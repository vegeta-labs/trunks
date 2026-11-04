// PRD appendix B.5: structural inspection only. No pixels are decoded or sent to a model.
export interface ImageFacts {
  format: 'png' | 'jpeg' | 'gif' | null
  width: number
  height: number
  bytes: number
  code: string // 'ok', or a fixed structural failure code
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const signatures = [Buffer.from('ffd8ff', 'hex'), Buffer.from('89504e47', 'hex'), Buffer.from('GIF8')]
const containsImage = (b: Buffer) => signatures.some((s) => b.includes(s))
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function pngCrc(b: Buffer): number {
  let c = 0xffffffff
  for (const v of b) c = crcTable[(c ^ v) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Malformed, unknown and uncovered structures always fail closed. Work is bounded by the input size. */
export function imageHeader(b: Buffer): ImageFacts {
  const out: ImageFacts = { format: null, width: 0, height: 0, bytes: b.length, code: 'unknown_format' }
  const bad = (code: string) => ({ ...out, code })
  const ok = () => out.width > 0 && out.height > 0 ? { ...out, code: 'ok' } : bad('zero_dimensions')
  if (b.subarray(0, 8).equals(PNG)) {
    out.format = 'png'
    const allowed = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'pHYs', 'bKGD', 'sBIT', 'tIME', 'tEXt', 'iTXt', 'eXIf', 'iDOT', 'cICP'])
    let p = 8, ihdr = 0, metadata = 0
    const idat: Buffer[] = []
    while (p < b.length) {
      if (p + 12 > b.length) return bad('png_truncated')
      const n = b.readUInt32BE(p), name = b.subarray(p + 4, p + 8).toString('latin1')
      if (n > b.length - p - 12) return bad('png_truncated')
      const data = b.subarray(p + 8, p + 8 + n)
      if (pngCrc(b.subarray(p + 4, p + 8 + n)) !== b.readUInt32BE(p + 8 + n)) return bad('png_crc')
      if (!allowed.has(name)) return bad('png_chunk')
      if (p === 8 && name !== 'IHDR') return bad('png_ihdr')
      if (name === 'IHDR') {
        if (++ihdr !== 1 || n !== 13) return bad('png_ihdr')
        out.width = data.readUInt32BE(0); out.height = data.readUInt32BE(4)
      }
      if (name === 'iDOT' && n !== 28 || name === 'cICP' && n !== 4) return bad('png_chunk_size')
      if (['tEXt', 'iTXt', 'eXIf', 'iCCP'].includes(name) && n > 16384) return bad('png_metadata_size')
      if (['tEXt', 'iTXt', 'eXIf'].includes(name)) {
        metadata += n
        if (metadata > 16384 || containsImage(data)) return bad('png_metadata')
      }
      if (name === 'iTXt') {
        const zero = data.indexOf(0)
        if (zero < 0 || zero + 2 >= n || data[zero + 1] === 1) return bad('png_itxt')
      }
      if (name === 'IDAT') idat.push(data)
      p += n + 12
      if (name === 'IEND') {
        if (p !== b.length) return bad('trailing_data')
        if (containsImage(Buffer.concat(idat))) return bad('embedded_image')
        return ok()
      }
    }
    return bad('png_no_iend')
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    out.format = 'jpeg'
    let p = 2, frames = 0, scans = 0, metadata = 0
    const compressed: Buffer[] = []
    while (p < b.length) {
      if (b[p++] !== 0xff) return bad('jpeg_marker')
      while (b[p] === 0xff) p++
      if (p >= b.length) return bad('jpeg_truncated')
      const m = b[p++]!
      if (m === 0xd9) {
        if (p !== b.length) return bad('trailing_data')
        if (frames !== 1 || scans === 0) return bad('jpeg_missing_frame_scan')
        if (containsImage(Buffer.concat(compressed))) return bad('embedded_image')
        return ok()
      }
      const sof = m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)
      const app = m >= 0xe0 && m <= 0xef
      if (!sof && !app && ![0xc4, 0xcc, 0xdb, 0xdd, 0xda, 0xfe].includes(m)) return bad('jpeg_marker')
      if (p + 2 > b.length) return bad('jpeg_truncated')
      const n = b.readUInt16BE(p)
      if (n < 2 || n > b.length - p) return bad('jpeg_segment_size')
      const data = b.subarray(p + 2, p + n)
      p += n
      if (sof) {
        if (++frames !== 1 || scans || data.length < 5) return bad('jpeg_frame')
        out.height = data.readUInt16BE(1); out.width = data.readUInt16BE(3)
      }
      if (app || m === 0xfe) {
        if (containsImage(data)) return bad('embedded_image')
        if (m === 0xe2 && data.subarray(0, 4).equals(Buffer.from('MPF\0'))) return bad('jpeg_mpf')
        const icc = m === 0xe2 && data.subarray(0, 12).equals(Buffer.from('ICC_PROFILE\0'))
        const xmp = m === 0xe1 && data.subarray(0, 29).equals(Buffer.from('http://ns.adobe.com/xap/1.0/\0'))
        if (data.length > (icc || xmp ? 16384 : 4096)) return bad('jpeg_metadata_size')
        if (!icc) metadata += data.length
        if (metadata > 16384) return bad('jpeg_metadata_total')
      }
      if (m === 0xda) {
        if (frames !== 1) return bad('jpeg_frame')
        scans++
        const start = p
        while (p < b.length) {
          if (b[p] !== 0xff) { p++; continue }
          if (p + 1 === b.length) return bad('jpeg_truncated')
          const next = b[p + 1]!
          if (next === 0 || next >= 0xd0 && next <= 0xd7) { p += 2; continue }
          if (next === 0xff) { p++; continue }
          break
        }
        compressed.push(b.subarray(start, p))
      }
    }
    return bad('jpeg_no_eoi')
  }
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'))) {
    out.format = 'gif'
    if (b.length < 13) return bad('gif_truncated')
    out.width = b.readUInt16LE(6); out.height = b.readUInt16LE(8)
    let p = 13, frames = 0
    if (b[10]! & 128) p += 3 * 2 ** ((b[10]! & 7) + 1)
    const blocks = (): Buffer[] | null => {
      const chunks: Buffer[] = []
      while (p < b.length) {
        const n = b[p++]!
        if (n === 0) return chunks
        if (n > b.length - p) return null
        chunks.push(b.subarray(p, p + n)); p += n
      }
      return null
    }
    while (p < b.length) {
      const tag = b[p++]!
      if (tag === 0x3b) return p === b.length ? ok() : bad('trailing_data')
      if (tag === 0x2c) {
        if (++frames !== 1 || p + 9 > b.length) return bad('gif_frame')
        const x = b.readUInt16LE(p), y = b.readUInt16LE(p + 2), w = b.readUInt16LE(p + 4), h = b.readUInt16LE(p + 6), flags = b[p + 8]!
        if (!w || !h || x + w > out.width || y + h > out.height) return bad('gif_frame')
        p += 9
        if (flags & 128) p += 3 * 2 ** ((flags & 7) + 1)
        if (p >= b.length) return bad('gif_truncated')
        p++ // LZW minimum code size; pixels are never decoded
        const chunks = blocks()
        if (!chunks) return bad('gif_truncated')
        if (containsImage(Buffer.concat(chunks))) return bad('embedded_image')
      } else if (tag === 0x21) {
        if (p >= b.length) return bad('gif_truncated')
        const label = b[p++]!
        if (![0xf9, 0xfe, 0xff, 0x01].includes(label)) return bad('gif_extension')
        const chunks = blocks()
        if (!chunks) return bad('gif_truncated')
        if (label === 0xf9) {
          if (chunks.length !== 1 || chunks[0]!.length !== 4) return bad('gif_control')
        } else {
          const data = Buffer.concat(chunks)
          if (data.length > 4096 || containsImage(data)) return bad('gif_metadata')
        }
      } else return bad('gif_block')
    }
    return bad('gif_no_trailer')
  }
  return out
}
