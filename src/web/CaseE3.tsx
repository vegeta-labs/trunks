// E3 review panels (PRD R-REV-02 to R-REV-05, R-RTE-03): links, risk, labels, fields, suggested actions, replies with
// approval and copy, verification tasks, routing. Every text is plain text; nothing is sent from here — a person
// copies the approved reply into their own mail client (decision 5).
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, type SessionUser } from './api.ts'
import type { ApprovalFailure } from '../lib/verification.ts'
import { STATIC_DEMO } from './static-demo.ts'

/** The static demo is read-only: change controls are not rendered at all (PRD R-DEMO-02 v0.7.25). */
const Change = ({ children }: { children: ReactNode }) => (STATIC_DEMO ? null : <>{children}</>)

export interface Meta {
  classes: Array<{ id: string; riskFloor: string }>
  queues: string[]
  outcomes: string[]
  users: Array<{ id: string; username: string; role: string }>
}

export interface E3 {
  generation: number
  complete: boolean
  manualRevision: number
  adopted: string[]
  low: string[]
  pendingAdopted: string[] | null
  ruleLabels: string[]
  removed: Array<{ classId: string; by: string | null; reason: string | null }>
  risk: { computed: string; final: string; by: string; clauses: string[]; floor: { level: string; classes: string[] } | null; adjustment: { level: string; state: string } | null; held: string | null; applied: string } | null
  pendingRisk: string | null
  links: {
    contact: { id: string; name: string } | null
    contactCandidates: string[]
    commitment: { key: string; investorName: string; reference: string } | null
    commitmentCandidates: string[]
    deal: string | null
    dealCandidates: string[]
    dealConflict: boolean
    bankLines: Array<{ transactionId: string; ledgerStatus: string | null }>
    authenticatedSender: boolean
    mayDisclose: boolean
    ledger: string | null
  } | null
  signalsFromEarlierSnapshot: boolean
  actions: Array<{ action: string; details: string | null }>
  autoTemplate: string | null
  allowedTemplates: string[]
  replies: Array<{ id: string; templateId: string; source: string; edited: boolean; recipient: string | null; subject: string; text: string; status: string; checkOk: boolean; problems: string[]; removed: number; bodyEditable: boolean; createdAt: string; outOfDate: boolean }>
  allowedRecipients: string[]
  verification: Array<{ id: string; kind: string; state: string; checklist: Array<{ id: string; text: string; checked: boolean }>; phone: string | null; notifyRecipient: string | null; notifySubject: string | null; notifyText: string | null; notifyProblems: string[]; completedBy: string | null; coolingUntil: string | null; approvedBy: string | null; impersonatedContact: string | null; approvalFailures: ApprovalFailure[] }>
  due: { at: string | null; state: string | null; followUpAt: string | null }
  assignee: string | null
  outcome: string | null
}

const CLAUSE_TEXT: Record<string, string> = {
  'C-RSK-2:display_name_mismatch': 'Display name matches a contact, address does not',
  'C-RSK-2:lookalike_domain': 'Look-alike domain',
  'C-RSK-2:hidden_text': 'Hidden text',
  'C-RSK-2:injection_markers': 'Instruction-like phrases',
  'C-RSK-2:message_id_collision': 'Message-ID seen before with other content',
  'C-RSK-2:first_time_sender_account': 'First mail from this address, with an account number',
  'C-RSK-2:uetr_candidate_invalid': 'A UETR-like value that is not valid',
  'C-RSK-2:amount_mismatch': 'Attachment amounts differ from the mail',
  'C-RSK-2:attachment_blocked_or_over_limit': 'An attachment was blocked or over the limit',
  'C-RSK-2a:auth_fail': 'Authentication failed (+1)',
  'C-RSK-2a:untrusted_auth_header': 'Authentication header from an unknown server (+1)',
  'C-RSK-2a:reply_to_mismatch': 'Reply-To differs from From (+1)',
  'C-RSK-2a:pressure': 'Pressure words in a payment or account mail (+1)',
  'C-RSK-2a:closing': 'Planned close within 3 working days (+1)',
}
const PROBLEM_TEXT = (p: string) =>
  p.startsWith('internal_terms:') ? `Internal wording not allowed in a reply: ${p.slice(15).split('|').join(', ')}` : ({ placeholder_left: 'A value is missing', no_recipient: 'No recipient', recipient_not_allowed: 'This recipient is not allowed' } as Record<string, string>)[p] ?? p
