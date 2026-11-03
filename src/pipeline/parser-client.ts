// Client for the parser container (tech design T7). The container listens on a Unix socket in a shared volume and runs
// every task in its own bubblewrap sandbox. InProcessParser runs the same task code directly (tests, demo).
import { request } from 'node:http'
import { runTask, type TaskLimits, type TaskResult } from '../../parser/task.ts'
import type { AttachmentKind } from '../ingest/mime.ts'

export interface ParserClient {
  parse(kind: AttachmentKind, bytes: Buffer, limits: TaskLimits, timeoutMs: number): Promise<TaskResult & { timedOut?: boolean }>
}

export class InProcessParser implements ParserClient {
  async parse(kind: AttachmentKind, bytes: Buffer, limits: TaskLimits, timeoutMs: number) {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<TaskResult & { timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'failed', reason: 'timeout', text: '', facts: {}, timedOut: true }), timeoutMs)
    })
    try {
      return await Promise.race([runTask(kind, bytes, limits), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}

const STATUSES = new Set(['parsed', 'not_parsed', 'over_limit', 'failed'])

/** A result from the container is data from a sandbox that may be compromised: check its shape before use. */
export function checkResult(v: unknown): TaskResult & { timedOut?: boolean } {
  const r = v as Partial<TaskResult> & { timedOut?: unknown }
  if (!r || typeof r !== 'object' || !STATUSES.has(r.status as string) || typeof r.text !== 'string' || typeof r.facts !== 'object' || r.facts === null) {
    throw new Error('parser returned an invalid result')
  }
  return { status: r.status!, text: r.text, facts: r.facts, ...(r.reason === undefined ? {} : { reason: String(r.reason) }), ...(r.timedOut === true ? { timedOut: true } : {}) }
}

export class SocketParser implements ParserClient {
  private readonly socketPath: string
  constructor(socketPath: string) {
    this.socketPath = socketPath
  }
  parse(kind: AttachmentKind, bytes: Buffer, limits: TaskLimits, timeoutMs: number): Promise<TaskResult & { timedOut?: boolean }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { socketPath: this.socketPath, path: '/parse', method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-kind': kind, 'x-limits': JSON.stringify({ ...limits, timeoutMs }) } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (d: Buffer) => chunks.push(d))
          res.on('end', () => {
            try {
              resolve(checkResult(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
            } catch (e) {
              reject(e)
            }
          })
        },
      )
      req.setTimeout(timeoutMs + 10_000, () => req.destroy(new Error('parser did not answer')))
      req.on('error', reject)
      req.end(bytes)
    })
  }
}
