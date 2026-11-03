// Every configuration key path of the three files (src/config/load.ts), for the docs check (TC-OPS-04):
// dotted, with `[]` for array items; a free-form map (additionalProperties) is listed at its own path only.
import { z } from 'zod'
import { CasesFile, DeploymentFile, TemplatesFile } from '../src/config/load.ts'

type Node = { type?: string | string[]; properties?: Record<string, Node>; items?: Node; anyOf?: Node[]; oneOf?: Node[]; allOf?: Node[]; additionalProperties?: boolean | Node }

// a container: an object with named properties, or an array of them (or a union of such); its keys are listed instead
const container = (n: Node): boolean =>
  !!n.properties || (!!n.items && container(n.items)) || [...(n.anyOf ?? []), ...(n.oneOf ?? []), ...(n.allOf ?? [])].some(container)

function walk(n: Node | undefined, path: string, out: Set<string>, all: Set<string>): void {
  if (!n) return
  for (const alt of [...(n.anyOf ?? []), ...(n.oneOf ?? []), ...(n.allOf ?? [])]) walk(alt, path, out, all)
  if (n.properties) for (const [k, v] of Object.entries(n.properties)) {
    const p = path ? `${path}.${k}` : k
    all.add(p)
    if (!container(v)) out.add(p)
    walk(v, p, out, all)
  }
  if (n.items) walk(n.items, `${path}[]`, out, all)
}

/** `leaves`: every key a reference must document; `all`: also the section paths, which it may document. */
export function configKeys(): { leaves: string[]; all: string[] } {
  const out = new Set<string>()
  const all = new Set<string>()
  for (const s of [DeploymentFile, CasesFile, TemplatesFile]) walk(z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Node, '', out, all)
  return { leaves: [...out].sort(), all: [...all].sort() }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(configKeys().leaves.join('\n'))
