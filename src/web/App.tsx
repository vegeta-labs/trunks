// Review UI (PRD R-REV-01 to R-REV-05). Mail content is shown as plain text only (tech design T9).
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, csrf, withoutRuleIds, type SessionUser } from './api.ts'
import { snapshotInfo, STATIC_DEMO } from './static-demo.ts'
import { caseStatus, DEMO_DATES, displayName, riskReasonText, transferText } from './presentation.ts'
import { actionText, E3Panels, FieldActions, HoldPanel, LabelsPanel, type E3, type Meta } from './CaseE3.tsx'

interface CaseItem {
  id: string
  receivedAt: string
  mailbox: string
  from: string | null
  fromName: string | null
  subject: string | null
  status: string
  risk: string | null
  queue: string | null
  dueAt: string | null
  flags: string[]
  signals: string[]
  hold: boolean
}

interface CaseDetail extends CaseItem {
  holdReason: string | null
  failedStage: string | null
  failedReason: string | null
  to: string | null
  cc: string | null
  dateHeader: string | null
  text: string
  htmlText: string | null
  hiddenTexts: Array<{ reason: string; text: string }>
  attachments: Array<{ ordinal: number; filename: string; kind: string; scanStatus: string; parseStatus: string; maybeKyc: boolean | null; kycReason: string | null; kycTransfer: { id: string; state: string; error: string | null; removed: boolean } | null }>
  signalDetails: Array<{ signal: string; value: boolean | null; batch: string }>
  extraction: {
    invalidIbans?: number
    uetrs: Array<{ value: string }>
    uetrCandidatesInvalid: Array<{ value: string }>
    amounts: Array<{ minor: number; currency: string; at: { part: string } }>
    references: Array<{ value: string }>
    accounts: Array<{ kind: string; last4: string; country: string }>
    dates: Array<{ iso: string | null; status: string }>
    hidden?: { dates: number; kyc: number }
    evidence: Array<{ source: string; minor: number | null; currency: string | null; valueDate: string | null; uetr: string | null }>
    esign: { esignInvite: boolean; platform: string | null }
  } | null
  labels: Array<{ classId: string; source: string; confidence: string; adopted: boolean; reason: string | null }>
  fields: Array<{ field: string; status: string; value: string | null; candidates: string[]; needsConfirmation: boolean; reason: string | null; confirmed: boolean }>
  previousCaseId: string | null
  e3: E3 | null
}

const DATE_HIDDEN: Record<string, string> = { hidden_dob: 'date of birth (hidden)', hidden_kyc: 'from a possible KYC attachment (hidden)' }

const FIELD_STATUS: Record<string, string> = { void: 'void', multiple: 'several values — a person chooses', conflict: 'differs from the rules — rule value shown' }

const SIGNAL_TEXT: Record<string, string> = {
  auth_fail: 'Authentication failed (SPF, DKIM or DMARC)',
  untrusted_auth_header: 'An authentication header from an unknown server',
  display_name_mismatch: 'Display name matches a contact, address does not',
  lookalike_domain: 'Domain looks like a known contact domain',
  reply_to_mismatch: 'Reply-To differs from From',
  first_time_sender: 'First mail from this address',
  hidden_text: 'Hidden text in the HTML',
  injection_markers: 'Instruction-like phrases in the mail',
  message_id_collision: 'Message-ID seen before with other content',
}
const FLAG_TEXT: Record<string, string> = {
  attachment_blocked: 'Attachment blocked by the virus scan',
  attachment_over_limit: 'Attachment over the size or page limit',
  mime_parse_failed: 'The message could not be fully decoded',
  sender_unparseable: 'The sender (From or Reply-To) could not be read with certainty',
}

const money = (minor: number | null, ccy: string | null) =>
  minor === null || ccy === null ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: ccy }).format(minor / 100)
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

