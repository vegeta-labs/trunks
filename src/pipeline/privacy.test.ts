import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createKit, type Kit } from './testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { makePdf } from '../../parser/testfiles.ts'

// realistic-format fictional values (PRD R-PRV-05, test plan TC-PRV-05a)
const SECRETS = {
  iban: 'GB82 WEST 1234 5698 7654 32',
  ibanCompact: 'GB82WEST12345698765432',
  account: '55779911',
  sortCode: '20-00-00',
  passport: '123456789',
  nino: 'QQ123456C',
  phone: '07700 900123',
  email: 'amelia.hart@hartfamily.example',
  name: 'Amelia Hart',
  subject: 'Bank details update for Northwind',
  filename: 'Amelia_statement.pdf',
  postcode: 'SW1A 1AA',
  messageId: 'secret-msgid-77@hartfamily.example',
}

// The exact audit fields that hold random hashes or ids, found from the rows this test writes (Codex E4 r9 N2). A field
// is skipped only at exactly this path and only when its value is a hex hash or a UUID; every other value is checked.
const HASH_OR_ID_PATHS = new Set([
  'actor', 'case_id', 'hash', 'prev_hash',
  ...['deal_key', 'dedupe_key_hmac', 'detail_sha256', 'file_sha256', 'input_identity', 'input_sha256', 'message_id',
    'raw_sans_msgid_sha256', 'raw_sha256', 'snapshot_id', 'task_id', 'version_id'].map((x) => `payload.${x}`),
])
const HASH_OR_UUID = /^([0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
function holdsAccountTail(v: unknown, path = ''): boolean {
  // a long random hash always has a letter; an all-digit value (an account number) is never skipped
  if (typeof v === 'string' && HASH_OR_ID_PATHS.has(path) && HASH_OR_UUID.test(v) && /[a-f]/i.test(v)) return false
  if (Array.isArray(v)) return v.some((x) => holdsAccountTail(x, `${path}[]`))
  if (v && typeof v === 'object') return Object.entries(v).some(([kk, x]) => holdsAccountTail(x, path ? `${path}.${kk}` : kk))
  return String(v).includes('5432')
}

let k: Kit
let caseId: string
beforeAll(async () => {
  k = await createKit()
  await k.importCsv('deals', 'name,currency\nNorthwind Robotics,GBP\n')
  await k.importCsv('contacts', `contact_id,name,email,phone,role,deal\nC001,${SECRETS.name},${SECRETS.email},${SECRETS.phone},investor,Northwind Robotics\n`)
  // every directory kind, with personal values in the free-text columns (self-test LK-F3)
  await k.importCsv('commitments', `investor_id,name,email,reference,cash_due\nc01,${SECRETS.name},${SECRETS.email},NW-001,"10,000.00"\n`, 'Northwind Robotics')
  await k.importCsv('bank', `transaction_id,date,amount,payer,reference\nT1,2026-10-06,10000.00,${SECRETS.name},${SECRETS.account}\n`, 'Northwind Robotics')
  await k.importCsv('ledger', `transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency\nT1,2026-10-06,10000.00,${SECRETS.name},${SECRETS.account},auto,c01,${SECRETS.name},auto,,GBP\n`, 'Northwind Robotics')
  const r = await k.ingest(eml({
    from: `${SECRETS.name} <${SECRETS.email}>`,
    subject: SECRETS.subject,
    messageId: `<${SECRETS.messageId}>`,
    text: `Please use ${SECRETS.iban}. Sort code ${SECRETS.sortCode}, account ${SECRETS.account}. Passport ${SECRETS.passport}, NI ${SECRETS.nino}. 1 Example Road, London ${SECRETS.postcode}. Call ${SECRETS.phone}.`,
    attachments: [{ type: 'application/pdf', filename: SECRETS.filename, content: makePdf([`Statement for account ${SECRETS.account} ${SECRETS.ibanCompact}`]) }],
  }))
  caseId = (r as { caseId: string }).caseId
  await k.drain()
}, 120_000)
afterAll(async () => k?.close())

async function dumpDatabase(): Promise<string> {
  const tables = (await k.t.owner.query(`SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('public', 'pgboss') AND table_type = 'BASE TABLE'`)).rows
  let all = ''
  for (const t of tables) {
    const rows = (await k.t.owner.query(`SELECT t::text AS r FROM "${t.table_schema}"."${t.table_name}" t`)).rows
    all += rows.map((x) => x.r).join('\n')
  }
  return all
}

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))

