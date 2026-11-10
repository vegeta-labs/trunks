// E3 pipeline stages (tech design §6): link → risk → reply → route → emit. Each computes from the Case's snapshot, the
// earlier stages of the same generation and a person's changes, then publishes under the Case row lock (runStage).
// The rules themselves are the pure functions in src/lib; nothing here calls a model (decisions 4, 4a).
import { restartFrom } from './restart.ts'
import { caseReplyRecipients, closureBlockers, labelsWithChanges, PROTECTED_CLASSES, senderSuspect, type CloseBlocker } from '../lib/gates.ts'
import { evidenceSupportsTracing, structuredBeneficiaries } from '../lib/payment-message.ts'
import { normaliseAccount } from '../lib/accounts.ts'
import { receivingAccountHmac } from '../store/directory.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { Tx } from '../store/db.ts'
import { getBlobs, getJson, putBlob } from '../store/blobs.ts'
import { appendAudit } from '../store/audit.ts'
import { loadSnapshot, type SnapshotView } from '../store/directory.ts'
import type { Json } from '../lib/audit-hash.ts'
import { loadMessage, resultOf, type Applied, type CaseRow, type ClassifyResult, type Extraction, type FieldsResult, type Prepared, type StageDeps } from './stages.ts'
import { commitmentKey, ledgerState, link, mayDisclose, type Dir, type LedgerState, type Links } from '../lib/link.ts'
import { applyAdjustment, computeRisk, hasPressure, rank, type Level, type RiskResult } from '../lib/risk.ts'
import { fill, formatMoney, internalTermsIn, NOTIFY_OLD_CONTACT, paymentDate, primaryClass, selectTemplate, type FieldValue, type SelectInput, type Selection } from '../lib/draft.ts'
import { addWorkingHours, localDate, type WorkCalendar } from '../lib/workdays.ts'
import { PAYMENT_ACTIONS, queueFor } from '../lib/output.ts'
import { CHECKLIST, fieldsChanged, invalidated, phoneOnFile, taskContact, taskFieldContent } from '../lib/verification.ts'
import { fieldsFor } from '../lib/fields.ts'
import { suggestedActions, closingLeadConfirmed, type Action, type ActionInput } from '../lib/actions.ts'
import { dueEvents, eventProblems, sensitiveIn, SCHEMA_VERSION, type CaseFacts } from '../lib/events.ts'
import { accountShapes, fullNumbers } from '../lib/redact.ts'
import { normalise } from '../lib/text.ts'
import type { Config } from '../config/load.ts'
import type { Keyring } from '../store/crypto.ts'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
/** PRD C-FRD-8: what a closing stage writes on a closed Case: nothing but its own stage record. */
const SKIPPED_CLOSED: Applied = { audit: { skipped: 'closed' } }

// ---------- the Case's effective inputs: pipeline results plus a person's changes ----------

export interface EffectiveLabels {
  adopted: string[]
  risk: string[] // C-RSK-1: adopted + model low labels
  low: string[]
}

/** C-CLS-4a E6. */
export const hadBankRuleLabel = async (c: Pick<Tx, 'query'>, caseId: string) =>
  (await c.query(`SELECT 1 FROM case_label WHERE case_id = $1 AND class_id = 'bank_details' AND source = 'rule' LIMIT 1`, [caseId])).rows.length > 0

/** C-FRD-6: the protected classes that carry a rule label in any generation (rule labels cannot be removed, C-CLS-5). */
export const protectedRuleLabels = async (c: Pick<Tx, 'query'>, caseId: string): Promise<string[]> =>
  (await c.query<{ class_id: string }>(`SELECT DISTINCT class_id FROM case_label WHERE case_id = $1 AND source = 'rule' AND class_id = ANY($2::text[])`, [caseId, PROTECTED_CLASSES])).rows.map((r) => r.class_id)

export async function effectiveLabels(d: Pick<StageDeps, 'db' | 'k'>, caseId: string, generation: number): Promise<EffectiveLabels> {
  const cls = await resultOf<ClassifyResult>(d, caseId, 'classify', generation)
  if (!cls) throw new Error('no classification for this generation')
  // C-FRD-6: a protected class adopted in any generation stays, whatever a later classification says
  const persisted = (await d.db.query<{ class_id: string }>('SELECT DISTINCT class_id FROM case_label WHERE case_id = $1 AND adopted AND class_id = ANY($2::text[])', [caseId, PROTECTED_CLASSES])).rows.map((r) => r.class_id)
  const changes = (await d.db.query<{ class_id: string; action: string; approved_by: string | null }>('SELECT class_id, action, approved_by FROM case_label_change WHERE case_id = $1 ORDER BY created_at, id', [caseId])).rows
  const { adopted, risk } = labelsWithChanges(cls, persisted, changes.map((ch) => ({ classId: ch.class_id, action: ch.action, approvedBy: ch.approved_by })))
  // C-CLS-4a E6, C-FRD-6: a protected rule label of any generation stays, also one the risk step wrote (C-RSK-2 v0.7.28)
  for (const c of await protectedRuleLabels(d.db, caseId)) {
    adopted.add(c)
    risk.add(c)
  }
  // rule labels cannot be removed by a person (C-CLS-5): the current ones always count, whatever was removed earlier (Codex E3 F4)
  for (const l of cls.labels) if (l.source === 'rule' && l.classId !== 'unclassified') {
    adopted.add(l.classId)
    risk.add(l.classId)
  }
  // a person's label replaces `unclassified`
  if (adopted.size > 1) adopted.delete('unclassified')
  if (adopted.size === 0) adopted.add('unclassified')
  const a = [...adopted]
  return { adopted: a, risk: [...new Set([...risk, ...a])], low: [...risk].filter((c) => !adopted.has(c)) }
}

export interface EffectiveField {
  status: 'ok' | 'void' | 'multiple' | 'conflict' | 'empty'
  value: unknown
  candidates: unknown[]
  confirmed: boolean // a person set or confirmed it (C-DRF-1 «经人确认»)
}

/** The fields step's result with a person's values on top; a stored change may also be `{multiple}` / `{void}` (evaluation). */
export async function effectiveFields(d: Pick<StageDeps, 'db' | 'k'>, caseId: string, generation: number): Promise<Record<string, EffectiveField>> {
  const fr = await resultOf<FieldsResult>(d, caseId, 'fields', generation)
  const out: Record<string, EffectiveField> = Object.create(null) as Record<string, EffectiveField> // field names never reach a prototype
  for (const f of fr?.fields ?? []) out[f.field] = { status: f.status, value: f.value, candidates: f.candidates, confirmed: false }
  const ch = (await d.db.query<{ field: string; value_blob: string | null }>(
    'SELECT DISTINCT ON (field) field, value_blob FROM case_field_change WHERE case_id = $1 ORDER BY field, created_at DESC, id DESC',
    [caseId],
  )).rows
  for (const c of ch) {
    const v = c.value_blob ? await getJson<{ value?: unknown; multiple?: unknown[]; void?: string }>(d.db, d.k, c.value_blob) : null
    if (v && 'multiple' in v) out[c.field] = { status: 'multiple', value: null, candidates: v.multiple!, confirmed: true }
    else if (v && 'void' in v) out[c.field] = { status: 'void', value: null, candidates: [], confirmed: true }
    else out[c.field] = { status: v ? 'ok' : 'empty', value: v?.value ?? null, candidates: [], confirmed: true }
  }
  return out
}

