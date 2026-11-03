// Retention (PRD R-PRV-02, C-PRV-1 v0.7.18; tech design §4.1 deletion order, v0.7.9). Runs as the `maintenance` role.
// One message per transaction: the thread link of the next Case is cleared, file deletions are recorded in
// `file_deletion_job`, the rows are deleted in the fixed order, then the text blobs they referenced. Files are removed
// after the commit by `runFileDeletions`, which survives a crash between the two.
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { appendAudit } from '../store/audit.ts'
import { lockObjectKey, type FileStore } from '../store/files.ts'
import { randomUUID } from 'node:crypto'
import { outboxLockKey } from '../pipeline/outbox.ts'

export interface RetentionDeps {
  db: Db // the maintenance pool
  k: Keyring
  files: FileStore
}

export interface RetentionSettings {
  messages_days: number | 'forever'
  directory_days: number | 'forever'
}

const DAY_MS = 86_400_000

// tables scoped by case (deletion order of tech design §4.1, before the case row itself)
const CASE_TABLES = [
  'event_outbox', 'event_state', 'reply', 'risk_adjustment', 'verification_task', 'case_label', 'case_field',
  'case_label_change', 'case_field_change', 'model_output', 'model_attempt', 'case_link', 'case_signal', 'stage_run', 'audit_detail',
] as const

/** Every (table, column) that references secret_blob, read from the catalogue so no column is ever forgotten. */
export async function blobColumns(c: Pick<Tx, 'query'>): Promise<Array<{ tbl: string; col: string }>> {
  const r = await c.query<{ tbl: string; col: string }>(
    `SELECT cl.relname AS tbl, a.attname AS col
       FROM pg_constraint k
       JOIN pg_class cl ON cl.oid = k.conrelid
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
      WHERE k.contype = 'f' AND k.confrelid = 'public.secret_blob'::regclass
      ORDER BY 1, 2`,
  )
  return r.rows
}

// which rows of a table belong to the message: [condition on $1, whether $1 is the case id or the message id]
const scope = (tbl: string): [string, 'case' | 'message'] | null => {
  if ((CASE_TABLES as readonly string[]).includes(tbl)) return ['case_id = $1', 'case']
  if (tbl === 'case') return ['id = $1', 'case']
  if (tbl === 'redaction_map' || tbl === 'kyc_delivery' || tbl === 'attachment' || tbl === 'message_file') return ['message_id = $1', 'message']
  if (tbl === 'attachment_text') return ['attachment_id IN (SELECT id FROM attachment WHERE message_id = $1)', 'message']
  if (tbl === 'message') return ['id = $1', 'message']
  return null
}

/** Lock a Case and every later Case of its thread in creation order; return them with their hold flags. */
async function lockThreadFrom(c: Tx, caseId: string): Promise<Array<{ id: string; hold: boolean }>> {
  let locked: Array<{ id: string; hold: boolean }> = []
  // a reply recorded while we wait adds a later Case: lock again until the set is stable (the lock on the earlier
  // Case blocks new references to it, so this ends)
  for (;;) {
    const r = await c.query<{ id: string; hold: boolean }>(
      `WITH RECURSIVE later AS (
         SELECT id FROM "case" WHERE id = $1
         UNION SELECT c.id FROM "case" c JOIN later l ON c.previous_case_id = l.id)
       SELECT id, hold FROM "case" WHERE id IN (SELECT id FROM later) ORDER BY created_at, id FOR UPDATE`,
      [caseId],
    )
    if (r.rows.length === locked.length) return r.rows
    locked = r.rows
  }
}

/**
 * Lock a Case and every earlier Case of its thread in creation order (used when a hold is set, PRD R-REV-07). Both
 * sides take the locks in the same order, so a hold set at the same moment as a deletion is never missed.
 */
export async function lockThreadTo(c: Tx, caseId: string): Promise<string[]> {
  const r = await c.query<{ id: string }>(
    `WITH RECURSIVE earlier AS (
       SELECT id, previous_case_id FROM "case" WHERE id = $1
       UNION SELECT c.id, c.previous_case_id FROM "case" c JOIN earlier e ON c.id = e.previous_case_id)
     SELECT id FROM "case" WHERE id IN (SELECT id FROM earlier) ORDER BY created_at, id FOR UPDATE`,
    [caseId],
  )
  return r.rows.map((x) => x.id)
}

