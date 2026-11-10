// PRD C-FRD-6, C-FRD-7, C-DRF-10, C-DRF-11 (v0.7.30, plan docs/11_FRAUD_GATES_PLAN.md): pure judgements for the fraud
// gates. The store and the actions apply them in one transaction; these functions read nothing.
import { allowedCaseRecipients } from './draft.ts'
import { relatesPair, type UserEvent } from './verification.ts'

/** The classes whose verification obligation must not vanish automatically (C-FRD-6). */
export const PROTECTED_CLASSES = ['bank_details', 'identity_change'] as const
export const isProtectedClass = (c: string): boolean => (PROTECTED_CLASSES as readonly string[]).includes(c)

export interface LabelChange {
  classId: string
  action: string
  approvedBy: string | null
}

/**
 * C-FRD-6: the labels a Case keeps. `persisted` are the protected classes adopted in any generation; a person's changes
 * apply in order on top, and a removal of a protected class counts only when it records an approver.
 */
export function labelsWithChanges(base: { adopted: readonly string[]; risk: readonly string[] }, persisted: readonly string[], changes: readonly LabelChange[]): { adopted: Set<string>; risk: Set<string> } {
  const adopted = new Set([...base.adopted, ...persisted])
  const risk = new Set([...base.risk, ...persisted])
  for (const ch of changes) {
    if (ch.action === 'add') {
      adopted.add(ch.classId)
      risk.add(ch.classId)
    } else if (!isProtectedClass(ch.classId) || ch.approvedBy !== null) {
      adopted.delete(ch.classId)
      risk.delete(ch.classId)
    }
  }
  return { adopted, risk }
}

export type CloseBlocker = 'processing' | 'check_not_created' | 'check_not_approved' | 'check_not_valid' | 'reply_not_sent'

const BLOCKER_TEXT: Readonly<Record<CloseBlocker, string>> = {
  processing: 'its email has not finished processing',
  check_not_created: 'it is marked as a bank details or identity change, but its check has not been created yet',
  check_not_approved: 'a bank details or identity check has not been approved',
  check_not_valid: 'an approved check no longer matches this case because the contact or details changed',
  reply_not_sent: 'an approved reply has not been marked as sent',
}
export const closeBlockerText = (b: CloseBlocker): string => BLOCKER_TEXT[b]

export interface ClosureFacts {
  complete: boolean // pipeline_complete_generation = processing_generation
  requiredKinds: readonly string[] // the protected classes this generation adopted
  tasks: ReadonlyArray<{ kind: string; state: string; valid: boolean }> // every live task (state <> 'invalidated')
  approvedUnsentReply: boolean
}

/** C-FRD-7: what stands in the way of a normal close; empty means any reviewer may close. */
export function closureBlockers(f: ClosureFacts): CloseBlocker[] {
  const out = new Set<CloseBlocker>()
  if (!f.complete) out.add('processing')
  if (f.approvedUnsentReply) out.add('reply_not_sent')
  if (f.complete) {
    for (const k of f.requiredKinds) if (!f.tasks.some((t) => t.kind === k)) out.add('check_not_created')
    for (const t of f.tasks) {
      if (t.state !== 'approved') out.add('check_not_approved')
      else if (!t.valid) out.add('check_not_valid')
    }
  }
  return [...out]
}

/** C-DRF-10: the sender imitates a contact or a domain (the signals must be exactly true). */
export const senderSuspect = (signals: Readonly<Record<string, boolean | null | undefined>>): boolean => signals.display_name_mismatch === true || signals.lookalike_domain === true

/** C-DRF-10 over C-DRF-2 ④a: a suspect sender has no allowed recipient; the case-level exception allows only From. */
export function caseReplyRecipients(from: string | null, replyTo: readonly string[], replyToMismatch: boolean, suspect: boolean, overrideGranted: boolean): string[] {
  if (suspect) return overrideGranted ? allowedCaseRecipients(from, [], true) : []
  return allowedCaseRecipients(from, replyTo, replyToMismatch)
}

export const SUSPECT_SENDER_REASON = "the sender's name or domain imitates a known contact, so this reply has no allowed recipient; an approver or admin can allow replying to the original address with a reason"
const EDITED_NEEDS_APPROVER = 'the text was changed from the template, so an approver or admin must approve it'
const EDITED_NEEDS_OTHER = 'the text was changed by the person approving it, so a different approver or admin must approve it'
const EDITED_RELATED = 'the person approving it and a person who changed the text created, granted a role to or reset the password of one another, so a different approver or admin must approve it'

/**
 * C-DRF-11: `approver` is the recorded approver (the caller at approval); null means no recorded approver. `events` are
 * the account events naming the approver or an editor: the relationship rules of C-FRD-5 apply between the approver and
 * every editor, in either direction (not its cooling-off or account-age rules).
 */
export function editedReplyProblem(approver: { id: string; role: string | null } | null, editors: readonly string[], events: readonly UserEvent[]): string | null {
  if (!approver || (approver.role !== 'approver' && approver.role !== 'admin')) return EDITED_NEEDS_APPROVER
  if (editors.includes(approver.id)) return EDITED_NEEDS_OTHER
  return events.some((e) => editors.some((ed) => relatesPair(e, approver.id, ed))) ? EDITED_RELATED : null
}
