import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKit, type Kit } from './testkit.ts'
import { eml } from '../ingest/testmail.ts'
import { stageResult, type Extraction, type Redaction } from './stages.ts'
import { makePdf } from '../../parser/testfiles.ts'

let k: Kit
beforeAll(async () => {
  k = await createKit()
  await k.importCsv('deals', 'name,currency,close_date\nNorthwind Robotics,GBP,2026-11-02\n')
  await k.importCsv('commitments', 'investor_id,name,email,reference,cash_due\nc01,Amelia Hart,amelia@hartfamily.example,NW-001,"10,000.00"\n', 'Northwind Robotics')
  await k.importCsv('contacts', 'contact_id,name,email,phone,role,deal,investor_id\nC001,Amelia Hart,amelia@hartfamily.example,+44 7700 900123,investor,Northwind Robotics,Northwind Robotics::c01\n')
}, 60_000)
afterAll(async () => k?.close())

describe('pipeline E1 (ingest → redact)', () => {
  it('a payment mail with a PDF goes through every stage', async () => {
    const r = await k.ingest(eml({
      subject: 'Paid NW-001',
      text: 'Hi, I paid £10,000.00 on 23 Oct 2026, ref nw 001. UETR eb6305c9-1f7f-49de-aed0-16487c27b42d. Old account GB82 WEST 1234 5698 7654 32.',
      attachments: [{ type: 'application/pdf', filename: 'confirmation.pdf', content: makePdf([':32A:261023GBP10000,00']) }],
    }))
    expect(r.status).toBe('created')
    await k.drain()
    const id = (r as { caseId: string }).caseId
    const c = (await k.db.query('SELECT status, pipeline_complete_generation, flags FROM "case" WHERE id = $1', [id])).rows[0]
    expect(c).toEqual({ status: 'open', pipeline_complete_generation: 1, flags: [] })
    const ex = (await stageResult<Extraction>(k.db, k.k, id, 'extract'))!
    expect(ex.uetrs.map((u) => u.value)).toEqual(['eb6305c9-1f7f-49de-aed0-16487c27b42d'])
    expect(ex.amounts.map((a) => [a.minor, a.currency, a.at.part])).toEqual([[1000000, 'GBP', 'body']])
    expect(ex.references.map((x) => x.value)).toEqual(['NW-001'])
    expect(ex.accounts.map((a) => a.last4)).toEqual(['5432'])
    expect(ex.evidence).toMatchObject([{ source: 'mt103', part: 'attachment_text:0', minor: 1000000, currency: 'GBP', valueDate: '2026-10-23', uetr: null }])
    const red = (await stageResult<Redaction>(k.db, k.k, id, 'redact'))!
    expect(red.body).toContain('[ACCOUNT_1]')
    expect(red.body).not.toContain('GB82')
    expect(red.fromName).toBe('[NAME_1] [NAME_2]')
    const sig = Object.fromEntries((await k.db.query('SELECT signal, value FROM case_signal WHERE case_id = $1', [id])).rows.map((s) => [s.signal, s.value]))
    expect(sig).toMatchObject({ auth_fail: null, first_time_sender: false, display_name_mismatch: false, hidden_text: false, injection_markers: false })
  }, 60_000)

  it('TC-EXT-11 every persisted value points at its source text (Codex F14)', async () => {
    const body = 'Paid £1\u200B0,000.00 on 23 Oct 2026, ref NW-001, UETR eb6305c9-1f7f-49de-aed0-16487c27b42d.'
    const r = await k.ingest(eml({ text: body, attachments: [{ type: 'application/pdf', filename: 'c.pdf', content: makePdf([':32A:261023GBP10000,00']) }] }))
    await k.drain()
    const ex = (await stageResult<Extraction>(k.db, k.k, (r as { caseId: string }).caseId, 'extract'))!
    const at = (p: { part: string; originalStart: number; originalEnd: number }) => (p.part === 'body' ? body.slice(p.originalStart, p.originalEnd) : null)
    expect(at(ex.amounts[0]!.at)).toBe('£1\u200B0,000.00')
    expect(at(ex.references[0]!.at[0]!)).toBe('NW-001')
    expect(at(ex.uetrs[0]!.at[0]!)).toBe('eb6305c9-1f7f-49de-aed0-16487c27b42d')
    expect(at(ex.dates[0]!.at)).toBe('23 Oct 2026')
    expect(ex.evidence[0]!.at).toMatchObject({ part: 'attachment_text:0' })
    expect(ex.evidence[0]!.at!.end - ex.evidence[0]!.at!.start).toBe(':32A:261023GBP10000,00'.length)
  }, 60_000)

  it('TC-EXT-11 pacs.008 values point at their element text, nested messages included (Codex F14)', async () => {
    const U = 'eb6305c9-1f7f-49de-aed0-16487c27b42d'
    const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><FIToFICstmrCdtTrf><GrpHdr><IntrBkSttlmDt>2026-10-20</IntrBkSttlmDt></GrpHdr><CdtTrfTxInf><PmtId><UETR>${U}</UETR></PmtId><IntrBkSttlmAmt Ccy="GBP">10000.00</IntrBkSttlmAmt></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>`
    const inner = eml({ subject: 'Fwd', text: 'Ｓee attached', attachments: [{ type: 'application/xml', filename: 'p.xml', content: Buffer.from(xml) }] })
    const r = await k.ingest(eml({ text: 'Payment files', attachments: [
      { type: 'application/xml', filename: 'pacs.xml', content: Buffer.from(xml) },
      { type: 'message/rfc822', filename: 'fwd.eml', content: inner },
    ] }))
    await k.drain()
    const caseId = (r as { caseId: string }).caseId
    const ex = (await stageResult<Extraction>(k.db, k.k, caseId, 'extract'))!
    const { loadMessage } = await import('./stages.ts')
    const m = await loadMessage(k, (await k.db.query('SELECT message_id FROM "case" WHERE id = $1', [caseId])).rows[0].message_id)
    const pacsEv = ex.evidence.filter((e) => e.source === 'pacs008')
    expect(pacsEv).toHaveLength(2)
    for (const e of pacsEv) {
      expect(e).toMatchObject({ minor: 1000000, currency: 'GBP', valueDate: '2026-10-20', uetr: U })
      const text = m.attachments.find((a) => `attachment_text:${a.ordinal}` === e.part)!.text
      const cut = (p: { originalStart: number; originalEnd: number } | null | undefined) => (p ? text.slice(p.originalStart, p.originalEnd) : null)
      expect([cut(e.at), cut(e.fields!.amount), cut(e.fields!.valueDate), cut(e.fields!.uetr)]).toEqual(['10000.00', '10000.00', '2026-10-20', U])
    }
  }, 60_000)
})
