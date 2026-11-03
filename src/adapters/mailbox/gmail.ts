// Gmail adapter (PRD R-ING-01/02/07, C-ING-5, C-ING-6, decision 3 and 6; tech design §3.1, v0.7.9). gmail.readonly only,
// one refresh token per mailbox; every request through MailHttp's allow-list.
//
// Cursor: `<position>:<message id>` after each message (catch-up stores the ref key). Position is a history id, or
// `resync` while a full listing is under way: a crash part way through a listing lists again (C-ING-1 de-duplicates),
// and only the last message of the listing moves the cursor to the history id taken before the listing began.
import { createSign } from 'node:crypto'
import type { MailboxAdapter, MessageRef } from './types.ts'
import { MailHttp } from './http.ts'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const TOKEN = 'https://oauth2.googleapis.com/token'
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub'
const NEVER = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH']) // C-ING-6

/** The mailbox's refresh token was revoked or expired (`invalid_grant`): this mailbox stops, others go on. */
export class TokenRevoked extends Error {}
/** A temporary failure (network, 429, 5xx): retry later, the cursor stays (C-ING-5). */
export class Temporary extends Error {}
/** The token belongs to another account than the configured address (review #7). */
export class WrongAccount extends Error {}
/** The configuration names a label that does not exist or is never received (C-ING-6). */
export class ConfigError extends Error {}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

const RATE = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|backendError/

/** `body`: the error answer; Gmail reports usage limits as 403 too, which are temporary (self-test F5). */
function check(status: number, what: string, body?: unknown): void {
  if (status === 429 || status >= 500) throw new Temporary(`${what}: ${status}`)
  if (status === 403 && RATE.test(JSON.stringify(body ?? ''))) throw new Temporary(`${what}: rate limited`)
  if (status === 401 || status === 403) throw new TokenRevoked(`${what}: ${status}`)
  if (status < 200 || status > 299) throw new Error(`${what}: ${status}`)
}

/** Access tokens from the stored refresh token; after each new token the account is checked (review #7). */
export class GmailTokens {
  private token: { value: string; until: number } | null = null
  private readonly http: MailHttp
  private readonly o: { address: string; clientId: string; clientSecret: string; refreshToken: () => Promise<string | null> }
  constructor(http: MailHttp, o: { address: string; clientId: string; clientSecret: string; refreshToken: () => Promise<string | null> }) {
    this.http = http
    this.o = o
  }
  async get(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value
    const refresh = await this.o.refreshToken()
    if (!refresh) throw new TokenRevoked('no refresh token stored: run doi gmail-auth')
    let r: { status: number; body: { access_token?: string; expires_in?: number; error?: string; scope?: string } | null }
    try {
      r = await this.http.json('POST', TOKEN, { headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: this.o.clientId, client_secret: this.o.clientSecret }) })
    } catch (e) {
      throw new Temporary(`token: ${(e as Error).name}`)
    }
    if (r.body?.error === 'invalid_grant') throw new TokenRevoked('the refresh token was revoked or has expired')
    check(r.status, 'token', r.body)
    if (!r.body?.access_token) throw new Temporary('token: no access token')
    if (r.body.scope !== undefined && r.body.scope.split(' ').sort().join(' ') !== GMAIL_SCOPE) throw new TokenRevoked('the token has another scope than gmail.readonly')
    const value = r.body.access_token
    const p = await this.http.json<{ emailAddress?: string }>('GET', `${GMAIL}/profile`, { headers: { authorization: `Bearer ${value}` } })
    check(p.status, 'profile', p.body)
    if (p.body?.emailAddress?.toLowerCase() !== this.o.address.toLowerCase()) throw new WrongAccount('the token belongs to another account than the configured address')
    this.token = { value, until: Date.now() + Math.max(60, (r.body.expires_in ?? 3600) - 120) * 1000 }
    return value
  }
  forget(): void {
    this.token = null
  }
}

/** A service account's access token (JWT bearer grant) for Pub/Sub pull only. */
export async function serviceAccountToken(http: MailHttp, sa: { client_email: string; private_key: string }, scope = PUBSUB_SCOPE): Promise<{ token: string; until: number }> {
  const now = Math.floor(Date.now() / 1000)
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: TOKEN, iat: now, exp: now + 3600 })}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url')
  const r = await http.json<{ access_token?: string; expires_in?: number }>('POST', TOKEN, { headers: FORM, body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }) })
  check(r.status, 'service account token', r.body)
  if (!r.body?.access_token) throw new Temporary('service account token: none')
  return { token: r.body.access_token, until: Date.now() + Math.max(60, (r.body.expires_in ?? 3600) - 120) * 1000 }
}

