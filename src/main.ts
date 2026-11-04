// Entry point: `serve` (API, review UI, pipeline workers, IMAP catch-up) and maintenance commands.
//   node src/main.ts init-secrets <dir>
//   node src/main.ts migrate
//   node src/main.ts serve
//   node src/main.ts maintain [--once]
//   node src/main.ts import-eml <mailbox id> <file.eml>…
//   node src/main.ts audit verify | audit export <out.jsonl> | audit head
import { readFileSync, writeFileSync } from 'node:fs'
import { loadConfig, type Config } from './config/load.ts'
import { Keyring } from './store/crypto.ts'
import { pool, tx } from './store/db.ts'
import { migrate } from './store/migrate.ts'
import { chainHead, exportAudit, verifyAudit } from './store/audit.ts'
import { cleanOrphans, DiskStore } from './store/files.ts'
import { kycSink, runMaintenanceRound, scheduleKycDeliveries, scheduleKycReplacements, scheduleMaintenance } from './maintenance/daily.ts'
import { Clamd } from './adapters/scan/clamd.ts'
import { ImapAdapter } from './adapters/mailbox/imap.ts'
import { InProcessParser, SocketParser } from './pipeline/parser-client.ts'
import { BossQueue, RETRY, STAGES, type StageJob } from './pipeline/queue.ts'
import { deliverDue } from './pipeline/outbox.ts'
import { ensureMailboxes, ingestMessage } from './pipeline/ingest.ts'
import { stageHandler, type StageDeps } from './pipeline/stages.ts'
import { failureLabel } from './pipeline/failure.ts'
import { retryDeferredKyc } from './pipeline/kyc-recheck.ts'
import { rerunFailed } from './pipeline/restart.ts'
import { catchUp } from './pipeline/catchup.ts'
import { buildServer } from './server/app.ts'
import { bootstrapAdmin } from './server/auth.ts'
import { Oidc } from './server/oidc.ts'
import { demoGuard, recordConfig, recordKeys, startModel } from './startup.ts'
import { rotateKeys } from './maintenance/rotation.ts'
import { checkM365, startCloudMailboxes } from './pipeline/mailboxes.ts'
import { authUrl, exchangeAndSave, pkce } from './adapters/mailbox/gmail-auth.ts'
import { MailHttp } from './adapters/mailbox/http.ts'
import { createServer } from 'node:http'
import { initSecrets } from './ops/secrets.ts'
import { expandFileVariables } from './ops/env-files.ts'
import { checkDemoConfig, DEMO_ACCOUNTS, demoConfig, demoSampleMap, seedDemo } from './ops/demo.ts'
import { headExporter } from './ops/head-export.ts'

// compose passes secrets as files: <NAME>_FILE fills <NAME> before anything reads the environment
expandFileVariables(process.env)

const env = (name: string): string => {
  const file = process.env[`${name}_FILE`]
  const v = file ? readFileSync(file, 'utf8').trim() : process.env[name]
  if (!v) throw new Error(`${name} (or ${name}_FILE) is required`)
  return v
}

const DEMO = process.env.DEMO === '1'

function setup(databaseUrlEnv = 'APP_DATABASE_URL') {
  // DEMO=1: the evaluation configuration the replay was recorded with (PRD R-DEMO-01 v0.7.22)
  const config = DEMO ? demoConfig() : loadConfig(process.env.CONFIG_DIR ?? 'config/default')
  const k = Keyring.fromEnv({ ...process.env, DOI_MASTER_KEYS: env('DOI_MASTER_KEYS'), DOI_HMAC_KEY: env('DOI_HMAC_KEY') })
  const db = pool(env(databaseUrlEnv))
  const files = new DiskStore(process.env.FILES_DIR ?? '/var/lib/deal-ops-inbox/files', k)
  return { config, k, db, files }
}

