// PRD C-FLD-0 to C-FLD-2, §5.5a: the model's field output (schema version 2), code validation, and the merge with
// rule extraction (rules win; several different values → "multiple"). Pure functions.
import { z } from 'zod'
import { extractAmounts } from './amounts.ts'
import { extractDates } from './dates.ts'
import { extractUetrs } from './uetr.ts'
import { findReferences } from './references.ts'
import { normaliseText } from './text.ts'

/** PRD §3.1 «主要字段» of the default catalogue; a configured class may list its own. */
export const DEFAULT_CLASS_FIELDS: Record<string, string[]> = {
  payment_query: ['amount', 'currency', 'payment_date', 'payer_name', 'reference', 'uetr'],
  payment_evidence: ['uetr', 'amount', 'currency', 'value_date', 'payer_name', 'reference'],
  unreferenced_payment: ['amount', 'currency', 'payment_date', 'payer_name', 'third_party_payer'],
  kyc_documents: ['document_types', 'entity_type'],
  withdrawal: ['investor', 'consent_evidence'],
  commitment_change: ['new_amount', 'currency'],
  fee_or_terms_change: ['change_type', 'from_payer', 'to_payer', 'consent_evidence'],
  closing_confirmation: ['confirms', 'deal'],
  legal_documents: ['platform', 'document_type', 'deal'],
  bank_details: ['party_role', 'account_last4', 'change_requested'],
  identity_change: ['change_fields'],
  tax_certificates: ['certificate_type', 'deal'],
  exit_distribution: ['deal', 'question_type'],
  bank_letter_request: ['deal'],
  account_access: ['issue_type'],
  complaint: [],
  other_known: ['subtype'],
  unclassified: [],
}

