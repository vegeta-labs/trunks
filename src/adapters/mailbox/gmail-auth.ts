// `doi gmail-auth <mailbox>` (PRD decision 6, tech design v0.7.9): one consent per mailbox, on the operator's machine.
// Loopback redirect (127.0.0.1, a random port) with PKCE; the request asks for gmail.readonly only; the answer must
// carry exactly that scope and belong to the configured address, or nothing is saved. The refresh token is stored
// encrypted (secret_blob via mailbox_credential); the token it replaces is not revoked (that would revoke the grant).
import { createHash, randomBytes } from 'node:crypto'
import type { Keyring } from '../../store/crypto.ts'
import { tx, type Db } from '../../store/db.ts'
import { getText, putBlob } from '../../store/blobs.ts' // getText: storedRefreshToken
import { appendAudit } from '../../store/audit.ts'
import { MailHttp } from './http.ts'
import { GMAIL_SCOPE } from './gmail.ts'

export interface Pkce {
  verifier: string
  challenge: string
  state: string
}
export function pkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(16).toString('base64url') }
}

/** The consent page the operator opens in a browser (not fetched by this application). */
export function authUrl(clientId: string, redirect: string, address: string, p: Pkce): string {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: GMAIL_SCOPE, code_challenge: p.challenge, code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent', login_hint: address, state: p.state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
}

export async function exchangeAndSave(
  d: { db: Db; k: Keyring; http: MailHttp },
  o: { mailboxId: string; address: string; clientId: string; clientSecret: string; redirect: string; code: string; verifier: string },
): Promise<void> {
  const r = await d.http.json<{ access_token?: string; refresh_token?: string; scope?: string; error?: string }>('POST', 'https://oauth2.googleapis.com/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: o.code, code_verifier: o.verifier, redirect_uri: o.redirect, client_id: o.clientId, client_secret: o.clientSecret }).toString(),
  })
  if (r.status !== 200 || !r.body?.access_token || !r.body.refresh_token) throw new Error(`Google refused the authorisation (${r.body?.error ?? r.status})`)
  const scopes = (r.body.scope ?? '').split(' ').filter(Boolean).sort()
  if (scopes.join(' ') !== GMAIL_SCOPE) throw new Error(`the granted scope must be exactly gmail.readonly; got: ${scopes.join(', ') || 'none'} — nothing saved`)
  const p = await d.http.json<{ emailAddress?: string }>('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${r.body.access_token}` } })
  if (p.body?.emailAddress?.toLowerCase() !== o.address.toLowerCase()) throw new Error('the account that consented is not the configured mailbox address — nothing saved')
  // the old token is not revoked: Google revokes the whole grant of this user to this client, which would take the new
  // token with it (self-test F3). The account check above means it is the same account; the old blob, no longer
  // referred to, is removed by the daily clean-up (review #14)
  const old = (await d.db.query<{ secret_blob_id: string }>('SELECT secret_blob_id FROM mailbox_credential WHERE mailbox_id = $1', [o.mailboxId])).rows[0]
  await tx(d.db, async (c) => {
    const blob = await putBlob(c, d.k, r.body!.refresh_token!)
    await c.query(
      `INSERT INTO mailbox_credential (mailbox_id, kind, secret_blob_id, updated_at) VALUES ($1, 'gmail_refresh_token', $2, now())
       ON CONFLICT (mailbox_id) DO UPDATE SET secret_blob_id = excluded.secret_blob_id, updated_at = now()`,
      [o.mailboxId, blob],
    )
    await appendAudit(c, d.k, [{ actor: 'system', type: 'mailbox.authorised', payload: { mailbox: o.mailboxId, scope: GMAIL_SCOPE, replaced: !!old } }])
  })
}

/** The stored refresh token of a mailbox (read by the adapter's token source). */
export async function storedRefreshToken(db: Db, k: Keyring, mailboxId: string): Promise<string | null> {
  const r = (await db.query<{ secret_blob_id: string }>("SELECT secret_blob_id FROM mailbox_credential WHERE mailbox_id = $1 AND kind = 'gmail_refresh_token'", [mailboxId])).rows[0]
  return r ? getText(db, k, r.secret_blob_id) : null
}
