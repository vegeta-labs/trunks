// PRD C-RED-1: replace sensitive values before any model call. Input and output are I-04 normalised text.
// The redacted range is the union of the rules below and the C-EXT-4 hits; earlier rules win where they overlap
// (UETRs, amounts and references are never redacted on their own, but lose to any sensitive pattern).
import { extractAccounts, ibanShapes } from './accounts.ts'
import { extractDates } from './dates.ts'
import { findPhrases, normaliseText, words } from './text.ts'

export type RedactKind = 'ACCOUNT' | 'SORTCODE' | 'ID' | 'DOB' | 'ADDRESS' | 'PHONE' | 'EMAIL' | 'NAME'

export interface RedactSpan {
  start: number
  end: number
  kind: RedactKind
  placeholder: string
}

interface Span {
  start: number
  end: number
}

const near = (keywords: Span[], s: Span, before: number, after: number) =>
  keywords.some((k) => (k.end <= s.start && s.start - k.end <= before) || (s.end <= k.start && k.start - s.end <= after))

const all = (t: string, re: RegExp): Span[] => [...t.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }))

const SORT_HYPHEN = /(?<![\p{L}\p{N}-])\d{2}-\d{2}-\d{2}(?![\p{L}\p{N}-])/gu
const SIX = /(?<![\p{L}\p{N}])\d{6}(?![\p{L}\p{N}])/gu
const EIGHT = /(?<![\p{L}\p{N}])\d{8}(?![\p{L}\p{N}])/gu
const NINE = /(?<![\p{L}\p{N}])\d{9}(?![\p{L}\p{N}])/gu
// 5 letters + 6 digits + 2 letters/digits + 3 letters/digits (16 characters)
// surname block: 5 letters, a short surname padded with 9s (v0.7.3)
const DRIVING = /(?<![\p{L}\p{N}])[A-Za-z][A-Za-z9]{4}\d{6}[A-Za-z0-9]{2}[A-Za-z0-9]{3}(?![\p{L}\p{N}])/gu
// AA999999A; also written with single spaces between the pairs (`QQ 12 34 56 C`)
const NINO = /(?<![\p{L}\p{N}])[A-Za-z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-Za-z](?![\p{L}\p{N}])/gu
// DD.MM.YYYY and DD-MM-YYYY: only as dates of birth (C-EXT-5 does not read them)
const NUMERIC_DATE = /(?<![\p{L}\p{N}])\d{1,2}([.-])\d{1,2}\1\d{4}(?![\p{L}\p{N}])/gu
const POSTCODE = /(?<![\p{L}\p{N}])[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}(?![\p{L}\p{N}])/gu
// `+` or 0 first; a `(0)` after the country code is allowed (v0.7.1)
// digits with single spaces or hyphens between them (v0.7.2)
// a bracketed area code `(020) …` and the `00` prefix are allowed too (v0.7.3)
const PHONE_RUN = /(?<![\p{L}\p{N}+])(?:\+\d{1,3}[ -]?\(0\)[ -]?\d|\+\d{1,3}[ -]?\(\d{1,4}\)[ -]?\d|\+\d|\(0\d{1,4}\)[ -]?\d|0)\d*(?:[ -]\d+)*/gu
// RFC 5322 local part: every atom character (letters and digits in any script, ! # $ % & ' * + / = ? ^ _ ` { | } ~ - .)
// or a quoted string; the domain is kept (Codex F6). A `"` before an atom local part is punctuation around the address,
// not part of it (`"alice@example.com"`, Codex round 2 N2)
const EMAIL = /(?<![\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-])((?:"(?:[^"\\\r\n]|\\.)*"|[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+))@((?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+)/gu

/** The postcode's line and up to three non-blank lines directly above it (v0.7.3). */
function addressBlock(t: string, s: Span): Span {
  const line = lineOf(t, s)
  let start = line.start
  for (let n = 0; n < 3 && start > 0; n++) {
    const prevEnd = start - 1 // the \n before the current first line
    const prevStart = t.lastIndexOf('\n', prevEnd - 1) + 1
    if (t.slice(prevStart, prevEnd).trim() === '') break
    start = prevStart
  }
  return { start, end: line.end }
}

function lineOf(t: string, s: Span): Span {
  const start = t.lastIndexOf('\n', s.start - 1) + 1
  const nl = t.indexOf('\n', s.end)
  let end = nl === -1 ? t.length : nl
  if (t[end - 1] === '\r') end--
  return { start, end }
}

