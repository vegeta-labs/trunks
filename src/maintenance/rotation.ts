// Key rotation (PRD R-PRV-05; tech design §5, v0.7.9): `trunks rotate-keys`, run on its own as the `rotation` role. Every
// text blob and every stored file gets its data key wrapped by the active master key; nothing else changes (blobs:
// key_id and wrapped_dek; files: the header, the ciphertext untouched). It can stop at any point and start again: done
// work is recognised by its key id. Old versions of a rewritten object are removed. A rotation is complete only after a
// sample decrypts with the new key alone and no service started with the old write key in the meantime.
import { createHash, randomUUID } from 'node:crypto'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db } from '../store/db.ts'
import { fileKeyId, lockObjectKey, openFile, rewrapFile, type FileStore } from '../store/files.ts'

export interface RotationDeps {
  db: Db // the rotation pool
  k: Keyring // holds the old keys and the new active one
  files: FileStore
}

export interface RotationHooks {
  /** Called after each object; a test throws here to stop the run part way. */
  afterObject?: (n: number) => void | Promise<void>
}

const BATCH = 200

/** The write key the services last started with (tech design v0.7.9: `keys.active`, written at every start). */
/** The advisory lock under which a start checks its write key and a rotation starts and completes (round 2 F6). */
export const KEYS_LOCK = 7_340_011

async function lastActiveSince(db: Pick<Db, 'query'>, since: Date | null): Promise<string[]> {
  const r = await db.query<{ key: string }>(
    `SELECT payload->>'key' AS key FROM audit WHERE type = 'keys.active' ${since ? "AND time >= $1" : ''} ORDER BY seq DESC`,
    since ? [since.toISOString()] : [],
  )
  return r.rows.map((x) => x.key)
}

/** Every stored object the database refers to, or that a write in progress may still record. */
async function objectKeys(db: Db): Promise<string[]> {
  const r = await db.query<{ key: string }>(
    `SELECT file_ref AS key FROM message_file
     UNION SELECT file_ref FROM attachment WHERE file_ref IS NOT NULL
     UNION SELECT object_key FROM file_write_intent`,
  )
  return r.rows.map((x) => x.key)
}

export async function rotateKeys(d: RotationDeps, hooks: RotationHooks = {}): Promise<{ rotation: string; blobs: number; files: number; sampled: number }> {
  const to = d.k.active.id
  // keys that may have written something: ever the services' write key, or still on a text blob; a key only staged in
  // TRUNKS_MASTER_KEYS is not «rotated away from» (regression review R6)
  const used = new Set([
    ...(await d.db.query<{ key: string }>("SELECT DISTINCT payload->>'key' AS key FROM audit WHERE type = 'keys.active'")).rows.map((r) => r.key),
    ...(await d.db.query<{ key_id: string }>('SELECT DISTINCT key_id FROM secret_blob')).rows.map((r) => r.key_id),
  ])
  const old = d.k.ids().filter((id) => id !== to && used.has(id))
  if (!old.length) throw new Error('nothing to rotate: TRUNKS_MASTER_KEYS holds only the active key')
  // the services must already write with the new key, or new data would keep appearing under an old one. The check and
  // the rotation records are made under the lock every start takes for its key check (Codex E4 round 2 F6)
  const { open, rotation } = await tx(d.db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [KEYS_LOCK])
    const last = (await lastActiveSince(c, null))[0]
    if (last !== to) throw new Error(`restart the service with TRUNKS_ACTIVE_KEY=${to} first (it last started with ${last ?? 'no recorded key'})`)
    const o = (await c.query<{ id: string; started_at: Date }>('SELECT id, started_at FROM key_rotation WHERE to_key = $1 AND completed_at IS NULL ORDER BY started_at LIMIT 1', [to])).rows[0]
    const id = o?.id ?? randomUUID()
    if (!o) for (const from of old) await c.query('INSERT INTO key_rotation (id, from_key, to_key) VALUES ($1, $2, $3)', [from === old[0] ? id : randomUUID(), from, to])
    return { open: o, rotation: id }
  })
  let since = open?.started_at ?? new Date()
  let n = 0
  let blobs = 0
  let files = 0
  let sampled = 0
  for (;;) {
    blobs += await rotateBlobs(d, old, async () => hooks.afterObject?.(++n))
    files += await rotateFiles(d, old, async () => hooks.afterObject?.(++n))
    sampled = await sample(d, to)
    // review round 2 #2, Codex round 2 F6: the last check and the completion under the start-up lock, so no start with an
    // old write key can slip in between them
    const outcome = await tx(d.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [KEYS_LOCK])
      const starts = await lastActiveSince(c, since)
      if (starts.every((x) => x === to)) {
        await c.query('UPDATE key_rotation SET blobs_done = blobs_done + $2, files_done = files_done + $3, sampled = $4, completed_at = now() WHERE to_key = $1 AND completed_at IS NULL', [to, blobs, files, sampled])
        return 'done'
      }
      return starts[0] !== to ? 'old' : 'again'
    })
    if (outcome === 'done') break
    if (outcome === 'old') throw new Error(`a service started with an old write key during the rotation; restart it with TRUNKS_ACTIVE_KEY=${to} and run again`)
    since = new Date() // it has been restarted with the new key since: one more full pass covers what it wrote
  }
  return { rotation, blobs, files, sampled }
}

