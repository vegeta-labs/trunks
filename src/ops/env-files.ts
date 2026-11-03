// Docker's `<NAME>_FILE` convention (tech design v0.7.11): compose passes every secret as a file; some readers (the
// model's API key) look at the variable itself, so each `<NAME>_FILE` fills `<NAME>` once at start. A variable already
// set wins. Values are never logged.
import { readFileSync } from 'node:fs'

export function expandFileVariables(env: NodeJS.ProcessEnv): string[] {
  const filled: string[] = []
  for (const [key, file] of Object.entries(env)) {
    const name = key.endsWith('_FILE') ? key.slice(0, -5) : null
    if (!name || !file || env[name] !== undefined) continue
    env[name] = readFileSync(file, 'utf8').trim()
    filled.push(name)
  }
  return filled
}
