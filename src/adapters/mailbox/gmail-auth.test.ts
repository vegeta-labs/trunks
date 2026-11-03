// TC-PRV-11 (PRD decision 6): the consent asks for gmail.readonly only; a broader or narrower scope, or another account,
// saves nothing; the refresh token is stored only encrypted; re-authorising revokes the old token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKit, testConfig, type Kit } from '../../pipeline/testkit.ts'
import { ensureMailboxes } from '../../pipeline/ingest.ts'
import { MailHttp } from './http.ts'
import { FakeGmail } from './gmail.fake.ts'
import { authUrl, exchangeAndSave, pkce, storedRefreshToken } from './gmail-auth.ts'

let k: Kit
beforeAll(async () => {
  const config = testConfig()
  config.mailboxes.push({ id: 'ga', name: 'ga', kind: 'gmail', gmail: { address: 'ops@capital.example', labels: ['INBOX'] }, strips_external_auth_results: false, catch_up_minutes: 5 })
  k = await createKit({ config })
  await ensureMailboxes(k.db, k.k, config)
}, 60_000)
afterAll(() => k.close())

const o = { mailboxId: 'ga', address: 'ops@capital.example', clientId: 'cid', clientSecret: 'csecret', redirect: 'http://127.0.0.1:53999', code: 'code-ok', verifier: 'v'.repeat(64) }

describe('TC-PRV-11 Gmail authorisation', () => {
  it('TC-PRV-11 the consent request asks for gmail.readonly only, with PKCE', () => {
    const p = pkce()
    const u = new URL(authUrl('cid', o.redirect, o.address, p))
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53999')
  })

  it('TC-PRV-11 a scope that is broader or narrower, or another account → nothing saved', async () => {
    for (const scope of ['https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.metadata']) {
      const fake = new FakeGmail(o.address)
      fake.scope = scope
      await expect(exchangeAndSave({ db: k.db, k: k.k, http: new MailHttp(fake.fetch) }, o)).rejects.toThrow(/exactly gmail.readonly/)
    }
    const fake = new FakeGmail(o.address)
    fake.consentAccount = 'personal@capital.example'
    await expect(exchangeAndSave({ db: k.db, k: k.k, http: new MailHttp(fake.fetch) }, o)).rejects.toThrow(/not the configured mailbox address/)
    expect((await k.t.owner.query('SELECT 1 FROM mailbox_credential')).rowCount).toBe(0)
  })

  it('TC-PRV-11 saved encrypted only; re-authorising replaces the token without revoking the grant (self-test F3)', async () => {
    const fake = new FakeGmail(o.address)
    const d = { db: k.db, k: k.k, http: new MailHttp(fake.fetch) }
    await exchangeAndSave(d, o)
    const first = await storedRefreshToken(k.db, k.k, 'ga')
    expect(first).toMatch(/^refresh-/)
    // nowhere in the database in clear text
    const dump = (await k.t.owner.query<{ t: string }>("SELECT string_agg(x::text, '|') AS t FROM (SELECT * FROM mailbox_credential) x")).rows[0]!.t
    expect(dump).not.toContain(first!)
    expect((await k.t.owner.query('SELECT 1 FROM secret_blob WHERE position($1::bytea in ciphertext) > 0', [Buffer.from(first!)])).rowCount).toBe(0)
    await exchangeAndSave(d, o)
    expect(fake.revoked.size).toBe(0)
    expect(fake.requests.some((r) => r.url.endsWith('/revoke'))).toBe(false)
    expect(await storedRefreshToken(k.db, k.k, 'ga')).not.toBe(first)
    expect((await k.t.owner.query("SELECT payload FROM audit WHERE type = 'mailbox.authorised'")).rowCount).toBe(2)
    expect(fake.writes()).toEqual([])
  })
})
