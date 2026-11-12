// Integration-test kit: a fresh database, a temp file store, pg-boss as the app role, and a drain loop.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type Config } from '../config/load.ts'
import { createTestDb, TEST_URL, type TestDb } from '../store/testdb.ts'
import { DiskStore } from '../store/files.ts'
import { Clamd, type Scanner } from '../adapters/scan/clamd.ts'
import { InProcessParser, type ParserClient } from './parser-client.ts'
import { BossQueue, STAGES, type StageJob } from './queue.ts'
import { ensureMailboxes, ingestMessage, type MailboxInfo } from './ingest.ts'
import { markFailed, runStage, type StageDeps } from './stages.ts'
import type { z } from 'zod'
import { validated, type LlmAdapter, type LlmRequest, type LlmResult } from '../adapters/llm/types.ts'
import { importDirectory, type DirectoryKind } from '../store/directory.ts'

/** Recognises the EICAR test string only; the real clamd is used where a test is about scanning. */
export class FakeScanner implements Scanner {
  async scan(data: Buffer) {
    return data.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? { clean: false as const, signature: 'Eicar-Test-Signature' } : { clean: true as const }
  }
}

export const clamd = () => new Clamd(process.env.TEST_CLAMD_HOST ?? 'localhost', Number(process.env.TEST_CLAMD_PORT ?? 53310))

export interface Kit extends StageDeps {
  t: TestDb
  boss: BossQueue
  mailbox: MailboxInfo
  ingest(raw: Buffer, receivedAt?: string, mailbox?: MailboxInfo): ReturnType<typeof ingestMessage>
  drain(): Promise<void>
  importCsv(kind: DirectoryKind, csv: string, deal?: string): Promise<void>
  close(): Promise<void>
}

export function testConfig(): Config {
  const c = loadConfig('config/default')
  return {
    ...c,
    mailboxes: [
      { id: 'ops', name: 'Operations', kind: 'eml', strips_external_auth_results: false, catch_up_minutes: 5 },
      { id: 'legal', name: 'Legal', kind: 'eml', strips_external_auth_results: false, catch_up_minutes: 5 },
    ],
    esign_platforms: { 'Example Sign': ['esign.example'] },
  }
}

/** A scripted model: `reply(promptVersion, user)` returns the raw reply; every request is recorded. */
export class FakeLlm implements LlmAdapter {
  readonly id = 'fake/model'
  readonly location = 'local' as const
  readonly requests: Array<LlmRequest<z.ZodType>> = []
  defaultReply = (v: string) => (v.startsWith('classify') ? '{"labels":[{"class":"unclassified","confidence":"high","reason":"test"}],"language":"en"}' : '{"fields":{}}')
  reply: (promptVersion: string, user: string) => string = (v) => this.defaultReply(v)
  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResult<z.infer<S>>> {
    this.requests.push(req)
    const raw = this.reply(req.promptVersion, req.user)
    return { raw, parsed: validated(req.schema, raw), usage: { inputTokens: 0, outputTokens: 0 } }
  }
}

export async function createKit(o: { scanner?: Scanner; parser?: ParserClient; config?: Config; llm?: LlmAdapter } = {}): Promise<Kit> {
  const t = await createTestDb()
  const config = o.config ?? testConfig()
  const u = new URL(TEST_URL)
  u.pathname = `/${t.name}`
  u.username = 'trunks_app'
  u.password = 'test-trunks_app'
  const boss = new BossQueue(u.toString())
  await boss.start()
  const files = new DiskStore(mkdtempSync(join(tmpdir(), 'trunks-files-')), t.keyring)
  const deps: StageDeps = { db: t.app, k: t.keyring, files, config, queue: boss, scanner: o.scanner ?? new FakeScanner(), parser: o.parser ?? new InProcessParser(), llm: o.llm ?? new FakeLlm() }
  await ensureMailboxes(t.app, t.keyring, config)
  const mailbox: MailboxInfo = { id: 'ops', trustedAuthResults: false, trustedAuthservId: 'mx.ops.example' }
  const kit: Kit = {
    ...deps,
    t,
    boss,
    mailbox,
    ingest: (raw, receivedAt = '2026-10-29T10:15:00.000Z', mb = mailbox) => ingestMessage(deps, mb, raw, receivedAt),
    async drain() {
      for (let round = 0; round < 50; round++) {
        let any = false
        for (const stage of STAGES) {
          const jobs = await boss.boss.fetch<StageJob>(stage, { batchSize: 20 })
          for (const j of jobs) {
            any = true
            try {
              await runStage(deps, stage, j.data)
              await boss.boss.complete(stage, j.id)
            } catch (e) {
              await markFailed(deps, stage, j.data, e)
              await boss.boss.fail(stage, j.id)
            }
          }
        }
        if (!any) return
      }
      throw new Error('drain did not settle')
    },
    async importCsv(kind, csv, deal) {
      const r = await importDirectory(t.app, t.keyring, { kind, csv, deal, userId: '00000000-0000-4000-8000-000000000001', currencies: config.deployment.currencies })
      if (!r.ok) throw new Error(JSON.stringify(r.errors))
    },
    async close() {
      await boss.stop()
      await t.drop()
    },
  }
  return kit
}
