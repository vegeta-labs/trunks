// Gmail against the in-process fake (test plan §1): TC-ING-12 (duplicate, out-of-order, lost notifications; polling
// only; C-ING-6 labels), TC-ING-13 (watch renewal and its failure; a revoked token), TC-ING-19b (historyId expired,
// 404, temporary errors, a crash part way through a listing). Nothing is ever written to the mailbox.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKit, testConfig, type Kit } from '../../pipeline/testkit.ts'
import { eml } from '../../ingest/testmail.ts'
import { catchUp } from '../../pipeline/catchup.ts'
import { guardedCatchUp, guardedRenew, mailboxWarnings } from '../../pipeline/mailbox-runtime.ts'
import { ensureMailboxes, type MailboxInfo } from '../../pipeline/ingest.ts'
import { MailHttp } from './http.ts'
import { GmailAdapter, GmailTokens, Temporary } from './gmail.ts'
import { FakeGmail } from './gmail.fake.ts'

let k: Kit
const info = (id: string): MailboxInfo => ({ id, trustedAuthResults: false, trustedAuthservId: 'mx.ops.example' })

function gmail(id: string, o: { pubsub?: boolean; labels?: string[]; refresh?: string } = {}) {
  const fake = new FakeGmail(`${id}@ops.example`)
  const http = new MailHttp(fake.fetch)
  const tokens = new GmailTokens(http, { address: fake.address, clientId: 'cid', clientSecret: 'secret', refreshToken: async () => o.refresh ?? 'refresh-ok' })
  const adapter = new GmailAdapter(
    { id, name: id, address: fake.address, labels: o.labels ?? ['INBOX'], stripsExternalAuthResults: false, ...(o.pubsub ? { pubsub: { topic: 'projects/p/topics/t', subscription: 'projects/p/subscriptions/s', serviceAccount: { client_email: 'sa@p.example', private_key: TEST_KEY } } } : {}) },
    http,
    tokens,
  )
  return { fake, adapter }
}

