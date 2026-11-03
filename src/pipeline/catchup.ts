// Catch-up from the stored cursor (PRD R-ING-02, C-ING-5): messages are handled in order and the cursor moves in the
// same transaction that records each one (or records it as gone). A temporary error stops the run with the cursor
// where it was; the next run starts again from there.
import type { MailboxAdapter } from '../adapters/mailbox/types.ts'
import { getText } from '../store/blobs.ts'
import { tx } from '../store/db.ts'
import { appendAudit } from '../store/audit.ts'
import { advanceCursor, ingestMessage, type IngestDeps, type MailboxInfo } from './ingest.ts'

export async function readCursor(deps: Pick<IngestDeps, 'db' | 'k'>, mailboxId: string, folderKey = ''): Promise<string | null> {
  const r = await deps.db.query<{ cursor_blob: string }>('SELECT cursor_blob FROM mailbox_cursor WHERE mailbox_id = $1 AND folder_key = $2', [mailboxId, folderKey])
  return r.rows[0] ? getText(deps.db, deps.k, r.rows[0].cursor_blob) : null
}

export interface CatchUpReport {
  created: number
  duplicates: number
  gaps: number
  resync: boolean
}

export async function catchUp(deps: IngestDeps, adapter: MailboxAdapter, info: MailboxInfo, hooks: { beforeIngest?: (index: number) => void | Promise<void> } = {}, folderKey = ''): Promise<CatchUpReport> {
  // one cursor per configured folder for Graph (PRD C-ING-6); '' for IMAP and Gmail
  const cursor = await readCursor(deps, adapter.id, folderKey)
  const { refs, cursor: end, resync } = await adapter.catchUp(cursor)
  const report: CatchUpReport = { created: 0, duplicates: 0, gaps: 0, resync: !!resync }
  if (resync) {
    await tx(deps.db, (c) => appendAudit(c, deps.k, [{ actor: 'system', type: 'ingest.resync', payload: { mailbox: adapter.id, messages: refs.length } }]))
  }
  for (const [i, ref] of refs.entries()) {
    await hooks.beforeIngest?.(i)
    const got = await adapter.fetchRaw(ref) // a network error propagates: the cursor stays before this message
    if ('gone' in got) {
      await tx(deps.db, async (c) => {
        await advanceCursor(c, deps.k, adapter.id, ref.key, folderKey)
        await appendAudit(c, deps.k, [{ actor: 'system', type: 'ingest.gap', payload: { mailbox: adapter.id } }])
      })
      report.gaps++
      continue
    }
    const r = await ingestMessage(deps, info, got.raw, got.serverReceivedAt, { value: ref.key, folderKey })
    if (r.status === 'created') report.created++
    else report.duplicates++
  }
  // nothing new: still record the position (e.g. after a resync of an empty folder)
  if (refs.length === 0 && end !== cursor) await tx(deps.db, (c) => advanceCursor(c, deps.k, adapter.id, end, folderKey))
  return report
}
