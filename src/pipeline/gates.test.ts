// PRD C-FRD-6, C-FRD-7, C-FRD-8, C-DRF-9, C-DRF-10, C-DRF-11 (v0.7.30) through the pipeline and the review actions, on
// the test Postgres. Every sequence of the plan reviews has a test here.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createKit, FakeLlm, testConfig, type Kit } from './testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { markFailed, resultOf, runStage, type FieldsResult } from './stages.ts'
import { STAGES, type Stage, type StageJob } from './queue.ts'
import { retryDeferredKyc } from './kyc-recheck.ts'
import { fraudGatesRollout } from './rollout.ts'
import { buildServer } from '../server/app.ts'
import { createSession, createUser } from '../server/auth.ts'
import { tx, type Db } from '../store/db.ts'
import { blobColumns, deleteMessage } from '../maintenance/retention.ts'
import { replaceMessage, runKycDeliveries, type KycFile, type KycReceipt, type KycSink } from '../maintenance/kyc.ts'
import { restartFrom } from './restart.ts'
import { makePdf } from '../../parser/testfiles.ts'

let k: Kit
let app: FastifyInstance
const llm = new FakeLlm()
const classes = new Map<string, string[]>()
const fieldAnswers = new Map<string, string>() // subject → the model's field answer
const AUTH: Array<[string, string]> = [['Authentication-Results', 'mx.ops.example; spf=pass; dkim=pass; dmarc=pass']]
const TRUSTED = { id: 'ops', trustedAuthResults: true, trustedAuthservId: 'mx.ops.example' }
const users: Record<string, { id: string; session: string; csrf: string }> = {}
const DAY = 86_400_000

beforeAll(async () => {
  llm.reply = (v, user) => {
    if (!v.startsWith('classify')) return [...fieldAnswers].find(([sub]) => user.includes(sub))?.[1] ?? '{"fields":{}}'
    const subject = /<subject>([^<]*)<\/subject>/.exec(user)?.[1] ?? ''
    const list = [...classes].find(([s]) => subject.includes(s))?.[1] ?? ['unclassified']
    return JSON.stringify({ labels: list.map((c) => ({ class: c.split(':')[0], confidence: c.split(':')[1] ?? 'high', reason: 'test' })), language: 'en' })
  }
  k = await createKit({ config: { ...testConfig(), verification: { cooling_off_hours: 1 } }, llm })
  await k.importCsv('deals', 'name,currency,close_date\nNorthwind Robotics,GBP,2026-12-18\n')
  await k.importCsv('commitments', 'investor_id,name,email,reference,cash_due\n001,Amelia Hart,amelia@hartfamily.example,NW-001,"10,000.00"\n002,Oliver Bennett,oliver@bennett.example,NW-002,"5,000.00"\n', 'Northwind Robotics')
  await k.importCsv('contacts', CONTACTS)
  app = await buildServer({ db: k.db, k: k.k, files: k.files, config: k.config, queue: k.boss })
  const old = new Date(Date.now() - 30 * DAY).toISOString()
  const root = await tx(k.db, (c) => createUser(c, k.k, { username: 'root', role: 'admin', password: null, by: null, mustChange: false }))
  for (const [name, role] of [['rita', 'reviewer'], ['rob', 'reviewer'], ['paul', 'approver'], ['petra', 'approver'], ['adam', 'admin']] as const) {
    const id = await tx(k.db, (c) => createUser(c, k.k, { username: name, role, password: null, by: root, mustChange: false }))
    const s = await createSession(k.db, k.k, id, 1, 12)
    users[name] = { id, ...s }
  }
  await k.t.owner.query('UPDATE user_event SET at = $1', [old])
}, 120_000)
afterAll(async () => {
  await app?.close()
  await k?.close()
})

const CONTACTS = 'contact_id,name,email,phone,role,deal,investor_id\nC001,Amelia Hart,amelia@hartfamily.example,+44 7700 900101,investor,Northwind Robotics,Northwind Robotics::001\nC002,Oliver Bennett,oliver@bennett.example,+44 7700 900102,investor,Northwind Robotics,Northwind Robotics::002\n'
const as = (who: string) => ({ cookies: { doi_session: users[who]!.session }, headers: { 'x-csrf-token': users[who]!.csrf } })
const post = (who: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload, ...as(who) })
const put = (who: string, url: string, payload: object) => app.inject({ method: 'PUT', url, payload, ...as(who) })
const view = async (who: string, id: string) => (await app.inject({ method: 'GET', url: `/api/cases/${id}`, ...as(who) })).json().e3
const one = async <T>(sql: string, args: unknown[] = []) => (await k.db.query(sql, args)).rows[0] as T
const count = async (sql: string, args: unknown[]) => (await k.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, args)).rows[0]!.n
const owner = (sql: string, args: unknown[] = []) => k.t.owner.query(sql, args)
const ingest = async (subject: string, cls: string[], o: { from?: string; text?: string; headers?: Array<[string, string]>; drain?: boolean; attachments?: Parameters<typeof eml>[0]['attachments'] } = {}) => {
  classes.set(subject, cls)
  const r = await k.ingest(eml({ from: o.from ?? 'Amelia Hart <amelia@hartfamily.example>', subject, text: o.text ?? 'Hello', headers: [...AUTH, ...(o.headers ?? [])], attachments: o.attachments }), '2026-10-29T10:15:00.000Z', TRUSTED)
  if (o.drain !== false) await k.drain()
  return (r as { caseId: string }).caseId
}
const auditOf = (id: string, type: string) => k.db.query<{ payload: Record<string, unknown> }>('SELECT payload FROM audit WHERE case_id = $1 AND type = $2 ORDER BY seq', [id, type])
const draftOf = async (id: string) => (await k.db.query<{ id: string }>(`SELECT id FROM reply WHERE case_id = $1 AND status = 'draft' ORDER BY created_at DESC LIMIT 1`, [id])).rows[0]!.id
const statusOf = async (id: string) => (await one<{ status: string }>('SELECT status FROM "case" WHERE id = $1', [id])).status
const taskOf = async (id: string) => one<{ id: string; state: string }>(`SELECT id, state FROM verification_task WHERE case_id = $1 AND state <> 'invalidated' ORDER BY created_at DESC LIMIT 1`, [id])
const ALL = ['call_phone_on_file', 'no_contact_details_from_mail', 'check_request_content', 'notify_old_contact']
const finishTask = async (id: string) => {
  const t = await taskOf(id)
  expect((await post('rita', `/api/verification/${t.id}/complete`, { items: ALL })).statusCode).toBe(200)
  await owner(`UPDATE verification_task SET completed_at = completed_at - interval '2 hours' WHERE id = $1`, [t.id])
  expect((await post('paul', `/api/verification/${t.id}/approve`)).statusCode).toBe(200)
  return t.id
}
// a new contact in the list gives the next relink a new snapshot, so classify runs again (not reused)
let contactN = 100
const relink = async (id: string, name = 'Extra Person') => {
  await k.importCsv('contacts', `${CONTACTS}C${contactN},${name},extra${contactN++}@other.example,,investor,Northwind Robotics,Northwind Robotics::002\n`)
  expect((await post('rita', `/api/cases/${id}/relink`)).statusCode).toBe(200)
  await k.drain()
}
// run the stages of one Case in order, up to the job of `stop`, which is fetched but not run
const runUntil = async (id: string, stop: Stage) => {
  for (const stage of STAGES) {
    const [job] = await k.boss.boss.fetch<StageJob>(stage, { batchSize: 1 })
    expect(job?.data.caseId).toBe(id)
    if (stage === stop) return job!
    await runStage(k, stage, job!.data)
    await k.boss.boss.complete(stage, job!.id)
  }
  throw new Error(`no ${stop} job`)
}
/** Run one stage; `meanwhile` runs right after the stage has read the Case row and before it prepares and applies. */
const CASE_READ = 'SELECT id, message_id, processing_generation, manual_revision, snapshot_id, flags, closed_at FROM "case" WHERE id = $1'
const runWithAfterRead = async (stage: Stage, job: { id: string; data: StageJob }, meanwhile: () => Promise<void>) => {
  let fired = false
  const db = new Proxy(k.db, {
    get(t, p) {
      if (p === 'query') {
        return async (...a: Parameters<Db['query']>) => {
          const r = await (t.query as (...x: unknown[]) => Promise<{ rows: Array<{ closed_at?: Date | null }> }>)(...a)
          if (!fired && a[0] === CASE_READ) {
            fired = true
            expect(r.rows[0]!.closed_at).toBeNull() // the stage read an open Case
            await meanwhile()
          }
          return r
        }
      }
      const v = Reflect.get(t, p) as unknown
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
    },
  })
  const out = await runStage({ ...k, db }, stage, job.data)
  expect(fired).toBe(true)
  await k.boss.boss.complete(stage, job.id)
  return out
}
/** Send a request while the Case row is locked; `meanwhile` runs once the request waits for that lock. */
const whileCaseLocked = async <T>(id: string, send: () => Promise<T>, meanwhile: () => Promise<unknown>): Promise<T> => {
  const cl = await k.t.owner.connect()
  try {
    await cl.query('BEGIN')
    await cl.query('SELECT 1 FROM "case" WHERE id = $1 FOR UPDATE', [id])
    const pending = send()
    for (let i = 0; i < 400; i++) {
      if ((await k.t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted')).rows[0]!.n > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect((await k.t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted')).rows[0]!.n).toBeGreaterThan(0)
    await meanwhile()
    await cl.query('COMMIT')
    return await pending
  } finally {
    cl.release()
  }
}
const liveTasks = (id: string) => count("verification_task WHERE case_id = $1 AND state <> 'invalidated'", [id])
const NO_CODES = /\bC-[A-Z]+-\d|\bno_recipient\b|\brecipient_not_allowed\b|\bprocessing_generation\b|\bclosed_at\b|\b(?:check_not|reply_not)_/

