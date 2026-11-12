// Versioned YAML configuration, validated at start-up (PRD R-CFG-01): an invalid file stops the start and the error
// names the file and the line. The configuration hash feeds `config.changed` (R-CFG-02).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LineCounter, parseDocument, isMap, isSeq, type Node } from 'yaml'
import { z } from 'zod'
import { CLASS_FIELDS_KNOWN, ENGLAND_WALES_HOLIDAYS } from './constants.ts'
import { checkTemplate, REQUIRED_TEMPLATES, type TemplateMeta } from '../lib/draft.ts'
import { MIN_COOLING_HOURS } from '../lib/verification.ts'
import { INLINE_DEFAULTS } from '../lib/kyc.ts'

const ID = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lower-case letters, digits and _')
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM')
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const DOMAIN = z.string().regex(/^[a-z0-9.-]+\.[a-z0-9-]+$/i, 'a domain name')

const Imap = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean(),
  user_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  password_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  folder: z.string().min(1).default('INBOX'),
})

const ENV = z.string().regex(/^[A-Z][A-Z0-9_]*$/)
const EMAIL = z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'an e-mail address')

// PRD C-ING-6: the labels / folders to receive, by name (resolved to ids at start-up); never sent, drafts, spam, trash
const NEVER_LABELS = ['SENT', 'DRAFT', 'SPAM', 'TRASH']
const Gmail = z.strictObject({
  address: EMAIL,
  labels: z.array(z.string().min(1)).min(1).default(['INBOX']).refine((l) => !l.some((x) => NEVER_LABELS.includes(x.toUpperCase())), 'SENT, DRAFT, SPAM and TRASH are never received (C-ING-6)'),
})
const Graph = z.strictObject({ user: EMAIL, folders: z.array(z.string().min(1)).min(1).default(['Inbox']) })

const Mailbox = z
  .strictObject({
    id: ID,
    name: z.string().min(1),
    kind: z.enum(['imap', 'eml', 'gmail', 'graph']),
    imap: Imap.optional(),
    gmail: Gmail.optional(),
    graph: Graph.optional(),
    strips_external_auth_results: z.boolean().default(false),
    trusted_authserv_id: z.string().min(1).optional(),
    catch_up_minutes: z.number().int().min(1).max(1440).default(5),
  })
  .superRefine((m, ctx) => {
    if (m.kind === 'imap' && !m.imap) ctx.addIssue({ code: 'custom', path: ['imap'], message: 'required for an imap mailbox' })
    if (m.kind === 'gmail' && !m.gmail) ctx.addIssue({ code: 'custom', path: ['gmail'], message: 'required for a gmail mailbox' })
    if (m.kind === 'graph' && !m.graph) ctx.addIssue({ code: 'custom', path: ['graph'], message: 'required for a graph mailbox' })
    if (m.kind === 'eml' && m.strips_external_auth_results) {
      ctx.addIssue({ code: 'custom', path: ['strips_external_auth_results'], message: '.eml imports never adopt authentication results (C-SIG-1.1)' })
    }
    if (m.strips_external_auth_results && !m.trusted_authserv_id) ctx.addIssue({ code: 'custom', path: ['trusted_authserv_id'], message: 'required when stripping is declared' })
  })

