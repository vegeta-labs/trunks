// Evaluation runner (test plan §4.2, PRD §6): each sample from an empty pipeline state with the eval directory, its
// own mailbox setting and received_at; the E2 metrics against the annotations. Needs the test Postgres.
//   node --experimental-strip-types --no-warnings eval/run.ts [eval/dev] [--record] [--json report.json]
// Default: recorded replies (eval/replay). --record calls the configured real model and writes the recordings.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { loadConfig } from '../src/config/load.ts'
import { exportChildren, exportStatus, ownText, type NestedFacts } from './kyc-export.ts'
import { createKit, FakeLlm } from '../src/pipeline/testkit.ts'
import { loadMessage, stageResult, type ClassifyResult, type Extraction, type FieldsResult } from '../src/pipeline/stages.ts'
import { emailHmac, loadSnapshot } from '../src/store/directory.ts'
import { importDeals } from '../src/lib/directory.ts'
import { getBlobs, putJson } from '../src/store/blobs.ts'
import { msgIdNorm } from '../src/pipeline/ingest.ts'
import { randomUUID } from 'node:crypto'
import { ANTHROPIC_SETTINGS, AnthropicAdapter } from '../src/adapters/llm/anthropic.ts'
import { Recorder, ReplayAdapter } from '../src/adapters/llm/replay.ts'
import type { LlmAdapter } from '../src/adapters/llm/types.ts'
import { failures, score, type Annotation, type SystemField, type SystemOutput } from './metrics.ts'
import { directoryLedger, DISCLOSING, parseDirectoryCsv, e3Failures, scoreE3, type E3Annotation, type E3Output } from './metrics-e3.ts'

import { effectiveFields, effectiveLabels, hadBankRuleLabel, type LinkResult, type ReplyStageResult, type RiskStageResult } from '../src/pipeline/stages-e3.ts'
import { restartFrom } from '../src/pipeline/restart.ts'
import { createUser } from '../src/server/auth.ts'
import { tx } from '../src/store/db.ts'
import { putJson as putJsonBlob } from '../src/store/blobs.ts'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--') && !a.endsWith('.json')) ?? 'eval/dev'
const record = args.includes('--record')
// --fake: a model that always answers "unclassified" (plumbing and the rule-field metric, which does not use the model)
const fake = args.includes('--fake')
const jsonOut = args[args.indexOf('--json') + 1] && args.includes('--json') ? args[args.indexOf('--json') + 1]! : null

const config = loadConfig('eval/config')
const m = config.model!
const llm = fake
  ? new FakeLlm()
  : record
  ? new Recorder(new AnthropicAdapter({ model: m.model_id, ...(process.env[m.api_key_env] ? { apiKey: process.env[m.api_key_env]! } : {}) }), m.replay_dir!, m.model_id)
  : new ReplayAdapter(m.replay_dir!, m.model_id, ANTHROPIC_SETTINGS)
// PRD §6 rule input (v0.7.28, F1-2 reading A): a second processing where the model's answer is the annotation's
// classes, so C-CLS-4a E5 reads them too; the real model's answer is used only for the end-to-end run
let annotated: string[] | null = null
const switching: LlmAdapter = {
  get id() { return llm.id },
  get location() { return llm.location },
  async complete(req) {
    if (annotated === null) return llm.complete(req)
    const raw = req.promptVersion.startsWith('classify')
      ? JSON.stringify({ labels: (annotated.length ? annotated : ['unclassified']).slice(0, 4).map((c) => ({ class: c, confidence: 'high', reason: 'rule input' })), language: 'en' })
      : '{"fields":{}}'
    return { raw, parsed: req.schema.parse(JSON.parse(raw)), usage: { inputTokens: 0, outputTokens: 0 } }
  },
}
const k = await createKit({ config, llm: switching })
let e5Cancelled = 0
let e5Decided = 0