type Kind = 'money' | 'currency' | 'date' | 'text' | 'reference' | 'uetr' | 'deal' | 'enum' | 'enums' | 'boolean' | 'platform' | 'last4'
const ENUMS: Record<string, readonly string[]> = {
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

/** The fields of the adopted classes, in catalogue order. */
export function fieldsFor(classes: readonly string[], configured: Record<string, readonly string[] | undefined> = {}): string[] {
  const out: string[] = []
  for (const c of classes) for (const f of configured[c] ?? DEFAULT_CLASS_FIELDS[c] ?? []) if (!out.includes(f)) out.push(f)
  return out
}

/** Fields the model is asked for: everything but `account_last4`, which comes only from rule extraction (§5.5a). */
export const modelFields = (fields: readonly string[]) => fields.filter((f) => KIND[f] !== 'last4')

// lenient on purpose: one bad value voids that field (C-FLD-1), not the whole reply
const Scalar = z.union([z.string(), z.boolean(), z.array(z.string()), z.null()])
const Candidates = z.strictObject({ candidates: z.array(z.strictObject({ value: Scalar, quote: z.string().max(200) })).min(2) })
const FieldOut = z.strictObject({ value: z.union([Scalar, Candidates]), confidence: z.enum(['high', 'medium', 'low']), quote: z.string().max(200) })

/** C-FLD-0 schema version 2 for the given fields. */
export function fieldSchema(fields: readonly string[]) {
  return z.strictObject({ fields: z.strictObject(Object.fromEntries(fields.map((f) => [f, FieldOut.optional()]))) })
}
export type FieldOutput = { fields: Record<string, z.infer<typeof FieldOut> | undefined> }

export type Money = { minor: number; currency: string }
export type Value = string | boolean | string[] | Money

export interface FieldResult {
  field: string
  status: 'ok' | 'void' | 'multiple' | 'conflict'
  value: Value | null // ok / conflict: the adopted value; null when empty, void, multiple or invalid
  candidates: Value[] // multiple: the distinct values of both sides
  invalid: boolean // C-FLD-1 failed: the field is void and shown yellow (v0.7.9)
  confidence: 'high' | 'medium' | 'low' | 'rule' | null
  source: 'model' | 'rule' | 'merged'
  quotes: string[] // where the model value comes from (provenance)
  reason: string | null // why void / invalid / conflict
  needsConfirmation: boolean // C-FLD-2
}

export interface RuleValues {
  uetrs: string[] // valid UETRs found by C-EXT-1
  amounts: Money[] // C-EXT-3 amount tokens
  evidenceAmounts: Money[] // the subset parsed from MT103 `:32A:` / pacs.008 (amounts written there without a currency mark)
  references: string[] // C-EXT-2 matched references, as imported
  accountLast4: string[] // C-EXT-4 valid accounts
  valueDates: string[] // payment-evidence value dates
}

export interface FieldContext {
  modelText: string // exactly what the model was given (quotes must appear in it)
  currencies: readonly string[]
  platforms: readonly string[] // configured e-sign platform names
  deals: ReadonlyArray<{ id: string; name: string }>
  restore: (s: string) => string // NAME / EMAIL / PHONE / ADDRESS placeholders → original, in memory only (C-RED-2)
  rules: RuleValues
}

// PRD §6 comparison: money by minor units and currency, text NFKC + lower case + collapsed white space, arrays as sets
export function sameKey(v: Value): string {
  if (typeof v === 'string') return `s:${v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}`
  if (typeof v === 'boolean') return `b:${v}`
  if (Array.isArray(v)) return `a:${[...new Set(v)].sort().join('|')}`
  return `m:${v.minor}:${v.currency}`
}
const distinct = (vs: Value[]) => {
  const seen = new Map<string, Value>()
  for (const v of vs) if (!seen.has(sameKey(v))) seen.set(sameKey(v), v)
  return [...seen.values()]
}

const ws = (s: string) => s.replace(/\s+/g, ' ').trim()
const SECRET_PLACEHOLDER = /\[(ACCOUNT|SORTCODE|ID|DOB)_\d+\]/

type Checked = { ok: true; value: Value } | { ok: false; void: boolean; reason: string }

/** C-FLD-1 for one raw model value. `void` = the value can never be right (C-RED-2, reference, deal); otherwise invalid. */
export function checkValue(field: string, raw: string | boolean | string[], ctx: FieldContext): Checked {
  const kind = KIND[field]
  if (kind === undefined) return { ok: false, void: true, reason: 'unknown field' }
  // account / ID placeholders (C-RED-2) are checked for the whole field before this, in resolveField
  const str = (k: (s: string) => Checked): Checked => (typeof raw === 'string' ? k(raw) : { ok: false, void: false, reason: 'not a string' })
  switch (kind) {
    case 'money':
      return str((s) => {
        const hits = extractAmounts(normaliseText(s), ctx.currencies)
        if (hits.length === 1) return { ok: true, value: { minor: hits[0]!.minor, currency: hits[0]!.currency } }
        // a pick written as MT103 `:32A:` or pacs.008 write it (`6000,00`, `6000.00`): only when it equals by value
        // exactly one amount parsed from such a record; any other comma-decimal or currency-less value fails (C-FLD-2, CF-F5)
        const m = /^\s*([A-Z]{3})?\s*(\d+)(?:[.,](\d{1,2}))?\s*([A-Z]{3})?\s*$/.exec(normaliseText(s).toUpperCase())
        if (m) {
          const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
          const ccy = m[1] ?? m[4] ?? null
          const same = ctx.rules.evidenceAmounts.filter((a) => a.minor === minor && (ccy === null || a.currency === ccy))
          if (new Set(same.map((a) => a.currency)).size === 1) return { ok: true, value: { minor, currency: same[0]!.currency } }
        }
        return { ok: false, void: false, reason: 'not one amount with a currency (I-01)' }
      })
    case 'currency':
      return str((s) => (ctx.currencies.includes(s.trim().toUpperCase()) ? { ok: true, value: s.trim().toUpperCase() } : { ok: false, void: false, reason: 'not a configured currency' }))
    case 'date':
      return str((s) => {
        // a value date written as MT103 `:32A:` writes it (YYMMDD): only when it is one parsed from such a record, like
        // the as-written amounts (owner acceptance: a correct date was shown yellow as "not a date")
        const yymmdd = /^\s*(\d{2})(\d{2})(\d{2})\s*$/.exec(s)
        if (field === 'value_date' && yymmdd) {
          const iso = `20${yymmdd[1]}-${yymmdd[2]}-${yymmdd[3]}`
          if (ctx.rules.valueDates.includes(iso)) return { ok: true, value: iso }
        }
        const hits = extractDates(normaliseText(s))
        return hits.length === 1 && hits[0]!.iso ? { ok: true, value: hits[0]!.iso } : { ok: false, void: false, reason: hits[0]?.status === 'ambiguous' ? 'ambiguous date' : 'not a date (C-EXT-5)' }
      })
    case 'uetr':
      return str((s) => {
        const r = extractUetrs(normaliseText(s))
        return r.uetrs.length === 1 && r.invalid.length === 0 ? { ok: true, value: r.uetrs[0]! } : { ok: false, void: false, reason: 'not a valid UETR (C-EXT-1)' }
      })
    case 'reference':
      return str((s) => {
        // C-EXT-2 inside the value: `NW-008 FERNANDEZ`, `/ROC/NW-013` name the matched reference NW-008, NW-013
        const refs = [...new Set(findReferences(normaliseText(s), ctx.rules.references).map((h) => h.value))]
        return refs.length === 1 ? { ok: true, value: refs[0]! } : { ok: false, void: true, reason: refs.length ? 'several matched references in one value' : 'not a matched reference (C-EXT-2)' }
      })
    case 'deal':
      return str((s) => {
        const name = ws(ctx.restore(s)).toLowerCase()
        const d = ctx.deals.find((x) => ws(x.name).toLowerCase() === name)
        // the field keeps the deal ID: the restored name is never stored (C-RED-2, TC-FLD-08)
        return d ? { ok: true, value: d.id } : { ok: false, void: true, reason: 'not a deal in the directory' }
      })
    case 'platform':
      return str((s) => {
        const p = ctx.platforms.find((x) => x.toLowerCase() === s.trim().toLowerCase())
        return p ? { ok: true, value: p } : { ok: false, void: false, reason: 'not a configured e-sign platform' }
      })
    case 'enum':
      return str((s) => (ENUMS[field]!.includes(s) ? { ok: true, value: s } : { ok: false, void: false, reason: `not one of ${ENUMS[field]!.join(', ')}` }))
    case 'enums':
      return Array.isArray(raw) && raw.every((x) => ENUMS[field]!.includes(x)) ? { ok: true, value: [...new Set(raw)] } : { ok: false, void: false, reason: 'a value outside the list' }
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, void: false, reason: 'not true / false' }
    case 'text':
      return str((s) => (s.trim() === '' ? { ok: false, void: false, reason: 'empty' } : { ok: true, value: s.trim() }))
    case 'last4':
      return { ok: false, void: true, reason: 'account_last4 comes only from rule extraction' }
  }
}

