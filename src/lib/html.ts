// HTML bodies: plain-text view (tech design T9) and C-SIG-1.7 `hidden_text`. Nothing is rendered or fetched.
import { parse } from 'parse5'

interface PNode {
  nodeName: string
  tagName?: string
  value?: string // text
  data?: string // comment
  attrs?: Array<{ name: string; value: string }>
  childNodes?: PNode[]
  content?: PNode // <template>
}

// code and metadata, never text: not hidden text and not body text (a mail client does not run <noscript>'s alternative)
const NOT_SHOWN = new Set(['script', 'style', 'title'])
// hidden by the browser's default style sheet (C-SIG-1.7 v0.7.3); an author style can show them again
const DEFAULT_HIDDEN = new Set(['head', 'template', 'datalist', 'noembed', 'noframes', 'rp'])
const BLOCK = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'pre', 'hr'])

const attr = (n: PNode, name: string) => n.attrs?.find((a) => a.name === name)?.value

/** Apply the declarations of one importance (`!important` or not) in order; the cascade applies each kind separately. */
function declarations(text: string, into: Map<string, string>, important = false): void {
  for (const decl of text.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const k = decl.slice(0, i).trim().toLowerCase()
    let v = decl.slice(i + 1).trim().toLowerCase()
    const imp = /!\s*important$/.test(v)
    if (imp !== important) continue
    v = v.replace(/!\s*important$/, '').trim()
    // a negative size makes the declaration invalid: it is dropped and the earlier size stays (Codex round 5 Q1)
    if ((k === 'font-size' && negativeSize(v)) || (k === 'font' && negativeSize(fontShorthandSize(v)))) continue
    into.set(k, v)
    // a shorthand resets its longhands: the later of `font-size` and `font` wins (Codex round 2, F2), likewise the colours
    // (a `font` without a size is not valid CSS and changes nothing)
    if (k === 'font') {
      const size = fontShorthandSize(v)
      if (size !== undefined) into.set('font-size', size)
    }
    // `background` sets background-color to its colour component, or to transparent when it has none (Codex round 3 M2)
    if (k === 'background') into.set('background-color', backgroundColour(v))
  }
}

// one compound selector: element, .class, #id and their combinations (self-test RK-F6)
interface Compound {
  tag: string | null
  classes: string[]
  id: string | null
}

interface Rule {
  // right to left: the element itself first, then its ancestors with the combinator that links them
  parts: Array<{ c: Compound; via: ' ' | '>' | null }>
  decls: string
  specificity: number // ids, classes, types; compared before source order (Codex round 2, F2)
  layer: number // position of its cascade layer in first-appearance order; -1 outside any layer
}

