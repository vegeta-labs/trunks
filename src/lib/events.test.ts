import { describe, expect, it } from 'vitest'
import { careFromDelivered, dueEvents, EVENT_TYPES, EVIDENCE_NOTE, eventProblems, sensitiveIn, type CaseFacts, type DueEvent } from './events.ts'
import { fullNumbers } from './redact.ts'

const facts = (o: Partial<CaseFacts> = {}): CaseFacts => ({
  mailbox: 'ops', adopted: ['payment_query'], links: [], risk: 'medium', riskBy: 'system', queue: 'ops', assignee: null, outcome: null, approved: null,
  confirmedAmount: null, ruleUetrs: [],
  fields: { consent_evidence: null, change_type: null, from_payer: null, to_payer: null, account_last4: null, party_role: null, change_fields: [], document_types: [] },
  leadConfirmed: false, approvedTasks: [], actions: [], actionAmount: null, ...o,
})
const types = (e: DueEvent[]) => e.map((x) => x.type)
/** Send everything due and remember it, as the store does. */
const send = (s: CaseFacts, last: Map<string, string>) => {
  const due = dueEvents(s, last)
  for (const e of due) last.set(e.type, e.type === 'case.risk_changed' ? (e.data.to as string) : e.care)
  return due
}
const wrap = (e: DueEvent, seq = 1) => ({
  id: 'x', type: e.type, occurred_at: '2026-10-29T10:15:00.000Z', deployment: 'demo', case_id: 'c1', case_revision: 0, case_event_seq: seq,
  deal: null, investor_id: null, contact_id: null, transaction_ids: [], data: e.data, schema_version: 1,
})

