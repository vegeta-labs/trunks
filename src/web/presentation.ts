// Display names only. Persisted IDs, judgement rules and reply text are unchanged.
import { ENUMS, KIND } from '../lib/field-kinds.ts'

const NAMES: Record<string, string> = {
  ops: 'Operations', compliance: 'Compliance', deal_ops: 'Deal operations', legal: 'Legal', ops_lead: 'Operations lead',
  payment_query: 'Payment query', payment_evidence: 'Payment confirmation', unreferenced_payment: 'Unreferenced payment',
  kyc_documents: 'KYC documents', withdrawal: 'Withdrawal', commitment_change: 'Commitment change',
  fee_or_terms_change: 'Fee or terms change', closing_confirmation: 'Closing confirmation', legal_documents: 'Legal documents',
  bank_details: 'Bank details', identity_change: 'Identity change', tax_certificates: 'Tax certificates',
  exit_distribution: 'Exit distribution', bank_letter_request: 'Bank letter request', account_access: 'Account access',
  complaint: 'Complaint', other_known: 'Other known request', unclassified: 'Unclassified',
  party_role: 'Sender role', account_last4: 'Account ending', change_requested: 'Change requested',
  payment_reference: 'Payment reference', payment_date: 'Payment date', investor_id: 'Investor ID',
  payer_name: 'Payer name', reference: 'Payment reference', amount: 'Amount', currency: 'Currency',
  value_date: 'Value date', deal_name: 'Deal name', investor_name: 'Investor name',
  safe_ack: 'Acknowledgement', payment_received: 'Payment received', payment_wait: 'Awaiting payment',
  payment_need_evidence: 'Request payment evidence',
  payment_evidence_received: 'Acknowledge payment confirmation',
  uetr: 'Payment tracking reference (UETR)', new_amount: 'New amount', investor: 'Investor', third_party_payer: 'Third-party payer',
  document_types: 'Document types', entity_type: 'Entity type', consent_evidence: 'Consent evidence', change_type: 'Type of change',
  from_payer: 'From payer', to_payer: 'To payer', confirms: 'Confirms', deal: 'Deal', platform: 'Platform', document_type: 'Document type',
  change_fields: 'Details to change', certificate_type: 'Certificate type', question_type: 'Question type', issue_type: 'Issue type', subtype: 'Subtype',
  notify_old_contact: 'Notify the old contact', payment_need_reference: 'Request a payment reference', unreferenced_ack: 'Acknowledge unreferenced payment',
  kyc_received: 'KYC documents received', withdrawal_ack: 'Acknowledge withdrawal', commitment_change_ack: 'Acknowledge commitment change',
  closing_ack: 'Acknowledge closing', legal_ack: 'Acknowledge legal documents', tax_cert_info: 'Tax certificate information',
  exit_info: 'Exit information', bank_letter_info: 'Bank letter information', account_access_info: 'Account access information', complaint_ack: 'Acknowledge complaint',
}
export const displayName = (id: string) => NAMES[id] ?? id

// TC-REV-18: the edit input matches the field's kind, so a yes/no field sends true / false and a list field sends a
// list; the server's §5.5a checks are unchanged
export type EditInput = { kind: 'boolean' } | { kind: 'list'; options: readonly string[] } | { kind: 'text' }
export const editInput = (field: string): EditInput =>
  KIND[field] === 'boolean' ? { kind: 'boolean' } : KIND[field] === 'enums' ? { kind: 'list', options: ENUMS[field]! } : { kind: 'text' }
