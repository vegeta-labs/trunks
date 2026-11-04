import { storedDisposition } from '../lib/inline-image.ts'
// Pipeline stages after `ingest` (tech design §6): scan → parse → content_signals → extract → redact.
// Each stage computes outside the transaction, then publishes under `SELECT … FOR UPDATE` on the Case row: a job whose
// generation is stale is dropped; a repeated input identity reuses the stored result (stage_run unique key).
import { createHash } from 'node:crypto'
import type { Config } from '../config/load.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { getBlobs, getJson, putBlob, putJson } from '../store/blobs.ts'
import { appendAudit } from '../store/audit.ts'
import type { Json } from '../lib/audit-hash.ts'
import type { FileStore } from '../store/files.ts'
import { loadSnapshot } from '../store/directory.ts'
import type { Scanner } from '../adapters/scan/clamd.ts'
import type { ParserClient } from './parser-client.ts'
import { STAGES, type Queue, type Stage, type StageJob } from './queue.ts'
import { decodeMime, type InlineMetadata } from '../ingest/mime.ts'
import { imageHeader, type ImageFacts } from '../lib/image-header.ts'
import type { TaskResult } from '../../parser/task.ts'
import { htmlToText } from '../lib/html.ts'
import { hasHiddenText, htmlScanTexts, injectionMarkers, domainOf } from '../lib/signals.ts'
import { fromOriginal, normalise, toOriginal } from '../lib/text.ts'
import { extractUetrs } from '../lib/uetr.ts'
import { extractAmounts, mt103 } from '../lib/amounts.ts'
import { findReferences } from '../lib/references.ts'
import { distinctAccounts, extractAccounts, invalidIbanCount } from '../lib/accounts.ts'
import { extractDates } from '../lib/dates.ts'
import { detectEsign, linkDomains } from '../lib/esign.ts'
import { Redactor } from '../lib/redact.ts'
import { pacsAmount, type PacsItem } from '../lib/pacs008.ts'
import { readFileSync } from 'node:fs'
import { createDeliveries } from '../maintenance/kyc.ts'
import { toJSONSchema, type z } from 'zod'
import { adoptLabels, adoptedClasses, classificationSchema, maskUnknownPlaceholders, riskClasses, ruleLabels, type Classification, type Label } from '../lib/classify.ts'
import { inlineSignature, kycReason } from '../lib/kyc.ts'
import { failureCode, originalText, sanitised, tagged } from './failure.ts'
import { LlmOutputError, SetupError, type LlmAdapter, type LlmRequest } from '../adapters/llm/types.ts'
import { inputSha } from '../adapters/llm/replay.ts'
import { CLASS_TEXT, FIELD_TEXT } from './prompts/catalogue.ts'
import { fieldSchema, fieldsFor, modelFields, resolveFields, type FieldOutput, type FieldResult } from '../lib/fields.ts'
import { prepEmit, prepLink, prepReply, prepRisk, prepRoute } from './stages-e3.ts'

