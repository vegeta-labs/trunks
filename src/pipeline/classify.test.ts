import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKit, FakeLlm, type Kit } from './testkit.ts'
import { SetupError } from '../adapters/llm/types.ts'
import { eml } from '../ingest/testmail.ts'
import { runStage, stageResult, type ClassifyResult } from './stages.ts'
import { getBlobs } from '../store/blobs.ts'
import { makePdf } from '../../parser/testfiles.ts'
import { loadConfig } from '../config/load.ts'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let k: Kit
const llm = new FakeLlm()
beforeAll(async () => {
  k = await createKit({ llm })
  await k.importCsv('deals', 'name,currency,close_date\nNorthwind Robotics,GBP,2026-11-02\n')
  await k.importCsv('contacts', 'contact_id,name,email,phone,role,deal,investor_id\nC001,Amelia Hart,amelia@hartfamily.example,+44 7700 900123,investor,Northwind Robotics,\n')
}, 60_000)
afterAll(async () => k?.close())

const caseOf = (r: unknown) => (r as { caseId: string }).caseId
const labels = async (caseId: string) =>
  (await k.db.query('SELECT class_id, source, confidence, adopted FROM case_label WHERE case_id = $1 ORDER BY source, class_id', [caseId])).rows
async function detail(caseId: string, type: string) {
  const sha = (await k.db.query(`SELECT payload->>'detail_sha256' AS sha FROM audit WHERE case_id = $1 AND type = $2 ORDER BY seq DESC LIMIT 1`, [caseId, type])).rows[0].sha
  const blob = (await k.db.query('SELECT content_blob FROM audit_detail WHERE sha256 = $1', [sha])).rows[0].content_blob
  return JSON.parse((await getBlobs(k.db, k.k, [blob])).get(blob)!.toString('utf8'))
}

