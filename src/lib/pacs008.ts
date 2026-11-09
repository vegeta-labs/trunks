// PRD C-ING-2 (which XML is parsed) and C-EXT-3 (pacs.008 amounts, settlement dates and UETRs).
import { XMLParser } from 'fast-xml-parser'
import { parseAmountNumber } from './money.ts'
import { isIsoDate } from './dates.ts'

export const PACS008_MAX_BYTES = 1024 * 1024
const NS_PREFIX = 'urn:iso:std:iso:20022:tech:xsd:pacs.008.'

export interface PacsItem {
  minor: number | null
  currency: string | null
  valueDate: string | null
  uetr: string | null // lower case, as written; validity is judged by C-EXT-1
  // as written, before the configured currencies are applied: the parse does not depend on configuration (Codex F13)
  amountText: string | null
  ccy: string | null
  // [start, end) of each element's text in the result's `text` (R-EXT-02, Codex F14)
  spans: { amount: [number, number] | null; valueDate: [number, number] | null; uetr: [number, number] | null }
}

// PRD appendix C.2: judged on the raw XML by the parser. Spans are in the result's `text`. A result saved before v0.7.28
// has no `strict` and never qualifies. `accounts` are found on the fixed paths whether or not `ok` (C-RED-1 masks them).
export interface PacsStrict {
  ok: boolean
  reason: string | null
  accounts: Array<{ tx: number; role: 'debtor' | 'creditor'; span: [number, number] }>
  free: Array<[number, number]> // leaf text that M4 ③ counts digits in
  ids: Array<{ span: [number, number]; max: number }> // reference elements: no white space, length limit
}

export type PacsResult = { parsed: true; items: PacsItem[]; text: string; strict?: PacsStrict } | { parsed: false; reason: 'too_large' | 'dtd_or_entity' | 'malformed' | 'not_pacs008' }

type Node = Record<string, unknown> & { ':@'?: Record<string, string> }

const nameOf = (n: Node) => Object.keys(n).find((k) => k !== ':@')!
const localName = (q: string) => q.slice(q.indexOf(':') + 1)
const prefixOf = (q: string) => (q.includes(':') ? q.slice(0, q.indexOf(':')) : '')
const childrenOf = (n: Node) => (n[nameOf(n)] as Node[]).filter((c) => !('#text' in c) && !nameOf(c).startsWith('?'))
const textOf = (n: Node) =>
  (n[nameOf(n)] as Node[])
    .filter((c) => '#text' in c)
    .map((c) => String(c['#text']))
    .join('')
    .trim()

type Scope = Record<string, string>
function scopeOf(n: Node, parent: Scope): Scope {
  const s = { ...parent }
  for (const [k, v] of Object.entries(n[':@'] ?? {})) {
    if (k === '@_xmlns') s[''] = v
    else if (k.startsWith('@_xmlns:')) s[k.slice(8)] = v
  }
  return s
}

const kids = (n: Node, local: string) => childrenOf(n).filter((c) => localName(nameOf(c)) === local)

/** C-EXT-3 amount of an item under the configured currencies. */
export function pacsAmount(item: Pick<PacsItem, 'amountText' | 'ccy'>, currencies: readonly string[]): { minor: number | null; currency: string | null } {
  const minor = item.amountText !== null && item.ccy && currencies.includes(item.ccy) ? parseAmountNumber(item.amountText) : null
  return { minor, currency: minor === null ? null : item.ccy }
}

