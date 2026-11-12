import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validate } from './validate.ts'

// the annotation example in eval/SCHEMA.md
const example = () => JSON.parse(/## 标注 JSON[^`]*```json\n([\s\S]*?)```/.exec(readFileSync(new URL('SCHEMA.md', import.meta.url), 'utf8'))![1]!)

function run(...annotations: Array<Record<string, unknown>>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'trunks-eval-'))
  for (const a of annotations) writeFileSync(join(dir, `${a.id}.json`), JSON.stringify(a))
  return validate([dir])
}

describe('eval/validate (test plan §4, eval/SCHEMA.md)', () => {
  it('TC-EVAL-01 the SCHEMA example passes; non-calendar dates, short multiple and missing class fields are rejected', () => {
    expect(run(example())).toEqual([])
    const badDate = { ...example(), received_at: '2026-99-99T10:15:00Z' }
    expect(run(badDate).join('\n')).toMatch(/not a calendar date|schema/)
    const badDay = example()
    badDay.fields.payment_date = '2026-02-30'
    expect(run(badDay).join('\n')).toMatch(/payment_date 2026-02-30 is not a calendar date/)
    // two spellings of one name are one value under the PRD §6 comparison
    const multiple = example()
    multiple.fields.payer_name = { multiple: ['Amelia Hart', 'amelia  HART'] }
    expect(run(multiple).join('\n')).toMatch(/payer_name multiple has 1 distinct value/)
    const sameMoney = example()
    sameMoney.fields.amount = { multiple: [{ minor: 100, currency: 'GBP' }, { minor: 100, currency: 'GBP' }] }
    expect(run(sameMoney).join('\n')).toMatch(/amount multiple has 1 distinct value/)
    const missing = example()
    delete missing.fields.uetr
    expect(run(missing).join('\n')).toMatch(/class payment_query needs field uetr/)
    const twin = { ...example(), id: 'E0002', twin_of: 'E0001' }
    expect(run(example(), twin).join('\n')).toMatch(/twin_of E0001 is not a prompt_injection sample/)
  })
})
