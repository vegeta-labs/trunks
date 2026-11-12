// F1 through the pipeline and the review actions, on the test Postgres. The rules themselves: src/lib/payment-message.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createKit, FakeLlm, testConfig, type Kit } from './testkit.ts'
import { eml, type Part } from '../ingest/testmail.ts'
import { stageResult, type ClassifyResult } from './stages.ts'
import { effectiveLabels, type ReplyStageResult, type RiskStageResult } from './stages-e3.ts'
import { buildServer } from '../server/app.ts'
import { createSession, createUser } from '../server/auth.ts'
import { tx } from '../store/db.ts'
import { makePdf } from '../../parser/testfiles.ts'

const P = 'DE89370400440532013000'
const G = 'GB82WEST12345698765432'
const X = 'GB29NWBK60161331926819'
const UETR = '81cd69a7-85c3-46e1-b133-9d08c4210b21'
const DEALS = (list = G) => `name,currency,close_date,receiving_accounts\nNorthwind Robotics,GBP,2027-06-30,${list}\nLarkspur Energy Storage,USD,,\n`
const AUTH: Array<[string, string]> = [['Authentication-Results', 'mx.ops.example; spf=pass; dkim=pass; dmarc=pass']]
const TRUSTED = { id: 'ops', trustedAuthResults: true, trustedAuthservId: 'mx.ops.example' }

let k: Kit
let app: FastifyInstance
const llm = new FakeLlm()
const classes = new Map<string, string[]>()
const users: Record<string, { id: string; session: string; csrf: string }> = {}

beforeAll(async () => {
  llm.reply = (v, user) => {
    if (!v.startsWith('classify')) return '{"fields":{}}'
    const subject = /<subject>([^<]*)<\/subject>/.exec(user)?.[1] ?? ''
    const list = [...classes].find(([s]) => subject.includes(s))?.[1] ?? ['payment_evidence']
    return JSON.stringify({ labels: list.map((c) => ({ class: c.split(':')[0], confidence: c.split(':')[1] ?? 'high', reason: 'test' })), language: 'en' })
  }
  k = await createKit({ config: { ...testConfig(), verification: { cooling_off_hours: 1 } }, llm })
  await k.importCsv('deals', DEALS())
  await k.importCsv('commitments', 'investor_id,name,email,reference,cash_due\n001,Amelia Hart,amelia@hartfamily.example,NW-001,"9000.00"\n002,Oliver Bennett,oliver@bennettmail.example,NW-002,"9000.00"\n', 'Northwind Robotics')
  await k.importCsv('commitments', 'investor_id,name,email,reference,cash_due\n001,James Smith,james@smith.example,LK-001,"9000.00"\n', 'Larkspur Energy Storage')
  await k.importCsv('contacts', 'contact_id,name,email,phone,role,deal,investor_id\nC001,Amelia Hart,amelia@hartfamily.example,+44 7700 900101,investor,Northwind Robotics,Northwind Robotics::001\nC002,Oliver Bennett,oliver@bennettmail.example,+44 7700 900102,investor,Northwind Robotics,Northwind Robotics::002\n')
  app = await buildServer({ db: k.db, k: k.k, files: k.files, config: k.config, queue: k.boss })
  const root = await tx(k.db, (c) => createUser(c, k.k, { username: 'root', role: 'admin', password: null, by: null, mustChange: false }))
  for (const [name, role] of [['rita', 'reviewer'], ['paul', 'approver']] as const) {
    const id = await tx(k.db, (c) => createUser(c, k.k, { username: name, role, password: null, by: root, mustChange: false }))
    users[name] = { id, ...(await createSession(k.db, k.k, id, 1, 12)) }
  }
  await k.t.owner.query('UPDATE user_event SET at = $1', [new Date(Date.now() - 30 * 86_400_000).toISOString()])
  await k.ingest(eml({ from: 'Amelia Hart <amelia@hartfamily.example>', subject: 'Hello first', text: 'Hello', headers: AUTH }), '2026-10-01T09:00:00Z', TRUSTED)
  await k.ingest(eml({ from: 'Oliver Bennett <oliver@bennettmail.example>', subject: 'Hello first', text: 'Hello', headers: AUTH }), '2026-10-01T09:00:00Z', TRUSTED)
  await k.drain()
}, 120_000)
afterAll(async () => {
  await app?.close()
  await k?.close()
})

