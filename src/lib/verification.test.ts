import { describe, expect, it } from 'vitest'
import { approvalFailures, canApprove, CHECKLIST, invalidated, phoneOnFile, taskContact, taskFieldContent, type ApproveInput, type UserEvent } from './verification.ts'

const H = 3_600_000
const day = 24 * H
const ev = (userId: string, type: UserEvent['type'], at: string, byUser: string | null = 'root', role: string | null = null): UserEvent => ({ userId, type, role, byUser, at })
const history: UserEvent[] = [
  ev('alice', 'created', '2026-09-01T09:00:00Z', 'root', 'reviewer'), ev('alice', 'role_granted', '2026-09-01T09:00:00Z', 'root', 'reviewer'),
  ev('bob', 'created', '2026-09-01T09:00:00Z', 'root', 'approver'), ev('bob', 'role_granted', '2026-09-01T09:00:00Z', 'root', 'approver'),
]
const base: ApproveInput = {
  completedBy: 'alice', approver: { id: 'bob', role: 'approver' }, checklistDoneAt: '2026-10-29T10:00:00Z', now: '2026-10-30T10:00:00Z', coolingMs: day,
  events: history, currentRoles: { alice: 'reviewer', bob: 'approver' },
}
const reason = (o: Partial<ApproveInput>) => {
  const r = canApprove({ ...base, ...o })
  return r.ok ? 'ok' : r.reason
}

describe('two-person condition and cooling-off (C-FRD-5)', () => {
  it('passes when every condition holds', () => expect(reason({})).toBe('ok'))
  it('TC-FRD-07 the same user, or not an approver', () => {
    expect(reason({ approver: { id: 'alice', role: 'approver' } })).toBe('You ticked the checklist, so a different person must approve.')
    expect(reason({ approver: { id: 'bob', role: 'reviewer' } })).toMatch(/approver role/)
  })
  it('TC-FRD-07 created, granted or reset by the other — either direction, at any time', () => {
    expect(reason({ events: [...history, ev('bob', 'role_granted', '2026-09-02T09:00:00Z', 'alice', 'approver')] })).toMatch(/granted a role/)
    expect(reason({ events: [...history.filter((e) => e.userId !== 'alice'), ev('alice', 'created', '2026-09-01T09:00:00Z', 'bob', 'reviewer'), ev('alice', 'role_granted', '2026-09-01T09:00:00Z', 'root', 'reviewer')] })).toMatch(/created/)
    // A once reset B's credentials, later someone else reset them again: still refused
    expect(reason({ events: [...history, ev('bob', 'credential_reset', '2026-09-05T09:00:00Z', 'alice'), ev('bob', 'credential_reset', '2026-09-10T09:00:00Z', 'root')] })).toMatch(/reset the credentials/)
  })
  it('TC-FRD-07 a recent reset, a new account or a new role', () => {
    expect(reason({ events: [...history, ev('bob', 'credential_reset', '2026-10-29T08:00:00Z')] })).toMatch(/reset within/)
    expect(reason({ events: [...history, ev('bob', 'credential_reset', '2026-10-29T12:00:00Z')] })).toMatch(/reset within/) // after checklist_done (reading)
    expect(reason({ events: [...history, ev('bob', 'credential_reset', '2026-10-28T09:59:00Z')] })).toBe('ok')
    expect(reason({ events: history.map((e) => (e.userId === 'alice' ? { ...e, at: '2026-10-28T12:00:00Z' } : e)) })).toMatch(/account is newer/)
    expect(reason({ events: [...history, ev('bob', 'role_granted', '2026-10-28T12:00:00Z', 'root', 'approver')] })).toMatch(/role is newer/)
  })
  it('TC-FRD-09 not before the cooling-off period ends', () => {
    expect(reason({ now: '2026-10-30T09:59:59Z' })).toMatch(/cooling-off/)
    expect(reason({ now: '2026-10-30T10:00:00Z' })).toBe('ok')
  })
})