describe('classify stage (C-CLS, C-RED-0)', () => {
  it('TC-CLS-01 an invalid reply is retried once; still invalid → unclassified, both replies kept in audit_detail', async () => {
    let n = 0
    llm.reply = (v) => (v.startsWith('classify') ? (n++ === 0 ? 'not json' : '{"labels":[{"class":"wire_fraud","confidence":"high","reason":"x"}],"language":"en"}') : '{}')
    const id = caseOf(await k.ingest(eml({ subject: 'Hello', text: 'Just checking in' })))
    await k.drain()
    expect(n).toBe(2)
    expect(await labels(id)).toEqual([{ class_id: 'unclassified', source: 'rule', confidence: 'rule', adopted: true }])
    expect((await stageResult<ClassifyResult>(k.db, k.k, id, 'classify'))!.modelFailed).toBe(true)
    const d = await detail(id, 'stage.classify')
    expect(d.requests[0].attempts.map((a: { raw: string }) => a.raw)).toEqual(['not json', '{"labels":[{"class":"wire_fraud","confidence":"high","reason":"x"}],"language":"en"}'])
    // the audit row itself holds no model text (TC-AUD-06b)
    const row = (await k.db.query(`SELECT payload FROM audit WHERE case_id = $1 AND type = 'stage.classify'`, [id])).rows[0].payload
    expect(JSON.stringify(row)).not.toContain('wire_fraud')
  }, 60_000)

  it('TC-CLS-04a / TC-CLS-05 / TC-CLS-09 model labels high + medium adopted, low kept for risk; rule labels added (IBAN in the body)', async () => {
    llm.reply = (v) =>
      v.startsWith('classify')
        ? '{"labels":[{"class":"payment_query","confidence":"high","reason":"a"},{"class":"identity_change","confidence":"medium","reason":"b"},{"class":"complaint","confidence":"low","reason":"c"}],"language":"en"}'
        : '{}'
    const id = caseOf(await k.ingest(eml({ subject: 'Paid', text: 'I paid. Please use GB82 WEST 1234 5698 7654 32 from now on.' })))
    await k.drain()
    expect(await labels(id)).toEqual([
      { class_id: 'complaint', source: 'model', confidence: 'low', adopted: false },
      { class_id: 'identity_change', source: 'model', confidence: 'medium', adopted: true },
      { class_id: 'payment_query', source: 'model', confidence: 'high', adopted: true },
      { class_id: 'bank_details', source: 'rule', confidence: 'rule', adopted: true },
    ])
    // the model saw placeholders, not the IBAN
    expect(llm.requests.at(-1)!.user).toContain('[ACCOUNT_1]')
    expect(llm.requests.at(-1)!.user).not.toContain('GB82')
  }, 60_000)

  it('TC-RED-04 (request) the content of a possible-KYC attachment is not in the model request; its name is redacted; maybe_kyc is set', async () => {
    llm.reply = () => '{"labels":[{"class":"kyc_documents","confidence":"high","reason":"x"}],"language":"en"}'
    const before = llm.requests.length
    const id = caseOf(await k.ingest(eml({
      subject: 'Documents',
      text: 'Please find my passport attached.',
      attachments: [
        { type: 'application/pdf', filename: 'Amelia_Hart_passport.pdf', content: makePdf(['CANARY-KYC-CONTENT 1980-01-01']) },
        { type: 'application/pdf', filename: 'invoice.pdf', content: makePdf(['Invoice 1042 total GBP 1,200.00']) },
      ],
    })))
    await k.drain()
    const reqs = llm.requests.slice(before)
    expect(reqs.length).toBeGreaterThan(0)
    for (const r of reqs) {
      expect(r.user).not.toContain('CANARY-KYC-CONTENT')
      expect(r.user).not.toContain('Amelia')
      expect(r.user).toContain('[content withheld: possible KYC document]')
      expect(r.user).toContain('Invoice 1042') // the ordinary attachment is sent
    }
    const kyc = (await k.db.query('SELECT ordinal, maybe_kyc FROM attachment WHERE message_id = (SELECT message_id FROM "case" WHERE id = $1) ORDER BY ordinal', [id])).rows
    expect(kyc).toEqual([{ ordinal: 0, maybe_kyc: true }, { ordinal: 1, maybe_kyc: false }])
  }, 60_000)

  it('TC-RED-05 a local model gets the same redacted request; a redact_local key in the configuration fails to load', async () => {
    expect(llm.location).toBe('local')
    expect(llm.requests.every((r) => !r.user.includes('GB82'))).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), 'doi-cfg-'))
    cpSync('config/default', dir, { recursive: true })
    const f = join(dir, 'deployment.yaml')
    const base = readFileSync(f, 'utf8')
    writeFileSync(f, `${base.slice(0, base.indexOf('\nmodel:'))}\nmodel:\n  provider: ollama\n  model_id: llama\n  location: local\n  dpa: false\n  no_training: true\n  ollama_host: http://ollama.local:11434\n  redact_local: false\n`)
    expect(() => loadConfig(dir)).toThrow(/redact_local/)
  })

  it('TC-FLD-07 (classify) a retried step reuses the saved model reply and does not call the model again', async () => {
    let calls = 0
    llm.reply = (v) => {
      if (!v.startsWith('classify')) return '{"fields":{}}'
      calls++
      return '{"labels":[{"class":"complaint","confidence":"high","reason":"x"}],"language":"en"}'
    }
    const id = caseOf(await k.ingest(eml({ subject: 'Unhappy', text: 'I am not happy with the service' })))
    await k.drain()
    expect(calls).toBe(1)
    // the step ran but its result was lost (a crash before commit): remove it and run the step again
    await k.t.owner.query(`DELETE FROM stage_run WHERE case_id = $1 AND stage = 'classify'`, [id])
    await k.t.owner.query('DELETE FROM case_label WHERE case_id = $1', [id])
    expect(await runStage(k, 'classify', { caseId: id, generation: 1 })).toBe('published')
    expect(calls).toBe(1)
    expect((await labels(id)).map((l) => l.class_id)).toEqual(['complaint'])
  }, 60_000)

  it('TC-FLD-07 (Codex E2 round 4 F20) attempt 2 sent but its save failed: the retry does not send it a third time', async () => {
    let calls = 0
    llm.reply = (v) => {
      if (!v.startsWith('classify')) return '{"fields":{}}'
      calls++
      return calls === 1 ? 'not json' : '{"labels":[{"class":"complaint","confidence":"high","reason":"x"}],"language":"en"}'
    }
    // the database refuses to save attempt 2, after the model has answered it
    await k.t.owner.query(`CREATE FUNCTION refuse_attempt_2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.attempt = 2 THEN RAISE EXCEPTION 'save failed'; END IF; RETURN NEW; END $$`)
    await k.t.owner.query('CREATE TRIGGER refuse_attempt_2 BEFORE INSERT ON model_output FOR EACH ROW EXECUTE FUNCTION refuse_attempt_2()')
    let id: string
    try {
      id = caseOf(await k.ingest(eml({ subject: 'Save fails', text: 'Please look into this' })))
      await k.drain()
      expect(calls).toBe(2)
    } finally {
      await k.t.owner.query('DROP TRIGGER refuse_attempt_2 ON model_output')
      await k.t.owner.query('DROP FUNCTION refuse_attempt_2()')
    }
    await runStage(k, 'classify', { caseId: id, generation: 1 })
    expect(calls).toBe(2) // attempt 2 may have reached the model: it counts, and is not sent again
    expect((await k.db.query('SELECT attempt, error FROM model_output WHERE case_id = $1 ORDER BY attempt', [id])).rows).toEqual([{ attempt: 1, error: 'output_error' }, { attempt: 2, error: 'interrupted' }])
    expect(await labels(id)).toEqual([{ class_id: 'unclassified', source: 'rule', confidence: 'rule', adopted: true }])
  }, 60_000)

  it('TC-FLD-07 (F20) a setup error releases its reservation: once fixed, the request is sent as attempt 1', async () => {
    let calls = 0
    let broken = true
    llm.reply = (v) => {
      if (!v.startsWith('classify')) return '{"fields":{}}'
      if (broken) throw new SetupError('cannot connect to ollama (ECONNREFUSED)')
      calls++
      return '{"labels":[{"class":"complaint","confidence":"high","reason":"x"}],"language":"en"}'
    }
    const id = caseOf(await k.ingest(eml({ subject: 'Setup first', text: 'Please look into this too' })))
    await k.drain()
    expect((await k.db.query('SELECT count(*)::int AS n FROM model_attempt WHERE case_id = $1', [id])).rows[0].n).toBe(0)
    broken = false
    await runStage(k, 'classify', { caseId: id, generation: 1 })
    expect(calls).toBe(1)
    expect((await labels(id)).map((l) => l.class_id)).toEqual(['complaint'])
  }, 60_000)

  it('C-FLD-0 a provider error is a failed attempt: retried once, then unclassified; a re-run of the step never calls again', async () => {
    let calls = 0
    llm.reply = (v) => {
      if (!v.startsWith('classify')) return '{"fields":{}}'
      calls++
      throw new Error('529 overloaded')
    }
    const id = caseOf(await k.ingest(eml({ subject: 'Hello again', text: 'Checking in once more' })))
    await k.drain()
    expect(calls).toBe(2)
    expect((await k.db.query('SELECT status FROM "case" WHERE id = $1', [id])).rows[0].status).not.toBe('failed')
    expect(await labels(id)).toEqual([{ class_id: 'unclassified', source: 'rule', confidence: 'rule', adopted: true }])
    const d = await detail(id, 'stage.classify')
    // a fixed code in model_output; the message only in the encrypted audit detail (Codex E2 re-run F3)
    expect(d.requests[0].attempts.map((a: { error: string; detail: string }) => [a.error, a.detail])).toEqual([['provider_error', '529 overloaded'], ['provider_error', '529 overloaded']])
    await k.t.owner.query(`DELETE FROM stage_run WHERE case_id = $1 AND stage = 'classify'`, [id])
    await k.t.owner.query('DELETE FROM case_label WHERE case_id = $1', [id])
    expect(await runStage(k, 'classify', { caseId: id, generation: 1 })).toBe('published')
    expect(calls).toBe(2)
  }, 60_000)

  it('TC-OPS-09 a failed Case runs again from the step that failed (rerun-failed); a Case that is not failed is left as it is', async () => {
    const { ReplayMissingError } = await import('../adapters/llm/types.ts')
    const { rerunFailed } = await import('./restart.ts')
    const { tx } = await import('../store/db.ts')
    const orig = llm.complete.bind(llm)
    llm.reply = (v) => (v.startsWith('classify') ? '{"labels":[{"class":"complaint","confidence":"high","reason":"x"}],"language":"en"}' : '{}')
    // the model is unreachable for a while: the step fails after its retries
    llm.complete = (async (r: Parameters<typeof orig>[0]) => {
      if (!r.promptVersion.startsWith('classify')) return orig(r)
      throw new ReplayMissingError('no recording')
    }) as typeof llm.complete
    let id: string
    let closed: string
    try {
      id = caseOf(await k.ingest(eml({ subject: 'Rerun me', text: 'I am not happy with the service' })))
      closed = caseOf(await k.ingest(eml({ subject: 'Closed by a person', text: 'Handled by hand' })))
      await k.drain()
      expect((await k.db.query('SELECT status, failed_stage FROM "case" WHERE id = $1', [id])).rows[0]).toMatchObject({ status: 'failed', failed_stage: 'classify' })
    } finally {
      llm.complete = orig
    }
    const before = (await k.db.query<{ stage: string }>('SELECT stage FROM stage_run WHERE case_id = $1 ORDER BY stage', [id])).rows.map((r) => r.stage)
    expect(before).not.toContain('classify')
    // the cause is gone; the command runs it again from classify, the earlier steps carried over
    expect(await tx(k.db, (c) => rerunFailed(c, k.k, k.boss, id))).toMatchObject({ from: 'classify', generation: 2 })
    await k.drain()
    const after = (await k.db.query('SELECT status, failed_stage, generation_by, manual_revision FROM "case" WHERE id = $1', [id])).rows[0]
    expect(after).toMatchObject({ failed_stage: null, generation_by: 'system', manual_revision: 0 })
    expect(after.status).not.toBe('failed')
    expect((await labels(id)).find((l) => l.adopted)?.class_id).toBe('complaint')
    const reused = (await k.db.query<{ stage: string }>('SELECT stage FROM stage_run WHERE case_id = $1 AND generation = 2 AND reused ORDER BY stage', [id])).rows.map((r) => r.stage)
    expect(reused).toEqual(before)
    expect((await k.db.query(`SELECT payload FROM audit WHERE case_id = $1 AND type = 'case.rerun_failed'`, [id])).rows[0].payload).toMatchObject({ failed_stage: 'classify', from: 'classify', generation: 2 })
    // a failed Case a person closed (POST /api/cases/:id/close keeps failed_stage): left as it is
    await k.t.owner.query(`UPDATE "case" SET status = 'closed', closed_at = now(), outcome = 'no_action' WHERE id = $1`, [closed])
    expect((await k.db.query('SELECT failed_stage FROM "case" WHERE id = $1', [closed])).rows[0].failed_stage).toBe('classify')
    expect(await tx(k.db, (c) => rerunFailed(c, k.k, k.boss, closed))).toBeNull()
    expect((await k.db.query('SELECT status, processing_generation FROM "case" WHERE id = $1', [closed])).rows[0]).toMatchObject({ status: 'closed', processing_generation: 1 })
    // C-FRD-8: an older row marked failed after it was closed stays closed; a stray failed_stage on an open Case does nothing
    await k.t.owner.query(`UPDATE "case" SET status = 'failed' WHERE id = $1`, [closed])
    expect(await tx(k.db, (c) => rerunFailed(c, k.k, k.boss, closed))).toBeNull()
    await k.t.owner.query(`UPDATE "case" SET failed_stage = 'classify' WHERE id = $1`, [id])
    expect(await tx(k.db, (c) => rerunFailed(c, k.k, k.boss, id))).toBeNull()
    await k.t.owner.query(`UPDATE "case" SET failed_stage = NULL WHERE id = $1`, [id])
    // not failed any more: left as it is, nothing queued
    expect(await tx(k.db, (c) => rerunFailed(c, k.k, k.boss, id))).toBeNull()
    expect((await k.db.query('SELECT processing_generation FROM "case" WHERE id = $1', [id])).rows[0].processing_generation).toBe(2)
    // a failure after the reply was drafted (here: route, as markFailed leaves it): the re-run drafts the reply again
    // for the new generation, so it can be approved (Codex E5 round 5 F1)
    const draftOf = async (g: number) => (await k.db.query(`SELECT count(*)::int AS n FROM reply WHERE case_id = $1 AND generation = $2 AND status = 'draft'`, [id, g])).rows[0].n
    expect(await draftOf(2)).toBe(1)
    await k.t.owner.query(`DELETE FROM stage_run WHERE case_id = $1 AND generation = 2 AND stage IN ('route', 'emit')`, [id])
    await k.t.owner.query(`UPDATE "case" SET status = 'failed', failed_stage = 'route' WHERE id = $1`, [id])
    expect(await tx(k.db, (c) => rerunFailed(c, k.k, k.boss, id))).toMatchObject({ from: 'reply', generation: 3 })
    await k.drain()
    expect(await draftOf(3)).toBe(1)
    expect((await k.db.query('SELECT status, pipeline_complete_generation FROM "case" WHERE id = $1', [id])).rows[0]).toMatchObject({ status: 'open', pipeline_complete_generation: 3 })
  }, 120_000)

  it('X2 a reply the adapter refused (cut off) is a failed attempt even when its text parses; X1 a missing recording fails the step', async () => {
    const { LlmOutputError, ReplayMissingError } = await import('../adapters/llm/types.ts')
    let calls = 0
    const good = '{"labels":[{"class":"complaint","confidence":"high","reason":"x"}],"language":"en"}'
    const orig = llm.complete.bind(llm)
    llm.complete = (async (r: Parameters<typeof orig>[0]) => {
      if (!r.promptVersion.startsWith('classify')) return orig(r)
      calls++
      throw new LlmOutputError('reply cut off at max_tokens', good)
    }) as typeof llm.complete
    try {
      const id = caseOf(await k.ingest(eml({ subject: 'Cut off', text: 'A long complaint' })))
      await k.drain()
      expect(calls).toBe(2)
      expect((await labels(id)).map((l) => l.class_id)).toEqual(['unclassified'])
      expect((await detail(id, 'stage.classify')).requests[0].attempts.map((a: { error: string; detail: string }) => [a.error, a.detail])).toEqual([['output_error', 'reply cut off at max_tokens'], ['output_error', 'reply cut off at max_tokens']])
      llm.complete = (async (r: Parameters<typeof orig>[0]) => {
        if (!r.promptVersion.startsWith('classify')) return orig(r)
        throw new ReplayMissingError('no recording')
      }) as typeof llm.complete
      const id2 = caseOf(await k.ingest(eml({ subject: 'Missing', text: 'No recording for this one' })))
      await k.drain()
      expect((await k.db.query('SELECT status, failed_stage FROM "case" WHERE id = $1', [id2])).rows[0]).toMatchObject({ status: 'failed', failed_stage: 'classify' })
      expect((await k.db.query('SELECT count(*)::int AS n FROM model_output WHERE case_id = $1', [id2])).rows[0].n).toBe(0)
    } finally {
      llm.complete = orig
    }
  }, 120_000)

    it('TC-AUD-06b audit rows hold no model request or reply text; the replies are in audit_detail', async () => {
    const MARK = 'ZEBRA-REASON-TEXT'
    llm.reply = (v) =>
      v.startsWith('classify')
        ? JSON.stringify({ labels: [{ class: 'withdrawal', confidence: 'high', reason: MARK }], language: 'en' })
        : JSON.stringify({ fields: { investor: { value: '[NAME_1] [NAME_2]', confidence: 'high', quote: '[NAME_1] [NAME_2]' } } })
    const id = caseOf(await k.ingest(eml({ subject: 'Withdraw', text: 'Amelia Hart wants to withdraw. SECRET-BODY-WORDS' })))
    await k.drain()
    const rows = (await k.db.query(`SELECT type, payload FROM audit WHERE case_id = $1 AND type IN ('stage.classify', 'stage.fields')`, [id])).rows
    expect(rows.map((r) => r.type).sort()).toEqual(['stage.classify', 'stage.fields'])
    for (const r of rows) {
      const text = JSON.stringify(r.payload)
      for (const leak of [MARK, 'SECRET-BODY-WORDS', '[NAME_1]', 'Amelia']) expect(text).not.toContain(leak)
      expect(r.payload.detail_sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(JSON.stringify((await detail(id, 'stage.classify')).requests)).toContain(MARK)
    // the request is kept too, encrypted (tech design §5, Codex E2 re-run F9)
    // each request kept as sent, with its schema (round 2 F9): equal to what the adapter received
    for (const stage of ['stage.classify', 'stage.fields']) {
      for (const q of (await detail(id, stage)).requests) {
        expect(llm.requests.some((x) => x.system === q.system && x.user === q.user), stage).toBe(true)
        expect(q.user).toContain('SECRET-BODY-WORDS')
        expect(q.schema.type).toBe('object')
      }
    }
    expect(JSON.stringify((await detail(id, 'stage.fields')).requests)).toContain('[NAME_1] [NAME_2]')
  }, 60_000)
})

