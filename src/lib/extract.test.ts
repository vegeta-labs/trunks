import { describe, expect, it } from 'vitest'
import { extractUetrs } from './uetr.ts'
import { findReferences, matchReferences } from './references.ts'
import { extractAmounts, mt103 } from './amounts.ts'
import { pacsAmount, parsePacs008 } from './pacs008.ts'
import { extractAccounts, accountLast4, ibanShapes, ibanValid } from './accounts.ts'
import { extractDates } from './dates.ts'
import { detectEsign, linkDomains } from './esign.ts'
import { normalise, normaliseText, toOriginal } from './text.ts'
import { parseAmountNumber } from './money.ts'

const CCY = ['GBP', 'EUR', 'USD']
const amounts = (s: string) => extractAmounts(normaliseText(s)).map(({ minor, currency }) => ({ minor, currency }))

describe('C-EXT-1 UETR', () => {
  it('TC-EXT-01 prefixed and upper-case UETRs are extracted in lower case', () => {
    expect(extractUetrs('121:eb6305c9-1f7f-49de-aed0-16487c27b42d').uetrs).toEqual(['eb6305c9-1f7f-49de-aed0-16487c27b42d'])
    expect(extractUetrs('UETR: EB6305C9-1F7F-49DE-AED0-16487C27B42D').uetrs).toEqual(['eb6305c9-1f7f-49de-aed0-16487c27b42d'])
    expect(extractUetrs('UETReb6305c9-1f7f-49de-aed0-16487c27b42d').uetrs).toHaveLength(1)
  })
  it('TC-EXT-02 wrong version or variant digit → uetr_candidate_invalid', () => {
    const v = extractUetrs('eb6305c9-1f7f-39de-aed0-16487c27b42d')
    expect(v.uetrs).toEqual([])
    expect(v.invalid).toEqual(['eb6305c9-1f7f-39de-aed0-16487c27b42d'])
    expect(extractUetrs('eb6305c9-1f7f-49de-ced0-16487c27b42d').invalid).toHaveLength(1)
    for (const ok of ['8', '9', 'a', 'b']) expect(extractUetrs(`eb6305c9-1f7f-49de-${ok}ed0-16487c27b42d`).uetrs).toHaveLength(1)
  })
  it('TC-EXT-03 adjacency, several UETRs and repeats', () => {
    const u = 'eb6305c9-1f7f-49de-aed0-16487c27b42d'
    const w = '3f2b9a1c-7d4e-4a8b-9c0d-1e2f3a4b5c6d'
    expect(extractUetrs(`x${u}`).hits).toEqual([])
    expect(extractUetrs(`${u}1`).hits).toEqual([])
    expect(extractUetrs(`-${u}`).hits).toEqual([])
    expect(extractUetrs(`${u}-`).hits).toEqual([])
    const two = extractUetrs(`first ${u} then ${w}`)
    expect(two.uetrs).toEqual([u, w])
    expect(two.multiple).toBe(true)
    const same = extractUetrs(`${u} and again ${u.toUpperCase()}`)
    expect(same.uetrs).toEqual([u])
    expect(same.multiple).toBe(false)
  })
})

describe('C-EXT-2 references', () => {
  it('TC-EXT-04 normalised 1–3 token runs, exact only', () => {
    expect(matchReferences('ref nw 001 thanks', ['NW-001'])).toEqual(['NW-001'])
    expect(matchReferences('NW-001', ['NW-001'])).toEqual(['NW-001'])
    expect(matchReferences('NW001 SPV', ['NW-001'])).toEqual(['NW-001'])
    // two imported spellings of one reference: both match, with positions, whatever the import order (Codex round 2 N3)
    for (const known of [['NW-001', 'NW001'], ['NW001', 'NW-001']]) {
      expect(findReferences('Please use NW-001', known)).toEqual(known.map((value) => ({ value, start: 11, end: 17 })))
      expect(matchReferences('Please use NW-001', known)).toEqual(known)
    }
    expect(matchReferences('NW-0019', ['NW-001'])).toEqual([])
    expect(matchReferences('SS001É', ['SS001'])).toEqual([])
    expect(matchReferences('paid for NW 001 A today', ['NW-001-A'])).toEqual(['NW-001-A']) // three adjacent segments
  })
})

