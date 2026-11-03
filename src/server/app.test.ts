import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { createKit, type Kit } from '../pipeline/testkit.ts'
import { buildServer, CSP } from './app.ts'
import { bootstrapAdmin } from './auth.ts'
import { Oidc } from './oidc.ts'
import { startMockIdp, type MockIdp } from './mock-idp.ts'
import { eml } from '../ingest/testmail.ts'

const ADMIN_PASSWORD = 'initial-admin-secret-1234'
let k: Kit
let app: FastifyInstance
let idp: MockIdp
let logs = ''

beforeAll(async () => {
  k = await createKit()
  idp = await startMockIdp()
  const secretDir = mkdtempSync(join(tmpdir(), 'doi-secret-'))
  writeFileSync(join(secretDir, 'admin'), `${ADMIN_PASSWORD}\n`)
  expect(await bootstrapAdmin(k.db, k.k, join(secretDir, 'admin'))).toBe('created')
  const config = {
    ...k.config,
    auth: { session_hours: 12, oidc: { issuer: idp.issuer, client_id: 'doi', client_secret_env: 'X', redirect_uri: 'http://app.example/auth/oidc/callback', role_claim: 'roles', role_map: { 'ops-reviewers': 'reviewer' as const, 'ops-admins': 'admin' as const } } },
  }
  const oidc = new Oidc({ issuer: idp.issuer, clientId: 'doi', clientSecret: 'oidc-client-secret', redirectUri: 'http://app.example/auth/oidc/callback', roleClaim: 'roles', roleMap: config.auth.oidc.role_map, allowHttp: true }, k.k)
  const stream = new Writable({ write(chunk, _enc, cb) { logs += chunk.toString(); cb() } })
  app = await buildServer({ db: k.db, k: k.k, files: k.files, config, oidc, logger: { level: 'trace', stream } })
  await k.ingest(eml({ subject: 'Hello', html: '<p>Hi <img src="https://tracker.example/x.png"><script>alert(1)</script><link rel="stylesheet" href="https://cdn.example/x.css"></p>' }))
  await k.drain()
}, 60_000)
afterAll(async () => {
  await app?.close()
  await idp?.close()
  await k?.close()
})

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }, name = 'doi_session') => res.cookies.find((c) => c.name === name)?.value
async function login(username: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } })
  return { res, session: cookieOf(res), csrf: res.json().csrf as string }
}
async function adminSession() {
  const changed = await login('admin', 'admin-changed-password-99')
  if (changed.res.statusCode === 200) return changed
  let a = await login('admin', ADMIN_PASSWORD)
  if (a.res.json().user?.mustChangePassword) {
    await app.inject({ method: 'POST', url: '/api/password', cookies: { doi_session: a.session! }, headers: { 'x-csrf-token': a.csrf }, payload: { current: ADMIN_PASSWORD, next: 'admin-changed-password-99' } })
    a = await login('admin', 'admin-changed-password-99')
  }
  return a
}