describe('Codex E2 re-run', () => {
  it('TC-RED-03 (F1) a block tag splitting an IBAN is removed before redaction: the request never holds the joined number', async () => {
    llm.reply = (v) => llm.defaultReply(v)
    const before = llm.requests.length
    await k.ingest(eml({ subject: 'Split', text: 'Pay GB82</body>WEST 1234 5698 7654 32 and <</body>body> done. <body title="passport">123456789 and <body title="account">12345678' }))
    await k.drain()
    const sent = llm.requests.slice(before).map((r) => r.user).join('\n')
    expect(sent).not.toMatch(/GB82\s*WEST/)
    expect(sent).toContain('[ACCOUNT_')
    // round 2 F10: keywords inside markup still count for redaction
    expect(sent).not.toContain('123456789')
    expect(sent).not.toContain('12345678')
    const n = llm.requests.length - before
    expect(sent.match(/<\/?body>/g)).toEqual(Array.from({ length: n }, () => ['<body>', '</body>']).flat()) // only the block's own tags
  }, 60_000)
  it('TC-CLS-01 (F3) a failed reply stores only a fixed code in plain text', async () => {
    llm.reply = (v) => (v.startsWith('classify') ? JSON.stringify({ labels: [{ class: 'payment_query', confidence: 'high', reason: 'x' }], language: 'en', 'Morgan Reed': 1 }) : '{}')
    const id = caseOf(await k.ingest(eml({ subject: 'Codes', text: 'Hello' })))
    await k.drain()
    const errs = (await k.db.query('SELECT error FROM model_output WHERE case_id = $1', [id])).rows.map((r) => r.error)
    for (const e of errs) expect(['schema_invalid', 'not_json', 'output_error', 'provider_error', null]).toContain(e)
    expect(JSON.stringify(errs)).not.toContain('Morgan')
  }, 60_000)
  it('TC-FLD-07 (F5) two workers on the same step call the model once', async () => {
    let calls = 0
    llm.reply = (v) => {
      if (v.startsWith('classify')) calls++
      return llm.defaultReply(v)
    }
    const id = caseOf(await k.ingest(eml({ subject: 'Twice', text: 'Hello twice' })))
    for (const st of ['scan', 'parse', 'content_signals', 'extract', 'redact'] as const) await runStage(k, st, { caseId: id, generation: 1 })
    const slow = llm.complete.bind(llm)
    llm.complete = async (req) => {
      await new Promise((r) => setTimeout(r, 200))
      return slow(req)
    }
    try {
      await Promise.all([runStage(k, 'classify', { caseId: id, generation: 1 }), runStage(k, 'classify', { caseId: id, generation: 1 })])
    } finally {
      llm.complete = slow
    }
    expect(calls).toBe(1)
  }, 60_000)
})