/** A field as C-DRF-4 / C-OUT-3 read it: a single value, `{multiple}`, `{void}` or null. */
export const asFieldValue = (f: EffectiveField | undefined): FieldValue => {
  if (!f || f.status === 'empty') return null
  if (f.status === 'multiple') return { multiple: f.candidates }
  if (f.status === 'void') return { void: 'void' }
  return typeof f.value === 'string' ? f.value : f.value === null ? null : JSON.stringify(f.value)
}

export const toDir = (s: SnapshotView): Dir => ({
  deals: s.deals, commitments: s.commitments, bankLines: s.bankLines, ledger: s.ledger, ledgerDeals: s.ledgerDeals,
  contacts: s.contacts.map((c) => ({ contactId: c.contactId, emails: c.emails, role: c.role, deals: c.deals, investorIds: c.investorIds, authorisedFor: c.authorisedFor })),
})

export const calendar = (config: Config): WorkCalendar => {
  const [sh, sm] = config.routing.working_hours.start.split(':').map(Number)
  const [eh, em] = config.routing.working_hours.end.split(':').map(Number)
  return { timeZone: config.deployment.timezone, startMinute: sh! * 60 + sm!, endMinute: eh! * 60 + em!, holidays: new Set(config.routing.holidays) }
}

const caseInfo = async (c: Pick<Tx, 'query'>, caseId: string) =>
  (await c.query<{ received_at: Date; mailbox_id: string; generation_by: string; queue: string | null; queue_by: string | null; assignee: string | null; outcome: string | null; manual_revision: number }>(
    `SELECT m.received_at, m.mailbox_id, c.generation_by, c.queue, c.queue_by, c.assignee, c.outcome, c.manual_revision FROM "case" c JOIN message m ON m.id = c.message_id WHERE c.id = $1`,
    [caseId],
  )).rows[0]!

const signalsOf = async (c: Pick<Tx, 'query'>, caseId: string) =>
  Object.fromEntries((await c.query<{ signal: string; value: boolean | null }>('SELECT signal, value FROM case_signal WHERE case_id = $1', [caseId])).rows.map((r) => [r.signal, r.value]))

// ---------- link (C-LNK, C-SIG-3, C-LNK-5, C-DRF-6) ----------

export interface LinkResult {
  links: Links
  authenticated: boolean
  mayDisclose: boolean
  ledger: LedgerState | null
  received: number | null
  commitment: { key: string; investorName: string; reference: string; cashDue: number; currency: string } | null
  contact: { contactId: string; name: string; emails: string[]; phone: string | null; role: string; deals: string[] } | null // the linked contact
  sender: { contactId: string; role: string; deals: string[] } | null // C-LNK-1 / C-SIG-3: the one contact the From address matches
  // C-FRD-4 v0.7.21: the verification task's contact (the linked one, or the one the display name impersonates); absent in
  // results saved before v0.7.21
  taskContact?: { contact: { contactId: string; name: string; emails: string[]; phone: string | null; role: string; deals: string[] }; impersonated: boolean } | null
  dealName: string | null
  dealCloseDate: string | null
  payment: { date: string | null; status: 'ok' | 'unknown' | 'invalid' } | null
  primary: string | null
}

async function personLinks(c: Pick<Tx, 'query'>, k: StageDeps['k'], caseId: string): Promise<Map<string, string | null>> {
  const rows = (await c.query<{ kind: string; target_blob: string | null }>(`SELECT kind, target_blob FROM case_link WHERE case_id = $1 AND source = 'person' AND active ORDER BY created_at`, [caseId])).rows
  const b = await getBlobs(c, k, rows.flatMap((r) => (r.target_blob ? [r.target_blob] : [])))
  return new Map(rows.map((r) => [r.kind, r.target_blob ? b.get(r.target_blob)!.toString('utf8') : null]))
}

export async function prepLink(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const gen = cr.processing_generation
  const m = await loadMessage(d, cr.message_id)
  const snap = await loadSnapshot(d.db, d.k, cr.snapshot_id)
  const dir = toDir(snap)
  const ex = (await resultOf<Extraction>(d, cr.id, 'extract', gen))!
  const labels = await effectiveLabels(d, cr.id, gen)
  const fields = await effectiveFields(d, cr.id, gen)
  const info = await caseInfo(d.db, cr.id)
  const sig = await signalsOf(d.db, cr.id)
  const received = localDate(d.config.deployment.timezone, info.received_at.toISOString())
  const primary = primaryClass(d.config.classes, labels.adopted)
  const payment = primary === 'payment_query' || primary === 'payment_evidence' || labels.adopted.some((c) => c === 'payment_query' || c === 'payment_evidence')
    ? paymentDate({ primary: primary ?? 'payment_query', evidenceValueDates: ex.evidence.flatMap((e) => (e.valueDate ? [e.valueDate] : [])), valueDate: asFieldValue(fields.value_date), paymentDate: asFieldValue(fields.payment_date), receivedDate: received })
    : null
  const dealField = fields.deal?.status === 'ok' && typeof fields.deal.value === 'string' ? (snap.deals.find((x) => x.dealKey === fields.deal!.value)?.name ?? null) : null
  const amounts = [...ex.amounts.map((a) => ({ minor: a.minor, currency: a.currency })), ...ex.evidence.flatMap((e) => (e.minor !== null && e.currency ? [{ minor: e.minor, currency: e.currency }] : []))]
  // a person's links win (R-LNK-02, TC-LNK-04); a person's commitment goes through C-LNK-4 and C-LNK-6 ① like an
  // automatic one; links that are not in this snapshot are dropped (they were checked when set)
  const person = await personLinks(d.db, d.k, cr.id)
  const personCommitment = person.has('commitment') ? person.get('commitment')! : undefined
  let links = link(dir, { fromAddress: m.fromAddress, references: ex.references.map((r) => r.value), deal: dealField, amounts, paymentDate: payment?.status === 'ok' ? payment.date : null, ...(personCommitment !== undefined ? { commitment: personCommitment } : {}) })
  if (person.has('contact')) {
    const id = person.get('contact')!
    links = { ...links, contact: { id: id !== null && dir.contacts.some((x) => x.contactId === id) ? id : null, candidates: [] } }
  }
  // C-LNK-6 ①: with a commitment linked, the deal is the commitment's; a person's other deal is shown as a conflict, never
  // used (Codex E3 F1: a false «received» naming another deal)
  if (person.has('deal')) {
    const name = person.get('deal')!
    const valid = name !== null && dir.deals.some((x) => x.name === name) ? name : null
    if (links.commitment.key === null) links = { ...links, deal: { name: valid, candidates: [], conflict: false } }
    else if (valid !== links.deal.name) links = { ...links, deal: { ...links.deal, conflict: true } }
  }
  // C-SIG-3: frozen dmarc_pass, and the sender matches exactly one contact of this snapshot
  const senderMatches = m.fromAddress ? dir.contacts.filter((x) => x.emails.some((e) => e.toLowerCase() === m.fromAddress!.toLowerCase())) : []
  const sender = senderMatches.length === 1 ? senderMatches[0]! : null
  const authenticated = sig.dmarc_pass === true && sender !== null
  const key = links.commitment.key
  const comm = key ? dir.commitments.find((x) => commitmentKey(dir, x) === key)! : null
  const ls = key ? ledgerState(dir, key) : null
  const contactRow = links.contact.id ? snap.contacts.find((x) => x.contactId === links.contact.id) ?? null : null
  const dealRow = links.deal.name ? snap.deals.find((x) => x.name === links.deal.name) ?? null : null
  const asContact = (x: (typeof snap.contacts)[number]) => ({ contactId: x.contactId, name: x.name, emails: x.emails, phone: x.phone, role: x.role, deals: x.deals })
  const tc = taskContact(contactRow ? asContact(contactRow) : null, sig.display_name_mismatch ?? null, m.fromName, snap.contacts.map(asContact))
  const out: LinkResult = {
    links,
    authenticated,
    mayDisclose: mayDisclose(authenticated, key, sender),
    ledger: ls?.state ?? null,
    received: ls?.received ?? null,
    commitment: comm ? { key: key!, investorName: comm.name, reference: comm.reference, cashDue: comm.cashDue, currency: snap.deals.find((x) => x.dealKey === comm.dealKey)?.currency ?? '' } : null,
    contact: contactRow ? asContact(contactRow) : null,
    taskContact: tc,
    sender: sender ? { contactId: sender.contactId, role: sender.role, deals: sender.deals } : null,
    dealName: links.deal.name,
    dealCloseDate: dealRow?.closeDate ?? null,
    payment,
    primary,
  }
  return {
    // per generation: this step writes its own rows (links) for every generation, never reused (Codex round 2 F17)
    inputHash: sha256(JSON.stringify([gen, cr.snapshot_id, ex.references, amounts, labels, fields, [...person], sig.dmarc_pass, m.fromAddress, sig.display_name_mismatch ?? null, m.fromName])),
    result: out,
    async apply(c) {
      const rows: Array<[string, string]> = [
        ...(links.contact.id ? [['contact', links.contact.id] as [string, string]] : []),
        ...(key ? [['commitment', key] as [string, string]] : []),
        ...(links.deal.name ? [['deal', links.deal.name] as [string, string]] : []),
        ...links.bankLines.map((b) => ['bank_line', b.transactionId] as [string, string]),
      ]
      for (const [kind, target] of rows) {
        await c.query('INSERT INTO case_link (id, case_id, generation, kind, target_blob, source) VALUES ($1, $2, $3, $4, $5, $6)', [randomUUID(), cr.id, gen, kind, await putBlob(c, d.k, target), 'auto'])
      }
      return {
        audit: { contact: links.contact.id !== null, contact_candidates: links.contact.candidates.length, commitment: key !== null, commitment_by: links.commitment.by, commitment_candidates: links.commitment.candidates.length, deal: links.deal.name !== null, deal_conflict: links.deal.conflict, bank_lines: links.bankLines.length, authenticated_sender: authenticated, may_disclose: out.mayDisclose, ledger: out.ledger },
        detail: out as unknown as Json,
      }
    },
  }
}