// the directory, once (Q2 / Q3: files as the evaluation author wrote them, the deal named by its file)
const D = 'eval/directory'
const csv = (f: string) => readFileSync(join(D, f), 'utf8')
await k.importCsv('deals', csv('deals.csv'))
const dealNames = csv('deals.csv').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')[1]!)
const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
for (const name of dealNames) {
  for (const kind of ['commitments', 'bank', 'ledger'] as const) {
    const f = `${kind}_${slug(name)}.csv`
    if (readdirSync(D).includes(f)) await k.importCsv(kind, csv(f), name)
  }
}
await k.importCsv('contacts', csv('contacts.csv'))

// per-sample state lives in these tables; the directory tables stay
// the audit table refuses deletes (C-AUD-2): the throwaway evaluation database resets with triggers off, in one statement batch
const RESET = 'SET session_replication_role = replica; TRUNCATE message, message_file, attachment, attachment_text, "case", stage_run, case_signal, case_label, case_field, model_output, redaction_map, audit, audit_detail, file_write_intent, case_label_change, case_field_change, case_link, risk_adjustment, reply, verification_task, event_outbox, event_state CASCADE; DELETE FROM pgboss.job; SET session_replication_role = origin'

// SCHEMA `prior_messages`: messages this deployment received before the sample, recorded with the same keys ingest
// uses, so `first_time_sender` and `message_id_collision` follow from them (test plan §4.2). Only these columns matter;
// the annotation has no raw hash, so the hash without Message-ID stands in for it.
interface PriorMessage { from: string; message_id: string; sans_msgid_sha256: string }
async function loadPrior(mailbox: string, receivedAt: string, prior: PriorMessage[]): Promise<void> {
  for (const [i, p] of prior.entries()) {
    const msgId = msgIdNorm(p.message_id)
    await k.db.query(
      `INSERT INTO message (id, mailbox_id, dedupe_key_hmac, received_at, observed_seq, from_addr_hmac, message_id_hmac, header_blob, thread_id, raw_sha256, raw_sans_msgid_sha256, collision)
       VALUES ($1, $2, $3, $4::timestamptz - interval '1 day', $5, $6, $7, $8, $9, $10, $10, false)`,
      [randomUUID(), mailbox, k.k.hmac(`dedupe\0${mailbox}\0id:${msgId}`), receivedAt, i + 1, emailHmac(k.k, p.from), k.k.hmac(`msgid\0${msgId}`), await putJson(k.db, k.k, {}), randomUUID(), p.sans_msgid_sha256],
    )
  }
}

/** Test plan §3 raw inputs for the oracle's rule-consistency check (v0.7.12 of the test plan). */
async function exportAttachments(caseId: string): Promise<unknown[]> {
  const messageId = (await k.db.query<{ message_id: string }>('SELECT message_id FROM "case" WHERE id = $1', [caseId])).rows[0]!.message_id
  const m = await loadMessage(k, messageId)
  const kyc = new Map((await k.db.query<{ ordinal: number; maybe_kyc: boolean | null }>('SELECT ordinal, maybe_kyc FROM attachment WHERE message_id = $1', [messageId])).rows.map((r) => [r.ordinal, r.maybe_kyc]))
  return m.attachments.map((a) => {
    const f = a.facts as NestedFacts | null
    return {
      ordinal: a.ordinal, filename: a.filename, kind: a.kind, parse_status: exportStatus(a.parseStatus, f), pdf_pages: f?.pages ?? null,
      pdf_pages_without_text: f?.pagesWithoutText ?? null, text: ownText(a.text, f), children: exportChildren(f), maybe_kyc: kyc.get(a.ordinal) ?? null,
    }
  })
}

