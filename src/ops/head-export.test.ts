import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headExporter } from './head-export.ts'

describe('chain head export', () => {
  it('TC-AUD-07 missing directory is created; an export that cannot be written is reported once, not every time', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doi-head-'))
    const lines: string[] = []
    const ok = headExporter(async () => ({ seq: 7, hash: 'ab' }), join(root, 'state', 'nested', 'audit-head.jsonl'), (l) => lines.push(l))
    await ok()
    expect(readFileSync(join(root, 'state', 'nested', 'audit-head.jsonl'), 'utf8')).toBe('{"seq":7,"hash":"ab"}\n')
    expect(lines).toEqual([])
    // a file where the directory should be: cannot be created
    writeFileSync(join(root, 'blocker'), '')
    const bad = headExporter(async () => ({ seq: 1 }), join(root, 'blocker', 'audit-head.jsonl'), (l) => lines.push(l))
    await bad()
    await bad()
    await bad()
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/^chain head export failed: /)
  })
})
