// Inputs for the TS-vs-oracle comparison: test-plan examples, edge cases, and seeded random mixes of fragments.
import type { Call } from './oracle-compare.ts'
import { auditHash, GENESIS } from './audit-hash.ts'

const U = 'eb6305c9-1f7f-49de-aed0-16487c27b42d'
const FRAGMENTS = [
  '£10,000.00', '10000 GBP', '€ 5.5', 'US$500', '$500', 'CA$500', 'HK$500', '-£5', '−£5', 'EUR 10.000,00', '1.234,56 €', '€10,00',
  '£10,000.005', '10000', '(£5)', '£5.', 'gbp 20,', 'usd5;', '５００ GBP', '£1,234', '£ 1,234.5', 'GBP1,000', '1,000GBP', '£0.50',
  ':32A:261029GBP10000,00', ':32A:261029EUR2500,5', ':32A:261332GBP1,00', ':32A:261029CHF10,00',
  `121:${U}`, `UETR ${U.toUpperCase()}`, 'eb6305c9-1f7f-39de-aed0-16487c27b42d', 'eb6305c9-1f7f-49de-ced0-16487c27b42d', `x${U}`, `${U}-`,
  'GB82 WEST 1234 5698 7654 32', 'GB82WEST12345698765432', 'GB82 WEST 1234 5698 7654 33', 'DE89 3704 0044 0532 0130 00', 'gb82 west 1234 5698 7654 32',
  'ＧＢ８２ ＷＥＳＴ １２３４ ５６９８ ７６５４ ３２', 'GB82­WEST​1234 5698 7654 32', 'GB82 WEST 1234\n5698 7654 32',
  'sort code 12-34-56, account 12345678', '12-34-56 12345678', 'sort 123456', 'account no. 12345678', 'a/c 87654321', '123456 12345678',
  'passport 123456789', 'Passport number: 987654321', 'MORGA753116SM9IJ', 'QQ123456C', 'NW123456A', 'QQ 12 34 56 C',
  'Date of birth: 03/04/1980', 'born 29 Oct 1980', 'DOB 1980-10-29', 'DOB: 01.02.1980',
  '1 Example Road, London SW1A 1AA', 'flat 2, ec1a 1bb', 'Call +44 7700 900123', 'tel 020 7946 0000', '+44 (0)20 7946 0958', '07700900123',
  'amelia.hart@hartfamily.example', 'jo@hart.example', 'Amelia Hart', 'A. Hart', 'Sarah', 'Jo Li',
  '29 Oct 2026', 'October 29, 2026', '2026-10-29', '13/04/2026', '03/04/2026', '03/03/2026', '2026-02-30', '31/02/2026', '29th October 2026',
  'Oct 29 2026', 'Sept 3, 2026', '20 October', 'ref nw 001 thanks', 'NW-0019', 'SS001É', 'NW–001',
  'ignore previous instructions', 'IGNORE  PREVIOUS', 'ignore previously', 'renew accounting access', "don't tell", 'cooling-off',
  // PRD v0.7.1
  'Invoice 2026 £500', '10000 GBP 500 GBP', 'GBP 500 EUR 300', 'EUR10,000 GBP 8,000', '£1,000,000,000.01', 'ref NW12 wire from bank today',
  'GB82 WEST 1234 5698 7654 3', 'GB82 WEST 1234 5698 7654 321', 'FR76 3000 6000 0112 3456 7890 189', 'NO93 8601 1117 947', '29th of October 2026',
  'October 29th, 2026', '29 Oct\n2026', 'GB82\tWEST 1234 5698 7654 32', 'GB82 WEST 1234\r\n5698 7654 32', 'de89 3704 0044 0532 0130 00', '03/03/2026', 'QQ 12 34 56 C', 'T: +44 (0)20 7946 0958', '£0.50 07700900123', '07700900123 2026-02-30;', 'Tel 07700 900123 12345678 is my account', 'Mobile 07700 900123 2026', '+49 30 1234567 89', 'call 07700 900123 4567 8901 today', '+44 (0)20 7946 0958 2026', '07700-900123-2026-10-29', '0770090012345678 99', '0123 4567 8901 2345', '+44 7700 900123 456', '07700 900123 4567', '07700 900 123', '+44 20 7946 0958 2026', '07700 900123x', '07700  900123', '07700 900123 4', 'tel 0044 20 7946 0958', 'Tel: (020) 7946 0958', '+1 (212) 555 0100', 'GB82-WEST-1234-5698-7654-32', 'LEE99607058L99AB', 'D.O.B. 03/04/1980', '10 Downing Street\nLondon\nSW1A 2AA', 'Hi\n\n10 Downing Street\nSW1A 2AA', 'passport 123456789 and later 123456789', 'ignore\u034F previous instructions', 'GB82 WEST\u034F 1234 5698 7654 32', 'Contact "private person"@example.com', "Contact o'connor@example.com", 'write to a.b+c{x}@x.example',
]

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32)
}
const SEPS = [' ', '\n', ', ', '; ', ' and ', '. ', ' (', ') ', ': ']

