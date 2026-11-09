// PRD C-CLS-4a and appendix C: fixtures are fictional; a passing mail differs from a failing one by one condition.
import { describe, expect, it } from 'vitest'
import { ruleLabels } from './classify.ts'
import { parsePacs008, type PacsResult } from './pacs008.ts'
import { evidenceExemption, evidenceSupportsTracing, hasExplicitRedirect, hasRedirectWording, SIGNALS, structuredBeneficiaries, type AttachmentInput, type ExemptionInput } from './payment-message.ts'
import { normaliseText } from './text.ts'
import { normaliseAccount } from './accounts.ts'
import { Redactor } from './redact.ts'

const P = 'DE89370400440532013000'
const G = 'GB82WEST12345698765432'
const X = 'GB29NWBK60161331926819'
const UETR = '81cd69a7-85c3-46e1-b133-9d08c4210b21'
const CCY = ['GBP', 'EUR', 'USD']

interface Mt {
  payer?: string
  benef?: string
  ref?: string
  rem?: string
  extra?: string
  after?: string
  uetr?: string
}
const mt = (o: Mt = {}) =>
  `{3:{121:${o.uetr ?? UETR}}}\n{4:\n:20:${o.ref ?? 'REF-2026-1'}\n:23B:CRED\n:32A:261030GBP9000,00\n:50K:${o.payer ?? `/${P}`}\nDANIEL OSEI\n:59:${o.benef ?? `/${G}`}\nNORTHWIND SPV LP\n${o.rem === undefined ? ':70:NW-016 SECOND HALF\n' : o.rem}${o.extra ?? ''}:71A:SHA\n-}\n${o.after ?? ''}`
const txt = (text: string, over: Partial<AttachmentInput> = {}): AttachmentInput => ({ ordinal: 0, kind: 'txt', filename: 'mt103.txt', parseStatus: 'parsed', text, facts: {}, maybeKyc: false, ...over })

const tx = (acct = `<DbtrAcct><Id><IBAN>${P}</IBAN></Id></DbtrAcct><CdtrAcct><Id><IBAN>${G}</IBAN></Id></CdtrAcct>`, rem = 'SB-004', amt = '<IntrBkSttlmAmt Ccy="GBP">9000.00</IntrBkSttlmAmt>', uetr = UETR) =>
  `<CdtTrfTxInf><PmtId><EndToEndId>E2E1</EndToEndId><UETR>${uetr}</UETR></PmtId>${amt}<IntrBkSttlmDt>2026-10-30</IntrBkSttlmDt><ChrgBr>SHAR</ChrgBr><Dbtr><Nm>ELENA RUIZ</Nm></Dbtr>${acct}<RmtInf><Ustrd>${rem}</Ustrd></RmtInf></CdtTrfTxInf>`
