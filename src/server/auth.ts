// Users, roles and sessions (PRD R-REV-05, R-REV-06; tech design §5). Passwords: argon2id. Session and CSRF tokens
// live only in the cookie / the client; the database keeps their HMAC.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import argon2 from 'argon2'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { getText, putBlob } from '../store/blobs.ts'
import { appendAudit } from '../store/audit.ts'

export type Role = 'reviewer' | 'approver' | 'admin'
export const ROLE_RANK: Record<Role, number> = { reviewer: 1, approver: 2, admin: 3 }

export interface User {
  id: string
  username: string
  role: Role
  mustChangePassword: boolean
  credentialVersion: number // the version the password check saw
}

export const usernameHmac = (k: Keyring, u: string) => k.hmac(`user\0${u.trim().toLowerCase()}`)
const token = () => randomBytes(32).toString('base64url')

export const MIN_PASSWORD = 12

async function userRow(c: Pick<Tx, 'query'>, k: Keyring, where: string, arg: string): Promise<(User & { passwordHash: string | null; disabled: boolean }) | null> {
  const r = await c.query(`SELECT id, username_blob, role, must_change_password, password_hash, disabled, credential_version FROM app_user WHERE ${where} = $1`, [arg])
  const u = r.rows[0]
  if (!u) return null
  return { id: u.id, username: (await getText(c, k, u.username_blob))!, role: u.role, mustChangePassword: u.must_change_password, passwordHash: u.password_hash, disabled: u.disabled, credentialVersion: u.credential_version }
}

/** Create a user; writes user_event and audit (R-REV-05). `by` is null only for the initial admin. */
export async function createUser(c: Tx, k: Keyring, o: { username: string; role: Role; password: string | null; by: string | null; oidcSub?: string; mustChange?: boolean }): Promise<string> {
  if (o.password !== null && o.password.length < MIN_PASSWORD) throw new Error(`password must be at least ${MIN_PASSWORD} characters`)
  const id = randomUUID()
  await c.query('INSERT INTO app_user (id, username_blob, username_hmac, password_hash, must_change_password, role, oidc_sub_hmac) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    id, await putBlob(c, k, o.username), usernameHmac(k, o.username), o.password === null ? null : await argon2.hash(o.password, { type: argon2.argon2id }),
    o.mustChange ?? o.password !== null, o.role, o.oidcSub ? k.hmac(`oidc\0${o.oidcSub}`) : null,
  ])
  await c.query('INSERT INTO user_event (id, user_id, type, role, by_user) VALUES ($1, $2, $3, $4, $5), ($6, $2, $7, $4, $5)', [randomUUID(), id, 'created', o.role, o.by, randomUUID(), 'role_granted'])
  await appendAudit(c, k, [{ actor: o.by ?? 'system', type: 'user.created', payload: { user_id: id, role: o.role, via: o.oidcSub ? 'oidc' : 'local' } }])
  return id
}

export async function setRole(db: Db, k: Keyring, userId: string, role: Role, by: string): Promise<void> {
  await tx(db, async (c) => {
    const old = (await c.query<{ role: Role }>('SELECT role FROM app_user WHERE id = $1 FOR UPDATE', [userId])).rows[0]
    if (!old) throw new Error('no such user')
    if (old.role === role) return
    await c.query('UPDATE app_user SET role = $2 WHERE id = $1', [userId, role])
    await c.query('INSERT INTO user_event (id, user_id, type, role, by_user) VALUES ($1, $2, $3, $4, $5), ($6, $2, $7, $8, $5)', [
      randomUUID(), userId, 'role_removed', old.role, by, randomUUID(), 'role_granted', role,
    ])
    await appendAudit(c, k, [{ actor: by, type: 'user.role_changed', payload: { user_id: userId, from: old.role, to: role } }])
  })
}

/** Admin reset: a new temporary password that must be changed at the next login. */
export async function resetPassword(db: Db, k: Keyring, userId: string, newPassword: string, by: string): Promise<void> {
  if (newPassword.length < MIN_PASSWORD) throw new Error(`password must be at least ${MIN_PASSWORD} characters`)
  await tx(db, async (c) => {
    const r = await c.query('UPDATE app_user SET password_hash = $2, must_change_password = true, credential_version = credential_version + 1 WHERE id = $1', [userId, await argon2.hash(newPassword, { type: argon2.argon2id })])
    if (!r.rowCount) throw new Error('no such user')
    await c.query('INSERT INTO user_event (id, user_id, type, by_user) VALUES ($1, $2, $3, $4)', [randomUUID(), userId, 'credential_reset', by])
    await c.query('DELETE FROM app_session WHERE user_id = $1', [userId])
    await appendAudit(c, k, [{ actor: by, type: 'user.credential_reset', payload: { user_id: userId } }])
  })
}

