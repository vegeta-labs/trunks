import { describe, expect, it } from 'vitest'
import { ledgerState, link, mayDisclose, type Dir, type DirContact, type LinkInput } from './link.ts'

const NW = 'k-nw'
const LK = 'k-lk'
const contact = (o: Partial<DirContact> & { contactId: string; emails: string[] }): DirContact => ({ role: 'investor', deals: [], investorIds: [], authorisedFor: [], ...o })
const dir = (o: Partial<Dir> = {}): Dir => ({
  deals: [
    { dealKey: NW, name: 'Northwind Robotics', currency: 'GBP', closeDate: '2026-11-20' },
    { dealKey: LK, name: 'Larkspur Energy Storage', currency: 'USD', closeDate: null },
  ],
  contacts: [
    contact({ contactId: 'C001', emails: ['amelia@hartfamily.example'], deals: ['Northwind Robotics'], investorIds: ['Northwind Robotics::001'] }),
    contact({ contactId: 'C002', emails: ['oliver@bennett.example'], deals: ['Northwind Robotics', 'Larkspur Energy Storage'], investorIds: ['Northwind Robotics::002', 'Larkspur Energy Storage::001'] }),
    contact({ contactId: 'C003', emails: ['shared@family.example'], deals: ['Northwind Robotics'], investorIds: ['Northwind Robotics::003'] }),
    contact({ contactId: 'C004', emails: ['other@x.example', 'shared@family.example'], deals: ['Northwind Robotics'] }),
    contact({ contactId: 'C005', role: 'lead', emails: ['lead@ramsay.example'], deals: ['Northwind Robotics', 'Larkspur Energy Storage'] }),
    contact({ contactId: 'C006', emails: ['two@same.example'], deals: ['Northwind Robotics'], investorIds: ['Northwind Robotics::004', 'Northwind Robotics::005'] }),
    contact({ contactId: 'C007', emails: ['ghost@x.example'], deals: ['Northwind Robotics'], investorIds: ['Northwind Robotics::099', 'Northwind Robotics::005'] }),
  ],
  commitments: ['001', '002', '003', '004', '005'].map((id) => ({ dealKey: NW, investorId: id, keyHmac: `h-nw-${id}`, name: `Investor ${id}`, reference: `NW-${id}`, cashDue: 1_000_000 })).concat([
    { dealKey: LK, investorId: '001', keyHmac: 'h-lk-001', name: 'Investor L1', reference: 'LK-001', cashDue: 500_000 },
  ]),
  bankLines: [
    { dealKey: NW, transactionId: 'T1', date: '2026-10-28', amount: 1_000_000, reference: 'FASTER PAYMENT' },
    { dealKey: NW, transactionId: 'T2', date: '2026-10-17', amount: 1_000_000, reference: 'payment' },
    { dealKey: NW, transactionId: 'T3', date: '2026-10-01', amount: 250_000, reference: 'NW 001 balance' },
    { dealKey: LK, transactionId: 'T4', date: '2026-10-23', amount: 1_000_000, reference: null },
  ],
  ledger: [{ dealKey: NW, transactionId: 'T1', status: 'unmatched', commitmentKeyHmac: null, currency: 'GBP', amount: 1_000_000 }],
  ledgerDeals: [NW],
  ...o,
})
const at = (o: Partial<LinkInput>) => link(dir(), { fromAddress: null, references: [], deal: null, amounts: [], paymentDate: null, ...o })

