// File storage (tech design T3, §4 `file_write_intent`, §5 encryption at rest). Disk adapter; S3 arrives with E4.
// Object key = owning object id + content hash: identical content in two messages is two objects.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { Keyring } from './crypto.ts'
import { tx, type Db, type Tx } from './db.ts'

export interface FileStore {
  put(key: string, data: Buffer): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  deleteAllVersions(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  /** Remove temporary files of interrupted writes older than the given age (Codex F9). */
  sweepTemporary(olderThanMs: number): Promise<number>
  /** Key rotation: the stored (encrypted) bytes, null when the object does not exist. */
  getSealed(key: string): Promise<Buffer | null>
  /** Key rotation: store new encrypted bytes as the only version of the object (older versions removed). */
  replaceSealed(key: string, sealed: Buffer): Promise<void>
  /** Key rotation: remove every version but the current one (a rewrite interrupted before its clean-up). */
  pruneOldVersions(key: string): Promise<void>
}

const MAGIC = Buffer.from('DOI1')
const TMP_SUFFIX = '.partial'

/** Encrypted file: MAGIC | keyId length (1) | keyId | wrapped DEK length (2) | wrapped DEK | ciphertext. */
export function sealFile(k: Keyring, data: Buffer): Buffer {
  const e = k.encrypt(data)
  const id = Buffer.from(e.keyId, 'utf8')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(e.wrappedDek.length)
  return Buffer.concat([MAGIC, Buffer.from([id.length]), id, len, e.wrappedDek, e.ciphertext])
}

function header(sealed: Buffer): { keyId: string; wrappedDek: Buffer; ciphertext: Buffer } {
  if (!sealed.subarray(0, 4).equals(MAGIC)) throw new Error('not an encrypted file')
  const idLen = sealed[4]!
  const keyId = sealed.subarray(5, 5 + idLen).toString('utf8')
  const dekLen = sealed.readUInt16BE(5 + idLen)
  const at = 7 + idLen
  return { keyId, wrappedDek: sealed.subarray(at, at + dekLen), ciphertext: sealed.subarray(at + dekLen) }
}

export function openFile(k: Keyring, sealed: Buffer): Buffer {
  const h = header(sealed)
  return k.decrypt(h.keyId, h.wrappedDek, h.ciphertext)
}

/** The master key id in a stored file's header. */
export const fileKeyId = (sealed: Buffer) => header(sealed).keyId

/** Key rotation: the same file with its data key wrapped by the active master key (the ciphertext is not touched). */
export function rewrapFile(k: Keyring, sealed: Buffer): Buffer {
  const h = header(sealed)
  const r = k.rewrap(h.keyId, h.wrappedDek)
  const id = Buffer.from(r.keyId, 'utf8')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(r.wrappedDek.length)
  return Buffer.concat([MAGIC, Buffer.from([id.length]), id, len, r.wrappedDek, h.ciphertext])
}

// owner id + HMAC of the content hash: the storage provider cannot test for a known document (self-test LK-F5)
export const objectKey = (k: Keyring, ownerId: string, sha256: string) => `${ownerId}/${k.hmac(`file\0${sha256}`)}`

/** Transaction-scoped lock on one object key: recording and orphan cleanup of the same key never interleave (CC-F1). */
export const lockObjectKey = (c: Pick<Tx, 'query'>, key: string) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7340003))', [key])

export class DiskStore implements FileStore {
  private readonly root: string
  private readonly k: Keyring
  constructor(root: string, k: Keyring) {
    this.root = resolve(root)
    this.k = k
  }
  private path(key: string): string {
    if (!/^[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(key)) throw new Error('invalid object key')
    return join(this.root, key)
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key)
    await mkdir(dirname(p), { recursive: true })
    const tmp = `${p}.${randomUUID()}${TMP_SUFFIX}`
    await writeFile(tmp, sealFile(this.k, data), { mode: 0o600 })
    await rename(tmp, p) // a retry writes the same key again
  }
  async get(key: string): Promise<Buffer> {
    return openFile(this.k, await readFile(this.path(key)))
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }
  async deleteAllVersions(key: string): Promise<void> {
    await this.delete(key) // a disk has one version
  }
  async getSealed(key: string): Promise<Buffer | null> {
    // absent only when it is: a permission or I/O error must not look like «nothing to rotate» (Codex E4 round 3 F8)
    return readFile(this.path(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
  }
  async replaceSealed(key: string, sealed: Buffer): Promise<void> {
    const p = this.path(key)
    const tmp = `${p}.${randomUUID()}${TMP_SUFFIX}`
    await writeFile(tmp, sealed, { mode: 0o600 })
    // checked before it replaces the old file (round 5 F3)
    if (!(await readFile(tmp)).equals(sealed)) {
      await rm(tmp, { force: true })
      throw new Error('the rewritten file did not read back identically')
    }
    await rename(tmp, p) // atomic: the old content is gone with the rename
  }
  async pruneOldVersions(): Promise<void> {
    // a disk keeps no versions
  }
  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.path(key))
      return true
    } catch {
      return false
    }
  }
  async sweepTemporary(olderThanMs: number): Promise<number> {
    let n = 0
    const now = Date.now()
    for (const dir of await readdir(this.root).catch(() => [] as string[])) {
      const full = join(this.root, dir)
      for (const f of await readdir(full).catch(() => [] as string[])) {
        if (!f.endsWith(TMP_SUFFIX)) continue
        const st = await stat(join(full, f)).catch(() => null)
        if (st && now - st.mtimeMs > olderThanMs) {
          await rm(join(full, f), { force: true })
          n++
        }
      }
    }
    return n
  }
}

/** Record the intent, then write the object. The caller deletes the intent in the transaction that records the file. */
export async function writeWithIntent(db: Db, store: FileStore, key: string, purpose: string, data: Buffer): Promise<string> {
  const id = randomUUID()
  await tx(db, (c) => c.query('INSERT INTO file_write_intent (id, object_key, purpose) VALUES ($1, $2, $3)', [id, key, purpose]))
  await store.put(key, data)
  return id
}

/**
 * Remove objects whose intent is older than `olderThanMs` and that no database row refers to (tech design §4). Each key
 * is re-checked under its lock, so an ingest retry that records the same key at the same moment is never undone (CC-F1).
 */
export async function cleanOrphans(db: Db, store: FileStore, olderThanMs = 3_600_000): Promise<number> {
  const old = await db.query<{ id: string; object_key: string }>(
    `SELECT id, object_key FROM file_write_intent WHERE created_at < now() - ($1::double precision * interval '1 millisecond')`,
    [olderThanMs],
  )
  let removed = 0
  for (const row of old.rows) {
    removed += await tx(db, async (c) => {
      await lockObjectKey(c, row.object_key)
      const still = await c.query('SELECT 1 FROM file_write_intent WHERE id = $1', [row.id])
      if (!still.rowCount) return 0
      const used = await c.query(
        `SELECT 1 FROM message_file WHERE file_ref = $1 UNION ALL SELECT 1 FROM attachment WHERE file_ref = $1
         UNION ALL SELECT 1 FROM file_write_intent WHERE object_key = $1 AND id <> $2 AND created_at >= now() - ($3::double precision * interval '1 millisecond')`,
        [row.object_key, row.id, olderThanMs],
      )
      await c.query('DELETE FROM file_write_intent WHERE id = $1', [row.id])
      if (used.rowCount) return 0 // recorded, or a younger attempt is writing it: keep the object
      await store.deleteAllVersions(row.object_key)
      return 1
    })
  }
  // temporary files of writes that never reached their rename
  await store.sweepTemporary(olderThanMs)
  return removed
}
