// Display names only. Persisted IDs, judgement rules and reply text are unchanged.
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
}
export const displayName = (id: string) => NAMES[id] ?? id
const STATUS: Record<string, string> = {
  processing: 'Processing', open: 'Open', failed: 'Processing failed', approved: 'Approved — awaiting manual send',
  sent: 'Marked as sent', closed: 'Closed',
}
export const caseStatus = (id: string) => STATUS[id] ?? id
export const RISK_NOTE = 'Risk reflects handling requirements and warning signals. High does not by itself mean fraud.'
export const DEMO_DATES = 'Sample received times and deadlines are fixed. Overdue labels do not represent a live backlog.'
export type Transfer = { state: string; error: string | null; removed: boolean }
export function transferText(t: Transfer, demo: boolean): string {
  if (t.state === 'discarded') return `Blocked by the virus scan; handled manually${t.removed ? '; removed from this system' : ''}`
  if (t.state === 'failed') return t.error === 'infected' ? 'Blocked by the virus scan; not transferred' : `Transfer failed (${t.error ?? 'error'})`
  if (t.removed) return 'Transferred; removed from this system'
  if (t.state === 'delivered') return demo ? 'Recorded transfer: completed' : 'Transferred; removal pending'
  return t.state === 'pending' ? 'Transfer pending' : `Transfer state: ${t.state}`
}
