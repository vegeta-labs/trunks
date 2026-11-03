// Prints every TS-vs-oracle difference, grouped by function (used for triage; the CI test asserts none remain).
import { corpus } from '../src/lib/oracle-corpus.ts'
import { runOracle, runTs } from '../src/lib/oracle-compare.ts'

const calls = corpus()
const want = runOracle(calls)
const byFn = new Map<string, Array<{ input: unknown; ts: unknown; py: unknown }>>()
calls.forEach((c, i) => {
  let ts: unknown
  try { ts = runTs(c) } catch (e) { ts = { error: String(e) } }
  if (JSON.stringify(ts) !== JSON.stringify(want[i])) byFn.set(c.fn, [...(byFn.get(c.fn) ?? []), { input: c.input, ts, py: want[i] }])
})
console.log(`${calls.length} calls`)
for (const [fn, d] of byFn) {
  console.log(`\n=== ${fn}: ${d.length} differences`)
  for (const x of d.slice(0, Number(process.env.SHOW ?? 6))) console.log(JSON.stringify(x))
}
