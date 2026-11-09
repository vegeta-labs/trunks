import { describe, expect, it } from 'vitest'
import { applyAdjustment, computeRisk, hasPressure, requestAdjustment, type ClassFloor, type RiskInput } from './risk.ts'

// PRD §3.1 default floors (config/default/cases.yaml)
const classes: ClassFloor[] = [
  { id: 'payment_query', risk_floor: 'medium' },
  { id: 'payment_evidence', risk_floor: 'medium' },
  { id: 'unreferenced_payment', risk_floor: 'medium' },
  { id: 'kyc_documents', risk_floor: 'high' },
  { id: 'withdrawal', risk_floor: 'high' },
  { id: 'commitment_change', risk_floor: 'medium' },
  { id: 'fee_or_terms_change', risk_floor: 'high' },
  { id: 'closing_confirmation', risk_floor: 'medium' },
  { id: 'legal_documents', risk_floor: 'high' },
  { id: 'bank_details', risk_floor: 'high' },
  { id: 'identity_change', risk_floor: 'high' },
  { id: 'tax_certificates', risk_floor: 'medium' },
  { id: 'exit_distribution', risk_floor: 'medium' },
  { id: 'bank_letter_request', risk_floor: 'low' },
  { id: 'account_access', risk_floor: 'medium' },
  { id: 'complaint', risk_floor: 'medium' },
  { id: 'other_known', risk_floor: 'high' },
  { id: 'unclassified', risk_floor: 'medium' },
]
const holidays = new Set(['2026-08-31', '2026-12-25', '2026-12-28'])
const quiet = { auth_fail: false, untrusted_auth_header: false, display_name_mismatch: false, lookalike_domain: false, reply_to_mismatch: false, first_time_sender: false, hidden_text: false, injection_markers: false, message_id_collision: false }
const input = (o: Partial<RiskInput> & { sig?: Partial<Record<keyof typeof quiet, boolean | null>> } = {}): RiskInput => ({
  classes, labels: ['bank_letter_request'], signals: { ...quiet, ...o.sig }, accountPresent: false, uetrCandidatesInvalid: 0, amountsBody: [], amountsAttachment: [],
  attachmentBlockedOrOverLimit: false, pressure: false, plannedCloseDate: null, receivedDate: '2026-10-29', holidays, ...o,
})
const level = (o: Parameters<typeof input>[0] = {}) => computeRisk(input(o)).level
const gbp = (pounds: number) => ({ minor: pounds * 100, currency: 'GBP' })

describe('risk (C-RSK-1, C-RSK-2, C-RSK-2a)', () => {
  it('TC-RSK-01 low class; + auth_fail → medium; + reply_to_mismatch → high', () => {
    expect(level()).toBe('low')
    expect(level({ sig: { auth_fail: true } })).toBe('medium')
    expect(level({ sig: { auth_fail: true, reply_to_mismatch: true } })).toBe('high')
    expect(level({ sig: { auth_fail: null } })).toBe('low') // unknown is not a failure
  })
  it('base = highest floor over adopted and low labels (C-RSK-1)', () => {
    expect(level({ labels: ['bank_letter_request', 'account_access'] })).toBe('medium')
    expect(level({ labels: ['commitment_change', 'bank_details'] })).toBe('high') // a model low label counts
    expect(() => level({ labels: ['nope'] })).toThrow()
  })
  it('TC-RSK-02 first_time_sender alone does not raise; with an account → high', () => {
    expect(level({ sig: { first_time_sender: true } })).toBe('low')
    expect(level({ sig: { first_time_sender: true }, accountPresent: true })).toBe('high')
    expect(level({ accountPresent: true })).toBe('low')
  })
  it('TC-RSK-03 pressure words with listed classes only; whole words', () => {
    expect(hasPressure(['please do this today'])).toBe(true)
    expect(hasPressure(['Sarah asked about the SAR form'])).toBe(false) // sar is an internal term, not a pressure word
    expect(hasPressure(['Kind regards, Sarah'])).toBe(false)
    expect(level({ labels: ['exit_distribution'], pressure: true })).toBe('high')
    expect(level({ labels: ['bank_letter_request'], pressure: true })).toBe('low')
    expect(hasPressure(['Re: urgently needed'], [])).toBe(true)
    expect(hasPressure(['act now'], ['act now'])).toBe(true) // configured additions
  })
  it('TC-RSK-04 planned close within 0–3 working days (v0.7.12 count)', () => {
    const pq = (close: string, received = '2026-10-29', labels = ['payment_query']) => level({ labels, plannedCloseDate: close, receivedDate: received })
    expect(pq('2026-10-29')).toBe('high') // same day: medium + 1
    expect(pq('2026-11-03')).toBe('high') // Thu → Tue: Fri, Mon, Tue = 3
    expect(pq('2026-11-04')).toBe('medium') // 4
    expect(pq('2026-10-28')).toBe('medium') // before receipt
    expect(pq('2026-11-01', '2026-10-30')).toBe('high') // Fri → Sun: 0
    expect(pq('2026-11-02', '2026-10-31')).toBe('high') // Sat → Mon: 1
    expect(pq('2026-09-02', '2026-08-27')).toBe('high') // Thu → Wed, Monday a bank holiday: 3
    expect(pq('2026-10-29', '2026-10-29', ['complaint'])).toBe('medium') // class not listed
    expect(pq('2026-10-29', '2026-10-29', ['bank_letter_request', 'payment_query'])).toBe('high') // a low label payment_query counts
  })
  it('TC-RSK-07 each direct trigger on a low class → high', () => {
    for (const s of ['lookalike_domain', 'display_name_mismatch', 'hidden_text', 'injection_markers', 'message_id_collision'] as const) expect(level({ sig: { [s]: true } })).toBe('high')
    expect(level({ uetrCandidatesInvalid: 1 })).toBe('high')
    expect(level({ attachmentBlockedOrOverLimit: true })).toBe('high')
  })
  it('TC-RSK-08 amount mismatch by sets', () => {
    expect(level({ amountsBody: [gbp(10000), gbp(20000)], amountsAttachment: [gbp(10000)] })).toBe('low')
    expect(level({ amountsBody: [gbp(10000)], amountsAttachment: [gbp(9000)] })).toBe('high')
    expect(level({ amountsBody: [gbp(10000)], amountsAttachment: [gbp(10000), gbp(9000)] })).toBe('low') // A ∩ B not empty
    expect(level({ amountsBody: [], amountsAttachment: [gbp(9000)] })).toBe('low')
    expect(level({ amountsBody: [gbp(10000)], amountsAttachment: [] })).toBe('low')
    expect(level({ amountsBody: [gbp(100)], amountsAttachment: [{ minor: 10000, currency: 'EUR' }] })).toBe('high') // currency differs
  })
  it('TC-RSK-06 nothing from the model text enters the computation', () => {
    // the input has no place for a model reason; only labels count
    expect(level({ labels: ['bank_details'] })).toBe('high')
  })
  it('every rule result is reported (C-AUD-3)', () => {
    const r = computeRisk(input({ sig: { auth_fail: true } }))
    expect(r.clauses).toHaveLength(15)
    expect(r.clauses.filter((c) => c.hit).map((c) => c.id)).toEqual(['C-RSK-2a:auth_fail'])
    expect(r.reasons).toEqual(['bank_letter_request', 'C-RSK-2a:auth_fail'])
  })
})

