import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandFileVariables } from './env-files.ts'

describe('<NAME>_FILE variables', () => {
  it('TC-OPS-01 secrets as files: each fills its variable (the model key too); a variable already set wins', () => {
    const d = mkdtempSync(join(tmpdir(), 'doi-envf-'))
    writeFileSync(join(d, 'key'), 'sk-test-value\n')
    writeFileSync(join(d, 'other'), 'from-file\n')
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY_FILE: join(d, 'key'), SET_FILE: join(d, 'other'), SET: 'from-env', PLAIN: 'x' }
    expect(expandFileVariables(env).sort()).toEqual(['ANTHROPIC_API_KEY'])
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-value')
    expect(env.SET).toBe('from-env')
  })
})