describe('verification obligations do not vanish (C-FRD-6)', () => {
  it('TC-FRD-14 a protected class stays when a later classification no longer gives it; its task stays too', async () => {
    const id = await ingest('Identity change one', ['identity_change'], { text: 'My surname has changed. Regards, Zelda Moon' })
    expect((await view('rita', id)).adopted).toContain('identity_change')
    classes.set('Identity change one', ['unclassified'])
    const calls = llm.requests.length
    await relink(id, 'Zelda Moon') // a new contact name changes the redacted text, so the model really is asked again
    expect(llm.requests.length).toBeGreaterThan(calls)
    expect((await one<{ result: string }>(`SELECT count(*)::text AS result FROM case_label WHERE case_id = $1 AND class_id = 'identity_change' AND generation = (SELECT processing_generation FROM "case" WHERE id = $1)`, [id])).result).toBe('0')
    const after = await view('rita', id)
    expect(after.adopted).toContain('identity_change')
    // its fields are still asked for in the new generation
    const gen = (await one<{ g: number }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [id])).g
    const asked = await resultOf<FieldsResult>(k, id, 'fields', gen)
    expect(asked!.classes).toContain('identity_change')
    expect(asked!.fields.map((f) => f.field)).toContain('change_fields')
    // the relink is a person's change, so the task is rebound to the new revision (C-FRD-5); one live task remains
    expect(await count("verification_task WHERE case_id = $1 AND kind = 'identity_change' AND state = 'open'", [id])).toBe(1)
  })
  it('TC-FRD-14 removal needs an approver and a reason whatever the risk, then it lasts through reprocessing', async () => {
    const id = await ingest('Identity change two', ['identity_change'], { text: 'My surname has changed.' })
    const refused = await post('rita', `/api/cases/${id}/labels`, { remove: ['identity_change'], reason: 'wrong' })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error).not.toMatch(NO_CODES)
    expect((await post('paul', `/api/cases/${id}/labels`, { remove: ['identity_change'] })).statusCode).toBe(403)
    expect((await post('paul', `/api/cases/${id}/labels`, { remove: ['identity_change'], reason: 'It is a spelling fix, not a change' })).statusCode).toBe(200)
    const row = await one<{ approved_by: string | null; reason_blob: string | null }>(`SELECT approved_by, reason_blob FROM case_label_change WHERE case_id = $1 AND action = 'remove'`, [id])
    expect(row.approved_by).toBe(users.paul!.id)
    expect(row.reason_blob).not.toBeNull()
    await k.drain()
    expect((await view('rita', id)).adopted).not.toContain('identity_change')
    expect(await count("verification_task WHERE case_id = $1 AND state <> 'invalidated'", [id])).toBe(0)
    // the model keeps adopting it on the re-run: the approved removal stands
    await relink(id)
    expect((await view('rita', id)).adopted).not.toContain('identity_change')
    expect(await count("verification_task WHERE case_id = $1 AND state <> 'invalidated'", [id])).toBe(0)
  })
  it('TC-FRD-14 a rule label stays non-removable, also for an approver with a reason, also from an earlier generation', async () => {
    const id = await ingest('Identity change rule', ['legal_documents'], { text: 'Hello' })
    await owner(`INSERT INTO case_label (case_id, generation, class_id, source, confidence, adopted) VALUES ($1, 1, 'identity_change', 'rule', 'rule', true) ON CONFLICT DO NOTHING`, [id])
    const r = await post('paul', `/api/cases/${id}/labels`, { remove: ['identity_change'], reason: 'no' })
    expect(r.statusCode).toBe(409)
    await k.drain()
    expect((await view('rita', id)).ruleLabels).toContain('identity_change')
  })
  it('TC-FRD-14 a rule label that appears after an approved removal still counts', async () => {
    const id = await ingest('Identity rule after removal', ['identity_change'], { text: 'My surname has changed.' })
    expect((await post('paul', `/api/cases/${id}/labels`, { remove: ['identity_change'], reason: 'Spelling fix' })).statusCode).toBe(200)
    await k.drain()
    expect((await view('rita', id)).adopted).not.toContain('identity_change')
    await owner(`INSERT INTO case_label (case_id, generation, class_id, source, confidence, adopted) VALUES ($1, 1, 'identity_change', 'rule', 'rule', true) ON CONFLICT DO NOTHING`, [id])
    await relink(id)
    expect((await view('rita', id)).adopted).toContain('identity_change')
  })
  it('TC-FRD-19 removals before this change without an approver do not count; the migration keeps only reasoned approver removals', async () => {
    const reviewerCase = await ingest('Old removal reviewer', ['identity_change'], { text: 'My surname has changed.' })
    const approverCase = await ingest('Old removal approver', ['identity_change'], { text: 'My surname has changed.' })
    const promotedCase = await ingest('Old removal promoted', ['identity_change'], { text: 'My surname has changed.' })
    const noReasonCase = await ingest('Old removal no reason', ['identity_change'], { text: 'My surname has changed.' })
    const blob = (await k.db.query<{ reason_blob: string }>('SELECT reason_blob FROM case_label_change WHERE reason_blob IS NOT NULL LIMIT 1')).rows[0]!.reason_blob
    const insert = (caseId: string, by: string, withReason: boolean) => owner(`INSERT INTO case_label_change (id, case_id, class_id, action, by_user, reason_blob, created_at) VALUES (gen_random_uuid(), $1, 'identity_change', 'remove', $2, $3, now() - interval '2 days')`, [caseId, by, withReason ? blob : null])
    await insert(reviewerCase, users.rita!.id, true) // reviewer, with a reason
    await insert(approverCase, users.paul!.id, true) // approver, with a reason
    await insert(promotedCase, users.rob!.id, true) // reviewer then, promoted later: rob's role changed after the removal
    await insert(noReasonCase, users.adam!.id, false) // approver, no reason
    await owner(`UPDATE app_user SET role = 'approver' WHERE id = $1`, [users.rob!.id])
    await owner(`INSERT INTO user_event (id, user_id, type, role, at) VALUES (gen_random_uuid(), $1, 'role_removed', 'reviewer', now()), (gen_random_uuid(), $1, 'role_granted', 'approver', now())`, [users.rob!.id])
    // before the migration backfill none of them has an approved_by, so none counts
    for (const id of [reviewerCase, approverCase, promotedCase, noReasonCase]) expect((await view('rita', id)).adopted).toContain('identity_change')
    await owner(backfill(0)) // the approved_by statement of 009
    const after = async (caseId: string) => (await one<{ approved_by: string | null }>(`SELECT approved_by FROM case_label_change WHERE case_id = $1 AND action = 'remove'`, [caseId])).approved_by
    expect(await after(reviewerCase)).toBeNull()
    expect(await after(approverCase)).toBe(users.paul!.id)
    expect(await after(promotedCase)).toBeNull()
    expect(await after(noReasonCase)).toBeNull()
    await relink(approverCase)
    expect((await view('rita', approverCase)).adopted).not.toContain('identity_change') // the reasoned approver removal counts
    await owner(`UPDATE app_user SET role = 'reviewer' WHERE id = $1`, [users.rob!.id])
  })
})

/** The nth UPDATE statement of migration 009 (0: approved_by, 1: text_editors), to check it against rows made here. */
const backfill = (n: number) => {
  const sql = readFileSync('src/store/migrations/009_fraud_gates.sql', 'utf8')
  return [...sql.matchAll(/UPDATE [^;]+;/g)][n]![0]
}

