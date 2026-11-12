// Start-up checks shared by the server, the workers and the CLI (PRD R-CFG-01, R-CFG-02).
import type { Config } from './config/load.ts'
import type { Keyring } from './store/crypto.ts'
import { tx, type Db } from './store/db.ts'
import { appendAudit } from './store/audit.ts'
import type { Queue } from './pipeline/queue.ts'
import { modelPolicy } from './lib/model-policy.ts'
import { llmFromConfig } from './adapters/llm/index.ts'
import type { LlmAdapter } from './adapters/llm/types.ts'
import { KEYS_LOCK, missingKeyProblems } from './maintenance/rotation.ts'

/**
 * R-PRV-01 at start-up of `serve`: no model configured or a refused provider stops start-up; warnings go to the log
 * (the review UI shows them too, from the same policy). Returns the adapter the model steps use.
 */
export function startModel(config: Config, warn: (s: string) => void = console.warn, env: NodeJS.ProcessEnv = process.env): LlmAdapter {
  if (!config.model) throw new Error('model is required in deployment.yaml (classification and field extraction, tech design §3.2)')
  const policy = modelPolicy(config.model)
  if (policy.refuse) throw new Error(policy.refuse)
  // a hosted provider without its key cannot classify anything (verify R1)
  if (config.model.provider === 'anthropic' && !env[config.model.api_key_env]) throw new Error(`${config.model.api_key_env} is empty: the model provider needs its API key`)
  for (const w of policy.warnings) warn(`WARNING (R-PRV-01): ${w}`)
  return llmFromConfig(config.model, env)
}

/**
 * R-CFG-02: when the configuration hash differs from the last one recorded, write `config.changed`. Tech design §6: the
 * change also advances the processing generation of every Case not closed and queues it again, in the same
 * transaction, so no pipeline finishes on the old configuration (Codex F13). Stages before `extract` are idempotent.
 */
export async function recordConfig(db: Db, k: Keyring, config: Config, queue: Queue): Promise<'initial' | 'changed' | 'unchanged'> {
  return tx(db, async (c) => {
    const last = (await c.query<{ sha: string }>(`SELECT payload->>'config_sha256' AS sha FROM audit WHERE type IN ('config.initial', 'config.changed') ORDER BY seq DESC LIMIT 1`)).rows[0]?.sha
    if (last === config.sha256) return 'unchanged'
    let requeued = 0
    if (last !== undefined) {
      const r = await c.query<{ id: string; processing_generation: number }>(
        `UPDATE "case" SET processing_generation = processing_generation + 1, generation_by = 'system' WHERE status <> 'closed' RETURNING id, processing_generation`,
      )
      for (const row of r.rows) await queue.send(c, 'scan', { caseId: row.id, generation: row.processing_generation })
      requeued = r.rows.length
    }
    const type = last === undefined ? 'config.initial' : 'config.changed'
    await appendAudit(c, k, [{ actor: 'system', type, payload: { config_sha256: config.sha256, previous_sha256: last ?? null, cases_requeued: requeued } }])
    return last === undefined ? 'initial' : 'changed'
  })
}

/**
 * Tech design v0.7.9: refuse to start while a master key that data still needs is missing, then record which key this
 * process writes with (`keys.active`): `trunks rotate-keys` checks it before and during a rotation.
 */
export async function recordKeys(db: Db, k: Keyring): Promise<void> {
  // the check and the record in one transaction under the rotation's lock (Codex E4 round 2 F6)
  await tx(db, async (c) => {
  await c.query('SELECT pg_advisory_xact_lock($1)', [KEYS_LOCK])
  const problems = await missingKeyProblems(c, k)
  // Codex E4 F8: a write key that a rotation has moved away from (running or completed) cannot write again
  // only when the latest rotation that involves this key moved away from it (regression review R6: a key rotated back
  // to later, or one only staged during an earlier rotation, may write)
  const away = await c.query("SELECT 1 FROM (SELECT from_key FROM key_rotation WHERE from_key = $1 OR to_key = $1 ORDER BY started_at DESC LIMIT 1) r WHERE r.from_key = $1", [k.active.id])
  if (away.rowCount) problems.push(`the write key ${k.active.id} has been rotated away from; set TRUNKS_ACTIVE_KEY to the new key`)
  if (problems.length) throw new Error(`refusing to start: ${problems.join('; ')}`)
  await appendAudit(c, k, [{ actor: 'system', type: 'keys.active', payload: { key: k.active.id } }])
  })
}

/** Whether this database carries the demo marker (PRD R-DEMO-01 v0.7.22); a database from before E5 has no marker table. */
export async function isDemoDatabase(db: Db): Promise<boolean> {
  const t = await db.query<{ t: string | null }>("SELECT to_regclass('public.demo_marker')::text AS t")
  if (!t.rows[0]!.t) return false
  return ((await db.query('SELECT 1 FROM demo_marker')).rowCount ?? 0) > 0
}

/**
 * The demo guard for `serve` and `maintain` (tech design v0.7.11; plan review R1, W1): DEMO=1 needs a demo database,
 * and a demo database is used only with DEMO=1. Returns whether this is the demo.
 */
export async function demoGuard(db: Db, demoMode: boolean): Promise<boolean> {
  const demoDb = await isDemoDatabase(db)
  if (demoMode && !demoDb) throw new Error('refusing to start: DEMO=1 but this database has no demo marker (run migrate with DEMO=1 on an empty database)')
  if (!demoMode && demoDb) throw new Error('refusing to start: this is a demo database; a demo database cannot become a real deployment')
  return demoDb
}