export const DeploymentFile = z.strictObject({
  deployment: z.strictObject({
    name: z.string().min(1),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz })
        return true
      } catch {
        return false
      }
    }, 'an IANA time zone'),
    currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
  }),
  mailboxes: z.array(Mailbox).min(1),
  // PRD decision 6: Gmail with one OAuth refresh token per mailbox (trunks gmail-auth); watch notifications by Pub/Sub pull
  gmail: z
    .strictObject({
      client_id_env: ENV,
      client_secret_env: ENV,
      pubsub: z.strictObject({ topic: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/), subscription: z.string().regex(/^projects\/[^/]+\/subscriptions\/[^/]+$/), service_account_env: ENV }).optional(),
    })
    .optional(),
  // PRD C-ING-4, R-ING-07: Microsoft 365 by client credentials (certificate or secret), checked at every start
  m365: z
    .strictObject({
      tenant_id: z.string().regex(/^[0-9a-f-]{36}$/i, 'the tenant id (a GUID)'),
      client_id: z.string().regex(/^[0-9a-f-]{36}$/i, 'the application (client) id'),
      client_secret_env: ENV.optional(),
      certificate_key_env: ENV.optional(), // PEM private key
      certificate_thumbprint: z.string().regex(/^[0-9A-Fa-f]{40}$/).optional(), // SHA-1, hex
      permission_review: z.strictObject({ date: ISO_DATE, reviewer: z.string().min(1) }).optional(), // C-ING-4 ①: checked at start, not here
      negative_probe_mailbox: EMAIL,
    })
    .refine((m) => !!m.client_secret_env !== !!m.certificate_key_env, 'exactly one of client_secret_env and certificate_key_env')
    .refine((m) => !m.certificate_key_env || !!m.certificate_thumbprint, 'certificate_thumbprint is required with certificate_key_env')
    .optional(),
  esign_platforms: z.record(z.string().min(1), z.array(DOMAIN).min(1)),
  attachments: z.strictObject({
    max_attachment_bytes: z.number().int().positive(),
    max_total_bytes: z.number().int().positive(),
    max_pdf_pages: z.number().int().positive(),
    parse_timeout_seconds: z.number().int().positive().max(300),
    max_nesting: z.number().int().min(0).max(3),
  }),
  // word lists: words may be added; the built-in lists cannot be shortened (C-SIG-1.8, C-RSK-2a, C-FRD-3)
  signals: z.strictObject({ injection_markers_extra: z.array(z.string().min(1)).default([]), pressure_words_extra: z.array(z.string().min(1)).default([]) }),
  replies: z.strictObject({ internal_terms_extra: z.array(z.string().min(1)).default([]) }).default({ internal_terms_extra: [] }),
  // C-RTE-1, C-RTE-2, R-RTE-02
  routing: z
    .strictObject({
      working_hours: z.strictObject({ start: HHMM, end: HHMM }).refine((w) => w.start < w.end, 'start before end').default({ start: '09:00', end: '18:00' }),
      targets_working_hours: z.record(ID, z.number().positive()).default({ ops: 2 }),
      default_target_working_hours: z.number().positive().default(9),
      remind_share: z.number().gt(0).lt(1).default(0.25),
      holidays: z.array(ISO_DATE).default([...ENGLAND_WALES_HOLIDAYS]),
      follow_up: z.strictObject({ enabled: z.boolean(), working_days: z.number().int().positive() }).default({ enabled: true, working_days: 10 }),
    })
    .default({ working_hours: { start: '09:00', end: '18:00' }, targets_working_hours: { ops: 2 }, default_target_working_hours: 9, remind_share: 0.25, holidays: [...ENGLAND_WALES_HOLIDAYS], follow_up: { enabled: true, working_days: 10 } }),
  // C-FRD-4: at least one hour, never zero
  verification: z.strictObject({ cooling_off_hours: z.number().min(MIN_COOLING_HOURS) }).default({ cooling_off_hours: 24 }),
  // C-OUT-1: HTTPS only; the signing secret comes from the environment
  events: z
    .strictObject({ webhook: z.strictObject({ url: z.string().url().refine((u) => u.startsWith('https://'), 'an https:// address'), secret_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).optional() })
    .default({}),
  audit: z.strictObject({ head_export_path: z.string().min(1) }),
  // C-PRV-1: whole days counted from the received time, or forever (v0.7.18: directory versions from unreferenced_since)
  retention: z
    .strictObject({ messages_days: z.union([z.number().int().positive(), z.literal('forever')]).default(1826), directory_days: z.union([z.number().int().positive(), z.literal('forever')]).default(1826) })
    .default({ messages_days: 1826, directory_days: 1826 }),
  // R-PRV-03, C-PRV-2: where possible-KYC attachments are transferred; absent → transfers fail and are reminded daily
  kyc: z
    .strictObject({
      inline_image: z.strictObject({
        max_long_side: z.number().int().positive().max(1280).default(400),
        max_short_side: z.number().int().positive().max(300).default(150),
        max_bytes: z.number().int().positive().max(102400).default(51200),
      }).default(INLINE_DEFAULTS),
      target: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('folder'), path: z.string().min(1) }),
        z.strictObject({ kind: z.literal('webhook'), url: z.string().url().refine((u) => u.startsWith('https://'), 'an https:// address'), secret_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
      ]).optional(),
    })
    .default({ inline_image: INLINE_DEFAULTS }),
  // the model provider (tech design §3.2, PRD R-PRV-01); absent → no model step can run
  model: z
    .strictObject({
      provider: z.enum(['anthropic', 'ollama', 'replay']),
      model_id: z.string().min(1),
      location: z.enum(['local', 'external']),
      region: z.string().min(1).optional(),
      dpa: z.boolean(),
      no_training: z.boolean(),
      transfer_basis: z.string().min(1).optional(),
      allow_without_dpa: z.boolean().default(false),
      api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('ANTHROPIC_API_KEY'),
      // no user name or password in the address: it would end up in error messages and logs (Codex E2 round 3 F15)
      // URL.canParse first: the refine runs even when .url() failed, and new URL() would throw (self-review S3)
      ollama_host: z.string().url().refine((u) => { if (!URL.canParse(u)) return true; const x = new URL(u); return !x.username && !x.password }, 'no user name or password in ollama_host').optional(),
      replay_dir: z.string().min(1).optional(),
    })
    // R-PRV-01: a hosted provider cannot be declared local to skip the data processing agreement check
    .refine((m) => m.provider !== 'anthropic' || m.location === 'external', { message: 'provider anthropic is always location: external', path: ['location'] })
    .optional(),
  auth: z
    .strictObject({
      session_hours: z.number().int().min(1).max(24 * 14).default(12),
      oidc: z
        .strictObject({
          issuer: z.string().url(),
          client_id: z.string().min(1),
          client_secret_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
          redirect_uri: z.string().url(),
          role_claim: z.string().min(1),
          role_map: z.record(z.string(), z.enum(['reviewer', 'approver', 'admin'])),
        })
        .optional(),
    })
    .default({ session_hours: 12 }),
})

