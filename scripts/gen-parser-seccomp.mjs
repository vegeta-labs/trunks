// Builds deploy/parser-seccomp.json (tech design T7, v0.7.11): Docker's default seccomp profile (moby v28.0.0, Apache-2.0,
// vendored unchanged in deploy/) plus one rule for what bubblewrap needs to build each task's sandbox. Measured: with
// the default profile alone the sandbox does not start; with these five calls TC-ING-10 holds and `unshare` inside a
// task is still refused (each task also gets bubblewrap's own seccomp filter, parser/seccomp-gen.py).
//   node scripts/gen-parser-seccomp.mjs          write the file
//   node scripts/gen-parser-seccomp.mjs --check  fail when the file differs (CI, TC-OPS-02)
import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE = 'deploy/moby-seccomp-default-v28.0.0.json'
const OUT = 'deploy/parser-seccomp.json'
export const BUBBLEWRAP_CALLS = ['clone', 'unshare', 'mount', 'umount2', 'pivot_root']

export function build(source) {
  const p = JSON.parse(source)
  p.syscalls.push({ names: BUBBLEWRAP_CALLS, action: 'SCMP_ACT_ALLOW', comment: 'trunks parser: bubblewrap sandbox per task' })
  return `${JSON.stringify(p, null, 2)}\n`
}

const want = build(readFileSync(SOURCE, 'utf8'))
if (process.argv.includes('--check')) {
  let have = ''
  try {
    have = readFileSync(OUT, 'utf8')
  } catch {}
  if (have !== want) {
    console.error(`${OUT} differs from the output of scripts/gen-parser-seccomp.mjs; run it and commit the result`)
    process.exit(1)
  }
  console.log(`${OUT} matches`)
} else {
  writeFileSync(OUT, want)
  console.log(`wrote ${OUT}`)
}
