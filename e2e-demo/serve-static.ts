// Serves the static demo snapshot (dist-demo) the way the Deal Ops website does, for TC-DEMO-04: with the site's
// Content-Security-Policy (connect-src 'none': the page may make no fetch or XHR at all; site interface T1).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? 'dist-demo')
const port = Number(process.argv[3] ?? 4318)
export const SITE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain' }
createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]!)
  const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path))
  if (!file.startsWith(root)) {
    res.writeHead(403).end()
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'content-security-policy': SITE_CSP }).end(body)
  } catch {
    res.writeHead(404).end()
  }
}).listen(port, '127.0.0.1', () => console.log(`static demo on http://127.0.0.1:${port}/`))