/** Messages whose retention has ended and that no hold protects (a hold also keeps the earlier Cases of its thread). */
async function dueMessages(db: Db, days: number, now: Date, limit: number, after: { at: Date; id: string } | null = null): Promise<Array<{ message_id: string; case_id: string | null; received_at: Date }>> {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString()
  const r = await db.query<{ message_id: string; case_id: string | null; received_at: Date }>(
    `WITH RECURSIVE kept AS (
       SELECT id, previous_case_id FROM "case" WHERE hold
       UNION SELECT c.id, c.previous_case_id FROM "case" c JOIN kept k ON c.id = k.previous_case_id)
     SELECT m.id AS message_id, cs.id AS case_id, m.received_at
       FROM message m LEFT JOIN "case" cs ON cs.message_id = m.id
      WHERE m.received_at < $1 AND (cs.id IS NULL OR cs.id NOT IN (SELECT id FROM kept))
        AND ($3::timestamptz IS NULL OR (m.received_at, m.id) > ($3::timestamptz, $4::uuid))
      ORDER BY m.received_at, m.id
      LIMIT $2`,
    [cutoff, limit, after?.at ?? null, after?.id ?? null],
  )
  return r.rows
}

export type DeleteOutcome = 'deleted' | 'kept' | 'gone' | 'busy' | 'failed'

/** Delete one message and everything derived from it (one transaction). */
export async function deleteMessage(d: RetentionDeps, messageId: string, cutoff: string | null): Promise<DeleteOutcome> {
  return tx(d.db, async (c) => {
    // message rows are insert-only for every role, so row locks are not available: an advisory lock per message; held
    // by a KYC replacement of this message → skip it today (never wait: the pool is small, self-test F4)
    const got = (await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 7340009)) AS ok', [messageId])).rows[0]!.ok
    if (!got) return 'busy'
    const m = await c.query<{ raw_sha256: string; received_at: Date }>('SELECT raw_sha256, received_at FROM message WHERE id = $1', [messageId])
    if (!m.rows[0]) return 'gone'
    if (cutoff && m.rows[0].received_at.toISOString() >= cutoff) return 'kept'
    const cs = await c.query<{ id: string }>('SELECT id FROM "case" WHERE message_id = $1', [messageId])
    const caseId = cs.rows[0]?.id ?? null
    if (caseId) {
      // under the locks: a hold on this Case or any later Case of the thread keeps it (C-PRV-1 v0.7.18)
      const thread = await lockThreadFrom(c, caseId)
      if (thread.some((x) => x.hold)) return 'kept'
      // a delivery in progress holds the Case's outbox lock: wait for it, so nothing deleted here is sent afterwards
      // (Codex E4 round 3 F3)
      await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [outboxLockKey(caseId)])
      const next = await c.query<{ id: string }>('UPDATE "case" SET previous_case_id = NULL WHERE previous_case_id = $1 RETURNING id', [caseId])
      if (next.rowCount) {
        await appendAudit(c, d.k, next.rows.map((n) => ({ actor: 'system', type: 'retention.link_cleared', caseId: n.id, payload: { previous_case: caseId } })))
      }
    }
    // files: every object of the message, all versions, after the commit
    const objs = await c.query<{ key: string }>(
      `SELECT file_ref AS key FROM message_file WHERE message_id = $1
       UNION SELECT file_ref FROM attachment WHERE message_id = $1 AND file_ref IS NOT NULL
       UNION SELECT stripped_file_ref FROM kyc_replacement WHERE message_id = $1 AND stripped_file_ref IS NOT NULL
       UNION SELECT original_file_ref FROM kyc_replacement WHERE message_id = $1`,
      [messageId],
    )
    for (const o of objs.rows) await c.query("INSERT INTO file_deletion_job (id, object_key, reason) VALUES ($1, $2, 'retention')", [randomUUID(), o.key])
    // the text blobs the rows refer to, collected before the rows go
    const blobs = new Set<string>()
    for (const { tbl, col } of await blobColumns(c)) {
      const sc = scope(tbl)
      if (!sc) continue
      const id = sc[1] === 'case' ? caseId : messageId
      if (!id) continue
      const r = await c.query<{ b: string }>(`SELECT "${col}" AS b FROM "${tbl}" WHERE ${sc[0]} AND "${col}" IS NOT NULL`, [id])
      for (const x of r.rows) blobs.add(x.b)
    }
    if (caseId) {
      for (const t of CASE_TABLES) {
        if (t === 'verification_task') {
          // a task points at its replacement: delete the tasks no other task points at, until none are left
          for (;;) {
            const r = await c.query(
              'DELETE FROM verification_task v WHERE v.case_id = $1 AND NOT EXISTS (SELECT 1 FROM verification_task w WHERE w.replaced_by = v.id)',
              [caseId],
            )
            if (!r.rowCount) break
          }
          continue
        }
        await c.query(`DELETE FROM "${t}" WHERE case_id = $1`, [caseId])
      }
      // KYC transfer rows refer to the Case (self-test F1): before it
      await c.query('DELETE FROM kyc_delivery WHERE message_id = $1', [messageId])
      await c.query('DELETE FROM "case" WHERE id = $1', [caseId])
    }
    await c.query('DELETE FROM kyc_delivery WHERE message_id = $1', [messageId])
    await c.query('DELETE FROM kyc_replacement WHERE message_id = $1', [messageId])
    await c.query('DELETE FROM redaction_map WHERE message_id = $1', [messageId])
    await c.query('DELETE FROM attachment_text WHERE attachment_id IN (SELECT id FROM attachment WHERE message_id = $1)', [messageId])
    // nested attachments before their parents
    const depths = await c.query<{ depth: number }>('SELECT DISTINCT depth FROM attachment WHERE message_id = $1 ORDER BY depth DESC', [messageId])
    for (const x of depths.rows) await c.query('DELETE FROM attachment WHERE message_id = $1 AND depth = $2', [messageId, x.depth])
    await c.query('DELETE FROM message_file WHERE message_id = $1', [messageId])
    await c.query('DELETE FROM message WHERE id = $1', [messageId])
    if (blobs.size) await c.query('DELETE FROM secret_blob WHERE id = ANY ($1::uuid[])', [[...blobs]])
    // references and hashes only (R-PRV-02, C-AUD-5)
    await appendAudit(c, d.k, [{ actor: 'system', type: 'retention.deleted', caseId, payload: { message: messageId, raw_sha256: m.rows[0].raw_sha256, files: objs.rowCount ?? 0, blobs: blobs.size } }])
    return 'deleted'
  })
}

