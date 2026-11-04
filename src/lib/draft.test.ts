import { describe, expect, it } from 'vitest'
import {
  allowedCaseRecipients, allowedManualTemplates, bodyEditable, checkTemplate, fill, formatMoney, internalTermsIn, paymentDate, primaryClass, recipientAllowed,
  REQUIRED_TEMPLATES, selectTemplate, type SelectInput, type TemplateMeta,
} from './draft.ts'
import type { ClassFloor } from './risk.ts'

const classes: ClassFloor[] = [
  ['payment_query', 'medium'], ['payment_evidence', 'medium'], ['unreferenced_payment', 'medium'], ['kyc_documents', 'high'], ['withdrawal', 'high'],
  ['commitment_change', 'medium'], ['fee_or_terms_change', 'high'], ['closing_confirmation', 'medium'], ['legal_documents', 'high'], ['bank_details', 'high'],
  ['identity_change', 'high'], ['tax_certificates', 'medium'], ['exit_distribution', 'medium'], ['bank_letter_request', 'low'], ['account_access', 'medium'],
  ['complaint', 'medium'], ['other_known', 'high'], ['unclassified', 'medium'],
].map(([id, risk_floor]) => ({ id: id!, risk_floor: risk_floor as ClassFloor['risk_floor'] }))
const disclosing = new Set(['payment_received', 'payment_wait', 'payment_need_evidence', 'exit_info', 'withdrawal_ack', 'commitment_change_ack'])
const templates = new Map<string, TemplateMeta>(REQUIRED_TEMPLATES.map((id) => [id, { id, discloses: disclosing.has(id), asserts: id === 'payment_received', placeholders: [] }]))
const holidays = new Set<string>()
const sel = (o: Partial<SelectInput>) =>
  selectTemplate({ classes, adopted: ['payment_query'], risk: 'medium', linkedCommitment: true, ledger: 'not_received', payment: null, receivedDate: '2026-10-29', holidays, mayDisclose: true, templates, ...o })
const pay = (date: string | null) => paymentDate({ primary: 'payment_query', evidenceValueDates: [], paymentDate: date, receivedDate: '2026-10-29' })

