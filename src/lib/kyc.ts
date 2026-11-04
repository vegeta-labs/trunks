// PRD C-RED-0 (v0.7.8): which attachments may be KYC documents. Decided by code before any model call; the content
// of such an attachment never goes to any model, only its (redacted) file name and type.
import { findPhrases, normaliseText } from './text.ts'
import type { ImageFacts } from './image-header.ts'

export const INLINE_DEFAULTS = { max_long_side: 400, max_short_side: 150, max_bytes: 51200 }
export interface InlineLimits { max_long_side: number; max_short_side: number; max_bytes: number }

const WORDS = [
  'passport', 'driving', 'licence', 'license', 'utility', 'bank statement', 'proof of address', 'poa', 'id card', 'identity',
  'certificate of incorporation', 'trust deed', 'register of members', 'ubo', 'structure chart',
  // v0.7.8: German, French, Spanish
  'reisepass', 'personalausweis', 'führerschein', 'kontoauszug', 'passeport', "carte d'identité", 'permis de conduire',
  'justificatif de domicile', 'relevé bancaire', 'pasaporte', 'dni', 'documento de identidad', 'permiso de conducir', 'extracto bancario',
]
// Chinese is not written with spaces: these match as substrings, not as whole words (v0.7.8)
const ZH = ['护照', '身份证', '驾驶证', '银行对账单', '住址证明', '营业执照']
const BIRTH = ['date of birth', 'place of birth', 'nationality']
// a passport machine-readable zone line (C-RED-0 ② v0.7.19): `P`, then four characters that are capital letters or `<`
// (document type and issuing state, e.g. `P<GBR`, `P<D<<`, `PMGBR`), and `<<` on the same line; any Unicode line
// break starts a line (CR-only text, NEL, U+2028, U+2029, form feed, vertical tab); leading blanks allowed
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/
const MRZ_START = /^\s*P[A-Z<]{4}/
const hasMrz = (t: string) => t.split(LINE_BREAK).some((line) => MRZ_START.test(line) && line.includes('<<'))
// CJK characters are letters to I-05, so `Passport扫描件` would not be a whole word: in C-RED-0 they separate words (P1)
const CJK = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu

const hasWord = (t: string) => {
  const n = normaliseText(t).toLowerCase()
  // file names join words with _ - .: I-05 already treats them as separators
  return findPhrases(n.replace(CJK, ' $1 '), WORDS).length > 0 || ZH.some((w) => n.includes(w))
}

export interface KycInput {
  filename: string
  kind: string // pdf | txt | csv | eml | docx | xml | image | other
  parseStatus: string // parsed | not_parsed | over_limit | failed | timeout | blocked | pending
  text: string
  scanStatus?: string
  inline?: { eligible: boolean; contentId: string | null; disposition: string | null; htmlReferenced: boolean } | null
  imageFacts?: ImageFacts | null
  inlineLimits?: InlineLimits
  facts: { pagesWithoutText?: number; encrypted?: boolean; tooDeep?: boolean; signalTexts?: string[]; nested?: Array<{ filename: string; kind: string; result: { status: string; text: string; facts: KycInput['facts'] } }> } | null
}

/** Only the narrow image exception skips the usual not-parsed check (B.1–6). */
export function inlineSignature(a: KycInput): boolean {
  const f = a.imageFacts, l = a.inlineLimits ?? INLINE_DEFAULTS
  return a.kind === 'image' && !hasWord(a.filename) && a.scanStatus === 'clean' &&
    a.parseStatus === 'not_parsed' && a.inline?.eligible === true && a.inline.htmlReferenced && !!a.inline.contentId &&
    (a.inline.disposition === null || a.inline.disposition === 'inline') && f?.code === 'ok' && f.format !== null &&
    f.width > 0 && f.height > 0 && Math.max(f.width, f.height) <= l.max_long_side &&
    Math.min(f.width, f.height) <= l.max_short_side && f.bytes <= l.max_bytes
}

/** The reason an attachment may be KYC (C-RED-0 ① to ⑤), or null when it may go to a model. */
export function kycReason(a: KycInput): string | null {
  if (hasWord(a.filename)) return 'file_name'
  if (a.kind === 'image') return inlineSignature(a) ? null : 'image'
  // ⑤ a check that could not be completed: anything not parsed, encrypted, nested too deep
  if (a.parseStatus !== 'parsed') return `not_checked:${a.parseStatus}`
  if (a.facts?.encrypted) return 'not_checked:encrypted'
  if (a.facts?.tooDeep) return 'not_checked:too_deep'
  if (a.kind === 'pdf' && (a.facts?.pagesWithoutText ?? 0) > 0) return 'pdf_without_text_layer'
  // an attached message's header values and comments are its text too, judged together with its body: two birth
  // details may be split between them (C-RED-0 ②, Codex E2 re-run F2, round 2 F11)
  const all = [a.text, ...(a.facts?.signalTexts ?? [])].join('\n')
  if (contentReason(all)) return contentReason(a.text) ? contentReason(a.text) : `header:${contentReason(all)}`
  for (const n of a.facts?.nested ?? []) {
    const r = kycReason({ filename: n.filename, kind: n.kind, parseStatus: n.result.status, text: n.result.text, facts: n.result.facts })
    if (r) return `nested:${r}`
  }
  // the whole attachment tree is one attachment's text: two birth details may sit at two levels (C-RED-0 ②, Codex E2 round 3 F14)
  const tree = contentReason(treeText(a.text, a.facts))
  return tree ? `tree:${tree}` : null
}

const treeText = (text: string, facts: KycInput['facts']): string =>
  [text, ...(facts?.signalTexts ?? []), ...(facts?.nested ?? []).map((n) => treeText(n.result.text, n.result.facts))].join('\n')

function contentReason(text: string): string | null {
  if (hasMrz(normaliseText(text))) return 'mrz'
  if (hasWord(text)) return 'content_word'
  // CJK characters separate English words here too (P1, Codex X3)
  const n = normaliseText(text).toLowerCase().replace(CJK, ' $1 ')
  if (BIRTH.filter((p) => findPhrases(n, [p]).length > 0).length >= 2) return 'birth_details'
  return null
}
