import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { caseStatus, displayName, editInput, editValue, optionText, plainProblems, problemText, riskReasonText, transferText } from './presentation.ts'
import { CLASS_FIELDS_KNOWN } from '../config/constants.ts'
import { computeRisk } from '../lib/risk.ts'
import { checkValue, ENUMS, KIND, type FieldContext } from '../lib/fields.ts'

describe('TC-DEMO-05 attachment transfer states', () => {
  it('never turns failures, manual handling or pending work into a successful transfer', () => {
    for (const demo of [true, false]) {
      expect(transferText({ state: 'failed', error: 'infected', removed: false }, demo)).toBe('Blocked by the virus scan; not transferred')
      expect(transferText({ state: 'failed', error: 'timeout', removed: false }, demo)).toBe('Transfer failed (timeout)')
      expect(transferText({ state: 'pending', error: null, removed: false }, demo)).toBe('Transfer pending')
      expect(transferText({ state: 'discarded', error: null, removed: true }, demo)).toBe('Blocked by the virus scan; handled manually; removed from this system')
      expect(transferText({ state: 'discarded', error: null, removed: false }, demo)).toBe('Blocked by the virus scan; handled manually')
      expect(transferText({ state: 'delivered', error: null, removed: true }, demo)).toBe('Transferred; removed from this system')
    }
    expect(transferText({ state: 'delivered', error: null, removed: false }, true)).toBe('Recorded transfer: completed')
    expect(transferText({ state: 'delivered', error: null, removed: false }, false)).toBe('Transferred; removal pending')
    expect(transferText({ state: 'new_state', error: null, removed: false }, true)).toBe('Transfer state: new_state')
  })
  it('retains unknown IDs and distinguishes manual send status', () => {
    expect(displayName('future_class')).toBe('future_class')
    expect(caseStatus('sent')).toBe('Marked as sent')
    expect(caseStatus('future_status')).toBe('future_status')
  })
})

