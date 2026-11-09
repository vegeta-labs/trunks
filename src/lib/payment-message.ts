// PRD C-CLS-4a and appendix C (v0.7.28): when the accounts in a payment message do not count as a bank details change.
// Pure functions. Everything is fail closed: what these rules do not positively accept keeps the C-CLS-4 trigger.
import { ibanShapes, ibanValid, normaliseAccount } from './accounts.ts'
import { mt103 } from './amounts.ts'
import { pacsAmount, type PacsResult } from './pacs008.ts'
import { accountShapes } from './redact.ts'
import { findPhrases, fromOriginal, normalise, normaliseText, words, type Normalised } from './text.ts'
import { extractUetrs } from './uetr.ts'

interface Span {
  start: number
  end: number
}

// C.5 stems: anywhere in a word
const E2_STEMS = ['account', 'acct', 'iban', 'benef', 'payee', 'banking', 'refund', 'konto', 'banco', 'cuenta', 'compte']
// C.5 whole words or phrases (I-05)
const E2_PHRASES = [
  'a/c', 'sort code', 'rib', 'bank details', 'payment instructions', 'pay to', 'pay into', 'send funds', 'send back', 'return', 'sender', 'originator',
  'distribution', 'from now on', 'going forward', 'in future', 'future payments', 'later', 'subsequent', 'henceforth', 'instead',
]
// C.5 Chinese: not separated by spaces, matched as substrings
const E2_CJK = [
  '账户', '账号', '帐户', '帐号', '户口', '收款', '受益', '退款', '退回', '以后', '今后', '后续', '汇到', '付到', '转到', '打到', '汇款到', '转账到', '打款到', '付款到', '汇至', '汇入',
  '賬戶', '賬號', '帳戶', '帳號', '戶口', '受益', '退款', '退回', '以後', '今後', '後續', '匯到', '轉到', '匯款到', '轉賬到', '轉帳到', '匯至', '匯入',
]
// C.5: any form of wire or remit, except inside these usual ways of naming a payment document. Words as I-05 reads them
const WIRE_FORMS = new Set(['wire', 'wires', 'wired', 'wiring'])
const WIRE_DOCUMENTS = new Set(['confirmation', 'receipt', 'transfer', 'advice', 'reference'])
const REMITTANCE_DOCUMENTS = new Set(['advice', 'information', 'slip', 'reference'])
function wireOrRemit(ws: readonly string[]): boolean {
  return ws.some((w, n) => {
    if (!WIRE_FORMS.has(w) && !w.startsWith('remit')) return false
    const next = ws[n + 1] ?? ''
    const named = (w === 'wire' && WIRE_DOCUMENTS.has(next)) || (w === 'remittance' && REMITTANCE_DOCUMENTS.has(next))
    return !named || ws[n + 2] === 'to'
  })
}
// C.6: added as a rule label when the mail has payment evidence (D7); `后续` only cancels the exception
const REDIRECT_PHRASES = ['from now on', 'going forward', 'henceforth', 'future payments']
const REDIRECT_CJK = ['以后', '今后', '以後', '今後']

export const CHANGE_WORDS = ['change', 'changed', 'new', 'update', 'updated']
export const BANK_WORDS = ['bank', 'account', 'details', 'payment instructions']
export const hasChangeWording = (normalised: string) => findPhrases(normalised, CHANGE_WORDS).length > 0 && findPhrases(normalised, BANK_WORDS).length > 0
// C.0: accents that NFKC composed into one letter are removed too, so `ẃire` and `REMİT` cannot hide a word. Only these
// rules: the general C-CLS-4 wording rule and other word lists keep I-05 as it is
const fold = (t: string) => t.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC')
// C.0: CJK characters separate English words here, as in C-RED-0 (v0.7.11): `请wire到附件` holds the word `wire`
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const forWords = (folded: string) => folded.replace(CJK, ' ')
export const hasChangeWordingFolded = (normalised: string) => hasChangeWording(forWords(fold(normalised)))