describe('linking (C-LNK-1, 2, 4, 6)', () => {
  it('TC-LNK-01 one contact by address (case-insensitive) → linked; shared address → candidates', () => {
    expect(at({ fromAddress: 'Amelia@HartFamily.example' }).contact).toEqual({ id: 'C001', candidates: [] })
    expect(at({ fromAddress: 'shared@family.example' }).contact).toEqual({ id: null, candidates: ['C003', 'C004'] })
    expect(at({ fromAddress: 'nobody@x.example' }).contact).toEqual({ id: null, candidates: [] })
  })
  it('TC-LNK-02 reference, then the sender’s commitment keys in the snapshot (v0.7.12)', () => {
    expect(at({ references: ['NW-002'] }).commitment).toEqual({ key: 'Northwind Robotics::002', candidates: [], by: 'reference' })
    expect(at({ fromAddress: 'amelia@hartfamily.example' }).commitment).toEqual({ key: 'Northwind Robotics::001', candidates: [], by: 'sender' })
    expect(at({ fromAddress: 'oliver@bennett.example' }).commitment).toEqual({ key: null, candidates: ['Northwind Robotics::002', 'Larkspur Energy Storage::001'], by: null })
    expect(at({ fromAddress: 'two@same.example' }).commitment.candidates).toEqual(['Northwind Robotics::004', 'Northwind Robotics::005']) // same deal, two keys
    expect(at({ fromAddress: 'ghost@x.example' }).commitment).toEqual({ key: 'Northwind Robotics::005', candidates: [], by: 'sender' }) // 099 not in the snapshot
    expect(link(dir({ commitments: [] }), { fromAddress: 'amelia@hartfamily.example', references: [], deal: null, amounts: [], paymentDate: null }).commitment).toEqual({ key: null, candidates: [], by: null })
    expect(at({ references: ['NW-001', 'NW-002'], fromAddress: 'amelia@hartfamily.example' }).commitment.key).toBe('Northwind Robotics::001') // two references → by sender
    expect(at({ references: ['NW-001', 'NW-003'], fromAddress: 'oliver@bennett.example' }).commitment).toMatchObject({ key: null, by: null }) // not the first reference
  })
  it('TC-LNK-03 bank lines: amount within ±5 days, or the reference; listed only', () => {
    const d = dir()
    const before = JSON.stringify(d)
    const amt = [{ minor: 1_000_000, currency: 'GBP' }]
    const r = link(d, { fromAddress: 'amelia@hartfamily.example', references: [], deal: null, amounts: amt, paymentDate: '2026-10-23' })
    expect(r.bankLines).toEqual([{ transactionId: 'T1', ledgerStatus: 'unmatched' }, { transactionId: 'T3', ledgerStatus: null }]) // T1 5 days; T2 6 days; T3 by reference
    expect(link(d, { fromAddress: 'amelia@hartfamily.example', references: [], deal: null, amounts: [], paymentDate: '2026-10-23' }).bankLines.map((x) => x.transactionId)).toEqual(['T3'])
    expect(link(d, { fromAddress: 'amelia@hartfamily.example', references: [], deal: null, amounts: amt, paymentDate: null }).bankLines.map((x) => x.transactionId)).toEqual(['T3'])
    expect(link(d, { fromAddress: 'amelia@hartfamily.example', references: [], deal: null, amounts: [{ minor: 1_000_000, currency: 'EUR' }], paymentDate: '2026-10-23' }).bankLines.map((x) => x.transactionId)).toEqual(['T3'])
    expect(JSON.stringify(d)).toBe(before) // nothing changed
  })
  it('TC-LNK-08 deal selection (C-LNK-6)', () => {
    expect(at({ references: ['NW-001'] }).deal).toEqual({ name: 'Northwind Robotics', candidates: [], conflict: false })
    expect(at({ fromAddress: 'lead@ramsay.example', deal: 'Larkspur Energy Storage' }).deal).toEqual({ name: 'Larkspur Energy Storage', candidates: [], conflict: false })
    expect(at({ fromAddress: 'amelia@hartfamily.example', references: ['NW-001'], deal: 'Larkspur Energy Storage' }).deal).toEqual({ name: 'Northwind Robotics', candidates: [], conflict: true })
    expect(at({ fromAddress: 'lead@ramsay.example' }).deal).toEqual({ name: null, candidates: ['Northwind Robotics', 'Larkspur Energy Storage'], conflict: false })
    expect(at({ fromAddress: 'shared@family.example', deal: 'Larkspur Energy Storage' }).deal.name).toBe(null) // not in the sender's deals
    expect(at({ fromAddress: 'nobody@x.example', deal: 'Larkspur Energy Storage' }).deal.name).toBe('Larkspur Energy Storage') // sender not in the directory
    expect(at({ fromAddress: 'nobody@x.example', deal: 'Unknown Deal' }).deal.name).toBe(null)
    expect(at({ fromAddress: 'other@x.example' }).deal.name).toBe('Northwind Robotics') // one deal
  })
})

describe('who may be told (C-LNK-5) and the ledger state (C-DRF-6)', () => {
  const c1 = { investorIds: ['Northwind Robotics::001'], authorisedFor: [] }
  it('TC-LNK-05 / TC-LNK-09 who may be told', () => {
    expect(mayDisclose(true, 'Northwind Robotics::001', c1)).toBe(true)
    expect(mayDisclose(false, 'Northwind Robotics::001', c1)).toBe(false) // auth unknown
    expect(mayDisclose(true, 'Northwind Robotics::002', c1)).toBe(false) // another investor's reference
    expect(mayDisclose(true, 'Northwind Robotics::002', { investorIds: [], authorisedFor: ['Northwind Robotics::002'] })).toBe(true)
    expect(mayDisclose(true, 'Larkspur Energy Storage::001', c1)).toBe(false) // same bare id, other deal
    const two = { investorIds: ['Northwind Robotics::002', 'Larkspur Energy Storage::001'], authorisedFor: [] }
    expect(mayDisclose(true, 'Northwind Robotics::002', two) && mayDisclose(true, 'Larkspur Energy Storage::001', two)).toBe(true)
    expect(mayDisclose(true, null, c1)).toBe(false)
  })
  it('TC-DRF-15 only auto / confirmed rows of that commitment, deal and currency', () => {
    const row = (status: string, amount: number, o: Partial<Dir['ledger'][number]> = {}) => ({ dealKey: NW, transactionId: null, status, commitmentKeyHmac: 'h-nw-001', currency: 'GBP', amount, ...o })
    const st = (ledger: Dir['ledger']) => ledgerState(dir({ ledger }), 'Northwind Robotics::001')
    expect(st([row('auto', 600_000), row('confirmed', 400_000)])).toEqual({ state: 'received', received: 1_000_000, due: 1_000_000 }) // exactly the amount due
    expect(st([row('auto', 600_000), row('rejected', 400_000), row('unmatched', 400_000)])?.state).toBe('not_received')
    expect(st([row('auto', 600_000), row('auto', 400_000, { currency: 'EUR' })])?.state).toBe('not_received')
    expect(st([row('auto', 600_000), row('auto', 400_000, { dealKey: LK })])?.state).toBe('not_received')
    expect(ledgerState(dir(), 'Larkspur Energy Storage::001')?.state).toBe('unknown') // no ledger for that deal in the snapshot
    expect(ledgerState(dir(), 'Nope::1')).toBe(null)
  })
})
