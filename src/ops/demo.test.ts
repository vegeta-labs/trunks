// TC-DEMO-03 (PRD R-DEMO-01 v0.7.22): the demo configuration and what it refuses.
import { describe, expect, it } from 'vitest'
import { checkDemoConfig, DEMO_SAMPLES, demoConfig } from './demo.ts'
import type { Config } from '../config/load.ts'

describe('demo configuration', () => {
  it('TC-DEMO-03 the evaluation configuration with a KYC folder; anything reaching outside the demo refused', () => {
    const c = demoConfig('eval/config', '/tmp/trunks-kyc')
    expect(c.kyc.target).toEqual({ kind: 'folder', path: '/tmp/trunks-kyc' })
    expect(c.model?.provider).toBe('replay')
    expect(() => checkDemoConfig(c)).not.toThrow()
    const bad = (patch: (c: Config) => Config, why: RegExp) => expect(() => checkDemoConfig(patch(structuredClone(c)))).toThrow(why)
    for (const kind of ['imap', 'gmail', 'graph'] as const) bad((x) => ({ ...x, mailboxes: [{ ...x.mailboxes[0]!, kind }] }), new RegExp(`is ${kind} \\(only eml\\)`))
    bad((x) => ({ ...x, model: { ...x.model!, provider: 'ollama' } }), /model provider ollama/)
    bad((x) => ({ ...x, model: { ...x.model!, provider: 'anthropic' } }), /model provider anthropic/)
    bad((x) => ({ ...x, events: { webhook: { url: 'https://hooks.example/x', secret_env: 'X' } } }), /an event webhook/)
    bad((x) => ({ ...x, kyc: { ...x.kyc, target: { kind: 'webhook', url: 'https://kyc.example/x', secret_env: 'X' } } }) as Config, /a KYC webhook/)
    bad((x) => ({ ...x, auth: { ...x.auth, oidc: { issuer: 'https://idp.example', client_id: 'x', client_secret_env: 'X', redirect_uri: 'https://app.example/cb', role_claim: 'roles', role_map: {} } } }) as Config, /OIDC/)
    expect(new Set(DEMO_SAMPLES).size).toBe(31)
  })
})