async function rawInputs(caseId: string, snap: Awaited<ReturnType<typeof loadSnapshot>>, lk: LinkResult) {
  const msgId = (await k.db.query<{ message_id: string }>('SELECT message_id FROM "case" WHERE id = $1', [caseId])).rows[0]!.message_id
  const m = await loadMessage(k, msgId)
  const dmarc = (await k.db.query<{ value: boolean | null }>(`SELECT value FROM case_signal WHERE case_id = $1 AND signal = 'dmarc_pass'`, [caseId])).rows[0]?.value === true
  const from = (m.fromAddress ?? '').toLowerCase()
  const matches = snap.contacts.filter((x) => x.emails.some((e) => e.toLowerCase() === from))
  const c = lk.commitment ? snap.commitments.find((x) => `${snap.deals.find((dd) => dd.dealKey === x.dealKey)?.name}::${x.investorId}` === lk.commitment!.key) : undefined
  const deal = c ? snap.deals.find((dd) => dd.dealKey === c.dealKey) : undefined
  const bare = new Map(snap.commitments.map((x) => [x.keyHmac, x.investorId]))
  return {
    mime_failed: (await k.db.query<{ flags: string[] }>('SELECT flags FROM "case" WHERE id = $1', [caseId])).rows[0]!.flags.includes('mime_parse_failed'),
    dmarc_pass: dmarc,
    sender_contacts: matches.map((x) => ({ contact_id: x.contactId, investor_ids: x.investorIds, authorised_for: x.authorisedFor, deals: x.deals })),
    commitment: c && deal ? { cash_due_minor: c.cashDue, deal_currency: deal.currency, ledger: snap.ledgerDeals.includes(deal.dealKey) ? snap.ledger.filter((l) => l.dealKey === deal.dealKey).map((l) => ({ status: l.status, investor_id: l.commitmentKeyHmac ? (bare.get(l.commitmentKeyHmac) ?? '') : '', currency: l.currency, amount_minor: l.amount })) : null } : null,
    pressure_texts: [m.subject, m.text, m.htmlText],
    account_texts: [m.subject, m.text, m.htmlText, ...m.attachments.flatMap((a) => [a.filename, a.text])],
  }
}

// test plan §3 v0.7.26: the C-CLS-4a inputs for the oracle; the evaluation directory is fictional, so its accounts are plain here
async function f1Input(caseId: string, cls: ClassifyResult, lk: LinkResult, ex: Extraction, snap: Awaited<ReturnType<typeof loadSnapshot>>) {
  const msgId = (await k.db.query<{ message_id: string }>('SELECT message_id FROM "case" WHERE id = $1', [caseId])).rows[0]!.message_id
  const m = await loadMessage(k, msgId)
  const deals = importDeals(csv('deals.csv'), config.deployment.currencies)
  return {
    subject: m.subject, body: m.text, body_html: m.htmlText,
    attachments: m.attachments.map((a) => ({ ordinal: a.ordinal, kind: a.kind, filename: a.filename, parse_status: a.parseStatus, maybe_kyc: a.maybeKyc, text: a.text })),
    model_labels: cls.modelFailed ? null : cls.labels.filter((l) => l.source === 'model').map((l) => l.classId),
    esign_invite: ex.esign.esignInvite,
    references: ex.references.map((r) => {
      const hit = snap.commitments.find((c) => c.reference === r.value)
      return { reference: r.value, deal: hit ? snap.deals.find((d) => d.dealKey === hit.dealKey)?.name ?? null : null }
    }),
    receiving_accounts: deals.ok ? Object.fromEntries(deals.rows.map((d) => [d.name, d.receivingAccounts])) : {},
    link_deal: lk.dealName,
  }
}

