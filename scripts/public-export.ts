// The public snapshot (PRD decision 7, tech design v0.7.11, TC-OPS-05):
//   node --experimental-strip-types scripts/public-export.ts <out dir>
// Copies the tracked files on the allow-list below into <out dir> (no history), writes the public versions of the
// Chinese design documents (no names, no local paths, no links to the unpublished review records, no research
// sources; the rules themselves unchanged), then checks the result. Names that must never appear (the owner's,
// reference platforms, compared products) are read from FORBIDDEN_NAMES_FILE, and the sentences that need a curated
// wording from PUBLIC_CURATION_FILE (`<exact text><TAB><public text>` per line); both are kept outside the
// repository, so this file holds none of them. A publication run needs both (Codex E5 F5).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** Published paths: a file, or a directory prefix ending in `/`. */
export const ALLOW = [
  'src/', 'parser/', 'scripts/', 'deploy/', 'e2e/', 'e2e-demo/', 'config/', 'data/', 'fixtures/',
  'eval/dev/', 'eval/oracle/', 'eval/replay/', 'eval/directory/', 'eval/config/', 'eval/clock.json', 'eval/validate', 'eval/SCHEMA.md', 'eval/annotation.schema.json',
  'docs/en/', 'docs/perf.md', 'docs/01_PRD.md', 'docs/02_TECH_DESIGN.md', 'docs/03_RULES_AND_REVIEW.md', 'docs/04_TEST_PLAN.md', 'docs/09_UI_DESIGN.md', 'docs/milestone.txt',
  'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'vitest.compose.config.ts', 'playwright.config.ts', 'playwright.demo.config.ts',
  'Dockerfile', 'docker-compose.yml', '.env.example', '.gitignore', '.dockerignore', '.gitattributes', '.github/workflows/ci.yml',
]
/** Never published, even below an allowed prefix. */
const DENY = [/(^|\/)[^/]* 2\.[^/]+$/] // iCloud duplicates
const allowed = (p: string) => ALLOW.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a)) && !DENY.some((d) => d.test(p))
// eval/*.ts sit directly in eval/ (runner, metrics): allowed one by one
const allowEvalTs = (p: string) => /^eval\/[^/]+\.ts$/.test(p)

/** The public version of a Chinese design document; `rules`: the private exact-text replacements, applied first. */
export function curate(text: string, rules: ReadonlyArray<readonly [string, string]> = []): string {
  for (const [from, to] of rules) text = text.split(from).join(to)
  return text
    .replace(/负责人：[^·（\n]+（产品）/g, '负责人：项目负责人（产品）')
    .replace(/存放在 Deal Ops Toolkit 的开发仓库[^。\n]*/g, '未公开')
    .replace(/`?(?:docs\/)?review\/[^\s`）)，、；]+`?/g, '（审查记录，未公开）')
    .replace(/`?(?:~\/|\/Users\/)[^\s`）)，、；]+`?/g, '（本机路径，未公开）')
}
const CURATED = new Set(['docs/01_PRD.md', 'docs/02_TECH_DESIGN.md', 'docs/03_RULES_AND_REVIEW.md', 'docs/04_TEST_PLAN.md', 'docs/09_UI_DESIGN.md'])

/** PUBLIC_CURATION_FILE: one `<exact text>\t<public text>` per line. */
export const readCuration = (file: string): Array<[string, string]> =>
  readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t', 2) as [string, string])

/** Exports; also returns the curation rules whose exact text was found in no document (stale rules). */
export function exportPublic(out: string, rules: ReadonlyArray<readonly [string, string]> = []): string[] & { unusedRules?: string[] } {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const files = tracked.filter((p) => (allowed(p) || allowEvalTs(p)) && existsSync(p)).sort()
  const used = new Set<string>()
  for (const p of files) {
    const to = join(out, p)
    mkdirSync(dirname(to), { recursive: true })
    if (CURATED.has(p)) {
      const text = readFileSync(p, 'utf8')
      for (const [from] of rules) if (text.includes(from)) used.add(from)
      writeFileSync(to, curate(text, rules))
    } else copyFileSync(p, to)
  }
  return Object.assign(files, { unusedRules: rules.map(([f]) => f).filter((f) => !used.has(f)) })
}