const LATIN = /\p{Script=Latin}/u
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u
const mixedScript = (ws: readonly string[]) => ws.some((w) => LATIN.test(w) && LOOKALIKE.test(w))

/** C.5 on normalised text: true = the exception is cancelled. */
export function hasRedirectWording(text: string): boolean {
  const normalised = fold(text)
  // words as I-05 reads them: lower case, combining marks removed, so a mark cannot hide a word
  const latin = forWords(normalised)
  const ws = words(latin).map((w) => w.word)
  const folded = ws.join(' ')
  return E2_STEMS.some((s) => folded.includes(s)) || E2_CJK.some((s) => normalised.includes(s)) || findPhrases(latin, E2_PHRASES).length > 0 || wireOrRemit(ws) || mixedScript(ws)
}

/** C.6 on normalised text. */
export function hasExplicitRedirect(text: string): boolean {
  const normalised = fold(text)
  return REDIRECT_CJK.some((s) => normalised.includes(s)) || findPhrases(forWords(normalised), REDIRECT_PHRASES).length > 0
}

// ---------- what a structurally valid message looks like, whichever the format ----------

export interface MessageView {
  text: string // I-04 normalised
  payers: Span[] // account positions in `text`
  beneficiaries: Span[]
  fields: Span[] // M4 ①: the change wording rule reads one field or element at a time
  free: Span[] // what M4 ③ counts digits in
  beneficiaryLines: Span[] // M4 ③: non-position lines of 59a, the lower limit
  ids: Array<Span & { max: number }> // reference fields: no white space, length limit
  uetrs: Array<string | null> // per transaction, a valid C-EXT-1 UETR
  transactions: Array<{ minor: number | null; currency: string | null; valueDate: string | null }>
}

// ---------- C.1 MT103 ----------

const ORDER: ReadonlyArray<{ tags: readonly string[]; n: '1' | '?' | '*' }> = [
  { tags: ['20'], n: '1' }, { tags: ['13C'], n: '*' }, { tags: ['23B'], n: '1' }, { tags: ['23E'], n: '*' }, { tags: ['26T'], n: '?' }, { tags: ['32A'], n: '1' },
  { tags: ['33B'], n: '?' }, { tags: ['36'], n: '?' }, { tags: ['50A', '50F', '50K'], n: '1' }, { tags: ['51A'], n: '?' }, { tags: ['52A', '52D'], n: '?' },
  { tags: ['53A', '53B', '53D'], n: '?' }, { tags: ['54A', '54B', '54D'], n: '?' }, { tags: ['55A', '55B', '55D'], n: '?' }, { tags: ['56A', '56C', '56D'], n: '?' },
  { tags: ['57A', '57B', '57C', '57D'], n: '?' }, { tags: ['59', '59A', '59F'], n: '1' }, { tags: ['70'], n: '?' }, { tags: ['71A'], n: '1' }, { tags: ['71F'], n: '*' },
  { tags: ['71G'], n: '?' }, { tags: ['72'], n: '?' }, { tags: ['77B'], n: '?' },
]
// fields whose content is a fixed format: M4 ③ does not count their digits
const STRUCTURED = new Set(['20', '13C', '23B', '26T', '32A', '33B', '36', '71A', '71F', '71G'])
const CCY_AMOUNT = /^[A-Z]{3}[\d,]+$/
const FORMATS: Readonly<Record<string, RegExp>> = { '13C': /^\/[A-Z]{1,8}\/\d{4}[+-]\d{4}$/, '23B': /^[A-Z]{4}$/, '26T': /^[A-Z0-9]{3}$/, '33B': CCY_AMOUNT, '36': /^[\d,]+$/, '71A': /^(BEN|OUR|SHA)$/, '71F': CCY_AMOUNT, '71G': CCY_AMOUNT }
export const digitCount = (t: string) => (t.match(/\p{Nd}/gu) ?? []).length
const PARTY_TAGS = new Set(['50A', '50F', '50K', '59', '59A', '59F'])
const SUB = String.raw`\{[0-9A-Z]{3}:[0-9A-Za-z]{0,32}\}`
const HEADER = new RegExp(String.raw`^\s*(?:\{1:[FA]\d{2}[A-Z0-9]{12}\d{10}\}\s*)?(?:\{2:[IO]103[A-Z0-9]{0,43}\}\s*)?(?:\{3:(?:\{(?:108|111|119|121):[0-9A-Za-z-]{1,36}\})+\}\s*)?\{4:[ \t]*\r?\n`)
const TRAILER = new RegExp(String.raw`^\s*(?:\{5:(?:${SUB})*\}\s*)?(?:\{S:(?:${SUB})*\}\s*)?$`)