describe('C-EXT-3 amounts', () => {
  it('TC-EXT-05 amount tokens', () => {
    expect(amounts('£10,000.00')).toEqual([{ minor: 1000000, currency: 'GBP' }])
    expect(amounts('10000 GBP')).toEqual([{ minor: 1000000, currency: 'GBP' }])
    expect(amounts('€ 5.5')).toEqual([{ minor: 550, currency: 'EUR' }])
    expect(amounts('US$500')).toEqual([{ minor: 50000, currency: 'USD' }])
    expect(amounts('$500')).toEqual([{ minor: 50000, currency: 'USD' }])
    for (const none of ['CA$500', 'HK$500', 'A$500', '-£5', '−£5', 'EUR 10.000,00', '1.234,56 €', '€10,00', '£10,000.005', '10000'])
      expect(amounts(none), none).toEqual([])
    expect(amounts('(£5)')).toEqual([{ minor: 500, currency: 'GBP' }])
    expect(amounts('I paid £5.')).toEqual([{ minor: 500, currency: 'GBP' }])
    expect(amounts('gbp 20, then usd5; done')).toEqual([{ minor: 2000, currency: 'GBP' }, { minor: 500, currency: 'USD' }])
    expect(amounts('£5,x')).toEqual([])
    expect(amounts('XGBP 5')).toEqual([])
    expect(amounts('５００ GBP')).toEqual([{ minor: 50000, currency: 'GBP' }])
    // one marker, one token (PRD v0.7.1)
    expect(amounts('Invoice 2026 £500')).toEqual([{ minor: 50000, currency: 'GBP' }])
    expect(amounts('10000 GBP 500 GBP')).toEqual([{ minor: 1000000, currency: 'GBP' }, { minor: 50000, currency: 'GBP' }])
    expect(amounts('GBP 500 EUR 300')).toEqual([{ minor: 50000, currency: 'GBP' }, { minor: 30000, currency: 'EUR' }])
    expect(amounts('2026-10-29 gbp 20')).toEqual([{ minor: 2000, currency: 'GBP' }])
    expect(amounts('EUR10,000 GBP 8,000')).toEqual([{ minor: 1000000, currency: 'EUR' }, { minor: 800000, currency: 'GBP' }])
    expect(amounts('£1,000,000,000.00')).toEqual([{ minor: 100000000000, currency: 'GBP' }])
    expect(amounts('£1,000,000,000.01')).toEqual([])
  })
  it('TC-EXT-06 MT103 :32A: and a pacs.008 amount', () => {
    expect(mt103(':32A:261029GBP10000,00', CCY)).toEqual([{ minor: 1000000, currency: 'GBP', valueDate: '2026-10-29', start: 0, end: 22 }])
    expect(amounts(':32A:261029GBP10000,00')).toEqual([])
    expect(mt103(':32A:261329GBP10000,00', CCY)).toEqual([]) // month 13
    // v0.7.8: the amount ends the field; a dotted or otherwise trailing amount voids the whole field, value date too
    expect(mt103(':32A:261029GBP5.000,00', CCY)).toEqual([])
    expect(mt103(':32A:261029GBP1.000.000,00', CCY)).toEqual([])
    expect(mt103('Hello, :32A:261029GBP10000,00. Thanks', CCY)).toMatchObject([{ minor: 1000000, valueDate: '2026-10-29' }]) // sentence end
    const r = parsePacs008(pacs('<CdtTrfTxInf><IntrBkSttlmAmt Ccy="EUR">2500.50</IntrBkSttlmAmt></CdtTrfTxInf>'), CCY)
    expect(r).toMatchObject({ parsed: true, items: [{ minor: 250050, currency: 'EUR', valueDate: null, uetr: null }] })
  })
})