async function serve(): Promise<void> {
  const { config, k, db, files } = setup()
  // R-PRV-01 before anything else starts: the classification and field steps need the configured model
  if (DEMO) checkDemoConfig(config) // nothing that reaches outside the demo (plan review R6)
  const llm = startModel(config)
  await demoGuard(db, DEMO)
  // a master key that data still needs must not be missing; record the write key (tech design v0.7.9)
  await recordKeys(db, k)
  // C-ING-4: Microsoft 365 permissions are checked before anything else runs; any doubt refuses the start
  const graphTokens = await checkM365(config, env)
  await ensureMailboxes(db, k, config)
  // the demo has its own accounts (seedDemo); a real deployment starts with the admin from the secret file
  if (!DEMO) await bootstrapAdmin(db, k, process.env.INITIAL_ADMIN_PASSWORD_FILE)
  const queue = new BossQueue(env('APP_DATABASE_URL'))
  await queue.start()
  await recordConfig(db, k, config, queue)
  // attachments are parsed only in the sandboxed parser container (tech design T7); in-process parsing would run
  // untrusted files next to the keys and the database, so it needs an explicit development switch (Codex F11)
  if (!process.env.PARSER_SOCKET && process.env.DEV_IN_PROCESS_PARSER !== '1') throw new Error('PARSER_SOCKET is required (the parser container)')
  const parser = process.env.PARSER_SOCKET ? new SocketParser(process.env.PARSER_SOCKET) : new InProcessParser()
  if (!process.env.PARSER_SOCKET) console.warn('DEV_IN_PROCESS_PARSER=1: attachments are parsed in-process, without the sandbox. Never in production.')
  const deps: StageDeps = { db, k, files, config, queue, scanner: new Clamd(process.env.CLAMD_HOST ?? 'clamav', Number(process.env.CLAMD_PORT ?? 3310)), parser, llm }

  for (const stage of STAGES) {
    // only a fixed code reaches the log and the job queue; the error's text goes to the encrypted audit (E6 D2)
    const handle = stageHandler(deps, stage, RETRY.retryLimit)
    await queue.boss.work<StageJob>(stage, { batchSize: 1, includeMetadata: true }, async ([job]) => handle(job!))
  }

  // the demo emails, once per reset, after the workers are listening (PRD R-DEMO-01; tech design v0.7.11)
  if (DEMO) {
    console.log(`demo: ${await seedDemo(deps, { filesDir: process.env.FILES_DIR ?? '/var/lib/deal-ops-inbox/files' })}`)
    // a second `docker compose up` resets the database under this process (migrate runs again): leave, so that the
    // restart policy starts a fresh process that loads the demo again (PRD R-DEMO-01 v0.7.22, self-test F7)
    setInterval(() => {
      void db.query<{ n: number }>('SELECT count(*)::int AS n FROM message').then(
        (r) => r.rows[0]!.n === 0 && demoReset('no demo emails left'),
        (e: Error) => demoReset(e.message),
      )
    }, 15_000)
  }

  // IMAP: IDLE triggers a catch-up; a timer catches up anyway (R-ING-02)
  for (const m of config.mailboxes.filter((x) => x.kind === 'imap')) {
    const adapter = new ImapAdapter({
      id: m.id, name: m.name, host: m.imap!.host, port: m.imap!.port, tls: m.imap!.tls, user: env(m.imap!.user_env), password: env(m.imap!.password_env), folder: m.imap!.folder,
      stripsExternalAuthResults: m.strips_external_auth_results,
    })
    const info = { id: m.id, trustedAuthResults: adapter.capabilities.trustedAuthResults, trustedAuthservId: m.trusted_authserv_id ?? '' }
    // one catch-up at a time per mailbox; a notification during a run asks for one more run afterwards (CC-F6)
    let running: Promise<unknown> | null = null
    let again = false
    const run = (): Promise<unknown> => {
      if (running) {
        again = true
        return running
      }
      running = catchUp(deps, adapter, info)
        .catch((e: unknown) => console.error(`catch-up ${m.id} failed: reason=${failureLabel(e)}`))
        .finally(() => {
          running = null
          if (again) {
            again = false
            void run()
          }
        })
      return running
    }
    await adapter.start(async () => void run()).catch((e: unknown) => console.error(`IMAP ${m.id} failed: reason=${failureLabel(e)}`))
    void run()
    setInterval(() => void run(), m.catch_up_minutes * 60_000)
  }
  // Gmail (history + watch via Pub/Sub pull) and Microsoft 365 (delta per folder): PRD R-ING-02, decision 6
  await startCloudMailboxes(deps, config, env, graphTokens)

  // event webhook (C-OUT-1): due deliveries every 30 seconds
  const hook = config.events.webhook
  if (hook) {
    const secret = env(hook.secret_env)
    let busy = false
    setInterval(() => {
      if (busy) return
      busy = true
      void deliverDue({ db, k }, { url: hook.url, secret }).catch((e: unknown) => console.error(`webhook delivery failed: reason=${failureLabel(e)}`)).finally(() => (busy = false))
    }, 30_000)
  }

  // KYC transfer as the app role (PRD R-PRV-03); retention, file deletions, the orphan clean-up and the KYC
  // replacement run in their own container with the maintenance role (`maintain`, tech design v0.7.11)
  scheduleKycDeliveries({ db, k, files }, kycSink(config, env), () => retryDeferredKyc(deps))

  // C-AUD-4: export the chain head daily
  const exportHead = headExporter(() => chainHead(db), config.audit.head_export_path)
  await exportHead()
  setInterval(() => void exportHead(), 24 * 3600_000)

  const o = config.auth.oidc
  const oidc = o ? new Oidc({ issuer: o.issuer, clientId: o.client_id, clientSecret: env(o.client_secret_env), redirectUri: o.redirect_uri, roleClaim: o.role_claim, roleMap: o.role_map }, k) : undefined
  const app = await buildServer({
    db, k, files, config, oidc, queue, webRoot: process.env.WEB_ROOT ?? 'dist/web', logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Secure cookies always, unless explicitly developing over plain http; trust only the configured proxy (WR-F6)
    // the demo too (self-audit S1: Safari refuses Secure cookies on http://localhost); it listens on 127.0.0.1 only
    secureCookies: process.env.DEV_INSECURE_COOKIES !== '1' && !DEMO, trustProxy: process.env.TRUST_PROXY || false,
    ...(DEMO ? { demo: { accounts: DEMO_ACCOUNTS, samples: () => demoSampleMap(db, k) } } : {}),
  })
  await app.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' })
}

