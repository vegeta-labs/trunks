import { afterAll, beforeAll, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { createKit, FakeLlm, type Kit } from './testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { smallPng } from '../ingest/testimages.ts'
import { loadMessage, markFailed, runStage } from './stages.ts'
import { SetupError, type LlmAdapter } from '../adapters/llm/types.ts'
import { tx } from '../store/db.ts'
import { restartFrom } from './restart.ts'
import { putBlob } from '../store/blobs.ts'
import { replaceMessage, replaceableMessages, runKycDeliveries, type KycSink } from '../maintenance/kyc.ts'
import { decodeMime } from '../ingest/mime.ts'
import { objectKey } from '../store/files.ts'

let k: Kit
const llm = new FakeLlm()
const sink: KycSink = { async deliver(_bytes, meta) { return { target: 'folder', name: meta.name, sha256: meta.sha256 } } }
beforeAll(async () => { k = await createKit({ llm }) }, 60_000)
afterAll(async () => k?.close())
const untilRedact = async (raw: Buffer) => {
  const r = await k.ingest(raw)
  if (r.status !== 'created') throw new Error('test mail duplicated')
  for (const stage of ['scan', 'parse', 'content_signals', 'extract', 'redact'] as const) await runStage(k, stage, { caseId: r.caseId, generation: 1 })
  return r
}
const mail = () => eml({ text: 'Hello', html: '<img src="cid:logo">', attachments: [
  { type: 'image/png', filename: 'logo.png', disposition: 'inline', contentId: '<logo>', content: smallPng() },
  { type: 'image/png', filename: 'photo.png', content: smallPng(1200, 800) },
] })
const atts = (m: string) => k.db.query('SELECT ordinal, maybe_kyc, kyc_reason, image_facts, source_deleted FROM attachment WHERE message_id = $1 ORDER BY ordinal', [m])
const next = (caseId: string, stage: 'redact' | 'classify' = 'redact') => tx(k.db, (c) => restartFrom(c, k.queue, caseId, stage, 'system'))

it.each([false, true])('TC-PRV-12 upgraded messages retain legacy ordinals through transfer and verified replacement (oversize=%s)', async (oversize) => {
  const body = Buffer.from('Legacy attachment text')
  const raw = eml({ text: 'Hello', attachments: [
    { type: 'text/plain', disposition: 'attachmentish', content: body },
    { type: 'image/png', filename: 'passport.png', content: smallPng() },
    { type: 'text/plain', filename: 'notes.txt', content: 'Keep these notes' },
  ] })
  const limit = k.config.attachments.max_attachment_bytes
  if (oversize) k.config.attachments.max_attachment_bytes = 32
  const r = await k.ingest(raw).finally(() => { k.config.attachments.max_attachment_bytes = limit })
  if (r.status !== 'created') throw new Error('duplicated upgrade fixture')
  // The two ordinary parts already have their encrypted files. Recreate the pre-E6 row layout exactly.
  const legacyId = randomUUID(), hash = createHash('sha256').update(body).digest('hex')
  const key = objectKey(k.k, legacyId, hash)
  await k.files.put(key, body)
  const name = await tx(k.db, (c) => putBlob(c, k.k, ''))
  await k.t.owner.query('UPDATE message SET mime_version = 1 WHERE id = $1', [r.messageId])
  await k.t.owner.query('UPDATE attachment SET ordinal = ordinal + 10 WHERE message_id = $1', [r.messageId])
  await k.t.owner.query('UPDATE attachment SET ordinal = ordinal - 9, inline_eligible = NULL WHERE message_id = $1', [r.messageId])
  await k.t.owner.query(`INSERT INTO attachment (id, message_id, ordinal, depth, name_blob, kind, size, sha256, file_ref, scan_status, parse_status)
    VALUES ($1, $2, 0, 1, $3, 'txt', $4, $5, $6, 'pending', 'pending')`, [legacyId, r.messageId, name, body.length, hash, key])
  for (const stage of ['scan', 'parse', 'content_signals', 'extract', 'redact'] as const) await runStage(k, stage, { caseId: r.caseId, generation: 1 })
  expect((await atts(r.messageId)).rows.map((a) => a.maybe_kyc)).toEqual([false, true, false])
  const stored = (await k.db.query('SELECT file_ref, sha256 FROM attachment WHERE message_id = $1 AND ordinal = 1', [r.messageId])).rows[0]!
  if (oversize) expect(stored).toEqual({ file_ref: null, sha256: '' })
  let transferred: Buffer | null = null
  await runKycDeliveries(k, { async deliver(bytes, meta) { transferred = bytes; return sink.deliver(bytes, meta) } })
  expect((transferred as Buffer | null)?.equals(smallPng())).toBe(true)
  {
    const correct = createHash('sha256').update(smallPng()).digest('hex')
    const wrong = createHash('sha256').update('Keep these notes').digest('hex')
    await k.t.owner.query('UPDATE kyc_delivery SET sha256 = $2 WHERE message_id = $1', [r.messageId, wrong])
    await expect(replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).rejects.toThrow(/identity changed|does not match/)
    expect((await atts(r.messageId)).rows.every((a) => !a.source_deleted)).toBe(true)
    await k.t.owner.query('UPDATE kyc_delivery SET sha256 = $2 WHERE message_id = $1', [r.messageId, correct])
  }
  if (oversize) {
    await expect(replaceMessage({ ...k, db: k.t.maintenance }, r.messageId, { afterStep(n) { if (n === 3) throw new Error('pause after copy') } })).rejects.toThrow('pause after copy')
    const saved = (await k.db.query('SELECT original_file_ref, stripped_file_ref FROM kyc_replacement WHERE message_id = $1', [r.messageId])).rows[0]!
    const copy = await k.files.get(saved.stripped_file_ref)
    const correct = createHash('sha256').update(smallPng()).digest('hex')
    await k.t.owner.query('UPDATE kyc_delivery SET sha256 = $2 WHERE message_id = $1', [r.messageId, createHash('sha256').update('Keep these notes').digest('hex')])
    await expect(replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).rejects.toThrow('identity changed')
    await k.t.owner.query('UPDATE kyc_delivery SET sha256 = $2 WHERE message_id = $1', [r.messageId, correct])
    await k.files.deleteAllVersions(saved.stripped_file_ref)
    await expect(replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).rejects.toThrow()
    expect(await k.files.exists(saved.original_file_ref)).toBe(true)
    expect((await atts(r.messageId)).rows.every((a) => !a.source_deleted)).toBe(true)
    await k.files.put(saved.stripped_file_ref, copy)
  }
  expect(await replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).toBe('done')
  const ref = (await k.db.query("SELECT file_ref FROM message_file WHERE message_id = $1 AND kind = 'kyc_stripped'", [r.messageId])).rows[0]!.file_ref
  const copy = decodeMime(await k.files.get(ref), { maxAttachmentBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, legacyOrdinals: true })
  expect(copy.attachments.map((a) => a.filename)).toEqual(['', 'removed', 'notes.txt'])
  expect(copy.attachments[0]!.content?.equals(body)).toBe(true)
  expect(copy.attachments[2]!.content?.toString()).toBe('Keep these notes')
})

it('TC-RED-12 judgments and transfers precede classify; setup and database failures cannot roll them back; retries are idempotent', async () => {
  const r = await untilRedact(mail())
  expect((await atts(r.messageId)).rows.map((a) => a.maybe_kyc)).toEqual([false, true])
  expect((await atts(r.messageId)).rows[0]).toMatchObject({ kyc_reason: 'inline_signature', image_facts: { code: 'ok', width: 120, height: 40 } })
  const job = { caseId: r.caseId, generation: 1 }
  const failure = new SetupError('unavailable')
  const failing = { ...k, llm: { ...llm, complete: async () => { throw failure } } }
  await expect(runStage(failing, 'classify', job)).rejects.toThrow()
  await markFailed(k, 'classify', job, failure)
  expect((await k.db.query('SELECT 1 FROM kyc_delivery WHERE message_id = $1', [r.messageId])).rowCount).toBe(1)
  await k.t.owner.query(`CREATE FUNCTION test_classify_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional db detail' USING ERRCODE = '23505'; END $$;
    CREATE TRIGGER test_classify_failure BEFORE INSERT ON case_label FOR EACH ROW EXECUTE FUNCTION test_classify_failure()`)
  try {
    await expect(runStage(k, 'classify', job)).rejects.toThrow('fictional db detail')
    expect((await k.db.query('SELECT 1 FROM kyc_delivery WHERE message_id = $1', [r.messageId])).rowCount).toBe(1)
  } finally {
    await k.t.owner.query('DROP TRIGGER test_classify_failure ON case_label; DROP FUNCTION test_classify_failure()')
  }
  await runStage(k, 'redact', job)
  expect((await k.db.query('SELECT 1 FROM kyc_delivery WHERE message_id = $1', [r.messageId])).rowCount).toBe(1)
  await runKycDeliveries(k, sink)
  expect(await replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).toBe('done')
  expect((await k.db.query('SELECT failed_reason FROM "case" WHERE id = $1', [r.caseId])).rows[0]!.failed_reason).toBeNull()
})

it('TC-RED-12 NULL uses fresh checks; saved true withholds even if the new check allows it; every later stage uses the same image facts', async () => {
  const r = await untilRedact(mail())
  await k.t.owner.query('UPDATE attachment SET maybe_kyc = NULL WHERE message_id = $1 AND ordinal = 1', [r.messageId])
  const job = { caseId: r.caseId, generation: 1 }
  await runStage(k, 'classify', job)
  const request = llm.requests.at(-1)!.user
  expect(request).toContain('[image: not read]')
  expect(request).toContain('[content withheld: possible KYC document]')
  expect((await atts(r.messageId)).rows.map((a) => a.maybe_kyc)).toEqual([false, true])
  await k.t.owner.query('UPDATE attachment SET maybe_kyc = true WHERE message_id = $1 AND ordinal = 0', [r.messageId])
  const n = await next(r.caseId, 'classify')
  await runStage(k, 'classify', { caseId: r.caseId, generation: n.generation })
  expect(llm.requests.at(-1)!.user).not.toContain('[image: not read]')
  expect((await atts(r.messageId)).rows.map((a) => a.maybe_kyc)).toEqual([true, true])
})

it('TC-RED-12 stale jobs save no judgement or transfers; reusing a prior redact result still saves NULL judgements', async () => {
  const r = await untilRedact(mail())
  await k.t.owner.query('UPDATE attachment SET maybe_kyc = NULL WHERE message_id = $1', [r.messageId])
  const n = await next(r.caseId)
  expect(await runStage(k, 'redact', { caseId: r.caseId, generation: 1 })).toBe('stale')
  expect((await atts(r.messageId)).rows.map((a) => a.maybe_kyc)).toEqual([null, null])
  expect(await runStage(k, 'redact', { caseId: r.caseId, generation: n.generation })).toBe('reused')
  expect((await atts(r.messageId)).rows.map((a) => a.maybe_kyc)).toEqual([false, true])
})

it('TC-RED-12 / TC-PRV-12 a deferred false→true promotion is transferred after round one; round two strips the current copy', async () => {
  const r = await untilRedact(mail())
  const id = (await k.db.query('SELECT id FROM attachment WHERE message_id = $1 AND ordinal = 0', [r.messageId])).rows[0]!.id
  // Simulate a filename newly matching the KYC word list on re-run; the previous saved false is not authority to send it.
  const name = await tx(k.db, (c) => putBlob(c, k.k, 'passport.png'))
  await k.t.owner.query('UPDATE attachment SET name_blob = $2 WHERE id = $1', [id, name])
  const lock = await k.t.owner.connect()
  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 7340009))', [r.messageId])
    const n = await next(r.caseId)
    await runStage(k, 'redact', { caseId: r.caseId, generation: n.generation })
    expect((await atts(r.messageId)).rows[0]!.maybe_kyc).toBe(false)
    expect((await k.db.query("SELECT 1 FROM audit WHERE case_id = $1 AND type = 'kyc.reclassify_deferred'", [r.caseId])).rowCount).toBe(1)
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 7340009))', [r.messageId]); lock.release()
  }
  await runKycDeliveries(k, sink)
  // Pause round one after recording its copy: promotions must remain deferred even when the advisory lock is free.
  await expect(replaceMessage({ ...k, db: k.t.maintenance }, r.messageId, { afterStep(n) { if (n === 3) throw new Error('pause') } })).rejects.toThrow('pause')
  const pending = await next(r.caseId)
  await runStage(k, 'redact', { caseId: r.caseId, generation: pending.generation })
  expect((await atts(r.messageId)).rows[0]!.maybe_kyc).toBe(false)
  expect(await replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).toBe('done')
  const gen = (await k.db.query('SELECT processing_generation AS gen FROM "case" WHERE id = $1', [r.caseId])).rows[0]!.gen
  await runStage(k, 'extract', { caseId: r.caseId, generation: gen })
  await runStage(k, 'redact', { caseId: r.caseId, generation: gen })
  expect((await atts(r.messageId)).rows[0]!.maybe_kyc).toBe(true)
  expect(await replaceableMessages(k.db)).not.toContain(r.messageId) // new transfer has no receipt yet
  await runKycDeliveries(k, sink)
  expect(await replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).toBe('done')
  expect((await k.db.query('SELECT round, step FROM kyc_replacement WHERE message_id = $1 ORDER BY round', [r.messageId])).rows).toEqual([{ round: 1, step: 5 }, { round: 2, step: 5 }])
  expect((await atts(r.messageId)).rows.map((a) => a.source_deleted)).toEqual([true, true])
  const files = (await k.db.query('SELECT file_ref FROM message_file WHERE message_id = $1', [r.messageId])).rows
  expect(files).toHaveLength(1)
  const copy = decodeMime(await k.files.get(files[0]!.file_ref), { maxAttachmentBytes: 1e6, maxTotalBytes: 1e6 })
  expect(copy.attachments.map((a) => a.filename)).toEqual(['removed', 'removed'])
  expect((await loadMessage(k, r.messageId)).attachments.map((a) => a.maybeKyc)).toEqual([true, true])
})


