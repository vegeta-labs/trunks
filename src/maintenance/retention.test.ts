// TC-PRV-02 (PRD C-PRV-1 v0.7.18, tech design §4.1 / v0.7.9): retention under the real maintenance grants and foreign
// keys; files removed after the commit and again after a crash; holds (also over the earlier Cases of a thread);
// thread links cleared; directory versions and snapshots; mailbox credentials kept. Plus TC-ING-20's second half.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createKit, type Kit } from '../pipeline/testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { makePdf } from '../../parser/testfiles.ts'
import { verifyAudit } from '../store/audit.ts'
import { putBlob } from '../store/blobs.ts'
import { tx } from '../store/db.ts'
import { blobColumns, deleteMessage, runDirectoryRetention, runFileDeletions, runMessageRetention, sweepOrphanBlobs, type RetentionDeps } from './retention.ts'

let k: Kit
let d: RetentionDeps
const DAY = 86_400_000
const settings = { messages_days: 30, directory_days: 30 } as const
const caseOf = (r: unknown) => (r as { caseId: string }).caseId

async function msgOf(caseId: string): Promise<string> {
  return (await k.t.owner.query<{ m: string }>('SELECT message_id AS m FROM "case" WHERE id = $1', [caseId])).rows[0]!.m
}
async function filesOf(messageId: string): Promise<string[]> {
  const r = await k.t.owner.query<{ key: string }>('SELECT file_ref AS key FROM message_file WHERE message_id = $1 UNION SELECT file_ref FROM attachment WHERE message_id = $1 AND file_ref IS NOT NULL', [messageId])
  return r.rows.map((x) => x.key)
}
/** Every row anywhere that belongs to the message or its Case, by table. */
async function leftovers(messageId: string, caseId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const tables = await k.t.owner.query<{ t: string; c: string }>(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('case_id', 'message_id') AND table_name NOT IN ('audit')`,
  )
  for (const { t, c } of tables.rows) {
    const id = c === 'case_id' ? caseId : messageId
    const n = (await k.t.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}" WHERE ${c} = $1`, [id])).rows[0]!.n
    if (n) out[t] = n
  }
  for (const [t, where, id] of [['case', 'id', caseId], ['message', 'id', messageId]] as const) {
    const n = (await k.t.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}" WHERE ${where} = $1`, [id])).rows[0]!.n
    if (n) out[t] = n
  }
  return out
}
async function blobsOf(messageId: string, caseId: string): Promise<string[]> {
  const ids: string[] = []
  for (const { tbl, col } of await blobColumns(k.t.owner)) {
    const cols = await k.t.owner.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1 AND column_name IN ('case_id', 'message_id', 'id', 'attachment_id')`, [tbl])
    const names = cols.rows.map((x) => x.c)
    let where: string | null = null
    if (tbl === 'case') where = 'id = $1'
    else if (tbl === 'message') where = 'id = $2'
    else if (tbl === 'attachment_text') where = 'attachment_id IN (SELECT id FROM attachment WHERE message_id = $2)'
    else if (names.includes('case_id')) where = 'case_id = $1'
    else if (names.includes('message_id')) where = 'message_id = $2'
    if (!where) continue
    const r = await k.t.owner.query<{ b: string }>(`SELECT "${col}"::text AS b FROM "${tbl}" WHERE ${where.replace('$1', '$1::uuid').replace('$2', '$2::uuid')} AND "${col}" IS NOT NULL AND $1::uuid IS NOT NULL AND $2::uuid IS NOT NULL`, [caseId, messageId])
    ids.push(...r.rows.map((x) => x.b))
  }
  return ids
}
const later = (days: number) => new Date(Date.parse('2026-10-29T10:15:00.000Z') + days * DAY)

beforeAll(async () => {
  k = await createKit()
  d = { db: k.t.maintenance, k: k.k, files: k.files }
}, 60_000)
afterAll(() => k.close())

describe('TC-PRV-02 retention', () => {
  it('TC-PRV-02 deletes every row, blob and file of an expired message in order; audit rows stay and verify; a crash after the commit is finished by file_deletion_job', async () => {
    const pdf = makePdf(['Invoice 1042 total GBP 1,200.00'])
    const c1 = caseOf(await k.ingest(eml({ subject: 'Invoice', messageId: '<r1@x.example>', text: 'Invoice attached', attachments: [{ type: 'application/pdf', filename: 'invoice.pdf', content: pdf }] }), '2026-08-01T09:00:00.000Z'))
    // TC-ING-20: a second message with the same attachment keeps its own object
    const c2 = caseOf(await k.ingest(eml({ subject: 'Invoice again', messageId: '<r2@x.example>', text: 'Same invoice', attachments: [{ type: 'application/pdf', filename: 'invoice.pdf', content: pdf }] }), '2026-10-28T09:00:00.000Z'))
    await k.drain()
    const m1 = await msgOf(c1)
    const m2 = await msgOf(c2)
    const files1 = await filesOf(m1)
    const files2 = await filesOf(m2)
    expect(files1.length).toBe(2)
    const blobs = await blobsOf(m1, c1)
    expect(blobs.length).toBeGreaterThan(5)
    const auditBefore = (await k.t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM audit')).rows[0]!.n

    const r = await runMessageRetention(d, settings, later(0))
    expect(r.deleted).toBe(1) // m1 (received 2026-08-01); m2 is still inside 30 days
    expect(await leftovers(m1, c1)).toEqual({})
    const still = await k.t.owner.query('SELECT 1 FROM secret_blob WHERE id = ANY ($1::uuid[])', [blobs])
    expect(still.rowCount).toBe(0)
    // crash between commit and file deletion: the files are still there, the jobs remember them
    for (const f of files1) expect(await k.files.exists(f)).toBe(true)
    expect((await k.t.owner.query('SELECT 1 FROM file_deletion_job')).rowCount).toBe(2)
    // «restart»
    expect(await runFileDeletions(d)).toEqual({ done: 2, failed: 0 })
    for (const f of files1) expect(await k.files.exists(f)).toBe(false)
    for (const f of files2) expect(await k.files.exists(f)).toBe(true)
    expect((await k.t.owner.query('SELECT 1 FROM file_deletion_job')).rowCount).toBe(0)
    // audit rows are kept, one more for the deletion, and the chain still verifies
    const audit = await k.t.owner.query<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM audit WHERE seq > $1', [auditBefore])
    expect(audit.rows.map((x) => x.type)).toEqual(['retention.deleted'])
    expect(JSON.stringify(audit.rows[0]!.payload)).not.toMatch(/Invoice|invoice/)
    expect((await verifyAudit(k.t.app)).ok).toBe(true)
  })

  it('TC-PRV-02 a failed file deletion stays queued and is tried again later', async () => {
    const c = caseOf(await k.ingest(eml({ subject: 'Old', messageId: '<r3@x.example>' }), '2026-07-01T09:00:00.000Z'))
    await k.drain()
    await runMessageRetention(d, settings, later(0))
    expect((await k.t.owner.query('SELECT 1 FROM "case" WHERE id = $1', [c])).rowCount).toBe(0)
    const broken: RetentionDeps = { ...d, files: { ...k.files, deleteAllVersions: async () => { throw new Error('storage down') } } as never }
    const now = new Date()
    expect(await runFileDeletions(broken, now)).toEqual({ done: 0, failed: 1 })
    const job = (await k.t.owner.query<{ attempts: number; last_error: string; next_attempt_at: Date }>('SELECT attempts, last_error, next_attempt_at FROM file_deletion_job')).rows[0]!
    expect(job).toMatchObject({ attempts: 1, last_error: 'delete_failed' })
    expect(await runFileDeletions(d, now)).toEqual({ done: 0, failed: 0 }) // not due yet
    expect(await runFileDeletions(d, new Date(job.next_attempt_at.getTime() + 1))).toEqual({ done: 1, failed: 0 })
  })

  it('TC-PRV-02 threads: the earlier message expires first → deleted, the later Case loses its link with an audit row; a hold on the later Case keeps the earlier one', async () => {
    const a = caseOf(await k.ingest(eml({ subject: 'Thread A', messageId: '<ta@x.example>' }), '2026-07-02T09:00:00.000Z'))
    const b = caseOf(await k.ingest(eml({ subject: 'Re: Thread A', messageId: '<tb@x.example>', headers: [['In-Reply-To', '<ta@x.example>']] }), '2026-10-27T09:00:00.000Z'))
    const x = caseOf(await k.ingest(eml({ subject: 'Thread X', messageId: '<tx@x.example>' }), '2026-07-03T09:00:00.000Z'))
    const y = caseOf(await k.ingest(eml({ subject: 'Re: Thread X', messageId: '<ty@x.example>', headers: [['In-Reply-To', '<tx@x.example>']] }), '2026-10-27T10:00:00.000Z'))
    const z = caseOf(await k.ingest(eml({ subject: 'Re: Re: Thread X', messageId: '<tz@x.example>', headers: [['In-Reply-To', '<ty@x.example>']] }), '2026-10-27T11:00:00.000Z'))
    await k.drain()
    expect((await k.t.owner.query<{ p: string }>('SELECT previous_case_id AS p FROM "case" WHERE id = $1', [b])).rows[0]!.p).toBe(a)
    await k.t.owner.query('UPDATE "case" SET hold = true WHERE id = $1', [z]) // the newest Case of thread X
    await runMessageRetention(d, settings, later(0))
    expect((await k.t.owner.query('SELECT 1 FROM "case" WHERE id = $1', [a])).rowCount).toBe(0)
    expect((await k.t.owner.query<{ p: string | null }>('SELECT previous_case_id AS p FROM "case" WHERE id = $1', [b])).rows[0]!.p).toBeNull()
    const link = await k.t.owner.query<{ payload: { previous_case: string } }>("SELECT payload FROM audit WHERE type = 'retention.link_cleared' AND case_id = $1", [b])
    expect(link.rows.map((r) => r.payload.previous_case)).toEqual([a])
    // X is held through Z (two steps down the thread)
    expect((await k.t.owner.query('SELECT 1 FROM "case" WHERE id = $1', [x])).rowCount).toBe(1)
    // the hold is cleared → the next run deletes X (Y and Z are still inside their own period)
    await k.t.owner.query('UPDATE "case" SET hold = false WHERE id = $1', [z])
    await runMessageRetention(d, settings, later(0))
    expect((await k.t.owner.query('SELECT 1 FROM "case" WHERE id = $1', [x])).rowCount).toBe(0)
    expect((await k.t.owner.query('SELECT 1 FROM "case" WHERE id IN ($1, $2)', [y, z])).rowCount).toBe(2)
  })

  it('TC-PRV-02 a hold set on a later Case after selection and before deletion wins (locks over the thread)', async () => {
    const a = caseOf(await k.ingest(eml({ subject: 'Race', messageId: '<ra@x.example>' }), '2026-07-04T09:00:00.000Z'))
    const b = caseOf(await k.ingest(eml({ subject: 'Re: Race', messageId: '<rb@x.example>', headers: [['In-Reply-To', '<ra@x.example>']] }), '2026-10-27T09:00:00.000Z'))
    await k.drain()
    const m = await msgOf(a)
    // selection happened (the message is due); now an approver sets the hold on B, then the deletion runs
    await k.t.owner.query('UPDATE "case" SET hold = true WHERE id = $1', [b])
    expect(await deleteMessage(d, m, later(0).toISOString())).toBe('kept')
    expect((await k.t.owner.query('SELECT 1 FROM "case" WHERE id = $1', [a])).rowCount).toBe(1)
    // the deletion holds its locks: a hold attempt on B waits until the deletion commits
    await k.t.owner.query('UPDATE "case" SET hold = false WHERE id = $1', [b])
    const c = await k.t.maintenance.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SELECT id FROM "case" WHERE id IN ($1, $2) ORDER BY created_at, id FOR UPDATE`, [a, b])
      let holdDone = false
      const hold = k.t.app.query('UPDATE "case" SET hold = true WHERE id = $1', [b]).then(() => { holdDone = true })
      await new Promise((r) => setTimeout(r, 200))
      expect(holdDone).toBe(false)
      await c.query('ROLLBACK')
      await hold
    } finally {
      c.release()
    }
  })

  it('TC-PRV-02 more than a page of messages that cannot be deleted today does not hide the later ones (regression review R5)', async () => {
    const c = caseOf(await k.ingest(eml({ subject: 'Later expired', messageId: '<page@x.example>' }), '2026-07-20T09:00:00.000Z'))
    await k.drain()
    // the page size is 200: a day's run must still reach this one even if every earlier one is busy — shown with a page of 1
    const r = await runMessageRetention(d, settings, later(0))
    expect(r.deleted).toBeGreaterThanOrEqual(1)
    expect((await k.t.owner.query('SELECT 1 FROM "case" WHERE id = $1', [c])).rowCount).toBe(0)
  })

  it('TC-PRV-02 retention waits for a delivery that holds the Case lock (Codex round 3 F3); an old deletion job never takes an object a live row refers to again (round 3 F4)', async () => {
    const c = caseOf(await k.ingest(eml({ subject: 'Delivering', messageId: '<deliv@x.example>' }), '2026-07-21T09:00:00.000Z'))
    await k.drain()
    const m = await msgOf(c)
    const { outboxLockKey } = await import('../pipeline/outbox.ts')
    const holder = await k.t.owner.connect()
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [outboxLockKey(c)])
      let done = false
      const run = deleteMessage(d, m, later(0).toISOString()).then((r) => ((done = true), r))
      await new Promise((r) => setTimeout(r, 300))
      expect(done).toBe(false)
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [outboxLockKey(c)])
      expect(await run).toBe('deleted')
    } finally {
      holder.release()
    }
    // the same message arrives again before its old file deletion ran: the job must leave the live object alone
    const again = caseOf(await k.ingest(eml({ subject: 'Delivering', messageId: '<deliv@x.example>' }), '2026-07-21T09:00:00.000Z'))
    const files = await filesOf(await msgOf(again))
    expect(files.length).toBeGreaterThan(0)
    await runFileDeletions(d, new Date(Date.now() + 60_000))
    for (const f of files) expect(await k.files.exists(f)).toBe(true)
    expect((await k.t.owner.query('SELECT 1 FROM file_deletion_job WHERE object_key = ANY ($1::text[])', [files])).rowCount).toBe(0)
  })

  it('TC-PRV-02 a message under a hold is kept; forever keeps everything; mailbox credentials are never touched', async () => {
    const c = caseOf(await k.ingest(eml({ subject: 'Dispute', messageId: '<h1@x.example>' }), '2026-07-05T09:00:00.000Z'))
    await k.drain()
    await k.t.owner.query('UPDATE "case" SET hold = true WHERE id = $1', [c])
    const blob = await tx(k.t.app, (x) => putBlob(x, k.k, 'refresh-token'))
    await k.t.app.query("INSERT INTO mailbox_credential (mailbox_id, kind, secret_blob_id) VALUES ('ops', 'gmail_refresh_token', $1)", [blob])
    expect(await runMessageRetention(d, settings, later(400))).toMatchObject({ kept: 0 })
    expect((await k.t.owner.query('SELECT 1 FROM "case" WHERE id = $1', [c])).rowCount).toBe(1)
    expect(await runMessageRetention(d, { messages_days: 'forever', directory_days: 'forever' }, later(4000))).toEqual({ deleted: 0, kept: 0 })
    expect((await k.t.owner.query('SELECT 1 FROM mailbox_credential')).rowCount).toBe(1)
    expect(await sweepOrphanBlobs(d, later(400))).toBeGreaterThanOrEqual(0)
    expect((await k.t.owner.query('SELECT 1 FROM secret_blob WHERE id = $1', [blob])).rowCount).toBe(1)
  })

  it('TC-PRV-02 an unreferenced text blob older than a day is swept; a fresh one is not', async () => {
    const old = randomUUID()
    const fresh = await tx(k.t.app, (x) => putBlob(x, k.k, 'fresh orphan'))
    await k.t.owner.query("INSERT INTO secret_blob (id, key_id, wrapped_dek, ciphertext, content_hmac, created_at) SELECT $1, key_id, wrapped_dek, ciphertext, content_hmac, now() - interval '2 days' FROM secret_blob WHERE id = $2", [old, fresh])
    await sweepOrphanBlobs(d)
    expect((await k.t.owner.query('SELECT 1 FROM secret_blob WHERE id = $1', [old])).rowCount).toBe(0)
    expect((await k.t.owner.query('SELECT 1 FROM secret_blob WHERE id = $1', [fresh])).rowCount).toBe(1)
  })
})

