// Codex E4 F12: the independent KYC comparison really compares. A system result flipped on purpose must be reported;
// with --require-attachments a file without the attachment export fails.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (dir: string, ...flags: string[]) => {
  try {
    return execFileSync('python3', ['eval/oracle/check_actual.py', ...flags, dir], { encoding: 'utf8' })
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? '')
  }
}
const att = (maybe_kyc: boolean) => ({ ordinal: 0, filename: 'passport.pdf', kind: 'pdf', parse_status: 'ok', pdf_pages: 1, pdf_pages_without_text: 0, text: 'Scan of the document', children: [], maybe_kyc })

describe('the oracle KYC comparison (test plan §3, C-RED-0)', () => {
  it('TC-RED-04 a flipped maybe_kyc is reported; the correct one is not; a missing export fails with --require-attachments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doi-kyc-oracle-'))
    writeFileSync(join(dir, 'classes.json'), '[]')
    writeFileSync(join(dir, 'calendar.json'), JSON.stringify({ timezone: 'Europe/London', start: '09:00', end: '18:00', holidays: [] }))
    writeFileSync(join(dir, 'K1.actual.json'), JSON.stringify({ id: 'K1', attachments: [att(false)] }))
    expect(run(dir)).toMatch(/K1 attachment 0 maybe_kyc system=(false|False) oracle=(true|True)/)
    writeFileSync(join(dir, 'K1.actual.json'), JSON.stringify({ id: 'K1', attachments: [att(true)] }))
    expect(run(dir)).not.toMatch(/K1 attachment 0 maybe_kyc/)
    writeFileSync(join(dir, 'K2.actual.json'), JSON.stringify({ id: 'K2' }))
    expect(run(dir, '--require-attachments')).toMatch(/K2 attachments missing/)
  })
})
