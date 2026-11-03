// TC-PRV-03, TC-PRV-09 (PRD R-PRV-03, C-PRV-2 v0.7.18; tech design §4.1, §5, v0.7.9): KYC transfer and replacement under
// the real app / maintenance grants. One transfer per possible-KYC attachment; none replaced while one has failed; a
// failed transfer is retried daily and by an admin; the five steps resume after a crash and delete nothing before ③;
// a paused parse job's late result is discarded; the continuation re-runs the Case and nothing from the removed
// attachments comes back. Folder and webhook targets: generated names, receipts, HTTPS, no redirects.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { createKit, FakeLlm, type Kit } from '../pipeline/testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { decodeMime } from '../ingest/mime.ts'
import { makePdf } from '../../parser/testfiles.ts'
import { InProcessParser, type ParserClient } from '../pipeline/parser-client.ts'
import { restartFrom } from '../pipeline/restart.ts'
import { runStage, type StageDeps } from '../pipeline/stages.ts'
import { ingestMessage } from '../pipeline/ingest.ts'
import type { FileStore } from '../store/files.ts'
import type { StageJob } from '../pipeline/queue.ts'
import { appendAudit, verifyAudit } from '../store/audit.ts'
import { getBlobs, putBlob } from '../store/blobs.ts'
import { tx } from '../store/db.ts'
import { buildServer } from '../server/app.ts'
import { createSession, createUser } from '../server/auth.ts'
import { deleteMessage, runFileDeletions, runMessageRetention } from './retention.ts'
import { FolderSink, kycReminders, replaceMessage, runKycDeliveries, runKycReplacements, WebhookSink, type KycFile, type KycPoster, type KycReceipt, type KycSink } from './kyc.ts'

/** A parser that can be held before it returns (the «paused parse job»). */
class GatedParser implements ParserClient {
  readonly inner = new InProcessParser()
  gate: Promise<void> | null = null
  entered: (() => void) | null = null
  async parse(...a: Parameters<ParserClient['parse']>) {
    this.entered?.()
    if (this.gate) await this.gate
    return this.inner.parse(...a)
  }
}

/** Records every file; fails for the sequence numbers in `failing`. */
class RecordingSink implements KycSink {
  readonly got: Array<{ meta: KycFile; bytes: Buffer }> = []
  failing = new Set<number>()
  async deliver(bytes: Buffer, meta: KycFile): Promise<KycReceipt> {
    if (this.failing.has(meta.seq)) throw new Error('target down')
    this.got.push({ meta, bytes })
    return { target: 'folder', name: meta.name, sha256: meta.sha256 }
  }
}

let k: Kit
let app: FastifyInstance
const parser = new GatedParser()
const users: Record<string, { id: string; session: string; csrf: string }> = {}
const caseOf = (r: unknown) => (r as { caseId: string }).caseId
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const CANARIES = ['CANARY-KYC-PASSPORT', 'CANARY-KYC-ADDRESS', '987654', '9,876.54', '9876.54', '4321']

beforeAll(async () => {
  const llm = new FakeLlm()
  llm.reply = (v) => (v.startsWith('classify') ? '{"labels":[{"class":"kyc_documents","confidence":"high","reason":"documents"}],"language":"en"}' : '{"fields":{}}')
  k = await createKit({ parser, llm })
  app = await buildServer({ db: k.db, k: k.k, files: k.files, config: k.config, queue: k.boss })
  const root = await tx(k.db, (c) => createUser(c, k.k, { username: 'root', role: 'admin', password: null, by: null, mustChange: false }))
  for (const [name, role] of [['rita', 'reviewer'], ['paul', 'approver'], ['adam', 'admin']] as const) {
    const id = await tx(k.db, (c) => createUser(c, k.k, { username: name, role, password: null, by: root, mustChange: false }))
    users[name] = { id, ...(await createSession(k.db, k.k, id, 1, 12)) }
  }
}, 60_000)
afterAll(async () => {
  await app?.close()
  await k?.close()
})

const app_ = () => ({ db: k.t.app, k: k.k, files: k.files })
const mnt = () => ({ db: k.t.maintenance, k: k.k, files: k.files })
const as = (who: string) => ({ cookies: { doi_session: users[who]!.session }, headers: { 'x-csrf-token': users[who]!.csrf } })

function kycMail(id: string) {
  return eml({
    subject: `Onboarding documents ${id}`,
    messageId: `<${id}@x.example>`,
    text: 'Please find my documents and the invoice attached.',
    attachments: [
      { type: 'application/pdf', filename: 'passport.pdf', content: makePdf(['CANARY-KYC-PASSPORT P<GBRHART<<AMELIA paid GBP 9,876.54 from account ending 4321']) },
      { type: 'application/pdf', filename: 'invoice.pdf', content: makePdf(['Invoice 1042 total GBP 1,200.00']) },
      { type: 'application/pdf', filename: 'proof of address.pdf', content: makePdf(['CANARY-KYC-ADDRESS 14 Example Road']) },
    ],
  })
}

