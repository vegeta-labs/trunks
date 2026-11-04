import { approvalFailures, type ApprovalFailure, type UserEvent } from '../lib/verification.ts'
import { hiddenTextView, type HiddenFinding } from '../lib/html.ts'
import { Redactor } from '../lib/redact.ts'
import { normalise, fromOriginal } from '../lib/text.ts'
// Read models for the review UI (PRD R-REV-01, R-REV-02). Only the current page is decrypted.
import { FAILURE_TEXT, type FailureCode } from '../pipeline/failure.ts'
import type { Config } from '../config/load.ts'
import type { Keyring } from '../store/crypto.ts'
import type { Db } from '../store/db.ts'
import { getBlobs, getJson, getText } from '../store/blobs.ts'
import type { FileStore } from '../store/files.ts'
import { loadMessage, stageResult, type ClassifyResult, type Extraction, type FieldsResult } from '../pipeline/stages.ts'
import { loadSnapshot } from '../store/directory.ts'
import type { Value } from '../lib/fields.ts'
import { currentActions, effectiveFields, effectiveLabels, outputGeneration, replyContext, taskContactOf, type LinkResult, type ReplyStageResult, type RiskStageResult } from '../pipeline/stages-e3.ts'
import { allowedManualTemplates, bodyEditable } from '../lib/draft.ts'
import { CHECKLIST_TEXT, NO_PHONE_TEXT_EN } from '../lib/verification.ts'
import { dueState } from '../lib/workdays.ts'
import { calendar } from '../pipeline/stages-e3.ts'
import type { MessageView } from '../pipeline/stages.ts'

export interface CaseListItem {
  id: string
  receivedAt: string
  mailbox: string
  from: string | null
  fromName: string | null
  subject: string | null
  status: string
  risk: string | null
  queue: string | null
  dueAt: string | null
  flags: string[]
  signals: string[] // signals that are true
  hold: boolean // R-REV-07
}

export interface CaseFilter {
  status?: string
  queue?: string
  risk?: string
  limit?: number
  offset?: number
}

const RISK_ORDER = `CASE c.risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`

