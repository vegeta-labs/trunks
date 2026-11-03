// Bounded MIME decoding in the main process (PRD R-ING-06, C-ING-2; tech design T7): headers, text and HTML bodies,
// and attachment bytes. Limits on part count, nesting depth and decoded size; nested messages (message/rfc822) are not
// opened here — they are attachments for the isolated parser.
import { createHash } from 'node:crypto'
import iconv from 'iconv-lite'
import libmime from 'libmime'
import { decode as qpDecode } from 'libqp'

export const MIME_LIMITS = { maxParts: 1000, maxDepth: 20, maxHeaderBytes: 256 * 1024 }

export type AttachmentKind = 'pdf' | 'txt' | 'csv' | 'eml' | 'docx' | 'xml' | 'image' | 'other'

export interface DecodedAttachment {
  ordinal: number
  filename: string // as declared (may be empty); never used as a path
  contentType: string
  kind: AttachmentKind
  size: number // decoded size, or the estimate when not decoded
  content: Buffer | null // null when over the single-attachment limit
  sha256: string | null
  overLimit: boolean
}

export interface DecodedMessage {
  headers: Array<[string, string]> // top to bottom, unfolded, encoded words decoded
  rawHeaders: Array<[string, string]> // the same, not RFC 2047 decoded (address parsing must see the raw form)
  text: string | null
  html: string | null
  attachments: DecodedAttachment[]
  failure: null | 'truncated' | 'bad_boundary' | 'too_many_parts' | 'too_deep' | 'header_too_large'
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function splitHead(buf: Buffer): { head: string; body: Buffer } {
  let i = buf.indexOf('\r\n\r\n')
  let sep = 4
  const j = buf.indexOf('\n\n')
  if (i < 0 || (j >= 0 && j < i)) {
    i = j
    sep = 2
  }
  if (i < 0) return { head: buf.toString('latin1'), body: Buffer.alloc(0) }
  return { head: buf.subarray(0, i).toString('latin1'), body: buf.subarray(i + sep) }
}

/** Unfold and split a header block; values decoded (RFC 2047) as UTF-8. */
export function parseHeaders(head: string, decodeWords = true): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim()
    // header bytes are read as latin1; 8-bit headers are treated as UTF-8
    const raw = Buffer.from(line.slice(i + 1).trim(), 'latin1').toString('utf8')
    let value = raw
    if (decodeWords) {
      try {
        value = libmime.decodeWords(raw)
      } catch {
        value = raw
      }
    }
    out.push([name, value])
  }
  return out
}

const header = (h: Array<[string, string]>, name: string) => h.find(([n]) => n.toLowerCase() === name)?.[1]

function contentType(h: Array<[string, string]>): { type: string; params: Record<string, string> } {
  const v = header(h, 'content-type')
  if (!v) return { type: 'text/plain', params: {} }
  const p = libmime.parseHeaderValue(v)
  return { type: String(p.value).toLowerCase().trim() || 'text/plain', params: (p.params ?? {}) as Record<string, string> }
}

function decodeBody(body: Buffer, h: Array<[string, string]>): Buffer {
  const enc = (header(h, 'content-transfer-encoding') ?? '').toLowerCase().trim()
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (enc === 'quoted-printable') return qpDecode(body.toString('latin1'))
  return body
}

const estimateSize = (body: Buffer, h: Array<[string, string]>) =>
  (header(h, 'content-transfer-encoding') ?? '').toLowerCase().trim() === 'base64' ? Math.floor((body.length * 3) / 4) : body.length

function toText(buf: Buffer, charset: string | undefined): string {
  const cs = (charset ?? 'utf-8').toLowerCase()
  try {
    return iconv.encodingExists(cs) ? iconv.decode(buf, cs) : buf.toString('utf8')
  } catch {
    return buf.toString('utf8')
  }
}

function filenameOf(h: Array<[string, string]>, params: Record<string, string>): string {
  const d = header(h, 'content-disposition')
  const dp = d ? (libmime.parseHeaderValue(d).params as Record<string, string>) : {}
  const name = dp.filename ?? params.name ?? ''
  try {
    return libmime.decodeWords(name)
  } catch {
    return name
  }
}

