import { describe, expect, it } from 'vitest'
import { Redactor } from './redact.ts'
import { normaliseText } from './text.ts'
import { matchReferences } from './references.ts'
import { extractAmounts } from './amounts.ts'
import { extractUetrs } from './uetr.ts'

const CONTACTS = ['Amelia Hart', 'Jo Li']
const red = (s: string, names = CONTACTS) => new Redactor({ contactNames: names }).redact(normaliseText(s))

const SAMPLE = [
  'Dear team, I am Amelia Hart.',
  'Please pay GB82 WEST 1234 5698 7654 32 and again GB82WEST12345698765432.',
  'Sort code 20-00-00, account 55779911.',
  'Passport number 123456789. Date of birth: 03/04/1980.',
  '', // a blank line ends the address block above the postcode (C-RED-1 v0.7.3)
  'I live at 1 Example Road, London SW1A 1AA',
  'Call me on +44 7700 900123 or 020 7946 0000.',
  'Email amelia.hart@hartfamily.example',
].join('\n')

describe('C-RED-1 redaction', () => {
  it('TC-RED-01 every sensitive kind is replaced; one value, one placeholder', () => {
    const r = red(SAMPLE)
    expect(r.text).toContain('[ACCOUNT_1] and again [ACCOUNT_1].')
    expect(r.text).toContain('Sort code [SORTCODE_1], account [ACCOUNT_2].')
    expect(r.text).toContain('Passport number [ID_1].')
    expect(r.text).toContain('Date of birth: [DOB_1].')
    expect(r.text).toContain('[ADDRESS_1]')
    expect(r.text).not.toContain('Example Road')
    expect(r.text).toContain('Call me on [PHONE_1] or [PHONE_2].')
    expect(r.text).toContain('[EMAIL_1]@hartfamily.example')
    expect(r.text).toContain('I am [NAME_1] [NAME_2].')
    // "Jo" is shorter than 3 characters and is not a name placeholder; three letters are
    expect(red('Jo said hi').text).toBe('Jo said hi')
    expect(red('Amy Fox said hi', ['Amy Fox']).text).toBe('[NAME_1] [NAME_2] said hi')
  })
  it('TC-RED-01 a value found once is replaced wherever it appears again (v0.7.3)', () => {
    const r = new Redactor({ contactNames: [] })
    const [subject, body, file] = r.redactAll([
      'Payment to 12345678 today',
      'Account number 12345678. My passport number is 123456789.\nKind regards and many thanks, let me know if you need the number again: 123456789',
      'statement_12345678.pdf',
    ]).map((x) => x.text)
    expect(subject).toBe('Payment to [ACCOUNT_1] today')
    expect(body).toBe('Account number [ACCOUNT_1]. My passport number is [ID_1].\nKind regards and many thanks, let me know if you need the number again: [ID_1]')
    expect(file).toBe('statement_[ACCOUNT_1].pdf')
    // the same IBAN written solid elsewhere, the same phone with other spacing
    expect(red('GB82 WEST 1234 5698 7654 32 / GB82WEST12345698765432').text).toBe('[ACCOUNT_1] / [ACCOUNT_1]')
    expect(red('call 07700 900123, or 07700900123').text).toBe('call [PHONE_1], or [PHONE_1]')
    // the value a rule hit (the sort code 900123), not the merged text, is spread: the earlier phone sharing those digits is covered too
    expect(red('Call +44 7700 900123; Tel 07700 900123 12345678').text).toBe('Call [SORTCODE_1]; Tel [SORTCODE_2] [ACCOUNT_1]')
  })
  it('TC-RED-02 UETRs, amounts and references stay', () => {
    const t = 'Paid £10,000.00 ref NW-001 UETR eb6305c9-1f7f-49de-aed0-16487c27b42d'
    expect(red(t).text).toBe(t)
  })
  it('TC-RED-03 no original sensitive value is left in the redacted text', () => {
    const r = red(SAMPLE)
    for (const v of ['GB82', '5432', '20-00-00', '55779911', '123456789', '03/04/1980', 'SW1A', '7700', '7946', 'amelia.hart', 'Amelia', 'Hart'])
      expect(r.text, v).not.toContain(v)
  })
  it('TC-RED-06 an IBAN split by invisible characters, full-width digits or a line break is still replaced', () => {
    for (const s of [
      'GB82 WEST 1234 5698 7654 32',
      'ＧＢ８２ ＷＥＳＴ １２３４ ５６９８ ７６５４ ３２',
      'GB82­WEST​1234‮5698⁦7654⁩32',
      'GB82 WEST 1234\n5698 7654 32',
      'GB82 WEST\u034F 1234 5698 7654 32', // combining grapheme joiner (I-04 v0.7.3)
      'GB82\uFE00 WEST 1234 5698 7654 32', // variation selector
    ]) {
      const r = red(`pay ${s} now`)
      expect(r.text, s).toBe('pay [ACCOUNT_1] now')
    }
  })
  it('TC-RED-07 invalid IBANs, sort codes alone and 8-digit accounts are replaced', () => {
    expect(red('GB82 WEST 1234 5698 7654 33').text).toBe('[ACCOUNT_1]')
    expect(red('our sort code is 12-34-56').text).toBe('our sort code is [SORTCODE_1]')
    expect(red('sort 123456').text).toBe('sort [SORTCODE_1]')
    expect(red('Sort code for the account: 654321').text).toBe('Sort code for the account: [SORTCODE_1]') // 20 characters after "sort"
    expect(red('Sort code for the account is: 654321').text).toBe('Sort code for the account is: 654321')
    expect(red('account no. 12345678').text).toBe('account no. [ACCOUNT_1]')
    expect(red('12-34-56 12345678').text).toBe('[SORTCODE_1] [ACCOUNT_1]')
    expect(red('a/c 12345678').text).toBe('a/c [ACCOUNT_1]')
    // C-EXT-4 union: a plain 6-digit sort code next to an account
    expect(red('123456 12345678').text).toBe('[SORTCODE_1] [ACCOUNT_1]')
    // an account pairs with the nearest sort code, not the first: a phone's last six digits are left to the phone rule
    expect(red('Call +44 7700 900123, sort code 12-34-56, account 12345678').text).toBe('Call [PHONE_1], sort code [SORTCODE_1], account [ACCOUNT_1]')
    // printed forms (PRD v0.7.1)
    expect(red('NI number QQ 12 34 56 C').text).toBe('NI number [ID_1]')
    expect(red('T: +44 (0)20 7946 0958').text).toBe('T: [PHONE_1]')
    expect(red('£0.50 07700900123').text).toBe('£0.50 [PHONE_1]')
    // v0.7.3: 00 prefix, bracketed area code, hyphenated IBAN, padded licence, D.O.B., address lines above the postcode
    expect(red('tel 0044 20 7946 0958').text).toBe('tel [PHONE_1]')
    expect(red('Tel: (020) 7946 0958').text).toBe('Tel: [PHONE_1]')
    expect(red('pay GB82-WEST-1234-5698-7654-32 now').text).toBe('pay [ACCOUNT_1] now')
    expect(red('licence LEE99607058L99AB').text).toBe('licence [ID_1]')
    expect(red('D.O.B. 03/04/1980').text).toBe('D.O.B. [DOB_1]')
    expect(red('Dear team,\n\n10 Downing Street\nLondon\nSW1A 2AA\n\nThanks').text).toBe('Dear team,\n\n[ADDRESS_1]\n\nThanks')
    // a phone followed by other digits ends at the first group boundary that reaches 10 digits (PRD v0.7.2)
    expect(red('07700900123 2026-02-30;').text).toBe('[PHONE_1] 2026-02-30;')
    expect(red('Mobile 07700 900123 2026').text).toBe('Mobile [PHONE_1] 2026')
    expect(red('07700  900123').text).toBe('07700  900123') // two spaces: not one number
    expect(red('07700 900123x').text).toBe('07700 900123x') // runs into a letter
    // after a cut the rest is scanned again; one number, one placeholder however it is spaced
    expect(red('07700 900 123 07700-900123-2026-10-29').text).toBe('[PHONE_1] [PHONE_1]-2026-10-29')
    expect(red('+44 (0)20 7946 0958 or +44 20 7946 0958').text).toBe('[PHONE_1] or [PHONE_1]')
    // every occurrence is replaced, not only the first (found by the oracle comparison)
    expect(red('12-34-56 12345678\n12-34-56 12345678').text).toBe('[SORTCODE_1] [ACCOUNT_1]\n[SORTCODE_1] [ACCOUNT_1]')
  })
  it('overlapping hits merge into one span of the earliest kind (C-RED-1 union)', () => {
    // an IBAN on an address line: one placeholder, of the ACCOUNT kind
    expect(red('1 Example Road GB82 WEST 1234 5698 7654 32 London SW1A 1AA').text).toBe('[ACCOUNT_1]')
  })
  it('TC-RED-01 e-mail local parts: quoted, with an apostrophe, with any atom character (Codex F6)', () => {
    expect(red('Contact "private person"@example.com').text).toBe('Contact [EMAIL_1]@example.com')
    expect(red("Contact o'connor@example.com").text).toBe('Contact [EMAIL_1]@example.com')
    expect(red('write to a.b+c{x}@x.example').text).toBe('write to [EMAIL_1]@x.example')
    // quotes around an ordinary address are punctuation (Codex round 2 N2)
    expect(red('Email: "alice@example.com"').text).toBe('Email: "[EMAIL_1]@example.com"')
    // `'` is an atom character (o'connor), so here it goes with the local part: more is replaced, nothing is left
    expect(red("Email: 'alice@example.com'").text).toBe("Email: [EMAIL_1]@example.com'")
  })
  it('TC-RED-08 subject, display name, quoted mail, attachment text and file names share one map', () => {
    const r = new Redactor({ contactNames: CONTACTS })
    const parts = [
      'Re: Amelia Hart bank change', // subject
      'Amelia Hart', // display name
      '> On Monday Amelia Hart wrote: use GB82 WEST 1234 5698 7654 32', // quoted mail
      'Statement for account 12345678', // attachment text
      'Amelia_Hart_passport_123456789.pdf', // file name
    ].map((p) => r.redact(normaliseText(p)).text)
    expect(parts[0]).toBe('Re: [NAME_1] [NAME_2] bank change')
    expect(parts[1]).toBe('[NAME_1] [NAME_2]')
    expect(parts[2]).toBe('> On Monday [NAME_1] [NAME_2] wrote: use [ACCOUNT_1]')
    expect(parts[3]).toBe('Statement for account [ACCOUNT_2]')
    expect(parts[4]).toContain('[ID_1]')
    expect(r.map.get('[ACCOUNT_1]')).toBe('GB82 WEST 1234 5698 7654 32')
  })
  it('TC-RED-10 a reference shaped like a NI number is redacted but still extracted from the original', () => {
    const t = normaliseText('Payment ref NW123456A for £5,000.00')
    expect(red(t).text).toBe('Payment ref [ID_1] for £5,000.00')
    expect(matchReferences(t, ['NW123456A'])).toEqual(['NW123456A'])
  })
  it('hostile inputs: long text, __proto__ names, sensitive patterns over UETR digits', () => {
    const long = `${'word '.repeat(50_000)}GB82 WEST 1234 5698 7654 32`
    expect(red(long).text.endsWith('[ACCOUNT_1]')).toBe(true)
    expect(red('__proto__ constructor', ['__proto__ constructor']).text).toBe('__[NAME_1]__ [NAME_2]') // underscores are not letters (I-05)
    const t = 'UETR eb6305c9-1f7f-49de-aed0-16487c27b42d £5'
    expect(extractUetrs(red(t).text).uetrs).toHaveLength(1)
    expect(extractAmounts(red(t).text)).toHaveLength(1)
  })
})

describe('I-05 v0.7.17: a combining mark belongs to the letter before it (round-4 self-review T1)', () => {
  it('Devanagari and Arabic contact names are redacted whole; vowel signs do not cut the word', () => {
    const r = red('Regards, किरण शर्मा and राम. Also محمّد عليّ wrote.', ['किरण शर्मा', 'राम', 'محمّد عليّ'])
    expect(r.text).toBe('Regards, [NAME_1] [NAME_2] and [NAME_3]. Also [NAME_4] [NAME_5] wrote.')
  })
  it('the length of a name word (≥ 3) counts its marks: राम (र ा म) is three characters', () => {
    expect(red('from राम', ['राम']).text).toBe('from [NAME_1]')
    expect(red('from Jo', ['Jo']).text).toBe('from Jo')
  })
  it('words compare without marks: a stray mark after a name still matches it', () => {
    // t + U+0301 has no composed form, so NFKC leaves the mark standing
    expect(red('Amelia Hart\u0301 wrote').text).toBe('[NAME_1] [NAME_2] wrote')
  })
})