const COMPOUND = /^([a-z][a-z0-9]*|\*)?((?:\.[\w-]+|#[\w-]+)*)$/i

function compound(t: string): Compound | null {
  const m = COMPOUND.exec(t)
  if (!m || t === '' || t === '*') return t === '*' ? { tag: null, classes: [], id: null } : null
  const bits = m[2] ?? ''
  const ids = [...bits.matchAll(/#([\w-]+)/g)].map((x) => x[1]!.toLowerCase())
  if (ids.length > 1) return null
  return { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, classes: [...bits.matchAll(/\.([\w-]+)/g)].map((x) => x[1]!.toLowerCase()), id: ids[0] ?? null }
}

// a media query that holds on every screen: `all`, `screen`, `only screen` (an empty query is `all`)
const ALWAYS = /^(?:only\s+)?(?:all|screen)$|^$/i

interface SheetRule {
  prelude: string
  body: string
  layer: string | null // full name (`a.b`) of the cascade layer, null outside any
}

/**
 * The rules of the mail's style sheets that apply unconditionally (C-SIG-1.7 v0.7.4): top-level rules and those inside
 * `@supports`, `@layer` and an `@media` whose query holds on every screen. Other at-rule blocks are skipped as a whole.
 * `layers` collects layer names in the order they first appear (v0.7.5: an earlier layer ranks lower).
 */
function sheetRules(css: string, layers: string[], layer: string | null = null, out: SheetRule[] = []): SheetRule[] {
  // `a.b` declares `a` first
  const declare = (name: string) => {
    const bits = name.split('.')
    for (let k = 1; k <= bits.length; k++) if (!layers.includes(bits.slice(0, k).join('.'))) layers.push(bits.slice(0, k).join('.'))
    return name
  }
  const full = (name: string) => (layer ? `${layer}.${name}` : name)
  const statements = (text: string) => {
    for (const st of text.split(';')) {
      const m = /^\s*@layer\s+([\s\S]+)$/i.exec(st)
      if (m) for (const name of m[1]!.split(',')) if (name.trim()) declare(full(name.trim()))
      // `@import url(x) layer(a)` declares a; a bare `layer` an unnamed layer of its own
      const imp = /^\s*@import\b[\s\S]*?\blayer(?:\(\s*([^)\s]+)\s*\))?/i.exec(st)
      if (imp) declare(full(imp[1] ?? `#anonymous${layers.length}`))
    }
  }
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    // statements after the last rule of a block still declare layers (Codex round 3 M4)
    if (open < 0) {
      statements(css.slice(i))
      break
    }
    let prelude = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
    }
    const body = css.slice(open + 1, j - 1)
    i = j
    // statement at-rules (`@import …;`, `@layer a, b;`) before a rule are not part of its selector; `@layer a, b;` sets
    // the order of those layers
    if (prelude.startsWith('@') && prelude.includes(';')) {
      statements(prelude.slice(0, prelude.lastIndexOf(';')))
      prelude = prelude.slice(prelude.lastIndexOf(';') + 1).trim()
    }
    const at = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude)
    if (!at) out.push({ prelude, body, layer: layer === null ? null : declare(layer) })
    else {
      const name = at[1]!.toLowerCase()
      // an unnamed `@layer { }` is a layer of its own
      // layer names are case-sensitive; `@layer a, b { }` is not valid CSS and is dropped
      if (name === 'layer') {
        if (!at[2]!.includes(',')) sheetRules(body, layers, declare(full(at[2]!.trim() || `#anonymous${layers.length}`)), out)
      }
      else if (name === 'supports') sheetRules(body, layers, layer, out)
      else if (name === 'media' && at[2]!.split(',').some((q) => ALWAYS.test(q.trim()))) sheetRules(body, layers, layer, out)
    }
  }
  return out
}

// `<style>` rules with type, class and id selectors joined by descendant or child combinators (Codex F2). Not evaluated:
// conditional at-rules, attribute and pseudo selectors, sibling combinators.
function stylesheetRules(doc: PNode): { normal: Rule[]; important: Rule[] } {
  const css: string[] = []
  const collect = (n: PNode) => {
    if (n.tagName === 'style') css.push(kids(n).map((c) => c.value ?? '').join(''))
    for (const c of kids(n)) collect(c)
  }
  collect(doc)
  const rules: Rule[] = []
  const layers: string[] = []
  const sheet = sheetRules(css.join('\n').replace(/\/\*[\s\S]*?\*\//g, ''), layers)
  // layer order as in CSS: siblings by first appearance; a layer's own rules after its sub-layers, as rules outside any
  // layer come after every layer. The key of `a.b` is [position of a, position of b among a's sub-layers, ∞].
  const parentOf = (l: string) => (l.includes('.') ? l.slice(0, l.lastIndexOf('.')) : '')
  const keyOf = (l: string | null): number[] => {
    if (l === null) return [Infinity]
    const path: number[] = []
    for (let cur = l; cur !== ''; cur = parentOf(cur)) path.unshift(layers.filter((x) => parentOf(x) === parentOf(cur)).indexOf(cur))
    return [...path, Infinity]
  }
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
    return a.length - b.length
  }
  const order = [null, ...layers].sort((a, b) => cmp(keyOf(a), keyOf(b)))
  // unlayered rules get -1, a marker for "outside any layer"; layered rules their position in cascade order
  const layerRank = (l: string | null) => (l === null ? -1 : order.indexOf(l))
  for (const r of sheet) {
    for (const sel of r.prelude.split(',')) {
      const tokens = sel.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean)
      const parts: Rule['parts'] = []
      let ok = tokens.length > 0
      let via: ' ' | '>' | null = null
      for (let i = tokens.length - 1; i >= 0 && ok; i--) {
        if (tokens[i] === '>') {
          via = '>'
          continue
        }
        const c = compound(tokens[i]!)
        if (!c) ok = false
        else parts.push({ c, via: parts.length === 0 ? null : (via ?? ' ') })
        via = null
      }
      if (ok && parts.length) {
        const sum = (f: (c: Compound) => number) => parts.reduce((n, p) => n + f(p.c), 0)
        rules.push({
          parts, decls: r.body, specificity: sum((c) => (c.id ? 1 : 0)) * 1e6 + sum((c) => c.classes.length) * 1e3 + sum((c) => (c.tag ? 1 : 0)),
          layer: layerRank(r.layer),
        })
      }
    }
  }
  // the cascade (v0.7.5): first the layer — for normal declarations a later layer wins and rules outside any layer win
  // over all layers; for `!important` the other way round — then the more specific rule, then the later one (stable sort)
  const by = (rank: (r: Rule) => number) => [...rules].sort((a, b) => rank(a) - rank(b) || a.specificity - b.specificity)
  return { normal: by((r) => (r.layer < 0 ? Infinity : r.layer)), important: by((r) => (r.layer < 0 ? -Infinity : -r.layer)) }
}

