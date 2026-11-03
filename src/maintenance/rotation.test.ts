// TC-PRV-08 (PRD R-PRV-05; tech design §5, v0.7.9): key rotation under the real `rotation` grants. Stopped part way and
// started again → completes; only the wrapping columns and file headers change (ciphertext and every logical table
// untouched); everything reads with the new key alone and hashes are unchanged; the services must have restarted with
// the new write key first, and a restart with the old key during the run is caught; a file deleted while rotation
// reads it is not written back; on S3 the old versions are gone; a missing key refuses the start until rotation is done.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createKit, type Kit } from '../pipeline/testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { makePdf } from '../../parser/testfiles.ts'
import { Keyring } from '../store/crypto.ts'
import { getBlobs } from '../store/blobs.ts'
import { fileKeyId, openFile, rewrapFile, type FileStore } from '../store/files.ts'
import { S3Store } from '../store/s3.ts'
import { appendAudit, verifyAudit } from '../store/audit.ts'
import { tx } from '../store/db.ts'
import { recordKeys } from '../startup.ts'
import { runFileDeletions } from './retention.ts'
import { missingKeyProblems, rotateKeys } from './rotation.ts'

let k: Kit
let k2: Keyring // k1 + k2, k2 writes
let current: Keyring // every key so far; the last one writes
const NEW = { id: 'k2', key: randomBytes(32) }
const S3 = { endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:58333', region: 'us-east-1', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }

const LOGICAL = ['mailbox', 'message', 'message_file', 'attachment', 'attachment_text', '"case"', 'stage_run', 'case_signal', 'redaction_map', 'case_label', 'case_field', 'reply', 'event_outbox', 'audit', 'audit_detail', 'directory_version', 'contact']
async function logicalDigest(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const t of LOGICAL) out[t] = (await k.t.owner.query<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0]!.h
  out.secret_blob_content = (await k.t.owner.query<{ h: string }>(`SELECT md5(string_agg(id::text || encode(ciphertext, 'hex') || content_hmac, '|' ORDER BY id)) AS h FROM secret_blob`)).rows[0]!.h
  return out
}
const fileRefs = async () => (await k.t.owner.query<{ key: string; sha256: string }>('SELECT file_ref AS key, sha256 FROM message_file UNION SELECT file_ref, sha256 FROM attachment WHERE file_ref IS NOT NULL')).rows

beforeAll(async () => {
  k = await createKit()
  for (const i of [1, 2, 3]) {
    await k.ingest(eml({ subject: `Rotation ${i}`, messageId: `<rot${i}@x.example>`, text: `Payment of GBP ${i},000.00`, attachments: [{ type: 'application/pdf', filename: `invoice${i}.pdf`, content: makePdf([`Invoice ${i}`]) }] }))
  }
  await k.drain()
  k2 = k.k.withKey(NEW)
}, 60_000)
afterAll(() => k.close())

