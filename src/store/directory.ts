// Directory versions and snapshots in the database (PRD R-DIR-04, C-LNK-0). Text is encrypted; lookups use HMAC.
import { createHash, randomUUID } from 'node:crypto'
import type { Keyring } from './crypto.ts'
import { tx, type Db, type Tx } from './db.ts'
import { getBlobs, putBlob, putJson, putOptional } from './blobs.ts'
import { appendAudit } from './audit.ts'
import {
  importBank, importCommitments, importContacts, importDeals, importLedger,
  type ImportError,
} from '../lib/directory.ts'
import { normAddress } from '../lib/signals.ts'

export type DirectoryKind = 'deals' | 'contacts' | 'commitments' | 'bank' | 'ledger'

export const dealKey = (k: Keyring, name: string) => k.hmac(`deal\0${name}`)
export const commitmentKeyHmac = (k: Keyring, key: string) => k.hmac(`commitment\0${key}`)
export const emailHmac = (k: Keyring, address: string) => k.hmac(`email\0${normAddress(address)}`)

export type ImportOutcome = { ok: true; versionId: string; rows: number } | { ok: false; errors: ImportError[] }

async function latestDeal(c: Pick<Tx, 'query'>, k: Keyring, name: string): Promise<{ currency: string } | null> {
  const r = await c.query<{ currency: string }>(
    `SELECT d.currency FROM deal d WHERE d.deal_key = $1 AND d.directory_version = (
       SELECT id FROM directory_version WHERE kind = 'deals' ORDER BY imported_at DESC, id DESC LIMIT 1)`,
    [dealKey(k, name)],
  )
  return r.rows[0] ?? null
}

