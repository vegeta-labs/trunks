import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKit, FakeLlm, type Kit } from './testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { runStage, stageResult, type FieldsResult } from './stages.ts'
import { getBlobs } from '../store/blobs.ts'
import { loadSnapshot } from '../store/directory.ts'

let k: Kit
const llm = new FakeLlm()
const U1 = 'eb6305c9-1f7f-49de-aed0-16487c27b42d'
const U2 = '0f3c9a2e-5b1d-4c8e-9a7f-2d6e8b1c4a90'
beforeAll(async () => {
  k = await createKit({ llm })
  await k.importCsv('deals', 'name,currency,close_date\nNorthwind Robotics,GBP,2026-11-02\nAmelia Hart SPV,GBP,\n')
  await k.importCsv('commitments', 'investor_id,name,email,reference,cash_due\nc01,Amelia Hart,amelia@hartfamily.example,NW-001,"10,000.00"\n', 'Northwind Robotics')
  await k.importCsv('contacts', 'contact_id,name,email,phone,role,deal,investor_id\nC001,Amelia Hart,amelia@hartfamily.example,+44 7700 900123,investor,Northwind Robotics,Northwind Robotics::c01\n')
}, 60_000)
afterAll(async () => k?.close())

const caseOf = (r: unknown) => (r as { caseId: string }).caseId
const fieldRows = async (id: string) =>
  Object.fromEntries((await k.db.query('SELECT field, status, source, needs_confirmation, value_blob FROM case_field WHERE case_id = $1', [id])).rows.map((r) => [r.field, r]))
const valueOf = async (blob: string | null) => (blob ? JSON.parse((await getBlobs(k.db, k.k, [blob])).get(blob)!.toString('utf8')) : null)

describe('fields stage (C-FLD)', () => {
  it('a payment mail: rule values merged, a different model UETR is a conflict (TC-FLD-01), the reference is the imported one', async () => {
    llm.reply = (v, user) => {
      if (v.startsWith('classify')) return '{"labels":[{"class":"payment_query","confidence":"high","reason":"paid"}],"language":"en"}'
      expect(user).toContain('£10,000.00')
      return JSON.stringify({ fields: {
        amount: { value: '£10,000.00', confidence: 'high', quote: '£10,000.00' },
        payment_date: { value: '23 Oct 2026', confidence: 'high', quote: '23 Oct 2026' },
        reference: { value: 'nw 001', confidence: 'high', quote: 'ref nw 001' },
        uetr: { value: U2, confidence: 'medium', quote: 'UETR' },
        payer_name: { value: '[NAME_1] [NAME_2]', confidence: 'high', quote: '[NAME_1] [NAME_2]' },
      } })
    }
    const id = caseOf(await k.ingest(eml({ from: 'Amelia Hart <amelia@hartfamily.example>', subject: 'Paid', text: `Hi, I paid £10,000.00 on 23 Oct 2026, ref nw 001. UETR ${U1}.\nAmelia Hart` })))
    await k.drain()
    const res = (await stageResult<FieldsResult>(k.db, k.k, id, 'fields'))!
    const by = Object.fromEntries(res.fields.map((f) => [f.field, f]))
    expect(by.amount).toMatchObject({ status: 'ok', value: { minor: 1000000, currency: 'GBP' } })
    expect(by.currency).toMatchObject({ value: 'GBP' })
    expect(by.payment_date).toMatchObject({ value: '2026-10-23' })
    expect(by.reference).toMatchObject({ value: 'NW-001' })
    expect(by.uetr).toMatchObject({ status: 'conflict', value: U1, needsConfirmation: true })
    const rows = await fieldRows(id)
    expect(rows.uetr).toMatchObject({ status: 'conflict', needs_confirmation: true })
    expect(await valueOf(rows.amount.value_blob)).toEqual({ value: { minor: 1000000, currency: 'GBP' } })
  }, 60_000)

  it('TC-FLD-08 a deal written with name placeholders is checked after in-memory restoring; the database keeps the deal ID only', async () => {
    llm.reply = (v) =>
      v.startsWith('classify')
        ? '{"labels":[{"class":"exit_distribution","confidence":"high","reason":"exit"}],"language":"en"}'
        : JSON.stringify({ fields: { deal: { value: '[NAME_1] [NAME_2] SPV', confidence: 'high', quote: '[NAME_1] [NAME_2] SPV' }, question_type: { value: 'timing', confidence: 'high', quote: 'When' } } })
    const id = caseOf(await k.ingest(eml({ subject: 'Exit', text: 'When will the Amelia Hart SPV distribute the proceeds?' })))
    await k.drain()
    const rows = await fieldRows(id)
    const deal = await valueOf(rows.deal.value_blob)
    expect(rows.deal.status).toBe('ok')
    const snapshot = (await k.db.query('SELECT snapshot_id FROM "case" WHERE id = $1', [id])).rows[0].snapshot_id
    const dir = await loadSnapshot(k.db, k.k, snapshot)
    expect(deal.value).toBe(dir.deals.find((x) => x.name === 'Amelia Hart SPV')!.dealKey) // the directory's key, not the name
    // nothing restored is stored anywhere in the Case's fields
    for (const r of Object.values(rows)) expect(JSON.stringify(await valueOf((r as { value_blob: string | null }).value_blob))).not.toContain('Amelia')
    expect(rows.question_type.status).toBe('ok')
  }, 60_000)

  it('TC-FLD-07 (fields) a retried step reuses the saved model reply', async () => {
    let calls = 0
    llm.reply = (v) => {
      if (v.startsWith('classify')) return '{"labels":[{"class":"withdrawal","confidence":"high","reason":"x"}],"language":"en"}'
      calls++
      return '{"fields":{"investor":{"value":"[NAME_1] [NAME_2]","confidence":"high","quote":"[NAME_1] [NAME_2]"}}}'
    }
    const id = caseOf(await k.ingest(eml({ subject: 'Withdrawal', text: 'Amelia Hart wants to withdraw from the deal' })))
    await k.drain()
    expect(calls).toBe(1)
    await k.t.owner.query(`DELETE FROM stage_run WHERE case_id = $1 AND stage = 'fields'`, [id])
    await k.t.owner.query('DELETE FROM case_field WHERE case_id = $1', [id])
    expect(await runStage(k, 'fields', { caseId: id, generation: 1 })).toBe('published')
    expect(calls).toBe(1)
    expect((await fieldRows(id)).investor.status).toBe('ok')
  }, 60_000)
})