it('TC-RED-12 a classify result in flight becomes stale when an earlier transfer completes and replacement continues the Case', async () => {
  const r = await untilRedact(mail())
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const model: LlmAdapter = { id: 'gated/model', location: 'local', async complete(req) { entered(); await gate; return llm.complete(req) } }
  const running = runStage({ ...k, llm: model }, 'classify', { caseId: r.caseId, generation: 1 })
  await ready
  try {
    await runKycDeliveries(k, sink)
    expect(await replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).toBe('done')
  } finally { release() }
  expect(await running).toBe('stale')
  expect((await k.db.query('SELECT 1 FROM stage_run WHERE case_id = $1 AND generation = 1 AND stage = $2', [r.caseId, 'classify'])).rowCount).toBe(0)
})


it('TC-FRD-17 a KYC transfer and replacement on a closed Case finish: the Case stays closed, with no new draft, task or routing change', async () => {
  const r = await untilRedact(mail())
  await k.drain()
  await k.t.owner.query(`UPDATE "case" SET status = 'closed', closed_at = now(), outcome = 'no_action' WHERE id = $1`, [r.caseId])
  const state = async () => (await k.db.query('SELECT status, queue, due_at, processing_generation AS g, pipeline_complete_generation AS done FROM "case" WHERE id = $1', [r.caseId])).rows[0]
  const before = await state()
  await runKycDeliveries(k, sink)
  expect(await replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).toBe('done')
  await k.drain()
  const after = await state()
  expect(after.g).toBe(before.g + 1)
  expect(after.done).toBe(after.g)
  expect({ status: after.status, queue: after.queue, due: after.due_at?.getTime() }).toEqual({ status: 'closed', queue: before.queue, due: before.due_at?.getTime() })
  expect((await k.db.query('SELECT 1 FROM reply WHERE case_id = $1', [r.caseId])).rowCount).toBe(0) // the replacement removed the draft; none came back
  expect((await k.db.query('SELECT 1 FROM verification_task WHERE case_id = $1', [r.caseId])).rowCount).toBe(0)
  expect((await k.db.query('SELECT 1 FROM attachment WHERE message_id = $1 AND source_deleted', [r.messageId])).rowCount).toBeGreaterThan(0)
})

