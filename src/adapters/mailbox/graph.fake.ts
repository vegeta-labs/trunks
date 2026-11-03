// Test double: an in-process Microsoft Graph + Entra token service, written from the public documentation. Delta pages,
// sync state that can be invalidated, folders and child folders, permission probes, the application's role
// assignments. Every request is logged. Never imported by production code (no-send check).

interface Msg {
  id: string
  folder: string
  raw: Buffer
  received: string
}

export class FakeGraph {
  readonly folders = [
    { id: 'f-inbox', displayName: 'Inbox', parent: null as string | null },
    { id: 'f-deals', displayName: 'Deals', parent: 'f-inbox' },
    { id: 'f-sent', displayName: 'Sent Items', parent: null },
  ]
  readonly messages: Msg[] = []
  readonly requests: Array<{ method: string; url: string }> = []
  readonly readable = new Set<string>() // mailboxes the application may read
  readonly existing = new Set<string>()
  roles: string[] = [] // Graph app roles granted tenant-wide (values)
  directoryRead = true // Application.Read.All granted
  assignmentsPages = 1 // role assignments split over this many pages
  assignmentsBody: string | null = null // a raw answer instead (malformed)
  pageSize = 2
  validTokens = new Set<string>() // delta tokens that are still valid
  failNextPage = 0 // next N delta pages answer a network-level failure
  host = 'graph.microsoft.com'
  odataLinks = false // links in the OData key form with literal @ (as Graph may write them)
  private seq = 0
  private stamp = 0

  constructor(users: string[]) {
    for (const u of users) {
      this.readable.add(u)
      this.existing.add(u)
    }
  }