// ---------- risk (C-RSK) ----------

export interface RiskStageResult {
  inputs: { pressure: boolean; accountPresent: boolean; amountsBody: Array<{ minor: number; currency: string }>; amountsAttachment: Array<{ minor: number; currency: string }>; blockedOrOverLimit: boolean; receivedDate: string; evidenceBeneficiaryMismatch?: boolean }
  computed: RiskResult
  final: Level
  by: 'system' | 'person'
  adjustmentVoid: boolean
  held: Level | null // C-RSK-3 v0.7.15: a lower result kept at this level until an approver confirms
  applied: Level // the computed risk with the active adjustment, before any hold (what an approver confirms)
}

export async function prepRisk(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const gen = cr.processing_generation
  const m = await loadMessage(d, cr.message_id)
  const ex = (await resultOf<Extraction>(d, cr.id, 'extract', gen))!
  const lk = (await resultOf<LinkResult>(d, cr.id, 'link', gen))!
  const labels = await effectiveLabels(d, cr.id, gen)
  const sig = await signalsOf(d.db, cr.id)
  const info = await caseInfo(d.db, cr.id)
  const texts = [m.subject, m.text, m.htmlText, ...m.attachments.flatMap((a) => [a.filename, a.text])]
  // C-RSK-2 «IBAN 形状的串或英国账号»: the C-RED-1 account shapes, check digits or not, sort code or not (Codex round 2 F14)
  const accountPresent = texts.some((t) => accountShapes(normalise(t).text).length > 0)
  // C-RSK-2 v0.7.28: judged on this generation's link, which the classify step could not see
  const cls = await resultOf<ClassifyResult>(d, cr.id, 'classify', gen)
  const snap = await loadSnapshot(d.db, d.k, cr.snapshot_id)
  const linkedDeal = lk.dealName ? snap.deals.find((x) => x.name === lk.dealName) ?? null : null
  const exempted = cls?.evidenceExemption?.applied ? cls.evidenceExemption : null
  const fieldsAsked = (await resultOf<FieldsResult>(d, cr.id, 'fields', gen))?.classes ?? []
  const listed = linkedDeal?.receiving ?? null
  const evidenceBeneficiaryMismatch =
    (exempted !== null && (linkedDeal?.dealKey !== exempted.dealKey || listed === null)) ||
    (listed !== null && structuredBeneficiaries(m.attachments, d.config.deployment.currencies).some((v) => !listed.some((x) => x.hmac === receivingAccountHmac(d.k, normaliseAccount(v)))))
  const inputs: RiskStageResult['inputs'] = {
    pressure: hasPressure([m.subject, m.text, m.htmlText], d.config.signals.pressure_words_extra),
    accountPresent,
    amountsBody: ex.amounts.filter((a) => a.at.part === 'body' || a.at.part === 'body_html').map((a) => ({ minor: a.minor, currency: a.currency })),
    amountsAttachment: ex.evidence.filter((e) => e.part.startsWith('attachment') && e.minor !== null && e.currency).map((e) => ({ minor: e.minor!, currency: e.currency! })),
    blockedOrOverLimit: cr.flags.includes('attachment_blocked') || cr.flags.includes('attachment_over_limit'),
    receivedDate: localDate(d.config.deployment.timezone, info.received_at.toISOString()),
    evidenceBeneficiaryMismatch,
  }
  const computed = computeRisk({
    classes: d.config.classes,
    labels: evidenceBeneficiaryMismatch ? [...new Set([...labels.risk, 'bank_details'])] : labels.risk,
    evidenceBeneficiaryMismatch,
    signals: sig,
    accountPresent: inputs.accountPresent,
    uetrCandidatesInvalid: ex.uetrCandidatesInvalid.length,
    amountsBody: inputs.amountsBody,
    amountsAttachment: inputs.amountsAttachment,
    attachmentBlockedOrOverLimit: inputs.blockedOrOverLimit,
    pressure: inputs.pressure,
    plannedCloseDate: lk.dealCloseDate,
    receivedDate: inputs.receivedDate,
    holidays: new Set(d.config.routing.holidays),
  })
  const adj = (await d.db.query<{ id: string; level: Level; computed_at_set: Level; reasons: string[] }>(`SELECT id, level, computed_at_set, reasons FROM risk_adjustment WHERE case_id = $1 AND state = 'active'`, [cr.id])).rows[0]
  const applied = applyAdjustment(computed, adj ? { level: adj.level, computedAtSet: adj.computed_at_set, reasons: adj.reasons } : null, d.config.classes)
  // an adjustment lapsing is the system's doing (C-RSK-3 ⑥, Codex E3 F11)
  const by: 'system' | 'person' = applied.void ? 'system' : (adj && !applied.void) || info.generation_by === 'person' ? 'person' : 'system'
  // a person's change may not lower the risk on its own (C-RSK-3 v0.7.15): below the kept level → keep it
  const hold = (await d.db.query<{ risk_hold: Level | null }>('SELECT risk_hold FROM "case" WHERE id = $1', [cr.id])).rows[0]!.risk_hold
  const held = hold !== null && rank(applied.level) < rank(hold) ? hold : null
  const out: RiskStageResult = { inputs, computed, final: held ?? applied.level, by, adjustmentVoid: applied.void, held, applied: applied.level }
  return {
    // per generation: this step writes the Case's risk, so every generation publishes it, never reused (Codex round 3 F20)
    inputHash: sha256(JSON.stringify([gen, computed, adj ?? null, info.generation_by, hold])),
    result: out,
    async apply(c, locked) {
      if (locked.closed_at) return SKIPPED_CLOSED // C-FRD-8
      // C-RSK-2 v0.7.28: the mismatch is handled as bank_details from here on, and stays (C-CLS-4a E6)
      if (evidenceBeneficiaryMismatch) {
        await c.query(`INSERT INTO case_label (case_id, generation, class_id, source, confidence, adopted, reason_blob) VALUES ($1, $2, 'bank_details', 'rule', 'rule', true, NULL) ON CONFLICT DO NOTHING`, [cr.id, gen])
        // the fields step ran before this label existed: run it again once in a new generation, so the bank_details
        // fields (party_role, account_last4, change_requested) are asked for too
        if (!fieldsAsked.includes('bank_details')) await restartFrom(c, d.queue, cr.id, 'fields', 'system')
      }
      await c.query('UPDATE "case" SET risk = $2, risk_by = $3, risk_hold = $4 WHERE id = $1', [cr.id, out.final, by, held])
      if (held) await appendAudit(c, d.k, [{ actor: 'system', type: 'risk.lowering_held', caseId: cr.id, payload: { held, computed: applied.level } }])
      if (applied.void && adj) {
        await c.query(`UPDATE risk_adjustment SET state = 'void', ended_at = now() WHERE id = $1 AND state = 'active'`, [adj.id])
        await appendAudit(c, d.k, [{ actor: 'system', type: 'risk.adjustment_void', caseId: cr.id, payload: { adjustment_id: adj.id, level: adj.level, computed_at_set: adj.computed_at_set, computed_now: computed.level } }])
      }
      // C-AUD-3: every rule's result
      return { audit: { computed: computed.level, base: computed.base, final: out.final, held, by, clauses: computed.clauses.filter((x) => x.hit).map((x) => x.id), adjustment: adj ? (applied.void ? 'void' : 'applied') : null } }
    },
  }
}