const STATUS_TEXT: Record<string, string> = { draft: 'Draft', approved: 'Approved, waiting to be sent by a person', sent: 'Marked as sent', rejected: 'Rejected' }
const DUE_TEXT: Record<string, string> = { ok: 'on time', due_soon: 'due soon', overdue: 'overdue' }
// R-REV-04 v0.7.20: a clipboard write that has not finished by then counts as failed
const CLIPBOARD_TIMEOUT_MS = 3000
// R-REV-04 v0.7.20: one native clipboard write at a time for the whole page (Codex E4 r9 N1)
let clipboardQueue: Promise<boolean> = Promise.resolve(true)
let latestCopy = 0
// a missing clipboard API, a synchronous throw or a rejection is a failure, never an exception (Codex E4 r8 F2)
function writeClipboard(value: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      navigator.clipboard.writeText(value).then(() => resolve(true), () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

function useAction(reload: (notice?: string) => void) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setError('')
    setBusy(true)
    try {
      await fn()
      reload()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        reload(`${e.message}. The Case has been refreshed; check the current details.`)
      } else setError(e instanceof ApiError ? e.message : 'The action failed')
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, run }
}

const Err = ({ text }: { text: string }) => (text ? <p className="error" role="alert">{text}</p> : null)
const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="panel">
    <h3>{title}</h3>
    {children}
  </section>
)

export function E3Panels({ caseId, e3, user, meta, reload }: { caseId: string; e3: E3; user: SessionUser; meta: Meta | null; reload: (notice?: string) => void }) {
  return (
    <>
      {!e3.complete && <p className="banner" role="status">Reprocessing after a change… approving and copying wait until it finishes.</p>}
      <RiskPanel caseId={caseId} e3={e3} user={user} reload={reload} />
      <LinksPanel caseId={caseId} e3={e3} reload={reload} />
      <Panel title="Suggested actions">
        <ul className="actions">
          {e3.actions.map((a) => (
            // D8: «none» is the internal name of «nothing to do»; it is not shown beside the text
            <li key={a.action}>{a.action === 'none' ? 'No action needed' : <>{a.action === 'mark_withdrawn' ? a.details?.replace(' in Deal Ops Toolkit (consent:', ' in Goten — Deal Calculations (consent:') ?? a.action : a.details ?? a.action} <span className="meta mono">{a.action}</span></>}</li>
          ))}
        </ul>
      </Panel>
      {e3.verification.map((t) => <VerificationPanel key={t.id} caseId={caseId} task={t} user={user} reload={reload} />)}
      <RepliesPanel caseId={caseId} e3={e3} reload={reload} />
      <RoutingPanel caseId={caseId} e3={e3} meta={meta} reload={reload} />
    </>
  )
}

/** «Hold» (PRD R-REV-07): retention keeps the Case and the earlier Cases of its thread; approver and admin, with a reason. */
export function HoldPanel({ caseId, hold, reason, user, reload }: { caseId: string; hold: boolean; reason: string | null; user: SessionUser; reload: (notice?: string) => void }) {
  const [why, setWhy] = useState('')
  const a = useAction(reload)
  if (!hold && user.role === 'reviewer') return null
  return (
    <Panel title="Hold">
      {hold ? <p><span className="tag warn">On hold</span> <span className="meta">{reason}</span></p> : <p className="meta">Not on hold. A hold keeps this Case and the earlier Cases of its thread past the retention period.</p>}
      {user.role !== 'reviewer' && !STATIC_DEMO && (
        <div className="inline-form">
          <input aria-label={hold ? 'Reason for removing the hold' : 'Reason for the hold'} placeholder="Reason" value={why} onChange={(e) => setWhy(e.target.value)} />
          <button className="secondary" disabled={!why.trim() || a.busy} onClick={() => void a.run(() => api('POST', `/api/cases/${caseId}/hold`, { hold: !hold, reason: why }))}>{hold ? 'Remove the hold' : 'Put on hold'}</button>
        </div>
      )}
      <Err text={a.error} />
    </Panel>
  )
}