describe('login and roles', () => {
  it('TC-PRV-07 the initial admin comes from the secret file and must change the password; no credential in any log', async () => {
    const a = await login('admin', ADMIN_PASSWORD)
    expect(a.res.statusCode).toBe(200)
    expect(a.res.json().user).toMatchObject({ role: 'admin', mustChangePassword: true })
    // until the password is changed, nothing else works
    const blocked = await app.inject({ method: 'GET', url: '/api/cases', cookies: { doi_session: a.session! } })
    expect(blocked.statusCode).toBe(403)
    await adminSession()
    await login('admin', 'wrong-password-attempt')
    // query strings never reach the log (deal names, OIDC codes)
    await app.inject({ method: 'GET', url: '/auth/oidc/callback?code=SECRET-AUTH-CODE-123&state=STATE-XYZ' })
    await app.inject({ method: 'POST', url: '/api/directory/commitments?deal=Project%20Nightingale%20Secret', headers: { 'content-type': 'text/csv' }, payload: 'x' })
    for (const secret of [ADMIN_PASSWORD, 'admin-changed-password-99', 'wrong-password-attempt', 'oidc-client-secret', a.session!, a.csrf, 'SECRET-AUTH-CODE-123', 'STATE-XYZ', 'Nightingale'])
      expect(logs.includes(secret), secret).toBe(false)
    expect(logs.length).toBeGreaterThan(0)
    const audit = (await k.db.query('SELECT a::text AS r FROM audit a')).rows.map((r) => r.r).join('\n')
    expect(audit.includes(ADMIN_PASSWORD)).toBe(false)
  })

  it('TC-REV-06 local login: success, wrong password, expired session; OIDC login maps the role', async () => {
    const admin = await adminSession()
    expect((await login('admin', 'nope-nope-nope')).res.statusCode).toBe(401)
    expect((await login('nobody', 'nope-nope-nope')).res.statusCode).toBe(401)
    // expire the session
    await k.t.owner.query(`UPDATE app_session SET expires_at = now() - interval '1 second' WHERE id_hmac = $1`, [k.k.hmac(`session\0${admin.session}`)])
    expect((await app.inject({ method: 'GET', url: '/api/session', cookies: { doi_session: admin.session! } })).statusCode).toBe(401)

    // the sign-in page offers the organisation sign-in only with OIDC configured (E5 acceptance G4)
    expect((await app.inject({ method: 'GET', url: '/api/signin-options' })).json()).toEqual({ oidc: true })
    const plain = await buildServer({ db: k.db, k: k.k, files: k.files, config: { ...k.config, auth: { session_hours: 12 } } })
    expect((await plain.inject({ method: 'GET', url: '/api/signin-options' })).json()).toEqual({ oidc: false })
    expect((await plain.inject({ method: 'GET', url: '/auth/oidc/start' })).statusCode).toBe(404)
    await plain.close()
    // OIDC: start → identity provider → callback → session
    const start = await app.inject({ method: 'GET', url: '/auth/oidc/start' })
    expect(start.statusCode).toBe(302)
    const flow = cookieOf(start, 'doi_oidc')!
    const atIdp = await fetch(start.headers.location as string, { redirect: 'manual' })
    const back = new URL(atIdp.headers.get('location')!)
    const cb = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, cookies: { doi_oidc: flow } })
    expect(cb.statusCode).toBe(302)
    const s = cookieOf(cb)!
    const me = await app.inject({ method: 'GET', url: '/api/session', cookies: { doi_session: s } })
    expect(me.json().user).toMatchObject({ role: 'reviewer', username: 'reviewer@ops.example' })
    // a claim without a mapped role is refused
    idp.claims = { sub: 'user-2', roles: ['marketing'] }
    const start2 = await app.inject({ method: 'GET', url: '/auth/oidc/start' })
    const back2 = new URL((await fetch(start2.headers.location as string, { redirect: 'manual' })).headers.get('location')!)
    expect((await app.inject({ method: 'GET', url: `${back2.pathname}${back2.search}`, cookies: { doi_oidc: cookieOf(start2, 'doi_oidc')! } })).statusCode).toBe(403)
    // a tampered state cookie is refused
    expect((await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, cookies: { doi_oidc: `${flow}x` } })).statusCode).toBe(403)
  })

  it('TC-REV-05 reviewer cannot import or manage users; no session → 401; no CSRF → 403', async () => {
    const admin = await adminSession()
    const h = { cookies: { doi_session: admin.session! }, headers: { 'x-csrf-token': admin.csrf } }
    const created = await app.inject({ method: 'POST', url: '/api/users', ...h, payload: { username: 'rita', role: 'reviewer', password: 'rita-temporary-pass-1' } })
    expect(created.statusCode).toBe(200)
    const ritaId = created.json().id as string
    let rita = await login('rita', 'rita-temporary-pass-1')
    await app.inject({ method: 'POST', url: '/api/password', cookies: { doi_session: rita.session! }, headers: { 'x-csrf-token': rita.csrf }, payload: { current: 'rita-temporary-pass-1', next: 'rita-own-password-22' } })
    rita = await login('rita', 'rita-own-password-22')
    const rh = { cookies: { doi_session: rita.session! }, headers: { 'x-csrf-token': rita.csrf } }
    expect((await app.inject({ method: 'GET', url: '/api/cases', cookies: rh.cookies })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/directory/deals', ...rh, headers: { ...rh.headers, 'content-type': 'text/csv' }, payload: 'name,currency\nX,GBP\n' })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/users', ...rh, payload: { username: 'x', role: 'admin', password: 'xxxxxxxxxxxxxxx' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: `/api/users/${ritaId}/role`, ...rh, payload: { role: 'admin' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/cases' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/logout', cookies: rh.cookies })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/directory/deals', cookies: { doi_session: admin.session! }, headers: { 'content-type': 'text/csv' }, payload: 'name,currency\nX,GBP\n' })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/directory/deals', ...h, headers: { ...h.headers, 'content-type': 'text/csv' }, payload: 'name,currency\nX,GBP\n' })).statusCode).toBe(200)
  })

  it('TC-REV-05 another tab of the same browser gets the CSRF token again and can work and sign out (M-05 F4)', async () => {
    const admin = await adminSession()
    // the tab that signed in is closed: a second tab has only the session cookie
    const tab = await app.inject({ method: 'GET', url: '/api/csrf', cookies: { doi_session: admin.session! } })
    expect(tab.statusCode).toBe(200)
    expect(tab.json().csrf).toBe(admin.csrf)
    // a must-change-password user's new tab gets it too (plan review R12)
    const made = await app.inject({ method: 'POST', url: '/api/users', cookies: { doi_session: admin.session! }, headers: { 'x-csrf-token': admin.csrf }, payload: { username: 'nina', role: 'reviewer', password: 'nina-temporary-pass-1' } })
    expect(made.statusCode).toBe(200)
    const nina = await login('nina', 'nina-temporary-pass-1')
    const ninaTab = await app.inject({ method: 'GET', url: '/api/csrf', cookies: { doi_session: nina.session! } })
    expect(ninaTab.statusCode).toBe(200)
    // another session's token is refused; no session, no token
    const other = await login('nina', 'nina-temporary-pass-1')
    expect((await app.inject({ method: 'POST', url: '/api/logout', cookies: { doi_session: nina.session! }, headers: { 'x-csrf-token': other.csrf } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/csrf' })).statusCode).toBe(401)
    // the second tab signs out with the fetched token; afterwards the session and its token are gone
    expect((await app.inject({ method: 'POST', url: '/api/logout', cookies: { doi_session: nina.session! }, headers: { 'x-csrf-token': ninaTab.json().csrf } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/csrf', cookies: { doi_session: nina.session! } })).statusCode).toBe(401)
  })

  it('TC-AUD-03 (E1 part) creating a user, granting a role and resetting a password each leave a record', async () => {
    const admin = await adminSession()
    const h = { cookies: { doi_session: admin.session! }, headers: { 'x-csrf-token': admin.csrf } }
    const id = (await app.inject({ method: 'POST', url: '/api/users', ...h, payload: { username: 'arnold', role: 'reviewer', password: 'arnold-temp-pass-12' } })).json().id
    await app.inject({ method: 'PUT', url: `/api/users/${id}/role`, ...h, payload: { role: 'approver' } })
    await app.inject({ method: 'POST', url: `/api/users/${id}/reset`, ...h, payload: { password: 'arnold-reset-pass-34' } })
    const types = (await k.db.query(`SELECT type FROM audit WHERE payload->>'user_id' = $1 ORDER BY seq`, [id])).rows.map((r) => r.type)
    expect(types).toEqual(['user.created', 'user.role_changed', 'user.credential_reset'])
    const events = (await k.db.query('SELECT type, role FROM user_event WHERE user_id = $1 ORDER BY at, type', [id])).rows.map((r) => r.type)
    expect(events.sort()).toEqual(['created', 'credential_reset', 'role_granted', 'role_granted', 'role_removed'])
  })
})

describe('route protection', () => {
  it('TC-REV-05 every non-public route needs a session, also when the path is percent-encoded; CSRF on every change', async () => {
    const routes = app.printRoutes({ commonPrefix: false })
    expect(routes).toContain('/api/cases')
    const gets = ['/api/cases', '/api/session', '/api/csrf', `/api/cases/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`]
    const posts = ['/api/users', '/api/directory/deals', '/api/logout', '/api/password', `/api/users/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/reset`]
    const encode = (u: string) => [u, u.replace('/api/', '/%61pi/'), u.replace('/api/', '/%61%70%69/'), u.replace('cases', 'c%61ses')]
    for (const u of gets.flatMap(encode)) expect((await app.inject({ method: 'GET', url: u })).statusCode, u).toBe(401)
    for (const u of posts.flatMap(encode)) expect((await app.inject({ method: 'POST', url: u, payload: {} })).statusCode, u).toBe(401)
    expect((await app.inject({ method: 'PUT', url: `/%61pi/users/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/role`, payload: {} })).statusCode).toBe(401)
    // signed in, no CSRF token, encoded path → still refused
    const admin = await adminSession()
    const r = await app.inject({ method: 'POST', url: '/%61pi/users', cookies: { doi_session: admin.session! }, payload: { username: 'eve', role: 'admin', password: 'eve-password-12345' } })
    expect(r.statusCode).toBe(403)
  })
  it('a login that checked the old password cannot outlive a password change (Codex F12)', async () => {
    const { verifyLogin, createSession, sessionUser, changeOwnPassword } = await import('./auth.ts')
    const admin = await adminSession()
    const seen = (await verifyLogin(k.db, k.k, 'admin', 'admin-changed-password-99'))! // an attacker's login, still in flight
    expect(await changeOwnPassword(k.db, k.k, seen.id, 'admin-changed-password-99', 'admin-changed-password-55', k.k.hmac(`session\0${admin.session}`))).toBe(true)
    const late = await createSession(k.db, k.k, seen.id, seen.credentialVersion, 12) // the in-flight login completes
    expect(await sessionUser(k.db, k.k, late.session)).toBeNull()
    expect(await sessionUser(k.db, k.k, admin.session!)).not.toBeNull() // the session that made the change stays
    await changeOwnPassword(k.db, k.k, seen.id, 'admin-changed-password-55', 'admin-changed-password-99', k.k.hmac(`session\0${admin.session}`))
  })
  it('changing one\'s own password ends the other sessions', async () => {
    const admin = await adminSession()
    const other = await login('admin', 'admin-changed-password-99')
    const res = await app.inject({ method: 'POST', url: '/api/password', cookies: { doi_session: admin.session! }, headers: { 'x-csrf-token': admin.csrf }, payload: { current: 'admin-changed-password-99', next: 'admin-changed-password-77' } })
    expect(res.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/session', cookies: { doi_session: other.session! } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/session', cookies: { doi_session: admin.session! } })).statusCode).toBe(200)
    // put the password back for the other tests
    await app.inject({ method: 'POST', url: '/api/password', cookies: { doi_session: admin.session! }, headers: { 'x-csrf-token': admin.csrf }, payload: { current: 'admin-changed-password-77', next: 'admin-changed-password-99' } })
  })
})

describe('directory import API', () => {
  const HEADERS: Record<string, string> = {
    deals: 'name,currency',
    contacts: 'contact_id,name,email,phone,role,deal,investor_id,authorised_for',
    commitments: 'investor_id,name,email,reference,cash_due,scheme',
    bank: 'transaction_id,date,amount,payer,reference',
    ledger: 'transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency',
  }
  const DEAL = 'Header Only Ltd'
  const counts = async () => (await k.db.query(`SELECT (SELECT count(*)::int FROM directory_version) AS v, (SELECT count(*)::int FROM audit WHERE type = 'directory.imported') AS a`)).rows[0]
  const poster = async () => {
    const admin = await adminSession()
    return (kind: string, csv: string, query = '') =>
      app.inject({ method: 'POST', url: `/api/directory/${kind}${query}`, cookies: { doi_session: admin.session! }, headers: { 'x-csrf-token': admin.csrf, 'content-type': 'text/csv' }, payload: csv })
  }

  it('TC-DIR-09 a header-only file is refused with 422 for every kind; the current version stays, no new version, no import audit', async () => {
    const post = await poster()
    expect((await post('deals', `name,currency\n${DEAL},GBP\n`)).statusCode).toBe(200)
    for (const kind of Object.keys(HEADERS)) {
      const before = await counts()
      const query = ['commitments', 'bank', 'ledger'].includes(kind) ? `?deal=${encodeURIComponent(DEAL)}` : ''
      // what curl --data makes of a file: the line breaks are gone, only the header line is left
      for (const q of [query, `${query}${query ? '&' : '?'}clear=true`]) {
        const res = await post(kind, HEADERS[kind]!, q)
        expect(res.statusCode, `${kind} ${q}`).toBe(422)
        expect(res.json().errors, kind).toContainEqual({ where: 'file', message: 'no data rows: the list would become empty (nothing was imported)' })
      }
      expect(await counts(), kind).toEqual(before)
    }
  })

  it('TC-DIR-09 clear=yes with a header-only file empties the list (audited as a clear); clear=yes with data rows is refused', async () => {
    const post = await poster()
    const deal = `?deal=${encodeURIComponent(DEAL)}`
    const ledger = `${HEADERS.ledger}\nT-1,2026-10-20,100.00,A PAYER,REF-1,auto,001,A Payer,system,,GBP\n`
    expect((await post('ledger', ledger, deal)).statusCode).toBe(200)
    const snapBefore = await (await import('../store/directory.ts')).takeSnapshot(k.db)
    const before = await counts()
    // a clear request with data rows: nothing written
    const mixed = await post('ledger', ledger, `${deal}&clear=yes`)
    expect(mixed.statusCode).toBe(422)
    expect(mixed.json().errors).toEqual([{ where: 'file', message: 'clear=yes needs a file with the header only (it has data rows)' }])
    expect(await counts()).toEqual(before)
    // the explicit clear
    const cleared = await post('ledger', `${HEADERS.ledger}\n`, `${deal}&clear=yes`)
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ ok: true, rows: 0 })
    expect(await counts()).toEqual({ v: before.v + 1, a: before.a + 1 })
    const audit = (await k.db.query(`SELECT payload FROM audit WHERE type = 'directory.imported' ORDER BY seq DESC LIMIT 1`)).rows[0].payload
    expect(audit).toMatchObject({ kind: 'ledger', rows: 0, cleared: true })
    expect((await k.db.query('SELECT count(*)::int AS n FROM ledger_line WHERE directory_version = $1', [cleared.json().versionId])).rows[0].n).toBe(0)
    // snapshots (G3 D9 Codex round 1 F1): the one taken before the clear keeps its ledger; a new one takes the empty
    // version, which counts as no ledger (C-DRF-6 v0.7.24: «unknown», as before the mistaken import)
    const { takeSnapshot, loadSnapshot, dealKey } = await import('../store/directory.ts')
    const dk = dealKey(k.k, DEAL)
    const view = async (id: string) => loadSnapshot(k.db, k.k, id)
    expect((await view(snapBefore)).ledgerDeals).toContain(dk)
    expect((await view(snapBefore)).ledger.filter((l) => l.dealKey === dk)).toHaveLength(1)
    const snapAfter = await takeSnapshot(k.db)
    const after = await k.db.query<{ per_deal: Record<string, { ledger: string | null }> }>('SELECT per_deal FROM directory_snapshot WHERE id = $1', [snapAfter])
    expect(after.rows[0]!.per_deal[dk]!.ledger).toBe(cleared.json().versionId)
    expect((await view(snapAfter)).ledgerDeals).not.toContain(dk)
    expect((await view(snapAfter)).ledger.filter((l) => l.dealKey === dk)).toHaveLength(0)
    // an empty ledger imported before D9 (no clear marker; then accepted without clear=yes) still counts as a ledger
    // (Codex D9 round 2 F2): the deal stays in ledgerDeals, so its Cases keep «not received in full», not «unknown»
    await k.t.owner.query('UPDATE directory_version SET cleared = false WHERE id = $1', [cleared.json().versionId])
    expect((await view(snapAfter)).ledgerDeals).toContain(dk)
    await k.t.owner.query('UPDATE directory_version SET cleared = true WHERE id = $1', [cleared.json().versionId])
  })
})

describe('review API', () => {
  it('TC-REV-01 (API part) mail HTML is never sent to the page; strict CSP on every response', async () => {
    const admin = await adminSession()
    const list = await app.inject({ method: 'GET', url: '/api/cases', cookies: { doi_session: admin.session! } })
    expect(list.headers['content-security-policy']).toBe(CSP)
    const c = list.json().cases.find((x: { subject: string }) => x.subject?.startsWith('Hello'))
    const detail = await app.inject({ method: 'GET', url: `/api/cases/${c.id}`, cookies: { doi_session: admin.session! } })
    const body = detail.json()
    expect(body.text).toBe('Hi')
    expect(JSON.stringify(body)).not.toMatch(/<script|<img|<link|tracker\.example\/x|cdn\.example/)
    expect(detail.headers['content-security-policy']).toContain("default-src 'self'")
  })
})