describe('manual adjustment (C-RSK-3 ①–⑦, v0.7.12)', () => {
  const medium = computeRisk(input({ labels: ['payment_query', 'complaint'] }))
  it('TC-RSK-09 a raise holds whatever the computation does', () => {
    const req = requestAdjustment('high', medium, 'medium', classes)
    expect(req).toMatchObject({ kind: 'set', needsApprover: false })
    const adj = req.kind === 'set' ? req.adjustment : null
    const low = computeRisk(input({ labels: ['bank_letter_request'] }))
    expect(applyAdjustment(low, adj, classes)).toEqual({ level: 'high', void: false })
    // going back to the computed level is a cancel and lowers the final risk: approver
    expect(requestAdjustment('medium', medium, 'high', classes)).toEqual({ kind: 'cancel', needsApprover: true })
    expect(applyAdjustment(medium, null, classes).level).toBe('medium')
  })
  it('TC-RSK-05 / 09 a lowering needs an approver, lapses on a new reason, never comes back', () => {
    const high = computeRisk(input({ labels: ['payment_query'], sig: { lookalike_domain: true } }))
    const req = requestAdjustment('medium', high, 'high', classes)
    expect(req.needsApprover).toBe(true)
    const adj = req.kind === 'set' ? req.adjustment : null
    expect(adj).toEqual({ level: 'medium', computedAtSet: 'high', reasons: ['C-RSK-2:lookalike_domain'] })
    expect(applyAdjustment(high, adj, classes)).toEqual({ level: 'medium', void: false })
    // a class whose floor is not above L does not count
    expect(applyAdjustment(computeRisk(input({ labels: ['payment_query', 'complaint'], sig: { lookalike_domain: true } })), adj, classes)).toEqual({ level: 'medium', void: false })
    // a new high-floor class: lapses even though the level stays high
    expect(applyAdjustment(computeRisk(input({ labels: ['payment_query', 'withdrawal'], sig: { lookalike_domain: true } })), adj, classes)).toEqual({ level: 'high', void: true })
    // a newly hit clause
    expect(applyAdjustment(computeRisk(input({ labels: ['payment_query'], sig: { lookalike_domain: true, reply_to_mismatch: true } })), adj, classes).void).toBe(true)
    // the computation falling below L: min
    expect(applyAdjustment(computeRisk(input({ labels: ['bank_letter_request'] })), { level: 'medium', computedAtSet: 'high', reasons: [] }, classes)).toEqual({ level: 'low', void: false })
  })
  it('② is judged against the final risk; ④ a raise is a floor, not a cap', () => {
    const low = computeRisk(input({ labels: ['bank_letter_request'] }))
    expect(requestAdjustment('medium', low, 'high', classes).needsApprover).toBe(true) // computed low, raised to high: medium lowers it
    expect(applyAdjustment(computeRisk(input({ labels: ['bank_details'] })), { level: 'medium', computedAtSet: 'low', reasons: [] }, classes).level).toBe('high')
  })
  it('a lowering lapses when the computed risk rises above C0', () => {
    const adj = { level: 'low' as const, computedAtSet: 'medium' as const, reasons: ['payment_query'] }
    expect(applyAdjustment(computeRisk(input({ labels: ['payment_query'] })), adj, classes)).toEqual({ level: 'low', void: false })
    expect(applyAdjustment(computeRisk(input({ labels: ['payment_query'], sig: { auth_fail: true } })), adj, classes)).toEqual({ level: 'high', void: true })
  })
})

describe('the class floor behind the risk (D8)', () => {
  it('TC-REV-09 names the labels whose floor set the base level; none at low', () => {
    expect(computeRisk(input({ labels: ['withdrawal', 'payment_query'] })).floorClasses).toEqual(['withdrawal'])
    expect(computeRisk(input({ labels: ['payment_query', 'commitment_change'] })).floorClasses).toEqual(['payment_query', 'commitment_change'])
    expect(computeRisk(input({ labels: ['bank_letter_request'] })).floorClasses).toEqual([])
  })
})
