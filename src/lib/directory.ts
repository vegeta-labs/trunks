// PRD R-DIR-01 to 03, C-DIR-1 to 3: directory CSV imports. Header aliases, currency annotations, line endings and
// cell handling are copied from Deal Ops Toolkit src/lib/csv.ts and money.ts (same author), so files exported by the
// Toolkit import here unchanged.
import Papa from 'papaparse'
import { isoFromParts } from './dates.ts'
import { normAddress } from './signals.ts'

export interface ImportError {
  where: string
  message: string
}
export type Imported<T> = { ok: true; rows: T[]; ignoredColumns: string[] } | { ok: false; errors: ImportError[] }

type Currency = string
type FieldSpec = { key: string; required: boolean; aliases: string[] }

const SCHEMAS = {
  deals: [
    { key: 'name', required: true, aliases: ['deal', 'deal name'] },
    { key: 'currency', required: true, aliases: ['ccy'] },
    { key: 'close_date', required: false, aliases: ['planned close', 'planned close date', 'planned_close_date', 'close date'] },
    { key: 'reference_prefix', required: false, aliases: ['reference prefix', 'reference_prefix'] },
  ],
  commitments: [
    { key: 'investor_id', required: false, aliases: ['id', 'investor id'] },
    { key: 'name', required: true, aliases: ['investor name', 'investor', 'full name'] },
    { key: 'email', required: false, aliases: [] },
    { key: 'reference', required: true, aliases: ['payment reference', 'ref'] },
    { key: 'cash_due', required: true, aliases: ['cash due', 'amount due', 'expected', 'expected amount'] },
    { key: 'scheme', required: false, aliases: ['tax scheme', 'seis/eis'] },
  ],
  bank: [
    { key: 'transaction_id', required: false, aliases: ['id', 'transaction id', 'txn id'] },
    { key: 'date', required: true, aliases: ['value date', 'booking date'] },
    { key: 'amount', required: true, aliases: ['credit', 'paid in'] },
    { key: 'payer', required: false, aliases: ['payer name', 'counterparty', 'from', 'name'] },
    { key: 'reference', required: false, aliases: ['description', 'payment reference', 'narrative'] },
  ],
  // Toolkit ledger export: exact column names (C-DIR-1)
  ledger: ['transaction_id', 'date', 'amount', 'payer', 'reference', 'status', 'investor_id', 'investor_name', 'decided_by', 'withdrawn_on'].map((key) => ({
    key,
    required: ['date', 'amount', 'status'].includes(key),
    aliases: [],
  })),
  contacts: [
    { key: 'contact_id', required: false, aliases: ['id', 'contact id'] },
    { key: 'name', required: true, aliases: [] },
    { key: 'email', required: true, aliases: [] },
    { key: 'phone', required: false, aliases: [] },
    { key: 'role', required: true, aliases: [] },
    { key: 'deal', required: false, aliases: [] },
    { key: 'investor_id', required: false, aliases: [] },
    { key: 'authorised_for', required: false, aliases: [] },
  ],
} satisfies Record<string, FieldSpec[]>
type Kind = keyof typeof SCHEMAS

const CCY_MARKS: Record<string, string[]> = { GBP: ['£', 'gbp'], EUR: ['€', 'eur'], USD: ['$', 'us$', 'usd'] }
const CURRENCY_COLUMN = ['currency', 'ccy']
const IDENTIFIER_FIELDS: Record<Kind, string[]> = {
  deals: ['currency', 'close_date', 'reference_prefix'],
  commitments: ['investor_id', 'reference', 'email', 'cash_due', 'scheme'],
  bank: ['transaction_id', 'date', 'amount'],
  ledger: ['transaction_id', 'date', 'amount', 'status', 'investor_id', 'withdrawn_on'],
  contacts: ['contact_id', 'email', 'phone', 'role', 'deal', 'investor_id', 'authorised_for'],
}

/** Trim ASCII whitespace only: a non-breaking space is content, not padding. */
export const trimAscii = (s: string) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')

function normaliseHeader(raw: string, currency: Currency | null): { name: string } | { error: string } {
  let h = raw.trim().toLowerCase()
  const bracket = /\s*\(([^)]*)\)\s*$/.exec(h)
  let mark: string | null = null
  if (bracket) {
    mark = bracket[1]!.trim()
    h = h.slice(0, bracket.index).trim()
  } else {
    const code = /\s+(gbp|eur|usd)$/.exec(h)
    if (code) {
      mark = code[1]!
      h = h.slice(0, code.index).trim()
    }
  }
  if (mark !== null) {
    const known = Object.entries(CCY_MARKS).find(([, marks]) => marks.includes(mark!))
    if (known && currency !== null && known[0] !== currency) return { error: `column "${raw.trim()}" is in ${known[0]} but this deal is in ${currency}` }
    if (!known) h = raw.trim().toLowerCase() // a bracket that is not a currency: keep the header as written
  }
  return { name: h }
}

