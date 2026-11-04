// PRD appendix B.2–4. Scan each HTML body separately; no DOM repair or browser rendering.
import { parseFragment } from 'parse5'

export const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())
export const asciiTrim = (s: string) => s.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '')
export const storedDisposition = (s: string | null): 'inline' | 'attachment' | 'other' | null =>
  s === null ? null : s === 'inline' || s === 'attachment' ? s : 'other'
const blank = (c: string | undefined) => c !== undefined && /^[ \t\n\r\f]$/.test(c)

export function contentId(s: string): string | null {
  const v = asciiTrim(s)
  return /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(v) ? asciiLower(v.slice(1, -1)) : null
}

/** B.3: validation is separate from the ingest decoder's intentionally tolerant decoding. */
export function strictBase64(s: string): Buffer | null {
  const v = s.replace(/[ \t\n\r\f]/g, '')
  if (v.length % 4 !== 0) return null
  const end = v.length - (v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0)
  // A repeated-group regexp can exhaust the engine's stack on ordinary multi-megabyte attachments.
  for (let i = 0; i < end; i++) {
    const c = v.charCodeAt(i)
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47)) return null
  }
  return Buffer.from(v, 'base64')
}

// Use the installed HTML entity table in text context (as html.unescape), only after scanning attributes ourselves.
const unescape = (s: string) => s.replace(/&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]*;?)/g, (ref) => {
  if (ref.startsWith('&#')) {
    const hex = /^&#[xX]/.test(ref)
    const n = Number.parseInt(ref.slice(hex ? 3 : 2), hex ? 16 : 10)
    // Python html.unescape drops these invalid code points; literal controls are preserved.
    if (n >= 1 && n <= 8 || n === 11 || n >= 14 && n <= 31 || n === 127 ||
        n >= 0xfdd0 && n <= 0xfdef || n <= 0x10ffff && (n % 65536 === 0xfffe || n % 65536 === 0xffff)) return ''
  }
  return parseFragment(ref).childNodes.map((n) => 'value' in n ? n.value : '').join('')
})
const percentDecode = (s: string) => {
  const bytes: Buffer[] = []
  let start = 0
  for (let p = 0; p < s.length; p++) {
    if (s[p] === '%' && /^[0-9a-f]{2}$/i.test(s.slice(p + 1, p + 3))) {
      bytes.push(Buffer.from(s.slice(start, p)), Buffer.from([Number.parseInt(s.slice(p + 1, p + 3), 16)]))
      p += 2; start = p + 1
    }
  }
  bytes.push(Buffer.from(s.slice(start)))
  return Buffer.concat(bytes).toString('utf8')
}

const ignored = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'svg', 'math'])

export function htmlCidReferences(html: string): Set<string> {
  const refs = new Set<string>()
  const lower = asciiLower(html)
  let p = 0
  while (p < html.length) {
    p = html.indexOf('<', p)
    if (p < 0) break
    if (html.startsWith('<!--', p)) {
      if (html.startsWith('<!-->', p)) { p += 5; continue }
      if (html.startsWith('<!--->', p)) { p += 6; continue }
      const end = html.indexOf('-->', p + 4)
      if (end < 0) break
      p = end + 3; continue
    }
    if (html[p + 1] === '!' || html[p + 1] === '?') {
      const end = html.indexOf('>', p + 2)
      if (end < 0) break
      p = end + 1; continue
    }
    p++
    const closing = html[p] === '/'
    if (closing) p++
    if (!/[A-Za-z]/.test(html[p] ?? '')) continue
    const start = p
    while (p < html.length && !blank(html[p]) && html[p] !== '/' && html[p] !== '>') p++
    const tag = lower.slice(start, p)
    const attrs = new Map<string, string>()
    let closed = false
    while (p < html.length) {
      while (blank(html[p]) || html[p] === '/') p++
      if (html[p] === '>') { p++; closed = true; break }
      if (p >= html.length) break
      const at = p
      while (p < html.length && !blank(html[p]) && !['/', '=', '>'].includes(html[p]!)) p++
      const name = lower.slice(at, p)
      while (blank(html[p])) p++
      let value = ''
      if (html[p] === '=') {
        p++
        while (blank(html[p])) p++
        const quote = html[p]
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, ++p)
          if (end < 0) { p = html.length; break }
          value = html.slice(p, end); p = end + 1
        } else {
          const v = p
          while (p < html.length && !blank(html[p]) && html[p] !== '>') p++
          value = html.slice(v, p)
        }
      }
      if (name && !attrs.has(name)) attrs.set(name, value)
      if (p === at) p++ // a stray '=' cannot stop the scanner
    }
    if (!closed) break
    if (!closing && tag === 'plaintext') break
    if (!closing && ignored.has(tag)) {
      const re = new RegExp(`</${tag}(?=[ \\t\\r\\n\\f/>])`, 'g')
      re.lastIndex = p
      const match = re.exec(lower)
      if (!match) break
      // Resume at the closing tag; its text is not an opening img tag.
      p = match.index
      continue
    }
    if (!closing && tag === 'img' && attrs.has('src')) {
      const src = asciiTrim(unescape(attrs.get('src')!))
      if (asciiLower(src.slice(0, 4)) === 'cid:') refs.add(asciiLower(percentDecode(src.slice(4))))
    }
  }
  return refs
}
