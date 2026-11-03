// Ollama adapter (tech design §3.2): a local model; the JSON Schema goes in `format`, the reply is validated again.
import { z } from 'zod'
import { LlmOutputError, SetupError, unsentCode, validated, type LlmAdapter, type LlmRequest, type LlmResult } from './types.ts'

// the same output limit as the hosted adapter; a reply that hits it is cut off, not valid
export const OLLAMA_SETTINGS = { num_predict: 4096, temperature: 0 } as const

export class OllamaAdapter implements LlmAdapter {
  readonly id: string
  readonly location = 'local' as const
  readonly settings = OLLAMA_SETTINGS
  private readonly timeoutMs: number
  private readonly host: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private probed = false
  constructor(o: { host: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.timeoutMs = o.timeoutMs ?? 120_000
    this.host = o.host.replace(/\/$/, '')
    this.model = o.model
    this.id = `ollama/${o.model}`
    this.fetchImpl = o.fetchImpl ?? fetch
  }

  /**
   * Before the first model request, one GET of the version, which carries no mail content. A TLS error cannot tell
   * whether a request was sent (https to a plain-http port fails the same way as a bad record after the request), so a
   * TLS error on a model request is a counted attempt (Codex E2 round 5 F23); a wrong address or protocol shows up here
   * instead, as a setup error before any request (round 4 F21). Fixed words: no address, no transport message (F15).
   */
  private async probe(): Promise<void> {
    if (this.probed) return
    const res = await this.fetchImpl(`${this.host}/api/version`, { method: 'GET', signal: AbortSignal.timeout(this.timeoutMs) }).catch((e: unknown) => {
      throw new SetupError(`cannot connect to ollama (${errorCode(e) ?? 'no answer'})`)
    })
    if (res.status === 401 || res.status === 403) throw new SetupError(`ollama rejected the request (${res.status})`)
    this.probed = true
  }

  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResult<z.infer<S>>> {
    await this.probe()
    const res = await this.fetchImpl(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: z.toJSONSchema(req.schema),
        options: { ...OLLAMA_SETTINGS },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    }).catch((e: unknown) => {
      // only a connection that certainly sent nothing is a setup error, in fixed words: no address (it may hold a
      // password), no transport message (Codex E2 round 3 F15, F16). Anything else may have reached the model: an attempt
      const code = unsentCode(e)
      if (code) throw new SetupError(`cannot connect to ollama (${code})`)
      throw e
    })
    if (res.status === 401 || res.status === 403) throw new SetupError(`ollama rejected the request (${res.status})`)
    if (!res.ok) throw new Error(`ollama ${res.status}`)
    const body = (await res.json()) as { message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number }
    const raw = body.message?.content ?? ''
    if (body.done_reason === 'length') throw new LlmOutputError('reply cut off at num_predict', raw)
    return { raw, parsed: validated(req.schema, raw), usage: { inputTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 } }
  }
}

// the first error code along `cause`, if it looks like one (upper case, digits, underscores): never a message
function errorCode(e: unknown, depth = 0): string | null {
  if (!e || typeof e !== 'object' || depth > 5) return null
  const x = e as { code?: unknown; cause?: unknown }
  if (typeof x.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(x.code)) return x.code
  return errorCode(x.cause, depth + 1)
}
