// Virus scan through clamd (tech design T7): INSTREAM over TCP to the separate ClamAV container.
import { connect } from 'node:net'

export type ScanResult = { clean: true } | { clean: false; signature: string }

export interface Scanner {
  scan(data: Buffer): Promise<ScanResult>
}

export class Clamd implements Scanner {
  private readonly host: string
  private readonly port: number
  private readonly timeoutMs: number
  constructor(host: string, port: number, timeoutMs = 60_000) {
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
  }

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const s = connect({ host: this.host, port: this.port })
      const chunks: Buffer[] = []
      s.setTimeout(this.timeoutMs, () => s.destroy(new Error('clamd timeout')))
      s.on('error', reject)
      s.on('data', (d) => chunks.push(d))
      s.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()
        if (/:\s*OK$/.test(reply)) resolve({ clean: true })
        else {
          const m = /:\s*(.+) FOUND$/.exec(reply)
          if (m) resolve({ clean: false, signature: m[1]! })
          else reject(new Error(`clamd: ${reply.slice(0, 200)}`)) // e.g. size limit exceeded: retried, then the Case fails
        }
      })
      s.on('connect', () => {
        s.write('zINSTREAM\0')
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024)
          const len = Buffer.alloc(4)
          len.writeUInt32BE(chunk.length)
          s.write(len)
          s.write(chunk)
        }
        s.end(Buffer.alloc(4))
      })
    })
  }
}
