// The only way this application talks to Google or Microsoft (tech design v0.7.9 «原生 HTTP», TC-OUT-09). Every request
// is checked against a fixed allow-list of host + method + path before it is sent; anything else throws and nothing goes
// out. Links the server hands back (Graph `@odata.nextLink` / `@odata.deltaLink`, also when stored in a cursor) pass the
// same check. Redirects are never followed. The list holds read calls only, plus the few non-mail calls the read-only
// design needs (Gmail watch/stop, Pub/Sub pull/acknowledge, token endpoints).

/** host, method, path pattern (`*` = one path segment). CI compares this list with the expected one (no-send check). */
export const MAIL_HTTP_ALLOW = [
  // Gmail (gmail.readonly)
  'GET gmail.googleapis.com /gmail/v1/users/*/profile',
  'GET gmail.googleapis.com /gmail/v1/users/*/labels',
  'GET gmail.googleapis.com /gmail/v1/users/*/history',
  'GET gmail.googleapis.com /gmail/v1/users/*/messages',
  'GET gmail.googleapis.com /gmail/v1/users/*/messages/*',
  'POST gmail.googleapis.com /gmail/v1/users/*/watch',
  'POST gmail.googleapis.com /gmail/v1/users/*/stop',
  // Pub/Sub pull (the watch notifications; no inbound address)
  'POST pubsub.googleapis.com /v1/projects/*/subscriptions/*:pull',
  'POST pubsub.googleapis.com /v1/projects/*/subscriptions/*:acknowledge',
  // Google tokens
  'POST oauth2.googleapis.com /token',
  // Microsoft Graph (Application Mail.Read on the designated mailboxes)
  'GET graph.microsoft.com /v1.0/users/*/mailFolders',
  'GET graph.microsoft.com /v1.0/users/*/mailFolders/*',
  'GET graph.microsoft.com /v1.0/users/*/mailFolders/*/childFolders',
  'GET graph.microsoft.com /v1.0/users/*/mailFolders/*/messages/delta',
  'GET graph.microsoft.com /v1.0/users/*/messages',
  'GET graph.microsoft.com /v1.0/users/*/messages/*',
  'GET graph.microsoft.com /v1.0/users/*/messages/*/$value',
  // C-ING-4 ② (only when Application.Read.All is granted)
  'GET graph.microsoft.com /v1.0/servicePrincipals',
  'GET graph.microsoft.com /v1.0/servicePrincipals/*/appRoleAssignments',
  // Microsoft tokens (client credentials)
  'POST login.microsoftonline.com /*/oauth2/v2.0/token',
] as const

const RULES = MAIL_HTTP_ALLOW.map((r) => {
  const [method, host, path] = r.split(' ') as [string, string, string]
  const re = new RegExp(`^${path.split('/').map((seg) => seg.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')).join('/')}$`)
  return { method, host, re }
})

export class MailHttpRefused extends Error {
  override name = 'MailHttpRefused'
}

/** Whether a request may be sent; never throws. */
export function allowed(method: string, url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  // as sent: an encoded «/» inside an id stays inside its segment; the OData key form users('…') / mailFolders('…') that
  // Graph may use in its own links counts as the plain segment (regression review R1)
  const path = u.pathname.replace(/\/(users|mailFolders)\('([^'/]*)'\)/g, '/$1/$2').replace(/\/(users|mailFolders)\(%27([^/]*?)%27\)/g, '/$1/$2')
  return RULES.some((r) => r.method === method && r.host === u.hostname && r.re.test(path))
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** fetch through the allow-list. Tests pass a fetch that answers in-process (the fake Gmail / Graph services). */
export class MailHttp {
  private readonly f: FetchLike
  constructor(f: FetchLike = (url, init) => fetch(url, init)) {
    this.f = f
  }
  async request(method: 'GET' | 'POST', url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    if (!allowed(method, url)) throw new MailHttpRefused(`refused: ${method} ${safeUrl(url)} is not on the read-only allow-list`)
    return this.f(url, { method, headers: init.headers, body: init.body, redirect: 'error', signal: AbortSignal.timeout(60_000) })
  }
  async json<T>(method: 'GET' | 'POST', url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: T | null }> {
    const r = await this.request(method, url, init)
    const text = await r.text()
    let body: T | null = null
    try {
      body = text ? (JSON.parse(text) as T) : null
    } catch {
      body = null
    }
    return { status: r.status, body }
  }
}

/** Host and path only: a query can carry tokens or addresses (logs must not). */
export const safeUrl = (url: string) => {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return '<invalid url>'
  }
}
