// PRD C-FRD-4, C-FRD-5: the verification task for `bank_details` and `identity_change` — its content, its state
// machine and the two-person condition. Pure functions; the store applies them in one transaction with the full
// `user_event` history (tech design §4).
import { sameName } from './names.ts'
import { normaliseText } from './text.ts'

export type TaskState = 'open' | 'checklist_done' | 'approved' | 'invalidated'

// C-FRD-4 checklist (fixed order)
export const CHECKLIST = ['call_phone_on_file', 'no_contact_details_from_mail', 'check_request_content', 'notify_old_contact'] as const
export type ChecklistItem = (typeof CHECKLIST)[number]
export const CHECKLIST_TEXT: Readonly<Record<ChecklistItem, string>> = {
  call_phone_on_file: 'Call the phone number on file',
  no_contact_details_from_mail: 'Do not use any phone number or link from the email',
  check_request_content: 'Check what the request asks for',
  notify_old_contact: 'Notify the old contact details',
}
export const NO_PHONE_TEXT = '档案里没有电话，需另找已知渠道' // C-FRD-4 wording, shown in the review UI's language
export const NO_PHONE_TEXT_EN = 'No phone number on file: find another known channel'

/** C-FRD-4: the phone number comes from the contacts CSV only, never from the mail. */
export const phoneOnFile = (contactPhone: string | null | undefined) => (contactPhone && contactPhone.trim() !== '' ? contactPhone.trim() : null)

/**
 * C-FRD-4 v0.7.21 «task contact»: the Case's linked contact; without one, when the display name impersonates exactly one
 * contact of the snapshot (`display_name_mismatch` true, C-LNK-3 similarity 1), that contact, marked as impersonated.
 * The Case itself is not linked to it. Two or more contacts with that name: none.
 */
export function taskContact<T extends { name: string }>(linked: T | null, displayNameMismatch: boolean | null, displayName: string, contacts: readonly T[]): { contact: T; impersonated: boolean } | null {
  if (linked) return { contact: linked, impersonated: false }
  if (displayNameMismatch !== true) return null
  const name = normaliseText(displayName)
  const named = contacts.filter((c) => sameName(name, normaliseText(c.name)))
  return named.length === 1 ? { contact: named[0]!, impersonated: true } : null
}

export const MIN_COOLING_HOURS = 1 // C-FRD-4: configurable, at least one hour, never zero

export interface TaskBinding {
  manualRevision: number
  contactId: string | null
  checklist: readonly string[]
}

/** C-FRD-5: whether a task bound at creation must be invalidated (approved ones included) and replaced by a new open one. */
export function invalidated(task: TaskBinding & { state: TaskState }, now: TaskBinding): boolean {
  if (task.state === 'invalidated') return false
  return task.manualRevision !== now.manualRevision || task.contactId !== now.contactId || task.checklist.join('\n') !== now.checklist.join('\n')
}

export interface UserEvent {
  userId: string
  type: 'created' | 'role_granted' | 'role_removed' | 'credential_reset' | 'disabled'
  role: string | null
  byUser: string | null
  at: string // ISO UTC
}

export interface ApproveInput {
  completedBy: string
  approver: { id: string; role: string }
  checklistDoneAt: string
  now: string
  coolingMs: number
  events: readonly UserEvent[] // the full history of both users, every event that names either of them
  currentRoles: Readonly<Record<string, string>> // userId → role now
}

export type ApproveResult = { ok: true } | { ok: false; reason: string }

/** C-FRD-5: the cooling-off period and the two-person condition, checked against the whole history. */
export function canApprove(i: ApproveInput): ApproveResult {
  const t = (iso: string) => Date.parse(iso)
  if (i.approver.id === i.completedBy) return { ok: false, reason: 'You ticked the checklist, so a different person must approve.' }
  if (i.approver.role !== 'approver' && i.approver.role !== 'admin') return { ok: false, reason: 'the approver needs the approver role' }
  if (t(i.now) < t(i.checklistDoneAt) + i.coolingMs) return { ok: false, reason: 'the cooling-off period has not ended' }
  const pair = [i.completedBy, i.approver.id]
  for (const e of i.events) {
    // at any time: neither created the other's account, granted the other a role or reset the other's credentials
    if (['created', 'role_granted', 'credential_reset'].includes(e.type) && e.byUser !== null && pair.includes(e.userId) && pair.includes(e.byUser) && e.userId !== e.byUser) {
      return { ok: false, reason: `one of the two users ${e.type === 'created' ? 'created' : e.type === 'role_granted' ? 'granted a role to' : 'reset the credentials of'} the other` }
    }
  }
  const limit = t(i.checklistDoneAt) - i.coolingMs
  for (const u of pair) {
    const mine = i.events.filter((e) => e.userId === u)
    const created = mine.find((e) => e.type === 'created')
    if (!created || t(created.at) > limit) return { ok: false, reason: 'an account is newer than one cooling-off period before the checklist was done' }
    const role = i.currentRoles[u]
    const granted = mine.filter((e) => e.type === 'role_granted' && e.role === role).map((e) => t(e.at))
    if (granted.length === 0 || Math.max(...granted) > limit) return { ok: false, reason: 'a role is newer than one cooling-off period before the checklist was done' }
    // READING: a reset after checklist_done (before the approval) is refused too; the text names the period before it
    if (mine.some((e) => e.type === 'credential_reset' && t(e.at) > limit && t(e.at) <= t(i.now))) return { ok: false, reason: 'credentials were reset within the cooling-off period' }
  }
  return { ok: true }
}
