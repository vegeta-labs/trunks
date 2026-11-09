// PRD C-OUT-2 CSV exports and R-RTE-01 queues.
import type { ClassFloor, Level } from './risk.ts'

const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 }

/** R-RTE-01: the queue of the adopted class with the highest floor, ties by the class table order. */
export function queueFor(classes: ReadonlyArray<ClassFloor & { queue: string }>, adopted: readonly string[]): string {
  const own = classes.filter((c) => adopted.includes(c.id))
  const pool = own.some((c) => c.id !== 'unclassified') ? own.filter((c) => c.id !== 'unclassified') : own
  const best = pool.reduce<(ClassFloor & { queue: string }) | null>((b, c) => (b === null || RANK[c.risk_floor] > RANK[b.risk_floor] ? c : b), null)
  return (best ?? classes.find((c) => c.id === 'unclassified')!).queue
}

export const ACTION_COLUMNS = ['case_id', 'received_at', 'deal', 'investor_id', 'investor_name', 'action', 'details', 'amount', 'status', 'currency'] as const
export const CASE_COLUMNS = ['case_id', 'received_at', 'mailbox', 'from', 'classes', 'risk', 'queue', 'assignee', 'status', 'due_at', 'closed_at', 'outcome'] as const

/** Amounts as in the Toolkit: no thousands separator, two decimals, a minus sign when negative. */
export function csvAmount(minor: number | null): string {
  if (minor === null) return ''
  const sign = minor < 0 ? '-' : ''
  const a = Math.abs(minor)
  return `${sign}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`
}

// a text cell a spreadsheet could read as a formula gets a leading quote (amount column excepted)
const guard = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)
const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** CSV with exactly `columns`, in that order; `amountColumns` are numbers already formatted and not guarded. */
export function toCsv<C extends string>(columns: readonly C[], rows: ReadonlyArray<Readonly<Record<C, string | null>>>, amountColumns: readonly C[] = []): string {
  const line = (cells: string[]) => cells.map(quote).join(',')
  const body = rows.map((r) => line(columns.map((c) => (r[c] === null || r[c] === undefined ? '' : amountColumns.includes(c) ? r[c]! : guard(r[c]!)))))
  return [line([...columns]), ...body].join('\r\n') + '\r\n'
}

export const PAYMENT_ACTIONS = ['check_payment_in_ledger', 'request_payment_evidence', 'check_payment_evidence']
