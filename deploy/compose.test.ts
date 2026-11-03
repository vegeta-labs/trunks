// Tests that drive docker compose (tech design v0.7.11): `npm run test:compose`, in the compose CI job only.
// Needs: the images (docker compose build), and for TC-DEMO-01 the evaluation's export of the same samples
// (EVAL_ACTUAL_DIR, written by `EVAL_ACTUAL_DIR=… npm run eval` before).
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { webkit, chromium } from '@playwright/test'
import { DEMO_SAMPLES } from '../src/ops/demo.ts'

const scratch = mkdtempSync(join(tmpdir(), 'doi-compose-'))
const secrets = join(scratch, 'secrets')
mkdirSync(secrets, { mode: 0o700 }) // as the quickstart says: the operator creates the directory first
execFileSync('docker', ['run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`, '-v', `${secrets}:/out`, 'deal-ops-inbox:local', 'init-secrets', '/out'])

type Stack = { project: string; files: string[]; env: Record<string, string> }
const compose = (s: Stack, ...args: string[]) =>
  execFileSync('docker', ['compose', '-p', s.project, ...s.files.flatMap((f) => ['-f', f]), ...args], { encoding: 'utf8', env: { ...process.env, DOI_SECRETS_DIR: secrets, ...s.env }, maxBuffer: 1 << 26 })
const composeTry = (s: Stack, ...args: string[]) =>
  spawnSync('docker', ['compose', '-p', s.project, ...s.files.flatMap((f) => ['-f', f]), ...args], { encoding: 'utf8', env: { ...process.env, DOI_SECRETS_DIR: secrets, ...s.env } })
const up: Stack[] = []
const start = (s: Stack) => {
  up.push(s)
  compose(s, 'up', '-d')
}
const stop = (s: Stack) => composeTry(s, 'down', '-v', '--remove-orphans')
afterAll(() => {
  for (const s of up) stop(s)
})

/** A request made from inside the app container (works on internal-only networks too). */
function inside(s: Stack, script: string): string {
  return compose(s, 'exec', '-T', 'app', 'node', '--input-type=module', '-e', script).trim()
}
const sql = (s: Stack, q: string) => compose(s, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'doi', '-Atc', q).trim()
async function until(what: string, ok: () => boolean, seconds = 600) {
  for (let i = 0; i < seconds / 5; i++) {
    try {
      if (ok()) return
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  throw new Error(`timed out waiting for ${what}`)
}
/** The address in the From header: headers unfolded, the last address-shaped token (display names may hold quotes). */
function fromAddress(raw: string): string {
  const head = raw.split(/\r?\n\r?\n/)[0]!.replace(/\r?\n[ \t]+/g, ' ')
  const line = /^From:(.*)$/im.exec(head)?.[1] ?? ''
  const all = [...line.matchAll(/[^\s<>"',;:]+@[^\s<>"',;]+/g)].map((m) => m[0])
  if (!all.length) throw new Error(`no From address in: ${line}`)
  return all.at(-1)!
}
/** Each secret file mounted on its own, as compose does: on Linux the 0700 directory itself is closed to uid 10001. */
const secretMounts = (dir: string) => readdirSync(dir).flatMap((f) => ['-v', `${join(dir, f)}:/s/${f}:ro`])
// every stored email file decrypted with the deployment's keys and compared with its recorded SHA-256 (self-test /
// Codex E5 F9): proves the files volume and the keys came back together
const VERIFY_FILES = `
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { Keyring } from '/app/src/store/crypto.ts'
import { DiskStore } from '/app/src/store/files.ts'
const v = (n) => process.env[n] ?? readFileSync(process.env[n + '_FILE'], 'utf8').trim()
const k = Keyring.fromEnv({ DOI_MASTER_KEYS: v('DOI_MASTER_KEYS'), DOI_HMAC_KEY: v('DOI_HMAC_KEY') })
const files = new DiskStore('/var/lib/deal-ops-inbox/files', k)
const c = new pg.Client({ connectionString: v('APP_DATABASE_URL') }); await c.connect()
const count = async (q) => {
  const rows = (await c.query(q)).rows
  let ok = 0
  for (const r of rows) if (createHash('sha256').update(await files.get(r.file_ref)).digest('hex') === r.sha256) ok++
  return ok + '/' + rows.length
}
// the stored emails and, separately stored, their attachments (G3 Codex round 1 F1)
console.log(await count('SELECT file_ref, sha256 FROM message_file') + ' ' + await count('SELECT file_ref, sha256 FROM attachment WHERE file_ref IS NOT NULL'))
await c.end()
`
const verifyFiles = (s: Stack) => compose(s, 'exec', '-T', '-w', '/app', 'app', 'node', '--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', VERIFY_FILES).trim()
/** All 4 stored emails and every stored attachment (at least one) decrypt to their recorded SHA-256. */
const expectFiles = (s: Stack) => {
  const m = /^4\/4 (\d+)\/(\d+)$/.exec(verifyFiles(s))
  expect(m, 'emails 4/4 and attachments n/n').not.toBeNull()
  expect(Number(m![2])).toBeGreaterThan(0)
  expect(m![1]).toBe(m![2])
}
const demoDone = (s: Stack) => () => sql(s, `SELECT count(*) FILTER (WHERE status = 'processing') || '/' || count(*) FROM "case"`) === `0/${DEMO_SAMPLES.length}`

// the demo's answers for every case, signed in as demo-reviewer from inside the app container
const DEMO_ANSWERS = `
const b = 'http://127.0.0.1:8080'
const r = await fetch(b + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo-reviewer', password: 'demo-reviewer-password' }) })
const cookie = r.headers.get('set-cookie').split(';')[0]
const list = await (await fetch(b + '/api/cases?limit=200', { headers: { cookie } })).json()
const out = []
for (const c of list.cases) {
  const d = await (await fetch(b + '/api/cases/' + c.id, { headers: { cookie } })).json()
  out.push({ receivedAt: c.receivedAt, from: c.from, classes: d.e3.adopted.map((x) => typeof x === 'string' ? x : x.classId).sort(), risk: d.e3.risk.final, template: d.e3.autoTemplate })
}
console.log(JSON.stringify(out))
`

describe('docker compose', () => {
  it('TC-DEMO-01 / TC-DEMO-02 the demo on networks without any way out: every demo email processed, each result equal to the evaluation; the directory is the evaluation one', async () => {
    const actual = process.env.EVAL_ACTUAL_DIR
    if (!actual) throw new Error('EVAL_ACTUAL_DIR is required (run the evaluation with it first)')
    const s: Stack = { project: 'doi-t-offline', files: ['docker-compose.yml', 'deploy/compose.demo.yml', 'deploy/compose.offline.yml'], env: {} }
    start(s)
    await until('the demo to finish processing', demoDone(s))
    expect(sql(s, `SELECT count(*) FROM "case" WHERE status = 'failed'`)).toBe('0')
    // the memory each container uses with the demo processed (self-audit S3: the quick start states it)
    const stats = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}', ...compose(s, 'ps', '-q').trim().split('\n')], { encoding: 'utf8' })
    appendFileSync('compose-memory.txt', `demo, offline, all ${DEMO_SAMPLES.length} emails processed (${new Date().toISOString()}):\n${stats}`)
    const mib = (v: string) => { const [n, u] = [parseFloat(v), v.replace(/[\d.]/g, '')]; return u.startsWith('GiB') ? n * 1024 : u.startsWith('KiB') ? n / 1024 : n }
    const total = stats.trim().split('\n').reduce((t, l) => t + mib(l.split('\t')[1]!.split('/')[0]!.trim()), 0)
    expect(total, `memory in use: ${total.toFixed(0)} MiB`).toBeLessThan(4096)
    // nothing outside is reachable from the app container
    expect(inside(s, `try { await fetch('https://example.com', { signal: AbortSignal.timeout(5000) }); console.log('reached') } catch { console.log('unreachable') }`)).toBe('unreachable')
    // per (receive time, sender): the twin samples share both, so a group is compared as a whole (multiset)
    const norm = (t: string) => new Date(t).toISOString()
    const key = (t: string, from: string) => `${norm(t)} ${from.toLowerCase()}`
    const demo = JSON.parse(inside(s, DEMO_ANSWERS)) as Array<{ receivedAt: string; from: string; classes: string[]; risk: string; template: string | null }>
    const group = new Map<string, string[]>()
    for (const d of demo) group.set(key(d.receivedAt, d.from), [...(group.get(key(d.receivedAt, d.from)) ?? []), JSON.stringify([d.classes, d.risk, d.template])].sort())
    const want = new Map<string, string[]>()
    for (const id of DEMO_SAMPLES) {
      const a = JSON.parse(readFileSync(join(actual, `${id}.actual.json`), 'utf8')) as { received_at: string; classes: string[]; risk: string; template: string | null }
      const from = fromAddress(readFileSync(join('eval', 'dev', `${id}.eml`), 'latin1'))
      const k = key(a.received_at, from)
      want.set(k, [...(want.get(k) ?? []), JSON.stringify([[...a.classes].sort(), a.risk, a.template])].sort())
    }
    expect(demo.length).toBe(DEMO_SAMPLES.length)
    // TC-DEMO-02 (PRD R-DEMO-01 v0.7.22): the demo directory is eval/directory — deals, currencies, commitments and
    // amounts due as in its files — and every page says so (not the Toolkit sample)
    const csvRows = (f: string) => readFileSync(join('eval', 'directory', f), 'utf8').trim().split(/\r?\n/).slice(1)
    const commitmentFiles = readdirSync(join('eval', 'directory')).filter((f) => f.startsWith('commitments_'))
    const wantDue = commitmentFiles.flatMap(csvRows).reduce((t, l) => t + Math.round(Number(l.split(',')[4]) * 100), 0)
    const wantCount = commitmentFiles.flatMap(csvRows).length
    expect(sql(s, 'SELECT count(*) || \'/\' || sum(cash_due_minor) FROM commitment')).toBe(`${wantCount}/${wantDue}`)
    expect(sql(s, "SELECT string_agg(currency, ',' ORDER BY currency) FROM deal")).toBe(csvRows('deals.csv').map((l) => l.split(',')[2]).sort().join(','))
    expect(inside(s, `
const b = 'http://127.0.0.1:8080'
const r = await fetch(b + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo-reviewer', password: 'demo-reviewer-password' }) })
const s = await (await fetch(b + '/api/session', { headers: { cookie: r.headers.get('set-cookie').split(';')[0] } })).json()
console.log(s.warnings.join(' '))`)).toMatch(/the evaluation set's fictional one, not the Toolkit sample/)
    expect(Object.fromEntries(group)).toEqual(Object.fromEntries(want))
    stop(s)
  })

  it('TC-DEMO-03 the demo: sign-in with WebKit and Chromium on http://localhost; the accounts listed; KYC transferred, not replaced', async () => {
    const s: Stack = { project: 'doi-t-demo', files: ['docker-compose.yml', 'deploy/compose.demo.yml'], env: { DOI_PORT: '18090' } }
    start(s)
    await until('the demo to finish processing', demoDone(s))
    for (const engine of [webkit, chromium]) {
      const b = await engine.launch()
      const page = await b.newPage()
      await page.goto('http://localhost:18090/')
      await page.getByText('Demo accounts').waitFor()
      await page.getByRole('button', { name: 'reviewer' }).click()
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.getByRole('heading', { name: 'Cases' }).waitFor({ timeout: 20_000 })
      await b.close()
    }
    // the KYC attachment went to the demo folder; the stored email was not replaced (PRD C-PRV-2's demo exception)
    await until('the KYC transfer', () => Number(sql(s, `SELECT count(*) FROM kyc_delivery WHERE state = 'delivered'`)) > 0, 180)
    compose(s, 'run', '--rm', '--no-deps', 'maintenance', 'maintain', '--once')
    expect(sql(s, 'SELECT count(*) FROM kyc_replacement')).toBe('0')
    // a second `up` while the demo runs resets it, and the app loads the demo again (PRD R-DEMO-01, self-test F7)
    sql(s, "UPDATE \"case\" SET hold = true") // a visible change that the reset must undo
    compose(s, 'up', '-d')
    await until('the demo after a second up', () => demoDone(s)() && sql(s, 'SELECT count(*) FROM "case" WHERE hold') === '0', 300)
    expect(sql(s, "SELECT count(*) FROM app_user")).toBe('3')
    // the static snapshot for TC-DEMO-04 (its Playwright spec runs next in the job)
    execFileSync('node', ['--experimental-strip-types', '--no-warnings', 'scripts/demo-snapshot.ts', 'http://127.0.0.1:18090'], { stdio: 'inherit' })
    stop(s)
  })

  it('TC-OPS-01 / TC-OPS-03 a real start: migrate first, admin must change the password, Secure cookie; each service only its own secrets', async () => {
    const s: Stack = { project: 'doi-t-real', files: ['docker-compose.yml'], env: { DOI_CONFIG_DIR: './eval/config', DOI_PORT: '18091' } }
    start(s)
    await until('the app', () => composeTry(s, 'exec', '-T', 'app', 'node', '-e', "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))").status === 0, 300)
    expect(compose(s, 'ps', '-a', '--format', '{{.Service}} {{.State}} {{.ExitCode}}')).toMatch(/migrate exited 0/)
    // the initial admin: password from the secret, must change it first; the session cookie is Secure
    const r = await fetch('http://127.0.0.1:18091/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: readFileSync(join(secrets, 'initial_admin_password'), 'utf8').trim() }) })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(true)
    expect(r.headers.get('set-cookie')).toMatch(/;\s*Secure/i)
    expect((await fetch('http://127.0.0.1:18091/api/demo')).status).toBe(404)
    // each service's environment and secret files (TC-OPS-03)
    const seen = (svc: string) => {
      const id = compose(s, 'ps', '-q', svc).trim()
      const i = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0] as { Config: { Env: string[] }; Mounts: Array<{ Destination: string }> }
      return `${i.Config.Env.join('\n')}\n${i.Mounts.map((m) => m.Destination).join('\n')}`
    }
    const app = seen('app')
    for (const x of ['MAINTENANCE_DATABASE', 'ROTATION_DATABASE', 'OWNER_DATABASE', 'doi_maintenance_db_password', 'doi_rotation_db_password', 'owner_database_url', 'postgres_password']) expect(app).not.toContain(x)
    const maintenance = seen('maintenance')
    for (const x of ['APP_DATABASE', 'ANTHROPIC', 'INITIAL_ADMIN', 'anthropic_api_key', 'initial_admin_password', 'app_database_url']) expect(maintenance).not.toContain(x)
    // every service of the compose file, the one-off tools included (self-test F4): exactly its own secrets
    const cfg = JSON.parse(compose({ ...s, env: { ...s.env } }, '--profile', 'tools', 'config', '--format', 'json')) as { services: Record<string, { secrets?: Array<{ source: string }> }> }
    const secretsOf = (svc: string) => (cfg.services[svc]!.secrets ?? []).map((x) => x.source).sort()
    expect(secretsOf('migrate')).toEqual(['doi_app_db_password', 'doi_maintenance_db_password', 'doi_rotation_db_password', 'owner_database_url'])
    expect(secretsOf('app')).toEqual(['anthropic_api_key', 'app_database_url', 'doi_hmac_key', 'doi_master_keys', 'initial_admin_password'])
    expect(secretsOf('maintenance')).toEqual(['doi_hmac_key', 'doi_master_keys', 'maintenance_database_url'])
    expect(secretsOf('rotate')).toEqual(['doi_hmac_key', 'doi_master_keys', 'rotation_database_url'])
    expect(secretsOf('gmail-auth')).toEqual(['app_database_url', 'doi_hmac_key', 'doi_master_keys'])
    expect(secretsOf('parser')).toEqual([])
    // serve no longer connects as the maintenance role (self-test F3): every doi_maintenance session comes from the
    // maintenance container
    const ipOf = (svc: string) => (JSON.parse(execFileSync('docker', ['inspect', compose(s, 'ps', '-q', svc).trim()], { encoding: 'utf8' }))[0] as { NetworkSettings: { Networks: Record<string, { IPAddress: string }> } }).NetworkSettings.Networks[`${s.project}_backend`]!.IPAddress
    const sessions = sql(s, "SELECT DISTINCT usename || ' ' || host(client_addr) FROM pg_stat_activity WHERE usename LIKE 'doi_%'").split('\n').filter(Boolean)
    expect(sessions).toContain(`doi_app ${ipOf('app')}`)
    expect(sessions.filter((x) => x.startsWith('doi_maintenance ')).every((x) => x === `doi_maintenance ${ipOf('maintenance')}`)).toBe(true)
    expect(sessions.some((x) => x === `doi_maintenance ${ipOf('app')}`)).toBe(false)
    // the chain head export lands in the state volume (TC-OPS-01, self-test F4)
    const head = () => compose(s, 'exec', '-T', 'app', 'cat', '/var/lib/deal-ops-inbox/state/audit-head.jsonl')
    await until('the chain head export', () => head().trim().length > 0, 60)
    const headBefore = head()
    expect(compose(s, 'logs', '--no-log-prefix', 'maintenance')).toMatch(/maintenance running/)
    expect(compose(s, 'run', '--rm', '--no-deps', 'maintenance', 'maintain', '--once')).not.toMatch(/refusing/)
    // gmail-auth --port: its callback is reachable from the host on 127.0.0.1 (plan review R5 / V2)
    const gcfg = join(scratch, 'gmail-config')
    cpSync('eval/config', gcfg, { recursive: true })
    const dep = readFileSync(join(gcfg, 'deployment.yaml'), 'utf8')
    writeFileSync(join(gcfg, 'deployment.yaml'), dep.replace(/^mailboxes:\n/m, 'mailboxes:\n  - id: deals\n    name: Deals\n    kind: gmail\n    gmail: { address: deals@capital.example, labels: [INBOX] }\n    catch_up_minutes: 5\n') + '\ngmail: { client_id_env: GMAIL_CLIENT_ID, client_secret_env: GMAIL_CLIENT_SECRET }\n')
    const g = { ...s, env: { ...s.env, DOI_CONFIG_DIR: gcfg } }
    compose(g, 'run', '-d', '--rm', '--service-ports', '-e', 'GMAIL_CLIENT_ID=test-client', '-e', 'GMAIL_CLIENT_SECRET=test-secret', 'gmail-auth', 'deals')
    let answer = ''
    await until('the gmail-auth callback', () => {
      answer = execFileSync('curl', ['-s', '--max-time', '3', 'http://127.0.0.1:8765/?state=not-the-state&code=x'], { encoding: 'utf8' })
      return answer.length > 0
    }, 60)
    expect(answer).toMatch(/Authorisation failed or was cancelled/)
    // the bundled HTTPS proxy (self-audit S2): sign-in through it; TRUST_PROXY names its fixed address
    // as the quick start says: COMPOSE_FILE keeps the operator's override (mailbox credentials) together with the proxy
    // file, so the HTTPS start does not drop it (Codex E5 F6)
    const override = join(scratch, 'docker-compose.override.yml')
    writeFileSync(override, 'services:\n  app:\n    environment:\n      DOI_OVERRIDE_PROBE: kept\n')
    const px = { ...s, files: [], env: { ...s.env, TRUST_PROXY: '172.30.99.10', DOI_DOMAIN: 'localhost', COMPOSE_FILE: ['docker-compose.yml', override, 'deploy/compose.proxy.yml'].join(':') } }
    compose(px, 'up', '-d')
    let viaProxy = ''
    await until('the proxy', () => {
      viaProxy = execFileSync('curl', ['-sk', '--max-time', '5', '-D', '-', '-o', '/dev/null', '-H', 'content-type: application/json', '--data', JSON.stringify({ username: 'admin', password: readFileSync(join(secrets, 'initial_admin_password'), 'utf8').trim() }), 'https://localhost/api/login'], { encoding: 'utf8' })
      return /^HTTP\/\S+ 200/m.test(viaProxy)
    }, 120)
    expect(viaProxy).toMatch(/set-cookie:[^\n]*;\s*Secure/i)
    expect(seen('app')).toContain('TRUST_PROXY=172.30.99.10')
    expect(seen('app')).toContain('DOI_OVERRIDE_PROBE=kept')
    compose(px, 'stop', 'proxy')
    // key rotation as compose runs it: the rotation role only, DOI_ACTIVE_KEY unset (docs review: it could not start)
    const keys = readFileSync(join(secrets, 'doi_master_keys'), 'utf8').trim()
    writeFileSync(join(secrets, 'doi_master_keys'), `${keys},k2:${Buffer.alloc(32, 7).toString('base64')}\n`)
    compose(s, 'up', '-d', '--force-recreate', 'app', 'maintenance')
    await until('the app with the new key', () => composeTry(s, 'exec', '-T', 'app', 'node', '-e', "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))").status === 0, 120)
    // a rebuilt app container still has the earlier chain head exports (they live in the state volume)
    expect(head().startsWith(headBefore)).toBe(true)
    expect(compose(s, 'run', '--rm', 'rotate')).toMatch(/rotation .* complete/)
    // a second `up` keeps the data (no reset outside the demo)
    sql(s, "CREATE TABLE IF NOT EXISTS compose_probe (x int); INSERT INTO compose_probe VALUES (1)")
    compose(s, 'up', '-d')
    expect(sql(s, 'SELECT count(*) FROM compose_probe')).toBe('1')
    stop(s)
    writeFileSync(join(secrets, 'doi_master_keys'), `${keys}\n`) // the next stacks start with the first key again
  })

  it('TC-OPS-08 / TC-OPS-09 users and directory exactly as docs/en/users-and-directory.md says: its commands and example files, run as written', async () => {
    // the page's marked blocks: `<!-- tested: run -->` shell blocks in order, `<!-- tested: file <name> -->` files
    const doc = readFileSync('docs/en/users-and-directory.md', 'utf8')
    const blocks = [...doc.matchAll(/<!-- tested: (run|file ([\w.-]+)) -->\n```\w*\n([\s\S]*?)```/g)]
    const work = join(scratch, 'users-and-directory')
    mkdirSync(work)
    for (const b of blocks) if (b[2]) writeFileSync(join(work, b[2]), b[3]!)
    expect(blocks.filter((b) => b[2]).map((b) => b[2])).toEqual(['deals.csv', 'contacts.csv', 'commitments.csv', 'bank.csv', 'ledger.csv'])
    const runs = blocks.filter((b) => !b[2]).map((b) => b[3]!)
    const run = runs.join('\n')
    // the only change: the address of this test deployment instead of the example domain
    const url = 'DOI_URL=https://inbox.capital.example\n'
    expect(run.split(url).length).toBe(2)
    const here = (x: string) => x.replace(url, 'DOI_URL=http://127.0.0.1:18096\n')
    const script = here(run)

    const s: Stack = { project: 'doi-t-users', files: ['docker-compose.yml'], env: { DOI_CONFIG_DIR: './eval/config', DOI_PORT: '18096' } }
    start(s)
    await until('the app', () => composeTry(s, 'exec', '-T', 'app', 'node', '-e', "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))").status === 0, 300)
    // quick start §2.5 first: the admin changes the initial password
    const b = 'http://127.0.0.1:18096'
    const r = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: readFileSync(join(secrets, 'initial_admin_password'), 'utf8').trim() }) })
    const { csrf } = (await r.json()) as { csrf: string }
    const pw = '  ops-08 admin password 1 ' // surrounding spaces: the page's prompts keep them (Codex E5 round 5 F2)
    expect((await fetch(`${b}/api/password`, { method: 'POST', headers: { cookie: r.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: readFileSync(join(secrets, 'initial_admin_password'), 'utf8').trim(), next: pw }) })).status).toBe(200)

    // the page's commands, with the names, roles and passwords typed at its prompts (none of them is in the page)
    expect(doc).not.toMatch(/first-password-/)
    const out = execFileSync('bash', ['-e', '-c', script], { cwd: work, input: `admin\n${pw}\nsam.reviewer\nreviewer\nfirst-password-sam-1\nalex.approver\napprover\nfirst-password-alex-1\n`, encoding: 'utf8' })
    expect(out.match(/\{"id":"[0-9a-f-]{36}"\}/g)).toHaveLength(2)
    expect(out.match(/"ok":true/g)).toHaveLength(5)
    expect(readdirSync(work)).not.toContain('doi-cookies.txt')
    expect(sql(s, "SELECT string_agg(role || '', ',' ORDER BY role) FROM app_user")).toBe('admin,approver,reviewer')
    expect(sql(s, "SELECT string_agg(kind, ',' ORDER BY kind) FROM directory_version")).toBe('bank,commitments,contacts,deals,ledger')
    expect(sql(s, 'SELECT count(*) FROM commitment')).toBe('2')
    expect(sql(s, 'SELECT count(*) FROM contact')).toBe('2')
    // the new user signs in and must choose a password first
    const sam = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sam.reviewer', password: 'first-password-sam-1' }) })
    expect(((await sam.json()) as { user: { role: string; mustChangePassword: boolean } }).user).toMatchObject({ role: 'reviewer', mustChangePassword: true })
    // a file with an error is refused as a whole, with its row number (the page's description)
    writeFileSync(join(work, 'bad.csv'), 'name,currency\nSolent Biotherapeutics,CHF\n')
    const bad = execFileSync('bash', ['-c', `${here(runs[0]!)}\ncurl -sS -b doi-cookies.txt -H "x-csrf-token: $CSRF" -H 'content-type: text/csv' --data-binary @bad.csv "$DOI_URL/api/directory/deals"; rm doi-cookies.txt`], { cwd: work, input: `admin\n${pw}\n`, encoding: 'utf8' })
    expect(bad).toMatch(/"where":"row 2, currency"/)
    // TC-OPS-09: the quick start's re-run command works in the image with the app's own secrets
    expect(compose(s, 'run', '--rm', 'app', 'rerun-failed')).toMatch(/no failed Cases/)
    stop(s)
  })

  it('TC-OPS-01 migrate fails → app and maintenance do not start', () => {
    const broken = join(scratch, 'broken')
    execFileSync('cp', ['-R', secrets, broken])
    writeFileSync(join(broken, 'owner_database_url'), 'postgres://postgres:wrong-password@db:5432/doi\n')
    const s: Stack = { project: 'doi-t-broken', files: ['docker-compose.yml'], env: { DOI_CONFIG_DIR: './eval/config', DOI_PORT: '18092', DOI_SECRETS_DIR: broken } }
    up.push(s)
    const r = composeTry(s, 'up', '-d')
    expect(r.status).not.toBe(0)
    const ps = compose(s, 'ps', '-a', '--format', '{{.Service}} {{.State}}')
    expect(ps).toMatch(/migrate exited/)
    expect(ps).not.toMatch(/app running/)
    expect(ps).not.toMatch(/maintenance running/)
    stop(s)
  })

  // TC-OPS-07 needs the development history (8ad8e91, before E5). The public repository starts with one commit and has
  // no earlier public release to upgrade from: there the data is made with the current images and only TC-OPS-06
  // (backup and restore) runs; scripts/check-coverage.mjs exempts TC-OPS-07 only when the commit does not exist (G3)
  // a shallow checkout would look like «no history» and silently drop TC-OPS-07: refuse it (G3 self-test F1)
  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() !== 'false') throw new Error('shallow checkout: fetch the full history (TC-OPS-07)')
  const HAS_E4 = spawnSync('git', ['cat-file', '-e', '8ad8e91004d5a51c12a89dc54c1cb3ff15cc2cd8^{commit}']).status === 0
  it(`${HAS_E4 ? 'TC-OPS-07 / ' : ''}TC-OPS-06 ${HAS_E4 ? 'upgrade from 8ad8e91, then ' : ''}backup and restore exactly as docs/en/backup-and-upgrade.md says`, async () => {
    // the code before E5 (8ad8e91: E4 + D8, no Dockerfile), run in a node container; dependencies are unchanged since
    const wt = join(scratch, 'e4')
    if (HAS_E4) {
      execFileSync('git', ['worktree', 'add', '--detach', wt, '8ad8e91'], { stdio: 'ignore' })
      mkdirSync(join(wt, 'node_modules')) // the mount point for this checkout's dependencies (the checkout is mounted read-only)
    }
    try {
      const P = 'doi-t-upgrade'
      const s: Stack = { project: P, files: ['docker-compose.yml'], env: { DOI_CONFIG_DIR: './eval/config', DOI_PORT: '18093' } }
      up.push(s)
      compose(s, 'create')
      compose(s, 'up', '-d', '--wait', 'db')
      execFileSync('docker', ['run', '--rm', '-v', `${P}_files:/v`, 'alpine:3.20', 'chown', '10001:10001', '/v'])
      const e4 = (...cmd: string[]) =>
        execFileSync('docker', ['run', '--rm', '--user', '10001:10001', '--network', `${P}_backend`,
          '-v', `${wt}:/app:ro`, '-v', `${resolve('node_modules')}:/app/node_modules:ro`, ...secretMounts(secrets), '-v', `${P}_files:/var/lib/deal-ops-inbox/files`, '-v', `${resolve('eval/dev')}:/samples:ro`, '-w', '/app',
          '-e', 'OWNER_DATABASE_URL_FILE=/s/owner_database_url', '-e', 'DOI_APP_DB_PASSWORD_FILE=/s/doi_app_db_password', '-e', 'DOI_MAINTENANCE_DB_PASSWORD_FILE=/s/doi_maintenance_db_password', '-e', 'DOI_ROTATION_DB_PASSWORD_FILE=/s/doi_rotation_db_password',
          '-e', 'APP_DATABASE_URL_FILE=/s/app_database_url', '-e', 'DOI_MASTER_KEYS_FILE=/s/doi_master_keys', '-e', 'DOI_HMAC_KEY_FILE=/s/doi_hmac_key', '-e', 'CONFIG_DIR=eval/config',
          'node:22-bookworm-slim', 'node', '--experimental-strip-types', '--no-warnings', 'src/main.ts', ...cmd], { encoding: 'utf8' })
      // emails with attachments (a pacs.008 XML, a passport PDF, an MT103 text file) and one without (Codex E5 F9)
      const samples = ['/samples/E0001.eml', '/samples/E0024.eml', '/samples/E0045.eml', '/samples/E0287.eml']
      if (HAS_E4) {
        e4('migrate')
        expect(e4('import-eml', 'ops', ...samples)).toMatch(/E0287\.eml: created/)
        expect(sql(s, "SELECT count(*) FROM schema_migrations WHERE name = '005_e5.sql'")).toBe('0')
      } else {
        compose(s, 'run', '--rm', 'migrate')
        expect(compose(s, 'run', '--rm', '--no-deps', '-v', `${resolve('eval/dev')}:/samples:ro`, 'app', 'import-eml', 'ops', ...samples)).toMatch(/E0287\.eml: created/)
      }

      // backup (docs: stop, tar every volume, copy the secrets)
      const B = join(scratch, 'backup')
      mkdirSync(B)
      compose(s, 'stop')
      for (const v of ['db', 'files', 'state', 'kyc']) execFileSync('docker', ['run', '--rm', '-v', `${P}_${v}:/v:ro`, '-v', `${B}:/b`, 'postgres:16', 'tar', '--numeric-owner', '-czf', `/b/${v}.tgz`, '-C', '/v', '.'])
      execFileSync('cp', ['-a', secrets, join(B, 'secrets')])

      // TC-OPS-07: the E5 images on the E4 data (without the history: the same images start on their own data)
      compose(s, 'up', '-d')
      await until('the upgraded app', () => composeTry(s, 'exec', '-T', 'app', 'node', '-e', "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))").status === 0, 300)
      expect(sql(s, "SELECT count(*) FROM schema_migrations WHERE name = '005_e5.sql'")).toBe('1')
      expect(sql(s, 'SELECT count(*) FROM message')).toBe('4')
      expect(compose(s, 'exec', '-T', 'app', 'node', '--experimental-strip-types', '--no-warnings', 'src/main.ts', 'audit', 'verify')).toMatch(/^ok: /)
      expectFiles(s)
      // the restore below runs while this deployment is still up, as the docs describe (Codex E5 round 2 F4)

      // TC-OPS-06: restore into a fresh project (docs: create, untar, up)
      const R: Stack = { project: 'doi-t-restore', files: [], env: { DOI_SECRETS_DIR: join(B, 'secrets'), DOI_CONFIG_DIR: './eval/config', DOI_PORT: '18094', COMPOSE_FILE: 'docker-compose.yml' } }
      up.push(R)
      compose(R, 'create')
      for (const v of ['db', 'files', 'state', 'kyc']) execFileSync('docker', ['run', '--rm', '-v', `doi-t-restore_${v}:/v`, '-v', `${B}:/b:ro`, 'postgres:16', 'sh', '-c', `cd /v && tar --numeric-owner -xzf /b/${v}.tgz`])
      compose(R, 'up', '-d')
      await until('the restored app', () => composeTry(R, 'exec', '-T', 'app', 'node', '-e', "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))").status === 0, 300)
      expect(compose(R, 'exec', '-T', 'app', 'node', '--experimental-strip-types', '--no-warnings', 'src/main.ts', 'audit', 'verify')).toMatch(/^ok: /)
      expect(sql(R, 'SELECT count(*) FROM message')).toBe('4')
      expectFiles(R)
      // the raw emails decrypt with the restored keys and files: the admin reads a Case's text
      const pw = readFileSync(join(B, 'secrets', 'initial_admin_password'), 'utf8').trim()
      const base = 'http://127.0.0.1:18094'
      let r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pw }) })
      let cookie = r.headers.get('set-cookie')!.split(';')[0]!
      const { csrf } = (await r.json()) as { csrf: string }
      expect((await fetch(`${base}/api/password`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: pw, next: 'restored-admin-password-1' }) })).status).toBe(200)
      r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'restored-admin-password-1' }) })
      cookie = r.headers.get('set-cookie')!.split(';')[0]!
      const list = (await (await fetch(`${base}/api/cases?limit=10`, { headers: { cookie } })).json()) as { cases: Array<{ id: string }> }
      expect(list.cases.length).toBe(4)
      const detail = (await (await fetch(`${base}/api/cases/${list.cases[0]!.id}`, { headers: { cookie } })).json()) as { text: string }
      expect(detail.text.length).toBeGreaterThan(20)
      stop(R)
      stop(s)
      if (!HAS_E4) return

      // going back (docs: restore the backup made before the upgrade and run the older version): the E4 code on it
      const back: Stack = { project: 'doi-t-back', files: ['docker-compose.yml'], env: { DOI_SECRETS_DIR: join(B, 'secrets'), DOI_CONFIG_DIR: './eval/config', DOI_PORT: '18095' } }
      up.push(back)
      compose(back, 'create')
      execFileSync('docker', ['run', '--rm', '-v', 'doi-t-back_db:/v', '-v', `${B}:/b:ro`, 'postgres:16', 'sh', '-c', 'cd /v && tar --numeric-owner -xzf /b/db.tgz'])
      compose(back, 'up', '-d', '--wait', 'db')
      expect(sql(back, "SELECT count(*) FROM schema_migrations WHERE name = '005_e5.sql'")).toBe('0')
      const verify = execFileSync('docker', ['run', '--rm', '--user', '10001:10001', '--network', 'doi-t-back_backend', '-v', `${wt}:/app:ro`, '-v', `${resolve('node_modules')}:/app/node_modules:ro`, ...secretMounts(join(B, 'secrets')), '-w', '/app',
        '-e', 'APP_DATABASE_URL_FILE=/s/app_database_url', 'node:22-bookworm-slim', 'node', '--experimental-strip-types', '--no-warnings', 'src/main.ts', 'audit', 'verify'], { encoding: 'utf8' })
      expect(verify).toMatch(/^ok: /)
      stop(back)
    } finally {
      if (HAS_E4) spawnSync('git', ['worktree', 'remove', '--force', wt])
    }
  })
})

