// The maintenance schedule: since tech design v0.7.11 in its own container (`maintain`) with the maintenance role's
// credentials; only the KYC transfer (app role) stays in `serve`. Every step is safe to run twice or on two instances
// at once (per-message locks, re-checks).
import type { Config } from '../config/load.ts'
import { runDirectoryRetention, runFileDeletions, runMessageRetention, sweepOrphanBlobs, type RetentionDeps } from './retention.ts'
import { FolderSink, kycReminders, runKycDeliveries, runKycReplacements, WebhookSink, type KycSink } from './kyc.ts'
import type { Db } from '../store/db.ts'
import { cleanOrphans } from '../store/files.ts'
import { failureLabel } from '../pipeline/failure.ts'

// only a fixed code: an error's text may carry values from an email (tech design v0.7.15)
const log = (what: string) => (e: unknown) => console.error(`${what} failed: reason=${failureLabel(e)}`)

/** Once a day: retention of messages and directory versions, then text blobs nothing refers to. */
export async function runDaily(d: RetentionDeps, config: Pick<Config, 'retention'>, now = new Date()): Promise<void> {
  await runMessageRetention(d, config.retention, now).catch(log('retention'))
  await runDirectoryRetention(d, config.retention, now).catch(log('directory retention'))
  await sweepOrphanBlobs(d, now).catch(log('blob clean-up'))
  await runFileDeletions(d, now).catch(log('file deletion'))
  await kycReminders(d).catch(log('KYC reminders'))
}

/** The configured KYC target (R-PRV-03); none configured → transfers fail with `no_target` and are reminded. */
export function kycSink(config: Pick<Config, 'kyc'>, env: (name: string) => string): KycSink | null {
  const t = config.kyc.target
  if (!t) return null
  return t.kind === 'folder' ? new FolderSink(t.path) : new WebhookSink(t.url, env(t.secret_env))
}

const once = (fn: () => Promise<unknown>) => {
  let busy = false
  return () => {
    if (busy) return
    busy = true
    void fn().finally(() => (busy = false))
  }
}

/** KYC transfers as the app role, in `serve`: every minute; failed ones once a day until they succeed (R-PRV-03 v0.7.18). */
export function scheduleKycDeliveries(app: { db: Db } & Omit<RetentionDeps, 'db'>, sink: KycSink | null, recheck?: () => Promise<unknown>): void {
  const send = async (includeFailed: boolean) => {
    await recheck?.().catch(log('KYC judgement retry'))
    await runKycDeliveries(app, sink, { includeFailed }).catch(log('KYC transfer'))
  }
  const quick = once(() => send(false))
  const daily = once(() => send(true))
  daily()
  setInterval(quick, 60_000)
  setInterval(daily, 24 * 3600_000)
}

/** The KYC replacement as the maintenance role, in `maintain` (tech design v0.7.11): every ten minutes. */
export function scheduleKycReplacements(maintenance: RetentionDeps): void {
  const replace = once(() => runKycReplacements(maintenance).catch(log('KYC replacement')))
  replace()
  setInterval(replace, 600_000)
}

/** One round of everything `maintain` schedules (`maintain --once`, plan review R21). */
export async function runMaintenanceRound(d: RetentionDeps, config: Pick<Config, 'retention'>, opts: { kycReplacement: boolean }, now = new Date()): Promise<void> {
  await cleanOrphans(d.db, d.files).catch(log('orphan cleanup'))
  if (opts.kycReplacement) await runKycReplacements(d).catch(log('KYC replacement'))
  await runDaily(d, config, now)
}

export function scheduleMaintenance(d: RetentionDeps, config: Pick<Config, 'retention'>): void {
  let busy = false
  const guard = (fn: () => Promise<unknown>) => () => {
    if (busy) return
    busy = true
    void fn().finally(() => (busy = false))
  }
  guard(() => runDaily(d, config))()
  setInterval(guard(() => runDaily(d, config)), 24 * 3600_000)
  // committed deletions whose files are still there (a crash, a storage error): every ten minutes
  setInterval(guard(() => runFileDeletions(d).catch(log('file deletion'))), 600_000)
}