/** Remove the files of committed deletions; a failure keeps the job and tries again later (tech design §4.1). */
export async function runFileDeletions(d: RetentionDeps, now = new Date(), limit = 500): Promise<{ done: number; failed: number }> {
  const due = await d.db.query<{ id: string; object_key: string; attempts: number }>(
    'SELECT id, object_key, attempts FROM file_deletion_job WHERE next_attempt_at <= $1 ORDER BY created_at LIMIT $2',
    [now, limit],
  )
  let done = 0
  let failed = 0
  for (const j of due.rows) {
    try {
      await tx(d.db, async (c) => {
        // the same lock as key rotation and orphan cleanup: rotation never writes back an object deleted here
        await lockObjectKey(c, j.object_key)
        const still = await c.query('SELECT 1 FROM file_deletion_job WHERE id = $1 FOR UPDATE', [j.id])
        if (!still.rowCount) return
        // the same message received again since (deterministic keys): the object belongs to a live row now and the old
        // job must not take it (Codex E4 round 3 F4)
        const live = await c.query('SELECT 1 FROM message_file WHERE file_ref = $1 UNION ALL SELECT 1 FROM attachment WHERE file_ref = $1', [j.object_key])
        if (!live.rowCount) await d.files.deleteAllVersions(j.object_key)
        await c.query('DELETE FROM file_deletion_job WHERE id = $1', [j.id])
      })
      done++
    } catch {
      failed++
      const backoffMin = Math.min(24 * 60, 5 * 2 ** Math.min(j.attempts, 8))
      await d.db.query("UPDATE file_deletion_job SET attempts = attempts + 1, last_error = 'delete_failed', next_attempt_at = $2 WHERE id = $1", [
        j.id,
        new Date(now.getTime() + backoffMin * 60_000),
      ])
    }
  }
  return { done, failed }
}

/**
 * Directory versions (C-PRV-1 v0.7.18): mark those no snapshot refers to and that are not the latest of their kind
 * (per deal for the per-deal kinds, global for deals and contacts); delete them `directory_days` after that day.
 * Snapshots no Case refers to are deleted once a day old.
 */
