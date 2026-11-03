// Generic IMAP adapter (PRD R-ING-01, R-ING-02, R-ING-07; tech design §3.1). Read-only: the folder is opened with
// EXAMINE (readOnly) and only SEARCH and FETCH are used. The cursor is `UIDVALIDITY:last UID`.
import { ImapFlow } from 'imapflow'
import type { MailboxAdapter, MessageRef } from './types.ts'

export interface ImapSettings {
  id: string
  name: string
  host: string
  port: number
  tls: boolean
  user: string
  password: string
  folder: string
  stripsExternalAuthResults: boolean
}

export const parseCursor = (c: string | null) => {
  const m = c ? /^(\d+):(\d+)$/.exec(c) : null
  return m ? { validity: m[1]!, uid: Number(m[2]) } : null
}

export class ImapAdapter implements MailboxAdapter {
  readonly id: string
  readonly name: string
  readonly capabilities: { push: boolean; trustedAuthResults: boolean }
  private readonly s: ImapSettings
  private client: ImapFlow | null = null

  constructor(s: ImapSettings) {
    this.s = s
    this.id = s.id
    this.name = s.name
    this.capabilities = { push: true, trustedAuthResults: s.stripsExternalAuthResults }
  }

  private async open(): Promise<{ client: ImapFlow; validity: string }> {
    if (!this.client || !this.client.usable) {
      this.client = new ImapFlow({ host: this.s.host, port: this.s.port, secure: this.s.tls, auth: { user: this.s.user, pass: this.s.password }, logger: false })
      await this.client.connect()
    }
    // EXAMINE: the server must not change flags (not even \Seen)
    const box = await this.client.mailboxOpen(this.s.folder, { readOnly: true })
    return { client: this.client, validity: String(box.uidValidity) }
  }

  async start(onMessage: (ref: MessageRef) => Promise<void>): Promise<void> {
    const { client } = await this.open()
    // new mail during IDLE: tell the caller, who runs a catch-up from the stored cursor
    client.on('exists', () => void onMessage({ mailboxId: this.id, key: 'exists' }).catch(() => {}))
  }

  async catchUp(cursor: string | null): Promise<{ refs: MessageRef[]; cursor: string; resync?: boolean }> {
    const { client, validity } = await this.open()
    const cur = parseCursor(cursor)
    const resync = cur !== null && cur.validity !== validity
    const from = cur && !resync ? cur.uid + 1 : 1
    const found = (await client.search({ uid: `${from}:*` }, { uid: true })) || []
    // `n:*` always matches the last message, even when its UID is below n
    const uids = found.filter((u) => u >= from).sort((a, b) => a - b)
    const last = uids.at(-1) ?? (cur && !resync ? cur.uid : 0)
    return { refs: uids.map((u) => ({ mailboxId: this.id, key: `${validity}:${u}` })), cursor: `${validity}:${last}`, ...(resync ? { resync: true } : {}) }
  }

  async fetchRaw(ref: MessageRef): Promise<{ raw: Buffer; serverReceivedAt: string } | { gone: true }> {
    const { client, validity } = await this.open()
    const c = parseCursor(ref.key)
    if (!c || c.validity !== validity) return { gone: true }
    const m = await client.fetchOne(String(c.uid), { source: true, internalDate: true }, { uid: true })
    if (!m || !m.source) return { gone: true }
    const at = m.internalDate instanceof Date ? m.internalDate : new Date(String(m.internalDate))
    return { raw: m.source, serverReceivedAt: at.toISOString() }
  }

  async renew(): Promise<void> {
    // IMAP has no subscription to renew
  }

  async close(): Promise<void> {
    if (this.client) await this.client.logout().catch(() => this.client?.close())
    this.client = null
  }
}
