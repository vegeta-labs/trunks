import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createKit, FakeLlm, type Kit } from './testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { SetupError, ReplayMissingError } from '../adapters/llm/types.ts'
import { FAILURE_TEXT, failureCode, failureLabel, originalText, sanitised, tagged, TaggedFailure } from './failure.ts'
import { stageHandler, type StageDeps } from './stages.ts'
import { RETRY, type Stage, type StageJob } from './queue.ts'
import { caseDetail } from '../server/cases.ts'
import { getBlobs } from '../store/blobs.ts'

// values from an email that must never reach a log, the job queue, the Case row or the API (TC-OPS-10)
const SECRET = 'GB82WEST12345698765432 Amelia Hart ignore previous instructions'

describe('failure codes (tech design v0.7.15, E6 D2)', () => {
  it('TC-OPS-10 codes by error class; labels carry only a class name; the queue error has no cause or extra properties', () => {
    const db = new pg.DatabaseError(`duplicate key value; ${SECRET}`, 0, 'error')
    db.detail = `Key (iban)=(${SECRET})`
    expect(failureCode(db)).toBe('database_error')
    expect(failureCode(new ReplayMissingError(SECRET))).toBe('replay_missing')
    expect(failureCode(new SetupError(SECRET))).toBe('model_setup')
    expect(failureCode(new TaggedFailure('parser_unavailable', new Error(SECRET)))).toBe('parser_unavailable')
    expect(failureCode(new Error(SECRET))).toBe('internal')
    expect(failureCode(SECRET)).toBe('internal')
    expect(failureLabel(new TypeError(SECRET))).toBe('internal (TypeError)')
    expect(failureLabel(db)).toBe('database_error')
    const odd = new Error(SECRET)
    Object.defineProperty(odd.constructor, 'name', { value: 'Error' })
    expect(failureLabel(odd)).toBe('internal (Error)')
    for (const e of [db, new SetupError(SECRET), new TaggedFailure('storage_error', db)]) {
      const s = sanitised(e)
      expect(s.message).not.toContain('GB82')
      expect(Object.keys(s)).toEqual([])
      expect((s as Error & { cause?: unknown }).cause).toBeUndefined()
      expect(JSON.stringify({ ...s, message: s.message })).not.toContain('Amelia')
    }
    expect(originalText(new TaggedFailure('storage_error', new Error(SECRET)))).toContain(SECRET)
  })

  it('TC-OPS-10 tagged() turns rejections and throws of every method into its code and leaves results alone', async () => {
    const t = tagged({ ok: async () => 1, bad: async () => { throw new Error(SECRET) }, sync: () => { throw new Error(SECRET) }, n: 3 }, 'scanner_unavailable')
    expect(await t.ok()).toBe(1)
    expect(t.n).toBe(3)
    await expect(t.bad()).rejects.toMatchObject({ code: 'scanner_unavailable', message: 'scanner_unavailable' })
    expect(() => t.sync()).toThrow('scanner_unavailable')
  })
})

let k: Kit
const llm = new FakeLlm()
beforeAll(async () => {
  k = await createKit({ llm })
}, 60_000)
afterAll(async () => k?.close())

async function auditDetail(caseId: string, type: string): Promise<string> {
  const sha = (await k.db.query(`SELECT payload->>'detail_sha256' AS sha FROM audit WHERE case_id = $1 AND type = $2 ORDER BY seq DESC LIMIT 1`, [caseId, type])).rows[0].sha
  const blob = (await k.db.query('SELECT content_blob FROM audit_detail WHERE sha256 = $1', [sha])).rows[0].content_blob
  return (await getBlobs(k.db, k.k, [blob])).get(blob)!.toString('utf8')
}