export interface StageDeps {
  db: Db
  k: Keyring
  files: FileStore
  config: Config
  queue: Queue
  scanner: Scanner
  parser: ParserClient
  llm?: LlmAdapter // the configured model (tech design §3.2); the model stages fail without one
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const PARSEABLE = new Set(['pdf', 'txt', 'csv', 'eml', 'docx', 'xml'])
export const PIPELINE_VERSION = 'e6.1' // bump when stage logic changes (part of the input identity)

export interface Applied {
  audit: Record<string, Json>
  detail?: Json
  detailSources?: string[]
}

export interface Prepared {
  inputHash: string
  kycJudgements?: KycJudgement[]
  result?: unknown // stored with the stage run (stage_run.result_blob)
  apply(c: Tx, caseRow: CaseRow): Promise<Applied>
}

export interface CaseRow {
  id: string
  message_id: string
  processing_generation: number
  manual_revision: number
  snapshot_id: string
  flags: string[]
}

// ---------- shared loaders ----------

async function caseRow(c: Pick<Tx, 'query'>, caseId: string, lock = false): Promise<CaseRow> {
  const r = await c.query<CaseRow>(`SELECT id, message_id, processing_generation, manual_revision, snapshot_id, flags FROM "case" WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [caseId])
  if (!r.rows[0]) throw new Error(`case ${caseId} not found`)
  return r.rows[0]
}

interface AttRow {
  id: string
  ordinal: number
  kind: string
  name_blob: string
  file_ref: string | null
  scan_status: string
  parse_status: string
  source_deleted: boolean
  kyc_recheck_pending: boolean
  maybe_kyc: boolean | null
  kyc_reason: string | null
  content_id_hmac: string | null
  disposition: string | null
  html_referenced: boolean | null
  inline_eligible: boolean | null
  image_facts: ImageFacts | null
}

const attachments = async (c: Pick<Tx, 'query'>, messageId: string) =>
  (await c.query<AttRow>('SELECT id, ordinal, kind, name_blob, file_ref, scan_status, parse_status, source_deleted, kyc_recheck_pending, maybe_kyc, kyc_reason, content_id_hmac, disposition, html_referenced, inline_eligible, image_facts FROM attachment WHERE message_id = $1 ORDER BY ordinal', [messageId])).rows

export interface MessageView {
  headers: Array<[string, string]>
  subject: string
  fromName: string
  fromAddress: string | null
  text: string // plain body, or the HTML body as text when there is no plain part
  htmlText: string // the HTML body as text ('' when there is none); extracted and redacted too (self-test RK-F2)
  html: string | null
  attachments: Array<{ id: string; ordinal: number; kind: string; filename: string; parseStatus: string; scanStatus: string; text: string; facts: TaskResult['facts'] | null; inline: InlineMetadata | null; imageFacts: ImageFacts | null; maybeKyc: boolean | null; kycReason: string | null; sourceDeleted: boolean }>
}

/** Bodies come from the archived original; attachment texts from the parser's output. */
export async function loadMessage(deps: Pick<StageDeps, 'db' | 'k' | 'files' | 'config'>, messageId: string, judgeImages = false): Promise<MessageView> {
  const { db, k, files, config } = deps
  const f = (await db.query<{ file_ref: string }>(`SELECT file_ref FROM message_file WHERE message_id = $1 ORDER BY kind = 'kyc_stripped' DESC, created_at DESC LIMIT 1`, [messageId])).rows[0]
  const raw = await files.get(f!.file_ref)
  const meta = (await db.query<{ header_blob: string; mime_version: number }>('SELECT header_blob, mime_version FROM message WHERE id = $1', [messageId])).rows[0]!
  const m = decodeMime(raw, { maxAttachmentBytes: config.attachments.max_attachment_bytes, maxTotalBytes: config.attachments.max_total_bytes, legacyOrdinals: meta.mime_version === 1 })
  const hdr = (await getJson<{ subject: string | null; from: string | null; from_name: string | null }>(db, k, meta.header_blob))!
  const atts = await attachments(db, messageId)
  const texts = (await db.query<{ attachment_id: string; text_blob: string; facts_blob: string | null }>('SELECT attachment_id, text_blob, facts_blob FROM attachment_text WHERE attachment_id = ANY($1::uuid[])', [atts.map((a) => a.id)])).rows
  const blobs = await getBlobs(db, k, [...atts.map((a) => a.name_blob), ...texts.flatMap((t) => [t.text_blob, t.facts_blob]).filter((x): x is string => !!x)])
  const byAtt = new Map(texts.map((t) => [t.attachment_id, t]))
  return {
    headers: m.headers,
    subject: hdr.subject ?? '',
    fromName: hdr.from_name ?? '',
    fromAddress: hdr.from,
    text: m.text ?? (m.html ? htmlToText(m.html) : ''),
    htmlText: m.text !== null && m.html ? htmlToText(m.html) : '',
    html: m.html,
    attachments: await Promise.all(atts.map(async (a) => {
      const t = byAtt.get(a.id)
      const part = m.attachments.find((p) => p.ordinal === a.ordinal)
      const inline: InlineMetadata | null = a.inline_eligible === null ? part?.inline ?? null : {
        contentId: a.content_id_hmac, disposition: a.disposition, htmlReferenced: a.html_referenced === true, eligible: a.inline_eligible,
      }
      const imageFacts = a.image_facts ?? (judgeImages && a.kind === 'image' && !a.source_deleted ? imageHeader(
        (a.file_ref ? await files.get(a.file_ref).catch(() => null) : part?.content) ?? Buffer.alloc(0),
      ) : null)
      return {
        id: a.id, ordinal: a.ordinal, kind: a.kind, filename: meta.mime_version === 1 && !a.source_deleted && part ? part.filename : blobs.get(a.name_blob)!.toString('utf8'), parseStatus: a.parse_status, scanStatus: a.scan_status,
        text: t && !a.source_deleted ? blobs.get(t.text_blob)!.toString('utf8') : '',
        inline, imageFacts, maybeKyc: a.maybe_kyc, kycReason: a.kyc_reason, sourceDeleted: a.source_deleted,
        facts: t?.facts_blob && !a.source_deleted ? (JSON.parse(blobs.get(t.facts_blob)!.toString('utf8')) as TaskResult['facts']) : null,
      }
    })),
  }
}

// ---------- stages ----------

async function prepScan(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const pending = (await attachments(d.db, cr.message_id)).filter((a) => a.scan_status === 'pending' && a.file_ref)
  const results: Array<{ id: string; clean: boolean; signature?: string }> = []
  for (const a of pending) {
    const r = await d.scanner.scan(await d.files.get(a.file_ref!))
    results.push(r.clean ? { id: a.id, clean: true } : { id: a.id, clean: false, signature: r.signature })
  }
  return {
    inputHash: sha256(JSON.stringify(pending.map((a) => a.id))),
    async apply(c) {
      for (const r of results) {
        await c.query(`UPDATE attachment SET scan_status = $2, parse_status = CASE WHEN $3 THEN parse_status ELSE 'blocked' END WHERE id = $1 AND scan_status = 'pending'`, [r.id, r.clean ? 'clean' : 'infected', r.clean])
      }
      const blocked = results.filter((r) => !r.clean).length
      if (blocked) await c.query(`UPDATE "case" SET flags = array(SELECT DISTINCT unnest(flags || '{attachment_blocked}')) WHERE id = $1`, [cr.id])
      return { audit: { scanned: results.length, infected: blocked }, ...(blocked ? { detail: { signatures: results.filter((r) => !r.clean).map((r) => r.signature ?? '') } } : {}) }
    },
  }
}

async function prepParse(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const all = await attachments(d.db, cr.message_id)
  const todo = all.filter((a) => a.parse_status === 'pending' && a.scan_status === 'clean' && a.file_ref && !a.source_deleted)
  const limits = {
    maxPdfPages: d.config.attachments.max_pdf_pages, maxNesting: d.config.attachments.max_nesting, maxAttachmentBytes: d.config.attachments.max_attachment_bytes,
    maxTotalBytes: d.config.attachments.max_total_bytes,
  }
  const out: Array<{ id: string; status: string; result: TaskResult | null }> = []
  for (const a of todo) {
    if (!PARSEABLE.has(a.kind)) {
      out.push({ id: a.id, status: 'not_parsed', result: null })
      continue
    }
    const r = await d.parser.parse(a.kind as never, await d.files.get(a.file_ref!), limits, d.config.attachments.parse_timeout_seconds * 1000)
    out.push({ id: a.id, status: r.timedOut ? 'timeout' : r.status, result: r })
  }
  return {
    inputHash: sha256(JSON.stringify(todo.map((a) => a.id))),
    async apply(c) {
      for (const o of out) {
        await c.query(`UPDATE attachment SET parse_status = $2 WHERE id = $1 AND parse_status = 'pending'`, [o.id, o.status])
        if (o.result && (o.result.text !== '' || Object.keys(o.result.facts).length)) {
          await c.query('INSERT INTO attachment_text (attachment_id, text_blob, facts_blob) VALUES ($1, $2, $3) ON CONFLICT (attachment_id) DO NOTHING', [
            o.id, await putBlob(c, d.k, o.result.text), await putJson(c, d.k, o.result.facts),
          ])
        }
      }
      return { audit: { parsed: out.filter((o) => o.status === 'parsed').length, statuses: out.map((o) => o.status) } }
    },
  }
}

async function prepContentSignals(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const m = await loadMessage(d, cr.message_id)
  const nestedTexts = (n: TaskResult['facts']['nested']): string[] =>
    (n ?? []).flatMap((x) => [x.result.text, ...(x.result.facts.signalTexts ?? []), ...nestedTexts(x.result.facts.nested)])
  const nestedNames = (n: TaskResult['facts']['nested']): string[] => (n ?? []).flatMap((x) => [x.filename, ...nestedNames(x.result.facts.nested)])
  // attachment names are part headers and go to the model (C-RED-1): scanned too (self-test RK-F8)
  const texts = [
    m.subject, ...m.headers.map(([, v]) => v), m.text, ...htmlScanTexts(m.html),
    ...m.attachments.flatMap((a) => [a.filename, a.text, ...(a.facts?.signalTexts ?? []), ...nestedTexts(a.facts?.nested), ...nestedNames(a.facts?.nested)]),
  ]
  const hidden = hasHiddenText(m.html)
  const markers = injectionMarkers(texts, d.config.signals.injection_markers_extra)
  const inputHash = sha256(JSON.stringify([texts, m.html]))
  return {
    inputHash,
    async apply(c) {
      // frozen: the first computation stands (C-SIG-1)
      for (const [signal, value] of [['hidden_text', hidden], ['injection_markers', markers.length > 0]] as const) {
        await c.query('INSERT INTO case_signal (case_id, signal, value, batch, input_sha256) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (case_id, signal) DO NOTHING', [cr.id, signal, value, 'content', inputHash])
      }
      return { audit: { hidden_text: hidden, injection_markers: markers.length > 0, input_sha256: inputHash } }
    },
  }
}

export interface Provenance {
  part: string // subject | body | attachment_name:<ordinal> | attachment_text:<ordinal>
  start: number // in the I-04 normalised part
  end: number
  originalStart: number
  originalEnd: number
}

export interface Extraction {
  invalidIbans?: number // absent in older saved results; no invalid account value is retained

  uetrs: Array<{ value: string; at: Provenance[] }>
  uetrCandidatesInvalid: Array<{ value: string; at: Provenance[] }>
  multipleUetrs: boolean
  amounts: Array<{ minor: number; currency: string; at: Provenance }>
  references: Array<{ value: string; at: Provenance[] }>
  accounts: Array<{ kind: string; last4: string; country: string; at: Provenance }>
  dates: Array<{ iso: string | null; status: string; at: Provenance }>
  // `at`: the `:32A:` field, or for pacs.008 the first of its value elements; `fields`: each pacs.008 value's own element
  evidence: Array<{
    source: 'mt103' | 'pacs008'
    part: string
    at: Provenance | null // null only for a pacs.008 transaction with no usable value
    fields?: { amount: Provenance | null; valueDate: Provenance | null; uetr: Provenance | null }
    minor: number | null
    currency: string | null
    valueDate: string | null
    uetr: string | null
  }>
  esign: { esignInvite: boolean; platform: string | null }
}

async function prepExtract(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const m = await loadMessage(d, cr.message_id)
  const dir = await loadSnapshot(d.db, d.k, cr.snapshot_id)
  const known = dir.commitments.map((x) => x.reference)
  const parts: Array<{ part: string; text: string }> = [
    { part: 'subject', text: m.subject },
    { part: 'body', text: m.text },
    // the HTML half of multipart/alternative is what most clients show; it may differ from the plain half
    ...(m.htmlText ? [{ part: 'body_html', text: m.htmlText }] : []),
    ...m.attachments.map((a) => ({ part: `attachment_name:${a.ordinal}`, text: a.filename })),
    ...m.attachments.filter((a) => a.text !== '').map((a) => ({ part: `attachment_text:${a.ordinal}`, text: a.text })),
  ]
  const ex: Extraction = { uetrs: [], uetrCandidatesInvalid: [], multipleUetrs: false, amounts: [], references: [], accounts: [], dates: [], evidence: [], esign: { esignInvite: false, platform: null } }
  ex.invalidIbans = parts.reduce((n, p) => n + invalidIbanCount(normalise(p.text).text), 0)
  const refs = new Map<string, Provenance[]>()
  for (const p of parts) {
    const n = normalise(p.text)
    const prov = (s: number, e: number): Provenance => {
      const [os, oe] = toOriginal(n, s, e)
      return { part: p.part, start: s, end: e, originalStart: os, originalEnd: oe }
    }
    for (const h of extractUetrs(n.text).hits) {
      const list = h.valid ? ex.uetrs : ex.uetrCandidatesInvalid
      const e = list.find((x) => x.value === h.value)
      if (e) e.at.push(prov(h.start, h.end))
      else list.push({ value: h.value, at: [prov(h.start, h.end)] })
    }
    for (const a of extractAmounts(n.text, d.config.deployment.currencies)) ex.amounts.push({ minor: a.minor, currency: a.currency, at: prov(a.start, a.end) })
    for (const r of findReferences(n.text, known)) refs.set(r.value, [...(refs.get(r.value) ?? []), prov(r.start, r.end)])
    for (const a of distinctAccounts(n.text, extractAccounts(n.text))) ex.accounts.push({ kind: a.kind, last4: a.last4, country: a.country, at: prov(a.start, a.end) })
    for (const dt of extractDates(n.text)) ex.dates.push({ iso: dt.iso, status: dt.status, at: prov(dt.start, dt.end) })
    if (p.part === 'body' || p.part === 'body_html' || p.part.startsWith('attachment_text:')) {
      for (const e of mt103(n.text, d.config.deployment.currencies)) ex.evidence.push({ source: 'mt103', part: p.part, at: prov(e.start, e.end), minor: e.minor, currency: e.currency, valueDate: e.valueDate, uetr: null })
    }
  }
  // pacs.008 attachments (and pacs.008 inside nested messages); `offset` is where the pacs.008 text starts in the attachment text
  const pacsOf = (facts: TaskResult['facts'] | null, offset: number): Array<{ offset: number; item: PacsItem }> => [
    ...(facts?.pacs008?.parsed ? facts.pacs008.items.map((item) => ({ offset, item })) : []),
    ...(facts?.nested ?? []).flatMap((n) => pacsOf(n.result.facts, offset + n.offset)),
  ]
  for (const a of m.attachments) {
    const part = `attachment_text:${a.ordinal}`
    const n = normalise(a.text)
    // each value's element text, as a position in the I-04 normalised attachment text (R-EXT-02, Codex F14)
    const span = (offset: number, s: [number, number] | null): Provenance | null => {
      if (!s) return null
      const [start, end] = fromOriginal(n, offset + s[0], offset + s[1])
      return { part, start, end, originalStart: offset + s[0], originalEnd: offset + s[1] }
    }
    for (const { offset, item } of pacsOf(a.facts, 0)) {
      // the UETR element's value is also in the attachment text, where C-EXT-1 finds it with its real position; the
      // evidence keeps it only when it is a valid UETR (an arbitrary string here is not a UETR, Codex F7)
      const r = item.uetr ? extractUetrs(item.uetr) : null
      const valid = r !== null && r.uetrs.length === 1 && r.hits[0]!.start === 0 && r.hits[0]!.end === item.uetr!.length
      // currencies are applied here, under the current configuration, not in the parser (Codex F13)
      const { minor, currency } = pacsAmount(item, d.config.deployment.currencies)
      const fields = { amount: minor === null ? null : span(offset, item.spans.amount), valueDate: span(offset, item.spans.valueDate), uetr: valid ? span(offset, item.spans.uetr) : null }
      ex.evidence.push({ source: 'pacs008', part, at: fields.amount ?? fields.valueDate ?? fields.uetr, fields, minor, currency, valueDate: item.valueDate, uetr: valid ? r!.uetrs[0]! : null })
    }
  }
  ex.references = [...refs].map(([value, at]) => ({ value, at }))
  ex.multipleUetrs = ex.uetrs.length > 1
  ex.esign = detectEsign(m.fromAddress ? domainOf(m.fromAddress) : '', linkDomains(m.text, m.html), d.config.esign_platforms)
  const inputHash = sha256(JSON.stringify([parts, cr.snapshot_id, m.attachments.map((a) => a.facts), d.config.deployment.currencies]))
  const sources = m.attachments.filter((a) => a.text !== '' || a.facts).map((a) => a.id)
  return {
    inputHash,
    result: ex,
    async apply() {
      return {
        audit: { uetrs: ex.uetrs.length, uetr_candidates_invalid: ex.uetrCandidatesInvalid.length, amounts: ex.amounts.length, references: ex.references.length, accounts: ex.accounts.length, evidence: ex.evidence.length, esign_invite: ex.esign.esignInvite },
        detail: ex as unknown as Json,
        detailSources: sources,
      }
    },
  }
}

export interface Redaction {
  subject: string
  fromName: string
  body: string
  bodyHtml: string
  attachments: Array<{ ordinal: number; filename: string; text: string }>
  counts: Record<string, number>
}

async function prepRedact(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const m = await loadMessage(d, cr.message_id, true)
  const dir = await loadSnapshot(d.db, d.k, cr.snapshot_id)
  const r = new Redactor({ contactNames: dir.contacts.map((p) => p.name) })
  // all parts at once: a value found in one part is replaced in every part (C-RED-1, v0.7.3)
  const parts: Array<{ text: string; source: string | null }> = [
    { text: m.subject, source: null },
    { text: m.fromName, source: null },
    { text: m.text, source: null },
    { text: m.htmlText, source: null },
    ...m.attachments.flatMap((a) => [{ text: a.filename, source: a.id }, { text: a.text, source: a.id }]),
  ]
  // redaction sees the text as written, keywords in any markup included (Codex round 2 F10)
  const done = r.redactAll(parts.map((p) => normalise(p.text).text))
  const sourceOf = new Map<string, string | null>() // placeholder → source attachment (null = mail itself)
  done.forEach((x, i) => {
    for (const p of x.text.match(/\[[A-Z]+_\d+\]/g) ?? []) if (!sourceOf.has(p)) sourceOf.set(p, parts[i]!.source)
  })
  const t = (i: number) => done[i]!.text
  const out: Redaction = {
    subject: t(0),
    fromName: t(1),
    body: t(2),
    bodyHtml: t(3),
    attachments: m.attachments.map((a, j) => ({ ordinal: a.ordinal, filename: t(4 + 2 * j), text: t(5 + 2 * j) })),
    counts: {},
  }
  for (const p of r.map.keys()) {
    const kind = /^\[([A-Z]+)_/.exec(p)![1]!
    out.counts[kind] = (out.counts[kind] ?? 0) + 1
  }
  return {
    inputHash: sha256(JSON.stringify([m.subject, m.fromName, m.text, m.htmlText, m.attachments.map((a) => [a.filename, a.text]), cr.snapshot_id])),
    result: out,
    kycJudgements: judgeAttachments(d, m),
    async apply(c) {
      for (const [placeholder, value] of r.map) {
        await c.query('INSERT INTO redaction_map (message_id, placeholder, value_blob, source_attachment_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
          cr.message_id, placeholder, await putBlob(c, d.k, value), sourceOf.get(placeholder) ?? null,
        ])
      }
      return { audit: { placeholders: out.counts } }
    },
  }
}

// ---------- model stages (E2) ----------

const prompt = (name: string) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8')

// the e-mail block: tags inside the content are removed so the content cannot close the block (tech design §3.2)
const BLOCK_TAG = /<\/?\s*(email|subject|from_name|body|body_html_text|attachment)\b[^>]*>/gi
/**
 * After redaction nothing is removed: the angle brackets of the block's own tags become ‹ › (punctuation for
 * punctuation), so no fragments are joined into a value (Codex E2 re-run F1) and no keyword is lost before redaction
 * (round 2 F10). Repeated until no tag is left (`<</body>body>`).
 */
export function neutraliseBlockTags(s: string): string {
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(BLOCK_TAG, (t) => t.replace(/</g, '‹').replace(/>/g, '›'))
  }
  return s
}
const clean = neutraliseBlockTags

export interface ModelView {
  user: string
  kyc: Array<{ ordinal: number; reason: string }>
  judgements: KycJudgement[]
}

export interface KycJudgement {
  id: string
  ordinal: number
  reason: string | null
  label: string | null
  inline: InlineMetadata | null
  imageFacts: ImageFacts | null
}

function judgeAttachments(d: Pick<StageDeps, 'config'>, m: MessageView): KycJudgement[] {
  return m.attachments.map((a) => {
    const input = { ...a, inlineLimits: d.config.kyc.inline_image }
    const reason = kycReason(input)
    return { id: a.id, ordinal: a.ordinal, reason, label: reason ?? (inlineSignature(input) ? 'inline_signature' : null), inline: a.inline, imageFacts: a.imageFacts }
  })
}

/** Called after the generation check, under the Case row lock, including both in-transaction reuse paths. */
export async function ensureKycJudgement(c: Tx, k: Keyring, cr: CaseRow, judgements: KycJudgement[]): Promise<void> {
  const rows = await attachments(c, cr.message_id)
  const promote = rows.some((a) => !a.source_deleted && a.maybe_kyc !== true && judgements.some((j) => j.id === a.id && j.reason !== null))
  let mayPromote = true
  if (promote) {
    // Try, never wait: maintenance holds the same advisory lock and later needs the Case row lock.
    const got = (await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 7340009)) AS ok', [cr.message_id])).rows[0]!.ok
    mayPromote = got && !(await c.query('SELECT 1 FROM kyc_replacement WHERE message_id = $1 AND step < 5', [cr.message_id])).rowCount
  }
  let changed = 0, deferred = 0
  for (const j of judgements) {
    const a = rows.find((r) => r.id === j.id)
    if (!a || a.source_deleted) continue // judging the stripped copy never undoes an earlier decision
    if (j.imageFacts || j.inline) await c.query(
      `UPDATE attachment SET image_facts = coalesce(image_facts, $2::jsonb),
         content_id_hmac = CASE WHEN inline_eligible IS NULL THEN $3 ELSE content_id_hmac END,
         disposition = CASE WHEN inline_eligible IS NULL THEN $4 ELSE disposition END,
         html_referenced = coalesce(html_referenced, $5), inline_eligible = coalesce(inline_eligible, $6) WHERE id = $1`,
      [a.id, j.imageFacts ? JSON.stringify(j.imageFacts) : null, j.inline?.contentId ? k.hmac(`content-id\0${j.inline.contentId}`) : null, storedDisposition(j.inline?.disposition ?? null), j.inline?.htmlReferenced ?? false, j.inline?.eligible ?? false],
    )
    if (a.maybe_kyc === true || a.maybe_kyc === false && j.reason === null) {
      if (a.kyc_recheck_pending) await c.query('UPDATE attachment SET kyc_recheck_pending = false WHERE id = $1', [a.id])
      continue
    }
    if (j.reason !== null && !mayPromote) {
      await c.query('UPDATE attachment SET kyc_recheck_pending = true WHERE id = $1', [a.id])
      deferred++; continue
    }
    await c.query('UPDATE attachment SET maybe_kyc = $2, kyc_reason = $3, kyc_recheck_pending = false WHERE id = $1', [a.id, j.reason !== null, j.label])
    changed++
  }
  const transfers = await createDeliveries(c, cr.id, cr.message_id)
  if (changed || transfers) await appendAudit(c, k, [{ actor: 'system', type: 'kyc.judged', caseId: cr.id, payload: { judged: changed, transfers } }])
  if (deferred) await appendAudit(c, k, [{ actor: 'system', type: 'kyc.reclassify_deferred', caseId: cr.id, payload: { attachments: deferred } }])
}

/** The model's input: redacted text only; a possible-KYC attachment contributes its redacted name and type (C-RED-0). */
async function modelView(d: StageDeps, cr: CaseRow, generation: number): Promise<ModelView> {
  const red = await resultOf<Redaction>(d, cr.id, 'redact', generation)
  if (!red) throw new Error('no redaction for this generation')
  const m = await loadMessage(d, cr.message_id, true)
  const judgements = judgeAttachments(d, m)
  const kyc: ModelView['kyc'] = []
  const parts = [`<subject>${clean(red.subject)}</subject>`, `<from_name>${clean(red.fromName)}</from_name>`, `<body>${clean(red.body)}</body>`]
  if (red.bodyHtml.trim() !== '' && red.bodyHtml !== red.body) parts.push(`<body_html_text>${clean(red.bodyHtml)}</body_html_text>`)
  for (const a of red.attachments) {
    const raw = m.attachments.find((x) => x.ordinal === a.ordinal)!
    const fresh = judgements.find((j) => j.ordinal === a.ordinal)!
    const reason = raw.maybeKyc === true ? raw.kycReason ?? 'previously_judged' : fresh.reason
    if (reason) kyc.push({ ordinal: a.ordinal, reason })
    const content = reason ? '[content withheld: possible KYC document]' : raw.kind === 'image' ? '[image: not read]' : clean(a.text)
    parts.push(`<attachment number="${a.ordinal + 1}" name="${clean(a.filename).replace(/"/g, "'")}" type="${raw.kind}">${content}</attachment>`)
  }
  return { user: `<email>\n${parts.join('\n')}\n</email>`, kyc, judgements }
}

