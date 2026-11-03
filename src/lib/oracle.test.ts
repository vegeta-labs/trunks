// Test plan §3: the TypeScript rules and the independent Python oracle give the same answer on every input.
import { describe, expect, it } from 'vitest'
import { corpus } from './oracle-corpus.ts'
import { runOracle, runTs } from './oracle-compare.ts'

describe('TS vs independent oracle (E1 rules)', () => {
  it('C-EXT, C-RED-1, C-SIG-1, C-SIG-3, C-LNK-3, C-AUD-1: no difference on the corpus', () => {
    const calls = corpus()
    const want = runOracle(calls)
    const diffs = calls
      .map((c, i) => ({ fn: c.fn, input: c.input, ts: runTs(c), py: want[i] }))
      .filter((d) => JSON.stringify(d.ts) !== JSON.stringify(d.py))
    expect(diffs.slice(0, 5), `${diffs.length} of ${calls.length} differ`).toEqual([])
  }, 120_000)
})
