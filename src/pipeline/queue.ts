// Job queue (tech design T2): pg-boss in its own schema, owned by the app role. The next stage is always enqueued in
// the same transaction that publishes the current stage's result (tech design §6).
import { PgBoss } from 'pg-boss'
import type { Tx } from '../store/db.ts'

export const STAGES = ['scan', 'parse', 'content_signals', 'extract', 'redact', 'classify', 'fields', 'link', 'risk', 'reply', 'route', 'emit'] as const
export type Stage = (typeof STAGES)[number]
export interface StageJob {
  caseId: string
  generation: number
}

export interface Queue {
  send(c: Tx, stage: Stage, job: StageJob): Promise<void>
}

export const RETRY = { retryLimit: 3, retryDelay: 5, retryBackoff: true }

export class BossQueue implements Queue {
  readonly boss: PgBoss
  constructor(connectionString: string) {
    // the schema is created by our migration (owned by the app role), so pg-boss needs no CREATE on the database
    this.boss = new PgBoss({ connectionString, schema: 'pgboss', createSchema: false })
    // the same for the queue's own connections
    this.boss.on('error', (e: Error & { code?: string }) => console.error(`job queue error (${e.code ?? e.name})`))
  }
  async start(): Promise<void> {
    await this.boss.start()
    for (const s of STAGES) if (!(await this.boss.getQueue(s))) await this.boss.createQueue(s, RETRY)
  }
  async send(c: Tx, stage: Stage, job: StageJob): Promise<void> {
    await this.boss.send(stage, job, {
      ...RETRY,
      // pg-boss's standard queues do not de-duplicate by this key; runStage makes repeats harmless (one result per
      // stage and generation). The key is kept for tracing.
      singletonKey: `${job.caseId}:${stage}:${job.generation}`,
      db: { executeSql: async (text: string, values?: unknown[]) => ({ rows: (await c.query(text, values as unknown[])).rows }) },
    })
  }
  stop(): Promise<void> {
    return this.boss.stop({ graceful: true, timeout: 10_000 })
  }
}
