import { describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig } from './load.ts'

const copy = () => {
  const d = mkdtempSync(join(tmpdir(), 'doi-cfg-'))
  cpSync('config/default', d, { recursive: true })
  return d
}
const edit = (d: string, f: string, fn: (s: string) => string) => writeFileSync(join(d, f), fn(readFileSync(join(d, f), 'utf8')))
const err = (d: string) => {
  try {
    loadConfig(d)
  } catch (e) {
    if (e instanceof ConfigError) return e.message
    throw e
  }
  return null
}

describe('R-CFG-01 configuration checks', () => {
  it('the default configuration loads', () => {
    const c = loadConfig('config/default')
    expect(c.classes).toHaveLength(18)
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
  it('TC-CFG-01 missing required key, duplicate class id, unknown placeholder → file and line', () => {
    let d = copy()
    edit(d, 'deployment.yaml', (s) => s.replace('  timezone: Europe/London\n', ''))
    expect(err(d)).toMatch(/deployment\.yaml:2: deployment\.timezone: /)

    d = copy()
    edit(d, 'cases.yaml', (s) => s.replace('{ id: payment_evidence,', '{ id: payment_query,'))
    expect(err(d)).toMatch(/cases\.yaml:4: classes\.1\.id: duplicate class id payment_query/)

    d = copy()
    edit(d, 'templates.yaml', (s) => s.replace('      {deployment_name}', '      {cash_owed}'))
    expect(err(d)).toMatch(/templates\.yaml:\d+: templates\.0: unknown placeholder \{cash_owed\}/)

    d = copy()
    edit(d, 'deployment.yaml', (s) => s.replace('    kind: imap\n', '    kind: imap\n    send_as: x\n'))
    expect(err(d)).toMatch(/deployment\.yaml:\d+: mailboxes\.0: .*send_as/)

    d = copy()
    edit(d, 'deployment.yaml', (s) => s.replace('  name: Example Capital Ops', '  name: A\n  name: B'))
    expect(err(d)).toMatch(/deployment\.yaml:\d+: .*[Dd]uplicate|unique/)

    // R-PRV-01 (LK-F2): a hosted provider cannot be declared local
    d = copy()
    edit(d, 'deployment.yaml', (s) => s.replace('  location: external\n', '  location: local\n'))
    expect(err(d)).toMatch(/deployment\.yaml:\d+: model\.location: provider anthropic is always location: external/)

    // Codex E2 round 3 F15: no credentials in the Ollama address
    d = copy()
    edit(d, 'deployment.yaml', (s) => s.replace('  api_key_env: ANTHROPIC_API_KEY\n', '  api_key_env: ANTHROPIC_API_KEY\n  ollama_host: http://operator:FICTIONAL_SECRET@localhost:11434\n'))
    expect(err(d)).toMatch(/model\.ollama_host: no user name or password/)
    expect(err(d)).not.toContain('FICTIONAL_SECRET')
    // not a URL: refused with the field named, not thrown (self-review S3)
    d = copy()
    edit(d, 'deployment.yaml', (s) => s.replace('  api_key_env: ANTHROPIC_API_KEY\n', '  api_key_env: ANTHROPIC_API_KEY\n  ollama_host: not a url\n'))
    expect(err(d)).toMatch(/model\.ollama_host/)
  })

  it('TC-FRD-06 switching off a fixed rule or replacing a built-in word list fails and names the key', () => {
    for (const [file, from, to, key] of [
      ['deployment.yaml', 'signals:\n', 'signals:\n  injection_markers: []\n', 'signals.injection_markers'],
      ['deployment.yaml', 'audit:\n', 'replies:\n  internal_terms: [fraud]\naudit:\n', 'replies.internal_terms'],
      ['deployment.yaml', 'audit:\n', 'fraud_rules:\n  bank_details_never_applied: false\naudit:\n', 'fraud_rules'],
      ['deployment.yaml', 'signals:\n', 'signals:\n  pressure_words: [urgent]\n', 'signals.pressure_words'],
    ] as const) {
      const d = copy()
      edit(d, file, (s) => s.replace(from, to))
      expect(err(d)).toMatch(new RegExp(`${file.replace('.', '\\.')}:\\d+: ${key.replace('.', '\\.')}: the fixed rules and built-in word lists cannot be configured`))
    }
    const d = copy()
    edit(d, 'deployment.yaml', (s) => s.replace('  injection_markers_extra: []\n', '  injection_markers_extra: [act now]\n  pressure_words_extra: [by tonight]\n'))
    expect(err(d)).toBe(null) // additions are fine
  })
  it('TC-FRD-04 a cooling-off period of 0 fails', () => {
    const d = copy()
    edit(d, 'deployment.yaml', (s) => s.replace('audit:\n', 'verification:\n  cooling_off_hours: 0\naudit:\n'))
    expect(err(d)).toMatch(/verification\.cooling_off_hours: /)
    expect(loadConfig('config/default').verification.cooling_off_hours).toBe(24)
  })
  it('TC-DRF-09 / TC-DRF-16 template sources, required templates, automatic discloses_record', () => {
    const c = loadConfig('config/default')
    expect([...c.templateMeta.values()].filter((m) => m.discloses).map((m) => m.id).sort()).toEqual(['commitment_change_ack', 'exit_info', 'payment_need_evidence', 'payment_received', 'payment_wait', 'withdrawal_ack'])
    let d = copy()
    edit(d, 'templates.yaml', (s) => s.replace('We have received {received_amount}', 'We have received {amount}'))
    expect(err(d)).toMatch(/payment_received asserts receipt and may only use directory or ledger placeholders and \{deployment_name\}, not \{amount\}/)
    d = copy()
    edit(d, 'templates.yaml', (s) => s.replace('Thank you for your email. We have received it', 'Dear {investor_name}. We have received it'))
    expect(err(d)).toMatch(/safe_ack may only use system placeholders, not \{investor_name\}/)
    d = copy()
    edit(d, 'templates.yaml', (s) => s.replace('Our legal team will review them', 'Our legal team will check them for fraud'))
    expect(err(d)).toMatch(/internal terms in the template text: fraud/)
    d = copy()
    edit(d, 'templates.yaml', (s) => s.replace('Thank you for the documents. Our legal team', 'Thank you for the documents for {deal_name}. Our legal team'))
    expect(loadConfig(d).templateMeta.get('legal_ack')?.discloses).toBe(true)
    d = copy()
    edit(d, 'templates.yaml', (s) => s.replace('  - id: safe_ack\n', '  - id: safe_ack\n    asserts_receipt: true\n'))
    expect(err(d)).toMatch(/safe_ack cannot assert receipt/) // Codex E3 F3
    d = copy()
    edit(d, 'templates.yaml', (s) => s.replace('  - id: closing_ack', '  - id: closing_ack_old'))
    expect(err(d)).toMatch(/the template closing_ack is required/)
  })
  it('the evaluation configuration uses the same templates', () => {
    expect(readFileSync('eval/config/templates.yaml', 'utf8')).toBe(readFileSync('config/default/templates.yaml', 'utf8'))
  })
  it('TC-PRV-01 serve start-up: the default (external, no DPA) refuses; allow_without_dpa starts with a warning; no model refuses', async () => {
    const { startModel } = await import('../startup.ts')
    expect(() => startModel(loadConfig('config/default'))).toThrow(/data processing agreement/)
    let d = copy()
    edit(d, 'deployment.yaml', (s) => s.replace('  dpa: false\n', '  dpa: false\n  allow_without_dpa: true\n'))
    const warned: string[] = []
    expect(startModel(loadConfig(d), (w) => warned.push(w), { ANTHROPIC_API_KEY: 'test' }).id).toBe('anthropic/claude-opus-5-5')
    // verify R1: a hosted provider without its key does not start
    expect(() => startModel(loadConfig(d), () => undefined, {})).toThrow(/ANTHROPIC_API_KEY is empty/)
    expect(warned.join()).toMatch(/R-PRV-01.*without a data processing agreement/)
    d = copy()
    edit(d, 'deployment.yaml', (s) => s.slice(0, s.indexOf('\n# the model provider')) + '\n')
    expect(() => startModel(loadConfig(d))).toThrow(/model is required/)
  })
})


it('TC-RED-11 inline image thresholds default conservatively and reject values beyond every hard cap', () => {
  expect(loadConfig('config/default').kyc.inline_image).toEqual({ max_long_side: 400, max_short_side: 150, max_bytes: 51200 })
  for (const [key, cap] of [['max_long_side', 1280], ['max_short_side', 300], ['max_bytes', 102400]] as const) {
    const d = copy()
    edit(d, 'deployment.yaml', (s) => s + `\nkyc:\n  inline_image:\n    ${key}: ${cap}\n`)
    expect(err(d)).toBeNull()
    edit(d, 'deployment.yaml', (s) => s.replace(`${key}: ${cap}`, `${key}: ${cap + 1}`))
    expect(err(d)).toContain(`kyc.inline_image.${key}`)
  }
})
