// Forward-only migrations, run by the owner role at start-up (tech design §7).
// Creates the three database roles of tech design §4.1 if they do not exist and sets their passwords.
import { readdirSync, readFileSync } from 'node:fs'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import pg from 'pg'

const DIR = new URL('./migrations/', import.meta.url)
export const ROLES = ['doi_app', 'doi_maintenance', 'doi_rotation'] as const

/** SCRAM-SHA-256 verifier as Postgres stores it (RFC 5802 / 7677), computed here so the password never leaves the app. */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16)
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

/** A lock every `migrate` takes first, in every mode (tech design v0.7.11, plan review V6). */
const MIGRATE_LOCK = 7_301_105

type DbState = { empty: boolean; demo: boolean }

/** Empty = no `schema_migrations` and no table at all in `public`; a database from before E5 has no marker table. */
async function dbState(c: pg.Client): Promise<DbState> {
  const tables = await c.query<{ n: string }>("SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'")
  const marker = await c.query<{ t: string | null }>("SELECT to_regclass('public.demo_marker')::text AS t")
  const demo = marker.rows[0]!.t ? ((await c.query('SELECT 1 FROM demo_marker')).rowCount ?? 0) > 0 : false
  return { empty: Number(tables.rows[0]!.n) === 0, demo }
}

async function setRoles(c: pg.Client, passwords: Record<(typeof ROLES)[number], string>): Promise<void> {
  for (const role of ROLES) {
    // a SCRAM verifier, never the password itself: Postgres statement logs must not hold it (self-test WR-F9)
    const pw = scramVerifier(passwords[role])
    // roles are cluster-wide: two databases migrating at once can race on the same role row; try again
    for (let attempt = 1; ; attempt++) {
      try {
        const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
        await c.query(exists.rowCount ? `ALTER ROLE ${role} WITH LOGIN PASSWORD '${pw}'` : `CREATE ROLE ${role} WITH LOGIN PASSWORD '${pw}'`)
        break
      } catch (e) {
        const code = (e as { code?: string }).code
        if (attempt >= 10 || !(code === 'XX000' || code === '23505' || code === '42710')) throw e
        await new Promise((r) => setTimeout(r, 50 * attempt))
      }
    }
  }
}

function migrationFiles(): Array<{ name: string; sql: string; sha: string }> {
  return readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((name) => {
    const sql = readFileSync(new URL(name, DIR), 'utf8')
    return { name, sql, sha: createHash('sha256').update(sql).digest('hex') }
  })
}

const MIGRATIONS_TABLE = 'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()); REVOKE ALL ON schema_migrations FROM PUBLIC'

/**
 * `demo: true` (DEMO=1, PRD R-DEMO-01 v0.7.22): an empty database gets every migration and the demo marker in one
 * transaction (plan review V1); a database with the marker is wiped and rebuilt (PRD C-AUD-2's demo exception); a
 * database with data and no marker is refused before anything changes, the role passwords included (R2). Without
 * `demo`, a database with the marker is refused (R1: a demo database never becomes a real deployment).
 */
export async function migrate(ownerUrl: string, passwords: Record<(typeof ROLES)[number], string>, opts: { demo?: boolean } = {}): Promise<string[]> {
  const c = new pg.Client({ connectionString: ownerUrl })
  await c.connect()
  try {
    await c.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK])
    const state = await dbState(c)
    if (!opts.demo && state.demo) throw new Error('refusing: this is a demo database (demo marker present); a demo database cannot become a real deployment')
    if (opts.demo && !state.empty && !state.demo) throw new Error('refusing: DEMO=1 on a database that has data and no demo marker; nothing was changed')
    if (opts.demo) {
      await setRoles(c, passwords)
      const applied: string[] = []
      // the wipe, the rebuild and the marker in one transaction: no other session ever sees this database without its
      // marker, so a non-demo command checking it meanwhile is still refused (Codex E5 round 2 F1)
      await c.query('BEGIN')
      try {
        if (state.demo) {
          // wipe the demo database: every object of this application, then the schema as Postgres creates it
          await c.query('DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC')
        }
        await c.query(MIGRATIONS_TABLE)
        for (const f of migrationFiles()) {
          await c.query(f.sql)
          await c.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [f.name, f.sha])
          applied.push(f.name)
        }
        await c.query('INSERT INTO demo_marker (id) VALUES (1)')
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK')
        throw new Error(`demo migration failed, the database is left as it was: ${(e as Error).message}`)
      }
      return applied
    }
    await setRoles(c, passwords)
    await c.query(MIGRATIONS_TABLE)
    const done = new Map((await c.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations')).rows.map((r) => [r.name, r.sha256]))
    const applied: string[] = []
    for (const f of migrationFiles()) {
      if (done.has(f.name)) {
        if (done.get(f.name) !== f.sha) throw new Error(`migration ${f.name} was changed after it was applied`)
        continue
      }
      await c.query('BEGIN')
      try {
        await c.query(f.sql)
        await c.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [f.name, f.sha])
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK')
        throw new Error(`migration ${f.name} failed: ${(e as Error).message}`)
      }
      applied.push(f.name)
    }
    return applied
  } finally {
    await c.end() // ends the session and with it the advisory lock
  }
}
