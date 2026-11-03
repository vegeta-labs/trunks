// TC-OPS-02 (tech design T7, v0.7.11): the parser's dedicated seccomp and AppArmor profiles, never `unconfined`.
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

const compose = readFileSync('docker-compose.yml', 'utf8')
// set by the Ubuntu 24.04 CI job after `apparmor_parser -r -W deploy/apparmor/doi-parser`
const APPARMOR = process.env.PARSER_APPARMOR === '1'

describe('parser profiles', () => {
  it('TC-OPS-02 compose never runs anything unconfined; the parser uses the generated seccomp profile and doi-parser', () => {
    expect(compose).not.toMatch(/unconfined/)
    expect(compose).toMatch(/- seccomp=deploy\/parser-seccomp\.json/)
    expect(compose).toMatch(/- apparmor=doi-parser/)
    // the committed profile is exactly what the generator makes from the vendored Docker default
    expect(() => execFileSync('node', ['scripts/gen-parser-seccomp.mjs', '--check'], { encoding: 'utf8' })).not.toThrow()
    const p = JSON.parse(readFileSync('deploy/parser-seccomp.json', 'utf8')) as { defaultAction: string; syscalls: Array<{ names: string[]; action: string }> }
    expect(p.defaultAction).toBe('SCMP_ACT_ERRNO')
    const extra = p.syscalls.at(-1)!
    expect(extra.names).toEqual(['clone', 'unshare', 'mount', 'umount2', 'pivot_root'])
  })

  it.runIf(APPARMOR)('TC-OPS-02 on an AppArmor host: enabled, doi-parser loaded, an unloaded profile stops the container from starting', () => {
    expect(readFileSync('/sys/module/apparmor/parameters/enabled', 'utf8').trim()).toBe('Y')
    // loaded: a container under it starts (the CI step checked `aa-status` for enforce mode)
    expect(spawnSync('docker', ['run', '--rm', '--security-opt', 'apparmor=doi-parser', 'alpine:3.20', 'true']).status).toBe(0)
    const r = spawnSync('docker', ['run', '--rm', '--security-opt', 'apparmor=doi-parser-not-loaded', 'alpine:3.20', 'true'], { encoding: 'utf8' })
    expect(r.status).not.toBe(0)
  })

  it.runIf(APPARMOR)('TC-OPS-02 / TC-ING-10 the dispatcher itself cannot mount a fresh filesystem over / or over its own files (Codex E5 F3)', () => {
    const SECURITY = (parse(compose) as { services: { parser: { security_opt: string[] } } }).services.parser.security_opt.flatMap((o) => ['--security-opt', o.startsWith('seccomp=') ? `seccomp=${resolve(o.slice(8))}` : o])
    const probe = (target: string) =>
      // the profiles are per container, not per image: alpine has the mount tool the parser image lacks (busybox)
      spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', ...SECURITY, '--user', '10001:10001', 'alpine:3.20',
        'sh', '-c', `unshare -r -m sh -c 'mount -t tmpfs none ${target} && echo MOUNTED' 2>&1`], { encoding: 'utf8' })
    for (const target of ['/', '/etc', '/usr']) {
      const r = probe(target)
      expect(r.stdout, `${target}: ${r.stdout}${r.stderr}`).not.toMatch(/MOUNTED/)
      expect(r.stdout, `${target}: ${r.stdout}${r.stderr}`).toMatch(/permission denied|not permitted/i)
    }
  })
})

