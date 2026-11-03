import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { createKit, type Kit } from './testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { catchUp, readCursor } from './catchup.ts'
import { ImapAdapter } from '../adapters/mailbox/imap.ts'
import type { MailboxAdapter, MessageRef } from '../adapters/mailbox/types.ts'

const HOST = process.env.TEST_IMAP_HOST ?? 'localhost'
const PORT = Number(process.env.TEST_IMAP_PORT ?? 53143)

let k: Kit
beforeAll(async () => {
  k = await createKit()
}, 60_000)
afterAll(async () => k?.close())

const cases = async () => Number((await k.db.query('SELECT count(*)::int AS n FROM "case"')).rows[0].n)
const audits = async (type: string) => Number((await k.db.query('SELECT count(*)::int AS n FROM audit WHERE type = $1', [type])).rows[0].n)

/** A mailbox in memory: messages by uid; tests can delete messages or make fetch fail. */
class FakeAdapter implements MailboxAdapter {
  readonly id = 'ops'
  readonly name = 'Operations'
  readonly capabilities = { push: false, trustedAuthResults: false }
  validity = '1'
  msgs = new Map<number, Buffer>()
  failFetch = new Set<number>()
  goneOnFetch = new Set<number>() // listed, then deleted before the fetch
  async start() {}
  async renew() {}
  async catchUp(cursor: string | null) {
    const m = cursor ? /^(\d+):(\d+)$/.exec(cursor) : null
    const resync = !!m && m[1] !== this.validity
    const from = m && !resync ? Number(m[2]) + 1 : 1
    const uids = [...this.msgs.keys(), ...this.failFetch].filter((u) => u >= from).sort((a, b) => a - b)
    const unique = [...new Set(uids)]
    return { refs: unique.map((u) => ({ mailboxId: this.id, key: `${this.validity}:${u}` })), cursor: `${this.validity}:${unique.at(-1) ?? 0}`, ...(resync ? { resync: true } : {}) }
  }
  async fetchRaw(ref: MessageRef) {
    const uid = Number(ref.key.split(':')[1])
    if (this.failFetch.has(uid)) throw new Error('ECONNRESET')
    const raw = this.goneOnFetch.has(uid) ? undefined : this.msgs.get(uid)
    return raw ? { raw, serverReceivedAt: '2026-10-29T10:00:00.000Z' } : ({ gone: true } as const)
  }
}

describe('C-ING-5 cursor', () => {
  it('TC-ING-19a crash before the 3rd, a deleted message, a network error, a UIDVALIDITY change', async () => {
    const a = new FakeAdapter()
    for (let u = 1; u <= 5; u++) a.msgs.set(u, eml({ messageId: `<c${u}@x.example>`, text: `m${u}` }))
    const before = await cases()
    // crash before the 3rd is archived
    await expect(catchUp(k, a, k.mailbox, { beforeIngest: (i) => { if (i === 2) throw new Error('crash') } })).rejects.toThrow('crash')
    expect(await readCursor(k, 'ops')).toBe('1:2')
    // restart: all five, each exactly once
    await catchUp(k, a, k.mailbox)
    expect(await cases()).toBe(before + 5)
    expect(await readCursor(k, 'ops')).toBe('1:5')

    // deleted before fetch → ingest.gap, skipped, cursor moves
    a.msgs.set(6, eml({ messageId: '<c6@x.example>', text: 'm6' }))
    a.msgs.set(8, eml({ messageId: '<c8@x.example>', text: 'm8' }))
    a.failFetch.add(7)
    const gaps = await audits('ingest.gap')
    // network error on 7 → the run stops, cursor stays after 6
    await expect(catchUp(k, a, k.mailbox)).rejects.toThrow('ECONNRESET')
    expect(await readCursor(k, 'ops')).toBe('1:6')
    // uid 7 is listed but deleted on the server before it is fetched
    a.failFetch.delete(7)
    a.msgs.set(7, eml({ messageId: '<c7@x.example>', text: 'm7' }))
    a.goneOnFetch.add(7)
    const r = await catchUp(k, a, k.mailbox)
    expect(r).toMatchObject({ created: 1, gaps: 1 })
    expect(await audits('ingest.gap')).toBe(gaps + 1)
    expect(await readCursor(k, 'ops')).toBe('1:8')

    // UIDVALIDITY changes: full re-list, no new Case, ingest.resync
    const n = await cases()
    a.validity = '2'
    const re = await catchUp(k, a, k.mailbox)
    a.goneOnFetch.clear()
    a.msgs.delete(7)
    expect(re).toMatchObject({ resync: true, created: 0, duplicates: 7, gaps: 1 })
    expect(await cases()).toBe(n)
    expect(await audits('ingest.resync')).toBe(1)
    expect(await readCursor(k, 'ops')).toBe('2:8')
  })
})

