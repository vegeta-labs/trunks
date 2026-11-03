// Tech design §9: audit lock and encrypted list page timings, recorded in docs/perf.md. Run with BENCH=1.
import { describe, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { createKit } from '../pipeline/testkit.ts'
import { tx } from './db.ts'
import { appendAudit } from './audit.ts'
import { eml } from '../ingest/testmail.ts'
import { listCases } from '../server/cases.ts'

describe.skipIf(!process.env.BENCH)('perf', () => {
  it('audit appends and the case list', async () => {
    const k = await createKit()
    const out: string[] = []
    let t = performance.now()
    for (let i = 0; i < 1000; i++) await tx(k.db, (c) => appendAudit(c, k.k, [{ actor: 'system', type: 'bench' }]))
    out.push(`1,000 sequential one-record audit transactions: ${(performance.now() - t).toFixed(0)} ms`)
    t = performance.now()
    await Promise.all(Array.from({ length: 10 }, () => (async () => { for (let i = 0; i < 100; i++) await tx(k.db, (c) => appendAudit(c, k.k, [{ actor: 'system', type: 'bench' }])) })()))
    out.push(`1,000 audit transactions from 10 concurrent writers: ${(performance.now() - t).toFixed(0)} ms`)
    t = performance.now()
    for (let i = 0; i < 200; i++) await k.ingest(eml({ text: `bench ${i}` }))
    out.push(`200 ingests (archive, snapshot, signals, Case; no stages): ${(performance.now() - t).toFixed(0)} ms`)
    t = performance.now()
    for (let i = 0; i < 20; i++) await listCases(k.db, k.k, k.config, { limit: 50 })
    out.push(`case list, 50 rows decrypted, average of 20: ${((performance.now() - t) / 20).toFixed(1)} ms`)
    writeFileSync(process.env.BENCH_OUT ?? '/dev/stdout', `${out.join('\n')}\n`)
    await k.close()
  }, 600_000)
})
