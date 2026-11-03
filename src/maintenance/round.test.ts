// TC-OPS-03 (PRD R-OPS-01 v0.7.22, tech design v0.7.11; self-test F3): one round of the maintenance container
// (`doi maintain --once`) under the maintenance role: an expired message deleted and a transferred KYC message
// replaced in the same round; the continuation is then done by the app's workers; on a demo database no replacement.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKit, FakeLlm, type Kit } from '../pipeline/testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { makePdf } from '../../parser/testfiles.ts'
import { FolderSink, runKycDeliveries } from './kyc.ts'
import { runMaintenanceRound } from './daily.ts'

let k: Kit
const caseOf = (r: unknown) => (r as { caseId: string }).caseId
const DAY = 86_400_000

beforeAll(async () => {
  const llm = new FakeLlm()
  llm.reply = (v) => (v.startsWith('classify') ? '{"labels":[{"class":"kyc_documents","confidence":"high","reason":"documents"}],"language":"en"}' : '{"fields":{}}')
  k = await createKit({ llm })
}, 60_000)
afterAll(() => k?.close())

const kycMail = (id: string) =>
  eml({ subject: `Documents ${id}`, messageId: `<${id}@x.example>`, text: 'My documents attached.', attachments: [{ type: 'application/pdf', filename: 'passport.pdf', content: makePdf(['P<GBRHART<<AMELIA passport']) }] })

describe('maintenance round', () => {
  it('TC-OPS-03 maintain --once: retention deletes the expired message and the KYC replacement runs, as the maintenance role; app finishes the Case', async () => {
    const old = caseOf(await k.ingest(eml({ subject: 'Old', messageId: '<old@x.example>', text: 'An old question.' }), '2026-01-05T09:00:00.000Z'))
    const kyc = caseOf(await k.ingest(kycMail('kyc1'), '2026-10-28T09:00:00.000Z'))
    await k.drain()
    const target = mkdtempSync(join(tmpdir(), 'doi-kyc-target-'))
    const app = { db: k.t.app, k: k.k, files: k.files }
    expect((await runKycDeliveries(app, new FolderSink(target))).delivered).toBeGreaterThan(0)
    expect(readdirSync(target).length).toBe(1)
    const genBefore = (await k.t.owner.query<{ g: number }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [kyc])).rows[0]!.g

    // one round, maintenance credentials only (the round's own deps), 30-day retention, at a time after both
    await runMaintenanceRound({ db: k.t.maintenance, k: k.k, files: k.files }, { retention: { messages_days: 30, directory_days: 1826 } }, { kycReplacement: true }, new Date(Date.parse('2026-10-29T10:00:00.000Z') + DAY))
    expect((await k.t.owner.query('SELECT 1 FROM "case" WHERE id = $1', [old])).rowCount).toBe(0)
    expect((await k.t.owner.query<{ step: number }>('SELECT step FROM kyc_replacement r JOIN "case" c ON c.message_id = r.message_id WHERE c.id = $1', [kyc])).rows[0]?.step).toBe(5)
    // the continuation it queued is processed by the app's workers (a new generation of the KYC Case)
    await k.drain()
    const after = (await k.t.owner.query<{ g: number; status: string }>('SELECT processing_generation AS g, status FROM "case" WHERE id = $1', [kyc])).rows[0]!
    expect(after.g).toBe(genBefore + 1)
    expect(after.status).not.toBe('processing')
  })

  it('TC-OPS-03 a round with the KYC replacement off (a demo database) leaves the transferred message as it is', async () => {
    const kyc = caseOf(await k.ingest(kycMail('kyc2'), '2026-10-28T10:00:00.000Z'))
    await k.drain()
    await runKycDeliveries({ db: k.t.app, k: k.k, files: k.files }, new FolderSink(mkdtempSync(join(tmpdir(), 'doi-kyc-target-'))))
    await runMaintenanceRound({ db: k.t.maintenance, k: k.k, files: k.files }, { retention: { messages_days: 30, directory_days: 1826 } }, { kycReplacement: false }, new Date('2026-10-30T10:00:00.000Z'))
    expect((await k.t.owner.query('SELECT 1 FROM kyc_replacement r JOIN "case" c ON c.message_id = r.message_id WHERE c.id = $1', [kyc])).rowCount).toBe(0)
  })
})
