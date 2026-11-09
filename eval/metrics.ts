// PRD §6 metrics enabled at E2: classification macro F1, rule fields, field recall, field precision, empty fields.
// Pure functions over annotations (eval/SCHEMA.md) and the system's per-sample output.

export type AnnValue = null | string | boolean | string[] | { minor: number; currency: string } | { multiple: AnnValue[] } | { void: string }

export interface Annotation {
  id: string
  classes: string[]
  fields: Record<string, AnnValue>
  rule_output: { uetrs: string[]; uetr_candidates_invalid: string[]; amounts: Array<{ minor: number; currency: string }>; references: string[]; account_last4: string[]; evidence_value_dates: string[] }
}

export interface SystemField {
  status: 'ok' | 'void' | 'multiple' | 'conflict'
  value: unknown // already mapped for comparison: deal key → deal name, placeholders restored
  candidates: unknown[]
  reason?: string | null // diagnostics only
}

export interface SystemOutput {
  id: string
  adopted: string[]
  ruleOutput: Annotation['rule_output']
  fields: Record<string, SystemField>
}

/** JSON with object keys in sorted order: PRD §6 compares by value, so `{currency, minor}` equals `{minor, currency}`. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

// PRD §6 comparison: money by minor units and currency, dates by ISO, enums by value, arrays as sets, text NFKC + lower case + collapsed white space
export function key(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return `s:${v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}`
  if (typeof v === 'boolean') return `b:${v}`
  if (Array.isArray(v)) return `a:${JSON.stringify([...new Set(v.map(key))].sort())}`
  if (typeof v === 'object' && 'minor' in v && 'currency' in v) return `m:${(v as { minor: number }).minor}:${(v as { currency: string }).currency}`
  return `j:${canonicalJson(v)}`
}
const keySet = (vs: unknown[]) => JSON.stringify([...new Set(vs.map(key))].sort())
// rule output «逐项相等» (PRD §6): exact values, lists as sets — no case or white-space folding (EV-F4)
export const exactSet = (vs: unknown[]) => JSON.stringify([...new Set(vs.map((v) => canonicalJson(v)))].sort())

const isMultiple = (v: AnnValue): v is { multiple: AnnValue[] } => typeof v === 'object' && v !== null && !Array.isArray(v) && 'multiple' in v
const isVoid = (v: AnnValue): v is { void: string } => typeof v === 'object' && v !== null && !Array.isArray(v) && 'void' in v
const hasValue = (s: SystemField | undefined) => !!s && (s.status === 'multiple' || ((s.status === 'ok' || s.status === 'conflict') && s.value !== null))

/** Whether the system field equals the annotated value (recall and precision both use it). */
export function fieldCorrect(ann: AnnValue, sys: SystemField | undefined): boolean {
  if (ann === null) return !hasValue(sys) // an empty annotation: no value given
  if (!sys) return false
  if (isVoid(ann)) return sys.status === 'void'
  if (isMultiple(ann)) return sys.status === 'multiple' && keySet(sys.candidates) === keySet(ann.multiple)
  return (sys.status === 'ok' || sys.status === 'conflict') && key(sys.value) === key(ann)
}

export type Metric = { value: number | null; numerator: number; denominator: number } // null = not applicable (PRD §6)
const ratio = (n: number, d: number): Metric => ({ value: d === 0 ? null : n / d, numerator: n, denominator: d })

export interface Report {
  classification: Metric & { perClass: Record<string, { f1: number; tp: number; fp: number; fn: number }> }
  ruleFields: Metric & { failures: Array<{ id: string; item: string; expected: unknown; actual: unknown }> }
  fieldRecall: Metric
  fieldPrecision: Metric
  emptyFields: Metric
  fieldFailures: Array<{ id: string; field: string; expected: AnnValue; actual: SystemField | null }>
}

export function score(anns: Annotation[], outs: SystemOutput[], classFloors: Record<string, 'low' | 'medium' | 'high'>): Report {
  const byId = new Map(outs.map((o) => [o.id, o]))
  // classification: binary F1 per class whose risk floor is not high (not unclassified, only classes with positives)
  const perClass: Report['classification']['perClass'] = {}
  for (const [c, floor] of Object.entries(classFloors)) {
    if (floor === 'high' || c === 'unclassified') continue
    let tp = 0, fp = 0, fn = 0
    for (const a of anns) {
      const want = a.classes.includes(c)
      const got = byId.get(a.id)?.adopted.includes(c) ?? false
      if (want && got) tp++
      else if (got) fp++
      else if (want) fn++
    }
    if (tp + fn === 0) continue
    perClass[c] = { f1: tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn), tp, fp, fn }
  }
  const f1s = Object.values(perClass).map((x) => x.f1)
  const classification = { value: f1s.length ? f1s.reduce((s, x) => s + x, 0) / f1s.length : null, numerator: f1s.length, denominator: f1s.length, perClass }

  // rule fields: the complete rule output equals the annotation, item by item, lists as sets
  const ruleFailures: Report['ruleFields']['failures'] = []
  let ruleOk = 0
  for (const a of anns) {
    const o = byId.get(a.id)
    let ok = !!o
    for (const item of Object.keys(a.rule_output) as Array<keyof Annotation['rule_output']>) {
      const exp = a.rule_output[item]
      const act = o?.ruleOutput[item] ?? []
      if (exactSet(exp) !== exactSet(act)) {
        ok = false
        ruleFailures.push({ id: a.id, item, expected: exp, actual: act })
      }
    }
    if (ok) ruleOk++
  }

  // fields
  let recallN = 0, recallD = 0, precN = 0, precD = 0, emptyN = 0, emptyD = 0
  const fieldFailures: Report['fieldFailures'] = []
  for (const a of anns) {
    const o = byId.get(a.id)
    const names = new Set([...Object.keys(a.fields), ...Object.keys(o?.fields ?? {})])
    for (const f of names) {
      const listed = f in a.fields
      const ann = a.fields[f] ?? null
      const sys = o?.fields[f]
      const correct = fieldCorrect(ann, sys)
      if (ann !== null) {
        recallD++
        if (correct) recallN++
      } else if (listed) {
        // «标注为 null 的字段»: only fields the annotation lists as null; a field of a class the annotation does not have
        // counts against precision below (and the class against classification), not here
        emptyD++
        if (correct) emptyN++
      }
      if (hasValue(sys)) {
        precD++
        if (correct) precN++
      }
      if (!correct) fieldFailures.push({ id: a.id, field: f, expected: ann, actual: sys ?? null })
    }
  }
  return {
    classification,
    ruleFields: { ...ratio(ruleOk, anns.length), failures: ruleFailures },
    fieldRecall: ratio(recallN, recallD),
    fieldPrecision: ratio(precN, precD),
    emptyFields: ratio(emptyN, emptyD),
    fieldFailures,
  }
}

/** PRD §6 thresholds of the metrics enabled at E2; a metric that is not applicable does not fail. */
export const E2_THRESHOLDS = { classification: 0.85, ruleFields: 1, fieldRecall: 0.9, fieldPrecision: 0.9, emptyFields: 0.95 } as const

export function failures(r: Report): string[] {
  const out: string[] = []
  for (const [name, min] of Object.entries(E2_THRESHOLDS)) {
    const m = r[name as keyof typeof E2_THRESHOLDS]
    if (m.value !== null && m.value < min) out.push(`${name} ${m.value.toFixed(3)} < ${min}`)
  }
  return out
}