describe('closing (C-FRD-7, C-FRD-8)', () => {
  const closeBody = { outcome: 'no_action' }
  it('TC-FRD-15 / TC-FRD-17 closed while the reply step runs: no one closes it normally, an approver with a reason can; the step that had read the open Case writes no draft and no task; a late failure leaves it closed', async () => {
    const id = await ingest('Close while processing', ['identity_change'], { text: 'My surname has changed.', drain: false })
    const job = await runUntil(id, 'reply')
    const out = await runWithAfterRead('reply', job, async () => {
      const refused = await post('rita', `/api/cases/${id}/close`, closeBody)
      expect(refused.statusCode).toBe(403)
      expect(refused.json().error).toMatch(/still|not finished/i)
      expect(refused.json().error).not.toMatch(NO_CODES)
      expect((await post('paul', `/api/cases/${id}/close`, closeBody)).statusCode).toBe(400)
      expect((await post('paul', `/api/cases/${id}/close`, { ...closeBody, reason: 'Duplicate' })).statusCode).toBe(200)
    })
    expect(out).toBe('published')
    expect((await auditOf(id, 'case.closed')).rows[0]!.payload).toMatchObject({ exception: true })
    expect((await auditOf(id, 'stage.reply')).rows.at(-1)!.payload).toMatchObject({ skipped: 'closed' })
    expect(await count('reply WHERE case_id = $1', [id])).toBe(0)
    expect(await count('verification_task WHERE case_id = $1', [id])).toBe(0)
    // the worker's last attempt of a later step fails after the close: the Case stays closed
    const gen = (await one<{ g: number }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [id])).g
    await markFailed(k, 'route', { caseId: id, generation: gen }, new Error('boom'))
    expect(await statusOf(id)).toBe('closed')
    expect((await one<{ failed_stage: string | null }>('SELECT failed_stage FROM "case" WHERE id = $1', [id])).failed_stage).toBeNull()
    await k.drain() // route and emit finish: no routing, still closed, still no draft or task
    expect(await statusOf(id)).toBe('closed')
    expect((await one<{ queue: string | null }>('SELECT queue FROM "case" WHERE id = $1', [id])).queue).toBeNull()
    expect(await count('reply WHERE case_id = $1', [id])).toBe(0)
    expect(await count('verification_task WHERE case_id = $1', [id])).toBe(0)
  })
  it('TC-FRD-15 an open or stale check, or a missing check, blocks a normal close; an approved and still valid check does not', async () => {
    const id = await ingest('Close with a check', ['identity_change'], { text: 'My surname has changed.' })
    expect((await post('rita', `/api/cases/${id}/close`, closeBody)).statusCode).toBe(403)
    await finishTask(id)
    expect((await view('rita', id)).closeBlockers).toEqual([])
    // the approved task goes stale: change the link, close before the re-run has finished
    expect((await put('rita', `/api/cases/${id}/links/contact`, { target: 'C002' })).statusCode).toBe(200)
    expect((await post('rita', `/api/cases/${id}/close`, closeBody)).statusCode).toBe(403)
    await k.drain()
    expect((await post('rita', `/api/cases/${id}/close`, closeBody)).statusCode).toBe(403) // the replacement task is open
    expect((await view('rita', id)).closeBlockers.join(' ')).toMatch(/not been approved/)
    await finishTask(id)
    expect((await post('rita', `/api/cases/${id}/close`, closeBody)).statusCode).toBe(200)
  })
  it('TC-FRD-15 / TC-FRD-22 an older removal without an approver: after migration 009 the class is back, a normal close is refused until the start-up step has made its task, with its fields and risk worked out again', async () => {
    const id = await ingest('Close no task', ['identity_change'], { text: 'My surname has changed.' })
    // the removal as the code before this change made it: the class goes and reprocessing invalidates its task
    expect((await post('paul', `/api/cases/${id}/labels`, { remove: ['identity_change'], reason: 'Not a change' })).statusCode).toBe(200)
    await k.drain()
    expect(await liveTasks(id)).toBe(0)
    expect((await one<{ risk: string }>('SELECT risk FROM "case" WHERE id = $1', [id])).risk).not.toBe('high') // the removal lowered the risk
    // the row as it was before 009: a reviewer's removal with a reason and no approver column; then the real 009 backfill
    await owner(`UPDATE case_label_change SET by_user = $2, approved_by = NULL WHERE case_id = $1 AND action = 'remove'`, [id, users.rita!.id])
    await owner(backfill(0))
    expect((await one<{ approved_by: string | null }>(`SELECT approved_by FROM case_label_change WHERE case_id = $1 AND action = 'remove'`, [id])).approved_by).toBeNull()
    // the class counts again, but the page still shows the last run's classes and there is no task
    expect((await view('rita', id)).pendingAdopted).toContain('identity_change')
    expect(await liveTasks(id)).toBe(0)
    expect((await post('rita', `/api/cases/${id}/close`, closeBody)).statusCode).toBe(403)
    expect((await view('rita', id)).closeBlockers.join(' ')).toMatch(/has not been created/)
    // the start-up step runs the Case again from the fields step (round 2 D2), which makes the task; a second start does nothing more
    await fraudGatesRollout(k)
    const [rerun] = (await auditOf(id, 'case.rerun_for_check')).rows.map((r) => r.payload)
    expect(rerun).toEqual(expect.objectContaining({ kinds: ['identity_change'], from: 'fields' }))
    await k.drain()
    expect(await count("verification_task WHERE case_id = $1 AND kind = 'identity_change' AND state = 'open'", [id])).toBe(1)
    // fields and risk ran again for the restored class: its floor applies, not the low risk of the removal
    const ran = (await k.db.query<{ stage: string; reused: boolean }>('SELECT stage, reused FROM stage_run WHERE case_id = $1 AND generation = $2 AND stage IN ($3, $4) ORDER BY stage', [id, rerun!.generation, 'fields', 'risk'])).rows
    expect(ran).toEqual([{ stage: 'fields', reused: false }, { stage: 'risk', reused: false }])
    expect((await one<{ risk: string }>('SELECT risk FROM "case" WHERE id = $1', [id])).risk).toBe('high')
    expect((await view('rita', id)).adopted).toContain('identity_change')
    expect((await view('rita', id)).closeBlockers.join(' ')).toMatch(/not been approved/)
    await fraudGatesRollout(k)
    expect((await auditOf(id, 'case.rerun_for_check')).rows).toHaveLength(1)
  })
  it('TC-FRD-15 an approved but unsent reply blocks a normal close; marking it sent clears that', async () => {
    const id = await ingest('Close with reply', ['legal_documents'])
    const rep = await draftOf(id)
    expect((await post('rita', `/api/cases/${id}/replies/${rep}/approve`)).statusCode).toBe(200)
    const refused = await post('rita', `/api/cases/${id}/close`, closeBody)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error).toMatch(/marked as sent/)
    expect((await post('rita', `/api/cases/${id}/replies/${rep}/sent`)).statusCode).toBe(200)
    expect((await post('rita', `/api/cases/${id}/close`, closeBody)).statusCode).toBe(200)
    expect((await one<{ status: string }>('SELECT status FROM reply WHERE id = $1', [rep])).status).toBe('sent')
  })
  it('TC-FRD-16 closing voids approved replies and live tasks, and writes why; an exception close keeps the reason in the audit', async () => {
    const id = await ingest('Void on close', ['identity_change'], { text: 'My surname has changed.' })
    await post('rita', `/api/cases/${id}/replies/${await draftOf(id)}/approve`) // safe_ack
    expect(await count("reply WHERE case_id = $1 AND status = 'approved'", [id])).toBe(1)
    const task = await taskOf(id)
    expect((await post('paul', `/api/cases/${id}/close`, { ...closeBody, reason: 'Confirmed fraud' })).statusCode).toBe(200)
    expect(await count("reply WHERE case_id = $1 AND status = 'approved'", [id])).toBe(0)
    expect((await one<{ state: string }>('SELECT state FROM verification_task WHERE id = $1', [task.id])).state).toBe('invalidated')
    expect((await auditOf(id, 'reply.voided_on_close')).rows).toHaveLength(1)
    expect((await auditOf(id, 'verification.invalidated')).rows.some((r) => r.payload.reason === 'case_closed')).toBe(true)
    expect((await auditOf(id, 'case.closed')).rows[0]!.payload).toMatchObject({ exception: true })
  })
  it('TC-FRD-16 an approved check survives the close and still shows; only unfinished checks are voided', async () => {
    const id = await ingest('Approved check kept on close', ['identity_change'], { text: 'My surname has changed.' })
    const taskId = await finishTask(id)
    expect((await post('rita', `/api/cases/${id}/close`, closeBody)).statusCode).toBe(200)
    expect((await one<{ state: string }>('SELECT state FROM verification_task WHERE id = $1', [taskId])).state).toBe('approved')
    expect((await auditOf(id, 'verification.invalidated')).rows.filter((r) => r.payload.reason === 'case_closed')).toHaveLength(0)
    const v = await view('rita', id)
    expect(v.closed).toBe(true)
    expect(v.verification).toEqual([expect.objectContaining({ id: taskId, state: 'approved' })])
  })
  it('TC-FRD-16 / TC-FRD-18 every person action on a closed case is refused in plain English; only the retention hold works', async () => {
    const id = await ingest('Closed read only', ['legal_documents'])
    const t = await taskOf(await ingest('Task on read only', ['identity_change'], { text: 'My surname has changed.' })).catch(() => null)
    expect(t).not.toBeNull()
    const rep = await draftOf(id)
    expect((await post('rita', `/api/cases/${id}/close`, closeBody)).statusCode).toBe(200)
    const url = `/api/cases/${id}`
    const attempts = await Promise.all([
      post('rita', `${url}/labels`, { add: ['complaint'] }),
      put('rita', `${url}/fields/amount`, { value: '10.00' }),
      put('rita', `${url}/links/contact`, { target: 'C001' }),
      post('rita', `${url}/relink`),
      post('paul', `${url}/risk`, { level: 'high' }),
      post('paul', `${url}/risk/confirm-lower`, { reason: 'x', level: 'low' }),
      post('rita', `${url}/replies/${rep}/revise`, { templateId: 'complaint_ack' }),
      post('rita', `${url}/replies/${rep}/approve`),
      post('rita', `${url}/replies/${rep}/copy`),
      post('rita', `${url}/replies/${rep}/sent`),
      post('rita', `${url}/replies/${rep}/reject`),
      put('rita', `${url}/assignment`, { queue: 'ops' }),
      post('rita', `${url}/close`, closeBody),
      post('paul', `${url}/recipient-override`, { reason: 'x' }),
    ])
    for (const r of attempts) {
      expect(r.statusCode).toBe(409)
      expect(r.json().error).not.toMatch(NO_CODES)
    }
    expect((await post('paul', `${url}/hold`, { hold: true, reason: 'Litigation' })).statusCode).toBe(200)
    expect(await statusOf(id)).toBe('closed')
    // a verification task of another case stays refused once its case is closed
    const taskCase = await one<{ case_id: string }>('SELECT case_id FROM verification_task WHERE id = $1', [t!.id])
    await post('paul', `/api/cases/${taskCase.case_id}/close`, { ...closeBody, reason: 'x' })
    expect((await post('rita', `/api/verification/${t!.id}/complete`, { items: ALL })).statusCode).toBe(409)
  })
  it('TC-FRD-16 /sent never changes the status of a closed case; a sent reply and a closed case stay as they are', async () => {
    const id = await ingest('Sent after close', ['legal_documents'])
    const rep = await draftOf(id)
    await post('rita', `/api/cases/${id}/replies/${rep}/approve`)
    expect((await post('paul', `/api/cases/${id}/close`, { ...closeBody, reason: 'Withdrawn' })).statusCode).toBe(200)
    // the approval was voided by the close, and the guard refuses anyway
    expect((await post('rita', `/api/cases/${id}/replies/${rep}/sent`)).statusCode).toBe(409)
    expect(await statusOf(id)).toBe('closed')
  })
  it('TC-FRD-16 concurrency: closing and approving, closing and marking sent, end in one consistent state', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await ingest(`Concurrent one ${i}`, ['legal_documents'])
      const rep = await draftOf(id)
      const [a, b] = await Promise.all([post('rita', `/api/cases/${id}/replies/${rep}/approve`), post('paul', `/api/cases/${id}/close`, { ...closeBody, reason: 'x' })])
      // the close always succeeds (an approved reply only makes it an exception, which paul's reason covers)
      expect(b.statusCode).toBe(200)
      expect(await statusOf(id)).toBe('closed')
      expect(await count("reply WHERE case_id = $1 AND status = 'approved'", [id])).toBe(0)
      const replyStatus = (await one<{ status: string }>('SELECT status FROM reply WHERE id = $1', [rep])).status
      const closed = (await auditOf(id, 'case.closed')).rows[0]!.payload
      if (a.statusCode === 200) {
        // approved first: the close was an exception for the unsent reply and voided it
        expect(replyStatus).toBe('superseded')
        expect(closed).toMatchObject({ exception: true, blockers: ['reply_not_sent'] })
        expect((await auditOf(id, 'reply.voided_on_close')).rows).toEqual([expect.objectContaining({ payload: { reply_id: rep } })])
      } else {
        // closed first: the approval is refused as a closed Case and the draft is untouched
        expect(a.statusCode).toBe(409)
        expect(a.json().error).toMatch(/This case is closed/)
        expect(replyStatus).toBe('draft')
        expect(closed).toMatchObject({ exception: false, blockers: [] })
        expect((await auditOf(id, 'reply.voided_on_close')).rows).toHaveLength(0)
      }
    }
    for (let i = 0; i < 3; i++) {
      const id = await ingest(`Concurrent two ${i}`, ['legal_documents'])
      const rep = await draftOf(id)
      await post('rita', `/api/cases/${id}/replies/${rep}/approve`)
      const [s, c] = await Promise.all([post('rita', `/api/cases/${id}/replies/${rep}/sent`), post('paul', `/api/cases/${id}/close`, { ...closeBody, reason: 'x' })])
      expect(c.statusCode).toBe(200)
      expect(await statusOf(id)).toBe('closed') // closing always wins last or first; closed either way
      const r = await one<{ status: string }>('SELECT status FROM reply WHERE id = $1', [rep])
      expect(s.statusCode === 200 ? 'sent' : 'superseded').toBe(r.status)
    }
  })
  it('TC-FRD-17 KYC continuation and deferred rechecks finish on a closed case without undoing it or adding a task or a case event; retention deletes it', async () => {
    const id = await ingest('Closed KYC', ['identity_change'], { text: 'My surname has changed.', attachments: [{ filename: 'passport.txt', type: 'text/plain', content: Buffer.from('statement') }] })
    await post('rita', `/api/cases/${id}/assignment`, { queue: 'ops' })
    // a protected class: the reply step would make a verification task on any open Case
    const task = await taskOf(id)
    expect((await post('paul', `/api/cases/${id}/close`, { ...closeBody, reason: 'Withdrawn' })).statusCode).toBe(200)
    expect((await one<{ state: string }>('SELECT state FROM verification_task WHERE id = $1', [task.id])).state).toBe('invalidated')
    const caseEvents = async () => (await k.db.query<{ type: string }>(`SELECT type FROM event_outbox WHERE case_id = $1 AND type LIKE 'case.%' ORDER BY case_event_seq`, [id])).rows.map((r) => r.type)
    const eventsAtClose = await caseEvents()
    expect(eventsAtClose).toContain('case.closed')
    const route = async () => one<{ queue: string; due_at: Date; generation: number; risk: string }>('SELECT queue, due_at, processing_generation AS generation, risk FROM "case" WHERE id = $1', [id])
    const before = await route()
    const repliesBefore = await count('reply WHERE case_id = $1', [id])
    // the KYC replacement's continuation
    await owner('SELECT enqueue_kyc_continuation($1, $2)', [id, before.generation])
    await k.drain()
    const afterCont = await route()
    expect(afterCont.generation).toBe(before.generation + 1)
    expect(afterCont.queue).toBe(before.queue)
    expect(afterCont.due_at.getTime()).toBe(before.due_at.getTime())
    expect(await statusOf(id)).toBe('closed')
    expect(await count('reply WHERE case_id = $1', [id])).toBe(repliesBefore)
    expect((await view('rita', id)).adopted).toContain('identity_change')
    expect(await liveTasks(id)).toBe(0)
    expect(await caseEvents()).toEqual(eventsAtClose)
    // the pipeline finished for the new generation
    expect((await one<{ c: number }>('SELECT pipeline_complete_generation AS c FROM "case" WHERE id = $1', [id])).c).toBe(afterCont.generation)
    // the deferred KYC recheck on the closed case
    await owner('UPDATE attachment SET maybe_kyc = true, kyc_recheck_pending = true WHERE message_id = (SELECT message_id FROM "case" WHERE id = $1)', [id])
    expect(await retryDeferredKyc(k)).toBe(1)
    await k.drain()
    expect(await statusOf(id)).toBe('closed')
    expect(await count('reply WHERE case_id = $1', [id])).toBe(repliesBefore)
    expect(await liveTasks(id)).toBe(0)
    expect(await caseEvents()).toEqual(eventsAtClose)
    // the recipient-exception reason is a blob column retention knows about
    const cols = await blobColumns(k.db)
    expect(cols).toContainEqual({ tbl: 'case', col: 'recipient_override_reason_blob' })
    // retention runs on the closed Case: the message and the Case go
    const messageId = (await one<{ message_id: string }>('SELECT message_id FROM "case" WHERE id = $1', [id])).message_id
    expect(await deleteMessage({ db: k.t.maintenance, k: k.k, files: k.files }, messageId, null)).toBe('deleted')
    expect(await count('"case" WHERE id = $1', [id])).toBe(0)
    expect(await count('message WHERE id = $1', [messageId])).toBe(0)
  })
  it('TC-FRD-17 a risk step that had read the open Case before the close leaves risk and routing alone; a relink sent after the close is refused and changes nothing', async () => {
    const id = await ingest('Close mid risk', ['legal_documents'], { drain: false })
    const job = await runUntil(id, 'risk')
    expect(await runWithAfterRead('risk', job, async () => {
      expect((await post('paul', `/api/cases/${id}/close`, { ...closeBody, reason: 'x' })).statusCode).toBe(200)
    })).toBe('published')
    expect((await auditOf(id, 'stage.risk')).rows.at(-1)!.payload).toMatchObject({ skipped: 'closed' })
    const state = () => one<{ g: number; m: number; risk: string | null; queue: string | null; due_at: Date | null; outcome: string }>('SELECT processing_generation AS g, manual_revision AS m, risk, queue, due_at, outcome FROM "case" WHERE id = $1', [id])
    const before = await state()
    const relink = await post('rita', `/api/cases/${id}/relink`)
    expect(relink.statusCode).toBe(409)
    expect(relink.json().error).toMatch(/This case is closed/)
    expect(await state()).toEqual(before)
    await k.drain()
    const row = await state()
    expect(row.g).toBe(before.g)
    expect(row.risk).toBeNull() // nothing computed for a closed case
    expect(row.queue).toBeNull()
    expect(row.due_at).toBeNull()
    expect(row.outcome).toBe('no_action')
    expect(await count('reply WHERE case_id = $1', [id])).toBe(0)
  })
})