export async function resultOf<T>(d: Pick<StageDeps, 'db' | 'k'>, caseId: string, stage: Stage, generation: number): Promise<T | null> {
  const r = await d.db.query<{ result_blob: string | null }>('SELECT result_blob FROM stage_run WHERE case_id = $1 AND stage = $2 AND generation = $3', [caseId, stage, generation])
  return r.rows[0]?.result_blob ? getJson<T>(d.db, d.k, r.rows[0].result_blob) : null
}

export interface ModelCall<T> {
  parsed: T | null // null: both attempts failed validation
  attempts: Array<{ raw: string; error: string | null; detail: string | null; reused: boolean }>
}

/**
 * One model call with one retry (R-CLS-01, C-FLD-0: «模型调用失败或输出不合格重试 1 次»). Every attempt is saved as soon
 * as it ends — a reply, an invalid reply or a provider error — and a retried pipeline step reuses the saved attempts, so
 * the model is never called more than twice for one request (TC-FLD-07). Two failed attempts → null: the caller falls
 * back to rule labels / `unclassified` and empty fields.
 */
const MAX_RAW = 64 * 1024

async function callModel<S extends z.ZodType>(d: StageDeps, caseId: string, req: LlmRequest<S>): Promise<ModelCall<z.infer<S>>> {
  if (!d.llm) throw new SetupError('no model configured (model in deployment.yaml)')
  const llm = d.llm
  const sha = inputSha(req)
  const attempts: ModelCall<z.infer<S>>['attempts'] = []
  // one request at a time per request identity, across workers: look up, call and save under one lock (F5)
  const lock = await d.db.connect()
  const key = BigInt.asIntN(64, BigInt(`0x${createHash('sha256').update(`${caseId}\0${req.promptVersion}\0${llm.id}\0${sha}`).digest('hex').slice(0, 16)}`)).toString()
  try {
    await lock.query('SELECT pg_advisory_lock($1::bigint)', [key])
    return await callModelLocked(d, caseId, req, llm, sha, attempts)
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined)
    lock.release()
  }
}

