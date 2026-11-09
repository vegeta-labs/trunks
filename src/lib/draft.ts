// PRD C-DRF-0 to C-DRF-7, C-FRD-3: which reply template, its values, and the checks before approval. Templates are
// chosen by code only (decisions 4, 4a); no model is involved anywhere here.
import { matchedPhrases } from './text.ts'
import { normAddress } from './signals.ts'
import { workingDaysAfter } from './workdays.ts'
import type { ClassFloor, Level } from './risk.ts'
import type { LedgerState } from './link.ts'

// C-DRF-1 source table: the only placeholders, and where each value comes from
export type PlaceholderSource = 'directory' | 'ledger' | 'confirmed_field' | 'system'
export const PLACEHOLDER_SOURCE: Readonly<Record<string, PlaceholderSource>> = {
  contact_name: 'directory', investor_name: 'directory', deal_name: 'directory', reference: 'directory', cash_due: 'directory', currency: 'directory',
  received_amount: 'ledger', outstanding_amount: 'ledger',
  amount: 'confirmed_field', payment_date: 'confirmed_field', value_date: 'confirmed_field', uetr: 'confirmed_field',
  deployment_name: 'system', case_number: 'system',
}

// C-FRD-3 internal terms: fixed, the configuration can add, never remove
export const INTERNAL_TERMS: readonly string[] = [
  'fraud', 'fraudulent', 'suspicious', 'suspect', 'scam', 'risk level', 'high risk', 'flagged', 'flag', 'verification task', 'cooling-off', 'cooling off',
  'two-person', 'signal', 'lookalike', 'spoof', 'spoofed', 'injection', 'money laundering', 'sar', 'tipping off',
]

export const SAFE_ACK = 'safe_ack'
export const NOTIFY_OLD_CONTACT = 'notify_old_contact'
const FIXED_BODY = new Set([SAFE_ACK, NOTIFY_OLD_CONTACT]) // C-DRF-7: their text cannot be edited

// C-DRF-5
export const DEFAULT_TEMPLATE: Readonly<Record<string, string>> = {
  unreferenced_payment: 'unreferenced_ack', kyc_documents: 'kyc_received', withdrawal: 'withdrawal_ack', commitment_change: 'commitment_change_ack',
  fee_or_terms_change: SAFE_ACK, closing_confirmation: 'closing_ack', legal_documents: 'legal_ack', bank_details: SAFE_ACK, identity_change: SAFE_ACK,
  tax_certificates: 'tax_cert_info', exit_distribution: 'exit_info', bank_letter_request: 'bank_letter_info', account_access: 'account_access_info',
  complaint: 'complaint_ack', other_known: SAFE_ACK,
}
export const PAYMENT_CLASSES = ['payment_query', 'payment_evidence']
export const PAYMENT_TEMPLATES = ['payment_need_reference', 'payment_received', 'payment_wait', 'payment_need_evidence']
export const EVIDENCE_RECEIVED = 'payment_evidence_received' // C-DRF-4 v0.7.28; optional, so a deployment's own template set still loads
// C-DRF-5 lists; the loader also marks any template that uses a directory or ledger placeholder (C-DRF-1)
export const DISCLOSES_RECORD = ['payment_received', 'payment_wait', 'payment_need_evidence', EVIDENCE_RECEIVED, 'exit_info', 'withdrawal_ack', 'commitment_change_ack']
export const ASSERTS_RECEIPT = ['payment_received']
const DRF5_TEMPLATES = new Set([SAFE_ACK, ...PAYMENT_TEMPLATES, EVIDENCE_RECEIVED, ...Object.values(DEFAULT_TEMPLATE)])
/** Template ids the configuration must provide. */
export const REQUIRED_TEMPLATES = [...new Set([SAFE_ACK, NOTIFY_OLD_CONTACT, ...PAYMENT_TEMPLATES, ...Object.values(DEFAULT_TEMPLATE)])]