/** C.1: the fields of a message, or null when the text is not exactly one MT103. */
function mt103Fields(text: string): { fields: Array<{ tag: string; start: number; end: number }> } | null {
  let from = 0
  let to = text.length
  const h = HEADER.exec(text)
  if (h) {
    from = h[0].length
    const close = /^-\}/gm
    close.lastIndex = from
    const c = close.exec(text)
    if (!c || !TRAILER.test(text.slice(c.index + 2))) return null
    to = c.index
  } else {
    if (/^\s*\{/.test(text) || /[{}]/.test(text)) return null
    from = /^\s*/.exec(text)![0].length
    to = text.trimEnd().length
  }
  const body = text.slice(from, to)
  const fields: Array<{ tag: string; start: number; end: number }> = []
  const re = /^:([0-9]{2}[A-Z]?):/gm
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (fields.length === 0 && body.slice(0, m.index).trim() !== '') return null
    if (fields.length) fields[fields.length - 1]!.end = from + m.index
    fields.push({ tag: m[1]!, start: from + m.index + m[0].length, end: to })
  }
  if (fields.length === 0) return null
  let at = 0
  for (const rule of ORDER) {
    let seen = 0
    while (at < fields.length && rule.tags.includes(fields[at]!.tag)) {
      seen++
      at++
      if (rule.n !== '*' && seen > 1) return null
    }
    if (rule.n === '1' && seen !== 1) return null
  }
  return at === fields.length ? { fields } : null
}

