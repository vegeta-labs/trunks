// PRD C-FRD-5, C-FRD-6, C-DRF-9 (v0.7.30; code review rounds 1 and 2): what migration 009 cannot finish in SQL, done
// once at start-up. Every step is idempotent: a second start finds nothing left to do.
import { tx } from '../store/db.ts'
import { appendAudit } from '../store/audit.ts'
import { PROTECTED_CLASSES } from '../lib/gates.ts'
import { effectiveLabels } from './stages-e3.ts'
import { restartFrom } from './restart.ts'
import { failureCode, originalText } from './failure.ts'
import type { Stage } from './queue.ts'
import type { StageDeps } from './stages.ts'

/**
 * Where a Case runs again (code review round 2 D2): the earliest of `fields` (a restored class's fields count, C8) and
 * `risk` (its floor applies), so both are worked out again for the classes in force now and not carried over.
 */
export const RERUN_FROM: Stage = 'fields'

export async function fraudGatesRollout(d: Pick<StageDeps, 'db' | 'k' | 'queue'>): Promise<{ lapsed: number; unbound: number; restarted: number; failed: number }> {
  // C-DRF-9: the audit entry of every approval migration 009 returned to draft (an audit row needs the key); the Case
  // is stored with the reply, so the entry is written even when maintenance has deleted the reply since (D3)
  const lapsed = await tx(d.db, async (c) => {
    const rows = (await c.query<{ reply_id: string; case_id: string }>(
      'WITH gone AS (DELETE FROM rollout_lapsed_reply RETURNING reply_id, case_id) SELECT reply_id, case_id FROM gone ORDER BY reply_id',
    )).rows
    if (rows.length) await appendAudit(c, d.k, rows.map((r) => ({ actor: 'system', type: 'reply.approval_lapsed', caseId: r.case_id, payload: { reply_id: r.reply_id, problems: ['rules_changed'] } })))
    return rows.length
  })

  // C-FRD-5 (D1): a live task from before the field binding is not bound to any content, so it goes, approved or not,
  // on every Case. C-FRD-6: a protected class that counts again (an older removal without an approver no longer does)
  // has no live task until something else changes the Case. Open, fully processed Cases without a live task for a
  // protected class they have run again, which makes it.
  const candidates = (await d.db.query<{ id: string }>(
    `SELECT c.id FROM "case" c
      WHERE EXISTS (SELECT 1 FROM verification_task t WHERE t.case_id = c.id AND t.state <> 'invalidated' AND t.bound_fields_sha256 IS NULL)
         OR (c.closed_at IS NULL AND c.pipeline_complete_generation = c.processing_generation
             AND EXISTS (SELECT 1 FROM unnest($1::text[]) p(kind)
                          WHERE (EXISTS (SELECT 1 FROM case_label l WHERE l.case_id = c.id AND l.class_id = p.kind AND (l.adopted OR l.source = 'rule'))
                              OR EXISTS (SELECT 1 FROM case_label_change x WHERE x.case_id = c.id AND x.class_id = p.kind AND x.action = 'add'))
                            AND NOT EXISTS (SELECT 1 FROM verification_task t WHERE t.case_id = c.id AND t.kind = p.kind AND t.state <> 'invalidated')))
      ORDER BY c.id`,
    [PROTECTED_CLASSES],
  )).rows
  let unbound = 0
  let restarted = 0
  let failed = 0
  for (const { id } of candidates) {
    try {
      const r = await tx(d.db, async (c) => {
        const cr = (await c.query<{ processing_generation: number; pipeline_complete_generation: number | null; closed_at: Date | null }>(
          'SELECT processing_generation, pipeline_complete_generation, closed_at FROM "case" WHERE id = $1 FOR UPDATE', [id],
        )).rows[0]
        if (!cr) return { unbound: 0, restarted: 0 }
        const gone = (await c.query<{ id: string; kind: string; state: string }>(
          `WITH old AS (SELECT id, kind, state FROM verification_task WHERE case_id = $1 AND state <> 'invalidated' AND bound_fields_sha256 IS NULL FOR UPDATE)
           UPDATE verification_task t SET state = 'invalidated', invalidated_at = now() FROM old WHERE t.id = old.id RETURNING t.id, old.kind, old.state`, [id],
        )).rows
        if (gone.length) await appendAudit(c, d.k, gone.map((g) => ({ actor: 'system', type: 'verification.invalidated', caseId: id, payload: { task_id: g.id, was: g.state, reason: 'fields_unbound_at_upgrade' } })))
        if (cr.closed_at !== null || cr.pipeline_complete_generation !== cr.processing_generation) return { unbound: gone.length, restarted: 0 }
        const labels = await effectiveLabels({ db: c as never, k: d.k }, id, cr.processing_generation)
        const live = new Set((await c.query<{ kind: string }>(`SELECT DISTINCT kind FROM verification_task WHERE case_id = $1 AND state <> 'invalidated'`, [id])).rows.map((x) => x.kind))
        const missing = labels.adopted.filter((x) => (PROTECTED_CLASSES as readonly string[]).includes(x) && !live.has(x))
        if (!missing.length) return { unbound: gone.length, restarted: 0 }
        const g = await restartFrom(c, d.queue, id, RERUN_FROM, 'system')
        await appendAudit(c, d.k, [{ actor: 'system', type: 'case.rerun_for_check', caseId: id, payload: { kinds: missing, from: g.from, generation: g.generation } }])
        return { unbound: gone.length, restarted: 1 }
      })
      unbound += r.unbound
      restarted += r.restarted
    } catch (e) {
      // D5: one Case that cannot be done does not stop the server; it has no valid task, so a normal close stays refused.
      // A fixed code in plain text, the error's own text only in the encrypted detail (tech design v0.7.15)
      failed++
      await tx(d.db, (c) => appendAudit(c, d.k, [{ actor: 'system', type: 'case.rollout_failed', caseId: id, payload: { reason: failureCode(e) }, detail: { error: originalText(e).slice(0, 500) } }]))
    }
  }
  return { lapsed, unbound, restarted, failed }
}
