// Microsoft 365 against the in-process fake: TC-ING-12 (delta pages, a page failure, two folders and a server-side rule,
// a move between configured folders), TC-ING-19b (sync state invalid, 404), TC-ING-13 (no subscription: renew sends
// nothing), TC-PRV-06 (C-ING-4), and a nextLink to another host is never followed (TC-OUT-09). Nothing written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKit, testConfig, type Kit } from '../../pipeline/testkit.ts'
import { eml } from '../../ingest/testmail.ts'
import { catchUp } from '../../pipeline/catchup.ts'
import { ensureMailboxes, type MailboxInfo } from '../../pipeline/ingest.ts'
import { MailHttp } from './http.ts'
import { GraphAdapter, GraphTokens, m365PermissionProblems, resolveFolders } from './graph.ts'
import { FakeGraph } from './graph.fake.ts'

let k: Kit
const USER = 'ops@capital.example'
const info = (id: string): MailboxInfo => ({ id, trustedAuthResults: false, trustedAuthservId: 'mx.ops.example' })
const creds = { tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222', secret: 'app-secret' }
const mail = (n: string) => eml({ subject: `Graph ${n}`, messageId: `<${n}@sender.example>` })
const count = async (mb: string) => (await k.t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM message WHERE mailbox_id = $1', [mb])).rows[0]!.n

function setup(mb: string, folders = ['Inbox']) {
  const fake = new FakeGraph([USER, 'legal@capital.example'])
  fake.existing.add('ceo@capital.example') // exists, not designated
  fake.readable.delete('ceo@capital.example')
  const http = new MailHttp(fake.fetch)
  const tokens = new GraphTokens(http, creds)
  const adapters = async () =>
    (await resolveFolders(http, tokens, USER, folders)).map((f) => ({ folderKey: f.id, adapter: new GraphAdapter({ id: mb, name: mb, user: USER, folderId: f.id, stripsExternalAuthResults: false }, http, tokens) }))
  const run = async () => {
    for (const a of await adapters()) await catchUp(k, a.adapter, info(mb), {}, a.folderKey)
  }
  return { fake, http, tokens, adapters, run }
}

beforeAll(async () => {
  const config = testConfig()
  config.mailboxes.push(...['m1', 'm2', 'm3', 'm4'].map((id) => ({ id, name: id, kind: 'graph' as const, graph: { user: USER, folders: ['Inbox'] }, strips_external_auth_results: false, catch_up_minutes: 5 })))
  k = await createKit({ config })
  await ensureMailboxes(k.db, k.k, config)
}, 60_000)
afterAll(() => k.close())

describe('TC-ING-12 Microsoft 365 delta', () => {
  it('TC-ING-12 several pages; a page that fails → retried with the cursor kept; each message one Case; nothing written', async () => {
    const g = setup('m1')
    for (const n of ['a', 'b', 'c', 'd', 'e']) g.fake.add(mail(n))
    g.fake.failNextPage = 1
    await expect(g.run()).rejects.toThrow()
    expect(await count('m1')).toBe(0)
    await g.run()
    expect(await count('m1')).toBe(5)
    g.fake.add(mail('f'))
    await g.run()
    await g.run()
    expect(await count('m1')).toBe(6)
    expect(g.fake.writes()).toEqual([])
  })

  it('TC-ING-12 two configured folders, each with its own cursor; a rule files a message into the sub-folder → a Case; moved to the other configured folder → no second Case', async () => {
    const g = setup('m2', ['Inbox', 'Inbox/Deals'])
    g.fake.add(mail('in'))
    const filed = g.fake.add(mail('filed'), 'f-deals')
    await g.run()
    expect(await count('m2')).toBe(2)
    const cursors = await k.t.owner.query<{ folder_key: string }>("SELECT folder_key FROM mailbox_cursor WHERE mailbox_id = 'm2' ORDER BY folder_key")
    expect(cursors.rows.map((r) => r.folder_key)).toEqual(['f-deals', 'f-inbox'])
    g.fake.move(filed, 'f-inbox')
    await g.run()
    expect(await count('m2')).toBe(2)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'ingest.duplicate' AND payload->>'mailbox' = 'm2'")).rowCount).toBe(1)
  })

  it('TC-ING-12 a configured folder that does not exist refuses', async () => {
    await expect(setup('m2', ['Inbox/Nope']).adapters()).rejects.toThrow(/folder «Inbox\/Nope» not found/)
  })
})

describe('TC-ING-19b Microsoft 365 cursor', () => {
  it('TC-ING-19b sync state invalid → listed again, no duplicate, ingest.resync; a message deleted before fetching → ingest.gap', async () => {
    const g = setup('m3')
    g.fake.add(mail('s1'))
    await g.run()
    g.fake.add(mail('s2'))
    g.fake.invalidateDelta()
    await g.run()
    expect(await count('m3')).toBe(2)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'ingest.resync' AND payload->>'mailbox' = 'm3'")).rowCount).toBe(1)
    const gone = g.fake.add(mail('s3'))
    g.fake.add(mail('s4'))
    // s3 is in the delta but deleted before it is fetched: the provider confirms it is gone (404)
    const fetch = g.fake.fetch
    const http = new MailHttp(async (u, i) => {
      if (u.includes(`/messages/${gone}`)) g.fake.messages.splice(g.fake.messages.findIndex((x) => x.id === gone), 1)
      return fetch(u, i)
    })
    const tokens = new GraphTokens(http, creds)
    const [f] = await resolveFolders(http, tokens, USER, ['Inbox'])
    await catchUp(k, new GraphAdapter({ id: 'm3', name: 'm3', user: USER, folderId: f!.id, stripsExternalAuthResults: false }, http, tokens), info('m3'), {}, f!.id)
    expect(await count('m3')).toBe(3)
    expect((await k.t.owner.query("SELECT 1 FROM audit WHERE type = 'ingest.gap' AND payload->>'mailbox' = 'm3'")).rowCount).toBe(1)
  })

  it('TC-ING-13 renew sends nothing (no subscription in v1)', async () => {
    const g = setup('m4')
    const [a] = await g.adapters()
    const before = g.fake.requests.length
    await a!.adapter.renew()
    expect(g.fake.requests.length).toBe(before)
  })

  it('TC-OUT-09 a nextLink to another host is not followed and the token does not leave', async () => {
    const g = setup('m4')
    g.fake.host = 'evil.example'
    for (const n of ['x1', 'x2', 'x3']) g.fake.add(mail(n))
    await expect(g.run()).rejects.toThrow(/refused/)
    expect(g.fake.requests.some((r) => r.url.includes('evil.example'))).toBe(false)
  })
})

describe('TC-PRV-06 C-ING-4 permission check', () => {
  const base = { clientId: creds.clientId, permissionReview: { date: '2026-09-01', reviewer: 'IT lead' }, negativeProbe: 'ceo@capital.example', mailboxes: [USER] }
  const now = new Date('2026-11-01T00:00:00Z')
  it('TC-PRV-06 all in order → no problems', async () => {
    const g = setup('m4')
    g.fake.roles = ['User.Read.All']
    expect(await m365PermissionProblems(g.http, g.tokens, base, now)).toEqual([])
  })
  it('TC-PRV-06 no review record, or one older than 180 days → refused', async () => {
    const g = setup('m4')
    expect((await m365PermissionProblems(g.http, g.tokens, { ...base, permissionReview: undefined }, now)).join()).toMatch(/①.*missing/)
    expect((await m365PermissionProblems(g.http, g.tokens, { ...base, permissionReview: { date: '2026-04-01', reviewer: 'x' } }, now)).join()).toMatch(/older than 180 days/)
  })
  it('TC-PRV-06 Mail.Send, Mail.ReadWrite or tenant-wide Mail.Read granted in Entra → refused', async () => {
    for (const role of ['Mail.Send', 'Mail.ReadWrite', 'Mail.Read']) {
      const g = setup('m4')
      g.fake.roles = [role]
      expect((await m365PermissionProblems(g.http, g.tokens, base, now)).join()).toMatch(new RegExp(`②.*${role.replace('.', '\\.')}`))
    }
  })
  it('TC-PRV-06 ② is read whenever the directory permission exists (no switch): malformed or partial answers refuse; Mail.Send on a later page is found; no directory permission → ① only (Codex E4 F2, F3)', async () => {
    const g = setup('m4')
    g.fake.assignmentsBody = '<html>maintenance</html>'
    expect((await m365PermissionProblems(g.http, g.tokens, base, now)).join()).toMatch(/②.*could not be read/)
    const h = setup('m4')
    h.fake.roles = ['User.Read.All', 'Mail.Send']
    h.fake.assignmentsPages = 2
    expect((await m365PermissionProblems(h.http, h.tokens, base, now)).join()).toMatch(/②.*Mail\.Send/)
    const j = setup('m4')
    j.fake.directoryRead = false
    j.fake.roles = ['Mail.Send'] // cannot be seen without the directory permission: ① carries it
    expect(await m365PermissionProblems(j.http, j.tokens, base, now)).toEqual([])
  })

  it('TC-ING-12 links written by Graph in the OData key form with a literal @ are followed and stored; a stored link that is no longer acceptable resyncs (regression review R1)', async () => {
    const g = setup('m4')
    g.fake.odataLinks = true
    for (const n of ['o1', 'o2', 'o3']) g.fake.add(mail(n))
    await g.run()
    g.fake.add(mail('o4'))
    await g.run()
    expect(await count('m4')).toBe(4)
  })

  it('TC-PRV-06 incomplete evidence refuses: an assignment without its resource, a 403 that is not «no directory permission», a probe answering HTML (Codex round 2 F1)', async () => {
    const a = setup('m4')
    a.fake.assignmentsBody = JSON.stringify({ value: [{ appRoleId: 'r-send' }] })
    expect((await m365PermissionProblems(a.http, a.tokens, base, now)).join()).toMatch(/②/)
    const b = setup('m4')
    const html403 = new MailHttp(async (u, i) => (u.includes('servicePrincipals') ? new Response('<html>denied</html>', { status: 403 }) : b.fake.fetch(u, i)))
    expect((await m365PermissionProblems(html403, new GraphTokens(html403, creds), base, now)).join()).toMatch(/②/)
    const c = setup('m4')
    const html200 = new MailHttp(async (u, i) => (u.includes(`${encodeURIComponent(USER)}/messages`) ? new Response('<html>ok</html>', { status: 200 }) : c.fake.fetch(u, i)))
    expect((await m365PermissionProblems(html200, new GraphTokens(html200, creds), base, now)).join()).toMatch(/③/)
  })

  it('TC-ING-12 a configured folder on the second page of the folder list is found (Codex round 2 F11)', async () => {
    const g = setup('m4', ['Archive'])
    g.fake.folders.push({ id: 'f-archive', displayName: 'Archive', parent: null })
    const http = new MailHttp(async (u, i) => {
      if (u.includes('/mailFolders?')) {
        const second = u.includes('skiptoken')
        return new Response(JSON.stringify(second ? { value: [{ id: 'f-archive', displayName: 'Archive' }] } : { value: [{ id: 'f-inbox', displayName: 'Inbox' }], '@odata.nextLink': `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(USER)}/mailFolders?$skiptoken=2` }), { status: 200 })
      }
      return g.fake.fetch(u, i)
    })
    expect(await resolveFolders(http, new GraphTokens(http, creds), USER, ['Archive'])).toEqual([{ name: 'Archive', id: 'f-archive' }])
  })

  it('TC-ING-19b a delta page without a list or with an entry without an id is temporary: the cursor stays (round 4 F5)', async () => {
    const g = setup('m4')
    for (const body of [{ value: [{}], '@odata.deltaLink': 'x' }, { '@odata.deltaLink': 'x' }]) {
      const http = new MailHttp(async (u, i) => (u.includes('/messages/delta') ? new Response(JSON.stringify(body), { status: 200 }) : g.fake.fetch(u, i)))
      const tokens = new GraphTokens(http, creds)
      const [f] = await resolveFolders(http, tokens, USER, ['Inbox'])
      await expect(new GraphAdapter({ id: 'm4', name: 'm4', user: USER, folderId: f!.id, stripsExternalAuthResults: false }, http, tokens).catchUp(null)).rejects.toThrow(/delta:/)
    }
  })

  it('TC-OUT-09 a Graph nextLink to another allowed provider (Google) is refused; the Microsoft token never goes there (Codex E4 F1)', async () => {
    const g = setup('m4')
    g.fake.host = 'gmail.googleapis.com'
    for (const n of ['y1', 'y2', 'y3']) g.fake.add(mail(n))
    await expect(g.run()).rejects.toThrow(/outside/)
    expect(g.fake.requests.some((r) => r.url.includes('gmail.googleapis.com'))).toBe(false)
  })

  it('TC-PRV-06 the negative probe is readable, does not exist, or gives no answer → refused; a designated mailbox not readable → refused', async () => {
    const g = setup('m4')
    g.fake.readable.add('ceo@capital.example')
    expect((await m365PermissionProblems(g.http, g.tokens, base, now)).join()).toMatch(/④.*is readable/)
    const h = setup('m4')
    expect((await m365PermissionProblems(h.http, h.tokens, { ...base, negativeProbe: 'nobody@capital.example' }, now)).join()).toMatch(/④.*no clear/)
    const broken = new MailHttp(async (u, i) => (u.includes('ceo%40') ? Promise.reject(new TypeError('fetch failed')) : h.fake.fetch(u, i)))
    expect((await m365PermissionProblems(broken, new GraphTokens(broken, creds), base, now)).join()).toMatch(/④.*no answer/)
    const j = setup('m4')
    j.fake.readable.delete(USER)
    expect((await m365PermissionProblems(j.http, j.tokens, base, now)).join()).toMatch(/③.*not readable/)
  })
})