function mt103View(n: Normalised, currencies: readonly string[]): MessageView | null {
  // C.0: CRLF, LF and CR end a line; any other line separator disqualifies
  if (['\v', '\f', '\u0085', '\u2028', '\u2029'].some((c) => n.text.includes(c))) return null
  const text = n.text.replace(/\r\n?/g, '\n')
  const parsed = mt103Fields(text)
  if (!parsed) return null
  const items = mt103(text, currencies)
  const f32 = parsed.fields.find((x) => x.tag === '32A')!
  if (items.length !== 1 || items[0]!.start !== f32.start - 5 || items[0]!.end !== text.slice(f32.start, f32.end).trimEnd().length + f32.start) return null
  const payers: Span[] = []
  const beneficiaries: Span[] = []
  const free: Span[] = []
  const beneficiaryLines: Span[] = []
  const ids: Array<Span & { max: number }> = []
  const fields: Span[] = []
  for (const x of parsed.fields) {
    const value = text.slice(x.start, x.end).trimEnd()
    fields.push({ start: x.start, end: x.start + value.length })
    // a fixed format field is one line (C.1)
    if (STRUCTURED.has(x.tag) && value.includes('\n')) return null
    if (FORMATS[x.tag] && !FORMATS[x.tag]!.test(value)) return null
    if (x.tag === '20') ids.push({ start: x.start, end: x.start + value.length, max: 16 })
    if (PARTY_TAGS.has(x.tag)) {
      const nl = value.indexOf('\n')
      const line = nl === -1 ? value : value.slice(0, nl)
      // C.0: a value is trimmed, so `:59: /12345678` is the same position as `:59:/12345678`
      const lead = line.length - line.trimStart().length
      const first = line.slice(lead)
      let restFrom = x.start
      if (first.startsWith('/')) {
        // the account position: after the one `/`, to the end of the line; `//` or nothing after it disqualifies.
        // A value with no digit is a name (C.1): `:59:/NORTHWIND SPV CLIENT AC`
        if (first.startsWith('//') || first.trim() === '/') return null
        if (digitCount(first) > 0) {
          ;(x.tag.startsWith('50') ? payers : beneficiaries).push({ start: x.start + lead + 1, end: x.start + line.length })
          restFrom = x.start + line.length
        }
      }
      const lines = { start: restFrom, end: x.start + value.length }
      free.push(lines)
      if (x.tag.startsWith('59')) beneficiaryLines.push(lines)
    } else if (!STRUCTURED.has(x.tag)) free.push({ start: x.start, end: x.start + value.length })
  }
  // C-DRF-4: exactly one, in the `{3:}` block; the same text in a field does not count
  const uetrHeaders = [...(HEADER.exec(text)?.[0] ?? '').matchAll(/\{121:([^{}\n]*)\}/g)]
  const uetrHeader = uetrHeaders.length === 1 ? uetrHeaders[0]! : null
  const u = uetrHeader ? extractUetrs(uetrHeader[1]!) : null
  const uetr = u && u.uetrs.length === 1 && u.hits[0]!.start === 0 && u.hits[0]!.end === uetrHeader![1]!.length ? u.uetrs[0]! : null
  return { text, payers, beneficiaries, fields, free, beneficiaryLines, ids, uetrs: [uetr], transactions: [{ minor: items[0]!.minor, currency: items[0]!.currency, valueDate: items[0]!.valueDate }] }
}

// ---------- C.2 pacs.008 ----------

type ParsedPacs = Extract<PacsResult, { parsed: true }>

function pacsView(rawText: string, r: ParsedPacs, currencies: readonly string[]): MessageView | null {
  if (r.strict?.ok !== true) return null
  const amounts = r.items.map((i) => pacsAmount(i, currencies))
  if (!amounts.some((a) => a.minor !== null)) return null
  const n = normalise(rawText)
  const at = (s: readonly [number, number]): Span => {
    const [start, end] = fromOriginal(n, s[0], s[1])
    return { start, end }
  }
  const uetrs = r.items.map((i) => {
    const u = i.uetr ? extractUetrs(i.uetr) : null
    return u && u.uetrs.length === 1 && u.hits[0]!.start === 0 && u.hits[0]!.end === i.uetr!.length ? u.uetrs[0]! : null
  })
  // a value with no digit is a name (C.2): it is free text, not an account position
  const hasDigit = (a: { span: [number, number] }) => {
    const s = at(a.span)
    return digitCount(n.text.slice(s.start, s.end)) > 0 // after I-04: `⑧⑦⑥` are digits
  }
  const names = r.strict.accounts.filter((a) => !hasDigit(a)).map((a) => at(a.span))
  const free = [...r.strict.free.map(at), ...names]
  return {
    text: n.text,
    payers: r.strict.accounts.filter((a) => a.role === 'debtor' && hasDigit(a)).map((a) => at(a.span)),
    beneficiaries: r.strict.accounts.filter((a) => a.role === 'creditor' && hasDigit(a)).map((a) => at(a.span)),
    fields: [...free, ...r.strict.ids.map((x) => at(x.span))],
    free,
    beneficiaryLines: r.strict.accounts.filter((a) => a.role === 'creditor' && !hasDigit(a)).map((a) => at(a.span)),
    ids: r.strict.ids.map((x) => ({ ...at(x.span), max: x.max })),
    uetrs,
    transactions: r.items.map((i, j) => ({ minor: amounts[j]!.minor, currency: amounts[j]!.currency, valueDate: i.valueDate })),
  }
}

