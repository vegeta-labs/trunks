import { describe, expect, it } from 'vitest'
import { ACTION_COLUMNS, CASE_COLUMNS, csvAmount, queueFor, toCsv } from './output.ts'

describe('CSV (C-OUT-2)', () => {
  it('TC-OUT-05 columns, order, amounts and formula guard', () => {
    const row = { case_id: 'c1', received_at: '2026-10-29T10:15:00Z', deal: 'Northwind Robotics', investor_id: 'Northwind Robotics::001', investor_name: '=HYPERLINK("x")',
      action: 'check_payment_in_ledger', details: "Check Amelia's payment, today", amount: csvAmount(-1_234_56), status: 'open', currency: 'GBP' }
    const csv = toCsv(ACTION_COLUMNS, [row], ['amount'])
    expect(csv.split('\r\n')[0]).toBe('case_id,received_at,deal,investor_id,investor_name,action,details,amount,status,currency')
    expect(csv.split('\r\n')[1]).toBe(`c1,2026-10-29T10:15:00Z,Northwind Robotics,Northwind Robotics::001,"'=HYPERLINK(""x"")",check_payment_in_ledger,"Check Amelia's payment, today",-1234.56,open,GBP`)
    for (const bad of ['+1', '-x', '@SUM', '\tx', '\rx']) expect(toCsv(['a'], [{ a: bad }]).split('\r\n')[1]!.replace(/^"|"$/g, '')).toMatch(/^'/)
    expect(csvAmount(1_000_000)).toBe('10000.00')
    expect(csvAmount(5)).toBe('0.05')
    expect(csvAmount(null)).toBe('')
    expect(toCsv(CASE_COLUMNS, []).trim()).toBe('case_id,received_at,mailbox,from,classes,risk,queue,assignee,status,due_at,closed_at,outcome')
  })
})

describe('queues (R-RTE-01)', () => {
  const classes = [
    { id: 'commitment_change', risk_floor: 'medium' as const, queue: 'ops' },
    { id: 'closing_confirmation', risk_floor: 'medium' as const, queue: 'deal_ops' },
    { id: 'bank_details', risk_floor: 'high' as const, queue: 'compliance' },
    { id: 'unclassified', risk_floor: 'medium' as const, queue: 'ops' },
  ]
  it('TC-RTE-08 the highest floor, then the table order', () => {
    expect(queueFor(classes, ['closing_confirmation', 'commitment_change'])).toBe('ops')
    expect(queueFor(classes, ['closing_confirmation', 'bank_details'])).toBe('compliance')
    expect(queueFor(classes, ['unclassified'])).toBe('ops')
    expect(queueFor(classes, ['closing_confirmation'])).toBe('deal_ops')
  })
})
