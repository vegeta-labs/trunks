import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { ADAPTER_MEMBERS, checkAllowList, EXPECTED_MAIL_HTTP_ALLOW, mailboxAdapterMembers, scanDirectRequests, scanPackageJson, scanSource } from './no-send.ts'
import { MAIL_HTTP_ALLOW, MailHttp, allowed } from '../src/adapters/mailbox/http.ts'

const rules = (src: string) => scanSource('x.ts', src).map((f) => f.rule)

describe('no-send static check', () => {
  it('TC-OUT-09 every listed write or send call fails; reply.send and boss.send do not', () => {
    const bad = [
      "gmail.users.messages.send({ userId: 'me' })",
      "gmail.users.messages.insert({})",
      "gmail.users.messages.import({})",
      "gmail.users.messages.modify({})",
      "gmail.users.drafts.create({})",
      "gmail.users.drafts.list({})",
      "client.api('/users/ops@x.example/messages').post({})",
      "client.api(`/users/${id}/messages/${m}`).patch({})",
      "client.api('/me/sendMail').post({})",
      "client.api('/me/messages/1/reply').post({})",
      "client.api('/me/messages/1/forward').post({})",
      "client.api('/me/messages/1/createReply').post({})",
      "const p = '/users/x/messages/1/replyAll'",
      "imap.append('INBOX', raw)",
      "imap.messageFlagsAdd('1', ['\\\\Seen'])",
      "imap.messageCopy('1', 'Archive')",
      "imap.messageMove('1', 'Archive')",
      "imap.messageDelete('1')",
      "imap.mailboxOpen('INBOX')",
      "imap.mailboxOpen('INBOX', { readOnly: false })",
      "imap.getMailboxLock('INBOX')",
      "imap.exec('UID STORE 1 +FLAGS (\\\\Deleted)')",
      "imap.exec('EXPUNGE')",
      "import nodemailer from 'nodemailer'",
      "const s = require('smtp-client')",
    ]
    for (const b of bad) expect(rules(b), b).not.toEqual([])
    // self-test WR-F2 bypasses, checked in an adapter file (where the mail libraries are allowed)
    const inAdapter = (src: string) => scanSource('src/adapters/mailbox/x.ts', src).map((f) => f.rule)
    for (const b of [
      'const msgs = gmail.users.messages; await msgs.send({})',
      "client['messageMove']('1', 'x')",
      'const { messageFlagsAdd } = client; messageFlagsAdd.call(client, 1)',
      'const cmd = x; client.exec(cmd)',
      "fetch(base + '/sendMail', { method: 'POST' })",
      "client.mailboxOpen('INBOX', { readOnly: true, ...opts })",
      'const p = name; await import(p)',
      "const s = 'MAIL FROM:<a@x.example>'",
      "fetch('https://graph.microsoft.com/v1.0/me/messages', { method: 'POST', body: '{}' })",
      "await fetch(url, { method: 'PATCH' })",
    ]) expect(inAdapter(b), b).not.toEqual([])
    // outside adapters the network and mail modules themselves are refused
    for (const b of ["import tls from 'node:tls'", "import { ImapFlow } from 'imapflow'", "import net from 'net'"]) expect(rules(b), b).not.toEqual([])
    // a mail-service write by plain HTTP is refused anywhere; a read is not
    expect(rules("fetch('https://graph.microsoft.com/v1.0/me/messages', { method: 'POST' })")).not.toEqual([])
    expect(rules("fetch('https://graph.microsoft.com/v1.0/me/messages/delta')")).toEqual([])
    expect(rules("fetch('https://hooks.example/x', { method: 'POST' })")).toEqual([])
    expect(scanSource('src/adapters/events/webhook.ts', "fetch(hook, { method: 'POST' })").map((f) => f.rule)).toEqual([])
    expect(inAdapter("import { ImapFlow } from 'imapflow'")).toEqual([])
    const good = [
      'reply.send({ ok: true })',
      "boss.send('parse', {})",
      "gmail.users.messages.get({ userId: 'me', id })",
      "gmail.users.history.list({})",
      "client.api('/subscriptions').post({})",
      "client.api('/users/x/messages/delta').get()",
      "imap.mailboxOpen('INBOX', { readOnly: true })",
      "imap.getMailboxLock('INBOX', { readOnly: true })",
      "imap.fetchOne('1', { source: true }, { uid: true })",
    ]
    for (const g of good) expect(rules(g), g).toEqual([])
    expect(scanPackageJson(JSON.stringify({ dependencies: { nodemailer: '1' } }))).toHaveLength(1)
    expect(scanPackageJson(JSON.stringify({ devDependencies: { 'smtp-server': '1' } }))).toHaveLength(1)
    expect(mailboxAdapterMembers('interface MailboxAdapter { id: string; send(): void }')).toEqual(['id', 'send'])
    expect(mailboxAdapterMembers(readFileSync('src/adapters/mailbox/types.ts', 'utf8'))).toEqual(ADAPTER_MEMBERS)
    // and the real repository passes
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/check-no-send.ts'], { encoding: 'utf8' })
    expect(out).toContain('no-send check passed')
  })
})

