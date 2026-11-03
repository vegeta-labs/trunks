// PRD C-EXT-2: payment references. Copied from Deal Ops Toolkit src/lib/reconcile.ts (C-REC-1, C-REC-2, same author)
// so both projects match references the same way.

// Only a–z are upper-cased; other letters (É, ß) stay as they are and still count as letters.
const upperAscii = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase())
// Separators are ASCII characters other than A–Z, a–z, 0–9; every non-ASCII character belongs to a token.
// oxlint-disable-next-line no-control-regex -- ASCII control characters are separators by rule (C-EXT-2)
const SEP = /[\x00-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/
export const normRef = (s: string) => upperAscii(s).split(SEP).join('')
const tokens = (s: string) => upperAscii(s).split(SEP).filter(Boolean)

/** All concatenations of 1–3 adjacent tokens. */
export function tokenRuns(s: string): string[] {
  const t = tokens(s)
  const out: string[] = []
  for (let i = 0; i < t.length; i++) for (let n = 1; n <= 3 && i + n <= t.length; n++) out.push(t.slice(i, i + n).join(''))
  return out
}

/** C-EXT-2 with positions: every run of 1–3 adjacent tokens equal to a known reference (R-EXT-02). */
export function findReferences(text: string, known: readonly string[]): Array<{ value: string; start: number; end: number }> {
  const toks: Array<{ t: string; start: number; end: number }> = []
  // oxlint-disable-next-line no-control-regex -- ASCII control characters are separators by rule (C-EXT-2)
  for (const m of text.matchAll(/[^\x00-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g)) toks.push({ t: upperAscii(m[0]), start: m.index, end: m.index + m[0].length })
  // every distinct imported spelling with that normalised form matches, as in matchReferences (Codex round 2 N3)
  const want = new Map<string, string[]>()
  for (const ref of known) {
    const n = normRef(ref)
    if (n === '') continue
    const list = want.get(n) ?? []
    if (!list.includes(ref)) want.set(n, [...list, ref])
  }
  const out: Array<{ value: string; start: number; end: number }> = []
  for (let i = 0; i < toks.length; i++) {
    let joined = ''
    for (let n = 0; n < 3 && i + n < toks.length; n++) {
      joined += toks[i + n]!.t
      for (const ref of want.get(joined) ?? []) out.push({ value: ref, start: toks[i]!.start, end: toks[i + n]!.end })
    }
  }
  return out
}

/** C-EXT-2: the imported references (as imported) whose normalised form equals a run of 1–3 adjacent tokens. */
export function matchReferences(text: string, known: readonly string[]): string[] {
  const runs = new Set(tokenRuns(text))
  const out: string[] = []
  const seen = new Set<string>()
  for (const ref of known) {
    const n = normRef(ref)
    if (n !== '' && runs.has(n) && !seen.has(ref)) {
      seen.add(ref)
      out.push(ref)
    }
  }
  return out
}