// ---------- reply and verification tasks (C-DRF, C-FRD-4, C-FRD-5) ----------

export interface ReplyStageResult {
  selection: Selection
  actions: Action[]
  // what the actions were derived from in this generation, all but the template: later reads take only the reply in use
  // from now, never a person's pending change (Codex round 3 F21)
  actionInput: Omit<ActionInput, 'template'>
  // the classes this generation used, so the outputs show them beside this generation's risk (Codex round 4 F26)
  labels: { adopted: string[]; low: string[] }
  replyId: string | null
}

/** Values for the placeholders (C-DRF-1 source table): directory, ledger, confirmed typed fields, system. */
export function placeholderValues(o: { lk: LinkResult; fields: Record<string, EffectiveField>; config: Config; caseId: string }): Record<string, string | null> {
  const { lk, fields } = o
  const money = (minor: number | null) => (minor === null || !lk.commitment ? null : formatMoney(minor, lk.commitment.currency))
  const confirmed = (f: string) => {
    const v = fields[f]
    if (!v || !v.confirmed || v.status !== 'ok' || v.value === null) return null
    if (typeof v.value === 'object' && v.value && 'minor' in (v.value as object)) {
      const mv = v.value as { minor: number; currency: string }
      return formatMoney(mv.minor, mv.currency)
    }
    return String(v.value)
  }
  return {
    contact_name: lk.contact?.name ?? null,
    investor_name: lk.commitment?.investorName ?? null,
    deal_name: lk.dealName,
    reference: lk.commitment?.reference ?? null,
    cash_due: money(lk.commitment?.cashDue ?? null),
    currency: lk.commitment?.currency ?? null,
    received_amount: lk.ledger === 'unknown' ? null : money(lk.received),
    outstanding_amount: lk.ledger === 'unknown' || lk.received === null || !lk.commitment ? null : money(Math.max(0, lk.commitment.cashDue - lk.received)),
    amount: confirmed('amount'),
    payment_date: confirmed('payment_date'),
    value_date: confirmed('value_date'),
    uetr: confirmed('uetr'),
    deployment_name: o.config.deployment.name,
    case_number: caseNumber(o.caseId),
  }
}

export const caseNumber = (caseId: string) => caseId.slice(0, 8).toUpperCase()

export function render(config: Config, templateId: string, values: Record<string, string | null>) {
  const t = config.templates.find((x) => x.id === templateId)!
  const subject = fill(t.subject, values)
  const body = fill(t.body, values)
  return { subject: subject.text.trim(), text: body.text.replace(/^\n+/, ''), removed: subject.removed + body.removed }
}

export const contentSha = (recipient: string | null, subject: string, text: string) => sha256(JSON.stringify([recipient, subject, text]))

export interface ReplyCheck {
  ok: boolean
  problems: string[]
}

/** C-DRF-2 ② – ④ on a reply's final text. */
export function checkReply(o: { subject: string; text: string; recipient: string | null; allowed: readonly string[]; removed: number; extraInternal: readonly string[] }): ReplyCheck {
  const problems: string[] = []
  const terms = [...new Set([...internalTermsIn(o.subject, o.extraInternal), ...internalTermsIn(o.text, o.extraInternal)])]
  if (terms.length) problems.push(`internal_terms:${terms.join('|')}`)
  if (/\{[a-z_]+\}/.test(o.subject + o.text)) problems.push('placeholder_left')
  if (o.recipient === null) problems.push('no_recipient')
  else if (!o.allowed.includes(o.recipient.toLowerCase())) problems.push('recipient_not_allowed')
  return { ok: problems.length === 0, problems }
}

export interface ReplyContext {
  lk: LinkResult
  labels: EffectiveLabels
  fields: Record<string, EffectiveField>
  select: SelectInput
  allowed: string[] // C-DRF-2 ④ a: From, and Reply-To unless reply_to_mismatch
  recipient: string | null // the default: Reply-To when allowed, otherwise From
  senderSuspect: boolean // C-DRF-10
  values: Record<string, string | null>
}

/** What the reply rules read for a Case's generation (pipeline and the review actions use the same). */
export async function replyContext(d: Pick<StageDeps, 'db' | 'k' | 'files' | 'config'>, caseId: string, messageId: string, gen: number, riskLevel?: Level): Promise<ReplyContext> {
  const m = await loadMessage(d, messageId)
  const lk = (await resultOf<LinkResult>(d, caseId, 'link', gen))!
  const labels = await effectiveLabels(d, caseId, gen)
  const fields = await effectiveFields(d, caseId, gen)
  const info = await caseInfo(d.db, caseId)
  const sig = await signalsOf(d.db, caseId)
  const risk = riskLevel ?? (await resultOf<RiskStageResult>(d, caseId, 'risk', gen))!.final
  const select: SelectInput = {
    classes: d.config.classes, adopted: labels.adopted, risk, linkedCommitment: lk.commitment !== null, ledger: lk.ledger, payment: lk.payment,
    receivedDate: localDate(d.config.deployment.timezone, info.received_at.toISOString()), holidays: new Set(d.config.routing.holidays), mayDisclose: lk.mayDisclose, templates: d.config.templateMeta,
    // only when C-DRF-4 can reach this step: this runs on every Case view too
    evidenceSupportsTracing: lk.commitment !== null && lk.ledger !== 'received' && evidenceSupportsTracing(m.attachments, {
      partlyDecoded: (await d.db.query<{ flags: string[] }>('SELECT flags FROM "case" WHERE id = $1', [caseId])).rows[0]!.flags.includes('mime_parse_failed'),
      currencies: d.config.deployment.currencies, dealCurrency: lk.commitment?.currency ?? null, cashDue: lk.commitment?.cashDue ?? null, receivedDate: localDate(d.config.deployment.timezone, info.received_at.toISOString()),
    }),
  }
  // C-DRF-2 ④a: Reply-To only as parsed at ingest (the list behind the signal), and only when the signal is exactly
  // false; unparseable or several headers (null) or a mismatch → From only (C-SIG-1.5 v0.7.15)
  const hdr = await getJson<{ reply_to?: string[] | null }>(d.db, d.k, (await d.db.query<{ header_blob: string }>('SELECT header_blob FROM message WHERE id = $1', [messageId])).rows[0]!.header_blob)
  const replyTo = sig.reply_to_mismatch === false ? (hdr?.reply_to ?? []) : []
  const suspect = senderSuspect(sig)
  const overrideGranted = suspect && (await d.db.query<{ recipient_override_at: Date | null }>('SELECT recipient_override_at FROM "case" WHERE id = $1', [caseId])).rows[0]!.recipient_override_at !== null
  // C-DRF-10 over C-DRF-2 ④a
  const allowed = caseReplyRecipients(m.fromAddress, replyTo, sig.reply_to_mismatch !== false, suspect, overrideGranted)
  const recipient = allowed.find((a) => a !== m.fromAddress?.toLowerCase()) ?? allowed[0] ?? null
  return { lk, labels, fields, select, allowed, recipient, senderSuspect: suspect, values: placeholderValues({ lk, fields, config: d.config, caseId }) }
}

