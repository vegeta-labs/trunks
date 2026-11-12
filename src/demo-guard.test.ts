// The demo guard of `serve` and `maintain` (PRD R-DEMO-01 v0.7.22, tech design v0.7.11; plan review R1, W1).
import { afterAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { migrate } from './store/migrate.ts'
import { pool } from './store/db.ts'
import { PASSWORDS, TEST_URL } from './store/testdb.ts'
import { demoGuard } from './startup.ts'

const names: string[] = []
const at = (db: string, user?: string, password?: string) => {
  const u = new URL(TEST_URL)
  u.pathname = `/${db}`
  if (user) [u.username, u.password] = [user, password ?? '']
  return u.toString()
}
const PW = PASSWORDS // roles are cluster-wide: the shared test passwords
async function database(demo: boolean) {
  const name = `trunks_guard_${randomBytes(5).toString('hex')}`
  const a = new pg.Client({ connectionString: TEST_URL })
  await a.connect()
  await a.query(`CREATE DATABASE ${name}`)
  await a.end()
  names.push(name)
  await migrate(at(name), PW, { demo })
  return { app: pool(at(name, 'trunks_app', PW.trunks_app), 2), maintenance: pool(at(name, 'trunks_maintenance', PW.trunks_maintenance), 2) }
}
afterAll(async () => {
  const a = new pg.Client({ connectionString: TEST_URL })
  await a.connect()
  for (const n of names) await a.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`)
  await a.end()
})

describe('demo guard', () => {
  it('TC-DEMO-03 serve / maintain: DEMO=1 needs the marker; the marker needs DEMO=1; both roles can read it', async () => {
    const real = await database(false)
    const demo = await database(true)
    for (const role of ['app', 'maintenance'] as const) {
      await expect(demoGuard(real[role], false)).resolves.toBe(false)
      await expect(demoGuard(real[role], true)).rejects.toThrow(/DEMO=1 but this database has no demo marker/)
      await expect(demoGuard(demo[role], true)).resolves.toBe(true)
      await expect(demoGuard(demo[role], false)).rejects.toThrow(/this is a demo database/)
    }
    await Promise.all([real.app.end(), real.maintenance.end(), demo.app.end(), demo.maintenance.end()])
  })
})
