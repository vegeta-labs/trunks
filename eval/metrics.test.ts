import { describe, expect, it } from 'vitest'
import { failures, fieldCorrect, score, type Annotation, type SystemOutput } from './metrics.ts'

const rule = { uetrs: [], uetr_candidates_invalid: [], amounts: [{ minor: 100, currency: 'GBP' }], references: ['NW-001'], account_last4: [], evidence_value_dates: [] }
const ann = (id: string, classes: string[], fields: Annotation['fields'] = {}): Annotation => ({ id, classes, fields, rule_output: rule })
const out = (id: string, adopted: string[], fields: SystemOutput['fields'] = {}, ruleOutput = rule): SystemOutput => ({ id, adopted, fields, ruleOutput })
const floors = { payment_query: 'medium', complaint: 'medium', bank_details: 'high', bank_letter_request: 'low', unclassified: 'medium' } as const

describe('PRD §6 E2 metrics', () => {
  it('classification macro F1 over classes whose floor is not high, with positives only', () => {
    const r = score(
      [ann('E1', ['payment_query']), ann('E2', ['payment_query', 'bank_details']), ann('E3', ['complaint'])],
      [out('E1', ['payment_query']), out('E2', ['complaint']), out('E3', ['complaint'])],
      floors,
    )
    // payment_query: tp 1, fn 1 → 2/3; complaint: tp 1, fp 1 → 2/3; bank_details (high) and bank_letter_request (no positives) not counted
    expect(Object.keys(r.classification.perClass).sort()).toEqual(['complaint', 'payment_query'])
    expect(r.classification.value).toBeCloseTo(2 / 3)
  })

  it('rule fields compare every list as a set; one missing item fails the sample', () => {
    const r = score([ann('E1', []), ann('E2', [])], [out('E1', [], {}, { ...rule, references: ['NW-001'] }), out('E2', [], {}, { ...rule, references: [] })], floors)
    expect(r.ruleFields).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 })
    expect(r.ruleFields.failures).toEqual([{ id: 'E2', item: 'references', expected: ['NW-001'], actual: [] }])
    // exact: a lower-case reference is not the imported one (EV-F4)
    expect(score([ann('E1', [])], [out('E1', [], {}, { ...rule, references: ['nw-001'] })], floors).ruleFields.value).toBe(0)
  })

  it('field comparison: money, text (NFKC, case, white space), sets, multiple, void, empty', () => {
    expect(fieldCorrect({ minor: 100, currency: 'GBP' }, { status: 'ok', value: { minor: 100, currency: 'GBP' }, candidates: [] })).toBe(true)
    expect(fieldCorrect('Amelia  Hart', { status: 'ok', value: 'amelia hart', candidates: [] })).toBe(true)
    expect(fieldCorrect(['passport', 'tax_id'], { status: 'ok', value: ['tax_id', 'passport', 'passport'], candidates: [] })).toBe(true)
    expect(fieldCorrect({ multiple: ['A', 'B'] }, { status: 'multiple', value: null, candidates: ['b', 'a'] })).toBe(true)
    expect(fieldCorrect({ multiple: ['A', 'B'] }, { status: 'multiple', value: null, candidates: ['A', 'C'] })).toBe(false)
    expect(fieldCorrect({ void: 'not I-01' }, { status: 'void', value: null, candidates: [] })).toBe(true)
    expect(fieldCorrect({ void: 'not I-01' }, { status: 'ok', value: 'x', candidates: [] })).toBe(false)
    expect(fieldCorrect({ void: 'not I-01' }, { status: 'ok', value: null, candidates: [] })).toBe(false)
    expect(fieldCorrect(null, { status: 'void', value: null, candidates: [] })).toBe(true) // no value given
    expect(fieldCorrect(null, { status: 'ok', value: 'x', candidates: [] })).toBe(false)
    expect(fieldCorrect('NW-001', { status: 'conflict', value: 'NW-001', candidates: [] })).toBe(true) // the adopted rule value
  })

  it('recall, precision and empty fields; a field the annotation lacks counts against precision only (PRD §6: «标注为 null 的字段»)', () => {
    const r = score(
      [ann('E1', ['payment_query'], { amount: { minor: 100, currency: 'GBP' }, payer_name: 'Amelia Hart', uetr: null })],
      [out('E1', ['payment_query'], {
        amount: { status: 'ok', value: { minor: 100, currency: 'GBP' }, candidates: [] },
        payer_name: { status: 'ok', value: 'Someone Else', candidates: [] },
        uetr: { status: 'ok', value: null, candidates: [] },
        deal: { status: 'ok', value: 'Northwind Robotics', candidates: [] },
      })],
      floors,
    )
    expect(r.fieldRecall).toMatchObject({ numerator: 1, denominator: 2 })
    // `deal` is not in the annotation: it counts against precision, not in the empty-field denominator
    expect(r.fieldPrecision).toMatchObject({ numerator: 1, denominator: 3 })
    expect(r.emptyFields).toMatchObject({ numerator: 1, denominator: 1 })
    expect(failures(r).join()).toMatch(/fieldRecall 0.500 < 0.9/)
  })

  it('a sample without system output fails rule fields even when nothing was to be extracted; thresholds are the PRD values', () => {
    const none = { uetrs: [], uetr_candidates_invalid: [], amounts: [], references: [], account_last4: [], evidence_value_dates: [] }
    const r = score([{ ...ann('E1', []), rule_output: none }], [], floors)
    expect(r.ruleFields).toMatchObject({ value: 0, numerator: 0, denominator: 1 })
    const at = (v: number) => ({ value: v, numerator: 0, denominator: 1 })
    const base = score([], [], floors)
    expect(failures({ ...base, classification: { ...base.classification, ...at(0.849) } })).toEqual(['classification 0.849 < 0.85'])
    expect(failures({ ...base, classification: { ...base.classification, ...at(0.85) } })).toEqual([])
    expect(failures({ ...base, fieldRecall: at(0.899), fieldPrecision: at(0.899), emptyFields: at(0.949), ruleFields: { ...base.ruleFields, ...at(0.999) } })).toHaveLength(4)
  })

  it('a metric with an empty denominator is not applicable and does not fail', () => {
    const r = score([], [], floors)
    expect(r.fieldRecall.value).toBeNull()
    expect(failures(r)).toEqual([])
  })
})
