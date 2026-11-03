// Tech design §7: migrations only go forward. A migration file that is on the main branch never changes and is never
// removed; a schema change is a new file. Files that exist only on this branch may still change (Codex E1 round 2, N4).
// Usage: node scripts/check-migrations.mjs [base ref]; CI passes the pull request's base branch.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const DIR = 'src/store/migrations'
// CI: a pull request compares with its base branch, a push with the commit before the push (BASE_SHA; all zeros when
// the push created the branch)
const before = process.env.BASE_SHA ?? ''
const base = process.argv[2] ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : /[1-9a-f]/.test(before) ? before : 'HEAD^')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

// the first commit of a repository (the public snapshot, G3) has nothing released before it; only when no base was
// given and HEAD really has no parent, never because a named base is missing
// (a shallow checkout's boundary commit also shows no parent: never take this path there, G3 self-test F2)
if (!process.argv[2] && !process.env.GITHUB_BASE_REF && !/[1-9a-f]/.test(before) && git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length === 1) {
  if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') {
    console.error('check-migrations: shallow checkout, fetch more history (git fetch --unshallow)')
    process.exit(1)
  }
  console.log('migrations: first commit of this repository, nothing released before it')
  process.exit(0)
}
// an unknown base fails: the check must never pass because it could not look (self-review)
try {
  git('rev-parse', '--verify', `${base}^{commit}`)
} catch {
  console.error(`check-migrations: base ${base} is not a commit here (fetch it first)`)
  process.exit(1)
}
const listed = git('ls-tree', '--name-only', base, `${DIR}/`)
const released = listed.split('\n').filter((f) => f.endsWith('.sql')).map((f) => f.slice(DIR.length + 1)) // empty: the base has no migrations yet
const bad = []
for (const f of released) {
  const path = `${DIR}/${f}`
  if (!existsSync(path)) bad.push(`${path} was removed`)
  else if (readFileSync(path, 'utf8') !== git('show', `${base}:${path}`)) bad.push(`${path} was changed`)
}
if (bad.length) {
  console.error(`Released migrations must not change (compared with ${base}):\n  ${bad.join('\n  ')}\nAdd a new migration instead.`)
  process.exit(1)
}
console.log(`migrations: ${released.length} released file(s) unchanged (compared with ${base})`)
