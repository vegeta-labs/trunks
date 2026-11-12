// Test double: an in-process Gmail + Pub/Sub + Google token service (test plan §1 «本地假 Gmail 服务»), written from the
// public API documentation. It answers MailHttp's fetch; every request is logged so tests can assert nothing was
// written. Never imported by production code (no-send check).

export interface FakeGmailMessage {
  id: string
  raw: Buffer
  internalDate: number
  labels: string[]
}

export class FakeGmail {
  readonly address: string
  readonly messages = new Map<string, FakeGmailMessage>()
  readonly history: Array<{ id: string; messagesAdded?: Array<{ message: { id: string; labelIds: string[] } }>; labelsAdded?: Array<{ message: { id: string; labelIds: string[] }; labelIds: string[] }> }> = []
  readonly labels = [
    { id: 'INBOX', name: 'INBOX' }, { id: 'SENT', name: 'SENT' }, { id: 'DRAFT', name: 'DRAFT' }, { id: 'SPAM', name: 'SPAM' }, { id: 'TRASH', name: 'TRASH' },
    { id: 'Label_7', name: 'Deals' },
  ]
  readonly requests: Array<{ method: string; url: string; body?: string }> = []
  readonly pubsub: Array<{ ackId: string }> = []
  readonly watches: string[] = []
  historyId = 1000
  oldestHistory = 0 // history before this answers 404
  refreshTokens = new Map<string, string>() // refresh token → account
  revoked = new Set<string>()
  scope = 'https://www.googleapis.com/auth/gmail.readonly'
  failMessageGets = 0 // next N message fetches answer 503
  failWatch = false
  sparseHistory = false // history entries carry only the message id (as the API may)
  consentAccount = '' // the account that consents in the browser (trunks gmail-auth)
  private seq = 0
  private tokens = new Map<string, string>() // access token → account

  constructor(address: string) {
    this.address = address
    this.refreshTokens.set('refresh-ok', address)
    this.consentAccount = address
  }

  add(raw: Buffer, labels: string[] = ['INBOX'], at = Date.parse('2026-10-29T10:15:00Z')): string {
    const id = `m${(++this.seq).toString(16).padStart(6, '0')}`
    this.messages.set(id, { id, raw, internalDate: at, labels })
    this.history.push({ id: String(++this.historyId), messagesAdded: [{ message: { id, labelIds: labels } }] })
    this.pubsub.push({ ackId: `ack-${this.historyId}` })
    return id
  }

  relabel(id: string, add: string[], remove: string[] = []): void {
    const m = this.messages.get(id)!
    m.labels = [...m.labels.filter((l) => !remove.includes(l)), ...add]
    this.history.push({ id: String(++this.historyId), labelsAdded: [{ message: { id, labelIds: m.labels }, labelIds: add }] })
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? init.body : undefined
    this.requests.push({ method, url, body })
    const u = new URL(url)
    const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
    const auth = (init.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /, '')
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') {
      this.revoked.add(new URLSearchParams(body).get('token') ?? '')
      return json(200, {})
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const p = new URLSearchParams(body)
      if (p.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer') return json(200, { access_token: 'sa-token', expires_in: 3600 })
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'code-ok' || !p.get('code_verifier')) return json(400, { error: 'invalid_grant' })
        const t = `at-${++this.seq}`
        this.tokens.set(t, this.consentAccount)
        const rt = `refresh-${this.seq}`
        this.refreshTokens.set(rt, this.consentAccount)
        return json(200, { access_token: t, refresh_token: rt, expires_in: 3600, scope: this.scope })
      }
      const rt = p.get('refresh_token') ?? ''
      if (!this.refreshTokens.has(rt) || this.revoked.has(rt)) return json(400, { error: 'invalid_grant' })
      const t = `at-${++this.seq}`
      this.tokens.set(t, this.refreshTokens.get(rt)!)
      return json(200, { access_token: t, expires_in: 3600, scope: this.scope })
    }
    if (u.host === 'pubsub.googleapis.com') {
      if (u.pathname.endsWith(':pull')) return json(200, { receivedMessages: this.pubsub.splice(0).map((m) => ({ ackId: m.ackId, message: { data: '' } })) })
      return json(200, {})
    }
    if (u.host !== 'gmail.googleapis.com') return json(404, {})
    if (!auth || !this.tokens.has(auth)) return json(401, { error: { code: 401 } })
    const path = u.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/profile') return json(200, { emailAddress: this.tokens.get(auth), historyId: String(this.historyId) })
    if (path === '/labels') return json(200, { labels: this.labels })
    if (path === '/watch') {
      this.watches.push(body ?? '')
      return this.failWatch ? json(500, {}) : json(200, { historyId: String(this.historyId), expiration: String(Date.now() + 7 * 86_400_000) })
    }
    if (path === '/history') {
      const start = Number(u.searchParams.get('startHistoryId'))
      if (start < this.oldestHistory) return json(404, { error: { code: 404 } })
      const hist = this.history.filter((h) => Number(h.id) > start)
      const strip = (m: { id: string; labelIds: string[] }) => (this.sparseHistory ? { id: m.id } : m)
      return json(200, { history: hist.map((h) => ({ id: h.id, ...(h.messagesAdded ? { messagesAdded: h.messagesAdded.map((x) => ({ message: strip(x.message) })) } : {}), ...(h.labelsAdded ? { labelsAdded: h.labelsAdded.map((x) => ({ message: strip(x.message), labelIds: x.labelIds })) } : {}) })), historyId: String(this.historyId) })
    }
    if (path === '/messages') {
      const label = u.searchParams.get('labelIds') ?? ''
      const list = [...this.messages.values()].filter((m) => m.labels.includes(label) && !m.labels.includes('SENT') && !m.labels.includes('DRAFT') && !m.labels.includes('SPAM') && !m.labels.includes('TRASH'))
      return json(200, { messages: list.reverse().map((m) => ({ id: m.id })) })
    }
    const one = /^\/messages\/([^/]+)$/.exec(path)
    if (one && method === 'GET') {
      if (this.failMessageGets > 0) {
        this.failMessageGets--
        return json(503, {})
      }
      const m = this.messages.get(one[1]!)
      if (!m) return json(404, { error: { code: 404 } })
      if (u.searchParams.get('format') === 'minimal') return json(200, { id: m.id, labelIds: m.labels })
      return json(200, { id: m.id, raw: m.raw.toString('base64url'), internalDate: String(m.internalDate), labelIds: m.labels })
    }
    return json(400, { error: 'unsupported by the fake' })
  }

  /** Requests other than reads, Pub/Sub, tokens and watch: must stay empty (TC-OUT-09, M-05). */
  writes(): string[] {
    return this.requests
      .filter((r) => !(r.method === 'GET' || /oauth2\.googleapis\.com\/(token|revoke)$/.test(r.url) || /pubsub\.googleapis\.com/.test(r.url) || r.url.endsWith('/watch')))
      .map((r) => `${r.method} ${r.url}`)
  }
}
