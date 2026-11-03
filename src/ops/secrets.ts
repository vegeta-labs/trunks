// `doi init-secrets <dir>` (tech design v0.7.11): random passwords and keys for docker compose's file secrets.
// compose bind-mounts each file with its host mode and owner, and the containers run as other users (the application
// as 10001, Postgres as 999), so the files are 0644 inside a 0700 directory: readable in the containers, not by other
// users on the host (plan review R4). Existing files are never overwritten: a second run only adds what is missing.
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const password = () => randomBytes(24).toString('base64url')

/** The compose file's secret names → how each one is made (database URLs reuse the passwords written before them). */
export function secretPlan(read: (name: string) => string): Array<[string, () => string]> {
  const url = (role: string, pw: string) => `postgres://${role}:${read(pw)}@db:5432/doi`
  return [
    ['postgres_password', password],
    ['doi_app_db_password', password],
    ['doi_maintenance_db_password', password],
    ['doi_rotation_db_password', password],
    ['owner_database_url', () => url('postgres', 'postgres_password')],
    ['app_database_url', () => url('doi_app', 'doi_app_db_password')],
    ['maintenance_database_url', () => url('doi_maintenance', 'doi_maintenance_db_password')],
    ['rotation_database_url', () => url('doi_rotation', 'doi_rotation_db_password')],
    ['doi_master_keys', () => `k1:${randomBytes(32).toString('base64')}`],
    ['doi_hmac_key', () => randomBytes(32).toString('base64')],
    ['initial_admin_password', password],
    // compose needs the file even when another model provider is configured; empty until the operator fills it
    ['anthropic_api_key', () => ''],
  ]
}

export function initSecrets(dir: string): { created: string[]; kept: string[] } {
  mkdirSync(dir, { recursive: true })
  try {
    chmodSync(dir, 0o700)
  } catch (e) {
    // a directory Docker created for the bind mount belongs to root: the operator creates it first (plan review R4)
    if ((e as NodeJS.ErrnoException).code === 'EPERM') throw new Error(`cannot set the permissions of ${dir}: create the directory on the host first (mkdir -m 700 <dir>) and run with --user "$(id -u):$(id -g)"`)
    throw e
  }
  const read = (name: string) => readFileSync(join(dir, name), 'utf8').trim()
  const created: string[] = []
  const kept: string[] = []
  for (const [name, make] of secretPlan(read)) {
    const file = join(dir, name)
    if (existsSync(file)) {
      kept.push(name)
      continue
    }
    // `wx`: fails instead of replacing a file that appeared meanwhile
    writeFileSync(file, `${make()}\n`, { flag: 'wx', mode: 0o644 })
    chmodSync(file, 0o644)
    created.push(name)
  }
  return { created, kept }
}
