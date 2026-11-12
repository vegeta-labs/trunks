// The old-names check (rename plan §7): what it catches and what it leaves alone.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { findOldNames, OLD } from './check-old-names.ts'

describe('old product names', () => {
  const one = (file: string, text: string) => findOldNames([file], () => text)

  it('TC-OPS-12 every form of the old names is found, in any letter case', () => {
    for (const s of ['Deal Ops Inbox', 'Deal Ops Toolkit', 'deal-ops-inbox:local', 'DOI_SECRETS_DIR', 'doi_app', 'doi-parser', 'X-DealOps-Signature', 'x-dealops-signature', 'X-Deal-Ops-Removed', 'psql -d doi', 'globalThis.DOI_DEMO', 'doi.csrf', 'DOI1'])
      expect(one('README.md', `a ${s} b`), s).toHaveLength(1)
    expect(one('deploy/apparmor/doi-parser', '')).toEqual(['deploy/apparmor/doi-parser: file name'])
  })

  it('TC-OPS-12 the queue id, ordinary words and the new names are not', () => {
    for (const s of ['queue: deal_ops', 'the system\'s doing', 'trunks_app', 'TRUNKS_DEMO', 'avoid', 'X-Trunks-Signature']) expect(OLD.test(s), s).toBe(false)
  })

  it('TC-OPS-12 historical records keep their text; a current line in a design document does not', () => {
    expect(one('docs/review/2026-10-29_x.md', 'Deal Ops Inbox')).toEqual([])
    expect(one('CHANGELOG.md', 'Deal Ops Inbox is a self-hosted')).toEqual([])
    expect(one('docs/01_PRD.md', '| 2026-10-29 | v0.1 | 暂名 Deal Ops Inbox | 批准 |')).toEqual([])
    expect(one('docs/01_PRD.md', '- **R-OPS-01** 环境变量 `DOI_PORT`')).toHaveLength(1)
    // the real name of another repository is left alone, a leftover on the same line is not (code review, finding 1)
    expect(one('docs/04_TEST_PLAN.md', '- 保留集在私有仓库 `deal-ops/deal-ops-inbox-holdout`')).toEqual([])
    expect(one('docs/04_TEST_PLAN.md', '- 保留集在 `deal-ops/deal-ops-inbox-holdout`，cookie `doi_session`')).toHaveLength(1)
    expect(one('docs/02_TECH_DESIGN.md', '- cookie `doi_session`')).toHaveLength(1)
    expect(one('src/store/migrations/001_e1.sql', 'GRANT SELECT ON x TO doi_app;')).toEqual([])
    expect(one('src/store/migrations/011_next.sql', 'GRANT SELECT ON x TO doi_app;')).toHaveLength(1)
    expect(one('src/store/files.ts', "const MAGIC = Buffer.from('DOI1')")).toEqual([])
    expect(one('src/store/files.ts', "const DIR = '/var/lib/deal-ops-inbox'")).toHaveLength(1)
  })

  it('TC-OPS-12 this repository has none', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    const text = tracked.filter((f) => /\.(ts|tsx|mjs|json|ya?ml|md|css|html|sql|py|example)$|^(Dockerfile|deploy\/apparmor\/.*)$/.test(f) && f !== 'package-lock.json' && !/^eval\/(dev|replay)\//.test(f))
    expect(findOldNames(text, (f) => readFileSync(f, 'utf8'))).toEqual([])
  })
})
