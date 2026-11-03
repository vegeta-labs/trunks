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

export type PacsResult = { parsed: true; items: PacsItem[]; text: string } | { parsed: false; reason: 'too_large' | 'dtd_or_entity' | 'malformed' | 'not_pacs008' }

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
  return { parsed: true, items, text: texts.join('\n') }
}
