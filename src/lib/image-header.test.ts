import { describe, expect, it } from 'vitest'
import { imageHeader, pngCrc } from './image-header.ts'
import { inlineSignature, kycReason, type KycInput } from './kyc.ts'
import { jpegSegment, pngChunk, smallGif, smallJpeg, smallPng } from '../ingest/testimages.ts'

describe('TC-RED-11 appendix B.5 image structure', () => {
  it('accepts the three signatures and checks PNG CRC, complete structures and dimensions', () => {
    expect(pngCrc(Buffer.from('IEND'))).toBe(0xae426082)
    for (const b of [smallPng(), smallJpeg(), smallGif()]) expect(imageHeader(b)).toMatchObject({ code: 'ok', width: 120, height: 40, bytes: b.length })
    const corrupt = smallPng(); corrupt[29] = corrupt[29]! ^ 1
    expect(imageHeader(corrupt).code).toBe('png_crc')
    for (const b of [smallPng(), smallJpeg(), smallGif()]) {
      expect(imageHeader(Buffer.concat([b, Buffer.from([0])])).code).not.toBe('ok')
      for (let n = 0; n < b.length; n++) expect(imageHeader(b.subarray(0, n)).code, `truncated ${n}`).not.toBe('ok')
    }
    expect(imageHeader(smallPng(0, 40)).code).toBe('zero_dimensions')
    expect(imageHeader(smallPng(1280, 300))).toMatchObject({ width: 1280, height: 300 })
  })
  it('rejects PNG animation, unknown chunks, embedded signatures across IDAT, compressed text and excess metadata', () => {
    for (const [name, data] of [
      ['acTL', Buffer.alloc(8)], ['zTXt', Buffer.from('secret')], ['prIv', Buffer.alloc(0)], ['iDOT', Buffer.alloc(27)],
      ['tEXt', Buffer.from('GIF8')], ['eXIf', Buffer.from('ffd8ff', 'hex')], ['iTXt', Buffer.from([0x61, 0, 1, 0, 0, 0])], ['iCCP', Buffer.alloc(16385)],
    ] as const) expect(imageHeader(smallPng(120, 40, [pngChunk(name, data)])).code, name).not.toBe('ok')
    expect(imageHeader(smallPng(120, 40, [pngChunk('IDAT', Buffer.from([0x89, 0x50])), pngChunk('IDAT', Buffer.from([0x4e, 0x47]))])).code).toBe('embedded_image')
    expect(imageHeader(smallPng(120, 40, [pngChunk('tEXt', Buffer.alloc(8192)), pngChunk('eXIf', Buffer.alloc(8192))])).code).toBe('ok')
    expect(imageHeader(smallPng(120, 40, [pngChunk('tEXt', Buffer.alloc(8192)), pngChunk('eXIf', Buffer.alloc(8193))])).code).not.toBe('ok')
    expect(imageHeader(smallPng(120, 40, [pngChunk('iDOT', Buffer.alloc(28)), pngChunk('cICP', Buffer.alloc(4))])).code).toBe('ok')
  })
  it('rejects JPEG thumbnails, MPF, extra frames, DNL, unknown markers, missing SOS and oversized APP totals', () => {
    for (const seg of [jpegSegment(0xe1, Buffer.from('ffd8ff', 'hex')), jpegSegment(0xe2, Buffer.from('MPF\0')), jpegSegment(0xdc, Buffer.alloc(2)), jpegSegment(0xc0, Buffer.from([8, 0, 40, 0, 120])), jpegSegment(0xe0, Buffer.alloc(4097))]) {
      expect(imageHeader(smallJpeg([seg])).code).not.toBe('ok')
    }
    expect(imageHeader(smallJpeg(Array.from({ length: 4 }, () => jpegSegment(0xfe, Buffer.alloc(4096))))).code).toBe('ok')
    expect(imageHeader(smallJpeg([...Array.from({ length: 4 }, () => jpegSegment(0xfe, Buffer.alloc(4096))), jpegSegment(0xfe, Buffer.alloc(1))])).code).toBe('jpeg_metadata_total')
    const icc = Buffer.concat([Buffer.from('ICC_PROFILE\0'), Buffer.alloc(16372)])
    expect(imageHeader(smallJpeg([jpegSegment(0xe2, icc)])).code).toBe('ok')
    const xmp = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.alloc(5000)])
    expect(imageHeader(smallJpeg([jpegSegment(0xe1, xmp)])).code).toBe('ok')
    expect(imageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xd9])).code).not.toBe('ok')
  })
  it('rejects GIF multiple frames, a frame outside its canvas, hidden data and malformed control extensions', () => {
    const g = smallGif()
    expect(imageHeader(Buffer.concat([g.subarray(0, -1), g.subarray(13)])).code).toBe('gif_frame')
    const wide = Buffer.from(g); wide.writeUInt16LE(121, 18)
    expect(imageHeader(wide).code).toBe('gif_frame')
    for (const ext of [Buffer.from([0x21, 0xfe, 4, 0x47, 0x49, 0x46, 0x38, 0]), Buffer.from([0x21, 0xf9, 3, 0, 0, 0, 0]), Buffer.from([0x21, 0x22, 0])]) {
      expect(imageHeader(Buffer.concat([g.subarray(0, 13), ext, g.subarray(13)])).code).not.toBe('ok')
    }
  })
})

describe('TC-RED-11 signature exception and hard boundaries', () => {
  const image = (b = smallPng()): KycInput => ({ filename: 'logo.png', kind: 'image', parseStatus: 'not_parsed', scanStatus: 'clean', text: '', facts: null,
    inline: { contentId: 'logo', disposition: 'inline', htmlReferenced: true, eligible: true }, imageFacts: imageHeader(b) })
  it('only a clean, complete, referenced inline image skips both image and not-parsed rules', () => {
    expect(kycReason(image())).toBeNull()
    expect(inlineSignature(image())).toBe(true)
    for (const patch of [{ filename: 'passport.png' }, { scanStatus: 'infected' }, { parseStatus: 'over_limit' }, { inline: null }, { imageFacts: null }, { kind: 'other' }]) {
      expect(kycReason({ ...image(), ...patch })).not.toBeNull()
    }
    expect(kycReason(image(smallPng(401, 150)))).toBe('image')
    expect(kycReason(image(smallPng(400, 151)))).toBe('image')
    expect(kycReason({ ...image(smallPng(1280, 300)), inlineLimits: { max_long_side: 1280, max_short_side: 300, max_bytes: 102400 } })).toBeNull()
    expect(kycReason({ ...image(), imageFacts: { ...imageHeader(smallPng()), bytes: 51201 } })).toBe('image')
    expect(kycReason({ ...image(), kind: 'txt' })).toBe('not_checked:not_parsed')
  })
})
