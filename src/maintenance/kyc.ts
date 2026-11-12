// KYC transfer and replacement (PRD R-PRV-03, C-PRV-2 v0.7.18; tech design §3.3 KycSink, §4.1, §5, v0.7.9).
// Transfers run as the app role: one row per possible-KYC attachment, created when C-RED-0's judgement is saved
// (redact), tried at once and again a few times, then once a day until it succeeds. Once every possible-KYC attachment
// of a message is delivered, the maintenance role replaces the archive in five recorded steps and continues the Case
// from `extract` through enqueue_kyc_continuation.
import { createHash, createHmac, randomUUID } from 'node:crypto'
import pg from 'pg'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { appendAudit } from '../store/audit.ts'
import { getBlobs, putBlob, putJson } from '../store/blobs.ts'
import { careFromDelivered } from '../lib/events.ts'
import { outboxLockKey } from '../pipeline/outbox.ts'
import { lockObjectKey, objectKey, writeWithIntent, type FileStore } from '../store/files.ts'
import { decodeMime, stripAttachments } from '../ingest/mime.ts'
import { blobColumns } from './retention.ts'

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const QUICK_ATTEMPTS = 3 // then «failed»: retried by the daily run until it succeeds (R-PRV-03 v0.7.18)

/** An error code only; never a message that could carry data (kyc_delivery.last_error). */
export class KycError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export interface KycFile {
  deliveryId: string
  caseId: string
  seq: number
  name: string // generated: <case_id>-<seq>.<ext> (tech design §5), never the attachment's own name
  sha256: string
}
export interface KycReceipt {
  target: 'folder' | 'webhook'
  name: string
  sha256: string
}
export interface KycSink {
  deliver(file: Buffer, meta: KycFile): Promise<KycReceipt>
}

const EXT: Record<string, string> = { pdf: 'pdf', txt: 'txt', csv: 'csv', eml: 'eml', docx: 'docx', xml: 'xml' }
export function generatedName(caseId: string, seq: number, kind: string, content: Buffer): string {
  let ext = Object.hasOwn(EXT, kind) ? EXT[kind]! : 'bin' // own keys only: «__proto__» is not a kind
  if (kind === 'image') {
    if (content[0] === 0x89 && content.subarray(1, 4).toString('latin1') === 'PNG') ext = 'png'
    else if (content[0] === 0xff && content[1] === 0xd8) ext = 'jpg'
    else if (content.subarray(0, 4).toString('latin1') === 'GIF8') ext = 'gif'
  }
  return `${caseId}-${seq}.${ext}`
}

/** Folder target: temporary file, fsync, rename, read back (C-PRV-2 v0.7.18). */
export class FolderSink implements KycSink {
  private readonly dir: string
  constructor(dir: string) {
    this.dir = resolve(dir)
  }
  async deliver(file: Buffer, meta: KycFile): Promise<KycReceipt> {
    if (!/^[0-9a-f-]{36}-\d+\.[a-z]{1,4}$/.test(meta.name)) throw new KycError('bad_name')
    await mkdir(this.dir, { recursive: true }).catch(() => {
      throw new KycError('folder_unavailable')
    })
    const final = join(this.dir, meta.name)
    const tmp = join(this.dir, `.${meta.name}.${randomUUID()}.tmp`)
    try {
      const h = await open(tmp, 'wx', 0o600)
      try {
        await h.writeFile(file)
        await h.sync()
      } finally {
        await h.close()
      }
      await rename(tmp, final)
    } catch {
      await rm(tmp, { force: true })
      throw new KycError('folder_write_failed')
    }
    const back = await readFile(final).catch(() => null)
    if (!back || sha256(back) !== meta.sha256) throw new KycError('readback_mismatch')
    return { target: 'folder', name: meta.name, sha256: meta.sha256 }
  }
}

export type KycPoster = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>
/** HTTPS only, redirects are an error (tech design §5). */
export const fetchKycPoster: KycPoster = async (url, body, headers) => {
  const r = await fetch(url, { method: 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(60_000) })
  return { status: r.status, body: (await r.text()).slice(0, 4096) }
}