describe('approver decisions re-read the acting user (C-FRD-6, C-FRD-7, C-DRF-10)', () => {
  const demote = (id: string) => owner(`UPDATE app_user SET role = 'reviewer' WHERE id = $1`, [id])
  const restore = (id: string) => owner(`UPDATE app_user SET role = 'approver' WHERE id = $1`, [id])
  it('TC-FRD-20 an approver demoted while the request waits for the Case lock is refused: protected removal, exception close, recipient exception', async () => {
    const labels = await ingest('Demoted removal', ['identity_change'], { text: 'My surname has changed.' })
    const closing = await ingest('Demoted close', ['identity_change'], { text: 'My surname has changed.' })
    const spoof = await ingest('Demoted override', ['bank_letter_request'], { from: 'Amelia Hart <amelia@hartfamiIy.example>' })
    const cases: Array<[string, () => Promise<{ statusCode: number; json: () => { error: string } }>]> = [
      [labels, () => post('paul', `/api/cases/${labels}/labels`, { remove: ['identity_change'], reason: 'Not a change' })],
      [closing, () => post('paul', `/api/cases/${closing}/close`, { outcome: 'no_action', reason: 'Fraud' })],
      [spoof, () => post('paul', `/api/cases/${spoof}/recipient-override`, { reason: 'Called her' })],
    ]
    for (const [id, send] of cases) {
      try {
        const r = await whileCaseLocked(id, send, () => demote(users.paul!.id))
        expect(r.statusCode).toBe(409)
        expect(r.json().error).toMatch(/your account changed; sign in again/)
      } finally {
        await restore(users.paul!.id)
      }
    }
    // nothing was written
    expect(await count('case_label_change WHERE case_id = $1', [labels])).toBe(0)
    expect(await statusOf(closing)).not.toBe('closed')
    expect((await one<{ at: Date | null }>('SELECT recipient_override_at AS at FROM "case" WHERE id = $1', [spoof])).at).toBeNull()
    // without the demotion the same requests go through
    expect((await post('paul', `/api/cases/${spoof}/recipient-override`, { reason: 'Called her' })).statusCode).toBe(200)
    expect((await post('paul', `/api/cases/${closing}/close`, { outcome: 'no_action', reason: 'Fraud' })).statusCode).toBe(200)
  })
})

