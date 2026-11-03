// HTTP server (tech design §5, T9): API, login, CSRF, security headers, static review UI.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../config/load.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db } from '../store/db.ts'
import { mailboxWarnings } from '../pipeline/mailbox-runtime.ts'
import type { FileStore } from '../store/files.ts'
import { importDirectory, type DirectoryKind } from '../store/directory.ts'
import { modelPolicy } from '../lib/model-policy.ts'
import { appendAudit } from '../store/audit.ts'
import {
  changeOwnPassword, createSession, createUser, csrfOk, endSession, resetPassword, ROLE_RANK, sessionUser, setRole, userByOidcSub, verifyLogin,
  type Role, type User,
} from './auth.ts'
import { caseDetail, listCases } from './cases.ts'
import type { Oidc } from './oidc.ts'

import { registerCaseActions } from './actions.ts'
import { actionsCsv, casesCsv } from './exports.ts'
import type { Queue } from '../pipeline/queue.ts'

export interface ServerDeps {
  db: Db
  k: Keyring
  files: FileStore
  config: Config
  oidc?: Oidc
  webRoot?: string // built review UI
  logger?: boolean | object
  secureCookies?: boolean // false only for local development over plain http
  trustProxy?: boolean | string // the reverse proxy's address, never `true` in production
  queue?: Queue // a person's changes start a new generation (E3 actions); without it the review is read-only
  // DEMO=1 (PRD R-DEMO-01): the published accounts, and case → evaluation sample for the static snapshot (site T2)
  demo?: { accounts: ReadonlyArray<{ username: string; password: string; role: string }>; samples: () => Promise<Record<string, string>> }
}

// Routes reachable without a session. Every other route needs one (default deny on the matched route, not the raw URL:
// the router decodes `%61pi` to `api`, a string test on `req.url` does not).
const PUBLIC_ROUTES = new Set(['/api/login', '/api/demo', '/api/signin-options', '/auth/oidc/start', '/auth/oidc/callback', '/*'])
// /api/csrf too: a new tab of a user who must change the password first needs the token for that (plan review R12)
const MUST_CHANGE_ALLOWED = new Set(['/api/session', '/api/password', '/api/logout', '/api/csrf'])

const SESSION = 'doi_session'
const OIDC_COOKIE = 'doi_oidc'
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

declare module 'fastify' {
  interface FastifyRequest {
    user: (User & { csrf: string; sessionHmac: string }) | null
  }
}

const cookieOpts = (secure: boolean) => ({ httpOnly: true, secure, sameSite: 'strict' as const, path: '/' })

