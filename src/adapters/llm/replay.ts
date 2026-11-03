// Replay adapter (tech design §3.2): recorded replies keyed by prompt version + model ID + input hash + attempt. A
// missing recording, or one made with other request settings, is an error; no real model is called. `Recorder` wraps a real adapter and writes the recordings.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { LlmOutputError, ReplayMissingError, validated, type LlmAdapter, type LlmRequest, type LlmResult } from './types.ts'

/** Stable key of one request: the prompt, the input and the schema the reply must satisfy. */
export function inputSha(req: LlmRequest<z.ZodType>): string {
  return createHash('sha256').update(JSON.stringify([req.system, req.user, z.toJSONSchema(req.schema)])).digest('hex')
}

// attempt 1 keeps the plain name; the retry has its own recording, so a retry reaches the real model when recording
const fileOf = (dir: string, modelId: string, req: LlmRequest<z.ZodType>) =>
  join(dir, req.promptVersion.replace(/[^\w.@-]/g, '_'), modelId.replace(/[^\w.@-]/g, '_'), `${inputSha(req)}${(req.attempt ?? 1) > 1 ? `.a${req.attempt}` : ''}.json`)

interface Recording {
  model: string
  prompt_version: string
  settings: Record<string, unknown> | null // the adapter's request settings at recording time
  answered_by: string | null // the model that answered (null: recorded before this was stored)
  raw: string
  error?: string | null // the adapter refused the reply (cut off, refused): it replays as that failure, even if `raw` parses
  usage: { inputTokens: number; outputTokens: number }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export class ReplayAdapter implements LlmAdapter {
  readonly id: string
  readonly location = 'local' as const // nothing leaves the deployment
  private readonly dir: string
  private readonly modelId: string // the model the recordings came from
  private readonly expect: Record<string, unknown> | undefined // the settings the recordings must have been made with
  constructor(dir: string, modelId: string, expectSettings?: Record<string, unknown>) {
    this.dir = dir
    this.modelId = modelId
    this.expect = expectSettings
    this.id = `replay/${modelId}`
  }

  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResult<z.infer<S>>> {
    const f = fileOf(this.dir, this.modelId, req)
    if (!existsSync(f)) throw new ReplayMissingError(`no recording for ${req.promptVersion} ${this.modelId} ${inputSha(req).slice(0, 12)} (record with eval:record)`)
    const r = JSON.parse(readFileSync(f, 'utf8')) as Recording
    if (this.expect && !same(r.settings, this.expect)) throw new ReplayMissingError(`recording ${inputSha(req).slice(0, 12)} was made with other request settings (re-record with eval:record)`)
    if (r.error) throw new LlmOutputError(r.error, r.raw)
    return { raw: r.raw, parsed: validated(req.schema, r.raw), usage: r.usage, ...(r.answered_by ? { model: r.answered_by } : {}) }
  }
}

/** Calls the real adapter and records each reply (also replies that fail validation, so replay reproduces them). */
export class Recorder implements LlmAdapter {
  readonly id: string
  readonly location: 'local' | 'external'
  private readonly inner: LlmAdapter
  private readonly dir: string
  private readonly modelId: string
  constructor(inner: LlmAdapter, dir: string, modelId: string) {
    this.inner = inner
    this.dir = dir
    this.modelId = modelId
    this.id = inner.id
    this.location = inner.location
  }

  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResult<z.infer<S>>> {
    const f = fileOf(this.dir, this.modelId, req)
    // an existing recording of the same request and settings is reused: re-recording pays only for requests that changed;
    // one made with other settings is recorded again (verify R2)
    if (existsSync(f)) {
      const r = JSON.parse(readFileSync(f, 'utf8')) as Recording
      if (same(r.settings, this.inner.settings ?? null)) return new ReplayAdapter(this.dir, this.modelId, this.inner.settings).complete(req)
    }
    mkdirSync(join(f, '..'), { recursive: true })
    const rec = (raw: string, usage: Recording['usage'], answeredBy: string | null, error: string | null = null): Recording => ({
      model: this.modelId, prompt_version: req.promptVersion, settings: this.inner.settings ?? null, answered_by: answeredBy, raw, ...(error ? { error } : {}), usage,
    })
    try {
      const r = await this.inner.complete(req)
      writeFileSync(f, JSON.stringify(rec(r.raw, r.usage, r.model ?? null), null, 1))
      return r
    } catch (e) {
      if (e instanceof LlmOutputError) writeFileSync(f, JSON.stringify(rec(e.raw, { inputTokens: 0, outputTokens: 0 }, null, e.message), null, 1))
      throw e
    }
  }
}
