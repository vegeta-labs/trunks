// Runs inside one bubblewrap sandbox: read /in/input, write /out/result.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { runTask, type TaskLimits } from './task.ts'
import type { AttachmentKind } from '../src/ingest/mime.ts'

const [input, output, kind, limits] = process.argv.slice(2)
const r = await runTask(kind as AttachmentKind, readFileSync(input!), JSON.parse(limits!) as TaskLimits)
writeFileSync(output!, JSON.stringify(r))