describe('Codex round 2 (E2 fixes)', () => {
  it('TC-RED-04 (request, round 2 F11) an attached message with a date of birth in a header and a nationality in its body is withheld', async () => {
    llm.reply = (v) => llm.defaultReply(v)
    const inner = 'From: someone@x.example\r\nSubject: record\r\nContent-Description: Date of birth: 1 Jan 1980\r\n\r\nNationality: British\r\nConfidential record: XZ1234567\r\n'
    const before = llm.requests.length
    const id = caseOf(await k.ingest(eml({ subject: 'Forwarded', text: 'See the attached message.', attachments: [{ type: 'message/rfc822', filename: 'forward.eml', content: Buffer.from(inner) }] })))
    await k.drain()
    const sent = llm.requests.slice(before).map((r) => r.user).join('\n')
    expect(sent).not.toContain('Nationality')
    expect(sent).not.toContain('XZ1234567')
    expect((await k.db.query('SELECT maybe_kyc FROM attachment WHERE message_id = (SELECT message_id FROM "case" WHERE id = $1)', [id])).rows.map((r) => r.maybe_kyc)).toContain(true)
  }, 60_000)
})

describe('Codex round 3 (E2 fixes)', () => {
  it('TC-RED-04 (request, round 3 F14) two birth details in the headers of two nested messages are counted together: nothing reaches the model', async () => {
    llm.reply = (v) => llm.defaultReply(v)
    const child = 'From: b@x.example\r\nSubject: child\r\nContent-Description: Date of birth: 1 Jan 1980\r\n\r\nConfidential record: ZX-AUDIT-MARKER\r\n'
    const forward = [
      'From: a@x.example', 'Subject: fwd', 'Content-Description: Nationality: British', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
      '--b1', 'Content-Type: text/plain', '', 'See below.', '--b1', 'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="child.eml"', '',
      child, '--b1--', '',
    ].join('\r\n')
    const before = llm.requests.length
    const id = caseOf(await k.ingest(eml({ subject: 'Forwarded twice', text: 'See the attached message.', attachments: [{ type: 'message/rfc822', filename: 'forward.eml', content: Buffer.from(forward) }] })))
    await k.drain()
    const sent = llm.requests.slice(before).map((r) => r.user).join('\n')
    expect(llm.requests.length).toBeGreaterThan(before) // the mail itself still goes to the model
    expect(sent).not.toContain('ZX-AUDIT-MARKER')
    expect(sent).not.toContain('Nationality')
    expect((await k.db.query('SELECT maybe_kyc FROM attachment WHERE message_id = (SELECT message_id FROM "case" WHERE id = $1)', [id])).rows.map((r) => r.maybe_kyc)).toContain(true)
  }, 60_000)
})