async function callModelLocked<S extends z.ZodType>(d: StageDeps, caseId: string, req: LlmRequest<S>, llm: LlmAdapter, sha: string, attempts: ModelCall<z.infer<S>>['attempts']): Promise<ModelCall<z.infer<S>>> {
  for (const attempt of [1, 2]) {
    const saved = await d.db.query<{ raw_blob: string; error: string | null }>(
      'SELECT raw_blob, error FROM model_output WHERE case_id = $1 AND prompt_version = $2 AND model_id = $3 AND input_sha256 = $4 AND attempt = $5',
      [caseId, req.promptVersion, llm.id, sha, attempt],
    )
    let raw: string
    let reused = false
    // a failed attempt keeps its reason; its text (if any) is kept for the audit and never parsed: a reply cut off at
    // the output limit or refused may still be valid JSON (Codex X2)
    let failure: string | null = null
    let detail: string | null = null
    const id = [caseId, req.promptVersion, llm.id, sha, attempt]
    if (saved.rows[0]) {
      raw = (await getBlobs(d.db, d.k, [saved.rows[0].raw_blob])).get(saved.rows[0].raw_blob)!.toString('utf8')
      reused = true
      failure = saved.rows[0].error
    } else if ((await d.db.query('SELECT 1 FROM model_attempt WHERE case_id = $1 AND prompt_version = $2 AND model_id = $3 AND input_sha256 = $4 AND attempt = $5', id)).rowCount) {
      // reserved but never saved: the request may have reached the model before the save failed or the worker stopped.
      // It counts as a failed attempt and is never sent again (C-FLD-0, Codex E2 round 4 F20)
      raw = ''
      failure = 'interrupted'
    } else {
      // reserved and committed before sending, so no failure after this point can lead to a third call (F20)
      await d.db.query('INSERT INTO model_attempt (case_id, prompt_version, model_id, input_sha256, attempt) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', id)
      try {
        raw = (await llm.complete({ ...req, attempt })).raw
      } catch (e) {
        // a setup error (credentials, refused connection, missing recording) is not an attempt (Codex X1, verify R1):
        // nothing was sent, so the reservation is released
        if (e instanceof SetupError) {
          await d.db.query('DELETE FROM model_attempt WHERE case_id = $1 AND prompt_version = $2 AND model_id = $3 AND input_sha256 = $4 AND attempt = $5', id)
          throw e
        }
        raw = e instanceof LlmOutputError ? e.raw : ''
        // only a fixed code is stored in plain text (R-PRV-05, F3); the message goes to the encrypted audit detail
        failure = e instanceof LlmOutputError ? 'output_error' : 'provider_error'
        detail = e instanceof LlmOutputError ? e.message : String((e as Error).message ?? e).slice(0, 200)
      }
      // a runaway reply is stored only up to a cap (it is invalid anyway)
      if (raw.length > MAX_RAW) raw = raw.slice(0, MAX_RAW)
    }
    let parsed: z.infer<S> | null = null
    let error: string | null = failure
    if (error === null) {
      try {
        const json: unknown = JSON.parse(raw)
        const r = req.schema.safeParse(json)
        if (r.success) parsed = r.data
        else {
          error = 'schema_invalid'
          detail = r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')
        }
      } catch {
        error = 'not_json'
      }
    }
    if (!reused) {
      await tx(d.db, async (c) => {
        await c.query('INSERT INTO model_output (case_id, prompt_version, model_id, input_sha256, attempt, raw_blob, error) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING', [
          caseId, req.promptVersion, llm.id, sha, attempt, await putBlob(c, d.k, raw), error,
        ])
      })
    }
    attempts.push({ raw, error, detail, reused })
    if (parsed !== null) return { parsed, attempts }
  }
  return { parsed: null, attempts }
}

