// Tech design §5 licence policy: application dependencies only MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD;
// development tools the same, plus the explicit exceptions below (each with its reason).
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'])
// package name → reason. Development tools only; never shipped.
const DEV_EXCEPTIONS = {
  // (none yet)
}
// package name → reason. Application dependencies, each approved by the owner (tech design §5).
const APP_EXCEPTIONS = {
  // owner 2026-10-30 「只给这个包开例外」: Unlicense (public-domain dedication, OSI-approved); reached only through
  // @anthropic-ai/sdk → standardwebhooks; the licence itself stays off the list
  'fast-sha256': 'Unlicense',
}

const ok = (expr) => {
  if (!expr) return false
  const s = String(expr).replace(/^\((.*)\)$/, '$1')
  if (s.includes(' OR ')) return s.split(' OR ').some((p) => ok(p.trim()))
  if (s.includes(' AND ')) return s.split(' AND ').every((p) => ok(p.trim()))
  return ALLOWED.has(s.trim())
}

function tree(omitDev) {
  const args = ['ls', '--all', '--json', '--long', ...(omitDev ? ['--omit=dev'] : [])]
  const out = execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  const seen = new Map()
  const walk = (deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      if (!d.path || seen.has(d.path)) continue
      const pkgFile = join(d.path, 'package.json')
      const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')) : {}
      const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : undefined)
      seen.set(d.path, { name, version: pkg.version, lic })
      walk(d.dependencies)
    }
  }
  walk(JSON.parse(out).dependencies)
  return [...seen.values()]
}

const prod = tree(true)
const prodNames = new Set(prod.map((p) => `${p.name}@${p.version}`))
const dev = tree(false).filter((p) => !prodNames.has(`${p.name}@${p.version}`))
const bad = [
  ...prod.filter((p) => !ok(p.lic) && APP_EXCEPTIONS[p.name] !== p.lic).map((p) => `app: ${p.name}@${p.version} ${p.lic ?? 'no licence'}`),
  ...dev.filter((p) => !ok(p.lic) && !(p.name in DEV_EXCEPTIONS)).map((p) => `dev: ${p.name}@${p.version} ${p.lic ?? 'no licence'}`),
]
for (const b of bad) console.log(b)
console.log(`${prod.length} application and ${dev.length} development packages checked; ${bad.length} not allowed`)
process.exit(bad.length ? 1 : 0)