/** Kind from content, then declared type, then extension. */
export function attachmentKind(filename: string, type: string, content: Buffer | null): AttachmentKind {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? ''
  const head = content?.subarray(0, 8)
  if (head) {
    if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
    if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'image'
    if (head[0] === 0xff && head[1] === 0xd8) return 'image'
    if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image'
    if (head.subarray(0, 2).toString('latin1') === 'PK') return ext === 'docx' || type.includes('wordprocessingml') ? 'docx' : 'other'
  }
  if (type === 'message/rfc822' || ext === 'eml') return 'eml'
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'heic', 'tif', 'tiff', 'bmp', 'webp'].includes(ext)) return 'image'
  if (type === 'application/pdf' || ext === 'pdf') return content ? 'other' : 'pdf' // a ".pdf" without the PDF header is not a PDF
  if (type === 'text/csv' || ext === 'csv') return 'csv'
  if (type === 'application/xml' || type === 'text/xml' || ext === 'xml') return 'xml'
  if (type === 'text/plain' || ext === 'txt') return 'txt'
  return 'other'
}

interface Ctx {
  parts: number
  maxAttachment: number
  out: DecodedMessage
  // KYC replacement (C-PRV-2): where each attachment's part lies in the raw message
  spans?: Map<number, { start: number; end: number; bodyStart: number }>
  base?: Buffer
}

class Stop extends Error {
  readonly reason: NonNullable<DecodedMessage['failure']>
  constructor(reason: NonNullable<DecodedMessage['failure']>) {
    super(reason)
    this.reason = reason
  }
}

function walk(buf: Buffer, depth: number, ctx: Ctx, h?: Array<[string, string]>): void {
  if (++ctx.parts > MIME_LIMITS.maxParts) throw new Stop('too_many_parts')
  if (depth > MIME_LIMITS.maxDepth) throw new Stop('too_deep')
  const { head, body } = h ? { head: '', body: buf } : splitHead(buf)
  if (head.length > MIME_LIMITS.maxHeaderBytes) throw new Stop('header_too_large')
  const headers = h ?? parseHeaders(head)
  if (depth === 0) {
    ctx.out.headers = headers
    ctx.out.rawHeaders = h ? headers : parseHeaders(head, false)
  }
  const ct = contentType(headers)
  const disposition = (header(headers, 'content-disposition') ?? '').toLowerCase()
  const filename = filenameOf(headers, ct.params)

  if (ct.type.startsWith('multipart/')) {
    const b = ct.params.boundary
    if (!b) throw new Stop('bad_boundary')
    const text = body.toString('latin1')
    const delim = `--${b}`
    const lines: number[] = [] // offsets of delimiter lines
    let close = -1
    let pos = 0
    for (;;) {
      const i = text.indexOf(delim, pos)
      if (i < 0) break
      const atLineStart = i === 0 || text[i - 1] === '\n'
      // RFC 2046: the whole line is the delimiter (optionally `--` for the close), then only transport padding
      const closing = text.startsWith('--', i + delim.length)
      const after = i + delim.length + (closing ? 2 : 0)
      const eol = text.indexOf('\n', after)
      const tail = text.slice(after, eol < 0 ? text.length : eol).replace(/\r$/, '')
      if (atLineStart && /^[ \t]*$/.test(tail)) {
        if (closing) {
          close = i
          break
        }
        lines.push(i)
      }
      pos = i + delim.length
    }
    if (lines.length === 0) throw new Stop('bad_boundary')
    if (close < 0) throw new Stop('truncated')
    const ends = [...lines.slice(1), close]
    for (let k = 0; k < lines.length; k++) {
      const start = text.indexOf('\n', lines[k]!) + 1
      let end = ends[k]!
      // the line break before a delimiter belongs to the delimiter
      if (text[end - 1] === '\n') end--
      if (text[end - 1] === '\r') end--
      walk(body.subarray(start, Math.max(start, end)), depth + 1, ctx)
    }
    return
  }

  const isAttachment = disposition.startsWith('attachment') || filename !== '' || ct.type === 'message/rfc822' || !(ct.type === 'text/plain' || ct.type === 'text/html')
  if (isAttachment && ctx.spans && ctx.base) {
    const start = buf.byteOffset - ctx.base.byteOffset
    ctx.spans.set(ctx.out.attachments.length, { start, end: start + buf.length, bodyStart: body.byteOffset - ctx.base.byteOffset })
  }
  if (!isAttachment) {
    const decoded = decodeBody(body, headers)
    let s = toText(decoded, ct.params.charset)
    if (ct.type === 'text/plain' && /flowed/i.test(ct.params.format ?? '')) s = libmime.decodeFlowed(s, /yes/i.test(ct.params.delsp ?? ''))
    // every inline text part is body, in order: a reader's client shows them all (self-test RK-F3)
    if (ct.type === 'text/plain') ctx.out.text = ctx.out.text === null ? s : `${ctx.out.text}\n\n${s}`
    else ctx.out.html = ctx.out.html === null ? s : `${ctx.out.html}\n${s}`
    return
  }
  const estimate = estimateSize(body, headers)
  // decode unless the encoded body is clearly too large (base64 with line breaks is ~1.37× the decoded size)
  if (body.length > ctx.maxAttachment * 1.5 + 4096) {
    ctx.out.attachments.push({ ordinal: ctx.out.attachments.length, filename, contentType: ct.type, kind: attachmentKind(filename, ct.type, null), size: estimate, content: null, sha256: null, overLimit: true })
    return
  }
  ctx.out.attachments.push(att(ctx, filename, ct.type, decodeBody(body, headers)))
}