describe('events (C-OUT-1, appendix A)', () => {
  it('TC-OUT-01 every type, as built, fits the closed schema; one extra field fails', () => {
    const all = facts({
      adopted: ['payment_query', 'payment_evidence', 'withdrawal', 'fee_or_terms_change', 'bank_details', 'identity_change', 'kyc_documents', 'closing_confirmation'],
      links: [{ kind: 'contact', target: 'C001' }], outcome: 'replied', approved: { templateId: 'safe_ack', contentSha256: 'a'.repeat(64) },
      confirmedAmount: { minor: 1_000_000, currency: 'GBP' }, ruleUetrs: ['eb6305c9-1f7f-49de-aed0-16487c27c35a'],
      fields: { consent_evidence: 'none', change_type: 'fee_payer', from_payer: 'investors', to_payer: 'company', account_last4: '5432', party_role: 'investor', change_fields: ['email'], document_types: ['passport'] },
      leadConfirmed: true, approvedTasks: ['t1'], actions: ['check_payment_in_ledger'], actionAmount: { minor: 1_000_000, currency: 'GBP' },
    })
    const due = dueEvents(all, new Map())
    expect(new Set(types(due))).toEqual(new Set(EVENT_TYPES))
    for (const e of due) expect(eventProblems(wrap(e))).toEqual([])
    const ev = wrap(due[0]!)
    expect(eventProblems({ ...ev, extra: 1 })).toEqual(['unknown field extra'])
    expect(eventProblems({ ...ev, data: { mailbox: 'ops', more: 1 } })).toEqual(['unknown data field more'])
    expect(eventProblems({ ...ev, data: {} })).toEqual(['missing data field mailbox'])
    expect(eventProblems(wrap({ type: 'case.risk_changed', care: '', data: { from: null, to: 'severe', by: 'system' } }))).toEqual(['data.to has the wrong type'])
    expect(eventProblems(wrap({ type: 'bank_details.change_requested', care: '', data: { account_last4: '12345', party_role: null } }))).toEqual(['data.account_last4 must be 4 digits'])
  })
  it('TC-OUT-10 state changes only; Alice → Bob → Alice gives three events', () => {
    const last = new Map<string, string>()
    expect(types(send(facts(), last))).toEqual(['case.created', 'case.classified', 'case.risk_changed', 'case.assigned', 'payment.query_received'])
    expect(send(facts(), last)).toEqual([]) // a re-run, nothing changed
    expect(send(facts({ assignee: 'alice' }), last).map((e) => e.data)).toEqual([{ queue: 'ops', assignee: 'alice' }])
    expect(send(facts({ assignee: 'bob' }), last)).toHaveLength(1)
    expect(send(facts({ assignee: 'alice' }), last)).toHaveLength(1)
    expect(send(facts({ risk: 'high', riskBy: 'person', assignee: 'alice' }), last).map((e) => e.data)).toEqual([{ from: 'medium', to: 'high', by: 'person' }])
  })
  it('first-time types are sent once; withdrawal again when the consent changes', () => {
    const last = new Map<string, string>()
    send(facts({ adopted: ['withdrawal'] }), last)
    expect(types(send(facts({ adopted: ['withdrawal'], fields: { ...facts().fields, consent_evidence: 'investor_cc' } }), last))).toEqual(['withdrawal.requested'])
    send(facts({ adopted: ['bank_details'] }), last)
    expect(types(send(facts({ adopted: ['bank_details'], fields: { ...facts().fields, account_last4: '9999' } }), last))).toEqual([])
  })
  it('TC-OUT-07 / TC-FRD-03 evidence: one UETR only, the fixed note', () => {
    const one = dueEvents(facts({ adopted: ['payment_evidence'], ruleUetrs: ['u1'] }), new Map()).find((e) => e.type === 'payment.evidence_received')!
    expect(one.data).toEqual({ uetr: 'u1', amount_minor: null, currency: null, note: EVIDENCE_NOTE })
    const two = dueEvents(facts({ adopted: ['payment_evidence'], ruleUetrs: ['u1', 'u2'] }), new Map()).find((e) => e.type === 'payment.evidence_received')!
    expect(two.data.uetr).toBe(null)
  })
  it('TC-OUT-08 lead confirmation only when the condition holds', () => {
    expect(types(dueEvents(facts({ adopted: ['closing_confirmation'] }), new Map()))).not.toContain('closing.lead_confirmed')
    expect(types(dueEvents(facts({ adopted: ['closing_confirmation'], leadConfirmed: true }), new Map()))).toContain('closing.lead_confirmed')
  })
  it('verification.completed once per approved task', () => {
    const last = new Map<string, string>()
    expect(send(facts({ approvedTasks: ['t1', 't2'] }), last).filter((e) => e.type === 'verification.completed').map((e) => e.data.task_id)).toEqual(['t1', 't2'])
    expect(send(facts({ approvedTasks: ['t1', 't2'] }), last).filter((e) => e.type === 'verification.completed')).toEqual([])
    expect(send(facts({ approvedTasks: ['t1', 't2', 't3'] }), last).filter((e) => e.type === 'verification.completed').map((e) => e.data.task_id)).toEqual(['t3'])
  })
  it('TC-OUT-04 the serialised event is scanned: a full IBAN is found, last-4 and amounts are not', () => {
    const scan = (v: unknown) => sensitiveIn(JSON.stringify(v), fullNumbers)
    expect(scan({ data: { account_last4: '5432', amount_minor: 12345678 } })).toBe(false)
    expect(scan({ data: { note: 'GB82 WEST 1234 5698 7654 32' } })).toBe(true)
    expect(scan({ data: { note: 'account 12345678' } })).toBe(true)
    expect(scan({ data: { note: 'passport 123456789' } })).toBe(true)
    expect(scan({ transaction_ids: ['T1', 'GB33BUKB20201555555555'], data: {} })).toBe(true) // arrays too
    expect(scan({ case_id: '3f2c1a9e-0d4b-4c7e-9a1f-6b2e8d0c4a77', data: { content_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } })).toBe(false)
  })
})

describe('careFromDelivered (Codex E4 round 5 F2)', () => {
  it('TC-OUT-10 rebuilt values are the ones dueEvents compares: unchanged values are not re-sent, a risk «from» stays a level', () => {
    expect(careFromDelivered('case.risk_changed', [{ data: { from: null, to: 'medium' } }])).toBe('medium')
    expect(careFromDelivered('verification.completed', [{ data: { task_id: 'b' } }, { data: { task_id: 'a' } }])).toBe('["a","b"]')
    expect(careFromDelivered('case.classified', [{ data: { classes: ['payment_query'] } }])).toBe('["payment_query"]')
    expect(careFromDelivered('kyc.documents_received', [{ data: {} }])).toBe('seen')
    expect(JSON.parse(careFromDelivered('case.linked', [{ data: { link_kinds: ['deal'] } }]))).toBeInstanceOf(Array)
  })
})