/**
 * Webhook target: a JSON body with the file, signed (HMAC-SHA256, X-Trunks-Signature) and carrying the transfer id as
 * the idempotency key. Success only when the answer is 2xx and its JSON body returns the same transfer id and SHA-256
 * (C-PRV-2 v0.7.18); anything else is a failure and nothing is deleted.
 */
export class WebhookSink implements KycSink {
  private readonly url: string
  private readonly secret: string
  private readonly post: KycPoster
  constructor(url: string, secret: string, post: KycPoster = fetchKycPoster) {
    if (!url.startsWith('https://')) throw new Error('the KYC webhook must be an https:// address')
    this.url = url
    this.secret = secret
    this.post = post
  }
  async deliver(file: Buffer, meta: KycFile): Promise<KycReceipt> {
    const body = JSON.stringify({ delivery_id: meta.deliveryId, case_id: meta.caseId, seq: meta.seq, filename: meta.name, sha256: meta.sha256, content_base64: file.toString('base64') })
    const headers = {
      'content-type': 'application/json',
      'idempotency-key': meta.deliveryId,
      'x-trunks-signature': `sha256=${createHmac('sha256', this.secret).update(body).digest('hex')}`,
    }
    let r: { status: number; body: string }
    try {
      r = await this.post(this.url, body, headers)
    } catch {
      throw new KycError('webhook_unreachable') // includes a redirect: fetch with redirect 'error' throws
    }
    if (r.status < 200 || r.status > 299) throw new KycError(`webhook_http_${r.status}`)
    let ack: { delivery_id?: unknown; sha256?: unknown }
    try {
      ack = JSON.parse(r.body) as typeof ack
    } catch {
      throw new KycError('webhook_no_receipt')
    }
    if (ack?.delivery_id !== meta.deliveryId || ack?.sha256 !== meta.sha256) throw new KycError('webhook_receipt_mismatch')
    return { target: 'webhook', name: meta.name, sha256: meta.sha256 }
  }
}

/**
 * One transfer row per possible-KYC attachment that has none yet and whose source is still there (review #3: a re-run
 * never creates a second one). Called in the transaction that saves C-RED-0's judgement.
 */
export async function createDeliveries(c: Tx, caseId: string, messageId: string): Promise<number> {
  const r = await c.query(
    `INSERT INTO kyc_delivery (id, attachment_id, message_id, case_id, seq, sha256, state)
     SELECT gen_random_uuid(), a.id, a.message_id, $1, a.ordinal + 1, a.sha256, 'pending' FROM attachment a
      WHERE a.message_id = $2 AND a.maybe_kyc AND NOT a.source_deleted
        AND NOT EXISTS (SELECT 1 FROM kyc_delivery d WHERE d.attachment_id = a.id)
     ON CONFLICT (attachment_id) DO NOTHING`,
    [caseId, messageId],
  )
  return r.rowCount ?? 0
}

export interface KycDeps {
  db: Db
  k: Keyring
  files: FileStore
}

/** The attachment's bytes: its own object, or (over the size limit, never stored alone) its part of the archive. */
async function attachmentBytes(d: KycDeps, c: Tx, attachmentId: string): Promise<{ content: Buffer; kind: string; scan: string }> {
  const a = (await c.query<{ ordinal: number; kind: string; file_ref: string | null; scan_status: string; message_id: string; mime_version: number }>(
    'SELECT a.ordinal, a.kind, a.file_ref, a.scan_status, a.message_id, m.mime_version FROM attachment a JOIN message m ON m.id = a.message_id WHERE a.id = $1', [attachmentId],
  )).rows[0]
  if (!a) throw new KycError('attachment_gone')
  if (a.file_ref) return { content: await d.files.get(a.file_ref).catch(() => { throw new KycError('file_unavailable') }), kind: a.kind, scan: a.scan_status }
  const f = (await c.query<{ file_ref: string; sha256: string }>("SELECT file_ref, sha256 FROM message_file WHERE message_id = $1 ORDER BY kind = 'kyc_stripped' DESC, created_at DESC LIMIT 1", [a.message_id])).rows[0]
  if (!f) throw new KycError('archive_gone')
  const raw = await d.files.get(f.file_ref)
  if (sha256(raw) !== f.sha256) throw new KycError('archive_changed')
  const m = decodeMime(raw, { maxAttachmentBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER, legacyOrdinals: a.mime_version === 1 })
  const part = m.attachments.find((x) => x.ordinal === a.ordinal)
  if (!part?.content) throw new KycError('part_unavailable')
  return { content: part.content, kind: a.kind, scan: a.scan_status }
}

