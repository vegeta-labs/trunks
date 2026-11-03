// Anthropic adapter (tech design §3.2): structured output through `output_config.format`, never tool definitions.
// A provider refusal goes to the server-side fallback first. The reply is validated here, not by the SDK: an invalid,
// cut-off or refused reply is an LlmOutputError, so the caller's one retry (R-CLS-01, C-FLD-0) applies. The SDK does
// not retry on its own; the caller counts every attempt.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { z } from 'zod'
import { LlmOutputError, SetupError, unsentCode, validated, type LlmAdapter, type LlmRequest, type LlmResult } from './types.ts'

/** The request settings; recordings carry them so a change cannot replay old replies (eval). */
export const ANTHROPIC_SETTINGS = {
  max_tokens: 4096,
  // classification and extraction are short structured answers: low effort (the model's own default is medium)
  effort: 'low',
  // on a policy decline the API re-runs the request on its default fallback model
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
} as const

export interface AnthropicOptions {
  model: string // from configuration, e.g. claude-opus-5-5
  apiKey?: string
  fetch?: typeof fetch // tests: the real client over a fake transport
  timeoutMs?: number
}

export class AnthropicAdapter implements LlmAdapter {
  readonly id: string
  readonly location = 'external' as const
  readonly settings = ANTHROPIC_SETTINGS
  private readonly client: Anthropic
  private readonly model: string
  constructor(o: AnthropicOptions) {
    this.model = o.model
    this.id = `anthropic/${o.model}`
    this.client = new Anthropic({ ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), maxRetries: 0, timeout: o.timeoutMs ?? 120_000 })
  }

  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResult<z.infer<S>>> {
    // the JSON Schema only: `create` does not run the SDK's own parser (it throws its own error type)
    const { type, schema } = betaZodOutputFormat(req.schema)
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: ANTHROPIC_SETTINGS.max_tokens,
      output_config: { effort: ANTHROPIC_SETTINGS.effort, format: { type, schema } },
      betas: [...ANTHROPIC_SETTINGS.betas],
      fallbacks: ANTHROPIC_SETTINGS.fallbacks,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }).catch((e: unknown) => {
      // credentials and a connection that certainly sent nothing are setup errors; a timeout or a connection broken
      // later may have reached the provider, so they are attempts (Codex E2 round 3 F16)
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new SetupError(`model provider rejected the credentials (${e.status})`)
      const code = e instanceof Anthropic.APIConnectionError && !(e instanceof Anthropic.APIConnectionTimeoutError) ? unsentCode(e) : null
      if (code) throw new SetupError(`cannot connect to the model provider (${code})`)
      if (e instanceof Anthropic.AnthropicError && /authentication|api ?key/i.test(e.message) && !(e instanceof Anthropic.APIError)) throw new SetupError(`no model credentials: ${e.message}`)
      throw e
    })
    const raw = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    if (res.stop_reason === 'refusal') throw new LlmOutputError(`provider refused (${res.stop_details?.category ?? 'no category'})`, raw)
    if (res.stop_reason === 'max_tokens') throw new LlmOutputError('reply cut off at max_tokens', raw)
    return { raw, parsed: validated(req.schema, raw), usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }, model: res.model }
  }
}