/** Mixed line endings: outside quoted fields, CRLF and lone CR become LF; row numbers do not move. */
export function normaliseNewlines(src: string): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"') quoted = !quoted
    if (!quoted && ch === '\r') {
      out += '\n'
      if (src[i + 1] === '\n') i++
      continue
    }
    out += ch
  }
  return out
}

interface Table {
  rows: Array<Record<string, string>>
  rowNumbers: number[]
  rowCurrencies: Array<string | null> // the currency column's value per row, upper case; null without one
  hasColumn: Set<string>
}

function readTable(text: string, kind: Kind, currency: Currency | null): { table: Table; errors: ImportError[]; ignored: string[] } {
  const errors: ImportError[] = []
  const src = normaliseNewlines(text.replace(/^﻿/, ''))
  const records: Array<{ cells: string[]; line: number }> = []
  const lineAt = (offset: number) => src.slice(0, offset).split(/\r\n|\r|\n/).length
  let prevCursor = 0
  Papa.parse<string[]>(src, {
    delimiter: ',',
    newline: '\n',
    skipEmptyLines: false,
    step: (res) => {
      const start = prevCursor
      prevCursor = res.meta.cursor
      for (const err of res.errors) errors.push({ where: `row ${lineAt(start)}`, message: err.message })
      const cells = [...res.data]
      const lead = src.slice(start, res.meta.cursor).match(/^[\r\n]*/)?.[0].length ?? 0
      if (cells.every((c) => c.trim() === '')) return
      records.push({ cells, line: lineAt(start + lead) })
    },
  })
  const [headerRec, ...body] = records
  const header = headerRec?.cells ?? []
  const spec: FieldSpec[] = SCHEMAS[kind]
  const colOf: Record<string, number> = {}
  const ignored: string[] = []
  let currencyCol: number | null = null
  header.forEach((raw, idx) => {
    const n = normaliseHeader(raw, currency)
    if ('error' in n) return void errors.push({ where: 'header', message: n.error })
    if (kind !== 'deals' && CURRENCY_COLUMN.includes(n.name)) {
      if (currencyCol !== null) errors.push({ where: 'header', message: 'two currency columns' })
      currencyCol = idx
      return
    }
    const field = spec.find((f) => f.key === n.name || f.aliases.includes(n.name))
    if (field) {
      if (field.key in colOf) errors.push({ where: 'header', message: `two columns map to "${field.key}"` })
      else colOf[field.key] = idx
      return
    }
    ignored.push(raw.trim())
  })
  for (const f of spec) if (f.required && !(f.key in colOf)) errors.push({ where: 'header', message: `missing required column "${f.key}"` })
  for (const r of body) {
    if (r.cells.length !== header.length) errors.push({ where: `row ${r.line}`, message: `has ${r.cells.length} cells but the header has ${header.length} — check for unquoted commas` })
  }
  // a ledger row in another currency is imported and later not counted (PRD C-DRF-6); commitments and bank lines must match
  if (currencyCol !== null && currency !== null && kind !== 'ledger') {
    for (const r of body) {
      const c = trimAscii(r.cells[currencyCol] ?? '')
      if (c !== '' && c.toUpperCase() !== currency) errors.push({ where: `row ${r.line}, currency`, message: `"${c}" but this deal is in ${currency}` })
    }
  }
  const unescape = (v: string) => (/^'[=+\-@\t\r']/.test(v) ? v.slice(1) : v)
  const ids = new Set(IDENTIFIER_FIELDS[kind])
  const rows = body.map((r) =>
    Object.fromEntries(
      Object.entries(colOf).map(([k, i]) => {
        const v = unescape(r.cells[i] ?? '')
        return [k, ids.has(k) ? trimAscii(v) : v]
      }),
    ),
  )
  const rowCurrencies = body.map((r) => (currencyCol === null ? null : trimAscii(r.cells[currencyCol] ?? '').toUpperCase() || null))
  return { table: { rows, rowNumbers: body.map((r) => r.line), rowCurrencies, hasColumn: new Set(Object.keys(colOf)) }, errors, ignored }
}

