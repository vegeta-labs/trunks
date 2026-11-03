// Names the configuration may refer to.

import { PLACEHOLDER_SOURCE } from '../lib/draft.ts'

// PRD C-DRF-1 source table: the only placeholders a template may use
export const PLACEHOLDERS = new Set(Object.keys(PLACEHOLDER_SOURCE))

// PRD §5.5a field table
export const CLASS_FIELDS_KNOWN = new Set([
  'amount', 'new_amount', 'currency', 'payment_date', 'value_date', 'payer_name', 'investor', 'third_party_payer', 'reference', 'uetr',
  'document_types', 'entity_type', 'consent_evidence', 'change_type', 'from_payer', 'to_payer', 'confirms', 'deal', 'platform',
  'document_type', 'party_role', 'account_last4', 'change_requested', 'change_fields', 'certificate_type', 'question_type', 'issue_type', 'subtype',
])

// C-RTE-1 default holiday table: England and Wales bank holidays (GOV.UK); deployments replace it with `routing.holidays`
export const ENGLAND_WALES_HOLIDAYS: readonly string[] = [
  '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26', '2025-08-25', '2025-12-25', '2025-12-26',
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
  '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26',
]