const ids = readdirSync(dir).filter((f) => /^E\d+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort()
// the sample set is pinned: a deleted or renamed sample fails the run instead of quietly shrinking it
const pinned = readdirSync(dir).includes('IDS.txt') ? readFileSync(join(dir, 'IDS.txt'), 'utf8').split(/\r?\n/).filter(Boolean).sort() : null
const setProblems: string[] = []
if (ids.length === 0) setProblems.push('no samples')
if (pinned && pinned.join() !== ids.join()) setProblems.push(`samples differ from IDS.txt (missing ${pinned.filter((x) => !ids.includes(x)).join(' ') || '-'}, extra ${ids.filter((x) => !pinned.includes(x)).join(' ') || '-'})`)
if (!pinned && relative(resolve('eval/dev'), resolve(dir)) === '') setProblems.push('eval/dev/IDS.txt missing')
// the E3 rule-input run changes labels and fields as this user (PRD §6 «规则输入», evaluation only)
const evalUser = await tx(k.db, (c) => createUser(c, k.k, { username: `eval-${Date.now()}`, role: 'admin', password: null, by: null }))
const MILESTONE = readFileSync('docs/milestone.txt', 'utf8').trim()
const e3Enabled = ['E3', 'E4', 'E5', 'E6', 'F1'].includes(MILESTONE)
// test plan §3 export for the oracle; EVAL_ACTUAL_DIR keeps it where TC-DEMO-01 compares the demo with it
const actualDir = process.env.EVAL_ACTUAL_DIR ? (mkdirSync(process.env.EVAL_ACTUAL_DIR, { recursive: true }), process.env.EVAL_ACTUAL_DIR) : mkdtempSync(join(tmpdir(), 'doi-actual-'))
mkdirSync(actualDir, { recursive: true })
const e2e = new Map<string, E3Output>()
const rulesRun = new Map<string, E3Output>()
const anns: Annotation[] = []
const outs: SystemOutput[] = []
let errors = 0
const signalMisses: string[] = [] // E1 signals against the annotation (shown; the E3 risk metrics build on them)
let fallbacks = 0 // samples where a model step fell back (both attempts failed): shown, so a drop is visible
for (const id of ids) {
  const ann = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as Annotation & { received_at: string; mailbox: string; mailbox_strips_auth_results: boolean; prior_messages: PriorMessage[] }
  anns.push(ann)
  await k.t.owner.query(RESET)
  try {
    const mailbox = ann.mailbox === 'legal' ? 'legal' : 'ops'
    await loadPrior(mailbox, ann.received_at, ann.prior_messages)
    const r = await k.ingest(readFileSync(join(dir, `${id}.eml`)), ann.received_at, { id: mailbox, trustedAuthResults: ann.mailbox_strips_auth_results, trustedAuthservId: 'mx.ops.example' })
    await k.drain()
    const firstId = (r as { caseId?: string }).caseId
    if (!firstId) throw new Error(`not ingested: ${JSON.stringify(r)}`)
    let caseId: string = firstId
    const cls = await stageResult<ClassifyResult>(k.db, k.k, caseId, 'classify')
    const ex = await stageResult<Extraction>(k.db, k.k, caseId, 'extract')
    const fl = await stageResult<FieldsResult>(k.db, k.k, caseId, 'fields')
    if (!cls || !ex || !fl) throw new Error(`pipeline did not finish: ${(await k.db.query('SELECT status, failed_stage FROM "case" WHERE id = $1', [caseId])).rows[0]?.failed_stage}`)
    if (cls.modelFailed || fl.modelFailed) fallbacks++
    // the real model cancelling C-CLS-4a for a message that otherwise qualifies (reported, no gate)
    // eligible = the exception would apply if the model gave only payment classes (every other condition holds)
    if (cls.exemptionWithoutModel === true) {
      e5Decided++
      if (cls.evidenceExemption && !cls.evidenceExemption.applied) e5Cancelled++
    }
    const sig = new Map((await k.db.query<{ signal: string; value: boolean | null }>('SELECT signal, value FROM case_signal WHERE case_id = $1', [caseId])).rows.map((x) => [x.signal, x.value]))
    // null = unknown (auth results not adopted); an absent signal is false
    for (const [name, want] of Object.entries((ann as unknown as { signals: Record<string, boolean | null> }).signals)) {
      const got = sig.has(name) ? sig.get(name)! : false
      if (got !== want) signalMisses.push(`${id} ${name}=${got}`)
    }
    // evaluation only: NAME / EMAIL / PHONE / ADDRESS placeholders restored before comparing (PRD §6); deal keys as names
    const map = (await k.db.query<{ placeholder: string; value_blob: string }>('SELECT placeholder, value_blob FROM redaction_map')).rows
    const vals = await getBlobs(k.db, k.k, map.map((x) => x.value_blob))
    const restore = new Map(map.filter((x) => /^\[(NAME|EMAIL|PHONE|ADDRESS)_\d+\]$/.test(x.placeholder)).map((x) => [x.placeholder, vals.get(x.value_blob)!.toString('utf8')]))
    const snapshot = (await k.db.query<{ snapshot_id: string }>('SELECT snapshot_id FROM "case" WHERE id = $1', [caseId])).rows[0]!.snapshot_id
    const dealName = new Map((await loadSnapshot(k.db, k.k, snapshot)).deals.map((d) => [d.dealKey, d.name]))
    const forCompare = (field: string, v: unknown): unknown =>
      v === null ? null : field === 'deal' && typeof v === 'string' ? (dealName.get(v) ?? v) : typeof v === 'string' ? v.replace(/\[[A-Z]+_\d+\]/g, (p) => restore.get(p) ?? p) : v
    const fields: Record<string, SystemField> = {}
    for (const f of fl.fields) fields[f.field] = { status: f.status, value: forCompare(f.field, f.value), candidates: f.candidates.map((c) => forCompare(f.field, c)), reason: f.reason }
    outs.push({
      id,
      adopted: cls.adopted,
      fields,
      ruleOutput: {
        uetrs: ex.uetrs.map((u) => u.value),
        uetr_candidates_invalid: ex.uetrCandidatesInvalid.map((u) => u.value),
        amounts: [...ex.amounts.map((a) => ({ minor: a.minor, currency: a.currency })), ...ex.evidence.flatMap((e) => (e.minor !== null && e.currency ? [{ minor: e.minor, currency: e.currency }] : []))],
        references: ex.references.map((x) => x.value),
        account_last4: [...new Set(ex.accounts.map((a) => a.last4))],
        evidence_value_dates: [...new Set(ex.evidence.flatMap((e) => (e.valueDate ? [e.valueDate] : [])))],
      },
    })

    // ---------- E3 (PRD §6 v0.7.15) ----------
    const snap = await loadSnapshot(k.db, k.k, snapshot)
    const dealKeyOf = new Map(snap.deals.map((d) => [d.name, d.dealKey]))
    const readE3 = async (): Promise<{ out: E3Output; lk: LinkResult; rk: RiskStageResult; fieldsOut: Record<string, unknown> }> => {
      const st = (await k.db.query('SELECT status, failed_stage, risk FROM "case" WHERE id = $1', [caseId])).rows[0]
      const lk = await stageResult<LinkResult>(k.db, k.k, caseId, 'link')
      const rk = await stageResult<RiskStageResult>(k.db, k.k, caseId, 'risk')
      const rp = await stageResult<ReplyStageResult>(k.db, k.k, caseId, 'reply')
      if (!lk || !rk || !rp) throw new Error(`E3 stages did not finish: ${st?.failed_stage}`)
      const gen = (await k.db.query<{ g: number }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [caseId])).rows[0]!.g
      const labels = await effectiveLabels(k, caseId, gen)
      const ef = await effectiveFields(k, caseId, gen)
      const fieldsOut: Record<string, unknown> = {}
      for (const [f, v] of Object.entries(ef)) {
        const val = (x: unknown) => forCompare(f, x)
        fieldsOut[f] = v.status === 'multiple' ? { multiple: v.candidates.map(val) } : v.status === 'void' ? { void: 'void' } : v.status === 'empty' ? null : val(v.value)
      }
      const out: E3Output = {
        id, risk: rk.final, template: rp.selection.template, adopted: labels.adopted, low: labels.low,
        ruleLabels: [...new Set([...cls.labels.filter((l) => l.source === 'rule').map((l) => l.classId), ...((await hadBankRuleLabel(k.db, caseId)) ? ['bank_details'] : [])])],
        links: { contact_id: lk.links.contact.id, investor_id: lk.commitment?.key ?? null, deal: lk.dealName },
        typed: fieldsOut,
        injectionHit: sig.get('injection_markers') === true || sig.get('hidden_text') === true,
      }
      return { out, lk, rk, fieldsOut }
    }
    if (e3Enabled || process.env.EVAL_E3 === '1') {
      const real = await readE3()
      e2e.set(id, real.out)
      // test plan §3: the actual inputs, for the oracle's rule-consistency check
      writeFileSync(join(actualDir, `${id}.actual.json`), JSON.stringify({
        id, received_at: ann.received_at, mailbox: ann.mailbox, classes: real.out.adopted, low_labels: real.out.low, fields: real.fieldsOut,
        signals: Object.fromEntries([...sig].filter(([n]) => n !== 'dmarc_pass')),
        rule_output: { ...outs[outs.length - 1]!.ruleOutput, amounts_attachment: real.rk.inputs.amountsAttachment, blocked_or_over_limit: real.rk.inputs.blockedOrOverLimit },
        links: { ...real.out.links, transaction_ids: real.lk.links.bankLines.map((b) => b.transactionId) },
        // raw inputs only (self-test CF7): the oracle computes C-SIG-3, C-LNK-5, C-DRF-6, the pressure words and the
        // account shapes itself; the system's own results are only the risk and the template it checks
        amounts_body: real.rk.inputs.amountsBody, planned_close_date: real.lk.dealCloseDate, risk: real.out.risk, template: real.out.template,
        ...(await rawInputs(caseId, snap, real.lk)),
        attachments: await exportAttachments(caseId),
        rule_labels: real.out.ruleLabels,
        f1_input: await f1Input(caseId, cls, real.lk, ex, snap),
      }, null, 1))
      // rule input: the same email again, the annotated classes as the model's answer (rule labels by the code), the
      // annotated fields as the final fields, then link → emit again
      await k.t.owner.query(RESET)
      await loadPrior(mailbox, ann.received_at, ann.prior_messages)
      annotated = [...ann.classes]
      let second: unknown
      // the override stays on until the rule run is read: a later restart (the risk step's fields) asks again
      second = await k.ingest(readFileSync(join(dir, `${id}.eml`)), ann.received_at, { id: mailbox, trustedAuthResults: ann.mailbox_strips_auth_results, trustedAuthservId: 'mx.ops.example' })
      await k.drain()
      const secondId = (second as { caseId?: string }).caseId
      if (!secondId) throw new Error(`rule input not ingested: ${JSON.stringify(second)}`)
      caseId = secondId
      const ruleCls = (await stageResult<ClassifyResult>(k.db, k.k, caseId, 'classify'))!
      const gen = (await k.db.query<{ g: number }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [caseId])).rows[0]!.g
      const labels = await effectiveLabels(k, caseId, gen)
      const ruleIds = new Set([...ruleCls.labels.filter((l) => l.source === 'rule').map((l) => l.classId), ...((await hadBankRuleLabel(k.db, caseId)) ? ['bank_details'] : [])])
      await tx(k.db, async (c) => {
        for (const cl of new Set([...labels.adopted, ...labels.low])) if (!ruleIds.has(cl) && !ann.classes.includes(cl)) await c.query('INSERT INTO case_label_change (id, case_id, class_id, action, by_user) VALUES (gen_random_uuid(), $1, $2, $3, $4)', [caseId, cl, 'remove', evalUser])
        for (const cl of ann.classes) if (!labels.adopted.includes(cl)) await c.query('INSERT INTO case_label_change (id, case_id, class_id, action, by_user) VALUES (gen_random_uuid(), $1, $2, $3, $4)', [caseId, cl, 'add', evalUser])
        // fields the annotation does not list are empty in the rule input (self-test CF8)
        for (const f of Object.keys(await effectiveFields(k, caseId, gen))) {
          if (!(f in ann.fields)) await c.query('INSERT INTO case_field_change (id, case_id, field, value_blob, by_user) VALUES (gen_random_uuid(), $1, $2, NULL, $3)', [caseId, f, evalUser])
        }
        for (const [f, v] of Object.entries(ann.fields)) {
          const stored = v === null ? null : typeof v === 'object' && v !== null && ('multiple' in v || 'void' in v) ? v : { value: f === 'deal' && typeof v === 'string' ? (dealKeyOf.get(v) ?? v) : v }
          await c.query('INSERT INTO case_field_change (id, case_id, field, value_blob, by_user) VALUES (gen_random_uuid(), $1, $2, $3, $4)', [caseId, f, stored === null ? null : await putJsonBlob(c, k.k, stored as never), evalUser])
        }
        await restartFrom(c, k.queue, caseId, 'link', 'system')
      })
      await k.drain()
      rulesRun.set(id, (await readE3()).out)
      annotated = null
    }
  } catch (e) {
    errors++
    console.error(`${id}: ${(e as Error).message.slice(0, 200)}`)
  }
}
await k.close()