function matches(n: PNode, c: Compound): boolean {
  if (!n.tagName) return false
  if (c.tag && c.tag !== n.tagName) return false
  if (c.id && c.id !== attr(n, 'id')?.toLowerCase()) return false
  const classes = (attr(n, 'class') ?? '').toLowerCase().split(/\s+/)
  return c.classes.every((x) => classes.includes(x))
}

/** Does the rule select n, given its ancestors (nearest last)? */
function selects(rule: Rule, n: PNode, ancestors: PNode[]): boolean {
  if (!matches(n, rule.parts[0]!.c)) return false
  let at = ancestors.length - 1
  for (let k = 1; k < rule.parts.length; k++) {
    const p = rule.parts[k]! // p.via links p to the part inside it
    if (p.via === '>') {
      if (at < 0 || !matches(ancestors[at]!, p.c)) return false
      at--
    } else {
      while (at >= 0 && !matches(ancestors[at]!, p.c)) at--
      if (at < 0) return false
      at--
    }
  }
  return true
}

function styleOf(n: PNode, rules: { normal: Rule[]; important: Rule[] }, ancestors: PNode[]): Map<string, string> {
  const m = new Map<string, string>()
  // browser defaults first, so the mail's own style sheet and inline style can override them
  if (n.attrs?.some((a) => a.name === 'hidden') || (n.tagName && DEFAULT_HIDDEN.has(n.tagName)) || (n.tagName === 'dialog' && !n.attrs?.some((a) => a.name === 'open'))) {
    m.set('display', 'none')
  }
  // the cascade (v0.7.4, v0.7.5): style sheet in cascade order, inline style, then the same again for `!important`
  const inline = attr(n, 'style') ?? ''
  for (const important of [false, true]) {
    for (const r of important ? rules.important : rules.normal) if (selects(r, n, ancestors)) declarations(r.decls, m, important)
    declarations(inline, m, important)
  }
  return m
}

const NAMED: Record<string, string> = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', navy: '#000080', maroon: '#800000', purple: '#800080',
  teal: '#008080', olive: '#808000', lime: '#00ff00', aqua: '#00ffff', fuchsia: '#ff00ff', orange: '#ffa500',
}