export const CasesFile = z.strictObject({
  classes: z.array(z.strictObject({ id: ID, risk_floor: z.enum(['low', 'medium', 'high']), queue: ID, fields: z.array(z.string()).optional() })).min(1),
})

export const TemplatesFile = z.strictObject({
  templates: z.array(z.strictObject({ id: ID, subject: z.string().min(1), body: z.string().min(1), discloses_record: z.boolean().optional(), asserts_receipt: z.boolean().optional() })).min(1),
})

export type DeploymentConfig = z.infer<typeof DeploymentFile>
export type Config = DeploymentConfig & {
  classes: z.infer<typeof CasesFile>['classes']
  templates: z.infer<typeof TemplatesFile>['templates']
  templateMeta: ReadonlyMap<string, TemplateMeta> // C-DRF-1: placeholders and `discloses_record`, decided at load
  sha256: string
  dir: string
}

export class ConfigError extends Error {}

type Located = { file: string; line: number; path: string; message: string }

function locate(_file: string, text: string, path: ReadonlyArray<PropertyKey>): number {
  const lc = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lc })
  // walk down as far as the path exists; report the deepest node found
  let node: unknown = doc.contents
  let range: [number, number, number] | undefined = (node as Node | null)?.range ?? undefined
  for (const key of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => (p.key as { value?: unknown } | null)?.value === key)
      if (!pair) break
      node = pair.value
      range = (pair.key as Node).range ?? range
    } else if (isSeq(node) && typeof key === 'number') {
      node = node.items[key]
      range = (node as Node | undefined)?.range ?? range
    } else break
  }
  return range ? lc.linePos(range[0]).line : 1
}

// R-CFG-03: a key that tries to switch off a fixed rule (C-FRD) or to replace a built-in word list fails with its own message
const HARD = /(^|_)(fraud|frd|hard_rules?|fixed_rules?|bank_details_rule|payment_evidence_rule|internal_terms|injection_markers|pressure_words)($|_)/
function hardRuleKeys(v: unknown, path: PropertyKey[] = []): PropertyKey[][] {
  if (Array.isArray(v)) return v.flatMap((x, i) => hardRuleKeys(x, [...path, i]))
  if (!v || typeof v !== 'object') return []
  return Object.entries(v).flatMap(([k, x]) => [...(HARD.test(k) && !k.endsWith('_extra') ? [[...path, k]] : []), ...hardRuleKeys(x, [...path, k])])
}