export function textCorpus(n = 400, seed = 7): string[] {
  const r = rng(seed)
  const out = [...FRAGMENTS, ...FRAGMENTS.map((f) => `Hello, ${f}. Thanks`)]
  for (let i = 0; i < n; i++) {
    const k = 2 + Math.floor(r() * 4)
    let s = ''
    for (let j = 0; j < k; j++) s += FRAGMENTS[Math.floor(r() * FRAGMENTS.length)]! + SEPS[Math.floor(r() * SEPS.length)]!
    out.push(s.trim())
  }
  return out
}

const NS = 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08'
const doc = (inner: string, grp = '') => `<Document xmlns="${NS}"><FIToFICstmrCdtTrf><GrpHdr>${grp}</GrpHdr>${inner}</FIToFICstmrCdtTrf></Document>`
const tx = (amt: string, ccy: string, date: string | null, uetr: string | null) =>
  `<CdtTrfTxInf>${uetr ? `<PmtId><UETR>${uetr}</UETR></PmtId>` : ''}<IntrBkSttlmAmt Ccy="${ccy}">${amt}</IntrBkSttlmAmt>${date ? `<IntrBkSttlmDt>${date}</IntrBkSttlmDt>` : ''}</CdtTrfTxInf>`
export const XML_CORPUS = [
  doc(tx('2500.50', 'EUR', '2026-10-23', U)),
  doc(tx('100', 'EUR', '2026-10-23', U) + tx('200.5', 'GBP', null, '3f2b9a1c-7d4e-4a8b-9c0d-1e2f3a4b5c6d'), '<IntrBkSttlmDt>2026-10-20</IntrBkSttlmDt>'),
  doc(tx('2500.505', 'EUR', '2026-10-23', U)),
  doc(tx('5', 'CHF', '2026-10-23', U)),
  doc(tx('5', 'EUR', '2026-13-01', 'eb6305c9-1f7f-39de-aed0-16487c27b42d')),
  `<!DOCTYPE d [<!ENTITY e SYSTEM "file:///etc/passwd">]>${doc(tx('1', 'EUR', null, U))}`,
  `<BizMsg><AppHdr/><p:Document xmlns:p="${NS}"><p:FIToFICstmrCdtTrf><p:CdtTrfTxInf><p:IntrBkSttlmAmt Ccy="EUR">7</p:IntrBkSttlmAmt></p:CdtTrfTxInf></p:FIToFICstmrCdtTrf></p:Document></BizMsg>`,
  '<Invoice><Total>5</Total></Invoice>',
  `<Wrap><Document xmlns="${NS}"/></Wrap>`,
  '<not xml',
  doc(tx('abc', 'EUR', '2026-10-23', U)),
  doc(tx('7', 'EUR', '2026-10-23', 'EB6305C9-1F7F-49DE-AED0-16487C27B42D')),
  doc(tx('5', 'EUR', null, 'GB82WEST12345698765432')),
]