describe('one check at approve, copy and sent (C-DRF-9)', () => {
  const reviewerApprovedEdited = async (subject: string) => {
    const id = await ingest(subject, ['bank_letter_request'])
    const edited = (await post('rita', `/api/cases/${id}/replies/${await draftOf(id)}/revise`, { text: 'Dear investor, thank you for your documents.' })).json().replyId as string
    return { id, edited }
  }
  it('TC-DRF-22 a reply approved before this change that fails the rules goes back to draft at copy', async () => {
    const { id, edited } = await reviewerApprovedEdited('Legacy approved copy')
    await owner(`UPDATE reply SET status = 'approved', approved_by = $2, approved_at = now(), approved_generation = generation, approved_manual_revision = (SELECT manual_revision FROM "case" WHERE id = $3), text_editors = $4 WHERE id = $1`, [edited, users.rita!.id, id, [users.rita!.id]])
    await owner(`UPDATE "case" SET status = 'approved' WHERE id = $1`, [id])
    // an admin who never touched the text copies: the recorded approver (a reviewer) still fails
    const r = await post('adam', `/api/cases/${id}/replies/${edited}/copy`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/no longer holds/)
    expect(r.json().error).not.toMatch(NO_CODES)
    const row = await one<{ status: string; approved_by: string | null }>('SELECT status, approved_by FROM reply WHERE id = $1', [edited])
    expect(row).toMatchObject({ status: 'draft', approved_by: null })
    expect(await statusOf(id)).toBe('open')
    expect((await auditOf(id, 'reply.approval_lapsed')).rows).toHaveLength(1)
  })
  it('TC-DRF-22 the same check at sent, on the recorded approver and not the caller', async () => {
    const { id, edited } = await reviewerApprovedEdited('Legacy approved sent')
    await owner(`UPDATE reply SET status = 'approved', approved_by = $2, approved_at = now(), approved_generation = generation, approved_manual_revision = (SELECT manual_revision FROM "case" WHERE id = $3), text_editors = $4 WHERE id = $1`, [edited, users.rita!.id, id, [users.rita!.id]])
    await owner(`UPDATE "case" SET status = 'approved' WHERE id = $1`, [id])
    // the caller is an admin who never touched the text: the recorded approver (a reviewer) still fails
    const r = await post('adam', `/api/cases/${id}/replies/${edited}/sent`)
    expect(r.statusCode).toBe(409)
    expect((await one<{ status: string }>('SELECT status FROM reply WHERE id = $1', [edited])).status).toBe('draft')
  })
  it('TC-DRF-22 a reply that became unsendable after approval is refused at copy and at sent', async () => {
    const id = await ingest('Approved then spoof signal', ['bank_letter_request'])
    const rep = await draftOf(id)
    expect((await post('rita', `/api/cases/${id}/replies/${rep}/approve`)).statusCode).toBe(200)
    await owner(`UPDATE case_signal SET value = true WHERE case_id = $1 AND signal = 'lookalike_domain'`, [id])
    await owner(`INSERT INTO case_signal (case_id, signal, value, batch, input_sha256) VALUES ($1, 'lookalike_domain', true, 'metadata', 'x') ON CONFLICT DO NOTHING`, [id])
    const r = await post('rita', `/api/cases/${id}/replies/${rep}/sent`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/no allowed recipient/)
    expect(await statusOf(id)).toBe('open')
    expect((await one<{ status: string }>('SELECT status FROM reply WHERE id = $1', [rep])).status).toBe('draft')
  })
  it('TC-DRF-22 a good approval passes approve, copy and sent; a caller who edited but did not approve can still use it', async () => {
    const id = await ingest('Good approval path', ['bank_letter_request'])
    const edited = (await post('rita', `/api/cases/${id}/replies/${await draftOf(id)}/revise`, { text: 'Thank you for your documents, we are reviewing them.' })).json().replyId as string
    expect((await post('adam', `/api/cases/${id}/replies/${edited}/approve`)).statusCode).toBe(200)
    // rita edited but adam (recorded approver) approved: copying by rita is the recorded approver check, not hers
    expect((await post('rita', `/api/cases/${id}/replies/${edited}/copy`)).statusCode).toBe(200)
    expect((await post('rita', `/api/cases/${id}/replies/${edited}/sent`)).statusCode).toBe(200)
    expect(await statusOf(id)).toBe('sent')
  })
})

describe('suspicious senders (C-DRF-10)', () => {
  const LOOKALIKE = 'Amelia Hart <amelia@hartfamiIy.example>'
  it('TC-DRF-23 / TC-DRF-25 a look-alike or impersonating sender has no allowed recipient; an approver with a reason allows only the original From; the template is unchanged', async () => {
    const id = await ingest('Lookalike sender', ['bank_letter_request'], { from: LOOKALIKE, headers: [['Reply-To', 'elsewhere@other.example']] })
    let v = await view('rita', id)
    expect(v.senderSuspect).toBe(true)
    expect(v.allowedRecipients).toEqual([])
    expect(v.replies[0].recipient).toBeNull()
    expect(v.autoTemplate).toBe('safe_ack') // high risk from the signal, as before: selection is unchanged
    const refused = await post('rita', `/api/cases/${id}/replies/${await draftOf(id)}/approve`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/no allowed recipient/)
    expect(refused.json().error).not.toMatch(NO_CODES)
    expect((await post('rita', `/api/cases/${id}/recipient-override`, { reason: 'It is her' })).statusCode).toBe(403)
    expect((await post('paul', `/api/cases/${id}/recipient-override`, {})).statusCode).toBe(400)
    expect((await post('paul', `/api/cases/${id}/recipient-override`, { reason: 'Called her on the file number' })).statusCode).toBe(200)
    expect((await post('paul', `/api/cases/${id}/recipient-override`, { reason: 'again' })).statusCode).toBe(409)
    v = await view('rita', id)
    expect(v.allowedRecipients).toEqual(['amelia@hartfamiiy.example']) // the From address only, not Reply-To
    expect(v.recipientOverride.reason).toBe('Called her on the file number')
    const withTo = (await post('rita', `/api/cases/${id}/replies/${await draftOf(id)}/revise`, { recipient: 'amelia@hartfamiiy.example' })).json().replyId as string
    expect((await post('rita', `/api/cases/${id}/replies/${withTo}/approve`)).statusCode).toBe(200)
    expect((await post('rita', `/api/cases/${id}/replies/${withTo}/copy`)).json().recipient).toBe('amelia@hartfamiiy.example')
    expect((await auditOf(id, 'case.recipient_override_set')).rows).toHaveLength(1)
  })
  it('TC-DRF-23 a Reply-To is never allowed by the exception', async () => {
    const id = await ingest('Lookalike reply-to', ['bank_letter_request'], { from: LOOKALIKE, headers: [['Reply-To', 'amelia@hartfamiIy.example']] })
    await post('paul', `/api/cases/${id}/recipient-override`, { reason: 'Known' })
    const bad = (await post('rita', `/api/cases/${id}/replies/${await draftOf(id)}/revise`, { recipient: 'someone@other.example' })).json().replyId as string
    expect((await post('rita', `/api/cases/${id}/replies/${bad}/approve`)).statusCode).toBe(409)
  })
  it('TC-DRF-23 an override has no effect on an ordinary sender, and a sender without either signal is refused one', async () => {
    const id = await ingest('Ordinary sender', ['bank_letter_request'])
    expect((await post('paul', `/api/cases/${id}/recipient-override`, { reason: 'no' })).statusCode).toBe(409)
    expect((await view('rita', id)).senderSuspect).toBe(false)
  })
})

