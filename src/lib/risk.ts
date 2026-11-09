// PRD C-RSK-1 to C-RSK-3 (v0.7.12): risk from the labels, the frozen signals and the rule extraction; a person's direct
// adjustment on top. Pure functions; the pipeline gathers the inputs. Reason ids name what raised the risk (C-RSK-3 R0).
import { matchedPhrases } from './text.ts'
import { workingDaysAfter } from './workdays.ts'

export type Level = 'low' | 'medium' | 'high'
const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 }
const LEVELS: readonly Level[] = ['low', 'medium', 'high']
export const rank = (l: Level) => RANK[l]
export const maxLevel = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b)
export const minLevel = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b)

export interface ClassFloor {
  id: string
  risk_floor: Level
}

// C-RSK-2a pressure words: fixed, the configuration can add, never remove
export const PRESSURE_WORDS: readonly string[] = [
  'urgent', 'urgently', 'immediately', 'today', 'asap', 'confidential', 'do not tell', "don't tell", 'keep this between us', 'before close',
]
const PRESSURE_CLASSES = ['payment_query', 'payment_evidence', 'unreferenced_payment', 'bank_details', 'withdrawal', 'exit_distribution']
const CLOSING_CLASSES = ['bank_details', 'payment_query', 'payment_evidence', 'unreferenced_payment']

/** C-RSK-2a pressure words in the subject and body (quoted mail included). */
export const hasPressure = (texts: readonly string[], extra: readonly string[] = []) => texts.some((t) => matchedPhrases(t, [...PRESSURE_WORDS, ...extra]).length > 0)

export interface Amount {
  minor: number
  currency: string
}

export interface RiskInput {
  classes: readonly ClassFloor[]
  labels: readonly string[] // C-RSK-1: adopted labels plus the model's low labels
  signals: Readonly<Record<string, boolean | null>> // C-SIG-1, null = unknown
  accountPresent: boolean // an IBAN-shaped string or a UK account (C-RSK-2, with first_time_sender)
  evidenceBeneficiaryMismatch?: boolean // C-RSK-2 v0.7.28
  uetrCandidatesInvalid: number
  amountsBody: readonly Amount[]
  amountsAttachment: readonly Amount[] // MT103 / pacs.008
  attachmentBlockedOrOverLimit: boolean
  pressure: boolean
  plannedCloseDate: string | null // the linked deal's
  receivedDate: string // deployment time zone
  holidays: ReadonlySet<string>
}

export interface RiskResult {
  level: Level
  base: Level
  floorClasses?: string[] // D8: the labels whose floor set `base` (none at low); absent in results saved before D8
  reasons: string[] // class ids of the labels and the clause ids that hit
  clauses: Array<{ id: string; hit: boolean }> // every rule's result (C-AUD-3)
}

const DIRECT = ['display_name_mismatch', 'lookalike_domain', 'hidden_text', 'injection_markers', 'message_id_collision'] as const
const UPGRADE = ['auth_fail', 'untrusted_auth_header', 'reply_to_mismatch'] as const

