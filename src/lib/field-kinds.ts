// PRD §5.5a: the kind of each field and the allowed values of the list fields. No imports, so the review page can
// use it to offer the right input (TC-REV-18) while the server keeps the checks in fields.ts.
export type Kind = 'money' | 'currency' | 'date' | 'text' | 'reference' | 'uetr' | 'deal' | 'enum' | 'enums' | 'boolean' | 'platform' | 'last4'
export const ENUMS: Record<string, readonly string[]> = {
  document_types: ['passport', 'driving_licence', 'proof_of_address', 'bank_statement', 'certificate_of_incorporation', 'register_of_members', 'ubo_register', 'structure_chart', 'trust_deed', 'partnership_agreement', 'tax_id', 'other'],
  entity_type: ['individual', 'company', 'trust', 'partnership', 'other'],
  consent_evidence: ['investor_cc', 'forwarded_written_consent', 'attached_document', 'investor_self', 'none'],
  change_type: ['fee_payer', 'valuation', 'share_price', 'instrument', 'other'],
  from_payer: ['investors', 'company', 'lead'],
  to_payer: ['investors', 'company', 'lead'],
  confirms: ['yes', 'no', 'question'],
  document_type: ['subscription', 'shareholder_resolution', 'conversion', 'side_letter', 'transfer', 'other'],
  party_role: ['investor', 'company', 'seller', 'lead', 'other'],
  change_fields: ['name', 'email', 'postal_address', 'phone'],
  certificate_type: ['seis', 'eis', 'other'],
  question_type: ['timing', 'amount', 'tax', 'other'],
  issue_type: ['login', 'permissions', 'other'],
  subtype: ['secondary', 'liquidation', 'nominee_kyc', 'us_person', 'fx', 'rolling_close', 'other'],
}
export const KIND: Record<string, Kind> = {
  amount: 'money', new_amount: 'money', currency: 'currency', payment_date: 'date', value_date: 'date',
  payer_name: 'text', investor: 'text', third_party_payer: 'text', reference: 'reference', uetr: 'uetr',
  document_types: 'enums', change_fields: 'enums', deal: 'deal', platform: 'platform', account_last4: 'last4', change_requested: 'boolean',
  ...Object.fromEntries(Object.keys(ENUMS).filter((f) => f !== 'document_types' && f !== 'change_fields').map((f) => [f, 'enum' as const])),
}
