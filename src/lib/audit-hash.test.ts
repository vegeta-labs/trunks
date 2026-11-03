import { describe, expect, it } from 'vitest'
import { auditHash, GENESIS, jcs, verifyChain, type AuditRecord } from './audit-hash.ts'

export function chain(n: number): AuditRecord[] {
  const out: AuditRecord[] = []
  let prev = GENESIS
  for (let i = 1; i <= n; i++) {
    const r = { seq: i, time: `2026-10-29T10:00:${String(i % 60).padStart(2, '0')}.000Z`, actor: 'system', type: 'ingest.received', case_id: `c${i}`, payload: { n: i, ok: true, list: [1, 'b'] }, prev_hash: prev }
    const hash = auditHash(r)
    out.push({ ...r, hash })
    prev = hash
  }
  return out
}

describe('C-AUD-1 hash chain (pure part)', () => {
  it('TC-AUD-01 1,000 records verify; a changed payload is reported by seq', () => {
    const c = chain(1000)
    expect(verifyChain(c)).toEqual({ ok: true })
    const bad = c.map((r) => (r.seq === 417 ? { ...r, payload: { ...r.payload, n: 0 } } : r))
    expect(verifyChain(bad)).toEqual({ ok: false, badSeq: 417 })
    expect(verifyChain(c.filter((r) => r.seq !== 10))).toEqual({ ok: false, badSeq: 11 })
  })
  it('RFC 8785 canonical form', () => {
    expect(jcs({ b: 1, a: [true, null, 'x'], c: { z: 1.5, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":1.5}}')
    // keys sort by UTF-16 code units
    expect(jcs({ '€': 1, '\r': 2, '😀': 3, 'é': 4 })).toBe('{"\\r":2,"é":4,"€":1,"😀":3}')
    expect(jcs({ s: ' \u0007"\\' })).toBe('{"s":" \\u0007\\"\\\\"}')
    expect(jcs([1e21, 1e-7, 0.1])).toBe('[1e+21,1e-7,0.1]')
  })
})
