// TC-REV-10 (PRD R-REV-02 v0.7.25, 界面规则 v0.3.4 §4): the Signals block lists the fired and the unchecked signals,
// folds the full list, and says «No warning signals» only when none fired — with how many could not be checked.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Signals } from './App.tsx'

type D = Array<{ signal: string; value: boolean | null; batch: string }>
const html = (details: D) => renderToStaticMarkup(createElement(Signals, { details }))
const visible = (h: string) => h.replace(/<details>[\s\S]*<\/details>/, '')
const ALL = ['auth_fail', 'untrusted_auth_header', 'display_name_mismatch', 'lookalike_domain', 'reply_to_mismatch', 'first_time_sender', 'hidden_text', 'injection_markers', 'message_id_collision']
/** every known signal checked and clean, then the given values on top */
const full = (set: Record<string, boolean | null> = {}): D => ALL.map((signal) => ({ signal, value: signal in set ? set[signal]! : false, batch: 'a' }))

describe('TC-REV-10 signals display', () => {
  it('fired signals as tags, the rest folded', () => {
    const h = html(full({ display_name_mismatch: true }))
    expect(visible(h)).toContain('<li class="tag sig-on">Display name matches a contact, address does not</li>')
    expect(visible(h)).not.toContain('Authentication failed')
    expect(visible(h)).not.toContain('No warning signals')
    expect(h).toContain('<summary>All signals (9)</summary>')
    expect(h).toContain('Authentication failed (SPF, DKIM or DMARC): no')
  })
  it('none fired, all checked: «No warning signals»', () => {
    const h = html(full())
    expect(visible(h)).toContain('<p class="meta">No warning signals</p>')
    expect(visible(h)).not.toContain('sig-')
  })
  it('none fired, some unchecked: they are listed and counted, never hidden', () => {
    const h = html(full({ auth_fail: null, lookalike_domain: null }))
    expect(visible(h)).toContain('No warning signals; 2 could not be checked')
    expect(visible(h)).toContain('<li class="tag sig-unknown">Authentication failed (SPF, DKIM or DMARC): could not be checked</li>')
    expect(visible(h)).toContain('Domain looks like a known contact domain: could not be checked')
  })
  it('fired and unchecked together: both listed, no «No warning signals»', () => {
    const h = html(full({ auth_fail: null, first_time_sender: true }))
    expect(visible(h)).toContain('sig-on')
    expect(visible(h)).toContain('sig-unknown')
    expect(visible(h)).not.toContain('No warning signals')
  })
  it('only the first batch written (processing, or failed before the content step): the rest are not checked (self-test F1)', () => {
    const h = html(full().filter((s) => s.signal !== 'hidden_text' && s.signal !== 'injection_markers'))
    expect(visible(h)).toContain('No warning signals; 2 could not be checked')
    expect(visible(h)).toContain('Instruction-like phrases in the mail: could not be checked')
    expect(h).toContain('Hidden text in the HTML: not checked')
    expect(h).toContain('<summary>All signals (9)</summary>')
  })
  it('no signals computed yet: says so, not «No warning signals»', () => {
    expect(html([])).toContain('No signals yet.')
    expect(html([])).not.toContain('No warning signals')
  })
})