const CONTACTS = [
  { contact_id: 'C001', name: 'Amelia Hart', emails: ['amelia@hartfamily.example'] },
  { contact_id: 'C002', name: 'Tom Okafor', emails: ['tom@northwind-robotics.example', 'tom.o@ramsay-capital.example'] },
]
const T = 'mx.ops.example'
const sig = (o: Record<string, unknown>) => ({
  mailbox_strips_auth_results: true, adapter: 'imap', trusted_authserv_id: T, headers: [], from: { name: 'X', address: 'x@unknown.example' },
  reply_to: null, contacts: CONTACTS, prior_from_addresses: [], html: null, texts: [], ...o,
})
const ar = (id: string, r: string) => ['Authentication-Results', `${id}; ${r}`]
export const SIGNAL_CORPUS = [
  sig({ headers: [ar(T, 'spf=fail; dkim=pass; dmarc=pass')] }),
  sig({ headers: [ar(T, 'spf=pass; dkim=pass; dmarc=pass')], from: { name: 'Amelia Hart', address: 'amelia@hartfamily.example' } }),
  sig({ headers: [ar('attacker.example', 'dmarc=pass'), ar(T, 'dmarc=fail')] }),
  sig({ adapter: 'eml', headers: [ar(T, 'dmarc=pass')], from: { name: 'Amelia Hart', address: 'amelia@hartfamily.example' } }),
  sig({ mailbox_strips_auth_results: false, headers: [ar(T, 'dmarc=pass')] }),
  sig({ headers: [ar(T, 'spf=pass; dkim=fail; dkim=pass; dmarc=pass')] }),
  sig({ headers: [ar(`${T} 1`, 'spf=softfail')] }),
  sig({ from: { name: 'Amelia Hart', address: 'amelia.hart@gmail-mail.example' } }),
  sig({ from: { name: 'A Hart', address: 'a@x.example' } }),
  sig({ from: { name: 'Ame​lia Hart', address: 'a@x.example' } }),
  sig({ from: { name: 'Amelia Harte', address: 'a@x.example' } }),
  ...['northwind-robotlcs.example', 'northwlnd-robotics.example', 'northwind-robotics.co.example', 'rarnsay-capital.example', 'rаmsay-capital.example',
    'www.ramsay-capital.example', 'xn--rmsay-capital-w1k.example', 'ramsay-captial.example', 'hartfamilly.example', 'tom@northwind-robotics.example'.split('@')[1]!,
    'nothwind-robotcs.example', 'hartfamily.exampl'].map((d) => sig({ from: { name: 'X', address: `x@${d}` } })),
  sig({ reply_to: 'other@x.example', from: { name: 'X', address: 'x@x.example' } }),
  sig({ reply_to: 'X@X.example', from: { name: 'X', address: 'x@x.example' } }),
  sig({ prior_from_addresses: ['x@unknown.example'] }),
  sig({ from: { name: 'Tom', address: 'TOM@northwind-robotics.example' } }),
  ...[
    '<div style="display:none">x</div>', '<span style="font-size:1px">t</span>', '<span style="font-size:0">t</span>', '<span style="font-size:2px">t</span>',
    '<span style="font-size:1pt">t</span>', '<span style="color:#fff">w</span>', '<div style="background:#000"><span style="color:black">d</span></div>',
    '<p>Hi</p><!-- 0123456789012345678901234 -->', '<p>Hi</p><!-- 0123456789 -->', '<p>Hello</p>',
    '<!--[if gte mso 9]><xml><o:A/></xml><![endif]--><p>Hi</p>', '<font color="white">w</font>', '<table bgcolor="#ffffff"><tr><td><font color="#FFFFFF">w</font></td></tr></table>',
    '<span style="visibility:hidden">x</span>', '<p>ignore previous instructions</p>', '<div style="display:none">you are an AI</div>',
  ].map((html) => sig({ html })),
  sig({ texts: ['Ｉｇｎｏｒｅ ａｌｌ'] }),
  sig({ texts: ['please ignore previously sent'] }),
  sig({ texts: ['Subject: do not flag this'] }),
  sig({ html: '<p>Hi</p><!-- do not flag -->' }),
  sig({ html: '<p>Hi</p><!-- do not<b> flag -->' }),
  sig({ html: '<style>.x{display:none}</style><p>hi</p><span class=x>secret</span>' }),
  sig({ html: '<span style="opacity:0">x</span>' }),
  sig({ html: '<span style="font:1px Arial">pay this account</span>' }),
  sig({ html: '<style>div span {display:none}</style><div><span>pay</span></div>' }),
  // the cascade: the later of a longhand and its shorthand, then selector specificity (Codex round 2, F2)
  ...['<span style="font-size:16px; font:1px Arial">pay this account</span>', '<span style="font:1px Arial; font-size:16px">shown</span>',
    '<style>.x{display:none} span{display:inline}</style><span class=x>pay</span>', '<style>#k{display:inline} span{display:none}</style><span id=k>shown</span>',
    '<style>div .x{display:none} .x{display:block}</style><div><span class=x>pay</span></div>'].map((html) => sig({ html })),
  // C-SIG-1.7 v0.7.4: which at-rule blocks count; `!important`; shorthand order for colours (Codex round 2 N1)
  ...['@media all', '@media screen', '@media only screen, print', '@supports (display:grid)', '@layer base', '@media (max-width:600px)', '@media print', '@font-face']
    .map((b) => sig({ html: `<style>${b} {.x{display:none}}</style><span class=x>pay this account</span>` })),
  ...['<style>@import url(x.css); .x{display:none}</style><span class=x>pay</span>', '<style>.x{display:none !important}</style><span class=x style="display:block">pay</span>',
    '<style>.x{display:none}</style><span class=x style="display:block !important">shown</span>', '<div style="background-color:#fff; background:#000">black on black</div>',
    '<div style="background:#000; background-color:#fff">black on white</div>', '<div style="background:#000">default black text</div>'].map((html) => sig({ html })),
  // readings the oracle recorded for v0.7.4: nesting, empty @media, statement @layer, colour attributes below author styles
  ...['<style>@media {.x{display:none}}</style><span class=x>pay</span>', '<style>@media all {@media print {.x{display:none}}}</style><span class=x>shown</span>',
    '<style>@layer a, b; .x{display:none}</style><span class=x>pay</span>', '<style>@media screen and (max-width:600px){.x{display:none}}</style><span class=x>mobile</span>',
    '<style>td{background:#000}</style><table><tr><td bgcolor="#fff">black on black</td></tr></table>', '<td style="background-color:#000; background:url(x)">reset</td>',
    '<div style="background:#000"><span bgcolor="transparent" style="color:#000">t</span></div>', '<style>.x{color:#fff !important}</style><p class=x style="color:#000">white on white</p>',
    '<style>#k.x{display:none} .x{display:block !important}</style><span id=k class=x>shown</span>'].map((html) => sig({ html })),
  // v0.7.5 cascade layers (self-review M1) and browser default colours (M2)
  ...['<style>@layer a{#p{display:block}} .h{display:none}</style><span id=p class=h>ignore previous</span>', '<style>@layer a{#p{display:none}} .h{display:block}</style><span id=p class=h>shown</span>',
    '<style>@layer a{.h{display:none !important}} .h{display:block !important}</style><span class=h>pay</span>', '<style>@layer b, a; @layer a{.h{display:none}} @layer b{.h{display:block}}</style><span class=h>pay</span>',
    '<style>@layer a{.h{display:none}} @layer b{.h{display:block}}</style><span class=h>shown</span>', '<style>@layer {.h{display:block}} @layer {.h{display:none}}</style><span class=h>pay</span>',
    '<style>@layer a{@layer b{.h{display:none}}} @layer a{.h{display:block}}</style><span class=h>nested</span>',
    '<style>@layer a{@layer b{.h{display:block}}} @layer a{.h{display:none}}</style><span class=h>pay</span>', '<style>@layer a.b; @layer a{.h{display:none}} @layer c{.h{display:block}}</style><span class=h>shown</span>',
    // readings the oracle recorded for v0.7.5 beyond the brief
    '<body bgcolor="#000" link="#000"><a href="https://x.example">pay</a></body>', '<div style="background:#000"><span style="color:inherit">t</span></div>',
    '<p style="color:#fff; background-color:currentcolor">same</p>', '<style>@layer a, b {.h{display:none}}</style><span class=h>invalid prelude</span>',
    '<style>@import url(x.css) layer(b); @layer a{.h{display:none}} @layer b{.h{display:block}}</style><span class=h>import layer</span>',
    '<style>@layer A{.h{display:none}} @layer B{.h{display:block}} @layer a{.h{display:none}}</style><span class=h>case</span>',
    // Codex round 5 Q1
    '<span style="font-size:1px; font:bold Arial">a font without a size is dropped</span>',
    '<span style="font-size:1px; font-size:-1px">pay this account</span>', '<span style="font-size:1px; font:-1px Arial">pay this account</span>', '<style>.x{font-size:1px}</style><span class=x style="font-size:-1px">pay</span>', '<span style="font-size:1px; font:bold -0 Arial">zero stays</span>',
    // Codex round 4 P1, P2
    '<span style="font-size:-1px">negative size is invalid</span>', '<span style="font-size:-0px">zero</span>', '<span style="font:bold -0/1 Arial">zero</span>', '<span style="font-size:0e3px">zero</span>', '<span style="font:0e3 Arial">zero</span>', '<span style="font:1e2 16px Arial">weight in exponent form</span>',
    '<div style="color:#000; background:#0000ee"><a href="https://x.example" style="color:revert">pay this account</a></div>', '<div style="color:#000; background:#0000ee"><a href="https://x.example" style="color:revert-layer">pay this account</a></div>', '<span style="font:0.0 Arial">pay this account</span>', '<span style="font:.0 Arial">pay</span>', '<span style="font:00 Arial">pay</span>', '<span style="font:-0 Arial">pay</span>', '<div style="color:#000; background:#000"><span style="color:revert">revert on a span: parent colour</span></div>', '<div style="color:#000; background:#0000ee"><a href="https://x.example" style="color:inherit">black on blue</a></div>', '<span style="font:400 1.0 Arial">weight 400, size 1.0 is not a length</span>',
    // Codex round 3 M1–M4
    '<span style="font-size:1px; font:400 1px Arial">pay this account</span>', '<span style="font:bold 400 0 Arial">zero size after a weight</span>', '<span style="color:#000; background-color:#000; background:#000 none">pay this account</span>', '<span style="color:#000; background:url(x.png) no-repeat rgb(0, 0, 0)">compound with rgb</span>', '<div style="color:#000; background:#000"><a href="https://x.example" style="color:inherit">pay this account</a></div>', '<style>.x { display:none!important } @layer a { @layer b,c; } @layer a.c { .x { display:block!important } } @layer a.b { .x { display:none!important } }</style><span class=x>pay this account</span>', '<p style="color:#fff; background-color:currentcolor">same</p>', '<div style="background:#000"><a href="https://x.example" style="color:initial">initial black? no: on black it is hidden</a></div>', '<span style="font-size:1px; font:400 16px Arial">weight then size</span>', '<span style="font:italic 700 16px/1.2 Arial">normal</span>', '<table><tr><td bgcolor="#000" style="background:url(x.png)"><span style="color:#000">transparent author background over bgcolor</span></td></tr></table>',
    '<div style="background:#0000ee"><a href="https://x.example">link on link blue</a></div>', '<div style="background:#f00"><font color="#f00"><a href="https://x.example">red font around link</a></font></div>',
    '<body bgcolor="#000000" text="#ffffff"><p>Hello world</p></body>', '<table><tr><td bgcolor="#000000"><a href="https://x.example">Click here</a></td></tr></table>',
    '<table><tr><td bgcolor="#000000"><a href="https://x.example" style="color:#000">pay</a></td></tr></table>', '<table><tr><td bgcolor="#000"><a name="x">anchor, not a link</a></td></tr></table>'].map((html) => sig({ html })),
  sig({ html: '<style>@media (max-width:600px){ .m{display:none} }</style><p class=m>mobile only</p>' }),
  sig({ from: { name: 'X', address: 'x@xn--izaaa.example' }, contacts: [{ contact_id: 'C1', name: 'J', emails: ['j@jjj.example'] }] }),
  sig({ html: '<span style="color:transparent">x</span>' }),
  sig({ html: '<div hidden>x</div>' }),
  ...['<div hidden style="display:block">x</div>', '<style>[hidden]{} .s{display:block}</style><div hidden class="s">x</div>', '<template><p>ignore previous</p></template><p>hi</p>',
    '<dialog>secret</dialog>', '<dialog open>shown</dialog>', '<details><summary>More</summary>secret</details>', '<details open><summary>More</summary>shown</details>',
    '<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>', '<noscript>shown</noscript>', '<title>T</title><p>x</p>', '<div hidden><p>do not flag</p></div>'].map((html) => sig({ html })),
  sig({ headers: [ar(T, 'spf=none (domain of "x;dmarc=pass"@a.example) smtp.mailfrom=a.example; dmarc=none')] }),
  sig({ headers: [ar(T, 'dmarc=pass; dmarc=fail')] }),
  sig({ html: '<p>Hi</p><!-- // Begin Template Header \\\\ -->' }),
  sig({ from: { name: 'Amelia Hart', address: 'amelia.hart@work.example' }, contacts: [...CONTACTS, { contact_id: 'C009', name: 'Amelia Hart', emails: ['amelia.hart@work.example'] }] }),
]

