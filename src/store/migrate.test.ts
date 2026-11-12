// `migrate` with and without DEMO=1 (PRD R-DEMO-01 v0.7.22, tech design v0.7.11; plan review R1, R2, V1, V6).
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'
import { readdirSync, readFileSync } from 'node:fs'
import { LEGACY_ROLE_FILES, migrate, migrationFiles, withCurrentRoles } from './migrate.ts'
import { PASSWORDS, TEST_URL } from './testdb.ts'

const created: string[] = []
const url = (db: string, user?: string, password?: string) => {
  const u = new URL(TEST_URL)
  u.pathname = `/${db}`
  if (user) {
    u.username = user
    u.password = password ?? ''
  }
  return u.toString()
}
async function admin<T>(fn: (c: pg.Client) => Promise<T>, db = 'postgres'): Promise<T> {
  const c = new pg.Client({ connectionString: url(db) })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}
async function emptyDb(): Promise<string> {
  const name = `trunks_mig_${randomBytes(5).toString('hex')}`
  await admin((c) => c.query(`CREATE DATABASE ${name}`))
  created.push(name)
  return name
}
// roles are cluster-wide and shared with every other test file: always the same test passwords
const pw = (_tag: string) => PASSWORDS
const q = (db: string, sql: string) => admin((c) => c.query(sql), db)
const canLogin = async (db: string, user: string, password: string) => {
  const c = new pg.Client({ connectionString: url(db, user, password) })
  try {
    await c.connect()
    await c.end()
    return true
  } catch {
    return false
  }
}

