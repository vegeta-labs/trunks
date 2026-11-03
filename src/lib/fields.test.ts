import { describe, expect, it } from 'vitest'
import { checkValue, DEFAULT_CLASS_FIELDS, fieldSchema, fieldsFor, modelFields, resolveField, resolveFields, type FieldContext } from './fields.ts'

const U1 = 'eb6305c9-1f7f-49de-aed0-16487c27b42d'
const U2 = '0f3c9a2e-5b1d-4c8e-9a7f-2d6e8b1c4a90'
const text = `<email><body>[NAME_1] [NAME_2] here. I paid £10,000.00 on 23 Oct 2026, ref NW-001, UETR ${U2}. Deal: [NAME_1] [NAME_2] SPV. Also 10,000 more.</body></email>`
const ctx = (over: Partial<FieldContext> = {}): FieldContext => ({
  modelText: text,
  currencies: ['GBP', 'EUR', 'USD'],
  platforms: ['DocuSign'],
  deals: [{ id: 'd-1', name: 'Northwind Robotics' }, { id: 'd-2', name: 'Amelia Hart SPV' }],
  restore: (s) => s.replace('[NAME_1]', 'Amelia').replace('[NAME_2]', 'Hart'),
  rules: { uetrs: [], amounts: [{ minor: 1000000, currency: 'GBP' }], evidenceAmounts: [], references: ['NW-001'], accountLast4: [], valueDates: [] },
  ...over,
})
const f = (value: unknown, quote: string, confidence: 'high' | 'medium' | 'low' = 'high') => ({ value: value as string, quote, confidence })

