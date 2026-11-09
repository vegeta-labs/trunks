// A person's actions on a Case (PRD R-REV-03 to R-REV-05, R-RTE-03, C-CLS-5, C-RSK-3, C-DRF-7, C-DRF-8, C-FRD-5,
// C-LNK-0). Each action is one transaction: the change, its audit (before and after in audit_detail) and, where the
// state the events care about changes, the events (TC-OUT-06). Changes to inputs start a new generation (restartFrom).
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { tx, type Tx } from '../store/db.ts'
import { getBlobs, putBlob, putJson } from '../store/blobs.ts'
import { appendAudit } from '../store/audit.ts'
import { loadSnapshot, takeSnapshot } from '../store/directory.ts'
import type { Json } from '../lib/audit-hash.ts'
import { resultOf, type ClassifyResult, type Extraction } from '../pipeline/stages.ts'
import { checkReply, contentSha, effectiveFields, effectiveLabels, emitEvents, hadBankRuleLabel, render, replyContext, routeOf, syncVerificationTasks, taskContactOf, type LinkResult, type RiskStageResult } from '../pipeline/stages-e3.ts'
import { restartFrom } from '../pipeline/restart.ts'
import { lockThreadTo } from '../maintenance/retention.ts'
import { discardBlocked, retryDelivery } from '../maintenance/kyc.ts'
import type { Queue } from '../pipeline/queue.ts'
import { allowedManualTemplates, bodyEditable, selectTemplate } from '../lib/draft.ts'
import { applyAdjustment, computeRisk, rank, requestAdjustment, type Level } from '../lib/risk.ts'
import { checkValue } from '../lib/fields.ts'
import { canApprove, CHECKLIST, type UserEvent } from '../lib/verification.ts'
import type { Role } from './auth.ts'
import { CLASS_FIELDS_KNOWN } from '../config/constants.ts'
import type { ServerDeps } from './app.ts'

type Need = (role: Role) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
const LEVELS = ['low', 'medium', 'high'] as const
const OUTCOMES = ['replied', 'no_action', 'forwarded', 'duplicate', 'spam'] as const
const UUID = /^[0-9a-f-]{36}$/
// a person's action carries a few fields; the server-wide limit is for directory imports
const OPTS = { bodyLimit: 256 * 1024 }
const MAX_TEXT = 20_000 // characters in a reply

class Refused extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

interface CaseLock {
  id: string
  message_id: string
  processing_generation: number
  pipeline_complete_generation: number | null
  manual_revision: number
  risk: Level | null
  status: string
  queue: string | null
  assignee: string | null
}

const lockCase = async (c: Tx, id: string): Promise<CaseLock> => {
  const r = (await c.query<CaseLock>('SELECT id, message_id, processing_generation, pipeline_complete_generation, manual_revision, risk, status, queue, assignee FROM "case" WHERE id = $1 FOR UPDATE', [id])).rows[0]
  if (!r) throw new Refused(404, 'not found')
  return r
}