/** Import one CSV as a new directory version (R-DIR-04). `deal` names the deal for per-deal kinds. */
export async function importDirectory(
  db: Db,
  k: Keyring,
  o: { kind: DirectoryKind; csv: string; userId: string; deal?: string; currencies: readonly string[] },
): Promise<ImportOutcome> {
  return tx(db, async (c) => {
    const versionId = randomUUID()
    const tag = versionId.slice(0, 8)
    const fileSha = createHash('sha256').update(o.csv).digest('hex')
    let currency: string | null = null
    let dKey: string | null = null
    if (o.kind === 'commitments' || o.kind === 'bank' || o.kind === 'ledger') {
      if (!o.deal) return { ok: false, errors: [{ where: 'deal', message: 'choose the deal this file belongs to' }] }
      const d = await latestDeal(c, k, o.deal)
      if (!d) return { ok: false, errors: [{ where: 'deal', message: 'unknown deal (import the deals list first)' }] }
      currency = d.currency
      dKey = dealKey(k, o.deal)
    }
    const insertVersion = () =>
      c.query('INSERT INTO directory_version (id, kind, deal_key, imported_by, file_sha256) VALUES ($1, $2, $3, $4, $5)', [versionId, o.kind, dKey, o.userId, fileSha])
    let count = 0
    switch (o.kind) {
      case 'deals': {
        const r = importDeals(o.csv, o.currencies)
        if (!r.ok) return r
        await insertVersion()
        for (const d of r.rows) {
          await c.query('INSERT INTO deal (id, directory_version, deal_key, name_blob, currency, close_date, reference_prefix_blob, row_no) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
            randomUUID(), versionId, dealKey(k, d.name), await putBlob(c, k, d.name), d.currency, d.closeDate, await putOptional(c, k, d.referencePrefix), d.row,
          ])
        }
        count = r.rows.length
        break
      }
      case 'commitments': {
        const r = importCommitments(o.csv, currency!, tag)
        if (!r.ok) return r
        await insertVersion()
        for (const m of r.rows) {
          await c.query(
            `INSERT INTO commitment (id, directory_version, deal_key, commitment_key_hmac, investor_id_blob, name_blob, email_blob, reference_blob, cash_due_minor, scheme_blob, row_no)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [randomUUID(), versionId, dKey, commitmentKeyHmac(k, `${o.deal}::${m.investorId}`), await putBlob(c, k, m.investorId), await putBlob(c, k, m.name),
              await putOptional(c, k, m.email), await putBlob(c, k, m.reference), m.cashDue, await putBlob(c, k, m.scheme), m.row],
          )
        }
        count = r.rows.length
        break
      }
      case 'bank': {
        const r = importBank(o.csv, currency!, tag)
        if (!r.ok) return r
        await insertVersion()
        for (const b of r.rows) {
          await c.query('INSERT INTO bank_line (id, directory_version, deal_key, txn_id_blob, value_date, amount_minor, payer_blob, reference_blob, row_no) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
            randomUUID(), versionId, dKey, await putBlob(c, k, b.txnId), b.date, b.amount, await putOptional(c, k, b.payer), await putOptional(c, k, b.reference), b.row,
          ])
        }
        count = r.rows.length
        break
      }
      case 'ledger': {
        const r = importLedger(o.csv, currency!)
        if (!r.ok) return r
        await insertVersion()
        for (const l of r.rows) {
          await c.query(
            `INSERT INTO ledger_line (id, directory_version, deal_key, txn_id_blob, value_date, amount_minor, payer_blob, reference_blob, status, commitment_key_hmac,
               investor_name_blob, decided_by_blob, withdrawn_on, currency, row_no) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [randomUUID(), versionId, dKey, await putOptional(c, k, l.txnId), l.date, l.amount, await putOptional(c, k, l.payer), await putOptional(c, k, l.reference), l.status,
              l.investorId ? commitmentKeyHmac(k, `${o.deal}::${l.investorId}`) : null, await putOptional(c, k, l.investorName), await putOptional(c, k, l.decidedBy), l.withdrawnOn, l.currency, l.row],
          )
        }
        count = r.rows.length
        break
      }
      case 'contacts': {
        const r = importContacts(o.csv, tag)
        if (!r.ok) return r
        await insertVersion()
        for (const p of r.rows) {
          const id = randomUUID()
          await c.query(
            `INSERT INTO contact (id, directory_version, contact_key_hmac, contact_id_blob, name_blob, emails_blob, phone_blob, role, deals_blob, investor_ids_blob, authorised_for_blob, row_no)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [id, versionId, k.hmac(`contact\0${p.contactId}`), await putBlob(c, k, p.contactId), await putBlob(c, k, p.name), await putJson(c, k, p.emails), await putOptional(c, k, p.phone), p.role,
              await putJson(c, k, p.deals), await putJson(c, k, p.investorIds), await putJson(c, k, p.authorisedFor), p.row],
          )
          for (const e of new Set(p.emails)) await c.query('INSERT INTO contact_email (contact, email_hmac) VALUES ($1, $2)', [id, emailHmac(k, e)])
        }
        count = r.rows.length
        break
      }
    }
    await appendAudit(c, k, [{ actor: o.userId, type: 'directory.imported', payload: { kind: o.kind, version_id: versionId, deal_key: dKey, file_sha256: fileSha, rows: count } }])
    return { ok: true, versionId, rows: count }
  })
}

/** C-LNK-0: snapshot of the latest versions: deals, contacts, and per deal its commitments, bank lines and ledger. */
export async function takeSnapshot(c: Pick<Tx, 'query'>): Promise<string> {
  const latest = async (kind: string, dk: string | null) =>
    (await c.query<{ id: string }>(
      `SELECT id FROM directory_version WHERE kind = $1 AND deal_key IS NOT DISTINCT FROM $2 ORDER BY imported_at DESC, id DESC LIMIT 1`,
      [kind, dk],
    )).rows[0]?.id ?? null
  const deals = await latest('deals', null)
  const contacts = await latest('contacts', null)
  const perDeal: Record<string, { commitment: string | null; bank: string | null; ledger: string | null }> = {}
  if (deals) {
    const keys = await c.query<{ deal_key: string }>('SELECT deal_key FROM deal WHERE directory_version = $1 ORDER BY row_no', [deals])
    for (const { deal_key } of keys.rows) {
      perDeal[deal_key] = { commitment: await latest('commitments', deal_key), bank: await latest('bank', deal_key), ledger: await latest('ledger', deal_key) }
    }
  }
  const id = randomUUID()
  await c.query('INSERT INTO directory_snapshot (id, deals_version, contacts_version, per_deal) VALUES ($1, $2, $3, $4)', [id, deals, contacts, JSON.stringify(perDeal)])
  return id
}

export interface SnapshotView {
  deals: Array<{ dealKey: string; name: string; currency: string; closeDate: string | null }>
  contacts: Array<{ contactId: string; name: string; emails: string[]; phone: string | null; role: string; deals: string[]; investorIds: string[]; authorisedFor: string[] }>
  commitments: Array<{ dealKey: string; investorId: string; keyHmac: string; name: string; reference: string; cashDue: number }>
  bankLines: Array<{ dealKey: string; transactionId: string; date: string; amount: number; payer: string | null; reference: string | null }>
  ledger: Array<{ dealKey: string; transactionId: string | null; status: string; commitmentKeyHmac: string | null; currency: string; amount: number }>
  ledgerDeals: string[] // deal keys whose ledger is in the snapshot (C-DRF-6: none → unknown)
}

/** Decrypted directory content of a snapshot (for rules in src/lib). */
export async function loadSnapshot(c: Pick<Tx, 'query'>, k: Keyring, snapshotId: string): Promise<SnapshotView> {
  const s = (await c.query<{ deals_version: string | null; contacts_version: string | null; per_deal: Record<string, { commitment: string | null; bank?: string | null; ledger?: string | null }> }>(
    'SELECT deals_version, contacts_version, per_deal FROM directory_snapshot WHERE id = $1',
    [snapshotId],
  )).rows[0]
  if (!s) throw new Error(`snapshot ${snapshotId} not found`)
  const deals = s.deals_version ? (await c.query('SELECT deal_key, name_blob, currency, close_date FROM deal WHERE directory_version = $1 ORDER BY row_no', [s.deals_version])).rows : []
  const contacts = s.contacts_version
    ? (await c.query('SELECT contact_id_blob, name_blob, emails_blob, phone_blob, role, deals_blob, investor_ids_blob, authorised_for_blob FROM contact WHERE directory_version = $1 ORDER BY row_no', [s.contacts_version])).rows
    : []
  const cVersions = Object.values(s.per_deal).map((v) => v.commitment).filter((v): v is string => !!v)
  const commitments = cVersions.length
    ? (await c.query('SELECT deal_key, investor_id_blob, commitment_key_hmac, name_blob, reference_blob, cash_due_minor FROM commitment WHERE directory_version = ANY($1::uuid[]) ORDER BY row_no', [cVersions])).rows
    : []
  const bVersions = Object.values(s.per_deal).map((v) => v.bank).filter((v): v is string => !!v)
  const bank = bVersions.length
    ? (await c.query('SELECT deal_key, txn_id_blob, value_date, amount_minor, payer_blob, reference_blob FROM bank_line WHERE directory_version = ANY($1::uuid[]) ORDER BY directory_version, row_no', [bVersions])).rows
    : []
  const lVersions = Object.values(s.per_deal).map((v) => v.ledger).filter((v): v is string => !!v)
  const ledger = lVersions.length
    ? (await c.query('SELECT deal_key, txn_id_blob, status, commitment_key_hmac, currency, amount_minor FROM ledger_line WHERE directory_version = ANY($1::uuid[]) ORDER BY directory_version, row_no', [lVersions])).rows
    : []
  const ids = [
    ...deals.map((d) => d.name_blob),
    ...contacts.flatMap((p) => [p.contact_id_blob, p.name_blob, p.emails_blob, p.phone_blob, p.deals_blob, p.investor_ids_blob, p.authorised_for_blob]),
    ...commitments.flatMap((m) => [m.investor_id_blob, m.name_blob, m.reference_blob]),
    ...bank.flatMap((l) => [l.txn_id_blob, l.payer_blob, l.reference_blob]),
    ...ledger.map((l) => l.txn_id_blob),
  ].filter(Boolean) as string[]
  const b = await getBlobs(c, k, ids)
  const t = (id: string | null) => (id ? b.get(id)!.toString('utf8') : null)
  const j = <T>(id: string | null, d: T): T => (id ? (JSON.parse(b.get(id)!.toString('utf8')) as T) : d)
  const iso = (d: Date | string | null) => (d === null ? null : typeof d === 'string' ? d : d.toISOString().slice(0, 10))
  return {
    deals: deals.map((d) => ({ dealKey: d.deal_key, name: t(d.name_blob)!, currency: d.currency, closeDate: iso(d.close_date) })),
    contacts: contacts.map((p) => ({ contactId: t(p.contact_id_blob)!, name: t(p.name_blob)!, emails: j<string[]>(p.emails_blob, []), phone: t(p.phone_blob), role: p.role,
      deals: j<string[]>(p.deals_blob, []), investorIds: j<string[]>(p.investor_ids_blob, []), authorisedFor: j<string[]>(p.authorised_for_blob, []) })),
    commitments: commitments.map((m) => ({ dealKey: m.deal_key, investorId: t(m.investor_id_blob)!, keyHmac: m.commitment_key_hmac, name: t(m.name_blob)!, reference: t(m.reference_blob)!, cashDue: Number(m.cash_due_minor) })),
    bankLines: bank.map((l) => ({ dealKey: l.deal_key, transactionId: t(l.txn_id_blob)!, date: iso(l.value_date)!, amount: Number(l.amount_minor), payer: t(l.payer_blob), reference: t(l.reference_blob) })),
    ledger: ledger.map((l) => ({ dealKey: l.deal_key, transactionId: t(l.txn_id_blob), status: l.status, commitmentKeyHmac: l.commitment_key_hmac, currency: l.currency, amount: Number(l.amount_minor) })),
    ledgerDeals: Object.entries(s.per_deal).filter(([, v]) => !!v.ledger).map(([d]) => d),
  }
}
