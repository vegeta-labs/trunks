// RFC 5322 mailbox parsing for From / Reply-To (C-SIG-1, C-SIG-3, C-LNK-1). Parsed on the raw header value, before
// RFC 2047 decoding, so an encoded word in a display name can never become an address. Quoted strings and comments are
// skipped when looking for the address; anything ambiguous is reported as unparseable rather than guessed.
import libmime from 'libmime'

export interface Mailbox {
  name: string // decoded display name ('' when none)
  address: string // addr-spec as written
}

type Token = { kind: 'word' | 'quoted' | 'angle' | 'comma' | 'colon' | 'semicolon' | 'at'; text: string }

function tokens(raw: string): Token[] | null {
  const out: Token[] = []
  let i = 0
  while (i < raw.length) {
    const c = raw[i]!
    if (/\s/.test(c)) {
      i++
    } else if (c === '(') {
      // comment, possibly nested, with quoted-pairs
      let depth = 0
      for (; i < raw.length; i++) {
        if (raw[i] === '\\') i++
        else if (raw[i] === '(') depth++
        else if (raw[i] === ')' && --depth === 0) break
      }
      if (depth !== 0) return null
      i++
    } else if (c === '"') {
      let text = ''
      i++
      for (; i < raw.length && raw[i] !== '"'; i++) {
        if (raw[i] === '\\') i++
        text += raw[i] ?? ''
      }
      if (raw[i] !== '"') return null
      i++
      out.push({ kind: 'quoted', text })
    } else if (c === '<') {
      const end = raw.indexOf('>', i)
      if (end < 0) return null
      out.push({ kind: 'angle', text: raw.slice(i + 1, end).trim() })
      i = end + 1
    } else if (c === ',' || c === ':' || c === ';') {
      out.push({ kind: c === ',' ? 'comma' : c === ':' ? 'colon' : 'semicolon', text: c })
      i++
    } else if (c === '>') {
      return null
    } else {
      let text = ''
      while (i < raw.length && !/[\s"(<>,:;]/.test(raw[i]!)) text += raw[i++]
      out.push({ kind: 'word', text })
    }
  }
  return out
}

const ADDR_SPEC = /^(?:"(?:[^"\\]|\\.)*"|[^\s"<>(),:;@\\[\]]+)@(?:[\p{L}\p{N}-]+\.)*[\p{L}\p{N}-]+$/u
const EMBEDDED_ADDRESS = /[^\s<>()"@,;:]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu

const decode = (s: string) => {
  try {
    return libmime.decodeWords(s)
  } catch {
    return s
  }
}

function mailboxOf(ts: Token[]): Mailbox | null {
  const angles = ts.filter((t) => t.kind === 'angle')
  if (ts.some((t) => t.kind === 'colon' || t.kind === 'semicolon' || t.kind === 'comma')) return null
  if (angles.length > 1) return null
  if (angles.length === 1) {
    const at = ts.indexOf(angles[0]!)
    if (at !== ts.length - 1) return null // nothing may follow the angle address (comments are already gone)
    const address = angles[0]!.text
    if (!ADDR_SPEC.test(address)) return null
    const name = decode(ts.slice(0, at).map((t) => t.text).join(' ')).trim()
    return { name, address }
  }
  // a bare addr-spec: one word (an @ inside a quoted local part is not supported here)
  if (ts.length !== 1 || ts[0]!.kind !== 'word' || !ADDR_SPEC.test(ts[0]!.text)) return null
  return { name: '', address: ts[0]!.text }
}

export type SenderParse = { ok: true; mailbox: Mailbox } | { ok: false; reason: 'missing' | 'unparseable' | 'several' | 'name_holds_other_address' }

/** The sender from a raw (not yet RFC 2047 decoded) `From` value: exactly one mailbox, or a reason why not. */
export function parseSender(raw: string | undefined): SenderParse {
  if (raw === undefined || raw.trim() === '') return { ok: false, reason: 'missing' }
  const ts = tokens(raw)
  if (!ts) return { ok: false, reason: 'unparseable' }
  if (ts.some((t) => t.kind === 'comma')) return { ok: false, reason: 'several' }
  const m = mailboxOf(ts)
  if (!m) return { ok: false, reason: 'unparseable' }
  // a display name that carries a different address is a disguise (`"Alice <cfo@fund.example>" <x@evil.example>`)
  const embedded = [...m.name.matchAll(EMBEDDED_ADDRESS)].map((x) => x[0].toLowerCase())
  if (embedded.some((e) => e !== m.address.toLowerCase())) return { ok: false, reason: 'name_holds_other_address' }
  return { ok: true, mailbox: m }
}

/** Addresses of a raw address list (Reply-To). Null when any member cannot be parsed. */
export function parseAddressList(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return []
  const ts = tokens(raw)
  if (!ts) return null
  const groups: Token[][] = [[]]
  for (const t of ts) {
    if (t.kind === 'comma') groups.push([])
    else groups.at(-1)!.push(t)
  }
  const out: string[] = []
  for (const g of groups) {
    if (g.length === 0) continue
    const m = mailboxOf(g)
    if (!m) return null
    out.push(m.address)
  }
  return out
}