/** Normalise a CSS colour to `#rrggbb`; null when not understood. */
export function cssColour(v: string | undefined): string | null {
  if (!v) return null
  const s = v.trim().toLowerCase()
  if (NAMED[s]) return NAMED[s]
  let m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) return `#${[...m[1]!].map((c) => c + c).join('')}`
  m = /^#([0-9a-f]{6})$/.exec(s)
  if (m) return `#${m[1]}`
  // rgb(255,255,255), rgb(255 255 255), rgb(255 255 255 / 50%)
  m = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(s)
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}`
  return null
}

/** The size in a `font` shorthand: the token before the family, optionally `size/line-height`. */
// a font size in the shorthand: a length (a number with a unit), a percentage, zero in any spelling (`0`, `0.0`, `.0`,
// Codex round 4 P2), or a size keyword; a bare non-zero number such as `400` is the weight (Codex round 3 M1)
// a CSS number: sign, digits, fraction, exponent (`0e3` is zero)
const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`
const SIZE = new RegExp(String.raw`^(?:${NUM}(?:(?!e[-+]?\d)[a-z]+|%)|[-+]?0*\.?0+(?:e[-+]?\d+)?|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$`)
function fontShorthandSize(v: string | undefined): string | undefined {
  if (!v) return undefined
  const tokens = v.split(/\s+/)
  for (let i = 0; i < tokens.length - 1; i++) {
    const size = tokens[i]!.split('/')[0]!
    if (SIZE.test(size)) return size // the family follows it
  }
  return undefined
}

/** The colour component of a `background` shorthand; `transparent` when it names none. */
function backgroundColour(v: string): string {
  for (const t of v.match(/[a-z-]+\([^)]*\)|[^\s,/()]+/g) ?? []) if (cssColour(t) !== null || t === 'transparent' || t === 'currentcolor') return t
  return 'transparent'
}

const negativeSize = (v: string | undefined) => v !== undefined && v.startsWith('-') && parseFloat(v) !== 0

/** Font size in px when it can be told; `0` in any unit is 0. */
function fontPx(v: string | undefined): number | null {
  if (!v) return null
  const m = new RegExp(`^(${NUM})\\s*(px|pt|em|rem|%)?$`).exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  if (n === 0) return 0
  if (n < 0) return null // a negative size is not valid CSS and changes nothing
  if (m[2] === 'px' || m[2] === undefined) return n
  if (m[2] === 'pt') return (n * 4) / 3
  // relative sizes against the 16px default (a parent's own size is not tracked)
  if (m[2] === 'em' || m[2] === 'rem') return n * 16
  return (n * 16) / 100
}

const kids = (n: PNode) => n.childNodes ?? []
const INHERITING = new Set(['inherit', 'unset', 'currentcolor'])
// roll back to the browser's default: a link's own colour, otherwise the parent's (Codex round 4 P1)
const REVERTING = new Set(['revert', 'revert-layer'])

export interface HiddenFinding {
  text: string
  reason: 'display_none' | 'visibility_hidden' | 'opacity_zero' | 'tiny_font' | 'same_colour' | 'transparent'
}

/**
 * C-SIG-1.7 (v0.7.1): text in the HTML body that a reader would not see: `display:none`, `visibility:hidden`,
 * font size ≤ 1px, text colour equal to the background colour. Comments do not count (C-SIG-1.8 scans them).
 */
export function hiddenText(html: string): HiddenFinding[] {
  return hiddenTextView(html).findings.map(({ reason, text }) => ({ reason, text }))
}