const OPTION_NAMES: Record<string, string> = { tax_id: 'Tax ID', ubo_register: 'UBO register' }
export const optionText = (v: string) => OPTION_NAMES[v] ?? (v.charAt(0).toUpperCase() + v.slice(1)).replace(/_/g, ' ')
/** The value an edit sends: `text` is the typed text or the chosen 'true' / 'false'; nothing chosen clears the field. */
export function editValue(input: EditInput, text: string, picked: readonly string[]): string | boolean | string[] | null {
  if (input.kind === 'boolean') return text === 'true' ? true : text === 'false' ? false : null
  if (input.kind === 'list') return picked.length ? input.options.filter((o) => picked.includes(o)) : null
  return text.trim() === '' ? null : text.trim()
}
const STATUS: Record<string, string> = {
  processing: 'Processing', open: 'Open', failed: 'Processing failed', approved: 'Approved — awaiting manual send',
  sent: 'Marked as sent', closed: 'Closed',
}
export const caseStatus = (id: string) => STATUS[id] ?? id
export const SECOND_APPROVER_NOTE = 'The text was changed from the template, so it needs approval from an approver or admin who did not change it.'
export const RISK_NOTE = 'Risk reflects handling requirements and warning signals. High does not by itself mean fraud.'
export const DEMO_DATES = 'Sample received times and deadlines are fixed. Overdue labels do not represent a live backlog.'
const CLAUSE_TEXT: Record<string, string> = {
  'C-RSK-2:display_name_mismatch': 'Display name matches a contact, address does not',
  'C-RSK-2:lookalike_domain': 'Look-alike domain',
  'C-RSK-2:hidden_text': 'Hidden text',
  'C-RSK-2:injection_markers': 'Instruction-like phrases',
  'C-RSK-2:message_id_collision': 'Message-ID seen before with other content',
  'C-RSK-2:first_time_sender_account': 'First mail from this address, with an account number',
  'C-RSK-2:evidence_beneficiary_mismatch': 'The beneficiary account in the payment message is not a receiving account on file',
  'C-RSK-2:uetr_candidate_invalid': 'A UETR-like value that is not valid',
  'C-RSK-2:amount_mismatch': 'Attachment amounts differ from the mail',
  'C-RSK-2:attachment_blocked_or_over_limit': 'An attachment was blocked or over the limit',
  'C-RSK-2a:auth_fail': 'Authentication failed (+1)',
  'C-RSK-2a:untrusted_auth_header': 'Authentication header from an unknown server (+1)',
  'C-RSK-2a:reply_to_mismatch': 'Reply-To differs from From (+1)',
  'C-RSK-2a:pressure': 'Pressure words in a payment or account mail (+1)',
  'C-RSK-2a:closing': 'Planned close within 3 working days (+1)',
}
export const riskReasonText = (clause: string) => CLAUSE_TEXT[clause] ?? clause
const PROBLEM_TEXT: Record<string, string> = { placeholder_left: 'A value is missing', no_recipient: 'No recipient', recipient_not_allowed: 'This recipient is not allowed' }
const internalTerms = (terms: string) => `Internal wording not allowed in a reply: ${terms.split('|').join(', ')}`
export const problemText = (p: string) => (p.startsWith('internal_terms:') ? internalTerms(p.slice(15)) : (PROBLEM_TEXT[p] ?? p))
/** A refusal from the server may list problem codes (TC-REV-15); the codes stay in the server's answer and the audit. */
export const plainProblems = (text: string) =>
  text.replace(/internal_terms:([^;]*)|\b(?:placeholder_left|no_recipient|recipient_not_allowed)\b/g, (code: string, terms?: string) => (terms === undefined ? PROBLEM_TEXT[code]! : internalTerms(terms))) // one pass: a term that spells a code stays as written
export type Transfer = { state: string; error: string | null; removed: boolean }
export function transferText(t: Transfer, demo: boolean): string {
  if (t.state === 'discarded') return `Blocked by the virus scan; handled manually${t.removed ? '; removed from this system' : ''}`
  if (t.state === 'failed') return t.error === 'infected' ? 'Blocked by the virus scan; not transferred' : `Transfer failed (${t.error ?? 'error'})`
  if (t.removed) return 'Transferred; removed from this system'
  if (t.state === 'delivered') return demo ? 'Recorded transfer: completed' : 'Transferred; removal pending'
  return t.state === 'pending' ? 'Transfer pending' : `Transfer state: ${t.state}`
}
