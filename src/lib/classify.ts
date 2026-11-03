// PRD C-CLS-1 to C-CLS-4: the model's output format, rule labels and the adopted labels. Pure functions.
import { z } from 'zod'
import { accountShapes } from './redact.ts'
import { findPhrases, normaliseText } from './text.ts'

export type Confidence = 'high' | 'medium' | 'low'

/** C-CLS-1, schema version 1: 1–4 labels from the configured classes, a reason of at most 200 characters, ISO 639-1. */
export function classificationSchema(classIds: readonly string[]) {
  return z.strictObject({
    labels: z
      .array(z.strictObject({ class: z.enum(classIds as [string, ...string[]]), confidence: z.enum(['high', 'medium', 'low']), reason: z.string().max(200) }))
      .min(1)
      .max(4),
    language: z.string().regex(/^[a-z]{2}$/),
  })
}
export type Classification = z.infer<ReturnType<typeof classificationSchema>>

export interface RuleInput {
  subject: string
  body: string // the body as received, quoted earlier mail included
  bodyHtml: string // the HTML body as text ('' when none): a body like the plain one (CF-F3)
  attachmentTexts: string[]
  esignInvite: boolean // C-EXT-6
  paymentEvidenceParsed: boolean // an attachment where C-EXT-3 parsed `:32A:` or `IntrBkSttlmAmt`
}

const CHANGE = ['change', 'changed', 'new', 'update', 'updated']
const BANK = ['bank', 'account', 'details', 'payment instructions']

/** C-CLS-4 (v0.7.8): labels added whatever the model says. */
export function ruleLabels(i: RuleInput): string[] {
  const out = new Set<string>()
  // account shapes: every text that rule extraction reads (subject, body, attachment texts)
  if ([i.subject, i.body, i.bodyHtml, ...i.attachmentTexts].some((t) => accountShapes(normaliseText(t)).length > 0)) out.add('bank_details')
  // the word rule: the body only (quoted mail included; plain or HTML), not the subject or attachments
  for (const b of [i.body, i.bodyHtml].map(normaliseText)) if (findPhrases(b, CHANGE).length > 0 && findPhrases(b, BANK).length > 0) out.add('bank_details')
  if (i.esignInvite) out.add('legal_documents')
  if (i.paymentEvidenceParsed) out.add('payment_evidence')
  return [...out]
}

export interface Label {
  classId: string
  source: 'model' | 'rule' | 'person'
  confidence: Confidence | 'rule' | 'person'
  adopted: boolean
  reason: string | null
}

/**
 * C-CLS-2: adopted = model high / medium + rule + person labels; none adopted → `unclassified`. Model low labels are
 * kept (not adopted) because risk uses them (C-RSK-1). A model failure (null) adopts only rule and person labels.
 */
export function adoptLabels(model: Classification | null, rules: readonly string[], person: readonly string[] = []): Label[] {
  const out: Label[] = []
  // a class named twice keeps its highest confidence (Codex E2 re-run F7): a low mention never hides a high one
  const RANK = { low: 0, medium: 1, high: 2 } as const
  for (const l of model?.labels ?? []) {
    const seen = out.find((o) => o.source === 'model' && o.classId === l.class)
    if (seen && RANK[l.confidence] <= RANK[seen.confidence as keyof typeof RANK]) continue
    if (seen) out.splice(out.indexOf(seen), 1)
    out.push({ classId: l.class, source: 'model', confidence: l.confidence, adopted: l.confidence !== 'low', reason: l.reason })
  }
  for (const c of new Set(rules)) out.push({ classId: c, source: 'rule', confidence: 'rule', adopted: true, reason: null })
  for (const c of new Set(person)) out.push({ classId: c, source: 'person', confidence: 'person', adopted: true, reason: null })
  if (!out.some((l) => l.adopted)) out.push({ classId: 'unclassified', source: 'rule', confidence: 'rule', adopted: true, reason: null })
  return out
}

/**
 * MN-F4: a placeholder in a reason that the model was not given (a guess, or one from a withheld attachment) would be
 * restored in the review UI; it is replaced by `[?]`.
 */
export function maskUnknownPlaceholders(m: Classification, modelText: string): Classification {
  const fix = (r: string) => r.replace(/\[[A-Z]+_\d+\]/g, (p) => (modelText.includes(p) ? p : '[?]'))
  return { ...m, labels: m.labels.map((l) => ({ ...l, reason: fix(l.reason) })) }
}

/** The adopted class IDs (each once, model order first). */
export const adoptedClasses = (labels: readonly Label[]) => [...new Set(labels.filter((l) => l.adopted).map((l) => l.classId))]
/** C-RSK-1 input: adopted labels plus model low labels. */
export const riskClasses = (labels: readonly Label[]) => [...new Set(labels.map((l) => l.classId))]
