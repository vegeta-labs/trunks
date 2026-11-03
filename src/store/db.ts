// Database access: one pool per database role (tech design §4.1). Transactions run at READ COMMITTED.
import pg from 'pg'

export type Role = 'app' | 'maintenance' | 'rotation'
export type Db = pg.Pool
export type Tx = pg.PoolClient

// bigint columns come back as numbers; amounts stay well inside 2^53 (I-01)
pg.types.setTypeParser(20, (v) => Number(v))
// dates stay ISO strings; a Date would shift with the server time zone
pg.types.setTypeParser(1082, (v) => v)

export function pool(url: string, max = 10): Db {
  const p = new pg.Pool({ connectionString: url, max })
  // an idle connection the server ends (restart, failover, a dropped test database) must not crash the process; the
  // pool replaces it on the next checkout. Only the code is logged: the message can carry connection details.
  p.on('error', (e: Error & { code?: string }) => console.error(`database connection lost (${e.code ?? 'no code'})`))
  return p
}

/** Run fn in a transaction; retry the whole transaction on a unique violation of audit.seq (C-AUD-1) or a deadlock. */
export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    const c = await db.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const out = await fn(c)
      await c.query('COMMIT')
      return out
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      const err = e as { code?: string; constraint?: string }
      const retry = (err.code === '23505' && err.constraint === 'audit_seq_key') || err.code === '40P01' || err.code === '40001'
      if (!retry || i >= attempts) throw e
    } finally {
      c.release()
    }
  }
}
