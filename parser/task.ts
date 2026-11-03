// One attachment parse (PRD C-ING-2). Runs inside the parser container, one bubblewrap sandbox per task
// (tech design T7); the same code runs in-process in tests. Never executes macros or scripts; images are not read.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import iconv from 'iconv-lite'
import { docxText } from './docx.ts'
import { parsePacs008, type PacsResult } from '../src/lib/pacs008.ts'
import { decodeMime, type AttachmentKind } from '../src/ingest/mime.ts'
import { htmlComments, htmlToText } from '../src/lib/html.ts'

export interface TaskLimits {
  maxPdfPages: number
  maxNesting: number // nested .eml depth (≤ 3)
  maxAttachmentBytes: number
  maxTotalBytes: number
}

export type TaskStatus = 'parsed' | 'not_parsed' | 'over_limit' | 'failed'

export interface NestedPart {
  filename: string
  kind: AttachmentKind
  result: TaskResult
  offset: number // where result.text starts in the enclosing message's text (R-EXT-02 positions, Codex F14)
}

export interface TaskResult {
  status: TaskStatus
  reason?: string
  text: string // '' when nothing was read
  facts: {
    pages?: number
    pagesWithoutText?: number
    encrypted?: boolean
    pacs008?: PacsResult
    nested?: NestedPart[]
    tooDeep?: boolean
    // a nested message's header values and HTML comments: checked for injection phrases, never model text (Codex F4)
    signalTexts?: string[]
  }
}

const fail = (reason: string, facts: TaskResult['facts'] = {}): TaskResult => ({ status: 'failed', reason, text: '', facts })

/** Text of a plain-text attachment: UTF-8, or the encoding its byte-order mark names, else windows-1252. */
export function plainText(b: Buffer): string {
  const bom = (...xs: number[]) => xs.every((x, i) => b[i] === x)
  if (bom(0xff, 0xfe, 0x00, 0x00)) return iconv.decode(b.subarray(4), 'utf32le')
  if (bom(0x00, 0x00, 0xfe, 0xff)) return iconv.decode(b.subarray(4), 'utf32be')
  if (bom(0xff, 0xfe)) return iconv.decode(b.subarray(2), 'utf16le')
  if (bom(0xfe, 0xff)) return iconv.decode(b.subarray(2), 'utf16be')
  const s = bom(0xef, 0xbb, 0xbf) ? b.subarray(3) : b
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(s)
  } catch {
    return iconv.decode(s, 'windows-1252')
  }
}

// control characters other than tab, line feed and carriage return: the text was not decoded right (self-test RK-F4)
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function textResult(text: string): TaskResult {
  return CONTROL.test(text) ? { status: 'failed', reason: 'undecodable_text', text: '', facts: {} } : { status: 'parsed', text, facts: {} }
}

async function pdf(b: Buffer, maxPages: number): Promise<TaskResult> {
  const task = getDocument({ data: new Uint8Array(b), disableFontFace: true, useSystemFonts: false, enableXfa: false, verbosity: 0 })
  let doc
  try {
    doc = await task.promise
  } catch (e) {
    await task.destroy()
    const name = (e as { name?: string }).name ?? ''
    return fail(name === 'PasswordException' ? 'encrypted' : 'unreadable_pdf', { encrypted: name === 'PasswordException' })
  }
  try {
    if (doc.numPages > maxPages) return { status: 'over_limit', reason: 'too_many_pages', text: '', facts: { pages: doc.numPages } }
    const texts: string[] = []
    let without = 0
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      const t = tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('')
      if (t.trim() === '') without++
      texts.push(t)
    }
    return { status: 'parsed', text: texts.join('\n\f\n'), facts: { pages: doc.numPages, pagesWithoutText: without } }
  } finally {
    await task.destroy()
  }
}

async function eml(b: Buffer, limits: TaskLimits, depth: number): Promise<TaskResult> {
  if (depth > limits.maxNesting) return { status: 'failed', reason: 'too_deep', text: '', facts: { tooDeep: true } }
  const m = decodeMime(b, { maxAttachmentBytes: limits.maxAttachmentBytes, maxTotalBytes: limits.maxTotalBytes })
  if (m.failure) return fail(`mime_${m.failure}`)
  const subject = m.headers.find(([n]) => n.toLowerCase() === 'subject')?.[1] ?? ''
  const nested: NestedPart[] = []
  for (const a of m.attachments) {
    const result: TaskResult = a.overLimit || !a.content ? { status: 'over_limit', text: '', facts: {} } : await runTask(a.kind, a.content, limits, depth + 1)
    nested.push({ filename: a.filename, kind: a.kind, result, offset: 0 })
  }
  const parts = [subject, m.text ?? '', m.html ? htmlToText(m.html) : ''].filter((s) => s !== '')
  let len = parts.join('\n\n').length
  for (const n of nested) {
    if (n.result.text === '') continue
    if (parts.length) len += 2
    n.offset = len
    parts.push(n.result.text)
    len += n.result.text.length
  }
  const signalTexts = [...m.headers.map(([, v]) => v), ...(m.html ? htmlComments(m.html).flatMap((c) => [c, c.replace(/<[^>]*>/g, '')]) : [])]
  return { status: 'parsed', text: parts.join('\n\n'), facts: { nested, tooDeep: nested.some((n) => n.result.facts.tooDeep), signalTexts } }
}

/** Parse one attachment. `depth` counts nested messages (the outer attachment is depth 1). */
export async function runTask(kind: AttachmentKind, bytes: Buffer, limits: TaskLimits, depth = 1): Promise<TaskResult> {
  try {
    switch (kind) {
      case 'txt':
      case 'csv':
        return textResult(plainText(bytes))
      case 'pdf':
        return await pdf(bytes, limits.maxPdfPages)
      case 'docx':
        return { status: 'parsed', text: docxText(bytes), facts: {} }
      case 'xml': {
        // no currencies here: the pipeline applies the configured ones, so a configuration change needs no re-parse (Codex F13)
        const r = parsePacs008(plainText(bytes), [])
        return r.parsed ? { status: 'parsed', text: r.text, facts: { pacs008: { ...r, text: '' } } } : { status: 'not_parsed', reason: r.reason, text: '', facts: { pacs008: r } }
      }
      case 'eml':
        return await eml(bytes, limits, depth)
      default:
        return { status: 'not_parsed', reason: 'type', text: '', facts: {} }
    }
  } catch (e) {
    return fail(`error: ${(e as Error).message.slice(0, 200)}`)
  }
}