const as = (who: string) => ({ cookies: { trunks_session: users[who]!.session }, headers: { 'x-csrf-token': users[who]!.csrf } })
const post = (who: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload, ...as(who) })

const mt = (benef = `/${G}`, payer = `/${P}`, uetr = UETR, date = '261030') =>
  `{3:{121:${uetr}}}\n{4:\n:20:REF-2026-1\n:23B:CRED\n:32A:${date}GBP9000,00\n:50K:${payer}\nAMELIA HART\n:59:${benef}\nNORTHWIND SPV LP\n:70:NW-001\n:71A:SHA\n-}\n`
const txt = (content: string, filename = 'mt103.txt') => ({ filename, type: 'text/plain', content })
const NS = 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08'
const pacs = (cdtr = G) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="${NS}"><FIToFICstmrCdtTrf><GrpHdr><MsgId>M1</MsgId></GrpHdr><CdtTrfTxInf><PmtId><UETR>${UETR}</UETR></PmtId><IntrBkSttlmAmt Ccy="GBP">9000.00</IntrBkSttlmAmt><IntrBkSttlmDt>2026-10-30</IntrBkSttlmDt><Dbtr><Nm>AMELIA HART</Nm></Dbtr><DbtrAcct><Id><Othr><Id>87654321</Id></Othr></Id></DbtrAcct><CdtrAcct><Id><IBAN>${cdtr}</IBAN></Id></CdtrAcct><RmtInf><Ustrd>NW-001</Ustrd></RmtInf></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>`
const xmlPart = (content: string) => ({ filename: 'pacs008.xml', type: 'application/xml', content })

let n = 0
const ingest = async (cls: string[] | null, o: { text?: string; html?: string; subject?: string; attachments?: Part[]; from?: string; received?: string } = {}) => {
  const subject = `${o.subject ?? 'Confirmation'} ${++n}`
  if (cls) classes.set(subject, cls)
  const r = await k.ingest(eml({ from: o.from ?? 'Amelia Hart <amelia@hartfamily.example>', subject, text: o.text ?? 'Confirmation attached.', html: o.html, headers: AUTH, attachments: o.attachments }), o.received ?? '2026-11-02T10:00:00Z', TRUSTED)
  await k.drain()
  return (r as { caseId: string }).caseId
}
const view = async (id: string) => {
  const gen = (await k.db.query<{ g: number; queue: string | null }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [id])).rows[0]!.g
  const cls = (await stageResult<ClassifyResult>(k.db, k.k, id, 'classify'))!
  const risk = (await stageResult<RiskStageResult>(k.db, k.k, id, 'risk'))!
  const reply = (await stageResult<ReplyStageResult>(k.db, k.k, id, 'reply'))!
  const labels = await effectiveLabels(k, id, gen)
  const tasks = (await k.db.query<{ state: string; kind: string }>('SELECT state, kind FROM verification_task WHERE case_id = $1', [id])).rows
  return { exemption: cls.evidenceExemption, adopted: labels.adopted, risk: risk.final, clauses: risk.computed.clauses.filter((c) => c.hit).map((c) => c.id), template: reply.selection.template, actions: reply.actions.map((a) => a.action), tasks }
}

describe('C-CLS-4a through the pipeline', () => {
  it('TC-CLS-10 a qualifying MT103 and pacs.008: no bank details, no task; the template follows the ledger', async () => {
    const a = await view(await ingest(null, { attachments: [txt(mt())] }))
    expect(a.exemption).toMatchObject({ applied: true, payerLast4: ['3000'], beneficiaryLast4: ['5432'] })
    expect(a.adopted).toEqual(['payment_evidence'])
    expect(a.risk).toBe('medium')
    expect(a.template).not.toBe('safe_ack')
    expect(a.tasks).toEqual([])
    const b = await view(await ingest(null, { attachments: [xmlPart(pacs())] }))
    expect(b.exemption).toMatchObject({ applied: true, beneficiaryLast4: ['5432'] })
    expect(b.adopted).toEqual(['payment_evidence'])
  })
  it('TC-CLS-13 a beneficiary off the list: bank details, high, a task', async () => {
    const a = await view(await ingest(null, { attachments: [txt(mt(`/${X}`))] }))
    expect(a.adopted).toContain('bank_details')
    expect(a.risk).toBe('high')
    expect(a.template).toBe('safe_ack')
    expect(a.clauses).toContain('C-RSK-2:evidence_beneficiary_mismatch')
    expect(a.tasks.map((t) => t.kind)).toEqual(['bank_details'])
    const b = await view(await ingest(null, { attachments: [xmlPart(pacs(X))] }))
    expect(b.clauses).toContain('C-RSK-2:evidence_beneficiary_mismatch')
  })
  it('TC-CLS-13 no account shape: the risk step writes the rule label, and an approver cannot lower the template', async () => {
    const id = await ingest(null, { attachments: [txt(mt('/12345678', 'AMELIA HART'))] })
    const a = await view(id)
    expect(a.exemption).toBeNull() // nothing to exempt: the attachment has no account shape
    expect(a.adopted).toContain('bank_details')
    expect(a.template).toBe('safe_ack')
    expect(a.tasks.map((t) => t.kind)).toEqual(['bank_details'])
    // the fields step ran again for the label the risk step wrote: its fields were asked for (once)
    const asked = await stageResult<{ classes: string[]; fields: Array<{ field: string }> }>(k.db, k.k, id, 'fields')
    expect(asked!.classes).toContain('bank_details')
    expect(asked!.fields.map((f) => f.field)).toEqual(expect.arrayContaining(['party_role', 'account_last4', 'change_requested']))
    expect((await k.db.query<{ g: number }>('SELECT processing_generation AS g FROM "case" WHERE id = $1', [id])).rows[0]!.g).toBe(2)
    expect((await post('paul', `/api/cases/${id}/risk`, { level: 'medium', reason: 'checked' })).statusCode).toBe(200)
    await k.drain()
    const after = await view(id)
    expect(after.template).toBe('safe_ack')
    expect(after.tasks.some((t) => t.kind === 'bank_details' && t.state !== 'invalidated')).toBe(true) // the task is bound to the revision: a live one follows
    expect((await post('paul', `/api/cases/${id}/labels`, { remove: ['bank_details'], reason: 'no' })).statusCode).toBe(409)
  })
  it('TC-CLS-13 the link decides too: a reference to another deal, and a person changing the link', async () => {
    const other = await view(await ingest(null, { text: 'Confirmation for LK-001 attached.', attachments: [txt(mt())] }))
    expect(other.exemption).toMatchObject({ applied: false, reason: 'E3' })
    expect(other.adopted).toContain('bank_details')
    const id = await ingest(null, { attachments: [txt(mt())] })
    expect((await view(id)).exemption).toMatchObject({ applied: true })
    const put = await app.inject({ method: 'PUT', url: `/api/cases/${id}/links/commitment`, payload: { target: 'Larkspur Energy Storage::001' }, ...as('rita') })
    expect(put.statusCode).toBe(200)
    await k.drain()
    const after = await view(id)
    expect(after.clauses).toContain('C-RSK-2:evidence_beneficiary_mismatch')
    expect(after.adopted).toContain('bank_details')
    expect(after.template).toBe('safe_ack')
    expect((await app.inject({ method: 'GET', url: `/api/cases/${id}`, ...as('rita') })).json().e3.evidenceAccounts).toBeNull() // the line would now be false
    // back to the original link: the rule label stays, and so the line stays away
    expect((await app.inject({ method: 'PUT', url: `/api/cases/${id}/links/commitment`, payload: { target: 'Northwind Robotics::001' }, ...as('rita') })).statusCode).toBe(200)
    await k.drain()
    expect((await view(id)).adopted).toContain('bank_details')
    expect((await app.inject({ method: 'GET', url: `/api/cases/${id}`, ...as('rita') })).json().e3.evidenceAccounts).toBeNull()
  })
  it('TC-CLS-15 other attachments and a model label cancel it', async () => {
    const pdf = { filename: 'note.pdf', type: 'application/pdf', content: Buffer.from(makePdf(['some notes'])) }
    expect((await view(await ingest(null, { attachments: [txt(mt()), pdf] }))).exemption).toMatchObject({ applied: false, reason: 'E4' })
    const w = await view(await ingest(['payment_evidence', 'withdrawal:low'], { attachments: [txt(mt())] }))
    expect(w.exemption).toMatchObject({ applied: false, reason: 'E5' })
    expect(w.adopted).toContain('bank_details')
  })
  it('TC-CLS-16 an unauthenticated sender keeps the trigger', async () => {
    const subject = `Confirmation ${++n}`
    const r = await k.ingest(eml({ from: 'Amelia Hart <amelia@hartfamily.example>', subject, text: 'Confirmation attached.', headers: [['Authentication-Results', 'mx.ops.example; spf=none; dkim=none; dmarc=none']], attachments: [txt(mt())] }), '2026-11-02T10:00:00Z', TRUSTED)
    await k.drain()
    const a = await view((r as { caseId: string }).caseId)
    expect(a.exemption).toMatchObject({ applied: false, reason: 'E3' })
    expect(a.adopted).toContain('bank_details')
  })
  it('TC-CLS-17 a relink after importing the account keeps the label and the task', async () => {
    const id = await ingest(null, { attachments: [txt(mt(`/${X}`))] })
    expect((await view(id)).tasks.map((t) => t.kind)).toEqual(['bank_details'])
    await k.importCsv('deals', DEALS(`${G};${X}`))
    expect((await post('rita', `/api/cases/${id}/relink`)).statusCode).toBe(200)
    await k.drain()
    const after = await view(id)
    expect(after.exemption).toMatchObject({ applied: false, reason: 'E6' })
    // also when the safeguard came from the risk step and the message has no account shape (13e)
    expect(after.adopted).toContain('bank_details')
    expect(after.template).toBe('safe_ack')
    expect(after.tasks.some((t) => t.kind === 'bank_details' && t.state !== 'invalidated')).toBe(true)
    await k.importCsv('deals', DEALS())
  })
  it('TC-CLS-17 from a label the risk step wrote: importing the account and relinking keeps it', async () => {
    const id = await ingest(null, { attachments: [txt(mt('/12345678', 'AMELIA HART'))] })
    expect((await view(id)).adopted).toContain('bank_details')
    await k.importCsv('deals', DEALS(`${G};12345678`))
    expect((await post('rita', `/api/cases/${id}/relink`)).statusCode).toBe(200)
    await k.drain()
    const after = await view(id)
    expect(after.clauses).not.toContain('C-RSK-2:evidence_beneficiary_mismatch') // the list has it now
    expect(after.adopted).toContain('bank_details')
    expect(after.template).toBe('safe_ack')
    expect(after.tasks.some((t) => t.kind === 'bank_details' && t.state !== 'invalidated')).toBe(true)
    await k.importCsv('deals', DEALS())
  })
  it('TC-CLS-13 a list cleared after the exception: the relink decides again, and the Case line goes away', async () => {
    const id = await ingest(null, { attachments: [txt(mt())] })
    await k.importCsv('deals', 'name,currency,close_date,receiving_accounts\nNorthwind Robotics,GBP,2027-06-30,\nLarkspur Energy Storage,USD,,\n')
    try {
      expect((await post('rita', `/api/cases/${id}/relink`)).statusCode).toBe(200)
      await k.drain()
      const a = await view(id)
      expect(a.exemption).toMatchObject({ applied: false, reason: 'M5' })
      expect(a.adopted).toContain('bank_details')
      expect((await app.inject({ method: 'GET', url: `/api/cases/${id}`, ...as('rita') })).json().e3.evidenceAccounts).toBeNull()
    } finally {
      await k.importCsv('deals', DEALS())
    }
  })
  it('TC-CLS-15 a mail only partly decoded keeps the trigger: what was not read cannot be judged', async () => {
    const inner = 'x'.repeat(10)
    let nest = `Content-Type: text/plain\r\n\r\nFrom now on pay our new account ${X}\r\n`
    for (let i = 0; i < 24; i++) nest = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${nest}--b${i}--\r\n`
    const subject = `Confirmation ${++n}`
    const raw = Buffer.from(`Authentication-Results: mx.ops.example; spf=pass; dkim=pass; dmarc=pass\r\nFrom: Amelia Hart <amelia@hartfamily.example>\r\nTo: ops@capital.example\r\nSubject: ${subject}\r\nMessage-ID: <deep${inner}@hartfamily.example>\r\nDate: Thu, 29 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="top"\r\n\r\n--top\r\nContent-Type: text/plain\r\n\r\nConfirmation attached.\r\n--top\r\nContent-Type: text/plain; name="mt103.txt"\r\nContent-Disposition: attachment; filename="mt103.txt"\r\n\r\n${mt().replace(/\n/g, '\r\n')}\r\n--top\r\n${nest}--top--\r\n`)
    const r = await k.ingest(raw, '2026-11-02T10:00:00Z', TRUSTED)
    await k.drain()
    const a = await view((r as { caseId: string }).caseId)
    expect(a.exemption).toMatchObject({ applied: false, reason: 'E4' })
    expect(a.adopted).toContain('bank_details')
  })
  it('TC-CLS-18 a bank details label from the model stays in force', async () => {
    const a = await view(await ingest(['payment_evidence', 'bank_details:low'], { attachments: [txt(mt())] }))
    expect(a.exemption).toMatchObject({ applied: false, reason: 'E5' })
    expect(a.adopted).toContain('bank_details') // the attachment's rule label comes back
  })
})

