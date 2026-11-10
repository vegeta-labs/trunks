// PRD C-FRD-6, C-FRD-7, C-DRF-10, C-DRF-11 (v0.7.30): the pure judgements (see src/pipeline/gates.test.ts for the actions).
import { describe, expect, it } from 'vitest'
import { caseReplyRecipients, closeBlockerText, closureBlockers, editedReplyProblem, labelsWithChanges, senderSuspect } from './gates.ts'

const base = { adopted: ['payment_query'], risk: ['payment_query'] }

describe('TC-FRD-14 labels', () => {
  it('a protected class adopted in any generation stays', () => {
    expect([...labelsWithChanges(base, ['bank_details'], []).adopted].sort()).toEqual(['bank_details', 'payment_query'])
  })
  it('a removal of a protected class counts only with an approver', () => {
    const noApprover = labelsWithChanges(base, ['bank_details'], [{ classId: 'bank_details', action: 'remove', approvedBy: null }])
    expect(noApprover.adopted.has('bank_details')).toBe(true)
    expect(noApprover.risk.has('bank_details')).toBe(true)
    const approved = labelsWithChanges(base, ['bank_details'], [{ classId: 'bank_details', action: 'remove', approvedBy: 'u1' }])
    expect(approved.adopted.has('bank_details')).toBe(false)
    expect(approved.risk.has('bank_details')).toBe(false)
  })
  it('an approved removal holds even when the model adopts it again (the base re-adds, the change still removes)', () => {
    expect(labelsWithChanges({ adopted: ['bank_details'], risk: ['bank_details'] }, ['bank_details'], [{ classId: 'bank_details', action: 'remove', approvedBy: 'u1' }]).adopted.has('bank_details')).toBe(false)
  })
  it('other classes are removed as before, without an approver', () => {
    expect(labelsWithChanges(base, [], [{ classId: 'payment_query', action: 'remove', approvedBy: null }]).adopted.has('payment_query')).toBe(false)
  })
  it('a person can add a removed class again; order decides', () => {
    expect(labelsWithChanges(base, [], [{ classId: 'identity_change', action: 'remove', approvedBy: 'u' }, { classId: 'identity_change', action: 'add', approvedBy: null }]).adopted.has('identity_change')).toBe(true)
  })
})

describe('TC-FRD-15 closure blockers', () => {
  const ok = { complete: true, requiredKinds: [], tasks: [], approvedUnsentReply: false }
  it('nothing in the way', () => expect(closureBlockers(ok)).toEqual([]))
  it('still processing', () => expect(closureBlockers({ ...ok, complete: false })).toEqual(['processing']))
  it('an approved but unsent reply', () => expect(closureBlockers({ ...ok, approvedUnsentReply: true })).toEqual(['reply_not_sent']))
  it('a task that is not approved', () => expect(closureBlockers({ ...ok, requiredKinds: ['bank_details'], tasks: [{ kind: 'bank_details', state: 'open', valid: true }] })).toEqual(['check_not_approved']))
  it('an approved task that is stale', () => expect(closureBlockers({ ...ok, requiredKinds: ['bank_details'], tasks: [{ kind: 'bank_details', state: 'approved', valid: false }] })).toEqual(['check_not_valid']))
  it('a required class with no task', () => expect(closureBlockers({ ...ok, requiredKinds: ['identity_change'] })).toEqual(['check_not_created']))
  it('an approved and valid task is enough', () => expect(closureBlockers({ ...ok, requiredKinds: ['bank_details'], tasks: [{ kind: 'bank_details', state: 'approved', valid: true }] })).toEqual([]))
  it('TC-FRD-18 the texts are plain English, without rule codes', () => {
    for (const b of ['processing', 'check_not_created', 'check_not_approved', 'check_not_valid', 'reply_not_sent'] as const) {
      expect(closeBlockerText(b)).not.toMatch(/C-[A-Z]+-\d|_/)
    }
  })
})

describe('TC-DRF-23 sender', () => {
  it('needs exactly true', () => {
    expect(senderSuspect({ display_name_mismatch: true })).toBe(true)
    expect(senderSuspect({ lookalike_domain: true })).toBe(true)
    expect(senderSuspect({ display_name_mismatch: null, lookalike_domain: false })).toBe(false)
    expect(senderSuspect({})).toBe(false)
  })
  it('recipients', () => {
    expect(caseReplyRecipients('a@x.example', ['b@y.example'], false, false, false)).toEqual(['a@x.example', 'b@y.example'])
    expect(caseReplyRecipients('a@x.example', ['b@y.example'], false, true, false)).toEqual([])
    expect(caseReplyRecipients('a@x.example', ['b@y.example'], false, true, true)).toEqual(['a@x.example'])
    expect(caseReplyRecipients(null, [], true, true, true)).toEqual([])
  })
})

describe('TC-DRF-24 edited reply problem', () => {
  it('needs an approver or admin who did not edit', () => {
    expect(editedReplyProblem({ id: 'a', role: 'reviewer' }, [], [])).toMatch(/approver or admin must approve/)
    expect(editedReplyProblem({ id: 'a', role: null }, [], [])).toMatch(/approver or admin must approve/)
    expect(editedReplyProblem(null, [], [])).toMatch(/approver or admin must approve/)
    expect(editedReplyProblem({ id: 'a', role: 'approver' }, ['a'], [])).toMatch(/different approver or admin/)
    expect(editedReplyProblem({ id: 'a', role: 'admin' }, ['b'], [])).toBeNull()
    expect(editedReplyProblem({ id: 'a', role: 'approver' }, [], [])).toBeNull()
  })
  it('TC-DRF-26 the approver and an editor must not be related by an account action, in either direction', () => {
    const ev = (type: 'created' | 'role_granted' | 'credential_reset' | 'disabled', userId: string, byUser: string | null) => ({ userId, type, role: null, byUser, at: '2026-11-01T00:00:00.000Z' })
    const RELATED = /created, granted a role to or reset the password of one another/
    for (const type of ['created', 'role_granted', 'credential_reset'] as const) {
      expect(editedReplyProblem({ id: 'b', role: 'approver' }, ['a'], [ev(type, 'b', 'a')])).toMatch(RELATED) // the editor acted on the approver
      expect(editedReplyProblem({ id: 'b', role: 'approver' }, ['x', 'a'], [ev(type, 'a', 'b')])).toMatch(RELATED) // the approver acted on an editor
    }
    // not related: a third person, the user's own event, an event of another kind
    expect(editedReplyProblem({ id: 'b', role: 'admin' }, ['a'], [ev('created', 'b', 'root'), ev('created', 'a', 'root'), ev('credential_reset', 'b', 'b'), ev('disabled', 'a', 'b'), ev('created', 'c', 'b')])).toBeNull()
    expect(editedReplyProblem({ id: 'b', role: 'admin' }, ['a'], [ev('created', 'b', null)])).toBeNull()
  })
})
