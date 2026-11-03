import { describe, expect, it } from 'vitest'
import { matchedPhrases, words } from './text.ts'

describe('I-05 v0.7.17 combining marks', () => {
  it('a mark joins the word before it and is ignored when words are compared', () => {
    expect(words('किरण शर्मा').map((w) => [w.word, w.start, w.end])).toEqual([['करण', 0, 4], ['शरम', 5, 10]])
    expect(matchedPhrases('my passport\u0301 scan', ['passport'])).toEqual(['passport'])
    expect(matchedPhrases('passport\u0301.txt', ['passport'])).toEqual(['passport'])
    // a mark with no letter before it is no word
    expect(words(' \u0301 ')).toEqual([])
  })
})
