// `ingest` (tech design §6): bounded MIME decode, archive, de-duplication (C-ING-1), thread (C-ING-3), directory
// snapshot (C-LNK-0), metadata signals (C-SIG-1 1–6, 9), Case, cursor — one transaction under a global serial lock.
import { createHash, randomUUID } from 'node:crypto'
import type { Config } from '../config/load.ts'
import type { Keyring } from '../store/crypto.ts'
import { tx, type Db, type Tx } from '../store/db.ts'
import { putBlob, putJson } from '../store/blobs.ts'
import { appendAudit } from '../store/audit.ts'
import { lockObjectKey, objectKey, writeWithIntent, type FileStore } from '../store/files.ts'
import { emailHmac, loadSnapshot, takeSnapshot } from '../store/directory.ts'
import { decodeMime, type DecodedMessage } from '../ingest/mime.ts'
import { parseAddressList, parseSender } from '../lib/address.ts'
import {
  authSignals, displayNameMismatch, domainOf, firstTimeSender, lookalikeDomain, normAddress, replyToMismatch, type Contact,
} from '../lib/signals.ts'
import type { Queue } from './queue.ts'

const INGEST_LOCK = 7_340_002

export interface MailboxInfo {
  id: string
  trustedAuthResults: boolean // adapter capability (never for .eml)
  trustedAuthservId: string
}

export interface IngestDeps {
  db: Db
  k: Keyring
  files: FileStore
  config: Config
  queue: Queue
}

