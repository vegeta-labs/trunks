import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { applyClear, importBank, importCommitments, importContacts, importDeals, importLedger } from './directory.ts'

const ok = <T>(r: { ok: true; rows: T[] } | { ok: false; errors: unknown[] }) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.rows
}
const errs = (r: { ok: boolean; errors?: Array<{ where: string; message: string }> }) => (r.ok ? [] : r.errors!.map((e) => `${e.where}: ${e.message}`))

describe('C-DIR directory imports', () => {
  it('TC-DIR-09 a file with a header and no data rows is refused, for every kind (PRD R-DIR-04 v0.7.24)', () => {
    const empty = 'no data rows: the list would become empty (nothing was imported)'
    const cases: Array<[string, () => { ok: boolean; errors?: Array<{ where: string; message: string }> }]> = [
      ['deals', () => importDeals('name,currency\n', ['GBP'])],
      ['contacts', () => importContacts('contact_id,name,email,phone,role,deal,investor_id,authorised_for\r\n\r\n', 'v1')],
      ['commitments', () => importCommitments('investor_id,name,email,reference,cash_due,scheme', 'GBP', 'v1')],
      ['bank', () => importBank('transaction_id,date,amount,payer,reference\n\n  \n', 'GBP', 'v1')],
      ['ledger', () => importLedger('transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency\n', 'GBP')],
    ]
    for (const [kind, run] of cases) expect(errs(run()), kind).toContain(`file: ${empty}`)
    // one data row is enough
    expect(errs(importDeals('name,currency\nNorthwind Robotics,GBP\n', ['GBP']))).toEqual([])
    // clearing is explicit: header only + clear → an empty list; clear with data rows, or with another error → refused
    expect(applyClear(importDeals('name,currency\n', ['GBP']), true)).toEqual({ ok: true, rows: [], ignoredColumns: [] })
    expect(errs(applyClear(importDeals('name,currency\nNorthwind Robotics,GBP\n', ['GBP']), true))).toEqual(['file: clear=yes needs a file with the header only (it has data rows)'])
    expect(applyClear(importDeals('name\n', ['GBP']), true).ok).toBe(false) // header-only but missing a required column
    expect(applyClear(importDeals('name,currency\n', ['GBP']), false).ok).toBe(false)
  })
  it('TC-DIR-01 the Goten sample commitments and bank lines import with the same amounts', () => {
    const c = ok(importCommitments(readFileSync('fixtures/goten/commitments.csv', 'utf8'), 'GBP', 'v1'))
    expect(c.map((r) => [r.investorId, r.name, r.reference, r.cashDue, r.scheme])).toEqual([
      ['c01', 'Amelia Hart', 'NW-001', 1000000, 'SEIS'],
      ['v1-r3', 'Ben Okafor', 'NW-002', 500000, 'EIS'],
      ['c03', 'Chloe Martin', 'NW-003', 2000000, 'NONE'],
      ['v1-r5', 'David Kim', 'NW 004', 250000, 'SEIS'],
    ])
    const b = ok(importBank(readFileSync('fixtures/goten/bank.csv', 'utf8'), 'GBP', 'v1'))
    expect(b.map((r) => [r.txnId, r.date, r.amount])).toEqual([
      ['T1', '2026-10-06', 1000000], ['T2', '2026-10-06', 500000], ['T3', '2026-10-07', 0], ['T4', '2026-10-07', -4500], ['T5', '2026-10-08', 200000],
    ])
  })
  it('TC-DIR-02 currency annotations and the currency column', () => {
    const csv = 'transaction_id,date,Amount (£),payer\nT1,2026-10-06,10.00,X\n'
    expect(ok(importBank(csv, 'GBP', 'v'))[0]!.amount).toBe(1000)
    expect(errs(importBank(csv, 'EUR', 'v'))).toContain('header: column "Amount (£)" is in GBP but this deal is in EUR')
    expect(errs(importBank('date,amount,currency\n2026-10-06,5,GBP\n2026-10-06,5,EUR\n', 'GBP', 'v'))).toEqual(['row 3, currency: "EUR" but this deal is in GBP'])
    // a ledger row in another currency is imported with its currency and not counted later (PRD C-DRF-6)
    const led = importLedger('transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency\nT1,2026-10-27,8000.00,M,NW-011,auto,011,M,system,,EUR\nT2,2026-10-27,5.00,M,NW-011,auto,011,M,system,,\n', 'GBP')
    expect(errs(led)).toEqual([])
    expect(led.ok && led.rows.map((r) => [r.txnId, r.currency, r.amount])).toEqual([['T1', 'EUR', 800000], ['T2', 'GBP', 500]])
    expect(ok(importBank('date,amount,ccy\n2026-10-06,5,gbp\n', 'GBP', 'v'))).toHaveLength(1)
    expect(ok(importCommitments('name,reference,cash due gbp\nA,R1,5\n', 'GBP', 'v'))[0]!.cashDue).toBe(500)
    expect(errs(importCommitments('name,reference,committed\nA,R1,5\n', 'GBP', 'v'))).toContain('header: missing required column "cash_due"')
  })
  it('TC-DIR-03 contacts: role, several e-mails, authorised_for', () => {
    expect(errs(importContacts('name,email,role\nA,a@x.example,boss\n', 'v'))).toEqual(['row 2, role: "boss" must be one of investor, lead, company, seller, adviser, other'])
    const [c] = ok(importContacts('contact_id,name,email,role,deal,investor_id,authorised_for\nC1,Amelia Hart,Amelia@HartFamily.example; a.hart@work.example,investor,Northwind Robotics,Northwind Robotics::c01,Northwind Robotics::c02;Other Deal::007\n', 'v'))
    expect(c!.emails).toEqual(['amelia@hartfamily.example', 'a.hart@work.example'])
    expect(c!.authorisedFor).toEqual(['Northwind Robotics::c02', 'Other Deal::007'])
    expect(c!.deals).toEqual(['Northwind Robotics'])
  })
  it('TC-DIR-10 receiving accounts: optional, several, not only IBANs; a bad check digit is an error', () => {
    const header = 'name,currency,receiving_accounts\n'
    expect(ok(importDeals(`${header}A,GBP,\n`, ['GBP']))[0]!.receivingAccounts).toEqual([])
    expect(ok(importDeals(`${header}A,GBP,GB82 WEST 1234 5698 7654 32; 12-34-56 12345678;\n`, ['GBP']))[0]!.receivingAccounts).toEqual(['GB82WEST12345698765432', '123456' + '12345678'])
    expect(errs(importDeals(`${header}A,GBP,GB82WEST12345698765431\n`, ['GBP']))).toEqual(['row 2, receiving_accounts: an IBAN with invalid check digits'])
    expect(ok(importDeals('name,currency\nA,GBP\n', ['GBP']))[0]!.receivingAccounts).toEqual([])
  })
  it('TC-DIR-05 deals: currency must be configured', () => {
    expect(ok(importDeals('name,currency,close_date\nNorthwind Robotics,GBP,2026-11-02\n', ['GBP', 'EUR', 'USD']))).toEqual([{ name: 'Northwind Robotics', currency: 'GBP', receivingAccounts: [], closeDate: '2026-11-02', referencePrefix: null, row: 2 }])
    expect(errs(importDeals('name,currency\nX,CHF\n', ['GBP', 'EUR', 'USD']))).toEqual(['row 2, currency: "CHF" is not one of GBP, EUR, USD'])
    // the evaluation directory's header (eval/directory/deals.csv): before E3 the close date was silently dropped
    expect(ok(importDeals('deal_id,name,currency,planned_close_date,reference_prefix\nD1,Northwind Robotics,GBP,2026-11-20,NW\n', ['GBP']))[0]).toMatchObject({ closeDate: '2026-11-20', referencePrefix: 'NW' })
  })
  it('TC-DIR-06 stable generated ids; duplicate ids are errors with the row', () => {
    const a = ok(importContacts('name,email,role\nA,a@x.example,investor\nB,b@x.example,lead\n', 'ver7'))
    expect(a.map((r) => r.contactId)).toEqual(['ver7-r2', 'ver7-r3'])
    expect(ok(importContacts('name,email,role\nA,a@x.example,investor\nB,b@x.example,lead\n', 'ver7')).map((r) => r.contactId)).toEqual(['ver7-r2', 'ver7-r3'])
    expect(errs(importContacts('contact_id,name,email,role\nC1,A,a@x.example,investor\nC1,B,b@x.example,lead\n', 'v'))).toEqual(['row 3, contact_id: "C1" also used on row 2'])
    expect(errs(importCommitments('investor_id,name,reference,cash_due\nc1,A,R1,1\nc1,B,R2,1\n', 'GBP', 'v'))).toEqual(['row 3, investor_id: "c1" also used on row 2'])
  })
  it('TC-DIR-07 ledger: one row per transaction id, blank-id duplicates, negatives', () => {
    const H = 'transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency\n'
    const row = (id: string, amount = '100.00', payer = 'A HART', status = 'auto') => `${id},2026-10-06,${amount},${payer},NW-001,${status},c01,Amelia Hart,auto,,GBP\n`
    expect(errs(importLedger(H + row('T1') + row('T1', '200.00'), 'GBP'))).toEqual(['row 3, transaction_id: "T1" also on row 2 with different values'])
    expect(errs(importLedger(H + row('T1') + row('T1', '100.00', 'A. HART'), 'GBP'))).toHaveLength(1)
    expect(ok(importLedger(H + row('T1') + row('T1'), 'GBP'))).toHaveLength(1)
    expect(errs(importLedger(H + row('') + row(''), 'GBP'))).toEqual(['row 3: same date, amount, payer, reference, investor_id and status as row 2 without a transaction_id: duplicate or two payments cannot be told apart'])
    expect(ok(importLedger(H + row('') + row('', '50.00'), 'GBP'))).toHaveLength(2)
    expect(errs(importLedger(H + row('T1', '-5.00'), 'GBP'))).toEqual(['row 2, amount: cannot be negative (reverse it in Goten and export again)'])
    const noId = ok(importLedger('date,amount,payer,reference,status,investor_id\n2026-10-06,1,X,R,auto,c01\n', 'GBP'))
    expect(noId[0]!.txnId).toBeNull()
  })
  it('TC-DIR-08 investor_id must be a commitment key', () => {
    expect(errs(importContacts('name,email,role,investor_id\nA,a@x.example,investor,001\n', 'v'))).toEqual(['row 2, investor_id: "001" must be written as "deal name::investor_id"'])
    expect(ok(importContacts('name,email,role,investor_id\nA,a@x.example,investor,Northwind Robotics::001\n', 'v'))[0]!.investorIds).toEqual(['Northwind Robotics::001'])
  })
})