// ---------- M1, M2 ----------

export interface AttachmentInput {
  ordinal: number
  kind: string
  filename: string
  parseStatus: string
  text: string
  facts: { pacs008?: PacsResult; nested?: unknown[] } | null
  maybeKyc: boolean | null
}

/** M1 + M2: the structured view of a top-level attachment, or null. */
export function structuredMessage(a: AttachmentInput, currencies: readonly string[]): MessageView | null {
  if (a.parseStatus !== 'parsed' || a.facts?.nested?.length) return null
  if (a.kind === 'txt') return mt103View(normalise(a.text), currencies)
  if (a.kind === 'xml' && a.facts?.pacs008?.parsed) return pacsView(a.text, a.facts.pacs008, currencies)
  return null
}

const valueOf = (v: MessageView, s: Span) => v.text.slice(s.start, s.end).trim()
const removeSpans = (t: string, spans: readonly Span[]) => {
  let out = ''
  let at = 0
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    out += `${t.slice(at, s.start)}\n`
    at = s.end
  }
  return out + t.slice(at)
}

/** M3 and M4. Returns the failed condition, or null. */
export function messageContentProblem(v: MessageView): 'M3' | 'M4' | null {
  const positions = [...v.payers, ...v.beneficiaries]
  const trimmed = (s: Span): Span => {
    const raw = v.text.slice(s.start, s.end)
    const start = s.start + (raw.length - raw.trimStart().length)
    return { start, end: start + raw.trim().length }
  }
  for (const shape of accountShapes(v.text)) {
    const inside = positions.map(trimmed).find((p) => shape.start === p.start && shape.end === p.end)
    if (!inside) return 'M3'
  }
  for (const h of ibanShapes(v.text)) if (!ibanValid(v.text.slice(h.start, h.end))) return 'M3'
  for (const p of v.payers) {
    const value = valueOf(v, p)
    const iban = ibanShapes(value).find((h) => h.start === 0 && h.end === value.length)
    if (!(iban && ibanValid(value)) && !/^[\d\s.-]+$/.test(value)) return 'M3'
  }
  if (hasRedirectWording(normaliseText(removeSpans(v.text, positions)))) return 'M4'
  if (v.fields.some((f) => hasChangeWordingFolded(normaliseText(removeSpans(v.text.slice(f.start, f.end), positions.filter((p) => p.start >= f.start && p.end <= f.end).map((p) => ({ start: p.start - f.start, end: p.end - f.start }))))))) return 'M4'
  for (const f of v.free) if (digitCount(v.text.slice(f.start, f.end)) >= 8) return 'M4'
  for (const f of v.beneficiaryLines) if (digitCount(v.text.slice(f.start, f.end)) >= 6) return 'M4'
  for (const i of v.ids) {
    const value = v.text.slice(i.start, i.end)
    if (/\s/.test(value) || value.length > i.max) return 'M4'
  }
  return null
}

// ---------- C-CLS-4a ----------

export const SIGNALS = ['auth_fail', 'untrusted_auth_header', 'display_name_mismatch', 'lookalike_domain', 'reply_to_mismatch', 'first_time_sender', 'hidden_text', 'injection_markers', 'message_id_collision'] as const
const PAYMENT_ONLY = ['payment_query', 'payment_evidence']

export interface ExemptionInput {
  subject: string
  body: string
  bodyHtml: string
  attachments: readonly AttachmentInput[]
  currencies: readonly string[]
  signals: Readonly<Record<string, boolean | null>>
  authenticated: boolean // C-SIG-3
  senderDeals: readonly string[] // deal keys the sender is involved in: `deal`, `investor_id` and `authorised_for` together
  referenceDeals: readonly string[] // the deal key of each reference the rules found ('' = no commitment)
  blockedOrOverLimit: boolean // attachments blocked or over the limit, or a mail only partly decoded (E4)
  modelLabels: readonly string[] | null // every label, low included; null = the model call failed
  priorBankRule: boolean // E6
  listed: (dealKey: string, account: string) => boolean | null // M5; null = this deal has no list
}

