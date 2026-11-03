// The static demo snapshot (PRD R-DEMO-02, tech design v0.7.11, TC-DEMO-04; site interface T1–T5):
//   node --experimental-strip-types scripts/demo-snapshot.ts <demo base URL> [--out dist-demo] [--version 0.1.0] [--commit <sha>]
// Signs in to a running, fully processed demo as demo-reviewer, takes the read-only API answers the review UI needs,
// names every case by its evaluation sample (T2), builds the UI in its static mode, and puts the answers in
// data/snapshot.js, loaded by a classic <script src> before the app (T1: the site's CSP has connect-src 'none').
// Then checks the result (no cookie, CSRF token, session ID or key material; only `.example` addresses; optional
// FORBIDDEN_NAMES_FILE, kept outside the repository, for rule P6) and packs it (T5):
//   deal-ops-inbox-demo-v<version>.tar.gz (no outer directory) + .sha256; inside, MANIFEST.sha256 and snapshot-info.json.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : fallback)
const base = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
if (!base) {
  console.error('usage: demo-snapshot.ts <demo base URL> [--out dist-demo] [--version x.y.z] [--commit sha]')
  process.exit(2)
}
const out = resolve(opt('--out', 'dist-demo'))
const version = opt('--version', (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version)
const commit = opt('--commit', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())

const login = await fetch(new URL('/api/login', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo-reviewer', password: 'demo-reviewer-password' }) })
if (!login.ok) throw new Error(`demo sign-in failed: ${login.status} (is this the demo?)`)
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!
const session = cookie.split('=')[1] ?? ''
const { csrf } = (await login.json()) as { csrf: string }
const get = async (path: string) => {
  const r = await fetch(new URL(path, base), { headers: { cookie } })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json() as Promise<Record<string, unknown>>
}

const builtAt = new Date().toISOString()
const sessionAnswer = await get('/api/session')
const meta = await get('/api/meta')
const { samples } = (await get('/api/demo')) as unknown as { samples: Record<string, string> }
const list = (await get('/api/cases?limit=200')) as { cases: Array<{ id: string; status: string }> }
if (list.cases.some((c) => c.status === 'processing')) throw new Error('the demo is still processing; wait until every case is done')
const missing = list.cases.filter((c) => !samples[c.id])
if (missing.length) throw new Error(`cases without a sample ID: ${missing.map((c) => c.id).join(', ')}`)
const details = Object.fromEntries(await Promise.all(list.cases.map(async (c) => [c.id, await get(`/api/cases/${c.id}`)] as const)))

// T2: every case UUID, wherever it appears (list, details, links to earlier cases), becomes its sample ID
let text = JSON.stringify({
  info: { version, built_at: builtAt },
  session: { ...sessionAnswer, warnings: [`Read-only snapshot of the demo, built ${builtAt.slice(0, 16).replace('T', ' ')} UTC.`, ...((sessionAnswer.warnings as string[] | undefined) ?? [])] },
  meta,
  cases: list.cases,
  details,
})
for (const [uuid, sample] of Object.entries(samples)) text = text.split(uuid).join(sample)

// ---------- the UI in its static mode ----------
rmSync(out, { recursive: true, force: true })
execFileSync('npx', ['vite', 'build', '--config', 'vite.config.ts', '--outDir', out, '--base', './', '--emptyOutDir'], { stdio: 'inherit', env: { ...process.env, VITE_STATIC_DEMO: '1', NODE_ENV: 'production' } }) // a production build also when run from the tests (NODE_ENV=test)
mkdirSync(join(out, 'data'), { recursive: true })
writeFileSync(join(out, 'data', 'snapshot.js'), `globalThis.DOI_DEMO = Object.freeze(${text});\n`)
// T1 / T3: the snapshot before the app; not for search engines
const indexPath = join(out, 'index.html')
const index = readFileSync(indexPath, 'utf8')
if (!/<script type="module"/.test(index)) throw new Error('index.html: no module script to load the snapshot before')
writeFileSync(indexPath, index.replace('<head>', '<head>\n    <meta name="robots" content="noindex" />').replace(/(\s*)<script type="module"/, '$1<script src="./data/snapshot.js"></script>$1<script type="module"'))
writeFileSync(join(out, 'snapshot-info.json'), `${JSON.stringify({ version, commit, built_at: builtAt }, null, 2)}\n`)

// ---------- checks (TC-DEMO-04) ----------
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))
const problems: string[] = []
const forbidden = process.env.FORBIDDEN_NAMES_FILE ? readFileSync(process.env.FORBIDDEN_NAMES_FILE, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean) : []
for (const f of files(out)) {
  if (!/\.(json|html|js|css|svg|txt)$/.test(f)) continue
  const body = readFileSync(f, 'utf8')
  const rel = relative(out, f)
  if (session && body.includes(session)) problems.push(`${rel}: the session token`)
  if (csrf && body.includes(csrf)) problems.push(`${rel}: the CSRF token`)
  if (/doi_session|doi_csrf|set-cookie/i.test(body)) problems.push(`${rel}: a cookie name`)
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bk1:[A-Za-z0-9+/]{40,}={0,2}/.test(body)) problems.push(`${rel}: key material`)
  if (rel === join('data', 'snapshot.js')) {
    for (const m of body.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) if (!/\.example$/i.test(m[1]!)) problems.push(`${rel}: address outside .example (${m[0]})`)
    if (/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.test(body) && Object.keys(samples).some((u) => body.includes(u))) problems.push(`${rel}: a case UUID left`)
  }
  for (const n of forbidden) if (body.toLowerCase().includes(n)) problems.push(`${rel}: a reference-platform name`)
}
if (problems.length) {
  console.error(`snapshot refused:\n${[...new Set(problems)].join('\n')}`)
  rmSync(out, { recursive: true, force: true })
  process.exit(1)
}

// ---------- the package (T5) ----------
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
const manifest = files(out).map((f) => relative(out, f).split('\\').join('/')).filter((p) => p !== 'MANIFEST.sha256').sort()
writeFileSync(join(out, 'MANIFEST.sha256'), manifest.map((p) => `${sha(join(out, p))}  ${p}\n`).join(''))
const tar = join(dirname(out), `deal-ops-inbox-demo-v${version}.tar.gz`)
execFileSync('tar', ['-czf', tar, '-C', out, ...readdirSync(out).sort()], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
writeFileSync(`${tar}.sha256`, `${sha(tar)}  ${basename(tar)}\n`)
console.log(`demo snapshot v${version}: ${list.cases.length} cases in ${out}; package ${basename(tar)} (${statSync(tar).size} bytes)${forbidden.length ? `; ${forbidden.length} names checked` : '; no name list given'}`)
