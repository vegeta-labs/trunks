// Microsoft 365 adapter (PRD R-ING-01/02/07, C-ING-4/5/6, decision 5 and 6; tech design §3.1, v0.7.9). Client
// credentials (certificate or secret); Application Mail.Read on the designated mailboxes only; delta polling per
// configured folder (no subscriptions in v1). Every request through MailHttp's allow-list, links from the server too.
//
// One adapter per (mailbox, folder): catch-up keeps one cursor per folder (folder_key = the folder id). The cursor after
// a message is JSON {c: <deltaLink or null>, id}; only the last message of a run carries the new deltaLink, so a crash
// part way through re-reads from the old one (C-ING-1 de-duplicates).
import { createSign, randomUUID } from 'node:crypto'
import type { MailboxAdapter, MessageRef } from './types.ts'
import { MailHttp, MailHttpRefused, safeUrl } from './http.ts'
import { Temporary, TokenRevoked } from './gmail.ts'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000' // Microsoft Graph's own service principal

export interface M365Credentials {
  tenantId: string
  clientId: string
  secret?: string
  certificate?: { privateKeyPem: string; thumbprintHex: string }
}

function check(status: number, what: string): void {
  if (status === 429 || status >= 500) throw new Temporary(`${what}: ${status}`)
  if (status === 401) throw new TokenRevoked(`${what}: ${status}`)
  if (status < 200 || status > 299) throw new Error(`${what}: ${status}`)
}

