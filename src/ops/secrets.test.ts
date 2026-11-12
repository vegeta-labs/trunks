import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initSecrets } from './secrets.ts'
import { Keyring } from '../store/crypto.ts'

describe('init-secrets (tech design v0.7.11)', () => {
  it('TC-OPS-01 secret files: created once, never overwritten, 0644 in a 0700 directory, usable values', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'trunks-secrets-')), 's')
    const first = initSecrets(dir)
    expect(first.kept).toEqual([])
    expect(first.created).toContain('app_database_url')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const f of first.created) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o644)
    const read = (f: string) => readFileSync(join(dir, f), 'utf8').trim()
    // the URLs carry the passwords written beside them
    expect(read('app_database_url')).toBe(`postgres://trunks_app:${read('trunks_app_db_password')}@db:5432/trunks`)
    expect(read('owner_database_url')).toBe(`postgres://postgres:${read('postgres_password')}@db:5432/trunks`)
    // the keys load
    const k = Keyring.fromEnv({ TRUNKS_MASTER_KEYS: read('trunks_master_keys'), TRUNKS_HMAC_KEY: read('trunks_hmac_key') })
    expect(k.active.id).toBe('k1')
    // a second run keeps every file byte for byte
    const before = first.created.map(read)
    writeFileSync(join(dir, 'trunks_app_db_password'), 'operator-chosen\n')
    const second = initSecrets(dir)
    expect(second.created).toEqual([])
    expect(read('trunks_app_db_password')).toBe('operator-chosen')
    expect(first.created.filter((f) => f !== 'trunks_app_db_password').map(read)).toEqual(before.filter((_, i) => first.created[i] !== 'trunks_app_db_password'))
  })
})
