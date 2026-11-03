import { describe, expect, it } from 'vitest'
import { adoptLabels, adoptedClasses, classificationSchema, maskUnknownPlaceholders, riskClasses, ruleLabels, type RuleInput } from './classify.ts'

const CLASSES = ['payment_query', 'payment_evidence', 'bank_details', 'identity_change', 'legal_documents', 'bank_letter_request', 'unclassified']
const schema = classificationSchema(CLASSES)
const none: RuleInput = { subject: '', body: '', bodyHtml: '', attachmentTexts: [], esignInvite: false, paymentEvidenceParsed: false }

describe('C-CLS classification', () => {
  it('TC-CLS-02 a class not in the configuration, too many labels or a long reason do not validate', () => {
    expect(schema.safeParse({ labels: [{ class: 'payment_query', confidence: 'high', reason: 'r' }], language: 'en' }).success).toBe(true)
    expect(schema.safeParse({ labels: [{ class: 'wire_fraud', confidence: 'high', reason: 'r' }], language: 'en' }).success).toBe(false)
    expect(schema.safeParse({ labels: [], language: 'en' }).success).toBe(false)
    const five = Array.from({ length: 5 }, () => ({ class: 'payment_query', confidence: 'high', reason: '' }))
    expect(schema.safeParse({ labels: five, language: 'en' }).success).toBe(false)
    expect(schema.safeParse({ labels: [{ class: 'payment_query', confidence: 'high', reason: 'x'.repeat(201) }], language: 'en' }).success).toBe(false)
    expect(schema.safeParse({ labels: [{ class: 'payment_query', confidence: 'sure', reason: '' }], language: 'en' }).success).toBe(false)
    expect(schema.safeParse({ labels: [{ class: 'payment_query', confidence: 'high', reason: '', extra: 1 }], language: 'en' }).success).toBe(false)
  })

  it('TC-CLS-03a only low labels → unclassified is adopted; the low labels stay for risk ("needs confirmation")', () => {
    const labels = adoptLabels({ labels: [{ class: 'bank_letter_request', confidence: 'low', reason: '' }], language: 'en' }, [])
    expect(adoptedClasses(labels)).toEqual(['unclassified'])
    expect(labels.find((l) => l.classId === 'bank_letter_request')).toMatchObject({ adopted: false, confidence: 'low' })
    expect(riskClasses(labels).sort()).toEqual(['bank_letter_request', 'unclassified'])
    // a failed model call: only rule labels, else unclassified
    expect(adoptedClasses(adoptLabels(null, []))).toEqual(['unclassified'])
    expect(adoptedClasses(adoptLabels(null, ['payment_evidence']))).toEqual(['payment_evidence'])
  })

  it('TC-CLS-04a payment_query (high) + identity_change (medium) → both adopted', () => {
    const labels = adoptLabels({ labels: [{ class: 'payment_query', confidence: 'high', reason: '' }, { class: 'identity_change', confidence: 'medium', reason: '' }], language: 'en' }, [])
    expect(adoptedClasses(labels)).toEqual(['payment_query', 'identity_change'])
  })

  it('TC-CLS-05 rule labels: IBAN shape, "our payment instructions have changed", a parsed :32A:, an e-sign invite; rule labels are adopted', () => {
    expect(ruleLabels({ ...none, body: 'Please pay GB82 WEST 1234 5698 7654 31 instead' })).toEqual(['bank_details']) // check digits do not matter
    expect(ruleLabels({ ...none, body: 'Note: our payment instructions have changed.' })).toEqual(['bank_details'])
    expect(ruleLabels({ ...none, paymentEvidenceParsed: true })).toEqual(['payment_evidence'])
    expect(ruleLabels({ ...none, esignInvite: true })).toEqual(['legal_documents'])
    const labels = adoptLabels({ labels: [{ class: 'payment_query', confidence: 'low', reason: '' }], language: 'en' }, ['bank_details'])
    expect(adoptedClasses(labels)).toEqual(['bank_details'])
    // v0.7.8 scope: account shapes in the subject and attachments count; the word rule reads the body only
    expect(ruleLabels({ ...none, subject: 'IBAN GB82WEST12345698765432' })).toEqual(['bank_details'])
    expect(ruleLabels({ ...none, attachmentTexts: ['Account 12345678 sort code 12-34-56'] })).toEqual(['bank_details'])
    expect(ruleLabels({ ...none, subject: 'New bank details', body: 'see attached' })).toEqual([])
    // the HTML body is a body too (CF-F3): both rules read it
    expect(ruleLabels({ ...none, body: 'see below', bodyHtml: 'Pay GB82 WEST 1234 5698 7654 32 from now on' })).toEqual(['bank_details'])
    expect(ruleLabels({ ...none, body: 'see below', bodyHtml: 'Our bank details have changed.' })).toEqual(['bank_details'])
    // the two word lists must meet in one body, not one in each
    expect(ruleLabels({ ...none, body: 'Our details are new', bodyHtml: '' })).toEqual(['bank_details'])
    expect(ruleLabels({ ...none, body: 'something new', bodyHtml: 'the bank' })).toEqual([])
    expect(ruleLabels({ ...none, body: 'New year greetings from the team', attachmentTexts: ['update your bank details'] })).toEqual([])
    // quoted earlier mail is part of the body
    expect(ruleLabels({ ...none, body: 'Thanks!\n> On Monday you wrote: we have updated our bank details' })).toEqual(['bank_details'])
    // whole words only (I-05): "renew accounting access" is neither
    expect(ruleLabels({ ...none, body: 'please renew accounting access' })).toEqual([])
  })

  it('MN-F4 a reason naming a placeholder the model was not given shows [?], not a restored value', () => {
    const m = { labels: [{ class: 'payment_query', confidence: 'high' as const, reason: '[NAME_1] asks; passport of [NAME_7]' }], language: 'en' }
    expect(maskUnknownPlaceholders(m, '<body>[NAME_1] here</body>').labels[0]!.reason).toBe('[NAME_1] asks; passport of [?]')
  })

  it('hostile model output (G2 step 0): a __proto__ key or class is not the schema', () => {
    const c = classificationSchema(['payment_query'])
    expect(c.safeParse(JSON.parse('{"labels":[{"class":"payment_query","confidence":"high","reason":"x","__proto__":{"adopted":true}}],"language":"en"}')).success).toBe(false)
    expect(c.safeParse(JSON.parse('{"labels":[{"class":"__proto__","confidence":"high","reason":"x"}],"language":"en"}')).success).toBe(false)
  })
})

describe('duplicate classes in a reply (Codex E2 re-run F7)', () => {
  it('TC-CLS-03a a class named low then high is adopted at high', async () => {
    const { adoptLabels } = await import('./classify.ts')
    const l = adoptLabels({ labels: [{ class: 'payment_query', confidence: 'low', reason: 'a' }, { class: 'payment_query', confidence: 'high', reason: 'b' }], language: 'en' }, [])
    expect(l.filter((x) => x.source === 'model')).toEqual([{ classId: 'payment_query', source: 'model', confidence: 'high', adopted: true, reason: 'b' }])
    expect(l.some((x) => x.classId === 'unclassified')).toBe(false)
  })
})