export interface TemplateDef {
  id: string
  subject: string
  body: string
  discloses_record?: boolean
  asserts_receipt?: boolean
}
export interface TemplateMeta {
  id: string
  discloses: boolean
  asserts: boolean // asserts_receipt (C-DRF-1, C-DRF-5)
  placeholders: string[]
}

export const placeholdersOf = (text: string) => [...new Set([...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!))]

/** C-DRF-1 checks on one template; problems as messages (the loader adds the file and line). */
export function checkTemplate(t: TemplateDef, extraInternal: readonly string[] = []): { meta: TemplateMeta; problems: string[] } {
  const placeholders = placeholdersOf(`${t.subject}\n${t.body}`)
  const problems: string[] = []
  const sources = placeholders.map((p) => PLACEHOLDER_SOURCE[p])
  for (const p of placeholders) if (!PLACEHOLDER_SOURCE[p]) problems.push(`unknown placeholder {${p}}`)
  if (t.id === SAFE_ACK) for (const p of placeholders) if (PLACEHOLDER_SOURCE[p] !== 'system') problems.push(`safe_ack may only use system placeholders, not {${p}}`)
  if (t.id === NOTIFY_OLD_CONTACT) for (const p of placeholders) if (PLACEHOLDER_SOURCE[p] !== 'system' && p !== 'contact_name') problems.push(`notify_old_contact may only use system placeholders and {contact_name}, not {${p}}`)
  const asserts = t.asserts_receipt === true || ASSERTS_RECEIPT.includes(t.id)
  // the deployment's own name may sign it off (C-DRF-1 v0.7.25): a fixed configuration value, not from the email
  if (asserts) for (const p of placeholders) if (!['directory', 'ledger'].includes(PLACEHOLDER_SOURCE[p] ?? '') && p !== 'deployment_name') problems.push(`${t.id} asserts receipt and may only use directory or ledger placeholders and {deployment_name}, not {${p}}`)
  const terms = [...matchedPhrases(t.subject, [...INTERNAL_TERMS, ...extraInternal]), ...matchedPhrases(t.body, [...INTERNAL_TERMS, ...extraInternal])]
  if (terms.length) problems.push(`internal terms in the template text: ${[...new Set(terms)].join(', ')}`)
  // notify_old_contact goes to the contact's own address on file and may name them; it is not a Case reply (C-FRD-4)
  // asserting receipt also tells record data: it counts as disclosing (C-DRF-7 v0.7.15)
  const discloses = t.id !== NOTIFY_OLD_CONTACT && (asserts || t.discloses_record === true || DISCLOSES_RECORD.includes(t.id) || sources.some((s) => s === 'directory' || s === 'ledger'))
  if (t.id === SAFE_ACK && t.discloses_record === true) problems.push('safe_ack cannot disclose directory data')
  // the fall-back replies never claim receipt: they are chosen without the ledger or disclosure gates (Codex E3 F3)
  if ((t.id === SAFE_ACK || t.id === NOTIFY_OLD_CONTACT) && t.asserts_receipt === true) problems.push(`${t.id} cannot assert receipt`)
  return { meta: { id: t.id, discloses, asserts, placeholders }, problems }
}

// ---------- C-DRF-4: the payment date ----------

export type FieldValue = string | null | { multiple: unknown[] } | { void: string }
const single = (v: FieldValue | undefined): string | null => (typeof v === 'string' ? v : null)
const present = (v: FieldValue | undefined) => v !== null && v !== undefined

