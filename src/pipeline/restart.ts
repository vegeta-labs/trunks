// Start a new processing generation from a given stage (tech design §6): a person's change (labels, fields, links,
// risk, relink) or a system re-run. The earlier stages' results are carried over to the new generation unchanged
// (`reused`); a stage the current generation has not finished yet is where the new generation starts instead.
import type { Tx } from '../store/db.ts'
import type { Keyring } from '../store/crypto.ts'
import { appendAudit } from '../store/audit.ts'
import { STAGES, type Queue, type Stage } from './queue.ts'

/**
 * `hold` (PRD C-RSK-3 v0.7.15, a person's change only): keep the current final risk as a floor until an approver confirms
 * a lower one. Off for the actions that already carry an approver's decision (a direct risk adjustment, an approved
 * class change, the confirmation itself).
 */
export async function restartFrom(c: Tx, queue: Queue, caseId: string, stage: Stage, by: 'person' | 'system', o: { hold?: boolean } = {}): Promise<{ generation: number; from: Stage }> {
  const cr = (await c.query<{ processing_generation: number }>('SELECT processing_generation FROM "case" WHERE id = $1 FOR UPDATE', [caseId])).rows[0]
  if (!cr) throw new Error(`case ${caseId} not found`)
  const gen = cr.processing_generation
  const done = new Set((await c.query<{ stage: string }>('SELECT stage FROM stage_run WHERE case_id = $1 AND generation = $2', [caseId, gen])).rows.map((r) => r.stage))
  let from = stage
  for (const s of STAGES.slice(0, STAGES.indexOf(stage))) {
    if (!done.has(s)) {
      from = s
      break
    }
  }
  const next = gen + 1
  await c.query(
    `UPDATE "case" SET processing_generation = $2, manual_revision = manual_revision + $3, generation_by = $4, status = CASE WHEN status = 'failed' THEN 'processing' ELSE status END, failed_stage = NULL, failed_reason = NULL,
       risk_hold = CASE WHEN $5 THEN COALESCE(risk_hold, risk) ELSE risk_hold END WHERE id = $1`,
    [caseId, next, by === 'person' ? 1 : 0, by, by === 'person' && o.hold !== false],
  )
  await c.query(
    `INSERT INTO stage_run (case_id, stage, generation, input_identity, result_blob, reused)
     SELECT case_id, stage, $3, input_identity, result_blob, true FROM stage_run WHERE case_id = $1 AND generation = $2 AND stage = ANY($4::text[])`,
    [caseId, gen, next, STAGES.slice(0, STAGES.indexOf(from))],
  )
  await queue.send(c, from, { caseId, generation: next })
  return { generation: next, from }
}

/**
 * A failed Case again, from the step where it failed, or from `reply` if it failed after it (tech design §6
 * 「可手动重跑」, v0.7.12; E5 acceptance G3; Codex round 5 F1): the
 * `rerun-failed` command. The steps before it are carried over; a Case that is not failed is left as it is (null).
 */
export async function rerunFailed(c: Tx, k: Keyring, queue: Queue, caseId: string): Promise<{ generation: number; from: Stage } | null> {
  const row = (await c.query<{ status: string; failed_stage: Stage | null }>('SELECT status, failed_stage FROM "case" WHERE id = $1 FOR UPDATE', [caseId])).rows[0]
  if (!row || row.status !== 'failed' || !row.failed_stage || !STAGES.includes(row.failed_stage)) return null
  // a reply belongs to its generation (C-DRF-8): after a failure past `reply`, the draft is made again for the new
  // generation instead of carrying the old one over, which could not be approved (Codex E5 round 5 F1)
  const start: Stage = STAGES.indexOf(row.failed_stage) > STAGES.indexOf('reply') ? 'reply' : row.failed_stage
  const g = await restartFrom(c, queue, caseId, start, 'system')
  await appendAudit(c, k, [{ actor: 'system', type: 'case.rerun_failed', caseId, payload: { failed_stage: row.failed_stage, from: g.from, generation: g.generation } }])
  return g
}
