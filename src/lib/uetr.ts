// PRD C-EXT-1: UETR candidates are 8-4-4-4-12 hex groups; only UUID version 4 (variant 8/9/a/b) counts.

export interface UetrResult {
  uetrs: string[] // lower case, distinct, in order of first appearance
  invalid: string[] // `uetr_candidate_invalid`
  multiple: boolean
  hits: Array<{ value: string; valid: boolean; start: number; end: number }>
}

const H = '[0-9A-Fa-f]'
// Not directly after a letter, digit or hyphen, unless after one of the allowed prefixes (`UETR`, `UETR:`, `121:`).
const CANDIDATE = new RegExp(
  `(?:(?<![\\p{L}\\p{N}-])|(?<=(?<![\\p{L}\\p{N}])UETR))(${H}{8}-${H}{4}-${H}{4}-${H}{4}-${H}{12})(?![\\p{L}\\p{N}-])`,
  'giu',
)

export function extractUetrs(t: string): UetrResult {
  const uetrs: string[] = []
  const invalid: string[] = []
  const hits: UetrResult['hits'] = []
  for (const m of t.matchAll(CANDIDATE)) {
    const value = m[1]!.toLowerCase()
    const hex = value.replace(/-/g, '')
    const valid = hex[12] === '4' && '89ab'.includes(hex[16]!)
    hits.push({ value, valid, start: m.index, end: m.index + m[0].length })
    const list = valid ? uetrs : invalid
    if (!list.includes(value)) list.push(value)
  }
  return { uetrs, invalid, multiple: uetrs.length > 1, hits }
}

export const isUetr = (s: string) => {
  const r = extractUetrs(s)
  return r.hits.length === 1 && r.hits[0]!.valid && r.hits[0]!.start === 0 && r.hits[0]!.end === s.length
}