export async function prepReply(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const gen = cr.processing_generation
  const ctx = await replyContext(d, cr.id, cr.message_id, gen)
  const { lk, labels, fields, allowed, recipient, values } = ctx
  const selection = selectTemplate(ctx.select)
  // the reply a person is working on (edited or chosen) stays; its template decides the actions (C-OUT-3 v0.7.12)
  const personReply = (await d.db.query<{ id: string; template_id: string }>(
    `SELECT id, template_id FROM reply WHERE case_id = $1 AND generation = $2 AND (edited OR template_source = 'person') AND status IN ('draft', 'approved', 'sent') ORDER BY created_at DESC LIMIT 1`,
    [cr.id, gen],
  )).rows[0]
  const currentTemplate = personReply?.template_id ?? selection.template
  const actionInput: ReplyStageResult['actionInput'] = {
    adopted: labels.adopted,
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, asFieldValue(v)])),
    commitment: lk.commitment ? { investorName: lk.commitment.investorName, reference: lk.commitment.reference } : null,
    deal: lk.dealName,
    leadConfirmed: leadConfirmed(labels.adopted, fields, lk),
  }
  const actions = suggestedActions({ ...actionInput, template: currentTemplate })
  const draft = selection.template ? render(d.config, selection.template, values) : null
  const check = draft ? checkReply({ ...draft, recipient, allowed, extraInternal: d.config.replies.internal_terms_extra }) : null
  const replyId = draft ? randomUUID() : null
  const out: ReplyStageResult = { selection, actions, actionInput, labels: { adopted: [...labels.adopted], low: [...labels.low] }, replyId }
  return {
    // per generation: every generation needs its own draft row to approve (Codex round 2 F17)
    inputHash: sha256(JSON.stringify([gen, selection, actions, draft, recipient, lk, labels.adopted])),
    result: out,
    async apply(c, locked) {
      if (locked.closed_at) return SKIPPED_CLOSED // C-FRD-8: no draft and no task on a closed Case
      // earlier automatic drafts give way; approved or sent replies and a person's replies stay (shown side by side)
      await c.query(`UPDATE reply SET status = 'superseded' WHERE case_id = $1 AND status = 'draft' AND template_source = 'auto' AND NOT edited`, [cr.id])
      // an approval from an earlier generation can no longer hold (C-DRF-8): it lapses now, not only at the next copy,
      // so the reply shows as out of date and the Case is no longer «approved» (owner acceptance S1)
      const lapsed = (await c.query<{ id: string }>(
        `UPDATE reply SET status = 'draft', approved_by = NULL, approved_at = NULL, approved_generation = NULL, approved_manual_revision = NULL
          WHERE case_id = $1 AND status = 'approved' AND generation < $2 RETURNING id`,
        [cr.id, gen],
      )).rows
      if (lapsed.length) {
        await c.query(`UPDATE "case" SET status = 'open' WHERE id = $1 AND status = 'approved'`, [cr.id])
        await appendAudit(c, d.k, lapsed.map((r) => ({ actor: 'system', type: 'reply.approval_lapsed', caseId: cr.id, payload: { reply_id: r.id, problems: ['generation'] } })))
      }
      if (draft && replyId) {
        await c.query(
          `INSERT INTO reply (id, case_id, generation, template_id, template_source, recipient_blob, subject_blob, text_blob, content_sha256, removed_sentences, check_ok, check_problems, status)
           VALUES ($1, $2, $3, $4, 'auto', $5, $6, $7, $8, $9, $10, $11, 'draft')`,
          [replyId, cr.id, gen, selection.template, recipient ? await putBlob(c, d.k, recipient) : null, await putBlob(c, d.k, draft.subject), await putBlob(c, d.k, draft.text),
            contentSha(recipient, draft.subject, draft.text), draft.removed, check!.ok, JSON.stringify(check!.problems)],
        )
      }
      const tasks = await syncVerificationTasks(c, d, cr, labels.adopted, lk, fields)
      return {
        audit: { template: selection.template, step: selection.step, primary: selection.primary, reply_check_ok: check?.ok ?? null, reply_problems: (check?.problems ?? []).map((p) => p.split(':')[0]!), removed_sentences: draft?.removed ?? 0, actions: actions.map((a) => a.action), verification_tasks: tasks },
        ...(draft ? { detail: { reply_id: replyId, subject: draft.subject, text: draft.text, recipient } } : {}),
      }
    },
  }
}

export function leadConfirmed(adopted: readonly string[], fields: Record<string, EffectiveField>, lk: LinkResult): boolean {
  return closingLeadConfirmed({
    adopted, confirms: asFieldValue(fields.confirms), confirmsByPerson: fields.confirms?.confirmed === true, authenticatedSender: lk.authenticated,
    // appendix A: the authenticated sender itself is a lead of that deal, not whoever a person linked
    senderIsLeadOfDeal: lk.sender !== null && lk.sender.role === 'lead' && lk.dealName !== null && lk.sender.deals.includes(lk.dealName),
  })
}

/** C-FRD-4 / C-FRD-5: one live task per kind, bound to the manual revision, the contact and the checklist. */
/**
 * The rendered notice to the old contact is checked like a reply: a directory name may hold an internal term (C-FRD-3,
 * Codex round 2 F13). No address on file is not a problem here: the text is still shown for the call (owner, R3 A).
 */
const noticeProblems = (config: Config, subject: string, text: string, onFile: string | null) =>
  checkReply({ subject, text, recipient: onFile, allowed: onFile ? [onFile.toLowerCase()] : [], removed: 0, extraInternal: config.replies.internal_terms_extra }).problems.filter((p) => p !== 'no_recipient')

/** C-FRD-4 v0.7.21: the task contact of a link result, one resolution for the pipeline and the review actions (Codex D8
 * F1); a result saved before v0.7.21 has none and falls back to the linked contact. */
export const taskContactOf = (lk: LinkResult | null) =>
  !lk ? null : lk.taskContact === undefined ? (lk.contact ? { contact: lk.contact, impersonated: false } : null) : lk.taskContact

