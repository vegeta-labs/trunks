// PRD C-LNK-3: name similarity. Copied from Goten src/lib/reconcile.ts (C-REC-3, same author).

const STOP = new Set(['MR', 'MRS', 'MS', 'DR', 'LTD', 'LIMITED', 'LLP', 'PLC', 'AND', 'THE'])
export const nameTokens = (s: string) =>
  s
    .replace(/[a-z]/g, (c) => c.toUpperCase())
    // oxlint-disable-next-line no-control-regex -- ASCII control characters separate words by rule (C-LNK-3)
    .replace(/[\x00-\x40\x5B-\x60\x7B-\x7F]+/g, ' ') // ASCII non-letters separate words; non-ASCII counts as a letter
    .split(' ')
    .filter((t) => t && !STOP.has(t))

// compare by code point, not UTF-16 unit, so letters outside the basic plane work
const cp = (s: string) => Array.from(s)
const pairs = (a: string, b: string) => {
  const A = cp(a)
  const B = cp(b)
  return a === b || (A.length === 1 && B[0] === A[0]) || (B.length === 1 && A[0] === B[0])
}

/** Maximum one-to-one matching as an exact ratio matched / of; of = 0 means similarity 0. */
export function nameMatch(x: string, y: string): { matched: number; of: number } {
  const A = nameTokens(x)
  const B = nameTokens(y)
  if (!A.length || !B.length) return { matched: 0, of: 0 }
  const matchOfB: number[] = B.map(() => -1)
  const tryAssign = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < B.length; j++) {
      if (seen[j] || !pairs(A[i]!, B[j]!)) continue
      seen[j] = true
      if (matchOfB[j] === -1 || tryAssign(matchOfB[j]!, seen)) {
        matchOfB[j] = i
        return true
      }
    }
    return false
  }
  let matched = 0
  for (let i = 0; i < A.length; i++) if (tryAssign(i, B.map(() => false))) matched++
  return { matched, of: Math.max(A.length, B.length) }
}

export function nameSimilarity(x: string, y: string): number {
  const { matched, of } = nameMatch(x, y)
  return of === 0 ? 0 : matched / of
}

/** Similarity exactly 1 (C-SIG-1.3). */
export const sameName = (x: string, y: string) => {
  const { matched, of } = nameMatch(x, y)
  return of > 0 && matched === of
}
