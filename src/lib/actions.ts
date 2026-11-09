// PRD C-OUT-3 suggested actions and the `closing.lead_confirmed` condition (appendix A). Fixed details text with
// values from the directory or confirmed enum fields only; never model text. Nothing is executed (R-ACT-01).
import type { FieldValue } from './draft.ts'

export interface Action {
  action: string
  details: string | null
}

const CONSENT_OK = ['investor_cc', 'forwarded_written_consent', 'attached_document', 'investor_self']
const single = (v: FieldValue | undefined) => (typeof v === 'string' ? v : null)

export interface ActionInput {
  adopted: readonly string[]
  fields: Readonly<Record<string, FieldValue | undefined>>
  template: string | null // the current reply's template, automatic or chosen by a person (v0.7.12)
  commitment: { investorName: string; reference: string } | null // the linked commitment, from the directory
  deal: string | null // the linked deal's name
  leadConfirmed: boolean // closingLeadConfirmed()
}

export function suggestedActions(i: ActionInput): Action[] {
  const has = (c: string) => i.adopted.includes(c)
  // READING: with no commitment linked the investor is not named; the details say «the investor»
  const investor = i.commitment?.investorName ?? 'the investor'
  const consent = single(i.fields.consent_evidence)
  const consentText = consent ?? 'none'
  const out: Action[] = []
  const verify = 'Verify the request by calling the phone number on file'
  if (has('bank_details')) out.push({ action: 'start_bank_details_verification', details: verify })
  if (has('identity_change')) out.push({ action: 'start_identity_verification', details: verify })
  if (has('withdrawal')) {
    if (consent !== null && CONSENT_OK.includes(consent)) out.push({ action: 'mark_withdrawn', details: `Mark ${investor} as withdrawn in Deal Ops Toolkit (consent: ${consent})` })
    else out.push({ action: 'request_withdrawal_consent', details: "Ask for the investor's written consent before marking the withdrawal" })
  }
  if (has('fee_or_terms_change')) {
    if (single(i.fields.change_type) === 'fee_payer') out.push({ action: 'review_fee_payer_change', details: `Review the fee payer change and the consent evidence (${consentText})` })
    else out.push({ action: 'review_terms_change', details: `Review the requested change to the deal terms and the consent evidence (${consentText})` })
  }
  const payment = has('payment_query') || has('payment_evidence')
  if (payment && i.commitment) out.push({ action: 'check_payment_in_ledger', details: `Check ${investor}'s payment in the ledger (${i.commitment.reference})` })
  if (payment && i.template === 'payment_need_evidence') out.push({ action: 'request_payment_evidence', details: 'Ask for the payment confirmation with UETR' })
  if (payment && i.template === 'payment_evidence_received') out.push({ action: 'check_payment_evidence', details: "Check the sender's payment confirmation against the ledger; it is not proof of receipt" })
  if (has('kyc_documents')) out.push({ action: 'forward_kyc_documents', details: 'Forward the documents to the KYC process' })
  if (has('legal_documents') || has('tax_certificates')) out.push({ action: 'forward_to_legal', details: 'Forward to the legal team' })
  if (i.leadConfirmed && i.deal) out.push({ action: 'record_lead_confirmation', details: `Record the lead's confirmation for ${i.deal}` })
  return out.length ? out : [{ action: 'none', details: null }]
}

/** Appendix A `closing.lead_confirmed`: confirms = yes confirmed by a person, an authenticated sender who is a lead of that deal. */
export function closingLeadConfirmed(i: { adopted: readonly string[]; confirms: FieldValue | undefined; confirmsByPerson: boolean; authenticatedSender: boolean; senderIsLeadOfDeal: boolean }): boolean {
  return i.adopted.includes('closing_confirmation') && single(i.confirms) === 'yes' && i.confirmsByPerson && i.authenticatedSender && i.senderIsLeadOfDeal
}
