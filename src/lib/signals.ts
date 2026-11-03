// PRD C-SIG-1 (sender and content signals), C-SIG-3 (authenticated sender), C-LNK-1 (sender match), I-03.
import { domainToUnicode } from 'node:url'
import { sameName } from './names.ts'
import { matchedPhrases, normaliseText } from './text.ts'
import { hiddenText, htmlComments, htmlToText } from './html.ts'
import { CONFUSABLES } from './confusables-data.ts'

/** I-03: compare addresses with the whole address lower-cased. */
export const normAddress = (a: string) => normaliseText(a).trim().toLowerCase()
export const domainOf = (a: string) => normAddress(a).split('@').pop() ?? ''

export interface Contact {
  contactId: string
  name: string
  emails: readonly string[]
}

// ---------- 1, 2: Authentication-Results ----------

export type AuthOutcome = 'pass' | 'fail' | 'unknown'

export interface AuthInput {
  headers: ReadonlyArray<readonly [string, string]> // top to bottom
  trustedAuthResults: boolean // adapter capability: declared stripping, never for `.eml`
  trustedAuthservId: string
}

export interface AuthResult {
  auth: AuthOutcome
  authFail: boolean
  untrustedAuthHeader: boolean
  dmarcPass: boolean
}

const FAILING = new Set(['fail', 'softfail', 'permerror'])

/** authserv-id: the first token of the header value, before `;` (an optional version may follow it). */
export const authservId = (value: string) => stripCommentsAndQuotes(normaliseText(value)).split(';')[0]!.trim().split(/\s+/)[0]!.toLowerCase()

/** RFC 8601: comments `( … )` (nested, with quoted-pairs) and quoted strings are not part of the result syntax. */
export function stripCommentsAndQuotes(value: string): string {
  let out = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    if (c === '\\' && (depth > 0 || quoted)) {
      i++
      continue
    }
    if (quoted) {
      if (c === '"') quoted = false
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && depth > 0) depth--
    else if (depth === 0) {
      if (c === '"') quoted = true
      else out += c
    }
  }
  return out
}

function methodResults(value: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const part of stripCommentsAndQuotes(normaliseText(value)).split(';').slice(1)) {
    const m = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(part)
    if (m) out.push([m[1]!.toLowerCase(), m[2]!.toLowerCase()])
  }
  return out
}

export function authSignals(input: AuthInput): AuthResult {
  const trusted = input.trustedAuthservId.toLowerCase()
  const ar = input.headers.filter(([n]) => n.toLowerCase() === 'authentication-results').map(([, v]) => v)
  const untrustedAuthHeader = ar.some((v) => authservId(v) !== trusted)
  const top = input.trustedAuthResults ? ar.find((v) => authservId(v) === trusted) : undefined
  if (top === undefined) return { auth: 'unknown', authFail: false, untrustedAuthHeader, dmarcPass: false }
  const results = methodResults(top)
  const authFail = results.some(([, r]) => FAILING.has(r))
  // several dmarc results that disagree are not a pass
  const dmarc = results.filter(([m]) => m === 'dmarc').map(([, r]) => r)
  const dmarcPass = dmarc.length > 0 && dmarc.every((r) => r === 'pass')
  return { auth: authFail ? 'fail' : 'pass', authFail, untrustedAuthHeader, dmarcPass }
}

// ---------- 3: display name ----------

export function displayNameMismatch(displayName: string, address: string, contacts: readonly Contact[]): boolean {
  const name = normaliseText(displayName)
  const addr = normAddress(address)
  const similar = contacts.filter((c) => sameName(name, normaliseText(c.name)))
  // not a mismatch when the address belongs to any contact with that name (two contacts may share a name, v0.7.1)
  return similar.length > 0 && !similar.some((c) => c.emails.some((e) => normAddress(e) === addr))
}

// ---------- 4: lookalike domain ----------

const stripWww = (d: string) => (d.startsWith('www.') ? d.slice(4) : d)
const unicodeDomain = (d: string) => (d.split('.').some((l) => l.startsWith('xn--')) ? domainToUnicode(d) || d : d)

