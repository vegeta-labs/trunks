import { DEMO_REFUSAL, STATIC_DEMO, staticAnswer } from './static-demo.ts'
import { plainProblems } from './presentation.ts'

// API client. The CSRF token is kept in sessionStorage so a page reload keeps working (tech design §5).
const CSRF = 'doi.csrf'

export const csrf = {
  // the static demo has no session and keeps nothing in the browser (site interface T4)
  get: () => {
    if (STATIC_DEMO) return ''
    try {
      return sessionStorage.getItem(CSRF) ?? ''
    } catch {
      return ''
    }
  },
  set: (v: string) => {
    if (STATIC_DEMO) return
    try {
      sessionStorage.setItem(CSRF, v)
    } catch {
      /* private mode: the token lives until the page closes */
    }
  },
}

/** D8: rule ids such as «(C-RSK-3)» stay in the server's answer and the audit; people see the plain sentence. */
export const withoutRuleIds = (text: string) => text.replace(/\s*\((?:[CRI]-[A-Z]+-\d+[a-z]?|I-\d+)\b[^()]*\)/g, '').trim()

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (STATIC_DEMO) {
    // the static demo snapshot (PRD R-DEMO-02): reads only, and no request at all, not even for a change
    const a = staticAnswer(method, url)
    if (!a) throw new ApiError(403, DEMO_REFUSAL)
    if (a.status >= 400) throw new ApiError(a.status, (a.data as { error?: string }).error ?? 'not found')
    return a.data as T
  }
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-csrf-token': csrf.get() }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, plainProblems(withoutRuleIds(data.error ?? res.statusText)))
  return data as T
}

export interface SessionUser {
  id: string
  username: string
  role: 'reviewer' | 'approver' | 'admin'
  mustChangePassword: boolean
}
