// Gmail and Microsoft 365 in the service (PRD R-ING-01/02, C-ING-4, C-ING-6, decision 6): adapters from the
// configuration, the C-ING-4 check before anything starts, one catch-up at a time per (mailbox, folder), a timer, the
// Gmail notifications, and the daily watch renewal.
import type { Config } from '../config/load.ts'
import { MailHttp } from '../adapters/mailbox/http.ts'
import { GraphAdapter, GraphTokens, m365PermissionProblems, resolveFolders } from '../adapters/mailbox/graph.ts'
import { storedRefreshToken } from '../adapters/mailbox/gmail-auth.ts'
import type { MailboxAdapter } from '../adapters/mailbox/types.ts'
import { guardedCatchUp, guardedRenew, setStatus } from './mailbox-runtime.ts'
import { GmailAdapter, GmailTokens, Temporary, TokenRevoked, WrongAccount } from '../adapters/mailbox/gmail.ts'
import type { IngestDeps } from './ingest.ts'

type Env = (name: string) => string

/** C-ING-4: refuses the start (throws) when any check fails or is uncertain. */
export async function checkM365(config: Config, env: Env, http = new MailHttp()): Promise<GraphTokens | null> {
  const m = config.m365
  const graphBoxes = config.mailboxes.filter((x) => x.kind === 'graph')
  if (!m || !graphBoxes.length) return null
  const tokens = new GraphTokens(http, {
    tenantId: m.tenant_id, clientId: m.client_id,
    ...(m.certificate_key_env ? { certificate: { privateKeyPem: env(m.certificate_key_env), thumbprintHex: m.certificate_thumbprint! } } : { secret: env(m.client_secret_env!) }),
  })
  const problems = await m365PermissionProblems(http, tokens, {
    clientId: m.client_id, permissionReview: m.permission_review, negativeProbe: m.negative_probe_mailbox, mailboxes: graphBoxes.map((x) => x.graph!.user),
  })
  if (problems.length) throw new Error(`refusing to start (Microsoft 365 permission check): ${problems.join('; ')}`)
  return tokens
}

function serial(fn: () => Promise<unknown>): () => void {
  let running: Promise<unknown> | null = null
  let again = false
  const run = (): void => {
    if (running) {
      again = true
      return
    }
    running = fn().finally(() => {
      running = null
      if (again) {
        again = false
        run()
      }
    })
  }
  return run
}

export async function startCloudMailboxes(deps: IngestDeps, config: Config, env: Env, graphTokens: GraphTokens | null, http = new MailHttp()): Promise<MailboxAdapter[]> {
  const started: MailboxAdapter[] = []
  for (const m of config.mailboxes.filter((x) => x.kind === 'gmail')) {
    const g = config.gmail!
    const tokens = new GmailTokens(http, { address: m.gmail!.address, clientId: env(g.client_id_env), clientSecret: env(g.client_secret_env), refreshToken: () => storedRefreshToken(deps.db, deps.k, m.id) })
    const sa = g.pubsub ? (JSON.parse(env(g.pubsub.service_account_env)) as { client_email: string; private_key: string }) : null
    const adapter = new GmailAdapter(
      { id: m.id, name: m.name, address: m.gmail!.address, labels: m.gmail!.labels, stripsExternalAuthResults: m.strips_external_auth_results, ...(g.pubsub && sa ? { pubsub: { topic: g.pubsub.topic, subscription: g.pubsub.subscription, serviceAccount: sa } } : {}) },
      http,
      tokens,
    )
    const info = { id: m.id, trustedAuthResults: adapter.capabilities.trustedAuthResults, trustedAuthservId: m.trusted_authserv_id ?? '' }
    const run = serial(() => guardedCatchUp(deps, adapter, info))
    // resolves the labels: a missing one refuses the start (C-ING-6); a revoked token or the wrong account only stops
    // this mailbox, with its warning; the others and the review UI start (Codex E4 F11)
    try {
      await adapter.start(async () => run())
    } catch (e) {
      if (e instanceof TokenRevoked) await setStatus(deps, m.id, 'catch_up', 'auth_failed')
      else if (e instanceof WrongAccount) await setStatus(deps, m.id, 'catch_up', 'wrong_account')
      else if (!(e instanceof Temporary)) throw e // ConfigError: a missing label refuses the start (C-ING-6)
    }
    run()
    setInterval(run, m.catch_up_minutes * 60_000)
    const renew = () => void guardedRenew(deps, adapter)
    renew()
    setInterval(renew, 24 * 3600_000) // the watch lasts 7 days
    started.push(adapter)
  }
  for (const m of config.mailboxes.filter((x) => x.kind === 'graph')) {
    const folders = await resolveFolders(http, graphTokens!, m.graph!.user, m.graph!.folders) // a missing folder refuses the start
    for (const f of folders) {
      const adapter = new GraphAdapter({ id: m.id, name: m.name, user: m.graph!.user, folderId: f.id, stripsExternalAuthResults: m.strips_external_auth_results }, http, graphTokens!)
      const info = { id: m.id, trustedAuthResults: adapter.capabilities.trustedAuthResults, trustedAuthservId: m.trusted_authserv_id ?? '' }
      const run = serial(() => guardedCatchUp(deps, adapter, info, f.id))
      run()
      setInterval(run, m.catch_up_minutes * 60_000)
      started.push(adapter)
    }
  }
  return started
}

