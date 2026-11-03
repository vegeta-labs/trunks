// C-AUD-4 daily chain-head export (TC-AUD-07; M-05 F5): the directory is created when missing; a failure is reported
// once until it changes or the export works again, instead of on every attempt (or never, after the first).
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function headExporter(head: () => Promise<unknown>, path: string, report: (line: string) => void = console.error): () => Promise<void> {
  let lastError: string | null = null
  return async () => {
    try {
      const h = await head()
      if (!h) return
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(h)}\n`)
      if (lastError) report(`chain head export works again: ${path}`)
      lastError = null
    } catch (e) {
      const m = (e as Error).message
      if (m !== lastError) report(`chain head export failed: ${m}`)
      lastError = m
    }
  }
}
