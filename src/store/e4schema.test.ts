// E4 schema under the real role grants (tech design §4.1, v0.7.9): per-folder cursors, the clear-only thread link, the
// KYC continuation function, and what maintenance / rotation may not do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKit, type Kit } from '../pipeline/testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { advanceCursor } from '../pipeline/ingest.ts'
import { readCursor } from '../pipeline/catchup.ts'
import { tx } from './db.ts'
import type { StageJob } from '../pipeline/queue.ts'

let k: Kit
let caseA: string
let caseB: string

beforeAll(async () => {
  k = await createKit()
  await k.ingest(eml({ subject: 'First', messageId: '<a1@x.example>' }))
  await k.ingest(eml({ subject: 'Re: First', messageId: '<a2@x.example>', headers: [['In-Reply-To', '<a1@x.example>']] }))
  await k.drain()
  const r = await k.t.owner.query<{ id: string; previous_case_id: string | null }>('SELECT id, previous_case_id FROM "case" ORDER BY created_at')
  caseA = r.rows[0]!.id
  caseB = r.rows[1]!.id
  expect(r.rows[1]!.previous_case_id).toBe(caseA)
}, 60_000)
afterAll(() => k.close())

const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '42501' })

describe('E4 schema and grants', () => {
  it('cursors are kept per folder (PRD C-ING-6)', async () => {
    await tx(k.t.app, (c) => advanceCursor(c, k.k, 'ops', 'inbox-delta', 'f-inbox'))
    await tx(k.t.app, (c) => advanceCursor(c, k.k, 'ops', 'deals-delta', 'f-deals'))
    await tx(k.t.app, (c) => advanceCursor(c, k.k, 'ops', 'single'))
    expect(await readCursor(k, 'ops', 'f-inbox')).toBe('inbox-delta')
    expect(await readCursor(k, 'ops', 'f-deals')).toBe('deals-delta')
    expect(await readCursor(k, 'ops')).toBe('single')
  })

  it('previous_case_id can only be cleared, and only maintenance-granted columns change (C-ING-3, v0.7.18)', async () => {
    await expect(k.t.maintenance.query('UPDATE "case" SET previous_case_id = $1 WHERE id = $2', [caseB, caseA])).rejects.toThrow(/only be cleared/)
    await expect(k.t.app.query('UPDATE "case" SET previous_case_id = $1 WHERE id = $2', [caseB, caseA])).rejects.toThrow(/only be cleared/)
    await denied(k.t.maintenance.query('UPDATE "case" SET hold = true WHERE id = $1', [caseA]))
    await k.t.maintenance.query('BEGIN')
    try {
      await k.t.maintenance.query('UPDATE "case" SET previous_case_id = NULL WHERE id = $1', [caseB])
    } finally {
      await k.t.maintenance.query('ROLLBACK')
    }
  })

  it('maintenance and rotation cannot change audit rows or logical tables outside their grants', async () => {
    await expect(k.t.maintenance.query('DELETE FROM audit')).rejects.toThrow()
    await expect(k.t.maintenance.query('UPDATE audit SET actor = actor')).rejects.toThrow()
    await denied(k.t.rotation.query('UPDATE "case" SET status = status'))
    await denied(k.t.rotation.query('DELETE FROM secret_blob'))
    await denied(k.t.rotation.query('UPDATE secret_blob SET ciphertext = ciphertext'))
    await denied(k.t.app.query('DELETE FROM message'))
    await denied(k.t.app.query('DELETE FROM kyc_delivery'))
    // only the rotation role writes rotation records: the app role cannot forge a completed one (Codex E4 F10)
    await denied(k.t.app.query("INSERT INTO key_rotation (id, from_key, to_key, completed_at) VALUES (gen_random_uuid(), 'k1', 'k2', now())"))
    await denied(k.t.maintenance.query('UPDATE kyc_delivery SET attachment_id = attachment_id'))
    await denied(k.t.maintenance.query("INSERT INTO pgboss.job (name, data) VALUES ('reply', '{}')"))
    // rotation reads what it must re-check under the object lock (tech design v0.7.9)
    await k.t.rotation.query('SELECT 1 FROM file_deletion_job, file_write_intent, audit LIMIT 1')
  })

  it('enqueue_kyc_continuation: maintenance queues exactly the current generation from extract (TC-PRV-03 part)', async () => {
    await expect(k.t.maintenance.query('SELECT enqueue_kyc_continuation($1, $2)', [caseA, 99])).rejects.toThrow(/current generation/)
    const g = (await k.t.owner.query<{ g: number }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [caseA])).rows[0]!.g
    const next = (await k.t.maintenance.query<{ n: number }>('SELECT enqueue_kyc_continuation($1, $2) AS n', [caseA, g])).rows[0]!.n
    expect(next).toBe(g + 1)
    const jobs = await k.boss.boss.fetch<StageJob>('extract', { batchSize: 10 })
    expect(jobs.map((j) => j.data)).toEqual([{ caseId: caseA, generation: g + 1 }])
    // the earlier stages' results are carried over to the new generation, as a system re-run does
    const carried = await k.t.owner.query<{ stage: string }>('SELECT stage FROM stage_run WHERE case_id = $1 AND generation = $2 ORDER BY stage', [caseA, g + 1])
    expect(carried.rows.map((r) => r.stage)).toEqual(['content_signals', 'parse', 'scan'])
    await denied(k.t.maintenance.query('UPDATE "case" SET processing_generation = processing_generation + 1 WHERE id = $1', [caseA]))
    await k.boss.boss.complete('extract', jobs[0]!.id)
    await denied(k.t.rotation.query('SELECT enqueue_kyc_continuation($1, $2)', [caseA, g + 1]))
  })
})