export const CLASSIFY_PROMPT = 'classify@v3'

export interface ClassifyResult {
  labels: Label[]
  adopted: string[]
  risk: string[] // C-RSK-1 input: adopted + model low labels
  language: string | null
  modelFailed: boolean
  kyc: ModelView['kyc']
}

async function prepClassify(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const view = await modelView(d, cr, cr.processing_generation)
  const ids = d.config.classes.map((c) => c.id)
  const system = prompt(CLASSIFY_PROMPT).replace('{{classes}}', ids.map((id) => `- ${id}: ${CLASS_TEXT[id] ?? id}`).join('\n'))
  const call = await callModel(d, cr.id, { system, user: view.user, schema: classificationSchema(ids), promptVersion: CLASSIFY_PROMPT })
  // rule labels read the original text (an IBAN is a placeholder in the redacted text) and the extraction result
  const m = await loadMessage(d, cr.message_id)
  const ex = await resultOf<Extraction>(d, cr.id, 'extract', cr.processing_generation)
  const rules = ruleLabels({
    subject: m.subject,
    body: m.text,
    bodyHtml: m.htmlText ?? '',
    attachmentTexts: m.attachments.map((a) => a.text),
    esignInvite: ex?.esign.esignInvite ?? false,
    // C-EXT-3 parsed `:32A:` or `IntrBkSttlmAmt` (an amount); a value date alone is not enough (CF-F9)
    paymentEvidenceParsed: (ex?.evidence ?? []).some((e) => e.part.startsWith('attachment') && e.minor !== null),
  })
  const model = call.parsed ? maskUnknownPlaceholders(call.parsed as Classification, view.user) : null
  const labels = adoptLabels(model, rules)
  const out: ClassifyResult = { labels, adopted: adoptedClasses(labels), risk: riskClasses(labels), language: model?.language ?? null, modelFailed: model === null, kyc: view.kyc }
  return {
    inputHash: sha256(JSON.stringify([view.user, system, rules, d.llm?.id])),
    result: out,
    kycJudgements: view.judgements,
    async apply(c) {
      for (const l of labels) {
        await c.query(
          'INSERT INTO case_label (case_id, generation, class_id, source, confidence, adopted, reason_blob) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
          [cr.id, cr.processing_generation, l.classId, l.source, l.confidence, l.adopted, l.reason === null ? null : await putBlob(c, d.k, l.reason)],
        )
      }
      return {
        audit: { adopted: out.adopted, model_failed: out.modelFailed, attempts: call.attempts.length, kyc_attachments: view.kyc.length, model: d.llm?.id ?? null, prompt: CLASSIFY_PROMPT },
        // the model's replies are kept in audit_detail, never in the audit row itself (TC-AUD-06b); TC-CLS-01: both attempts
        // the exact request with its schema, and its attempts (tech design §5, round 2 F9)
        detail: { requests: [{ system, user: view.user, prompt: CLASSIFY_PROMPT, schema: toJSONSchema(classificationSchema(ids)) as Json, attempts: call.attempts.map((a) => ({ raw: a.raw, error: a.error, detail: a.detail, reused: a.reused })) }], labels: labels as unknown as Json },
      }
    },
  }
}