describe('template choice (C-DRF-3, 4, 5)', () => {
  it('TC-DRF-05 payment query templates (received Thursday 2026-10-29)', () => {
    expect(sel({ ledger: 'received' }).template).toBe('payment_received')
    expect(sel({ payment: pay('2026-10-23') }).template).toBe('payment_wait')
    expect(sel({ payment: pay('2026-10-22') }).template).toBe('payment_need_evidence')
    expect(sel({ payment: pay(null) }).template).toBe('payment_need_evidence')
    expect(sel({ payment: pay('2026-10-30') }).template).toBe('payment_need_evidence')
    expect(sel({ ledger: 'unknown', payment: pay('2026-10-23') }).template).toBe('payment_need_evidence')
    expect(sel({ linkedCommitment: false, ledger: null }).template).toBe('payment_need_reference')
  })
  it('TC-DRF-06 payment date sources', () => {
    const r = '2026-10-29'
    expect(paymentDate({ primary: 'payment_evidence', evidenceValueDates: ['2026-10-23'], valueDate: '2026-10-20', receivedDate: r })).toEqual({ date: '2026-10-23', status: 'ok' })
    expect(paymentDate({ primary: 'payment_evidence', evidenceValueDates: ['2026-10-23', '2026-10-21'], valueDate: '2026-10-22', receivedDate: r }).status).toBe('unknown') // the field does not break the tie
    expect(paymentDate({ primary: 'payment_evidence', evidenceValueDates: ['2026-10-23', '2026-10-23'], receivedDate: r }).date).toBe('2026-10-23')
    expect(paymentDate({ primary: 'payment_evidence', evidenceValueDates: [], valueDate: '2026-10-22', receivedDate: r })).toEqual({ date: '2026-10-22', status: 'ok' })
    expect(paymentDate({ primary: 'payment_query', evidenceValueDates: [], valueDate: null, paymentDate: '2026-10-22', receivedDate: r }).date).toBe('2026-10-22')
    expect(paymentDate({ primary: 'payment_query', evidenceValueDates: [], valueDate: '2026-10-21', paymentDate: '2026-10-22', receivedDate: r }).status).toBe('unknown')
    expect(paymentDate({ primary: 'payment_query', evidenceValueDates: [], paymentDate: { multiple: ['2026-10-21', '2026-10-22'] }, receivedDate: r }).status).toBe('unknown')
    expect(paymentDate({ primary: 'payment_query', evidenceValueDates: [], paymentDate: { void: 'invalid' }, receivedDate: r }).status).toBe('unknown')
    expect(paymentDate({ primary: 'payment_query', evidenceValueDates: [], paymentDate: null, valueDate: '2026-10-21', receivedDate: r }).date).toBe('2026-10-21') // the other field
  })
  it('TC-DRF-07 / C-DRF-3 ①–③ and ⑤', () => {
    expect(sel({ adopted: ['unclassified'] }).template).toBe(null)
    expect(sel({ adopted: ['unclassified'], risk: 'high' }).template).toBe('safe_ack')
    expect(sel({ adopted: ['bank_details', 'payment_query'], risk: 'low' })).toMatchObject({ template: 'safe_ack', step: '1' }) // TC-FRD-02: whatever the risk
    expect(sel({ adopted: ['identity_change'], risk: 'medium' }).template).toBe('safe_ack')
    expect(sel({ adopted: ['withdrawal', 'identity_change'], risk: 'medium' })).toMatchObject({ template: 'safe_ack', step: '1' }) // withdrawal is earlier in the table
    expect(sel({ risk: 'high', ledger: 'received' }).template).toBe('safe_ack')
    expect(sel({ ledger: 'received', mayDisclose: false })).toMatchObject({ template: 'safe_ack', step: '5' }) // TC-LNK-05 stranger with a valid reference
    expect(sel({ linkedCommitment: false, ledger: null, mayDisclose: false }).template).toBe('payment_need_reference') // generic
  })
  it('TC-DRF-10 main class: highest floor, ties by table order', () => {
    expect(primaryClass(classes, ['exit_distribution', 'commitment_change'])).toBe('commitment_change')
    expect(sel({ adopted: ['exit_distribution', 'commitment_change'] }).template).toBe('commitment_change_ack')
    expect(sel({ adopted: ['bank_letter_request', 'account_access'] }).template).toBe('account_access_info')
    expect(sel({ adopted: ['bank_letter_request'], risk: 'low' }).template).toBe('bank_letter_info')
    expect(sel({ adopted: ['unreferenced_payment', 'payment_query'] }).template).toBe('payment_need_evidence') // payment_query is earlier in the table
  })
  it('TC-DRF-11a / TC-DRF-11b injection: high → safe_ack; without it never payment_received while not received', () => {
    expect(sel({ risk: 'high' }).template).toBe('safe_ack')
    const t = sel({ payment: pay('2026-10-27') }).template
    expect(['payment_wait', 'payment_need_evidence']).toContain(t)
  })
})