// C-FLD-0 (v0.7.16): verbatim apart from white space; an empty or white-space-only quote proves nothing (Codex E2 re-run F4)
const quoted = (q: string, ctx: FieldContext) => ws(q) !== '' && ws(ctx.modelText).includes(ws(q))
// every placeholder in a value must be one the model was given: a guessed `[NAME_7]` from a withheld attachment would
// be restored in the review UI (MN-F4)
const PLACEHOLDER = /\[[A-Z]+_\d+\]/g
const knownPlaceholders = (v: string | boolean | string[], ctx: FieldContext) =>
  (typeof v === 'boolean' ? [] : typeof v === 'string' ? [v] : v).every((x) => [...x.matchAll(PLACEHOLDER)].every((p) => ctx.modelText.includes(p[0])))

const empty = (field: string): FieldResult => ({ field, status: 'ok', value: null, candidates: [], invalid: false, confidence: null, source: 'model', quotes: [], reason: null, needsConfirmation: false })

/** One field: the model's value checked (C-FLD-0, C-FLD-1), then merged with rule extraction (rules win). */
const ruleSide = (field: string, ctx: FieldContext): Value[] =>
  field === 'uetr' ? ctx.rules.uetrs
    : field === 'reference' ? ctx.rules.references
      : field === 'account_last4' ? ctx.rules.accountLast4
        : field === 'value_date' ? ctx.rules.valueDates
          : []

