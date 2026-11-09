// Evaluation annotations (eval/SCHEMA.md, test plan §4, TC-EVAL-01): the JSON Schema plus the semantic checks the
// schema cannot express. Usage: node --experimental-strip-types --no-warnings eval/validate.ts <dir> [<dir> …]
// (a directory of <id>.json annotations; `twin_of` is resolved across all directories given).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from './metrics.ts'
import Ajv2020Module from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'

// CommonJS packages: under Node's ESM loader the default import is the module object
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as typeof Ajv2020Module.default
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as typeof addFormatsModule.default

const HERE = new URL('.', import.meta.url).pathname
const PRD = readFileSync(join(HERE, '../docs/01_PRD.md'), 'utf8')

/** PRD §3.1 «主要字段» per class: the field table each annotation must list in full. */
export function classFields(prd = PRD): Map<string, string[]> {
  const section = prd.slice(prd.indexOf('### 3.1'), prd.indexOf('### 3.2'))
  const out = new Map<string, string[]>()
  for (const line of section.split('\n')) {
    const m = /^\| `([a-z_]+)` \|(?:[^|]*\|){3}([^|]*)\|/.exec(line)
    // `document_types[]` (a list) and `confirms (yes/no/question)` (with its values) name the fields document_types and confirms
    if (m) out.set(m[1]!, m[2]!.split(',').map((f) => f.replace(/\(.*?\)/g, '').replace('[]', '').trim()).filter((f) => /^[a-z_0-9]+$/.test(f)))
  }
  return out
}

const isCalendarDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return true
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!))
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!
}

// PRD §6 comparison: money by minor units and currency, text NFKC + lower case + collapsed white space, arrays as sets
function key(v: unknown): string {
  if (typeof v === 'string') return `s:${v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}`
  if (Array.isArray(v)) return `a:${JSON.stringify(v.map(key).sort())}`
  if (v && typeof v === 'object' && 'minor' in v && 'currency' in v) return `m:${(v as { minor: number }).minor}:${(v as { currency: string }).currency}`
  return `j:${canonicalJson(v)}`
}

function strings(v: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof v === 'string') out.push([path, v])
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, `${path}.${k}`, out)
}

type Annotation = { id: string; classes: string[]; fields: Record<string, unknown>; twin_of: string | null; malicious_type: string | null }

export function validate(dirs: string[]): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  const check = ajv.compile(JSON.parse(readFileSync(join(HERE, 'annotation.schema.json'), 'utf8')))
  const fieldsOf = classFields()
  const all = new Map<string, { file: string; a: Annotation }>()
  const errors: string[] = []
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((x) => /^E\d+\.json$/.test(x)).sort()) {
      const file = join(dir, f)
      let a: Annotation
      try {
        a = JSON.parse(readFileSync(file, 'utf8'))
      } catch (e) {
        errors.push(`${file}: not JSON (${(e as Error).message})`)
        continue
      }
      if (!check(a)) for (const e of check.errors ?? []) errors.push(`${file}: schema ${e.instancePath || '/'} ${e.message}`)
      if (a.id !== f.replace(/\.json$/, '')) errors.push(`${file}: id ${a.id} does not match the file name`)
      if (all.has(a.id)) errors.push(`${file}: duplicate id ${a.id} (also ${all.get(a.id)!.file})`)
      all.set(a.id, { file, a })
      const ss: Array<[string, string]> = []
      strings(a, '', ss)
      for (const [p, s] of ss) if (/^\d{4}-\d{2}-\d{2}/.test(s) && !isCalendarDate(s)) errors.push(`${file}: ${p} ${s} is not a calendar date`)
      for (const [name, v] of Object.entries(a.fields ?? {})) {
        if (v && typeof v === 'object' && 'multiple' in v) {
          const n = new Set((v as { multiple: unknown[] }).multiple.map(key)).size
          if (n < 2) errors.push(`${file}: fields.${name} multiple has ${n} distinct value(s) after PRD §6 comparison`)
        }
      }
      for (const c of a.classes ?? []) {
        const want = fieldsOf.get(c)
        if (!want) continue
        for (const fld of want) if (!(fld in (a.fields ?? {}))) errors.push(`${file}: class ${c} needs field ${fld}`)
      }
    }
  }
  for (const { file, a } of all.values()) {
    if (a.twin_of === null || a.twin_of === undefined) continue
    const t = all.get(a.twin_of)
    if (!t) errors.push(`${file}: twin_of ${a.twin_of} not found`)
    else if (t.a.malicious_type !== 'prompt_injection') errors.push(`${file}: twin_of ${a.twin_of} is not a prompt_injection sample`)
  }
  return errors
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2)
  if (!dirs.length) {
    console.error('usage: eval/validate <annotation dir> [...]')
    process.exit(2)
  }
  const errors = validate(dirs)
  for (const e of errors) console.error(e)
  console.log(errors.length ? `${errors.length} problem(s)` : 'all annotations valid')
  process.exit(errors.length ? 1 : 0)
}
