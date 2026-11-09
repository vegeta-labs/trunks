// C-CLS-4a: the same hostile inputs through src/lib and the independent oracle. A difference is a finding for one of them.
import { describe, expect, it } from 'vitest'
import { runOracle } from './oracle-compare.ts'
import { parsePacs008 } from './pacs008.ts'
import { hasExplicitRedirect, hasRedirectWording, messageContentProblem, structuredMessage, type AttachmentInput } from './payment-message.ts'
import { normaliseText } from './text.ts'

const P = 'DE89370400440532013000'
const G = 'GB82WEST12345698765432'
const X = 'GB29NWBK60161331926819'
const UETR = '81cd69a7-85c3-46e1-b133-9d08c4210b21'
const CCY = ['GBP', 'EUR', 'USD']
const base = `{3:{121:${UETR}}}\n{4:\n:20:REF-2026-1\n:23B:CRED\n:32A:261030GBP9000,00\n:50K:/${P}\nDANIEL OSEI\n:59:/${G}\nNORTHWIND SPV LP\n:70:NW-016\n:71A:SHA\n-}\n`
const NS = 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08'
const tx = `<CdtTrfTxInf><PmtId><EndToEndId>E2E1</EndToEndId><UETR>${UETR}</UETR></PmtId><IntrBkSttlmAmt Ccy="GBP">9000.00</IntrBkSttlmAmt><IntrBkSttlmDt>2026-10-30</IntrBkSttlmDt><Dbtr><Nm>ELENA RUIZ</Nm></Dbtr><DbtrAcct><Id><IBAN>${P}</IBAN></Id></DbtrAcct><CdtrAcct><Id><IBAN>${G}</IBAN></Id></CdtrAcct><RmtInf><Ustrd>SB-004</Ustrd></RmtInf></CdtTrfTxInf>`
const doc = (inner = tx, attrs = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="${NS}"${attrs}><FIToFICstmrCdtTrf><GrpHdr><MsgId>M1</MsgId></GrpHdr>${inner}</FIToFICstmrCdtTrf></Document>`
const env = (extra = '') => `<BusinessMessage><AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02"><BizMsgIdr>B1</BizMsgIdr></AppHdr>${extra}<Document xmlns="${NS}"><FIToFICstmrCdtTrf><GrpHdr><MsgId>M1</MsgId></GrpHdr>${tx}</FIToFICstmrCdtTrf></Document></BusinessMessage>`

const MT = [
  base, base.replace(/\n/g, '\r\n'), `${base.trimEnd()}{5:{CHK:ABC}}\n`, base.replace('{3:', '{1:F01QZBKGB2LAXXX0000000000}{2:I103QZBKGB2LXXXXN}{3:'),
  `:20:REF1\n:23B:CRED\n:32A:261030GBP9000,00\n:50K:/${P}\nA NAME\n:59:/${G}\n:71A:SHA\n`,
  base.replace(`/${G}`, 'NORTHWIND'), base.replace(`/${G}`, '/NORTHWIND SPV CLIENT AC'), base.replace(`/${P}`, 'DANIEL'), base.replace(`/${G}`, `/${X}`),
  base.replace(`/${G}`, '/GB82 WEST 1234 5698 7654 32'), base.replace(`/${G}`, '/GB82 WEST 1234\n5698 7654 32'), base.replace(`/${G}`, '/GB82WEST12345698765431'), base.replace(`/${G}`, `/${G} USE THIS`),
  base.replace(`/${G}`, '/12345678'), base.replace(`/${G}`, '/GB82.WEST.1234.5698.7654.32'), base.replace(`/${G}`, '//1234567'), base.replace(`/${G}`, '/'), base.replace(`/${G}`, `/${G}\u2028${X}`),
  base.replace(`/${G}`, 'ATTACKER LTD\nACC 1234567'), base.replace(`/${P}`, '/PLEASE USE 123'), base.replace(`/${P}`, `/${P}\nNEW BANK DETAILS`), base.replace(':70:NW-016', `:70:${X}`),
  base.replace(':70:NW-016', ':70:CHANGE BANK ACCOUNT'), base.replace(':70:NW-016', ':70:NEW BANK'), base.replace(':70:NW-016', ':70:CREDIT 87654321 FOR NEXT'), base.replace(':70:NW-016', ':70:CREDIT 8765 4321 FOR NEXT'),
  base.replace(':70:NW-016', ':70:CREDIT ٨٧٦٥٤٣٢١'), base.replace(':70:NW-016', ':70:FUTURE PAYMENTS PLEASE'), base.replace(':70:NW-016\n', ''), base.replace(':23B:CRED\n', ''), base.replace(':23B:CRED\n', ':23B:CRED\n:23B:CRED\n'),
  base.replace(':20:REF-2026-1\n:23B:CRED\n', ':23B:CRED\n:20:REF-2026-1\n'), base.replace(':20:REF-2026-1', ':20:CHANGE ACCOUNT'), base.replace(':20:REF-2026-1', ':20:CREDIT 87654321'), base.replace(':20:REF-2026-1', ':20:12345678'), base.replace(':20:REF-2026-1', ':20:12345678901234567'),
  base.replace(':71A:SHA', ':71A:87654321'), base.replace(':71A:SHA\n', ':71A:SHA\nCREDIT 87654321\n'), base.replace(':71A:SHA\n', ':71A:SHA\n:99Z:X\n'), base.replace(':71A:SHA\n', ':71A:SHA\n:72:X\n:72:Y\n'), base.replace(':71A:SHA\n', ':71A:SHA\n:77B:X\n:72:Y\n'), base.replace(':71A:SHA\n', `:71A:SHA\n:72:${X}\n`),
  base.replace(':59:', `:57D:/${X}\n:59:`), base.replace(':59:', ':57D:/87654321\n:59:'), base.replace(':23B:CRED\n', ':23B:CRED\n:23E:HOLD/87654321\n'), base.replace('{3:{121:', '{3:{108:CREDIT 87654321}{121:'), `${base}{5:CREDIT 87654321}\n`, base.replace('{3:', '{2:87654321}{3:'),
  base.replace(`/${G}`, ' /12345678'), base.replace(`/${G}`, '\t/12345678'), base.replace(`/${P}`, ' /87654321'),
  base + base, `${base}Please note the new details\n`, `Please pay ${X}\n:32A:261030GBP9000,00\n`, ':32A:261030GBP9000,00',
]
const XML = [
  doc(), doc(tx + tx), env(), env('<Extra>x</Extra>'), env('<Nm>x</Nm>'), doc(tx.replace('SB-004', `pay ${X}`)), doc(tx.replace('<RmtInf>', `<InstrForCdtrAgt><InstrInf>${X}</InstrInf></InstrForCdtrAgt><RmtInf>`)),
  doc(tx.replace(`<IBAN>${G}</IBAN>`, `<IBAN>Please update bank account to ${G}</IBAN>`)), doc(tx.replace(`<IBAN>${G}</IBAN>`, `<IBAN>${G}</IBAN><IBAN>${X}</IBAN>`)), doc(tx.replace(`<IBAN>${G}</IBAN>`, '<Othr><Id>NWR-SPV-CLIENT</Id></Othr>')), doc(tx.replace(`<IBAN>${G}</IBAN>`, '<Othr><Id>87654321</Id></Othr>')),
  doc(tx.replace(`<IBAN>${G}</IBAN>`, `<Othr><Id>${G}</Id><SchmeNm><Cd>X</Cd></SchmeNm></Othr>`)), doc(tx.replace('<RmtInf>', `<!-- pay ${X} --><RmtInf>`)), doc(tx.replace('<RmtInf>', `<?note pay?><RmtInf>`)), doc(tx.replace('SB-004', '<![CDATA[SB-004]]>')), doc(tx.replace('SB-004', '&#83;B-004')),
  doc(tx.replace('<Dbtr>', '<Dbtr note="x">')), doc(tx.replace('<Dbtr>', `<Dbtr Ccy="CHANGE BANK ACCOUNT TO ${X}">`)), doc(tx, ` xmlns:CHANGE_BANK_ACCOUNT_TO_${X}="${NS}"`), doc(tx.replace('<Dbtr>', `<Dbtr><CHANGE_BANK_ACCOUNT_TO_${X}/>`)), doc(tx.replace('<Nm>ELENA RUIZ</Nm>', 'note<Nm>ELENA RUIZ</Nm>')),
  doc(tx.replace('<RmtInf>', '<CdtrAgtAcct><Id><Othr><Id>87654321</Id></Othr></Id></CdtrAgtAcct><RmtInf>')), doc(tx.replace('<RmtInf>', '<UltmtCdtr><CdtrAcct><Id><Othr><Id>87654321</Id></Othr></Id></CdtrAcct></UltmtCdtr><RmtInf>')), doc(tx.replace('<Nm>ELENA RUIZ</Nm>', '<Id><OrgId><Othr><Id>87654321</Id></Othr></OrgId></Id>')),
  doc(tx.replace('<Dbtr>', '<DbtrAgt><FinInstnId><BICFI>87654321 X</BICFI></FinInstnId></DbtrAgt><Dbtr>')), doc(tx.replace('<RmtInf>', `<Purp>${tx}</Purp><RmtInf>`)), doc(tx.replace('Ccy="GBP"', 'Ccy="gbp x"')), doc(tx).replace('encoding="UTF-8"', 'encoding="CHANGE BANK"'), doc(tx.replace('<Dbtr>', '<Document/><Dbtr>')), doc(tx.replace('<Dbtr>', '<AppHdr/><Dbtr>')), doc(tx, ' xmlns:ns1="urn:CHANGE BANK ACCOUNT"'), doc(tx.replace(`<IBAN>${G}</IBAN>`, '<Othr><Id>⑧⑦⑥⑤④③②①</Id></Othr>')),
]
const WORDS = [
  "Attached is my bank's MT103 for the second half.", 'Attached is the wire confirmation.', 'Please find the remittance advice attached.', 'My wire transfer receipt.', 'Send your next wire transfer to the party on the attached', 'Please wire to the attached', 'Please wire per the attached', 'should be wired to', 'Wires go to',
  'Please remit via the attached', 'Keep remitting to the bank', 'Remittance now goes to the bank', 'From now on pay', '以后请付到附件里的这个账户', '我的银行转账确认在附件。', '后续有问题再联系', '請匯到附件裡的帳戶', '下一笔请转账到附件里的人', 'Our accounts have moved', 'Bitte auf das Bankkonto im Anhang', 'Please use the bеneficiary shown', 'Please refund the overpayment', 'going forward', 'henceforth', 'future payments', '今后请这样', 'an ordinary note', 'Please wire transfer: to the ordering customer shown.', 'Please w\u0338ire to the ordering customer shown.', 'Use the b\u0338е\u0338neficiary shown', 'Our ac\u0338counts have moved', 'wire confirmation to you', 'Please ẃire to the party', 'PLEASE REMİT TO THE BANK', 'SEE İBAN', 'Le nouveau bénéficiaire', 'Fróm nów ón use the attached', '今後請這樣', '请wire到附件里的公司', '下次请remit到附件这家公司', '请pay to附件里的公司', 'from now on请按附件付款', '我的wire confirmation在附件', '附件是remittance advice', '新bank details见附件', 'future payments请按附件',
]

const toTs = (kind: 'txt' | 'xml', source: string): AttachmentInput | null => {
  if (kind === 'txt') return { ordinal: 0, kind, filename: 'mt103.txt', parseStatus: 'parsed', text: source, facts: {}, maybeKyc: false }
  const r = parsePacs008(source, [])
  return r.parsed ? { ordinal: 0, kind, filename: 'pacs008.xml', parseStatus: 'parsed', text: r.text, facts: { pacs008: { ...r, text: '' } }, maybeKyc: false } : null
}
const tsVerdict = (a: AttachmentInput | null) => {
  const v = a && structuredMessage(a, CCY)
  if (!v) return { structured: false, ok: false, beneficiaries: [] as string[] }
  return { structured: true, ok: messageContentProblem(v) === null, beneficiaries: v.beneficiaries.map((s) => v.text.slice(s.start, s.end).trim()) }
}

describe('C-CLS-4a TS against the independent oracle', () => {
  it('TC-CLS-11 structure and content agree on every hostile message', () => {
    const inputs = [...MT.map((s) => ['txt', s] as const), ...XML.map((s) => ['xml', s] as const)]
    const calls = inputs.map(([kind, s]) => {
      const a = toTs(kind, s)
      return { fn: 'payment_message', input: { kind, parse_status: a ? 'ok' : 'failed', top_level: true, text: a?.text ?? '', xml: kind === 'xml' ? s : null, currencies: CCY } }
    })
    const py = runOracle(calls) as Array<{ structured: boolean; problem: string | null; beneficiaries: string[] }>
    const diffs = inputs.flatMap(([kind, s], i) => {
      const ts = tsVerdict(toTs(kind, s))
      const o = { structured: py[i]!.structured, ok: py[i]!.structured && py[i]!.problem === null, beneficiaries: py[i]!.structured ? py[i]!.beneficiaries : [] }
      return JSON.stringify(ts) === JSON.stringify(o) ? [] : [{ s, ts, o }]
    })
    expect(diffs).toEqual([])
  })
  it('TC-CLS-12 the word lists agree', () => {
    const a = runOracle(WORDS.map((text) => ({ fn: 'redirect_wording', input: { text } }))) as Array<{ hit: boolean }>
    const b = runOracle(WORDS.map((text) => ({ fn: 'explicit_redirect', input: { text } }))) as Array<{ hit: boolean }>
    expect(WORDS.filter((w, i) => hasRedirectWording(normaliseText(w)) !== a[i]!.hit)).toEqual([])
    expect(WORDS.filter((w, i) => hasExplicitRedirect(normaliseText(w)) !== b[i]!.hit)).toEqual([])
  })
})