export async function buildServer(d: ServerDeps): Promise<FastifyInstance> {
  // R-PRV-01: model provider warnings stay at the top of the review UI for as long as the setting stands
  const warnings = [
    ...(d.demo ? [DEMO_NOTICE] : []),
    ...(d.config.model ? modelPolicy(d.config.model).warnings : []),
  ]
  // the logger never sees bodies, cookies or query strings (no credentials or names in logs, TC-PRV-07)
  const logger = d.logger && typeof d.logger === 'object'
    ? { ...d.logger, serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, path: r.url.split('?')[0] }), res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }) } }
    : (d.logger ?? false)
  const app = Fastify({ logger, bodyLimit: 10 * 1024 * 1024, trustProxy: d.trustProxy ?? false })
  await app.register(cookie)
  app.decorateRequest('user', null)
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => done(null, body))

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('content-security-policy', CSP)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('x-frame-options', 'DENY')
    reply.header('cache-control', 'no-store')
    return payload
  })

  app.addHook('preHandler', async (req, reply) => {
    req.user = await sessionUser(d.db, d.k, req.cookies[SESSION])
    const route = req.routeOptions.url ?? ''
    if (PUBLIC_ROUTES.has(route)) return
    if (!req.user) return reply.code(401).send({ error: 'not signed in' })
    if (req.method !== 'GET' && req.method !== 'HEAD' && !csrfOk(req.user.csrf, req.headers['x-csrf-token'] as string | undefined)) {
      return reply.code(403).send({ error: 'missing or wrong CSRF token' })
    }
    // a user who must change the password can only do that (and sign out)
    if (req.user.mustChangePassword && !MUST_CHANGE_ALLOWED.has(route)) return reply.code(403).send({ error: 'change your password first' })
  })

  const need = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || ROLE_RANK[req.user.role] < ROLE_RANK[role]) return reply.code(403).send({ error: `needs the ${role} role` })
  }
  const secure = (_req: FastifyRequest) => d.secureCookies ?? true

  // ---------- session ----------
  app.post<{ Body: { username?: string; password?: string } }>('/api/login', async (req, reply) => {
    const { username, password } = req.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string') return reply.code(400).send({ error: 'username and password required' })
    const u = await verifyLogin(d.db, d.k, username, password)
    if (!u) {
      await tx(d.db, (c) => appendAudit(c, d.k, [{ actor: 'system', type: 'user.login_failed', payload: {} }]))
      return reply.code(401).send({ error: 'wrong username or password' })
    }
    const s = await createSession(d.db, d.k, u.id, u.credentialVersion, d.config.auth.session_hours)
    await tx(d.db, (c) => appendAudit(c, d.k, [{ actor: u.id, type: 'user.login', payload: { via: 'local' } }]))
    reply.setCookie(SESSION, s.session, { ...cookieOpts(secure(req)), maxAge: d.config.auth.session_hours * 3600 })
    return { csrf: s.csrf, user: { id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword } }
  })
  app.post('/api/logout', async (req, reply) => {
    await endSession(d.db, req.user!.sessionHmac)
    reply.clearCookie(SESSION, { path: '/' })
    return { ok: true }
  })
  app.get('/api/session', async (req) => {
    const u = req.user!
    return { user: { id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword }, warnings: [...warnings, ...(await operationalWarnings(d.db, { demo: !!d.demo }))] }
  })
  // the demo accounts for the sign-in page; 404 outside the demo (tech design v0.7.11)
  app.get('/api/demo', async (_req, reply) => (d.demo ? { accounts: d.demo.accounts, samples: await d.demo.samples() } : reply.code(404).send({ error: 'not the demo' })))
  // what the sign-in page offers: the organisation sign-in only when OIDC is configured (E5 acceptance G4)
  app.get('/api/signin-options', async () => ({ oidc: !!d.oidc }))
  app.post<{ Body: { current?: string; next?: string } }>('/api/password', async (req, reply) => {
    const { current, next } = req.body ?? {}
    if (typeof current !== 'string' || typeof next !== 'string') return reply.code(400).send({ error: 'current and next required' })
    const ok = await changeOwnPassword(d.db, d.k, req.user!.id, current, next, req.user!.sessionHmac)
    return ok ? { ok: true } : reply.code(400).send({ error: 'wrong current password, or the new one is too short (12+) or unchanged' })
  })

  // ---------- OIDC ----------
  app.get('/auth/oidc/start', async (req, reply) => {
    if (!d.oidc) return reply.code(404).send({ error: 'OIDC not configured' })
    const s = await d.oidc.start()
    // Lax: the identity provider redirects back with a top-level GET from another site
    reply.setCookie(OIDC_COOKIE, s.cookie, { httpOnly: true, secure: secure(req), sameSite: 'lax', path: '/auth/oidc', maxAge: 600 })
    return reply.redirect(s.url)
  })
  app.get('/auth/oidc/callback', async (req, reply) => {
    if (!d.oidc) return reply.code(404).send({ error: 'OIDC not configured' })
    const url = new URL(req.url, d.config.auth.oidc!.redirect_uri)
    const r = await d.oidc.finish(url, req.cookies[OIDC_COOKIE]).catch(() => null)
    reply.clearCookie(OIDC_COOKIE, { path: '/auth/oidc' })
    if (!r) return reply.code(403).send({ error: 'sign-in refused' })
    let u = await userByOidcSub(d.db, d.k, r.sub)
    if (!u) {
      const id = await tx(d.db, (c) => createUser(c, d.k, { username: r.name, role: r.role, password: null, by: null, oidcSub: r.sub, mustChange: false }))
      u = { id, username: r.name, role: r.role, mustChangePassword: false, credentialVersion: 1 }
    } else if (u.role !== r.role) {
      await setRole(d.db, d.k, u.id, r.role, u.id) // the identity provider decides; recorded as the user's own change
    }
    const s = await createSession(d.db, d.k, u.id, u.credentialVersion, d.config.auth.session_hours)
    await tx(d.db, (c) => appendAudit(c, d.k, [{ actor: u.id, type: 'user.login', payload: { via: 'oidc' } }]))
    reply.setCookie(SESSION, s.session, { ...cookieOpts(secure(req)), maxAge: d.config.auth.session_hours * 3600 })
    // the page fetches the CSRF token from GET /api/csrf (same-origin only)
    return reply.redirect('/')
  })
  // any tab of a signed-in browser gets the session's token again (M-05 F4): readable only by same-origin pages (no
  // CORS), and the session cookie is SameSite=Strict
  app.get('/api/csrf', async (req) => ({ csrf: req.user!.csrf }))

  // ---------- cases (read-only in E1) ----------
  app.get<{ Querystring: { status?: string; queue?: string; risk?: string; limit?: string; offset?: string } }>('/api/cases', async (req) => {
    const q = req.query
    return { cases: await listCases(d.db, d.k, d.config, { status: q.status, queue: q.queue, risk: q.risk, limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined }) }
  })
  app.get<{ Params: { id: string } }>('/api/cases/:id', async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return reply.code(404).send({ error: 'not found' })
    const c = await caseDetail(d, req.params.id)
    return c ?? reply.code(404).send({ error: 'not found' })
  })

  if (d.queue) registerCaseActions(app, { ...d, queue: d.queue }, need)
  app.get('/api/export/actions.csv', async (_req, reply) => reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="actions.csv"').send(await actionsCsv(d)))
  app.get('/api/export/cases.csv', async (_req, reply) => reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="cases.csv"').send(await casesCsv(d)))

  // ---------- admin ----------
  app.post<{ Params: { kind: string }; Querystring: { deal?: string }; Body: string }>('/api/directory/:kind', { preHandler: need('admin') }, async (req, reply) => {
    const kind = req.params.kind as DirectoryKind
    if (!['deals', 'contacts', 'commitments', 'bank', 'ledger'].includes(kind)) return reply.code(404).send({ error: 'unknown directory kind' })
    if (typeof req.body !== 'string') return reply.code(400).send({ error: 'send the CSV as text/csv' })
    const r = await importDirectory(d.db, d.k, { kind, csv: req.body, userId: req.user!.id, deal: req.query.deal, currencies: d.config.deployment.currencies })
    return r.ok ? r : reply.code(422).send(r)
  })
  app.post<{ Body: { username?: string; role?: Role; password?: string } }>('/api/users', { preHandler: need('admin') }, async (req, reply) => {
    const { username, role, password } = req.body ?? {}
    if (typeof username !== 'string' || !username.trim() || !role || !(role in ROLE_RANK) || typeof password !== 'string') return reply.code(400).send({ error: 'username, role and password required' })
    try {
      const id = await tx(d.db, (c) => createUser(c, d.k, { username, role, password, by: req.user!.id }))
      return { id }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message.includes('unique') ? 'username taken' : (e as Error).message })
    }
  })
  app.put<{ Params: { id: string }; Body: { role?: Role } }>('/api/users/:id/role', { preHandler: need('admin') }, async (req, reply) => {
    const role = req.body?.role
    if (!role || !(role in ROLE_RANK)) return reply.code(400).send({ error: 'role required' })
    await setRole(d.db, d.k, req.params.id, role, req.user!.id)
    return { ok: true }
  })
  app.post<{ Params: { id: string }; Body: { password?: string } }>('/api/users/:id/reset', { preHandler: need('admin') }, async (req, reply) => {
    if (typeof req.body?.password !== 'string') return reply.code(400).send({ error: 'password required' })
    try {
      await resetPassword(d.db, d.k, req.params.id, req.body.password, req.user!.id)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    return { ok: true }
  })

  // ---------- static review UI ----------
  if (d.webRoot) {
    const root = resolve(d.webRoot)
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
    app.get('/*', async (req, reply) => {
      const path = decodeURIComponent(req.url.split('?')[0]!)
      const file = normalize(join(root, path === '/' ? 'index.html' : path))
      const rel = relative(root, file)
      const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      const target = inside && extname(file) ? file : join(root, 'index.html')
      try {
        const body = await readFile(target)
        return reply.type(types[extname(target)] ?? 'application/octet-stream').send(body)
      } catch {
        return reply.type(types['.html']!).send(await readFile(join(root, 'index.html')))
      }
    })
  }
  app.setErrorHandler((err, _req, reply) => {
    const ref = randomUUID()
    app.log.error({ ref, code: (err as { code?: string }).code }, 'request failed')
    return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: 'request failed', ref })
  })
  return app
}