describe('edited replies (C-DRF-11)', () => {
  it('TC-DRF-24 / TC-DRF-25 a reviewer cannot approve an edited body, an editor cannot, a different approver or admin can; no keyword scanning', async () => {
    const id = await ingest('Edited body gate', ['bank_letter_request'])
    const edited = (await post('rita', `/api/cases/${id}/replies/${await draftOf(id)}/revise`, { text: 'Bob invested GBP 50,000.' })).json().replyId as string
    const refused = await post('rob', `/api/cases/${id}/replies/${edited}/approve`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/approver or admin must approve/)
    expect(refused.json().error).not.toMatch(NO_CODES)
    // paul edits; the same text with his change: paul becomes an editor too
    const byPaul = (await post('paul', `/api/cases/${id}/replies/${edited}/revise`, { text: 'Bob invested GBP 60,000.' })).json().replyId as string
    const self = await post('paul', `/api/cases/${id}/replies/${byPaul}/approve`)
    expect(self.statusCode).toBe(409)
    expect(self.json().error).toMatch(/different approver or admin/)
    expect((await one<{ text_editors: string[] }>('SELECT text_editors FROM reply WHERE id = $1', [byPaul])).text_editors.sort()).toEqual([users.paul!.id, users.rita!.id].sort())
    // no keyword scanning: the body is approved as it is, by someone else with the right role
    expect((await post('petra', `/api/cases/${id}/replies/${byPaul}/approve`)).statusCode).toBe(200)
  })
  it('TC-DRF-26 an approver the editor created, or who reset the editor, cannot approve the edited text; checked again at copy and sent', async () => {
    const zedId = await tx(k.db, (c) => createUser(c, k.k, { username: 'zed', role: 'approver', password: null, by: users.adam!.id, mustChange: false }))
    users.zed = { id: zedId, ...(await createSession(k.db, k.k, zedId, 1, 12)) }
    const id = await ingest('Related approver', ['bank_letter_request'])
    const edited = (await post('adam', `/api/cases/${id}/replies/${await draftOf(id)}/revise`, { text: 'Bob invested GBP 70,000.' })).json().replyId as string
    const refused = await post('zed', `/api/cases/${id}/replies/${edited}/approve`) // adam created zed
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/created, granted a role to or reset the password of one another/)
    expect(refused.json().error).not.toMatch(NO_CODES)
    expect((await post('petra', `/api/cases/${id}/replies/${edited}/approve`)).statusCode).toBe(200)
    // after the approval adam resets petra's password: copy and sent check the recorded approver again
    await owner(`INSERT INTO user_event (id, user_id, type, role, by_user) VALUES (gen_random_uuid(), $1, 'credential_reset', NULL, $2)`, [users.petra!.id, users.adam!.id])
    const copy = await post('rita', `/api/cases/${id}/replies/${edited}/copy`)
    expect(copy.statusCode).toBe(409)
    expect(copy.json().error).toMatch(/no longer holds.*one another/)
    expect((await one<{ status: string }>('SELECT status FROM reply WHERE id = $1', [edited])).status).toBe('draft')
    // the same at sent: paul approves, then turns out to have been granted his role by the editor
    expect((await post('paul', `/api/cases/${id}/replies/${edited}/approve`)).statusCode).toBe(200)
    await owner(`INSERT INTO user_event (id, user_id, type, role, by_user) VALUES (gen_random_uuid(), $1, 'role_granted', 'approver', $2)`, [users.paul!.id, users.adam!.id])
    expect((await post('rita', `/api/cases/${id}/replies/${edited}/sent`)).statusCode).toBe(409)
    expect((await one<{ status: string }>('SELECT status FROM reply WHERE id = $1', [edited])).status).toBe('draft')
    await owner(`DELETE FROM user_event WHERE by_user = $1 AND user_id = ANY($2::uuid[])`, [users.adam!.id, [users.petra!.id, users.paul!.id]])
  })
  it('TC-DRF-24 changing only the template is not an edit; restoring the original text returns to normal approval', async () => {
    const id = await ingest('Template switch not edit', ['bank_letter_request'])
    const first = await draftOf(id)
    const switched = (await post('rita', `/api/cases/${id}/replies/${first}/revise`, { templateId: 'complaint_ack' })).json().replyId as string
    await k.drain()
    expect((await one<{ text_editors: string[] }>('SELECT text_editors FROM reply WHERE id = $1', [switched])).text_editors).toEqual([])
    // the rendered text of the switched template is unchanged: a reviewer can approve
    expect((await post('rob', `/api/cases/${id}/replies/${switched}/approve`)).statusCode).toBe(200)
  })
  it('TC-DRF-24 restoring the original text returns the reply to normal approval, also with an editor on record', async () => {
    const id = await ingest('Restore text', ['bank_letter_request'])
    const first = await draftOf(id)
    const original = (await view('rita', id)).replies[0].text as string
    const edited = (await post('rita', `/api/cases/${id}/replies/${first}/revise`, { text: 'Changed text.' })).json().replyId as string
    expect((await post('rob', `/api/cases/${id}/replies/${edited}/approve`)).statusCode).toBe(409)
    const back = (await post('rita', `/api/cases/${id}/replies/${edited}/revise`, { text: original })).json().replyId as string
    expect((await one<{ text_editors: string[] }>('SELECT text_editors FROM reply WHERE id = $1', [back])).text_editors).toContain(users.rita!.id)
    expect((await post('rob', `/api/cases/${id}/replies/${back}/approve`)).statusCode).toBe(200)
  })
  it('TC-FRD-19 / TC-DRF-24 a draft from before this change counts every creator on that case and generation as an editor', async () => {
    const id = await ingest('Pre-existing edited draft', ['bank_letter_request'])
    const first = await draftOf(id)
    const edited = (await post('rita', `/api/cases/${id}/replies/${first}/revise`, { text: 'Old edited text.' })).json().replyId as string
    // the migration's backfill on a row of that era: created_by is the person, text_editors empty
    await owner('UPDATE reply SET text_editors = \'{}\' WHERE case_id = $1', [id])
    await owner(`INSERT INTO reply (id, case_id, generation, template_id, template_source, edited, subject_blob, text_blob, content_sha256, check_ok, status, created_by) SELECT gen_random_uuid(), case_id, generation, template_id, template_source, true, subject_blob, text_blob, content_sha256, true, 'superseded', $2 FROM reply WHERE id = $1`, [edited, users.petra!.id])
    await owner(backfill(1))
    const row = await one<{ text_editors: string[] }>('SELECT text_editors FROM reply WHERE id = $1', [edited])
    expect(row.text_editors.sort()).toEqual([users.petra!.id, users.rita!.id].sort())
    expect((await post('petra', `/api/cases/${id}/replies/${edited}/approve`)).statusCode).toBe(409)
    expect((await post('paul', `/api/cases/${id}/replies/${edited}/approve`)).statusCode).toBe(200)
  })
  it('TC-FRD-21 the backfill keeps an editor of an earlier generation: a template switch before this change does not drop them', async () => {
    const id = await ingest('Editor across generations', ['bank_letter_request'])
    const byPaul = (await post('paul', `/api/cases/${id}/replies/${await draftOf(id)}/revise`, { text: 'Bob invested GBP 80,000.' })).json().replyId as string
    const switched = (await post('rita', `/api/cases/${id}/replies/${byPaul}/revise`, { templateId: 'complaint_ack', text: 'Bob invested GBP 80,000.' })).json().replyId as string
    await k.drain()
    const gens = await one<{ a: number; b: number }>('SELECT (SELECT generation FROM reply WHERE id = $1) AS a, (SELECT generation FROM reply WHERE id = $2) AS b', [byPaul, switched])
    expect(gens.b).toBeGreaterThan(gens.a)
    // the rows as they were before 009, then the real backfill
    await owner(`UPDATE reply SET text_editors = '{}' WHERE case_id = $1`, [id])
    await owner(backfill(1))
    expect((await one<{ text_editors: string[] }>('SELECT text_editors FROM reply WHERE id = $1', [switched])).text_editors.sort()).toEqual([users.paul!.id, users.rita!.id].sort())
    expect((await post('paul', `/api/cases/${id}/replies/${switched}/approve`)).json().error).toMatch(/different approver or admin/)
    expect((await post('petra', `/api/cases/${id}/replies/${switched}/approve`)).statusCode).toBe(200)
  })
})