describe('encryption at rest and audit privacy', () => {
  it('TC-PRV-05a no sensitive value in clear in any table; files on disk are ciphertext', async () => {
    const dump = await dumpDatabase()
    expect(dump.length).toBeGreaterThan(1000)
    for (const [what, v] of Object.entries(SECRETS)) expect(dump.includes(v), what).toBe(false)
    expect(dump.toLowerCase().includes(SECRETS.email)).toBe(false)
    const root = (k.files as unknown as { root: string }).root
    const all = files(root)
    expect(all.length).toBeGreaterThanOrEqual(2)
    for (const f of all) {
      const b = readFileSync(f)
      expect(b.subarray(0, 4).toString()).toBe('DOI1')
      for (const v of [SECRETS.iban, SECRETS.name, SECRETS.subject, 'Content-Type', '%PDF']) expect(b.includes(v), `${f} ${v}`).toBe(false)
    }
  })
  it('TC-RED-03 the redaction map is ciphertext and the redacted text holds no original value', async () => {
    const rows = (await k.t.owner.query('SELECT r::text AS r FROM redaction_map r')).rows.map((x) => x.r).join('\n')
    expect(rows).toMatch(/\[ACCOUNT_1\]/)
    for (const v of Object.values(SECRETS)) expect(rows.includes(v)).toBe(false)
    const { stageResult } = await import('./stages.ts')
    const red = JSON.stringify(await stageResult(k.db, k.k, caseId, 'redact'))
    for (const v of [SECRETS.iban, SECRETS.ibanCompact, SECRETS.account, SECRETS.sortCode, SECRETS.passport, SECRETS.nino, SECRETS.phone, 'amelia.hart', 'Amelia', SECRETS.postcode]) {
      expect(red.includes(v), v).toBe(false)
    }
  })
  it('TC-AUD-06a audit rows hold no names, addresses, accounts, Message-ID or subject; the values are in audit_detail with matching hashes', async () => {
    const audit = (await k.t.owner.query('SELECT a::text AS r FROM audit a')).rows.map((x) => x.r).join('\n')
    for (const v of Object.values(SECRETS)) expect(audit.includes(v)).toBe(false)
    // not even account tails. Hash and id fields are random hex and may contain "5432" by chance (flaky before E4), so
    // only the listed fields with hash or UUID values are skipped (Codex E4 r8 F3, r9 N2)
    const rows = (await k.t.owner.query('SELECT to_jsonb(a) AS r FROM audit a')).rows.map((x) => x.r)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => holdsAccountTail(r))).toBe(false)
    // negative controls: a skipped name with a non-hash value, a lookalike key, a nested object or free text is still caught
    expect(holdsAccountTail({ hash: 'ab5432', payload: { account: '000012345698765432' } })).toBe(true)
    expect(holdsAccountTail({ payload: { account_id: '000012345698765432' } })).toBe(true)
    expect(holdsAccountTail({ payload: { task_id: 'acct 12345432' } })).toBe(true)
    expect(holdsAccountTail({ payload: { task_id: '000012345698765432' } })).toBe(true)
    expect(holdsAccountTail({ payload: { task_id: { account: '5432' } } })).toBe(true)
    expect(holdsAccountTail({ payload: { detail: { raw_sha256: 'ab5432ab5432ab5432' } } })).toBe(true)
    expect(holdsAccountTail({ payload: { detail_sha256: 'cd5432cd5432cd5432', note: 'ending 5432' } })).toBe(true)
    expect(holdsAccountTail({ hash: 'ab5432ab5432ab5432', case_id: '5432abcd-0000-4000-8000-000000000000', payload: { detail_sha256: 'cd5432cd5432cd5432' } })).toBe(false)
    const details = (await k.db.query(`SELECT payload->>'detail_sha256' AS sha FROM audit WHERE case_id = $1 AND payload ? 'detail_sha256'`, [caseId])).rows
    expect(details.length).toBeGreaterThan(0)
    const { getJson } = await import('../store/blobs.ts')
    const { sha256Hex } = await import('../lib/audit-hash.ts')
    for (const d of details) {
      const row = (await k.db.query('SELECT content_blob FROM audit_detail WHERE sha256 = $1', [d.sha])).rows[0]
      const content = await getJson<unknown>(k.db, k.k, row.content_blob)
      expect(sha256Hex(JSON.stringify(content))).toBe(d.sha)
    }
  })
  it('TC-AUD-03 (E1 part) receiving and processing a mail writes receipt, extraction and redaction records', async () => {
    const types = (await k.db.query('SELECT type FROM audit WHERE case_id = $1 ORDER BY seq', [caseId])).rows.map((r) => r.type)
    expect(types).toEqual(expect.arrayContaining(['ingest.received', 'signals.metadata', 'stage.extract', 'stage.redact']))
    const received = (await k.db.query(`SELECT payload FROM audit WHERE case_id = $1 AND type = 'ingest.received'`, [caseId])).rows[0].payload
    expect(received).toMatchObject({ dedupe_key_hmac: expect.stringMatching(/^[0-9a-f]{64}$/), raw_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
})
