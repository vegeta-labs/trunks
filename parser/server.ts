// Parser container dispatcher (tech design T7). Listens on a Unix socket in a shared volume; the container itself
// has no network. Each request runs one task in its own bubblewrap sandbox: new mount, PID, IPC, UTS, network and
// user namespaces; it sees only its own input (read-only) and an empty output directory; hard timeout; both are
// deleted afterwards.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { constants, openSync, closeSync } from 'node:fs'

const SECCOMP = process.env.PARSER_SECCOMP ?? '/app/parser/task.bpf'
import { join } from 'node:path'

const SOCKET = process.env.PARSER_SOCKET ?? '/run/parser/parser.sock'
const JOBS = process.env.PARSER_JOBS ?? '/jobs' // tmpfs
const KINDS = new Set(['pdf', 'txt', 'csv', 'eml', 'docx', 'xml'])
// test images only: a task that reports what it can reach from inside the sandbox (TC-ING-10)
const PROBES = process.env.PARSER_TEST_PROBES === '1'
const MAX_BODY = 21 * 1024 * 1024

function runSandboxed(jobDir: string, kind: string, limits: string, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args = [
      '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
      // the task may not create namespaces, mount, or reach other risky kernel paths (self-test WR-F3)
      '--seccomp', '3',
      '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
      '--setenv', 'HOME', '/tmp',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/bin', '/bin',
      '--ro-bind', '/etc/ssl', '/etc/ssl',
      '--ro-bind', '/app', '/app',
      '--ro-bind', join(jobDir, 'in'), '/in',
      '--bind', join(jobDir, 'out'), '/out',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--chdir', '/app',
      ...(kind.startsWith('probe:')
        ? ['node', '--experimental-strip-types', '--no-warnings', 'parser/probe.ts', kind.slice(6), limits]
        : ['node', '--experimental-strip-types', '--no-warnings', '--max-old-space-size=512', 'parser/task-main.ts', '/in/input', '/out/result.json', kind, limits]),
    ]
    const filter = openSync(SECCOMP, 'r')
    const p = spawn('bwrap', args, { stdio: ['ignore', 'ignore', 'pipe', filter], detached: true })
    closeSync(filter)
    let timedOut = false
    const t = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-p.pid!, 'SIGKILL') // the whole process group
      } catch {
        p.kill('SIGKILL')
      }
    }, timeoutMs)
    p.stderr?.on('data', (d: Buffer) => process.stderr.write(d.subarray(0, 2000)))
    p.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, timedOut })
    })
  })
}

const MAX_RESULT = 64 * 1024 * 1024

/** The task's result: a regular file, not a symlink planted by the task (self-test WR-F7), with a size cap. */
async function readResult(path: string): Promise<string | null> {
  let fh
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = await fh.stat()
    if (!st.isFile() || st.size > MAX_RESULT) return null
    return await fh.readFile('utf8')
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

const server = createServer(async (req, res) => {
  const send = (code: number, o: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(o))
  }
  if (req.method !== 'POST' || req.url !== '/parse') return send(404, { error: 'not found' })
  const kind = String(req.headers['x-kind'] ?? '')
  if (!KINDS.has(kind) && !(PROBES && kind.startsWith('probe:'))) return send(200, { status: 'not_parsed', reason: 'type', text: '', facts: {} })
  let limits: { timeoutMs: number }
  try {
    limits = JSON.parse(String(req.headers['x-limits'] ?? '')) as { timeoutMs: number }
  } catch {
    return send(400, { error: 'bad limits' })
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) return send(413, { error: 'too large' })
    chunks.push(c as Buffer)
  }
  const jobDir = await mkdtemp(join(JOBS, 'job-'))
  try {
    await mkdir(join(jobDir, 'in'))
    await mkdir(join(jobDir, 'out'))
    // the sandbox sees /in read-only (bind), so the file itself needs no special mode
    await writeFile(join(jobDir, 'in', 'input'), Buffer.concat(chunks), { mode: 0o600 })
    const r = await runSandboxed(jobDir, kind, kind.startsWith('probe:') ? String((limits as { arg?: string }).arg ?? '') : JSON.stringify(limits), Math.max(1000, Math.min(limits.timeoutMs, 300_000)))
    if (r.timedOut) return send(200, { status: 'failed', reason: 'timeout', text: '', facts: {}, timedOut: true })
    const out = await readResult(join(jobDir, 'out', 'result.json'))
    if (r.code !== 0 || out === null) return send(200, { status: 'failed', reason: `sandbox exit ${r.code}`, text: '', facts: {} })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(out)
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch((e: Error) => console.error(`cleanup failed: ${e.message}`))
  }
})

await rm(SOCKET, { force: true })
server.listen(SOCKET, () => console.log(`parser listening on ${SOCKET}`))