/** Every text blob and every stored file, decrypted, searched for the removed attachments' values. */
async function canariesLeft(): Promise<string[]> {
  const hits: string[] = []
  const ids = (await k.t.owner.query<{ id: string }>('SELECT id FROM secret_blob')).rows.map((r) => r.id)
  const blobs = await getBlobs(k.t.owner, k.k, ids)
  // the numeric canaries as tokens only: a random hash or UUID in a blob may contain "4321" (a CI flake, like
  // TC-AUD-06a's "5432"); a real leak ("ending 4321", "****4321", "9,876.54") is still a token
  const seen = (text: string, c: string) => (/^[\d.,]+$/.test(c) ? new RegExp(`(^|[^0-9a-fA-F])${c.replace(/[.]/g, '\\.')}(?![0-9a-fA-F])`).test(text) : text.includes(c))
  for (const [id, b] of blobs) for (const c of CANARIES) if (seen(b.toString('utf8'), c)) hits.push(`blob ${id}: ${c}`)
  const files = (await k.t.owner.query<{ key: string }>('SELECT file_ref AS key FROM message_file UNION SELECT file_ref FROM attachment WHERE file_ref IS NOT NULL')).rows
  for (const f of files) {
    const raw = await k.files.get(f.key)
    const m = decodeMime(raw, { maxAttachmentBytes: 1e9, maxTotalBytes: 1e9 })
    const all = [raw.toString('latin1'), ...m.attachments.map((a) => a.content?.toString('latin1') ?? '')].join('\n')
    for (const c of CANARIES.slice(0, 2)) if (all.includes(c)) hits.push(`file ${f.key}: ${c}`)
  }
  return hits
}

let derivedBefore: { replies: string[]; events: string[]; sent: string | null } = { replies: [], events: [], sent: null }
let sentEvent: { id: string; type: string; care_sha256: string } | null = null

