import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKit, type Kit } from './pipeline/testkit.ts'
import { loadConfig } from './config/load.ts'
import { recordConfig } from './startup.ts'
import { STAGES } from './pipeline/queue.ts'
import { eml } from './ingest/testmail.ts'
import { stageResult, type Extraction } from './pipeline/stages.ts'

let k: Kit
beforeAll(async () => {
  k = await createKit()
}, 60_000)
afterAll(async () => k?.close())

describe('R-CFG-02', () => {
  it('TC-CFG-02 a changed configuration is audited at start-up and the open Cases are processed again under it (Codex F13)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doi-cfg-'))
    cpSync('config/default', dir, { recursive: true })
    const gbpOnly = () => writeFileSync(join(dir, 'deployment.yaml'), readFileSync(join(dir, 'deployment.yaml'), 'utf8').replace('currencies: [GBP, EUR, USD]', 'currencies: [GBP]'))
    gbpOnly()
    const before = { ...k.config, ...loadConfig(dir), mailboxes: k.config.mailboxes }
    expect(await recordConfig(k.db, k.k, before, k.queue)).toBe('initial')
    expect(await recordConfig(k.db, k.k, before, k.queue)).toBe('unchanged')
    // a mail processed under the GBP-only configuration: EUR 100 is not an amount there
    const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><FIToFICstmrCdtTrf><CdtTrfTxInf><IntrBkSttlmAmt Ccy="EUR">250.00</IntrBkSttlmAmt></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>`
    const r = await k.ingest(eml({ text: 'We sent EUR 100 today', attachments: [{ type: 'application/xml', filename: 'pacs.xml', content: Buffer.from(xml) }] }))
    const caseId = (r as { caseId: string }).caseId
    const { runStage } = await import('./pipeline/stages.ts')
    for (const st of STAGES) await runStage({ ...k, config: before }, st, { caseId, generation: 1 })
    expect((await stageResult<Extraction>(k.db, k.k, caseId, 'extract'))!.amounts).toEqual([])
    expect((await stageResult<Extraction>(k.db, k.k, caseId, 'extract'))!.evidence).toMatchObject([{ source: 'pacs008', minor: null, currency: null }])
    // EUR is added; start-up records the change and processes the open Case again
    writeFileSync(join(dir, 'deployment.yaml'), readFileSync(join(dir, 'deployment.yaml'), 'utf8').replace('currencies: [GBP]', 'currencies: [GBP, EUR]'))
    const after = { ...k.config, ...loadConfig(dir), mailboxes: k.config.mailboxes }
    expect(await recordConfig(k.db, k.k, after, k.queue)).toBe('changed')
    const row = (await k.db.query(`SELECT payload FROM audit WHERE type = 'config.changed'`)).rows[0]
    expect(row.payload).toMatchObject({ config_sha256: after.sha256, cases_requeued: 1 })
    expect((await k.db.query('SELECT processing_generation FROM "case" WHERE id = $1', [caseId])).rows[0].processing_generation).toBe(2)
    // the queued generation-2 jobs run under the new configuration
    const kit2 = { ...k, config: after }
    for (let i = 0; i < 10; i++) {
      for (const st of STAGES) {
        for (const j of await k.boss.boss.fetch<{ caseId: string; generation: number }>(st, { batchSize: 10 })) {
          await runStage(kit2, st, j.data)
          await k.boss.boss.complete(st, j.id)
        }
      }
    }
    const ex2 = (await stageResult<Extraction>(k.db, k.k, caseId, 'extract'))!
    expect(ex2.amounts.filter((a) => a.at.part === 'body').map((a) => [a.minor, a.currency])).toEqual([[10000, 'EUR']])
    // the attachment was parsed once, under GBP only; its pacs.008 amount follows the new configuration too
    expect(ex2.evidence).toMatchObject([{ source: 'pacs008', minor: 25000, currency: 'EUR' }])
    expect((await k.db.query('SELECT pipeline_complete_generation FROM "case" WHERE id = $1', [caseId])).rows[0].pipeline_complete_generation).toBe(2)
  }, 120_000)
})
