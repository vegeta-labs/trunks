import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { AnthropicAdapter } from './anthropic.ts'
import { OllamaAdapter } from './ollama.ts'
import { Recorder, ReplayAdapter } from './replay.ts'
import { LlmOutputError, ReplayMissingError, SetupError, type LlmAdapter } from './types.ts'
import { modelPolicy } from './index.ts'

const Schema = z.object({ labels: z.array(z.object({ class: z.string(), confidence: z.enum(['high', 'medium', 'low']) })) })
const req = { system: 'classify', user: '[NAME_1] paid', schema: Schema, promptVersion: 'classify@v1' }
const reply = '{"labels":[{"class":"payment_query","confidence":"high"}]}'

// the real SDK client over a fake transport: the SDK's own validation, retries and errors are exercised
function fakeAnthropic(text: string, stop = 'end_turn', status = 200) {
  const calls: Array<Record<string, unknown>> = []
  const fetch = (async (_u: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)))
    if (status !== 200) return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status, headers: { 'content-type': 'application/json' } })
    const body = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: stop, stop_details: null, usage: { input_tokens: 10, output_tokens: 5 } }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { adapter: new AnthropicAdapter({ model: 'claude-opus-5-5', apiKey: 'test', fetch }), calls }
}

// an Ollama transport that answers the version probe (F23) and hands every model request to `f`
const probed = (f: (u: string, init: RequestInit) => Promise<Response>) =>
  (async (u: string, init: RequestInit) => (u.endsWith('/api/version') ? new Response('{"version":"0.0.0"}') : f(u, init))) as unknown as typeof fetch