/**
 * Try the transfers that are due: `pending` ones always; `failed` ones when `includeFailed` (the daily run). Each row is
 * locked while it is sent, so two processes never send the same one at the same time; the target de-duplicates retries
 * by the transfer id.
 */
export async function runKycDeliveries(d: KycDeps, sink: KycSink | null, o: { includeFailed?: boolean } = {}): Promise<{ delivered: number; failed: number }> {
  const states = o.includeFailed ? ['pending', 'failed'] : ['pending']
  const ids = (await d.db.query<{ id: string }>('SELECT id FROM kyc_delivery WHERE state = ANY ($1::text[]) ORDER BY created_at', [states])).rows
  let delivered = 0
  let failed = 0
  for (const { id } of ids) {
    const out = await tx(d.db, async (c) => {
      const row = (await c.query<{ id: string; attachment_id: string; case_id: string; seq: number; state: string; attempts: number }>(
        'SELECT id, attachment_id, case_id, seq, state, attempts FROM kyc_delivery WHERE id = $1 AND state = ANY ($2::text[]) FOR UPDATE SKIP LOCKED',
        [id, states],
      )).rows[0]
      if (!row) return null
      let receipt: KycReceipt | null = null
      let code = ''
      let hash = ''
      try {
        if (!sink) throw new KycError('no_target')
        const { content, kind, scan } = await attachmentBytes(d, c, row.attachment_id)
        // an attachment the virus scanner blocked is not sent anywhere; it stays and is reminded (owner to decide)
        if (scan === 'infected') throw new KycError('infected')
        hash = sha256(content)
        receipt = await sink.deliver(content, { deliveryId: row.id, caseId: row.case_id, seq: row.seq, name: generatedName(row.case_id, row.seq, kind, content), sha256: hash })
      } catch (e) {
        code = e instanceof KycError ? e.code : 'delivery_failed'
      }
      const attempts = row.attempts + 1
      if (receipt) {
        await c.query("UPDATE kyc_delivery SET state = 'delivered', attempts = $2, last_error = NULL, sha256 = $3, receipt_blob = $4, delivered_at = now() WHERE id = $1", [
          row.id, attempts, hash, await putJson(c, d.k, receipt as unknown as Record<string, string>),
        ])
        await appendAudit(c, d.k, [{ actor: 'system', type: 'kyc.delivered', caseId: row.case_id, payload: { delivery: row.id, seq: row.seq, sha256: hash, target: receipt.target } }])
        return true
      }
      // blocked by the virus scan: it will never be sent, so it is «failed» at once (reminded, never retried in vain)
      const state = row.state === 'failed' || attempts >= QUICK_ATTEMPTS || code === 'infected' ? 'failed' : 'pending'
      await c.query('UPDATE kyc_delivery SET state = $2, attempts = $3, last_error = $4 WHERE id = $1', [row.id, state, attempts, code.slice(0, 40)])
      await appendAudit(c, d.k, [{ actor: 'system', type: 'kyc.delivery_failed', caseId: row.case_id, payload: { delivery: row.id, seq: row.seq, error: code, state } }])
      return false
    })
    if (out === true) delivered++
    else if (out === false) failed++
  }
  return { delivered, failed }
}

/** An admin's retry (R-PRV-03 v0.7.18): back to `pending`, audited; the next run sends it. */
export async function retryDelivery(c: Tx, k: Keyring, deliveryId: string, actor: string): Promise<boolean> {
  const r = await c.query<{ case_id: string; seq: number }>("UPDATE kyc_delivery SET state = 'pending', last_error = NULL WHERE id = $1 AND state = 'failed' RETURNING case_id, seq", [deliveryId])
  if (!r.rows[0]) return false
  await appendAudit(c, k, [{ actor, type: 'kyc.delivery_retry', caseId: r.rows[0].case_id, payload: { delivery: deliveryId, seq: r.rows[0].seq } }])
  return true
}

