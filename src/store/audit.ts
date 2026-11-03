// Audit log writer and checks (PRD C-AUD-1 to 5, tech design §4 `audit`).
// Written at the end of the business transaction: advisory lock, then a separate statement reads the chain head.
import { randomUUID } from 'node:crypto'
import { auditHash, GENESIS, sha256Hex, verifyChain, type AuditRecord, type Json } from '../lib/audit-hash.ts'
import type { Keyring } from './crypto.ts'
import type { Db, Tx } from './db.ts'
import { putBlob } from './blobs.ts'

const AUDIT_LOCK = 7_340_001 // fixed advisory-lock key for the chain head

export interface AuditEntry {
  actor: string // user id or 'system'
  type: string
  caseId?: string | null
  payload?: { [k: string]: Json }
  // personal values go to audit_detail; the audit row keeps only their SHA-256 (C-AUD-5)
  detail?: Json
  detailSources?: string[] // attachment ids the detail was derived from (KYC replacement, C-PRV-2)
}

export async function appendAudit(c: Tx, k: Keyring, entries: AuditEntry[]): Promise<AuditRecord[]> {
  const rows: Array<Omit<AuditRecord, 'seq' | 'prev_hash' | 'hash'>> = []
  for (const e of entries) {
    const payload: { [k: string]: Json } = { ...e.payload }
    if (e.detail !== undefined) {
      const content = JSON.stringify(e.detail)
      const sha = sha256Hex(content)
      const exists = await c.query('SELECT 1 FROM audit_detail WHERE sha256 = $1 AND case_id IS NOT DISTINCT FROM $2', [sha, e.caseId ?? null])
      if (exists.rowCount === 0) {
        const blob = await putBlob(c, k, content)
        // a concurrent writer of the same detail for the same Case wins quietly (self-test CC-F4)
        await c.query(
          'INSERT INTO audit_detail (id, sha256, case_id, content_blob, source_attachment_ids) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sha256, case_id) DO NOTHING',
          [randomUUID(), sha, e.caseId ?? null, blob, e.detailSources ?? []],
        )
      }
      payload.detail_sha256 = sha
    }
    rows.push({ time: new Date().toISOString(), actor: e.actor, type: e.type, case_id: e.caseId ?? null, payload })
  }
  await c.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK])
  // a separate statement after the lock: READ COMMITTED gives it a fresh snapshot including the last commit
  const head = await c.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1')
  let seq = head.rows[0]?.seq ?? 0
  let prev = head.rows[0]?.hash ?? GENESIS
  const out: AuditRecord[] = []
  for (const r of rows) {
    seq += 1
    const rec = { seq, ...r, prev_hash: prev }
    const hash = auditHash(rec)
    await c.query('INSERT INTO audit (seq, time, actor, type, case_id, payload, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      seq, rec.time, rec.actor, rec.type, rec.case_id, JSON.stringify(rec.payload), prev, hash,
    ])
    out.push({ ...rec, hash })
    prev = hash
  }
  return out
}

type Row = { seq: number; time: string; actor: string; type: string; case_id: string | null; payload: { [k: string]: Json }; prev_hash: string; hash: string }

export async function* auditRows(db: Pick<Db, 'query'>, batch = 5000): AsyncGenerator<AuditRecord> {
  let after = 0
  for (;;) {
    const r = await db.query<Row>('SELECT seq, time, actor, type, case_id, payload, prev_hash, hash FROM audit WHERE seq > $1 ORDER BY seq LIMIT $2', [after, batch])
    for (const row of r.rows) yield row
    if (r.rows.length < batch) return
    after = r.rows.at(-1)!.seq
  }
}

/** `verify` command: recompute every record; report the first bad seq. */
export async function verifyAudit(db: Pick<Db, 'query'>): Promise<{ ok: true; count: number; head: { seq: number; hash: string } | null } | { ok: false; badSeq: number }> {
  const all: AuditRecord[] = []
  for await (const r of auditRows(db)) all.push(r)
  const v = verifyChain(all)
  if (!v.ok) return v
  const last = all.at(-1)
  return { ok: true, count: all.length, head: last ? { seq: last.seq, hash: last.hash } : null }
}

/** JSON Lines export (R-AUD-03); each line is the record exactly as hashed plus `hash`. */
export async function exportAudit(db: Pick<Db, 'query'>, write: (line: string) => void): Promise<number> {
  let n = 0
  for await (const r of auditRows(db)) {
    write(JSON.stringify(r))
    n++
  }
  return n
}

export interface ChainHead {
  seq: number
  hash: string
  exported_at: string
}

/** C-AUD-4: the head written daily to a separate place. */
export async function chainHead(db: Pick<Db, 'query'>): Promise<ChainHead | null> {
  const r = await db.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1')
  return r.rows[0] ? { seq: r.rows[0].seq, hash: r.rows[0].hash, exported_at: new Date().toISOString() } : null
}

/** Compare the database with an exported head: missing tail records or a changed record at that seq. */
export async function checkHead(db: Pick<Db, 'query'>, head: ChainHead): Promise<{ ok: true } | { ok: false; reason: 'truncated' | 'changed'; lastSeq: number }> {
  const last = await db.query<{ seq: number }>('SELECT max(seq)::bigint AS seq FROM audit')
  const lastSeq = last.rows[0]?.seq ?? 0
  if (lastSeq < head.seq) return { ok: false, reason: 'truncated', lastSeq }
  const at = await db.query<{ hash: string }>('SELECT hash FROM audit WHERE seq = $1', [head.seq])
  if (at.rows[0]?.hash !== head.hash) return { ok: false, reason: 'changed', lastSeq }
  return { ok: true }
}
