// TC-OPS-04 (PRD R-OPS-02; tech design v0.7.11): the English documentation matches the code and says only what was
// tested (rule P8).
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { configKeys } from './config-keys.ts'

const DIR = 'docs/en'
const docs = readdirSync(DIR).filter((f) => f.endsWith('.md'))
const text = (f: string) => readFileSync(join(DIR, f), 'utf8')

describe('English documentation', () => {
  it('TC-OPS-04 the configuration reference lists exactly the keys of the configuration schema', () => {
    const { leaves, all } = configKeys()
    const documented = [...text('configuration.md').matchAll(/^\|\s*`([a-z_][a-z0-9_.[\]]*)`\s*\|/gm)].map((m) => m[1]!)
    expect(documented.filter((p) => !all.includes(p)), 'documented but not in the schema').toEqual([])
    expect(leaves.filter((p) => !documented.includes(p)), 'in the schema but not documented').toEqual([])
  })

  it('TC-OPS-04 every relative link points to a file that exists', () => {
    const broken: string[] = []
    for (const f of docs) {
      for (const m of text(f).matchAll(/\]\(([^)#\s]+)(#[^)\s]*)?\)/g)) {
        const target = m[1]!
        if (/^[a-z]+:/i.test(target)) continue
        if (!existsSync(resolve(dirname(join(DIR, f)), target))) broken.push(`${f} → ${target}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('TC-OPS-04 only what was tested (P8): simulated services named; no assertion of a regulatory result', () => {
    const all = docs.map(text).join('\n')
    expect(text('mailboxes.md')).toMatch(/Microsoft 365[^.]*only against (a )?simulated/i)
    expect(text('mailboxes.md')).toMatch(/Pub\/Sub[^.]*(only )?(against|on) (a )?simulated/i)
    expect(all).not.toMatch(/\b(is|are|be|being)\s+(GDPR[- ])?compliant\b|compliant with|complies with|ensures? compliance|GDPR-compliant/i)
    expect(all).not.toMatch(/docs\/review\//)
    for (const m of all.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) expect(m[1]!, m[0]).toMatch(/\.example$/i)
  })

  it('TC-OPS-04 the DPIA and LIA templates cover every outbound connection and every retention category', () => {
    const dpia = text('dpia-template.md')
    for (const c of ['IMAP', 'gmail.googleapis.com', 'pubsub.googleapis.com', 'oauth2.googleapis.com', 'graph.microsoft.com', 'login.microsoftonline.com', 'model provider', 'S3', 'OIDC', 'Event webhook', 'KYC webhook', 'ClamAV', 'Caddy']) expect(dpia, c).toContain(c)
    for (const r of ['All data of one email', 'Directory versions', 'Audit rows', 'Possible-KYC attachments', 'on hold', 'Demo data', 'Backups']) expect(dpia, r).toContain(r)
    const lia = text('lia-template.md')
    for (const r of ['5 years', 'Audit rows', 'KYC']) expect(lia, r).toContain(r)
  })
})