/**
 * Warnings that hold while a condition lasts (shown at the top of the review UI): failed KYC transfers (R-PRV-03),
 * file deletions that keep failing (tech design §4.1), mailboxes whose subscription or token needs attention (R-ING-02).
 */
/** Shown at the top of every demo page (PRD R-DEMO-01 v0.7.22; D11, V3b). */
export const DEMO_NOTICE = 'Demo: fictional data only, received at fixed past times (deadlines may show as overdue). The directory is the evaluation set\'s fictional one, not the Toolkit sample. KYC attachments are transferred to a folder but, unlike a real deployment, the stored email is not replaced.'

export async function operationalWarnings(db: Db, opts: { demo?: boolean } = {}): Promise<string[]> {
  const r = (await db.query<{ kyc: number; files: number; stuck: number }>(
    `SELECT (SELECT count(*)::int FROM kyc_delivery WHERE state = 'failed') AS kyc,
            (SELECT count(*)::int FROM file_deletion_job WHERE attempts > 0) AS files,
            (SELECT count(DISTINCT d.message_id)::int FROM kyc_delivery d
              WHERE NOT EXISTS (SELECT 1 FROM kyc_delivery x WHERE x.message_id = d.message_id AND x.state NOT IN ('delivered', 'discarded'))
                AND NOT EXISTS (SELECT 1 FROM kyc_replacement r WHERE r.message_id = d.message_id AND r.step = 5)
                AND (SELECT coalesce(max(delivered_at), max(created_at)) FROM kyc_delivery y WHERE y.message_id = d.message_id) < now() - interval '1 hour') AS stuck`,
  )).rows[0]!
  const out: string[] = []
  if (r.kyc) out.push(`${r.kyc} KYC attachment transfer${r.kyc > 1 ? 's have' : ' has'} failed; the originals are kept until the transfer succeeds.`)
  // the demo never replaces (PRD C-PRV-2's demo exception): not a fault there
  if (r.stuck && !opts.demo) out.push(`${r.stuck} message${r.stuck > 1 ? 's' : ''} with transferred KYC attachments could not be replaced yet; the originals are still stored.`)
  if (r.files) out.push(`${r.files} file deletion${r.files > 1 ? 's are' : ' is'} waiting to be retried.`)
  return [...out, ...(await mailboxWarnings(db))]
}