describe('TC-REV-15 no internal codes on the page', () => {
  const ids = (file: string) => [...readFileSync(`config/default/${file}`, 'utf8').matchAll(/^  - \{? ?id: (\w+)/gm)].map((m) => m[1]!)
  it('every known field, class and template has a label', () => {
    expect(ids('cases.yaml').length).toBeGreaterThan(10)
    expect(ids('templates.yaml').length).toBeGreaterThan(10)
    for (const id of [...CLASS_FIELDS_KNOWN, ...ids('cases.yaml'), ...ids('templates.yaml')]) expect(displayName(id), id).not.toBe(id)
    expect(displayName('uetr')).toBe('Payment tracking reference (UETR)')
  })
  it('every risk reason has a sentence, the beneficiary mismatch included', () => {
    const { clauses } = computeRisk({ classes: [{ id: 'x', risk_floor: 'low' }] as never, labels: ['x'], signals: {}, accountPresent: false, uetrCandidatesInvalid: 0, amountsBody: [], amountsAttachment: [], attachmentBlockedOrOverLimit: false, pressure: false, plannedCloseDate: null, receivedDate: '2026-10-29', holidays: new Set() })
    expect(clauses.length).toBeGreaterThan(10)
    for (const { id } of clauses) expect(riskReasonText(id), id).not.toBe(id)
    expect(riskReasonText('C-RSK-2:evidence_beneficiary_mismatch')).toBe('The beneficiary account in the payment message is not a receiving account on file')
  })
  it('problem codes read as sentences, in a list and inside a refusal', () => {
    expect(problemText('internal_terms:suspicious|flag')).toBe('Internal wording not allowed in a reply: suspicious, flag')
    expect(problemText('no_recipient')).toBe('No recipient')
    expect(plainProblems('cannot approve: internal_terms:suspicious; no_recipient; the content changed')).toBe('cannot approve: Internal wording not allowed in a reply: suspicious; No recipient; the content changed')
    expect(plainProblems('placeholder_left and recipient_not_allowed')).toBe('A value is missing and This recipient is not allowed')
    expect(plainProblems('nothing to translate')).toBe('nothing to translate')
    expect(plainProblems('cannot approve: internal_terms:no_recipient')).toBe('cannot approve: Internal wording not allowed in a reply: no_recipient')
  })
})

describe('TC-REV-18 a person can edit yes/no and list fields', () => {
  const ctx: FieldContext = {
    modelText: '', currencies: ['GBP'], platforms: [], deals: [], restore: (t) => t,
    rules: { uetrs: [], amounts: [], evidenceAmounts: [], references: [], accountLast4: [], valueDates: [] },
  }
  it('offers the input of each field kind and sends a value the server check accepts', () => {
    const booleans = Object.keys(KIND).filter((f) => KIND[f] === 'boolean')
    const lists = Object.keys(KIND).filter((f) => KIND[f] === 'enums')
    expect(booleans).toContain('change_requested')
    expect(lists).toEqual(expect.arrayContaining(['document_types', 'change_fields']))
    for (const f of booleans) {
      const input = editInput(f)
      expect(input).toEqual({ kind: 'boolean' })
      expect(editValue(input, 'true', [])).toBe(true)
      expect(editValue(input, 'false', [])).toBe(false)
      expect(editValue(input, '', [])).toBeNull()
      for (const v of [true, false]) expect(checkValue(f, editValue(input, String(v), []) as boolean, ctx)).toEqual({ ok: true, value: v })
    }
    for (const f of lists) {
      const input = editInput(f)
      expect(input).toEqual({ kind: 'list', options: ENUMS[f] })
      if (input.kind !== 'list') throw new Error('not a list')
      const picked = [input.options[2]!, input.options[0]!]
      const sent = editValue(input, '', picked)
      expect(sent).toEqual([input.options[0], input.options[2]])
      expect(checkValue(f, sent as string[], ctx)).toEqual({ ok: true, value: sent })
      expect(editValue(input, '', [])).toBeNull()
      for (const o of input.options) expect(optionText(o)).toMatch(/^[A-Z][^_]*$/)
    }
    expect(optionText('tax_id')).toBe('Tax ID')
    expect(optionText('proof_of_address')).toBe('Proof of address')
  })
  it('keeps typed text for the other fields', () => {
    for (const f of Object.keys(KIND).filter((x) => !['boolean', 'enum', 'enums'].includes(KIND[x]!))) expect(editInput(f)).toEqual({ kind: 'text' })
    expect(editValue({ kind: 'text' }, '  GBP ', [])).toBe('GBP')
    expect(editValue({ kind: 'text' }, '   ', [])).toBeNull()
  })
})

describe('TC-REV-19 a person chooses a single-choice field from its allowed values', () => {
  const ctx: FieldContext = {
    modelText: '', currencies: ['GBP'], platforms: [], deals: [], restore: (t) => t,
    rules: { uetrs: [], amounts: [], evidenceAmounts: [], references: [], accountLast4: [], valueDates: [] },
  }
  it('offers exactly the allowed values of every single-choice field, and each one passes the server check', () => {
    const choices = Object.keys(KIND).filter((f) => KIND[f] === 'enum')
    expect(choices).toEqual(expect.arrayContaining(['party_role', 'entity_type', 'confirms', 'subtype']))
    expect(choices).toHaveLength(Object.keys(ENUMS).length - 2)
    for (const f of choices) {
      const input = editInput(f)
      expect(input).toEqual({ kind: 'choice', options: ENUMS[f] })
      if (input.kind !== 'choice') throw new Error('not a choice')
      for (const o of input.options) {
        expect(editValue(input, o, [])).toBe(o)
        expect(checkValue(f, editValue(input, o, []) as string, ctx)).toEqual({ ok: true, value: o })
        expect(optionText(o)).toMatch(/^[A-Z][^_]*$/)
      }
      expect(editValue(input, '', [])).toBeNull()
      expect(editValue(input, 'not_an_option', [])).toBeNull()
    }
    expect(optionText('us_person')).toBe('US person')
    expect(optionText('seis')).toBe('SEIS')
  })
})