/** Application tokens (client credentials); kept in memory only. */
export class GraphTokens {
  private token: { value: string; until: number } | null = null
  private readonly http: MailHttp
  private readonly c: M365Credentials
  constructor(http: MailHttp, c: M365Credentials) {
    this.http = http
    this.c = c
  }
  async get(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value
    const url = `https://login.microsoftonline.com/${this.c.tenantId}/oauth2/v2.0/token`
    const p: Record<string, string> = { grant_type: 'client_credentials', client_id: this.c.clientId, scope: 'https://graph.microsoft.com/.default' }
    if (this.c.certificate) {
      const now = Math.floor(Date.now() / 1000)
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
      const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', x5t: Buffer.from(this.c.certificate.thumbprintHex, 'hex').toString('base64url') })}.${b64({ aud: url, iss: this.c.clientId, sub: this.c.clientId, jti: randomUUID(), nbf: now, exp: now + 600 })}`
      p.client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
      p.client_assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(this.c.certificate.privateKeyPem).toString('base64url')}`
    } else p.client_secret = this.c.secret ?? ''
    let r: { status: number; body: { access_token?: string; expires_in?: number } | null }
    try {
      r = await this.http.json('POST', url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p).toString() })
    } catch (e) {
      throw new Temporary(`token: ${(e as Error).name}`)
    }
    if (r.status === 400 || r.status === 401) throw new TokenRevoked('the application credentials were refused')
    check(r.status, 'token')
    if (!r.body?.access_token) throw new Temporary('token: none')
    this.token = { value: r.body.access_token, until: Date.now() + Math.max(60, (r.body.expires_in ?? 3600) - 120) * 1000 }
    return this.token.value
  }
}

/**
 * Codex E4 F1: the allow-list is shared by all providers, so a Graph token must additionally only ever go to Graph — and
 * a link the server hands back (nextLink, deltaLink, also from a stored cursor) only to the path it belongs to.
 */
function canonicalPath(p: string): string {
  let s: string
  try {
    s = decodeURIComponent(p)
  } catch {
    return '\u0000' // undecodable: never a prefix of anything we sent
  }
  return s.replace(/\/(users|mailfolders)\('([^']*)'\)/gi, '/$1/$2').toLowerCase()
}

export function graphOnly(url: string, prefix = `${GRAPH}/`): void {
  let ok = false
  try {
    const u = new URL(url)
    // compared in a canonical form (regression review R1): Graph may write its own links with literal `=` / `@`, in
    // another case, or with the OData key form users('…') / mailFolders('…')
    ok = u.origin === 'https://graph.microsoft.com' && canonicalPath(u.pathname).startsWith(canonicalPath(new URL(prefix).pathname))
  } catch {
    ok = false
  }
  if (!ok) throw new MailHttpRefused(`refused: a Graph request to ${safeUrl(url)} is outside ${safeUrl(prefix)}`)
}

async function graphGet<T>(http: MailHttp, tokens: GraphTokens, url: string, what: string, prefix?: string): Promise<{ status: number; body: T | null }> {
  graphOnly(url, prefix)
  try {
    // immutable ids: a message keeps its id when it is moved between folders
    return await http.json<T>('GET', url, { headers: { authorization: `Bearer ${await tokens.get()}`, prefer: 'IdType="ImmutableId"' } })
  } catch (e) {
    if (e instanceof Temporary || e instanceof TokenRevoked || (e as Error).name === 'MailHttpRefused') throw e
    throw new Temporary(`${what}: ${(e as Error).name}`)
  }
}

const enc = encodeURIComponent

/** Every page of a folder list, through the Graph guard (Codex E4 round 2 F11); anything malformed is temporary. */
async function allPages(http: MailHttp, tokens: GraphTokens, first: string, own: string, what: string): Promise<Array<{ id: string; displayName: string }>> {
  const out: Array<{ id: string; displayName: string }> = []
  let url: string | undefined = first
  for (let page = 0; url && page < 1000; page++) {
    const r: { status: number; body: unknown } = await graphGet<unknown>(http, tokens, url, what, own)
    check(r.status, what)
    const b = r.body as { value?: unknown; '@odata.nextLink'?: string } | null
    if (!b || typeof b !== 'object' || Array.isArray(b) || !Array.isArray(b.value)) throw new Temporary(`${what}: not a list`)
    for (const f of b.value as Array<{ id?: unknown; displayName?: unknown }>) if (typeof f?.id === 'string' && typeof f.displayName === 'string') out.push({ id: f.id, displayName: f.displayName })
    url = b['@odata.nextLink']
  }
  return out
}

/** C-ING-6: «Inbox», «Inbox/Deals», … → folder ids; a name that does not exist refuses the start. */
export async function resolveFolders(http: MailHttp, tokens: GraphTokens, user: string, names: string[]): Promise<Array<{ name: string; id: string }>> {
  const out: Array<{ name: string; id: string }> = []
  for (const name of names) {
    const parts = name.split('/')
    const own = `${GRAPH}/users/${enc(user)}/mailFolders`
    let cur = (await allPages(http, tokens, `${own}?$top=200`, own, 'folders')).find((f) => f.displayName.toLowerCase() === parts[0]!.toLowerCase())
    if (!cur && parts[0]!.toLowerCase() === 'inbox') {
      const wk = await graphGet<{ id: string; displayName: string }>(http, tokens, `${GRAPH}/users/${enc(user)}/mailFolders/inbox`, 'inbox')
      check(wk.status, 'inbox')
      cur = wk.body ?? undefined
    }
    for (const p of parts.slice(1)) {
      if (!cur) break
      const base = `${GRAPH}/users/${enc(user)}/mailFolders/${enc(cur.id)}/childFolders`
      cur = (await allPages(http, tokens, `${base}?$top=200`, base, 'child folders')).find((f) => f.displayName.toLowerCase() === p.toLowerCase())
    }
    if (!cur) throw new Error(`Microsoft 365 mailbox ${user}: folder «${name}» not found`)
    out.push({ name, id: cur.id })
  }
  return out
}

export interface GraphFolderSettings {
  id: string // the configured mailbox id
  name: string
  user: string
  folderId: string
  stripsExternalAuthResults: boolean
}

export class GraphAdapter implements MailboxAdapter {
  readonly id: string
  readonly name: string
  readonly capabilities: { push: boolean; trustedAuthResults: boolean }
  private readonly s: GraphFolderSettings
  private readonly http: MailHttp
  private readonly tokens: GraphTokens
  constructor(s: GraphFolderSettings, http: MailHttp, tokens: GraphTokens) {
    this.s = s
    this.id = s.id
    this.name = s.name
    this.http = http
    this.tokens = tokens
    this.capabilities = { push: false, trustedAuthResults: s.stripsExternalAuthResults }
  }

  async start(): Promise<void> {
    // v1: no subscriptions (decision 6); the catch-up interval polls the delta
  }

  async catchUp(cursor: string | null): Promise<{ refs: MessageRef[]; cursor: string; resync?: boolean }> {
    let saved: string | null = null
    try {
      saved = cursor ? ((JSON.parse(cursor) as { c: string | null }).c ?? null) : null
    } catch {
      saved = null
    }
    const own = `${GRAPH}/users/${enc(this.s.user)}/mailFolders/${enc(this.s.folderId)}/messages/delta`
    const first = `${own}?$select=receivedDateTime`
    let resync = false
    let url = saved ?? first
    // a stored link that is no longer acceptable is not a reason to stop for good: list the folder again (R1)
    if (saved) {
      try {
        graphOnly(saved, own)
      } catch {
        url = first
        resync = true
      }
    }
    const ids: string[] = []
    let delta: string | null = null
    for (let page = 0; page < 100_000; page++) {
      // every page, also a stored deltaLink, only to this mailbox's own delta path
      const r = await graphGet<{ value?: Array<{ id: string; '@removed'?: unknown }>; '@odata.nextLink'?: string; '@odata.deltaLink'?: string; error?: { code?: string } }>(this.http, this.tokens, url, 'delta', own)
      if ((r.status === 410 || r.body?.error?.code === 'SyncStateNotFound' || r.body?.error?.code === 'resyncRequired') && url !== first && !resync) {
        // the sync state is no longer valid (C-ING-5): list the folder again; C-ING-1 keeps it free of duplicates
        resync = true
        url = first
        ids.length = 0
        continue
      }
      check(r.status, 'delta')
      // a page that is not a delta page, or an entry without an id, is temporary: the cursor stays (round 4 F5)
      if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body) || !Array.isArray(r.body.value)) throw new Temporary('delta: not a delta page')
      if (r.body.value.some((m) => !m || typeof m.id !== 'string' || m.id === '')) throw new Temporary('delta: an entry without an id')
      for (const m of r.body.value) if (!m['@removed'] && !ids.includes(m.id)) ids.push(m.id)
      if (r.body?.['@odata.nextLink']) url = r.body['@odata.nextLink'] // checked against the allow-list when sent
      else {
        delta = r.body?.['@odata.deltaLink'] ?? null
        break
      }
    }
    if (!delta) throw new Temporary('delta: no deltaLink at the end')
    const keep = resync ? null : saved
    const refs = ids.map((id, i) => ({ mailboxId: this.id, key: JSON.stringify({ c: i === ids.length - 1 ? delta : keep, id }) }))
    return { refs, cursor: refs.length ? refs.at(-1)!.key : JSON.stringify({ c: delta, id: null }), ...(resync ? { resync: true } : {}) }
  }

  async fetchRaw(ref: MessageRef): Promise<{ raw: Buffer; serverReceivedAt: string } | { gone: true }> {
    let id: string | null = null
    try {
      id = (JSON.parse(ref.key) as { id: string | null }).id
    } catch {
      return { gone: true }
    }
    if (!id) return { gone: true }
    const base = `${GRAPH}/users/${enc(this.s.user)}/messages/${enc(id)}`
    const meta = await graphGet<{ receivedDateTime?: string }>(this.http, this.tokens, `${base}?$select=receivedDateTime`, 'message')
    if (meta.status === 404) return { gone: true } // C-ING-5
    check(meta.status, 'message')
    let r: Response
    try {
      r = await this.http.request('GET', `${base}/$value`, { headers: { authorization: `Bearer ${await this.tokens.get()}`, prefer: 'IdType="ImmutableId"' } })
    } catch (e) {
      if ((e as Error).name === 'MailHttpRefused') throw e
      throw new Temporary('message content')
    }
    if (r.status === 404) return { gone: true }
    check(r.status, 'message content')
    if (!meta.body?.receivedDateTime) throw new Temporary('message: no receivedDateTime')
    return { raw: Buffer.from(await r.arrayBuffer()), serverReceivedAt: new Date(meta.body.receivedDateTime).toISOString() } // C-SIG-2
  }

  async renew(): Promise<void> {
    // no subscription in v1 (decision 6): nothing to renew, no request
  }
}

/**
 * C-ING-4 at every start. ① a permission review on file, at most 180 days old; ② when it can be read, no Mail.* app
 * role of Microsoft Graph granted to this application (tenant-wide); ③ every designated mailbox readable; ④ the negative
 * probe mailbox answers «no permission». Anything uncertain refuses.
 */
export async function m365PermissionProblems(
  http: MailHttp,
  tokens: GraphTokens,
  c: { clientId: string; permissionReview?: { date: string; reviewer: string }; negativeProbe: string; mailboxes: string[] },
  now = new Date(),
): Promise<string[]> {
  const out: string[] = []
  const review = c.permissionReview
  if (!review) out.push('C-ING-4 ①: m365.permission_review {date, reviewer} is missing')
  else if (now.getTime() - Date.parse(`${review.date}T00:00:00Z`) > 180 * 86_400_000 || Number.isNaN(Date.parse(review.date))) out.push(`C-ING-4 ①: the permission review of ${review.date} is older than 180 days`)
  const probe = async (user: string) => {
    try {
      const r = await graphGet<{ value?: unknown; error?: { code?: string } }>(http, tokens, `${GRAPH}/users/${enc(user)}/messages?$top=1&$select=id`, 'probe')
      // a «read» counts only as a real message list (Codex E4 round 2 F1); anything else is not a clear answer
      if (r.status === 200 && !(r.body && typeof r.body === 'object' && Array.isArray(r.body.value))) return { status: -1, body: { error: { code: 'not_a_list' } } }
      return r
    } catch (e) {
      return { status: -1, body: { error: { code: (e as Error).name } } }
    }
  }
  // ② automatically whenever Application.Read.All is granted (PRD C-ING-4 ②; Codex E4 F3): a clear «no directory
  // permission» (403) leaves ① to the review record; any other uncertain or malformed answer refuses (Codex E4 F2)
  try {
    const list = <T,>(b: unknown): T[] | null => (b && typeof b === 'object' && Array.isArray((b as { value?: unknown }).value) ? ((b as { value: T[] }).value) : null)
    const me = await graphGet<unknown>(http, tokens, `${GRAPH}/servicePrincipals?$filter=${enc(`appId eq '${c.clientId}'`)}`, 'service principal', `${GRAPH}/servicePrincipals`)
    const denied = me.status === 403 && (me.body as { error?: { code?: string } } | null)?.error?.code === 'Authorization_RequestDenied'
    if (!denied) {
      const graph = await graphGet<unknown>(http, tokens, `${GRAPH}/servicePrincipals?$filter=${enc(`appId eq '${GRAPH_APP_ID}'`)}`, 'graph principal', `${GRAPH}/servicePrincipals`)
      const sp = me.status === 200 ? list<{ id: string }>(me.body)?.[0] : undefined
      const g = graph.status === 200 ? list<{ id: string; appRoles?: unknown }>(graph.body)?.[0] : undefined
      if (!sp?.id || !g?.id || !Array.isArray(g.appRoles)) out.push('C-ING-4 ②: the application\'s permissions could not be read completely')
      else {
        const roles = new Map((g.appRoles as Array<{ id: string; value: string }>).map((r) => [r.id, r.value]))
        const assigned: Array<{ appRoleId: string; resourceId: string }> = []
        const own = `${GRAPH}/servicePrincipals/${enc(sp.id)}/appRoleAssignments`
        let url: string | undefined = own
        for (let page = 0; url && page < 1000; page++) {
          const a: { status: number; body: unknown } = await graphGet<unknown>(http, tokens, url, 'role assignments', own) // every page, only this path
          const items = a.status === 200 ? list<{ appRoleId: string; resourceId: string }>(a.body) : null
          if (!items) throw new Error('role assignments: not a complete answer')
          assigned.push(...items)
          url = (a.body as { '@odata.nextLink'?: string })['@odata.nextLink']
        }
        if (url) throw new Error('role assignments: too many pages')
        // every record must be complete: a record without its resource or role is not evidence of anything (F1)
        if (assigned.some((x) => typeof x?.appRoleId !== 'string' || typeof x?.resourceId !== 'string')) throw new Error('role assignments: incomplete records')
        const mail = assigned.filter((x) => x.resourceId === g.id).map((x) => roles.get(x.appRoleId) ?? '?').filter((v) => v.startsWith('Mail.') || v === '?')
        if (mail.length) out.push(`C-ING-4 ②: tenant-wide Graph permissions granted to this application: ${mail.join(', ')} (only Exchange RBAC for Applications Mail.Read is allowed)`)
      }
    }
  } catch (e) {
    out.push(`C-ING-4 ②: the application's permissions could not be read (${(e as Error).name})`)
  }
  for (const m of c.mailboxes) {
    const r = await probe(m)
    if (r.status !== 200) out.push(`C-ING-4 ③: designated mailbox ${m} is not readable (${r.status === -1 ? 'no answer' : r.status})`)
  }
  const n = await probe(c.negativeProbe)
  const code = n.body?.error?.code ?? ''
  if (n.status === 200) out.push(`C-ING-4 ④: the negative probe mailbox ${c.negativeProbe} is readable: the permission is not limited to the designated mailboxes`)
  else if (!(n.status === 403 && /AccessDenied/i.test(code))) out.push(`C-ING-4 ④: the negative probe gave no clear «no permission» (${n.status === -1 ? 'no answer' : `${n.status} ${code}`})`)
  return out
}
