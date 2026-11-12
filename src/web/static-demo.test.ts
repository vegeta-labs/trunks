// TC-DEMO-04 (PRD R-DEMO-02; site interface T1, T2): the static demo answers reads from the snapshot, refuses changes.
import { afterEach, describe, expect, it } from 'vitest'
import { staticAnswer } from './static-demo.ts'

const g = globalThis as { TRUNKS_DEMO?: unknown }
afterEach(() => delete g.TRUNKS_DEMO)

describe('static demo answers', () => {
  it('TC-DEMO-04 reads from the snapshot (filters as the server), sample IDs for cases, every change refused', () => {
    g.TRUNKS_DEMO = { info: { version: '0.1.0', built_at: 'x' }, session: { user: { username: 'demo-reviewer' } }, meta: { m: 1 },
      cases: [{ id: 'E0001', risk: 'medium', status: 'open', queue: 'ops' }, { id: 'E0225', risk: 'high', status: 'open', queue: 'compliance' }],
      details: { E0225: { id: 'E0225' } } }
    expect(staticAnswer('GET', '/api/session')).toEqual({ status: 200, data: { user: { username: 'demo-reviewer' } } })
    expect((staticAnswer('GET', '/api/cases?risk=high')!.data as { cases: unknown[] }).cases).toEqual([{ id: 'E0225', risk: 'high', status: 'open', queue: 'compliance' }])
    expect((staticAnswer('GET', '/api/cases')!.data as { cases: unknown[] }).cases.length).toBe(2)
    expect(staticAnswer('GET', '/api/cases/E0225')).toEqual({ status: 200, data: { id: 'E0225' } })
    expect(staticAnswer('GET', '/api/cases/E9999')!.status).toBe(404)
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) expect(staticAnswer(m, '/api/cases/E0225/relink')).toBeNull()
    expect(staticAnswer('POST', '/api/logout')).toBeNull()
  })
  it('TC-REV-14 the snapshot pages like the server and reports the total of the filters', () => {
    g.TRUNKS_DEMO = { info: { version: '0.1.0', built_at: 'x' }, session: {}, meta: {}, details: {}, cases: Array.from({ length: 60 }, (_, i) => ({ id: `E${i}`, risk: i < 55 ? 'high' : 'low' })) }
    const page = (q: string) => staticAnswer('GET', `/api/cases?${q}`)!.data as { cases: Array<{ id: string }>; total: number }
    expect(page('').cases.length).toBe(50)
    expect(page('').total).toBe(60)
    expect(page('limit=50&offset=50').cases.map((c) => c.id)).toEqual(['E50', 'E51', 'E52', 'E53', 'E54', 'E55', 'E56', 'E57', 'E58', 'E59'])
    expect(page('risk=high&limit=50&offset=50')).toMatchObject({ total: 55 })
    expect(page('limit=abc&offset=-1').cases.length).toBe(50)
  })
})
