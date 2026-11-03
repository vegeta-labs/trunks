// Rules D4 / test plan §1: every test-plan case due at the current milestone must have run and passed.
// Reads the Vitest JSON report; never searches source text.
// A case is due at the earliest 〔E…〕 tag on its line, or, without one, at its section's tag (test plan §2).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ORDER = ['E1', 'E2', 'E3', 'E4', 'E5']
const current = readFileSync('docs/milestone.txt', 'utf8').trim()
if (!ORDER.includes(current)) {
  console.log(`invalid milestone "${current}" in docs/milestone.txt (expected one of ${ORDER.join(', ')})`)
  process.exit(1)
}

export function dueCases(plan, milestone) {
  const due = []
  const untagged = []
  let section = null
  for (const line of plan.split('\n')) {
    if (/^#{2,3} /.test(line)) section = /〔(E\d)/.exec(line)?.[1] ?? null
    const m = /^- \*\*((?:TC|E2E)-[A-Z0-9]+-\d+[a-z]?|E2E-\d+)\*\*/.exec(line)
    if (!m) continue
    const id = m[1]
    const ms = /〔(E\d)/.exec(line)?.[1] ?? section
    if (!ms) {
      untagged.push(id)
      continue
    }
    if (ORDER.indexOf(ms) <= ORDER.indexOf(milestone)) due.push(id)
  }
  return { due, untagged }
}

const plan = readFileSync('docs/04_TEST_PLAN.md', 'utf8')
const { due, untagged } = dueCases(plan, current)
if (untagged.length) {
  console.log(`cases without a milestone: ${untagged.join(', ')}`)
  process.exit(1)
}
if (due.length === 0) {
  console.log('no cases are due — the test plan could not be read')
  process.exit(1)
}

// Every test whose title starts with the id must have passed; skipped or pending counts as not passed.
// Reports: Vitest JSON (unit and integration) and, when given, Playwright JSON (browser tests).
const results = new Map()
// a title may start with several ids: "TC-DRF-12 / TC-DRF-13 / TC-REV-04 …"
const ID = String.raw`(?:TC-[A-Z0-9]+-\d+[a-z]?|E2E-\d+)`
const LEAD = new RegExp(String.raw`^${ID}(?:\s*/\s*${ID})*\b`)
const record = (title, status) => {
  const lead = LEAD.exec(title)?.[0] ?? ''
  for (const id of lead.match(new RegExp(ID, 'g')) ?? []) results.set(id, [...(results.get(id) ?? []), status])
}
const reports = process.argv.slice(2).length ? process.argv.slice(2) : ['test-report.json']
for (const path of reports) {
  const report = JSON.parse(readFileSync(path, 'utf8'))
  if (report.testResults) {
    for (const file of report.testResults) for (const t of file.assertionResults) record(t.title, t.status)
  } else {
    const walk = (suite) => {
      for (const spec of suite.specs ?? []) record(spec.title, spec.ok ? 'passed' : 'failed')
      for (const s of suite.suites ?? []) walk(s)
    }
    for (const s of report.suites ?? []) walk(s)
  }
}

// cases that need the development history (test plan TC-OPS-07): not due where the commit does not exist, i.e. in the
// public repository, which starts with one commit and has no earlier public release to upgrade from (G3)
const NEEDS_HISTORY = { 'TC-OPS-07': '8ad8e91004d5a51c12a89dc54c1cb3ff15cc2cd8' }
for (const [id, sha] of Object.entries(NEEDS_HISTORY)) {
  if (!due.includes(id)) continue
  // a shallow checkout cannot tell «not in this repository» from «not fetched»: never exempt there (G3 self-test F1)
  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() !== 'false') {
    console.log(`${id}: shallow checkout, cannot tell whether commit ${sha.slice(0, 7)} exists (fetch the full history)`)
    process.exit(1)
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' })
  } catch {
    due.splice(due.indexOf(id), 1)
    console.log(`${id} not due here: commit ${sha.slice(0, 7)} is not in this repository (public snapshot)`)
  }
}
const missing = due.filter((id) => !results.has(id))
const failed = due.filter((id) => results.has(id) && results.get(id).some((s) => s !== 'passed'))
console.log(`milestone ${current}: ${due.length} cases due, ${due.length - missing.length - failed.length} passed`)
if (missing.length) console.log(`NOT RUN: ${missing.join(', ')}`)
if (failed.length) console.log(`FAILED: ${failed.join(', ')}`)
process.exit(missing.length || failed.length ? 1 : 0)
