import { describe, expect, it } from 'vitest'
import { decodeMime, stripAttachments } from './mime.ts'
import { eml } from './testmail.ts'
import { smallPng } from './testimages.ts'

const limits = { maxAttachmentBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 }
const mail = (html = '<img src="cid:LoGo">') => eml({ html, attachments: [{ type: 'image/png', filename: 'logo.png', disposition: 'inline', contentId: '<logo>', content: smallPng() }] })
const eligible = (raw: Buffer) => decodeMime(raw, limits).attachments[0]!.inline.eligible
const change = (raw: Buffer, from: string, to: string) => Buffer.from(raw.toString().replace(from, to))

describe('TC-RED-11 MIME provenance and ordinals', () => {
  it('keeps RFC 2231 filenames without a second encoded-word decoding pass', () => {
    for (const value of ['filename="passport=?utf-8?Q?a?=.png"', "filename*=utf-8''passport%3D%3Futf-8%3FQ%3Fa%3F%3D.png"]) {
      const decoded = decodeMime(change(mail(), 'filename="logo.png"', value), limits)
      expect(decoded.attachments[0]!.filename).toBe('passport=?utf-8?Q?a?=.png')
    }
  })
  it('preserves legacy attachment identities during stripping and refuses a mismatched persisted hash', () => {
    const raw = eml({ attachments: [
      { type: 'text/plain', disposition: 'attachmentish', content: 'Legacy text' },
      { type: 'image/png', filename: 'passport.png', content: smallPng() },
      { type: 'text/plain', filename: 'notes.txt', content: 'Keep these notes' },
    ] })
    const legacy = decodeMime(raw, { ...limits, legacyOrdinals: true })
    expect(legacy.attachments.map((a) => a.filename)).toEqual(['', 'passport.png', 'notes.txt'])
    expect(decodeMime(raw, limits).attachments.map((a) => a.filename)).toEqual(['passport.png', 'notes.txt'])
    const stripped = stripAttachments(raw, new Set([1]), { legacyOrdinals: true, expectedHashes: new Map([[1, legacy.attachments[1]!.sha256!]]) })
    const after = decodeMime(stripped, { ...limits, legacyOrdinals: true })
    expect(after.attachments.map((a) => a.filename)).toEqual(['', 'removed', 'notes.txt'])
    // the placeholder says what it is, under the current name only (tech design v0.7.20)
    expect(stripped.toString('latin1')).toContain('\r\nX-Trunks-Removed: kyc\r\n')
    expect(after.attachments[2]!.content?.toString()).toBe('Keep these notes')
    expect(() => stripAttachments(raw, new Set([1]), { expectedHashes: new Map([[1, legacy.attachments[1]!.sha256!]]) })).toThrow('identity changed')
    expect(() => stripAttachments(raw, new Set([1]), { legacyOrdinals: true, expectedHashes: new Map([[1, '']]) })).toThrow('identity changed')
  })
  it('keeps all attachments and their ordinals when a referenced image exceeds the exception byte limit', () => {
    const image = Buffer.concat([smallPng(), Buffer.alloc(5 * 1024 * 1024)])
    const raw = eml({ html: '<img src="cid:large">', attachments: [
      { type: 'image/png', filename: 'passport.png', disposition: 'inline', contentId: '<large>', content: image },
      { type: 'text/plain', filename: 'notes.txt', content: 'Ordinary notes' },
    ] })
    const decoded = decodeMime(raw, { maxAttachmentBytes: 20 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 })
    expect(decoded.failure).toBeNull()
    expect(decoded.attachments.map((a) => a.filename)).toEqual(['passport.png', 'notes.txt'])
    expect(decoded.attachments[0]!.content?.equals(image)).toBe(true)
    expect(decoded.attachments[1]!.content?.toString()).toBe('Ordinary notes')
  })
  it('requires an external HTML body reference, unique raw headers and strict transfer decoding', () => {
    expect(eligible(mail())).toBe(true)
    expect(eligible(mail('<img src="cid:lo\0go">'))).toBe(false)
    for (const html of ['cid:logo', '<!-- <img src=cid:logo> -->', '<template><img src=cid:logo></template>', '<img src=cid:other>']) expect(eligible(mail(html))).toBe(false)
    for (const [from, to] of [
      ['Content-ID: <logo>', 'Content-ID: <logo>\r\nContent-ID: <other>'],
      ['Content-ID: <logo>', 'Content-ID: logo'],
      ['Content-ID: <logo>', 'Content-ID: <logo>\v'],
      ['Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: base64\v'],
      ['Content-ID: <logo>', 'Content-ID: =?utf-8?Q?<logo>?='],
      ['Content-Disposition: inline', 'Content-Disposition: unknown'],
      ['Content-Disposition: inline', 'Content-Disposition: inline\r\nContent-Disposition: inline'],
      ['Content-Disposition: inline', 'Content-Disposition: attachment'],
      ['iVBOR', '!iVBOR'],
    ] as const) expect(eligible(change(mail(), from, to)), to).toBe(false)
    expect(eligible(change(mail(), 'Content-Disposition: inline; filename="logo.png"\r\n', ''))).toBe(true)
    // Duplicate ids on root/multipart/body parts count too, even if one of those parts has multiple ids.
    for (const raw of [Buffer.concat([Buffer.from('Content-ID: <LOGO>\r\n'), mail()]), change(mail(), 'Content-Type: text/html', 'Content-ID: <logo>\r\nContent-Type: text/html')]) expect(eligible(raw)).toBe(false)
    expect(eligible(change(mail(), 'Content-ID: <logo>', 'cOnTeNt-Id: <logo>'))).toBe(true)
  })
  it('does not combine HTML parts or open attached messages; any MIME failure withholds the exception', () => {
    const raw = eml({ html: '<img src=cid:logo>', attachments: [{ type: 'message/rfc822', filename: 'forward.eml', content: mail() }, { type: 'image/png', filename: 'logo.png', contentId: '<logo>', disposition: 'inline', content: smallPng() }] })
    const decoded = decodeMime(raw, limits)
    expect(decoded.attachments).toHaveLength(2)
    expect(decoded.attachments[1]!.inline.eligible).toBe(true) // nested id is not part of the duplicate count
    const nestedOnly = eml({ text: 'see attached', attachments: [{ type: 'message/rfc822', filename: 'forward.eml', content: mail() }, { type: 'image/png', filename: 'logo.png', contentId: '<logo>', disposition: 'inline', content: smallPng() }] })
    expect(decodeMime(nestedOnly, limits).attachments[1]!.inline.eligible).toBe(false)
    const truncated = Buffer.from(mail().toString().replace(/--b-trunks-[^\r\n]+--\r\n$/, ''))
    expect(decodeMime(truncated, limits).failure).not.toBeNull()
    // B.1: empty disposition filename falls back to Content-Type name, and attachmentish is not attachment.
    const names = eml({ text: 'body', attachments: [{ type: 'text/plain', filename: 'name.txt', content: 'hello' }] })
    expect(decodeMime(change(names, 'filename="name.txt"', 'filename=""'), limits).attachments[0]!.filename).toBe('name.txt')
  })
})