/** C-FRD-5 (plan R1, owner 2026-11-10): the hash of the effective values of the fields a task of `kind` depends on. */
export const taskFieldsSha = (config: Config, kind: string, fields: Readonly<Record<string, EffectiveField>>): string =>
  sha256(taskFieldContent(fieldsFor([kind], Object.fromEntries(config.classes.map((x) => [x.id, x.fields]))), (n) => asFieldValue(fields[n])))

/**
 * C-FRD-5 v0.7.29: a person confirmed a field's current value, so nothing the task rests on changed. Live tasks bound to
 * the revision now in force follow it to the next one, which the caller's restart makes. A task already behind stays
 * behind and is invalidated as usual. A task bound to its field content (C10) follows even when the fields were worked
 * out again after it was created: the hash decides whether they changed (code review round 2 D4); a task without that
 * binding does not follow then.
 */
export async function carryVerificationBinding(c: Tx, k: Keyring, actor: string, caseId: string, revision: number, field: string): Promise<void> {
  const carried = (await c.query<{ id: string }>(
    `UPDATE verification_task t SET bound_manual_revision = $2 + 1 WHERE t.case_id = $1 AND t.state <> 'invalidated' AND t.bound_manual_revision = $2
       AND (t.bound_fields_sha256 IS NOT NULL OR NOT EXISTS (SELECT 1 FROM stage_run s WHERE s.case_id = t.case_id AND s.stage = 'fields' AND NOT s.reused AND s.created_at >= t.created_at))
     RETURNING t.id`,
    [caseId, revision],
  )).rows
  for (const t of carried) await appendAudit(c, k, [{ actor, type: 'verification.binding_carried', caseId, payload: { task_id: t.id, field, from_revision: revision, to_revision: revision + 1 } }])
}

export async function syncVerificationTasks(c: Tx, d: Pick<StageDeps, 'k' | 'config'>, cr: Pick<CaseRow, 'id' | 'manual_revision'>, adopted: readonly string[], lk: LinkResult, fields: Readonly<Record<string, EffectiveField>>, forceKind?: string): Promise<Record<string, string>> {
  const done: Record<string, string> = {}
  // C-FRD-4 v0.7.21: the task contact; results saved before it have none and fall back to the linked contact
  const who = taskContactOf(lk)
  const tcon = who?.contact ?? null
  const contactId = tcon?.contactId ?? null
  for (const kind of ['bank_details', 'identity_change'] as const) {
    const now = { manualRevision: cr.manual_revision, contactId, checklist: [...CHECKLIST], fieldsSha: taskFieldsSha(d.config, kind, fields) }
    // a task whose class is no longer adopted no longer applies, approved or not (C-FRD-5, Codex E3 F5)
    if (!adopted.includes(kind)) {
      const gone = (await c.query<{ id: string; state: string }>(`UPDATE verification_task SET state = 'invalidated', invalidated_at = now() WHERE case_id = $1 AND kind = $2 AND state <> 'invalidated' RETURNING id, state`, [cr.id, kind])).rows
      for (const g of gone) await appendAudit(c, d.k, [{ actor: 'system', type: 'verification.invalidated', caseId: cr.id, payload: { task_id: g.id, reason: 'class_removed' } }])
      if (gone.length) done[kind] = 'invalidated'
      continue
    }
    const live = (await c.query<{ id: string; state: 'open' | 'checklist_done' | 'approved'; bound_manual_revision: number; bound_contact_blob: string | null; bound_fields_sha256: string | null; checklist: string[]; notify_recipient_blob: string | null; notify_subject_blob: string; notify_text_blob: string; notify_problems: string[] }>(
      `SELECT id, state, bound_manual_revision, bound_contact_blob, bound_fields_sha256, checklist, notify_recipient_blob, notify_subject_blob, notify_text_blob, notify_problems FROM verification_task WHERE case_id = $1 AND kind = $2 AND state <> 'invalidated' ORDER BY created_at DESC LIMIT 1`,
      [cr.id, kind],
    )).rows[0]
    const bound = live?.bound_contact_blob ? (await getBlobs(c, d.k, [live.bound_contact_blob])).get(live.bound_contact_blob)!.toString('utf8') : null
    if (live) {
      if (kind !== forceKind && !invalidated({ state: live.state, manualRevision: live.bound_manual_revision, contactId: bound, checklist: live.checklist, fieldsSha: live.bound_fields_sha256 }, now)) {
        // a kept task's notice is checked again: the internal terms may have changed with the configuration
        const b = await getBlobs(c, d.k, [live.notify_subject_blob, live.notify_text_blob, ...(live.notify_recipient_blob ? [live.notify_recipient_blob] : [])])
        const text = (x: string | null) => (x ? b.get(x)!.toString('utf8') : null)
        const problems = noticeProblems(d.config, text(live.notify_subject_blob)!, text(live.notify_text_blob)!, text(live.notify_recipient_blob))
        if (JSON.stringify(problems) !== JSON.stringify(live.notify_problems)) await c.query('UPDATE verification_task SET notify_problems = $2 WHERE id = $1', [live.id, JSON.stringify(problems)])
        done[kind] = 'kept'
        continue
      }
    }
    const id = randomUUID()
    const values = placeholderValues({ lk: { ...lk, contact: tcon }, fields: {}, config: d.config, caseId: cr.id })
    const notice = render(d.config, NOTIFY_OLD_CONTACT, values)
    await c.query(
      `INSERT INTO verification_task (id, case_id, kind, state, bound_manual_revision, bound_contact_blob, checklist, phone_blob, notify_recipient_blob, notify_subject_blob, notify_text_blob, notify_problems, bound_fields_sha256)
       VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, cr.id, kind, cr.manual_revision, contactId ? await putBlob(c, d.k, contactId) : null, JSON.stringify(CHECKLIST), phoneOnFile(tcon?.phone) ? await putBlob(c, d.k, phoneOnFile(tcon?.phone)!) : null,
        tcon?.emails[0] ? await putBlob(c, d.k, tcon.emails[0]) : null, await putBlob(c, d.k, notice.subject), await putBlob(c, d.k, notice.text), JSON.stringify(noticeProblems(d.config, notice.subject, notice.text, tcon?.emails[0] ?? null)), now.fieldsSha],
    )
    if (live) {
      await c.query(`UPDATE verification_task SET state = 'invalidated', invalidated_at = now(), replaced_by = $2 WHERE id = $1`, [live.id, id])
      await appendAudit(c, d.k, [{ actor: 'system', type: 'verification.invalidated', caseId: cr.id, payload: { task_id: live.id, was: live.state, replaced_by: id, fields_changed: fieldsChanged({ fieldsSha: live.bound_fields_sha256 }, now) } }])
    }
    await appendAudit(c, d.k, [{ actor: 'system', type: 'verification.created', caseId: cr.id, payload: { task_id: id, kind, phone_on_file: phoneOnFile(tcon?.phone) !== null, impersonated_contact: who?.impersonated ?? false } }])
    done[kind] = live ? 'replaced' : 'created'
  }
  return done
}

// ---------- closing (C-FRD-7) ----------

/** What stands in the way of a normal close, read in the caller's transaction or for the review page. */
export async function caseClosureBlockers(d: Pick<StageDeps, 'db' | 'k' | 'config'>, cr: { id: string; processing_generation: number; pipeline_complete_generation: number | null; manual_revision: number }): Promise<CloseBlocker[]> {
  const complete = cr.pipeline_complete_generation === cr.processing_generation
  const approvedUnsentReply = (await d.db.query(`SELECT 1 FROM reply WHERE case_id = $1 AND status = 'approved' LIMIT 1`, [cr.id])).rows.length > 0
  if (!complete) return closureBlockers({ complete, requiredKinds: [], tasks: [], approvedUnsentReply })
  const labels = await effectiveLabels(d, cr.id, cr.processing_generation)
  const lk = await resultOf<LinkResult>(d, cr.id, 'link', cr.processing_generation)
  const fields = await effectiveFields(d, cr.id, cr.processing_generation)
  const rows = (await d.db.query<{ kind: string; state: 'open' | 'checklist_done' | 'approved'; bound_manual_revision: number; bound_contact_blob: string | null; bound_fields_sha256: string | null; checklist: string[] }>(
    `SELECT kind, state, bound_manual_revision, bound_contact_blob, bound_fields_sha256, checklist FROM verification_task WHERE case_id = $1 AND state <> 'invalidated'`, [cr.id],
  )).rows
  const b = await getBlobs(d.db, d.k, rows.flatMap((r) => (r.bound_contact_blob ? [r.bound_contact_blob] : [])))
  const now = { manualRevision: cr.manual_revision, contactId: taskContactOf(lk)?.contact.contactId ?? null, checklist: [...CHECKLIST] }
  const tasks = rows.map((t) => ({
    kind: t.kind,
    state: t.state,
    valid: !invalidated({ state: t.state, manualRevision: t.bound_manual_revision, contactId: t.bound_contact_blob ? b.get(t.bound_contact_blob)!.toString('utf8') : null, checklist: t.checklist, fieldsSha: t.bound_fields_sha256 }, { ...now, fieldsSha: taskFieldsSha(d.config, t.kind, fields) }),
  }))
  return closureBlockers({ complete, requiredKinds: labels.adopted.filter((c) => (PROTECTED_CLASSES as readonly string[]).includes(c)), tasks, approvedUnsentReply })
}

// ---------- route (R-RTE) ----------

export function routeOf(config: Config, adopted: readonly string[], receivedAt: string, queueOverride: string | null) {
  const queue = queueOverride ?? queueFor(config.classes, adopted)
  const cal = calendar(config)
  const target = config.routing.targets_working_hours[queue] ?? config.routing.default_target_working_hours
  const dueAt = addWorkingHours(cal, receivedAt, target)
  const dayHours = (cal.endMinute - cal.startMinute) / 60
  const payment = adopted.some((c) => ['payment_query', 'payment_evidence', 'unreferenced_payment'].includes(c))
  const followUpAt = config.routing.follow_up.enabled && payment ? addWorkingHours(cal, receivedAt, config.routing.follow_up.working_days * dayHours) : null
  return { queue, dueAt, followUpAt }
}

export async function prepRoute(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  const labels = await effectiveLabels(d, cr.id, cr.processing_generation)
  const info = await caseInfo(d.db, cr.id)
  const r = routeOf(d.config, labels.adopted, info.received_at.toISOString(), info.queue_by === 'person' ? info.queue : null)
  return {
    // per generation: this step writes the Case's queue and due time (Codex round 3 F20)
    inputHash: sha256(JSON.stringify([cr.processing_generation, r, labels.adopted])),
    result: r,
    async apply(c, locked) {
      if (locked.closed_at) return SKIPPED_CLOSED // C-FRD-8
      // read again under the publication lock: a person may have moved the Case since this step was prepared (Codex E3 F6)
      const now = (await c.query<{ queue_by: string | null; queue: string | null }>('SELECT queue_by, queue FROM "case" WHERE id = $1', [cr.id])).rows[0]!
      if (now.queue_by === 'person' && now.queue) {
        // the person's queue stays; its due time follows the current configuration (Codex round 2 F19)
        const kept = routeOf(d.config, labels.adopted, info.received_at.toISOString(), now.queue)
        await c.query('UPDATE "case" SET due_at = $2, follow_up_at = $3 WHERE id = $1', [cr.id, kept.dueAt, kept.followUpAt])
        return { audit: { queue: 'kept (person)', due_at: kept.dueAt, follow_up_at: kept.followUpAt } }
      }
      await c.query(`UPDATE "case" SET queue = $2, queue_by = COALESCE(queue_by, 'system'), due_at = $3, follow_up_at = $4 WHERE id = $1`, [cr.id, r.queue, r.dueAt, r.followUpAt])
      return { audit: { queue: r.queue, due_at: r.dueAt, follow_up_at: r.followUpAt } }
    },
  }
}

// ---------- emit (C-OUT-1) ----------

export async function prepEmit(d: StageDeps, cr: CaseRow): Promise<Prepared> {
  return {
    inputHash: sha256(JSON.stringify([cr.processing_generation, cr.manual_revision])),
    async apply(c, locked) {
      if (locked.closed_at) return SKIPPED_CLOSED // C-FRD-8: the closing itself emitted case.closed
      const n = await emitEvents(c, d, cr.id)
      return { audit: { events: n } }
    },
  }
}

/**
 * C-OUT-3 (v0.7.12): the suggested actions follow the reply in use now — an approved or sent reply of this generation,
 * else the reply a person works on in this generation, else the automatic choice (Codex round 2 F18). The events, the
 * review page and the CSV all read them from here.
 */
export async function currentActions(c: Pick<Tx, 'query'>, caseId: string, gen: number, rp: ReplyStageResult): Promise<Action[]> {
  // the latest approval decides among approved and sent replies (Codex round 3 F23)
  const inUse = (await c.query<{ template_id: string }>(
    `SELECT template_id FROM reply WHERE case_id = $1 AND generation = $2 AND (status IN ('approved', 'sent') OR ((edited OR template_source = 'person') AND status = 'draft'))
      ORDER BY (status IN ('approved', 'sent')) DESC, approved_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [caseId, gen],
  )).rows[0]
  // the generation's own inputs, so a fall-back to the last complete generation never mixes in a pending change (F21)
  return suggestedActions({ ...rp.actionInput, template: inUse?.template_id ?? rp.selection.template })
}