const cases = async (mailbox: string) => (await k.t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM message WHERE mailbox_id = $1', [mailbox])).rows[0]!.n
const mail = (n: string) => eml({ subject: `Gmail ${n}`, messageId: `<${n}@sender.example>` })

beforeAll(async () => {
  const config = testConfig()
  config.mailboxes.push(
    ...['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((id) => ({ id, name: id, kind: 'gmail' as const, gmail: { address: `${id}@ops.example`, labels: ['INBOX'] }, strips_external_auth_results: false, catch_up_minutes: 5 })),
  )
  k = await createKit({ config })
  await ensureMailboxes(k.db, k.k, config)
}, 60_000)
afterAll(() => k.close())

describe('TC-ING-12 Gmail notifications and labels', () => {
  it('TC-ING-12 duplicate, out-of-order and lost notifications → each message exactly one Case; polling alone the same', async () => {
    const { fake, adapter } = gmail('g1', { pubsub: true })
    for (const n of ['a', 'b', 'c']) fake.add(mail(n))
    // three notifications for three messages: the catch-up runs twice, then once more for a «late» one
    await catchUp(k, adapter, info('g1'))
    await catchUp(k, adapter, info('g1'))
    fake.add(mail('d')) // its notification is lost: the next interval's catch-up finds it
    await catchUp(k, adapter, info('g1'))
    await catchUp(k, adapter, info('g1'))
    expect(await cases('g1')).toBe(4)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'ingest.duplicate' AND payload->>'mailbox' = 'g1'")).rowCount).toBe(0)
    expect(fake.writes()).toEqual([])
  })

  it('TC-ING-12 C-ING-6: sent, drafts, spam and trash never become Cases; a message moved from spam to the inbox does, once', async () => {
    const { fake, adapter } = gmail('g2')
    fake.add(mail('in'))
    fake.add(mail('sent'), ['SENT'])
    fake.add(mail('draft'), ['DRAFT'])
    fake.add(mail('sent-to-self'), ['INBOX', 'SENT'])
    const spam = fake.add(mail('spam'), ['SPAM'])
    fake.add(mail('trash'), ['TRASH'])
    await catchUp(k, adapter, info('g2')) // first run: a full listing
    expect(await cases('g2')).toBe(1)
    fake.add(mail('in2'))
    fake.add(mail('draft2'), ['DRAFT'])
    fake.add(mail('sent-to-self-2'), ['INBOX', 'SENT']) // in the history too: a message we sent is never a Case
    await catchUp(k, adapter, info('g2'))
    expect(await cases('g2')).toBe(2)
    fake.relabel(spam, ['INBOX'], ['SPAM'])
    await catchUp(k, adapter, info('g2'))
    await catchUp(k, adapter, info('g2'))
    expect(await cases('g2')).toBe(3)
  })

  it('TC-ING-12 history entries with the message id only: the labels are read before deciding (Codex E4 F6)', async () => {
    const { fake, adapter } = gmail('g3')
    fake.sparseHistory = true
    await catchUp(k, adapter, info('g3'))
    fake.add(mail('sparse-in'))
    fake.add(mail('sparse-sent'), ['SENT'])
    await catchUp(k, adapter, info('g3'))
    expect(await cases('g3')).toBe(1)
  })

  it('TC-ING-19b a listing or profile that is not one (a maintenance page) is temporary: the cursor stays (Codex E4 F7)', async () => {
    const { fake } = gmail('g5')
    fake.add(mail('m-in'))
    for (const bad of ['<html>maintenance</html>', '{"messages": "oops"}']) {
      const http = new MailHttp(async (u, i) => (u.includes('/messages?') ? new Response(bad, { status: 200 }) : fake.fetch(u, i)))
      const a = new GmailAdapter({ id: 'g5', name: 'g5', address: fake.address, labels: ['INBOX'], stripsExternalAuthResults: false }, http, new GmailTokens(http, { address: fake.address, clientId: 'c', clientSecret: 's', refreshToken: async () => 'refresh-ok' }))
      await expect(a.catchUp(null)).rejects.toBeInstanceOf(Temporary)
    }
  })

  it('TC-ING-12 a label list that is not one is temporary; a missing label found at catch-up time shows a configuration warning (regression review R3)', async () => {
    const { fake } = gmail('g3')
    const http = new MailHttp(async (u, i) => (u.endsWith('/labels') ? new Response('<html>maintenance</html>', { status: 200 }) : fake.fetch(u, i)))
    const a = new GmailAdapter({ id: 'g3', name: 'g3', address: fake.address, labels: ['INBOX'], stripsExternalAuthResults: false }, http, new GmailTokens(http, { address: fake.address, clientId: 'c', clientSecret: 's', refreshToken: async () => 'refresh-ok' }))
    await expect(a.resolveLabels()).rejects.toBeInstanceOf(Temporary)
    const missing = gmail('g3', { labels: ['Gone'] })
    expect(await guardedCatchUp(k, missing.adapter, info('g3'))).toBeNull()
    expect((await mailboxWarnings(k.db)).join()).toMatch(/Mailbox g3: a configured label or folder does not exist/)
    expect(await guardedCatchUp(k, gmail('g3').adapter, info('g3'))).not.toBeNull() // corrected → the warning goes
    expect((await mailboxWarnings(k.db)).join()).not.toMatch(/Mailbox g3/)
  })

  it('TC-ING-12 moved to trash between listing and fetching → not received; a listing that is an array is temporary (Codex round 2 F8, F9)', async () => {
    const { fake, adapter } = gmail('g5')
    const id = fake.add(mail('moved'))
    const listed = await adapter.catchUp(null)
    fake.relabel(id, ['TRASH'], ['INBOX'])
    expect(await adapter.fetchRaw(listed.refs.at(-1)!)).toEqual({ gone: true })
    const http = new MailHttp(async (u, i) => (u.includes('/messages?') ? new Response('[]', { status: 200 }) : fake.fetch(u, i)))
    const a = new GmailAdapter({ id: 'g5', name: 'g5', address: fake.address, labels: ['INBOX'], stripsExternalAuthResults: false }, http, new GmailTokens(http, { address: fake.address, clientId: 'c', clientSecret: 's', refreshToken: async () => 'refresh-ok' }))
    await expect(a.catchUp(null)).rejects.toBeInstanceOf(Temporary)
  })

  it('TC-ING-19b a history entry with the id only whose message is already gone records ingest.gap (Codex round 2 F10)', async () => {
    const { fake, adapter } = gmail('g2')
    fake.sparseHistory = true
    await catchUp(k, adapter, info('g2'))
    const before = (await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'ingest.gap' AND payload->>'mailbox' = 'g2'")).rowCount!
    const gone = fake.add(mail('vanished'))
    fake.messages.delete(gone)
    await catchUp(k, adapter, info('g2'))
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'ingest.gap' AND payload->>'mailbox' = 'g2'")).rowCount).toBe(before + 1)
  })

  it('TC-ING-12 a configured label name that does not exist refuses; a never-received label is refused', async () => {
    await expect(gmail('g3', { labels: ['Nope'] }).adapter.resolveLabels()).rejects.toThrow(/label «Nope» not found/)
    await expect(gmail('g3', { labels: ['SPAM'] }).adapter.resolveLabels()).rejects.toThrow(/never received/)
    expect(await gmail('g3', { labels: ['Deals'] }).adapter.resolveLabels()).toEqual(['Label_7'])
  })
})

describe('TC-ING-19b Gmail cursor', () => {
  it('TC-ING-19b historyId expired → full listing, no duplicate Case, ingest.resync; a 404 message → ingest.gap and the cursor moves; a 503 → retried, cursor kept', async () => {
    const { fake, adapter } = gmail('g4')
    fake.add(mail('h1'))
    await catchUp(k, adapter, info('g4'))
    fake.add(mail('h2'))
    fake.oldestHistory = fake.historyId + 1 // everything we know is too old now
    const r = await catchUp(k, adapter, info('g4'))
    expect(r.resync).toBe(true)
    expect(await cases('g4')).toBe(2)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'ingest.resync' AND payload->>'mailbox' = 'g4'")).rowCount).toBe(1)
    fake.oldestHistory = 0
    const gone = fake.add(mail('h3'))
    fake.messages.delete(gone) // deleted before we fetch it
    fake.add(mail('h4'))
    fake.failMessageGets = 1
    await expect(catchUp(k, adapter, info('g4'))).rejects.toThrow() // h3's 404 is fine; first fetch (h3) gets 503 first
    expect(await cases('g4')).toBe(2)
    await catchUp(k, adapter, info('g4'))
    expect(await cases('g4')).toBe(3)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'ingest.gap' AND payload->>'mailbox' = 'g4'")).rowCount).toBe(1)
  })

  it('TC-ING-19b a crash part way through the first listing → listed again, each message one Case', async () => {
    const { fake, adapter } = gmail('g5')
    for (const n of ['l1', 'l2', 'l3', 'l4', 'l5']) fake.add(mail(n))
    await expect(catchUp(k, adapter, info('g5'), { beforeIngest: (i) => { if (i === 2) throw new Error('crash') } })).rejects.toThrow('crash')
    expect(await cases('g5')).toBe(2)
    await catchUp(k, adapter, info('g5'))
    expect(await cases('g5')).toBe(5)
  })
})

describe('TC-ING-13 renewal and authorisation', () => {
  it('TC-ING-13 watch is renewed; a failed renewal is audited once and shown; a revoked token stops only that mailbox', async () => {
    const { fake, adapter } = gmail('g6', { pubsub: true })
    expect(await guardedRenew(k, adapter)).toBe(true)
    expect(JSON.parse(fake.watches[0]!)).toMatchObject({ topicName: 'projects/p/topics/t', labelIds: ['INBOX'] })
    fake.failWatch = true
    expect(await guardedRenew(k, adapter)).toBe(false)
    expect(await guardedRenew(k, adapter)).toBe(false)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'mailbox.status' AND payload->>'mailbox' = 'g6' AND payload->>'status' = 'renew_failed'")).rowCount).toBe(1)
    expect((await mailboxWarnings(k.db)).join()).toMatch(/Mailbox g6: renewing its notifications failed/)
    fake.failWatch = false
    await guardedRenew(k, adapter)
    expect(await mailboxWarnings(k.db)).toEqual([])

    const revoked = gmail('g6', { refresh: 'refresh-revoked' })
    revoked.fake.add(mail('r1'))
    expect(await guardedCatchUp(k, revoked.adapter, info('g6'))).toBeNull()
    expect((await mailboxWarnings(k.db)).join()).toMatch(/Mailbox g6: its authorisation was revoked/)
    // another mailbox goes on
    const other = gmail('g1')
    other.fake.add(mail('still'))
    expect(await guardedCatchUp(k, other.adapter, info('g1'))).not.toBeNull()
  })

  it('TC-ING-13 a 403 rate limit is temporary, not a lost authorisation; a refused watch is a renewal failure (self-test F5)', async () => {
    const { fake, adapter } = gmail('g6', { pubsub: true })
    fake.add(mail('rl'))
    const limited = new GmailAdapter({ id: 'g6', name: 'g6', address: fake.address, labels: ['INBOX'], stripsExternalAuthResults: false }, new MailHttp(async (u, i) => (u.includes('/messages?') ? new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 403 }) : fake.fetch(u, i))), new GmailTokens(new MailHttp(fake.fetch), { address: fake.address, clientId: 'c', clientSecret: 's', refreshToken: async () => 'refresh-ok' }))
    await expect(limited.catchUp(null)).rejects.toBeInstanceOf(Temporary)
    const refused = new GmailAdapter({ id: 'g6', name: 'g6', address: fake.address, labels: ['INBOX'], stripsExternalAuthResults: false, pubsub: { topic: 'projects/p/topics/t', subscription: 'projects/p/subscriptions/s', serviceAccount: { client_email: 'sa@p.example', private_key: TEST_KEY } } }, new MailHttp(async (u, i) => (u.endsWith('/watch') ? new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }), { status: 403 }) : fake.fetch(u, i))), new GmailTokens(new MailHttp(fake.fetch), { address: fake.address, clientId: 'c', clientSecret: 's', refreshToken: async () => 'refresh-ok' }))
    expect(await guardedRenew(k, refused)).toBe(false)
    const last = await k.t.owner.query<{ s: string }>("SELECT payload->>'status' AS s FROM audit WHERE type = 'mailbox.status' AND payload->>'mailbox' = 'g6' AND payload->>'kind' = 'renew' ORDER BY seq DESC LIMIT 1")
    expect(last.rows[0]!.s).toBe('renew_failed')
    void adapter
  })

  it('TC-ING-13 a token for another account is refused (review #7); a token whose scope is not exactly gmail.readonly is refused', async () => {
    const wrong = gmail('g6')
    wrong.fake.refreshTokens.set('refresh-ok', 'someone.else@ops.example')
    await expect(wrong.adapter.resolveLabels()).rejects.toThrow(/another account/)
    const broad = gmail('g6')
    broad.fake.scope = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify'
    await expect(broad.adapter.resolveLabels()).rejects.toThrow(/another scope/)
  })
})

// a throwaway RSA key for the service-account JWT (fictional; the fake does not check the signature)
const TEST_KEY = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