describe('C-FLD field extraction', () => {
  it('the default field tables are exactly PRD §3.1', async () => {
    const { classFields } = await import('../../eval/validate.ts')
    expect(Object.fromEntries(classFields())).toEqual(DEFAULT_CLASS_FIELDS)
  })

  it('field lists follow the adopted classes; account_last4 is never asked from the model; the schema accepts candidates', () => {
    expect(fieldsFor(['payment_query', 'bank_details'])).toEqual(['amount', 'currency', 'payment_date', 'payer_name', 'reference', 'uetr', 'party_role', 'account_last4', 'change_requested'])
    expect(fieldsFor(['closing_confirmation', 'kyc_documents'])).toEqual(['confirms', 'deal', 'document_types', 'entity_type'])
    expect(modelFields(fieldsFor(['bank_details']))).toEqual(['party_role', 'change_requested'])
    const s = fieldSchema(['deal'])
    expect(s.safeParse({ fields: { deal: { value: { candidates: [{ value: 'A', quote: 'a' }, { value: 'B', quote: 'b' }] }, confidence: 'medium', quote: '' } } }).success).toBe(true)
    expect(s.safeParse({ fields: { amount: { value: 'x', confidence: 'high', quote: 'x' } } }).success).toBe(false) // a field outside the list
  })

  it('TC-FLD-01 a model UETR different from the rule UETR → the rule value, marked conflict', () => {
    const r = resolveField('uetr', f(U2, U2), ctx({ rules: { ...ctx().rules, uetrs: [U1] } }))
    expect(r).toMatchObject({ status: 'conflict', value: U1, needsConfirmation: true })
    expect(resolveField('uetr', f(U2, U2), ctx({ rules: { ...ctx().rules, uetrs: [U2] } }))).toMatchObject({ status: 'ok', value: U2, source: 'merged' })
    expect(resolveField('uetr', undefined, ctx({ rules: { ...ctx().rules, uetrs: [U1] } }))).toMatchObject({ status: 'ok', value: U1, source: 'rule' })
  })

  it('TC-FLD-02 an amount without a currency fails validation and is shown yellow', () => {
    expect(resolveField('amount', f('10,000', '10,000'), ctx())).toMatchObject({ status: 'void', value: null, invalid: true, needsConfirmation: true })
    expect(resolveField('amount', f('£15k', 'here'), ctx({ modelText: 'here' }))).toMatchObject({ status: 'void', needsConfirmation: true })
    expect(resolveField('amount', f('£10,000.00', '£10,000.00'), ctx())).toMatchObject({ value: { minor: 1000000, currency: 'GBP' }, needsConfirmation: false })
    expect(resolveField('amount', f('£10,000.00', '£10,000.00', 'low'), ctx()).needsConfirmation).toBe(true) // C-FLD-2
  })

  it('TC-FLD-03 enum outside §5.5a, deal not in the directory, reference not matched → invalid or void', () => {
    expect(resolveField('confirms', f('maybe', 'here'), ctx())).toMatchObject({ status: 'void', invalid: true, value: null })
    expect(resolveField('deal', f('Acme SPV', 'here'), ctx())).toMatchObject({ status: 'void' })
    const noRefs = ctx({ rules: { ...ctx().rules, references: [] } })
    expect(resolveField('reference', f('NW-999', 'ref NW-001'), noRefs)).toMatchObject({ status: 'void' })
    // a matched reference found by the rules wins over an unmatched model value
    expect(resolveField('reference', f('NW-999', 'ref NW-001'), ctx())).toMatchObject({ status: 'ok', value: 'NW-001', source: 'rule' })
    expect(resolveField('reference', f('nw 001', 'ref NW-001'), ctx())).toMatchObject({ status: 'ok', value: 'NW-001' })
    // C-EXT-2 inside the model's value: extra words around the reference
    for (const v of ['NW-001 FERNANDEZ', '/ROC/NW-001', 'NW 001 1/2']) expect(resolveField('reference', f(v, 'ref NW-001'), noRefs).status, v).toBe('void')
    const one = ctx({ rules: { ...ctx().rules, references: ['NW-001'] } })
    for (const v of ['NW-001 FERNANDEZ', '/ROC/NW-001']) expect(resolveField('reference', f(v, 'ref NW-001'), one), v).toMatchObject({ status: 'ok', value: 'NW-001' })
    // C-RED-2: the placeholders were in the model's text, so only the account / ID rule can void them
    const secrets = ctx({ modelText: 'here [ACCOUNT_1] [SORTCODE_2] [ID_1] [DOB_3]' })
    for (const v of ['[ACCOUNT_1]', '[SORTCODE_2]', 'Hart [ID_1]', '[DOB_3]']) expect(resolveField('payer_name', f(v, 'here'), secrets), v).toMatchObject({ status: 'void', reason: 'account or ID placeholder in a value' })
  })

  it('rules win over a model value that fails validation (an MT103 date as written); an amount equal by value to one amount of the mail', () => {
    const vd = ctx({ rules: { ...ctx().rules, valueDates: ['2026-10-30'] } })
    // the MT103 way of writing the same value date is that date, not an invalid value (owner acceptance)
    expect(resolveField('value_date', f('261030', 'here'), { ...vd, modelText: 'here' })).toMatchObject({ status: 'ok', value: '2026-10-30', source: 'merged', needsConfirmation: false })
    expect(resolveField('value_date', f('261031', 'here'), { ...vd, modelText: 'here' })).toMatchObject({ status: 'ok', value: '2026-10-30', source: 'rule', needsConfirmation: true })
    expect(resolveField('payment_date', f('261030', 'here'), { ...vd, modelText: 'here' })).toMatchObject({ status: 'void', invalid: true })
    const amt = ctx({ rules: { ...ctx().rules, amounts: [{ minor: 600000, currency: 'GBP' }], evidenceAmounts: [{ minor: 600000, currency: 'GBP' }] }, modelText: ':32A:261029GBP6000,00' })
    expect(resolveField('amount', f('6000,00', ':32A:261029GBP6000,00'), amt)).toMatchObject({ status: 'ok', value: { minor: 600000, currency: 'GBP' } })
    expect(resolveField('amount', f('GBP6000,00', ':32A:261029GBP6000,00'), amt)).toMatchObject({ status: 'ok', value: { minor: 600000, currency: 'GBP' } })
    expect(resolveField('amount', f('7000,00', ':32A:261029GBP6000,00'), amt)).toMatchObject({ status: 'void', invalid: true }) // no such amount in the mail
    // CF-F5: the as-written form only for an MT103 / pacs.008 amount; equal to a free-text amount is still invalid
    const free = ctx({ rules: { ...ctx().rules, amounts: [{ minor: 100050, currency: 'GBP' }] }, modelText: 'paid £1,000.50' })
    expect(resolveField('amount', f('1000,50', 'paid £1,000.50'), free)).toMatchObject({ status: 'void', invalid: true, needsConfirmation: true })
  })

  it('C-FLD-1 one value per field: two amounts, two dates or a valid UETR beside an invalid one fail validation', () => {
    const t = ctx({ modelText: 'here' })
    expect(checkValue('amount', '£10,000.00 or £5,000.00', t)).toMatchObject({ ok: false, void: false })
    expect(checkValue('payment_date', '23 Oct 2026 or 24 Oct 2026', t)).toMatchObject({ ok: false, void: false })
    expect(checkValue('uetr', `${U2} ${U2.slice(0, 14)}0${U2.slice(15)}`, t)).toMatchObject({ ok: false, void: false })
    expect(checkValue('uetr', U2, t)).toMatchObject({ ok: true, value: U2 })
  })

  it('S2 an account placeholder in one candidate voids the field; S3 an invalid model UETR beside the rule one is a conflict', () => {
    const c = { value: { candidates: [{ value: '[ACCOUNT_1]', quote: 'here' }, { value: '[NAME_1]', quote: 'here' }] }, confidence: 'high' as const, quote: '' }
    expect(resolveField('payer_name', c, ctx({ modelText: 'here [ACCOUNT_1] [NAME_1]' }))).toMatchObject({ status: 'void', value: null })
    const withRule = ctx({ rules: { ...ctx().rules, uetrs: [U1] }, modelText: `here [ACCOUNT_1] ${U1}` })
    // the rule value stands; the rejected placeholder keeps the field yellow, with its reason (Codex E2 round 4 F22)
    expect(resolveField('uetr', f('[ACCOUNT_1]', 'here'), withRule)).toMatchObject({ status: 'ok', value: U1, source: 'rule', needsConfirmation: true, reason: 'account or ID placeholder in a value' })
    const both = { value: { candidates: [{ value: U1, quote: U1 }, { value: '[ACCOUNT_1]', quote: '[ACCOUNT_1]' }] }, confidence: 'high' as const, quote: '' }
    expect(resolveField('uetr', both, withRule)).toMatchObject({ status: 'ok', value: U1, needsConfirmation: true, reason: 'account or ID placeholder in a value' })
    const v1 = `${U1.slice(0, 14)}1${U1.slice(15)}` // version digit 1: not a valid UETR
    expect(resolveField('uetr', f(v1, 'here'), withRule)).toMatchObject({ status: 'conflict', value: U1, needsConfirmation: true })
  })

  it('hostile model output (G2 step 0): __proto__ / constructor keys and extra keys are not the schema', () => {
    const s = fieldSchema(['amount'])
    for (const raw of ['{"fields":{"__proto__":{"value":"x","confidence":"high","quote":"q"}}}', '{"fields":{"constructor":{"value":"x","confidence":"high","quote":"q"}}}', '{"__proto__":{"x":1},"fields":{}}', '{"fields":{"amount":{"value":"£1.00","confidence":"high","quote":"q","adopted":true}}}']) {
      expect(s.safeParse(JSON.parse(raw)).success, raw).toBe(false)
    }
    expect(({} as Record<string, unknown>).value).toBeUndefined() // nothing leaked onto Object.prototype
  })

  it('MN-F2 a mail without any amount token cannot confirm a model amount: conflict, no value, yellow', () => {
    expect(resolveField('amount', f('£15,000.00', 'about 15k'), ctx({ modelText: 'about 15k', rules: { ...ctx().rules, amounts: [] } }))).toMatchObject({ status: 'conflict', value: null, needsConfirmation: true })
  })

  it('CF-F6 a low-confidence value is yellow even when the rules agree', () => {
    const r = resolveField('uetr', f(U2, U2, 'low'), ctx({ rules: { ...ctx().rules, uetrs: [U2] } }))
    expect(r).toMatchObject({ status: 'ok', value: U2, needsConfirmation: true })
  })

  it('MN-F3 candidates whose quotes are all fabricated are void, as a single value is', () => {
    const c = { value: { candidates: [{ value: 'Amelia Hart', quote: 'not there' }, { value: 'B Hart', quote: 'nor this' }] }, confidence: 'high' as const, quote: '' }
    expect(resolveField('payer_name', c, ctx())).toMatchObject({ status: 'void', value: null })
  })

  it('MN-F4 a placeholder the model was not given voids the value (it would be restored in the review UI)', () => {
    expect(resolveField('payer_name', f('[NAME_7]', 'here'), ctx({ modelText: 'here' }))).toMatchObject({ status: 'void', reason: expect.stringMatching(/placeholder/) })
    expect(resolveField('payer_name', f('[NAME_1] [NAME_2]', '[NAME_1] [NAME_2] here'), ctx())).toMatchObject({ status: 'ok', value: '[NAME_1] [NAME_2]' })
  })

  it('C-FLD-0 several rule values → multiple, the candidates of both sides', () => {
    const two = ctx({ rules: { ...ctx().rules, uetrs: [U1, U2] } })
    expect(resolveField('uetr', undefined, two)).toMatchObject({ status: 'multiple', candidates: [U1, U2], source: 'rule' })
    const one = ctx({ rules: { ...ctx().rules, references: ['NW-001', 'NW-002'] } })
    const r = resolveField('reference', f('NW-001', 'ref NW-001'), one)
    expect(r).toMatchObject({ status: 'multiple', source: 'merged' })
    expect(r.candidates).toEqual(['NW-001', 'NW-002'])
    // the model side adds a value the rules did not find
    const u = resolveField('uetr', { value: { candidates: [{ value: U2, quote: U2 }, { value: U1, quote: 'here' }] }, confidence: 'medium', quote: '' }, ctx({ modelText: `${text} here`, rules: { ...ctx().rules, uetrs: [U2] } }))
    expect(u.status).toBe('multiple')
    expect(new Set(u.candidates)).toEqual(new Set([U1, U2]))
  })

  it('TC-FLD-04 a quote that is not in the text given to the model voids the field', () => {
    expect(resolveField('amount', f('£10,000.00', 'I paid ten thousand pounds'), ctx())).toMatchObject({ status: 'void', value: null })
    // white space may differ (line breaks), the characters may not
    expect(resolveField('amount', f('£10,000.00', 'I paid   £10,000.00\non 23 Oct'), ctx()).value).toEqual({ minor: 1000000, currency: 'GBP' })

    // an empty or white-space-only quote proves nothing (v0.7.16, Codex E2 re-run F4); a void field is yellow (F8)
    for (const q of ['', '   ', '\n']) expect(resolveField('amount', f('£10,000.00', q), ctx()), JSON.stringify(q)).toMatchObject({ status: 'void', needsConfirmation: true })
    expect(resolveField('deal', f('Unknown Deal', 'Paid'), ctx({ modelText: 'Paid' }))).toMatchObject({ status: 'void', needsConfirmation: true })
  })
  it('TC-FLD-05 (Codex E2 re-run F6) several model amounts are checked against the mail one by one', () => {
    const none = ctx({ modelText: 'Paid', rules: { ...ctx().rules, amounts: [] } })
    const many = { value: { candidates: [{ value: '£99', quote: 'Paid' }, { value: '£100', quote: 'Paid' }] }, confidence: 'high' as const, quote: '' }
    expect(resolveField('amount', many, none)).toMatchObject({ status: 'conflict', value: null, needsConfirmation: true })
    const one = ctx({ modelText: 'Paid', rules: { ...ctx().rules, amounts: [{ minor: 9900, currency: 'GBP' }] } })
    expect(resolveField('amount', many, one)).toMatchObject({ status: 'conflict', value: { minor: 9900, currency: 'GBP' } })
    // round 2 F12: one pick in the mail, one not, two rule amounts → conflict without a value; three picks, one invented → conflict
    const two = ctx({ modelText: '£100 and £200. Paid', rules: { ...ctx().rules, amounts: [{ minor: 10000, currency: 'GBP' }, { minor: 20000, currency: 'GBP' }] } })
    const mixed = (vals: string[]) => ({ value: { candidates: vals.map((v) => ({ value: v, quote: v === '£999' ? 'Paid' : v })) }, confidence: 'high' as const, quote: '' })
    expect(resolveField('amount', mixed(['£100', '£999']), two)).toMatchObject({ status: 'conflict', value: null })
    expect(resolveField('amount', mixed(['£100', '£200', '£999']), two)).toMatchObject({ status: 'conflict', value: null })
    // round 2 F13: an invalid candidate beside a valid one keeps the field yellow
    const hundred = ctx({ modelText: 'Paid £100', rules: { ...ctx().rules, amounts: [{ minor: 10000, currency: 'GBP' }] } })
    expect(resolveField('amount', { value: { candidates: [{ value: '£100', quote: 'Paid' }, { value: '£15k', quote: 'Paid' }] }, confidence: 'high', quote: '' }, hundred)).toMatchObject({ value: { minor: 10000, currency: 'GBP' }, needsConfirmation: true })
    // round 3 F17: so does a candidate voided for its quote, with the reason shown — amounts and other fields alike
    const quoteGone = resolveField('amount', { value: { candidates: [{ value: '£100', quote: 'Paid' }, { value: '£999', quote: 'not present' }] }, confidence: 'high', quote: '' }, hundred)
    expect(quoteGone).toMatchObject({ value: { minor: 10000, currency: 'GBP' }, needsConfirmation: true, reason: 'quote not in the text given to the model' })
    const issue = resolveField('issue_type', { value: { candidates: [{ value: 'login', quote: 'Paid' }, { value: 'permissions', quote: 'not present' }] }, confidence: 'high', quote: '' }, hundred)
    expect(issue).toMatchObject({ value: 'login', needsConfirmation: true })
  })

  it('TC-FLD-05 (v0.7.9) amounts: the model picks, rule amounts check; candidates → multiple; deal candidates → multiple', () => {
    const two = ctx({ rules: { ...ctx().rules, amounts: [{ minor: 1000000, currency: 'GBP' }, { minor: 500000, currency: 'GBP' }] } })
    // an old amount in quoted mail no longer makes the field multiple: the model's pick is one of the mail's amounts
    expect(resolveField('amount', f('£10,000.00', '£10,000.00'), two)).toMatchObject({ status: 'ok', value: { minor: 1000000, currency: 'GBP' }, source: 'merged' })
    const cands = { value: { candidates: [{ value: '£10,000.00', quote: '£10,000.00' }, { value: '£5,000.00', quote: 'here' }] }, confidence: 'medium' as const, quote: '' }
    const a = resolveField('amount', cands, ctx({ ...two, modelText: `${text} here` }))
    expect(a.status).toBe('multiple')
    expect(a.candidates).toEqual([{ minor: 1000000, currency: 'GBP' }, { minor: 500000, currency: 'GBP' }])
    // a pick that is not in the mail: conflict; the rule value only when there is exactly one
    expect(resolveField('amount', f('£7,000.00', '£10,000.00'), two)).toMatchObject({ status: 'conflict', value: null })
    const one = ctx({ rules: { ...ctx().rules, amounts: [{ minor: 1000000, currency: 'GBP' }] } })
    expect(resolveField('amount', f('£7,000.00', '£10,000.00'), one)).toMatchObject({ status: 'conflict', value: { minor: 1000000, currency: 'GBP' } })
    expect(resolveField('amount', undefined, one)).toMatchObject({ status: 'ok', value: { minor: 1000000, currency: 'GBP' }, source: 'rule' })
    expect(resolveField('amount', undefined, two)).toMatchObject({ status: 'ok', value: null, needsConfirmation: true })
    const deals = { value: { candidates: [{ value: 'Northwind Robotics', quote: 'here' }, { value: '[NAME_1] [NAME_2] SPV', quote: '[NAME_1] [NAME_2] SPV' }] }, confidence: 'medium' as const, quote: '' }
    expect(resolveField('deal', deals, ctx({ modelText: `${text} here` }))).toMatchObject({ status: 'multiple', candidates: ['d-1', 'd-2'] })
  })

  it('TC-FLD-06 document_types compared as a set; a value outside the list fails validation', () => {
    expect(resolveField('document_types', f(['passport', 'proof_of_address', 'passport'], 'here'), ctx({ modelText: 'here' })).value).toEqual(['passport', 'proof_of_address'])
    expect(resolveField('document_types', f(['passport', 'selfie'], 'here'), ctx({ modelText: 'here' }))).toMatchObject({ status: 'void', invalid: true, value: null })
  })

  it('TC-FLD-08 a deal written with name placeholders is restored in memory and stored as the deal ID', () => {
    const r = resolveField('deal', f('[NAME_1] [NAME_2] SPV', '[NAME_1] [NAME_2] SPV'), ctx())
    expect(r).toMatchObject({ status: 'ok', value: 'd-2' })
    expect(JSON.stringify(r)).not.toContain('Amelia')
  })

  it('account_last4 from rules only; currency follows a single resolved amount', () => {
    const res = resolveFields(['amount', 'currency', 'account_last4'], { fields: { amount: f('£10,000.00', '£10,000.00') } }, ctx({ rules: { ...ctx().rules, accountLast4: ['5432'] } }))
    expect(res.map((r) => [r.field, r.value])).toEqual([['amount', { minor: 1000000, currency: 'GBP' }], ['currency', 'GBP'], ['account_last4', '5432']])
  })
})