export function registerCaseActions(app: FastifyInstance, d: ServerDeps & { queue: Queue }, need: Need): void {
  const sd = { db: d.db, k: d.k, files: d.files, config: d.config }
  // inside a transaction every read goes through its own connection: a second pool connection per request can exhaust
  // the pool and wait for ever (Codex E3 F7)
  const on = (c: Tx) => ({ ...sd, db: c as unknown as typeof d.db })
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof Refused) return reply.code(e.code).send({ error: e.message })
      throw e
    }
  }
  const audit = (c: Tx, actor: string, type: string, caseId: string, payload: Record<string, Json>, before?: Json, after?: Json) =>
    appendAudit(c, d.k, [{ actor, type, caseId, payload, ...(before !== undefined || after !== undefined ? { detail: { before: before ?? null, after: after ?? null } } : {}) }])

  // the choices the review page offers
  app.get('/api/meta', async () => ({
    classes: d.config.classes.map((x) => ({ id: x.id, riskFloor: x.risk_floor })),
    queues: [...new Set(d.config.classes.map((x) => x.queue))],
    outcomes: OUTCOMES,
    users: await Promise.all((await d.db.query<{ id: string; username_blob: string; role: string }>('SELECT id, username_blob, role FROM app_user WHERE NOT disabled ORDER BY created_at')).rows.map(async (u) => ({ id: u.id, role: u.role, username: (await getBlobs(d.db, d.k, [u.username_blob])).get(u.username_blob)!.toString('utf8') }))),
  }))

  /** The final risk the given labels would give, everything else as computed now (C-RSK-1 to 3). */
  const riskWithLabels = async (c: Tx, cr: CaseLock, labels: string[]): Promise<Level> => {
    const g = cr.processing_generation
    const rk = (await resultOf<RiskStageResult>(on(c), cr.id, 'risk', g))!
    const lk = (await resultOf<LinkResult>(on(c), cr.id, 'link', g))!
    const ex = (await resultOf<Extraction>(on(c), cr.id, 'extract', g))!
    const sig = Object.fromEntries((await c.query<{ signal: string; value: boolean | null }>('SELECT signal, value FROM case_signal WHERE case_id = $1', [cr.id])).rows.map((x) => [x.signal, x.value]))
    const computed = computeRisk({
      classes: d.config.classes, labels, signals: sig, accountPresent: rk.inputs.accountPresent, uetrCandidatesInvalid: ex.uetrCandidatesInvalid.length, amountsBody: rk.inputs.amountsBody,
      amountsAttachment: rk.inputs.amountsAttachment, attachmentBlockedOrOverLimit: rk.inputs.blockedOrOverLimit, pressure: rk.inputs.pressure, plannedCloseDate: lk.dealCloseDate,
      receivedDate: rk.inputs.receivedDate, holidays: new Set(d.config.routing.holidays), evidenceBeneficiaryMismatch: rk.inputs.evidenceBeneficiaryMismatch,
    })
    const adj = (await c.query<{ level: Level; computed_at_set: Level; reasons: string[] }>(`SELECT level, computed_at_set, reasons FROM risk_adjustment WHERE case_id = $1 AND state = 'active'`, [cr.id])).rows[0]
    return applyAdjustment(computed, adj ? { level: adj.level, computedAtSet: adj.computed_at_set, reasons: adj.reasons } : null, d.config.classes).level
  }

  // ---------- labels (C-CLS-5) ----------
  app.post<{ Params: { id: string }; Body: { add?: string[]; remove?: string[]; reason?: string } }>('/api/cases/:id/labels', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const add = req.body?.add ?? []
        const remove = req.body?.remove ?? []
        const known = new Set(d.config.classes.map((x) => x.id))
        if ([...add, ...remove].some((x) => !known.has(x)) || add.length + remove.length === 0) throw new Refused(400, 'unknown or no class')
        if (cr.pipeline_complete_generation !== cr.processing_generation) throw new Refused(409, 'the Case is being reprocessed') // R2-3
        const cls = await resultOf<ClassifyResult>(on(c), cr.id, 'classify', cr.processing_generation)
        const ruleLabels = new Set((cls?.labels ?? []).filter((l) => l.source === 'rule').map((l) => l.classId))
        if (await hadBankRuleLabel(c, cr.id)) ruleLabels.add('bank_details') // C-CLS-4a E6
        if (remove.some((x) => ruleLabels.has(x))) throw new Refused(409, 'a rule label cannot be removed (C-CLS-5)')
        const before = await effectiveLabels(on(c), cr.id, cr.processing_generation)
        const after = new Set(before.risk)
        for (const x of remove) after.delete(x)
        for (const x of add) after.add(x)
        // C-CLS-5 → C-RSK-3 (v0.7.15): the whole risk (C-RSK-1 to 2a and the active adjustment) with the new labels
        // compared with the risk as computed now, not a held level (R2-2): adding a class never «lowers»
        const lowers = rank(await riskWithLabels(c, cr, [...after])) < rank(await riskWithLabels(c, cr, before.risk))
        const approved = lowers && req.user!.role !== 'reviewer' && !!req.body?.reason?.trim()
        if (lowers && !approved) throw new Refused(403, 'lowering the risk this way needs the approver role and a reason (C-RSK-3)')
        const reasonBlob = req.body?.reason?.trim() ? await putBlob(c, d.k, req.body.reason.trim()) : null
        for (const [list, action] of [[remove, 'remove'], [add, 'add']] as const) {
          for (const x of list) await c.query('INSERT INTO case_label_change (id, case_id, class_id, action, by_user, reason_blob) VALUES ($1, $2, $3, $4, $5, $6)', [randomUUID(), cr.id, x, action, req.user!.id, reasonBlob])
        }
        await audit(c, req.user!.id, 'case.labels_changed', cr.id, { add, remove, lowers_risk: lowers }, before.adopted, [...new Set([...before.adopted.filter((x) => !remove.includes(x)), ...add])])
        // an approver's reasoned lowering needs no new hold; an earlier hold stays until /risk/confirm-lower (R2-2)
        return restartFrom(c, d.queue, cr.id, 'link', 'person', { hold: !approved })
      }),
    ),
  )

  // ---------- fields (R-REV-03, C-DRF-1 «经人确认») ----------
  // `confirm: true` keeps the current value and marks it confirmed by a person; `value` sets a new one
  app.put<{ Params: { id: string; field: string }; Body: { value?: unknown; confirm?: boolean } }>('/api/cases/:id/fields/:field', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        if (!CLASS_FIELDS_KNOWN.has(req.params.field)) throw new Refused(400, 'unknown field') // §5.5a field table only
        // the value in effect before this change, for the audit (R-REV-03, Codex E3 F12)
        const previousField = (await effectiveFields(on(c), cr.id, cr.processing_generation))[req.params.field] ?? null
        let value: { value: unknown } | null
        if (req.body?.confirm === true) {
          const cur = (await effectiveFields({ db: c as never, k: d.k }, cr.id, cr.processing_generation))[req.params.field]
          if (!cur || cur.status !== 'ok' || cur.value === null) throw new Refused(409, 'only a single valid value can be confirmed; choose or type the value instead')
          value = { value: cur.value }
        } else if (req.body?.value === undefined || req.body.value === null) value = null
        else {
          // §5.5a: the same checks as a model value (TC-REV-08); account_last4 comes from the rules only
          const raw = req.body.value
          if (typeof raw !== 'string' && typeof raw !== 'boolean' && !(Array.isArray(raw) && raw.every((x) => typeof x === 'string'))) throw new Refused(400, 'a value is text, true / false or a list of text')
          const snap = await loadSnapshot(c, d.k, (await c.query<{ snapshot_id: string }>('SELECT snapshot_id FROM "case" WHERE id = $1', [cr.id])).rows[0]!.snapshot_id)
          const checked = checkValue(req.params.field, raw, {
            modelText: '', currencies: d.config.deployment.currencies, platforms: Object.keys(d.config.esign_platforms), deals: snap.deals.map((x) => ({ id: x.dealKey, name: x.name })), restore: (t) => t,
            rules: { uetrs: [], amounts: [], evidenceAmounts: [], references: snap.commitments.map((x) => x.reference), accountLast4: [], valueDates: [] },
          })
          if (!checked.ok) throw new Refused(400, `${req.params.field}: ${checked.reason}`)
          value = { value: checked.value }
        }
        await c.query('INSERT INTO case_field_change (id, case_id, field, value_blob, by_user) VALUES ($1, $2, $3, $4, $5)', [
          randomUUID(), cr.id, req.params.field, value === null ? null : await putJson(c, d.k, value as unknown as Json), req.user!.id,
        ])
        await audit(c, req.user!.id, 'case.field_changed', cr.id, { field: req.params.field }, (previousField ?? null) as unknown as Json, value as unknown as Json)
        return restartFrom(c, d.queue, cr.id, 'link', 'person')
      }),
    ),
  )

  // ---------- links (R-LNK-02, TC-LNK-04) ----------
  app.put<{ Params: { id: string; kind: string }; Body: { target?: string | null } }>('/api/cases/:id/links/:kind', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        if (!['contact', 'commitment', 'deal'].includes(req.params.kind)) throw new Refused(400, 'unknown link kind')
        const target = typeof req.body?.target === 'string' && req.body.target.trim() ? req.body.target.trim() : null
        // only what the Case's snapshot holds (appendix A, C-DRF-1 {deal_name})
        if (target !== null) {
          const snap = await loadSnapshot(c, d.k, (await c.query<{ snapshot_id: string }>('SELECT snapshot_id FROM "case" WHERE id = $1', [cr.id])).rows[0]!.snapshot_id)
          const known = req.params.kind === 'contact' ? snap.contacts.map((x) => x.contactId) : req.params.kind === 'deal' ? snap.deals.map((x) => x.name) : snap.commitments.map((x) => `${snap.deals.find((dd) => dd.dealKey === x.dealKey)?.name}::${x.investorId}`)
          if (!known.includes(target)) throw new Refused(409, `not a ${req.params.kind} of this Case's directory`)
        }
        const lkNow = await resultOf<LinkResult>(on(c), cr.id, 'link', cr.processing_generation)
        // C-LNK-6 ①: with a commitment linked the deal is the commitment's; change the commitment instead (Codex E3 F1)
        if (req.params.kind === 'deal' && lkNow?.commitment && target !== null && target !== lkNow.dealName) throw new Refused(409, `the linked commitment belongs to ${lkNow.dealName}; change the commitment link instead`)
        // the link in effect: a person's active link of this kind, else the last complete generation's (Codex round 2 F12)
        const personRow = (await c.query<{ target_blob: string | null }>(`SELECT target_blob FROM case_link WHERE case_id = $1 AND kind = $2 AND source = 'person' AND active ORDER BY created_at DESC LIMIT 1`, [cr.id, req.params.kind])).rows[0]
        const lkDone = lkNow ?? (cr.pipeline_complete_generation !== null ? await resultOf<LinkResult>(on(c), cr.id, 'link', cr.pipeline_complete_generation) : null)
        const previousLink = personRow ? (personRow.target_blob ? (await getBlobs(c, d.k, [personRow.target_blob])).get(personRow.target_blob)!.toString('utf8') : null)
          : req.params.kind === 'contact' ? lkDone?.links.contact.id : req.params.kind === 'deal' ? lkDone?.dealName : lkDone?.commitment?.key
        await c.query(`UPDATE case_link SET active = false WHERE case_id = $1 AND kind = $2 AND source = 'person' AND active`, [cr.id, req.params.kind])
        await c.query('INSERT INTO case_link (id, case_id, generation, kind, target_blob, source, by_user) VALUES ($1, $2, NULL, $3, $4, $5, $6)', [
          randomUUID(), cr.id, req.params.kind, target ? await putBlob(c, d.k, target) : null, 'person', req.user!.id,
        ])
        await audit(c, req.user!.id, 'case.link_changed', cr.id, { kind: req.params.kind }, previousLink ?? null, target)
        return restartFrom(c, d.queue, cr.id, 'link', 'person')
      }),
    ),
  )

  // ---------- relink with the latest directory (C-LNK-0) ----------
  app.post<{ Params: { id: string } }>('/api/cases/:id/relink', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const old = (await c.query<{ snapshot_id: string }>('SELECT snapshot_id FROM "case" WHERE id = $1', [cr.id])).rows[0]!.snapshot_id
        const snap = await takeSnapshot(c)
        await c.query('UPDATE "case" SET snapshot_id = $2 WHERE id = $1', [cr.id, snap])
        await audit(c, req.user!.id, 'case.relinked', cr.id, { from_snapshot: old, to_snapshot: snap })
        // reference extraction onwards; the signals are not recomputed
        return restartFrom(c, d.queue, cr.id, 'extract', 'person')
      }),
    ),
  )

  // ---------- risk (C-RSK-3 ①–⑦) ----------
  app.post<{ Params: { id: string }; Body: { level?: Level; reason?: string } }>('/api/cases/:id/risk', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const level = req.body?.level
        if (!level || !LEVELS.includes(level)) throw new Refused(400, 'level required')
        const rk = await resultOf<RiskStageResult>(on(c), cr.id, 'risk', cr.processing_generation)
        if (!rk || !cr.risk) throw new Refused(409, 'the risk has not been computed yet')
        const r = requestAdjustment(level, rk.computed, cr.risk, d.config.classes)
        const reason = req.body?.reason?.trim() ?? ''
        if (r.needsApprover && (req.user!.role === 'reviewer' || !reason)) throw new Refused(403, 'lowering the risk needs the approver role and a reason (C-RSK-3)')
        const active = (await c.query<{ id: string }>(`SELECT id FROM risk_adjustment WHERE case_id = $1 AND state = 'active'`, [cr.id])).rows[0]
        if (active) await c.query(`UPDATE risk_adjustment SET state = $2, ended_at = now() WHERE id = $1`, [active.id, r.kind === 'cancel' ? 'cancelled' : 'replaced'])
        if (r.kind === 'set') {
          await c.query('INSERT INTO risk_adjustment (id, case_id, level, computed_at_set, reasons, state, by_user, reason_blob) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
            randomUUID(), cr.id, r.adjustment.level, r.adjustment.computedAtSet, JSON.stringify(r.adjustment.reasons), 'active', req.user!.id, reason ? await putBlob(c, d.k, reason) : null,
          ])
        }
        await audit(c, req.user!.id, 'case.risk_adjusted', cr.id, { kind: r.kind, from: cr.risk, to: level, computed: rk.computed.level, needs_approver: r.needsApprover }, reason ? { reason } : null)
        if (r.needsApprover) await c.query('UPDATE "case" SET risk_hold = NULL WHERE id = $1', [cr.id]) // an approver decided (C-RSK-3 v0.7.15)
        return restartFrom(c, d.queue, cr.id, 'risk', 'person', { hold: false })
      }),
    ),
  )

  // C-RSK-3 v0.7.15: an approver accepts the lower risk a person's change led to
  // the approver confirms the lower level that was computed and shown, nothing else (R2-4)
  app.post<{ Params: { id: string }; Body: { reason?: string; level?: Level } }>('/api/cases/:id/risk/confirm-lower', { ...OPTS, preHandler: need('approver') }, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const reason = req.body?.reason?.trim() ?? ''
        if (!reason) throw new Refused(400, 'a reason is required')
        if (cr.pipeline_complete_generation !== cr.processing_generation) throw new Refused(409, 'the Case is being reprocessed')
        const rk = await resultOf<RiskStageResult>(on(c), cr.id, 'risk', cr.processing_generation)
        if (!rk?.held) throw new Refused(409, 'no lower risk is waiting for confirmation')
        if (req.body?.level !== rk.applied) throw new Refused(409, `the lower risk now computed is ${rk.applied}; confirm that level`)
        await c.query('UPDATE "case" SET risk_hold = NULL WHERE id = $1', [cr.id])
        await audit(c, req.user!.id, 'case.risk_lowering_confirmed', cr.id, { held: rk.held, to: rk.applied }, null, { reason })
        return restartFrom(c, d.queue, cr.id, 'risk', 'person', { hold: false })
      }),
    ),
  )

  // ---------- «hold» (PRD R-REV-07, C-PRV-1 v0.7.18) ----------
  // approver and admin; a reason each time; the thread's earlier Cases are locked first in creation order, the same
  // order retention takes them, so a hold set while a deletion runs is never missed (tech design v0.7.9)
  app.post<{ Params: { id: string }; Body: { hold?: boolean; reason?: string } }>('/api/cases/:id/hold', { ...OPTS, preHandler: need('approver') }, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        if (!UUID.test(req.params.id)) throw new Refused(404, 'not found')
        const hold = req.body?.hold
        if (typeof hold !== 'boolean') throw new Refused(400, 'hold must be true or false')
        const reason = req.body?.reason?.trim() ?? ''
        if (!reason) throw new Refused(400, 'a reason is required')
        if (reason.length > 2000) throw new Refused(400, 'the reason is too long')
        if (!(await lockThreadTo(c, req.params.id)).length) throw new Refused(404, 'not found')
        const cr = await lockCase(c, req.params.id)
        const cur = (await c.query<{ hold: boolean }>('SELECT hold FROM "case" WHERE id = $1', [cr.id])).rows[0]!.hold
        if (cur === hold) throw new Refused(409, hold ? 'the Case is already on hold' : 'the Case is not on hold')
        await c.query('UPDATE "case" SET hold = $2, hold_reason_blob = $3 WHERE id = $1', [cr.id, hold, hold ? await putBlob(c, d.k, reason) : null])
        await audit(c, req.user!.id, hold ? 'case.hold_set' : 'case.hold_cleared', cr.id, {}, null, { reason })
        return { ok: true, hold }
      }),
    ),
  )

  // ---------- KYC transfer retry (PRD R-PRV-03 v0.7.18): admin only, audited; the next run sends it ----------
  app.post<{ Params: { id: string } }>('/api/kyc/deliveries/:id/retry', { ...OPTS, preHandler: need('admin') }, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        if (!UUID.test(req.params.id)) throw new Refused(404, 'not found')
        if (!(await retryDelivery(c, d.k, req.params.id, req.user!.id))) throw new Refused(409, 'only a failed transfer can be retried')
        return { ok: true }
      }),
    ),
  )

  // R-PRV-03 v0.7.19: a blocked possible-KYC attachment, handled by hand, is marked so the replacement can go ahead
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/kyc/deliveries/:id/discard', { ...OPTS, preHandler: need('admin') }, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        if (!UUID.test(req.params.id)) throw new Refused(404, 'not found')
        const reason = req.body?.reason?.trim() ?? ''
        if (!reason || reason.length > 2000) throw new Refused(400, 'a reason is required')
        if (!(await discardBlocked(c, d.k, req.params.id, req.user!.id, reason))) throw new Refused(409, 'only a transfer stopped by the virus scan can be marked handled')
        return { ok: true }
      }),
    ),
  )

  // ---------- replies (C-DRF-2, C-DRF-7, C-DRF-8, R-REV-04) ----------
  const loadReply = async (c: Tx, caseId: string, replyId: string) => {
    if (!UUID.test(replyId)) throw new Refused(404, 'not found')
    const r = (await c.query<{ id: string; template_id: string; template_source: string; edited: boolean; recipient_blob: string | null; subject_blob: string; text_blob: string; content_sha256: string; status: string; generation: number; approved_generation: number | null; approved_manual_revision: number | null }>(
      'SELECT id, template_id, template_source, edited, recipient_blob, subject_blob, text_blob, content_sha256, status, generation, approved_generation, approved_manual_revision FROM reply WHERE id = $1 AND case_id = $2 FOR UPDATE',
      [replyId, caseId],
    )).rows[0]
    if (!r) throw new Refused(404, 'not found')
    const b = await getBlobs(c, d.k, [r.subject_blob, r.text_blob, ...(r.recipient_blob ? [r.recipient_blob] : [])])
    return { ...r, subject: b.get(r.subject_blob)!.toString('utf8'), text: b.get(r.text_blob)!.toString('utf8'), recipient: r.recipient_blob ? b.get(r.recipient_blob)!.toString('utf8') : null }
  }

  // a person's version: edited text, another allowed template, or another allowed recipient
  app.post<{ Params: { id: string; replyId: string }; Body: { text?: string; templateId?: string; recipient?: string } }>('/api/cases/:id/replies/:replyId/revise', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const base = await loadReply(c, cr.id, req.params.replyId)
        if (cr.pipeline_complete_generation !== cr.processing_generation) throw new Refused(409, 'the Case is being reprocessed')
        // C-DRF-8 v0.7.15: only a draft of the current generation is worked on
        if (base.status !== 'draft' || base.generation !== cr.processing_generation) throw new Refused(409, 'this reply is out of date; work on the current draft')
        const ctx = await replyContext({ ...sd, db: c as never }, cr.id, cr.message_id, cr.processing_generation)
        let templateId = base.template_id
        let subject = base.subject
        let text = base.text
        let removed = 0
        let source = base.template_source
        if (req.body?.templateId && req.body.templateId !== base.template_id) {
          if (!allowedManualTemplates(ctx.select).includes(req.body.templateId)) throw new Refused(409, 'this template is not allowed for this Case (C-DRF-7)')
          templateId = req.body.templateId
          source = 'person'
          const r = render(d.config, templateId, ctx.values)
          subject = r.subject
          text = r.text
          removed = r.removed
        }
        if (typeof req.body?.text === 'string' && req.body.text.length > MAX_TEXT) throw new Refused(400, `a reply is at most ${MAX_TEXT} characters`)
        if (typeof req.body?.text === 'string' && req.body.text !== text) {
          if (!bodyEditable(templateId)) throw new Refused(409, `the text of ${templateId} cannot be changed (C-DRF-7)`)
          text = req.body.text
        }
        const recipient = typeof req.body?.recipient === 'string' ? req.body.recipient.trim().toLowerCase() : base.recipient
        const check = checkReply({ subject, text, recipient, allowed: ctx.allowed, removed, extraInternal: d.config.replies.internal_terms_extra })
        const id = randomUUID()
        // C-OUT-3 v0.7.12: the suggested actions follow the template in use, so a template change re-runs from the reply
        // step as a system run (no manual revision: a verification task stays valid); the person's reply belongs to that
        // new generation, so it can be approved once the run completes (R2-1)
        const generation = templateId !== base.template_id ? (await restartFrom(c, d.queue, cr.id, 'reply', 'system')).generation : cr.processing_generation
        await c.query(
          `INSERT INTO reply (id, case_id, generation, template_id, template_source, edited, recipient_blob, subject_blob, text_blob, content_sha256, removed_sentences, check_ok, check_problems, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', $14)`,
          [id, cr.id, generation, templateId, source, base.edited || text !== base.text, recipient ? await putBlob(c, d.k, recipient) : null, await putBlob(c, d.k, subject), await putBlob(c, d.k, text),
            contentSha(recipient, subject, text), removed, check.ok, JSON.stringify(check.problems), req.user!.id],
        )
        await c.query(`UPDATE reply SET status = 'superseded' WHERE id = $1`, [base.id])
        await audit(c, req.user!.id, 'reply.revised', cr.id, { reply_id: id, from_reply: base.id, template: templateId, template_changed: templateId !== base.template_id, check_ok: check.ok, problems: check.problems.map((p) => p.split(':')[0]!) },
          { template: base.template_id, recipient: base.recipient, text: base.text }, { template: templateId, recipient, text })
        return { replyId: id, check }
      }),
    ),
  )

  /** C-DRF-8: whether an approval still holds; checked at approval and again before copying, in the same transaction. */
  const approvalProblems = async (c: Tx, cr: CaseLock, r: Awaited<ReturnType<typeof loadReply>>, forCopy: boolean): Promise<string[]> => {
    const p: string[] = []
    // a re-run is under way: nothing can be checked against a generation that has not finished (C-DRF-8)
    if (cr.pipeline_complete_generation !== cr.processing_generation) return ['the Case is being reprocessed']
    if (r.generation !== cr.processing_generation) p.push('the reply is from an earlier generation; work on the current draft')
    if (forCopy && (r.approved_generation !== cr.processing_generation || r.approved_manual_revision !== cr.manual_revision)) p.push('the Case changed after the approval')
    const ctx = await replyContext({ ...sd, db: c as never }, cr.id, cr.message_id, cr.processing_generation, cr.risk ?? undefined)
    const check = checkReply({ subject: r.subject, text: r.text, recipient: r.recipient, allowed: ctx.allowed, removed: 0, extraInternal: d.config.replies.internal_terms_extra })
    p.push(...check.problems)
    if (contentSha(r.recipient, r.subject, r.text) !== r.content_sha256) p.push('the content changed')
    if (r.template_source === 'auto') {
      if (selectTemplate(ctx.select).template !== r.template_id) p.push('the rules now choose another template')
    } else if (!allowedManualTemplates(ctx.select).includes(r.template_id)) p.push('the chosen template is no longer allowed')
    return p
  }

  app.post<{ Params: { id: string; replyId: string } }>('/api/cases/:id/replies/:replyId/approve', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const r = await loadReply(c, cr.id, req.params.replyId)
        if (r.status !== 'draft') throw new Refused(409, `the reply is ${r.status}`)
        const problems = await approvalProblems(c, cr, r, false)
        if (problems.length) throw new Refused(409, `cannot approve: ${problems.join('; ')}`)
        await c.query(`UPDATE reply SET status = 'superseded' WHERE case_id = $1 AND status = 'approved'`, [cr.id])
        await c.query(`UPDATE reply SET status = 'approved', approved_by = $2, approved_at = now(), approved_generation = $3, approved_manual_revision = $4 WHERE id = $1`, [r.id, req.user!.id, cr.processing_generation, cr.manual_revision])
        await c.query(`UPDATE "case" SET status = 'approved' WHERE id = $1`, [cr.id])
        await audit(c, req.user!.id, 'reply.approved', cr.id, { reply_id: r.id, template: r.template_id, template_source: r.template_source, content_sha256: r.content_sha256, generation: cr.processing_generation, manual_revision: cr.manual_revision })
        await emitEvents(c, sd, cr.id)
        return { ok: true }
      }),
    ),
  )

  app.post<{ Params: { id: string; replyId: string } }>('/api/cases/:id/replies/:replyId/copy', OPTS, async (req, reply) =>
    run(reply, async () => {
      const out = await tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const r = await loadReply(c, cr.id, req.params.replyId)
        if (r.status !== 'approved' && r.status !== 'sent') return { refused: 'the reply is not approved' }
        const problems = await approvalProblems(c, cr, r, true)
        if (problems.length && r.status === 'sent') return { refused: `this reply was marked as sent and no longer matches the Case: ${problems.join('; ')}` } // the record stays (R-REV-04)
        if (problems.length) {
          // the approval no longer holds: back to a draft, needs approving again
          await c.query(`UPDATE reply SET status = 'draft', approved_by = NULL, approved_at = NULL, approved_generation = NULL, approved_manual_revision = NULL WHERE id = $1`, [r.id])
          await c.query(`UPDATE "case" SET status = 'open' WHERE id = $1 AND status = 'approved'`, [cr.id])
          await audit(c, req.user!.id, 'reply.approval_lapsed', cr.id, { reply_id: r.id, problems: problems.map((p) => p.split(':')[0]!) })
          return { refused: `the approval no longer holds: ${problems.join('; ')}` }
        }
        await audit(c, req.user!.id, 'reply.copied', cr.id, { reply_id: r.id, content_sha256: r.content_sha256 })
        return { recipient: r.recipient, subject: r.subject, text: r.text }
      })
      return 'refused' in out ? reply.code(409).send({ error: out.refused }) : out
    }),
  )

  app.post<{ Params: { id: string; replyId: string } }>('/api/cases/:id/replies/:replyId/sent', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const r = await loadReply(c, cr.id, req.params.replyId)
        if (r.status !== 'approved') throw new Refused(409, 'only an approved reply can be marked as sent')
        await c.query(`UPDATE reply SET status = 'sent', sent_by = $2, sent_at = now() WHERE id = $1`, [r.id, req.user!.id])
        await c.query(`UPDATE "case" SET status = 'sent' WHERE id = $1`, [cr.id])
        await audit(c, req.user!.id, 'reply.marked_sent', cr.id, { reply_id: r.id })
        return { ok: true }
      }),
    ),
  )

  app.post<{ Params: { id: string; replyId: string } }>('/api/cases/:id/replies/:replyId/reject', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const r = await loadReply(c, cr.id, req.params.replyId)
        if (r.status !== 'draft' && r.status !== 'approved') throw new Refused(409, `the reply is ${r.status}`)
        await c.query(`UPDATE reply SET status = 'rejected' WHERE id = $1`, [r.id])
        if (r.status === 'approved') await c.query(`UPDATE "case" SET status = 'open' WHERE id = $1 AND status = 'approved'`, [cr.id])
        await audit(c, req.user!.id, 'reply.rejected', cr.id, { reply_id: r.id })
        await emitEvents(c, sd, cr.id) // the reply in use, and so the actions, may change (C-OUT-3, self-review R1)
        return { ok: true }
      }),
    ),
  )

  // ---------- queue, assignee, close (R-RTE-03, R-REV-03) ----------
  app.put<{ Params: { id: string }; Body: { queue?: string; assignee?: string | null } }>('/api/cases/:id/assignment', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const queues = new Set(d.config.classes.map((x) => x.queue))
        const before = { queue: cr.queue, assignee: cr.assignee }
        if (req.body?.queue !== undefined) {
          if (!queues.has(req.body.queue)) throw new Refused(400, 'unknown queue')
          const received = (await c.query<{ received_at: Date }>('SELECT m.received_at FROM "case" c JOIN message m ON m.id = c.message_id WHERE c.id = $1', [cr.id])).rows[0]!.received_at
          // before classification the due time needs only the queue; the route step adds the follow-up later (Codex round 3 F22)
          const classified = (await resultOf(on(c), cr.id, 'classify', cr.processing_generation)) !== null
          const adopted = classified ? (await effectiveLabels({ db: c as never, k: d.k }, cr.id, cr.processing_generation)).adopted : []
          // a new queue: due time from the receipt time again (C-RTE-1)
          const r = routeOf(d.config, adopted, received.toISOString(), req.body.queue)
          await c.query(`UPDATE "case" SET queue = $2, queue_by = 'person', due_at = $3 WHERE id = $1`, [cr.id, r.queue, r.dueAt])
        }
        if (req.body?.assignee !== undefined) {
          const a = req.body.assignee
          if (a !== null && (!UUID.test(a) || !(await c.query('SELECT 1 FROM app_user WHERE id = $1 AND NOT disabled', [a])).rowCount)) throw new Refused(400, 'unknown user')
          await c.query('UPDATE "case" SET assignee = $2 WHERE id = $1', [cr.id, a])
        }
        await audit(c, req.user!.id, 'case.assigned', cr.id, { queue_changed: req.body?.queue !== undefined, assignee_changed: req.body?.assignee !== undefined }, before, { queue: req.body?.queue ?? cr.queue, assignee: req.body?.assignee === undefined ? cr.assignee : req.body.assignee })
        await emitEvents(c, sd, cr.id)
        return { ok: true }
      }),
    ),
  )

  app.post<{ Params: { id: string }; Body: { outcome?: string } }>('/api/cases/:id/close', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const cr = await lockCase(c, req.params.id)
        const outcome = req.body?.outcome
        if (!outcome || !(OUTCOMES as readonly string[]).includes(outcome)) throw new Refused(400, `outcome required: ${OUTCOMES.join(', ')}`)
        await c.query(`UPDATE "case" SET status = 'closed', closed_at = now(), outcome = $2 WHERE id = $1`, [cr.id, outcome])
        await audit(c, req.user!.id, 'case.closed', cr.id, { outcome })
        await emitEvents(c, sd, cr.id)
        return { ok: true }
      }),
    ),
  )

  // ---------- verification tasks (C-FRD-4, C-FRD-5) ----------
  // the Case first, then the task: the same order as the pipeline (WP4)
  const loadTask = async (c: Tx, taskId: string) => {
    if (!UUID.test(taskId)) throw new Refused(404, 'not found')
    const owner = (await c.query<{ case_id: string }>('SELECT case_id FROM verification_task WHERE id = $1', [taskId])).rows[0]
    if (!owner) throw new Refused(404, 'not found')
    const cr = await lockCase(c, owner.case_id)
    const t = (await c.query<{ id: string; case_id: string; state: string; checklist: string[]; checked: string[]; completed_by: string | null; completed_at: Date | null; cooling_until: Date | null }>(
      'SELECT id, case_id, state, checklist, checked, completed_by, completed_at, cooling_until FROM verification_task WHERE id = $1 FOR UPDATE',
      [taskId],
    )).rows[0]
    if (!t) throw new Refused(404, 'not found')
    // C-FRD-5: nothing on a task whose binding has changed but whose invalidation has not been published yet (WP3)
    const binding = (await c.query<{ bound_manual_revision: number; bound_contact_blob: string | null }>('SELECT bound_manual_revision, bound_contact_blob FROM verification_task WHERE id = $1', [taskId])).rows[0]!
    if (cr.pipeline_complete_generation !== cr.processing_generation) throw new Refused(409, 'the Case is being reprocessed')
    const lk = await resultOf<LinkResult>(on(c), cr.id, 'link', cr.processing_generation)
    const bound = binding.bound_contact_blob ? (await getBlobs(c, d.k, [binding.bound_contact_blob])).get(binding.bound_contact_blob)!.toString('utf8') : null
    if (binding.bound_manual_revision !== cr.manual_revision || bound !== (taskContactOf(lk)?.contact.contactId ?? null)) throw new Refused(409, 'this task no longer applies; a new task replaces it')
    return { ...t, cr, lk }
  }

  app.post<{ Params: { taskId: string }; Body: { items?: string[] } }>('/api/verification/:taskId/complete', OPTS, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const t = await loadTask(c, req.params.taskId)
        if (t.state !== 'open') throw new Refused(409, `the task is ${t.state}`)
        const items = req.body?.items ?? []
        if (!CHECKLIST.every((x) => items.includes(x))) throw new Refused(400, 'every checklist item must be ticked')
        const hours = d.config.verification.cooling_off_hours
        await c.query(`UPDATE verification_task SET state = 'checklist_done', checked = $2, completed_by = $3, completed_at = now(), cooling_until = now() + make_interval(secs => $4) WHERE id = $1`, [t.id, JSON.stringify(CHECKLIST), req.user!.id, hours * 3600])
        await audit(c, req.user!.id, 'verification.checklist_done', t.case_id, { task_id: t.id, cooling_off_hours: hours })
        return { ok: true }
      }),
    ),
  )

  app.post<{ Params: { taskId: string }; Body: { reason?: string } }>('/api/verification/:taskId/restart', { ...OPTS, preHandler: need('approver') }, async (req, reply) =>
    run(reply, () => tx(d.db, async (c) => {
      const t = await loadTask(c, req.params.taskId)
      if (t.state !== 'open' && t.state !== 'checklist_done') throw new Refused(409, `the task is ${t.state}`)
      const reason = req.body?.reason
      if (typeof reason !== 'string' || !reason.trim()) throw new Refused(400, 'a reason is required (C-FRD-5)')
      const kind = (await c.query<{ kind: string }>('SELECT kind FROM verification_task WHERE id = $1', [t.id])).rows[0]!.kind
      const labels = await effectiveLabels(on(c), t.cr.id, t.cr.processing_generation)
      if (!t.lk || !labels.adopted.includes(kind)) throw new Refused(409, 'this task no longer applies (C-FRD-5)')
      await syncVerificationTasks(c, on(c), t.cr, labels.adopted, t.lk, kind)
      const replacement = (await c.query<{ replaced_by: string }>('SELECT replaced_by FROM verification_task WHERE id = $1', [t.id])).rows[0]!.replaced_by
      await appendAudit(c, d.k, [{ actor: req.user!.id, type: 'verification.restarted', caseId: t.case_id, payload: { task_id: t.id, replaced_by: replacement }, detail: { reason } }])
      return { ok: true, taskId: replacement }
    })),
  )

  app.post<{ Params: { taskId: string } }>('/api/verification/:taskId/approve', { ...OPTS, preHandler: need('approver') }, async (req, reply) =>
    run(reply, () =>
      tx(d.db, async (c) => {
        const t = await loadTask(c, req.params.taskId)
        if (t.state !== 'checklist_done') throw new Refused(409, `the task is ${t.state}`)
        const pair = [t.completed_by!, req.user!.id]
        // both users' rows locked in one order first: a role change or credential reset (which update these rows) waits for
        // this decision or comes before it, never in between (C-FRD-5, Codex round 2 F15)
        const locked = (await c.query<{ id: string; role: string; credential_version: number; disabled: boolean }>(
          'SELECT id, role, credential_version, disabled FROM app_user WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [pair],
        )).rows
        const me = locked.find((u) => u.id === req.user!.id)
        if (!me || me.disabled || me.credential_version !== req.user!.credentialVersion || me.role !== req.user!.role) throw new Refused(409, 'your account changed; sign in again')
        // the whole history of both users (C-FRD-5), read in this transaction
        const events = (await c.query<{ user_id: string; type: UserEvent['type']; role: string | null; by_user: string | null; at: Date }>(
          'SELECT user_id, type, role, by_user, at FROM user_event WHERE user_id = ANY($1::uuid[]) OR by_user = ANY($1::uuid[]) ORDER BY at',
          [pair],
        )).rows.map((e) => ({ userId: e.user_id, type: e.type, role: e.role, byUser: e.by_user, at: e.at.toISOString() }))
        const roles = Object.fromEntries(locked.map((u) => [u.id, u.role]))
        const now = (await c.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now.toISOString()
        const r = canApprove({ completedBy: t.completed_by!, approver: { id: req.user!.id, role: req.user!.role }, checklistDoneAt: t.completed_at!.toISOString(), now, coolingMs: d.config.verification.cooling_off_hours * 3_600_000, events, currentRoles: roles })
        await audit(c, req.user!.id, 'verification.approval_checked', t.case_id, { task_id: t.id, ok: r.ok, reason: r.ok ? null : r.reason })
        if (!r.ok) return { refused: `${r.reason} (C-FRD-5)` }
        await c.query(`UPDATE verification_task SET state = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [t.id, req.user!.id])
        await audit(c, req.user!.id, 'verification.approved', t.case_id, { task_id: t.id })
        await emitEvents(c, sd, t.case_id)
        return { ok: true }
      }).then((x) => ('refused' in x ? reply.code(403).send({ error: x.refused }) : x)),
    ),
  )
}
