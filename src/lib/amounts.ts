// PRD C-EXT-3: amount tokens in free text, and MT103 `:32A:`. pacs.008 is in pacs008.ts.
import { MAX_MINOR, parseAmountNumber, type Money } from './money.ts'
import { isoFromParts } from './dates.ts'

export interface AmountHit extends Money {
  start: number
  end: number
}

const SYMBOLS: Record<string, string> = { '£': 'GBP', '€': 'EUR', $: 'USD', US$: 'USD' }
const CODES = new Set(['GBP', 'EUR', 'USD'])

const isLetter = (c: string | undefined) => c !== undefined && /[\p{L}\p{M}]/u.test(c)
const isLetterOrDigit = (c: string | undefined) => c !== undefined && /[\p{L}\p{M}\p{N}]/u.test(c)
const isSpace = (c: string | undefined) => c !== undefined && /\s/u.test(c)

/** Character before a token: whitespace, start of text, or ( ) ; : */
const okBefore = (t: string, i: number) => i === 0 || isSpace(t[i - 1]) || '();:'.includes(t[i - 1]!)

/** Character after a token: whitespace, end, ( ) ; :, a comma followed by whitespace, or a sentence-ending dot. */
function okAfter(t: string, i: number): boolean {
  if (i >= t.length || isSpace(t[i])) return true
  const c = t[i]!
  if ('();:'.includes(c)) return true
  if (c === ',' || c === '.') return i + 1 >= t.length || isSpace(t[i + 1])
  return false
}

/** Marker that ends exactly at `end` (text before a number, optional single space already removed). */
function markerBefore(t: string, end: number): { currency: string; start: number } | null {
  if (t.slice(end - 3, end) === 'US$' || t.slice(end - 3, end).toUpperCase() === 'US$') {
    return { currency: 'USD', start: end - 3 }
  }
  const c = t[end - 1]
  if (c === '£' || c === '€') return { currency: SYMBOLS[c]!, start: end - 1 }
  // `$` with a letter directly before it (CA$, A$, HK$) is not an amount
  if (c === '$') return isLetter(t[end - 2]) ? null : { currency: 'USD', start: end - 1 }
  const code = t.slice(end - 3, end).toUpperCase()
  if (end >= 3 && CODES.has(code)) return { currency: code, start: end - 3 }
  return null
}

/** Marker that starts exactly at `start`. */
function markerAfter(t: string, start: number): { currency: string; end: number } | null {
  if (t.slice(start, start + 3).toUpperCase() === 'US$') return { currency: 'USD', end: start + 3 }
  const c = t[start]
  if (c === '£' || c === '€' || c === '$') return { currency: SYMBOLS[c]!, end: start + 1 }
  const code = t.slice(start, start + 3).toUpperCase()
  if (CODES.has(code)) return { currency: code, end: start + 3 }
  return null
}

interface Candidate {
  start: number
  end: number
  currency: string
  minor: number
  touching: boolean // marker written directly against the number
}

/**
 * C-EXT-3 amount tokens in I-04 normalised text. `:32A:` fields are handled by `mt103`.
 * A currency marker belongs to one token only (v0.7.1): candidates that fail the boundaries or I-01 do not take it;
 * a marker written against its number wins; otherwise the leftmost candidate wins.
 */
export function extractAmounts(t: string, currencies: readonly string[] = ['GBP', 'EUR', 'USD']): AmountHit[] {
  const cands: Candidate[] = []
  for (const m of t.matchAll(/\d[\d.,]*/g)) {
    const numStart = m.index
    let numEnd = m.index + m[0].length
    // a trailing dot or comma followed by whitespace or the end is punctuation, not part of the number
    if (/[.,]$/.test(m[0]) && (numEnd >= t.length || isSpace(t[numEnd]))) numEnd--
    const minor = parseAmountNumber(t.slice(numStart, numEnd))
    const options: Array<Omit<Candidate, 'minor'>> = []
    const touchingBefore = markerBefore(t, numStart)
    if (touchingBefore) options.push({ start: touchingBefore.start, end: numEnd, currency: touchingBefore.currency, touching: true })
    else if (t[numStart - 1] === ' ') {
      const b = markerBefore(t, numStart - 1)
      if (b) options.push({ start: b.start, end: numEnd, currency: b.currency, touching: false })
    }
    // part of a longer word (e.g. `x10`): only a marker written against it can start the token
    if (!touchingBefore && isLetterOrDigit(t[numStart - 1])) {
      if (options.length === 0) continue
    }
    const touchingAfter = markerAfter(t, numEnd)
    if (touchingAfter) options.push({ start: numStart, end: touchingAfter.end, currency: touchingAfter.currency, touching: true })
    else if (t[numEnd] === ' ') {
      const a = markerAfter(t, numEnd + 1)
      if (a) options.push({ start: numStart, end: a.end, currency: a.currency, touching: false })
    }
    for (const o of options) {
      if (!currencies.includes(o.currency)) continue // a marker of a currency the deployment does not use (I-01)
      if (minor === null) continue // the whole token is void; never take part of the number
      if (!okBefore(t, o.start) || !okAfter(t, o.end)) continue
      if (t[o.start - 1] === '-' || t[o.start - 1] === '\u2212') continue
      cands.push({ ...o, minor })
    }
  }
  const taken: Candidate[] = []
  const overlaps = (c: Candidate) => taken.some((x) => c.start < x.end && x.start < c.end)
  for (const pass of [true, false]) {
    for (const c of cands.filter((x) => x.touching === pass).sort((a, b) => a.start - b.start || b.end - a.end)) if (!overlaps(c)) taken.push(c)
  }
  return taken.sort((a, b) => a.start - b.start).map(({ minor, currency, start, end }) => ({ minor, currency, start, end }))
}

export interface EvidenceItem extends Money {
  valueDate: string | null
  start: number // the `:32A:` field in the text (R-EXT-02)
  end: number
}

/**
 * MT103 `:32A:` = YYMMDD + currency + amount with a comma decimal; YY means 20YY. An amount written with thousands
 * dots (`5.000,00`) is not read in part: the whole field is invalid, value date included (PRD v0.7.8 C-EXT-3).
 */
export function mt103(t: string, currencies: readonly string[]): EvidenceItem[] {
  const out: EvidenceItem[] = []
  for (const m of t.matchAll(/:32A:(\d{2})(\d{2})(\d{2})([A-Z]{3})(\d+)(?:,(\d{0,2}))?(?![\d,]|\.\d)/g)) {
    const [, yy, mm, dd, ccy, whole, frac = ''] = m as unknown as [string, string, string, string, string, string, string?]
    const valueDate = isoFromParts(2000 + Number(yy), Number(mm), Number(dd))
    if (!valueDate || !currencies.includes(ccy)) continue
    const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
    if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) continue
    out.push({ minor, currency: ccy, valueDate, start: m.index, end: m.index + m[0].length })
  }
  return out
}