/**
 * The maintenance container (PRD R-OPS-01 v0.7.22, tech design v0.7.11): the only running service with the
 * maintenance role's credentials. `--once` runs one round and exits (tests).
 */
async function maintain(once: boolean): Promise<void> {
  const { config, k, db, files } = setup('MAINTENANCE_DATABASE_URL')
  // the database decides, not only the environment: a demo database never gets the KYC replacement (PRD C-PRV-2's
  // demo exception, plan review W1), and is refused without DEMO=1
  const demo = await demoGuard(db, DEMO)
  // it writes encrypted values and files: the key fence first, as in `serve` (plan review R3)
  await recordKeys(db, k)
  const d = { db, k, files }
  if (once) {
    await runMaintenanceRound(d, config, { kycReplacement: !demo })
    await db.end()
    return
  }
  // orphan file clean-up, hourly (tech design §4, §4.1; CC-F5)
  const sweep = () => cleanOrphans(db, files).catch((e: unknown) => console.error(`orphan cleanup failed: reason=${failureLabel(e)}`))
  void sweep()
  setInterval(() => void sweep(), 3600_000)
  // retention, file deletions, directory versions, unused text (PRD R-PRV-02, C-PRV-1; tech design v0.7.9)
  scheduleMaintenance(d, config)
  // the replacement of transferred KYC attachments (PRD C-PRV-2); not in the demo (V3b)
  if (!demo) scheduleKycReplacements(d)
  console.log('maintenance running')
}

