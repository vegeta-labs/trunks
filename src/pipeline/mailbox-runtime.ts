// Mailbox health (PRD R-ING-02, TC-ING-13): a catch-up or a renewal that fails for a reason a person must fix (a
// revoked token, the wrong account, a refused renewal) is audited once when the state changes and shown at the top of
// the review UI until it recovers. Temporary failures (network, 429, 5xx) are only retried (C-ING-5).
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db } from '../store/db.ts'
import { appendAudit } from '../store/audit.ts'
import type { MailboxAdapter } from '../adapters/mailbox/types.ts'
import { ConfigError, TokenRevoked, WrongAccount } from '../adapters/mailbox/gmail.ts'
import { catchUp, type CatchUpReport } from './catchup.ts'
import type { IngestDeps, MailboxInfo } from './ingest.ts'

export type MailboxStatus = 'ok' | 'auth_failed' | 'wrong_account' | 'renew_failed' | 'permission_failed' | 'config_error'

async function lastStatus(db: Pick<Db, 'query'>, mailbox: string, kind: 'catch_up' | 'renew'): Promise<MailboxStatus | null> {
  const r = await db.query<{ s: MailboxStatus }>(
    "SELECT payload->>'status' AS s FROM audit WHERE type = 'mailbox.status' AND payload->>'mailbox' = $1 AND payload->>'kind' = $2 ORDER BY seq DESC LIMIT 1",
    [mailbox, kind],
  )
  return r.rows[0]?.s ?? null
}

export async function setStatus(d: { db: Db; k: Keyring }, mailbox: string, kind: 'catch_up' | 'renew', status: MailboxStatus): Promise<void> {
  const prev = await lastStatus(d.db, mailbox, kind)
  if (prev === status || (prev === null && status === 'ok')) return
  await tx(d.db, (c) => appendAudit(c, d.k, [{ actor: 'system', type: 'mailbox.status', payload: { mailbox, kind, status } }]))
}

const classify = (e: unknown): MailboxStatus | null =>
  e instanceof TokenRevoked ? 'auth_failed' : e instanceof WrongAccount ? 'wrong_account' : e instanceof ConfigError ? 'config_error' : null

/** One catch-up with its health recorded; a temporary failure leaves the cursor and the status alone. */
export async function guardedCatchUp(deps: IngestDeps, adapter: MailboxAdapter, info: MailboxInfo, folderKey = ''): Promise<CatchUpReport | null> {
  try {
    const r = await catchUp(deps, adapter, info, {}, folderKey)
    await setStatus(deps, adapter.id, 'catch_up', 'ok')
    return r
  } catch (e) {
    const s = classify(e)
    if (s) await setStatus(deps, adapter.id, 'catch_up', s)
    else console.error(`catch-up of ${adapter.id} failed (${(e as Error).name}); retried at the next interval`)
    return null
  }
}

/** Renew a subscription (Gmail watch) before it expires; a failure is audited and shown. */
export async function guardedRenew(d: { db: Db; k: Keyring }, adapter: MailboxAdapter): Promise<boolean> {
  try {
    await adapter.renew()
    await setStatus(d, adapter.id, 'renew', 'ok')
    return true
  } catch (e) {
    await setStatus(d, adapter.id, 'renew', e instanceof TokenRevoked ? 'auth_failed' : e instanceof WrongAccount ? 'wrong_account' : 'renew_failed')
    return false
  }
}

/** For the banner: every mailbox whose latest status is not ok. */
export async function mailboxWarnings(db: Pick<Db, 'query'>): Promise<string[]> {
  const r = await db.query<{ mailbox: string; kind: string; status: string }>(
    `SELECT DISTINCT ON (payload->>'mailbox', payload->>'kind') payload->>'mailbox' AS mailbox, payload->>'kind' AS kind, payload->>'status' AS status
       FROM audit WHERE type = 'mailbox.status' ORDER BY payload->>'mailbox', payload->>'kind', seq DESC`,
  )
  const text: Record<string, string> = {
    auth_failed: 'its authorisation was revoked or has expired; run trunks gmail-auth again',
    wrong_account: 'its token belongs to another account; run trunks gmail-auth again',
    renew_failed: 'renewing its notifications failed; new mail is still picked up by the catch-up interval',
    permission_failed: 'its permission check failed',
    config_error: 'a configured label or folder does not exist; correct the configuration',
  }
  return r.rows.filter((x) => x.status !== 'ok').map((x) => `Mailbox ${x.mailbox}: ${text[x.status] ?? x.status}.`)
}