describe('task binding and content (C-FRD-4, C-FRD-5)', () => {
  const bound = { manualRevision: 3, contactId: 'C001', checklist: [...CHECKLIST], fieldsSha: 'f1' }
  it('TC-FRD-09 a change of revision, contact or checklist invalidates, approved tasks included', () => {
    for (const state of ['open', 'checklist_done', 'approved'] as const) {
      expect(invalidated({ ...bound, state }, bound)).toBe(false)
      expect(invalidated({ ...bound, state }, { ...bound, manualRevision: 4 })).toBe(true)
      expect(invalidated({ ...bound, state }, { ...bound, contactId: 'C002' })).toBe(true)
      expect(invalidated({ ...bound, state }, { ...bound, checklist: CHECKLIST.slice(1) })).toBe(true)
    }
    expect(invalidated({ ...bound, state: 'invalidated' }, { ...bound, manualRevision: 4 })).toBe(false)
  })
  it('TC-FRD-25 a change of the field content invalidates, approved tasks included; a task made before the binding (null) counts as changed', () => {
    for (const state of ['open', 'checklist_done', 'approved'] as const) {
      expect(invalidated({ ...bound, state }, { ...bound, fieldsSha: 'f2' })).toBe(true)
      expect(invalidated({ ...bound, state, fieldsSha: null }, { ...bound, fieldsSha: 'f2' })).toBe(true)
    }
    expect(invalidated({ ...bound, state: 'invalidated' }, { ...bound, fieldsSha: 'f2' })).toBe(false)
  })
  it('TC-FRD-25 the field content: only the named fields, in a fixed order, values only, missing as null', () => {
    const v: Record<string, unknown> = { b: 'x', a: ['name'], other: 'ignored' }
    expect(taskFieldContent(['b', 'a', 'c'], (n) => v[n])).toBe('[["a",["name"]],["b","x"],["c",null]]')
    expect(taskFieldContent(['a', 'b', 'a'], (n) => v[n])).toBe(taskFieldContent(['b', 'a'], (n) => v[n]))
    expect(taskFieldContent(['a'], () => undefined)).toBe('[["a",null]]')
  })
  it('TC-FRD-04 / 05 phone from the contacts CSV only', () => {
    expect(phoneOnFile('+44 7700 900101')).toBe('+44 7700 900101')
    expect(phoneOnFile(null)).toBe(null)
    expect(phoneOnFile('  ')).toBe(null)
  })
  it('TC-FRD-11 task contact: the linked one; else the one contact the display name impersonates; never one of two namesakes', () => {
    const amelia = { contactId: 'C001', name: 'Amelia Hart' }
    const oliver = { contactId: 'C002', name: 'Oliver Bennett' }
    const all = [amelia, oliver]
    expect(taskContact(oliver, true, 'Amelia Hart', all)).toEqual({ contact: oliver, impersonated: false }) // linked wins
    expect(taskContact(null, true, 'Amelia Hart', all)).toEqual({ contact: amelia, impersonated: true })
    expect(taskContact(null, true, 'A. HART', all)).toEqual({ contact: amelia, impersonated: true }) // C-LNK-3 similarity 1
    expect(taskContact(null, true, 'Amelia Hart', [...all, { contactId: 'C009', name: 'Amelia Hart' }])).toBe(null) // two namesakes
    expect(taskContact(null, false, 'Amelia Hart', all)).toBe(null) // no impersonation signal
    expect(taskContact(null, null, 'Amelia Hart', all)).toBe(null) // unknown is not true
    expect(taskContact(null, true, 'Someone Else', all)).toBe(null)
  })
})


describe('TC-FRD-12 all approval failures', () => {
  it('reports completer failures during cooling, independently of the viewer, with no account timestamps', () => {
    const events = history.map((e) => e.userId === 'alice' ? { ...e, at: '2026-10-29T09:30:00Z' } : e)
    const input = { ...base, now: '2026-10-29T11:00:00Z', events }
    const failures = approvalFailures(input)
    expect(failures.filter((f) => f.subject === 'completer').map((f) => f.code)).toEqual(['account_too_new', 'role_too_new'])
    expect(failures.some((f) => f.code === 'cooling')).toBe(true)
    const self = approvalFailures({ ...input, approver: { id: 'alice', role: 'reviewer' } })
    expect(self.filter((f) => f.subject === 'completer')).toEqual(failures.filter((f) => f.subject === 'completer'))
    expect(self.some((f) => f.code === 'same_person')).toBe(true)
    expect(JSON.stringify(failures)).not.toContain('2026-')
    expect(canApprove(input)).toMatchObject({ ok: false, reason: 'the cooling-off period has not ended' })
    expect(approvalFailures(base)).toEqual([])
  })
})
