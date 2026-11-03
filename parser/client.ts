// Sends one request to the dispatcher from inside the container (used by TC-ING-10 through `docker exec`).
import { request } from 'node:http'
import { readFileSync } from 'node:fs'

export function call(kind: string, body: Buffer, limits: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath: process.env.PARSER_SOCKET ?? '/run/parser/parser.sock', path: '/parse', method: 'POST', headers: { 'x-kind': kind, 'x-limits': JSON.stringify(limits) } }, (res) => {
      const c: Buffer[] = []
      res.on('data', (d: Buffer) => c.push(d))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString('utf8'))))
    })
    r.on('error', reject)
    r.end(body)
  })
}

// argv: a JSON list of {kind, file?, text?, limits}; all are sent at the same time
const jobs = JSON.parse(process.argv[2]!) as Array<{ kind: string; file?: string; b64?: string; limits: Record<string, unknown> }>
const results = await Promise.all(jobs.map((j) => call(j.kind, j.file ? readFileSync(j.file) : Buffer.from(j.b64 ?? '', 'base64'), j.limits)))
process.stdout.write(JSON.stringify(results))