describe('TC-OUT-09 from E4: the mailbox HTTP allow-list and direct requests', () => {
  it('the allow-list is exactly the expected one; one more entry or a write path fails', () => {
    expect(checkAllowList(MAIL_HTTP_ALLOW)).toEqual([])
    expect(checkAllowList([...EXPECTED_MAIL_HTTP_ALLOW, 'GET graph.microsoft.com /v1.0/users/*/events']).length).toBeGreaterThan(0)
    expect(checkAllowList([...EXPECTED_MAIL_HTTP_ALLOW.slice(0, -1), 'POST graph.microsoft.com /v1.0/users/*/sendMail']).join()).toMatch(/write path/)
    expect(checkAllowList([...EXPECTED_MAIL_HTTP_ALLOW.slice(0, -1), 'POST gmail.googleapis.com /gmail/v1/users/*/messages/*/modify']).join()).toMatch(/write path/)
  })
  it('only listed host + method + path is allowed at run time', () => {
    expect(allowed('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc?format=raw')).toBe(true)
    expect(allowed('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')).toBe(false)
    expect(allowed('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts')).toBe(false)
    expect(allowed('GET', 'https://gmail.googleapis.com.evil.example/gmail/v1/users/me/profile')).toBe(false)
    expect(allowed('GET', 'http://gmail.googleapis.com/gmail/v1/users/me/profile')).toBe(false)
    expect(allowed('GET', 'https://graph.microsoft.com/v1.0/users/a%40b.example/messages/X/$value')).toBe(true)
    expect(allowed('POST', 'https://graph.microsoft.com/v1.0/users/a%40b.example/sendMail')).toBe(false)
    expect(allowed('POST', 'https://graph.microsoft.com/v1.0/users/a%40b.example/messages/X/reply')).toBe(false)
    expect(allowed('GET', 'https://graph.microsoft.com/v1.0/users/a/messages/X/attachments')).toBe(false)
    expect(allowed('GET', 'https://evil.example/v1.0/users/a/mailFolders/inbox/messages/delta')).toBe(false)
  })
  it('MailHttp never follows a redirect and refuses before sending', async () => {
    const seen: RequestInit[] = []
    const http = new MailHttp(async (_u, i) => {
      seen.push(i)
      return new Response('{}')
    })
    await http.request('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/profile')
    expect(seen[0]!.redirect).toBe('error')
    await expect(http.request('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')).rejects.toThrow(/allow-list/)
    expect(seen.length).toBe(1)
  })
  it('a direct fetch to a provider outside MailHttp fails; MailHttp itself and fakes are exempt; production code cannot import a fake', () => {
    expect(scanDirectRequests('src/x.ts', "await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages')").length).toBe(1)
    expect(scanDirectRequests('src/x.ts', "https.request('https://graph.microsoft.com/v1.0/me')").length).toBe(1)
    expect(scanDirectRequests('src/adapters/mailbox/http.ts', "fetch('https://gmail.googleapis.com/')")).toEqual([])
    expect(scanDirectRequests('src/a.fake.ts', "fetch('https://gmail.googleapis.com/')")).toEqual([])
    expect(scanDirectRequests('src/main.ts', "import { FakeGmail } from './adapters/mailbox/gmail.fake.ts'").length).toBe(1)
    expect(scanDirectRequests('src/y.ts', "await fetch('https://hooks.example/doi')")).toEqual([])
  })
})
