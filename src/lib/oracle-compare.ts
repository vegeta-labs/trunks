// TS-vs-oracle comparison (test plan §3): the same inputs through src/lib and eval/oracle/oracle.py, field by field.
import { execFileSync } from 'node:child_process'
import { extractAmounts, mt103 } from './amounts.ts'
import { distinctAccounts, extractAccounts } from './accounts.ts'
import { extractDates } from './dates.ts'
import { detectEsign } from './esign.ts'
import { parsePacs008 } from './pacs008.ts'
import { parseAmountNumber } from './money.ts'
import { Redactor } from './redact.ts'
import { matchReferences } from './references.ts'
import { nameMatch } from './names.ts'
import { normaliseText, matchedPhrases } from './text.ts'
import { extractUetrs } from './uetr.ts'
import { auditHash, verifyChain, type AuditRecord, type Json } from './audit-hash.ts'
import {
  authSignals, authenticatedSender, displayNameMismatch, domainOf, firstTimeSender, hasHiddenText, injectionMarkers,
  htmlScanTexts, lookalikeDomain, normAddress, replyToMismatch, type Contact,
} from './signals.ts'

export type Call = { fn: string; input: Record<string, unknown> }

export function runOracle(calls: Call[]): unknown[] {
  const out = execFileSync('python3', ['-I', 'eval/oracle/oracle.py'], { input: calls.map((c) => JSON.stringify(c)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28 })
  return out.trim().split('\n').map((l) => {
    const r = JSON.parse(l) as { ok: boolean; output?: unknown; error?: string }
    return r.ok ? r.output : { error: r.error }
  })
}

const CCY = ['GBP', 'EUR', 'USD']
// code-point offset of a UTF-16 index
const cp = (t: string, i: number) => Array.from(t.slice(0, i)).length

type SigInput = {
  mailbox_strips_auth_results: boolean
  adapter: 'imap' | 'gmail' | 'graph' | 'eml'
  trusted_authserv_id: string
  headers: Array<[string, string]>
  from: { name: string; address: string }
  reply_to: string | null
  contacts: Array<{ contact_id: string; name: string; emails: string[] }>
  prior_from_addresses: string[]
  html: string | null
  texts: string[]
}

function tsSignals(s: SigInput) {
  const contacts: Contact[] = s.contacts.map((c) => ({ contactId: c.contact_id, name: c.name, emails: c.emails }))
  const auth = authSignals({ headers: s.headers, trustedAuthResults: s.adapter !== 'eml' && s.mailbox_strips_auth_results, trustedAuthservId: s.trusted_authserv_id })
  const addr = normAddress(s.from.address)
  const inDir = contacts.some((c) => c.emails.some((e) => normAddress(e) === addr))
  const dirDomains = contacts.flatMap((c) => c.emails.map(domainOf))
  const texts = [...s.texts, ...htmlScanTexts(s.html)]
  return {
    auth: auth.auth,
    auth_fail: auth.authFail,
    untrusted_auth_header: auth.untrustedAuthHeader,
    display_name_mismatch: displayNameMismatch(s.from.name, s.from.address, contacts),
    lookalike_domain: lookalikeDomain(domainOf(s.from.address), dirDomains),
    reply_to_mismatch: replyToMismatch(s.reply_to ? [s.reply_to] : [], s.from.address),
    first_time_sender: firstTimeSender(s.prior_from_addresses.some((p) => normAddress(p) === addr), inDir),
    hidden_text: hasHiddenText(s.html),
    injection_markers: injectionMarkers(texts).length > 0,
    dmarc_pass: auth.dmarcPass,
  }
}

/** TS output in the oracle's shape (eval/oracle/BRIEF.md). */
export function runTs(c: Call): unknown {
  // oxlint-disable-next-line typescript/no-explicit-any -- oracle inputs are loose JSON
  const i = c.input as any
  switch (c.fn) {
    case 'normalize':
      return { text: normaliseText(i.text) }
    case 'wordlist_match':
      return { matched: matchedPhrases(i.text, i.phrases) }
    case 'parse_amount_number':
      return { minor: parseAmountNumber(i.s) }
    case 'amounts': {
      const t = normaliseText(i.text)
      return { amounts: extractAmounts(t).map((a) => ({ minor: a.minor, currency: a.currency, start: cp(t, a.start), end: cp(t, a.end) })) }
    }
    case 'mt103':
      return { items: mt103(normaliseText(i.text), CCY).map((x) => ({ value_date: x.valueDate, minor: x.minor, currency: x.currency })) }
    case 'pacs008': {
      const r = parsePacs008(i.xml, CCY)
      if (!r.parsed) return r
      return {
        parsed: true,
        items: r.items.map((x) => {
          const valid = x.uetr !== null && extractUetrs(x.uetr).uetrs.length === 1
          // only a UUID-shaped value is a candidate at all (C-EXT-1)
          const shaped = x.uetr !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.uetr)
          return { minor: x.minor, currency: x.currency, value_date: x.valueDate, uetr: valid ? x.uetr : null, uetr_invalid: shaped && !valid ? x.uetr : null }
        }),
        text: r.text,
      }
    }
    case 'uetr': {
      const r = extractUetrs(normaliseText(i.text))
      return { uetrs: r.uetrs, invalid: r.invalid, multiple: r.multiple }
    }
    case 'references':
      return { matched: matchReferences(normaliseText(i.text), i.known) }
    case 'accounts':
      { const t = normaliseText(i.text); return { accounts: distinctAccounts(t, extractAccounts(t)).map((a) => ({ kind: a.kind, last4: a.last4, country: a.kind === 'uk' ? null : a.country })) } }
    case 'dates': {
      const t = normaliseText(i.text)
      return { dates: extractDates(t).map((d) => ({ iso: d.iso, status: d.status, start: cp(t, d.start), end: cp(t, d.end) })) }
    }
    case 'esign': {
      const r = detectEsign(i.from_domain, i.link_domains, i.platforms)
      return { esign_invite: r.esignInvite, platform: r.platform }
    }
    case 'redact': {
      const t = normaliseText(i.text)
      const r = new Redactor({ contactNames: i.contact_names }).redact(t)
      return { spans: r.spans.map((s) => ({ start: cp(t, s.start), end: cp(t, s.end), kind: s.kind })), text: r.text }
    }
    case 'name_similarity': {
      const m = nameMatch(normaliseText(i.a), normaliseText(i.b))
      return { num: m.matched, den: m.of }
    }
    case 'signals':
      return tsSignals(c.input as unknown as SigInput)
    case 'authenticated_sender': {
      const s = c.input as unknown as SigInput
      const auth = authSignals({ headers: s.headers, trustedAuthResults: s.adapter !== 'eml' && s.mailbox_strips_auth_results, trustedAuthservId: s.trusted_authserv_id })
      const r = authenticatedSender(s.from.address, s.contacts.map((x) => ({ contactId: x.contact_id, name: x.name, emails: x.emails })), auth)
      return { authenticated: r.authenticated, contact_id: r.contactId }
    }
    case 'audit_hash':
      return { hash: auditHash(i.record as unknown as Omit<AuditRecord, 'hash'>) }
    case 'verify_chain': {
      const r = verifyChain(i.records as unknown as AuditRecord[])
      return r.ok ? { ok: true, bad_seq: null } : { ok: false, bad_seq: r.badSeq }
    }
    default:
      throw new Error(`unknown fn ${c.fn}`)
  }
}

export type { Json }
