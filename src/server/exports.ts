// PRD R-OUT-02, R-OUT-03, C-OUT-2: the suggested-actions and Case CSVs. Only the listed columns; every cell is scanned
// for full account and ID numbers after it is written, and such a cell is withheld.
import type { Keyring } from '../store/crypto.ts'
import type { Db } from '../store/db.ts'
import type { Config } from '../config/load.ts'
import { getBlobs } from '../store/blobs.ts'
import { resultOf } from '../pipeline/stages.ts'
import { ACTION_COLUMNS, CASE_COLUMNS, csvAmount, PAYMENT_ACTIONS, toCsv } from '../lib/output.ts'
import { fullNumbers } from '../lib/redact.ts'
import { currentActions, outputGeneration, type LinkResult, type ReplyStageResult, type RiskStageResult } from '../pipeline/stages-e3.ts'

const WITHHELD = '(withheld: account or ID number)'
const scanned = <C extends string>(row: Record<C, string | null>): Record<C, string | null> =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && fullNumbers(v).length ? WITHHELD : v])) as Record<C, string | null>

interface Row {
  id: string
  received_at: Date
  mailbox_id: string
  header_blob: string
  status: string
  risk: string | null
  queue: string | null
  assignee: string | null
  due_at: Date | null
  closed_at: Date | null
  outcome: string | null
  processing_generation: number
  pipeline_complete_generation: number | null
}

async function cases(d: { db: Db; k: Keyring }): Promise<Row[]> {
  return (await d.db.query<Row>(
    `SELECT c.id, m.received_at, m.mailbox_id, m.header_blob, c.status, c.risk, c.queue, c.assignee, c.due_at, c.closed_at, c.outcome, c.processing_generation, c.pipeline_complete_generation
       FROM "case" c JOIN message m ON m.id = c.message_id ORDER BY m.received_at, c.id`,
  )).rows
}

export async function actionsCsv(d: { db: Db; k: Keyring; config: Config }): Promise<string> {
  const rows: Array<Record<(typeof ACTION_COLUMNS)[number], string | null>> = []
  for (const x of await cases(d)) {
    // the same generation as the review page and the events (self-review R2 / S5)
    const { gen } = await outputGeneration(d.db, x.id, x.processing_generation, x.pipeline_complete_generation)
    const rp = await resultOf<ReplyStageResult>(d, x.id, 'reply', gen)
    const lk = await resultOf<LinkResult>(d, x.id, 'link', gen)
    // the reply in use now decides the actions (C-OUT-3, Codex round 2 F18)
    const acts = rp ? await currentActions(d.db, x.id, gen, rp) : []
    for (const a of acts) {
      const payment = PAYMENT_ACTIONS.includes(a.action)
      rows.push(scanned({
        case_id: x.id, received_at: x.received_at.toISOString(), deal: lk?.dealName ?? null, investor_id: lk?.commitment?.key ?? null, investor_name: lk?.commitment?.investorName ?? null,
        action: a.action, details: a.details, amount: payment && lk?.commitment ? csvAmount(lk.commitment.cashDue) : null, status: x.status, currency: lk?.commitment?.currency ?? null,
      }))
    }
  }
  return toCsv(ACTION_COLUMNS, rows, ['amount'])
}

export async function casesCsv(d: { db: Db; k: Keyring; config: Config }): Promise<string> {
  const list = await cases(d)
  const headers = await getBlobs(d.db, d.k, list.map((x) => x.header_blob))
  const users = new Map((await d.db.query<{ id: string; username_blob: string }>('SELECT id, username_blob FROM app_user')).rows.map((u) => [u.id, u.username_blob]))
  const names = await getBlobs(d.db, d.k, [...users.values()])
  const mailboxes = new Map(d.config.mailboxes.map((m) => [m.id, m.name]))
  const rows = []
  for (const x of list) {
    const h = JSON.parse(headers.get(x.header_blob)!.toString('utf8')) as { from: string | null }
    const { gen } = await outputGeneration(d.db, x.id, x.processing_generation, x.pipeline_complete_generation)
    // the classes and the risk of that generation (Codex round 4 F26, self-review T2)
    const labels = [...((await resultOf<ReplyStageResult>(d, x.id, 'reply', gen))?.labels.adopted ?? [])]
    const risk = (await resultOf<RiskStageResult>(d, x.id, 'risk', gen))?.final ?? null
    rows.push(scanned({
      case_id: x.id, received_at: x.received_at.toISOString(), mailbox: mailboxes.get(x.mailbox_id) ?? x.mailbox_id, from: h.from, classes: labels.sort().join(';'), risk, queue: x.queue,
      assignee: x.assignee && users.has(x.assignee) ? names.get(users.get(x.assignee)!)!.toString('utf8') : null, status: x.status, due_at: x.due_at?.toISOString() ?? null,
      closed_at: x.closed_at?.toISOString() ?? null, outcome: x.outcome,
    }))
  }
  return toCsv(CASE_COLUMNS, rows)
}