export interface GmailSettings {
  id: string
  name: string
  address: string
  labels: string[] // names (C-ING-6); resolved to ids at start
  stripsExternalAuthResults: boolean
  pubsub?: { topic: string; subscription: string; serviceAccount: { client_email: string; private_key: string } }
}

interface Msg {
  id: string
  labelIds?: string[]
}

export class GmailAdapter implements MailboxAdapter {
  readonly id: string
  readonly name: string
  readonly capabilities: { push: boolean; trustedAuthResults: boolean }
  private readonly s: GmailSettings
  private readonly http: MailHttp
  private readonly tokens: GmailTokens
  private labelIds: string[] | null = null
  private sa: { token: string; until: number } | null = null
  private stopped = false

  constructor(s: GmailSettings, http: MailHttp, tokens: GmailTokens) {
    this.s = s
    this.id = s.id
    this.name = s.name
    this.http = http
    this.tokens = tokens
    this.capabilities = { push: !!s.pubsub, trustedAuthResults: s.stripsExternalAuthResults }
  }

  private async get<T>(url: string, what: string): Promise<{ status: number; body: T | null }> {
    for (let attempt = 0; ; attempt++) {
      let r: { status: number; body: T | null }
      try {
        r = await this.http.json<T>('GET', url, { headers: { authorization: `Bearer ${await this.tokens.get()}` } })
      } catch (e) {
        if (e instanceof TokenRevoked || e instanceof WrongAccount || e instanceof Temporary) throw e
        if ((e as Error).name === 'MailHttpRefused') throw e
        throw new Temporary(`${what}: ${(e as Error).name}`)
      }
      if (r.status === 401 && attempt === 0) {
        this.tokens.forget() // an expired access token: one more try with a new one
        continue
      }
      return r
    }
  }

  /** C-ING-6: label names → ids; a name that does not exist refuses the start. */
  async resolveLabels(): Promise<string[]> {
    if (this.labelIds) return this.labelIds
    const r = await this.get<{ labels?: Array<{ id: string; name: string }> }>(`${GMAIL}/labels`, 'labels')
    check(r.status, 'labels', r.body)
    // not a label list (a maintenance page): temporary, never «label not found» (regression review R3)
    if (!r.body || typeof r.body !== 'object' || !Array.isArray(r.body.labels)) throw new Temporary('labels: not a label list')
    const all = r.body.labels
    this.labelIds = this.s.labels.map((n) => {
      const hit = all.find((l) => l.name === n || l.id === n)
      if (!hit) throw new ConfigError(`Gmail mailbox ${this.id}: label «${n}» not found`)
      if (NEVER.has(hit.id)) throw new ConfigError(`Gmail mailbox ${this.id}: label ${hit.id} is never received (C-ING-6)`)
      return hit.id
    })
    return this.labelIds
  }

  private wanted(labels: string[] | undefined, ids: string[]): boolean {
    const l = labels ?? []
    return !l.some((x) => NEVER.has(x)) && l.some((x) => ids.includes(x))
  }

  async start(onMessage: (ref: MessageRef) => Promise<void>): Promise<void> {
    // the notification loop runs whatever the label check gives (it only triggers catch-ups, which check again) (R3)
    this.startPull(onMessage)
    await this.resolveLabels()
  }