describe('a task is bound to the field content it was made on (C-FRD-5, owner 2026-11-10)', () => {
  // a system re-run from `fields` with another model configured: the step asks the model again (same answers as `llm`)
  const systemRerunFields = async (id: string) => {
    await tx(k.db, (c) => restartFrom(c, k.boss, id, 'fields', 'system'))
    const [job] = await k.boss.boss.fetch<StageJob>('fields', { batchSize: 1 })
    expect(job?.data.caseId).toBe(id)
    const other = new FakeLlm()
    other.reply = llm.reply
    Object.defineProperty(other, 'id', { value: `fake/model-${job!.id}` })
    const asked = other.requests.length
    await runStage({ ...k, llm: other }, 'fields', job!.data)
    expect(other.requests.length).toBeGreaterThan(asked)
    await k.boss.boss.complete('fields', job!.id)
    await k.drain()
  }
  const revision = async (id: string) => (await one<{ m: number }>('SELECT manual_revision AS m FROM "case" WHERE id = $1', [id])).m
  const fieldsInvalidations = async (id: string) => (await auditOf(id, 'verification.invalidated')).rows.filter((r) => r.payload.fields_changed === true)
  const CHANGE = '{"fields":{"change_requested":{"value":true,"confidence":"high","quote":"Please change my bank account"}}}'

  it('TC-FRD-25 a system re-run that changes a bank details field invalidates the approved task; a new open task replaces it', async () => {
    const subject = 'Bank field changes on rerun'
    const id = await ingest(subject, ['bank_details'], { text: 'Please change my bank account to the new one.' })
    const approved = await finishTask(id)
    const rev = await revision(id)
    fieldAnswers.set(subject, CHANGE)
    await systemRerunFields(id)
    expect(await revision(id)).toBe(rev) // a system run: the manual revision did not move
    expect((await one<{ state: string }>('SELECT state FROM verification_task WHERE id = $1', [approved])).state).toBe('invalidated')
    expect(await fieldsInvalidations(id)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ task_id: approved, was: 'approved' }) })])
    expect(await count("verification_task WHERE case_id = $1 AND kind = 'bank_details' AND state = 'open'", [id])).toBe(1)
    expect((await view('rita', id)).closeBlockers.join(' ')).toMatch(/not been approved/)
  })
  it('TC-FRD-25 a system re-run with the same field values keeps the approved task', async () => {
    const subject = 'Bank field same on rerun'
    fieldAnswers.set(subject, CHANGE)
    const id = await ingest(subject, ['bank_details'], { text: 'Please change my bank account to the new one.' })
    const approved = await finishTask(id)
    await systemRerunFields(id)
    expect((await one<{ state: string }>('SELECT state FROM verification_task WHERE id = $1', [approved])).state).toBe('approved')
    expect(await fieldsInvalidations(id)).toHaveLength(0)
    expect((await view('rita', id)).closeBlockers).toEqual([])
  })
  it('TC-FRD-26 a task from before the field binding is never bound to the values found later: the next run replaces it, and a normal close is refused until then', async () => {
    const subject = 'Bank field unbound on rerun'
    fieldAnswers.set(subject, CHANGE)
    const id = await ingest(subject, ['bank_details'], { text: 'Please change my bank account to the new one.' })
    const approved = await finishTask(id)
    await owner('UPDATE verification_task SET bound_fields_sha256 = NULL WHERE id = $1', [approved])
    expect((await view('rita', id)).closeBlockers.join(' ')).toMatch(/no longer matches/)
    await systemRerunFields(id) // the same values: an unbound task is still not adopted to them
    expect((await one<{ sha: string | null; state: string }>('SELECT bound_fields_sha256 AS sha, state FROM verification_task WHERE id = $1', [approved]))).toEqual({ sha: null, state: 'invalidated' })
    expect(await count("verification_task WHERE case_id = $1 AND kind = 'bank_details' AND state = 'open' AND bound_fields_sha256 IS NOT NULL", [id])).toBe(1)
  })
  it('TC-FRD-27 a person confirming an unchanged value keeps an approved task bound to its fields, also after a later system run of the fields step', async () => {
    const subject = 'Bank field confirmed after rerun'
    fieldAnswers.set(subject, CHANGE)
    const id = await ingest(subject, ['bank_details'], { text: 'Please change my bank account to the new one.' })
    const approved = await finishTask(id)
    await systemRerunFields(id) // a fields run newer than the task, with the same values
    const rev = await revision(id)
    expect((await put('rita', `/api/cases/${id}/fields/change_requested`, { confirm: true })).statusCode).toBe(200)
    await k.drain()
    expect((await one<{ state: string; m: number }>('SELECT state, bound_manual_revision AS m FROM verification_task WHERE id = $1', [approved]))).toEqual({ state: 'approved', m: rev + 1 })
    expect((await auditOf(id, 'verification.binding_carried')).rows).toEqual([expect.objectContaining({ payload: expect.objectContaining({ task_id: approved }) })])
    expect((await view('rita', id)).closeBlockers).toEqual([])
  })
  it('TC-FRD-25 with the confirmation of PR #26: confirming the unchanged value keeps the approved task; a person changing it invalidates it', async () => {
    const subject = 'Bank field confirmed'
    fieldAnswers.set(subject, CHANGE)
    const id = await ingest(subject, ['bank_details'], { text: 'Please change my bank account to the new one.' })
    const approved = await finishTask(id)
    const rev = await revision(id)
    expect((await put('rita', `/api/cases/${id}/fields/change_requested`, { confirm: true })).statusCode).toBe(200)
    await k.drain()
    expect(await revision(id)).toBe(rev + 1)
    expect((await one<{ state: string; m: number }>('SELECT state, bound_manual_revision AS m FROM verification_task WHERE id = $1', [approved]))).toEqual({ state: 'approved', m: rev + 1 })
    expect(await fieldsInvalidations(id)).toHaveLength(0)
    expect((await view('rita', id)).closeBlockers).toEqual([])
    // a real change of the value: the task goes, and the replacement records that the fields changed
    expect((await put('rita', `/api/cases/${id}/fields/change_requested`, { value: false })).statusCode).toBe(200)
    await k.drain()
    expect((await one<{ state: string }>('SELECT state FROM verification_task WHERE id = $1', [approved])).state).toBe('invalidated')
    expect((await fieldsInvalidations(id)).map((r) => r.payload.task_id)).toEqual([approved])
  })
  it('TC-FRD-25 a KYC replacement that removes a person\'s field value invalidates the approved task', async () => {
    const id = await ingest('Identity change with documents', ['identity_change'], {
      text: 'My surname has changed, documents attached.',
      attachments: [{ type: 'application/pdf', filename: 'passport.pdf', content: makePdf(['P<GBRHART<<AMELIA passport']) }],
    })
    // a person sets the changed fields: a person's change, so the task is made again on that value, then approved
    expect((await put('rita', `/api/cases/${id}/fields/change_fields`, { value: ['name'] })).statusCode).toBe(200)
    await k.drain()
    const approved = await finishTask(id)
    const rev = await revision(id)
    const messageId = (await one<{ message_id: string }>('SELECT message_id FROM "case" WHERE id = $1', [id])).message_id
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM attachment WHERE message_id = $1 AND maybe_kyc', [messageId])).n).toBeGreaterThan(0)
    class Sink implements KycSink {
      async deliver(_b: Buffer, meta: KycFile): Promise<KycReceipt> {
        return { target: 'folder', name: meta.name, sha256: meta.sha256 }
      }
    }
    await runKycDeliveries({ db: k.t.app, k: k.k, files: k.files }, new Sink())
    // the replacement removes the person's field edit without a new manual revision, and runs the Case again
    expect(await replaceMessage({ db: k.t.maintenance, k: k.k, files: k.files }, messageId)).toBe('done')
    await k.drain()
    expect(await revision(id)).toBe(rev)
    expect(await count('case_field_change WHERE case_id = $1', [id])).toBe(0)
    expect((await one<{ state: string }>('SELECT state FROM verification_task WHERE id = $1', [approved])).state).toBe('invalidated')
    expect((await fieldsInvalidations(id)).filter((r) => r.payload.task_id === approved)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ was: 'approved' }) })])
    expect(await count("verification_task WHERE case_id = $1 AND kind = 'identity_change' AND state = 'open'", [id])).toBe(1)
  })
})

