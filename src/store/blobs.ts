// secret_blob: the only place text is stored (PRD R-PRV-05).
import { randomUUID } from 'node:crypto'
import type { Keyring } from './crypto.ts'
import type { Tx } from './db.ts'

type Q = Pick<Tx, 'query'>

export async function putBlob(c: Q, k: Keyring, value: string | Buffer): Promise<string> {
  const plain = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const e = k.encrypt(plain)
  const id = randomUUID()
  await c.query('INSERT INTO secret_blob (id, key_id, wrapped_dek, ciphertext, content_hmac) VALUES ($1, $2, $3, $4, $5)', [id, e.keyId, e.wrappedDek, e.ciphertext, k.hmac(plain)])
  return id
}

export const putJson = (c: Q, k: Keyring, v: unknown) => putBlob(c, k, JSON.stringify(v))

export async function putOptional(c: Q, k: Keyring, value: string | null | undefined): Promise<string | null> {
  return value === null || value === undefined || value === '' ? null : putBlob(c, k, value)
}

export async function getBlobs(c: Q, k: Keyring, ids: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  if (ids.length === 0) return out
  const r = await c.query<{ id: string; key_id: string; wrapped_dek: Buffer; ciphertext: Buffer }>(
    'SELECT id, key_id, wrapped_dek, ciphertext FROM secret_blob WHERE id = ANY($1::uuid[])',
    [[...new Set(ids)]],
  )
  for (const row of r.rows) out.set(row.id, k.decrypt(row.key_id, row.wrapped_dek, row.ciphertext))
  return out
}

export async function getText(c: Q, k: Keyring, id: string | null): Promise<string | null> {
  if (!id) return null
  const m = await getBlobs(c, k, [id])
  const b = m.get(id)
  if (!b) throw new Error(`secret_blob ${id} missing`)
  return b.toString('utf8')
}

export async function getJson<T>(c: Q, k: Keyring, id: string | null): Promise<T | null> {
  const s = await getText(c, k, id)
  return s === null ? null : (JSON.parse(s) as T)
}