describe('TC-PRV-03 KYC transfer and replacement', () => {
  let caseId: string
  let messageId: string
  const sink = new RecordingSink()

  it('TC-PRV-03 a transfer row per possible-KYC attachment is created when the judgement is saved', async () => {
    caseId = caseOf(await k.ingest(kycMail('kyc1')))
    await k.drain()
    messageId = (await k.t.owner.query<{ m: string }>('SELECT message_id AS m FROM "case" WHERE id = $1', [caseId])).rows[0]!.m
    const rows = await k.t.owner.query<{ seq: number; state: string }>('SELECT seq, state FROM kyc_delivery WHERE case_id = $1 ORDER BY seq', [caseId])
    expect(rows.rows).toEqual([{ seq: 1, state: 'pending' }, { seq: 3, state: 'pending' }])
    const audit = await k.t.owner.query<{ p: { kyc_transfers: number } }>("SELECT payload AS p FROM audit WHERE case_id = $1 AND type = 'stage.classify'", [caseId])
    expect(audit.rows[0]!.p.kyc_transfers).toBe(2)
    expect(await canariesLeft()).not.toEqual([]) // the canaries are there before
  })

  it('TC-PRV-03 one transfer succeeds, one fails → nothing is replaced, every row and file stays, a daily reminder; reviewer cannot retry, admin can', async () => {
    sink.failing = new Set([3])
    const before = {
      files: (await k.t.owner.query('SELECT file_ref FROM message_file WHERE message_id = $1 UNION ALL SELECT file_ref FROM attachment WHERE message_id = $1 AND file_ref IS NOT NULL', [messageId])).rowCount,
      texts: (await k.t.owner.query('SELECT 1 FROM attachment_text t JOIN attachment a ON a.id = t.attachment_id WHERE a.message_id = $1', [messageId])).rowCount,
    }
    for (let i = 0; i < 3; i++) await runKycDeliveries(app_(), sink)
    const st = await k.t.owner.query<{ seq: number; state: string; attempts: number; last_error: string | null }>('SELECT seq, state, attempts, last_error FROM kyc_delivery WHERE case_id = $1 ORDER BY seq', [caseId])
    expect(st.rows).toEqual([{ seq: 1, state: 'delivered', attempts: 1, last_error: null }, { seq: 3, state: 'failed', attempts: 3, last_error: 'delivery_failed' }])
    expect(await runKycReplacements(mnt())).toBe(0)
    expect((await k.t.owner.query('SELECT file_ref FROM message_file WHERE message_id = $1 UNION ALL SELECT file_ref FROM attachment WHERE message_id = $1 AND file_ref IS NOT NULL', [messageId])).rowCount).toBe(before.files)
    expect((await k.t.owner.query('SELECT 1 FROM attachment_text t JOIN attachment a ON a.id = t.attachment_id WHERE a.message_id = $1', [messageId])).rowCount).toBe(before.texts)
    expect((await k.t.owner.query('SELECT 1 FROM attachment WHERE message_id = $1 AND source_deleted', [messageId])).rowCount).toBe(0)
    // the daily reminder and the banner
    expect(await kycReminders(mnt())).toBe(1)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'kyc.delivery_pending' AND case_id = $1", [caseId])).rowCount).toBe(1)
    const session = (await app.inject({ method: 'GET', url: '/api/session', ...as('rita') })).json() as { warnings: string[] }
    expect(session.warnings.join(' ')).toMatch(/1 KYC attachment transfer has failed/)
    // the detail shows each transfer
    const detail = (await app.inject({ method: 'GET', url: `/api/cases/${caseId}`, ...as('rita') })).json() as { attachments: Array<{ ordinal: number; kycTransfer: { id: string; state: string } | null }> }
    expect(detail.attachments.map((a) => a.kycTransfer?.state ?? null)).toEqual(['delivered', null, 'failed'])
    const failedId = detail.attachments[2]!.kycTransfer!.id
    expect((await app.inject({ method: 'POST', url: `/api/kyc/deliveries/${failedId}/retry`, payload: {}, ...as('rita') })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/kyc/deliveries/${failedId}/retry`, payload: {}, ...as('adam') })).statusCode).toBe(200)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'kyc.delivery_retry' AND actor = $1", [users.adam!.id])).rowCount).toBe(1)
    expect((await app.inject({ method: 'POST', url: `/api/kyc/deliveries/${failedId}/retry`, payload: {}, ...as('adam') })).statusCode).toBe(409) // now pending
    // still failing → back to failed after the quick attempts
    for (let i = 0; i < 3; i++) await runKycDeliveries(app_(), sink)
    expect((await k.t.owner.query<{ state: string }>('SELECT state FROM kyc_delivery WHERE id = $1', [failedId])).rows[0]!.state).toBe('failed')
  })

  it('TC-PRV-03 the target comes back after three days → the daily run retries and delivers; then the replacement runs', async () => {
    await runKycDeliveries(app_(), sink) // a normal run does not touch failed transfers
    expect((await k.t.owner.query("SELECT 1 FROM kyc_delivery WHERE case_id = $1 AND state = 'failed'", [caseId])).rowCount).toBe(1)
    await runKycDeliveries(app_(), sink, { includeFailed: true }) // day 1: still down
    sink.failing = new Set()
    await runKycDeliveries(app_(), sink, { includeFailed: true }) // day 3: back
    expect((await k.t.owner.query("SELECT state FROM kyc_delivery WHERE case_id = $1 AND state <> 'delivered'", [caseId])).rowCount).toBe(0)
    // generated names, and the bytes are the attachments' own
    expect(sink.got.map((g) => g.meta.name)).toEqual([`${caseId}-1.pdf`, `${caseId}-3.pdf`])
    for (const g of sink.got) expect(sha(g.bytes)).toBe(g.meta.sha256)
  })

  it('TC-PRV-03 crash at ② → nothing deleted, starts over; crash inside ④ → rolled back; crash after ④ → resumes at ⑤; files go through file_deletion_job', async () => {
    const original = (await k.t.owner.query<{ file_ref: string }>("SELECT file_ref FROM message_file WHERE message_id = $1 AND kind = 'original'", [messageId])).rows[0]!.file_ref
    const attFiles = (await k.t.owner.query<{ file_ref: string }>('SELECT file_ref FROM attachment WHERE message_id = $1 AND maybe_kyc', [messageId])).rows.map((r) => r.file_ref)
    await k.t.owner.query('UPDATE "case" SET hold = true WHERE id = $1', [caseId]) // a hold does not stop the KYC deletion (C-PRV-1)
    // derived before the replacement (C-PRV-2 ④ v0.7.19): unsent replies, undelivered events, a person's field edit; one
    // sent reply stays
    // a person's field edit through the real API: its audit detail holds before / after (Codex round 2 F2)
    const put = await app.inject({ method: 'PUT', url: `/api/cases/${caseId}/fields/document_types`, payload: { value: ['other'] }, ...as('adam') })
    expect(put.statusCode, put.body).toBeLessThan(300)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE case_id = $1 AND type = 'case.field_changed'", [caseId])).rowCount).toBeGreaterThan(0)
    await k.drain()
    const sentReply = (await k.t.owner.query<{ id: string }>("UPDATE reply SET status = 'sent' WHERE id = (SELECT id FROM reply WHERE case_id = $1 ORDER BY created_at LIMIT 1) RETURNING id", [caseId])).rows[0]?.id
    // a reply revision's detail holds the reply text (Codex round 3 F1); written as the revise action writes it
    await tx(k.t.app, (c) => appendAudit(c, k.k, [{ actor: users.adam!.id, type: 'reply.revised', caseId, payload: { reply: 'r' }, detail: { before: 'x', after: 'Date of birth CANARY-KYC-PASSPORT' } }]))
    // one event was delivered: its value stays the state's value for its type (regression review S1)
    const delivered = (await k.t.owner.query<{ id: string; type: string; care_sha256: string }>("UPDATE event_outbox SET status = 'sent' WHERE id = (SELECT id FROM event_outbox WHERE case_id = $1 ORDER BY case_event_seq LIMIT 1) RETURNING id, type, care_sha256", [caseId])).rows[0]!
    sentEvent = delivered
    derivedBefore = {
      replies: (await k.t.owner.query<{ id: string }>("SELECT id FROM reply WHERE case_id = $1 AND status <> 'sent'", [caseId])).rows.map((r) => r.id),
      events: (await k.t.owner.query<{ id: string }>("SELECT id FROM event_outbox WHERE case_id = $1 AND status <> 'sent'", [caseId])).rows.map((r) => r.id),
      sent: sentReply ?? null,
    }
    expect(derivedBefore.events.length).toBeGreaterThan(0)
    const crash = (at: number) => ({ afterStep: (s: number) => { if (s === at) throw new Error(`crash at ${s}`) } })
    await expect(replaceMessage(mnt(), messageId, crash(2))).rejects.toThrow('crash at 2')
    expect((await k.t.owner.query<{ step: number }>('SELECT step FROM kyc_replacement WHERE message_id = $1', [messageId])).rows[0]!.step).toBe(0)
    for (const f of [original, ...attFiles]) expect(await k.files.exists(f)).toBe(true)
    expect((await k.t.owner.query('SELECT 1 FROM file_deletion_job')).rowCount).toBe(0)
    expect((await k.t.owner.query("SELECT 1 FROM message_file WHERE message_id = $1 AND kind = 'kyc_stripped'", [messageId])).rowCount).toBe(0)

    await expect(replaceMessage(mnt(), messageId, crash(3))).rejects.toThrow('crash at 3')
    expect((await k.t.owner.query<{ step: number }>('SELECT step FROM kyc_replacement WHERE message_id = $1', [messageId])).rows[0]!.step).toBe(3)
    for (const f of [original, ...attFiles]) expect(await k.files.exists(f)).toBe(true)

    await expect(replaceMessage(mnt(), messageId, crash(4))).rejects.toThrow('crash at 4')
    expect((await k.t.owner.query<{ step: number }>('SELECT step FROM kyc_replacement WHERE message_id = $1', [messageId])).rows[0]!.step).toBe(4)
    expect((await k.t.owner.query("SELECT 1 FROM file_deletion_job WHERE reason = 'kyc'")).rowCount).toBe(3)

    expect(await replaceMessage(mnt(), messageId)).toBe('done')
    expect((await k.t.owner.query<{ step: number }>('SELECT step FROM kyc_replacement WHERE message_id = $1', [messageId])).rows[0]!.step).toBe(5)
    expect(await runFileDeletions(mnt())).toEqual({ done: 3, failed: 0 })
    for (const f of [original, ...attFiles]) expect(await k.files.exists(f)).toBe(false)
    // the stripped copy: same ordinals, the KYC parts replaced; hashes recorded; one audit row with hashes only
    const stripped = (await k.t.owner.query<{ file_ref: string; sha256: string }>("SELECT file_ref, sha256 FROM message_file WHERE message_id = $1", [messageId])).rows
    expect(stripped.length).toBe(1)
    const m = decodeMime(await k.files.get(stripped[0]!.file_ref), { maxAttachmentBytes: 1e9, maxTotalBytes: 1e9 })
    expect(m.attachments.map((a) => a.filename)).toEqual(['removed', 'invoice.pdf', 'removed'])
    const audit = await k.t.owner.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit WHERE type = 'kyc.replaced' AND case_id = $1", [caseId])
    expect(audit.rows[0]!.payload).toMatchObject({ message: messageId, stripped_sha256: stripped[0]!.sha256, attachments: 2 })
    expect((await verifyAudit(k.t.app)).ok).toBe(true)
  })

  it('TC-PRV-03 the continuation re-runs the Case to completion; nothing from the removed attachments is left or comes back; no new transfer', async () => {
    const before = (await k.t.owner.query<{ g: number }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [caseId])).rows[0]!.g
    await k.drain()
    const cs = (await k.t.owner.query<{ g: number; done: number; status: string }>('SELECT processing_generation AS g, pipeline_complete_generation AS done, status FROM "case" WHERE id = $1', [caseId])).rows[0]!
    expect(cs.g).toBe(before)
    expect(cs.done).toBe(cs.g)
    // done in the current generation, with a draft of this generation that can be approved
    expect(cs.status).toBe('open')
    expect((await k.t.owner.query("SELECT 1 FROM reply WHERE case_id = $1 AND generation = $2 AND status = 'draft' AND check_ok", [caseId, cs.g])).rowCount).toBe(1)
    expect((await k.t.owner.query("SELECT 1 FROM stage_run WHERE case_id = $1 AND generation = $2 AND stage = 'emit'", [caseId, cs.g])).rowCount).toBe(1)
    expect(await canariesLeft()).toEqual([])
    expect((await k.t.owner.query('SELECT 1 FROM kyc_delivery WHERE case_id = $1', [caseId])).rowCount).toBe(2)
    // C-PRV-2 ④ v0.7.19: the derived rows from before are gone, the sent reply stays, no person's edit is left
    expect((await k.t.owner.query('SELECT 1 FROM reply WHERE id::text = ANY ($1::text[])', [derivedBefore.replies])).rowCount).toBe(0)
    // undelivered events are withdrawn, not deleted (sequence kept, placeholder content), and made again by the re-run
    const withdrawn = await k.t.owner.query<{ status: string; type: string }>('SELECT status, type FROM event_outbox WHERE id::text = ANY ($1::text[])', [derivedBefore.events])
    expect(withdrawn.rows.every((r) => r.status === 'withdrawn')).toBe(true)
    const again = await k.t.owner.query<{ type: string }>("SELECT type FROM event_outbox WHERE case_id = $1 AND status <> 'withdrawn' AND created_at > (SELECT finished_at FROM kyc_replacement WHERE message_id = $2)", [caseId, messageId])
    expect(new Set(again.rows.map((r) => r.type))).toEqual(new Set(withdrawn.rows.map((r) => r.type)))
    // the delivered event stays, and its type was not re-sent when its value did not change (C-OUT-1)
    expect((await k.t.owner.query<{ status: string }>('SELECT status FROM event_outbox WHERE id = $1', [sentEvent!.id])).rows[0]!.status).toBe('sent')
    const st = (await k.t.owner.query<{ care_sha256: string }>('SELECT care_sha256 FROM event_state WHERE case_id = $1 AND type = $2', [caseId, sentEvent!.type])).rows[0]
    expect(st?.care_sha256).toBeDefined()
    const seqs = (await k.t.owner.query<{ s: number }>('SELECT case_event_seq AS s FROM event_outbox WHERE case_id = $1 ORDER BY 1', [caseId])).rows.map((r) => r.s)
    expect(new Set(seqs).size).toBe(seqs.length)
    if (derivedBefore.sent) expect((await k.t.owner.query('SELECT 1 FROM reply WHERE id = $1', [derivedBefore.sent])).rowCount).toBe(1)
    expect((await k.t.owner.query('SELECT 1 FROM case_field_change WHERE case_id = $1', [caseId])).rowCount).toBe(0)
    // and the person's edit leaves no detail with its before / after (round 2 F2); the audit row itself stays
    expect((await k.t.owner.query("SELECT 1 FROM audit_detail d JOIN audit a ON a.payload->>'detail_sha256' = d.sha256 AND a.case_id = d.case_id WHERE a.type = 'case.field_changed' AND a.case_id = $1", [caseId])).rowCount).toBe(0)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'case.field_changed' AND case_id = $1", [caseId])).rowCount).toBeGreaterThan(0)
    expect((await k.t.owner.query("SELECT 1 FROM audit_detail d JOIN audit a ON a.payload->>'detail_sha256' = d.sha256 AND a.case_id = d.case_id WHERE a.type = 'reply.revised' AND a.case_id = $1", [caseId])).rowCount).toBe(0)
    expect((await k.t.owner.query("SELECT 1 FROM case_link WHERE case_id = $1 AND source = 'auto' AND created_at < (SELECT finished_at FROM kyc_replacement WHERE message_id = $2)", [caseId, messageId])).rowCount).toBe(0)
    // the invoice's values are still extracted
    const ex = (await k.t.owner.query<{ b: string }>("SELECT result_blob AS b FROM stage_run WHERE case_id = $1 AND stage = 'extract' AND generation = $2", [caseId, cs.g])).rows[0]!
    const text = (await getBlobs(k.t.owner, k.k, [ex.b])).get(ex.b)!.toString('utf8')
    expect(text).toContain('120000')
  })
})

describe('TC-PRV-03 a parse job paused before it publishes', () => {
  it('TC-PRV-03 its result is discarded after the replacement; no derived data is written back', async () => {
    const sink = new RecordingSink()
    const caseId = caseOf(await k.ingest(kycMail('kyc2')))
    await k.drain()
    const messageId = (await k.t.owner.query<{ m: string }>('SELECT message_id AS m FROM "case" WHERE id = $1', [caseId])).rows[0]!.m
    await runKycDeliveries(app_(), sink)
    // a re-parse of every attachment is queued (a new generation from parse)
    await k.t.owner.query("UPDATE attachment SET parse_status = 'pending' WHERE message_id = $1", [messageId])
    const g = await tx(k.t.app, (c) => restartFrom(c, k.boss, caseId, 'parse', 'system'))
    const jobs = await k.boss.boss.fetch<StageJob>('parse', { batchSize: 10 })
    const job = jobs.find((j) => j.data.caseId === caseId)!
    expect(job.data.generation).toBe(g.generation)
    let release!: () => void
    parser.gate = new Promise((r) => (release = r))
    const entered = new Promise<void>((r) => (parser.entered = r))
    const deps: StageDeps = k
    const paused = runStage(deps, 'parse', job.data)
    await entered
    // meanwhile the replacement runs to the end
    expect(await replaceMessage(mnt(), messageId)).toBe('done')
    parser.gate = null
    parser.entered = null
    release()
    expect(await paused).toBe('stale')
    await k.boss.boss.complete('parse', job.id)
    const kycIds = (await k.t.owner.query<{ id: string }>('SELECT id FROM attachment WHERE message_id = $1 AND maybe_kyc', [messageId])).rows.map((r) => r.id)
    expect((await k.t.owner.query('SELECT 1 FROM attachment_text WHERE attachment_id = ANY ($1::uuid[])', [kycIds])).rowCount).toBe(0)
    await k.drain()
    await runFileDeletions(mnt())
    expect(await canariesLeft()).toEqual([])
  })
})

describe('TC-PRV-03 a possible-KYC attachment blocked by the virus scan (R-PRV-03 v0.7.19)', () => {
  it('TC-PRV-03 never sent, kept and reminded; only an admin with a reason marks it handled, then the replacement goes ahead', async () => {
    const sink = new RecordingSink()
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
    const caseId = caseOf(await k.ingest(eml({ subject: 'Onboarding blocked', messageId: '<kyc3@x.example>', text: 'Passport attached.', attachments: [{ type: 'application/pdf', filename: 'passport.pdf', content: Buffer.from(eicar) }] })))
    await k.drain()
    const messageId = (await k.t.owner.query<{ m: string }>('SELECT message_id AS m FROM "case" WHERE id = $1', [caseId])).rows[0]!.m
    await runKycDeliveries(app_(), sink)
    await runKycDeliveries(app_(), sink, { includeFailed: true })
    const row = (await k.t.owner.query<{ id: string; state: string; last_error: string }>('SELECT id, state, last_error FROM kyc_delivery WHERE case_id = $1', [caseId])).rows[0]!
    expect(row).toMatchObject({ state: 'failed', last_error: 'infected' })
    expect(sink.got.filter((g) => g.meta.caseId === caseId)).toEqual([])
    expect(await runKycReplacements(mnt())).toBe(0)
    expect(await kycReminders(mnt())).toBeGreaterThanOrEqual(1)
    const url = `/api/kyc/deliveries/${row.id}/discard`
    for (const who of ['rita', 'paul']) expect((await app.inject({ method: 'POST', url, payload: { reason: 'x' }, ...as(who) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url, payload: { reason: ' ' }, ...as('adam') })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url, payload: { reason: 'Asked the investor to send a clean copy CANARY-HANDLED' }, ...as('adam') })).statusCode).toBe(200)
    const audit = await k.t.owner.query<{ actor: string; payload: unknown }>("SELECT actor, payload FROM audit WHERE type = 'kyc.discarded' AND case_id = $1", [caseId])
    expect(audit.rows.map((r) => r.actor)).toEqual([users.adam!.id])
    expect(JSON.stringify(audit.rows)).not.toContain('CANARY-HANDLED')
    expect(await replaceMessage(mnt(), messageId)).toBe('done')
    await runFileDeletions(mnt())
    expect((await k.t.owner.query("SELECT 1 FROM message_file WHERE message_id = $1 AND kind = 'original'", [messageId])).rowCount).toBe(0)
    expect((await k.t.owner.query('SELECT 1 FROM attachment WHERE message_id = $1 AND source_deleted', [messageId])).rowCount).toBe(1)
  })
})

describe('TC-PRV-03 self-test fixes (F2, F4, F1)', () => {
  it('TC-PRV-03 a message with a missing closing boundary is still stripped (F2); retention waits for a running replacement without blocking (F4)', async () => {
    const sink = new RecordingSink()
    // a complete outer multipart: text, passport.pdf, then a nested multipart whose closing boundary is missing;
    // ingest keeps the parts decoded before the problem (TC-ING-11), the stripping must do the same
    const pdf = makePdf(['CANARY-KYC-PASSPORT P<GBRHART<<AMELIA']).toString('base64')
    const cut = Buffer.from([
      'From: Amelia Hart <amelia@hartfamily.example>', 'To: ops@capital.example', 'Subject: Onboarding broken', 'Message-ID: <kyc4@x.example>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="OUT"', '', '--OUT', 'Content-Type: text/plain', '', 'My passport is attached.', '--OUT',
      'Content-Type: application/pdf; name="passport.pdf"', 'Content-Disposition: attachment; filename="passport.pdf"', 'Content-Transfer-Encoding: base64', '', pdf, '--OUT',
      'Content-Type: multipart/alternative; boundary="IN"', '', '--IN', 'Content-Type: text/plain', '', 'never closed', '--OUT--', '',
    ].join('\r\n'), 'latin1')
    const caseId = caseOf(await k.ingest(cut))
    await k.drain()
    const messageId = (await k.t.owner.query<{ m: string }>('SELECT message_id AS m FROM "case" WHERE id = $1', [caseId])).rows[0]!.m
    expect((await k.t.owner.query('SELECT 1 FROM attachment WHERE message_id = $1 AND maybe_kyc', [messageId])).rowCount).toBeGreaterThan(0)
    await runKycDeliveries(app_(), sink)
    let during: string | null = null
    const out = await replaceMessage(mnt(), messageId, { afterStep: async (n) => { if (n === 1) during = await deleteMessage(mnt(), messageId, null) } })
    expect(out).toBe('done')
    expect(during).toBe('busy')
    await runFileDeletions(mnt())
    await k.drain()
    expect(await canariesLeft()).toEqual([])
  })

  it('TC-PRV-03 a duplicate ingest that writes its files after the KYC deletion does not bring the original back (Codex E4 F5)', async () => {
    const raw = kycMail('kyc5')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let entered!: () => void
    const inPut = new Promise<void>((r) => (entered = r))
    const slow: FileStore = new Proxy(k.files, {
      get(t, p) {
        if (p === 'put') return async (key: string, data: Buffer) => { entered(); await gate; return t.put(key, data) }
        const v = Reflect.get(t, p) as unknown
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
      },
    })
    // B passes the duplicate check first and stalls before writing its files
    const b = ingestMessage({ ...k, files: slow }, k.mailbox, raw, '2026-10-29T10:15:00.000Z')
    await inPut
    // meanwhile A records the message, the transfers succeed and the replacement deletes the original
    const caseId = caseOf(await k.ingest(raw))
    await k.drain()
    const messageId = (await k.t.owner.query<{ m: string }>('SELECT message_id AS m FROM "case" WHERE id = $1', [caseId])).rows[0]!.m
    const original = (await k.t.owner.query<{ file_ref: string }>("SELECT file_ref FROM message_file WHERE message_id = $1 AND kind = 'original'", [messageId])).rows[0]!.file_ref
    await runKycDeliveries(app_(), new RecordingSink())
    expect(await replaceMessage(mnt(), messageId)).toBe('done')
    await runFileDeletions(mnt())
    expect(await k.files.exists(original)).toBe(false)
    release()
    expect((await b).status).toBe('duplicate')
    expect(await k.files.exists(original)).toBe(false)
  })

  it('TC-PRV-03 step ④ waits for a delivery that holds the Case lock (Codex round 2 F3)', async () => {
    const caseId = caseOf(await k.ingest(kycMail('kyc6')))
    await k.drain()
    const messageId = (await k.t.owner.query<{ m: string }>('SELECT message_id AS m FROM "case" WHERE id = $1', [caseId])).rows[0]!.m
    await runKycDeliveries(app_(), new RecordingSink())
    const { outboxLockKey } = await import('../pipeline/outbox.ts')
    const holder = await k.t.owner.connect()
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [outboxLockKey(caseId)]) // a delivery is sending
      let done = false
      const run = replaceMessage(mnt(), messageId).then((r) => ((done = true), r))
      await new Promise((r) => setTimeout(r, 400))
      expect(done).toBe(false)
      expect((await k.t.owner.query<{ step: number }>('SELECT step FROM kyc_replacement WHERE message_id = $1', [messageId])).rows[0]?.step ?? 0).toBeLessThan(4)
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [outboxLockKey(caseId)])
      expect(await run).toBe('done')
    } finally {
      holder.release()
    }
  })

  it('TC-PRV-03 the stripped copy taken by the orphan clean-up before step ③ is written again (round 4 F2); a legacy delivered event keeps its type re-sendable (round 4 F4)', async () => {
    const caseId = caseOf(await k.ingest(kycMail('kyc7')))
    await k.drain()
    const messageId = (await k.t.owner.query<{ m: string }>('SELECT message_id AS m FROM "case" WHERE id = $1', [caseId])).rows[0]!.m
    await runKycDeliveries(app_(), new RecordingSink())
    // a delivered event from before migration 004 (no stored value) and a later undelivered one of the same type
    const first = (await k.t.owner.query<{ type: string; case_event_seq: number; event_blob: string }>("UPDATE event_outbox SET status = 'sent', care_blob = NULL, care_sha256 = NULL WHERE id = (SELECT id FROM event_outbox WHERE case_id = $1 ORDER BY case_event_seq LIMIT 1) RETURNING type, case_event_seq, event_blob", [caseId])).rows[0]!
    const seq = (await k.t.owner.query<{ n: number }>('SELECT max(case_event_seq)::int AS n FROM event_outbox WHERE case_id = $1', [caseId])).rows[0]!.n + 1
    const blob = await tx(k.t.app, (c) => putBlob(c, k.k, '{"pending":true}'))
    await k.t.owner.query("INSERT INTO event_outbox (id, case_id, case_event_seq, type, event_blob, status) VALUES ($1, $2, $3, $4, $5, 'pending')", [`legacy-${seq}`, caseId, seq, first.type, blob])
    const out = await replaceMessage(mnt(), messageId, {
      afterStep: async (n) => {
        if (n !== 2) return
        const key = (await k.t.owner.query<{ object_key: string }>("SELECT object_key FROM file_write_intent WHERE purpose = 'kyc_stripped' ORDER BY created_at DESC LIMIT 1")).rows[0]!.object_key
        await k.files.deleteAllVersions(key) // the orphan clean-up, between verification and registration
      },
    })
    expect(out).toBe('done')
    const stripped = (await k.t.owner.query<{ file_ref: string }>("SELECT file_ref FROM message_file WHERE message_id = $1 AND kind = 'kyc_stripped'", [messageId])).rows[0]!.file_ref
    expect(await k.files.exists(stripped)).toBe(true)
    const st = (await k.t.owner.query<{ care_sha256: string }>('SELECT care_sha256 FROM event_state WHERE case_id = $1 AND type = $2', [caseId, first.type])).rows[0]
    expect(st?.care_sha256).toMatch(/^[0-9a-f]{64}$/) // a typed value rebuilt from the delivered event (round 5 F2)
    // and the continuation completes, events included
    await k.drain()
    const cs = (await k.t.owner.query<{ g: number; done: number }>('SELECT processing_generation AS g, pipeline_complete_generation AS done FROM "case" WHERE id = $1', [caseId])).rows[0]!
    expect(cs.done).toBe(cs.g)
  })

  it('TC-PRV-02 retention deletes messages that have KYC transfer and replacement rows (F1), under the maintenance grants', async () => {
    await k.t.owner.query('UPDATE "case" SET hold = false') // an earlier test held one
    const r = await runMessageRetention(mnt(), { messages_days: 1, directory_days: 'forever' }, new Date(Date.now() + 400 * 86_400_000))
    expect(r.deleted).toBeGreaterThan(0)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'retention.failed'")).rowCount).toBe(0)
    expect((await k.t.owner.query('SELECT 1 FROM kyc_delivery UNION ALL SELECT 1 FROM kyc_replacement UNION ALL SELECT 1 FROM message')).rowCount).toBe(0)
  })
})

describe('TC-PRV-09 targets', () => {
  const meta = (seq: number, body: Buffer): KycFile => ({ deliveryId: '0b0c0d0e-0000-4000-8000-000000000001', caseId: '0b0c0d0e-0000-4000-8000-0000000000aa', seq, name: `0b0c0d0e-0000-4000-8000-0000000000aa-${seq}.pdf`, sha256: sha(body) })

  it('TC-PRV-09 folder: the generated name only, written whole; no temporary file is left', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doi-kyc-'))
    const body = makePdf(['x'])
    const r = await new FolderSink(dir).deliver(body, meta(1, body))
    expect(r).toEqual({ target: 'folder', name: meta(1, body).name, sha256: sha(body) })
    expect(readdirSync(dir)).toEqual([meta(1, body).name])
    expect(readFileSync(join(dir, meta(1, body).name)).equals(body)).toBe(true)
    await expect(new FolderSink(dir).deliver(body, { ...meta(1, body), name: '../passport.pdf' })).rejects.toThrow('bad_name')
  })

  it('TC-PRV-09 webhook: HTTPS only; signed with the idempotency key; success only with the matching receipt; a redirect is a failure', async () => {
    expect(() => new WebhookSink('http://kyc.example/in', 's')).toThrow(/https/)
    const body = makePdf(['y'])
    const m = meta(2, body)
    const sent: Array<{ body: string; headers: Record<string, string> }> = []
    const answer = (status: number, text: string): KycPoster => async (_u, b, h) => {
      sent.push({ body: b, headers: h })
      return { status, body: text }
    }
    const ok = JSON.stringify({ delivery_id: m.deliveryId, sha256: m.sha256 })
    expect(await new WebhookSink('https://kyc.example/in', 's', answer(200, ok)).deliver(body, m)).toMatchObject({ target: 'webhook' })
    expect(sent[0]!.headers['idempotency-key']).toBe(m.deliveryId)
    expect(sent[0]!.headers['x-dealops-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ delivery_id: m.deliveryId, filename: m.name, sha256: m.sha256 })
    for (const [status, text, code] of [
      [200, '', 'webhook_no_receipt'],
      [200, '<html>maintenance</html>', 'webhook_no_receipt'],
      [200, JSON.stringify({ delivery_id: m.deliveryId, sha256: 'f'.repeat(64) }), 'webhook_receipt_mismatch'],
      [200, JSON.stringify({ delivery_id: 'other', sha256: m.sha256 }), 'webhook_receipt_mismatch'],
      [302, ok, 'webhook_http_302'],
      [500, ok, 'webhook_http_500'],
    ] as const) {
      await expect(new WebhookSink('https://kyc.example/in', 's', answer(status, text)).deliver(body, m)).rejects.toMatchObject({ code })
    }
    const redirecting: KycPoster = async () => {
      throw new TypeError('fetch failed: redirect mode is set to error')
    }
    await expect(new WebhookSink('https://kyc.example/in', 's', redirecting).deliver(body, m)).rejects.toMatchObject({ code: 'webhook_unreachable' })
  })
})