const NS = 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08'
const pacsXml = (inner = tx(), attrs = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="${NS}"${attrs}><FIToFICstmrCdtTrf><GrpHdr><MsgId>M1</MsgId></GrpHdr>${inner}</FIToFICstmrCdtTrf></Document>`
const envelope = (inner = tx(), extra = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<BusinessMessage><AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02"><BizMsgIdr>B1</BizMsgIdr></AppHdr>${extra}<Document xmlns="${NS}"><FIToFICstmrCdtTrf><GrpHdr><MsgId>M1</MsgId></GrpHdr>${inner}</FIToFICstmrCdtTrf></Document></BusinessMessage>`
const xml = (s: string, over: Partial<AttachmentInput> = {}): AttachmentInput => {
  const r = parsePacs008(s, []) as PacsResult
  if (!r.parsed) throw new Error(`fixture did not parse: ${r.reason}`)
  return { ordinal: 0, kind: 'xml', filename: 'pacs008.xml', parseStatus: 'parsed', text: r.text, facts: { pacs008: { ...r, text: '' } }, maybeKyc: false, ...over }
}

const clean = Object.fromEntries(SIGNALS.map((s) => [s, false]))
const input = (a: AttachmentInput | AttachmentInput[], over: Partial<ExemptionInput> = {}): ExemptionInput => ({
  subject: 'Payment confirmation',
  body: "Attached is my bank's MT103 for the second half.",
  bodyHtml: '',
  attachments: Array.isArray(a) ? a : [a],
  currencies: CCY,
  signals: clean,
  authenticated: true,
  senderDeals: ['D1'],
  referenceDeals: ['D1'],
  blockedOrOverLimit: false,
  modelLabels: ['payment_evidence'],
  priorBankRule: false,
  listed: (deal, account) => (deal === 'D1' ? normaliseAccount(account) === G || account === '' && false : null),
  ...over,
})
const decide = (a: AttachmentInput | AttachmentInput[], over: Partial<ExemptionInput> = {}) => evidenceExemption(input(a, over))
const reason = (a: AttachmentInput | AttachmentInput[], over: Partial<ExemptionInput> = {}) => {
  const r = decide(a, over)
  return r.applied ? 'applied' : r.reason
}
const labels = (texts: string[], exempt: number | null, over: Partial<Parameters<typeof ruleLabels>[0]> = {}) =>
  ruleLabels({ subject: 'Payment', body: 'Confirmation attached', bodyHtml: '', attachmentTexts: texts, esignInvite: false, paymentEvidenceParsed: true, evidenceAnywhere: true, exemptAttachment: exempt, ...over })

describe('C-CLS-4a a structurally valid message', () => {
  it('TC-CLS-10 the accounts of a qualifying MT103 and pacs.008 do not count', () => {
    expect(decide(txt(mt()))).toMatchObject({ applied: true, dealKey: 'D1', payerLast4: ['3000'], beneficiaryLast4: ['5432'] })
    expect(reason(xml(pacsXml()))).toBe('applied')
    expect(reason(xml(envelope(tx() + tx())))).toBe('applied')
    expect(reason(txt(mt({ benef: 'NORTHWIND SPV LP' })))).toBe('applied') // no beneficiary account position
    expect(reason(txt(mt().replace(/\n/g, '\r\n')))).toBe('applied')
    // only field lines, no blocks
    expect(reason(txt(`:20:REF1\n:23B:CRED\n:32A:261030GBP9000,00\n:50K:/${P}\nA NAME\n:59:/${G}\n:71A:SHA\n`))).toBe('applied')
    // the rule label follows the decision, attachment by attachment
    expect(labels([mt()], 0)).toEqual(['payment_evidence'])
    expect(labels([mt()], null)).toEqual(['bank_details', 'payment_evidence'])
  })
  it('TC-CLS-10 a position with no digit is a name: E0018 and E0024 are not accounts', () => {
    const a = txt(mt({ benef: '/NORTHWIND ROBOTICS SPV CLIENT AC' }))
    expect(structuredBeneficiaries([a], CCY)).toEqual([])
    expect(reason(a)).toBe('applied')
    expect(structuredBeneficiaries([xml(pacsXml(tx('<CdtrAcct><Id><Othr><Id>NWR-SPV-CLIENT-GBP</Id></Othr></Id></CdtrAcct>')))], CCY)).toEqual([])
  })
  it('TC-CLS-10 the two development samples qualify: their bodies and structures hit nothing', () => {
    const e0019 = `{3:{121:855df781-70c8-4285-82fe-032fc1ae5869}}\n{4:\n:20:OSE-PMT-2-OF-2\n:23B:CRED\n:32A:261030GBP9000,00\n:50K:DANIEL OSEI\n:59:/GB41QZBK79137211981312\nNORTHWIND ROBOTICS SPV LP\n:70:NW-016 SECOND HALF\n:71A:SHA\n-}\n`
    const listed = (_: string, a: string) => normaliseAccount(a) === 'GB41QZBK79137211981312'
    expect(reason(txt(e0019), { body: "Hi,\n\nAttached is my bank's MT103 for the second half of my Northwind subscription (£9,000.00).\n\nCheers,\nDan\n", listed })).toBe('applied')
    expect(hasRedirectWording(normaliseText('For your records, attached is the payment message for my Solent Biotherapeutics subscription.'))).toBe(false)
  })

  it('TC-CLS-11 accounts or instructions hidden in a message keep the trigger', () => {
    // a: outside the account positions
    expect(reason(txt(mt({ rem: `:70:${X}\n` })))).toBe('M3')
    for (const tag of ['72', '77B']) expect(reason(txt(mt().replace(':71A:SHA\n', `:71A:SHA\n:${tag}:${X}\n`)))).toBe('M3')
    expect(reason(txt(mt().replace(':59:', `:57D:/${X}\n:59:`)))).toBe('M3')
    // b: a `:32A:` line in ordinary text
    expect(reason(txt(`Please pay ${X}\n:32A:261030GBP9000,00\n`))).toBe('M2')
    // c: not exactly one message
    expect(reason(txt(mt({ after: 'Please note the new details\n' })))).toBe('M2')
    expect(reason(txt(mt() + mt()))).toBe('M2')
    expect(reason(txt(mt({ extra: ':99Z:SOMETHING\n' })))).toBe('M2')
    expect(reason(txt(mt().replace(':23B:CRED\n', '')))).toBe('M2')
    expect(reason(txt(mt().replace(':71A:SHA\n', ':71A:SHA\n:99Z:X\n')))).toBe('M2') // unknown, last
    expect(reason(txt(mt().replace(':71A:SHA\n', ':71A:SHA\n:77B:X\n:72:Y\n')))).toBe('M2') // misplaced
    expect(reason(txt(mt().replace(':71A:SHA\n', ':71A:SHA\n:72:X\n:72:Y\n')))).toBe('M2') // repeated, optional
    expect(reason(txt(mt().replace(':23B:CRED\n', ':23B:CRED\n:23B:CRED\n')))).toBe('M2')
    expect(reason(txt(mt().replace(':20:REF-2026-1\n:23B:CRED\n', ':23B:CRED\n:20:REF-2026-1\n')))).toBe('M2')
    // d: on the party lines
    expect(reason(txt(mt({ benef: `/${G}\n${X}` })))).toBe('M3')
    expect(reason(txt(mt({ payer: `/${P}\nNEW BANK DETAILS` })))).toBe('M4')
    expect(reason(txt(mt({ ref: 'CHANGE ACCOUNT' })))).toBe('M4')
    expect(reason(txt(mt({ payer: '/PLEASE USE 123' })))).toBe('M3')
    // bare lines where only a fixed format belongs, and the beneficiary without its `/`
    expect(reason(txt(mt().replace(':71A:SHA\n', ':71A:SHA\nCREDIT 87654321 FOR NEXT INSTALMENT\n')))).toBe('M2')
    expect(reason(txt(mt().replace(':23B:CRED\n', ':23B:CRED\nCREDIT 87654321\n')))).toBe('M2')
    expect(reason(txt(mt().replace(':23B:CRED\n', ':23B:CRED\n:23E:HOLD/87654321\n')))).toBe('M4')
    expect(reason(txt(mt().replace(':59:', ':57D:/87654321\n:59:')))).toBe('M4')
    expect(reason(txt(mt({ benef: 'ATTACKER LTD\nACC 1234567' })))).toBe('M4')
    expect(reason(txt(mt().replace('{3:{121:', '{3:{108:CREDIT 87654321}{121:')))).toBe('M2')
    expect(reason(txt(`${mt()}{5:CREDIT 87654321}\n`))).toBe('M2')
    // line ends (C.0), digits in any script, empty positions
    expect(reason(txt(mt({ benef: `/${G}\u2028${X}` })))).toBe('M2')
    expect(reason(txt(mt({ rem: ':70:CREDIT ٨٧٦٥٤٣٢١\n' })))).toBe('M4')
    expect(reason(txt(mt({ benef: '//1234567' })))).toBe('M2')
    expect(reason(txt(mt().replace(':71A:SHA', ':71A:87654321')))).toBe('M2') // a fixed format field holds its format
    // a date field next to a long reference is not a UK account (C.0)
    expect(reason(txt(mt({ ref: '12345678' })))).toBe('applied')
    expect(reason(txt(`${mt().trimEnd()}{5:{CHK:ABC}}\n`))).toBe('applied') // real output: trailer on the same line
    expect(reason(txt(mt({ benef: '/' })))).toBe('M2')
    // one field at a time for the change wording: `NEW YORK` and a bank name in another field are not a request
    expect(reason(txt(mt({ payer: `/${P}\nJANE\nNEW YORK` }).replace(':59:', ':57D:ABC BANK\n:59:')))).toBe('applied')
    // e: not one account
    expect(reason(txt(mt({ benef: '/GB82WEST12345698765431' })))).toBe('M3') // check digit
    expect(reason(txt(mt({ benef: '/GB82 WEST 1234\n5698 7654 32' })))).toBe('M3') // across lines
    expect(reason(txt(mt({ benef: `/${G} USE THIS` })))).toBe('M3')
    // f: wording and numbers with no account shape
    expect(reason(txt(mt({ rem: ':70:CHANGE BANK ACCOUNT\n' })))).toBe('M4')
    expect(reason(txt(mt({ rem: ':70:FUTURE PAYMENTS PLEASE\n' })))).toBe('M4') // the word list alone
    expect(reason(txt(mt({ rem: ':70:NEW BANK\n' })))).toBe('M4') // the change wording alone
    expect(reason(txt(mt({ rem: ':70:NÉW BÁNK\n' })))).toBe('M4')
    expect(reason(txt(mt({ rem: ':70:请WIRE到这家公司\n' })))).toBe('M4')
    expect(reason(txt(mt({ rem: ':70:NEW BANK见附件\n' })))).toBe('M4')
    expect(reason(txt(mt({ rem: ':70:PLEASE ẂIRE TO ORDERING CUSTOMER\n' })))).toBe('M4')
    expect(reason(txt(mt({ benef: '/NEW BANK' })))).toBe('M4') // a no-digit value is text, not a position
    expect(reason(txt(mt({ benef: '/FUTURE PAYMENTS HERE' })))).toBe('M4')
    expect(reason(txt(mt().replace('{3:', '{1:PLEASEUSEXGB29NWBK60161331926819X}{3:')))).toBe('M2')
    expect(reason(txt(mt().replace('{3:', '{2:87654321}{3:')))).toBe('M2')
    expect(reason(txt(mt().replace('{3:', '{1:F01QZBKGB2LAXXX0000000000}{2:I103QZBKGB2LXXXXN}{3:')))).toBe('applied') // the real form
    expect(reason(txt(mt({ rem: ':70:CREDIT 87654321 FOR NEXT INSTALMENT\n' })))).toBe('M4')
    expect(reason(txt(mt({ rem: ':70:CREDIT 8765 4321 FOR NEXT INSTALMENT\n' })))).toBe('M4')
    expect(reason(txt(mt({ ref: 'CREDIT 87654321' })))).toBe('M4')
    expect(reason(txt(mt({ ref: '12345678901234567' })))).toBe('M4') // over 16
  })
  it('TC-CLS-11 pacs.008: free text, repeated elements and anything the attachment text cannot show', () => {
    expect(reason(xml(pacsXml(tx(undefined, `pay ${X}`))))).toBe('M3')
    expect(reason(xml(pacsXml(tx().replace('<RmtInf>', `<InstrForCdtrAgt><InstrInf>${X}</InstrInf></InstrForCdtrAgt><RmtInf>`))))).toBe('M3')
    expect(reason(xml(pacsXml(tx().replace('<RmtInf>', `<UltmtCdtr><Nm>${X}</Nm></UltmtCdtr><RmtInf>`))))).toBe('M3')
    expect(reason(xml(pacsXml(tx(`<CdtrAcct><Id><IBAN>Please update bank account to ${G}</IBAN></Id></CdtrAcct>`))))).toBe('M3')
    expect(reason(xml(pacsXml(tx(`<CdtrAcct><Id><IBAN>${G}</IBAN><IBAN>${X}</IBAN></Id></CdtrAcct>`))))).toBe('M2')
    expect(reason(xml(pacsXml(tx(`<CdtrAcct><Id><IBAN>${G}</IBAN></Id></CdtrAcct><CdtrAcct><Id><IBAN>${G}</IBAN></Id></CdtrAcct>`))))).toBe('M2')
    const hidden: Array<[string, string]> = [
      ['comment', pacsXml(tx().replace('<RmtInf>', `<!-- pay ${X} --><RmtInf>`))],
      ['processing instruction', pacsXml(tx().replace('<RmtInf>', `<?note pay ${X}?><RmtInf>`))],
      ['cdata', pacsXml(tx(undefined, '<![CDATA[SB-004]]>'))],
      ['numeric reference', pacsXml(tx(undefined, '&#83;B-004'))],
      ['extra attribute', pacsXml(tx().replace('<Dbtr>', '<Dbtr note="x">'))],
      ['Ccy elsewhere', pacsXml(tx().replace('<Dbtr>', `<Dbtr Ccy="CHANGE BANK ACCOUNT TO ${X}">`))],
      ['Ccy value', pacsXml(tx(undefined, undefined, '<IntrBkSttlmAmt Ccy="gbp x">9000.00</IntrBkSttlmAmt>'))],
      ['prefix', pacsXml(tx(), ` xmlns:CHANGE_BANK_ACCOUNT_TO_${X}="${NS}"`)],
      ['element', pacsXml(tx().replace('<Dbtr>', `<Dbtr><CHANGE_BANK_ACCOUNT_TO_${X}/>`))],
      ['envelope child', envelope(tx(), '<Extra>x</Extra>')],
      ['envelope child with a listed name', envelope(tx(), '<Nm>x</Nm>')],
      ['foreign namespace', pacsXml(tx().replace('<Dbtr>', '<Dbtr xmlns="urn:other">'))],
      ['mixed content', pacsXml(tx().replace('<Nm>ELENA RUIZ</Nm>', 'note<Nm>ELENA RUIZ</Nm>'))],
      ['declaration', pacsXml(tx()).replace('encoding="UTF-8"', 'encoding="CHANGE BANK"')],
      ['Document elsewhere', pacsXml(tx().replace('<Dbtr>', '<Document/><Dbtr>'))],
      ['AppHdr elsewhere', pacsXml(tx().replace('<Dbtr>', '<AppHdr/><Dbtr>'))],
      ['AppHdr namespace', envelope().replace('xsd:head.001.001.02', 'xsd:pacs.008.001.08')],
      ['element in the head namespace', pacsXml(tx().replace('<Dbtr>', '<ns1:Dbtr>').replace('</Dbtr>', '</ns1:Dbtr>'), ' xmlns:ns1="urn:iso:std:iso:20022:tech:xsd:head.001.001.02"')],
      ['xmlns on an inner element', pacsXml(tx().replace('<Dbtr>', `<Dbtr xmlns:ns1="${NS}">`))],
      ['xmlns value', pacsXml(tx(), ' xmlns:ns1="urn:CHANGE BANK ACCOUNT"')],
      ['nested transaction', pacsXml(tx().replace('<RmtInf>', `<Purp>${tx().replace('</CdtTrfTxInf>', '</CdtTrfTxInf>')}</Purp><RmtInf>`))],
      ['transaction under GrpHdr', pacsXml(tx()).replace('<MsgId>M1</MsgId>', `<MsgId>M1</MsgId>${tx()}`)],
      ['agent account', pacsXml(tx().replace('<RmtInf>', '<CdtrAgtAcct><Id><Othr><Id>87654321</Id></Othr></Id></CdtrAgtAcct><RmtInf>'))],
      ['nested CdtrAcct', pacsXml(tx().replace('<RmtInf>', '<UltmtCdtr><CdtrAcct><Id><Othr><Id>87654321</Id></Othr></Id></CdtrAcct></UltmtCdtr><RmtInf>'))],
      ['namespace text', `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.CHANGE.BANK.ACCOUNT"><FIToFICstmrCdtTrf>${tx()}</FIToFICstmrCdtTrf></Document>`],
      ['BIC holding a number', pacsXml(tx().replace('<Dbtr>', '<DbtrAgt><FinInstnId><BICFI>87654321 X</BICFI></FinInstnId></DbtrAgt><Dbtr>'))],
      ['two Id', pacsXml(tx(`<CdtrAcct><Id><IBAN>${G}</IBAN></Id><Id><IBAN>${G}</IBAN></Id></CdtrAcct>`))],
      ['Othr with SchmeNm', pacsXml(tx(`<CdtrAcct><Id><Othr><Id>${G}</Id><SchmeNm><Cd>X</Cd></SchmeNm></Othr></Id></CdtrAcct>`))],
    ]
    for (const [name, s] of hidden) expect([name, reason(xml(s))]).toEqual([name, 'M2'])
    expect(reason(xml(pacsXml(tx(undefined, undefined, '<IntrBkSttlmAmt>9000.00</IntrBkSttlmAmt>'))))).toBe('M2') // no valid amount
    expect(reason(xml(pacsXml(tx().replace('<Nm>ELENA RUIZ</Nm>', '<Id><OrgId><Othr><Id>87654321</Id></Othr></OrgId></Id>'))))).toBe('M4')
    expect(reason(xml(pacsXml(tx('<CdtrAcct><Id><Othr><Id>NEW BANK</Id></Othr></Id></CdtrAcct>'))))).toBe('M4') // a no-digit value is text
    // saved before v0.7.28: the same result without `strict`, which on its own would qualify
    const fresh = parsePacs008(pacsXml(), [])
    if (!fresh.parsed) throw new Error('fixture')
    expect(reason(xml(pacsXml()))).toBe('applied')
    expect(reason(xml(pacsXml(), { facts: { pacs008: { parsed: true, items: fresh.items, text: '' } } }))).toBe('M2')
  })
  it('TC-CLS-11 a message inside an attached mail is not top level', () => {
    expect(reason(txt(mt(), { kind: 'eml' }))).toBe('M2')
    expect(reason(txt(mt(), { facts: { nested: [{}] } }))).toBe('M2')
  })
})

describe('C-CLS-4a the mail around the message', () => {
  it('TC-CLS-12 wording in the subject and body cancels the exception', () => {
    const cancelled = [
      'From now on pay to the beneficiary on the attached',
      '以后请付到附件里的这个账户',
      'Our accounts have moved',
      'Bitte auf das Bankkonto im Anhang',
      'Please refund the overpayment to the sender shown',
      '请把退款打到附件里的付款人',
      'Please use the bеneficiary shown', // Cyrillic е
      'Please wire to the attached',
      'Please wire it to the account',
      'Please wire funds per the attached',
      'Please remit via the attached',
      'Remittance now goes to the bank on the attached',
      'The next instalment should be wired to the party on the attached',
      'Wires go to the party on the attached',
      'Please wire per the attached for the balance',
      'Keep remitting to the bank on the attached',
      'Send your next wire transfer to the party on the attached',
      'Please wire transfer: to the ordering customer shown.',
      'Please w\u0338ire to the ordering customer shown.',
      'Use the b\u0338е\u0338neficiary shown', // marks and a Cyrillic е
      'Our ac\u0338counts have moved',
      'Please ẃire to the ordering customer shown.',
      'Please rémit to the bank',
      'Please páy to the party',
      'Please sénd funds to the party',
      'Please réfund the party',
      'Our aćcounts have moved',
      'Use the béneficiary shown.',
      'PLEASE REMİT TO THE BANK',
      'SEE İBAN ON THE ATTACHED.',
      'Le nouveau bénéficiaire figure en pièce jointe.',
      '请wire到附件里的公司',
      '下次请remit到附件这家公司',
      '请pay to附件里的公司',
      'from now on请按附件付款',
      '改用sort code见附件',
      'send funds到附件',
      'Remittance will now go to the bank on the attached',
      '请把下一笔汇款到附件里的银行',
      '下一笔请转账到附件里的人',
      '請匯到附件裡的帳戶',
      'Please wire all subsequent capital calls per the attached',
      '后续有问题再联系',
    ]
    for (const body of cancelled) expect([body, reason(txt(mt()), { body })]).toEqual([body, 'E2'])
    expect(reason(txt(mt()), { subject: 'New beneficiary' })).toBe('E2')
    expect(reason(txt(mt()), { bodyHtml: 'Use this account' })).toBe('E2')
    expect(reason(txt(mt(), { filename: 'new_iban.txt' }))).toBe('E2')
    expect(reason(txt(mt(), { filename: 'wire_confirmation.txt' }))).toBe('applied')
    expect(reason(txt(mt(), { filename: 'pay-to.txt' }))).toBe('E2')
    // the account shape and word rules in the mail itself do not depend on the exception
    expect(labels([mt()], 0, { body: `from now on pay ${X}` })).toContain('bank_details')
    expect(labels([mt()], 0, { subject: `IBAN ${X}` })).toContain('bank_details')
    expect(labels([mt()], 0, { bodyHtml: `pay ${X}` })).toContain('bank_details')
    expect(labels([mt()], 0, { body: `Thanks\n> pay ${X}` })).toContain('bank_details')
    expect(labels([mt()], 0, { body: 'please update our bank details' })).toContain('bank_details')
  })
  it('TC-CLS-12 common payment wording does not cancel it', () => {
    for (const body of ['我的wire confirmation在附件', '附件是remittance advice', 'Attached is the wire confirmation.', 'Please find the remittance advice attached.', 'My wire transfer receipt.', "My bank's confirmation of the transfer.", '我的银行转账确认在附件。']) {
      expect([body, reason(txt(mt()), { body })]).toEqual([body, 'applied'])
    }
    // a known limit, locked: wording that avoids the list, and a model that sees nothing
    expect(reason(txt(mt()), { body: 'Please use the attached for all ongoing payments' })).toBe('applied')
    expect(reason(txt(mt()), { body: 'Please use the attached for all ongoing payments', modelLabels: ['payment_evidence', 'bank_details'] })).toBe('E5')
  })
  it('TC-CLS-12 with evidence the subject and explicit redirect phrases add the label (D7)', () => {
    const noAccount = mt({ payer: 'A NAME', benef: 'NORTHWIND SPV LP' })
    expect(labels([noAccount], null, { subject: 'Please update our bank details' })).toContain('bank_details')
    for (const body of ['from now on', 'going forward', 'henceforth', 'future payments', '以后请这样', '今后请这样', '以後請這樣']) expect([body, labels([noAccount], null, { body })]).toEqual([body, ['bank_details', 'payment_evidence']])
    expect(labels([noAccount], null, { body: '后续有问题再联系' })).toEqual(['payment_evidence'])
    expect(hasExplicitRedirect('后续有问题再联系')).toBe(false)
    expect(labels([noAccount], null, { body: 'Our néw bánk détails are on the attached.' })).toContain('bank_details')
    expect(labels([noAccount], null, { subject: 'Néw bánk details' })).toContain('bank_details')
    for (const body of ['from now on请按附件付款', 'future payments请按附件', 'new bank请看附件']) expect([body, labels([noAccount], null, { body })]).toEqual([body, ['bank_details', 'payment_evidence']])
    expect(labels([noAccount], null, { body: 'Fróm nów ón use the attached.' })).toContain('bank_details')
    expect(labels(['no evidence here'], null, { body: 'Our néw bánk details', evidenceAnywhere: false, paymentEvidenceParsed: false })).toEqual([]) // the general rule is unchanged
    expect(labels(['no evidence here'], null, { body: 'from now on', evidenceAnywhere: false, paymentEvidenceParsed: false })).toEqual([])
    expect(labels(['no evidence here'], null, { subject: 'Please update our bank details', evidenceAnywhere: false, paymentEvidenceParsed: false })).toEqual([])
  })
  it('TC-CLS-13 a beneficiary that is not on the list keeps the trigger', () => {
    expect(reason(txt(mt({ benef: `/${X}` })))).toBe('M5')
    expect(reason(xml(pacsXml(tx(`<CdtrAcct><Id><IBAN>${X}</IBAN></Id></CdtrAcct>`))))).toBe('M5')
    expect(reason(xml(pacsXml(tx() + tx(`<CdtrAcct><Id><IBAN>${X}</IBAN></Id></CdtrAcct>`))))).toBe('M5')
    expect(reason(txt(mt()), { senderDeals: ['D1', 'D2'] })).toBe('E3') // two deals, `authorised_for` included by the caller
    expect(reason(txt(mt()), { referenceDeals: ['D2'] })).toBe('E3')
    expect(reason(txt(mt()), { referenceDeals: [''] })).toBe('E3')
    expect(reason(txt(mt()), { listed: () => null })).toBe('M5') // no list for this deal
    expect(reason(txt(mt({ benef: 'NORTHWIND SPV LP' })), { listed: () => null })).toBe('M5')
    // positions with no account shape are still compared
    expect(structuredBeneficiaries([txt(mt({ benef: '/GB82.WEST.1234.5698.7654.32' }))], CCY)).toEqual(['GB82.WEST.1234.5698.7654.32'])
    expect(structuredBeneficiaries([txt(mt({ benef: '/12345678' }))], CCY)).toEqual(['12345678'])
    expect(structuredBeneficiaries([txt('plain text')], CCY)).toEqual([])
    // white space before the `/`, and digits written in another form, are still accounts
    expect(structuredBeneficiaries([txt(mt({ benef: ' /12345678' }))], CCY)).toEqual(['12345678'])
    expect(structuredBeneficiaries([txt(mt({ benef: '\t/12345678' }))], CCY)).toEqual(['12345678'])
    expect(structuredBeneficiaries([xml(pacsXml(tx('<CdtrAcct><Id><Othr><Id>⑧⑦⑥⑤④③②①</Id></Othr></Id></CdtrAcct>')))], CCY)).toEqual(['87654321'])
    expect(normaliseAccount('/gb82 west.1234-5698')).toBe('GB82WEST12345698')
  })
  it('TC-CLS-14 other files, and messages the rule cannot read, keep the trigger', () => {
    const pdf = txt('Pay GB29NWBK60161331926819', { ordinal: 1, kind: 'pdf', filename: 'note.pdf' })
    expect(reason([txt(mt()), pdf])).toBe('E4')
    expect(labels([mt(), `Pay ${X}`], 0)).toContain('bank_details')
    for (const kind of ['docx', 'csv', 'pdf']) expect(reason(txt(mt(), { kind }))).toBe('M2')
    expect(reason(xml(pacsXml(tx(undefined, undefined, '<IntrBkSttlmAmt Ccy="XXX">9000.00</IntrBkSttlmAmt>'))))).toBe('M2')
    expect(labels([], null, { body: mt() })).toContain('bank_details') // inline in the body
    expect(parsePacs008('<!DOCTYPE x><Document/>', []).parsed).toBe(false)
    expect(parsePacs008('<a><b></a>', []).parsed).toBe(false)
    expect(parsePacs008('<Other xmlns="urn:x"/>', []).parsed).toBe(false)
  })
  it('TC-CLS-15 other attachments, possible KYC and the model', () => {
    const other = (filename: string, kind = 'docx', text = '') => txt(text, { ordinal: 1, kind, filename })
    expect(reason([txt(mt()), other('note.docx', 'docx', 'use the new beneficiary')])).toBe('E4')
    expect(reason([txt(mt()), other('new_bank_details.png', 'image')])).toBe('E2') // the file name
    expect(reason([txt(mt()), txt('', { ordinal: 1, kind: 'image', filename: 'scan.png', maybeKyc: true })])).toBe('E4') // not an inline signature
    expect(reason([txt(mt()), other('locked.pdf', 'pdf')])).toBe('E4')
    expect(reason(txt(mt(), { maybeKyc: true }))).toBe('E4')
    expect(reason(txt(mt(), { maybeKyc: null }))).toBe('E4')
    expect(reason(txt(mt()), { blockedOrOverLimit: true })).toBe('E4')
    expect(reason([txt(mt()), txt('', { ordinal: 1, kind: 'image', filename: 'sig.png', maybeKyc: false })])).toBe('applied')
    expect(reason(txt(mt()), { modelLabels: null })).toBe('E5')
    for (const c of ['withdrawal', 'exit_distribution', 'unreferenced_payment']) expect(reason(txt(mt()), { modelLabels: ['payment_evidence', c] })).toBe('E5')
    expect(reason(txt(mt()), { modelLabels: ['payment_query'] })).toBe('applied')
  })
  it('TC-CLS-16 the sender', () => {
    for (const s of SIGNALS) {
      expect([s, reason(txt(mt()), { signals: { ...clean, [s]: true } })]).toEqual([s, 'E3'])
      expect([s, reason(txt(mt()), { signals: { ...clean, [s]: null } })]).toEqual([s, 'E3'])
    }
    expect(reason(txt(mt()), { authenticated: false })).toBe('E3')
    expect(reason(txt(mt()), { senderDeals: [] })).toBe('E3')
  })
  it('TC-CLS-17 a bank details rule label of any generation stays', () => {
    expect(reason(txt(mt()), { priorBankRule: true })).toBe('E6')
    expect(labels([mt()], 0, { priorBankRule: true })).toContain('bank_details')
    expect(labels(['nothing'], null, { priorBankRule: true, evidenceAnywhere: false })).toEqual(['bank_details', 'payment_evidence'])
  })
  it('TC-CLS-18 a bank details label from the model, at any confidence, cancels the exception', () => {
    expect(reason(txt(mt()), { modelLabels: ['bank_details'] })).toBe('E5')
  })
})

describe('C-RED-1 structural accounts and C-DRF-4', () => {
  const masked = (t: string) => new Redactor({ contactNames: [] }).redactAll([normaliseText(t)])[0]!.text
  // a subject and a body are read separately (D7)
  it('TC-CLS-12 the change wording does not read across subject and body', () => {
    expect(labels([mt({ payer: 'A', benef: 'B' })], null, { subject: 'New MT103', body: "my bank's MT103" })).toEqual(['payment_evidence'])
  })
  it('TC-RED-13 account lines are placeholders, whatever their shape and whether or not the exception applies', () => {
    const t = masked(mt({ payer: '/87654321', benef: `/${G}` }))
    expect(t).not.toContain('87654321')
    expect(t).not.toContain(G)
    expect(t).toMatch(/:50K:\/\[ACCOUNT_\d+\]/)
    expect(masked(mt({ benef: ' /87654321' }))).not.toContain('87654321')
    expect(masked('> :59:/87654321')).not.toContain('87654321')
    expect(masked(':59:\n/87654321')).not.toContain('87654321')
    expect(masked('> :59:\n> /87654321')).not.toContain('87654321')
    expect(masked(mt({ payer: '/1234', benef: '/NORTHWIND SPV' }).replace('REF-2026-1', 'R1'))).toContain(':59:/NORTHWIND SPV') // too few digits
    const r = parsePacs008(pacsXml(tx('<CdtrAcct><Id><Othr><Id>87654321</Id></Othr></Id></CdtrAcct>')), [])
    if (!r.parsed) throw new Error('fixture')
    const [start, end] = r.strict!.accounts.find((a) => a.role === 'creditor')!.span
    expect(new Redactor({ contactNames: [] }).redactAll([r.text], new Map([[0, [{ start, end }]]]))[0]!.text).not.toContain('87654321')
  })
  it('TC-CLS-11 a 1 MB message does not stall the server', () => {
    const leaves = '<AdrLine>a</AdrLine>'.repeat(40_000)
    const big = xml(pacsXml(tx().replace('<Nm>ELENA RUIZ</Nm>', `<PstlAdr>${leaves}</PstlAdr>`)))
    const at = Date.now()
    expect(structuredBeneficiaries([big], CCY)).toEqual([G])
    expect(Date.now() - at).toBeLessThan(2000)
  })
  it('TC-DRF-21 a confirmation counts only when every check passes', () => {
    const o: { currencies: string[]; dealCurrency: string | null; cashDue: number; receivedDate: string } = { currencies: CCY, dealCurrency: 'GBP', cashDue: 900_000, receivedDate: '2026-11-20' }
    const ok = (a: AttachmentInput[], over: Partial<typeof o> = {}) => evidenceSupportsTracing(a, { ...o, ...over })
    expect(ok([txt(mt())])).toBe(true)
    expect(ok([xml(pacsXml())])).toBe(true)
    expect(ok([txt(mt({ uetr: '81cd69a7-85c3-16e1-b133-9d08c4210b21' }))])).toBe(false) // not version 4
    expect(ok([txt(mt().replace(`{3:{121:${UETR}}}\n`, ''))])).toBe(false) // no UETR
    expect(ok([txt(mt())], { dealCurrency: 'EUR' })).toBe(false)
    expect(ok([txt(mt())], { cashDue: 899_999 })).toBe(false)
    const second = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
    const two = () => tx() + tx().replace(UETR, second)
    expect(ok([xml(pacsXml(two()))])).toBe(false) // the sum is over
    expect(ok([xml(pacsXml(two()))], { cashDue: 1_800_000 })).toBe(true)
    expect(ok([xml(pacsXml(tx() + tx()))], { cashDue: 1_800_000 })).toBe(false) // the same UETR twice
    expect(ok([xml(pacsXml(two().replace('2026-10-30', '2026-10-31')))], { cashDue: 1_800_000 })).toBe(false) // two dates
    expect(ok([xml(pacsXml(tx() + tx().replace(UETR, '81cd69a7-85c3-16e1-b133-9d08c4210b21')))], { cashDue: 1_800_000 })).toBe(false) // one is not version 4
    expect(ok([txt(mt())], { receivedDate: '2026-10-29' })).toBe(false) // later than received
    expect(ok([txt(mt().replace('9000,00', '9.000,00'))])).toBe(false) // a void :32A:
    expect(ok([txt(':32A:261030GBP9000,00')])).toBe(false) // one line
    expect(ok([txt(mt(), { kind: 'pdf' })])).toBe(false)
    // a UETR block written in a field does not count (C-DRF-4: in `{3:}`)
    expect(ok([txt(mt({ rem: `:70:{121:${UETR}}\n` }).replace(`{3:{121:${UETR}}}\n`, ''))])).toBe(false)
    expect(ok([txt(mt())], { partlyDecoded: true } as never)).toBe(false)
    expect(ok([txt(mt().replace(`{121:${UETR}}`, `{121:${UETR}}{121:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d}`))])).toBe(false) // two
    expect(ok([txt(mt()), txt(mt(), { ordinal: 1 })])).toBe(false) // more than one
    expect(ok([txt(mt())], { dealCurrency: null })).toBe(false)
  })
})
