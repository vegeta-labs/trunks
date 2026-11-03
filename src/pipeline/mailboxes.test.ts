// TC-PRV-04 from E4: the service connects only to the providers of the mailbox kinds it is configured for — Gmail,
// Pub/Sub and Google's token endpoint for Gmail; Graph and Microsoft's token endpoint for Microsoft 365; nothing for
// kinds that are not configured. And C-ING-4 refuses the start on any doubt.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createKit, testConfig, type Kit } from './testkit.ts'
import { ensureMailboxes } from './ingest.ts'
import { MailHttp } from '../adapters/mailbox/http.ts'
import { FakeGmail } from '../adapters/mailbox/gmail.fake.ts'
import { FakeGraph } from '../adapters/mailbox/graph.fake.ts'
import { exchangeAndSave } from '../adapters/mailbox/gmail-auth.ts'
import { checkM365, startCloudMailboxes } from './mailboxes.ts'
import type { Config } from '../config/load.ts'

let k: Kit
const env = (n: string) => `value-of-${n}`
const hosts = (urls: string[]) => [...new Set(urls.map((u) => new URL(u).host))].sort()

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] })
  k = await createKit()
}, 60_000)
afterAll(async () => {
  vi.useRealTimers()
  await k.close()
})

describe('TC-PRV-04 outbound by configured mailbox kind', () => {
  it('TC-PRV-04 no Gmail or Microsoft 365 mailbox → not a single request', async () => {
    const urls: string[] = []
    const http = new MailHttp(async (u) => {
      urls.push(u)
      return new Response('{}')
    })
    expect(await checkM365(k.config, env, http)).toBeNull()
    expect(await startCloudMailboxes(k, k.config, env, null, http)).toEqual([])
    expect(urls).toEqual([])
  })

  it('TC-PRV-04 a Gmail mailbox → only gmail, oauth2 (and pubsub when configured); Microsoft 365 → only graph and login', async () => {
    const gconfig: Config = { ...testConfig(), gmail: { client_id_env: 'G_ID', client_secret_env: 'G_SECRET' } }
    gconfig.mailboxes = [{ id: 'gq', name: 'gq', kind: 'gmail', gmail: { address: 'ops@capital.example', labels: ['INBOX'] }, strips_external_auth_results: false, catch_up_minutes: 5 }]
    await ensureMailboxes(k.db, k.k, gconfig)
    const fake = new FakeGmail('ops@capital.example')
    const http = new MailHttp(fake.fetch)
    await exchangeAndSave({ db: k.db, k: k.k, http }, { mailboxId: 'gq', address: 'ops@capital.example', clientId: 'c', clientSecret: 's', redirect: 'http://127.0.0.1:1', code: 'code-ok', verifier: 'v'.repeat(50) })
    fake.requests.length = 0
    await startCloudMailboxes(k, gconfig, env, null, http)
    await vi.waitFor(async () => expect((await k.t.owner.query("SELECT 1 FROM message WHERE mailbox_id = 'gq'")).rowCount).toBe(0))
    expect(hosts(fake.requests.map((r) => r.url))).toEqual(['gmail.googleapis.com', 'oauth2.googleapis.com'])

    const mconfig: Config = {
      ...testConfig(),
      m365: { tenant_id: '11111111-1111-4111-8111-111111111111', client_id: '22222222-2222-4222-8222-222222222222', client_secret_env: 'M_SECRET', permission_review: { date: new Date().toISOString().slice(0, 10), reviewer: 'IT' }, negative_probe_mailbox: 'ceo@capital.example' },
    }
    mconfig.mailboxes = [{ id: 'mq', name: 'mq', kind: 'graph', graph: { user: 'ops@capital.example', folders: ['Inbox'] }, strips_external_auth_results: false, catch_up_minutes: 5 }]
    await ensureMailboxes(k.db, k.k, mconfig)
    const g = new FakeGraph(['ops@capital.example'])
    g.existing.add('ceo@capital.example')
    const mhttp = new MailHttp(g.fetch)
    const tokens = await checkM365(mconfig, env, mhttp)
    await startCloudMailboxes(k, mconfig, env, tokens, mhttp)
    expect(hosts(g.requests.map((r) => r.url))).toEqual(['graph.microsoft.com', 'login.microsoftonline.com'])
    expect([...fake.writes(), ...g.writes()]).toEqual([])
    // C-ING-4: the negative probe readable → the start is refused
    g.readable.add('ceo@capital.example')
    await expect(checkM365(mconfig, env, mhttp)).rejects.toThrow(/refusing to start .*④/)
  })

  it('TC-ING-13 a revoked Gmail token at start-up stops only that mailbox; the others start (Codex E4 F11)', async () => {
    const gconfig: Config = { ...testConfig(), gmail: { client_id_env: 'G_ID', client_secret_env: 'G_SECRET' } }
    gconfig.mailboxes = ['gr1', 'gr2'].map((id) => ({ id, name: id, kind: 'gmail' as const, gmail: { address: 'ops@capital.example', labels: ['INBOX'] }, strips_external_auth_results: false, catch_up_minutes: 5 }))
    await ensureMailboxes(k.db, k.k, gconfig)
    const fake = new FakeGmail('ops@capital.example')
    const http = new MailHttp(fake.fetch)
    // gr2 is authorised; gr1 has no token at all (as after a revocation)
    await exchangeAndSave({ db: k.db, k: k.k, http }, { mailboxId: 'gr2', address: 'ops@capital.example', clientId: 'c', clientSecret: 's', redirect: 'http://127.0.0.1:1', code: 'code-ok', verifier: 'v'.repeat(50) })
    const started = await startCloudMailboxes(k, gconfig, env, null, http)
    expect(started.map((a) => a.id)).toEqual(['gr1', 'gr2'])
    const st = await k.t.owner.query<{ s: string }>("SELECT payload->>'status' AS s FROM audit WHERE type = 'mailbox.status' AND payload->>'mailbox' = 'gr1'")
    expect(st.rows.map((r) => r.s)).toContain('auth_failed')
  })
})
