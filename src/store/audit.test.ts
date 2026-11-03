import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './testdb.ts'
import { appendAudit, chainHead, checkHead, exportAudit, verifyAudit } from './audit.ts'
import { tx } from './db.ts'
import { verifyChain, type AuditRecord } from '../lib/audit-hash.ts'
import { runOracle } from '../lib/oracle-compare.ts'

let t: TestDb
beforeAll(async () => {
  t = await createTestDb()
}, 60_000)
afterAll(async () => t?.drop())

const write = (n: number, actor = 'system') =>
  tx(t.app, (c) => appendAudit(c, t.keyring, Array.from({ length: n }, (_, i) => ({ actor, type: 'test.event', caseId: null, payload: { i } }))))

describe('C-AUD-1 to C-AUD-4 in the database', () => {
  it('TC-AUD-01 1,000 records verify; a changed payload is reported; hashes agree with the Python oracle', async () => {
    for (let i = 0; i < 10; i++) await write(100)
    const v = await verifyAudit(t.app)
    expect(v).toMatchObject({ ok: true, count: 1000 })
    const rows: AuditRecord[] = (await t.app.query('SELECT * FROM audit ORDER BY seq LIMIT 20')).rows
    const py = runOracle(rows.map((r) => ({ fn: 'audit_hash', input: { record: { seq: r.seq, time: r.time, actor: r.actor, type: r.type, case_id: r.case_id, payload: r.payload, prev_hash: r.prev_hash } } })))
    expect(py.map((p) => (p as { hash: string }).hash)).toEqual(rows.map((r) => r.hash))
    // tamper as the owner with the trigger disabled (an attacker with full database access)
    await t.owner.query('ALTER TABLE audit DISABLE TRIGGER audit_no_update')
    await t.owner.query(`UPDATE audit SET payload = '{"i": 999}' WHERE seq = 345`)
    await t.owner.query('ALTER TABLE audit ENABLE TRIGGER audit_no_update')
    expect(await verifyAudit(t.app)).toEqual({ ok: false, badSeq: 345 })
    await t.owner.query('ALTER TABLE audit DISABLE TRIGGER audit_no_update')
    await t.owner.query(`UPDATE audit SET payload = '{"i": 44}' WHERE seq = 345`)
    await t.owner.query('ALTER TABLE audit ENABLE TRIGGER audit_no_update')
    expect(await verifyAudit(t.app)).toMatchObject({ ok: true })
  }, 60_000)

  it('TC-AUD-02 ten concurrent writers keep one unbroken chain; a snapshot older than another commit still links to the newest', async () => {
    const before = (await verifyAudit(t.app)) as { count: number }
    await Promise.all(Array.from({ length: 10 }, (_, w) => Promise.all(Array.from({ length: 10 }, () => write(3, `w${w}`)))))
    const v = await verifyAudit(t.app)
    expect(v).toMatchObject({ ok: true, count: before.count + 300 })
    // transaction A starts and reads (old snapshot) before B commits; A writes its audit after B → still linked
    const a = await t.app.connect()
    try {
      await a.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await a.query('SELECT count(*) FROM audit')
      await write(1, 'b')
      await appendAudit(a, t.keyring, [{ actor: 'a', type: 'test.late' }])
      await a.query('COMMIT')
    } finally {
      a.release()
    }
    expect(await verifyAudit(t.app)).toMatchObject({ ok: true, count: before.count + 302 })
  }, 60_000)

  it('TC-AUD-04 no role can UPDATE or DELETE audit rows', async () => {
    for (const db of [t.app, t.maintenance, t.rotation, t.owner]) {
      await expect(db.query(`UPDATE audit SET actor = 'x' WHERE seq = 1`)).rejects.toThrow()
      await expect(db.query('DELETE FROM audit WHERE seq = 1')).rejects.toThrow()
    }
    await expect(t.owner.query('TRUNCATE audit')).rejects.toThrow()
    await expect(t.rotation.query(`INSERT INTO audit (seq, time, actor, type, payload, prev_hash, hash) VALUES (99999, 'x', 'x', 'x', '{}', 'x', 'x')`)).rejects.toThrow()
  })

  it('TC-AUD-05 a rolled-back transaction leaves no gap', async () => {
    await expect(
      tx(t.app, async (c) => {
        await appendAudit(c, t.keyring, [{ actor: 'system', type: 'test.rollback' }])
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await write(1)
    const all: AuditRecord[] = (await t.app.query('SELECT * FROM audit ORDER BY seq')).rows
    expect(verifyChain(all)).toEqual({ ok: true })
    expect(all.some((r) => r.type === 'test.rollback')).toBe(false)
  })

  it('TC-AUD-07 an exported head reveals the deletion of the last three records', async () => {
    const head = (await chainHead(t.app))!
    expect(await checkHead(t.app, head)).toEqual({ ok: true })
    await t.owner.query('ALTER TABLE audit DISABLE TRIGGER audit_no_update')
    await t.owner.query('DELETE FROM audit WHERE seq > $1', [head.seq - 3])
    await t.owner.query('ALTER TABLE audit ENABLE TRIGGER audit_no_update')
    // the chain itself still verifies — only the exported head shows the cut
    expect(await verifyAudit(t.app)).toMatchObject({ ok: true })
    expect(await checkHead(t.app, head)).toEqual({ ok: false, reason: 'truncated', lastSeq: head.seq - 3 })
  })

  it('TC-AUD-08 JSON Lines export verifies offline', async () => {
    const lines: string[] = []
    const n = await exportAudit(t.app, (l) => lines.push(l))
    expect(n).toBe(lines.length)
    const recs = lines.map((l) => JSON.parse(l) as AuditRecord)
    expect(verifyChain(recs)).toEqual({ ok: true })
    const py = runOracle([{ fn: 'verify_chain', input: { records: recs } }])
    expect(py[0]).toEqual({ ok: true, bad_seq: null })
  })

  it('audit_detail keeps personal values out of the audit row', async () => {
    const [r] = await tx(t.app, (c) => appendAudit(c, t.keyring, [{ actor: 'system', type: 'test.detail', payload: { field: 'payer_name' }, detail: { before: 'Amelia Hart', after: 'A Hart' } }]))
    expect(JSON.stringify(r)).not.toContain('Amelia')
    const d = await t.app.query('SELECT * FROM audit_detail WHERE sha256 = $1', [r!.payload.detail_sha256])
    expect(d.rowCount).toBe(1)
  })
})