async function rotateBlobs(d: RotationDeps, old: string[], each: () => Promise<void>): Promise<number> {
  let done = 0
  for (;;) {
    const rows = (await d.db.query<{ id: string; key_id: string; wrapped_dek: Buffer }>('SELECT id, key_id, wrapped_dek FROM secret_blob WHERE key_id = ANY ($1::text[]) LIMIT $2', [old, BATCH])).rows
    if (!rows.length) return done
    for (const r of rows) {
      const w = d.k.rewrap(r.key_id, r.wrapped_dek)
      // only the wrapping columns, and only while the row still has the old key (a second run skips it)
      const u = await d.db.query('UPDATE secret_blob SET key_id = $2, wrapped_dek = $3 WHERE id = $1 AND key_id = $4', [r.id, w.keyId, w.wrappedDek, r.key_id])
      done += u.rowCount ?? 0
      await each()
    }
    await d.db.query("UPDATE key_rotation SET blobs_done = blobs_done + $2 WHERE to_key = $1 AND completed_at IS NULL", [d.k.active.id, rows.length])
  }
}

async function rotateFiles(d: RotationDeps, old: string[], each: () => Promise<void>): Promise<number> {
  let done = 0
  for (const key of await objectKeys(d.db)) {
    await tx(d.db, async (c) => {
      // the lock retention, KYC deletion and orphan clean-up take: a file deleted meanwhile is never written back
      await lockObjectKey(c, key)
      const live = await c.query(
        // a row refers to it → it is live, whatever old deletion job remains (deletion spares live objects, round 4 F3);
        // only an object held by a write intent alone is skipped when its deletion is committed
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM message_file WHERE file_ref = $1) OR EXISTS (SELECT 1 FROM attachment WHERE file_ref = $1)
                     OR (EXISTS (SELECT 1 FROM file_write_intent WHERE object_key = $1) AND NOT EXISTS (SELECT 1 FROM file_deletion_job WHERE object_key = $1))`,
        [key],
      )
      if (!live.rowCount) return
      const sealed = await d.files.getSealed(key)
      if (!sealed) return
      // what the object must contain: the recorded hash of its content (none for an object held by a write intent only)
      const expected = (await c.query<{ sha256: string }>("SELECT sha256 FROM message_file WHERE file_ref = $1 UNION SELECT sha256 FROM attachment WHERE file_ref = $1 AND sha256 <> ''", [key])).rows.map((r) => r.sha256)
      const mustBe = (plain: Buffer) => {
        if (expected.length && !expected.includes(createHash('sha256').update(plain).digest('hex'))) throw new Error('rotation: an object does not hold its recorded content; its old versions are kept')
      }
      if (old.includes(fileKeyId(sealed))) {
        mustBe(openFile(d.k, sealed))
        await d.files.replaceSealed(key, rewrapFile(d.k, sealed))
        done++
      } else {
        // rewritten before an interruption: the current version must decrypt to this object's own content before its old
        // versions go (round 5 F3, round 6 F2)
        mustBe(openFile(d.k, sealed))
        await d.files.pruneOldVersions(key)
      }
    })
    await each()
  }
  await d.db.query('UPDATE key_rotation SET files_done = files_done + $2 WHERE to_key = $1 AND completed_at IS NULL', [d.k.active.id, done])
  return done
}

/** Decrypt a sample with the new key alone: blobs against their content HMAC, files against their recorded hash. */
async function sample(d: RotationDeps, to: string): Promise<number> {
  const only = d.k.restrictTo(to)
  let n = 0
  const blobs = (await d.db.query<{ key_id: string; wrapped_dek: Buffer; ciphertext: Buffer; content_hmac: string }>('SELECT key_id, wrapped_dek, ciphertext, content_hmac FROM secret_blob ORDER BY random() LIMIT 50')).rows
  for (const b of blobs) {
    const plain = only.decrypt(b.key_id, b.wrapped_dek, b.ciphertext)
    if (only.hmac(plain) !== b.content_hmac) throw new Error('a rotated text blob does not match its hash')
    n++
  }
  // attachments too (round 5 F3): their recorded hash is of the decoded content, as for the archive
  const files = (await d.db.query<{ file_ref: string; sha256: string }>(
    "SELECT file_ref, sha256 FROM (SELECT file_ref, sha256 FROM message_file UNION ALL SELECT file_ref, sha256 FROM attachment WHERE file_ref IS NOT NULL AND sha256 <> '') f ORDER BY random() LIMIT 40",
  )).rows
  for (const f of files) {
    const sealed = await d.files.getSealed(f.file_ref)
    if (!sealed) continue
    if (createHash('sha256').update(openFile(only, sealed)).digest('hex') !== f.sha256) throw new Error('a rotated file does not match its hash')
    n++
  }
  return n
}

/**
 * Start-up check (tech design v0.7.9): a master key that data still uses, or that was never rotated away from, must not
 * be missing from TRUNKS_MASTER_KEYS.
 */
export async function missingKeyProblems(db: Pick<Db, 'query'>, k: Keyring): Promise<string[]> {
  const have = new Set(k.ids())
  const used = (await db.query<{ key_id: string }>('SELECT DISTINCT key_id FROM secret_blob')).rows.map((r) => r.key_id)
  const known = (await db.query<{ id: string }>(
    `SELECT from_key AS id FROM key_rotation UNION SELECT to_key FROM key_rotation UNION SELECT payload->>'key' FROM audit WHERE type = 'keys.active'`,
  )).rows.map((r) => r.id)
  // a completed move away counts only if it is the latest rotation that involves the key: a key rotated back to later is
  // needed again (Codex E4 round 3 F7)
  const completed = new Set((await db.query<{ k: string }>(
    `SELECT k FROM (SELECT DISTINCT ON (k) k, from_key, completed_at FROM (
        SELECT from_key AS k, from_key, completed_at, started_at FROM key_rotation
        UNION ALL SELECT to_key AS k, from_key, completed_at, started_at FROM key_rotation) x
      ORDER BY k, started_at DESC) latest WHERE latest.from_key = latest.k AND latest.completed_at IS NOT NULL`,
  )).rows.map((r) => r.k))
  const out: string[] = []
  for (const id of new Set([...used, ...known])) {
    if (have.has(id)) continue
    if (used.includes(id)) out.push(`master key ${id} is missing from TRUNKS_MASTER_KEYS but data is still encrypted with it`)
    else if (!completed.has(id)) out.push(`master key ${id} is missing from TRUNKS_MASTER_KEYS but no completed rotation away from it is recorded`)
  }
  return out
}
