// Model adapters (tech design §3.2, T6): JSON Schema in, validated JSON out. Two calls only — classification
// (PRD C-CLS-1) and field extraction (C-FLD-0). No adapter sends tools or functions (R-CLS-02, TC-CLS-06).
import type { z } from 'zod'

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface LlmRequest<S extends z.ZodType> {
  system: string
  user: string // redacted text only (PRD R-RED-01)
  schema: S // the zod schema; adapters send its JSON Schema and validate the reply with it again
  promptVersion: string // e.g. classify@v1
  attempt?: number // 1 or 2 (the one retry); recordings are kept per attempt
}

export interface LlmResult<T> {
  raw: string
  parsed: T
  usage: Usage
  model?: string // the model that actually answered (a server-side fallback may answer instead)
}

export interface LlmAdapter {
  id: string // provider/model
  location: 'local' | 'external'
  settings?: Record<string, unknown> // request settings that change the reply; recordings must match them
  complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResult<z.infer<S>>>
}

/** The reply did not validate against the schema, or the provider declined: the caller retries once (R-CLS-01, C-FLD-0). */
export class LlmOutputError extends Error {
  readonly raw: string
  constructor(message: string, raw: string) {
    super(message)
    this.raw = raw
  }
}

/**
 * The request could not be made because of the deployment, not the model: a missing or rejected credential (401 / 403),
 * a model service that refuses the connection (nothing was sent), or no recorded reply (replay). Never a model attempt:
 * the caller does not count or save it and does not fall back; the step fails and can run again once the setup is fixed
 * (verify R1). The evaluation counts such a sample as not processed.
 */
export class SetupError extends Error {}

// connection failures that happen before any byte of the request leaves: only these are setup errors. A connection
// that breaks later may have delivered the request, so it is a counted attempt (Codex E2 round 3 F16)
// a refused or unreachable connection, and a certificate check, which only runs in the handshake (self-review S4)
const UNSENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'])
/** The error code when the request was certainly not sent, else null. Follows `cause` and every error of an AggregateError. */
export function unsentCode(e: unknown, depth = 0): string | null {
  if (!e || typeof e !== 'object' || depth > 5) return null
  const x = e as { code?: unknown; cause?: unknown; errors?: unknown }
  if (typeof x.code === 'string' && UNSENT.has(x.code)) return x.code
  if (Array.isArray(x.errors) && x.errors.length && x.errors.every((y) => unsentCode(y, depth + 1))) return unsentCode(x.errors[0], depth + 1)
  return unsentCode(x.cause, depth + 1)
}
/** No recorded reply for this request, or one made with other request settings. */
export class ReplayMissingError extends SetupError {}

/** Parse and validate a model reply; a reply that is not the schema's JSON is an LlmOutputError. */
export function validated<S extends z.ZodType>(schema: S, raw: string): z.infer<S> {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new LlmOutputError('reply is not JSON', raw)
  }
  const r = schema.safeParse(json)
  if (!r.success) throw new LlmOutputError(`reply does not match the schema: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, raw)
  return r.data
}
