// The product was renamed (rename plan, docs/review/2026-11-12_rename_plan.md): no tracked file names it "Deal Ops
// Inbox / Toolkit", `deal-ops-inbox`, `DOI_*`, `doi_*`, `doi-*` or `X-DealOps-*` any more, except the historical
// records and the few lines listed here, each with its reason.
//   node --experimental-strip-types --no-warnings scripts/check-old-names.ts
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Old names. `deal_ops` (the queue id) and words that merely contain "doi" (doing) do not match. */
export const OLD = /deal[- ]?ops(?!_)|dealops|(?<![a-z0-9])doi(?![a-z0-9])|(?<![a-z0-9])doi1(?![a-z0-9])/i

/** Whole files that keep what was true when they were written, or that other repositories share byte for byte. */
const HISTORY: ReadonlyArray<RegExp> = [
  /^docs\/review\//, // raw reviews and plans
  /^docs\/HANDOFF\.md$/, /^docs\/DESIGN_JOURNAL\.md$/, /^docs\/10_SITE_DEMO_INTERFACE\.md$/, /^docs\/09_UI_DESIGN\.md$/,
  /^CHANGELOG\.md$/, // released entries, and the table of old and new names
  /^release\/public-manifest\.json$/, // the record of the last publication
  /^src\/store\/migrations\/00[1-9]b?_[^/]+\.sql$/, // released migrations never change; run with the role names replaced
  /^src\/web\/tokens\.css$/, // identical in three repositories; changed in all of them together
  /^scripts\/check-old-names(\.test)?\.ts$/,
]
/** Single lines elsewhere: [file, text the line contains, why]. */
const LINES: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^docs\/en\/REVIEW_SUMMARY\.md$/, 'called Deal Ops Inbox before v0.2.1', 'history'],
  [/^docs\/02_TECH_DESIGN\.md$/, '写的是 `doi_*` 角色名', 'describes the role rename'],
  [/^docs\/04_TEST_PLAN\.md$/, '旧代码用改名前的名字运行', 'TC-OPS-07 runs the old code under its old names'],
  [/^docs\/04_TEST_PLAN\.md$/, '只把三个角色名 `doi_app`', 'TC-OPS-11 names the roles it replaces'],
  [/^docs\/02_TECH_DESIGN\.md$/, '`DOI1`', 'the format tag that was kept'],
  [/^eval\/SCHEMA\.md$/, 'deal-ops-inbox-holdout', 'the holdout repository keeps its real name'],
  [/^src\/store\/migrate\.ts$/, 'doi_', 'the role names of the released migrations'],
  [/^src\/store\/migrate\.test\.ts$/, 'doi', 'the role names of the released migrations'],
  [/^src\/store\/migrations\/010_rename\.sql$/, 'doi_', 'the role names it replaces'],
  [/^src\/store\/files\.ts$/, "Buffer.from('DOI1')", 'format tag of stored files (not a visible name; kept, see the plan §4)'],
  [/^src\/pipeline\/privacy\.test\.ts$/, "toBe('DOI1')", 'the same format tag'],
  [/^deploy\/compose\.test\.ts$/, 'doi_', 'TC-OPS-07 runs the old code under its old names'],
  [/^deploy\/compose\.test\.ts$/, 'DOI_', 'TC-OPS-07 runs the old code under its old names'],
  [/^deploy\/compose\.test\.ts$/, '/var/lib/deal-ops-inbox/files', 'TC-OPS-07 runs the old code under its old names'],
  [/^deploy\/compose\.test\.ts$/, '(doi|trunks)', 'TC-OPS-07 asserts the old roles are gone'],
  [/^CLAUDE\.md$/, 'do not reintroduce', 'the rule itself'],
  [/^CLAUDE\.md$/, 'deal-ops-inbox-regressions', 'a real local path in a recorded exception'],
]
/** In the Chinese design documents the dated records keep their text: version line, decisions, change log, revisions. */
const RECORD_LINE = /^(版本 |\| 20\d\d-\d\d-\d\d \||\| \d+ \| )|^## v0\.7\.\d+ 修订/
/** Real names of other repositories and sites: taken out of a line before the rest of it is checked. */
const EXTERNAL = /deal-ops\/[a-z.-]+|deal-ops-(site|toolkit|inbox-holdout)[a-z.-]*/g

export function findOldNames(files: ReadonlyArray<string>, read: (f: string) => string): string[] {
  const out: string[] = []
  for (const f of files) {
    if (OLD.test(f) && !HISTORY.some((h) => h.test(f))) out.push(`${f}: file name`)
    if (HISTORY.some((h) => h.test(f))) continue
    const design = /^docs\/0[1234]_[A-Z_]+\.md$/.test(f)
    read(f).split('\n').forEach((line, i) => {
      if (!OLD.test(design ? line.replace(EXTERNAL, '') : line)) return
      if (design && RECORD_LINE.test(line)) return
      if (LINES.some(([file, text]) => file.test(f) && line.includes(text))) return
      out.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`)
    })
  }
  return out
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((f) => f && existsSync(f))
  const text = tracked.filter((f) => !/\.(png|ico|woff2?|pdf|gz|tgz|jpg|jpeg|gif|eml|bin)$/i.test(f) && !/^eval\/(dev|replay)\//.test(f) && f !== 'package-lock.json')
  const found = [...findOldNames(text, (f) => readFileSync(f, 'utf8')), ...tracked.filter((f) => !text.includes(f) && OLD.test(f)).map((f) => `${f}: file name`)]
  if (found.length) {
    console.error(`Old product names (see scripts/check-old-names.ts for the exceptions):\n  ${found.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`old names: none in ${text.length} files outside the historical records`)
}