// ---------- cell parsers (Toolkit I-01, I-04) ----------

const SYMBOL: Record<string, string> = { GBP: '£', EUR: '€', USD: 'US$' }
const SYMBOL_IN = String.raw`(£|€|US\$|\$)`
const symbolFits = (sym: string, currency: Currency) => sym === SYMBOL[currency] || (currency === 'USD' && sym === '$')
const DIGITS = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)`
export const MAX_MONEY = 100_000_000_000 // 1,000,000,000.00 in minor units

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

export function parseMoney(raw: string, currency: Currency, allowNegative = false): Parsed<number> {
  const s = trimAscii(raw)
  if (s === '') return { ok: false, reason: 'required' }
  const m = new RegExp(String.raw`^(-)?${SYMBOL_IN}?(-)?(${DIGITS})(?:\.(\d{1,2}))?$`).exec(s)
  if (!m) return { ok: false, reason: `"${raw}" is not an amount (use 1234.56 or 1,234.56)` }
  const [, neg1, sym, neg2, int, frac] = m
  if (neg1 && neg2) return { ok: false, reason: `"${raw}" is not an amount` }
  if (sym && !symbolFits(sym, currency)) return { ok: false, reason: `"${raw}" uses ${sym} but this deal is in ${currency}` }
  const negative = Boolean(neg1 || neg2)
  if (negative && !allowNegative) return { ok: false, reason: 'cannot be negative' }
  const minor = Number(int!.replace(/,/g, '')) * 100 + Number((frac ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(minor) || minor > MAX_MONEY) return { ok: false, reason: 'exceeds the 1,000,000,000 limit' }
  return { ok: true, value: negative ? -minor : minor }
}

/** YYYY-MM-DD or DD/MM/YYYY (Toolkit I-04). */
export function parseCsvDate(raw: string): Parsed<string> {
  const s = trimAscii(raw)
  if (s === '') return { ok: false, reason: 'required' }
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  let iso: string | null = null
  if (m) iso = isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]))
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) iso = isoFromParts(Number(m[3]), Number(m[2]), Number(m[1]))
  else return { ok: false, reason: `"${raw}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)` }
  return iso ? { ok: true, value: iso } : { ok: false, reason: `"${raw}" is not a real date` }
}

const list = (s: string | undefined) => (s ?? '').split(';').map(trimAscii).filter(Boolean)

/** Stable id for a row without one: file version + row number (C-DIR-2). */
const rowId = (versionTag: string, row: number) => `${versionTag}-r${row}`

function uniqueIds<T>(rows: T[], idOf: (r: T) => string, rowOf: (r: T) => number, what: string, errors: ImportError[]) {
  const seen = new Map<string, number>()
  for (const r of rows) {
    const id = idOf(r)
    const prior = seen.get(id)
    if (prior !== undefined) errors.push({ where: `row ${rowOf(r)}, ${what}`, message: `"${id}" also used on row ${prior}` })
    else seen.set(id, rowOf(r))
  }
}

// ---------- deals (R-DIR-01) ----------

export interface DealRow {
  name: string
  currency: Currency
  closeDate: string | null
  referencePrefix: string | null
  row: number
}

export function importDeals(text: string, currencies: readonly Currency[]): Imported<DealRow> {
  const { table, errors, ignored } = readTable(text, 'deals', null)
  const rows: DealRow[] = []
  table.rows.forEach((r, i) => {
    const row = table.rowNumbers[i]!
    const name = r.name ?? ''
    if (trimAscii(name) === '') errors.push({ where: `row ${row}, name`, message: 'required' })
    if (name.includes('::')) errors.push({ where: `row ${row}, name`, message: 'cannot contain "::"' })
    const currency = (r.currency ?? '').toUpperCase()
    if (!currencies.includes(currency)) errors.push({ where: `row ${row}, currency`, message: `"${r.currency}" is not one of ${currencies.join(', ')}` })
    let closeDate: string | null = null
    if (r.close_date) {
      const d = parseCsvDate(r.close_date)
      if (d.ok) closeDate = d.value
      else errors.push({ where: `row ${row}, close_date`, message: d.reason })
    }
    rows.push({ name, currency, closeDate, referencePrefix: r.reference_prefix || null, row })
  })
  uniqueIds(rows, (r) => r.name, (r) => r.row, 'name', errors)
  return errors.length ? { ok: false, errors } : { ok: true, rows, ignoredColumns: ignored }
}

// ---------- commitments, bank lines, ledger (C-DIR-1) ----------