export type Exemption =
  | { applied: true; dealKey: string; ordinal: number; payerLast4: string[]; beneficiaryLast4: string[] }
  | { applied: false; reason: string }

const isInlineImage = (a: AttachmentInput) => a.kind === 'image' && a.maybeKyc === false
const last4 = (v: string) => normaliseAccount(v).slice(-4)

/**
 * C-CLS-4a: does the account in the only real attachment stop counting? A mail with no account shape in an attachment
 * has nothing to exempt, and the caller does not ask.
 */
export function evidenceExemption(i: ExemptionInput): Exemption {
  const no = (reason: string): Exemption => ({ applied: false, reason })
  if (i.priorBankRule) return no('E6')
  const others = i.attachments.filter((a) => !isInlineImage(a))
  if (others.length !== 1 || i.blockedOrOverLimit || others[0]!.maybeKyc !== false) return no('E4')
  const a = others[0]!
  const v = structuredMessage(a, i.currencies)
  if (!v) return no('M2')
  const content = messageContentProblem(v)
  if (content) return no(content)
  const surface = [i.subject, i.body, i.bodyHtml, ...i.attachments.map((x) => x.filename.replace(/[_.-]/g, ' '))].map(normaliseText)
  if (surface.some(hasRedirectWording)) return no('E2')
  if (!SIGNALS.every((s) => i.signals[s] === false) || !i.authenticated) return no('E3')
  const deals = [...new Set(i.senderDeals)]
  if (deals.length !== 1 || i.referenceDeals.some((d) => d !== deals[0])) return no('E3')
  if (i.modelLabels === null || !i.modelLabels.every((l) => PAYMENT_ONLY.includes(l))) return no('E5')
  const dealKey = deals[0]!
  const beneficiaries = v.beneficiaries.map((s) => valueOf(v, s))
  if (i.listed(dealKey, '') === null) return no('M5')
  if (!beneficiaries.every((b) => i.listed(dealKey, b) === true)) return no('M5')
  return { applied: true, dealKey, ordinal: a.ordinal, payerLast4: v.payers.map((s) => last4(valueOf(v, s))), beneficiaryLast4: beneficiaries.map(last4) }
}

/** C-RSK-2 evidence_beneficiary_mismatch ①: the beneficiary accounts of every structurally valid message. */
export function structuredBeneficiaries(attachments: readonly AttachmentInput[], currencies: readonly string[]): string[] {
  return attachments.flatMap((a) => {
    const v = structuredMessage(a, currencies)
    return v ? v.beneficiaries.map((s) => valueOf(v, s)) : []
  })
}

/** C-DRF-4: exactly one structurally valid message that passes every condition of the step. */
export function evidenceSupportsTracing(attachments: readonly AttachmentInput[], o: { currencies: readonly string[]; dealCurrency: string | null; cashDue: number | null; receivedDate: string; partlyDecoded?: boolean }): boolean {
  if (o.dealCurrency === null || o.cashDue === null || o.partlyDecoded) return false
  const views = attachments.map((a) => structuredMessage(a, o.currencies)).filter((v): v is MessageView => v !== null)
  if (views.length !== 1) return false
  const v = views[0]!
  if (v.transactions.length === 0 || v.uetrs.length !== v.transactions.length || v.uetrs.some((u) => u === null) || new Set(v.uetrs).size !== v.uetrs.length) return false
  const dates = new Set(v.transactions.map((t) => t.valueDate))
  const date = v.transactions[0]!.valueDate
  if (dates.size !== 1 || date === null || date > o.receivedDate) return false
  if (v.transactions.some((t) => t.minor === null || t.currency !== o.dealCurrency)) return false
  return v.transactions.reduce((s, t) => s + t.minor!, 0) <= o.cashDue
}