  private startPull(onMessage: (ref: MessageRef) => Promise<void>): void {
    if (!this.s.pubsub) return // no Pub/Sub: the catch-up interval polls history
    const ps = this.s.pubsub
    const loop = async () => {
      while (!this.stopped) {
        try {
          if (!this.sa || Date.now() >= this.sa.until) this.sa = await serviceAccountToken(this.http, ps.serviceAccount)
          const auth = { authorization: `Bearer ${this.sa.token}`, 'content-type': 'application/json' }
          const r = await this.http.json<{ receivedMessages?: Array<{ ackId: string }> }>('POST', `https://pubsub.googleapis.com/v1/${ps.subscription}:pull`, { headers: auth, body: JSON.stringify({ maxMessages: 50 }) })
          const got = r.body?.receivedMessages ?? []
          if (got.length) {
            await this.http.request('POST', `https://pubsub.googleapis.com/v1/${ps.subscription}:acknowledge`, { headers: auth, body: JSON.stringify({ ackIds: got.map((m) => m.ackId) }) })
            // the notification only says «something changed»: the catch-up from the stored cursor does the work
            await onMessage({ mailboxId: this.id, key: 'notify' }).catch(() => {})
          }
        } catch {
          // a failed pull is retried; the catch-up interval still runs
        }
        await new Promise((r) => setTimeout(r, 10_000))
      }
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
  }

  async catchUp(cursor: string | null): Promise<{ refs: MessageRef[]; cursor: string; resync?: boolean }> {
    const ids = await this.resolveLabels()
    const pos = cursor?.split(':')[0] ?? null
    if (pos && pos !== 'resync') {
      const out = await this.history(pos, ids)
      if (out) return out
      return { ...(await this.listAll(ids)), resync: true } // historyId too old (404): list everything again
    }
    const all = await this.listAll(ids)
    return pos === 'resync' ? { ...all, resync: true } : all
  }

  private async history(start: string, ids: string[]): Promise<{ refs: MessageRef[]; cursor: string } | null> {
    const records: Array<{ id: string; msgs: Msg[] }> = []
    let page: string | undefined
    let latest = start
    do {
      // historyTypes twice; built as pairs (the no-send check reads any `.append(` as an IMAP APPEND)
      const q = new URLSearchParams([['startHistoryId', start], ['historyTypes', 'messageAdded'], ['historyTypes', 'labelAdded'], ...(page ? [['pageToken', page]] : [])])
      const r = await this.get<{ history?: Array<{ id: string; messagesAdded?: Array<{ message: Msg }>; labelsAdded?: Array<{ message: Msg; labelIds: string[] }> }>; nextPageToken?: string; historyId?: string }>(`${GMAIL}/history?${q}`, 'history')
      if (r.status === 404) return null
      check(r.status, 'history', r.body)
      // an answer that is not a history page is temporary: the cursor must not move (Codex E4 F7)
      if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body) || !/^\d+$/.test(String(r.body.historyId ?? '')) || (r.body.history !== undefined && !Array.isArray(r.body.history))) throw new Temporary('history: not a history page')
      for (const h of r.body.history ?? []) {
        if (!/^\d+$/.test(String(h.id))) throw new Temporary('history: a record without an id')
        const msgs = [...(h.messagesAdded ?? []).map((x) => x.message), ...(h.labelsAdded ?? []).filter((x) => (x.labelIds ?? []).some((l) => ids.includes(l))).map((x) => x.message)]
        const kept: Msg[] = []
        for (const m of msgs) {
          // a history entry may carry only the id (Codex E4 F6): read the labels before deciding
          const labels = m.labelIds ?? (await this.labelsOf(m.id))
          // gone already (404): kept, so its fetch records ingest.gap with the cursor (round 2 F10)
          if (labels === null || this.wanted(labels, ids)) kept.push({ ...m, labelIds: labels ?? [] })
        }
        records.push({ id: h.id, msgs: kept })
      }
      latest = r.body.historyId ?? latest
      page = r.body?.nextPageToken
    } while (page)
    // after a message: its record's id minus one while more of the record follows, the record's id when it is the last
    const refs: MessageRef[] = []
    const seen = new Set<string>()
    for (const rec of records) {
      const msgs = rec.msgs.filter((m) => !seen.has(m.id) && seen.add(m.id))
      msgs.forEach((m, i) => refs.push({ mailboxId: this.id, key: `${i === msgs.length - 1 ? rec.id : (BigInt(rec.id) - 1n).toString()}:${m.id}` }))
    }
    if (refs.length) refs[refs.length - 1] = { ...refs.at(-1)!, key: `${latest}:${refs.at(-1)!.key.split(':')[1]}` }
    return { refs, cursor: refs.length ? refs.at(-1)!.key : latest }
  }

  /** The labels of one message; null when it no longer exists. */
  private async labelsOf(id: string): Promise<string[] | null> {
    if (!/^[0-9a-zA-Z_-]+$/.test(id)) return null
    const r = await this.get<{ labelIds?: string[] }>(`${GMAIL}/messages/${id}?format=minimal`, 'labels of a message')
    if (r.status === 404) return null
    check(r.status, 'labels of a message', r.body)
    if (!r.body || typeof r.body !== 'object') throw new Temporary('labels of a message: not an answer')
    return Array.isArray(r.body.labelIds) ? r.body.labelIds : []
  }

  /** Every wanted message, oldest first; the history id is taken before the listing (nothing in between is missed). */
  private async listAll(ids: string[]): Promise<{ refs: MessageRef[]; cursor: string }> {
    const p = await this.get<{ historyId?: string }>(`${GMAIL}/profile`, 'profile')
    check(p.status, 'profile', p.body)
    if (!/^\d+$/.test(String(p.body?.historyId ?? ''))) throw new Temporary('profile: no history id') // Codex E4 F7
    const h0 = String(p.body!.historyId)
    const found: string[] = []
    const seen = new Set<string>()
    for (const label of ids) {
      let page: string | undefined
      do {
        const q = new URLSearchParams({ labelIds: label, q: '-in:sent -in:drafts', maxResults: '500' })
        if (page) q.set('pageToken', page)
        const r = await this.get<{ messages?: Msg[]; nextPageToken?: string }>(`${GMAIL}/messages?${q}`, 'messages')
        check(r.status, 'messages', r.body)
        // a listing that is not a listing (a maintenance page) is temporary, never «empty» (Codex E4 F7)
        if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body) || (r.body['messages'] !== undefined && !Array.isArray(r.body['messages']))) throw new Temporary('messages: not a listing')
        const listed = r.body['messages'] ?? [] // element access: the no-send check guards `.messages`
        if (listed.some((m) => typeof m?.id !== 'string')) throw new Temporary('messages: an entry without an id') // round 2 F8
        for (const m of listed) if (!seen.has(m.id) && seen.add(m.id)) found.push(m.id)
        page = r.body?.nextPageToken
      } while (page)
    }
    found.reverse() // the API lists newest first
    const refs = found.map((id, i) => ({ mailboxId: this.id, key: `${i === found.length - 1 ? h0 : 'resync'}:${id}` }))
    return { refs, cursor: refs.length ? refs.at(-1)!.key : `${h0}:` }
  }

  async fetchRaw(ref: MessageRef): Promise<{ raw: Buffer; serverReceivedAt: string } | { gone: true }> {
    const id = ref.key.split(':')[1]
    if (!id || !/^[0-9a-zA-Z_-]+$/.test(id)) return { gone: true }
    const r = await this.get<{ raw?: string; internalDate?: string; labelIds?: string[] }>(`${GMAIL}/messages/${id}?format=raw`, 'message')
    if (r.status === 404) return { gone: true } // the provider confirms it no longer exists (C-ING-5)
    check(r.status, 'message', r.body)
    if (!r.body?.raw || !r.body.internalDate) throw new Temporary('message: incomplete answer')
    // moved out of the received labels (to trash, spam …) between listing and fetching: not received (round 2 F9)
    // an answer without labels says nothing about scope: read them (review S3); gone only on a definite answer
    const labels = Array.isArray(r.body.labelIds) ? r.body.labelIds : await this.labelsOf(id)
    if (labels === null || !this.wanted(labels, await this.resolveLabels())) return { gone: true }
    return { raw: Buffer.from(r.body.raw, 'base64url'), serverReceivedAt: new Date(Number(r.body.internalDate)).toISOString() } // C-SIG-2
  }

  /** Gmail watch (7 days): renewed daily by the scheduler; a failure throws for the caller to audit and show. */
  async renew(): Promise<void> {
    if (!this.s.pubsub) return
    const ids = await this.resolveLabels()
    const r = await this.http.json<{ expiration?: string }>('POST', `${GMAIL}/watch`, {
      headers: { authorization: `Bearer ${await this.tokens.get()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ topicName: this.s.pubsub.topic, labelIds: ids, labelFilterBehavior: 'INCLUDE' }),
    })
    // a refused watch (e.g. the topic does not let Gmail publish) is a renewal failure, not a lost authorisation
    if (r.status === 403 && !RATE.test(JSON.stringify(r.body ?? ''))) throw new Error('watch: refused (403)')
    check(r.status, 'watch', r.body)
  }
}
