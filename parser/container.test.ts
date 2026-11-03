import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { makeDocx, makePdf } from './testfiles.ts'

// TC-ING-10 runs the real parser image (built by CI before the tests: docker build -f parser/Dockerfile .)
const IMAGE = process.env.PARSER_IMAGE ?? 'doi-parser-test'
const NAME = `doi-parser-tc10-${process.pid}`
// the parser's security options exactly as docker-compose.yml runs it (TC-OPS-02, plan review R8): no `unconfined`
const COMPOSE = parse(readFileSync('docker-compose.yml', 'utf8')) as { services: { parser: { security_opt: string[] } } }
export const SECURITY = COMPOSE.services.parser.security_opt.flatMap((o) => ['--security-opt', o.startsWith('seccomp=') ? `seccomp=${resolve(o.slice(8))}` : o])
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 26 })
const LIMITS = { maxPdfPages: 50, maxNesting: 3, maxAttachmentBytes: 20 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024, timeoutMs: 30_000 }
const send = (jobs: Array<{ kind: string; b64?: string; limits: Record<string, unknown> }>) =>
  JSON.parse(docker('exec', NAME, 'node', '--experimental-strip-types', '--no-warnings', 'parser/client.ts', JSON.stringify(jobs))) as Array<{ status: string; reason?: string; text: string; timedOut?: boolean }>

beforeAll(() => {
  docker('run', '-d', '--name', NAME, '--network', 'none', '--read-only', '--cap-drop', 'ALL', ...SECURITY,
    '--pids-limit', '256', '--memory', '1g', '--tmpfs', '/jobs:size=200m,mode=1777', '--tmpfs', '/tmp', '--tmpfs', '/run/parser:mode=1777',
    '-e', 'PARSER_TEST_PROBES=1', '-e', 'DOI_HMAC_KEY=leak-me-secret', IMAGE)
  for (let i = 0; i < 50; i++) {
    if (docker('logs', NAME).includes('listening')) return
    execFileSync('sleep', ['0.2'])
  }
  throw new Error('parser container did not start')
}, 60_000)
afterAll(() => {
  docker('rm', '-f', NAME)
})

describe('parser container (tech design T7)', () => {
  it('TC-ING-10 no network, no secrets, read-only root, no view of other tasks, files removed, macro DOCX gives text only, hard timeout', () => {
    // a task holding its sandbox open while another probes from inside its own
    const [held, probe] = send([
      { kind: 'probe:hold', limits: { timeoutMs: 10_000, arg: '1500' } },
      { kind: 'probe:probe', limits: { timeoutMs: 10_000, arg: '/jobs' } },
    ])
    expect(held!.text, `container log:\n${docker('logs', NAME)}`).toBe('held')
    const p = JSON.parse(probe!.text) as Record<string, { ok: boolean; value?: unknown; error?: string }>
    expect(p.env!.value).toEqual(['HOME', 'PATH', 'PWD']) // no DOI_HMAC_KEY, no other variable
    expect(p.network!.ok).toBe(false)
    expect(p.write_root!.ok).toBe(false)
    expect(p.write_in!.ok).toBe(false)
    expect(p.jobs_dir!.ok).toBe(false) // other tasks' inputs and outputs are not even visible
    expect(p.other_job!.ok).toBe(false)
    expect(p.proc_1_environ!.ok).toBe(false)
    expect(p.uid!.value).not.toBe(0)
    expect(p.unshare!.ok, JSON.stringify(p.unshare)).toBe(false) // no new namespaces inside a task (self-test WR-F3)
    // the dispatcher deletes every job directory
    expect(docker('exec', NAME, 'sh', '-c', 'ls -A /jobs | wc -l').trim()).toBe('0')
    // real parsing through the sandbox
    const [docx, pdf] = send([
      { kind: 'docx', b64: makeDocx(['Payment of GBP 5,000.00', 'ref NW-001'], true).toString('base64'), limits: LIMITS },
      { kind: 'pdf', b64: makePdf(['Statement page one']).toString('base64'), limits: LIMITS },
    ])
    expect(docx).toMatchObject({ status: 'parsed', text: 'Payment of GBP 5,000.00\nref NW-001' })
    expect(pdf).toMatchObject({ status: 'parsed' })
    expect(pdf!.text).toContain('Statement page one')
    // a task that never ends is killed at the timeout and cleaned up
    const t0 = Date.now()
    const [spin] = send([{ kind: 'probe:spin', limits: { timeoutMs: 2000 } }])
    expect(spin).toMatchObject({ status: 'failed', reason: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(docker('exec', NAME, 'sh', '-c', 'ls -A /jobs | wc -l').trim()).toBe('0')
    // nothing was written into the container's root
    expect(() => docker('exec', NAME, 'sh', '-c', 'touch /app/x')).toThrow()
  }, 120_000)
})
