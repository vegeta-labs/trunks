// A durable retry after a replacement or retention lock deferred a stricter KYC judgement (E6 self-review F1).
import { tx } from '../store/db.ts'
import { appendAudit } from '../store/audit.ts'
import { restartFrom } from './restart.ts'
import type { StageDeps } from './stages.ts'

/** Called at startup and each minute by the app's transfer scheduler. No model or rule runs in the scheduler. */
export async function retryDeferredKyc(d: Pick<StageDeps, 'db' | 'k' | 'queue'>): Promise<number> {
  const cases = (await d.db.query<{ id: string }>(`SELECT c.id FROM "case" c WHERE
    (c.pipeline_complete_generation = c.processing_generation OR c.status = 'failed')
    AND EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = c.message_id AND a.kyc_recheck_pending AND NOT a.source_deleted)`)).rows
  let scheduled = 0
  for (const candidate of cases) {
    scheduled += await tx(d.db, async (c) => {
      const row = (await c.query<{ id: string; message_id: string; processing_generation: number; pipeline_complete_generation: number | null; status: string }>(
        'SELECT id, message_id, processing_generation, pipeline_complete_generation, status FROM "case" WHERE id = $1 FOR UPDATE', [candidate.id],
      )).rows[0]
      if (!row || row.pipeline_complete_generation !== row.processing_generation && row.status !== 'failed') return 0
      const got = (await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 7340009)) AS ok', [row.message_id])).rows[0]!.ok
      if (!got || (await c.query('SELECT 1 FROM kyc_replacement WHERE message_id = $1 AND step < 5', [row.message_id])).rowCount) return 0
      if (!(await c.query('SELECT 1 FROM attachment WHERE message_id = $1 AND kyc_recheck_pending AND NOT source_deleted', [row.message_id])).rowCount) return 0
      const next = await restartFrom(c, d.queue, row.id, 'redact', 'system')
      await appendAudit(c, d.k, [{ actor: 'system', type: 'kyc.reclassify_retry', caseId: row.id, payload: { generation: next.generation } }])
      // Keep the pending bit until the worker saves its judgement: a crash here or later cannot lose it.
      return 1
    })
  }
  return scheduled
}
