// Rules v0.3.1 G3 item 3: the judgement diff lists differing judgement files and leaves tests out.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script without types
import { isTest, judgementDiff, isJudgementInput } from './judgement-diff.mjs'

describe('judgement diff (rules G3 item 3)', () => {
  it('a commit against itself: nothing differs', () => {
    expect(judgementDiff('HEAD', 'HEAD')).toEqual([])
  })
  it('excludes only explicit UI, documentation, browser tests, CI and unit test paths', () => {
    expect(isTest('src/lib/directory.test.ts')).toBe(true)
    for (const f of ['src/web/App.tsx', 'docs/02_TECH_DESIGN.md', 'e2e/review.spec.ts', 'e2e-demo/static.spec.ts', '.github/workflows/ci.yml', 'README.md', 'CHANGELOG.md', 'src/lib/risk.test.ts']) expect(isJudgementInput(f), f).toBe(false)
    for (const f of ['src/main.ts', 'src/maintenance/kyc.ts', 'docs/milestone.txt', 'docs/01_PRD.md', 'docs/04_TEST_PLAN.md', 'src/lib/risk.ts', 'new-runtime-input.json']) expect(isJudgementInput(f), f).toBe(true)
  })
  it('runs as a command from a path with a space and through a symlink (self-test F3)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'jd-')), 'with space')
    mkdirSync(dir)
    cpSync('scripts/judgement-diff.mjs', join(dir, 'judgement-diff.mjs'))
    symlinkSync(dir, join(dir, '..', 'link'))
    for (const d of [dir, join(dir, '..', 'link')]) {
      const out = execFileSync('node', [join(d, 'judgement-diff.mjs'), 'HEAD', 'HEAD'], { encoding: 'utf8' })
      expect(out).toMatch(/no judgement-related file differs between HEAD and HEAD/)
    }
  })
  it('package files, the image and the server are judgement inputs (self-test F2)', () => {
    for (const f of ['package-lock.json', 'package.json', 'Dockerfile', 'src/server/auth.ts']) expect(isJudgementInput(f), f).toBe(true)
  })
})