/** Damerau-Levenshtein distance (optimal string alignment), by code point. */
export function dlDistance(x: string, y: string): number {
  const a = Array.from(x)
  const b = Array.from(y)
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1)
      d[i]![j] = v
    }
  }
  return d[a.length]![b.length]!
}

/** C-SIG-1.4 homoglyph table: 0→o, 1→l, i→l, rn→m, vv→w. */
export const unifyHomoglyphs = (d: string) => d.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1i]/g, 'l')

/** UTS #39 skeleton over the full Unicode confusables data: NFD, map every character to its prototype, NFD (Codex F3). */
export const skeleton = (s: string) =>
  Array.from(s.normalize('NFD'))
    .map((c) => CONFUSABLES.get(c) ?? c)
    .join('')
    .normalize('NFD')

const nonLatin = (d: string) => /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(d)

export function lookalikeDomain(senderDomain: string, directoryDomains: readonly string[]): boolean {
  const s = stripWww(unicodeDomain(senderDomain.toLowerCase()))
  const known = [...new Set(directoryDomains.map((d) => stripWww(unicodeDomain(d.toLowerCase()))))]
  if (known.includes(s)) return false
  return known.some((k) => {
    const dist = dlDistance(s, k)
    if (dist >= 1 && dist <= 2) return true
    if (unifyHomoglyphs(s) === unifyHomoglyphs(k)) return true
    return nonLatin(s) && skeleton(s) === skeleton(k)
  })
}

// ---------- 5, 6 ----------

export function replyToMismatch(replyTo: readonly string[], from: string): boolean {
  const f = normAddress(from)
  return replyTo.some((r) => normAddress(r) !== f)
}

/** C-SIG-1.6: never observed before by this deployment and not in the directory. */
export const firstTimeSender = (seenBefore: boolean, inDirectory: boolean) => !seenBefore && !inDirectory

// ---------- 7, 8: content signals ----------

export const INJECTION_MARKERS: readonly string[] = [
  'ignore previous', 'ignore all', 'ignore the above', 'disregard', 'system prompt', 'you are an ai', 'as an ai',
  'new instructions', 'classify this as', 'mark this as low', 'do not flag',
  'note to assistant', 'note to the assistant', 'instructions to the assistant', 'choose template', // v0.7.21 (D8)
]

export const hasHiddenText = (html: string | null) => (html ? hiddenText(html).length > 0 : false)

/** Texts of an HTML body for the injection check: all text (hidden text included) and every comment, as written and with
 * any markup inside it removed (`<!-- do not<b> flag -->`) (C-SIG-1.8). */
export const htmlScanTexts = (html: string | null) =>
  html ? [htmlToText(html), ...htmlComments(html).flatMap((c) => [c, c.replace(/<[^>]*>/g, '')])] : []

/** Injection phrases (fixed list plus configured additions) in any of the texts. */
export function injectionMarkers(texts: readonly string[], extra: readonly string[] = []): string[] {
  const list = [...INJECTION_MARKERS, ...extra]
  const found = new Set<string>()
  for (const t of texts) for (const p of matchedPhrases(t, list)) found.add(p)
  return list.filter((p) => found.has(p))
}

// ---------- C-LNK-1, C-SIG-3 ----------

/** C-LNK-1: the contacts whose e-mail equals the sender address. Exactly one → matched; several → candidates. */
export function contactsForAddress(address: string, contacts: readonly Contact[]): Contact[] {
  const a = normAddress(address)
  return contacts.filter((c) => c.emails.some((e) => normAddress(e) === a))
}

/** C-SIG-3: matches exactly one contact and the adopted authentication result has dmarc=pass. */
export function authenticatedSender(address: string, contacts: readonly Contact[], auth: AuthResult): { authenticated: boolean; contactId: string | null } {
  const m = contactsForAddress(address, contacts)
  const ok = m.length === 1 && auth.auth !== 'unknown' && !auth.authFail && auth.dmarcPass
  return { authenticated: ok, contactId: ok ? m[0]!.contactId : null }
}
