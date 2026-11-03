// TC-OPS-05 (PRD decision 7): the curation rules and the checks of the public export, on their own (fast). The
// hostile inputs are put together at run time, so this file itself passes the checks it tests (self-test F1).
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOW, checkPublic, curate } from './public-export.ts'

describe('public export rules', () => {
  it('TC-OPS-05 curation removes the owner line, review links, local paths and research sources; the checks catch each', () => {
    const HOME = '~' + '/Documents/x'
    const USERS = '/Us' + 'ers/someone/x'
    const LINUX = '/ho' + 'me/someone/project'
    const REVIEW = 'docs/rev' + 'iew/2026-10-29_x.md'
    const KEY = 'sk-' + 'ant-abcdefghijklmnop'
    const AT = '@'
    expect(curate(`· 负责人：某人（产品）· 见 \`${REVIEW.slice(5)}\`，路径 ${HOME}，存放在 Deal Ops Toolkit 的开发仓库 \`docs/x.md\`。`))
      .toBe('· 负责人：项目负责人（产品）· 见 （审查记录，未公开），路径 （本机路径，未公开），未公开。')
    const out = mkdtempSync(join(tmpdir(), 'doi-pubchk-'))
    mkdirSync(join(out, 'eval', 'other'), { recursive: true })
    writeFileSync(join(out, 'a.md'), `see ${USERS}\n`)
    writeFileSync(join(out, 'b.md'), `see ${REVIEW}\n`)
    writeFileSync(join(out, 'c.md'), `mail person${AT}realmail.test\n`)
    writeFileSync(join(out, 'd.md'), `key ${KEY}\n`)
    // self-test F9: a mailto link, a quoted path, a Linux home, an address right after a header colon
    writeFileSync(join(out, 'f.md'), `[me](mailto:someone${AT}realmail.test)\n`)
    writeFileSync(join(out, 'g.ts'), `const p = '${USERS}'\n`)
    writeFileSync(join(out, 'h.md'), `see ${LINUX}\n`)
    writeFileSync(join(out, 'i.eml'), `Reply-To:x${AT}realmail.test\n`)
    // URL user info is not an address
    writeFileSync(join(out, 'j.ts'), `const u = 'https://user:pw${AT}graph.microsoft.com/v1'\n`)
    writeFileSync(join(out, 'e.md'), 'the Probename platform, encoding\n')
    writeFileSync(join(out, 'eval', 'other', 'E9001.eml'), 'x')
    // a holdout-style ID inside a note (Codex E5 round 3 F1)
    writeFileSync(join(out, 'notes.md'), 'holdout E' + '0050 expected risk changed\n')
    writeFileSync(join(out, 'CHANGELOG.md'), 'Held-out set: HOLDOUT' + '_RESULTS\n')
    writeFileSync(join(out, 'ok.md'), 'investors@ops.example and alice@example.com, encoding, kodin.\n')
    const p = checkPublic(out, ['probename', 'od' + 'in']).sort()
    expect(p).toEqual(['a.md: a local path', 'b.md: a link to the review records', `c.md: address person${AT}realmail.test`, 'd.md: key material', 'CHANGELOG.md: a placeholder is not filled in', 'e.md: a forbidden name', 'eval/other/E9001.eml: an evaluation sample outside eval/dev', 'notes.md: sample E' + '0050 is not in eval/dev',
      `f.md: address someone${AT}realmail.test`, 'g.ts: a local path', 'h.md: a local path', `i.eml: address x${AT}realmail.test`].sort())
    for (const never of ['docs/review/', 'docs/HANDOFF.md', 'CLAUDE.md', 'docs/DESIGN_JOURNAL.md', 'eval/QUESTIONS.md']) expect(ALLOW.some((a) => never.startsWith(a) || a === never)).toBe(false)
  })
})