// C.4
const ELEMENTS = new Set(
  `Document BusinessMessage BizMsgEnvlp Envelope AppHdr FIToFICstmrCdtTrf GrpHdr MsgId CreDtTm BtchBookg NbOfTxs CtrlSum TtlIntrBkSttlmAmt IntrBkSttlmDt SttlmInf SttlmMtd ClrSys Cd Prtry
  InstgRmbrsmntAgt InstdRmbrsmntAgt ThrdRmbrsmntAgt PmtTpInf InstrPrty ClrChanl SvcLvl LclInstrm CtgyPurp InstgAgt InstdAgt CdtTrfTxInf
  PmtId InstrId EndToEndId TxId UETR ClrSysRef IntrBkSttlmAmt SttlmPrty SttlmTmIndctn DbtDtTm CdtDtTm AccptncDtTm PoolgAdjstmntDt InstdAmt XchgRate ChrgBr ChrgsInf Amt Agt PrvsInstgAgt1
  PrvsInstgAgt2 PrvsInstgAgt3 IntrmyAgt1 IntrmyAgt2 IntrmyAgt3 UltmtDbtr InitgPty Dbtr DbtrAcct DbtrAgt CdtrAgt
  Cdtr CdtrAcct UltmtCdtr InstrForCdtrAgt InstrForNxtAgt InstrInf Purp RmtInf Ustrd Nm PstlAdr Id CtctDtls CtryOfRes AdrTp Dept SubDept StrtNm BldgNb BldgNm Flr PstBx Room PstCd TwnNm TwnLctnNm
  DstrctNm CtrySubDvsn Ctry AdrLine OrgId PrvtId AnyBIC LEI Othr SchmeNm Issr IBAN FinInstnId BICFI ClrSysMmbId ClrSysId MmbId BrnchId Tp Ccy Prxy CharSet Fr To FIId BizMsgIdr MsgDefIdr BizSvc MktPrctc CreDt
  CpyDplct PssblDplct Prty`.split(/\s+/),
)
const WRAPPERS = ['BusinessMessage', 'BizMsgEnvlp', 'Envelope']
const PREFIXES = /^(|ns[1-9]?|pacs|head|doc)$/
const CCY_ELEMENTS = ['IntrBkSttlmAmt', 'InstdAmt', 'TtlIntrBkSttlmAmt', 'Amt']
const PACS_NS = /^urn:iso:std:iso:20022:tech:xsd:pacs\.008\.\d{3}\.\d{2}$/
const HEAD_NS = /^urn:iso:std:iso:20022:tech:xsd:head\.001\.\d{3}\.\d{2}$/
// M4 ④ reference elements and their standard length limits
const ID_LIMITS: Readonly<Record<string, number>> = { MsgId: 35, InstrId: 35, EndToEndId: 35, TxId: 35, BizMsgIdr: 35, ClrSysRef: 35 }
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/
const NUMBER = /^\d{1,18}(\.\d{1,5})?$/
const BIC = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/
// C.2: leaves with a stated format. M4 ③ does not count their digits, and a value out of format disqualifies (everything else is counted, fail closed)
const FIXED_FORMAT: Readonly<Record<string, RegExp>> = {
  UETR: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, CreDtTm: DATETIME, CreDt: DATETIME, AccptncDtTm: DATETIME, DbtDtTm: DATETIME, CdtDtTm: DATETIME,
  IntrBkSttlmDt: DATE, PoolgAdjstmntDt: DATE, IntrBkSttlmAmt: NUMBER, InstdAmt: NUMBER, Amt: NUMBER, TtlIntrBkSttlmAmt: NUMBER, CtrlSum: NUMBER, NbOfTxs: /^\d{1,15}$/, XchgRate: NUMBER,
  BICFI: BIC, AnyBIC: BIC, LEI: /^[A-Z0-9]{18}[0-9]{2}$/, MsgDefIdr: /^pacs\.008\.\d{3}\.\d{2}$/,
}