it('TC-RED-12 / TC-PRV-12 deferred decisions survive workers finishing during step four, then retry automatically and resume round two after a crash', async () => {
  const { retryDeferredKyc } = await import('./kyc-recheck.ts')
  const r = await untilRedact(mail())
  const name = await tx(k.db, (c) => putBlob(c, k.k, 'passport.png'))
  await k.t.owner.query('UPDATE attachment SET name_blob = $2 WHERE message_id = $1 AND ordinal = 0', [r.messageId, name])
  await runKycDeliveries(k, sink)
  expect(await replaceMessage({ ...k, db: k.t.maintenance }, r.messageId, { async afterStep(n) { if (n === 4) await k.drain() } })).toBe('done')
  const before = (await k.db.query('SELECT maybe_kyc, kyc_recheck_pending FROM attachment WHERE message_id = $1 AND ordinal = 0', [r.messageId])).rows[0]
  expect(before).toEqual({ maybe_kyc: false, kyc_recheck_pending: true })
  expect(await retryDeferredKyc(k)).toBe(1)
  expect(await retryDeferredKyc(k)).toBe(0) // one new generation, no duplicate scheduling while it is in flight
  await k.drain()
  expect((await k.db.query('SELECT maybe_kyc, kyc_recheck_pending FROM attachment WHERE message_id = $1 AND ordinal = 0', [r.messageId])).rows[0]).toEqual({ maybe_kyc: true, kyc_recheck_pending: false })
  expect((await k.db.query('SELECT 1 FROM kyc_delivery WHERE message_id = $1', [r.messageId])).rowCount).toBe(2)
  await runKycDeliveries(k, sink)
  await expect(replaceMessage({ ...k, db: k.t.maintenance }, r.messageId, { afterStep(n) { if (n === 3) throw new Error('round two interrupted') } })).rejects.toThrow('round two interrupted')
  expect(await replaceMessage({ ...k, db: k.t.maintenance }, r.messageId)).toBe('done')
  expect((await atts(r.messageId)).rows.map((a) => a.source_deleted)).toEqual([true, true])
})
