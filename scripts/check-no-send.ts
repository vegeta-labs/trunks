// CLI for the no-send static check (TC-OUT-09). Scans every non-test source file under src/ and parser/.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ADAPTER_MEMBERS, checkAllowList, mailboxAdapterMembers, scanDirectRequests, scanPackageJson, scanSource, type Finding } from './no-send.ts'
import { MAIL_HTTP_ALLOW } from '../src/adapters/mailbox/http.ts'

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : files(p)
    return /\.(ts|tsx|mts|js|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
  })
}

const sources = ['src', 'parser'].flatMap(files)
const findings: Finding[] = [
  ...sources.filter((f) => !f.endsWith('.fake.ts')).flatMap((f) => scanSource(f, readFileSync(f, 'utf8'))),
  ...sources.flatMap((f) => scanDirectRequests(f, readFileSync(f, 'utf8'))),
  ...checkAllowList(MAIL_HTTP_ALLOW).map((rule) => ({ file: 'src/adapters/mailbox/http.ts', line: 0, rule })),
  ...scanPackageJson(readFileSync('package.json', 'utf8')),
]
const iface = 'src/adapters/mailbox/types.ts'
const members = mailboxAdapterMembers(readFileSync(iface, 'utf8'))
if (!members || members.join() !== ADAPTER_MEMBERS.join()) findings.push({ file: iface, line: 0, rule: `MailboxAdapter members must be exactly ${ADAPTER_MEMBERS.join(', ')} (found ${members?.join(', ') ?? 'none'})` })
for (const f of findings) console.log(`${f.file}:${f.line} ${f.rule}`)
console.log(findings.length ? `no-send check FAILED (${findings.length})` : 'no-send check passed')
process.exit(findings.length ? 1 : 0)