export function resolveField(field: string, out: FieldOutput['fields'][string], ctx: FieldContext): FieldResult {
  const r = empty(field)
  // the rules decide these fields whatever the model wrote (C-FLD-1): a bad model value only loses
  const ruleFilled = distinct(ruleSide(field, ctx)).length > 0
  // ---- the model side
  const model: Value[] = []
  let voided = false // a value that can never be right (quote, placeholder, C-RED-2, reference, deal)
  if (out && out.value !== null) {
    r.confidence = out.confidence
    const items = typeof out.value === 'object' && !Array.isArray(out.value) && 'candidates' in out.value ? out.value.candidates : [{ value: out.value as string | boolean | string[], quote: out.quote }]
    // C-RED-2: an account or ID placeholder in any value or candidate voids the field, not just that candidate (S2);
    // where rule extraction fills the field, the rule value stands and the model side is dropped
    if (items.some((it) => it.value !== null && typeof it.value !== 'boolean' && (Array.isArray(it.value) ? it.value : [it.value]).some((x) => SECRET_PLACEHOLDER.test(x)))) {
      const reason = 'account or ID placeholder in a value'
      if (!ruleFilled) return { ...r, status: 'void', reason, needsConfirmation: true } // void is yellow (C-FLD-2, F8)
      // the rule value stands, but the rejection stays visible and yellow, as for any voided candidate (C-FLD-2, F17;
      // Codex E2 round 4 F22)
      return { ...resolveField(field, undefined, ctx), reason, needsConfirmation: true }
    }
    for (const it of items) {
      if (it.value === null) continue
      // a quote that is not in the model's input voids the value (TC-FLD-04)
      if (!quoted(it.quote, ctx)) {
        r.reason = 'quote not in the text given to the model'
        voided = true
        continue
      }
      if (!knownPlaceholders(it.value, ctx)) {
        r.reason = 'a placeholder that is not in the text given to the model'
        voided = true
        continue
      }
      const c = checkValue(field, it.value, ctx)
      if (c.ok) {
        model.push(c.value)
        r.quotes.push(it.quote)
      } else if (c.void) {
        r.reason = c.reason
        voided = true
      } else {
        r.invalid = true
        r.reason = c.reason
      }
    }
  }
  const modelD = distinct(model)
  // a model value that failed C-FLD-1 and left nothing valid: the field is void and needs a person (v0.7.9)
  if (r.invalid && modelD.length === 0 && !ruleFilled) return { ...r, status: 'void', needsConfirmation: true }
  // nothing valid left after voiding — one value or every candidate (MN-F3): the field is void, the reason shown
  if (voided && modelD.length === 0 && !ruleFilled) return { ...r, status: 'void', needsConfirmation: true } // void is yellow (C-FLD-2, F8)
  // a candidate that failed a check — invalid or voided — keeps whatever survives yellow (C-FLD-2, round 2 F13, round 3 F17)
  const failed = r.invalid || voided
  // ---- amounts (v0.7.9): the model picks; every amount token of the mail only checks the pick
  if (KIND[field] === 'money') return resolveAmount(r, modelD, distinct(ctx.rules.amounts), failed)
  // ---- the rule side
  const rule = ruleSide(field, ctx)
  const ruleD = distinct(rule)
  if (ruleD.length === 0) {
    if (modelD.length >= 2) return { ...r, status: 'multiple', candidates: modelD, needsConfirmation: true }
    const v = modelD[0] ?? null
    return { ...r, value: v, needsConfirmation: failed || (v !== null && r.confidence === 'low') }
  }
  // any side with several different values → multiple, the candidates of both sides (C-FLD-0)
  const all = distinct([...ruleD, ...modelD])
  if (ruleD.length >= 2 || modelD.length >= 2) return { ...r, status: 'multiple', candidates: all, source: modelD.length ? 'merged' : 'rule', confidence: modelD.length ? r.confidence : 'rule', needsConfirmation: true }
  const rv = ruleD[0]!
  // C-FLD-1 names UETR (and amount, handled above): an invalid model UETR differs from the rule one too → conflict, the
  // rule value kept (S3). A value date written as MT103 writes it is the same date, not a disagreement.
  if (KIND[field] === 'uetr' && modelD.length === 0 && r.invalid) return { ...r, status: 'conflict', value: rv, source: 'merged', needsConfirmation: true }
  if (modelD.length === 1 && sameKey(modelD[0]!) !== sameKey(rv)) {
    // the rule value wins; the field is marked conflict (C-FLD-1, TC-FLD-01)
    return { ...r, status: 'conflict', value: rv, source: 'merged', reason: 'model value differs from rule extraction', needsConfirmation: true }
  }
  // a low-confidence model value is yellow even when the rules agree (C-FLD-2, CF-F6)
  return { ...r, value: rv, source: modelD.length ? 'merged' : 'rule', confidence: modelD.length ? r.confidence : 'rule', needsConfirmation: failed || (modelD.length > 0 && r.confidence === 'low') }
}

