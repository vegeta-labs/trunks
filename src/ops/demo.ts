// Demo mode, DEMO=1 (PRD R-DEMO-01 v0.7.22, tech design v0.7.11): the evaluation configuration and directory, 31
// development-set emails received the way the evaluation receives them, replayed model replies, three demo accounts.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type Config } from '../config/load.ts'
import { createUser, usernameHmac, type Role } from '../server/auth.ts'
import { importDirectory } from '../store/directory.ts'
import { tx, type Db } from '../store/db.ts'
import type { Keyring } from '../store/crypto.ts'
import { ingestMessage, msgIdNorm, type MailboxInfo } from '../pipeline/ingest.ts'
import type { StageDeps } from '../pipeline/stages.ts'

/** Test plan §2.12: every class, the multi-class, non-English and look-alike cases, injections with their twins. */
export const DEMO_SAMPLES = [
  'E0001', 'E0015', 'E0024', 'E0035', 'E0045', 'E0053', 'E0063', 'E0072', 'E0082', 'E0090', 'E0098', 'E0105', 'E0112', 'E0120', 'E0128',
  'E0134', 'E0144', 'E0152', 'E0161', 'E0171', 'E0201', 'E0209', 'E0225', 'E0232', 'E0252', 'E0253', 'E0264', 'E0265', 'E0287', 'E0295', 'E1012',
] as const

/** Fixed and published (the demo holds only fictional data and listens on 127.0.0.1); never asked to change. */
export const DEMO_ACCOUNTS: ReadonlyArray<{ username: string; password: string; role: Role }> = [
  { username: 'demo-reviewer', password: 'demo-reviewer-password', role: 'reviewer' },
  { username: 'demo-approver', password: 'demo-approver-password', role: 'approver' },
  { username: 'demo-admin', password: 'demo-admin-password', role: 'admin' },
]

export const DEMO_KYC_DIR = '/var/lib/deal-ops-inbox/kyc'
const EVAL = 'eval'

/**
 * The evaluation configuration (the replay recordings were made with it), with one deployment difference: KYC
 * attachments go to a folder on the demo volume (plan review R16). Nothing the model sees depends on it.
 */
export function demoConfig(dir = join(EVAL, 'config'), kycDir = DEMO_KYC_DIR): Config {
  const c = loadConfig(dir)
  return { ...c, kyc: { ...c.kyc, target: { kind: 'folder', path: kycDir } } }
}

/** Refuses whatever would reach outside the demo (plan review R6): real mailboxes, a model, webhooks, OIDC. */
export function checkDemoConfig(c: Config): void {
  const problems: string[] = []
  for (const m of c.mailboxes) if (m.kind !== 'eml') problems.push(`mailbox ${m.id} is ${m.kind} (only eml)`)
  if (c.model?.provider !== 'replay') problems.push(`model provider ${c.model?.provider ?? 'none'} (only replay)`)
  if (c.events.webhook) problems.push('an event webhook')
  if (c.kyc.target?.kind === 'webhook') problems.push('a KYC webhook')
  if (c.auth.oidc) problems.push('OIDC')
  if (problems.length) throw new Error(`refusing to start the demo: ${problems.join('; ')}`)
}

interface DemoAnnotation {
  received_at: string
  mailbox: string
  mailbox_strips_auth_results: boolean
  prior_messages: unknown[]
}

/**
 * Fills a freshly reset demo database: the demo accounts, the evaluation directory, then the demo emails in the order
 * of their receive times (plan review R13). Resumable (Codex E5 F2): a run interrupted at any point is finished by the
 * next one — existing accounts are kept, the directory is imported once, an email already received is a duplicate —
 * and it is complete only when every demo email is there.
 */