function parseFile<T extends z.ZodType>(dir: string, name: string, schema: T): { value: z.infer<T>; text: string } {
  const file = join(dir, name)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new ConfigError(`${file}: missing`)
  }
  const lc = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true })
  if (doc.errors.length) {
    const e = doc.errors[0]!
    throw new ConfigError(`${file}:${e.linePos?.[0]?.line ?? 1}: ${e.message.split('\n')[0]}`)
  }
  const hard = hardRuleKeys(doc.toJS())
  if (hard.length) throw new ConfigError(hard.map((path) => `${file}:${locate(file, text, path)}: ${path.join('.')}: the fixed rules and built-in word lists cannot be configured (PRD R-CFG-03); lists only take *_extra additions`).join('\n'))
  const r = schema.safeParse(doc.toJS())
  if (!r.success) {
    const issues: Located[] = r.error.issues.map((i) => ({ file, line: locate(file, text, i.path), path: i.path.join('.'), message: i.message }))
    throw new ConfigError(issues.map((i) => `${i.file}:${i.line}: ${i.path || '(top)'}: ${i.message}`).join('\n'))
  }
  return { value: r.data, text }
}

/** Load and check a configuration directory. Throws ConfigError naming file and line. */
export function loadConfig(dir: string): Config {
  const dep = parseFile(dir, 'deployment.yaml', DeploymentFile)
  const cases = parseFile(dir, 'cases.yaml', CasesFile)
  const tpl = parseFile(dir, 'templates.yaml', TemplatesFile)
  const errors: string[] = []
  const at = (file: string, text: string, path: PropertyKey[], msg: string) => errors.push(`${join(dir, file)}:${locate(file, text, path)}: ${path.join('.')}: ${msg}`)

  const seenMb = new Set<string>()
  dep.value.mailboxes.forEach((m, i) => {
    if (seenMb.has(m.id)) at('deployment.yaml', dep.text, ['mailboxes', i, 'id'], `duplicate mailbox id ${m.id}`)
    seenMb.add(m.id)
    if (m.kind === 'gmail' && !dep.value.gmail) at('deployment.yaml', dep.text, ['mailboxes', i, 'kind'], 'a gmail mailbox needs the gmail block')
    if (m.kind === 'graph' && !dep.value.m365) at('deployment.yaml', dep.text, ['mailboxes', i, 'kind'], 'a graph mailbox needs the m365 block')
  })
  const seen = new Set<string>()
  cases.value.classes.forEach((c, i) => {
    if (seen.has(c.id)) at('cases.yaml', cases.text, ['classes', i, 'id'], `duplicate class id ${c.id}`)
    seen.add(c.id)
    for (const [j, f] of (c.fields ?? []).entries()) if (!CLASS_FIELDS_KNOWN.has(f)) at('cases.yaml', cases.text, ['classes', i, 'fields', j], `unknown field ${f}`)
  })
  if (!seen.has('unclassified')) at('cases.yaml', cases.text, ['classes'], 'the class unclassified is required')
  const seenTpl = new Set<string>()
  const templateMeta = new Map<string, TemplateMeta>()
  const extraInternal = dep.value.replies.internal_terms_extra
  tpl.value.templates.forEach((t, i) => {
    if (seenTpl.has(t.id)) at('templates.yaml', tpl.text, ['templates', i, 'id'], `duplicate template id ${t.id}`)
    seenTpl.add(t.id)
    for (const part of ['subject', 'body'] as const) {
      if (/[{}]/.test(t[part].replace(/\{[a-z_]+\}/g, ''))) at('templates.yaml', tpl.text, ['templates', i, part], 'unbalanced { or }')
    }
    const { meta, problems } = checkTemplate(t, extraInternal)
    for (const p of problems) at('templates.yaml', tpl.text, ['templates', i], p)
    templateMeta.set(t.id, meta)
  })
  for (const id of REQUIRED_TEMPLATES) if (!seenTpl.has(id)) at('templates.yaml', tpl.text, ['templates'], `the template ${id} is required (C-DRF-5)`)
  if (errors.length) throw new ConfigError(errors.join('\n'))

  const sha256 = configHash(dir)
  return { ...dep.value, classes: cases.value.classes, templates: tpl.value.templates, templateMeta, sha256, dir }
}

/** SHA-256 over every YAML file in the directory (names and contents, sorted by name). */
export function configHash(dir: string): string {
  const h = createHash('sha256')
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    h.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0')
  }
  return h.digest('hex')
}
