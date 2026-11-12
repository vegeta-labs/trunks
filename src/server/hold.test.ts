// TC-PRV-10 (PRD R-REV-07): approver and admin set and clear «hold» with a reason; reviewer refused; audit rows carry
// the reason only in audit_detail; the list and the detail show the mark.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createKit, type Kit } from '../pipeline/testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { buildServer } from './app.ts'
import { createSession, createUser } from './auth.ts'
import { tx } from '../store/db.ts'

let k: Kit
let app: FastifyInstance
let caseId: string
const users: Record<string, { id: string; session: string; csrf: string }> = {}

beforeAll(async () => {
  k = await createKit()
  caseId = ((await k.ingest(eml({ subject: 'Complaint about fees', messageId: '<hold1@x.example>' }))) as { caseId: string }).caseId
  await k.drain()
  app = await buildServer({ db: k.db, k: k.k, files: k.files, config: k.config, queue: k.boss })
  const root = await tx(k.db, (c) => createUser(c, k.k, { username: 'root', role: 'admin', password: null, by: null, mustChange: false }))
  for (const [name, role] of [['rita', 'reviewer'], ['paul', 'approver'], ['adam', 'admin']] as const) {
    const id = await tx(k.db, (c) => createUser(c, k.k, { username: name, role, password: null, by: root, mustChange: false }))
    users[name] = { id, ...(await createSession(k.db, k.k, id, 1, 12)) }
  }
}, 60_000)
afterAll(async () => {
  await app?.close()
  await k?.close()
})

const as = (who: string) => ({ cookies: { trunks_session: users[who]!.session }, headers: { 'x-csrf-token': users[who]!.csrf } })
const hold = (who: string, payload: object) => app.inject({ method: 'POST', url: `/api/cases/${caseId}/hold`, payload, ...as(who) })

describe('TC-PRV-10 hold', () => {
  it('TC-PRV-10 reviewer is refused; an empty reason is refused; approver sets, admin clears; audit and display', async () => {
    expect((await hold('rita', { hold: true, reason: 'dispute' })).statusCode).toBe(403)
    expect((await hold('paul', { hold: true, reason: '  ' })).statusCode).toBe(400)
    expect((await hold('paul', { hold: 'yes', reason: 'x' })).statusCode).toBe(400)
    const set = await hold('paul', { hold: true, reason: 'Investor dispute over the fee CANARY-HOLD' })
    expect(set.statusCode).toBe(200)
    expect((await hold('paul', { hold: true, reason: 'again' })).statusCode).toBe(409)

    const list = ((await app.inject({ method: 'GET', url: '/api/cases', ...as('rita') })).json() as { cases: Array<{ id: string; hold: boolean }> }).cases
    expect(list.find((c) => c.id === caseId)?.hold).toBe(true)
    const detail = (await app.inject({ method: 'GET', url: `/api/cases/${caseId}`, ...as('rita') })).json() as { hold: boolean; holdReason: string }
    expect(detail).toMatchObject({ hold: true, holdReason: 'Investor dispute over the fee CANARY-HOLD' })

    expect((await hold('adam', { hold: false, reason: 'Resolved' })).statusCode).toBe(200)
    const row = (await k.t.owner.query<{ hold: boolean; hold_reason_blob: string | null }>('SELECT hold, hold_reason_blob FROM "case" WHERE id = $1', [caseId])).rows[0]!
    expect(row).toEqual({ hold: false, hold_reason_blob: null })

    const audit = await k.t.owner.query<{ type: string; actor: string; payload: unknown }>("SELECT type, actor, payload FROM audit WHERE case_id = $1 AND type LIKE 'case.hold%' ORDER BY seq", [caseId])
    expect(audit.rows.map((r) => [r.type, r.actor])).toEqual([['case.hold_set', users.paul!.id], ['case.hold_cleared', users.adam!.id]])
    expect(JSON.stringify(audit.rows)).not.toContain('CANARY-HOLD')
    expect((await k.t.owner.query('SELECT 1 FROM audit_detail WHERE case_id = $1', [caseId])).rowCount).toBeGreaterThan(0)
  })
})