  add(raw: Buffer, folder = 'f-inbox'): string {
    const id = `AAMk${(++this.seq).toString(16).padStart(8, '0')}`
    this.messages.push({ id, folder, raw, received: new Date(Date.parse('2026-10-29T10:15:00Z') + this.seq * 1000).toISOString() })
    this.stamp++
    return id
  }
  move(id: string, folder: string): void {
    this.messages.find((m) => m.id === id)!.folder = folder // immutable id: unchanged
    this.stamp++
  }
  invalidateDelta(): void {
    this.validTokens.clear()
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET'
    this.requests.push({ method, url })
    const u = new URL(url)
    const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
    if (u.host === 'login.microsoftonline.com') return json(200, { access_token: 'graph-token', expires_in: 3600 })
    if ((init.headers as Record<string, string>)?.authorization !== 'Bearer graph-token') return json(401, {})
    const p = decodeURIComponent(u.pathname).replace('/v1.0', '').replace(/\/(users|mailFolders)\('([^']*)'\)/g, '/$1/$2')
    if (p.startsWith('/servicePrincipals') && !this.directoryRead) return json(403, { error: { code: 'Authorization_RequestDenied' } })
    if (p === '/servicePrincipals') {
      const f = u.searchParams.get('$filter') ?? ''
      if (f.includes('00000003-0000-0000-c000-000000000000')) return json(200, { value: [{ id: 'sp-graph', appRoles: [{ id: 'r-read', value: 'Mail.Read' }, { id: 'r-send', value: 'Mail.Send' }, { id: 'r-rw', value: 'Mail.ReadWrite' }, { id: 'r-user', value: 'User.Read.All' }] }] })
      return json(200, { value: [{ id: 'sp-app' }] })
    }
    if (p === '/servicePrincipals/sp-app/appRoleAssignments') {
      const ids: Record<string, string> = { 'Mail.Read': 'r-read', 'Mail.Send': 'r-send', 'Mail.ReadWrite': 'r-rw', 'User.Read.All': 'r-user' }
      if (this.assignmentsBody !== null) return new Response(this.assignmentsBody, { status: 200 })
      const all = this.roles.map((r) => ({ appRoleId: ids[r], resourceId: 'sp-graph' }))
      const page = Number(u.searchParams.get('$skiptoken') ?? 0)
      const size = Math.ceil(all.length / this.assignmentsPages) || 1
      const items = this.assignmentsPages > 1 && page === 0 ? [] : all.slice(page === 0 ? 0 : (page - 1) * size, page === 0 ? all.length : page * size)
      const next = this.assignmentsPages > 1 && page < this.assignmentsPages ? { '@odata.nextLink': `https://${this.host}/v1.0/servicePrincipals/sp-app/appRoleAssignments?$skiptoken=${page + 1}` } : {}
      return json(200, { value: items, ...next })
    }
    const m = /^\/users\/([^/]+)(\/.*)$/.exec(p)
    if (!m) return json(404, {})
    const user = decodeURIComponent(m[1]!)
    const rest = m[2]!
    if (!this.existing.has(user)) return json(404, { error: { code: 'ErrorInvalidUser' } })
    if (!this.readable.has(user)) return json(403, { error: { code: 'ErrorAccessDenied' } })
    if (rest === '/mailFolders') return json(200, { value: this.folders.filter((f) => !f.parent) })
    if (rest === '/mailFolders/inbox') return json(200, this.folders[0])
    const child = /^\/mailFolders\/([^/]+)\/childFolders$/.exec(rest)
    if (child) return json(200, { value: this.folders.filter((f) => f.parent === decodeURIComponent(child[1]!)) })
    const delta = /^\/mailFolders\/([^/]+)\/messages\/delta$/.exec(rest)
    if (delta) {
      if (this.failNextPage > 0) {
        this.failNextPage--
        throw new TypeError('fetch failed')
      }
      const folder = decodeURIComponent(delta[1]!)
      const token = u.searchParams.get('$deltatoken')
      const skip = Number(u.searchParams.get('$skiptoken') ?? 0)
      if (token && !this.validTokens.has(token)) return json(410, { error: { code: 'SyncStateNotFound' } })
      const since = token ? Number(token.split('-')[1]) : 0
      const all = this.messages.filter((x) => x.folder === folder).filter((x) => this.seenAt(x) > since)
      const page = all.slice(skip, skip + this.pageSize)
      const base = this.odataLinks ? `https://${this.host}/v1.0/users('${user}')/mailFolders('${decodeURIComponent(delta[1]!)}')/messages/delta` : `https://${this.host}/v1.0/users/${encodeURIComponent(user)}/mailFolders/${delta[1]}/messages/delta`
      if (skip + this.pageSize < all.length) return json(200, { value: page.map((x) => ({ id: x.id })), '@odata.nextLink': `${base}?$skiptoken=${skip + this.pageSize}${token ? `&$deltatoken=${token}` : ''}` })
      const t = `t-${this.stamp}`
      this.validTokens.add(t)
      return json(200, { value: page.map((x) => ({ id: x.id })), '@odata.deltaLink': `${base}?$deltatoken=${t}` })
    }
    const msg = /^\/messages\/([^/]+)(\/\$value)?$/.exec(rest)
    if (msg) {
      const x = this.messages.find((y) => y.id === decodeURIComponent(msg[1]!))
      if (!x) return json(404, { error: { code: 'ErrorItemNotFound' } })
      return msg[2] ? new Response(new Uint8Array(x.raw), { status: 200 }) : json(200, { id: x.id, receivedDateTime: x.received })
    }
    if (rest === '/messages') return json(200, { value: [] })
    return json(400, { error: { code: 'unsupported by the fake' } })
  }

  // a message «changes» in the delta when it is added or moved; tracked by the stamp at that moment
  private readonly changes = new Map<string, number>()
  private seenAt(x: Msg): number {
    const key = `${x.id}@${x.folder}`
    if (!this.changes.has(key)) this.changes.set(key, this.stamp)
    return this.changes.get(key)!
  }

  writes(): string[] {
    return this.requests.filter((r) => r.method !== 'GET' && !r.url.includes('login.microsoftonline.com')).map((r) => `${r.method} ${r.url}`)
  }
}
