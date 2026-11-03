import { describe, expect, it } from 'vitest'
import { closingLeadConfirmed, suggestedActions, type ActionInput } from './actions.ts'

const run = (o: Partial<ActionInput>) => suggestedActions({ adopted: [], fields: {}, template: null, commitment: null, deal: null, leadConfirmed: false, ...o }).map((a) => a.action)

describe('suggested actions (C-OUT-3)', () => {
  it('TC-OUT-07 withdrawal: consent given or not, never both', () => {
    expect(run({ adopted: ['withdrawal'], fields: { consent_evidence: 'investor_cc' } })).toEqual(['mark_withdrawn'])
    for (const v of ['none', null, { multiple: ['investor_cc', 'none'] }, { void: 'invalid' }]) expect(run({ adopted: ['withdrawal'], fields: { consent_evidence: v } })).toEqual(['request_withdrawal_consent'])
    expect(run({ adopted: ['withdrawal'] })).toEqual(['request_withdrawal_consent'])
  })
  it('TC-OUT-07 terms change by change_type', () => {
    expect(run({ adopted: ['fee_or_terms_change'], fields: { change_type: 'fee_payer' } })).toEqual(['review_fee_payer_change'])
    expect(run({ adopted: ['fee_or_terms_change'], fields: { change_type: 'valuation' } })).toEqual(['review_terms_change'])
    expect(run({ adopted: ['fee_or_terms_change'] })).toEqual(['review_terms_change'])
  })
  it('TC-OUT-07 table order; payment evidence by the current template (v0.7.12); none', () => {
    const commitment = { investorName: 'Amelia Hart', reference: 'NW-001' }
    expect(run({ adopted: ['bank_details', 'payment_query'], commitment, template: 'safe_ack' })).toEqual(['start_bank_details_verification', 'check_payment_in_ledger'])
    expect(run({ adopted: ['payment_query'], commitment, template: 'payment_need_evidence' })).toEqual(['check_payment_in_ledger', 'request_payment_evidence'])
    expect(run({ adopted: ['payment_query'], commitment, template: 'payment_wait' })).toEqual(['check_payment_in_ledger']) // a person chose another template
    expect(run({ adopted: ['legal_documents', 'tax_certificates'] })).toEqual(['forward_to_legal'])
    expect(run({ adopted: ['complaint'] })).toEqual(['none'])
    const details = suggestedActions({ adopted: ['payment_evidence', 'withdrawal'], fields: { consent_evidence: 'investor_self' }, template: null, commitment, deal: null, leadConfirmed: false })
    expect(details.map((a) => a.details)).toEqual(['Mark Amelia Hart as withdrawn in Deal Ops Toolkit (consent: investor_self)', "Check Amelia Hart's payment in the ledger (NW-001)"])
  })
  it('TC-OUT-07 / TC-OUT-08 lead confirmation', () => {
    const ok = { adopted: ['closing_confirmation'], confirms: 'yes', confirmsByPerson: true, authenticatedSender: true, senderIsLeadOfDeal: true }
    expect(closingLeadConfirmed(ok)).toBe(true)
    expect(closingLeadConfirmed({ ...ok, confirmsByPerson: false })).toBe(false)
    expect(closingLeadConfirmed({ ...ok, senderIsLeadOfDeal: false })).toBe(false)
    expect(closingLeadConfirmed({ ...ok, authenticatedSender: false })).toBe(false)
    expect(closingLeadConfirmed({ ...ok, confirms: 'question' })).toBe(false)
    expect(run({ adopted: ['closing_confirmation'], leadConfirmed: true, deal: 'Northwind Robotics' })).toEqual(['record_lead_confirmation'])
  })
})