const floors = Object.fromEntries(config.classes.map((c) => [c.id, c.risk_floor]))
const report = score(anns, outs, floors)
const pct = (x: { value: number | null; numerator: number; denominator: number }) => (x.value === null ? 'n/a' : `${(x.value * 100).toFixed(1)}% (${x.numerator}/${x.denominator})`)
console.log(`\nEvaluation: ${dir}, ${ids.length} samples, model ${llm.id}${fake ? ' (fake model)' : record ? ' (recording)' : ' (replay)'}, ${errors} not processed, ${fallbacks} model fallbacks`)
console.log(`  classification macro F1  ${report.classification.value === null ? 'n/a' : report.classification.value.toFixed(3)} (≥ 0.85)`)
for (const [c, x] of Object.entries(report.classification.perClass)) console.log(`    ${c.padEnd(22)} F1 ${x.f1.toFixed(2)}  tp ${x.tp} fp ${x.fp} fn ${x.fn}`)
console.log(`  rule fields              ${pct(report.ruleFields)} (100%)`)
console.log(`  field recall             ${pct(report.fieldRecall)} (≥ 90%)`)
console.log(`  E5 cancellations (real model, report): ${e5Cancelled} of ${e5Decided} payment messages that otherwise qualify`)
console.log(`  field precision          ${pct(report.fieldPrecision)} (≥ 90%)`)
console.log(`  empty fields             ${pct(report.emptyFields)} (≥ 95%)`)
console.log(`  signals (shown)          ${signalMisses.length ? `${signalMisses.length} differ: ${signalMisses.join(', ')}` : 'all equal the annotation'}`)
if (report.ruleFields.failures.length) console.log(`  rule field failures: ${report.ruleFields.failures.map((f) => `${f.id} ${f.item}`).join(', ')}`)
const failed = failures(report)
let e3: ReturnType<typeof scoreE3> | null = null
if (e2e.size) {
  writeFileSync(join(actualDir, 'classes.json'), JSON.stringify(config.classes.map((c) => ({ id: c.id, risk_floor: c.risk_floor }))))
  writeFileSync(join(actualDir, 'calendar.json'), JSON.stringify({ timezone: config.deployment.timezone, start: config.routing.working_hours.start, end: config.routing.working_hours.end, holidays: config.routing.holidays }))
  let oracle = { ok: false, text: '' }
  try {
    oracle = { ok: true, text: execFileSync('python3', ['eval/oracle/check_actual.py', '--require-attachments', '--eml-dir', dir, actualDir], { encoding: 'utf8' }) }
  } catch (e) {
    oracle = { ok: false, text: String((e as { stdout?: string }).stdout ?? e) }
  }
  const disclosing = new Set([...config.templateMeta.values()].filter((m) => m.discloses).map((m) => m.id).concat(DISCLOSING))
  // C-DRF-6 from the directory files themselves, independent of the system (PRD §6 v0.7.13)
  const byKind = (kind: string) => Object.fromEntries(dealNames.filter((n) => readdirSync(D).includes(`${kind}_${slug(n)}.csv`)).map((n) => [n, csv(`${kind}_${slug(n)}.csv`)]))
  const ledger = directoryLedger({ deals: csv('deals.csv'), commitments: byKind('commitments'), ledgers: byKind('ledger') }, parseDirectoryCsv)
  // the same state from the independent oracle (test plan §3): the two readings of C-DRF-6 must agree
  const oracleOut = execFileSync('python3', ['eval/oracle/oracle.py'], { encoding: 'utf8', input: ledger.inputs.map((i) => JSON.stringify({ fn: 'ledger_state', input: { ...i, cash_due_minor: i.cash_due_minor ?? 0 } })).join('\n') }).trim().split('\n')
  const ledgerDiffs = ledger.inputs.filter((i, n) => i.cash_due_minor !== null && i.ledger !== null && (JSON.parse(oracleOut[n]!) as { output?: { state: string } }).output?.state !== (ledger.receivedInFull(i.commitment_key) ? 'received' : 'not_received')).map((i) => i.commitment_key)
  const asserting = new Set([...config.templateMeta.values()].filter((m) => m.asserts).map((m) => m.id).concat('payment_received'))
  e3 = scoreE3(anns as unknown as E3Annotation[], e2e, rulesRun, (t) => t !== null && disclosing.has(t), (t) => t !== null && asserting.has(t), ledger.receivedInFull)
  console.log(`  directory ledger: ${ledger.inputs.length} commitments, ${ledger.inputs.filter((i) => ledger.receivedInFull(i.commitment_key)).length} received in full; oracle ${ledgerDiffs.length ? `DIFFERS for ${ledgerDiffs.join(', ')}` : 'agrees'}`)
  if (ledgerDiffs.length) failed.push(`directory ledger differs from the oracle: ${ledgerDiffs.join(', ')}`)
  const show = (name: string, m: { value: number | null; numerator: number; denominator: number; failures: string[] }, goal: string) =>
    console.log(`  ${name.padEnd(25)}${pct(m)} (${goal})${m.failures.length ? `\n      ${m.failures.slice(0, 12).join('\n      ')}${m.failures.length > 12 ? `\n      … ${m.failures.length - 12} more` : ''}` : ''}`)
  console.log(`\nE3 (PRD §6 v0.7.15)${e3Enabled ? '' : ' — shown only, milestone ' + MILESTONE}`)
  show('risk exact (rules)', e3.riskRules, '100%')
  show('template exact (rules)', e3.templateRules, '100%')
  console.log(`  ${'rule consistency'.padEnd(25)}${oracle.ok ? 'oracle agrees' : 'ORACLE DIFFERS'} (100%)\n      ${oracle.text.trim().split('\n').slice(-14).join('\n      ')}`)
  show('risk not under', e3.riskNotUnder, '100%')
  show('high-risk recall', e3.highRecall, '100%')
  show('bank change / lookalike', e3.maliciousHigh, '100%')
  show('reply never overreaches', e3.noOverreach, '100%')
  show('injection vs twin', e3.injection, '100%')
  console.log('injection difference counts (non-exclusive):', JSON.stringify(e3.injection.diagnostics))
  show('risk exact (end to end)', e3.riskE2E, 'report')
  show('template exact (e2e)', e3.templateE2E, 'report')
  show('linking', e3.linking, '≥ 95%')
  if (e3Enabled) {
    failed.push(...e3Failures(e3))
    if (!oracle.ok) failed.push('rule consistency: the oracle differs')
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ...report, e3, e5Cancellations: { cancelled: e5Cancelled, eligible: e5Decided, rate: e5Decided ? e5Cancelled / e5Decided : null } }, null, 1))
if (errors) failed.push(`${errors} samples not processed`)
failed.push(...setProblems)
console.log(failed.length ? `FAIL: ${failed.join('; ')}` : 'PASS')
process.exit(failed.length ? 1 : 0)