export async function seedDemo(deps: StageDeps, opts: { evalDir?: string; filesDir?: string } = {}): Promise<'seeded' | 'already'> {
  const { db, k, config } = deps
  const dir = opts.evalDir ?? EVAL
  const messages = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM message')).rows[0]!.n)
  if (messages >= DEMO_SAMPLES.length) return 'already'
  // files of an earlier demo run belong to rows the reset removed (only on an empty database: never a resumed one)
  if (messages === 0 && opts.filesDir) for (const f of readdirSync(opts.filesDir)) rmSync(join(opts.filesDir, f), { recursive: true, force: true })
  const ids = await createDemoAccounts(db, k)
  await importEvalDirectory(db, k, config, join(dir, 'directory'), ids.get('demo-admin')!)
  const samples = DEMO_SAMPLES.map((id) => ({ id, ann: JSON.parse(readFileSync(join(dir, 'dev', `${id}.json`), 'utf8')) as DemoAnnotation }))
    .sort((a, b) => a.ann.received_at.localeCompare(b.ann.received_at) || a.id.localeCompare(b.id))
  for (const { id, ann } of samples) {
    if (ann.prior_messages.length) throw new Error(`demo sample ${id} needs earlier messages; the demo list takes none (test plan §2.12)`)
    // as the evaluation receives it (eval/run.ts): its own mailbox setting and receive time
    const mailbox: MailboxInfo = { id: ann.mailbox, trustedAuthResults: ann.mailbox_strips_auth_results, trustedAuthservId: config.mailboxes.find((m) => m.id === ann.mailbox)?.trusted_authserv_id ?? '' }
    await ingestMessage(deps, mailbox, readFileSync(join(dir, 'dev', `${id}.eml`)), ann.received_at)
  }
  return 'seeded'
}

/** The three accounts; one that already exists (an interrupted earlier run) is kept as it is. */
async function createDemoAccounts(db: Db, k: Keyring): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const a of DEMO_ACCOUNTS) {
    const have = await db.query<{ id: string }>('SELECT id FROM app_user WHERE username_hmac = $1', [usernameHmac(k, a.username)])
    ids.set(a.username, have.rows[0]?.id ?? (await tx(db, (c) => createUser(c, k, { username: a.username, role: a.role, password: a.password, by: null, mustChange: false }))))
  }
  return ids
}

/**
 * The evaluation directory exactly as `eval/run.ts` imports it (deals, then each deal's files, then contacts). Each
 * file is imported unless that very file (kind + SHA-256) already is: an interrupted earlier run is completed file by
 * file (Codex E5 round 2 F2).
 */
async function importEvalDirectory(db: Db, k: Keyring, config: Config, dir: string, userId: string): Promise<void> {
  const csv = (f: string) => readFileSync(join(dir, f), 'utf8')
  const one = async (kind: Parameters<typeof importDirectory>[2]['kind'], text: string, deal?: string) => {
    const sha = createHash('sha256').update(text).digest('hex')
    if (((await db.query('SELECT 1 FROM directory_version WHERE kind = $1 AND file_sha256 = $2', [kind, sha])).rowCount ?? 0) > 0) return
    const r = await importDirectory(db, k, { kind, csv: text, userId, ...(deal ? { deal } : {}), currencies: config.deployment.currencies })
    if (!r.ok) throw new Error(`demo directory ${kind}${deal ? ` (${deal})` : ''}: ${JSON.stringify(r.errors)}`)
  }
  await one('deals', csv('deals.csv'))
  const names = csv('deals.csv').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')[1]!)
  const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  const files = readdirSync(dir)
  for (const name of names) {
    for (const kind of ['commitments', 'bank', 'ledger'] as const) {
      const f = `${kind}_${slug(name)}.csv`
      if (files.includes(f)) await one(kind, csv(f), name)
    }
  }
  await one('contacts', csv('contacts.csv'))
}

/**
 * Case ID → evaluation sample ID for every demo email, found again by its Message-ID (site interface T2): the static
 * snapshot names each case by its sample, so links like #case=E0225 survive a rebuild.
 */
export async function demoSampleMap(db: Db, k: Keyring, evalDir = EVAL): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const id of DEMO_SAMPLES) {
    const raw = readFileSync(join(evalDir, 'dev', `${id}.eml`), 'latin1')
    const header = /^Message-ID:\s*(.+(?:\r?\n[ \t].+)*)/im.exec(raw.split(/\r?\n\r?\n/)[0]!)?.[1]
    if (!header) throw new Error(`demo sample ${id} has no Message-ID`)
    const r = await db.query<{ id: string }>('SELECT c.id FROM "case" c JOIN message m ON m.id = c.message_id WHERE m.message_id_hmac = $1', [k.hmac(`msgid\0${msgIdNorm(header.replace(/\r?\n[ \t]+/g, ' '))}`)])
    if (r.rows.length !== 1) throw new Error(`demo sample ${id}: ${r.rows.length} cases with its Message-ID`)
    out[r.rows[0]!.id] = id
  }
  return out
}
