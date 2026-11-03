// DOCX text only (PRD C-ING-2): read word/document.xml from the zip and keep the text runs. Macros and embedded
// objects are never opened. Inflated size is capped (zip bombs).
import { inflateRawSync } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'

const MAX_XML_BYTES = 50 * 1024 * 1024

interface Entry {
  name: string
  method: number
  compSize: number
  size: number
  localOffset: number
}

function entries(zip: Buffer): Entry[] {
  // end of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const out: Entry[] = []
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory')
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    out.push({
      method: zip.readUInt16LE(p + 10),
      compSize: zip.readUInt32LE(p + 20),
      size: zip.readUInt32LE(p + 24),
      localOffset: zip.readUInt32LE(p + 42),
      name: zip.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function read(zip: Buffer, e: Entry): Buffer {
  const h = e.localOffset
  if (zip.readUInt32LE(h) !== 0x04034b50) throw new Error('bad zip entry')
  const start = h + 30 + zip.readUInt16LE(h + 26) + zip.readUInt16LE(h + 28)
  const data = zip.subarray(start, start + e.compSize)
  if (e.method === 0) return data
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES })
  throw new Error(`unsupported zip method ${e.method}`)
}

// WordprocessingML, transitional and strict
const W = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])

type Node = Record<string, unknown> & { ':@'?: Record<string, string> }
const nameOf = (n: Node) => Object.keys(n).find((k) => k !== ':@')!

/**
 * Text of the main document part: paragraphs on new lines, tabs and breaks kept. Elements are matched by namespace URI
 * and local name, whatever prefix the file binds (Codex F5).
 */
export function docxText(zip: Buffer): string {
  const doc = entries(zip).find((e) => e.name === 'word/document.xml')
  if (!doc) throw new Error('no word/document.xml')
  const xml = read(zip, doc).toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD in document.xml')
  const tree = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, processEntities: true, htmlEntities: false, trimValues: false }).parse(xml, true) as Node[]
  let out = ''
  const walk = (nodes: Node[], scope: Record<string, string>) => {
    for (const n of nodes) {
      const name = nameOf(n)
      if (name === '#text') continue
      if (name.startsWith('?')) continue
      const sc = { ...scope }
      for (const [k, v] of Object.entries(n[':@'] ?? {})) {
        if (k === '@_xmlns') sc[''] = v
        else if (k.startsWith('@_xmlns:')) sc[k.slice(8)] = v
      }
      const i = name.indexOf(':')
      const ns = sc[i < 0 ? '' : name.slice(0, i)] ?? ''
      const local = name.slice(i + 1)
      const kids = n[name] as Node[]
      if (W.has(ns) && local === 't') {
        out += kids.filter((c) => '#text' in c).map((c) => String(c['#text'])).join('')
        continue
      }
      if (W.has(ns) && local === 'tab') out += '\t'
      if (W.has(ns) && (local === 'br' || local === 'cr')) out += '\n'
      walk(kids, sc)
      if (W.has(ns) && local === 'p') out += '\n'
    }
  }
  walk(tree, {})
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
