// PRD C-OUT-1 and appendix A (schema_version 1): which events a Case's current state calls for, their closed `data`
// shapes, and the scan of the serialised event. An event is a state change: it is due only when the value its type
// cares about differs from the last one sent (the store keeps that in `event_state` and numbers the events).
import type { Level } from './risk.ts'

export const SCHEMA_VERSION = 1
export const EVIDENCE_NOTE = "sender's confirmation, not proof of receipt" // C-FRD-2

type Kind = 'string' | 'integer' | 'string[]' | { enum: readonly string[] }
interface FieldSpec {
  kind: Kind
  nullable: boolean
}
const f = (kind: Kind, nullable = false): FieldSpec => ({ kind, nullable })
const LEVEL = { enum: ['low', 'medium', 'high'] } as const
const PAYER = { enum: ['investors', 'company', 'lead'] } as const
const CONSENT = { enum: ['investor_cc', 'forwarded_written_consent', 'attached_document', 'investor_self', 'none'] } as const

// appendix A, in table order
export const EVENT_DATA: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = {
  'case.created': { mailbox: f('string') },
  'case.classified': { classes: f('string[]') },
  'case.linked': { link_kinds: f('string[]') },
  'case.risk_changed': { from: f(LEVEL, true), to: f(LEVEL), by: f({ enum: ['system', 'person'] }) },
  'case.assigned': { queue: f('string'), assignee: f('string', true) },
  'case.closed': { outcome: f({ enum: ['replied', 'no_action', 'forwarded', 'duplicate', 'spam'] }) },
  'reply.approved': { template_id: f('string'), content_sha256: f('string') },
  'payment.query_received': { amount_minor: f('integer', true), currency: f('string', true) },
  'payment.evidence_received': { uetr: f('string', true), amount_minor: f('integer', true), currency: f('string', true), note: f({ enum: [EVIDENCE_NOTE] }) },
  'withdrawal.requested': { consent_evidence: f(CONSENT, true) },
  'fee_payer.change_requested': { from_payer: f(PAYER, true), to_payer: f(PAYER, true), consent_evidence: f(CONSENT, true) },
  'bank_details.change_requested': { account_last4: f('string', true), party_role: f({ enum: ['investor', 'company', 'seller', 'lead', 'other'] }, true) },
  'identity.change_requested': { change_fields: f('string[]') },
  'closing.lead_confirmed': { confirms: f({ enum: ['yes'] }) },
  'kyc.documents_received': { document_types: f('string[]') },
  'verification.completed': { task_id: f('string') },
  'action.suggested': { actions: f('string[]'), amount_minor: f('integer', true), currency: f('string', true) },
}
export const EVENT_TYPES = Object.keys(EVENT_DATA)

const COMMON = ['id', 'type', 'occurred_at', 'deployment', 'case_id', 'case_revision', 'case_event_seq', 'deal', 'investor_id', 'contact_id', 'transaction_ids', 'data', 'schema_version']

const isKind = (v: unknown, k: Kind): boolean => {
  if (k === 'string') return typeof v === 'string'
  if (k === 'integer') return Number.isSafeInteger(v)
  if (k === 'string[]') return Array.isArray(v) && v.every((x) => typeof x === 'string')
  return typeof v === 'string' && k.enum.includes(v)
}