export function computeRisk(i: RiskInput): RiskResult {
  const floors = new Map(i.classes.map((c) => [c.id, c.risk_floor]))
  const labels = [...new Set(i.labels)]
  for (const l of labels) if (!floors.has(l)) throw new Error(`unknown class ${l}`)
  const base = labels.reduce<Level>((m, l) => maxLevel(m, floors.get(l)!), 'low')
  const has = (ids: readonly string[]) => labels.some((l) => ids.includes(l))
  const key = (a: Amount) => `${a.minor} ${a.currency}`
  const body = new Set(i.amountsBody.map(key))

  const direct: Array<[string, boolean]> = [
    ...DIRECT.map((s): [string, boolean] => [`C-RSK-2:${s}`, i.signals[s] === true]),
    ['C-RSK-2:first_time_sender_account', i.signals.first_time_sender === true && i.accountPresent],
    ['C-RSK-2:evidence_beneficiary_mismatch', i.evidenceBeneficiaryMismatch === true],
    ['C-RSK-2:uetr_candidate_invalid', i.uetrCandidatesInvalid > 0],
    ['C-RSK-2:amount_mismatch', i.amountsBody.length > 0 && i.amountsAttachment.length > 0 && !i.amountsAttachment.some((a) => body.has(key(a)))],
    ['C-RSK-2:attachment_blocked_or_over_limit', i.attachmentBlockedOrOverLimit],
  ]
  const closing =
    i.plannedCloseDate !== null && i.plannedCloseDate >= i.receivedDate && workingDaysAfter({ holidays: i.holidays }, i.receivedDate, i.plannedCloseDate) <= 3 && has(CLOSING_CLASSES)
  const upgrade: Array<[string, boolean]> = [
    ...UPGRADE.map((s): [string, boolean] => [`C-RSK-2a:${s}`, i.signals[s] === true]),
    ['C-RSK-2a:pressure', i.pressure && has(PRESSURE_CLASSES)],
    ['C-RSK-2a:closing', closing],
  ]
  const steps = upgrade.filter(([, hit]) => hit).length
  const level: Level = direct.some(([, hit]) => hit) ? 'high' : LEVELS[Math.min(2, RANK[base] + steps)]!
  const clauses = [...direct, ...upgrade].map(([id, hit]) => ({ id, hit }))
  const floorClasses = base === 'low' ? [] : labels.filter((l) => floors.get(l) === base)
  return { level, base, floorClasses, reasons: [...labels, ...clauses.filter((c) => c.hit).map((c) => c.id)], clauses }
}

// ---------- C-RSK-3 ①–⑦: a person's direct adjustment ----------

export interface Adjustment {
  level: Level // L
  computedAtSet: Level // C0
  reasons: readonly string[] // R0
}

/** The reasons that count for an adjustment to `level` (③ R0): labels whose floor is above it, and every clause id. */
export function reasonsAbove(reasons: readonly string[], level: Level, classes: readonly ClassFloor[]): string[] {
  const floors = new Map(classes.map((c) => [c.id, c.risk_floor]))
  return reasons.filter((r) => (floors.has(r) ? RANK[floors.get(r)!] > RANK[level] : true))
}

// ②: anything below the current final risk (a cancel included) needs an approver and a reason
export type AdjustRequest =
  | { kind: 'cancel'; needsApprover: boolean } // L equals the computed risk now (③)
  | { kind: 'set'; adjustment: Adjustment; needsApprover: boolean }

/** What a person's request to set the risk to `level` means now. */
export function requestAdjustment(level: Level, computed: RiskResult, finalNow: Level, classes: readonly ClassFloor[]): AdjustRequest {
  if (level === computed.level) return { kind: 'cancel', needsApprover: RANK[level] < RANK[finalNow] }
  return {
    kind: 'set',
    adjustment: { level, computedAtSet: computed.level, reasons: reasonsAbove(computed.reasons, level, classes) },
    needsApprover: RANK[level] < RANK[finalNow],
  }
}

/** Final risk with the active adjustment (④ ⑤). `void`: a lowering lapses for good. */
export function applyAdjustment(computed: RiskResult, adj: Adjustment | null, classes: readonly ClassFloor[]): { level: Level; void: boolean } {
  if (!adj || adj.level === adj.computedAtSet) return { level: computed.level, void: false }
  if (RANK[adj.level] > RANK[adj.computedAtSet]) return { level: maxLevel(computed.level, adj.level), void: false }
  const known = new Set(adj.reasons)
  const fresh = reasonsAbove(computed.reasons, adj.level, classes).filter((r) => !known.has(r))
  if (RANK[computed.level] > RANK[adj.computedAtSet] || fresh.length > 0) return { level: computed.level, void: true }
  return { level: minLevel(computed.level, adj.level), void: false }
}