export interface CommitmentRow {
  investorId: string
  name: string
  email: string
  reference: string
  cashDue: number
  scheme: string
  row: number
}

export function importCommitments(text: string, currency: Currency, versionTag: string): Imported<CommitmentRow> {
  const { table, errors, ignored } = readTable(text, 'commitments', currency)
  const rows: CommitmentRow[] = []
  table.rows.forEach((r, i) => {
    const row = table.rowNumbers[i]!
    const cash = parseMoney(r.cash_due ?? '', currency)
    if (!cash.ok) errors.push({ where: `row ${row}, cash_due`, message: cash.reason })
    if (trimAscii(r.name ?? '') === '') errors.push({ where: `row ${row}, name`, message: 'required' })
    if ((r.reference ?? '') === '') errors.push({ where: `row ${row}, reference`, message: 'required' })
    const scheme = (r.scheme ?? '').toUpperCase()
    if (!['', 'NONE', 'SEIS', 'EIS'].includes(scheme)) errors.push({ where: `row ${row}, scheme`, message: 'must be none, SEIS or EIS' })
    rows.push({ investorId: r.investor_id || rowId(versionTag, row), name: r.name ?? '', email: r.email ?? '', reference: r.reference ?? '', cashDue: cash.ok ? cash.value : 0, scheme: scheme === '' ? 'NONE' : scheme, row })
  })
  uniqueIds(rows, (r) => r.investorId, (r) => r.row, 'investor_id', errors)
  return errors.length ? { ok: false, errors } : { ok: true, rows, ignoredColumns: ignored }
}

export interface BankRow {
  txnId: string
  date: string
  amount: number
  payer: string
  reference: string
  row: number
}

export function importBank(text: string, currency: Currency, versionTag: string): Imported<BankRow> {
  const { table, errors, ignored } = readTable(text, 'bank', currency)
  const rows: BankRow[] = []
  table.rows.forEach((r, i) => {
    const row = table.rowNumbers[i]!
    const date = parseCsvDate(r.date ?? '')
    if (!date.ok) errors.push({ where: `row ${row}, date`, message: date.reason })
    const amt = parseMoney(r.amount ?? '', currency, true)
    if (!amt.ok) errors.push({ where: `row ${row}, amount`, message: amt.reason })
    rows.push({ txnId: r.transaction_id || rowId(versionTag, row), date: date.ok ? date.value : '', amount: amt.ok ? amt.value : 0, payer: r.payer ?? '', reference: r.reference ?? '', row })
  })
  uniqueIds(rows, (r) => r.txnId, (r) => r.row, 'transaction_id', errors)
  return errors.length ? { ok: false, errors } : { ok: true, rows, ignoredColumns: ignored }
}

export interface LedgerRow {
  txnId: string | null
  date: string
  amount: number
  payer: string
  reference: string
  status: string
  investorId: string | null // Toolkit investor id (bare); the commitment key is deal::investor_id
  investorName: string
  decidedBy: string
  withdrawnOn: string | null
  currency: Currency
  row: number
}

// the Toolkit's line statuses (LineStatus in its reconcile engine); anything else is free text and is refused
export const LEDGER_STATUSES = ['auto', 'confirmed', 'suggested', 'unmatched', 'rejected', 'skipped', 'future'] as const

