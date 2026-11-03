// Test server for the browser tests: a fresh database, fictional mails and directory, the built UI, the pipeline
// running in the background, and four users. Test-only helpers (never in the app): a control port that ingests a mail,
// and a clock that moves a finished checklist past its cooling-off period.
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKit, FakeLlm, testConfig } from '../src/pipeline/testkit.ts'
import { buildServer } from '../src/server/app.ts'
import { bootstrapAdmin, createUser, userByName } from '../src/server/auth.ts'
import { tx } from '../src/store/db.ts'
import { eml } from '../src/ingest/testmail.ts'
import { makePdf } from '../parser/testfiles.ts'

// a scripted model whose text carries Markdown, a name placeholder and an account placeholder (TC-REV-02, TC-RED-09a);
// other subjects get the classes below
const CLASSES: Array<[string, string[]]> = [
  ['I have paid', ['payment_query']],
  ['New bank details', ['bank_details']],
  ['Bank letter please', ['bank_letter_request', 'complaint']],
  ['Second payment', ['payment_query']],
]
const llm = new FakeLlm()
llm.reply = (v, user) => {
  if (user.includes('Model text test')) {
    if (v.startsWith('classify')) return JSON.stringify({ labels: [{ class: 'payment_query', confidence: 'high', reason: '![pixel](https://evil.example/p.png) [click here](https://evil.example/x) [NAME_1] paid into [ACCOUNT_1]' }], language: 'en' })
    return JSON.stringify({ fields: { payer_name: { value: '[NAME_1] [NAME_2]', confidence: 'high', quote: '[NAME_1] [NAME_2]' }, reference: { value: '[ACCOUNT_1]', confidence: 'low', quote: '[ACCOUNT_1]' } } })
  }
  const hit = CLASSES.find(([s]) => user.includes(s))
  if (!hit || !v.startsWith('classify')) return llm.defaultReply(v)
  return JSON.stringify({ labels: hit[1].map((c) => ({ class: c.split(':')[0], confidence: c.split(':')[1] ?? 'high', reason: 'test' })), language: 'en' })
}
const kit = await createKit({ llm, config: { ...testConfig(), verification: { cooling_off_hours: 1 } } })
const dir = mkdtempSync(join(tmpdir(), 'doi-e2e-'))
writeFileSync(join(dir, 'pw'), 'e2e-admin-password-1')
await bootstrapAdmin(kit.db, kit.k, join(dir, 'pw'))
await kit.importCsv('deals', 'name,currency,close_date\nNorthwind Robotics,GBP,2026-12-18\n')
await kit.importCsv('commitments', 'investor_id,name,email,reference,cash_due\n001,Amelia Hart,amelia@hartfamily.example,NW-001,"10,000.00"\n', 'Northwind Robotics')
await kit.importCsv('ledger', 'transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency\nT1,2026-10-20,4000.00,A HART,NW-001,auto,001,Amelia Hart,auto,,GBP\n', 'Northwind Robotics')
await kit.importCsv('contacts', 'contact_id,name,email,phone,role,deal,investor_id\nC001,Amelia Hart,amelia@hartfamily.example,+44 7700 900101,investor,Northwind Robotics,Northwind Robotics::001\n')

// users: ann (admin) completes checklists; paul (approver, created by the first admin) may approve after her;
// zed (approver) was created by ann, so never for her tasks; rita is a reviewer
const admin = (await userByName(kit.db, kit.k, 'admin'))!.id
const users: Record<string, string> = {}
for (const [name, role, by] of [['ann', 'admin', 'admin'], ['paul', 'approver', 'admin'], ['rita', 'reviewer', 'admin'], ['zed', 'approver', 'ann']] as const) {
  users[name] = await tx(kit.db, (c) => createUser(c, kit.k, { username: name, role, password: `${name}-password-1234`, by: by === 'admin' ? admin : users[by]!, mustChange: false }))
}
await kit.t.owner.query(`UPDATE user_event SET at = now() - interval '30 days'`) // accounts and roles older than any cooling-off period