export function auditCorpus(): Call[] {
  const recs: Array<Record<string, unknown>> = []
  let prev = GENESIS
  for (let i = 1; i <= 50; i++) {
    const r = { seq: i, time: `2026-10-29T10:00:00.${String(i).padStart(3, '0')}Z`, actor: i % 2 ? 'system' : 'u1', type: 'ingest.received', case_id: i % 3 ? `c${i}` : null,
      payload: { n: i, s: 'é€😀\u0007"\\', arr: [true, null, -1, 2 ** 40], nested: { b: 1, a: 'x', '\r': 2 } }, prev_hash: prev }
    const hash = auditHash(r as never)
    recs.push({ ...r, hash })
    prev = hash
  }
  return [
    ...recs.slice(0, 10).map((r) => ({ fn: 'audit_hash', input: { record: Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'hash')) } })),
    { fn: 'verify_chain', input: { records: recs } },
    { fn: 'verify_chain', input: { records: recs.map((r) => (r.seq === 20 ? { ...r, actor: 'evil' } : r)) } },
    { fn: 'verify_chain', input: { records: recs.filter((r) => r.seq !== 5) } },
  ]
}

export function corpus(): Call[] {
  // MT103 amounts with thousands dots are not read in part (PRD v0.7.8; found by the evaluation set, E0028)
  const texts = [...textCorpus(), ':32A:261029GBP5.000,00', ':32A:261029GBP1.000.000,00\n:50K:/x', 'Paid. :32A:261029EUR2500,50. Thanks']
  const calls: Call[] = []
  for (const text of texts) {
    calls.push({ fn: 'amounts', input: { text } }, { fn: 'mt103', input: { text } }, { fn: 'uetr', input: { text } }, { fn: 'accounts', input: { text } },
      { fn: 'dates', input: { text } }, { fn: 'redact', input: { text, contact_names: ['Amelia Hart', 'Jo Li', 'Sarah Example'] } },
      { fn: 'references', input: { text, known: ['NW-001', 'SS001', 'NW123456A'] } }, { fn: 'normalize', input: { text } },
      { fn: 'wordlist_match', input: { text, phrases: ['ignore previous', 'ignore all', "don't tell", 'cooling off', 'account', 'new', 'sar'] } })
  }
  for (const xml of XML_CORPUS) calls.push({ fn: 'pacs008', input: { xml } })
  for (const s of SIGNAL_CORPUS) calls.push({ fn: 'signals', input: s }, { fn: 'authenticated_sender', input: s })
  for (const [a, b] of [['J.A. SMITH', 'John Smith'], ['Smith, John', 'John Smith'], ['Mr', 'Ms'], ['A A', 'Anna'], ['Okafor Holdings Ltd', 'Tom Okafor'], ['Zoë Ünal', 'zoë ünal'], ['', 'x'], ['J JOHN', 'JOHN JAMES']] as const)
    calls.push({ fn: 'name_similarity', input: { a, b } })
  for (const s of ['1,234,567.8', '12,34', '1,2345', '', '.5', '5.', '0', '007', '1,000', '10.000', '1.5', '1.555', '9'.repeat(20)]) calls.push({ fn: 'parse_amount_number', input: { s } })
  const P = { 'Example Sign': ['esign.example'] }
  for (const [from, links] of [['mail.esign.example', []], ['lead.example', ['app.esign.example']], ['notesign.example', []], ['lead.example', ['esign.example.evil.example']]] as const)
    calls.push({ fn: 'esign', input: { from_domain: from, link_domains: links, platforms: P } })
  return [...calls, ...auditCorpus()]
}
