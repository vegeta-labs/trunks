// PRD I-02 and C-EXT-5: dates in mail text. YYMMDD is only read inside MT103 `:32A:` (amounts.ts).

export type DateStatus = 'ok' | 'ambiguous' | 'invalid'

export interface DateHit {
  iso: string | null
  status: DateStatus
  start: number
  end: number
}

/** ISO `YYYY-MM-DD` for a real calendar date, otherwise null. */
export function isoFromParts(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate()
  if (d > dim) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export const isIsoDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return !!m && isoFromParts(Number(m[1]), Number(m[2]), Number(m[3])) === s
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
}
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')
const ORD = '(?:st|nd|rd|th)?'
// spaces or tabs between the parts, never a line break (v0.7.1)
const S = '[ \\t]+'
// Not adjacent to a letter or digit on either side.
const L = '(?<![\\p{L}\\p{N}])'
const R = '(?![\\p{L}\\p{N}])'

const PATTERNS: Array<{ re: RegExp; read: (m: RegExpExecArray) => DateHit['status'] | [number, number, number] }> = [
  { re: new RegExp(`${L}(\\d{4})-(\\d{2})-(\\d{2})${R}`, 'gu'), read: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  {
    re: new RegExp(`${L}(\\d{1,2})${ORD}${S}(?:of${S})?(${MONTH})\\.?,?${S}(\\d{4})${R}`, 'giu'),
    read: (m) => [Number(m[3]), MONTHS[m[2]!.toLowerCase()]!, Number(m[1])],
  },
  {
    re: new RegExp(`${L}(${MONTH})\\.?${S}(\\d{1,2})${ORD},?${S}(\\d{4})${R}`, 'giu'),
    read: (m) => [Number(m[3]), MONTHS[m[1]!.toLowerCase()]!, Number(m[2])],
  },
]
const SLASH = new RegExp(`${L}(\\d{1,2})/(\\d{1,2})/(\\d{4})${R}`, 'gu')

/** C-EXT-5 over I-04 normalised text. Ambiguous DD/MM vs MM/DD is reported, never guessed. */
export function extractDates(t: string): DateHit[] {
  const out: DateHit[] = []
  for (const { re, read } of PATTERNS) {
    for (const m of t.matchAll(re)) {
      const r = read(m)
      const iso = typeof r === 'string' ? null : isoFromParts(...r)
      out.push({ iso, status: iso ? 'ok' : 'invalid', start: m.index, end: m.index + m[0].length })
    }
  }
  for (const m of t.matchAll(SLASH)) {
    const a = Number(m[1])
    const b = Number(m[2])
    const y = Number(m[3])
    const span = { start: m.index, end: m.index + m[0].length }
    if (a > 12 && b > 12) out.push({ iso: null, status: 'invalid', ...span })
    else if (a > 12) { const iso = isoFromParts(y, b, a); out.push({ iso, status: iso ? 'ok' : 'invalid', ...span }) }
    else if (b > 12) { const iso = isoFromParts(y, a, b); out.push({ iso, status: iso ? 'ok' : 'invalid', ...span }) }
    // both readings give the same date
    else if (a === b) { const iso = isoFromParts(y, a, b); out.push({ iso, status: iso ? 'ok' : 'invalid', ...span }) }
    else out.push({ iso: null, status: 'ambiguous', ...span })
  }
  return out.sort((x, y) => x.start - y.start)
}