describe('upgrade (migration 009 and the start-up step)', () => {
  // the statements of 009 between two of its comments, as the migration runs them (they touch every row of this
  // database, so this describe runs last)
  const section = (start: string, end: string) => {
    const sql = readFileSync('src/store/migrations/009_fraud_gates.sql', 'utf8')
    return sql.slice(sql.indexOf(start), sql.indexOf(end))
  }
  it('TC-FRD-23 / TC-FRD-24 every approved, unsent reply goes back to draft and its Case to open, with an audit entry written once at start-up; a closed Case says closed', async () => {
    const id = await ingest('Approved before upgrade', ['legal_documents'])
    const rep = await draftOf(id)
    expect((await post('rita', `/api/cases/${id}/replies/${rep}/approve`)).statusCode).toBe(200)
    expect(await statusOf(id)).toBe('approved')
    const sent = await ingest('Sent before upgrade', ['legal_documents'])
    const sentRep = await draftOf(sent)
    await post('rita', `/api/cases/${sent}/replies/${sentRep}/approve`)
    await post('rita', `/api/cases/${sent}/replies/${sentRep}/sent`)
    // a Case closed before this change whose status moved on afterwards (the old /sent did that)
    const closed = await ingest('Closed then sent before upgrade', ['legal_documents'])
    await owner(`UPDATE "case" SET closed_at = now(), status = 'sent', outcome = 'no_action' WHERE id = $1`, [closed])
    // the table and the statements as 009 runs them (the table exists already in this database)
    await owner('DELETE FROM rollout_lapsed_reply')
    await owner(section('-- C-FRD-8: closed_at decides', '-- C-DRF-10: a case-level').replace(/CREATE TABLE rollout_lapsed_reply[^;]*;\s*REVOKE[^;]*;\s*GRANT[^;]*;/, ''))
    expect(await statusOf(closed)).toBe('closed')
    expect((await one<{ status: string; approved_by: string | null }>('SELECT status, approved_by FROM reply WHERE id = $1', [rep]))).toEqual({ status: 'draft', approved_by: null })
    expect(await statusOf(id)).toBe('open')
    expect((await one<{ status: string }>('SELECT status FROM reply WHERE id = $1', [sentRep])).status).toBe('sent')
    expect(await statusOf(sent)).toBe('sent')
    await fraudGatesRollout(k)
    expect((await auditOf(id, 'reply.approval_lapsed')).rows).toEqual([expect.objectContaining({ payload: { reply_id: rep, problems: ['rules_changed'] } })])
    expect(await count('rollout_lapsed_reply', [])).toBe(0)
    await fraudGatesRollout(k)
    expect((await auditOf(id, 'reply.approval_lapsed')).rows).toHaveLength(1)
    // approving again works under the new rules
    expect((await post('rita', `/api/cases/${id}/replies/${rep}/approve`)).statusCode).toBe(200)
  })
  const lapse = async () => {
    await owner('DELETE FROM rollout_lapsed_reply')
    await owner(section('-- C-DRF-9: an approval given', '-- C-DRF-10: a case-level').replace(/CREATE TABLE rollout_lapsed_reply[^;]*;\s*REVOKE[^;]*;\s*GRANT[^;]*;/, ''))
  }
  it('TC-DRF-27 the lapse audit is written from the stored Case even when maintenance deleted the reply before start-up', async () => {
    const id = await ingest('Approved then deleted before start-up', ['legal_documents'])
    const rep = await draftOf(id)
    expect((await post('rita', `/api/cases/${id}/replies/${rep}/approve`)).statusCode).toBe(200)
    await lapse()
    await owner('DELETE FROM reply WHERE id = $1', [rep]) // as a KYC replacement deletes an unsent reply
    await fraudGatesRollout(k)
    expect((await auditOf(id, 'reply.approval_lapsed')).rows).toEqual([expect.objectContaining({ payload: { reply_id: rep, problems: ['rules_changed'] } })])
    expect(await count('rollout_lapsed_reply', [])).toBe(0)
  })
  it('TC-DRF-28 an approved, unsent reply on a closed Case goes back to draft too; the Case stays closed and is not run again', async () => {
    const id = await ingest('Approved then closed before upgrade', ['legal_documents'])
    const rep = await draftOf(id)
    expect((await post('rita', `/api/cases/${id}/replies/${rep}/approve`)).statusCode).toBe(200)
    // closed by the code before this change, which left the approved reply as it was
    await owner(`UPDATE "case" SET closed_at = now(), status = 'closed', outcome = 'no_action' WHERE id = $1`, [id])
    await lapse()
    expect((await one<{ status: string; approved_by: string | null }>('SELECT status, approved_by FROM reply WHERE id = $1', [rep]))).toEqual({ status: 'draft', approved_by: null })
    expect(await statusOf(id)).toBe('closed')
    await fraudGatesRollout(k)
    expect((await auditOf(id, 'reply.approval_lapsed')).rows).toEqual([expect.objectContaining({ payload: { reply_id: rep, problems: ['rules_changed'] } })])
    expect((await auditOf(id, 'case.rerun_for_check')).rows).toHaveLength(0)
    expect(await statusOf(id)).toBe('closed')
  })
  it('TC-FRD-26 an approved task from before the field binding is invalidated at start-up and its Case run again; after a KYC replacement changes a field no approved task survives; on a closed Case it goes too', async () => {
    const id = await ingest('Identity change before upgrade', ['identity_change'], {
      text: 'My surname has changed, documents attached.',
      attachments: [{ type: 'application/pdf', filename: 'passport.pdf', content: makePdf(['P<GBRHART<<AMELIA passport']) }],
    })
    expect((await put('rita', `/api/cases/${id}/fields/change_fields`, { value: ['name'] })).statusCode).toBe(200)
    await k.drain()
    const approved = await finishTask(id)
    const closed = await ingest('Bank change closed before upgrade', ['bank_details'], { text: 'Please change my bank account to the new one.' })
    const closedTask = await finishTask(closed)
    expect((await post('rita', `/api/cases/${closed}/close`, { outcome: 'no_action' })).statusCode).toBe(200)
    // the tasks as they were before 009: no field binding
    await owner('UPDATE verification_task SET bound_fields_sha256 = NULL WHERE id = ANY($1::uuid[])', [[approved, closedTask]])
    const r = await fraudGatesRollout(k)
    expect(r.unbound).toBeGreaterThanOrEqual(2)
    for (const [c, t] of [[id, approved], [closed, closedTask]] as const) {
      expect((await one<{ state: string }>('SELECT state FROM verification_task WHERE id = $1', [t])).state).toBe('invalidated')
      expect((await auditOf(c, 'verification.invalidated')).rows.filter((x) => x.payload.task_id === t)).toEqual([{ payload: { task_id: t, was: 'approved', reason: 'fields_unbound_at_upgrade' } }])
    }
    expect((await auditOf(id, 'case.rerun_for_check')).rows.map((x) => x.payload)).toEqual([expect.objectContaining({ kinds: ['identity_change'], from: 'fields' })])
    expect((await auditOf(closed, 'case.rerun_for_check')).rows).toHaveLength(0)
    expect(await statusOf(closed)).toBe('closed')
    expect((await view('rita', id)).closeBlockers.join(' ')).toMatch(/still|not finished|has not been created/i)
    await k.drain()
    expect(await count("verification_task WHERE case_id = $1 AND kind = 'identity_change' AND state = 'open' AND bound_fields_sha256 IS NOT NULL", [id])).toBe(1)
    // the KYC replacement removes the person's field value and runs the Case again: nothing approved before survives it
    const messageId = (await one<{ message_id: string }>('SELECT message_id FROM "case" WHERE id = $1', [id])).message_id
    class Sink implements KycSink {
      async deliver(_b: Buffer, meta: KycFile): Promise<KycReceipt> {
        return { target: 'folder', name: meta.name, sha256: meta.sha256 }
      }
    }
    await runKycDeliveries({ db: k.t.app, k: k.k, files: k.files }, new Sink())
    expect(await replaceMessage({ db: k.t.maintenance, k: k.k, files: k.files }, messageId)).toBe('done')
    await k.drain()
    expect(await count("verification_task WHERE case_id = $1 AND state = 'approved'", [id])).toBe(0)
    expect((await view('rita', id)).closeBlockers.join(' ')).toMatch(/not been approved/)
    // a second start finds nothing left
    expect((await fraudGatesRollout(k)).unbound).toBe(0)
  })
  it('TC-FRD-28 one Case the start-up step cannot do is audited and skipped; the others are done and the Case cannot be closed normally', async () => {
    const bad = await ingest('Unbound bad case', ['bank_details'], { text: 'Please change my bank account to the new one.' })
    const good = await ingest('Unbound good case', ['bank_details'], { text: 'Please change my bank account to the new one.' })
    const badTask = await finishTask(bad)
    const goodTask = await finishTask(good)
    await owner('UPDATE verification_task SET bound_fields_sha256 = NULL WHERE id = ANY($1::uuid[])', [[badTask, goodTask]])
    const queue = { send: async (c: Parameters<typeof k.boss.send>[0], stage: Stage, job: StageJob) => { if (job.caseId === bad) throw new Error('queue down for this case'); return k.boss.send(c, stage, job) } }
    const r = await fraudGatesRollout({ ...k, queue })
    expect(r.failed).toBe(1)
    expect((await auditOf(bad, 'case.rollout_failed')).rows).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: 'internal' }) })])
    expect(JSON.stringify((await auditOf(bad, 'case.rollout_failed')).rows)).not.toMatch(/queue down/) // the text only in the encrypted detail
    expect((await auditOf(good, 'case.rerun_for_check')).rows).toHaveLength(1)
    // the failed Case kept its unbound task, which counts as changed: a normal close is refused
    expect((await one<{ state: string }>('SELECT state FROM verification_task WHERE id = $1', [badTask])).state).toBe('approved')
    expect((await post('rita', `/api/cases/${bad}/close`, { outcome: 'no_action' })).statusCode).toBe(403)
    // the next start does it
    expect((await fraudGatesRollout(k)).failed).toBe(0)
    expect((await auditOf(bad, 'case.rerun_for_check')).rows).toHaveLength(1)
    await k.drain()
  })
})