describe('Codex round 4 (E2 fixes)', () => {
  it('TC-RED-04 (request, round 4 F18) a combining mark after a KYC word does not hide it: name and content withheld', async () => {
    llm.reply = (v) => llm.defaultReply(v)
    const before = llm.requests.length
    const id = caseOf(await k.ingest(eml({ subject: 'Marked names', text: 'Two files attached.', attachments: [
      { type: 'text/plain', filename: 'passport\u0301.txt', content: Buffer.from('Confidential record: ZX-AUDIT-MARKER-1') },
      { type: 'text/plain', filename: 'notes.txt', content: Buffer.from('My passport\u0301 details. Confidential record: ZX-AUDIT-MARKER-2') },
    ] })))
    await k.drain()
    const sent = llm.requests.slice(before).map((r) => r.user).join('\n')
    expect(llm.requests.length).toBeGreaterThan(before) // the mail itself still goes to the model
    expect(sent).not.toContain('ZX-AUDIT-MARKER-1')
    expect(sent).not.toContain('ZX-AUDIT-MARKER-2')
    expect((await k.db.query('SELECT maybe_kyc FROM attachment WHERE message_id = (SELECT message_id FROM "case" WHERE id = $1) ORDER BY ordinal', [id])).rows.map((r) => r.maybe_kyc)).toEqual([true, true])
  }, 60_000)
})