export async function runDirectoryRetention(d: RetentionDeps, s: RetentionSettings, now = new Date()): Promise<{ marked: number; deleted: number; snapshots: number }> {
  const today = now.toISOString().slice(0, 10)
  const referenced = `(
      v.id IN (SELECT deals_version FROM directory_snapshot WHERE deals_version IS NOT NULL)
   OR v.id IN (SELECT contacts_version FROM directory_snapshot WHERE contacts_version IS NOT NULL)
   OR v.id::text IN (SELECT x.value FROM directory_snapshot ds, jsonb_each(ds.per_deal) e, jsonb_each_text(e.value) x WHERE x.value IS NOT NULL)
   OR v.id = (SELECT w.id FROM directory_version w WHERE w.kind = v.kind AND w.deal_key IS NOT DISTINCT FROM v.deal_key ORDER BY w.imported_at DESC, w.id DESC LIMIT 1))`
  const snapshots = await d.db.query(
    `DELETE FROM directory_snapshot s WHERE s.created_at < $1 AND NOT EXISTS (SELECT 1 FROM "case" c WHERE c.snapshot_id = s.id)`,
    [new Date(now.getTime() - DAY_MS)],
  ).catch(() => ({ rowCount: 0 })) // a Case created at this moment that refers to one wins; tomorrow tries again
  await d.db.query(`UPDATE directory_version v SET unreferenced_since = NULL WHERE unreferenced_since IS NOT NULL AND ${referenced}`)
  const marked = await d.db.query(`UPDATE directory_version v SET unreferenced_since = $1 WHERE unreferenced_since IS NULL AND NOT ${referenced}`, [today])
  let deleted = 0
  if (s.directory_days !== 'forever') {
    const cutoff = new Date(now.getTime() - s.directory_days * DAY_MS).toISOString().slice(0, 10)
    const due = await d.db.query<{ id: string }>('SELECT id FROM directory_version WHERE unreferenced_since IS NOT NULL AND unreferenced_since <= $1', [cutoff])
    for (const v of due.rows) {
      const ok = await tx(d.db, async (c) => {
        const row = await c.query(`SELECT 1 FROM directory_version v WHERE v.id = $1 AND unreferenced_since IS NOT NULL AND NOT ${referenced} FOR UPDATE`, [v.id])
        if (!row.rowCount) return false
        const blobs = new Set<string>()
        for (const { tbl, col } of await blobColumns(c)) {
          if (!['deal', 'commitment', 'bank_line', 'ledger_line', 'contact'].includes(tbl)) continue
          const r = await c.query<{ b: string }>(`SELECT "${col}" AS b FROM "${tbl}" WHERE directory_version = $1 AND "${col}" IS NOT NULL`, [v.id])
          for (const x of r.rows) blobs.add(x.b)
        }
        await c.query('DELETE FROM contact_email WHERE contact IN (SELECT id FROM contact WHERE directory_version = $1)', [v.id])
        for (const t of ['contact', 'deal', 'commitment', 'bank_line', 'ledger_line']) await c.query(`DELETE FROM "${t}" WHERE directory_version = $1`, [v.id])
        await c.query('DELETE FROM directory_version WHERE id = $1', [v.id])
        if (blobs.size) await c.query('DELETE FROM secret_blob WHERE id = ANY ($1::uuid[])', [[...blobs]])
        await appendAudit(c, d.k, [{ actor: 'system', type: 'retention.directory_deleted', payload: { directory_version: v.id, blobs: blobs.size } }])
        return true
      })
      if (ok) deleted++
    }
  }
  return { marked: marked.rowCount ?? 0, deleted, snapshots: snapshots.rowCount ?? 0 }
}

/**
 * Text blobs nothing refers to any more (a replaced cursor or token, a cleared hold reason), older than a day so a
 * blob written by a transaction that has not yet recorded its row is never taken (tech design v0.7.9, review #11, #14).
 */
export async function sweepOrphanBlobs(d: RetentionDeps, now = new Date()): Promise<number> {
  const cols = await blobColumns(d.db)
  const unused = cols.map(({ tbl, col }) => `NOT EXISTS (SELECT 1 FROM "${tbl}" x WHERE x."${col}" = b.id)`).join(' AND ')
  let removed = 0
  for (;;) {
    const r = await d.db
      .query(`DELETE FROM secret_blob WHERE id IN (SELECT b.id FROM secret_blob b WHERE b.created_at < $1 AND ${unused} LIMIT 1000)`, [new Date(now.getTime() - DAY_MS)])
      .catch(() => ({ rowCount: 0 })) // a row that started referring to one in the meantime: next run
    removed += r.rowCount ?? 0
    if (!r.rowCount || r.rowCount < 1000) return removed
  }
}

/** The daily retention pass for messages. */
export async function runMessageRetention(d: RetentionDeps, s: RetentionSettings, now = new Date()): Promise<{ deleted: number; kept: number }> {
  if (s.messages_days === 'forever') return { deleted: 0, kept: 0 }
  const cutoff = new Date(now.getTime() - s.messages_days * DAY_MS).toISOString()
  let deleted = 0
  let kept = 0
  // keyset paging (regression review R5): a page of messages that cannot be deleted today never hides the later ones
  let after: { at: Date; id: string } | null = null
  for (;;) {
    const due = await dueMessages(d.db, s.messages_days, now, 200, after)
    if (!due.length) return { deleted, kept }
    for (const m of due) {
      after = { at: m.received_at, id: m.message_id }
      // one message that cannot be deleted must not stop the others (self-test F1): audited, retried tomorrow
      const out = await deleteMessage(d, m.message_id, cutoff).catch(async (e: Error & { code?: string }) => {
        await tx(d.db, (c) => appendAudit(c, d.k, [{ actor: 'system', type: 'retention.failed', payload: { message: m.message_id, code: e.code ?? 'error' } }])).catch(() => {})
        return 'failed' as const
      })
      if (out === 'deleted') deleted++
      else if (out === 'kept') kept++
    }
  }
}