/** Toolkit ledger export. One row per non-empty transaction_id; no generated ids (C-DIR-1). */
export function importLedger(text: string, currency: Currency): Imported<LedgerRow> {
  const { table, errors, ignored } = readTable(text, 'ledger', currency)
  const parsed: LedgerRow[] = []
  table.rows.forEach((r, i) => {
    const row = table.rowNumbers[i]!
    const date = parseCsvDate(r.date ?? '')
    if (!date.ok) errors.push({ where: `row ${row}, date`, message: date.reason })
    const rowCurrency = table.rowCurrencies[i] ?? currency
    if (!/^[A-Z]{3}$/.test(rowCurrency)) errors.push({ where: `row ${row}, currency`, message: `"${rowCurrency}" is not a currency code` })
    const amt = parseMoney(r.amount ?? '', /^[A-Z]{3}$/.test(rowCurrency) ? (rowCurrency as Currency) : currency, true)
    if (!amt.ok) errors.push({ where: `row ${row}, amount`, message: amt.reason })
    else if (amt.value < 0) errors.push({ where: `row ${row}, amount`, message: 'cannot be negative (reverse it in the Toolkit and export again)' })
    const status = (r.status ?? '').toLowerCase()
    if (!(LEDGER_STATUSES as readonly string[]).includes(status)) errors.push({ where: `row ${row}, status`, message: `"${r.status ?? ''}" must be one of ${LEDGER_STATUSES.join(', ')}` })
    let withdrawnOn: string | null = null
    if (r.withdrawn_on) {
      const w = parseCsvDate(r.withdrawn_on)
      if (w.ok) withdrawnOn = w.value
      else errors.push({ where: `row ${row}, withdrawn_on`, message: w.reason })
    }
    parsed.push({
      txnId: r.transaction_id || null, date: date.ok ? date.value : '', amount: amt.ok ? amt.value : 0, payer: r.payer ?? '', reference: r.reference ?? '',
      status, investorId: r.investor_id || null, investorName: r.investor_name ?? '', decidedBy: r.decided_by ?? '', withdrawnOn, currency: rowCurrency, row,
    })
  })
  const full = (l: LedgerRow) => JSON.stringify([l.txnId, l.date, l.amount, l.payer, l.reference, l.status, l.investorId, l.investorName, l.decidedBy, l.withdrawnOn])
  const byId = new Map<string, LedgerRow>()
  const rows: LedgerRow[] = []
  for (const l of parsed) {
    if (l.txnId === null) continue
    const prior = byId.get(l.txnId)
    if (!prior) {
      byId.set(l.txnId, l)
      rows.push(l)
    } else if (full(prior) !== full(l)) errors.push({ where: `row ${l.row}, transaction_id`, message: `"${l.txnId}" also on row ${prior.row} with different values` })
  }
  // blank ids: two rows equal on date, amount, payer, reference, investor_id and status cannot be told apart
  const blank = parsed.filter((l) => l.txnId === null)
  const key = (l: LedgerRow) => JSON.stringify([l.date, l.amount, l.payer, l.reference, l.investorId, l.status])
  const seen = new Map<string, number>()
  for (const l of blank) {
    const prior = seen.get(key(l))
    if (prior !== undefined) errors.push({ where: `row ${l.row}`, message: `same date, amount, payer, reference, investor_id and status as row ${prior} without a transaction_id: duplicate or two payments cannot be told apart` })
    else seen.set(key(l), l.row)
    rows.push(l)
  }
  return errors.length ? { ok: false, errors } : { ok: true, rows: rows.sort((a, b) => a.row - b.row), ignoredColumns: ignored }
}

// ---------- contacts (C-DIR-2) ----------

export const ROLES = ['investor', 'lead', 'company', 'seller', 'adviser', 'other'] as const

export interface ContactRow {
  contactId: string
  name: string
  emails: string[] // I-03 normalised
  phone: string | null
  role: (typeof ROLES)[number]
  deals: string[]
  investorIds: string[] // commitment keys `deal::investor_id`
  authorisedFor: string[] // commitment keys
  row: number
}

const commitmentKey = /^(.+)::(.+)$/

export function importContacts(text: string, versionTag: string): Imported<ContactRow> {
  const { table, errors, ignored } = readTable(text, 'contacts', null)
  const rows: ContactRow[] = []
  table.rows.forEach((r, i) => {
    const row = table.rowNumbers[i]!
    if (trimAscii(r.name ?? '') === '') errors.push({ where: `row ${row}, name`, message: 'required' })
    const emails = list(r.email).map(normAddress)
    if (emails.length === 0) errors.push({ where: `row ${row}, email`, message: 'required' })
    for (const e of emails) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) errors.push({ where: `row ${row}, email`, message: `"${e}" is not an e-mail address` })
    const role = (r.role ?? '').toLowerCase()
    if (!(ROLES as readonly string[]).includes(role)) errors.push({ where: `row ${row}, role`, message: `"${r.role ?? ''}" must be one of ${ROLES.join(', ')}` })
    const keys = (col: 'investor_id' | 'authorised_for') => {
      const v = list(r[col])
      for (const k of v) if (!commitmentKey.test(k)) errors.push({ where: `row ${row}, ${col}`, message: `"${k}" must be written as "deal name::investor_id"` })
      return v
    }
    rows.push({
      contactId: r.contact_id || rowId(versionTag, row), name: r.name ?? '', emails, phone: r.phone || null, role: role as ContactRow['role'],
      deals: list(r.deal), investorIds: keys('investor_id'), authorisedFor: keys('authorised_for'), row,
    })
  })
  uniqueIds(rows, (r) => r.contactId, (r) => r.row, 'contact_id', errors)
  return errors.length ? { ok: false, errors } : { ok: true, rows, ignoredColumns: ignored }
}