/** The closed schema: problems, empty when the event is valid (TC-OUT-01). */
export function eventProblems(e: Record<string, unknown>): string[] {
  const p: string[] = []
  for (const k of Object.keys(e)) if (!COMMON.includes(k)) p.push(`unknown field ${k}`)
  for (const k of COMMON) if (!(k in e)) p.push(`missing field ${k}`)
  const spec = EVENT_DATA[e.type as string]
  if (!spec) return [...p, `unknown type ${String(e.type)}`]
  for (const k of ['id', 'occurred_at', 'deployment', 'case_id']) if (typeof e[k] !== 'string') p.push(`${k} must be a string`)
  if (typeof e.occurred_at === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(e.occurred_at)) p.push('occurred_at must be ISO 8601 UTC')
  for (const k of ['case_revision', 'case_event_seq']) if (!Number.isSafeInteger(e[k])) p.push(`${k} must be an integer`)
  for (const k of ['deal', 'investor_id', 'contact_id']) if (e[k] !== null && typeof e[k] !== 'string') p.push(`${k} must be a string or null`)
  if (!isKind(e.transaction_ids, 'string[]')) p.push('transaction_ids must be an array of strings')
  if (e.schema_version !== SCHEMA_VERSION) p.push('schema_version must be 1')
  const data = e.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [...p, 'data must be an object']
  for (const k of Object.keys(data)) if (!(k in spec)) p.push(`unknown data field ${k}`)
  for (const [k, s] of Object.entries(spec)) {
    const v = (data as Record<string, unknown>)[k]
    if (!(k in data)) p.push(`missing data field ${k}`)
    else if (v === null ? !s.nullable : !isKind(v, s.kind)) p.push(`data.${k} has the wrong type`)
  }
  const LISTS: Record<string, readonly string[]> = {
    change_fields: ['name', 'email', 'postal_address', 'phone'],
    document_types: ['passport', 'driving_licence', 'proof_of_address', 'bank_statement', 'certificate_of_incorporation', 'register_of_members', 'ubo_register', 'structure_chart', 'trust_deed', 'partnership_agreement', 'tax_id', 'other'],
  }
  for (const [k, allowed] of Object.entries(LISTS)) {
    const v = (data as Record<string, unknown>)[k]
    if (Array.isArray(v) && v.some((x) => !allowed.includes(x as string))) p.push(`data.${k} has a value outside §5.5a`)
  }
  if (e.type === 'bank_details.change_requested') {
    const l4 = (data as Record<string, unknown>).account_last4
    if (l4 !== null && (typeof l4 !== 'string' || !/^\d{4}$/.test(l4))) p.push('data.account_last4 must be 4 digits')
  }
  return p
}

// ---------- what the current state calls for ----------

type Fv = string | null // a single value or null (multiple / void / empty project to null, appendix A single-value projection)

export interface CaseFacts {
  mailbox: string
  adopted: readonly string[]
  links: ReadonlyArray<{ kind: 'contact' | 'commitment' | 'deal' | 'bank_line'; target: string }>
  risk: Level
  riskBy: 'system' | 'person'
  queue: string | null // null until routed or set by a person
  assignee: string | null
  outcome: 'replied' | 'no_action' | 'forwarded' | 'duplicate' | 'spam' | null
  approved: { templateId: string; contentSha256: string } | null
  confirmedAmount: { minor: number; currency: string } | null // the amount field confirmed by a person
  ruleUetrs: readonly string[]
  fields: { consent_evidence: Fv; change_type: Fv; from_payer: Fv; to_payer: Fv; account_last4: Fv; party_role: Fv; change_fields: readonly string[]; document_types: readonly string[] }
  leadConfirmed: boolean
  approvedTasks: readonly string[] // verification tasks in `approved`
  actions: readonly string[] // C-OUT-3, in table order
  actionAmount: { minor: number; currency: string } | null // the amount due when an action is about a payment (C-OUT-2)
}

export interface DueEvent {
  type: string
  care: string // the value this type cares about; due when it differs from the last sent one
  data: Record<string, unknown>
}

const sorted = (xs: readonly string[]) => [...new Set(xs)].sort()

/**
 * The care value of a type rebuilt from events already delivered (oldest first) — for events delivered before each event
 * kept its own value (Codex E4 round 5 F2). The same encodings as dueEvents. `case.linked` sends only the link kinds,
 * so its exact value cannot be rebuilt: a value that equals no real one makes the next run send the current links.
 */
export function careFromDelivered(type: string, delivered: ReadonlyArray<{ data: Record<string, unknown> }>): string {
  const d = delivered.at(-1)?.data ?? {}
  switch (type) {
    case 'case.created':
      return 'created'
    case 'case.classified':
      return JSON.stringify(sorted((d.classes as string[]) ?? []))
    case 'case.risk_changed':
      return String(d.to)
    case 'case.assigned':
      return JSON.stringify([d.queue ?? null, d.assignee ?? null])
    case 'case.closed':
      return String(d.outcome)
    case 'reply.approved':
      return `${String(d.template_id)} ${String(d.content_sha256)}`
    case 'withdrawal.requested':
      return JSON.stringify(d.consent_evidence ?? null)
    case 'fee_payer.change_requested':
      return JSON.stringify({ from_payer: d.from_payer, to_payer: d.to_payer, consent_evidence: d.consent_evidence })
    case 'verification.completed':
      return JSON.stringify(sorted(delivered.map((e) => String(e.data.task_id))))
    case 'action.suggested':
      return JSON.stringify([...((d.actions as string[]) ?? [])].sort())
    case 'case.linked':
      return '["(delivered before E4)"]'
    default:
      return 'seen' // the «first» events
  }
}

