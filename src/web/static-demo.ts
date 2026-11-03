// The static read-only demo (PRD R-DEMO-02, tech design v0.7.11; site interface T1–T4): built with STATIC_DEMO=1, the
// review UI reads the snapshot that `data/snapshot.js` puts on globalThis (loaded by a classic <script src> before the
// app, so the site's CSP `connect-src 'none'` holds: no fetch, no XHR). The page renders no change control (PRD R-DEMO-02
// v0.7.25); a change that reached the API layer anyway is still refused here, without a request.
export const DEMO_REFUSAL = 'Demo: not available. This is a read-only snapshot of the demo; nothing can be changed here.'
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1'

type Item = Record<string, unknown>
export interface Snapshot {
  info: { version: string; built_at: string }
  session: Item
  meta: Item
  cases: Item[]
  details: Record<string, Item>
}
const snapshot = (): Snapshot => {
  const s = (globalThis as { DOI_DEMO?: Snapshot }).DOI_DEMO
  if (!s) throw new Error('the demo snapshot (data/snapshot.js) is missing')
  return s
}
export const snapshotInfo = (): Snapshot['info'] | null => (globalThis as { DOI_DEMO?: Snapshot }).DOI_DEMO?.info ?? null

/** The answer the API would give, from the snapshot; `null` for a change, which the caller refuses. */
export function staticAnswer(method: string, url: string): { status: number; data: unknown } | null {
  if (method !== 'GET') return null
  const u = new URL(url, 'http://snapshot.invalid')
  const path = u.pathname
  const s = snapshot()
  if (path === '/api/session') return { status: 200, data: s.session }
  if (path === '/api/meta') return { status: 200, data: s.meta }
  if (path === '/api/csrf') return { status: 200, data: { csrf: '' } }
  if (path === '/api/cases') {
    // the server's filters are plain equality on these three (src/server/cases.ts); the order is the server's
    const wanted = (['status', 'queue', 'risk'] as const).map((k) => [k, u.searchParams.get(k)] as const).filter(([, v]) => v)
    return { status: 200, data: { cases: s.cases.filter((c) => wanted.every(([k, v]) => c[k] === v)) } }
  }
  const one = /^\/api\/cases\/([A-Za-z0-9-]+)$/.exec(path)
  if (one && s.details[one[1]!]) return { status: 200, data: s.details[one[1]!] }
  return { status: 404, data: { error: 'not in the demo snapshot' } }
}