function Login({ onDone }: { onDone: (u: SessionUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  // DEMO=1 only: the published demo accounts (PRD R-DEMO-01 v0.7.22); elsewhere the route answers 404
  const [demo, setDemo] = useState<Array<{ username: string; password: string; role: string }>>([])
  // the organisation sign-in only when OIDC is configured (E5 acceptance G4)
  const [oidc, setOidc] = useState(false)
  useEffect(() => {
    api<{ accounts: Array<{ username: string; password: string; role: string }> }>('GET', '/api/demo').then((r) => setDemo(r.accounts), () => setDemo([]))
    api<{ oidc: boolean }>('GET', '/api/signin-options').then((r) => setOidc(r.oidc === true), () => setOidc(false))
  }, [])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const r = await api<{ csrf: string; user: SessionUser }>('POST', '/api/login', { username, password })
      csrf.set(r.csrf)
      onDone(r.user)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed')
    }
  }
  return (
    <main className="narrow">
      <h1>Trunks — Operations Inbox</h1>
      <form onSubmit={submit} className="card">
        <label>
          Username
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit">Sign in</button>
        {oidc && demo.length === 0 && <a className="secondary" href="/auth/oidc/start">Sign in with your organisation</a>}
      </form>
      {demo.length > 0 && (
        <section className="card" aria-label="Demo accounts">
          <h2>Demo accounts</h2>
          <p>Fictional data only. Sign in as:</p>
          <ul>
            {demo.map((a) => (
              <li key={a.username}>
                <button type="button" className="secondary" onClick={() => { setUsername(a.username); setPassword(a.password) }}>
                  {a.role}
                </button>{' '}
                <code>{a.username}</code> / <code>{a.password}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await api('POST', '/api/password', { current, next })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password')
    }
  }
  return (
    <main className="narrow">
      <h1>Choose a new password</h1>
      <form onSubmit={submit} className="card">
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label>
          New password (12 characters or more)
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit">Save</button>
      </form>
    </main>
  )
}

const PAGE_SIZE = 50 // R-REV-01 v0.7.29
interface ListView { status: string; queue: string; risk: string; page: number; scroll: number; lastId: string | null }
function CaseList({ meta, view, setView }: { meta: Meta | null; view: ListView; setView: (v: ListView) => void }) {
  const [cases, setCases] = useState<CaseItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [shownPage, setShownPage] = useState(view.page) // the page `cases` holds; `page` moves first
  const [error, setError] = useState('')
  const { status, queue, risk, page } = view
  const restore = useRef(true)
  useEffect(() => {
    let active = true
    setError('')
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries({ status, queue, risk }).filter(([, v]) => v)), limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
    void api<{ cases: CaseItem[]; total: number }>('GET', `/api/cases?${q}`).then((r) => {
      if (!active) return
      // fewer Cases than when this page was opened: go to the last page there is
      if (r.cases.length === 0 && r.total > 0 && page > 0) { setView({ ...view, page: Math.ceil(r.total / PAGE_SIZE) - 1, scroll: 0, lastId: null }); return }
      setCases(r.cases)
      setTotal(r.total)
      setShownPage(page)
    }, () => { if (active) setError('Cases could not be loaded. Try again.') })
    return () => { active = false }
  }, [status, queue, risk, page])
  useEffect(() => {
    if (!cases || !restore.current) return
    restore.current = false
    const frame = requestAnimationFrame(() => {
      if (view.lastId) document.getElementById(`case-${view.lastId}`)?.focus({ preventScroll: true })
      window.scrollTo(0, view.scroll)
    })
    return () => cancelAnimationFrame(frame)
  }, [cases, view.lastId, view.scroll])
  const filtered = Boolean(status || queue || risk)
  const filter = (key: 'status' | 'queue' | 'risk', value: string) => setView({ ...view, [key]: value, page: 0, scroll: 0, lastId: null })
  const turn = (to: number) => { setView({ ...view, page: to, scroll: 0, lastId: null }); window.scrollTo(0, 0) }
  const first = shownPage * PAGE_SIZE + 1
  const range = cases && cases.length > 0 ? `Showing ${first}–${first + cases.length - 1} of ${total} cases` : '0 cases'
  const now = Date.now()
  return (
    <section>
      <p className="eyebrow">Inbox</p>
      <div className="list-heading"><h2>Cases</h2><span className="meta" role="status">{cases && (STATIC_DEMO ? `${total} of ${snapshotInfo()?.caseCount ?? total} cases` : range)}</span></div>
      <p className="meta">Open a case to review the email, risk reasons and suggested next steps.</p>
      <div className="toolbar filters">
        <label><span id="status-filter-label">Status</span><select aria-labelledby="status-filter-label" value={status} onChange={(e) => filter('status', e.target.value)}>
          <option value="">All statuses</option>
          {['processing', 'open', 'failed', 'approved', 'sent', 'closed'].map((v) => <option key={v} value={v}>{caseStatus(v)}</option>)}
        </select></label>
        <label><span id="queue-filter-label">Queue</span><select aria-labelledby="queue-filter-label" value={queue} onChange={(e) => filter('queue', e.target.value)}>
          <option value="">All queues</option>
          {(meta?.queues ?? []).map((q) => <option key={q} value={q}>{displayName(q)}</option>)}
        </select></label>
        <label><span id="risk-filter-label">Risk</span><select aria-labelledby="risk-filter-label" value={risk} onChange={(e) => filter('risk', e.target.value)}>
          <option value="">All risk levels</option>
          {['high', 'medium', 'low'].map((v) => <option key={v} value={v}>{v[0]!.toUpperCase() + v.slice(1)}</option>)}
        </select></label>
        {filtered && <button className="link" onClick={() => setView({ ...view, status: '', queue: '', risk: '', page: 0, scroll: 0, lastId: null })}>Clear filters</button>}
        {!STATIC_DEMO && <span className="meta"><a href="/api/export/cases.csv">Cases CSV</a> · <a href="/api/export/actions.csv">Actions CSV</a></span>}
      </div>
      <p className="meta list-note">Sorted by risk, then due time.</p>
      {STATIC_DEMO && <p className="meta list-note">{DEMO_DATES}</p>}
      {error ? <p className="error" role="alert">{error}</p> : cases === null ? <p>Loading…</p> : cases.length === 0 ? <p>{filtered ? 'No cases match these filters.' : 'No cases yet.'}</p> : (
        <ul className="cases">{cases.map((c) => {
          const signal = Object.keys(SIGNAL_TEXT).find((k) => c.signals.includes(k)) ?? c.signals[0]
          return <li key={c.id}><a className="row" id={`case-${c.id}`} href={`#case=${encodeURIComponent(c.id)}`} onClick={(e) => {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) setView({ ...view, page: shownPage, scroll: window.scrollY, lastId: c.id })
          }}>
            <span className="row-heading"><span className="subject">{c.subject || '(no subject)'}</span><span aria-hidden="true">→</span></span>
            <span className="meta">{c.fromName ? `${c.fromName} · ` : ''}<span className="mono">{c.from ?? 'unknown sender'}</span></span>
            <span className="meta">{c.mailbox} · Received {when(c.receivedAt)}</span>
            <span className="tags">
              {c.risk && <span className={`tag risk-${c.risk}`}>{c.risk[0]!.toUpperCase() + c.risk.slice(1)} risk</span>}
              {c.hold && <span className="tag warn">retention hold</span>}
              <span className={`tag status-${c.status}`}>{caseStatus(c.status)}</span>
              {c.queue && <span className="tag">{displayName(c.queue)}</span>}
              {c.dueAt && c.status !== 'closed' && <span className={`tag ${Date.parse(c.dueAt) < now ? 'bad' : ''}`}>{Date.parse(c.dueAt) < now ? 'Overdue · ' : ''}Due {when(c.dueAt)}</span>}
              {c.signals.length > 0 && <span className="tag warn">{c.signals.length} warning signal{c.signals.length > 1 ? 's' : ''}</span>}
              {c.flags.map((f) => <span key={f} className="tag warn">{FLAG_TEXT[f] ?? f}</span>)}
            </span>
            {signal && <span className="meta">Warning signal: {SIGNAL_TEXT[signal] ?? signal}</span>}
          </a></li>
        })}</ul>
      )}
      {total > PAGE_SIZE && cases && (
        <nav className="toolbar" aria-label="Case pages">
          <button className="secondary" disabled={page === 0} onClick={() => turn(page - 1)}>Previous</button>
          <span className="meta">Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}</span>
          <button className="secondary" disabled={first + cases.length - 1 >= total} onClick={() => turn(page + 1)}>Next</button>
        </nav>
      )}
    </section>
  )
}

/** R-PRV-03, C-PRV-2: where the KYC transfer stands; an admin can retry a failed one. */
function KycTransfer({ t, user, reload }: { t: { id: string; state: string; error: string | null; removed: boolean }; user: SessionUser; reload: () => void }) {
  const [error, setError] = useState('')
  const [reason, setReason] = useState('')
  const blocked = t.state === 'failed' && t.error === 'infected'
  const text = transferText(t, STATIC_DEMO)
  return (
    <>
      {' '}<span className={`tag ${t.state === 'failed' ? 'bad' : ''}`}>{text}</span>
      {blocked && user.role === 'admin' && !STATIC_DEMO && (
        <span className="inline-form">
          <input aria-label="How the blocked attachment was handled" placeholder="How it was handled" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="link" disabled={!reason.trim()} onClick={() => void api('POST', `/api/kyc/deliveries/${t.id}/discard`, { reason }).then(reload, (e) => setError(e instanceof ApiError ? e.message : 'The action failed'))}>Mark as handled</button>
        </span>
      )}
      {t.state === 'failed' && !blocked && user.role === 'admin' && !STATIC_DEMO && (
        <button className="link" onClick={() => void api('POST', `/api/kyc/deliveries/${t.id}/retry`, {}).then(reload, (e) => setError(e instanceof ApiError ? e.message : 'The retry failed'))}>Retry the transfer</button>
      )}
      {error && <span className="error" role="alert"> {error}</span>}
    </>
  )
}

/**
 * PRD R-REV-02 v0.7.25: the signals that fired and the ones that could not be checked are listed; the rest are in the
 * folded full list. «No warning signals» only when none fired, and it says how many could not be checked: a signal
 * that was not checked is not a clean one.
 */
export function Signals({ details }: { details: CaseDetail['signalDetails'] }) {
  // every known signal is expected: one that has no row yet (a later batch that has not run, or a step that failed
  // before it) counts as not checked, never as clean (self-test F1)
  const known = new Set(details.map((s) => s.signal))
  const all = [...details, ...Object.keys(SIGNAL_TEXT).filter((k) => !known.has(k)).map((signal) => ({ signal, value: null, batch: 'missing' }))]
  const on = all.filter((s) => s.value === true)
  const unknown = all.filter((s) => s.value === null)
  const text = (s: { signal: string }) => SIGNAL_TEXT[s.signal] ?? s.signal
  return (
    <section aria-labelledby="signals-h">
      <h3 id="signals-h">Signals</h3>
      {details.length === 0 ? (
        <p className="meta">No signals yet.</p>
      ) : (
        <>
          {on.length > 0 && <ul className="plain signal-tags">{on.map((s) => <li key={s.signal} className="tag sig-on">{text(s)}</li>)}</ul>}
          {unknown.length > 0 && <ul className="plain signal-tags">{unknown.map((s) => <li key={s.signal} className="tag sig-unknown">{text(s)}: could not be checked</li>)}</ul>}
          {on.length === 0 && <p className="meta">{unknown.length ? `No warning signals detected. ${unknown.length} checks could not be completed.` : 'No warning signals detected.'}</p>}
          <details>
            <summary>All signals ({all.length})</summary>
            <ul className="signals">
              {all.map((s) => (
                <li key={s.signal} className={s.value ? 'on' : s.value === null ? 'unknown' : 'off'}>
                  {text(s)}: {s.value === null ? (s.batch === 'missing' ? 'not checked' : 'unknown') : s.value ? 'yes' : 'no'}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}

function Detail({ id, back, user, meta }: { id: string; back: () => void; user: SessionUser; meta: Meta | null }) {
  const [c, setC] = useState<CaseDetail | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const [notice, setNotice] = useState('')
  const reload = (message?: string) => { if (message) setNotice(message); setTick((t) => t + 1) }
  useEffect(() => {
    api<CaseDetail>('GET', `/api/cases/${id}`).then(setC, (e: Error) => setError(e.message))
  }, [id, tick])
  // after a change the pipeline runs again: look again until the new generation is complete
  useEffect(() => {
    if (!c || c.status === 'processing' || (c.e3 && !c.e3.complete)) {
      const t = setTimeout(reload, 1000)
      return () => clearTimeout(t)
    }
  }, [c])
  useEffect(() => {
    if (c) { document.getElementById('case-title')?.focus({ preventScroll: true }); window.scrollTo(0, 0) }
  }, [c?.id])
  if (error) return <div><button className="link" data-nav onClick={back}>← All cases</button><p className="error" role="alert">This case could not be loaded. {error}</p></div>
  if (!c) return <p>Loading…</p>
  const ex = c.extraction
  return (
    <article>
      {notice && <p className="error" role="alert">{notice}</p>}
      <button className="link" data-nav onClick={back}>← All cases</button>
      <p className="eyebrow">Case</p>
      <h2 id="case-title" tabIndex={-1}>{c.subject || '(no subject)'}</h2>
      <dl className="facts">
        <dt>From</dt>
        <dd className="mono">{c.fromName ? `${c.fromName} <${c.from}>` : c.from}</dd>
        <dt>To</dt>
        <dd>{c.to}</dd>
        <dt>Cc</dt>
        <dd>{c.cc ?? '—'}</dd>
        <dt>Received</dt>
        <dd>{when(c.receivedAt)} · {c.mailbox}</dd>
        {STATIC_DEMO && c.queue && (
          <>
            <dt>Queue</dt>
            <dd>{displayName(c.queue)}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>
          {caseStatus(c.status)}
          {c.status === 'failed' && (
            <><p className="error">Processing failed. Results may be incomplete. Ask an administrator to retry.</p><details><summary>Technical details</summary><p>Processing stopped at {c.failedStage ?? 'unknown'} after its retries. {c.failedReason} The failure deletes nothing. An administrator can use <code>rerun-failed</code>.</p></details></>
          )}
        </dd>
      </dl>
      {c.flags.length > 0 && (
        <ul className="flags">
          {c.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f}</li>)}
        </ul>
      )}
      <section className="case-summary" aria-label="Case summary">
        <p>{c.risk ? <span className={`tag risk-${c.risk}`}>{c.risk[0]!.toUpperCase() + c.risk.slice(1)} risk</span> : 'Risk not available'} {c.dueAt && <span className="meta">Due {when(c.dueAt)}</span>}</p>
        {!c.e3 ? <p>Analysis is not available yet.</p> : !c.e3.complete || c.status === 'processing' ? <p className="banner" role="status">Analysis is being updated. Wait for the current results before reviewing next steps.</p> : <>
          {c.e3.risk && <p className="meta">{c.e3.risk.clauses.length ? c.e3.risk.clauses.slice(0, 2).map(riskReasonText).join(' · ') : c.e3.risk.floor ? `Handling requirement: ${c.e3.risk.floor.classes.map(displayName).join(', ')}` : 'Review the risk details below.'}</p>}
          <p><strong>Next step:</strong> {c.e3.actions.map((a) => actionText(a)).join(' · ') || 'No suggested next step.'}</p>
        </>}
        {c.e3?.risk?.held && <p className="banner">A lower risk is awaiting confirmation. The current risk remains {c.e3.risk.held}.</p>}
        {c.e3?.pendingRisk && <p className="banner">Risk after reprocessing: {c.e3.pendingRisk}. Review the current result below.</p>}
      </section>
      <div className="case-grid">
      <div className="case-main">
      <h3>Message (plain text)</h3>
      <pre className="body">{c.text}</pre>
      {c.htmlText !== null && (
        <>
          <h3>HTML version (differs from the plain text; most mail clients show this one)</h3>
          <pre className="body">{c.htmlText}</pre>
        </>
      )}
      {(c.hiddenTexts ?? []).length > 0 && <section>
        <h3>Hidden text in the HTML</h3>
        <ul>{c.hiddenTexts.map((f, i) => <li key={i}><span className="meta">{({ display_none: 'display: none', visibility_hidden: 'visibility: hidden', opacity_zero: 'zero opacity', tiny_font: 'tiny font', same_colour: 'same text and background colour', transparent: 'transparent text' } as Record<string, string>)[f.reason] ?? f.reason}</span><pre className="body">{f.text}</pre></li>)}</ul>
      </section>}
      {c.attachments.length > 0 && (
        <>
          <h3>Attachments</h3>
          <ul>
            {c.attachments.map((a) => (
              <li key={a.ordinal}>
                {a.filename || '(no name)'} — {a.kind}, scan {a.scanStatus}, parse {a.parseStatus}
                {a.maybeKyc === null && <span className="tag">KYC not yet judged</span>}
                {a.maybeKyc === false && a.kycReason === 'inline_signature' && <span className="tag">Inline small image (treated as a signature image)</span>}
                {a.maybeKyc && <> <span className="tag warn">Possible KYC document</span> <span className="meta">content not sent to any model</span></>}
                {a.kycTransfer && <KycTransfer t={a.kycTransfer} user={user} reload={reload} />}
                {STATIC_DEMO && a.kycTransfer?.state === 'delivered' && !a.kycTransfer.removed && <p className="meta">This snapshot records a transfer to the demo folder; no transfer runs in this browser demo. Removal is not demonstrated: the sample attachment remains in the demo’s stored email.</p>}
              </li>
            ))}
          </ul>
          {c.attachments.some((a) => a.maybeKyc) && <details><summary>KYC handling in a real deployment</summary><p>Once all possible-KYC attachments in an email have been dealt with, maintenance replaces them with placeholders and removes the app’s stored copies. This does not remove files from your mailbox, KYC destination or backups.</p></details>}
        </>
      )}
      {c.labels.length > 0 && (
        <>
          {c.labels.some((l) => !l.adopted) && <p className="confirm">Some email types need confirmation. Review the classification evidence.</p>}
          <details><summary>Classification evidence</summary>
          {/* model text is plain text: React never renders it as HTML or Markdown (TC-REV-02) */}
          <ul className="labels">
            {c.labels.map((l) => (
              <li key={`${l.source}-${l.classId}`} className={l.adopted ? '' : 'confirm'}>
                <strong>{displayName(l.classId)}</strong> — {l.source === 'rule' ? 'rule' : l.adopted ? `model, ${l.confidence}` : 'model, low: needs confirmation'}
                {l.reason !== null && <div className="meta">{l.reason}</div>}
              </li>
            ))}
          </ul></details>
        </>
      )}
      {c.e3 && <LabelsPanel caseId={c.id} e3={c.e3} meta={meta} reload={reload} />}
      {c.fields.length > 0 && (
        <>
          <h3>Key details</h3>
          <dl className="facts fields">
            {c.fields.map((f) => (
              <Fragment key={f.field}>
                <dt>{displayName(f.field)}</dt>
                <dd className={f.needsConfirmation ? 'confirm' : ''}>
                  {f.status === 'multiple' ? f.candidates.join(' · ') : (f.value ?? '—')}
                  {f.status !== 'ok' && <span className="meta"> ({FIELD_STATUS[f.status] ?? f.status}{f.reason ? `: ${withoutRuleIds(f.reason)}` : ''})</span>}
                  {f.status === 'ok' && f.needsConfirmation && <span className="meta"> (needs confirmation{f.reason ? `: ${withoutRuleIds(f.reason)}` : ''})</span>}{' '}
                  {c.e3 && <FieldActions caseId={c.id} field={f.field} confirmed={f.confirmed} closed={c.e3.closed === true} reload={reload} />}
                </dd>
              </Fragment>
            ))}
          </dl>
        </>
      )}
      {ex && (
        <>
          {(ex.invalidIbans ?? 0) > 0 && <p className="confirm">IBAN-like text has invalid check digits and was not used.</p>}
          {ex.evidence.length > 0 && <p className="confirm">Payment documents are the sender’s confirmation, not proof of receipt.</p>}
          <details><summary>Details extracted by rules</summary>
          <dl className="facts">
            <dt>Amounts</dt>
            <dd>{ex.amounts.map((a) => money(a.minor, a.currency)).join(', ') || '—'}</dd>
            <dt>References</dt>
            <dd>{ex.references.map((r) => r.value).join(', ') || '—'}</dd>
            <dt>UETR</dt>
            <dd>{ex.uetrs.map((u) => u.value).join(', ') || '—'}{ex.uetrCandidatesInvalid.length > 0 && ` (not valid: ${ex.uetrCandidatesInvalid.map((u) => u.value).join(', ')})`}</dd>
            <dt>Bank accounts</dt>
            <dd>{ex.accounts.map((a) => `${a.kind === 'iban' ? `IBAN ${a.country}` : 'UK account'} ending ${a.last4}`).join(', ') || '—'}</dd>
            <dt>Dates</dt>
            <dd>{ex.dates.map((d) => d.iso ?? DATE_HIDDEN[d.status] ?? d.status).join(', ') || '—'}{ex.hidden && ex.hidden.kyc > 0 && <span className="meta"> · values from a possible KYC attachment are not shown</span>}</dd>
            <dt>Payment confirmations</dt>
            <dd>
              {ex.evidence.length
                ? ex.evidence.map((e, i) => <div key={i}>{e.source.toUpperCase()} {money(e.minor, e.currency)} {e.valueDate ?? ''} — sender's confirmation, not proof of receipt</div>)
                : '—'}
            </dd>
            <dt>E-signature invite</dt>
            <dd>{ex.esign.esignInvite ? ex.esign.platform : 'no'}</dd>
          </dl></details>
        </>
      )}
      </div>
      <div className="case-side">
        {c.e3 && <E3Panels caseId={c.id} e3={c.e3} user={user} meta={meta} reload={reload} signals={<Signals details={c.signalDetails} />} />}
        {!c.e3 && <Signals details={c.signalDetails} />}
        <HoldPanel caseId={c.id} hold={c.hold} reason={c.holdReason} user={user} reload={reload} />
      </div>
      </div>
    </article>
  )
}

export function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined)
  const [warnings, setWarnings] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(location.hash.slice(1)).get('case'))
  const [listView, setListView] = useState<ListView>({ status: '', queue: '', risk: '', page: 0, scroll: 0, lastId: null })
  const viewRef = useRef(listView)
  const entrySequence = useRef(0)
  const currentEntry = useRef<string | null>(null)
  const entries = useRef(new Map<string, { hash: string; view: ListView }>())
  const updateListView = (v: ListView) => {
    viewRef.current = v
    setListView(v)
    const entry = currentEntry.current && entries.current.get(currentEntry.current)
    if (entry) entry.view = v
  }
  const [meta, setMeta] = useState<Meta | null>(null)
  // a sign-out that did not go through (the static demo refuses it) says so (Codex E5 round 2 F3)
  const [signOutError, setSignOutError] = useState('')
  // the menus and warnings of whoever is signed in, as soon as they are, however that came about (TC-REV-16); the server
  // refuses both until a first password is changed. Warnings hold while a condition lasts: refreshed every minute (round 2 F12)
  const signedIn = user && !user.mustChangePassword ? user.id : null
  useEffect(() => {
    setMeta(null)
    setWarnings([])
    if (!signedIn) return
    let active = true
    const refresh = () => void api<{ warnings?: string[] }>('GET', '/api/session').then((s) => { if (active) setWarnings(s.warnings ?? []) }, () => {})
    refresh()
    void api<Meta>('GET', '/api/meta').then((m) => { if (active) setMeta(m) }, () => undefined)
    const t = setInterval(refresh, 60_000)
    return () => { active = false; clearInterval(t) }
  }, [signedIn])
  const load = useCallback(async () => {
    try {
      // the token of the session the browser has now, at every load: after a sign-out and sign-in in another tab the
      // stored one belongs to an ended session (Codex E5 F4); the server derives it from the session, any tab may ask
      await api<{ csrf: string }>('GET', '/api/csrf').then((r) => csrf.set(r.csrf), () => undefined)
      setUser((await api<{ user: SessionUser }>('GET', '/api/session')).user)
    } catch {
      setUser(null)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const previousRestoration = history.scrollRestoration
    history.scrollRestoration = 'manual'
    const changed = () => {
      const state = history.state as { trunksEntry?: string } | null
      const entry = state?.trunksEntry ? entries.current.get(state.trunksEntry) : undefined
      if (entry && entry.hash === location.hash) {
        currentEntry.current = state!.trunksEntry!
        viewRef.current = entry.view
        setListView(entry.view)
      } else {
        const key = String(++entrySequence.current)
        entries.current.set(key, { hash: location.hash, view: viewRef.current })
        currentEntry.current = key
        // Only an opaque navigation key goes into history; case view data stays in memory.
        history.replaceState({ ...(state && typeof state === 'object' ? state : {}), trunksEntry: key }, '')
      }
      setOpenId(new URLSearchParams(location.hash.slice(1)).get('case'))
    }
    changed()
    window.addEventListener('hashchange', changed)
    return () => { window.removeEventListener('hashchange', changed); history.scrollRestoration = previousRestoration }
  }, [])
  const open = (id: string | null) => {
    location.hash = id ? `case=${id}` : ''
  }
  if (user === undefined) return <p className="narrow">Loading…</p>
  // the static demo has no sign-in: a snapshot that did not load is said so, never a sign-in form (self-test F4)
  if (STATIC_DEMO && (user === null || user.mustChangePassword)) return <p className="narrow" role="alert">The demo snapshot could not be loaded. <a href="/inbox/">← Trunks</a></p>
  if (user === null) return <Login onDone={(u) => setUser(u)} />
  if (user.mustChangePassword) return <ChangePassword onDone={() => setUser({ ...user, mustChangePassword: false })} />
  return (
    <div className="shell">
      {STATIC_DEMO ? (
        // PRD R-DEMO-02 v0.7.25 (A1, A2): one thin bar; the notes and the build time fold into «About this demo»; no user,
        // role or Sign out, since the snapshot has no sign-in
        <div className="demo-bar">
          <p>
            <a href="/inbox/">← About Trunks</a> · Demo · Fictional data · View only
          </p>
          <details>
            <summary>About this demo</summary>
            <p>This demo shows precomputed results for {snapshotInfo()?.caseCount ?? 'the sample'} fictional emails. No live mailbox or model is connected.</p>
            <p>Browse cases and filter the inbox. Editing, approvals and workflow changes are unavailable in this demo.</p>
            <p>Deals, investors and contacts are fictional. Dates within the sample emails are fictional and may differ from the received dates.</p>
            <p className="meta">Demo version: v{snapshotInfo()?.version ?? 'unknown'} · Snapshot built: {snapshotInfo()?.built_at ? new Date(snapshotInfo()!.built_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'unknown'}</p>
          </details>
          {warnings.filter((w) => !w.startsWith('Read-only snapshot of the demo, built ') && !w.startsWith('Demo: fictional data only, received at fixed past times ')).map((w) => <p className="error" role="alert" key={w}>{w}</p>)}
        </div>
      ) : (
        <>
          <header>
            <strong>Trunks — Operations Inbox</strong>
            <span className="who">
              {user.username} ({user.role}){' '}
              <button className="link" onClick={() => void api('POST', '/api/logout').then(() => setUser(null), (e) => setSignOutError(e instanceof ApiError ? e.message : 'Sign-out failed'))}>Sign out</button>
            </span>
            {signOutError && <p className="error" role="alert">{signOutError}</p>}
          </header>
          {warnings.length > 0 && (
            <div className="banner" role="alert">
              {warnings.map((w) => <p key={w}>{w}</p>)}
            </div>
          )}
        </>
      )}
      <main>{STATIC_DEMO && <p className="product-name">Trunks <span className="meta">— Operations Inbox · Vegeta</span></p>}{openId ? <Detail key={openId} id={openId} back={() => open(null)} user={user} meta={meta} /> : <CaseList meta={meta} view={listView} setView={updateListView} />}</main>
    </div>
  )
}