function resolveAmount(r: FieldResult, model: Value[], rule: Value[], failed: boolean): FieldResult {
  // several picks: each must be an amount of the mail too (v0.7.9, Codex E2 re-run F6); the rest is a conflict
  if (model.length >= 2) {
    const inMail = model.filter((m) => rule.some((x) => sameKey(x) === sameKey(m)))
    if (inMail.length === model.length) return { ...r, status: 'multiple', candidates: model, needsConfirmation: true }
    // any pick that is not an amount of the mail: conflict, with the v0.7.9 fall-back value (round 2 F12)
    return { ...r, status: 'conflict', value: rule.length === 1 ? rule[0]! : null, source: 'merged', reason: 'a model amount is not an amount in the mail', needsConfirmation: true }
  }
  const m = model[0]
  if (m === undefined) {
    if (rule.length === 1) return { ...r, value: rule[0]!, source: 'rule', confidence: 'rule', needsConfirmation: failed }
    return { ...r, needsConfirmation: rule.length > 1 }
  }
  // the pick must equal an amount token of the mail; a mail without any (`£15k` only) cannot confirm it (MN-F2)
  // a failed candidate beside the surviving one keeps the field yellow (C-FLD-2, round 2 F13, round 3 F17)
  if (rule.some((x) => sameKey(x) === sameKey(m))) return { ...r, value: m, source: rule.length ? 'merged' : 'model', needsConfirmation: failed || r.confidence === 'low' }
  // the pick is not an amount of the mail: conflict; the rule value only when there is exactly one
  return { ...r, status: 'conflict', value: rule.length === 1 ? rule[0]! : null, source: 'merged', reason: 'model amount is not an amount in the mail', needsConfirmation: true }
}

/** Every field of the adopted classes; `currency` follows a single resolved amount when the model gave none. */
export function resolveFields(fields: readonly string[], out: FieldOutput | null, ctx: FieldContext): FieldResult[] {
  const res = fields.map((f) => resolveField(f, out?.fields[f], ctx))
  const amount = res.find((x) => x.field === 'amount')
  const currency = res.find((x) => x.field === 'currency')
  if (currency && currency.value === null && currency.status === 'ok' && amount?.value && typeof amount.value === 'object' && !Array.isArray(amount.value)) {
    Object.assign(currency, { value: amount.value.currency, source: 'rule', confidence: 'rule', needsConfirmation: false })
  }
  return res
}
