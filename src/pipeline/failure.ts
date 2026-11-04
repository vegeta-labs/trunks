// Failure reasons (tech design v0.7.15, E6 D2): an error's own text may carry values from an email (a database error's
// `Key (…)=(…)`, a parser message), so logs, the Case row, the API and the job queue only ever see a fixed code. The
// original text goes only to the encrypted audit detail (markFailed).
import pg from 'pg'
import { SetupError, ReplayMissingError } from '../adapters/llm/types.ts'

export const FAILURE_CODES = ['model_setup', 'replay_missing', 'parser_unavailable', 'scanner_unavailable', 'storage_error', 'database_error', 'internal'] as const
export type FailureCode = (typeof FAILURE_CODES)[number]

/** The fixed sentence shown for each code (Case page and API). */
export const FAILURE_TEXT: Record<FailureCode, string> = {
  model_setup: 'The model could not be used: it is not configured, cannot be reached, or rejected the credentials.',
  replay_missing: 'No recorded model reply exists for this request (replay mode).',
  parser_unavailable: 'The attachment parser could not be reached or returned an invalid answer.',
  scanner_unavailable: 'The virus scanner could not be reached or returned an invalid answer.',
  storage_error: 'A stored file could not be read or written.',
  database_error: 'A database error occurred.',
  internal: 'An unexpected error occurred.',
}

/** An error from an adapter boundary, tagged with its code; keeps the original only for the encrypted audit. */
export class TaggedFailure extends Error {
  readonly code: FailureCode
  readonly original: unknown
  constructor(code: FailureCode, original: unknown) {
    super(code)
    this.name = 'TaggedFailure'
    this.code = code
    this.original = original
  }
}

export function failureCode(e: unknown): FailureCode {
  if (e instanceof TaggedFailure) return e.code
  if (e instanceof ReplayMissingError) return 'replay_missing' // a SetupError subclass: checked first
  if (e instanceof SetupError) return 'model_setup'
  if (e instanceof pg.DatabaseError) return 'database_error'
  return 'internal'
}

/** For logs: the code, and for `internal` the error's class name (code-defined, carries no email content). */
export function failureLabel(e: unknown): string {
  const code = failureCode(e)
  if (code !== 'internal') return code
  const name = e instanceof Error ? e.constructor.name : typeof e
  return /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? `internal (${name})` : 'internal'
}

/** The original text of an error for the encrypted audit detail. */
export function originalText(e: unknown): string {
  const o = e instanceof TaggedFailure ? e.original : e
  return String(o)
}

/** What is thrown on to the job queue: the code only, no cause and no other properties (pg-boss serialises errors). */
export function sanitised(e: unknown): Error {
  return new Error(failureCode(e))
}

/** Wrap every method of an adapter so that a rejection becomes a TaggedFailure with the given code. */
export function tagged<T extends object>(target: T, code: FailureCode): T {
  return new Proxy(target, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r)
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        let out: unknown
        try {
          out = v.apply(t, args)
        } catch (e) {
          throw e instanceof TaggedFailure ? e : new TaggedFailure(code, e)
        }
        return out instanceof Promise ? out.catch((e: unknown) => { throw e instanceof TaggedFailure ? e : new TaggedFailure(code, e) }) : out
      }
    },
  })
}