/** Phone: `+` or `0` first; 10–15 digits once spaces, hyphens and `(0)` are removed; ends at the first group boundary that reaches 10. */
function phones(t: string): Span[] {
  const out: Span[] = []
  const re = new RegExp(PHONE_RUN.source, 'gu')
  for (let m = re.exec(t); m; m = re.exec(t)) {
    // `00` is an international prefix only when digits follow it directly
    if (m[0].startsWith('00') && !/\d/.test(m[0][2] ?? '')) {
      re.lastIndex = m.index + 1
      continue
    }
    // same length throughout: the trunk `(0)` and an international `00` are not counted; brackets are separators
    let s = m[0].replace('(0)', '\u0000\u0000\u0000').replace(/[()]/g, ' ')
    if (s.startsWith('00')) s = `\u0000\u0000${s.slice(2)}`
    let best = -1
    let digits = 0
    for (let i = 0; i < s.length; i++) {
      if (/\d/.test(s[i]!)) digits++
      const atGroupEnd = i === s.length - 1 || !/\d/.test(s[i + 1]!)
      // the first group boundary that reaches 10–15 digits (PRD v0.7.2)
      if (/\d/.test(s[i]!) && atGroupEnd && digits >= 10 && digits <= 15) {
        best = i + 1
        break
      }
      if (digits > 15) break
    }
    // like the other number patterns, a phone does not run straight into a letter (`07700 900123x` is not one)
    if (best > 0 && !/[\p{L}\p{N}]/u.test(t[m.index + best] ?? '')) {
      out.push({ start: m.index, end: m.index + best })
      re.lastIndex = m.index + best // the rest of the run is scanned again: it may hold another phone
    } else re.lastIndex = m.index + 1
  }
  return out
}

/** C-RED-1 account patterns (IBAN shapes, UK account numbers), whatever their check digits; also C-CLS-4. */
export function accountShapes(
  t: string,
  ext = extractAccounts(t),
  accKw = findPhrases(t, ['account', 'acc', 'a/c']),
  sortCodeKw = findPhrases(t, ['sort code']),
): Span[] {
  return [...ibanShapes(t), ...ext, ...all(t, EIGHT).filter((s) => near(accKw, s, 30, -1) || near(sortCodeKw, s, 30, 30))]
}

export interface RedactionRules {
  contactNames: readonly string[]
}

const ORDER: readonly RedactKind[] = ['ACCOUNT', 'SORTCODE', 'ID', 'DOB', 'ADDRESS', 'PHONE', 'EMAIL', 'NAME']

/** Every hit of every rule, plus the C-EXT-4 hits. */
function hits(t: string, rules: RedactionRules): Array<Span & { kind: RedactKind }> {
  const kw = (...p: string[]) => findPhrases(t, p)
  const sortKw = kw('sort', 'sort code')
  const sortCodeKw = kw('sort code')
  const accKw = kw('account', 'acc', 'a/c')
  const ext = extractAccounts(t)
  const emails = [...t.matchAll(EMAIL)].map((m) => ({
    local: { start: m.index, end: m.index + m[1]!.length },
    domain: { start: m.index + m[1]!.length, end: m.index + m[0].length },
  }))
  const dobKw = kw('born', 'dob', 'd.o.b.', 'date of birth')
  const nameWords = new Set(rules.contactNames.flatMap((n) => words(normaliseText(n))).filter((w) => w.length >= 3).map((w) => w.word))
  // the domain of an e-mail address is kept: a name word inside it is not a name
  const inDomain = (s: Span) => emails.some((e) => s.start >= e.domain.start && s.end <= e.domain.end)
  const by: Record<RedactKind, Span[]> = {
    ACCOUNT: accountShapes(t, ext, accKw, sortCodeKw),
    SORTCODE: [...all(t, SORT_HYPHEN), ...all(t, SIX).filter((s) => near(sortKw, s, 20, -1)), ...ext.flatMap((h) => (h.sort ? [h.sort] : []))],
    ID: [...all(t, NINE).filter((s) => near(kw('passport'), s, 30, 30)), ...all(t, DRIVING), ...all(t, NINO)],
    DOB: [...extractDates(t), ...all(t, NUMERIC_DATE)].filter((d) => near(dobKw, d, 30, -1)),
    ADDRESS: all(t, POSTCODE).map((p) => addressBlock(t, p)),
    PHONE: phones(t),
    EMAIL: emails.map((e) => e.local),
    NAME: words(t).filter((w) => nameWords.has(w.word) && !inDomain(w)),
  }
  return ORDER.flatMap((kind) => by[kind].map((s) => ({ start: s.start, end: s.end, kind })))
}

/**
 * Union of all hits: hits sharing at least one character merge into one span, which takes the earliest kind in the
 * C-RED-1 order. Touching hits stay separate.
 */