/** Everything that must not be in the public tree; empty means it may be published. */
export function checkPublic(out: string, forbiddenNames: string[] = []): string[] {
  const all = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? all(join(d, f)) : [join(d, f)]))
  const problems: string[] = []
  const names = forbiddenNames.map((n) => n.trim().toLowerCase()).filter(Boolean)
  for (const f of all(out)) {
    const rel = relative(out, f)
    if (/^(docs\/review\/|docs\/HANDOFF\.md$|docs\/DESIGN_JOURNAL\.md$|CLAUDE\.md$|docs\/10_SITE_DEMO_INTERFACE\.md$|\.claude\/)/.test(rel)) problems.push(`${rel}: not for publication`)
    if (/\.(png|jpg|jpeg|gif|woff2?|ico|pdf|bpf|gz|zip)$/i.test(rel)) continue
    const text = readFileSync(f, 'utf8')
    const low = text.toLowerCase()
    if (/(?:^|[\s`'"(（=:])(?:~\/(?:Documents|\.config|Library)|\/Users\/[a-z]|\/home\/[a-z])/m.test(text)) problems.push(`${rel}: a local path`)
    // the release notes are published only once their results are filled in (G3 Codex round 1 F3)
    if (rel === 'CHANGELOG.md' && /\b[A-Z]+_RESULTS\b/.test(text)) problems.push(`${rel}: a placeholder is not filled in`)
    if (/\(?(?:docs\/)?review\/20\d\d-/.test(text) && !rel.startsWith('scripts/')) problems.push(`${rel}: a link to the review records`)
    if (/sk-ant-[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}/.test(text)) problems.push(`${rel}: key material`)
    // every address-shaped token, `mailto:` and header values included; only URL user info (scheme://user:pass@host) is not an address
    for (const m of text.matchAll(/(^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+))/g)) {
      if (/:\/\/[^\s/@]*:$/.test(text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + m[1]!.length))) continue
      const domain = m[3]!.toLowerCase()
      const fictional = domain.endsWith('.example') || /^example\.(com|net|org)$/.test(domain) // RFC 2606 names
      // a quoted-printable line break can cut `.example` short inside a sample email
      const cut = rel.endsWith('.eml') && /\.e(x(a(m(p(l)?)?)?)?)?$/.test(domain) && text.charAt((m.index ?? 0) + m[0].length) === '='
      const allowedOther = /^(users\.noreply\.github\.com|anthropic\.com)$/.test(domain)
      if (!fictional && !cut && !allowedOther) problems.push(`${rel}: address ${m[2]}`)
    }
    // ASCII names as whole words (a short name may sit inside an ordinary word), others as substrings
    for (const n of names) if (/^[\x20-\x7e]+$/.test(n) ? new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(low) : low.includes(n)) problems.push(`${rel}: a forbidden name`)
  }
  // a sample ID named in any published text is a development-set sample (E9xxx: test placeholders): the holdout's
  // IDs and annotations stay private, also inside notes (Codex E5 round 3 F1; eval/QUESTIONS.md is not published)
  const devIds = new Set(existsSync(join(out, 'eval', 'dev')) ? readdirSync(join(out, 'eval', 'dev')).map((f) => f.slice(0, 5)) : [])
  for (const f of all(out)) {
    const rel = relative(out, f)
    if (rel.startsWith('eval/dev/') || rel.startsWith('eval/replay/') || /\.(png|jpg|jpeg|gif|woff2?|ico|pdf|bpf|gz|zip)$/i.test(rel)) continue
    // not a code point range such as E0000–E0FFF
    for (const m of readFileSync(f, 'utf8').matchAll(/(?<![\w+–-])E\d{4}(?![\w–-])/g)) if (!devIds.has(m[0]) && !m[0].startsWith('E9')) problems.push(`${rel}: sample ${m[0]} is not in eval/dev`)
  }
  // the evaluation samples: only the development set (the holdout lives in another repository)
  for (const f of all(join(out, 'eval')).map((f) => relative(out, f))) {
    if (/\.(eml|json)$/.test(f) && /\/E\d{4}\./.test(f) && !f.startsWith('eval/dev/') && !f.startsWith('eval/replay/')) problems.push(`${f}: an evaluation sample outside eval/dev`)
  }
  return [...new Set(problems)]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: public-export.ts <out dir>')
    process.exit(2)
  }
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty`)
  // a publication run: both private files are required (Codex E5 F5); the CI test calls the functions directly
  if (!process.env.FORBIDDEN_NAMES_FILE || !process.env.PUBLIC_CURATION_FILE) {
    console.error('refusing: a publication run needs FORBIDDEN_NAMES_FILE and PUBLIC_CURATION_FILE (kept outside the repository)')
    process.exit(2)
  }
  const rules = readCuration(process.env.PUBLIC_CURATION_FILE)
  const files = exportPublic(out, rules)
  const names = readFileSync(process.env.FORBIDDEN_NAMES_FILE, 'utf8').split('\n').filter((n) => n.trim())
  const problems = [...checkPublic(out, names), ...(files.unusedRules ?? []).map((r) => `curation rule not found in any document (stale?): ${r.slice(0, 40)}…`)]
  if (problems.length) {
    console.error(`not publishable:\n${problems.join('\n')}`)
    process.exit(1)
  }
  console.log(`${files.length} files in ${out}; ${names.length} names checked, ${rules.length} curation rules applied`)
}
