// Test-only task kinds used by TC-ING-10 to check the sandbox from the inside. Built into the test image only.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'

const [, , mode, arg] = process.argv
const out: Record<string, unknown> = {}
const tryIt = async (name: string, fn: () => unknown) => {
  try {
    out[name] = { ok: true, value: await fn() }
  } catch (e) {
    out[name] = { ok: false, error: (e as Error).message.slice(0, 120) }
  }
}
if (mode === 'probe') {
  await tryIt('env', () => Object.keys(process.env).sort())
  await tryIt('network', () => new Promise((res, rej) => { const s = connect({ host: '1.1.1.1', port: 53, timeout: 2000 }); s.on('connect', () => { s.destroy(); res('connected') }); s.on('error', rej); s.on('timeout', () => rej(new Error('timeout'))) }))
  await tryIt('write_root', () => writeFileSync('/app/pwned', 'x'))
  await tryIt('write_in', () => writeFileSync('/in/input2', 'x'))
  await tryIt('jobs_dir', () => readdirSync('/jobs'))
  await tryIt('other_job', () => readFileSync(arg!))
  await tryIt('proc_1_environ', () => readFileSync('/proc/1/environ', 'utf8').length)
  await tryIt('uid', () => process.getuid?.())
  // a new user (and network) namespace must be refused by the seccomp filter
  await tryIt('unshare', () => {
    const r = spawnSync('unshare', ['-U', '-n', 'true'])
    if (r.status !== 0) throw new Error(`refused (${r.status})`)
    return 'created'
  })
  writeFileSync('/out/result.json', JSON.stringify({ status: 'parsed', text: JSON.stringify(out), facts: {} }))
}
if (mode === 'hold') {
  // keep the sandbox alive for a while so another task can try to reach this one's files
  await new Promise((r) => setTimeout(r, Number(arg ?? 2000)))
  writeFileSync('/out/result.json', JSON.stringify({ status: 'parsed', text: 'held', facts: {} }))
}
if (mode === 'spin') {
  for (;;) {
    // never ends: the dispatcher must kill it at the timeout
  }
}