const AUTH: Array<[string, string]> = [['Authentication-Results', 'mx.ops.example; spf=pass; dkim=pass; dmarc=pass']]
const TRUSTED = { id: 'ops', trustedAuthResults: true, trustedAuthservId: 'mx.ops.example' }
const at = new Date().toISOString()
await kit.ingest(eml({
  from: 'Amelia Hart <amelia@hartfamily.example>',
  subject: 'Remote content test',
  html: '<p>Hello team</p><img src="https://tracker.example/pixel.gif"><script src="https://evil.example/x.js"></script><link rel="stylesheet" href="https://cdn.example/a.css"><div style="background:url(https://img.example/bg.png)">styled</div><script>document.title="pwned"</script>',
}))
await kit.ingest(eml({ subject: 'Payment £10,000.00 ref NW-001', text: 'I paid £10,000.00 on 23 Oct 2026.' }))
await kit.ingest(eml({ subject: 'Model text test', text: 'Hi, I paid £10,000.00 today from GB82 WEST 1234 5698 7654 32.\nAmelia Hart' }))
await kit.ingest(eml({
  subject: 'KYC documents test',
  text: 'Please find my passport attached.',
  attachments: [
    { type: 'application/pdf', filename: 'passport.pdf', content: makePdf(['Passport scan']) },
    { type: 'application/pdf', filename: 'invoice.pdf', content: makePdf(['Invoice 1042 total GBP 1,200.00']) },
  ],
}))
await kit.ingest(eml({ from: 'Amelia Hart <amelia@hartfamily.example>', subject: 'I have paid', text: 'Hello, I have paid my Northwind commitment NW-001.', headers: AUTH }), at, TRUSTED)
await kit.ingest(eml({ from: 'Amelia Hart <amelia@hartfamily.example>', subject: 'New bank details', text: 'Please send any refund to my new account GB33 BUKB 2020 1555 5555 55.', headers: AUTH }), at, TRUSTED)
await kit.ingest(eml({ from: 'Amelia Hart <amelia@hartfamily.example>', subject: 'Bank letter please', text: 'Could you send me a letter confirming my investment for my bank?', headers: AUTH }), at, TRUSTED)
await kit.drain()

// the pipeline in the background, and a clock that ends cooling-off periods for the tests
let draining = false
setInterval(() => {
  if (draining) return
  draining = true
  void kit
    .drain()
    .then(() => kit.t.owner.query(`UPDATE verification_task SET completed_at = completed_at - interval '2 hours', cooling_until = cooling_until - interval '2 hours' WHERE state = 'checklist_done' AND cooling_until > now()`))
    .catch((e: Error) => console.error(e.message))
    .finally(() => (draining = false))
}, 300)

// plain http on 127.0.0.1: the only place cookies may go without Secure
const app = await buildServer({ db: kit.db, k: kit.k, files: kit.files, config: kit.config, queue: kit.boss, webRoot: 'dist/web', secureCookies: false })
await app.listen({ port: Number(process.env.PORT ?? 4317), host: '127.0.0.1' })

// test control (127.0.0.1 only): POST /ingest {from, subject, text} ingests a trusted mail
const control = createServer((req, res) => {
  // GET /audit?case=<id>: the audit types of a Case and whether each has before / after values (audit_detail)
  if (req.method === 'GET' && req.url?.startsWith('/audit?case=')) {
    const id = new URL(req.url, 'http://x').searchParams.get('case')
    void kit.db.query(`SELECT type, payload ? 'detail_sha256' AS detail FROM audit WHERE case_id = $1 ORDER BY seq`, [id]).then((r) => res.end(JSON.stringify(r.rows)))
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const m = JSON.parse(body || '{}') as { from: string; subject: string; text: string }
    void kit.ingest(eml({ from: m.from, subject: m.subject, text: m.text, headers: AUTH }), new Date().toISOString(), TRUSTED).then(
      (r) => res.end(JSON.stringify(r)),
      (e: Error) => res.writeHead(500).end(e.message),
    )
  })
})
control.listen(Number(process.env.CONTROL_PORT ?? 4318), '127.0.0.1')

const stop = async () => {
  control.close()
  await app.close()
  await kit.close()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