/** The payment date for C-DRF-4: `unknown` (no usable date) or `invalid` (after the receipt date) count as not valid. */
export function paymentDate(i: { primary: string; evidenceValueDates: readonly string[]; valueDate?: FieldValue; paymentDate?: FieldValue; receivedDate: string }): { date: string | null; status: 'ok' | 'unknown' | 'invalid' } {
  let date: string | null
  const ev = [...new Set(i.evidenceValueDates)]
  if (ev.length > 1) return { date: null, status: 'unknown' }
  if (ev.length === 1) date = ev[0]!
  else {
    if (present(i.valueDate) && present(i.paymentDate) && JSON.stringify(i.valueDate) !== JSON.stringify(i.paymentDate)) return { date: null, status: 'unknown' }
    // the main class's own field; the other one when only that one has a value (both with different values: unknown above)
    const [own, other] = i.primary === 'payment_evidence' ? [i.valueDate, i.paymentDate] : [i.paymentDate, i.valueDate]
    date = present(own) ? single(own) : single(other)
  }
  if (date === null) return { date: null, status: 'unknown' }
  return date > i.receivedDate ? { date, status: 'invalid' } : { date, status: 'ok' }
}

// ---------- C-DRF-3: the Case reply template ----------

export interface SelectInput {
  classes: readonly ClassFloor[]
  adopted: readonly string[]
  risk: Level
  linkedCommitment: boolean
  ledger: LedgerState | null // null: no commitment linked
  payment: { date: string | null; status: 'ok' | 'unknown' | 'invalid' } | null
  receivedDate: string
  holidays: ReadonlySet<string>
  evidenceSupportsTracing?: boolean // C-DRF-4 v0.7.28
  mayDisclose: boolean
  templates: ReadonlyMap<string, TemplateMeta>
}
export interface Selection {
  template: string | null
  primary: string | null
  step: '1' | '2' | '3' | '4' | '5' // the C-DRF-3 step that decided
}

const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 }

/** C-DRF-3 ④ main class: the highest floor among the adopted labels, ties by the class table order. */
export function primaryClass(classes: readonly ClassFloor[], adopted: readonly string[]): string | null {
  const known = classes.filter((c) => adopted.includes(c.id) && c.id !== 'unclassified')
  return known.reduce<ClassFloor | null>((best, c) => (best === null || RANK[c.risk_floor] > RANK[best.risk_floor] ? c : best), null)?.id ?? null
}

/** C-DRF-4 */
export function paymentTemplate(i: Pick<SelectInput, 'linkedCommitment' | 'ledger' | 'payment' | 'receivedDate' | 'holidays' | 'evidenceSupportsTracing' | 'templates'>): string {
  if (!i.linkedCommitment) return 'payment_need_reference'
  if (i.ledger === 'received') return 'payment_received'
  const p = i.payment
  if (i.ledger === 'not_received' && p && p.status === 'ok' && workingDaysAfter({ holidays: i.holidays }, p.date!, i.receivedDate) < 5) return 'payment_wait'
  // C-DRF-4 v0.7.28: do not ask again for a confirmation already attached; only a message that passes every check counts
  return i.evidenceSupportsTracing === true && i.templates.has(EVIDENCE_RECEIVED) ? EVIDENCE_RECEIVED : 'payment_need_evidence'
}

export function selectTemplate(i: SelectInput): Selection {
  if (i.adopted.includes('bank_details') || i.adopted.includes('identity_change')) return { template: SAFE_ACK, primary: null, step: '1' }
  if (i.risk === 'high') return { template: SAFE_ACK, primary: null, step: '2' }
  const primary = primaryClass(i.classes, i.adopted)
  if (primary === null) return { template: null, primary: null, step: '3' } // only unclassified
  const chosen = PAYMENT_CLASSES.includes(primary) ? paymentTemplate(i) : DEFAULT_TEMPLATE[primary] ?? SAFE_ACK
  if (i.templates.get(chosen)?.discloses && !i.mayDisclose) return { template: SAFE_ACK, primary, step: '5' }
  // a template that asserts receipt only when the snapshot ledger shows it received in full (C-DRF-7 v0.7.15)
  if (i.templates.get(chosen)?.asserts && i.ledger !== 'received') return { template: SAFE_ACK, primary, step: '5' }
  return { template: chosen, primary, step: '4' }
}

