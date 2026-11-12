// Test helper: a fresh database per test file on the test Postgres, migrated, with a pool per role.
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { migrate, ROLES } from './migrate.ts'
import { pool, type Db } from './db.ts'
import { Keyring } from './crypto.ts'

export const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/postgres'
export const PASSWORDS = Object.fromEntries(ROLES.map((r) => [r, `test-${r}`])) as Record<(typeof ROLES)[number], string>

export interface TestDb {
  name: string
  owner: Db
  app: Db
  maintenance: Db
  rotation: Db
  keyring: Keyring
  drop(): Promise<void>
}

const withDb = (url: string, db: string, user?: string, password?: string) => {
  const u = new URL(url)
  u.pathname = `/${db}`
  if (user) {
    u.username = user
    u.password = password ?? ''
  }
  return u.toString()
}

export const testKeyring = () => new Keyring([{ id: 'k1', key: randomBytes(32) }], 'k1', randomBytes(32))

export async function createTestDb(): Promise<TestDb> {
  const name = `trunks_test_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: TEST_URL })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const ownerUrl = withDb(TEST_URL, name)
  await migrate(ownerUrl, PASSWORDS)
  const t: TestDb = {
    name,
    owner: pool(ownerUrl, 4),
    app: pool(withDb(TEST_URL, name, 'trunks_app', PASSWORDS.trunks_app), 12),
    maintenance: pool(withDb(TEST_URL, name, 'trunks_maintenance', PASSWORDS.trunks_maintenance), 4),
    rotation: pool(withDb(TEST_URL, name, 'trunks_rotation', PASSWORDS.trunks_rotation), 4),
    keyring: testKeyring(),
    async drop() {
      await Promise.all([t.owner.end(), t.app.end(), t.maintenance.end(), t.rotation.end()])
      const a = new pg.Client({ connectionString: TEST_URL })
      await a.connect()
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await a.end()
    },
  }
  return t
}