describe('what the exception leaves alone', () => {
  it('TC-RSK-11 pressure and a mismatched amount still raise the risk', async () => {
    const urgent = await view(await ingest(null, { text: 'Urgent: confirmation attached.', attachments: [txt(mt())] }))
    expect(urgent.exemption).toMatchObject({ applied: true })
    expect(urgent.risk).toBe('high') // medium + the pressure step
    const amount = await view(await ingest(null, { text: 'I paid £8,000.00, confirmation attached.', attachments: [txt(mt())] }))
    expect(amount.clauses).toContain('C-RSK-2:amount_mismatch')
    expect(amount.risk).toBe('high')
  })
  it('TC-RSK-11 a first-time sender with an account is still high', async () => {
    const a = await view(await ingest(null, { from: 'Newcomer <newcomer@elsewhere.example>', attachments: [txt(mt())] }))
    expect(a.exemption).toMatchObject({ applied: false })
    expect(a.risk).toBe('high')
  })
  it('TC-RED-13 the model sees placeholders, exception or not', async () => {
    const before = llm.requests.length
    await ingest(null, { attachments: [txt(mt(`/${G}`, '/87654321'))] })
    await ingest(null, { attachments: [xmlPart(pacs())] })
    const sent = JSON.stringify(llm.requests.slice(before))
    for (const v of [G, '87654321']) expect(sent).not.toContain(v)
    expect(sent).toContain('[ACCOUNT_')
    // the second attachment too
    const before2 = llm.requests.length
    await ingest(null, { attachments: [txt('a note', 'note.txt'), xmlPart(pacs().replace(G, X))] })
    expect(JSON.stringify(llm.requests.slice(before2))).not.toContain('87654321')
  })
  it('TC-OUT-12 no bank event without the label, the Case page says what happened, and no full account anywhere', async () => {
    const id = await ingest(null, { attachments: [txt(mt())] })
    const ev = (await k.db.query<{ type: string }>('SELECT type FROM event_outbox WHERE case_id = $1', [id])).rows.map((r) => r.type)
    expect(ev).not.toContain('bank_details.change_requested')
    const page = await app.inject({ method: 'GET', url: `/api/cases/${id}`, ...as('rita') })
    expect(page.statusCode).toBe(200)
    expect(page.json().e3.evidenceAccounts).toEqual({ payer: ['3000'], beneficiary: ['5432'] })
    expect(page.body).not.toContain(`"${G}"`)
    const audit = JSON.stringify((await k.db.query('SELECT payload FROM audit WHERE case_id = $1', [id])).rows)
    expect(audit).toContain('"evidence_exemption":"applied"')
    for (const v of [G, P]) expect(audit).not.toContain(v)
    const modelLabel = await ingest(['payment_evidence', 'bank_details'], { attachments: [txt(mt())] })
    expect((await k.db.query<{ type: string }>('SELECT type FROM event_outbox WHERE case_id = $1', [modelLabel])).rows.map((r) => r.type)).toContain('bank_details.change_requested')
  })
  it('TC-DIR-10 the list keeps a hash and the last four only; old files import as before', async () => {
    const rows = (await k.t.owner.query<{ receiving_accounts: unknown }>('SELECT receiving_accounts FROM deal WHERE receiving_accounts IS NOT NULL')).rows
    expect(rows.length).toBeGreaterThan(0)
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain(G)
    expect(stored).toContain('"last4":"5432"')
    await expect(k.importCsv('deals', DEALS('GB82WEST12345698765431'))).rejects.toThrow()
    await k.importCsv('deals', DEALS())
    const denied = await app.inject({ method: 'POST', url: '/api/directory/deals', payload: DEALS(X), headers: { ...as('rita').headers, 'content-type': 'text/csv' }, cookies: as('rita').cookies })
    expect(denied.statusCode).toBe(403)
  })
})