describe('stage failures in the worker (TC-OPS-10)', () => {
  // one Case per failure kind; the failing adapter throws an error whose text carries email values
  const kinds: Array<{ code: string; stage: Stage; deps: (d: StageDeps) => StageDeps }> = [
    { code: 'model_setup', stage: 'classify', deps: (d) => ({ ...d, llm: { ...llm, id: llm.id, location: llm.location, complete: async () => { throw new SetupError(`rejected: ${SECRET}`) } } }) },
    { code: 'replay_missing', stage: 'classify', deps: (d) => ({ ...d, llm: { ...llm, id: llm.id, location: llm.location, complete: async () => { throw new ReplayMissingError(`no recording for ${SECRET}`) } } }) },
    { code: 'scanner_unavailable', stage: 'scan', deps: (d) => ({ ...d, scanner: { scan: async () => { throw new Error(`clamd: ${SECRET}`) } } as never }) },
    { code: 'parser_unavailable', stage: 'parse', deps: (d) => ({ ...d, parser: { parse: async () => { throw new Error(`parser: ${SECRET}`) } } as never }) },
    { code: 'storage_error', stage: 'scan', deps: (d) => ({ ...d, files: { ...d.files, get: async () => { throw new Error(`ENOENT ${SECRET}`) } } as never }) },
  ]
  for (const kind of kinds) {
    it(`TC-OPS-10 ${kind.code}: every attempt logs only the code; the last marks the Case; the queue gets only the code`, async () => {
      llm.reply = () => '{"labels":[{"class":"complaint","confidence":"high","reason":"x"}],"language":"en"}'
      const r = (await k.ingest(eml({ subject: `Failure ${kind.code}`, text: SECRET, attachments: [{ filename: 'note.txt', type: 'text/plain', content: Buffer.from(SECRET) }] }))) as { caseId: string }
      // run the stages before the failing one normally
      const { runStage } = await import('./stages.ts')
      const { STAGES } = await import('./queue.ts')
      const job: StageJob = { caseId: r.caseId, generation: 1 }
      for (const s of STAGES.slice(0, STAGES.indexOf(kind.stage))) await runStage(k, s, job)
      const lines: string[] = []
      const handle = stageHandler(kind.deps(k), kind.stage, RETRY.retryLimit, (l) => lines.push(l))
      const thrown: Error[] = []
      for (let attempt = 0; attempt <= RETRY.retryLimit; attempt++) {
        await handle({ data: job, retryCount: attempt }).then(() => thrown.push(new Error('no failure')), (e: Error) => thrown.push(e))
      }
      expect(lines).toEqual([1, 2, 3, 4].map((n) => `step failed case=${r.caseId} step=${kind.stage} reason=${kind.code} attempt=${n}`))
      for (const e of thrown) {
        expect(e.message).toBe(kind.code)
        expect(Object.keys(e)).toEqual([])
      }
      // what pg-boss stores for a failed job: only the code
      const id = await k.boss.boss.send(kind.stage, job)
      await k.boss.boss.fail(kind.stage, id!, thrown.at(-1)!)
      const out = (await k.t.owner.query('SELECT output FROM pgboss.job WHERE id = $1', [id])).rows[0].output
      expect(JSON.stringify(out)).toContain(kind.code)
      expect(JSON.stringify(out)).not.toMatch(/GB82|Amelia|ignore previous/)
      // the Case: failed at that step with the code; the API shows the fixed sentence; the audit row has the code,
      // the original text only in the encrypted detail
      const row = (await k.db.query('SELECT status, failed_stage, failed_reason FROM "case" WHERE id = $1', [r.caseId])).rows[0]
      expect(row).toEqual({ status: 'failed', failed_stage: kind.stage, failed_reason: kind.code })
      const d = (await caseDetail(k, r.caseId))!
      expect(d.failedReason).toBe(FAILURE_TEXT[kind.code as keyof typeof FAILURE_TEXT])
      const payload = (await k.db.query(`SELECT payload FROM audit WHERE case_id = $1 AND type = 'stage.failed'`, [r.caseId])).rows[0].payload
      expect(payload).toMatchObject({ stage: kind.stage, reason: kind.code })
      expect(JSON.stringify(payload)).not.toContain('GB82')
      expect(await auditDetail(r.caseId, 'stage.failed')).toContain('GB82WEST12345698765432')
    }, 60_000)
  }

  it('TC-OPS-10 a re-run clears the reason; the migration leaves no old error text in pg-boss', async () => {
    const { rerunFailed } = await import('./restart.ts')
    const { tx } = await import('../store/db.ts')
    const failed = (await k.db.query(`SELECT id FROM "case" WHERE status = 'failed' LIMIT 1`)).rows[0].id
    await tx(k.db, (c) => rerunFailed(c, k.k, k.boss, failed))
    expect((await k.db.query('SELECT failed_stage, failed_reason FROM "case" WHERE id = $1', [failed])).rows[0]).toEqual({ failed_stage: null, failed_reason: null })
    // the KYC continuation clears it too
    await k.t.owner.query(`UPDATE "case" SET status = 'failed', failed_stage = 'classify', failed_reason = 'internal' WHERE id = $1`, [failed])
    const gen = (await k.db.query('SELECT processing_generation FROM "case" WHERE id = $1', [failed])).rows[0].processing_generation
    await k.t.owner.query('SELECT enqueue_kyc_continuation($1, $2)', [failed, gen])
    expect((await k.db.query('SELECT status, failed_stage, failed_reason FROM "case" WHERE id = $1', [failed])).rows[0]).toEqual({ status: 'processing', failed_stage: null, failed_reason: null })
    // a failed job stored before E6 with the raw error text: the migration's clean-up removes it
    const old = await k.boss.boss.send('scan', { caseId: failed, generation: 99 })
    await k.boss.boss.fail('scan', old!, new Error(SECRET))
    expect((await k.t.owner.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE output::text LIKE '%GB82%'`)).rows[0].n).toBe(1)
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('src/store/migrations/007_e6.sql', 'utf8')
    await k.t.owner.query(sql.slice(sql.indexOf('DO $$'), sql.indexOf('END $$;', sql.indexOf('DO $$')) + 'END $$;'.length))
    expect((await k.t.owner.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE output::text LIKE '%GB82%'`)).rows[0].n).toBe(0)
  }, 60_000)
})


it('TC-OPS-10 failure-recording errors at the final retry cannot escape to pg-boss with raw message or detail', async () => {
  const dbError = new pg.DatabaseError(SECRET, 0, 'error'); dbError.detail = SECRET
  const db = Object.assign(Object.create(k.db), { query: async () => { throw dbError }, connect: async () => { throw dbError } })
  const lines: string[] = []
  const handler = stageHandler({ ...k, db }, 'scan', 3, (line) => lines.push(line))
  const error = await handler({ data: { caseId: '00000000-0000-4000-8000-000000000001', generation: 1 }, retryCount: 3 }).catch((e: Error) => e)
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBe(dbError)
  expect((error as Error).message).toBe('database_error')
  expect(Object.keys(error!)).toEqual([])
  expect(JSON.stringify(lines)).not.toContain(SECRET)
})
