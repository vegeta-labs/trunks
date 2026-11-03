// TC-DEMO-01 / TC-DEMO-03 (PRD R-DEMO-01; Codex E5 F2): the demo seed is resumable and complete only with every
// demo email: interrupted after an account, or after some emails, the next start finishes it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKit, type Kit } from '../pipeline/testkit.ts'
import { createUser } from '../server/auth.ts'
import { tx } from '../store/db.ts'
import { ingestMessage } from '../pipeline/ingest.ts'
import { importDirectory } from '../store/directory.ts'
import { DEMO_SAMPLES, demoConfig, seedDemo } from './demo.ts'

let k: Kit
beforeAll(async () => {
  k = await createKit({ config: demoConfig('eval/config', mkdtempSync(join(tmpdir(), 'doi-demo-kyc-'))) })
}, 60_000)
afterAll(() => k?.close())
const count = async (q: string) => Number((await k.t.owner.query<{ n: string }>(q)).rows[0]!.n)

describe('demo seed', () => {
  it('TC-DEMO-03 an interrupted seed (one account, three emails) is finished by the next start; then it is complete', async () => {
    // the state a crash leaves: the first account committed, and the first three emails received
    const reviewer = await tx(k.db, (c) => createUser(c, k.k, { username: 'demo-reviewer', role: 'reviewer', password: 'demo-reviewer-password', by: null, mustChange: false }))
    // … and of the directory only the deals file (Codex E5 round 2 F2: the rest must still be imported)
    const r = await importDirectory(k.db, k.k, { kind: 'deals', csv: readFileSync('eval/directory/deals.csv', 'utf8'), userId: reviewer, currencies: k.config.deployment.currencies })
    expect(r.ok).toBe(true)
    for (const id of DEMO_SAMPLES.slice(0, 3)) {
      const ann = JSON.parse(readFileSync(join('eval', 'dev', `${id}.json`), 'utf8')) as { received_at: string; mailbox: string; mailbox_strips_auth_results: boolean }
      await ingestMessage(k, { id: ann.mailbox, trustedAuthResults: ann.mailbox_strips_auth_results, trustedAuthservId: 'mx.ops.example' }, readFileSync(join('eval', 'dev', `${id}.eml`)), ann.received_at)
    }
    expect(await seedDemo(k)).toBe('seeded')
    expect(await count('SELECT count(*) AS n FROM app_user')).toBe(3)
    expect(await count('SELECT count(*) AS n FROM message')).toBe(DEMO_SAMPLES.length)
    expect(await count('SELECT count(*) AS n FROM "case"')).toBe(DEMO_SAMPLES.length)
    const deals = await count('SELECT count(*) AS n FROM deal')
    expect(deals).toBeGreaterThan(0)
    // every directory file exactly once: deals and contacts, and each deal's files that exist
    const files = readdirSync('eval/directory').filter((f) => f.endsWith('.csv')).length
    expect(await count('SELECT count(*) AS n FROM directory_version')).toBe(files)
    expect(await count('SELECT count(*) AS n FROM contact')).toBeGreaterThan(0)
    // complete: a later start changes nothing
    expect(await seedDemo(k)).toBe('already')
    expect(await count('SELECT count(*) AS n FROM deal')).toBe(deals)
  }, 120_000)
})