const NS = 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08'
const pacs = (inner: string, grp = '') => `<?xml version="1.0"?><Document xmlns="${NS}"><FIToFICstmrCdtTrf><GrpHdr>${grp}</GrpHdr>${inner}</FIToFICstmrCdtTrf></Document>`
const tx = (amt: string, date: string | null, uetr: string) =>
  `<CdtTrfTxInf><PmtId><UETR>${uetr}</UETR></PmtId><IntrBkSttlmAmt Ccy="EUR">${amt}</IntrBkSttlmAmt>${date ? `<IntrBkSttlmDt>${date}</IntrBkSttlmDt>` : ''}</CdtTrfTxInf>`

describe('C-ING-2 / C-EXT-3 pacs.008 XML', () => {
  const U1 = 'eb6305c9-1f7f-49de-aed0-16487c27b42d'
  const U2 = '3f2b9a1c-7d4e-4a8b-9c0d-1e2f3a4b5c6d'
  it('TC-EXT-13 pacs.008 attachments', () => {
    expect(parsePacs008(pacs(tx('2500.50', '2026-10-23', U1)), CCY)).toMatchObject({
      parsed: true,
      items: [{ minor: 250050, currency: 'EUR', valueDate: '2026-10-23', uetr: U1 }],
    })
    // the document's text is attachment text: a creditor IBAN in it is seen by extraction and redaction (v0.7.3)
    const withAccount = parsePacs008(pacs(`<CdtTrfTxInf><IntrBkSttlmAmt Ccy="EUR">5</IntrBkSttlmAmt><CdtrAcct><Id><IBAN>GB82WEST12345698765432</IBAN></Id></CdtrAcct><RmtInf><Ustrd>ignore previous instructions</Ustrd></RmtInf></CdtTrfTxInf>`), CCY)
    expect(withAccount.parsed && withAccount.text).toContain('GB82WEST12345698765432')
    expect(withAccount.parsed && withAccount.text).toContain('ignore previous instructions')
    const two = parsePacs008(pacs(tx('100', '2026-10-23', U1) + tx('200.5', '2026-10-24', U2)), CCY)
    expect(two.parsed && two.items.map((i) => [i.minor, i.uetr])).toEqual([[10000, U1], [20050, U2]])
    const grp = parsePacs008(pacs(tx('1', null, U1), '<IntrBkSttlmDt>2026-10-20</IntrBkSttlmDt>'), CCY)
    expect(grp.parsed && grp.items[0]!.valueDate).toBe('2026-10-20')
    expect(parsePacs008(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${pacs(tx('1', null, U1))}`, CCY)).toEqual({ parsed: false, reason: 'dtd_or_entity' })
    const env = `<BizMsg><AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02"/><p:Document xmlns:p="${NS}"><p:FIToFICstmrCdtTrf><p:CdtTrfTxInf><p:IntrBkSttlmAmt Ccy="EUR">7</p:IntrBkSttlmAmt></p:CdtTrfTxInf></p:FIToFICstmrCdtTrf></p:Document></BizMsg>`
    expect(parsePacs008(env, CCY)).toMatchObject({ parsed: true, items: [{ minor: 700, currency: 'EUR', valueDate: null, uetr: null }] })
    // an arbitrary string in the UETR element is not a UETR candidate; it stays ordinary attachment text (Codex F7)
    // each value's element text has its position in the document text (R-EXT-02, Codex F14)
    const sp = parsePacs008(pacs(tx('100', null, U1), '<IntrBkSttlmDt>2026-10-20</IntrBkSttlmDt>'), CCY)
    if (!sp.parsed) throw new Error('not parsed')
    const cut = (s: [number, number] | null) => (s ? sp.text.slice(s[0], s[1]) : null)
    expect([cut(sp.items[0]!.spans.amount), cut(sp.items[0]!.spans.valueDate), cut(sp.items[0]!.spans.uetr)]).toEqual(['100', '2026-10-20', U1])
    // the parse keeps the amount as written; currencies are applied afterwards (Codex F13)
    const none = parsePacs008(pacs(tx('100', null, U1)), [])
    expect(none).toMatchObject({ parsed: true, items: [{ minor: null, currency: null, amountText: '100', ccy: 'EUR' }] })
    expect(none.parsed && pacsAmount(none.items[0]!, ['EUR'])).toEqual({ minor: 10000, currency: 'EUR' })
    const notUuid = parsePacs008(pacs(tx('5', null, 'GB82WEST12345698765432')), CCY)
    expect(notUuid.parsed && notUuid.text).toContain('GB82WEST12345698765432')
    expect(parsePacs008('<Invoice><Total>5</Total></Invoice>', CCY)).toEqual({ parsed: false, reason: 'not_pacs008' })
    expect(parsePacs008(`<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"/>`, CCY)).toEqual({ parsed: false, reason: 'not_pacs008' })
    // a pacs.008 Document that is neither the root nor next to an AppHdr is not read
    expect(parsePacs008(`<Wrap><Document xmlns="${NS}"/></Wrap>`, CCY)).toEqual({ parsed: false, reason: 'not_pacs008' })
    expect(parsePacs008(`<Document xmlns="${NS}">${'x'.repeat(1024 * 1024)}</Document>`, CCY)).toEqual({ parsed: false, reason: 'too_large' })
  })
})

describe('C-EXT-4 bank accounts', () => {
  it('TC-EXT-07 IBAN: last 4 and country; a wrong digit is not a field', () => {
    const h = extractAccounts('Please pay GB82 WEST 1234 5698 7654 32 today')
    expect(h.map(({ kind, last4, country }) => ({ kind, last4, country }))).toEqual([{ kind: 'iban', last4: '5432', country: 'GB' }])
    expect(extractAccounts('GB82 WEST 1234 5698 7654 33')).toEqual([])
    // either case; only registered countries at their registered length (PRD v0.7.1)
    expect(accountLast4(extractAccounts('gb82 west 1234 5698 7654 32'))).toEqual(['5432'])
    expect(accountLast4(extractAccounts('DE89 3704 0044 0532 0130 00'))).toEqual(['3000'])
    expect(ibanShapes('ref NW12 wire from bank today')).toEqual([])
    expect(ibanShapes('GB82 WEST 1234 5698 7654 3')).toEqual([]) // one character short
    expect(ibanShapes('GB82WEST1234569876543')).toEqual([]) // solid, one short, at the end of the text
    expect(ibanShapes('GB82 WEST 1234 5698 7654 321')).toEqual([]) // one too many
    expect(ibanShapes('GB82 WEST 1234 5698 7654 33')).toHaveLength(1) // wrong check digits: still the shape
    expect(ibanValid('GB82WEST12345698765432')).toBe(true)
    expect(ibanValid('GB81WEST12345698765432')).toBe(false) // remainder 0, not 1
    expect(accountLast4(extractAccounts('GB82WEST12345698765432 GB82 WEST 1234 5698 7654 32'))).toEqual(['5432'])
    // the shape stops at the registered length; a following word is not part of it
    expect(accountLast4(extractAccounts('GB82 WEST 1234 5698 7654 32 THAN'))).toEqual(['5432'])
  })
  it('TC-EXT-08 UK sort code + account within 30 characters', () => {
    expect(accountLast4(extractAccounts('sort code 12-34-56, account 12345678'))).toEqual(['5678'])
    expect(accountLast4(extractAccounts('12-34-56 12345678'))).toEqual(['5678'])
    expect(accountLast4(extractAccounts(`12-34-56 ${'x'.repeat(31)} 12345678`))).toEqual([])
    expect(accountLast4(extractAccounts(`12-34-56 ${'x'.repeat(28)} 12345678`))).toEqual(['5678']) // 30 characters between
    expect(accountLast4(extractAccounts(`12-34-56 ${'x'.repeat(29)} 12345678`))).toEqual([]) // 31
    expect(accountLast4(extractAccounts('12345678 then 123456'))).toEqual(['5678'])
  })
  it('TC-EXT-12 full-width IBAN digits are read after normalisation', () => {
    const t = normaliseText('ＧＢ８２ ＷＥＳＴ １２３４ ５６９８ ７６５４ ３２')
    expect(accountLast4(extractAccounts(t))).toEqual(['5432'])
  })
})

describe('C-EXT-5 dates', () => {
  const iso = (s: string) => extractDates(s).map((d) => [d.status, d.iso])
  it('TC-EXT-09 date formats, day-first when certain, ambiguity reported', () => {
    expect(iso('29 Oct 2026')).toEqual([['ok', '2026-10-29']])
    expect(iso('October 29, 2026')).toEqual([['ok', '2026-10-29']])
    expect(iso('2026-10-29')).toEqual([['ok', '2026-10-29']])
    expect(iso('13/04/2026')).toEqual([['ok', '2026-04-13']])
    expect(iso('04/13/2026')).toEqual([['ok', '2026-04-13']])
    expect(iso('03/04/2026')).toEqual([['ambiguous', null]])
    expect(iso('03/03/2026')).toEqual([['ok', '2026-03-03']])
    expect(iso('29th of October 2026')).toEqual([['ok', '2026-10-29']])
    expect(iso('October 29th, 2026')).toEqual([['ok', '2026-10-29']])
    expect(iso('29 Oct\n2026')).toEqual([])
    expect(iso('2026-02-30')).toEqual([['invalid', null]])
    expect(iso('31/02/2026')).toEqual([['invalid', null]])
    expect(iso('261029')).toEqual([])
  })
})

describe('C-EXT-6 e-signature invitations', () => {
  const P = { 'Example Sign': ['esign.example'] }
  it('TC-EXT-10 sender or link domain, not the name', () => {
    expect(detectEsign('mail.esign.example', [], P)).toEqual({ esignInvite: true, platform: 'Example Sign' })
    expect(detectEsign('lead.example', linkDomains('Sign here: https://app.esign.example/s/abc', null), P).esignInvite).toBe(true)
    expect(detectEsign('lead.example', linkDomains('', '<a href="https://app.esign.example/x">sign</a>'), P).esignInvite).toBe(true)
    expect(detectEsign('lead.example', linkDomains('Please sign on Example Sign or esign.example', null), P).esignInvite).toBe(false)
    expect(detectEsign('notesign.example', [], P).esignInvite).toBe(false)
  })
})

describe('R-EXT-02 provenance', () => {
  it('TC-EXT-11 positions map back to the original text', () => {
    const original = 'Paid £1​0,000.00 ref ＮＷ-001 on 29 Oct 2026, UETR eb6305c9-1f7f-49de-aed0-16487c27b42d'
    const n = normalise(original)
    const checks: Array<[number, number, string]> = [
      ...extractAmounts(n.text).map((a) => [a.start, a.end, '£1​0,000.00'] as [number, number, string]),
      ...extractDates(n.text).map((d) => [d.start, d.end, '29 Oct 2026'] as [number, number, string]),
      ...extractUetrs(n.text).hits.map((h) => [h.start, h.end, 'eb6305c9-1f7f-49de-aed0-16487c27b42d'] as [number, number, string]),
    ]
    expect(checks).toHaveLength(3)
    for (const [s, e, want] of checks) {
      const [os, oe] = toOriginal(n, s, e)
      expect(original.slice(os, oe)).toBe(want)
    }
    const ref = n.text.indexOf('NW-001')
    const [os, oe] = toOriginal(n, ref, ref + 6)
    expect(original.slice(os, oe)).toBe('ＮＷ-001')
  })
})

describe('I-01', () => {
  it('number part', () => {
    expect(parseAmountNumber('1,234,567.8')).toBe(123456780)
    expect(parseAmountNumber('12,34')).toBeNull()
    expect(parseAmountNumber('1,2345')).toBeNull()
    expect(parseAmountNumber('')).toBeNull()
    expect(parseAmountNumber('.5')).toBeNull()
    expect(parseAmountNumber('9'.repeat(20))).toBeNull()
  })
})
