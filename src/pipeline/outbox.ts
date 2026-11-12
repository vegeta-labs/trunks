// PRD C-OUT-1: webhook delivery from the event outbox. HTTPS only, redirects never followed, HMAC-SHA256 signature in
// X-Trunks-Signature; retries after 1, 5, 30 minutes and 2 hours, then failed; per Case strictly in case_event_seq
// order — an event waits while an earlier one of the same Case has not been delivered. Each attempt is audited.
import { createHash, createHmac } from 'node:crypto'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db } from '../store/db.ts'
import { getBlobs } from '../store/blobs.ts'
import { appendAudit } from '../store/audit.ts'

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000] // after attempts 1–4; the 5th failure is final

export type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>

/** fetch without following redirects: a 3xx comes back as a status and counts as a failure. */
export const fetchPoster: Poster = async (url, body, headers) => {
  const r = await fetch(url, { method: 'POST', body, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  return { status: r.status }
}

export const signature = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

/** The Case-level lock a delivery holds while it sends; KYC replacement takes it too (Codex E4 round 2 F3). */
export const outboxLockKey = (caseId: string) => BigInt.asIntN(64, BigInt(`0x${createHash('sha256').update(`outbox\0${caseId}`).digest('hex').slice(0, 16)}`)).toString()

export interface Webhook {
  url: string
  secret: string
}

/** Deliver what is due now; returns how many attempts were made. */
export async function deliverDue(d: { db: Db; k: Keyring }, hook: Webhook, post: Poster = fetchPoster, now = new Date()): Promise<number> {
  if (!hook.url.startsWith('https://')) throw new Error('the webhook must be an https:// address')
  // the first undelivered event of each Case; blocked and unsent ones never go out and do not hold the queue
  const heads = (await d.db.query<{ id: string; case_id: string; case_event_seq: number; status: string; attempts: number; next_attempt_at: Date | null; event_blob: string }>(
    `SELECT DISTINCT ON (case_id) id, case_id, case_event_seq, status, attempts, next_attempt_at, event_blob FROM event_outbox
      WHERE status IN ('pending', 'failed') ORDER BY case_id, case_event_seq`,
  )).rows
  let n = 0
  for (const h of heads) {
    if (h.status !== 'pending' || (h.next_attempt_at && h.next_attempt_at > now)) continue // a failed head holds its Case
    // one deliverer per Case across processes (Codex E3 F10): a Case lock held while sending, the head re-read under it
    const lock = await d.db.connect()
    const key = outboxLockKey(h.case_id)
    try {
      if (!(await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [key])).rows[0]!.ok) continue
      const still = (await lock.query<{ id: string; attempts: number }>(
        `SELECT id, attempts FROM event_outbox WHERE case_id = $1 AND status IN ('pending', 'failed') ORDER BY case_event_seq LIMIT 1`,
        [h.case_id],
      )).rows[0]
      if (!still || still.id !== h.id || still.attempts !== h.attempts) continue
      n += await deliverOne(d, hook, post, now, h)
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined)
      lock.release()
    }
  }
  return n
}

async function deliverOne(d: { db: Db; k: Keyring }, hook: Webhook, post: Poster, now: Date, h: { id: string; case_id: string; case_event_seq: number; attempts: number; event_blob: string }): Promise<number> {
  const body = (await getBlobs(d.db, d.k, [h.event_blob])).get(h.event_blob)!.toString('utf8')
  let status = 0
  let error: string | null = null
  try {
    status = (await post(hook.url, body, { 'content-type': 'application/json', 'x-trunks-signature': signature(hook.secret, body) })).status
    if (status < 200 || status > 299) error = `HTTP ${status}`
  } catch (e) {
    error = String((e as Error).message ?? e).slice(0, 200)
  }
  const attempts = h.attempts + 1
  await tx(d.db, async (c) => {
    // guarded: only the attempt this deliverer claimed may change the row
    if (error === null) {
      await c.query(`UPDATE event_outbox SET status = 'sent', attempts = $2, sent_at = now(), last_error = NULL WHERE id = $1 AND status = 'pending' AND attempts = $3`, [h.id, attempts, h.attempts])
    } else {
      const last = attempts > RETRY_DELAYS_MS.length
      await c.query(`UPDATE event_outbox SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5 WHERE id = $1 AND status = 'pending' AND attempts = $6`, [
        h.id, last ? 'failed' : 'pending', attempts, last ? null : new Date(now.getTime() + RETRY_DELAYS_MS[attempts - 1]!), error, h.attempts,
      ])
    }
    await appendAudit(c, d.k, [{ actor: 'system', type: error === null ? 'event.delivered' : 'event.delivery_failed', caseId: h.case_id, payload: { event_id: h.id, case_event_seq: h.case_event_seq, attempt: attempts, http_status: status || null, final: error !== null && attempts > RETRY_DELAYS_MS.length } }])
  })
  return 1
}