describe('C-DRF-4 a confirmation already attached', () => {
  const late = '2026-11-20T10:00:00Z' // well over five working days after the value date
  it('TC-DRF-21 no second request for a confirmation that passes every check', async () => {
    const a = await view(await ingest(null, { attachments: [txt(mt())], received: late }))
    expect(a.template).toBe('payment_evidence_received')
    expect(a.actions).toContain('check_payment_evidence')
    expect(a.actions).not.toContain('request_payment_evidence')
    const b = await view(await ingest(null, { attachments: [txt(mt(undefined, undefined, 'not-a-uetr'))], received: late }))
    expect(b.template).toBe('payment_need_evidence')
    expect(b.actions).toContain('request_payment_evidence')
    // no ledger yet («unknown»): a recent date does not matter, as before only «not received» waits
    expect((await view(await ingest(null, { attachments: [txt(mt())], received: '2026-11-02T10:00:00Z' }))).template).toBe('payment_evidence_received')
  })
  it('TC-DRF-21 with a ledger: not received waits within five working days, received in full says so', async () => {
    const LEDGER = 'transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency\n'
    await k.importCsv('ledger', `${LEDGER}T1,2026-10-20,1000.00,A HART,NW-001,auto,001,Amelia Hart,,,GBP\n`, 'Northwind Robotics')
    expect((await view(await ingest(null, { attachments: [txt(mt())], received: '2026-11-02T10:00:00Z' }))).template).toBe('payment_wait')
    expect((await view(await ingest(null, { attachments: [txt(mt())], received: late }))).template).toBe('payment_evidence_received')
    await k.importCsv('ledger', `${LEDGER}T1,2026-10-20,9000.00,A HART,NW-001,auto,001,Amelia Hart,,,GBP\n`, 'Northwind Robotics')
    const full = await view(await ingest(null, { attachments: [txt(mt())], received: late }))
    expect(full.exemption).toMatchObject({ applied: true })
    expect(full.adopted).toEqual(['payment_evidence'])
    expect(full.template).toBe('payment_received') // the reported bug: an MT103 with IBANs and the ledger in full
  })
  it('TC-DRF-21 the disclosure gate still applies', async () => {
    const id = await ingest(null, { from: 'Oliver Bennett <oliver@bennettmail.example>', text: 'Confirmation for NW-001 attached.', attachments: [txt(mt('NORTHWIND SPV LP', 'A NAME'))], received: late })
    expect((await view(id)).template).toBe('safe_ack')
  })
})
