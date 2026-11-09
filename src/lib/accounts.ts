// PRD C-EXT-4 (bank accounts: only the last 4 digits are kept) and the account shapes shared with C-RED-1.
import { IBAN_LENGTHS } from './iban-registry.ts'

export interface AccountHit {
  kind: 'iban' | 'uk'
  last4: string
  country: string // IBAN country code; `GB` for a UK sort code + account
  start: number
  end: number
  sort?: { start: number; end: number } // the paired sort code (UK)
}

// IBAN shape (C-EXT-4, C-RED-1, v0.7.1): a registered country code, 2 digits, and the rest up to exactly the country's
// registered length; written solid or in groups of four separated by one space, line break or hyphen (a line break may split
// the number, TC-RED-06); the last group may be short; letters in either case. Check digits are not checked here.
const compact = (s: string) => s.replace(/[\s-]+/g, '').toUpperCase()

/** ISO 13616 mod-97 = 1 on the compact form. */
/** PRD appendix C.3: the form accounts are compared in. */
export const normaliseAccount = (v: string) => v.replace(/[/\s.-]/g, '').toUpperCase()

export function ibanValid(s: string): boolean {
  const c = compact(s)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(c) || IBAN_LENGTHS[c.slice(0, 2)] !== c.length) return false
  const rearranged = c.slice(4) + c.slice(0, 4)
  let rem = 0
  for (const ch of rearranged) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) rem = (rem * 10 + Number(d)) % 97
  }
  return rem === 1
}

export interface ShapeHit {
  start: number
  end: number
}

/**
 * Every IBAN-shaped string, valid or not (C-RED-1, C-CLS-4): from each candidate start, take exactly the registered
 * number of characters; separators only between groups of four (or none at all); nothing glued on after it.
 */
export function ibanShapes(t: string): ShapeHit[] {
  const out: ShapeHit[] = []
  for (const m of t.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])[A-Za-z]{2}\\d{2}`, 'gu'))) {
    const len = IBAN_LENGTHS[m[0].slice(0, 2).toUpperCase()]
    if (!len) continue
    const hit = shapeAt(t, m.index, len)
    if (hit && !out.some((o) => hit.start < o.end)) out.push(hit)
  }
  return out
}

function shapeAt(t: string, start: number, len: number): ShapeHit | null {
  const isAlnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c)
  // solid
  const solid = t.slice(start, start + len)
  if (solid.length === len && /^[A-Za-z0-9]+$/.test(solid) && !/[\p{L}\p{N}]/u.test(t[start + len] ?? '')) return { start, end: start + len }
  // groups of four, one separator (space, tab or line break) between groups
  let i = start
  let count = 0
  while (count < len) {
    const group = Math.min(4, len - count)
    for (let g = 0; g < group; g++) {
      if (!isAlnum(t[i])) return null
      i++
    }
    count += group
    if (count < len) {
      if (t[i] === '\r' && t[i + 1] === '\n') i += 2
      else if (t[i] === ' ' || t[i] === '\n' || t[i] === '\r' || t[i] === '-') i++ // hyphen: v0.7.3
      else return null
    }
  }
  return /[\p{L}\p{N}]/u.test(t[i] ?? '') ? null : { start, end: i }
}

/** The shape is valid when its check digits pass (mod-97). */
const validIbanIn = (t: string, h: ShapeHit): ShapeHit | null => (ibanValid(t.slice(h.start, h.end)) ? h : null)

const SORT_CODE = /(?<![\p{L}\p{N}-])(?:\d{2}-\d{2}-\d{2}|\d{6})(?![\p{L}\p{N}-])/gu
const UK_ACCOUNT = /(?<![\p{L}\p{N}-])\d{8}(?![\p{L}\p{N}-])/gu
const NEAR = 30

const inside = (spans: ShapeHit[], s: number, e: number) => spans.some((h) => s < h.end && e > h.start)

/** C-EXT-4: valid IBANs and UK sort code + 8-digit account pairs within 30 characters. Normalised text in. */
export function extractAccounts(t: string): AccountHit[] {
  const out: AccountHit[] = []
  const shapes = ibanShapes(t)
  for (const h of shapes) {
    const v = validIbanIn(t, h)
    if (!v) continue
    const c = compact(t.slice(v.start, v.end))
    out.push({ kind: 'iban', last4: c.slice(-4), country: c.slice(0, 2), ...v })
  }
  const sorts = [...t.matchAll(SORT_CODE)].map((m) => ({ start: m.index, end: m.index + m[0].length })).filter((s) => !inside(shapes, s.start, s.end))
  for (const m of t.matchAll(UK_ACCOUNT)) {
    const start = m.index
    const end = start + m[0].length
    if (inside(shapes, start, end)) continue
    // the nearest sort code within 30 characters, before or after
    const gap = (s: { start: number; end: number }) => (s.end <= start ? start - s.end : s.start - end)
    const sort = sorts.filter((s) => gap(s) >= 0 && gap(s) <= NEAR).sort((a, b) => gap(a) - gap(b))[0]
    if (sort) out.push({ kind: 'uk', last4: m[0].slice(-4), country: 'GB', start, end, sort })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** One entry per account (IBANs by compact value, UK accounts by number), for rule output. Redaction uses every hit. */
export function distinctAccounts(t: string, hits: AccountHit[]): AccountHit[] {
  const seen = new Set<string>()
  return hits.filter((h) => {
    const k = h.kind === 'iban' ? `iban:${compact(t.slice(h.start, h.end))}` : `uk:${t.slice(h.start, h.end)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Distinct last-4 values (rule output `account_last4`). */
export const accountLast4 = (hits: AccountHit[]) => [...new Set(hits.map((h) => h.last4))]

/** E6 review hint: a count only, never retain or display the invalid account value. */
export const invalidIbanCount = (text: string): number => ibanShapes(text).filter((h) => !ibanValid(text.slice(h.start, h.end))).length
