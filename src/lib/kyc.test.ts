import { describe, expect, it } from 'vitest'
import { kycReason, type KycInput } from './kyc.ts'

const pdf = (filename: string, text: string, facts: KycInput['facts'] = {}): KycInput => ({ filename, kind: 'pdf', parseStatus: 'parsed', text, facts })

describe('C-RED-0 KYC judgement', () => {
  it('TC-RED-04 (judgement) MRZ, padded MRZ, file names, images, missing text layers, nested, too deep, timeout → maybe KYC; an invoice → not', () => {
    const mrz = 'P<GBRHART<<AMELIA<<<<<<<<<<<<<<<<<<<<<<<<<<<\n1234567890GBR8001014F3001018<<<<<<<<<<<<<<04'
    expect(kycReason(pdf('scan_0012.pdf', mrz))).toBe('mrz')
    expect(kycReason(pdf('scan_0012.pdf', `${'x'.repeat(5000)}\n${mrz}`))).toBe('mrz')
    // every Unicode line break starts a line (LK-F3): CR-only (old Mac CSV), NEL, U+2028, U+2029
    for (const br of ['\r', '\u0085', '\u2028', '\u2029', '\f']) expect(kycReason(pdf('scan.csv', `name,doc${br}${mrz}`)), JSON.stringify(br)).toBe('mrz')
    expect(kycReason(pdf('passport.pdf', 'hello'))).toBe('file_name')
    expect(kycReason(pdf('Amelia_Hart_passport_123.pdf', 'hello'))).toBe('file_name')
    // a combining mark is dropped when words are compared: `passport` + U+0301 is `passport` (I-05 v0.7.17, Codex E2 round 4 F18)
    expect(kycReason(pdf('passport\u0301.txt', 'hello'))).toBe('file_name')
    expect(kycReason(pdf('notes.txt', 'my passport\u0301 details'))).toBe('content_word')
    expect(kycReason({ filename: 'photo.png', kind: 'image', parseStatus: 'not_parsed', text: '', facts: null })).toBe('image')
    expect(kycReason(pdf('scan.pdf', 'page one', { pagesWithoutText: 1 }))).toBe('pdf_without_text_layer')
    const nestedPassport = { filename: 'fwd.eml', kind: 'eml', parseStatus: 'parsed', text: 'Fwd', facts: { nested: [{ filename: 'passport.pdf', kind: 'pdf', result: { status: 'parsed', text: 'x', facts: {} } }] } }
    expect(kycReason(nestedPassport)).toBe('nested:file_name')
    expect(kycReason({ filename: 'deep.eml', kind: 'eml', parseStatus: 'parsed', text: 'x', facts: { tooDeep: true } })).toBe('not_checked:too_deep')
    expect(kycReason({ ...pdf('a.pdf', ''), parseStatus: 'timeout' })).toBe('not_checked:timeout')
    expect(kycReason({ ...pdf('a.pdf', ''), parseStatus: 'over_limit' })).toBe('not_checked:over_limit')
    expect(kycReason(pdf('a.pdf', 'x', { encrypted: true }))).toBe('not_checked:encrypted')
    expect(kycReason(pdf('invoice_2026_10.pdf', 'Invoice 1042\nTotal due £1,200.00\nThank you for your business'))).toBeNull()
  })

  it('content words, two birth details, and the v0.7.8 non-English names', () => {
    expect(kycReason(pdf('doc.pdf', 'Date of birth: 1 Jan 1980\nNationality: British'))).toBe('birth_details')
    expect(kycReason(pdf('doc.pdf', 'Nationality: British'))).toBeNull()
    expect(kycReason(pdf('doc.pdf', 'Certified copy of the trust deed'))).toBe('content_word')
    for (const f of ['Reisepass.pdf', 'passeport_scan.pdf', 'pasaporte.pdf', 'DNI_frontal.pdf', '张三护照.pdf', '营业执照副本.pdf', 'Führerschein.pdf', "carte d'identité.pdf"]) {
      expect(kycReason(pdf(f, 'x')), f).toBe('file_name')
    }
    // whole words for the Latin-script words: "poa" inside "poach" or "dni" inside "dnipro" is not one
    expect(kycReason(pdf('poached_eggs.pdf', 'menu'))).toBeNull()
    expect(kycReason(pdf('dnipro_office.pdf', 'menu'))).toBeNull()
    // P1 (PRD v0.7.11): an English word written against CJK characters is still a whole word in C-RED-0
    for (const f of ['Passport扫描件.pdf', '银行bank statement.pdf', 'パスポートpassport.jpg.pdf']) expect(kycReason(pdf(f, 'x')), f).toBe('file_name')
    expect(kycReason(pdf('报告poach.pdf', 'menu'))).toBeNull()
    expect(kycReason(pdf('a.pdf', '姓名date of birth：1980年1月1日国籍nationality：英国'))).toBe('birth_details') // Codex X3
    // multi-word names joined by _ - . in file names; every v0.7.8 word is listed
    for (const f of ['bank_statement_oct.pdf', 'proof-of-address.pdf', 'register.of.members.pdf', 'Kontoauszug_2026.pdf', 'relevé_bancaire.pdf', 'extracto-bancario.pdf', 'permiso_de_conducir.pdf']) {
      expect(kycReason(pdf(f, 'x')), f).toBe('file_name')
    }
  })
})

