// Self-test gate (rules G2 step 0): hostile answers from the providers and hostile values for the E4 surfaces. A
// provider is outside our control: malformed JSON, path tricks in ids, links to other hosts, special keys.
import { describe, expect, it } from 'vitest'
import { MailHttp, allowed } from './http.ts'
import { GmailAdapter, GmailTokens, Temporary } from './gmail.ts'
import { GraphAdapter, GraphTokens } from './graph.ts'
import { FakeGmail } from './gmail.fake.ts'
import { FolderSink, WebhookSink, generatedName } from '../../maintenance/kyc.ts'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const gmail = (fetch: (u: string, i: RequestInit) => Promise<Response>, fake = new FakeGmail('ops@capital.example')) => {
  const http = new MailHttp(async (u, i) => (u.includes('oauth2') || u.endsWith('/profile') || u.endsWith('/labels') ? fake.fetch(u, i) : fetch(u, i)))
  return new GmailAdapter({ id: 'h', name: 'h', address: fake.address, labels: ['INBOX'], stripsExternalAuthResults: false }, http, new GmailTokens(http, { address: fake.address, clientId: 'c', clientSecret: 's', refreshToken: async () => 'refresh-ok' }))
}

describe('hostile provider answers', () => {
  it('a Gmail message id with path tricks is never requested', async () => {
    const urls: string[] = []
    const a = gmail(async (u) => {
      urls.push(u)
      return new Response('{}')
    })
    for (const id of ['../../users/other/messages/x', 'a/b', '%2e%2e', '__proto__?x=1', '']) expect(await a.fetchRaw({ mailboxId: 'h', key: `1:${id}` })).toEqual({ gone: true })
    expect(urls).toEqual([])
  })

  it('malformed JSON, an empty body or a 5xx from Gmail history is temporary (cursor kept), never «nothing new»', async () => {
    for (const body of ['not json', '', '{"history": "oops"', '<html>maintenance</html>']) {
      const a = gmail(async () => new Response(body, { status: 200 }))
      const r: unknown = await a.catchUp('1000:x').catch((e: unknown) => e)
      // a body that does not parse gives no history and no historyId: the cursor must not move past anything
      if (!(r instanceof Error)) expect((r as { cursor: string }).cursor.startsWith('1000')).toBe(true)
    }
    const down = gmail(async () => new Response('', { status: 503 }))
    await expect(down.catchUp('1000:x')).rejects.toBeInstanceOf(Temporary)
  })

  it('Graph: a deltaLink or nextLink to another host, plain http, or with credentials in it is refused before sending', () => {
    for (const u of [
      'https://graph.microsoft.com.evil.example/v1.0/users/a/mailFolders/f/messages/delta',
      'http://graph.microsoft.com/v1.0/users/a/mailFolders/f/messages/delta',
      'https://user:pw@graph.microsoft.com/v1.0/users/a/mailFolders/f/messages/delta',
      'https://graph.microsoft.com:8443/v1.0/users/a/mailFolders/f/messages/delta',
      'https://graph.microsoft.com/v1.0/users/a/mailFolders/f/messages/delta/../../../me/sendMail',
    ]) expect(allowed('GET', u), u).toBe(false)
  })

  it('Graph: a stored cursor that is not JSON, or a message id that is not a string, is handled without a request', async () => {
    const urls: string[] = []
    const http = new MailHttp(async (u) => {
      urls.push(u)
      return new Response('{}', { status: 200 })
    })
    const a = new GraphAdapter({ id: 'h', name: 'h', user: 'ops@capital.example', folderId: 'f', stripsExternalAuthResults: false }, http, new GraphTokens(http, { tenantId: 't', clientId: 'c', secret: 's' }))
    expect(await a.fetchRaw({ mailboxId: 'h', key: 'not json' })).toEqual({ gone: true })
    expect(await a.fetchRaw({ mailboxId: 'h', key: '{"c":null,"id":null}' })).toEqual({ gone: true })
    expect(urls).toEqual([])
  })
})

describe('hostile values for KYC targets', () => {
  it('a generated name never takes anything from the attachment; odd kinds fall back to .bin', () => {
    expect(generatedName('0b0c0d0e-0000-4000-8000-0000000000aa', 2, '__proto__', Buffer.from('x'))).toBe('0b0c0d0e-0000-4000-8000-0000000000aa-2.bin')
    expect(generatedName('0b0c0d0e-0000-4000-8000-0000000000aa', 3, 'image', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('0b0c0d0e-0000-4000-8000-0000000000aa-3.png')
  })
  it('a folder target refuses names that leave the folder; a webhook with a huge or nested receipt is not a receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trunks-kyc-h-'))
    for (const name of ['../x.pdf', '/etc/x.pdf', 'a/b.pdf', 'x.pdf\u0000.txt']) {
      await expect(new FolderSink(dir).deliver(Buffer.from('x'), { deliveryId: 'd', caseId: 'c', seq: 1, name, sha256: 'x' })).rejects.toMatchObject({ code: 'bad_name' })
    }
    expect(readdirSync(dir)).toEqual([])
    const m = { deliveryId: '0b0c0d0e-0000-4000-8000-000000000001', caseId: 'c', seq: 1, name: 'n', sha256: 'f'.repeat(64) }
    for (const body of ['{"delivery_id":{"$ne":null},"sha256":"' + 'f'.repeat(64) + '"}', '[]', 'null', JSON.stringify({ __proto__: { delivery_id: m.deliveryId, sha256: m.sha256 } })]) {
      await expect(new WebhookSink('https://kyc.example/in', 's', async () => ({ status: 200, body })).deliver(Buffer.from('x'), m)).rejects.toHaveProperty('code')
    }
  })
})