afterAll(async () => {
  for (const n of created) await admin((c) => c.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`))
})

describe('migrate and the demo marker', () => {
  it('TC-DEMO-03 empty database + DEMO=1: every migration and the marker; only the owner can write the marker', async () => {
    const db = await emptyDb()
    const applied = await migrate(url(db), pw('a'), { demo: true })
    expect(applied.at(-1)).toBe('010_rename.sql')
    expect((await q(db, 'SELECT count(*)::int AS n FROM demo_marker')).rows[0].n).toBe(1)
    expect((await q(db, 'SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(applied.length)
    const app = new pg.Client({ connectionString: url(db, 'trunks_app', PASSWORDS.trunks_app) })
    await app.connect()
    expect((await app.query('SELECT count(*)::int AS n FROM demo_marker')).rows[0].n).toBe(1)
    await expect(app.query('INSERT INTO demo_marker (id) VALUES (1)')).rejects.toThrow(/permission denied/)
    await expect(app.query('DELETE FROM demo_marker')).rejects.toThrow(/permission denied/)
    await app.end()
  })

  it('TC-DEMO-03 demo database + DEMO=1: wiped and rebuilt; the roles still reach the tables', async () => {
    const db = await emptyDb()
    await migrate(url(db), pw('a'), { demo: true })
    await q(db, "CREATE TABLE leftover (x int)")
    await migrate(url(db), pw('b'), { demo: true })
    expect((await q(db, "SELECT to_regclass('public.leftover')::text AS t")).rows[0].t).toBeNull()
    expect((await q(db, 'SELECT count(*)::int AS n FROM demo_marker')).rows[0].n).toBe(1)
    const app = new pg.Client({ connectionString: url(db, 'trunks_app', PASSWORDS.trunks_app) })
    await app.connect()
    expect((await app.query('SELECT count(*)::int AS n FROM audit')).rows[0].n).toBe(0) // USAGE on the new schema
    expect((await q(db, "SELECT nspowner::regrole::text AS o FROM pg_namespace WHERE nspname = 'pgboss'")).rows[0].o).toBe('trunks_app')
    await app.end()
  })

  it('TC-DEMO-03 data without the marker + DEMO=1: refused, nothing changed (not even the role passwords)', async () => {
    const db = await emptyDb()
    await migrate(url(db), pw('real'))
    await q(db, 'CREATE TABLE operator_data (x int); INSERT INTO operator_data VALUES (42)')
    // the statements the refused run sends (role verifiers cannot be compared: other test files change the shared roles)
    const spy = vi.spyOn(pg.Client.prototype, 'query')
    await expect(migrate(url(db), pw('demo'), { demo: true })).rejects.toThrow(/has data and no demo marker; nothing was changed/)
    const sent = spy.mock.calls.map((c) => String(typeof c[0] === 'string' ? c[0] : (c[0] as { text?: string }).text))
    spy.mockRestore()
    expect(sent.some((t) => /ROLE|CREATE|DROP|INSERT|BEGIN/i.test(t))).toBe(false)
    expect((await q(db, 'SELECT x FROM operator_data')).rows).toEqual([{ x: 42 }])
    expect((await q(db, 'SELECT count(*)::int AS n FROM demo_marker')).rows[0].n).toBe(0)
    expect(await canLogin(db, 'trunks_app', PASSWORDS.trunks_app)).toBe(true)
  })

  it('TC-DEMO-03 demo database without DEMO=1: refused (a demo database never becomes a real deployment)', async () => {
    const db = await emptyDb()
    await migrate(url(db), pw('a'), { demo: true })
    await expect(migrate(url(db), pw('a'))).rejects.toThrow(/this is a demo database/)
  })

  it('TC-DEMO-03 a demo migration that fails half-way leaves the database empty; the next run succeeds', async () => {
    const db = await emptyDb()
    // a view is not a table (the database counts as empty) but takes the name of a table the first migration creates
    await q(db, 'CREATE VIEW mailbox AS SELECT 1 AS x')
    await expect(migrate(url(db), pw('a'), { demo: true })).rejects.toThrow(/demo migration failed, the database is left as it was/)
    expect((await q(db, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n).toBe(0)
    expect((await q(db, "SELECT to_regnamespace('pgboss')::text AS t")).rows[0].t).toBeNull()
    await q(db, 'DROP VIEW mailbox')
    await migrate(url(db), pw('a'), { demo: true })
    expect((await q(db, 'SELECT count(*)::int AS n FROM demo_marker')).rows[0].n).toBe(1)
  })

  it('TC-DEMO-03 two demo migrations at once on an empty database: one after the other, one consistent result', async () => {
    const db = await emptyDb()
    const [a, b] = await Promise.all([migrate(url(db), pw('a'), { demo: true }), migrate(url(db), pw('a'), { demo: true })])
    expect(a.length).toBe(b.length)
    expect((await q(db, 'SELECT count(*)::int AS n FROM demo_marker')).rows[0].n).toBe(1)
    expect((await q(db, 'SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(a.length)
  })

  it('TC-DEMO-03 a demo reset is one transaction: the wipe comes after BEGIN and the marker before COMMIT (Codex E5 round 2 F1)', async () => {
    const db = await emptyDb()
    await migrate(url(db), pw('a'), { demo: true })
    const spy = vi.spyOn(pg.Client.prototype, 'query')
    await migrate(url(db), pw('a'), { demo: true })
    const sent = spy.mock.calls.map((c) => String(typeof c[0] === 'string' ? c[0] : (c[0] as { text?: string }).text))
    spy.mockRestore()
    const at = (re: RegExp) => sent.findIndex((t) => re.test(t))
    const begin = at(/^BEGIN$/)
    expect(begin).toBeGreaterThan(-1)
    expect(at(/DROP SCHEMA public CASCADE/)).toBeGreaterThan(begin)
    expect(at(/INSERT INTO demo_marker/)).toBeLessThan(at(/^COMMIT$/))
    expect(sent.slice(0, begin).some((t) => /DROP|CREATE TABLE|INSERT/.test(t))).toBe(false)
  })
})


describe('database roles after the rename (rename plan §3.1)', () => {
  const DIR = new URL('./migrations/', import.meta.url)
  const raw = (name: string) => readFileSync(new URL(name, DIR), 'utf8')

  it('TC-OPS-11 the migrations merged before the rename run with only the three role names replaced; later ones run as written', () => {
    const files = migrationFiles()
    expect(files.map((f) => f.name)).toEqual(readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort())
    expect([...LEGACY_ROLE_FILES].sort()).toEqual(files.map((f) => f.name).filter((n) => n < '010'))
    for (const f of files) {
      // the recorded hash is of the file on disk: a database migrated before the rename still verifies
      expect(f.sha, f.name).toBe(createHash('sha256').update(raw(f.name)).digest('hex'))
      if (!LEGACY_ROLE_FILES.has(f.name)) {
        expect(f.sql, f.name).toBe(raw(f.name))
        continue
      }
      expect(f.sql, f.name).not.toMatch(/doi/i)
      expect(raw(f.name), f.name).not.toMatch(/trunks/)
      // nothing but the names differs: putting the old names back gives the file as it is on disk
      expect(f.sql.replace(/\btrunks_(app|maintenance|rotation)\b/g, 'doi_$1'), f.name).toBe(raw(f.name))
    }
    // only whole role names: a longer identifier or another prefix is left alone
    expect(withCurrentRoles('GRANT x TO doi_app, doi_maintenance; doi_application my_doi_app doi_other DOI_APP')).toBe('GRANT x TO trunks_app, trunks_maintenance; doi_application my_doi_app doi_other DOI_APP')
  })

  it('TC-OPS-11 a new database has the roles and the stored role names under the new names only', async () => {
    const db = await emptyDb()
    await migrate(url(db), PASSWORDS)
    expect((await q(db, "SELECT pg_get_expr(polqual, polrelid) AS e FROM pg_policy WHERE polname = 'intent_delete_own'")).rows[0].e).toMatch(/'trunks_maintenance'/)
    expect((await q(db, "SELECT nspowner::regrole::text AS o FROM pg_namespace WHERE nspname = 'pgboss'")).rows[0].o).toBe('trunks_app')
    const grantees = (await q(db, "SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee <> 'postgres' ORDER BY 1")).rows.map((r) => r.grantee)
    expect(grantees).toEqual(['trunks_app', 'trunks_maintenance', 'trunks_rotation'])
    // the maintenance role deletes another role's write intent; the app role only its own
    await q(db, "INSERT INTO file_write_intent (id, object_key, purpose, created_by_role) VALUES ('00000000-0000-4000-8000-000000000001', 'k1', 't', 'trunks_app'), ('00000000-0000-4000-8000-000000000002', 'k2', 't', 'trunks_maintenance')")
    const as = async (role: 'trunks_app' | 'trunks_maintenance', sql: string) => {
      const c = new pg.Client({ connectionString: url(db, role, PASSWORDS[role]) })
      await c.connect()
      try {
        return (await c.query(sql)).rowCount
      } finally {
        await c.end()
      }
    }
    expect(await as('trunks_app', "DELETE FROM file_write_intent WHERE object_key = 'k2'")).toBe(0)
    expect(await as('trunks_maintenance', "DELETE FROM file_write_intent WHERE object_key = 'k1'")).toBe(1)
  })
})