describe('a person choosing a template (C-DRF-7)', () => {
  it('TC-DRF-14 / TC-FRD-02', () => {
    expect(allowedManualTemplates({ classes, adopted: ['bank_details'], risk: 'low', linkedCommitment: true, ledger: 'received', payment: null, receivedDate: '2026-10-29', holidays, mayDisclose: true, templates })).toEqual([])
    const base: SelectInput = { classes, adopted: ['payment_query', 'complaint'], risk: 'medium', linkedCommitment: true, ledger: 'not_received', payment: null, receivedDate: '2026-10-29', holidays, mayDisclose: true, templates }
    expect(allowedManualTemplates({ ...base, risk: 'high' })).toEqual([])
    const ok = allowedManualTemplates(base)
    expect(ok).toContain('complaint_ack')
    expect(ok).toContain('payment_need_evidence')
    expect(ok).not.toContain('payment_received')
    expect(ok).not.toContain('exit_info') // discloses, not a class of this Case
    expect(ok).not.toContain('notify_old_contact')
    expect(allowedManualTemplates({ ...base, ledger: 'received' })).toContain('payment_received')
    expect(allowedManualTemplates({ ...base, ledger: 'received', mayDisclose: false })).not.toContain('payment_received')
    expect(bodyEditable('safe_ack')).toBe(false)
    expect(bodyEditable('notify_old_contact')).toBe(false)
    expect(bodyEditable('complaint_ack')).toBe(true)
  })
})

describe('checks (C-DRF-1, C-DRF-2, C-FRD-3)', () => {
  it('TC-DRF-02 internal terms, whole words', () => {
    expect(internalTermsIn('This was flagged for review')).toEqual(['flagged'])
    expect(internalTermsIn('the RISK LEVEL is noted')).toEqual(['risk level'])
    expect(internalTermsIn('Kind regards, Sarah')).toEqual([])
    expect(internalTermsIn('a cooling-off period')).toEqual(['cooling-off', 'cooling off'])
  })
  it('TC-DRF-03 a sentence with a missing value is removed whole', () => {
    const t = 'Please send the confirmation (MT103 or pacs.008), with the UETR. Thanks!'
    expect(fill(t, {})).toEqual({ text: t, removed: 0 }) // nothing lost at «pacs.008»
    expect(fill('Ref {reference} (pacs.008 only). Regards', { reference: null })).toEqual({ text: 'Regards', removed: 1 })
    expect(fill('We received {amount}. Thank you.\nRegards', { amount: null })).toEqual({ text: 'Thank you.\nRegards', removed: 1 })
    expect(fill('Hello {contact_name}, we received {amount} on {payment_date}.', { contact_name: 'Amelia', amount: 'GBP 10,000.00', payment_date: '2026-10-23' }).text).toBe('Hello Amelia, we received GBP 10,000.00 on 2026-10-23.')
    expect(fill('Ref {reference}\nBalance {outstanding_amount}', { reference: 'NW-001', outstanding_amount: null })).toEqual({ text: 'Ref NW-001\n', removed: 1 })
    expect(fill('Balance {outstanding_amount}\nRegards', { outstanding_amount: null })).toEqual({ text: 'Regards', removed: 1 })
  })
  it('TC-DRF-04 recipients', () => {
    expect(allowedCaseRecipients('a@x.example', ['b@y.example'], false)).toEqual(['a@x.example', 'b@y.example'])
    expect(allowedCaseRecipients('a@x.example', ['b@y.example'], true)).toEqual(['a@x.example'])
    expect(recipientAllowed('A@X.example', ['a@x.example'])).toBe(true)
    expect(recipientAllowed('c@z.example', ['a@x.example'])).toBe(false)
  })
  it('TC-DRF-09 / TC-DRF-16 template sources', () => {
    const t = (id: string, body: string, o: object = {}) => checkTemplate({ id, subject: 'Re: {case_number}', body, ...o })
    // strictly by C-DRF-1: an asserts_receipt template takes directory and ledger values only, plus {deployment_name} (v0.7.25)
    expect(checkTemplate({ id: 'payment_received', subject: 'Your payment', body: 'We received {amount}.' }).problems).toEqual(['payment_received asserts receipt and may only use directory or ledger placeholders and {deployment_name}, not {amount}'])
    expect(t('payment_received', 'Received {received_amount}.').problems).toEqual(['payment_received asserts receipt and may only use directory or ledger placeholders and {deployment_name}, not {case_number}'])
    expect(t('complaint_ack', 'From {payer_name}').problems).toEqual(['unknown placeholder {payer_name}'])
    expect(t('complaint_ack', 'Not flagged.').problems[0]).toMatch(/internal terms/)
    expect(t('safe_ack', 'Dear {investor_name}').problems).toEqual(['safe_ack may only use system placeholders, not {investor_name}'])
    expect(t('notify_old_contact', 'Dear {contact_name}, {deployment_name}').problems).toEqual([])
    expect(t('complaint_ack', 'We owe {cash_due}.').meta.discloses).toBe(true) // auto
    expect(t('complaint_ack', 'Thanks. {deployment_name}').meta.discloses).toBe(false)
    expect(t('closing_ack', 'Thanks.', { discloses_record: true }).meta.discloses).toBe(true)
  })
  it('money in replies', () => {
    expect(formatMoney(1_000_000, 'GBP')).toBe('GBP 10,000.00')
    expect(formatMoney(5, 'EUR')).toBe('EUR 0.05')
    expect(formatMoney(123_456_789_01, 'USD')).toBe('USD 123,456,789.01')
  })
})