/**
 * R-PRV-03 v0.7.19: a possible-KYC attachment the virus scan blocked is never sent; once an admin has dealt with it by
 * hand they mark it, with a reason (in audit_detail), and the replacement then goes ahead as for a delivered one.
 */
export async function discardBlocked(c: Tx, k: Keyring, deliveryId: string, actor: string, reason: string): Promise<boolean> {
  const r = await c.query<{ case_id: string; seq: number }>(
    "UPDATE kyc_delivery SET state = 'discarded' WHERE id = $1 AND state = 'failed' AND last_error = 'infected' RETURNING case_id, seq",
    [deliveryId],
  )
  if (!r.rows[0]) return false
  await appendAudit(c, k, [{ actor, type: 'kyc.discarded', caseId: r.rows[0].case_id, payload: { delivery: deliveryId, seq: r.rows[0].seq }, detail: { reason } }])
  return true
}

/** Daily: one reminder per message that still has a failed transfer (R-PRV-03). Maintenance role. */
export async function kycReminders(d: KycDeps): Promise<number> {
  const r = await d.db.query<{ message_id: string; case_id: string; n: number }>(
    "SELECT message_id, min(case_id::text)::uuid AS case_id, count(*)::int AS n FROM kyc_delivery WHERE state = 'failed' GROUP BY message_id",
  )
  if (r.rows.length) {
    await tx(d.db, (c) => appendAudit(c, d.k, r.rows.map((x) => ({ actor: 'system', type: 'kyc.delivery_pending', caseId: x.case_id, payload: { message: x.message_id, failed: x.n } }))))
  }
  return r.rows.length
}

export interface ReplaceHooks {
  /** Called after each recorded step; a test throws here to simulate a crash. */
  afterStep?: (step: number) => void | Promise<void>
  lockLost?: () => boolean
}

const LATER_STAGES = ['extract', 'redact', 'classify', 'fields', 'link', 'risk', 'reply', 'route', 'emit']
// audit details of the steps whose output can carry a value from an attachment's text (amounts, accounts, quotes);
// classify's detail holds only what the model saw, where a possible-KYC attachment's content never is
// and a person's field edits, whose before / after may hold such a value (Codex E4 round 2 F2)
// and reply revisions, whose before / after is the reply text (Codex E4 round 3 F1)
const DERIVED_STAGES = ['stage.extract', 'stage.redact', 'stage.fields', 'stage.link', 'stage.risk', 'stage.reply', 'stage.route', 'stage.emit', 'case.field_changed', 'reply.revised']
const DERIVED_DETAILS = "SELECT payload->>'detail_sha256' FROM audit WHERE case_id = $1 AND type = ANY ($2::text[]) AND payload ? 'detail_sha256'"

/** Messages whose every possible-KYC attachment is delivered and whose replacement has not finished. */
export async function replaceableMessages(db: Db): Promise<string[]> {
  const r = await db.query<{ message_id: string }>(
    `SELECT d.message_id FROM kyc_delivery d
      GROUP BY d.message_id
     HAVING bool_and(d.state IN ('delivered', 'discarded'))
        AND (EXISTS (SELECT 1 FROM kyc_replacement r WHERE r.message_id = d.message_id AND r.step < 5)
             OR EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = d.message_id AND a.maybe_kyc AND NOT a.source_deleted))
        AND NOT EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = d.message_id AND a.maybe_kyc AND NOT a.source_deleted
                          AND NOT EXISTS (SELECT 1 FROM kyc_delivery x WHERE x.attachment_id = a.id AND x.state IN ('delivered', 'discarded')))`,
  )
  return r.rows.map((x) => x.message_id)
}

/**
 * C-PRV-2 ①–⑤ for one message, as the maintenance role, resuming from the recorded step. Steps ① and ② leave nothing
 * but an intent-covered object until ③ records it, so a crash before ③ deletes nothing and simply starts over.
 */