/**
 * Events due now, in appendix A order. `last` maps a type to the care value last sent (absent: never sent); for
 * `case.risk_changed` also the level last sent, as `from`.
 */
export function dueEvents(s: CaseFacts, last: ReadonlyMap<string, string>): DueEvent[] {
  const out: DueEvent[] = []
  const add = (type: string, care: string, data: Record<string, unknown>) => {
    if (last.get(type) !== care) out.push({ type, care, data })
  }
  const has = (c: string) => s.adopted.includes(c)
  add('case.created', 'created', { mailbox: s.mailbox })
  add('case.classified', JSON.stringify(sorted(s.adopted)), { classes: sorted(s.adopted) })
  // an emptied set is a change too, once a set has been sent (Codex E3 F9)
  if (s.links.length || last.has('case.linked')) add('case.linked', JSON.stringify(sorted(s.links.map((l) => `${l.kind}:${l.target}`))), { link_kinds: sorted(s.links.map((l) => l.kind)) })
  const prevRisk = last.get('case.risk_changed')
  add('case.risk_changed', s.risk, { from: prevRisk ?? null, to: s.risk, by: s.riskBy })
  // appendix A: case.assigned carries the queue; case.closed does not and is sent without one (self-review S1)
  if (s.queue !== null) add('case.assigned', JSON.stringify([s.queue, s.assignee]), { queue: s.queue, assignee: s.assignee })
  if (s.outcome) add('case.closed', s.outcome, { outcome: s.outcome })
  if (s.approved) add('reply.approved', `${s.approved.templateId} ${s.approved.contentSha256}`, { template_id: s.approved.templateId, content_sha256: s.approved.contentSha256 })
  // «首次»: once the label has been seen, the event is not sent again
  const first = (type: string, cond: boolean, data: Record<string, unknown>) => {
    if (cond && !last.has(type)) out.push({ type, care: 'seen', data })
  }
  const amount = { amount_minor: s.confirmedAmount?.minor ?? null, currency: s.confirmedAmount?.currency ?? null }
  first('payment.query_received', has('payment_query'), amount)
  first('payment.evidence_received', has('payment_evidence'), { uetr: s.ruleUetrs.length === 1 ? s.ruleUetrs[0]! : null, ...amount, note: EVIDENCE_NOTE })
  if (has('withdrawal')) add('withdrawal.requested', JSON.stringify(s.fields.consent_evidence), { consent_evidence: s.fields.consent_evidence })
  if (has('fee_or_terms_change') && s.fields.change_type === 'fee_payer') {
    const v = { from_payer: s.fields.from_payer, to_payer: s.fields.to_payer, consent_evidence: s.fields.consent_evidence }
    add('fee_payer.change_requested', JSON.stringify(v), v)
  }
  first('bank_details.change_requested', has('bank_details'), { account_last4: s.fields.account_last4, party_role: s.fields.party_role })
  first('identity.change_requested', has('identity_change'), { change_fields: sorted(s.fields.change_fields) })
  first('closing.lead_confirmed', s.leadConfirmed, { confirms: 'yes' })
  first('kyc.documents_received', has('kyc_documents'), { document_types: sorted(s.fields.document_types) })
  const sent = new Set<string>(JSON.parse(last.get('verification.completed') ?? '[]') as string[])
  const approved = sorted(s.approvedTasks)
  for (const id of approved.filter((t) => !sent.has(t))) {
    sent.add(id)
    out.push({ type: 'verification.completed', care: JSON.stringify(sorted([...sent])), data: { task_id: id } })
  }
  if (s.actions.length || last.has('action.suggested')) add('action.suggested', JSON.stringify([...s.actions].sort()), { actions: [...s.actions], amount_minor: s.actionAmount?.minor ?? null, currency: s.actionAmount?.currency ?? null })
  return out
}

/**
 * C-OUT-1 / R-OUT-03: full account and identity numbers in a serialised event or CSV, by the C-RED-1 rules. Each string
 * value is scanned on its own, so field names (`account_last4`) and integers do not act as keywords or digits.
 */
export function sensitiveIn(serialised: string, detect: (text: string) => readonly unknown[]): boolean {
  const strings: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(JSON.parse(serialised))
  return strings.some((t) => detect(t).length > 0)
}