/** Shared text stream and source ranges for masking values split across text nodes. */
export function hiddenTextView(html: string): { text: string; findings: Array<HiddenFinding & { start: number; end: number }> } {
  const doc = parse(html, { scriptingEnabled: false }) as unknown as PNode
  const rules = stylesheetRules(doc)
  const found: Array<HiddenFinding & { start: number; end: number }> = []
  let text = ''
  const ancestors: PNode[] = []
  // `<body link>` sets the colour of links (the HTML Standard's rendering section)
  let linkDefault = '#0000ee'
  const walk = (n: PNode, ctx: { hidden: HiddenFinding['reason'] | null; colour: string | null; bg: string | null }) => {
    if (n.nodeName === '#comment') return
    if (n.nodeName === '#text') {
      const start = text.length
      text += n.value ?? ''
      if ((n.value ?? '').trim() === '') return
      if (ctx.hidden) found.push({ reason: ctx.hidden, text: n.value ?? '', start, end: text.length })
      else if (ctx.colour && ctx.colour === (ctx.bg ?? '#ffffff')) found.push({ reason: 'same_colour', text: n.value ?? '', start, end: text.length })
      return
    }
    if (n.tagName && NOT_SHOWN.has(n.tagName)) {
      return
    }
    const block = n.tagName !== undefined && BLOCK.has(n.tagName)
    if (block) text += '\n'
    const st = styleOf(n, rules, ancestors)
    let hidden = ctx.hidden
    if (!hidden && st.get('display') === 'none') hidden = 'display_none'
    if (!hidden && st.get('visibility') === 'hidden') hidden = 'visibility_hidden'
    if (!hidden && /^0*\.?0*%?$/.test(st.get('opacity') ?? 'x')) hidden = 'opacity_zero' // v0.7.3
    if (!hidden && st.get('color') === 'transparent') hidden = 'transparent' // v0.7.3
    // `font: 1px Arial` sets the size too (Codex F2); declarations() resolves it into font-size
    const px = fontPx(st.get('font-size'))
    if (!hidden && px !== null && px <= 1) hidden = 'tiny_font'
    // presentational colours (`<font color>`, `<body text>`) rank below author styles; a link has the browser's own colour
    // instead of inheriting one (self-review M2)
    const presentational = n.tagName === 'font' ? attr(n, 'color') : n.tagName === 'body' ? attr(n, 'text') : undefined
    if (n.tagName === 'body') linkDefault = cssColour(attr(n, 'link')) ?? linkDefault
    const linkColour = n.tagName === 'a' && attr(n, 'href') !== undefined ? linkDefault : null
    // CSS-wide keywords (PRD v0.7.7): `inherit`, `unset`, `currentcolor` take the parent's colour; `initial` is black;
    // `revert`, `revert-layer` the browser default (Codex round 3 M3, round 4 P1)
    const c = st.get('color')
    const colour = c !== undefined && INHERITING.has(c) ? ctx.colour
      : c !== undefined && REVERTING.has(c) ? (linkColour ?? ctx.colour)
      : c === 'initial' ? '#000000'
        : (cssColour(c) ?? cssColour(presentational) ?? linkColour ?? ctx.colour)
    // an author background (also `transparent`) replaces `bgcolor`; `currentcolor` is the element's own text colour
    const b = st.get('background-color')
    const bg = b === undefined ? (cssColour(attr(n, 'bgcolor')) ?? ctx.bg)
      : b === 'currentcolor' ? colour
        : (cssColour(b) ?? ctx.bg)
    // a closed <details> shows only its first <summary>; this cannot be styled away
    let summarySeen = false
    const closedDetails = n.tagName === 'details' && !n.attrs?.some((a) => a.name === 'open')
    for (const c of [...kids(n), ...(n.content ? kids(n.content) : [])]) {
      let h = hidden
      if (closedDetails && !h) {
        if (c.tagName === 'summary' && !summarySeen) summarySeen = true
        else h = 'display_none'
      }
      ancestors.push(n)
      walk(c, { hidden: h, colour, bg })
      ancestors.pop()
    }
    if (block) text += '\n'
  }
  // a page without colours is black text on white
  walk(doc, { hidden: null, colour: '#000000', bg: '#ffffff' })
  return { text, findings: found }
}

/** Plain-text view of an HTML body: text nodes only, block elements on new lines; nothing hidden is dropped. */
export function htmlToText(html: string): string {
  const doc = parse(html, { scriptingEnabled: false }) as unknown as PNode
  let out = ''
  const walk = (n: PNode) => {
    if (n.nodeName === '#text') out += n.value ?? ''
    if (n.tagName && NOT_SHOWN.has(n.tagName)) return
    const block = n.tagName !== undefined && BLOCK.has(n.tagName)
    if (block) out += '\n'
    for (const c of [...kids(n), ...(n.content ? kids(n.content) : [])]) walk(c)
    if (block) out += '\n'
  }
  walk(doc)
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Every HTML comment's text, wherever it is (head included). */
export function htmlComments(html: string): string[] {
  const out: string[] = []
  const walk = (n: PNode) => {
    if (n.nodeName === '#comment') out.push(n.data ?? '')
    for (const c of kids(n)) walk(c)
    if (n.content) walk(n.content)
  }
  walk(parse(html, { scriptingEnabled: false }) as unknown as PNode)
  return out
}
