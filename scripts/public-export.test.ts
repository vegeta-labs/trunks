// TC-OPS-05 (PRD decision 7, tech design v0.7.11): the public snapshot holds nothing private and runs on its own.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkPublic, exportPublic, readCuration } from './public-export.ts'

describe('public snapshot', () => {
  it('TC-OPS-05 nothing private in the export; in a fresh tree: typecheck, lint, rule tests, oracle self-check, evaluation', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'trunks-public-')), 'pub')
    // local runs add the private curation rules and names (outside the repository); CI checks the generic rules
    const files = exportPublic(out, process.env.PUBLIC_CURATION_FILE ? readCuration(process.env.PUBLIC_CURATION_FILE) : [])
    if (process.env.PUBLIC_CURATION_FILE) expect(files.unusedRules).toEqual([])
    // the owner's and reference platforms' names are kept outside the repository (FORBIDDEN_NAMES_FILE, local runs)
    const names = process.env.FORBIDDEN_NAMES_FILE ? readFileSync(process.env.FORBIDDEN_NAMES_FILE, 'utf8').split('\n') : []
    expect(checkPublic(out, names)).toEqual([])
    for (const p of ['docs/review', 'docs/HANDOFF.md', 'docs/DESIGN_JOURNAL.md', 'CLAUDE.md', 'docs/10_SITE_DEMO_INTERFACE.md']) expect(existsSync(join(out, p)), p).toBe(false)
    expect(files).toContain('AGENTS.md') // instructions for coding assistants are public (site plan 31)
    expect(files.filter((f) => f.startsWith('eval/dev/') && f.endsWith('.eml')).length).toBe(236)
    // the curation rules on their own: scripts/public-curate.test.ts (its hostile inputs are built at run time)
    // it runs: the same dependencies, a tree with nothing but the published files
    symlinkSync(resolve('node_modules'), join(out, 'node_modules'))
    const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: out, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }) // plain output: CI forces colours
    run('npm', ['run', '-s', 'typecheck'])
    run('npm', ['run', '-s', 'lint'])
    expect(run('npx', ['vitest', 'run', 'src/lib', '--reporter=dot'])).toMatch(/Test Files\s+\d+ passed/)
    run('python3', ['eval/oracle/selfcheck.py'])
    expect(run('npm', ['run', '-s', 'eval'])).toMatch(/PASS/)
  }, 900_000)
})