describe('attached messages (Codex E2 re-run F2)', () => {
  it('TC-RED-04 (judgement) a KYC word only in an attached message’s header counts', async () => {
    const { kycReason } = await import('./kyc.ts')
    const r = kycReason({ filename: 'forward.eml', kind: 'eml', parseStatus: 'parsed', text: 'Confidential record: XZ1234567', facts: { signalTexts: ['passport'], nested: [] } })
    expect(r).toMatch(/^header:/)
  })
  it('TC-RED-04 (judgement, round 3 F14) two birth details at two levels of the tree count together; one alone does not', async () => {
    const { kycReason } = await import('./kyc.ts')
    const child = (signal: string) => ({ filename: 'child.eml', kind: 'eml', result: { status: 'parsed', text: 'Confidential record', facts: { signalTexts: [signal], nested: [] } } })
    const outer = (inner: string) => kycReason({ filename: 'forward.eml', kind: 'eml', parseStatus: 'parsed', text: 'See below.', facts: { signalTexts: ['Nationality: British'], nested: [child(inner)] } })
    expect(outer('Date of birth: 1 Jan 1980')).toBe('tree:birth_details')
    expect(outer('Subject: record')).toBe(null)
  })
})

describe('C-RED-0 ② machine-readable zone (v0.7.19)', () => {
  const pdf = (text: string) => ({ filename: 'scan_0012.pdf', kind: 'pdf', parseStatus: 'parsed', text, facts: { pages: 1, pagesWithoutText: 0 } })
  it('TC-RED-04 a German passport (P<D<<) and a two-letter type (PM) count; an ordinary line starting with P does not; P<GBR without << does not', () => {
    expect(kycReason(pdf('Scan\nP<D<<MUSTERMANN<<ERIKA<<<<<<<<<<<<<<<<<<<<<<'))).toBe('mrz')
    expect(kycReason(pdf('Scan\nPMGBRHART<<AMELIA<<<<<<<<<<<<<<<<<<<<<<<<<<<'))).toBe('mrz')
    expect(kycReason(pdf('  P<GBRHART<<AMELIA'))).toBe('mrz')
    expect(kycReason(pdf('PAYMENT DETAILS FOR APRIL\nPlease see below'))).toBeNull()
    expect(kycReason(pdf('P<GBR reference only'))).toBeNull()
    expect(kycReason(pdf('Total P<GBRHART<<AMELIA in the middle of a line'))).toBeNull()
  })
})