function RiskPanel({ caseId, e3, user, reload }: { caseId: string; e3: E3; user: SessionUser; reload: (notice?: string) => void }) {
  const [level, setLevel] = useState('')
  const [reason, setReason] = useState('')
  const a = useAction(reload)
  if (!e3.risk) return null
  return (
    <Panel title="Risk">
      <p>
        <span className={`tag risk-${e3.risk.final}`}>{e3.risk.final}</span> <span className="meta">computed by the rules: {e3.risk.computed}{e3.risk.adjustment ? `; a person's adjustment to ${e3.risk.adjustment.level} is ${e3.risk.adjustment.state}` : ''}</span>
      </p>
      {e3.pendingRisk && <p className="meta" role="status">After the re-run: {e3.pendingRisk}</p>}
      {e3.risk.held && (
        <div className="banner" role="status">
          <p>A change by a person would lower the risk to {e3.risk.applied}. It stays {e3.risk.held} until an approver confirms the lower risk.</p>
          {user.role !== 'reviewer' && !STATIC_DEMO && (
            <div className="inline-form">
              <input aria-label="Reason for accepting the lower risk" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="secondary" disabled={!reason.trim() || a.busy} onClick={() => void a.run(() => api('POST', `/api/cases/${caseId}/risk/confirm-lower`, { reason, level: e3.risk!.applied }))}>Accept the lower risk</button>
            </div>
          )}
        </div>
      )}
      {e3.risk.floor && <p className="meta">Class floor: {e3.risk.floor.classes.map((c) => e3.low.includes(c) ? `possible class ${c} (low confidence)` : c).join(', ')} → {e3.risk.floor.level}</p>}
      {e3.risk.clauses.length > 0 && (
        <ul className="signals">
          {e3.risk.clauses.map((c) => <li key={c} className="on">{CLAUSE_TEXT[c] ?? c}</li>)}
        </ul>
      )}
      <Change>
      <div className="inline-form">
        <label className="inline">
          Set risk
          <select aria-label="Set risk" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">—</option>
            {['low', 'medium', 'high'].map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <input aria-label="Reason for the risk change" placeholder={user.role === 'reviewer' ? 'Lowering needs an approver' : 'Reason (needed to lower)'} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="secondary" disabled={!level || a.busy} onClick={() => void a.run(() => api('POST', `/api/cases/${caseId}/risk`, { level, reason }))}>Apply</button>
      </div>
      </Change>
      <Err text={a.error} />
    </Panel>
  )
}

function LinksPanel({ caseId, e3, reload }: { caseId: string; e3: E3; reload: (notice?: string) => void }) {
  const a = useAction(reload)
  const l = e3.links
  if (!l) return null
  const set = (kind: string, target: string | null) => void a.run(() => api('PUT', `/api/cases/${caseId}/links/${kind}`, { target }))
  const Pick = ({ kind, current, candidates }: { kind: string; current: string | null; candidates: string[] }) =>
    candidates.length > 0 && STATIC_DEMO ? (
      // the demo shows what the system found, as text (self-test F5)
      <span className="meta">candidates: {candidates.join(', ')}</span>
    ) : candidates.length > 0 ? (
      <select aria-label={`Choose the ${kind}`} value="" onChange={(e) => e.target.value && set(kind, e.target.value)}>
        <option value="">{current ? 'Change…' : 'Not linked — choose…'}</option>
        {candidates.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    ) : null
  return (
    <Panel title="Links">
      <dl className="facts">
        <dt>Sender</dt>
        <dd>{l.contact ? `${l.contact.name} (${l.contact.id})` : 'Not linked'} {l.authenticatedSender ? <span className="tag ok">authenticated sender</span> : <span className="tag">not authenticated</span>} <Pick kind="contact" current={l.contact?.id ?? null} candidates={l.contactCandidates} /></dd>
        <dt>Commitment</dt>
        <dd>{l.commitment ? `${l.commitment.investorName} · ${l.commitment.reference}` : 'Not linked'} <Pick kind="commitment" current={l.commitment?.key ?? null} candidates={l.commitmentCandidates} /></dd>
        <dt>Deal</dt>
        <dd>{l.deal ?? 'Not linked'}{l.dealConflict && <span className="tag warn">the mail names another deal</span>} <Pick kind="deal" current={l.deal} candidates={l.dealCandidates} /></dd>
        <dt>Ledger</dt>
        <dd>{l.ledger === 'received' ? 'Received in full (Goten ledger)' : l.ledger === 'not_received' ? 'Not received in full (Goten ledger)' : l.ledger === 'unknown' ? 'No ledger imported for this deal' : '—'}</dd>
        <dt>Possible bank lines</dt>
        <dd>{l.bankLines.length ? l.bankLines.map((b) => `${b.transactionId} (${b.ledgerStatus ?? 'not in the ledger'})`).join(', ') : '—'} <span className="meta">shown only; nothing is changed</span></dd>
        <dt>Record data in replies</dt>
        <dd>{l.mayDisclose ? 'allowed' : 'not allowed (generic replies only)'}</dd>
      </dl>
      {e3.signalsFromEarlierSnapshot && <p className="meta">Signals are based on the directory at the time the mail arrived.</p>}
      <Change>
        <button className="secondary" disabled={a.busy} onClick={() => void a.run(() => api('POST', `/api/cases/${caseId}/relink`))}>Relink with the latest directory</button>
      </Change>
      <Err text={a.error} />
    </Panel>
  )
}

export function LabelsPanel({ caseId, e3, meta, reload }: { caseId: string; e3: E3; meta: Meta | null; reload: (notice?: string) => void }) {
  const [add, setAdd] = useState('')
  const [reason, setReason] = useState('')
  const a = useAction(reload)
  const change = (body: object) => void a.run(() => api('POST', `/api/cases/${caseId}/labels`, { ...body, reason }))
  return (
    <Panel title="Classes">
      <ul className="tags plain">
        {e3.adopted.map((c) => (
          <li key={c} className="tag">
            {c}
            {e3.ruleLabels.includes(c) ? <span className="meta"> (rule)</span> : STATIC_DEMO ? null : <button className="link" aria-label={`Remove ${c}`} onClick={() => change({ remove: [c] })}> ×</button>}
          </li>
        ))}
        {e3.low.map((c) => <li key={c} className="tag confirm">{c} (low confidence — needs confirmation; counts for risk)</li>)}
      </ul>
      {e3.removed.length > 0 && (
        <ul className="removed">
          {e3.removed.map((x) => <li key={x.classId} className="meta"><s>{x.classId}</s> removed by {x.by ?? 'a person'}{x.reason ? `: ${x.reason}` : ''}</li>)}
        </ul>
      )}
      {e3.pendingAdopted && <p className="meta" role="status">After the re-run: {e3.pendingAdopted.join(', ') || 'no class'}</p>}
      <Change>
      <div className="inline-form">
        <select aria-label="Add a class" value={add} onChange={(e) => setAdd(e.target.value)}>
          <option value="">Add a class…</option>
          {(meta?.classes ?? []).filter((c) => !e3.adopted.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
        </select>
        <button className="secondary" disabled={!add || a.busy} onClick={() => change({ add: [add] })}>Add</button>
        <input aria-label="Reason for the class change" placeholder="Reason (needed when it lowers the risk)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      </Change>
      <Err text={a.error} />
    </Panel>
  )
}

export function FieldActions({ caseId, field, confirmed, reload }: { caseId: string; field: string; confirmed: boolean; reload: (notice?: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const a = useAction((notice) => {
    setEditing(false)
    reload(notice)
  })
  if (confirmed) return <span className="tag ok">confirmed</span>
  if (STATIC_DEMO) return null
  return (
    <span className="field-actions">
      <button className="link" onClick={() => void a.run(() => api('PUT', `/api/cases/${caseId}/fields/${field}`, { confirm: true }))}>Confirm</button>{' '}
      <button className="link" onClick={() => setEditing(!editing)}>Edit</button>
      {editing && (
        <span className="inline-form">
          <input aria-label={`New value for ${field}`} value={value} onChange={(e) => setValue(e.target.value)} />
          <button className="secondary" onClick={() => void a.run(() => api('PUT', `/api/cases/${caseId}/fields/${field}`, { value: value.trim() === '' ? null : value.trim() }))}>Save</button>
        </span>
      )}
      <Err text={a.error} />
    </span>
  )
}

// PRD R-DEMO-02 v0.7.25: the demo shows no approval controls, so it says how a reply leaves a real deployment
export const DEMO_REPLY_NOTE = 'In a real deployment a reviewer approves this reply and sends it from their own mail client; the app cannot send.'

function RepliesPanel({ caseId, e3, reload }: { caseId: string; e3: E3; reload: (notice?: string) => void }) {
  if (e3.replies.length === 0) return <Panel title="Reply">{STATIC_DEMO && <p className="meta">{DEMO_REPLY_NOTE}</p>}<p className="meta">No reply is drafted for this Case.</p></Panel>
  return (
    <Panel title="Reply">
      <p className="meta">Templates are chosen by the rules{e3.autoTemplate ? ` (now: ${e3.autoTemplate})` : ''}. {STATIC_DEMO ? DEMO_REPLY_NOTE : 'Nothing is sent from here: copy the approved reply into your mail client, then mark it as sent.'}</p>
      {e3.replies.map((r) => <ReplyCard key={r.id} caseId={caseId} r={r} e3={e3} reload={reload} />)}
    </Panel>
  )
}

function ReplyCard({ caseId, r, e3, reload }: { caseId: string; r: E3['replies'][number]; e3: E3; reload: (notice?: string) => void }) {
  const [text, setText] = useState(r.text)
  const a = useAction(reload)
  const url = `/api/cases/${caseId}/replies/${r.id}`
  // every copy asks the server first (C-DRF-8 re-check) and copies what it returns now: nothing cached in the page
  // can outlive a rejection, a change or a re-run (Codex E3 F2)
  const [copyError, setCopyError] = useState('')
  // R-REV-04 v0.7.20 (M-05): every copy shows its result; a clipboard that refuses or never answers is a visible
  // failure with the server's text to copy by hand, never a silent no-op that leaves stale text on the clipboard
  const [copied, setCopied] = useState('')
  const [manual, setManual] = useState<{ part: string; value: string } | null>(null)
  // only the latest copy may show a result: an older response or timeout that finishes later is ignored (Codex E4 r8 F1)
  const attempt = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false; attempt.current += 1 }, [])
  // progress counters on the card, so tests can wait for each copy's own handler instead of sleeping (Codex E4 r11):
  // answered = server answers handled (also ignored ones), done = copies finished (also ignored ones)
  const [progress, setProgress] = useState({ answered: 0, done: 0 })
  const step = (k: 'answered' | 'done') => { if (mounted.current) setProgress((p) => ({ ...p, [k]: p[k] + 1 })) }
  const copy = async (part: 'recipient' | 'subject' | 'text') => {
    try {
      await copyOnce(part)
    } finally {
      step('done')
    }
  }
  const copyOnce = async (part: 'recipient' | 'subject' | 'text') => {
    const mine = ++attempt.current
    const current = () => attempt.current === mine
    setCopyError('')
    setCopied('')
    setManual(null)
    let fresh: { recipient: string; subject: string; text: string }
    try {
      fresh = await api<{ recipient: string; subject: string; text: string }>('POST', `${url}/copy`)
    } catch (e) {
      step('answered')
      if (!current()) return
      setCopyError(e instanceof ApiError ? e.message : 'Copy failed')
      reload()
      return
    }
    step('answered')
    if (!current()) return
    const value = fresh[part]
    const ticket = ++latestCopy
    // the deadline is a point in time, checked before the write starts and before success is shown, so a late timer
    // callback cannot let an overdue copy count as done (Codex E4 r10 F1)
    const deadline = performance.now() + CLIPBOARD_TIMEOUT_MS
    const inTime = () => performance.now() < deadline
    let timer: ReturnType<typeof setTimeout> | undefined
    // native writes run one at a time, across all reply cards: a write starts only after the previous one has settled,
    // and only if this copy is still the latest one and still in time, so an older write can never land after a newer
    // one (Codex E4 r9 N1)
    const turn = clipboardQueue.then(() => (inTime() && current() && latestCopy === ticket ? writeClipboard(value) : false))
    clipboardQueue = turn
    const written = await Promise.race([turn, new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), CLIPBOARD_TIMEOUT_MS) })])
    clearTimeout(timer)
    if (!current()) return
    if (written && inTime()) setCopied(`Copied the ${part}.`)
    else {
      setCopyError(`Copy failed: select the ${part} below and copy it by hand.`)
      setManual({ part, value })
    }
  }
  return (
    <div className="card reply" data-testid="reply" data-copies-answered={progress.answered} data-copies-done={progress.done}>
      <p>
        <span className="tag">{r.templateId}</span> <span className="tag">{r.outOfDate ? 'Out of date — work on the current draft' : (STATUS_TEXT[r.status] ?? r.status)}</span>
        {r.source === 'person' && <span className="tag">chosen by a person</span>} {r.edited && <span className="tag">edited</span>}
      </p>
      <dl className="facts">
        <dt>To</dt>
        <dd>
          {r.status === 'draft' && e3.allowedRecipients.length > 1 && !STATIC_DEMO ? (
            <select aria-label="Recipient" value={r.recipient ?? ''} onChange={(e) => void a.run(() => api('POST', `${url}/revise`, { recipient: e.target.value }))}>
              {e3.allowedRecipients.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          ) : (r.recipient ?? '—')}
        </dd>
        <dt>Subject</dt>
        <dd>{r.subject} <span className="meta">(set by the template; the subject of the sender's mail is never repeated)</span></dd>
      </dl>
      {r.status === 'draft' && r.bodyEditable && !r.outOfDate && !STATIC_DEMO ? (
        <textarea aria-label="Reply text" value={text} rows={Math.min(14, text.split('\n').length + 2)} onChange={(e) => setText(e.target.value)} />
      ) : (
        <pre className="body">{r.text}</pre>
      )}
      {!r.bodyEditable && r.status === 'draft' && <p className="meta">This reply's text is fixed and cannot be edited.</p>}
      {r.removed > 0 && <p className="meta">{r.removed} sentence{r.removed > 1 ? 's were' : ' was'} left out because a value is missing.</p>}
      {r.problems.length > 0 && <ul className="flags">{r.problems.map((p) => <li key={p}>{PROBLEM_TEXT(p)}</li>)}</ul>}
      <Change>
      <div className="inline-form">
        {r.status === 'draft' && r.bodyEditable && text !== r.text && <button className="secondary" disabled={a.busy} onClick={() => void a.run(() => api('POST', `${url}/revise`, { text }))}>Save text</button>}
        {r.status === 'draft' && !r.outOfDate && e3.allowedTemplates.length > 0 && (
          <select aria-label="Use another template" value="" onChange={(e) => e.target.value && void a.run(() => api('POST', `${url}/revise`, { templateId: e.target.value }))}>
            <option value="">Use another template…</option>
            {e3.allowedTemplates.filter((t) => t !== r.templateId).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {r.status === 'draft' && !r.outOfDate && <button disabled={a.busy || !e3.complete || text !== r.text} onClick={() => void a.run(() => api('POST', `${url}/approve`))}>Approve</button>}
        {/* D8: no Reject on an out-of-date automatic draft, which the next generation replaces anyway; a person's draft
            and an approval that has not lapsed yet can still be withdrawn (review F5) */}
        {(r.status === 'draft' || r.status === 'approved') && !(r.outOfDate && r.status === 'draft' && r.source === 'auto' && !r.edited) && <button className="secondary" disabled={a.busy} onClick={() => void a.run(() => api('POST', `${url}/reject`))}>Reject</button>}
        {r.status === 'approved' && !r.outOfDate && <button className="secondary" disabled={a.busy} onClick={() => void a.run(() => api('POST', `${url}/sent`))}>Mark as sent</button>}
      </div>
      </Change>
      {(r.status === 'approved' || r.status === 'sent') && !r.outOfDate && !STATIC_DEMO && (
        <div className="copy">
          <button className="secondary" disabled={!e3.complete} onClick={() => void copy('recipient')}>Copy recipient</button>
          <button className="secondary" disabled={!e3.complete} onClick={() => void copy('subject')}>Copy subject</button>
          <button className="secondary" disabled={!e3.complete} onClick={() => void copy('text')}>Copy text</button>
        </div>
      )}
      {copied && <p className="meta" role="status">{copied}</p>}
      <Err text={copyError} />
      {manual && (
        <textarea aria-label={`The ${manual.part} to copy by hand`} readOnly value={manual.value} rows={Math.min(14, manual.value.split('\n').length + 1)} onFocus={(e) => e.currentTarget.select()} autoFocus />
      )}
      <Err text={a.error} />
    </div>
  )
}

function VerificationPanel({ task, user, reload }: { caseId: string; task: E3['verification'][number]; user: SessionUser; reload: (notice?: string) => void }) {
  const [ticked, setTicked] = useState<string[]>(task.checklist.filter((c) => c.checked).map((c) => c.id))
  const a = useAction(reload)
  const [restartReason, setRestartReason] = useState('')
  const failures = task.approvalFailures ?? []
  const completerFailures = failures.filter((f) => f.subject === 'completer')
  const otherFailures = failures.filter((f) => f.subject !== 'completer' && f.subject !== 'timing')
  const STATE: Record<string, string> = { open: 'Open', checklist_done: 'Checklist done — cooling-off period', approved: 'Approved by a second person' }
  return (
    <Panel title={task.kind === 'bank_details' ? 'Check the bank details request' : 'Check the change of identity details'}>
      <p><span className="tag">{STATE[task.state] ?? task.state}</span>{task.coolingUntil && task.state === 'checklist_done' && completerFailures.length === 0 && otherFailures.length === 0 && <span className="meta"> second approval from {when(task.coolingUntil)}</span>}</p>
      <dl className="facts">
        {task.impersonatedContact && (
          <>
            <dt>Contact</dt>
            <dd>{task.impersonatedContact} — the contact the display name impersonates; the sender's address is not theirs</dd>
          </>
        )}
        <dt>Phone on file</dt>
        <dd>{task.phone}</dd>
      </dl>
      {task.state === 'checklist_done' && (completerFailures.length > 0 || otherFailures.length > 0) && <div className="banner" role="status">
        <p>{completerFailures.length ? 'With the current account history, this task cannot be approved (C-FRD-5).' : 'You cannot approve this task (C-FRD-5).'}</p>
        <ul>{(completerFailures.length ? completerFailures : otherFailures).map((f) => <li key={`${f.subject}-${f.code}`}>{f.reason} (C-FRD-5)</li>)}</ul>
      </div>}
      {task.state === 'open' && ticked.length < task.checklist.length && <p className="meta">Tick every checklist item before marking the checklist done.</p>}
      <ul className="checklist">
        {task.checklist.map((c) => (
          <li key={c.id}>
            {STATIC_DEMO ? <><span aria-label={c.checked ? 'done' : 'not done'}>{c.checked ? '✓' : '○'}</span> {c.text}</> : <label className="inline">
              <input type="checkbox" disabled={task.state !== 'open'} checked={ticked.includes(c.id)} onChange={(e) => setTicked(e.target.checked ? [...ticked, c.id] : ticked.filter((x) => x !== c.id))} />
              {c.text}
            </label>}
          </li>
        ))}
      </ul>
      {task.notifyProblems.length > 0 && <ul className="flags">{task.notifyProblems.map((p) => <li key={p}>The message to the old contact cannot be sent: {PROBLEM_TEXT(p)}</li>)}</ul>}
      {task.notifyText && (
        <details>
          <summary>Message to the old contact details ({task.notifyRecipient ?? 'no address on file'})</summary>
          <p className="meta">{task.notifySubject}</p>
          <pre className="body">{task.notifyText}</pre>
        </details>
      )}
      <Change>
      <div className="inline-form">
        {task.state === 'open' && <button disabled={a.busy || ticked.length < task.checklist.length} onClick={() => void a.run(() => api('POST', `/api/verification/${task.id}/complete`, { items: ticked }))}>Checklist done</button>}
        {task.state === 'checklist_done' && user.role !== 'reviewer' && <button disabled={a.busy} onClick={() => void a.run(() => api('POST', `/api/verification/${task.id}/approve`))}>Approve as the second person</button>}
      </div>
      {(task.state === 'open' || task.state === 'checklist_done') && user.role !== 'reviewer' && <div className="inline-form">
        <input aria-label="Reason for restarting verification" placeholder="Reason for restarting" value={restartReason} onChange={(e) => setRestartReason(e.target.value)} />
        <button className="secondary" disabled={a.busy || !restartReason.trim()} onClick={() => void a.run(() => api('POST', `/api/verification/${task.id}/restart`, { reason: restartReason }))}>Restart verification</button>
      </div>}
      </Change>
      <Err text={a.error} />
    </Panel>
  )
}

function RoutingPanel({ caseId, e3, meta, reload }: { caseId: string; e3: E3; meta: Meta | null; reload: (notice?: string) => void }) {
  const [outcome, setOutcome] = useState('')
  const a = useAction(reload)
  const users = meta?.users ?? []
  return (
    <Panel title="Queue and owner">
      <dl className="facts">
        <dt>Due</dt>
        <dd>{e3.due.at ? `${when(e3.due.at)} (${DUE_TEXT[e3.due.state ?? ''] ?? 'closed'})` : '—'}</dd>
        {STATIC_DEMO && (
          <>
            <dt>Owner</dt>
            <dd>{users.find((u) => u.id === e3.assignee)?.username ?? (e3.assignee ? 'assigned' : 'No owner')}</dd>
          </>
        )}
        {e3.due.followUpAt && (
          <Fragment>
            <dt>Follow up</dt>
            <dd>{when(e3.due.followUpAt)} <span className="meta">a reminder to follow the payment up, not a regulatory deadline</span></dd>
          </Fragment>
        )}
      </dl>
      <Change>
      <div className="inline-form">
        <select aria-label="Queue" value="" onChange={(e) => e.target.value && void a.run(() => api('PUT', `/api/cases/${caseId}/assignment`, { queue: e.target.value }))}>
          <option value="">Move to queue…</option>
          {(meta?.queues ?? []).map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
        <select aria-label="Owner" value={e3.assignee ?? ''} onChange={(e) => void a.run(() => api('PUT', `/api/cases/${caseId}/assignment`, { assignee: e.target.value || null }))}>
          <option value="">No owner</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
        </select>
      </div>
      </Change>
      {e3.outcome ? (
        <p>Closed: {e3.outcome}</p>
      ) : STATIC_DEMO ? null : (
        <div className="inline-form">
          <select aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">Close with outcome…</option>
            {(meta?.outcomes ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <button className="secondary" disabled={!outcome || a.busy} onClick={() => void a.run(() => api('POST', `/api/cases/${caseId}/close`, { outcome }))}>Close</button>
        </div>
      )}
      <Err text={a.error} />
    </Panel>
  )
}