// ---------- IMAP against GreenMail ----------

async function imapUser(): Promise<{ user: string; client: ImapFlow }> {
  const user = `u${randomBytes(4).toString('hex')}@greenmail.example`
  const client = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: 'x' }, logger: false })
  await client.connect()
  return { user, client }
}
const adapterFor = (user: string, folder = 'INBOX') =>
  new ImapAdapter({ id: 'ops', name: 'Operations', host: HOST, port: PORT, tls: false, user, password: 'x', folder, stripsExternalAuthResults: false })

describe('IMAP adapter (GreenMail)', () => {
  it('TC-ING-05 20 messages, a crash at the 10th, restart: none lost, none twice; the adapter never changes the mailbox', async () => {
    const kit = await createKit()
    const { user, client } = await imapUser()
    try {
      for (let i = 1; i <= 20; i++) await client.append('INBOX', eml({ messageId: `<g${i}@x.example>`, text: `greenmail ${i}` }))
      const ad = adapterFor(user)
      await expect(catchUp(kit, ad, kit.mailbox, { beforeIngest: (i) => { if (i === 9) throw new Error('killed') } })).rejects.toThrow('killed')
      expect(Number((await kit.db.query('SELECT count(*)::int AS n FROM "case"')).rows[0].n)).toBe(9)
      await ad.close()
      const ad2 = adapterFor(user)
      await catchUp(kit, ad2, kit.mailbox)
      await catchUp(kit, ad2, kit.mailbox) // nothing new
      await ad2.close()
      expect(Number((await kit.db.query('SELECT count(*)::int AS n FROM "case"')).rows[0].n)).toBe(20)
      // read-only: no message got \Seen or any other flag
      await client.mailboxOpen('INBOX', { readOnly: true })
      const flags = (await client.fetchAll('1:*', { flags: true })).map((m) => [...(m.flags ?? [])])
      expect(flags.flat().filter((f) => f !== '\\Recent')).toEqual([]) // \Recent is the server's session flag
      // the server time is used (C-SIG-2), not the Date: header
      const t = (await kit.db.query('SELECT received_at FROM message LIMIT 1')).rows[0].received_at as Date
      expect(t.getUTCFullYear()).toBeGreaterThanOrEqual(2026)
    } finally {
      await client.logout()
      await kit.close()
    }
  }, 120_000)

  it('TC-ING-19a (IMAP) a deleted UID becomes a gap; a recreated folder (new UIDVALIDITY) is re-listed without duplicates', async () => {
    const kit = await createKit()
    const { user, client } = await imapUser()
    try {
      await client.mailboxCreate('Ops')
      const raws = [1, 2, 3, 4].map((i) => eml({ messageId: `<f${i}@x.example>`, text: `folder ${i}` }))
      for (const raw of raws.slice(0, 3)) await client.append('Ops', raw)
      const ad = adapterFor(user, 'Ops')
      const first = await ad.catchUp(null)
      expect(first.refs).toHaveLength(3)
      await client.mailboxOpen('Ops')
      // UID 2 is listed, then deleted on the server before it is fetched
      const r = await catchUp(kit, ad, kit.mailbox, {
        beforeIngest: async (i) => {
          if (i === 1) await client.messageDelete(first.refs[1]!.key.split(':')[1]!, { uid: true })
        },
      })
      expect(r).toMatchObject({ created: 2, gaps: 1 })
      // recreate the folder: new UIDVALIDITY
      await client.mailboxClose()
      await client.mailboxDelete('Ops')
      // GreenMail derives UIDVALIDITY from the clock in seconds: wait so the new folder gets a new one
      await new Promise((r) => setTimeout(r, 1500))
      await client.mailboxCreate('Ops')
      // the same bytes again (the server copied them), plus one new message
      for (const i of [0, 2, 3]) await client.append('Ops', raws[i]!)
      await ad.close()
      const again = await catchUp(kit, adapterFor(user, 'Ops'), kit.mailbox)
      expect(again).toMatchObject({ resync: true, created: 1, duplicates: 2 })
      expect(Number((await kit.db.query(`SELECT count(*)::int AS n FROM audit WHERE type = 'ingest.resync'`)).rows[0].n)).toBe(1)
    } finally {
      await client.logout()
      await kit.close()
    }
  }, 120_000)
})
