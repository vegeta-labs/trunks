import { describe, expect, it } from 'vitest'
import { contentId, htmlCidReferences, strictBase64 } from './inline-image.ts'

describe('TC-RED-11 appendix B.2–4', () => {
  it('checks Content-ID shape and strict base64 without silently dropping bad bytes', () => {
    expect(contentId(' \t<A@EXAMPLE>\r')).toBe('a@example')
    for (const s of ['a', '<>', '<a b>', '<a<b>', '<a>b>', '<é>', '<a>\v']) expect(contentId(s)).toBeNull()
    expect(strictBase64(' YQ==\r\n\t')).toEqual(Buffer.from('a'))
    for (const s of ['YQ', 'YQ===', '=YQ=', 'YQ==?', 'YQ==\v', 'YQ==YQ==']) expect(strictBase64(s)).toBeNull()
  })
  it('validates multi-megabyte base64 without exhausting the stack, while rejecting late bad bytes', () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 0x5a)
    const text = bytes.toString('base64')
    expect(strictBase64(text)?.equals(bytes)).toBe(true)
    expect(strictBase64(`${text.slice(0, -4)}?AAA`)).toBeNull()
    expect(strictBase64(`${text.slice(0, -4)}=AAA`)).toBeNull()
    for (const bad of ['====', 'A===', '=AAA', 'AA=A']) expect(strictBase64(bad)).toBeNull()
  })
  it('reads quoted/unquoted first src, HTML character references and percent escapes (plus is literal)', () => {
    expect([...htmlCidReferences('<img src="cid:lo\0go">')]).toEqual(['lo\0go'])
    expect([...htmlCidReferences(`<IMG/SrC = ' c&#105;d:Lo%67o+X ' src="cid:wrong"><img src=cid:a%40b><img src='cid:a&amp;b'>`)]).toEqual(['logo+x', 'a@b', 'a&b'])
    for (const ref of ['&#11;', '&#x0b;', '&#1;', '&#127;', '&#xFDD0;', '&#x10FFFF;']) expect([...htmlCidReferences(`<img src="cid:lo${ref}go">`)]).toEqual(['logo'])
    expect([...htmlCidReferences('<img src="cid:lo\vgo">')]).toEqual(['lo\vgo'])
    expect([...htmlCidReferences('<img src="cid:lo&#0;go">')]).toEqual(['lo\ufffdgo'])
    expect([...htmlCidReferences(`<![if !vml]><img src="cid:outlook"><![endif]><!--><img src="cid:short"><!---> <img src="cid:shorter">`)]).toEqual(['outlook', 'short', 'shorter'])
  })
  it('ignores comments, non-img tags, templates, raw text and incomplete attributes', () => {
    for (const tag of ['script', 'style', 'template', 'noscript', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'svg', 'math']) {
      expect([...htmlCidReferences(`<${tag}><img src="cid:bad"></${tag}><img src="cid:good">`)], tag).toEqual(['good'])
      expect([...htmlCidReferences(`<${tag}><img src="cid:bad">`)]).toEqual([])
    }
    for (const s of ['<!-- <img src="cid:bad"> -->', '<plaintext><img src=cid:bad>', '<image src=cid:bad>', '<img srcset=cid:bad>', '<img src="cid:bad>', '<!-- <img src=cid:bad>', '<img src=none src=cid:bad>']) expect([...htmlCidReferences(s)], s).toEqual([])
    expect([...htmlCidReferences('<script></script title="<img src=cid:bad>"><img src=cid:good>')]).toEqual(['good'])
  })
})