describe('TC-PRV-08 key rotation', () => {
  it('TC-PRV-08 refuses until the service has started with the new write key', async () => {
    await recordKeys(k.t.app, k.k) // the service, still on k1
    await expect(rotateKeys({ db: k.t.rotation, k: k2, files: k.files })).rejects.toThrow(/restart the service with DOI_ACTIVE_KEY=k2/)
  })

  it('TC-PRV-08 stopped part way → some data on each key, the old key cannot be removed; started again → completes, logical tables untouched, readable with k2 alone', async () => {
    await recordKeys(k.t.app, k2) // the service restarted with k2
    const before = await logicalDigest()
    const ids = (await k.t.owner.query<{ id: string }>('SELECT id FROM secret_blob')).rows.map((r) => r.id)
    const plain = await getBlobs(k.t.owner, k.k, ids)
    await expect(rotateKeys({ db: k.t.rotation, k: k2, files: k.files }, { afterObject: (n) => { if (n === 7) throw new Error('stopped') } })).rejects.toThrow('stopped')
    const keys = (await k.t.owner.query<{ key_id: string; n: number }>('SELECT key_id, count(*)::int AS n FROM secret_blob GROUP BY key_id ORDER BY key_id')).rows
    expect(keys.map((r) => r.key_id)).toEqual(['k1', 'k2'])
    // the old key is still needed: a start without it is refused
    expect((await missingKeyProblems(k.t.app, k2.restrictTo('k2'))).join()).toMatch(/k1 is missing .* still encrypted/)

    const r = await rotateKeys({ db: k.t.rotation, k: k2, files: k.files })
    expect(r.sampled).toBeGreaterThan(0)
    expect((await k.t.owner.query("SELECT 1 FROM secret_blob WHERE key_id <> 'k2'")).rowCount).toBe(0)
    for (const f of await fileRefs()) {
      const sealed = (await k.files.getSealed(f.key))!
      expect(fileKeyId(sealed)).toBe('k2')
      expect(openFile(k2.restrictTo('k2'), sealed).length).toBeGreaterThan(0)
    }
    expect(await logicalDigest()).toEqual(before) // only the wrapping columns changed
    const after = await getBlobs(k.t.owner, k2.restrictTo('k2'), ids)
    for (const id of ids) expect(after.get(id)!.equals(plain.get(id)!)).toBe(true)
    expect((await k.t.owner.query('SELECT 1 FROM key_rotation WHERE completed_at IS NULL')).rowCount).toBe(0)
    expect(await missingKeyProblems(k.t.app, k2.restrictTo('k2'))).toEqual([])
    expect((await verifyAudit(k.t.app)).ok).toBe(true)
  })

  it('TC-PRV-08 a service restarted with the old write key during the run: caught; restarted with the new key → one more pass, nothing left on the old key', async () => {
    const k3 = k2.withKey({ id: 'k3', key: randomBytes(32) })
    current = k3
    await recordKeys(k.t.app, k3)
    // during the run: a start with k2 (old) that writes new data with k2, then the operator restarts with k3
    const old = k3.restrictTo('k2').withKey({ id: 'k3', key: randomBytes(32) }, 'k2')
    let once = false
    const during = async (n: number) => {
      if (n !== 3 || once) return
      once = true
      // a new start with the old write key is refused now (Codex E4 F8) …
      await expect(recordKeys(k.t.app, old)).rejects.toThrow(/rotated away from/)
      // … but an instance already running with it when the rotation began is only visible by its start record
      await tx(k.t.app, (c) => appendAudit(c, k.k, [{ actor: 'system', type: 'keys.active', payload: { key: 'k2' } }]))
      await k.ingest(eml({ subject: 'Written with the old key', messageId: '<old-key@x.example>' })) // the kit's store writes with k1
      await k.drain()
    }
    await expect(rotateKeys({ db: k.t.rotation, k: k3, files: k.files }, { afterObject: during })).rejects.toThrow(/started with an old write key/)
    await recordKeys(k.t.app, k3)
    await rotateKeys({ db: k.t.rotation, k: k3, files: k.files })
    expect((await k.t.owner.query("SELECT 1 FROM secret_blob WHERE key_id <> 'k3'")).rowCount).toBe(0)
    for (const f of await fileRefs()) expect(fileKeyId((await k.files.getSealed(f.key))!)).toBe('k3')
  })

  it('TC-PRV-08 a file whose deletion is committed is skipped; one deleted while rotation holds it is deleted after, never written back', async () => {
    const k4 = current.withKey({ id: 'k4', key: randomBytes(32) })
    current = k4
    await recordKeys(k.t.app, k4)
    const [a, b] = (await k.t.owner.query<{ file_ref: string }>('SELECT file_ref FROM attachment WHERE file_ref IS NOT NULL ORDER BY id LIMIT 2')).rows.map((r) => r.file_ref)
    // a: the deletion is committed (job recorded) before rotation comes to it
    // a real deletion removes the rows that refer to the file in the same transaction as the job (simulated here)
    await k.t.owner.query('UPDATE attachment SET file_ref = NULL WHERE file_ref = $1', [a])
    await k.t.owner.query("INSERT INTO file_deletion_job (id, object_key, reason, next_attempt_at) VALUES (gen_random_uuid(), $1, 'retention', now() + interval '1 day')", [a])
    // b: the deletion commits while rotation has read the file
    let deletion: Promise<unknown> | null = null
    const watching: FileStore = new Proxy(k.files, {
      get(t, p) {
        if (p === 'getSealed') {
          return async (key: string) => {
            const out = await t.getSealed(key)
            if (key === b && !deletion) {
              await k.t.owner.query('UPDATE attachment SET file_ref = NULL WHERE file_ref = $1', [b])
              await k.t.owner.query("INSERT INTO file_deletion_job (id, object_key, reason) VALUES (gen_random_uuid(), $1, 'retention')", [b])
              // «now» a minute ahead: the database and test clocks may differ slightly; a's job is a day away
              deletion = runFileDeletions({ db: k.t.maintenance, k: k.k, files: k.files }, new Date(Date.now() + 60_000))
              await new Promise((r) => setTimeout(r, 100)) // the deletion now waits for the object lock
            }
            return out
          }
        }
        const v = Reflect.get(t, p) as unknown
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
      },
    })
    await rotateKeys({ db: k.t.rotation, k: k4, files: watching })
    await deletion
    expect(await k.files.exists(b!)).toBe(false) // deleted after the rewrite, not resurrected
    expect(fileKeyId((await k.files.getSealed(a!))!)).not.toBe('k4') // skipped
    await runFileDeletions({ db: k.t.maintenance, k: k.k, files: k.files }, new Date(Date.now() + 2 * 86_400_000))
    expect(await k.files.exists(a!)).toBe(false)
  })

  it('TC-PRV-08 S3: after a rewrite the object has one version, with the new key in its header; an interrupted rewrite is pruned on the next run', async () => {
    const bucket = `doi-rot-${randomBytes(4).toString('hex')}`
    const s3 = new S3Store({ ...S3, bucket }, k.k)
    expect((await s3.request('PUT', '')).ok).toBe(true)
    const versioning = Buffer.from('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>')
    expect((await s3.request('PUT', '', { versioning: '' }, versioning)).ok).toBe(true)
    const kA = current.withKey({ id: 'kA', key: randomBytes(32) })
    current = kA
    // copy every referenced object into the bucket twice (two versions), sealed with the current keys
    const live = []
    for (const f of await fileRefs()) {
      const sealed = await k.files.getSealed(f.key)
      if (!sealed) continue // deleted in the test before
      live.push(f)
      for (let i = 0; i < 2; i++) expect((await s3.request('PUT', f.key, {}, sealed)).ok).toBe(true)
      expect((await s3.versions(f.key)).length).toBe(2)
    }
    await recordKeys(k.t.app, kA)
    await rotateKeys({ db: k.t.rotation, k: kA, files: s3 })
    expect(live.length).toBeGreaterThan(3)
    for (const f of live) {
      expect((await s3.versions(f.key)).length).toBe(1)
      expect(fileKeyId((await s3.getSealed(f.key))!)).toBe('kA')
    }
    // a rewrite interrupted after its PUT, before its clean-up: a second version with the new header is left over
    const one = live[0]!
    expect((await s3.request('PUT', one.key, {}, (await s3.getSealed(one.key))!)).ok).toBe(true)
    expect((await s3.versions(one.key)).length).toBe(2)
    await rotateKeys({ db: k.t.rotation, k: kA, files: s3 })
    expect((await s3.versions(one.key)).length).toBe(1)
    // leave no bucket behind (each is a SeaweedFS collection with its own volumes)
    for (const f of live) await s3.deleteAllVersions(f.key)
    await s3.request('DELETE', '')
  })
})