/** The facts of one generation's link, risk, reply and fields, for the derived events (C-OUT-1, appendix A). */
async function derivedFacts(c: Tx, dd: Pick<StageDeps, 'db' | 'k'>, caseId: string, gen: number, lk: LinkResult,
  cr: { risk: Level; risk_by: 'system' | 'person' | null; queue: string | null; assignee: string | null; outcome: CaseFacts['outcome'] }, mailbox: string): Promise<CaseFacts> {
  const rp = await resultOf<ReplyStageResult>(dd, caseId, 'reply', gen)
  const labels = await effectiveLabels(dd, caseId, gen)
  const fields = await effectiveFields(dd, caseId, gen)
  const ex = (await resultOf<Extraction>(dd, caseId, 'extract', gen))!
  const acts = rp ? await currentActions(c, caseId, gen, rp) : []
  // only an approval bound to this generation: an older sent reply is history, not this Case's approval now (Codex round 4 F25)
  const approved = (await c.query<{ template_id: string; content_sha256: string }>(
    `SELECT template_id, content_sha256 FROM reply WHERE case_id = $1 AND generation = $2 AND approved_generation = $2 AND status IN ('approved', 'sent') ORDER BY approved_at DESC LIMIT 1`,
    [caseId, gen],
  )).rows[0]
  const tasks = (await c.query<{ id: string }>(`SELECT id FROM verification_task WHERE case_id = $1 AND state = 'approved'`, [caseId])).rows.map((r) => r.id)
  const single = (f: string) => {
    const v = asFieldValue(fields[f])
    return typeof v === 'string' ? v : null
  }
  const list = (f: string) => (fields[f]?.status === 'ok' && Array.isArray(fields[f]!.value) ? (fields[f]!.value as string[]) : [])
  const amount = fields.amount?.confirmed && fields.amount.status === 'ok' && fields.amount.value && typeof fields.amount.value === 'object' ? (fields.amount.value as { minor: number; currency: string }) : null
  return {
    mailbox,
    adopted: labels.adopted,
    links: [
      ...(lk.links.contact.id ? [{ kind: 'contact' as const, target: lk.links.contact.id }] : []),
      ...(lk.commitment ? [{ kind: 'commitment' as const, target: lk.commitment.key }] : []),
      ...(lk.dealName ? [{ kind: 'deal' as const, target: lk.dealName }] : []),
      ...lk.links.bankLines.map((b) => ({ kind: 'bank_line' as const, target: b.transactionId })),
    ],
    risk: cr.risk,
    riskBy: cr.risk_by ?? 'system',
    queue: cr.queue,
    assignee: cr.assignee,
    outcome: cr.outcome,
    approved: approved ? { templateId: approved.template_id, contentSha256: approved.content_sha256 } : null,
    confirmedAmount: amount ? { minor: amount.minor, currency: amount.currency } : null,
    ruleUetrs: ex.uetrs.map((u) => u.value),
    fields: {
      consent_evidence: single('consent_evidence'), change_type: single('change_type'), from_payer: single('from_payer'), to_payer: single('to_payer'),
      account_last4: single('account_last4'), party_role: single('party_role'), change_fields: list('change_fields'), document_types: list('document_types'),
    },
    leadConfirmed: leadConfirmed(labels.adopted, fields, lk),
    approvedTasks: tasks,
    actions: acts.filter((a) => a.action !== 'none').map((a) => a.action),
    actionAmount: acts.some((a) => PAYMENT_ACTIONS.includes(a.action)) && lk.commitment ? { minor: lk.commitment.cashDue, currency: lk.commitment.currency } : null,
  }
}