/** Change one's own password; every other session of the user ends (a stolen session does not survive the change). */
export async function changeOwnPassword(db: Db, k: Keyring, userId: string, current: string, next: string, keepSessionHmac: string): Promise<boolean> {
  if (next.length < MIN_PASSWORD || next === current) return false
  return tx(db, async (c) => {
    const u = (await c.query<{ password_hash: string | null }>('SELECT password_hash FROM app_user WHERE id = $1 FOR UPDATE', [userId])).rows[0]
    if (!u?.password_hash || !(await argon2.verify(u.password_hash, current))) return false
    await c.query('UPDATE app_user SET password_hash = $2, must_change_password = false, credential_version = credential_version + 1 WHERE id = $1', [userId, await argon2.hash(next, { type: argon2.argon2id })])
    await c.query('DELETE FROM app_session WHERE user_id = $1 AND id_hmac <> $2', [userId, keepSessionHmac])
    // the session that made the change stays valid under the new version
    await c.query('UPDATE app_session SET credential_version = (SELECT credential_version FROM app_user WHERE id = $1) WHERE id_hmac = $2', [userId, keepSessionHmac])
    await appendAudit(c, k, [{ actor: userId, type: 'user.password_changed', payload: { user_id: userId } }])
    return true
  })
}

/** Local login; the same answer for an unknown user and a wrong password. */
export async function verifyLogin(db: Db, k: Keyring, username: string, password: string): Promise<User | null> {
  const u = await userRow(db, k, 'username_hmac', usernameHmac(k, username))
  if (!u || u.disabled || !u.passwordHash) {
    await argon2.hash(password, { type: argon2.argon2id }) // similar timing
    return null
  }
  if (!(await argon2.verify(u.passwordHash, password))) return null
  return { id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword, credentialVersion: u.credentialVersion }
}

export async function userByName(db: Db, k: Keyring, username: string): Promise<User | null> {
  return userRow(db, k, 'username_hmac', usernameHmac(k, username))
}

export async function userByOidcSub(db: Db, k: Keyring, sub: string): Promise<User | null> {
  const u = await userRow(db, k, 'oidc_sub_hmac', k.hmac(`oidc\0${sub}`))
  return u && !u.disabled ? { id: u.id, username: u.username, role: u.role, mustChangePassword: false, credentialVersion: u.credentialVersion } : null
}

/** A session is bound to the credential version the login checked: a password change in between voids it (Codex F12). */
/**
 * The CSRF token of a session (tech design v0.7.11, M-05 F4): derived from the session token with the deployment key, so
 * every tab of the signed-in browser can fetch it again from GET /api/csrf; it ends with the session. Its own prefix
 * keeps it apart from the stored values (plan review R12).
 */
export const csrfFor = (k: Keyring, session: string): string => k.hmac(`csrf-token\0${session}`)

export async function createSession(db: Db, k: Keyring, userId: string, credentialVersion: number, hours: number): Promise<{ session: string; csrf: string }> {
  const session = token()
  const csrf = csrfFor(k, session)
  // csrf_hmac is no longer read (migrations only go forward, the column stays); filled for the NOT NULL constraint
  await db.query('INSERT INTO app_session (id_hmac, user_id, csrf_hmac, credential_version, expires_at) VALUES ($1, $2, $3, $4, now() + $5 * interval \'1 hour\')', [k.hmac(`session\0${session}`), userId, k.hmac(`csrf\0${csrf}`), credentialVersion, hours])
  return { session, csrf }
}

export async function sessionUser(db: Db, k: Keyring, session: string | undefined): Promise<(User & { csrf: string; sessionHmac: string }) | null> {
  if (!session) return null
  const sh = k.hmac(`session\0${session}`)
  const r = await db.query('SELECT user_id, csrf_hmac, credential_version FROM app_session WHERE id_hmac = $1 AND expires_at > now()', [sh])
  if (!r.rows[0]) return null
  const u = await userRow(db, k, 'id', r.rows[0].user_id)
  if (!u || u.disabled || u.credentialVersion !== r.rows[0].credential_version) return null
  return { id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword, credentialVersion: u.credentialVersion, csrf: csrfFor(k, session), sessionHmac: sh }
}

export function csrfOk(expected: string, given: string | undefined): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const endSession = (db: Db, sessionHmac: string) => db.query('DELETE FROM app_session WHERE id_hmac = $1', [sessionHmac])

/** First start: an admin with the password from the secret file (tech design §5); never logged. */
export async function bootstrapAdmin(db: Db, k: Keyring, passwordFile: string | undefined): Promise<'created' | 'exists'> {
  const n = Number((await db.query('SELECT count(*)::int AS n FROM app_user')).rows[0].n)
  if (n > 0) return 'exists'
  if (!passwordFile) throw new Error('INITIAL_ADMIN_PASSWORD_FILE is required on first start')
  const password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '')
  await tx(db, (c) => createUser(c, k, { username: 'admin', role: 'admin', password, by: null, mustChange: true }))
  return 'created'
}