export const FIELDS_PROMPT = 'fields@v2'

export interface FieldsResult {
  classes: string[]
  fields: FieldResult[]
  modelFailed: boolean
}

async function prepFields(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const gen = cr.processing_generation
  const cls = await resultOf<ClassifyResult>(d, cr.id, 'classify', gen)
  if (!cls) throw new Error('no classification for this generation')
  const configured = Object.fromEntries(d.config.classes.map((c) => [c.id, c.fields]))
  const fields = fieldsFor(cls.adopted, configured)
  const asked = modelFields(fields)
  const view = await modelView(d, cr, gen)
  // the provider refuses structured-output schemas past about nine fields: at most eight fields per call
  const chunks: string[][] = []
  for (let i = 0; i < asked.length; i += 8) chunks.push(asked.slice(i, i + 8))
  const systemFor = (fs: string[]) => prompt(FIELDS_PROMPT).replace('{{fields}}', fs.map((f) => `- ${f}: ${FIELD_TEXT[f] ?? f}`).join('\n'))
  const calls: Array<ModelCall<unknown>> = []
  for (const fs of chunks) calls.push(await callModel(d, cr.id, { system: systemFor(fs), user: view.user, schema: fieldSchema(fs), promptVersion: FIELDS_PROMPT }))
  const merged: FieldOutput | null = calls.length ? { fields: Object.assign({}, ...calls.map((c) => (c.parsed as FieldOutput | null)?.fields ?? {})) } : null
  const system = chunks.map(systemFor).join('\n---\n')
  const call = calls.length ? { parsed: merged, failed: calls.some((c) => c.parsed === null), attempts: calls.flatMap((c) => c.attempts) } : null
  const ex = await resultOf<Extraction>(d, cr.id, 'extract', gen)
  const dir = await loadSnapshot(d.db, d.k, cr.snapshot_id)
  // NAME / EMAIL / PHONE / ADDRESS placeholders restored in memory for the deal check only (C-RED-2); never stored
  const map = (await d.db.query<{ placeholder: string; value_blob: string }>('SELECT placeholder, value_blob FROM redaction_map WHERE message_id = $1', [cr.message_id])).rows
  const values = await getBlobs(d.db, d.k, map.map((m) => m.value_blob))
  const restorable = new Map(map.filter((m) => /^\[(NAME|EMAIL|PHONE|ADDRESS)_\d+\]$/.test(m.placeholder)).map((m) => [m.placeholder, values.get(m.value_blob)!.toString('utf8')]))
  const restore = (t: string) => t.replace(/\[[A-Z]+_\d+\]/g, (p) => restorable.get(p) ?? p)
  const evidenceAmounts = (ex?.evidence ?? []).flatMap((e) => (e.minor !== null && e.currency ? [{ minor: e.minor, currency: e.currency }] : []))
  const res = resolveFields(fields, call?.parsed ?? null, {
    modelText: view.user,
    currencies: d.config.deployment.currencies,
    platforms: Object.keys(d.config.esign_platforms),
    deals: dir.deals.map((x) => ({ id: x.dealKey, name: x.name })),
    restore,
    rules: {
      uetrs: (ex?.uetrs ?? []).map((u) => u.value),
      amounts: [...(ex?.amounts ?? []).map((a) => ({ minor: a.minor, currency: a.currency })), ...evidenceAmounts],
      evidenceAmounts,
      references: (ex?.references ?? []).map((r) => r.value),
      accountLast4: [...new Set((ex?.accounts ?? []).map((a) => a.last4))],
      valueDates: [...new Set((ex?.evidence ?? []).flatMap((e) => (e.valueDate ? [e.valueDate] : [])))],
    },
  })
  const out: FieldsResult = { classes: cls.adopted, fields: res, modelFailed: call?.failed ?? false }
  return {
    kycJudgements: view.judgements,
    inputHash: sha256(JSON.stringify([view.user, system, cls.adopted, ex, cr.snapshot_id, d.llm?.id])),
    result: out,
    async apply(c) {
      for (const f of res) {
        const value = f.status === 'multiple' ? { candidates: f.candidates } : f.value === null ? null : { value: f.value }
        await c.query(
          `INSERT INTO case_field (case_id, generation, field, value_blob, confidence, source, provenance_blob, status, needs_confirmation)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
          [cr.id, gen, f.field, value === null ? null : await putJson(c, d.k, value as unknown as Json), f.confidence, f.source, f.quotes.length ? await putJson(c, d.k, { quotes: f.quotes, reason: f.reason }) : null, f.status, f.needsConfirmation],
        )
      }
      return {
        audit: { fields: res.length, void: res.filter((f) => f.status === 'void').length, multiple: res.filter((f) => f.status === 'multiple').length, conflict: res.filter((f) => f.status === 'conflict').length, model_failed: out.modelFailed, model: d.llm?.id ?? null, prompt: FIELDS_PROMPT },
        // one entry per request actually sent (fields go in chunks of eight), each with its schema and attempts (round 2 F9)
        ...(call ? { detail: { requests: chunks.map((fs, i) => ({ system: systemFor(fs), user: view.user, prompt: FIELDS_PROMPT, schema: toJSONSchema(fieldSchema(fs)) as Json, attempts: calls[i]!.attempts.map((a) => ({ raw: a.raw, error: a.error, detail: a.detail, reused: a.reused })) })) } } : {}),
      }
    },
  }
}

const PREP: Record<Stage, (d: StageDeps, cr: CaseRow) => Promise<Prepared>> = {
  scan: prepScan,
  parse: prepParse,
  content_signals: prepContentSignals,
  extract: prepExtract,
  redact: prepRedact,
  classify: prepClassify,
  fields: prepFields,
  link: prepLink,
  risk: prepRisk,
  reply: prepReply,
  route: prepRoute,
  emit: prepEmit,
}

/** Run one stage for one Case. Returns what happened (for tests and logs). */
export async function runStage(deps: StageDeps, stage: Stage, job: StageJob): Promise<'published' | 'reused' | 'stale'> {
  // adapter failures carry a fixed code (failure.ts); their own text never reaches a log or the job queue
  const d: StageDeps = { ...deps, files: tagged(deps.files, 'storage_error'), scanner: tagged(deps.scanner, 'scanner_unavailable'), parser: tagged(deps.parser, 'parser_unavailable') }
  const before = await caseRow(d.db, job.caseId)
  if (before.processing_generation !== job.generation) return 'stale'
  const next = STAGES[STAGES.indexOf(stage) + 1]
  const finish = async (c: Tx) => {
    if (next) await d.queue.send(c, next, job)
    else await c.query(`UPDATE "case" SET status = CASE WHEN status = 'processing' THEN 'open' ELSE status END, pipeline_complete_generation = $2 WHERE id = $1`, [job.caseId, job.generation])
  }
  const publishedFor = (c: Pick<Tx, 'query'>) => c.query('SELECT 1 FROM stage_run WHERE case_id = $1 AND stage = $2 AND generation = $3', [job.caseId, stage, job.generation])
  // one result per stage and generation: a re-delivered job does nothing new, whatever its input looks like now (CC-F3)
  if ((await publishedFor(d.db)).rowCount) {
    await tx(d.db, async (c) => {
      const cr = await caseRow(c, job.caseId, true)
      if (cr.processing_generation === job.generation) await finish(c)
    })
    return 'reused'
  }
  const prep = await PREP[stage](d, before)
  const identity = sha256(JSON.stringify({ stage, input: prep.inputHash, config: d.config.sha256, pipeline: PIPELINE_VERSION, snapshot: before.snapshot_id, manual: before.manual_revision }))
  return tx(d.db, async (c) => {
    const cr = await caseRow(c, job.caseId, true)
    if (cr.processing_generation !== job.generation) return 'stale' // a newer generation owns the Case now
    if (prep.kycJudgements) await ensureKycJudgement(c, d.k, cr, prep.kycJudgements)
    // the Case row lock serialises workers of the same Case, so check-then-insert is safe
    if ((await publishedFor(c)).rowCount) {
      await finish(c)
      return 'reused'
    }
    // the same input in an earlier generation: take its result over for this generation without recomputing (CC-F2)
    const earlier = await c.query<{ result_blob: string | null }>(
      'SELECT result_blob FROM stage_run WHERE case_id = $1 AND stage = $2 AND input_identity = $3 ORDER BY generation DESC LIMIT 1',
      [cr.id, stage, identity],
    )
    if (earlier.rows[0]) {
      await c.query('INSERT INTO stage_run (case_id, stage, generation, input_identity, result_blob, reused) VALUES ($1, $2, $3, $4, $5, true)', [
        cr.id, stage, job.generation, identity, earlier.rows[0].result_blob,
      ])
      await appendAudit(c, d.k, [{ actor: 'system', type: `stage.${stage}.reused`, caseId: cr.id, payload: { generation: job.generation, input_identity: identity } }])
      await finish(c)
      return 'reused'
    }
    const blob = prep.result === undefined ? null : await putJson(c, d.k, prep.result)
    await c.query('INSERT INTO stage_run (case_id, stage, generation, input_identity, result_blob) VALUES ($1, $2, $3, $4, $5)', [cr.id, stage, job.generation, identity, blob])
    const r = await prep.apply(c, cr)
    await c.query('UPDATE "case" SET system_revision = system_revision + 1 WHERE id = $1', [cr.id])
    await appendAudit(c, d.k, [{ actor: 'system', type: `stage.${stage}`, caseId: cr.id, payload: { generation: job.generation, input_identity: identity, ...r.audit }, ...(r.detail === undefined ? {} : { detail: r.detail, detailSources: r.detailSources ?? [] }) }])
    await finish(c)
    return 'published'
  })
}

/**
 * The job handler of one stage (tech design v0.7.15, E6 D2): every failed attempt writes one log line with a fixed
 * reason code; after the last retry the Case is marked failed; what goes on to the job queue (pg-boss stores it) is a
 * new error carrying only the code.
 */
export function stageHandler(deps: StageDeps, stage: Stage, retryLimit: number, log: (line: string) => void = (l) => console.error(l)) {
  return async (job: { data: StageJob; retryCount: number }): Promise<void> => {
    try {
      await runStage(deps, stage, job.data)
    } catch (e) {
      log(`step failed case=${job.data.caseId} step=${stage} reason=${failureCode(e)} attempt=${job.retryCount + 1}`)
      if (job.retryCount >= retryLimit) {
        try { await markFailed(deps, stage, job.data, e) }
        catch (recordError) { log(`step failure recording failed case=${job.data.caseId} step=${stage} reason=${failureCode(recordError)}`) }
      }
      throw sanitised(e)
    }
  }
}

/** After the last retry: the Case shows "processing failed"; the original mail is untouched (tech design §6). */
export async function markFailed(d: Pick<StageDeps, 'db' | 'k'>, stage: Stage, job: StageJob, error: unknown): Promise<void> {
  const reason = failureCode(error)
  await tx(d.db, async (c) => {
    const cr = await caseRow(c, job.caseId, true)
    if (cr.processing_generation !== job.generation) return
    await c.query(`UPDATE "case" SET status = 'failed', failed_stage = $2, failed_reason = $3 WHERE id = $1`, [cr.id, stage, reason])
    // the reason code in plain text; the error's own text only in the encrypted detail (tech design v0.7.15)
    await appendAudit(c, d.k, [{ actor: 'system', type: 'stage.failed', caseId: cr.id, payload: { stage, generation: job.generation, reason }, detail: { error: originalText(error).slice(0, 500) } }])
  })
}

/** Result of a stage for the current generation (review UI). */
export async function stageResult<T>(db: Db, k: Keyring, caseId: string, stage: Stage): Promise<T | null> {
  const r = await db.query<{ result_blob: string | null }>(
    `SELECT s.result_blob FROM stage_run s JOIN "case" c ON c.id = s.case_id WHERE s.case_id = $1 AND s.stage = $2 AND s.generation = c.processing_generation`,
    [caseId, stage],
  )
  return getJson<T>(db, k, r.rows[0]?.result_blob ?? null)
}