function att(ctx: Ctx, filename: string, type: string, content: Buffer): DecodedAttachment {
  const over = content.length > ctx.maxAttachment
  return {
    ordinal: ctx.out.attachments.length,
    filename,
    contentType: type,
    kind: attachmentKind(filename, type, content),
    size: content.length,
    content: over ? null : content,
    sha256: over ? null : sha(content),
    overLimit: over,
  }
}

/**
 * Decode a raw message. Never throws: a structural problem stops decoding and sets `failure` (TC-ING-11);
 * whatever was decoded before the stop is kept. Attachments beyond the total limit are marked over limit in order.
 */
export function decodeMime(raw: Buffer, limits: { maxAttachmentBytes: number; maxTotalBytes: number }): DecodedMessage {
  const out: DecodedMessage = { headers: [], rawHeaders: [], text: null, html: null, attachments: [], failure: null }
  const ctx: Ctx = { parts: 0, maxAttachment: limits.maxAttachmentBytes, out }
  try {
    walk(raw, 0, ctx)
  } catch (e) {
    if (e instanceof Stop) out.failure = e.reason
    else out.failure = 'truncated'
  }
  if (out.headers.length === 0) {
    const head = splitHead(raw).head.slice(0, MIME_LIMITS.maxHeaderBytes)
    out.headers = parseHeaders(head)
    out.rawHeaders = parseHeaders(head, false)
  }
  let total = 0
  for (const a of out.attachments) {
    if (a.overLimit) continue
    total += a.size
    if (total > limits.maxTotalBytes) {
      a.overLimit = true
      a.content = null
    }
  }
  return out
}

/** The part that stands in for a removed attachment: still an attachment, so the ordinals of the others do not move. */
export const REMOVED_PART = Buffer.from(
  'Content-Type: text/plain; charset=utf-8\r\nContent-Disposition: attachment; filename="removed"\r\nX-Deal-Ops-Removed: kyc\r\n\r\n' +
    'This attachment was transferred to the KYC store and removed from this copy.',
)

/**
 * A copy of the raw message with the given attachments replaced by REMOVED_PART (PRD C-PRV-2 ①). Ordinals are the
 * ones decodeMime assigns. When the whole message is the attachment, only its body is emptied. Throws when an ordinal
 * cannot be located: no copy is better than a copy that still holds the document.
 */
export function stripAttachments(raw: Buffer, ordinals: ReadonlySet<number>): Buffer {
  const out: DecodedMessage = { headers: [], rawHeaders: [], text: null, html: null, attachments: [], failure: null }
  const ctx: Ctx = { parts: 0, maxAttachment: Number.MAX_SAFE_INTEGER, out, spans: new Map(), base: raw }
  try {
    walk(raw, 0, ctx)
  } catch (e) {
    // a structural problem (as at ingest, where the parts before it were kept): the parts found so far are located
    // all the same (self-test F2); a part that was not reached cannot be in the stored attachments either
    // as decodeMime: whatever stopped the walk, the parts found so far are what ingest recorded (review R4 note)
    void e
  }
  const spans = [...ordinals].map((o) => {
    const s = ctx.spans!.get(o)
    if (!s) throw new Error(`attachment ${o} not found in the message`)
    return s
  })
  spans.sort((a, b) => b.start - a.start) // from the end, so earlier offsets stay valid
  let copy = raw
  for (const s of spans) {
    copy = s.start === 0 ? Buffer.concat([copy.subarray(0, s.bodyStart)]) : Buffer.concat([copy.subarray(0, s.start), REMOVED_PART, copy.subarray(s.end)])
  }
  return copy
}