describe('templates that assert receipt (C-DRF-7 v0.7.15)', () => {
  it('TC-DRF-20 sign-off and payment-reference wording (C-DRF-1 v0.7.25)', async () => {
    const { readFileSync } = await import('node:fs')
    const def = readFileSync('config/default/templates.yaml', 'utf8')
    expect(readFileSync('eval/config/templates.yaml', 'utf8')).toBe(def)
    const received = def.slice(def.indexOf('- id: payment_received'), def.indexOf('- id: payment_wait'))
    expect(received.trimEnd().endsWith('{deployment_name}')).toBe(true)
    for (const id of ['payment_wait', 'payment_need_evidence']) {
      const block = def.slice(def.indexOf(`- id: ${id}`), def.indexOf('- id:', def.indexOf(`- id: ${id}`) + 5))
      expect(block).toContain('(your payment reference {reference})')
    }
    expect(checkTemplate({ id: 'payment_received', subject: 'Your payment for {deal_name}', body: 'We have received {received_amount}.\n\n{deployment_name}' }).problems).toEqual([])
    expect(checkTemplate({ id: 'received_thanks', subject: 'Received', body: 'Paid. {case_number}', asserts_receipt: true }).problems).toEqual(['received_thanks asserts receipt and may only use directory or ledger placeholders and {deployment_name}, not {case_number}'])
  })
  it('TC-DRF-19 a configured asserts_receipt template discloses, is offered or chosen only when received in full; a template outside C-DRF-5 is never offered', () => {
    const meta = checkTemplate({ id: 'received_thanks', subject: 'Received', body: 'We confirm your payment has been received in full.', asserts_receipt: true }).meta
    expect(meta).toMatchObject({ asserts: true, discloses: true })
    const extra = new Map(templates)
    extra.set('received_thanks', meta)
    extra.set('house_note', { id: 'house_note', discloses: false, asserts: false, placeholders: [] })
    const base: SelectInput = { classes, adopted: ['payment_query'], risk: 'medium', linkedCommitment: true, ledger: 'not_received', payment: null, receivedDate: '2026-10-29', holidays, mayDisclose: true, templates: extra }
    expect(allowedManualTemplates(base)).not.toContain('received_thanks')
    expect(allowedManualTemplates(base)).not.toContain('house_note') // not a C-DRF-5 template
    // a deployment makes a class default assert receipt: chosen only when received in full
    const asserting = new Map(extra)
    asserting.set('closing_ack', { id: 'closing_ack', discloses: true, asserts: true, placeholders: [] })
    expect(selectTemplate({ ...base, adopted: ['closing_confirmation'], templates: asserting })).toMatchObject({ template: 'safe_ack', step: '5' })
    expect(selectTemplate({ ...base, adopted: ['closing_confirmation'], ledger: 'received', templates: asserting }).template).toBe('closing_ack')
  })
})