export type IngestResult = { status: 'created'; caseId: string; messageId: string } | { status: 'duplicate'; messageId: string }

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
/** A UUID (version 8 layout) from a hex digest: stable for the same input. */
const idFrom = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${(8 + (Number.parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`

/** The raw message without its Message-ID header line(s) (C-ING-1). */
export function withoutMessageId(raw: Buffer): Buffer {
  const s = raw.toString('latin1')
  const end = (() => {
    const a = s.indexOf('\r\n\r\n')
    const b = s.indexOf('\n\n')
    return a < 0 ? b : b < 0 ? a : Math.min(a, b)
  })()
  const head = end < 0 ? s : s.slice(0, end)
  const rest = end < 0 ? '' : s.slice(end)
  const lines = head.split(/(?<=\n)/)
  const out: string[] = []
  let skipping = false
  for (const l of lines) {
    if (/^[ \t]/.test(l) && skipping) continue // folded continuation of Message-ID
    skipping = /^message-id\s*:/i.test(l)
    if (!skipping) out.push(l)
  }
  return Buffer.from(out.join('') + rest, 'latin1')
}

const headerValue = (m: DecodedMessage, name: string) => m.headers.find(([n]) => n.toLowerCase() === name)?.[1]
const rawHeaderValue = (m: DecodedMessage, name: string) => m.rawHeaders.find(([n]) => n.toLowerCase() === name)?.[1]
const headerValues = (m: DecodedMessage, name: string) => m.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v)

export const msgIdNorm = (v: string) => v.trim().replace(/^<|>$/g, '').trim().toLowerCase()

/** Ingest one raw message. Idempotent: the same message again is a recorded duplicate, never a second Case. */
export async function ingestMessage(
  deps: IngestDeps,
  mailbox: MailboxInfo,
  raw: Buffer,
  serverReceivedAt: string,
  cursor?: { value: string; folderKey?: string },
): Promise<IngestResult> {
  const { db, k, files, config } = deps
  const decoded = decodeMime(raw, { maxAttachmentBytes: config.attachments.max_attachment_bytes, maxTotalBytes: config.attachments.max_total_bytes })
  const rawSha = sha256(raw)
  const sansSha = sha256(withoutMessageId(raw))
  const msgIdHeader = headerValue(decoded, 'message-id')
  const msgId = msgIdHeader ? msgIdNorm(msgIdHeader) : null
  const dedupeHmac = k.hmac(`dedupe\0${mailbox.id}\0${msgId !== null && msgId !== '' ? `id:${msgId}` : `sha:${rawSha}`}`)

  const existing = async (c: Pick<Tx, 'query'>) =>
    (await c.query<{ id: string; raw_sans_msgid_sha256: string }>('SELECT id, raw_sans_msgid_sha256 FROM message WHERE mailbox_id = $1 AND dedupe_key_hmac = $2', [mailbox.id, dedupeHmac])).rows

  // A duplicate needs no files: answer before writing anything.
  const pre = (await existing(db)).find((r) => r.raw_sans_msgid_sha256 === sansSha)
  if (pre) {
    await tx(db, async (c) => {
      if (cursor) await advanceCursor(c, k, mailbox.id, cursor.value, cursor.folderKey ?? '')
      await appendAudit(c, k, [{ actor: 'system', type: 'ingest.duplicate', payload: { mailbox: mailbox.id, dedupe_key_hmac: dedupeHmac, raw_sha256: rawSha } }])
    })
    return { status: 'duplicate', messageId: pre.id }
  }

  // Files first (each under a write intent), then one transaction records them. Ids are derived from the message, so a
  // retry after a crash writes the same object keys again (tech design §4 file_write_intent).
  const messageId = idFrom(k.hmac(`message\0${mailbox.id}\0${dedupeHmac}\0${sansSha}`))
  const intents: string[] = []
  const rawKey = objectKey(k, messageId, rawSha)
  intents.push(await writeWithIntent(db, files, rawKey, 'original', raw))
  const atts = decoded.attachments.map((a) => ({ ...a, id: idFrom(k.hmac(`attachment\0${messageId}\0${a.ordinal}`)) }))
  const written = new Map<string, Buffer>([[rawKey, raw]])
  for (const a of atts) {
    if (!a.content || !a.sha256) continue
    const key = objectKey(k, a.id, a.sha256)
    written.set(key, a.content)
    intents.push(await writeWithIntent(db, files, key, 'attachment', a.content))
  }

  const result = await tx(db, async (c): Promise<IngestResult> => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK])
    const prior = await existing(c)
    const same = prior.find((r) => r.raw_sans_msgid_sha256 === sansSha)
    if (same) {
      // a concurrent copy of this message was recorded first; the objects we wrote have the same keys as its own. If
      // nothing refers to one (its KYC original or attachment was deleted meanwhile), ours must not bring it back
      // (Codex E4 F5): removed now, under the object lock retention, KYC deletion and rotation also take
      for (const key of [...written.keys()].sort()) {
        await lockObjectKey(c, key)
        const used = await c.query('SELECT 1 FROM message_file WHERE file_ref = $1 UNION ALL SELECT 1 FROM attachment WHERE file_ref = $1', [key])
        if (!used.rowCount) await files.deleteAllVersions(key)
      }
      if (cursor) await advanceCursor(c, k, mailbox.id, cursor.value, cursor.folderKey ?? '')
      await appendAudit(c, k, [{ actor: 'system', type: 'ingest.duplicate', payload: { mailbox: mailbox.id, dedupe_key_hmac: dedupeHmac, raw_sha256: rawSha } }])
      return { status: 'duplicate', messageId: same.id }
    }
    const collision = prior.length > 0
    // hold every object key we are about to record; if an orphan cleanup removed one meanwhile, write it again (CC-F1)
    for (const key of [...written.keys()].sort()) {
      await lockObjectKey(c, key)
      if (!(await files.exists(key))) await files.put(key, written.get(key)!)
    }

    // the sender from the raw header (an encoded word can never become the address); ambiguous → unknown, flagged
    const sender = parseSender(rawHeaderValue(decoded, 'from'))
    const from = sender.ok ? sender.mailbox : null
    const fromAddr = from ? normAddress(from.address) : null
    const fromHmac = fromAddr ? emailHmac(k, fromAddr) : null

    // directory snapshot and the contacts it holds
    const snapshotId = await takeSnapshot(c)
    const dir = await loadSnapshot(c, k, snapshotId)
    const contacts: Contact[] = dir.contacts.map((p) => ({ contactId: p.contactId, name: p.name, emails: p.emails }))
    const inDirectory = fromAddr !== null && contacts.some((p) => p.emails.some((e) => normAddress(e) === fromAddr))
    const seenBefore = fromHmac !== null && (await c.query('SELECT 1 FROM message WHERE from_addr_hmac = $1 LIMIT 1', [fromHmac])).rowCount! > 0

    // metadata signals (C-SIG-1 1–6, 9), frozen now
    const auth = authSignals({ headers: decoded.headers, trustedAuthResults: mailbox.trustedAuthResults, trustedAuthservId: mailbox.trustedAuthservId })
    // C-SIG-1.5 (v0.7.15): several Reply-To headers (RFC 5322 allows one) are unparseable — unknown signal, From only
    const replyToHeaders = decoded.rawHeaders.filter(([n]) => n.toLowerCase() === 'reply-to').length
    const replyToParsed = replyToHeaders > 1 ? null : parseAddressList(rawHeaderValue(decoded, 'reply-to'))
    const replyTo = replyToParsed ?? []
    const signals: Record<string, boolean | null> = {
      auth_fail: auth.auth === 'unknown' ? null : auth.authFail,
      untrusted_auth_header: auth.untrustedAuthHeader,
      // without a parseable sender these are unknown (null), never a reassuring false; the Case is flagged
      display_name_mismatch: from ? displayNameMismatch(from.name, from.address, contacts) : null,
      lookalike_domain: fromAddr ? lookalikeDomain(domainOf(fromAddr), contacts.flatMap((p) => p.emails.map(domainOf))) : null,
      reply_to_mismatch: fromAddr && replyToParsed ? replyToMismatch(replyTo, fromAddr) : null,
      first_time_sender: fromAddr ? firstTimeSender(seenBefore, inDirectory) : null,
      message_id_collision: collision,
      // C-SIG-3's authentication half, frozen with the signals: the adopted result has dmarc=pass and nothing failed.
      // «已认证的发件人» adds the unique contact match from the Case's snapshot (link step)
      dmarc_pass: auth.auth !== 'unknown' && !auth.authFail && auth.dmarcPass,
    }
    const signalInput = sha256(JSON.stringify([decoded.headers, snapshotId, seenBefore]))

    // thread (C-ING-3)
    const refs = [...headerValues(decoded, 'in-reply-to'), ...headerValues(decoded, 'references')].flatMap((v) => v.match(/<[^>]+>/g) ?? []).map(msgIdNorm)
    let threadId: string = randomUUID()
    let previousCase: string | null = null
    if (refs.length) {
      const t = await c.query<{ thread_id: string }>('SELECT thread_id FROM message WHERE message_id_hmac = ANY($1::text[]) ORDER BY observed_seq DESC LIMIT 1', [refs.map((r) => k.hmac(`msgid\0${r}`))])
      if (t.rows[0]) {
        threadId = t.rows[0].thread_id
        previousCase = (await c.query<{ id: string }>('SELECT c.id FROM "case" c JOIN message m ON m.id = c.message_id WHERE m.thread_id = $1 ORDER BY m.observed_seq DESC LIMIT 1', [threadId])).rows[0]?.id ?? null
      }
    }

    const seq = Number((await c.query<{ n: number }>('SELECT coalesce(max(observed_seq), 0)::bigint + 1 AS n FROM message')).rows[0]!.n)
    const headerBlob = await putJson(c, k, {
      from: from?.address ?? null, from_name: from?.name ?? null, reply_to: replyTo, to: headerValue(decoded, 'to') ?? null, cc: headerValue(decoded, 'cc') ?? null,
      subject: headerValue(decoded, 'subject') ?? null, date: headerValue(decoded, 'date') ?? null, message_id: msgIdHeader ?? null,
    })
    await c.query(
      `INSERT INTO message (id, mailbox_id, dedupe_key_hmac, received_at, observed_seq, from_addr_hmac, message_id_hmac, header_blob, thread_id, raw_sha256, raw_sans_msgid_sha256, collision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [messageId, mailbox.id, dedupeHmac, serverReceivedAt, seq, fromHmac, msgId ? k.hmac(`msgid\0${msgId}`) : null, headerBlob, threadId, rawSha, sansSha, collision],
    )
    await c.query('INSERT INTO message_file (id, message_id, kind, sha256, file_ref) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), messageId, 'original', rawSha, rawKey])

    const flags: string[] = []
    if (!sender.ok || replyToParsed === null) flags.push('sender_unparseable')
    if (decoded.failure) flags.push('mime_parse_failed')
    for (const a of atts) {
      if (a.overLimit) flags.push('attachment_over_limit')
      await c.query(
        `INSERT INTO attachment (id, message_id, parent_id, ordinal, depth, name_blob, kind, size, sha256, file_ref, scan_status, parse_status)
         VALUES ($1, $2, NULL, $3, 1, $4, $5, $6, $7, $8, $9, $10)`,
        [a.id, messageId, a.ordinal, await putBlob(c, k, a.filename), a.kind, a.size, a.sha256 ?? '', a.content && a.sha256 ? objectKey(k, a.id, a.sha256) : null,
          a.overLimit ? 'skipped' : 'pending', a.overLimit ? 'over_limit' : 'pending'],
      )
    }

    const caseId = randomUUID()
    await c.query('INSERT INTO "case" (id, message_id, previous_case_id, status, flags, snapshot_id) VALUES ($1, $2, $3, $4, $5, $6)', [
      caseId, messageId, previousCase, 'processing', [...new Set(flags)], snapshotId,
    ])
    for (const [signal, value] of Object.entries(signals)) {
      await c.query('INSERT INTO case_signal (case_id, signal, value, batch, input_sha256) VALUES ($1, $2, $3, $4, $5)', [caseId, signal, value, 'metadata', signalInput])
    }
    if (cursor) await advanceCursor(c, k, mailbox.id, cursor.value, cursor.folderKey ?? '')
    await c.query('DELETE FROM file_write_intent WHERE id = ANY($1::uuid[])', [intents])
    await appendAudit(c, k, [
      {
        actor: 'system', type: 'ingest.received', caseId,
        payload: { mailbox: mailbox.id, message_id: messageId, dedupe_key_hmac: dedupeHmac, raw_sha256: rawSha, raw_sans_msgid_sha256: sansSha, attachments: atts.length,
          mime_failure: decoded.failure, snapshot_id: snapshotId },
      },
      ...(collision ? [{ actor: 'system', type: 'ingest.message_id_collision', caseId, payload: { earlier_sha256: prior.map((p) => p.raw_sans_msgid_sha256), this_sha256: sansSha } }] : []),
      { actor: 'system', type: 'signals.metadata', caseId, payload: { ...signals, input_sha256: signalInput } },
    ])
    await deps.queue.send(c, 'scan', { caseId, generation: 1 })
    return { status: 'created', caseId, messageId }
  })
  if (result.status === 'duplicate') {
    // a concurrent copy won. Intents go only for keys a record refers to (the winner's, when the content is the same);
    // an object only we wrote keeps its intent, so the hourly cleanup removes it (Codex F8)
    await db.query(
      `DELETE FROM file_write_intent i WHERE i.id = ANY($1::uuid[])
         AND (EXISTS (SELECT 1 FROM message_file f WHERE f.file_ref = i.object_key) OR EXISTS (SELECT 1 FROM attachment a WHERE a.file_ref = i.object_key))`,
      [intents],
    )
  }
  return result
}

/** C-ING-5: the cursor moves only in the transaction that records the message (or its gap). */
export async function advanceCursor(c: Tx, k: Keyring, mailboxId: string, value: string, folderKey = ''): Promise<void> {
  const blob = await putBlob(c, k, value)
  // one cursor per configured folder (Graph, PRD C-ING-6); IMAP and Gmail use folder_key ''
  await c.query(
    `INSERT INTO mailbox_cursor (mailbox_id, folder_key, cursor_blob, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (mailbox_id, folder_key) DO UPDATE SET cursor_blob = excluded.cursor_blob, updated_at = now()`,
    [mailboxId, folderKey, blob],
  )
}

export async function ensureMailboxes(db: Db, k: Keyring, config: Config): Promise<void> {
  await tx(db, async (c) => {
    for (const m of config.mailboxes) {
      const r = await c.query('SELECT 1 FROM mailbox WHERE id = $1', [m.id])
      if (!r.rowCount) await c.query('INSERT INTO mailbox (id, name_blob, kind) VALUES ($1, $2, $3)', [m.id, await putBlob(c, k, m.name), m.kind])
    }
  })
}
