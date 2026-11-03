// PRD I-04 (text normalisation) and I-05 (whole-word list matching).

// I-04: format characters and every default-ignorable code point (invisible joiners, variation selectors, fillers; v0.7.3)
const CF = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

export interface Normalised {
  text: string
  // origin[i] = [start, end) in the original string of the grapheme that produced normalised code unit i
  origin: Array<readonly [number, number]>
}

/** I-04: NFKC and remove every Unicode `Cf` character. Keeps a map back to the original (R-EXT-02). */
export function normalise(original: string): Normalised {
  let text = ''
  const origin: Array<readonly [number, number]> = []
  for (const { segment, index } of segmenter.segment(original)) {
    // Normalising grapheme by grapheme keeps a position map; a cluster never composes with its neighbours.
    const out = segment.replace(CF, '').normalize('NFKC').replace(CF, '')
    const span = [index, index + segment.length] as const
    for (let i = 0; i < out.length; i++) origin.push(span)
    text += out
  }
  return { text, origin }
}

export const normaliseText = (s: string) => normalise(s).text

/** Original [start, end) for a normalised [start, end). */
export function toOriginal(n: Normalised, start: number, end: number): [number, number] {
  if (start >= end) {
    const at = start < n.origin.length ? n.origin[start]![0] : (n.origin.at(-1)?.[1] ?? 0)
    return [at, at]
  }
  return [n.origin[start]![0], n.origin[end - 1]![1]]
}

/** The normalised range produced by the original range [start, end) (the inverse of toOriginal). */
export function fromOriginal(n: Normalised, start: number, end: number): [number, number] {
  let s = 0
  while (s < n.origin.length && n.origin[s]![1] <= start) s++
  let e = s
  while (e < n.origin.length && n.origin[e]![0] < end) e++
  return [s, e]
}

export interface Word {
  word: string // lower case, without combining marks
  length: number // code points as written, marks included (C-RED-1 name words ≥ 3)
  start: number
  end: number
}

// a combining mark belongs to the letter before it (Devanagari vowel signs, Arabic vowel points: v0.7.17, round-4
// self-review T1) and is dropped when words are compared, so `passport` + U+0301 is still `passport` (Codex E2 round 4 F18)
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu
const MARK = /\p{M}/gu

/** I-05 words: letters and digits with their marks, lower-cased, compared without marks. Input must be I-04 normalised. */
export function words(normalisedText: string): Word[] {
  const out: Word[] = []
  for (const m of normalisedText.matchAll(WORD)) {
    out.push({ word: m[0].replace(MARK, '').toLowerCase(), length: Array.from(m[0]).length, start: m.index, end: m.index + m[0].length })
  }
  return out
}

export const phraseWords = (phrase: string) => words(normaliseText(phrase)).map((w) => w.word)

export interface PhraseHit {
  phrase: string
  start: number
  end: number
}

/** I-05: every occurrence of each phrase as a whole-word sequence. `text` is I-04 normalised. */
export function findPhrases(normalisedText: string, phrases: readonly string[]): PhraseHit[] {
  const ws = words(normalisedText)
  const hits: PhraseHit[] = []
  for (const phrase of phrases) {
    const p = phraseWords(phrase)
    if (p.length === 0) continue
    for (let i = 0; i + p.length <= ws.length; i++) {
      let ok = true
      for (let j = 0; j < p.length; j++) if (ws[i + j]!.word !== p[j]) { ok = false; break }
      if (ok) hits.push({ phrase, start: ws[i]!.start, end: ws[i + p.length - 1]!.end })
    }
  }
  return hits.sort((a, b) => a.start - b.start || a.end - b.end)
}

/** Distinct phrases from the list that occur in the (raw) text. */
export function matchedPhrases(raw: string, phrases: readonly string[]): string[] {
  const found = new Set(findPhrases(normaliseText(raw), phrases).map((h) => h.phrase))
  return phrases.filter((p) => found.has(p))
}