/**
 * The generation the outputs read (review page, CSV, events): the current one once its link and reply steps are done,
 * else the last complete one — never old links with new fields, never «no actions» for «not computed yet» (Codex round
 * 2 F16, self-review R2 / S5).
 */
export async function outputGeneration(c: Pick<Tx, 'query'>, caseId: string, current: number, complete: number | null): Promise<{ gen: number; coherent: boolean }> {
  const n = (await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM stage_run WHERE case_id = $1 AND stage IN ('link', 'reply') AND generation = $2 AND result_blob IS NOT NULL`,
    [caseId, current],
  )).rows[0]!.n
  return n === 2 ? { gen: current, coherent: true } : { gen: complete ?? current, coherent: false }
}

/** Write the events the Case's current state calls for, in the caller's transaction (TC-OUT-06). Returns how many. */
export async function emitEvents(c: Tx, d: Pick<StageDeps, 'db' | 'k' | 'config'>, caseId: string): Promise<number> {
  const cr = (await c.query<{ processing_generation: number; pipeline_complete_generation: number | null; manual_revision: number; risk: Level | null; risk_by: 'system' | 'person' | null; queue: string | null; assignee: string | null; outcome: CaseFacts['outcome'] }>(
    'SELECT processing_generation, pipeline_complete_generation, manual_revision, risk, risk_by, queue, assignee, outcome FROM "case" WHERE id = $1',
    [caseId],
  )).rows[0]!
  const dd = { db: c as unknown as StageDeps['db'], k: d.k }
  // the derived events come from one coherent generation. Before the current one is done only what a person changes on
  // the spot (assignment, closing) is sent, from the last complete generation (Codex E3 F8)
  const { gen, coherent } = await outputGeneration(c, caseId, cr.processing_generation, cr.pipeline_complete_generation)
  const lk = await resultOf<LinkResult>(dd, caseId, 'link', gen)
  const info = await caseInfo(c, caseId)
  // before the first link and risk results, the assignment and the closing still go out at once, with no deal, investor
  // or contact (appendix A allows null); the derived facts below are placeholders then and never sent (Codex round 3 F22)
  const facts: CaseFacts = lk && cr.risk ? await derivedFacts(c, dd, caseId, gen, lk, { ...cr, risk: cr.risk }, info.mailbox_id)
    : { mailbox: info.mailbox_id, adopted: [], links: [], risk: 'low', riskBy: 'system', queue: cr.queue, assignee: cr.assignee, outcome: cr.outcome, approved: null, confirmedAmount: null, ruleUetrs: [],
        fields: { consent_evidence: null, change_type: null, from_payer: null, to_payer: null, account_last4: null, party_role: null, change_fields: [], document_types: [] }, leadConfirmed: false, approvedTasks: [], actions: [], actionAmount: null }
  const stateRows = (await c.query<{ type: string; care_blob: string }>('SELECT type, care_blob FROM event_state WHERE case_id = $1', [caseId])).rows
  const cares = await getBlobs(c, d.k, stateRows.map((r) => r.care_blob))
  const last = new Map(stateRows.map((r) => [r.type, cares.get(r.care_blob)!.toString('utf8')]))
  // case.created first, so a consumer knows the Case before its first assignment (self-review S2)
  const due = dueEvents(facts, last).filter((e) => coherent || e.type === 'case.created' || e.type === 'case.assigned' || e.type === 'case.closed')
  if (!due.length) return 0
  let seq = (await c.query<{ n: number }>('SELECT coalesce(max(case_event_seq), 0)::int AS n FROM event_outbox WHERE case_id = $1', [caseId])).rows[0]!.n
  const webhook = d.config.events.webhook !== undefined
  for (const e of due) {
    seq++
    const id = d.k.hmac(`event\0${caseId}\0${seq}`)
    const event = {
      id, type: e.type, occurred_at: new Date().toISOString(), deployment: d.config.deployment.name, case_id: caseId, case_revision: cr.manual_revision, case_event_seq: seq,
      deal: lk?.dealName ?? null, investor_id: lk?.commitment?.key ?? null, contact_id: lk?.sender?.contactId ?? null, transaction_ids: lk?.links.bankLines.map((b) => b.transactionId) ?? [], data: e.data, schema_version: SCHEMA_VERSION, // contact_id: appendix A «名单匹配的发件人»
    }
    const problems = eventProblems(event)
    if (problems.length) throw new Error(`event ${e.type} does not fit appendix A: ${problems.join('; ')}`)
    const serialised = JSON.stringify(event)
    // R-OUT-03: scanned after serialisation; a full account or ID number is never sent
    const blocked = sensitiveIn(serialised, fullNumbers)
    const care = e.type === 'case.risk_changed' ? String(e.data.to) : e.care
    const careBlob = await putBlob(c, d.k, care)
    // each event keeps its own C-OUT-1 value: a KYC withdrawal restores the state to the last one sent (E4 review S1)
    await c.query('INSERT INTO event_outbox (id, case_id, case_event_seq, type, event_blob, status, next_attempt_at, care_blob, care_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
      id, caseId, seq, e.type, await putBlob(c, d.k, serialised), blocked ? 'blocked' : webhook ? 'pending' : 'unsent', blocked || !webhook ? null : new Date(), careBlob, sha256(care),
    ])
    await c.query(
      `INSERT INTO event_state (case_id, type, care_blob, care_sha256) VALUES ($1, $2, $3, $4)
       ON CONFLICT (case_id, type) DO UPDATE SET care_blob = EXCLUDED.care_blob, care_sha256 = EXCLUDED.care_sha256`,
      [caseId, e.type, careBlob, sha256(care)],
    )
    if (blocked) await appendAudit(c, d.k, [{ actor: 'system', type: 'event.blocked', caseId, payload: { event_id: id, type: e.type, case_event_seq: seq } }])
  }
  return due.length
}