describe('TC-PRV-08 the start-up fence (Codex E4 F8, regression review R6)', () => {
  it('TC-PRV-08 a key rotated away from cannot write again; a key rotated back to can; a key only staged during a rotation is not fenced', async () => {
    const back = current.withKey({ id: 'kB', key: randomBytes(32) })
    current = back
    await recordKeys(k.t.app, back.withKey({ id: 'kS', key: randomBytes(32) }, 'kB'))
    // a rotation to kB with kS only staged (never a write key, no data)
    await rotateKeys({ db: k.t.rotation, k: back.withKey({ id: 'kS', key: randomBytes(32) }, 'kB'), files: k.files })
    expect((await k.t.owner.query("SELECT 1 FROM key_rotation WHERE from_key = 'kS'")).rowCount).toBe(0)
    const prev = (await k.t.owner.query<{ from_key: string }>("SELECT from_key FROM key_rotation WHERE to_key = 'kB' LIMIT 1")).rows[0]!.from_key
    await expect(recordKeys(k.t.app, back.withKey({ id: 'kX', key: randomBytes(32) }, prev))).rejects.toThrow(/rotated away from/)
  })
})

describe('TC-PRV-08 S3 with versioning suspended (Codex E4 F9)', () => {
  it('TC-PRV-08 the earlier numbered versions are removed; only the current «null» version stays', async () => {
    const bucket = `doi-rot-${randomBytes(4).toString('hex')}`
    const s3 = new S3Store({ ...S3, bucket }, k.k)
    expect((await s3.request('PUT', '')).ok).toBe(true)
    const status = (st: string) => Buffer.from(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${st}</Status></VersioningConfiguration>`)
    expect((await s3.request('PUT', '', { versioning: '' }, status('Enabled'))).ok).toBe(true)
    const key = '00000000-0000-4000-8000-0000000000f9/' + 'b'.repeat(64)
    expect((await s3.request('PUT', key, {}, Buffer.from('old version'))).ok).toBe(true)
    expect((await s3.request('PUT', '', { versioning: '' }, status('Suspended'))).ok).toBe(true)
    await s3.replaceSealed(key, Buffer.from('new header, same ciphertext'))
    const left = await s3.versions(key)
    expect(left).toEqual(['null'])
    await s3.deleteAllVersions(key)
    await s3.request('DELETE', '')
  })
})

describe('TC-PRV-08 key lifecycles and storage errors (Codex E4 round 3 F2, F7, F8)', () => {
  it('TC-PRV-08 a key rotated away from, back to, and away again without completing is still needed', async () => {
    const t = new Date('2030-01-01T00:00:00Z').getTime()
    const at = (n: number) => new Date(t + n * 1000)
    await k.t.owner.query("INSERT INTO key_rotation (id, from_key, to_key, started_at, completed_at) VALUES (gen_random_uuid(), 'kL', 'kM', $1, $1), (gen_random_uuid(), 'kM', 'kL', $2, $2), (gen_random_uuid(), 'kL', 'kN', $3, NULL)", [at(1), at(2), at(3)])
    const ring = k.k.withKey({ id: 'kN', key: randomBytes(32) }).restrictTo('kN')
    expect((await missingKeyProblems(k.t.app, ring)).join()).toMatch(/kL is missing .* no completed rotation/)
    await k.t.owner.query("DELETE FROM key_rotation WHERE from_key IN ('kL', 'kM') OR to_key IN ('kL', 'kM')")
  })
  it('TC-PRV-08 a live attachment with a stale deletion job is still rotated (round 4 F3)', async () => {
    const ref = (await k.t.owner.query<{ file_ref: string }>('SELECT file_ref FROM attachment WHERE file_ref IS NOT NULL LIMIT 1')).rows[0]!.file_ref
    await k.t.owner.query("INSERT INTO file_deletion_job (id, object_key, reason, next_attempt_at) VALUES (gen_random_uuid(), $1, 'retention', now() + interval '1 day')", [ref])
    const kz = current.withKey({ id: 'kZ', key: randomBytes(32) })
    current = kz
    await recordKeys(k.t.app, kz)
    await rotateKeys({ db: k.t.rotation, k: kz, files: k.files })
    expect(fileKeyId((await k.files.getSealed(ref))!)).toBe('kZ')
    await k.t.owner.query('DELETE FROM file_deletion_job WHERE object_key = $1', [ref])
  })
  it('TC-PRV-08 a replacement that decrypts but holds another object\'s content is not accepted on resume (round 6 F2)', async () => {
    const refs = (await k.t.owner.query<{ file_ref: string }>('SELECT file_ref FROM message_file ORDER BY file_ref LIMIT 2')).rows.map((r) => r.file_ref)
    const [a, b] = refs as [string, string]
    const original = (await k.files.getSealed(a))!
    // a faulty store left B's content, valid under the write key, as A's current version
    const kq = current.withKey({ id: 'kQ', key: randomBytes(32) })
    await k.files.replaceSealed(a, rewrapFile(kq, (await k.files.getSealed(b))!))
    await recordKeys(k.t.app, kq)
    await expect(rotateKeys({ db: k.t.rotation, k: kq, files: k.files })).rejects.toThrow(/recorded content/)
    await k.files.replaceSealed(a, original) // put things back for the next tests
    current = kq
    await rotateKeys({ db: k.t.rotation, k: kq, files: k.files })
  })
  it('TC-PRV-08 a disk read error is not «no file» (round 3 F8)', async () => {
    const ref = (await fileRefs())[0]!
    const { chmodSync } = await import('node:fs')
    const path = (k.files as unknown as { path(key: string): string }).path(ref.key)
    chmodSync(path, 0o000)
    try {
      await expect(k.files.getSealed(ref.key)).rejects.toThrow()
    } finally {
      chmodSync(path, 0o600)
    }
  })
  it('TC-PRV-08 S3 listings: escaped keys are decoded; a 200 that is not a complete listing fails (round 3 F2)', async () => {
    const s3 = new S3Store({ ...S3, bucket: 'unused', prefix: 'ops&archive/' }, k.k)
    const key = '00000000-0000-4000-8000-0000000000f2/' + 'd'.repeat(64)
    const listing = `<?xml version="1.0"?><ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>ops&amp;archive/${key}</Key><VersionId>v1</VersionId></Version></ListVersionsResult>`
    s3.request = async () => new Response(listing, { status: 200 })
    expect(await s3.versions(key)).toEqual(['v1'])
    s3.request = async () => new Response('<html>busy</html>', { status: 200 })
    await expect(s3.versions(key)).rejects.toThrow(/not a complete listing/)
    // a broken record inside an otherwise complete listing (round 4 F1)
    s3.request = async () => new Response(listing.replace('</Version>', '</BrokenVersion>'), { status: 200 })
    await expect(s3.versions(key)).rejects.toThrow(/incomplete record/)
    // an entity without its semicolon (round 5 F1)
    s3.request = async () => new Response(listing.replace('&amp;', '&amp'), { status: 200 })
    await expect(s3.versions(key)).rejects.toThrow(/malformed XML/)
    s3.request = async () => new Response(listing.replace('&amp;', '&#xD800;'), { status: 200 }) // round 6 F1
    await expect(s3.versions(key)).rejects.toThrow(/malformed XML/)
    // a rewrite that does not read back identically keeps the old versions (round 5 F3)
    const calls: string[] = []
    s3.request = async (method: string) => {
      calls.push(method)
      return method === 'GET' ? new Response(new Uint8Array(Buffer.from('corrupted')), { status: 200 }) : new Response('', { status: 200 })
    }
    await expect(s3.replaceSealed(key, Buffer.from('new header'))).rejects.toThrow(/did not read back/)
    expect(calls).not.toContain('DELETE')
  })
})

describe('TC-PRV-08 S3 pruning needs a clear answer (Codex E4 round 2 F7)', () => {
  it('TC-PRV-08 a failed HEAD while pruning throws: the rotation cannot complete over unknown old versions', async () => {
    const s3 = new S3Store({ ...S3, bucket: 'unused' }, k.k)
    s3.request = async (method: string) => new Response('', { status: method === 'HEAD' ? 503 : 200 })
    await expect(s3.pruneOldVersions('00000000-0000-4000-8000-0000000000f7/' + 'c'.repeat(64))).rejects.toThrow(/HEAD 503/)
  })
})
