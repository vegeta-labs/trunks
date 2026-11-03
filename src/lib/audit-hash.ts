// PRD C-AUD-1: audit hash chain. hash = SHA-256 of the RFC 8785 (JCS) form of every field except `hash`.
import { createHash } from 'node:crypto'

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** RFC 8785 canonical JSON: keys sorted by UTF-16 code units, ECMAScript number and string serialisation. */
export function jcs(v: Json): string {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('JCS: non-finite number')
    return JSON.stringify(v)
  }
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${keys.filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${jcs(v[k]!)}`).join(',')}}`
}

export const GENESIS = '0'.repeat(64)

export interface AuditRecord {
  seq: number
  time: string // ISO 8601 UTC with milliseconds
  actor: string // user id or `system`
  type: string
  case_id: string | null
  payload: { [k: string]: Json }
  prev_hash: string
  hash: string
}

export const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

export function auditHash(r: Omit<AuditRecord, 'hash'>): string {
  const { seq, time, actor, type, case_id, payload, prev_hash } = r
  return sha256Hex(jcs({ seq, time, actor, type, case_id, payload, prev_hash }))
}

/** Recompute every record; report the first seq that does not match or breaks the sequence. */
export function verifyChain(records: readonly AuditRecord[]): { ok: true } | { ok: false; badSeq: number } {
  let prev = GENESIS
  let expected = 1
  for (const r of records) {
    if (r.seq !== expected || r.prev_hash !== prev || auditHash(r) !== r.hash) return { ok: false, badSeq: r.seq }
    prev = r.hash
    expected++
  }
  return { ok: true }
}