describe('model adapters (tech design §3.2)', () => {
  it('TC-CLS-06 neither the Anthropic nor the Ollama request carries tools or functions; structured output is used', async () => {
    const a = fakeAnthropic(reply)
    expect((await a.adapter.complete(req)).model).toBe('claude-opus-5-5') // the answering model is reported
    const p = a.calls[0]!
    for (const k of ['tools', 'functions', 'tool_choice']) expect(p).not.toHaveProperty(k)
    expect(p.output_config).toMatchObject({ format: { type: 'json_schema' } })
    expect(p.messages).toEqual([{ role: 'user', content: '[NAME_1] paid' }])
    let body: Record<string, unknown> = {}
    const fetchImpl = probed(async (_u, init) => {
      body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ message: { content: reply } }))
    })
    const r = await new OllamaAdapter({ host: 'http://ollama.local:11434', model: 'llama', fetchImpl }).complete(req)
    expect(r.parsed.labels[0]!.class).toBe('payment_query')
    for (const k of ['tools', 'functions']) expect(body).not.toHaveProperty(k)
    expect(body.format).toMatchObject({ type: 'object' })
  })

  it('R-CLS-01 a reply that is not the schema, a refusal and a cut-off reply are output errors (the caller retries once)', async () => {
    // constraints the API does not enforce (maxLength, maxItems) are checked by the adapter, not by the SDK's parser
    const Strict = z.strictObject({ labels: z.array(z.strictObject({ reason: z.string().max(5) })).max(1) })
    for (const [text, stop] of [['{"labels":"x"}', 'end_turn'], ['not json', 'end_turn'], [reply, 'refusal'], [reply, 'max_tokens'], ['{"labels":[{"reason":"far too long"}]}', 'end_turn'], ['{"labels":[{"reason":"a"},{"reason":"b"}]}', 'end_turn']] as const) {
      const a = fakeAnthropic(text, stop)
      await expect(a.adapter.complete({ ...req, schema: text.includes('reason') ? Strict : Schema }), text).rejects.toBeInstanceOf(LlmOutputError)
      expect(a.calls).toHaveLength(1)
    }
  })

  it('C-FLD-0 the SDK does not retry on its own: a provider error is one request, then the caller counts the attempt', async () => {
    const a = fakeAnthropic(reply, 'end_turn', 529)
    const e = await a.adapter.complete(req).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(LlmOutputError)
    expect(a.calls).toHaveLength(1)
  })

  it('Ollama: an output limit and a timeout are sent; a reply cut off at the limit is an output error', async () => {
    let body: Record<string, unknown> = {}
    let signal: AbortSignal | null | undefined
    const fetchImpl = probed(async (_u, init) => {
      body = JSON.parse(String(init.body))
      signal = init.signal
      return new Response(JSON.stringify({ message: { content: '{"labels":[' }, done_reason: 'length' }))
    })
    await expect(new OllamaAdapter({ host: 'http://ollama.local:11434', model: 'llama', fetchImpl }).complete(req)).rejects.toBeInstanceOf(LlmOutputError)
    expect(body.options).toMatchObject({ num_predict: 4096, temperature: 0 })
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('replay returns what was recorded, keyed by prompt version + model + input; a missing recording is an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doi-replay-'))
    const real: LlmAdapter = { id: 'anthropic/m', location: 'external', complete: async () => ({ raw: reply, parsed: JSON.parse(reply), usage: { inputTokens: 1, outputTokens: 1 } }) }
    await new Recorder(real, dir, 'm').complete(req)
    const replay = new ReplayAdapter(dir, 'm')
    expect((await replay.complete(req)).parsed).toEqual(JSON.parse(reply))
    await expect(replay.complete({ ...req, user: 'other text' })).rejects.toThrow(/no recording/)
    await expect(replay.complete({ ...req, promptVersion: 'classify@v2' })).rejects.toThrow(/no recording/)
    await expect(new ReplayAdapter(dir, 'other-model').complete(req)).rejects.toThrow(/no recording/)
    // a recorded invalid reply replays as the same output error
    const bad: LlmAdapter = { ...real, complete: async () => { throw new LlmOutputError('bad', '{"x":1}') } }
    await expect(new Recorder(bad, dir, 'm').complete({ ...req, user: 'bad' })).rejects.toBeInstanceOf(LlmOutputError)
    await expect(replay.complete({ ...req, user: 'bad' })).rejects.toBeInstanceOf(LlmOutputError)
  })

  it('X1 a missing recording is a setup error (ReplayMissingError), X2 a recorded cut-off reply replays as a failure even when it parses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doi-replay-'))
    await expect(new ReplayAdapter(dir, 'm').complete(req)).rejects.toBeInstanceOf(ReplayMissingError)
    const cut: LlmAdapter = { id: 'anthropic/m', location: 'external', complete: async () => { throw new LlmOutputError('reply cut off at max_tokens', reply) } }
    await expect(new Recorder(cut, dir, 'm').complete(req)).rejects.toBeInstanceOf(LlmOutputError)
    await expect(new ReplayAdapter(dir, 'm').complete(req)).rejects.toThrow(/cut off/)
  })

    it('recordings are kept per attempt and carry the request settings and the answering model; other settings do not replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doi-replay-'))
    let calls = 0
    const settings = { effort: 'low' }
    const real: LlmAdapter = { id: 'anthropic/m', location: 'external', settings, complete: async () => {
      calls++
      if (calls === 1) throw new LlmOutputError('bad', '{"x":1}')
      return { raw: reply, parsed: JSON.parse(reply), usage: { inputTokens: 1, outputTokens: 1 }, model: 'fallback-model' }
    } }
    const rec = new Recorder(real, dir, 'm')
    await expect(rec.complete({ ...req, attempt: 1 })).rejects.toBeInstanceOf(LlmOutputError)
    // the retry reaches the real model instead of replaying the first invalid reply (EV-F2)
    expect((await rec.complete({ ...req, attempt: 2 })).parsed).toEqual(JSON.parse(reply))
    expect(calls).toBe(2)
    const replay = new ReplayAdapter(dir, 'm', settings)
    await expect(replay.complete({ ...req, attempt: 1 })).rejects.toBeInstanceOf(LlmOutputError)
    expect(await replay.complete({ ...req, attempt: 2 })).toMatchObject({ model: 'fallback-model' })
    await expect(new ReplayAdapter(dir, 'm', { effort: 'high' }).complete({ ...req, attempt: 2 })).rejects.toThrow(/other request settings/)
    // verify R2: recording with new settings records again instead of failing on its own check
    const changed: LlmAdapter = { ...real, settings: { effort: 'high' }, complete: async () => ({ raw: reply, parsed: JSON.parse(reply), usage: { inputTokens: 1, outputTokens: 1 } }) }
    expect((await new Recorder(changed, dir, 'm').complete({ ...req, attempt: 2 })).parsed).toEqual(JSON.parse(reply))
    expect((await new ReplayAdapter(dir, 'm', { effort: 'high' }).complete({ ...req, attempt: 2 })).parsed).toEqual(JSON.parse(reply))
  })

  it('verify R1: rejected credentials and refused connections are setup errors, not model attempts', async () => {
    for (const status of [401, 403]) {
      const a = fakeAnthropic(reply, 'end_turn', status)
      await expect(a.adapter.complete(req)).rejects.toBeInstanceOf(SetupError)
    }
    expect(await fakeAnthropic(reply, 'end_turn', 529).adapter.complete(req).catch((e: unknown) => e instanceof SetupError)).toBe(false)
    // the probe passed, then Ollama stopped: the model request is refused, nothing was sent (F23 probe)
    const refused = probed(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:11434'), { code: 'ECONNREFUSED' }) }) })
    const r1 = await new OllamaAdapter({ host: 'http://ollama:11434', model: 'llama', fetchImpl: refused }).complete(req).catch((e: unknown) => e)
    expect(r1).toBeInstanceOf(SetupError)
    expect((r1 as Error).message).toBe('cannot connect to ollama (ECONNREFUSED)') // no address, no transport text (F15)
    // a fetch failure without a known cause may have been sent: an attempt (Codex E2 round 3 F16)
    const unknown = probed(async () => { throw new TypeError('fetch failed') })
    expect(await new OllamaAdapter({ host: 'http://ollama:11434', model: 'llama', fetchImpl: unknown }).complete(req).catch((e: unknown) => e instanceof SetupError)).toBe(false)
    // a TLS handshake that failed sent nothing either (self-review S4)
    const tls = probed(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) }) })
    await expect(new OllamaAdapter({ host: 'https://ollama:11434', model: 'llama', fetchImpl: tls }).complete(req)).rejects.toBeInstanceOf(SetupError)
    const denied = probed(async () => new Response('no', { status: 401 }))
    await expect(new OllamaAdapter({ host: 'http://ollama:11434', model: 'llama', fetchImpl: denied }).complete(req)).rejects.toBeInstanceOf(SetupError)
  })

  it('Codex E2 round 3 F15 / F16 on real sockets: a refused connection is a setup error in fixed words; a connection broken after the request is an attempt', async () => {
    // a port nobody listens on
    const closed = createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
    const port = (closed.address() as AddressInfo).port
    await new Promise((r) => closed.close(r))
    // a server that reads the request, then drops the connection without answering
    let received = 0
    const dropper = createServer((sock) => sock.once('data', (d) => {
      // the Ollama version probe is answered (F23); a model request is dropped
      if (String(d).startsWith('GET /api/version')) return void sock.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}')
      received++
      sock.destroy()
    }))
    await new Promise<void>((r) => dropper.listen(0, '127.0.0.1', r))
    const drop = (dropper.address() as AddressInfo).port
    const to = (p: number) => (async (_u: string, init: RequestInit) => fetch(`http://127.0.0.1:${p}/v1/messages`, init)) as unknown as typeof fetch
    try {
      const e1 = await new OllamaAdapter({ host: `http://127.0.0.1:${port}`, model: 'llama' }).complete(req).catch((e: unknown) => e)
      expect(e1).toBeInstanceOf(SetupError)
      expect((e1 as Error).message).toBe('cannot connect to ollama (ECONNREFUSED)') // no address, no transport text
      const e2 = await new AnthropicAdapter({ model: 'm', apiKey: 'test', fetch: to(port) }).complete(req).catch((e: unknown) => e)
      expect(e2).toBeInstanceOf(SetupError)
      expect((e2 as Error).message).toBe('cannot connect to the model provider (ECONNREFUSED)')
      const e3 = await new OllamaAdapter({ host: `http://127.0.0.1:${drop}`, model: 'llama' }).complete(req).catch((e: unknown) => e)
      expect(e3).toBeInstanceOf(Error)
      expect(e3).not.toBeInstanceOf(SetupError)
      const e4 = await new AnthropicAdapter({ model: 'm', apiKey: 'test', fetch: to(drop) }).complete(req).catch((e: unknown) => e)
      expect(e4).toBeInstanceOf(Error)
      expect(e4).not.toBeInstanceOf(SetupError)
      expect(received).toBe(2) // both requests did reach the server
    } finally {
      await new Promise((r) => dropper.close(r))
    }
  })

  it('Codex E2 round 4 F21 / round 5 F23 on a real socket: https to a plain-http port is caught by the Ollama probe, a setup error before any request; on a model request the same TLS error is an attempt', async () => {
    let received = 0
    const plain = createServer((sock) => sock.once('data', () => {
      received++
      sock.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n')
    }))
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
    const port = (plain.address() as AddressInfo).port
    try {
      const e1 = await new OllamaAdapter({ host: `https://127.0.0.1:${port}`, model: 'llama' }).complete(req).catch((e: unknown) => e)
      expect(e1).toBeInstanceOf(SetupError)
      const tls = (async (_u: string, init: RequestInit) => fetch(`https://127.0.0.1:${port}/v1/messages`, init)) as unknown as typeof fetch
      // OpenSSL may report either code for the same TLS-to-plain-HTTP handshake. Both must remain setup errors.
      expect((e1 as Error).message).toMatch(/^cannot connect to ollama \(ERR_SSL_(?:WRONG_VERSION_NUMBER|PACKET_LENGTH_TOO_LONG)\)$/)
      // the Anthropic address is fixed, so it has no probe: the error cannot show the request was not sent (F23)
      const e2 = await new AnthropicAdapter({ model: 'm', apiKey: 'test', fetch: tls }).complete(req).catch((e: unknown) => e)
      expect(e2).toBeInstanceOf(Error)
      expect(e2).not.toBeInstanceOf(SetupError)
      expect(received).toBe(2) // the ClientHellos arrived; no HTTP request did
    } finally {
      await new Promise((r) => plain.close(r))
    }
  })

  it('Codex E2 round 5 F23: a TLS error after the request was sent is a counted attempt; Ollama probes its address once, with no mail content, before the first request', async () => {
    const tlsAfterSend = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('wrong version number'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }) }) }
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const ollama = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, method: init.method ?? 'GET', body: init.body })
      if (u.endsWith('/api/version')) return new Response('{"version":"0.0.0"}')
      return tlsAfterSend()
    }) as unknown as typeof fetch
    const a = new OllamaAdapter({ host: 'https://ollama:11434', model: 'llama', fetchImpl: ollama })
    for (let i = 0; i < 2; i++) {
      const e = await a.complete(req).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(SetupError)
    }
    // one probe, a GET without a body, then the two model requests
    expect(calls.map((c) => [c.url, c.method, c.body ?? null])).toEqual([
      ['https://ollama:11434/api/version', 'GET', null], ['https://ollama:11434/api/chat', 'POST', calls[1]!.body], ['https://ollama:11434/api/chat', 'POST', calls[2]!.body],
    ])
    const anthropic = (async () => tlsAfterSend()) as unknown as typeof fetch
    const e2 = await new AnthropicAdapter({ model: 'm', apiKey: 'test', fetch: anthropic }).complete(req).catch((x: unknown) => x)
    expect(e2).toBeInstanceOf(Error)
    expect(e2).not.toBeInstanceOf(SetupError)
    // a probe that fails in any way is a setup error in fixed words, and no model request follows
    for (const fail of [tlsAfterSend, () => { throw new TypeError('fetch failed') }]) {
      let chat = 0
      const f = (async (u: string) => (u.endsWith('/api/version') ? fail() : (chat++, new Response('{}')))) as unknown as typeof fetch
      const e = await new OllamaAdapter({ host: 'https://user:secret@ollama:11434', model: 'llama', fetchImpl: f }).complete(req).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(SetupError)
      expect((e as Error).message).toMatch(/^cannot connect to ollama \((ERR_SSL_WRONG_VERSION_NUMBER|no answer)\)$/)
      expect(chat).toBe(0)
    }
  })

  it('TC-PRV-01 external model without a DPA refuses to start unless allowed (then a lasting warning); a region outside the UK / EEA without a transfer basis warns', () => {
    const base = { provider: 'anthropic', model_id: 'claude-opus-5-5', location: 'external', dpa: false, no_training: true, allow_without_dpa: false, api_key_env: 'ANTHROPIC_API_KEY', region: 'eu' } as const
    expect(modelPolicy(base).refuse).toMatch(/data processing agreement/)
    const allowed = modelPolicy({ ...base, allow_without_dpa: true })
    expect(allowed.refuse).toBeNull()
    expect(allowed.warnings.join()).toMatch(/without a data processing agreement/)
    expect(modelPolicy({ ...base, dpa: true }).warnings).toEqual([])
    expect(modelPolicy({ ...base, dpa: true, region: 'us' }).warnings.join()).toMatch(/outside the UK \/ EEA/)
    expect(modelPolicy({ ...base, dpa: true, region: 'us', transfer_basis: 'UK IDTA' }).warnings).toEqual([])
    expect(modelPolicy({ ...base, location: 'local', provider: 'ollama' })).toEqual({ refuse: null, warnings: [] })
    // a hosted provider declared local is still external (LK-F2), and configuration load rejects it
    expect(modelPolicy({ ...base, location: 'local' }).refuse).toMatch(/data processing agreement/)
    // S4: an Ollama host declared local but looking external warns (start-up log and UI); local-looking hosts do not
    const ollama = { ...base, provider: 'ollama', location: 'local' } as const
    expect(modelPolicy({ ...ollama, ollama_host: 'https://ollama.provider.example' }).warnings.join()).toMatch(/does not look local/)
    for (const h of ['http://ollama:11434', 'http://localhost:11434', 'http://127.0.0.1:11434', 'http://10.0.0.5:11434', 'http://172.20.0.3:11434', 'http://192.168.1.9:11434', 'http://[::1]:11434', 'http://gpu.local:11434']) {
      expect(modelPolicy({ ...ollama, ollama_host: h }), h).toEqual({ refuse: null, warnings: [] })
    }
    expect(modelPolicy({ ...ollama, ollama_host: 'http://172.32.0.1:11434' }).warnings).toHaveLength(1)
  })
})