export async function listCases(db: Db, k: Keyring, config: Config, f: CaseFilter): Promise<CaseListItem[]> {
  const where: string[] = []
  const args: unknown[] = []
  for (const key of ['status', 'queue', 'risk'] as const) {
    if (f[key]) {
      args.push(f[key])
      where.push(`c.${key} = $${args.length}`)
    }
  }
  args.push(Math.min(f.limit ?? 50, 200), f.offset ?? 0)
  const r = await db.query(
    `SELECT c.id, m.received_at, m.mailbox_id, m.header_blob, c.status, c.risk, c.queue, c.due_at, c.flags, c.hold,
            coalesce(array_agg(s.signal) FILTER (WHERE s.value AND s.signal <> 'dmarc_pass'), '{}') AS signals
       FROM "case" c JOIN message m ON m.id = c.message_id LEFT JOIN case_signal s ON s.case_id = c.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY c.id, m.id
      ORDER BY ${RISK_ORDER}, c.due_at NULLS LAST, m.received_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  )
  const blobs = await getBlobs(db, k, r.rows.map((x) => x.header_blob))
  const names = new Map(config.mailboxes.map((m) => [m.id, m.name]))
  return r.rows.map((x) => {
    const h = JSON.parse(blobs.get(x.header_blob)!.toString('utf8')) as { from: string | null; from_name: string | null; subject: string | null }
    return {
      id: x.id, receivedAt: (x.received_at as Date).toISOString(), mailbox: names.get(x.mailbox_id) ?? x.mailbox_id, from: h.from, fromName: h.from_name, subject: h.subject,
      status: x.status, risk: x.risk, queue: x.queue, dueAt: x.due_at ? (x.due_at as Date).toISOString() : null, flags: x.flags, signals: x.signals, hold: x.hold,
    }
  })
}

export interface CaseDetail extends CaseListItem {
  to: string | null
  cc: string | null // shown so that a reviewer can check a consent claim of «investor copied» (E5 acceptance G8)
  dateHeader: string | null
  failedStage: string | null // the step where processing stopped, for a failed Case (E5 acceptance G3)
  failedReason: string | null // a fixed sentence for the failure's reason code; never the error's own text (E6 D2)
  text: string // plain text only (tech design T9)
  hiddenTexts: Array<{ reason: HiddenFinding['reason']; text: string }>
  htmlText: string | null // the HTML half as text, when it differs from the plain half
  attachments: Array<{ ordinal: number; filename: string; kind: string; scanStatus: string; parseStatus: string; maybeKyc: boolean | null; kycReason: string | null; kycTransfer: { id: string; state: string; error: string | null; removed: boolean } | null }> // null: not judged yet
  signalDetails: Array<{ signal: string; value: boolean | null; batch: string }>
  extraction: Extraction | null
  // model and rule labels (C-CLS-2); reasons are plain text with NAME / EMAIL / PHONE / ADDRESS restored (C-RED-2)
  labels: Array<{ classId: string; source: string; confidence: string; adopted: boolean; reason: string | null }>
  // final fields (C-FLD-2): values as display text; void fields carry only the reason
  fields: Array<{ field: string; status: string; value: string | null; candidates: string[]; needsConfirmation: boolean; reason: string | null; confirmed: boolean }>
  previousCaseId: string | null
  holdReason: string | null // R-REV-07: shown with the mark
  e3: CaseE3 | null
}

// E3 (R-REV-02): links, risk and its reasons, actions, replies, verification tasks, routing
export interface CaseE3 {
  generation: number
  complete: boolean // the current generation finished (C-DRF-8: approving and copying need it)
  manualRevision: number
  adopted: string[] // the classes of the generation shown, beside its risk (Codex round 4 F26)
  low: string[]
  pendingAdopted: string[] | null // a person's class changes waiting for the re-run
  ruleLabels: string[]
  removed: Array<{ classId: string; by: string | null; reason: string | null }> // classes a person removed (D8)
  risk: { computed: string; final: string; by: string; clauses: string[]; floor: { level: string; classes: string[] } | null; adjustment: { level: string; state: string } | null; held: string | null; applied: string } | null
  pendingRisk: string | null // the Case's newer risk, until the re-run that computed it is complete (self-review T2)
  links: {
    contact: { id: string; name: string } | null
    contactCandidates: string[]
    commitment: { key: string; investorName: string; reference: string } | null
    commitmentCandidates: string[]
    deal: string | null
    dealCandidates: string[]
    dealConflict: boolean
    bankLines: Array<{ transactionId: string; ledgerStatus: string | null }>
    authenticatedSender: boolean
    mayDisclose: boolean
    ledger: string | null
  } | null
  signalsFromEarlierSnapshot: boolean // TC-SIG-12: relinked; signals stay as computed with the first snapshot
  actions: Array<{ action: string; details: string | null }>
  autoTemplate: string | null
  allowedTemplates: string[]
  replies: Array<{ id: string; templateId: string; source: string; edited: boolean; recipient: string | null; subject: string; text: string; status: string; checkOk: boolean; problems: string[]; removed: number; bodyEditable: boolean; createdAt: string; outOfDate: boolean }>
  allowedRecipients: string[]
  verification: Array<{ id: string; kind: string; state: string; checklist: Array<{ id: string; text: string; checked: boolean }>; phone: string | null; notifyRecipient: string | null; notifySubject: string | null; notifyText: string | null; notifyProblems: string[]; completedBy: string | null; coolingUntil: string | null; approvedBy: string | null; impersonatedContact: string | null; approvalFailures: ApprovalFailure[] }>
  due: { at: string | null; state: string | null; followUpAt: string | null }
  assignee: string | null
  outcome: string | null
}

// C-RED-2: account and ID placeholders are never restored, anywhere; shown as a description only
const MASK: Record<string, string> = { ACCOUNT: '(account number)', SORTCODE: '(sort code)', ID: '(ID number)', DOB: '(date of birth)' }

const MONEY: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' }

export async function caseDetail(deps: { db: Db; k: Keyring; files: FileStore; config: Config }, id: string, viewer?: { id: string; role: string }): Promise<CaseDetail | null> {
  const { db, k, config } = deps
  const r = await db.query('SELECT c.id, c.message_id, c.previous_case_id, m.received_at, m.mailbox_id, m.header_blob, c.status, c.failed_stage, c.failed_reason, c.risk, c.queue, c.due_at, c.flags, c.hold, c.hold_reason_blob FROM "case" c JOIN message m ON m.id = c.message_id WHERE c.id = $1', [id])
  const x = r.rows[0]
  if (!x) return null
  const h = (await getJson<{ from: string | null; from_name: string | null; subject: string | null; to: string | null; cc?: string | null; date: string | null }>(db, k, x.header_blob))!
  const m = await loadMessage(deps, x.message_id)
  // dmarc_pass is C-SIG-3's input, not a signal (shown as «authenticated sender» with the links)
  const sig = (await db.query("SELECT signal, value, batch FROM case_signal WHERE case_id = $1 AND signal <> 'dmarc_pass' ORDER BY batch DESC, signal", [id])).rows
  // C-RED-0: «在 Case 里标「可能是 KYC 附件」»
  const kyc = new Map((await db.query<{ ordinal: number; maybe_kyc: boolean | null; kyc_reason: string | null }>('SELECT ordinal, maybe_kyc, kyc_reason FROM attachment WHERE message_id = $1', [x.message_id])).rows.map((a) => [a.ordinal, a]))
  // R-PRV-03: the transfer of each possible-KYC attachment, and whether its content has been removed (C-PRV-2)
  const transfers = new Map((await db.query<{ ordinal: number; id: string; state: string; last_error: string | null; source_deleted: boolean }>(
    'SELECT a.ordinal, d.id, d.state, d.last_error, a.source_deleted FROM kyc_delivery d JOIN attachment a ON a.id = d.attachment_id WHERE d.message_id = $1', [x.message_id],
  )).rows.map((t) => [t.ordinal, { id: t.id, state: t.state, error: t.last_error, removed: t.source_deleted }]))
  return {
    id, receivedAt: (x.received_at as Date).toISOString(), mailbox: config.mailboxes.find((b) => b.id === x.mailbox_id)?.name ?? x.mailbox_id, from: h.from, fromName: h.from_name,
    subject: h.subject, status: x.status, risk: x.risk, queue: x.queue, dueAt: x.due_at ? (x.due_at as Date).toISOString() : null, flags: x.flags, hold: x.hold,
    holdReason: x.hold ? await getText(db, k, x.hold_reason_blob) : null,
    failedStage: x.status === 'failed' ? x.failed_stage : null,
    failedReason: x.status === 'failed' && x.failed_reason ? FAILURE_TEXT[x.failed_reason as FailureCode] ?? null : null,
    signals: sig.filter((s) => s.value === true).map((s) => s.signal), to: h.to, cc: h.cc ?? null, dateHeader: h.date, text: m.text,
    htmlText: m.htmlText && m.htmlText.trim() !== m.text.trim() ? m.htmlText : null,
    hiddenTexts: displayHiddenText(m.html, [m.subject, m.fromName, m.text, m.htmlText, ...m.attachments.flatMap((a) => [a.filename, a.text])]),
    attachments: m.attachments.map((a) => ({ ordinal: a.ordinal, filename: a.filename, kind: a.kind, scanStatus: a.scanStatus, parseStatus: a.parseStatus, maybeKyc: kyc.get(a.ordinal)?.maybe_kyc ?? null, kycReason: kyc.get(a.ordinal)?.kyc_reason ?? null, kycTransfer: transfers.get(a.ordinal) ?? null })),
    signalDetails: sig.map((s) => ({ signal: s.signal, value: s.value, batch: s.batch })),
    extraction: masked(await stageResult<Extraction>(db, k, id, 'extract'), m, await dobValues(db, k, x.message_id), new Set([...kyc].filter(([, v]) => v.maybe_kyc === true).map(([o]) => o))),
    ...(await modelView(deps, id, x.message_id)),
    previousCaseId: x.previous_case_id,
    e3: await e3View(deps, id, x.message_id, viewer),
  }
}

/** Plain text only, masking the same sensitive kinds as the rest of the review view. */
export function displayHiddenText(html: string | null, parts: readonly string[] = []): HiddenFinding[] {
  if (!html) return []
  const view = hiddenTextView(html)
  const n = normalise(view.text)
  const redactor = new Redactor({ contactNames: [] })
  const spans = redactor.redactAll([...parts.map((part) => normalise(part).text), n.text]).at(-1)!.spans.filter((sp) => Object.hasOwn(MASK, sp.kind))
  return view.findings.map((f) => {
    const [start, end] = fromOriginal(n, f.start, f.end)
    let at = start, text = ''
    for (const span of spans) {
      if (span.end <= start || span.start >= end) continue
      text += n.text.slice(at, Math.max(at, span.start)) + MASK[span.kind]
      at = Math.min(end, span.end)
    }
    return { reason: f.reason, text: text + n.text.slice(at, end) }
  })
}

async function modelView(deps: { db: Db; k: Keyring }, caseId: string, messageId: string): Promise<Pick<CaseDetail, 'labels' | 'fields'>> {
  const { db, k } = deps
  const cls = await stageResult<ClassifyResult>(db, k, caseId, 'classify')
  const fl = await stageResult<FieldsResult>(db, k, caseId, 'fields')
  if (!cls && !fl) return { labels: [], fields: [] }
  const map = (await db.query<{ placeholder: string; value_blob: string }>('SELECT placeholder, value_blob FROM redaction_map WHERE message_id = $1', [messageId])).rows
  const vals = await getBlobs(db, k, map.map((m) => m.value_blob))
  const byPlaceholder = new Map(map.map((m) => [m.placeholder, vals.get(m.value_blob)!.toString('utf8')]))
  const show = (t: string) =>
    t.replace(/\[([A-Z]+)_\d+\]/g, (p, kind: string) => MASK[kind] ?? byPlaceholder.get(p) ?? p)
  const snapshot = (await db.query<{ snapshot_id: string }>('SELECT snapshot_id FROM "case" WHERE id = $1', [caseId])).rows[0]?.snapshot_id
  const deals = snapshot ? new Map((await loadSnapshot(db, k, snapshot)).deals.map((d) => [d.dealKey, d.name])) : new Map<string, string>()
  const text = (field: string, v: Value): string => {
    if (typeof v === 'boolean') return v ? 'yes' : 'no'
    if (Array.isArray(v)) return v.join(', ')
    if (typeof v === 'object') return `${MONEY[v.currency] ?? `${v.currency} `}${(v.minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`
    if (field === 'deal') return deals.get(v) ?? v
    if (field === 'account_last4') return `ending ${v}`
    return show(v)
  }
  // a person's value or confirmation on top (R-REV-03)
  const gen = (await db.query<{ g: number }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [caseId])).rows[0]!.g
  const eff = fl ? await effectiveFields({ db, k }, caseId, gen).catch(() => ({}) as Awaited<ReturnType<typeof effectiveFields>>) : {}
  const names = [...new Set([...(fl?.fields ?? []).map((f) => f.field), ...Object.keys(eff)])]
  return {
    labels: (cls?.labels ?? []).map((l) => ({ classId: l.classId, source: l.source, confidence: l.confidence, adopted: l.adopted, reason: l.reason === null ? null : show(l.reason) })),
    fields: names.map((name) => {
      const f = (fl?.fields ?? []).find((x) => x.field === name)
      const e = (eff as Record<string, { status: string; value: unknown; confirmed: boolean }>)[name]
      if (e?.confirmed) return { field: name, status: e.status, value: e.value === null ? null : text(name, e.value as Value), candidates: [], needsConfirmation: false, reason: null, confirmed: true }
      return {
        field: name,
        status: f!.status,
        value: f!.status === 'void' || f!.value === null ? null : text(name, f!.value),
        candidates: f!.candidates.map((c) => text(name, c)),
        needsConfirmation: f!.needsConfirmation,
        reason: f!.reason === null ? null : show(f!.reason),
        confirmed: false,
      }
    }),
  }
}

// ---------- G4 (C-RED-2): no date of birth, nothing from a possible KYC attachment ----------

async function dobValues(db: Db, k: Keyring, messageId: string): Promise<string[]> {
  const rows = (await db.query<{ value_blob: string }>(`SELECT value_blob FROM redaction_map WHERE message_id = $1 AND placeholder LIKE '[DOB_%'`, [messageId])).rows
  const b = await getBlobs(db, k, rows.map((r) => r.value_blob))
  return rows.map((r) => b.get(r.value_blob)!.toString('utf8').trim())
}

const partText = (m: MessageView, part: string): string => {
  if (part === 'subject') return m.subject
  if (part === 'body') return m.text
  if (part === 'body_html') return m.htmlText
  const n = /^attachment_(?:text|name):(\d+)$/.exec(part)
  const a = n ? m.attachments.find((x) => x.ordinal === Number(n[1])) : undefined
  return a ? (part.startsWith('attachment_name') ? a.filename : a.text) : ''
}

/** Every occurrence of a date of birth (C-RED-1 v0.7.3) shows as hidden; values from a possible-KYC attachment too. */
export function masked(ex: Extraction | null, m: MessageView, dobs: readonly string[], kycOrdinals: ReadonlySet<number>): (Extraction & { hidden: { dates: number; kyc: number } }) | null {
  if (!ex) return null
  const fromKyc = (part: string) => {
    const n = /^attachment_(?:text|name):(\d+)$/.exec(part)
    return n !== null && kycOrdinals.has(Number(n[1]))
  }
  let dates = 0
  let kyc = 0
  const isDob = (part: string, s: number, e: number) => dobs.includes(partText(m, part).slice(s, e).trim())
  const out = {
    ...ex,
    dates: ex.dates.map((d) => {
      if (fromKyc(d.at.part)) return (kyc++, { ...d, iso: null, status: 'hidden_kyc' })
      if (isDob(d.at.part, d.at.originalStart, d.at.originalEnd)) return (dates++, { ...d, iso: null, status: 'hidden_dob' })
      return d
    }),
    amounts: ex.amounts.filter((a) => (fromKyc(a.at.part) ? (kyc++, false) : true)),
    accounts: ex.accounts.filter((a) => (fromKyc(a.at.part) ? (kyc++, false) : true)),
  }
  return { ...out, hidden: { dates, kyc } }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x))

async function e3View(deps: { db: Db; k: Keyring; files: FileStore; config: Config }, id: string, messageId: string, viewer?: { id: string; role: string }): Promise<CaseE3 | null> {
  const { db, k, config } = deps
  const c = (await db.query(`SELECT processing_generation, pipeline_complete_generation, manual_revision, risk, risk_by, risk_hold, due_at, follow_up_at, assignee, outcome, snapshot_id, status, m.received_at
     FROM "case" JOIN message m ON m.id = "case".message_id WHERE "case".id = $1`, [id])).rows[0]
  const gen = c.processing_generation as number
  const done = c.pipeline_complete_generation as number | null
  // the same generation as the CSV and the events (self-review S5)
  const shown = (await outputGeneration(db, id, gen, done)).gen
  const lk = await resultAt<LinkResult>(db, k, id, 'link', shown)
  const rk = await resultAt<RiskStageResult>(db, k, id, 'risk', shown)
  const rp = await resultAt<ReplyStageResult>(db, k, id, 'reply', shown)
  if (!lk || !rk || !rp) return null
  const labels = await effectiveLabels({ db, k }, id, shown)
  const cls = await resultAt<ClassifyResult>(db, k, id, 'classify', shown)
  const snap = await loadSnapshot(db, k, c.snapshot_id)
  const adj = (await db.query(`SELECT level, state FROM risk_adjustment WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0]
  const firstSnapshot = (await db.query<{ s: string }>(`SELECT payload->>'snapshot_id' AS s FROM audit WHERE case_id = $1 AND type = 'ingest.received' LIMIT 1`, [id])).rows[0]?.s
  const replies = (await db.query(`SELECT id, generation, template_id, template_source, edited, recipient_blob, subject_blob, text_blob, status, check_ok, check_problems, removed_sentences, created_at FROM reply WHERE case_id = $1 AND status <> 'superseded' ORDER BY created_at DESC`, [id])).rows
  const tasks = (await db.query(`SELECT id, kind, state, checklist, checked, bound_contact_blob, phone_blob, notify_recipient_blob, notify_subject_blob, notify_text_blob, notify_problems, completed_by, completed_at, cooling_until, approved_by FROM verification_task WHERE case_id = $1 AND state <> 'invalidated' ORDER BY created_at`, [id])).rows
  const blobIds = [...replies.flatMap((r) => [r.recipient_blob, r.subject_blob, r.text_blob]), ...tasks.flatMap((t) => [t.bound_contact_blob, t.phone_blob, t.notify_recipient_blob, t.notify_subject_blob, t.notify_text_blob])].filter(Boolean) as string[]
  const b = await getBlobs(db, k, blobIds)
  const t = (x: string | null) => (x ? b.get(x)!.toString('utf8') : null)
  const ctx = await replyContext(deps, id, messageId, shown)
  const contact = lk.links.contact.id ? snap.contacts.find((x) => x.contactId === lk.links.contact.id) : undefined
  // D8: the class floor behind the risk (C-RSK-1), as saved with the generation shown (not the live configuration,
  // review F3); results saved before D8 have none
  const base = rk.computed.base
  const floorClasses = rk.computed.floorClasses ?? []
  // D8: classes a person removed and that are still removed, with who and why
  const changes = (await db.query<{ class_id: string; action: string; by_user: string | null; reason_blob: string | null }>(
    'SELECT DISTINCT ON (class_id) class_id, action, by_user, reason_blob FROM case_label_change WHERE case_id = $1 ORDER BY class_id, created_at DESC', [id])).rows
    .filter((x) => x.action === 'remove' && !rp.labels.adopted.includes(x.class_id) && !rp.labels.low.includes(x.class_id)) // low counts for risk too (Codex D8 F2)
  const people = changes.length ? (await db.query<{ id: string; username_blob: string }>('SELECT id, username_blob FROM app_user WHERE id = ANY($1::uuid[])', [changes.flatMap((x) => (x.by_user ? [x.by_user] : []))])).rows : []
  const cb = await getBlobs(db, k, [...changes.flatMap((x) => (x.reason_blob ? [x.reason_blob] : [])), ...people.map((u) => u.username_blob)])
  const nameOf = (u: string | null) => { const r = people.find((x) => x.id === u); return r ? cb.get(r.username_blob)!.toString('utf8') : null }
  const ids = [...new Set([...tasks.flatMap((t) => t.completed_by ? [t.completed_by as string] : []), ...(viewer ? [viewer.id] : [])])]
  const history = ids.length ? (await db.query<{ user_id: string; type: UserEvent['type']; role: string | null; by_user: string | null; at: Date }>(
    'SELECT user_id, type, role, by_user, at FROM user_event WHERE user_id = ANY($1::uuid[]) OR by_user = ANY($1::uuid[]) ORDER BY at', [ids],
  )).rows.map((e) => ({ userId: e.user_id, type: e.type, role: e.role, byUser: e.by_user, at: e.at.toISOString() })) : []
  const roles = ids.length ? Object.fromEntries((await db.query<{ id: string; role: string }>('SELECT id, role FROM app_user WHERE id = ANY($1::uuid[])', [ids])).rows.map((u) => [u.id, u.role])) : {}
  const now = new Date().toISOString()
  const failures = (x: (typeof tasks)[number]) => x.state !== 'checklist_done' || !x.completed_at || !x.completed_by ? [] : approvalFailures({
    completedBy: x.completed_by, approver: viewer ?? { id: x.completed_by, role: roles[x.completed_by] ?? 'reviewer' },
    checklistDoneAt: (x.completed_at as Date).toISOString(), now, coolingMs: config.verification.cooling_off_hours * 3_600_000,
    currentRoles: roles, events: history,
  }).filter((f) => viewer || f.subject === 'completer')
  return {
    generation: gen, complete: done === gen, manualRevision: c.manual_revision, adopted: rp.labels.adopted, low: rp.labels.low, pendingAdopted: sameSet(labels.adopted, rp.labels.adopted) ? null : labels.adopted,
    ruleLabels: (cls?.labels ?? []).filter((l) => l.source === 'rule').map((l) => l.classId),
    removed: changes.map((x) => ({ classId: x.class_id, by: nameOf(x.by_user), reason: x.reason_blob ? cb.get(x.reason_blob)!.toString('utf8') : null })),
    // the risk of the generation shown, beside its classes (self-review T2)
    risk: { computed: rk.computed.level, final: rk.final, by: rk.by, clauses: rk.computed.clauses.filter((x) => x.hit).map((x) => x.id), floor: floorClasses.length ? { level: base, classes: floorClasses } : null, adjustment: adj ? { level: adj.level, state: adj.state } : null, held: c.risk_hold, applied: rk.applied ?? rk.final },
    pendingRisk: c.risk && c.risk !== rk.final ? c.risk : null,
    links: {
      contact: contact ? { id: contact.contactId, name: contact.name } : null, contactCandidates: lk.links.contact.candidates,
      commitment: lk.commitment ? { key: lk.commitment.key, investorName: lk.commitment.investorName, reference: lk.commitment.reference } : null, commitmentCandidates: lk.links.commitment.candidates,
      deal: lk.dealName, dealCandidates: lk.links.deal.candidates, dealConflict: lk.links.deal.conflict, bankLines: lk.links.bankLines,
      authenticatedSender: lk.authenticated, mayDisclose: lk.mayDisclose, ledger: lk.ledger,
    },
    signalsFromEarlierSnapshot: firstSnapshot !== undefined && firstSnapshot !== c.snapshot_id,
    actions: await currentActions(db, id, shown, rp), // the reply in use now (Codex round 2 F18)
    autoTemplate: rp.selection.template,
    allowedTemplates: allowedManualTemplates(ctx.select),
    replies: replies.map((r) => ({ id: r.id, templateId: r.template_id, source: r.template_source, edited: r.edited, recipient: t(r.recipient_blob), subject: t(r.subject_blob)!, text: t(r.text_blob)!, status: r.status, checkOk: r.check_ok, problems: r.check_problems, removed: r.removed_sentences, bodyEditable: bodyEditable(r.template_id), createdAt: (r.created_at as Date).toISOString(), outOfDate: r.generation !== gen && (r.status === 'draft' || r.status === 'approved') })),
    allowedRecipients: ctx.allowed,
    verification: tasks.map((x) => ({
      id: x.id, kind: x.kind, state: x.state, checklist: (x.checklist as string[]).map((i) => ({ id: i, text: CHECKLIST_TEXT[i as keyof typeof CHECKLIST_TEXT] ?? i, checked: (x.checked as string[]).includes(i) })),
      phone: t(x.phone_blob) ?? NO_PHONE_TEXT_EN, notifyRecipient: t(x.notify_recipient_blob), notifySubject: t(x.notify_subject_blob), notifyText: (x.notify_problems as string[]).length ? null : t(x.notify_text_blob), notifyProblems: x.notify_problems as string[],
      approvalFailures: failures(x),
      completedBy: x.completed_by, coolingUntil: x.cooling_until ? (x.cooling_until as Date).toISOString() : null, approvedBy: x.approved_by,
      // C-FRD-4 v0.7.21: the task's contact is the one the display name impersonates
      impersonatedContact: taskContactOf(lk)?.impersonated && t(x.bound_contact_blob) === taskContactOf(lk)!.contact.contactId ? taskContactOf(lk)!.contact.name : null,
    })),
    due: { at: c.due_at ? (c.due_at as Date).toISOString() : null, state: c.due_at && c.status !== 'closed' ? dueState(calendar(config), (c.received_at as Date).toISOString(), (c.due_at as Date).toISOString(), now, config.routing.remind_share) : null, followUpAt: c.follow_up_at && c.status !== 'closed' ? (c.follow_up_at as Date).toISOString() : null },
    assignee: c.assignee, outcome: c.outcome,
  }
}

async function resultAt<T>(db: Db, k: Keyring, caseId: string, stage: string, generation: number): Promise<T | null> {
  const r = await db.query<{ result_blob: string | null }>('SELECT result_blob FROM stage_run WHERE case_id = $1 AND stage = $2 AND generation = $3', [caseId, stage, generation])
  return r.rows[0]?.result_blob ? getJson<T>(db, k, r.rows[0].result_blob) : null
}
