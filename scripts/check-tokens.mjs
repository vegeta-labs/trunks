// UI design rules §11.2 (docs/09_UI_DESIGN.md): tokens.css is shared word for word by the Toolkit app and this review UI
// (the website keeps its own styles, v0.3). Its SHA-256 must equal the one the rules record; change the rules first, then every copy.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const rules = readFileSync('docs/09_UI_DESIGN.md', 'utf8')
const want = /当前 `tokens\.css` 的 SHA-256：\*\* `([0-9a-f]{64})`/.exec(rules)?.[1]
const have = createHash('sha256').update(readFileSync('src/web/tokens.css')).digest('hex')
if (!want) {
  console.error('docs/09_UI_DESIGN.md §11.2 records no tokens.css hash')
  process.exit(1)
}
if (want !== have) {
  console.error(`src/web/tokens.css differs from the shared design variables (docs/09_UI_DESIGN.md §11.2)\n  recorded ${want}\n  file     ${have}\nChange the rules first (§10), then both copies.`)
  process.exit(1)
}
console.log('tokens.css matches the shared design variables')
