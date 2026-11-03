// Codex E4 round 2 F13: the export keeps each node's own text apart from its nested parts' text.
import { describe, expect, it } from 'vitest'
import { exportChildren, ownText, type NestedFacts } from './kyc-export.ts'

describe('the C-RED-0 attachment export (test plan §3)', () => {
  it('TC-RED-04 a forwarded message whose body ends in «bank» and whose attachment holds «statement»: neither text carries the other', () => {
    const inner = 'statement for April'
    const outer = `Subject: fwd\nplease see the bank\n${inner}`
    const facts: NestedFacts = { nested: [{ filename: 'inner.eml', kind: 'eml', offset: outer.indexOf(inner), result: { status: 'parsed', text: inner, facts: {} } }] }
    expect(ownText(outer, facts)).toBe('Subject: fwd\nplease see the bank\n')
    expect(exportChildren(facts)).toEqual([{ filename: 'inner.eml', kind: 'eml', parse_status: 'ok', pdf_pages: null, pdf_pages_without_text: null, text: inner, children: [] }])
  })
  it('TC-RED-04 nested two levels: each level keeps only its own text', () => {
    const c2 = 'level two'
    const c1 = `level one\n${c2}`
    const top = `top\n${c1}`
    const facts: NestedFacts = { nested: [{ filename: 'a.eml', kind: 'eml', offset: 4, result: { status: 'parsed', text: c1, facts: { nested: [{ filename: 'b.eml', kind: 'eml', offset: 10, result: { status: 'parsed', text: c2, facts: {} } }] } } }] }
    expect(ownText(top, facts)).toBe('top\n')
    const [one] = exportChildren(facts) as Array<{ text: string; children: Array<{ text: string }> }>
    expect(one!.text).toBe('level one\n')
    expect(one!.children[0]!.text).toBe(c2)
  })
})