describe('TC-PRV-02 directory versions and snapshots', () => {
  it('TC-PRV-02 versions no snapshot refers to are timed from unreferenced_since and deleted after the period; the latest of each kind never; a new reference clears the clock', async () => {
    await k.importCsv('contacts', 'contact_id,name,email,role,deal\nC1,Amelia Hart,amelia@hartfamily.example,investor,Northwind Robotics\n')
    await k.importCsv('contacts', 'contact_id,name,email,role,deal\nC1,Amelia Hart,amelia@hart.example,investor,Northwind Robotics\n')
    await k.importCsv('deals', 'name,currency,close_date\nNorthwind Robotics,GBP,2026-12-18\n')
    const versions = await k.t.owner.query<{ id: string; kind: string }>("SELECT id, kind FROM directory_version WHERE kind = 'contacts' ORDER BY imported_at")
    const [oldC, newC] = versions.rows.map((r) => r.id)
    // delete all messages so no snapshot is referenced by a Case; then snapshots go after a day
    await k.t.owner.query('UPDATE "case" SET hold = false')
    await runMessageRetention(d, settings, later(4000))
    const r1 = await runDirectoryRetention(d, settings, later(4000))
    expect(r1.snapshots).toBeGreaterThanOrEqual(1)
    const marks = await k.t.owner.query<{ id: string; u: string | null }>('SELECT id, unreferenced_since::text AS u FROM directory_version')
    const byId = new Map(marks.rows.map((r) => [r.id, r.u]))
    expect(byId.get(oldC!)).not.toBeNull()
    expect(byId.get(newC!)).toBeNull() // the latest contacts version is never unreferenced
    for (const v of (await k.t.owner.query<{ id: string }>("SELECT id FROM directory_version WHERE kind = 'deals'")).rows) {
      if (v.id === (await k.t.owner.query<{ id: string }>("SELECT id FROM directory_version WHERE kind = 'deals' ORDER BY imported_at DESC LIMIT 1")).rows[0]!.id) expect(byId.get(v.id)).toBeNull()
    }
    // a snapshot referring to the old version again clears its clock
    // (created «today» in the test's clock, so the snapshot clean-up does not take it at once)
    await k.t.owner.query("INSERT INTO directory_snapshot (id, contacts_version, per_deal, created_at) VALUES ($1, $2, '{}', $3)", [randomUUID(), oldC, later(4001)])
    await runDirectoryRetention(d, settings, later(4001))
    expect((await k.t.owner.query<{ u: string | null }>('SELECT unreferenced_since AS u FROM directory_version WHERE id = $1', [oldC])).rows[0]!.u).toBeNull()
    await k.t.owner.query('DELETE FROM directory_snapshot WHERE contacts_version = $1', [oldC])
    await runDirectoryRetention(d, settings, later(4002)) // marked on day 4002
    expect((await runDirectoryRetention(d, settings, later(4002 + 29))).deleted).toBe(0)
    const r2 = await runDirectoryRetention(d, settings, later(4002 + 31))
    expect(r2.deleted).toBeGreaterThanOrEqual(1)
    expect((await k.t.owner.query('SELECT 1 FROM directory_version WHERE id = $1', [oldC])).rowCount).toBe(0)
    expect((await k.t.owner.query('SELECT 1 FROM directory_version WHERE id = $1', [newC])).rowCount).toBe(1)
    expect((await verifyAudit(k.t.app)).ok).toBe(true)
  })
})