export async function replaceMessage(d: KycDeps, messageId: string, hooks: ReplaceHooks = {}): Promise<'done' | 'busy' | 'skipped'> {
  // one replacer per message, and never at the same time as retention of that message (same advisory key). The lock
  // is held on its own connection, outside the pool: the steps need the pool's connections (self-test F4)
  const lock = new pg.Client((d.db as unknown as { options: pg.ClientConfig }).options)
  // a lost lock connection must not crash the process (regression review R2); the code only, as for the pool
  let lost = false
  lock.on('error', (e: Error & { code?: string }) => {
    lost = true
    console.error(`KYC replacement lock connection lost (${e.code ?? 'no code'})`)
  })
  await lock.connect()
  const key = [messageId]
  try {
    const got = (await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 7340009)) AS ok', key)).rows[0]!.ok
    if (!got) return 'busy'
    return await replaceLocked(d, messageId, { ...hooks, lockLost: () => lost })
  } finally {
    await lock.end() // ends the session and its lock
  }
}

async function replaceLocked(d: KycDeps, messageId: string, hooks: ReplaceHooks): Promise<'done' | 'skipped'> {
  if (!(await replaceableMessages(d.db)).includes(messageId)) return 'skipped'
  let row = (await d.db.query<{ round: number; step: number; original_file_ref: string; original_sha256: string; stripped_file_ref: string | null; stripped_sha256: string | null }>(
    'SELECT round, step, original_file_ref, original_sha256, stripped_file_ref, stripped_sha256 FROM kyc_replacement WHERE message_id = $1 AND step < 5 ORDER BY round DESC LIMIT 1', [messageId],
  )).rows[0]
  if (!row) {
    const orig = (await d.db.query<{ file_ref: string; sha256: string }>("SELECT file_ref, sha256 FROM message_file WHERE message_id = $1 ORDER BY kind = 'kyc_stripped' DESC, created_at DESC LIMIT 1", [messageId])).rows[0]
    if (!orig) return 'skipped'
    const round = Number((await d.db.query<{ n: number }>('SELECT coalesce(max(round), 0) + 1 AS n FROM kyc_replacement WHERE message_id = $1', [messageId])).rows[0]!.n)
    await d.db.query('INSERT INTO kyc_replacement (message_id, round, step, original_file_ref, original_sha256) VALUES ($1, $2, 0, $3, $4)', [messageId, round, orig.file_ref, orig.sha256])
    row = { round, step: 0, original_file_ref: orig.file_ref, original_sha256: orig.sha256, stripped_file_ref: null, stripped_sha256: null }
  }
  const kycAtts = (await d.db.query<{ id: string; ordinal: number; file_ref: string | null; sha256: string; delivery_state: string; delivery_sha256: string }>(
    `SELECT a.id, a.ordinal, a.file_ref, a.sha256, d.state AS delivery_state, d.sha256 AS delivery_sha256
       FROM attachment a LEFT JOIN kyc_delivery d ON d.attachment_id = a.id
       WHERE a.message_id = $1 AND a.maybe_kyc AND NOT a.source_deleted ORDER BY a.ordinal`, [messageId],
  )).rows

  // The advisory lock prevents new promotions after this check. Never strip an attachment before its receipt.
  if (kycAtts.length && (await d.db.query(`SELECT 1 FROM attachment a WHERE a.id = ANY($1::uuid[]) AND
      NOT EXISTS (SELECT 1 FROM kyc_delivery d WHERE d.attachment_id = a.id AND d.state IN ('delivered', 'discarded'))`,
      [kycAtts.map((a) => a.id)])).rowCount) return 'skipped'

  let stripped: Buffer | null = null
  if (row.step < 4) {
    // Re-prove the identities on a step-③ resume too; a persisted copy is not a new transfer receipt.
    const raw = await d.files.get(row.original_file_ref)
    if (sha256(raw) !== row.original_sha256) throw new Error('original MIME hash changed before KYC replacement')
    const version = (await d.db.query<{ mime_version: number }>('SELECT mime_version FROM message WHERE id = $1', [messageId])).rows[0]!.mime_version
    const expectedHashes = new Map(kycAtts.map((a) => {
      const hash = a.sha256 || a.delivery_sha256
      if (!hash || a.delivery_state === 'delivered' && a.delivery_sha256 !== hash) throw new Error('KYC delivery does not match the attachment identity')
      return [a.ordinal, hash] as const
    }))
    stripped = stripAttachments(raw, new Set(kycAtts.map((a) => a.ordinal)), {
      legacyOrdinals: version === 1, expectedHashes,
    })
  }
  if (row.step < 3) {
    // ① a copy without the possible-KYC parts, written under an intent (cleaned up if we never get to ③)
    const hash = sha256(stripped!)
    const objKey = objectKey(d.k, messageId, hash)
    const intent = await writeWithIntent(d.db, d.files, objKey, 'kyc_stripped', stripped!)
    await hooks.afterStep?.(1)
    // ② read back and check
    const back = await d.files.get(objKey)
    if (sha256(back) !== hash) throw new Error('the KYC-stripped copy did not read back identically')
    await hooks.afterStep?.(2)
    // ③ record the copy and both hashes
    await tx(d.db, async (c) => {
      await lockObjectKey(c, objKey)
      // the orphan clean-up may have taken it while we paused (round 4 F2): under the lock it must be there and whole
      const now = await d.files.getSealed(objKey).then((b) => (b ? d.files.get(objKey) : null))
      if (!now || sha256(now) !== hash) {
        await d.files.put(objKey, stripped!)
        if (sha256(await d.files.get(objKey)) !== hash) throw new Error('the KYC-stripped copy did not read back identically')
      }
      const exists = await c.query("SELECT 1 FROM message_file WHERE message_id = $1 AND kind = 'kyc_stripped' AND file_ref = $2", [messageId, objKey])
      if (!exists.rowCount) await c.query("INSERT INTO message_file (id, message_id, kind, sha256, file_ref) VALUES ($1, $2, 'kyc_stripped', $3, $4)", [randomUUID(), messageId, hash, objKey])
      await c.query('UPDATE kyc_replacement SET step = 3, stripped_file_ref = $2, stripped_sha256 = $3 WHERE message_id = $1 AND round = $4', [messageId, objKey, hash, row!.round])
      await c.query('DELETE FROM file_write_intent WHERE id = $1', [intent])
    })
    row = { ...row, step: 3, stripped_file_ref: objKey, stripped_sha256: hash }
    await hooks.afterStep?.(3)
  }

  if (row.step < 4) {
    const expected = sha256(stripped!)
    if (!row.stripped_file_ref || row.stripped_sha256 !== expected || sha256(await d.files.get(row.stripped_file_ref)) !== expected) {
      throw new Error('KYC-stripped copy changed before source deletion')
    }
    // the lock that keeps retention away must still be held before anything is deleted (R2); a later run resumes
    if (hooks.lockLost?.()) throw new Error('the replacement lock was lost')
    // ④ delete: the original archive (all versions), the attachments' files, their texts, quotes and intermediate
    // results; the files after the commit through file_deletion_job. The Case continues from `extract`.
    await tx(d.db, async (c) => {
      const cs = (await c.query<{ id: string; processing_generation: number }>('SELECT id, processing_generation FROM "case" WHERE message_id = $1 FOR UPDATE', [messageId])).rows[0]
      const ids = kycAtts.map((a) => a.id)
      const objects = [row!.original_file_ref, ...kycAtts.map((a) => a.file_ref).filter((x): x is string => !!x)]
      for (const o of objects) await c.query("INSERT INTO file_deletion_job (id, object_key, reason) VALUES ($1, $2, 'kyc')", [randomUUID(), o])
      const blobs = new Set<string>()
      const collect = async (sql: string, args: unknown[]) => {
        for (const r of (await c.query<{ b: string | null }>(sql, args)).rows) if (r.b) blobs.add(r.b)
      }
      await collect('SELECT text_blob AS b FROM attachment_text WHERE attachment_id = ANY ($1::uuid[]) UNION SELECT facts_blob FROM attachment_text WHERE attachment_id = ANY ($1::uuid[])', [ids])
      await collect('SELECT value_blob AS b FROM redaction_map WHERE source_attachment_id = ANY ($1::uuid[])', [ids])
      await collect('SELECT content_blob AS b FROM audit_detail WHERE source_attachment_ids && $1::uuid[]', [ids])
      if (cs) {
        await collect('SELECT result_blob AS b FROM stage_run WHERE case_id = $1 AND stage = ANY ($2::text[])', [cs.id, LATER_STAGES])
        await collect('SELECT value_blob AS b FROM case_field WHERE case_id = $1 UNION SELECT provenance_blob FROM case_field WHERE case_id = $1', [cs.id])
        await collect(`SELECT content_blob AS b FROM audit_detail WHERE case_id = $1 AND sha256 IN (${DERIVED_DETAILS})`, [cs.id, DERIVED_STAGES])
      }
      await c.query('DELETE FROM attachment_text WHERE attachment_id = ANY ($1::uuid[])', [ids])
      await c.query('DELETE FROM redaction_map WHERE source_attachment_id = ANY ($1::uuid[])', [ids])
      await c.query('DELETE FROM audit_detail WHERE source_attachment_ids && $1::uuid[]', [ids])
      if (cs) {
        await c.query(`DELETE FROM audit_detail WHERE case_id = $1 AND sha256 IN (${DERIVED_DETAILS})`, [cs.id, DERIVED_STAGES])
        await c.query('DELETE FROM stage_run WHERE case_id = $1 AND stage = ANY ($2::text[])', [cs.id, LATER_STAGES])
        await c.query('DELETE FROM case_field WHERE case_id = $1', [cs.id])
      }
      if (cs) {
        // C-PRV-2 ④ v0.7.19 (self-test F6, Codex E4 F4): what was made from the Case before the replacement and has not
        // left the system — unsent replies, automatic links, undelivered events, a person's field edits — goes; the
        // re-run makes them again and a person confirms again. Sent replies and delivered events stay.
        const derived: Array<[string, string]> = [
          ['reply', "case_id = $1 AND status <> 'sent'"],
          ['case_link', "case_id = $1 AND source = 'auto'"],
          ['case_field_change', 'case_id = $1'],
        ]
        // undelivered events: wait for a delivery in progress (same Case lock as the outbox, round 2 F3), then withdraw
        // them — placeholder content, sequence kept (round 2 F4) — and forget the state of their types so the re-run
        // makes them again
        await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [outboxLockKey(cs.id)])
        const pending = (await c.query<{ id: string; type: string; event_blob: string; care_blob: string | null }>(
          "SELECT id, type, event_blob, care_blob FROM event_outbox WHERE case_id = $1 AND status NOT IN ('sent', 'withdrawn') FOR UPDATE",
          [cs.id],
        )).rows
        if (pending.length) {
          const placeholder = await putBlob(c, d.k, JSON.stringify({ withdrawn: true }))
          for (const e of pending) {
            blobs.add(e.event_blob)
            if (e.care_blob) blobs.add(e.care_blob)
            await c.query("UPDATE event_outbox SET status = 'withdrawn', event_blob = $2, care_blob = NULL, care_sha256 = NULL WHERE id = $1", [e.id, placeholder])
          }
          // the state goes back to what the receiver last got (C-OUT-1; regression review S1); never sent → no state
          for (const type of new Set(pending.map((e) => e.type))) {
            const state = (await c.query<{ care_blob: string }>('SELECT care_blob FROM event_state WHERE case_id = $1 AND type = $2', [cs.id, type])).rows[0]
            const sent = (await c.query<{ care_blob: string | null; care_sha256: string | null }>(
              "SELECT care_blob, care_sha256 FROM event_outbox WHERE case_id = $1 AND type = $2 AND status = 'sent' ORDER BY case_event_seq DESC LIMIT 1",
              [cs.id, type],
            )).rows[0]
            if (sent?.care_blob) {
              await c.query('UPDATE event_state SET care_blob = $3, care_sha256 = $4 WHERE case_id = $1 AND type = $2', [cs.id, type, sent.care_blob, sent.care_sha256])
              if (state && state.care_blob !== sent.care_blob) blobs.add(state.care_blob)
            } else if (sent) {
              // delivered before events kept their value (before migration 004, round 4 F4): rebuilt, typed, from what was
              // delivered (round 5 F2)
              const rows = (await c.query<{ event_blob: string }>("SELECT event_blob FROM event_outbox WHERE case_id = $1 AND type = $2 AND status = 'sent' ORDER BY case_event_seq", [cs.id, type])).rows
              const bodies = await getBlobs(c, d.k, rows.map((r) => r.event_blob))
              const care = careFromDelivered(type, rows.map((r) => JSON.parse(bodies.get(r.event_blob)!.toString('utf8')) as { data: Record<string, unknown> }))
              const blob = await putBlob(c, d.k, care)
              if (state) {
                await c.query('UPDATE event_state SET care_blob = $3, care_sha256 = $4 WHERE case_id = $1 AND type = $2', [cs.id, type, blob, sha256(Buffer.from(care))])
                blobs.add(state.care_blob)
              } else {
                await c.query('INSERT INTO event_state (case_id, type, care_blob, care_sha256) VALUES ($1, $2, $3, $4)', [cs.id, type, blob, sha256(Buffer.from(care))])
              }
            } else if (state) {
              blobs.add(state.care_blob)
              await c.query('DELETE FROM event_state WHERE case_id = $1 AND type = $2', [cs.id, type])
            }
          }
        }
        const cols = await blobColumns(c)
        for (const [tbl, where] of derived) {
          for (const { col } of cols.filter((x) => x.tbl === tbl)) await collect(`SELECT "${col}" AS b FROM "${tbl}" WHERE ${where} AND "${col}" IS NOT NULL`, [cs.id])
          await c.query(`DELETE FROM "${tbl}" WHERE ${where}`, [cs.id])
        }
      }
      await c.query("DELETE FROM message_file WHERE message_id = $1 AND file_ref = $2", [messageId, row!.original_file_ref])
      await c.query('UPDATE attachment SET source_deleted = true, file_ref = NULL WHERE id = ANY ($1::uuid[])', [ids])
      // blobs still referred to elsewhere (none expected) make this fail and roll the whole step back
      if (blobs.size) await c.query('DELETE FROM secret_blob WHERE id = ANY ($1::uuid[])', [[...blobs]])
      if (cs) await c.query('SELECT enqueue_kyc_continuation($1, $2)', [cs.id, cs.processing_generation])
      await c.query('UPDATE kyc_replacement SET step = 4 WHERE message_id = $1 AND round = $2', [messageId, row!.round])
    })
    row = { ...row, step: 4 }
    await hooks.afterStep?.(4)
  }

  // ⑤ audit (references and hashes only)
  await tx(d.db, async (c) => {
    const caseId = (await c.query<{ id: string }>('SELECT id FROM "case" WHERE message_id = $1', [messageId])).rows[0]?.id ?? null
    const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM kyc_delivery WHERE message_id = $1', [messageId])).rows[0]!.n
    await appendAudit(c, d.k, [{ actor: 'system', type: 'kyc.replaced', caseId, payload: { message: messageId, round: row!.round, original_sha256: row!.original_sha256, stripped_sha256: row!.stripped_sha256 ?? '', attachments: n } }])
    await c.query('UPDATE kyc_replacement SET step = 5, finished_at = now() WHERE message_id = $1 AND round = $2', [messageId, row!.round])
  })
  return 'done'
}

/** Every message that is ready (maintenance schedule). */
export async function runKycReplacements(d: KycDeps): Promise<number> {
  let n = 0
  for (const m of await replaceableMessages(d.db)) {
    // one message that cannot be replaced must not stop the others (self-test F2): audited, shown, retried next run
    const out = await replaceMessage(d, m).catch(async (e: Error) => {
      // audited when the failure first appears or changes, not every ten minutes (regression review R4)
      const last = await d.db.query<{ e: string }>("SELECT payload->>'error' AS e FROM audit WHERE type = 'kyc.replace_failed' AND payload->>'message' = $1 ORDER BY seq DESC LIMIT 1", [m])
      if (last.rows[0]?.e !== e.name) await tx(d.db, (c) => appendAudit(c, d.k, [{ actor: 'system', type: 'kyc.replace_failed', payload: { message: m, error: e.name } }])).catch(() => {})
      return 'failed' as const
    })
    if (out === 'done') n++
  }
  return n
}
