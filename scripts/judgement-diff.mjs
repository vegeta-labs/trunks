// Rules v0.3.1 G3 item 3 (minor release): lists every judgement-related file that differs between two commits, so a
// release can quote the previous holdout result only when nothing differs, or when each difference is listed and shown
// to act only under conditions the holdout never meets.
//   node scripts/judgement-diff.mjs <base commit> [<head commit, default HEAD>]
// Prints the differing files (tests excluded) and exits 0 when none differ, 1 when some do.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Default to inclusion so new runtime, evaluation and deployment inputs cannot silently escape G3.
export const isTest = (f) => /\.test\.[cm]?[jt]sx?$/.test(f)
export const isJudgementInput = (f) => ['docs/milestone.txt', 'docs/01_PRD.md', 'docs/04_TEST_PLAN.md'].includes(f) || !(isTest(f)
  || ['src/web/', 'docs/', 'e2e/', 'e2e-demo/', '.github/'].some((p) => f.startsWith(p))
  || ['README.md', 'CHANGELOG.md'].includes(f))

export function judgementDiff(base, head = 'HEAD') {
  // Disable rename detection: a move out of an included path must still report its deletion.
  const out = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head, '--'], { encoding: 'utf8' })
  return out.split('\0').filter(Boolean).filter(isJudgementInput)
}

// run as a command, also from a path with spaces or through a symlink (self-test F3)
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const [base, head = 'HEAD'] = process.argv.slice(2)
  if (!base) {
    console.error('usage: judgement-diff.mjs <base commit> [<head commit>]')
    process.exit(2)
  }
  const files = judgementDiff(base, head)
  console.log(files.length ? `judgement-related files that differ between ${base} and ${head}:\n${files.map((f) => `  ${f}`).join('\n')}` : `no judgement-related file differs between ${base} and ${head}`)
  process.exit(files.length ? 1 : 0)
}