function demoReset(why: string): void {
  console.error(`demo: the database was reset (${why}); restarting to load the demo again`)
  process.exit(1)
}

/** `rerun-failed [case id …]`: failed Cases (all, or the ones named) again from the step that failed (tech design §6). */
async function rerunFailedCases(ids: string[]): Promise<void> {
  const { k, db } = setup()
  await demoGuard(db, DEMO)
  await recordKeys(db, k) // it writes: the key fence first, as import-eml
  for (const id of ids) if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error(`not a Case id: ${id}`)
  const targets = ids.length ? ids : (await db.query<{ id: string }>(`SELECT c.id FROM "case" c JOIN message m ON m.id = c.message_id WHERE c.status = 'failed' ORDER BY m.received_at, c.id`)).rows.map((r) => r.id)
  if (!targets.length) console.log('no failed Cases')
  const queue = new BossQueue(env('APP_DATABASE_URL'))
  await queue.start()
  for (const id of targets) {
    const g = await tx(db, (c) => rerunFailed(c, k, queue, id))
    console.log(g ? `${id}: running again from ${g.from}` : `${id}: not a failed Case, left as it is`)
  }
  await queue.stop()
  await db.end()
}

async function importEml(mailboxId: string, paths: string[]): Promise<void> {
  const { config, k, db, files } = setup()
  const m = config.mailboxes.find((x) => x.id === mailboxId)
  if (!m) throw new Error(`no mailbox ${mailboxId} in the configuration`)
  await demoGuard(db, DEMO) // a real message never goes into a demo database, which the next reset empties (Codex E5 F1)
  await recordKeys(db, k) // a writer too: the key fence applies before anything is written (round 2 F6, review S2)
  await ensureMailboxes(db, k, config)
  const queue = new BossQueue(env('APP_DATABASE_URL'))
  await queue.start()
  for (const p of paths) {
    // .eml imports never adopt authentication results; the receive time is the import time (C-SIG-1.1, C-SIG-2)
    const r = await ingestMessage({ db, k, files, config, queue }, { id: m.id, trustedAuthResults: false, trustedAuthservId: '' }, readFileSync(p), new Date().toISOString())
    console.log(`${p}: ${r.status}`)
  }
  await queue.stop()
  await db.end()
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'migrate':
      console.log(await migrate(env('OWNER_DATABASE_URL'), { doi_app: env('DOI_APP_DB_PASSWORD'), doi_maintenance: env('DOI_MAINTENANCE_DB_PASSWORD'), doi_rotation: env('DOI_ROTATION_DB_PASSWORD') }, { demo: process.env.DEMO === '1' }))
      return
    case 'serve':
      return serve()
    case 'init-secrets': {
      // tech design v0.7.11: run on the host's secret directory (docker run --user "$(id -u):$(id -g)" -v …)
      if (!rest[0]) throw new Error('usage: init-secrets <directory>')
      const r = initSecrets(rest[0])
      console.log(`created: ${r.created.join(', ') || 'none'}; kept: ${r.kept.join(', ') || 'none'}`)
      return
    }
    case 'maintain':
      return maintain(rest.includes('--once'))
    case 'import-eml':
      return importEml(rest[0]!, rest.slice(1))
    case 'rerun-failed':
      return rerunFailedCases(rest)
    case 'gmail-auth': {
      // PRD decision 6: one consent per mailbox, on the operator's machine (loopback + PKCE)
      // `--port <n>`: a fixed port, listening on all addresses inside the container; compose publishes it on the
      // host's 127.0.0.1 only (tech design v0.7.11, plan review R5 / V2). Without it: the loopback, a random port.
      const portAt = rest.indexOf('--port')
      const fixedPort = portAt >= 0 ? Number(rest[portAt + 1]) : 0
      if (portAt >= 0 && !(Number.isInteger(fixedPort) && fixedPort > 0 && fixedPort < 65536)) throw new Error('--port needs a port number')
      const mailboxId = rest.filter((_, i) => portAt < 0 || (i !== portAt && i !== portAt + 1))[0]
      const { config, k, db } = setup()
      const m = config.mailboxes.find((x) => x.id === mailboxId && x.kind === 'gmail')
      if (!m || !config.gmail) throw new Error(`no gmail mailbox ${mailboxId} in the configuration`)
      await demoGuard(db, DEMO) // no real credential in a demo database (Codex E5 F1)
      await recordKeys(db, k) // it writes encrypted values: the key fence first (round 2 F6, review S2)
      await ensureMailboxes(db, k, config)
      const p = pkce()
      const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
        const srv = createServer((req, res) => {
          const u = new URL(req.url ?? '/', 'http://127.0.0.1')
          if (u.searchParams.get('state') !== p.state || !u.searchParams.get('code')) {
            res.end('Authorisation failed or was cancelled. You can close this page.')
            srv.close()
            return reject(new Error('no authorisation code'))
          }
          res.end('Authorised. You can close this page and return to the terminal.')
          srv.close()
          resolve({ code: u.searchParams.get('code')!, redirect })
        })
        let redirect = ''
        srv.listen(fixedPort, fixedPort ? '0.0.0.0' : '127.0.0.1', () => {
          // the browser runs on the operator's machine: the redirect is always that machine's loopback address
          redirect = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
          console.log(`Open this address in a browser and sign in as ${m.gmail!.address}:\n${authUrl(env(config.gmail!.client_id_env), redirect, m.gmail!.address, p)}\n(On a server without a browser: forward the port with ssh -L first.)`)
        })
      })
      await exchangeAndSave({ db, k, http: new MailHttp() }, { mailboxId: m.id, address: m.gmail!.address, clientId: env(config.gmail.client_id_env), clientSecret: env(config.gmail.client_secret_env), redirect: code.redirect, code: code.code, verifier: p.verifier })
      console.log(`Saved: ${m.id} reads ${m.gmail!.address} with gmail.readonly.`)
      await db.end()
      return
    }
    case 'rotate-keys': {
      // tech design §5, v0.7.9: its own process and role; DOI_MASTER_KEYS holds the old keys and the new active one
      // the rotation role only: the rotate service has no app credentials (docs review)
      const { k, files, db } = setup('ROTATION_DATABASE_URL')
      await demoGuard(db, DEMO) // the demo database only with DEMO=1, here too (Codex E5 F1)
      const r = await rotateKeys({ db, k, files })
      console.log(`rotation ${r.rotation} complete: ${r.blobs} text values and ${r.files} files rewrapped, ${r.sampled} checked with ${k.active.id} alone`)
      await db.end()
      return
    }
    case 'audit': {
      const db = pool(env('APP_DATABASE_URL'))
      if (rest[0] === 'verify') {
        const v = await verifyAudit(db)
        console.log(v.ok ? `ok: ${v.count} records, head ${v.head?.seq} ${v.head?.hash}` : `BROKEN at seq ${v.badSeq}`)
        process.exitCode = v.ok ? 0 : 1
      } else if (rest[0] === 'export') {
        const lines: string[] = []
        const n = await exportAudit(db, (l) => lines.push(l))
        writeFileSync(rest[1]!, `${lines.join('\n')}\n`)
        console.log(`${n} records`)
      } else if (rest[0] === 'head') console.log(JSON.stringify(await chainHead(db)))
      await db.end()
      return
    }
    default:
      console.log('usage: init-secrets <dir> | migrate | serve | maintain [--once] | import-eml <mailbox> <files…> | gmail-auth <mailbox> | rotate-keys | audit verify|export <file>|head')
      process.exitCode = 2
  }
}

export type { Config }
await main(process.argv.slice(2)).catch((e: Error) => {
  // the message only: configuration errors name file and line; secrets are never part of an error
  console.error(e.message)
  process.exit(1)
})