// ---------- C-DRF-7: a person choosing another template ----------

export function allowedManualTemplates(i: SelectInput): string[] {
  const auto = selectTemplate(i)
  if (auto.step === '1' || auto.step === '2') return []
  const ok = (id: string) => {
    const m = i.templates.get(id)
    if (!m || id === NOTIFY_OLD_CONTACT) return false
    if (m.discloses && !i.mayDisclose) return false
    if ((m.asserts || id === 'payment_received') && i.ledger !== 'received') return false
    return true
  }
  const ofClasses = i.adopted.flatMap((c) => (PAYMENT_CLASSES.includes(c) ? (paymentTemplate(i) === EVIDENCE_RECEIVED ? [EVIDENCE_RECEIVED, 'payment_need_evidence'] : [paymentTemplate(i)]) : DEFAULT_TEMPLATE[c] ? [DEFAULT_TEMPLATE[c]!] : []))
  // only the C-DRF-5 templates without discloses_record, not anything else a deployment configured (C-DRF-7)
  const generic = [...i.templates.values()].filter((m) => DRF5_TEMPLATES.has(m.id) && !m.discloses).map((m) => m.id)
  return [...new Set([...ofClasses, ...generic])].filter(ok)
}

export const bodyEditable = (templateId: string) => !FIXED_BODY.has(templateId)

// ---------- C-DRF-2 ③: filling values ----------

/** Fill placeholders; a sentence holding a placeholder without a value is removed whole. Sentences end at . ! ? or a line end. */
export function fill(text: string, values: Readonly<Record<string, string | null>>): { text: string; removed: number } {
  let removed = 0
  const out = text
    .split(/(\n)/)
    .map((line) => {
      if (line === '\n') return line
      // a sentence ends at . ! ? followed by whitespace or the line end; `pacs.008` or `e.g.x` do not end one
      const sentences: string[] = []
      let start = 0
      for (const m of line.matchAll(/[.!?]+(?=\s|$)\s*/g)) {
        sentences.push(line.slice(start, m.index + m[0].length))
        start = m.index + m[0].length
      }
      if (start < line.length) sentences.push(line.slice(start))
      if (sentences.join('') !== line) throw new Error('sentence split lost text') // never drop text silently
      const kept = sentences
        .filter((s) => {
          const missing = placeholdersOf(s).some((p) => values[p] === null || values[p] === undefined)
          if (missing) removed++
          return !missing
        })
        .map((s) => s.replace(/\{([a-z_]+)\}/g, (_, p: string) => values[p]!))
        .join('')
        .replace(/[ \t]+$/, '')
      return kept === '' && line !== '' ? null : kept // a line emptied by a removal goes with its line break
    })
    .flatMap((x, n, all) => (x === null ? [] : x === '\n' && n > 0 && all[n - 1] === null ? [] : [x]))
    .join('')
  return { text: out, removed }
}

// ---------- C-DRF-2 ②, C-FRD-3 ----------

export const internalTermsIn = (text: string, extra: readonly string[] = []) => matchedPhrases(text, [...INTERNAL_TERMS, ...extra])

// ---------- C-DRF-2 ④: recipients ----------

export function allowedCaseRecipients(from: string | null, replyTo: readonly string[], replyToMismatch: boolean): string[] {
  const list = [...(from ? [from] : []), ...(replyToMismatch ? [] : replyTo)]
  return [...new Set(list.map(normAddress))]
}

export const recipientAllowed = (proposed: string, allowed: readonly string[]) => allowed.includes(normAddress(proposed))

// ---------- values ----------

const GROUP = /\B(?=(\d{3})+(?!\d))/g
/** Money in a reply: currency code, thousands commas, two decimals (I-01). */
export const formatMoney = (minor: number, currency: string) => `${currency} ${String(Math.trunc(minor / 100)).replace(GROUP, ',')}.${String(minor % 100).padStart(2, '0')}`