function merge(all: Array<Span & { kind: RedactKind }>): Array<Span & { kind: RedactKind }> {
  const sorted = all.filter((h) => h.end > h.start).sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Array<Span & { kind: RedactKind }> = []
  for (const h of sorted) {
    const last = out.at(-1)
    if (last && h.start < last.end) {
      last.end = Math.max(last.end, h.end)
      if (ORDER.indexOf(h.kind) < ORDER.indexOf(last.kind)) last.kind = h.kind
    } else out.push({ ...h })
  }
  return out
}

const valueKey = (kind: RedactKind, v: string) =>
  kind === 'ACCOUNT' || kind === 'SORTCODE' || kind === 'ID'
    ? v.replace(/[\s-]+/g, '').toUpperCase()
    : kind === 'PHONE'
      ? v.replace('(0)', '').replace(/^\s*00/, '+').replace(/[^+\d]/g, '') // the same number however it is written (00 = +)
      : v.replace(/\s+/g, ' ').toLowerCase()

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Kinds whose value, once found, is replaced wherever else it appears (v0.7.3). Names are already matched everywhere;
// an e-mail's local part alone is not a value of its own (the whole address is found by its own rule).
const SPREAD: readonly RedactKind[] = ['ACCOUNT', 'SORTCODE', 'ID', 'DOB', 'ADDRESS', 'PHONE']

/** Every occurrence of a known value in t: the same characters (case ignored), as a whole token (v0.7.3). */
function occurrences(t: string, value: string): Span[] {
  const v = value.trim()
  if (v.replace(/[^\p{L}\p{N}]/gu, '').length < 6) return []
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, 'giu')
  return [...t.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
}

/**
 * One redactor per message: the same value gets the same placeholder in every part (subject, display names, body,
 * quoted mail, attachment text, file names). Placeholders are numbered per kind in order of first appearance.
 * `redactAll` works in two passes: find sensitive values in every part, then replace every occurrence of each of them
 * in every part, near a keyword or not (C-RED-1, v0.7.3).
 */
export class Redactor {
  private readonly counters = new Map<RedactKind, number>()
  private readonly byValue = new Map<string, string>()
  private readonly found: Array<{ kind: RedactKind; value: string }> = []
  readonly map = new Map<string, string>() // placeholder → original value (first spelling seen)

  private readonly rules: RedactionRules
  constructor(rules: RedactionRules) {
    this.rules = rules
  }

  private placeholder(kind: RedactKind, value: string): string {
    const key = `${kind}\u0000${valueKey(kind, value)}`
    let p = this.byValue.get(key)
    if (!p) {
      const n = (this.counters.get(kind) ?? 0) + 1
      this.counters.set(kind, n)
      p = `[${kind}_${n}]`
      this.byValue.set(key, p)
      this.map.set(p, value)
    }
    return p
  }

  redactAll(texts: readonly string[]): Array<{ text: string; spans: RedactSpan[] }> {
    // pass 1: what the rules find, part by part (placeholders numbered in order of appearance)
    const raw = texts.map((t) => hits(t, this.rules))
    const first = raw.map((h) => merge(h))
    first.forEach((spans, i) => spans.forEach((sp) => {
      const value = texts[i]!.slice(sp.start, sp.end)
      if (SPREAD.includes(sp.kind) && !this.found.some((f) => f.kind === sp.kind && f.value === value)) this.found.push({ kind: sp.kind, value })
    }))
    // the values the rules hit, before merging, are spread to their other occurrences
    raw.forEach((hs, i) => hs.forEach((h) => {
      const value = texts[i]!.slice(h.start, h.end)
      if (SPREAD.includes(h.kind) && !this.found.some((f) => f.kind === h.kind && f.value === value)) this.found.push({ kind: h.kind, value })
    }))
    // pass 2: every occurrence of every found value, in every part; placeholders numbered in the order they appear
    return texts.map((t, i) => {
      const extra = this.found.flatMap((f) => occurrences(t, f.value).map((sp) => ({ ...sp, kind: f.kind })))
      // the placeholder follows the merged span's kind and text (the same text gets the same placeholder)
      const spans = merge([...first[i]!, ...extra]).map((sp) => ({ ...sp, placeholder: this.placeholder(sp.kind, t.slice(sp.start, sp.end)) }))
      let text = ''
      let at = 0
      for (const sp of spans) {
        text += t.slice(at, sp.start) + sp.placeholder
        at = sp.end
      }
      return { text: text + t.slice(at), spans }
    })
  }

  redact(t: string): { text: string; spans: RedactSpan[] } {
    return this.redactAll([t])[0]!
  }
}

/** Full bank account and identity numbers (C-RED-1 ACCOUNT and ID rules) in a text: the outbound scan (C-OUT-1, R-OUT-03). */
export const fullNumbers = (text: string) => hits(normaliseText(text), { contactNames: [] }).filter((h) => h.kind === 'ACCOUNT' || h.kind === 'ID')