/** C.2 on the raw XML and its tree: the first problem, or null. */
function strictProblem(xml: string, root: Node, doc: Node): string | null {
  const decl = /^\s*<\?xml\s[^?]*\?>/.exec(xml)
  if (decl && !/^\s*<\?xml\s+version="1\.[01]"(\s+encoding="(UTF|utf)-8")?\s*\?>$/.test(decl[0])) return 'declaration'
  const body = decl ? xml.slice(decl[0].length) : xml
  if (/<!--/.test(body)) return 'comment'
  if (/<\?/.test(body)) return 'processing_instruction'
  if (/<!\[CDATA\[/i.test(body)) return 'cdata'
  if (/&#/.test(body)) return 'character_reference'
  const rootName = localName(nameOf(root))
  let head: Node | null = null
  if (root === doc) {
    if (rootName !== 'Document') return 'root'
  } else {
    if (!WRAPPERS.includes(rootName)) return 'root'
    const children = childrenOf(root)
    head = children.find((c) => localName(nameOf(c)) === 'AppHdr') ?? null
    if (children.length !== 2 || !head || !children.includes(doc)) return 'envelope'
  }
  const rootScope = scopeOf(root, {})
  const check = (n: Node, parent: Scope, scopeNs: string | null, canDeclare: boolean, q0 = ''): string | null => {
    const q = nameOf(n)
    const local = localName(q)
    const scope = scopeOf(n, parent)
    if (!ELEMENTS.has(local)) return 'element'
    // structural elements only where C.2 puts them
    if (local === 'Document' && n !== doc) return 'element'
    if (local === 'AppHdr' && n !== head) return 'element'
    if ((local === 'DbtrAcct' || local === 'CdtrAcct') && localName(q0) !== 'CdtTrfTxInf') return 'element'
    if (local === 'CdtTrfTxInf' && localName(q0) !== 'FIToFICstmrCdtTrf') return 'element'
    if (local === 'FIToFICstmrCdtTrf' && localName(q0) !== 'Document') return 'element'
    if (!PREFIXES.test(prefixOf(q))) return 'prefix'
    if (scopeNs !== null && scope[prefixOf(q)] !== scopeNs) return 'namespace'
    for (const [k, v] of Object.entries(n[':@'] ?? {})) {
      if (k === '@_xmlns' || k.startsWith('@_xmlns:')) {
        if (!canDeclare || !(PACS_NS.test(v) || HEAD_NS.test(v))) return 'attribute'
        if (!PREFIXES.test(k === '@_xmlns' ? '' : k.slice(8))) return 'prefix'
      } else if (k !== '@_Ccy' || !CCY_ELEMENTS.includes(local) || !/^[A-Z]{3}$/.test(v)) return 'attribute'
    }
    const raw = n[q] as Node[]
    const hasText = raw.some((c) => '#text' in c && String(c['#text']).trim() !== '')
    const kidsHere = childrenOf(n)
    if (hasText && kidsHere.length) return 'mixed_content'
    if (hasText && FIXED_FORMAT[local] && !FIXED_FORMAT[local]!.test(textOf(n))) return 'format'
    for (const c of kidsHere) {
      const isHead = c === head
      const isDoc = c === doc
      const ns = isDoc ? scopeOf(c, scope)[prefixOf(nameOf(c))] ?? null : isHead ? scopeOf(c, scope)[prefixOf(nameOf(c))] ?? null : scopeNs
      if (isHead && !HEAD_NS.test(ns ?? '')) return 'namespace'
      if (isDoc && !PACS_NS.test(ns ?? '')) return 'namespace'
      const p = check(c, scope, ns, isHead || isDoc, q)
      if (p) return p
    }
    return null
  }
  if (root === doc && !PACS_NS.test(rootScope[prefixOf(nameOf(root))] ?? '')) return 'namespace'
  const p = check(root, {}, root === doc ? (rootScope[prefixOf(nameOf(root))] ?? null) : null, true)
  if (p) return p
  for (const msg of childrenOf(doc)) {
    for (const tx of kids(msg, 'CdtTrfTxInf')) {
      for (const role of ['DbtrAcct', 'CdtrAcct']) {
        const acct = kids(tx, role)
        if (acct.length > 1) return 'account_repeated'
        if (acct.length === 0) continue
        const only = childrenOf(acct[0]!)
        if (only.length !== 1 || localName(nameOf(only[0]!)) !== 'Id') return 'account_shape'
        const inner = childrenOf(only[0]!)
        if (inner.length !== 1) return 'account_shape'
        const name = localName(nameOf(inner[0]!))
        if (name === 'IBAN') {
          if (childrenOf(inner[0]!).length || !textOf(inner[0]!)) return 'account_shape'
        } else if (name === 'Othr') {
          const o = childrenOf(inner[0]!)
          if (o.length !== 1 || localName(nameOf(o[0]!)) !== 'Id' || childrenOf(o[0]!).length || !textOf(o[0]!)) return 'account_shape'
        } else return 'account_shape'
      }
    }
  }
  return null
}

/** Parse an XML attachment; only pacs.008 (as root `Document` or in an `AppHdr` + `Document` envelope) is read. */
export function parsePacs008(xml: string, currencies: readonly string[]): PacsResult {
  if (Buffer.byteLength(xml, 'utf8') > PACS008_MAX_BYTES) return { parsed: false, reason: 'too_large' }
  // Any DTD (and so any entity declaration) means the file is not parsed at all.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { parsed: false, reason: 'dtd_or_entity' }
  let tree: Node[]
  try {
    tree = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      processEntities: true,
      htmlEntities: false,
      trimValues: true,
    }).parse(xml, true) as Node[]
  } catch {
    return { parsed: false, reason: 'malformed' }
  }
  const roots = tree.filter((n) => !nameOf(n).startsWith('?') && !('#text' in n))
  if (roots.length !== 1) return { parsed: false, reason: 'malformed' }
  const root = roots[0]!
  const rootScope = scopeOf(root, {})
  const isPacsDoc = (n: Node, scope: Scope) =>
    localName(nameOf(n)) === 'Document' && (scope[prefixOf(nameOf(n))] ?? '').startsWith(NS_PREFIX)

  let doc: Node | null = null
  if (isPacsDoc(root, rootScope)) doc = root
  else if (kids(root, 'AppHdr').length > 0) {
    doc = kids(root, 'Document').find((d) => isPacsDoc(d, scopeOf(d, rootScope))) ?? null
  }
  if (!doc) return { parsed: false, reason: 'not_pacs008' }

  // every element text of the document is attachment text (creditor account, names, remittance; PRD v0.7.3)
  const texts: string[] = []
  const at = new Map<Node, [number, number]>() // an element's own text in the joined text
  let len = 0
  const walk = (n: Node) => {
    for (const c of n[nameOf(n)] as Node[]) {
      if ('#text' in c) {
        const v = String(c['#text']).trim()
        if (!v) continue
        if (texts.length) len += 1 // the '\n' between texts
        const prev = at.get(n)
        at.set(n, [prev ? prev[0] : len, len + v.length])
        texts.push(v)
        len += v.length
      } else if (!nameOf(c).startsWith('?')) walk(c)
    }
  }
  walk(root) // the whole file, envelope included

  const items: PacsItem[] = []
  for (const msg of childrenOf(doc)) {
    const grpDateEl = kids(msg, 'GrpHdr').flatMap((g) => kids(g, 'IntrBkSttlmDt'))[0]
    for (const tx of kids(msg, 'CdtTrfTxInf')) {
      const amt = kids(tx, 'IntrBkSttlmAmt')[0]
      const ccy = amt?.[':@']?.['@_Ccy'] ?? null
      const amountText = amt ? textOf(amt) : null
      const dateEl = kids(tx, 'IntrBkSttlmDt')[0] ?? grpDateEl
      const date = dateEl ? textOf(dateEl) : null
      const uetrEl = kids(tx, 'PmtId').flatMap((p) => kids(p, 'UETR'))[0]
      const uetr = uetrEl ? textOf(uetrEl) : null
      const { minor, currency } = pacsAmount({ amountText, ccy }, currencies)
      const valueDate = date && isIsoDate(date) ? date : null
      items.push({
        minor,
        currency,
        valueDate,
        uetr: uetr ? uetr.toLowerCase() : null,
        amountText,
        ccy,
        spans: { amount: (amt && at.get(amt)) ?? null, valueDate: (valueDate && dateEl && at.get(dateEl)) || null, uetr: (uetr && uetrEl && at.get(uetrEl)) || null },
      })
    }
  }
  // C.2: the account positions on their fixed paths, and each leaf's role for M4
  const accounts: PacsStrict['accounts'] = []
  const accountNodes = new Set<Node>()
  let txNo = 0
  for (const msg of childrenOf(doc)) {
    for (const tx of kids(msg, 'CdtTrfTxInf')) {
      for (const [element, role] of [['DbtrAcct', 'debtor'], ['CdtrAcct', 'creditor']] as const) {
        for (const acct of kids(tx, element)) {
          for (const id of kids(acct, 'Id')) {
            for (const leaf of [...kids(id, 'IBAN'), ...kids(id, 'Othr').flatMap((o) => kids(o, 'Id'))]) {
              const span = at.get(leaf)
              if (!span) continue
              accounts.push({ tx: txNo, role, span })
              accountNodes.add(leaf)
            }
          }
        }
      }
      txNo++
    }
  }
  const free: PacsStrict['free'] = []
  const ids: PacsStrict['ids'] = []
  for (const [node, span] of at) {
    if (accountNodes.has(node)) continue
    const local = localName(nameOf(node))
    if (ID_LIMITS[local] !== undefined) ids.push({ span, max: ID_LIMITS[local]! })
    else if (!FIXED_FORMAT[local]) free.push(span)
  }
  const reason = strictProblem(xml, root, doc)
  return { parsed: true, items, text: texts.join('\n'), strict: { ok: reason === null, reason, accounts, free, ids } }
}
