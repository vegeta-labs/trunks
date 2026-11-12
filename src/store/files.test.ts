import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createKit, type Kit } from '../pipeline/testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { cleanOrphans, DiskStore, type FileStore } from './files.ts'
import { S3Store } from './s3.ts'
import type { Queue } from '../pipeline/queue.ts'

const S3 = { endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:58333', region: 'us-east-1', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }

let k: Kit
let bucket: string
beforeAll(async () => {
  k = await createKit()
  bucket = `trunks-test-${randomBytes(4).toString('hex')}`
  const s3 = new S3Store({ ...S3, bucket }, k.k)
  const made = await s3.request('PUT', '')
  expect(made.ok).toBe(true)
  const versioning = Buffer.from('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>')
  expect((await s3.request('PUT', '', { versioning: '' }, versioning)).ok).toBe(true)
}, 60_000)
afterAll(async () => k?.close())

const stores = (): Array<[string, FileStore]> => [
  ['disk', k.files as DiskStore],
  ['s3', new S3Store({ ...S3, bucket }, k.k)],
]

describe('file write intents (tech design §4)', () => {
  it('TC-ING-20 a crash after the file write and before the commit: the retry writes the same key; abandoned objects are removed after an hour; equal attachments in two mails are separate objects', async () => {
    for (const [name, files] of stores()) {
      const failing: Queue = { send: async () => { throw new Error('crash before commit') } }
      const raw = eml({ text: `crash test ${name}`, attachments: [{ type: 'text/plain', filename: 'a.txt', content: 'same attachment bytes' }] })
      await expect(k.ingest.call(null, raw)).resolves.toBeDefined() // warm-up: a normal ingest works
      const { ingestMessage } = await import('../pipeline/ingest.ts')
      const raw2 = eml({ text: `crash test 2 ${name}`, attachments: [{ type: 'text/plain', filename: 'a.txt', content: 'same attachment bytes' }] })
      await expect(ingestMessage({ ...k, files, queue: failing }, k.mailbox, raw2, '2026-10-29T10:00:00.000Z')).rejects.toThrow('crash before commit')
      const intents = (await k.db.query('SELECT object_key FROM file_write_intent ORDER BY created_at')).rows.map((r) => r.object_key as string)
      expect(intents.length, name).toBe(2) // the original and its attachment
      for (const key of intents) expect(await files.exists(key), name).toBe(true)
      // the retry: same keys, recorded this time
      const r = await ingestMessage({ ...k, files }, k.mailbox, raw2, '2026-10-29T10:00:00.000Z')
      expect(r.status).toBe('created')
      const refs = (await k.db.query('SELECT f.file_ref FROM message_file f WHERE f.message_id = $1 UNION ALL SELECT a.file_ref FROM attachment a WHERE a.message_id = $1', [(r as { messageId: string }).messageId])).rows.map((x) => x.file_ref)
      expect(refs.sort()).toEqual([...intents].sort())
      // the leftover intents of the failed attempt: their objects are in use, so cleaning keeps the objects
      expect(await cleanOrphans(k.db, files, 0)).toBe(0)
      for (const key of intents) expect(await files.exists(key)).toBe(true)
      expect((await k.db.query('SELECT count(*)::int AS n FROM file_write_intent')).rows[0].n).toBe(0)

      // an abandoned object (no retry ever came): removed only after the hour
      const raw3 = eml({ text: `abandoned ${name}` })
      await expect(ingestMessage({ ...k, files, queue: failing }, k.mailbox, raw3, '2026-10-29T10:00:00.000Z')).rejects.toThrow()
      const [orphan] = (await k.db.query('SELECT object_key FROM file_write_intent')).rows.map((x) => x.object_key as string)
      expect(await cleanOrphans(k.db, files)).toBe(0) // younger than an hour
      expect(await files.exists(orphan!)).toBe(true)
      expect(await cleanOrphans(k.db, files, 0)).toBe(1)
      expect(await files.exists(orphan!)).toBe(false)

      // two mails with the same attachment: separate objects; removing one leaves the other
      const a = await ingestMessage({ ...k, files }, k.mailbox, eml({ text: `twin A ${name}`, attachments: [{ type: 'application/pdf', filename: 'x.pdf', content: '%PDF-1.4 same' }] }), '2026-10-29T10:00:00.000Z')
      const b = await ingestMessage({ ...k, files }, k.mailbox, eml({ text: `twin B ${name}`, attachments: [{ type: 'application/pdf', filename: 'x.pdf', content: '%PDF-1.4 same' }] }), '2026-10-29T10:00:00.000Z')
      const ka = (await k.db.query('SELECT file_ref, sha256 FROM attachment WHERE message_id = $1', [(a as { messageId: string }).messageId])).rows[0]
      const kb = (await k.db.query('SELECT file_ref, sha256 FROM attachment WHERE message_id = $1', [(b as { messageId: string }).messageId])).rows[0]
      expect(ka.sha256).toBe(kb.sha256)
      expect(ka.file_ref).not.toBe(kb.file_ref)
      await files.deleteAllVersions(ka.file_ref)
      expect(await files.exists(ka.file_ref)).toBe(false)
      expect((await files.get(kb.file_ref)).toString()).toBe('%PDF-1.4 same')
    }
  }, 120_000)

  it('TC-ING-20 cleanup and a retry of the same message never lose the recorded original (self-test CC-F1)', async () => {
    const { ingestMessage } = await import('../pipeline/ingest.ts')
    const failing: Queue = { send: async () => { throw new Error('crash before commit') } }
    for (const order of ['cleanup first', 'retry first'] as const) {
      const raw = eml({ text: `race ${order}` })
      await expect(ingestMessage({ ...k, queue: failing }, k.mailbox, raw, '2026-10-29T10:00:00.000Z')).rejects.toThrow()
      // the abandoned intent is now more than an hour old
      await k.t.owner.query(`UPDATE file_write_intent SET created_at = now() - interval '2 hours'`)
      const [key] = (await k.db.query('SELECT object_key FROM file_write_intent')).rows.map((r) => r.object_key as string)
      if (order === 'cleanup first') {
        expect(await cleanOrphans(k.db, k.files)).toBe(1) // the object is gone …
        expect(await k.files.exists(key!)).toBe(false)
        const r = await ingestMessage(k, k.mailbox, raw, '2026-10-29T10:00:00.000Z') // … and the retry writes it again
        expect(r.status).toBe('created')
      } else {
        const r = await ingestMessage(k, k.mailbox, raw, '2026-10-29T10:00:00.000Z')
        expect(r.status).toBe('created')
        expect(await cleanOrphans(k.db, k.files)).toBe(0) // recorded now: the cleanup keeps it
      }
      expect(await k.files.exists(key!), order).toBe(true)
      expect((await k.db.query('SELECT count(*)::int AS n FROM file_write_intent')).rows[0].n).toBe(0)
    }
  })

  it('TC-ING-20 a losing concurrent variant keeps the intent of an object nobody records; temporary files are swept (Codex F8, F9)', async () => {
    const { ingestMessage } = await import('../pipeline/ingest.ts')
    const body = 'variant test body'
    const a = eml({ messageId: '<Var@x.example>', text: body, date: 'Thu, 29 Oct 2026 10:00:00 +0000' })
    const b = Buffer.from(a.toString('latin1').replace('<Var@x.example>', '<var@x.example>'), 'latin1') // same dedupe key, other bytes
    const before = (await k.db.query('SELECT count(*)::int AS n FROM file_write_intent')).rows[0].n
    const rs = await Promise.all([ingestMessage(k, k.mailbox, a, '2026-10-29T10:00:00.000Z'), ingestMessage(k, k.mailbox, b, '2026-10-29T10:00:00.000Z')])
    expect(rs.map((r) => r.status).sort()).toEqual(['created', 'duplicate'])
    const left = (await k.db.query('SELECT object_key FROM file_write_intent')).rows.map((r) => r.object_key as string)
    expect(left.length).toBe(before + 1) // the loser's raw object, still tracked
    expect(await cleanOrphans(k.db, k.files, 0)).toBe(1)
    // a temporary file of a write that never reached its rename
    const root = (k.files as unknown as { root: string }).root
    const { mkdirSync, writeFileSync, existsSync, utimesSync } = await import('node:fs')
    mkdirSync(`${root}/00000000-0000-4000-8000-000000000000`, { recursive: true })
    const tmp = `${root}/00000000-0000-4000-8000-000000000000/${'a'.repeat(64)}.123.partial`
    writeFileSync(tmp, 'x')
    utimesSync(tmp, new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000))
    await cleanOrphans(k.db, k.files)
    expect(existsSync(tmp)).toBe(false)
  })

  it('S3 version listings are followed across pages (Codex F10)', async () => {
    const s3 = new S3Store({ ...S3, bucket }, k.k)
    const key = `${'1'.repeat(8)}-0000-4000-8000-${'1'.repeat(12)}/${'b'.repeat(64)}`
    let calls = 0
    const pages = [
      `<ListVersionsResult><IsTruncated>true</IsTruncated><NextKeyMarker>${key}</NextKeyMarker><NextVersionIdMarker>v1</NextVersionIdMarker><Version><Key>${key}</Key><VersionId>v1</VersionId></Version></ListVersionsResult>`,
      `<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>${key}</Key><VersionId>v2</VersionId></Version></ListVersionsResult>`,
    ]
    ;(s3 as unknown as { request: (m: string, k: string, q: Record<string, string>) => Promise<Response> }).request = async (_m, _k, q) => {
      if (calls === 1) expect(q).toMatchObject({ 'key-marker': key, 'version-id-marker': 'v1' })
      return new Response(pages[calls++])
    }
    expect(await s3.versions(key)).toEqual(['v1', 'v2'])
  })

  it('object keys carry an HMAC of the content hash, never the hash itself (self-test LK-F5)', async () => {
    const raw = eml({ text: 'key test' })
    const r = await k.ingest(raw)
    const row = (await k.db.query('SELECT f.file_ref, f.sha256 FROM message_file f WHERE f.message_id = $1', [(r as { messageId: string }).messageId])).rows[0]
    expect(row.file_ref.includes(row.sha256)).toBe(false)
  })

  it('S3: deleting all versions leaves no version and no delete marker', async () => {
    const s3 = new S3Store({ ...S3, bucket }, k.k)
    const key = `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/${'a'.repeat(64)}`
    await s3.put(key, Buffer.from('v1'))
    await s3.put(key, Buffer.from('v2'))
    expect((await s3.versions(key)).length).toBe(2)
    expect((await s3.get(key)).toString()).toBe('v2')
    await s3.deleteAllVersions(key)
    expect(await s3.versions(key)).toEqual([])
    // the stored bytes are ciphertext
    await s3.put(key, Buffer.from('plain secret'))
    const raw = Buffer.from(await (await s3.request('GET', key)).arrayBuffer())
    expect(raw.includes('plain secret')).toBe(false)
    await s3.deleteAllVersions(key)
  })
})
