// Self-test gate (rules G2 step 0): break a key judgement on purpose; the unit tests must fail every time.
// Each mutant is [file, original text, mutated text, what it breaks]. The original must occur exactly once.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Not listed (equivalent mutants, shown by reasoning):
// - amounts.ts, the U+2212 check: a token directly after "−" already fails the boundary rule (only whitespace, start of
//   text and ( ) ; : may come before a token), so removing it changes nothing.
// - amounts.ts, the touching-first pass order: a marker written against a number on one side leaves the candidate on its
//   other side without a valid boundary (a digit follows or precedes the marker), so the two can never compete.
// - events.ts sensitiveIn, the array branch: an array is an object, so the object branch walks its items anyway.
// - draft.ts allowedManualTemplates, «payment_received only when received»: the class templates come from paymentTemplate,
//   which gives payment_received only when the ledger says received, and payment_received discloses, so it is never in the
//   generic list; the check is defence in depth (E3 self-test).
// - accounts.ts, the length check inside ibanValid: every string it is called on is a shape of exactly that length.
// a mutant may name its own test command (the database tests for the pipeline and the review actions)
const DB = 'npx vitest run src/pipeline/e3.test.ts --reporter=dot'
const R4 = 'npx vitest run src/maintenance/retention.test.ts --reporter=dot'
const K4 = 'npx vitest run src/maintenance/kyc.test.ts --reporter=dot'
const T4 = 'npx vitest run src/maintenance/rotation.test.ts --reporter=dot'
const M4 = 'npx vitest run src/adapters/mailbox scripts/no-send.test.ts --reporter=dot'
const H4 = 'npx vitest run src/server/hold.test.ts --reporter=dot'
const E5M = 'npx vitest run src/store/migrate.test.ts --reporter=dot'
const E5G = 'npx vitest run src/demo-guard.test.ts --reporter=dot'
const E5S = 'npx vitest run src/server/app.test.ts --reporter=dot'
const E5R = 'npx vitest run src/maintenance/round.test.ts --reporter=dot'
const E5P = 'npx vitest run scripts/public-curate.test.ts --reporter=dot'
const E5C = 'npx vitest run src/pipeline/classify.test.ts -t TC-OPS-09 --reporter=dot'
// v0.1.1 demo page (PRD v0.7.25): the web unit tests, the review UI browser test and the static demo test. DEMO needs a
// running, processed local demo at 127.0.0.1:8080 (deploy/compose.demo.yml) to rebuild the snapshot
const W = 'npx vitest run src/web --reporter=dot'
const WE = 'npx playwright test -g TC-REV-10 --reporter=dot'
const DEMO = 'npm run demo:snapshot --silent -- http://127.0.0.1:8080 && npx playwright test -c playwright.demo.config.ts --reporter=dot'
const MUTANTS = [
  ['src/lib/uetr.ts', "hex[12] === '4'", "hex[12] !== '0'", 'UETR version digit not checked'],
  ['src/lib/uetr.ts', "'89ab'.includes(hex[16]!)", "'89abc'.includes(hex[16]!)", 'UETR variant c accepted'],
  ['src/lib/references.ts', 'for (let n = 1; n <= 3 && i + n <= t.length; n++)', 'for (let n = 1; n <= 2 && i + n <= t.length; n++)', 'only 1–2 token runs'],
  ['src/lib/money.ts', 'minor <= MAX_MINOR', 'minor <= MAX_MINOR + 1', 'amount cap off by one'],
  ['src/lib/money.ts', '(?:\\.(\\d{1,2}))?$', '(?:\\.(\\d{1,3}))?$', 'three decimals accepted'],
  ['src/lib/amounts.ts', "if (c === '$') return isLetter(t[end - 2]) ? null", "if (c === '$') return false ? null", 'CA$ read as USD'],
  ['src/lib/accounts.ts', 'return rem === 1', 'return rem <= 1', 'mod-97 accepts 0'],
  ['src/lib/accounts.ts', 'const NEAR = 30', 'const NEAR = 31', 'sort code distance 31'],
  ['src/lib/dates.ts', "else out.push({ iso: null, status: 'ambiguous', ...span })", "else { const iso = isoFromParts(y, b, a); out.push({ iso, status: iso ? 'ok' : 'invalid', ...span }) }", 'ambiguous dates guessed day-first'],
  ['src/lib/text.ts', "const CF = /[\\p{Cf}\\p{Default_Ignorable_Code_Point}]/gu", "const CF = /\\u200B/gu", 'only zero-width space removed'],
  ['src/lib/text.ts', "const CF = /[\\p{Cf}\\p{Default_Ignorable_Code_Point}]/gu", "const CF = /\\p{Cf}/gu", 'default-ignorable characters kept (v0.7.3)'],
  ['src/lib/redact.ts', "if (SPREAD.includes(h.kind) && !this.found", "if (false && !this.found", 'found values not spread to other occurrences'],
  ['src/lib/html.ts', "if (n.attrs?.some((a) => a.name === 'hidden') || ", "if (", 'hidden attribute ignored'],
  ['src/lib/html.ts', "if (closedDetails && !h) {", "if (false) {", 'closed <details> shows everything'],
  ['src/lib/redact.ts', 'if (ORDER.indexOf(h.kind) < ORDER.indexOf(last.kind)) last.kind = h.kind', '', 'merged span keeps a later kind'],
  ['src/lib/redact.ts', '.filter((w) => w.length >= 3)', '.filter((w) => w.length >= 4)', 'three-letter names not redacted'],
  ['src/lib/redact.ts', "near(sortKw, s, 20, -1)", "near(sortKw, s, 2, -1)", 'sort code window shrunk'],
  ['src/lib/redact.ts', '        best = i + 1\n        break', '        best = i + 1', 'phone takes the longest prefix (eats the next number)'],
  ['src/lib/redact.ts', '      re.lastIndex = m.index + best // the rest', '      re.lastIndex = m.index + m[0].length // the rest', 'no rescan after a cut'],
  ['src/lib/signals.ts', "const FAILING = new Set(['fail', 'softfail', 'permerror'])", "const FAILING = new Set(['fail', 'permerror'])", 'softfail not a failure'],
  ['src/lib/signals.ts', 'const top = input.trustedAuthResults ? ar.find((v) => authservId(v) === trusted) : undefined', 'const top = ar.find((v) => authservId(v) === trusted)', '.eml results adopted'],
  ['src/lib/signals.ts', 'if (dist >= 1 && dist <= 2) return true', 'if (dist >= 1 && dist <= 1) return true', 'distance 2 not a lookalike'],
  ['src/lib/signals.ts', "return replyTo.some((r) => normAddress(r) !== f)", "return replyTo.some((r) => domainOf(r) !== domainOf(f))", 'Reply-To compared by domain'],
  ['src/lib/html.ts', 'if (!hidden && px !== null && px <= 1) hidden', 'if (!hidden && px !== null && px < 1) hidden', 'font-size 1px visible'],
  ['src/lib/names.ts', "const STOP = new Set(['MR', 'MRS', 'MS', 'DR', 'LTD', 'LIMITED', 'LLP', 'PLC', 'AND', 'THE'])", "const STOP = new Set(['MR', 'MRS', 'MS', 'DR'])", 'company words kept'],
  ['src/lib/audit-hash.ts', 'const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))', 'const keys = Object.keys(v)', 'JCS keys unsorted'],
  ['src/lib/pacs008.ts', "if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { parsed: false, reason: 'dtd_or_entity' }", '', 'DTD accepted'],
  ['src/lib/directory.ts', "else if (amt.value < 0) errors.push", "else if (false) errors.push", 'negative ledger amount accepted'],
  ['src/lib/accounts.ts', "if (solid.length === len && ", "if (solid.length >= len - 1 && ", 'solid IBAN one short accepted'],
  // Codex E1 round 2
  ['src/lib/html.ts', "else if (name === 'media' && at[2]!.split(',').some((q) => ALWAYS.test(q.trim()))) sheetRules(body, layers, layer, out)", '', '@media all skipped (N1)'],
  ['src/lib/html.ts', "else if (name === 'media' && at[2]!.split(',').some((q) => ALWAYS.test(q.trim())))", "else if (name === 'media')", 'conditional @media counted (N1)'],
  ['src/lib/html.ts', "for (const important of [false, true]) {", "for (const important of [false]) {", '!important ignored'],
  ['src/lib/html.ts', 'rank(a) - rank(b) || a.specificity - b.specificity', 'rank(a) - rank(b)', 'specificity ignored (F2)'],
  ['src/lib/html.ts', "if (size !== undefined) into.set('font-size', size)", "if (size !== undefined && !into.has('font-size')) into.set('font-size', size)", 'font-size beats a later font (F2)'],
  ['src/lib/redact.ts', "const EMAIL = /(?<![\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~.-])(", "const EMAIL = /(?<![\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~.\"-])(", 'quoted address not redacted (N2)'],
  ['src/lib/references.ts', 'if (!list.includes(ref)) want.set(n, [...list, ref])', 'if (!list.length) want.set(n, [ref])', 'one spelling per reference (N3)'],
  // self-review of the round-2 fixes
  ['src/lib/html.ts', 'return { normal: by((r) => (r.layer < 0 ? Infinity : r.layer)), important: by((r) => (r.layer < 0 ? -Infinity : -r.layer)) }', 'return { normal: by(() => 0), important: by(() => 0) }', 'layers ignored (M1)'],
  ['src/lib/html.ts', 'important: by((r) => (r.layer < 0 ? -Infinity : -r.layer))', 'important: by((r) => (r.layer < 0 ? Infinity : r.layer))', '!important layer order not reversed (M1)'],
  ['src/lib/html.ts', 'return [...path, Infinity]', 'return path', "a layer's own rules below its sub-layers (M1)"],
  ["src/lib/html.ts", "const linkColour = n.tagName === 'a' && attr(n, 'href') !== undefined ? linkDefault : null", 'const linkColour = null', 'links inherit the text colour (M2)'],
  // Codex round 3
  ['src/lib/html.ts', "|[-+]?0*\\.?0+(?:e[-+]?\\d+)?|xx-small|", "|[\\d.]+|xx-small|", 'a bare number read as the font size (M1)'],
  ['src/lib/html.ts', "if (k === 'background') into.set('background-color', backgroundColour(v))", "if (k === 'background') into.delete('background-color')", 'compound background loses its colour (M2)'],
  ['src/lib/html.ts', "const colour = c !== undefined && INHERITING.has(c) ? ctx.colour", "const colour = false ? ctx.colour", 'color:inherit ignored (M3)'],
  ['src/lib/html.ts', "      statements(css.slice(i))\n", '', 'trailing @layer statements dropped (M4)'],
  // Codex round 4
  ['src/lib/html.ts', "new Set(['inherit', 'unset', 'currentcolor'])", "new Set(['inherit', 'unset', 'currentcolor', 'revert', 'revert-layer'])", 'revert takes the parent colour on a link (P1)'],
  ['src/lib/html.ts', "|[-+]?0*\\.?0+(?:e[-+]?\\d+)?|xx-small|", "|0|xx-small|", 'only a literal 0 is a zero size (P2)'],
  // Codex round 5
  ['src/lib/html.ts', "    if ((k === 'font-size' && negativeSize(v)) || (k === 'font' && negativeSize(fontShorthandSize(v)))) continue\n", '', 'a negative size replaces the earlier valid one (Q1)'],
  // E2: classification, fields, KYC judgement, evaluation metrics
  ['src/lib/classify.ts', "adopted: l.confidence !== 'low'", "adopted: l.confidence === 'high'", 'medium labels not adopted (C-CLS-2)'],
  ['src/lib/classify.ts', "adopted: l.confidence !== 'low'", 'adopted: true', 'low labels adopted (C-CLS-2)'],
  ['src/lib/classify.ts', "  if (!out.some((l) => l.adopted)) out.push(", "  if (out.length === 0) out.push(", 'no unclassified when only low labels (C-CLS-2)'],
  ['src/lib/classify.ts', 'export const riskClasses = (labels: readonly Label[]) => [...new Set(labels.map((l) => l.classId))]', 'export const riskClasses = (labels: readonly Label[]) => adoptedClasses(labels)', 'risk ignores low labels (C-CLS-2)'],
  ['src/lib/classify.ts', 'if ([i.subject, i.body, i.bodyHtml, ...i.attachmentTexts].some(', 'if ([i.body, i.bodyHtml].some(', 'account shapes in subject / attachments ignored (C-CLS-4, v0.7.8)'],
  ['src/lib/classify.ts', 'findPhrases(b, CHANGE).length > 0 && findPhrases(b, BANK).length > 0', 'findPhrases(b, CHANGE).length > 0 || findPhrases(b, BANK).length > 0', 'one word list enough (C-CLS-4)'],
  ['src/lib/classify.ts', "if (i.esignInvite) out.add('legal_documents')", '', 'e-sign invite not legal_documents (C-CLS-4)'],
  ['src/lib/classify.ts', '.max(4),', '.max(5),', 'five labels accepted (C-CLS-1)'],
  ['src/lib/classify.ts', 'reason: z.string().max(200)', 'reason: z.string().max(201)', 'reason over 200 characters (C-CLS-1)'],
  ['src/lib/kyc.ts', "  if (a.kind === 'image') return 'image'\n", '', 'images not KYC (C-RED-0 ③)'],
  ['src/lib/kyc.ts', "  if (a.parseStatus !== 'parsed') return `not_checked:${a.parseStatus}`\n", '', 'unchecked attachments sent (C-RED-0 ⑤)'],
  ['src/lib/kyc.ts', "  if (a.facts?.encrypted) return 'not_checked:encrypted'\n", '', 'encrypted attachments sent (C-RED-0 ⑤)'],
  ['src/lib/kyc.ts', "  if (a.facts?.tooDeep) return 'not_checked:too_deep'\n", '', 'too-deep nesting sent (C-RED-0 ⑤)'],
  ['src/lib/kyc.ts', "(a.facts?.pagesWithoutText ?? 0) > 0", "(a.facts?.pagesWithoutText ?? 0) > 1", 'one page without text layer sent (C-RED-0 ④)'],
  ['src/lib/kyc.ts', "    if (r) return `nested:${r}`\n", '', 'nested attachments not checked (C-RED-0)'],
  ['src/lib/kyc.ts', "  if (hasMrz(normaliseText(text))) return 'mrz'\n", '', 'MRZ not checked (C-RED-0 ②)'],
  ['src/lib/kyc.ts', '.length >= 2) return', '.length >= 3) return', 'two birth details not enough (C-RED-0 ②)'],
  ['src/lib/kyc.ts', '|| ZH.some((w) => n.includes(w))', '|| ZH.some((w) => findPhrases(n, [w]).length > 0)', 'Chinese words matched as whole words (C-RED-0 ①, v0.7.8)'],
  ['src/lib/kyc.ts', "'kontoauszug', ", '', 'German bank statement word missing (v0.7.8)'],
  ['src/lib/fields.ts', "const quoted = (q: string, ctx: FieldContext) => ws(q) !== '' && ws(ctx.modelText).includes(ws(q))", 'const quoted = (q: string, ctx: FieldContext) => true', 'quotes not checked (C-FLD-0, TC-FLD-04)'],
  ['src/lib/fields.ts', "const quoted = (q: string, ctx: FieldContext) => ws(q) !== '' && ws(ctx.modelText).includes(ws(q))", 'const quoted = (q: string, ctx: FieldContext) => ws(ctx.modelText).includes(ws(q))', 'an empty quote accepted (v0.7.16, Codex E2 re-run F4)'],
  ['src/lib/fields.ts', 'const SECRET_PLACEHOLDER = /\\[(ACCOUNT|SORTCODE|ID|DOB)_\\d+\\]/', 'const SECRET_PLACEHOLDER = /\\[(ACCOUNT|SORTCODE)_\\d+\\]/', 'ID / DOB placeholders kept in values (C-RED-2)'],
  ['src/lib/fields.ts', 'export const modelFields = (fields: readonly string[]) => fields.filter((f) => KIND[f] !== \'last4\')', 'export const modelFields = (fields: readonly string[]) => [...fields]', 'model asked for account_last4 (§5.5a)'],
  ['src/lib/fields.ts', "if (r.invalid && modelD.length === 0 && !ruleFilled) return { ...r, status: 'void', needsConfirmation: true }", "if (r.invalid && modelD.length === 0 && !ruleFilled) return { ...r, status: 'void', needsConfirmation: false }", 'invalid value not yellow (C-FLD-2, v0.7.9)'],
  ['src/lib/fields.ts', "if (r.invalid && modelD.length === 0 && !ruleFilled) return { ...r, status: 'void', needsConfirmation: true }", '', 'invalid value not void (C-FLD-2, v0.7.9)'],
  ['src/lib/fields.ts', "    return { ...r, status: 'conflict', value: rv, source: 'merged'", "    return { ...r, status: 'ok', value: rv, source: 'merged'", 'rule/model difference not a conflict (C-FLD-1)'],
  ['src/lib/fields.ts', "    return { ...r, status: 'conflict', value: rv, source: 'merged'", "    return { ...r, status: 'conflict', value: modelD[0]!, source: 'merged'", 'model wins over rules (C-FLD-1)'],
  ['src/lib/fields.ts', 'if (ruleD.length >= 2 || modelD.length >= 2) return', 'if (modelD.length >= 2) return', 'several rule values not multiple (C-FLD-0)'],
  ['src/lib/fields.ts', 'candidates: all, source:', 'candidates: modelD, source:', 'multiple candidates not the union (C-FLD-0)'],
  ['src/lib/fields.ts', 'if (rule.some((x) => sameKey(x) === sameKey(m))) return', 'if (true) return', 'model amount not checked against the mail (v0.7.9)'],
  ['src/lib/fields.ts', "value: rule.length === 1 ? rule[0]! : null, source: 'merged', reason: 'model amount is not", "value: m, source: 'merged', reason: 'model amount is not", 'amount conflict keeps the model pick (v0.7.9)'],
  ['src/lib/fields.ts', "    if (rule.length === 1) return { ...r, value: rule[0]!, source: 'rule', confidence: 'rule', needsConfirmation: failed }\n", '', 'single rule amount not adopted (v0.7.9)'],
  ['src/lib/fields.ts', 'if (inMail.length === model.length) return', 'if (true) return', 'several model amounts not checked (Codex E2 re-run F6)'],
  ['src/lib/fields.ts', 'if (hits.length === 1) return { ok: true, value:', 'if (hits.length >= 1) return { ok: true, value:', 'two amounts in one value accepted (I-01)'],
  ['src/lib/fields.ts', 'return d ? { ok: true, value: d.id }', 'return d ? { ok: true, value: name }', 'deal field stores the restored name (C-RED-2, TC-FLD-08)'],
  ['src/lib/fields.ts', "return hits.length === 1 && hits[0]!.iso ?", "return hits.length >= 1 && hits[0]!.iso ?", 'several dates in one value accepted (C-EXT-5)'],
  ['src/lib/fields.ts', 'r.uetrs.length === 1 && r.invalid.length === 0', 'r.uetrs.length >= 1', 'invalid UETR beside a valid one accepted (C-EXT-1)'],
  ['eval/metrics.ts', "    if (floor === 'high' || c === 'unclassified') continue\n", '', 'high-floor classes in macro F1 (§6)'],
  ['eval/metrics.ts', '    if (tp + fn === 0) continue\n', '', 'classes without positives in macro F1 (§6)'],
  ['eval/metrics.ts', '(2 * tp) / (2 * tp + fp + fn)', '(2 * tp) / (2 * tp + fn)', 'false positives ignored in F1'],
  ['eval/metrics.ts', 'if (isVoid(ann)) return sys.status === \'void\'', "if (isVoid(ann)) return true", 'void annotation always correct (§6)'],
  ['eval/metrics.ts', "if (isMultiple(ann)) return sys.status === 'multiple' && keySet(sys.candidates) === keySet(ann.multiple)", "if (isMultiple(ann)) return sys.status === 'multiple'", 'multiple candidates not compared (§6)'],
  ['eval/metrics.ts', "if (ann === null) return !hasValue(sys)", 'if (ann === null) return true', 'empty annotation always correct (§6)'],
  ['eval/metrics.ts', '      } else if (listed) {', '      } else {', 'unlisted fields counted as empty (§6)'],
  ['eval/metrics.ts', 'if (m.value !== null && m.value < min)', 'if (m.value !== null && m.value < min - 0.05)', 'thresholds loosened (§6)'],
  ['eval/metrics.ts', "    let ok = !!o\n", "    let ok = true\n", 'missing system output passes rule fields'],
  // E2 self-test fixes
  ['src/lib/kyc.ts', 'const LINE_BREAK = /\\r\\n|[\\n\\r\\v\\f\\u0085\\u2028\\u2029]/', 'const LINE_BREAK = /\\n/', 'MRZ only after \\n (LK-F3; updated to the v0.7.19 code in E5)'],
  ['src/lib/kyc.ts', "MRZ_START.test(line) && line.includes('<<')", 'MRZ_START.test(line)', 'MRZ without << on the line (C-RED-0 ② v0.7.19, added in E5)'],
  ['src/lib/kyc.ts', "findPhrases(n.replace(CJK, ' $1 '), WORDS)", 'findPhrases(n, WORDS)', 'English word against CJK not a word (P1)'],
  ['src/lib/classify.ts', '[i.subject, i.body, i.bodyHtml, ...i.attachmentTexts]', '[i.subject, i.body, ...i.attachmentTexts]', 'IBAN in the HTML body ignored (CF-F3)'],
  ['src/lib/classify.ts', 'for (const b of [i.body, i.bodyHtml].map(normaliseText))', 'for (const b of [i.body].map(normaliseText))', 'change words in the HTML body ignored (CF-F3)'],
  ['src/lib/classify.ts', "(modelText.includes(p) ? p : '[?]')", '(p)', 'unknown placeholders kept in reasons (MN-F4)'],
  ['src/lib/fields.ts', '  if (rule.some((x) => sameKey(x) === sameKey(m))) return', '  if (rule.length === 0 || rule.some((x) => sameKey(x) === sameKey(m))) return', 'model amount accepted with no amount in the mail (MN-F2)'],
  ['src/lib/fields.ts', 'const same = ctx.rules.evidenceAmounts.filter(', 'const same = ctx.rules.amounts.filter(', 'as-written amounts outside MT103 / pacs.008 (CF-F5)'],
  ['src/lib/fields.ts', "  if (voided && modelD.length === 0 && !ruleFilled) return { ...r, status: 'void', needsConfirmation: true }", "  if (false) return { ...r, status: 'void', needsConfirmation: true }", 'fabricated candidates not void (MN-F3)'],
  ['src/lib/classify.ts', 'if (seen && RANK[l.confidence] <= RANK[seen.confidence as keyof typeof RANK]) continue', 'if (seen) continue', 'a later high mention of a class dropped (Codex E2 re-run F7)'],
  ['src/lib/kyc.ts', "const all = [a.text, ...(a.facts?.signalTexts ?? [])].join('\\n')", 'const all = a.text', 'attached message headers not checked together with the body (Codex E2 re-run F2, round 2 F11)'],
  ['src/lib/fields.ts', "needsConfirmation: failed || r.confidence === 'low' }\n  // the pick is not", "needsConfirmation: r.confidence === 'low' }\n  // the pick is not", 'an invalid candidate beside a valid one not yellow (round 2 F13)'],
  ['src/lib/fields.ts', '      if (!knownPlaceholders(it.value, ctx)) {', '      if (false) {', 'guessed placeholders kept (MN-F4)'],
  ['src/lib/fields.ts', "needsConfirmation: failed || (modelD.length > 0 && r.confidence === 'low') }", 'needsConfirmation: failed }', 'low confidence not yellow when rules agree (CF-F6)'],
  ['src/lib/model-policy.ts', "if (m.location === 'local' && m.provider !== 'anthropic')", "if (m.location === 'local')", 'hosted provider declared local (LK-F2)'],
  ['eval/metrics.ts', 'if (exactSet(exp) !== exactSet(act)) {', 'if (keySet(exp) !== keySet(act)) {', 'rule fields compared case-insensitively (EV-F4)'],
  // Codex (partial) and stand-in
  ['src/lib/fields.ts', "    if (items.some((it) => it.value !== null && typeof it.value !== 'boolean'", "    if (false && items.some((it) => it.value !== null && typeof it.value !== 'boolean'", 'one secret candidate voids only itself (S2)'],
  ['src/lib/fields.ts', "if (KIND[field] === 'uetr' && modelD.length === 0 && r.invalid) return", 'if (false) return', 'invalid model UETR beside the rule one not a conflict (S3)'],
  ['src/lib/kyc.ts', "const n = normaliseText(text).toLowerCase().replace(CJK, ' $1 ')", 'const n = normaliseText(text).toLowerCase()', 'birth details against CJK missed (X3)'],
  ['src/lib/model-policy.ts', "if (m.provider === 'ollama' && m.ollama_host && !looksLocal(m.ollama_host))", 'if (false)', 'remote Ollama declared local not warned (S4)'],
  ['src/lib/model-policy.ts', "  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true", "  if (m) return true", '172.32.x read as private (S4)'],
  ['src/adapters/llm/replay.ts', '    if (r.error) throw new LlmOutputError(r.error, r.raw)\n', '', 'recorded cut-off reply replays as success (X2)'],
  ['src/adapters/llm/replay.ts', 'if (!existsSync(f)) throw new ReplayMissingError(', 'if (!existsSync(f)) throw new Error(', 'missing recording a plain error (X1)'],
  // verification round
  ['src/adapters/llm/anthropic.ts', 'if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new SetupError(', 'if (false) throw new SetupError(', 'rejected credentials counted as attempts (R1)'],
  ['src/adapters/llm/ollama.ts', 'if (code) throw new SetupError(', 'if (false) throw new SetupError(', 'refused Ollama connection counted as an attempt (R1)'],
  ['src/adapters/llm/replay.ts', 'if (same(r.settings, this.inner.settings ?? null)) return', 'return', 'recorder cannot re-record after a settings change (R2)'],
  // owner acceptance
  ['src/lib/fields.ts', "if (ctx.rules.valueDates.includes(iso)) return { ok: true, value: iso }", "return { ok: true, value: iso }", 'any YYMMDD read as a value date'],
  // E3 (PRD §5.6–5.11, §6 v0.7.12–v0.7.14)
  ['src/lib/risk.ts', "['C-RSK-2:first_time_sender_account', i.signals.first_time_sender === true && i.accountPresent]", "['C-RSK-2:first_time_sender_account', i.signals.first_time_sender === true || i.accountPresent]", 'first-time sender alone is high'],
  ['src/lib/risk.ts', '!i.amountsAttachment.some((a) => body.has(key(a)))', '!i.amountsAttachment.every((a) => body.has(key(a)))', 'amount mismatch not by sets'],
  ['src/lib/risk.ts', 'i.receivedDate, i.plannedCloseDate) <= 3', 'i.receivedDate, i.plannedCloseDate) <= 4', 'closing window 4 working days'],
  ['src/lib/risk.ts', 'i.plannedCloseDate !== null && i.plannedCloseDate >= i.receivedDate', 'i.plannedCloseDate !== null', 'closing date in the past counts'],
  ['src/lib/risk.ts', 'Math.min(2, RANK[base] + steps)', 'Math.min(2, RANK[base] + Math.min(steps, 1))', 'upgrades do not add up'],
  ['src/lib/risk.ts', "'withdrawal', 'exit_distribution']", "'withdrawal']", 'pressure ignored for exit_distribution'],
  ['src/lib/risk.ts', 'if (RANK[computed.level] > RANK[adj.computedAtSet] || fresh.length > 0)', 'if (RANK[computed.level] > RANK[adj.computedAtSet])', 'a lowering survives a new reason (C-RSK-3 ⑤)'],
  ['src/lib/risk.ts', '(floors.has(r) ? RANK[floors.get(r)!] > RANK[level] : true)', '(floors.has(r) ? RANK[floors.get(r)!] >= RANK[level] : true)', 'R0 holds classes at the level (C-RSK-3 ①)'],
  ['src/lib/risk.ts', "needsApprover: RANK[level] < RANK[finalNow],", "needsApprover: RANK[level] < RANK[computed.level],", 'approver judged against the computed risk (C-RSK-3 ②)'],
  ['src/lib/risk.ts', 'return { level: maxLevel(computed.level, adj.level), void: false }', 'return { level: adj.level, void: false }', 'a raise caps the risk'],
  ['src/lib/draft.ts', "if (i.adopted.includes('bank_details') || i.adopted.includes('identity_change')) return", "if (i.adopted.includes('bank_details')) return", 'identity_change not forced to safe_ack (C-DRF-3 ①)'],
  ['src/lib/draft.ts', 'if (i.templates.get(chosen)?.discloses && !i.mayDisclose)', 'if (false)', 'C-LNK-5 not applied (C-DRF-3 ⑤)'],
  ['src/lib/draft.ts', 'workingDaysAfter({ holidays: i.holidays }, p.date!, i.receivedDate) < 5', 'workingDaysAfter({ holidays: i.holidays }, p.date!, i.receivedDate) <= 5', 'payment_wait at 5 working days'],
  ['src/lib/draft.ts', "if (i.ledger === 'received') return 'payment_received'", "if (i.ledger !== 'not_received') return 'payment_received'", 'unknown ledger asserts receipt'],
  ['src/lib/draft.ts', "return date > i.receivedDate ? { date, status: 'invalid' } : { date, status: 'ok' }", "return { date, status: 'ok' }", 'a future payment date accepted'],
  ['src/lib/draft.ts', "if (ev.length > 1) return { date: null, status: 'unknown' }", "if (ev.length > 2) return { date: null, status: 'unknown' }", 'two different value dates accepted'],
  ['src/lib/draft.ts', "if (asserts) for (const p of placeholders) if (!['directory', 'ledger'].includes(PLACEHOLDER_SOURCE[p] ?? ''))", "if (false) for (const p of placeholders) if (!['directory', 'ledger'].includes(PLACEHOLDER_SOURCE[p] ?? ''))", 'asserts_receipt template may use field values'],
  ['src/lib/draft.ts', 'const missing = placeholdersOf(s).some((p) => values[p] === null || values[p] === undefined)', 'const missing = placeholdersOf(s).some((p) => values[p] === undefined)', 'a null value printed instead of removing the sentence'],
  ['src/lib/draft.ts', '(best === null || RANK[c.risk_floor] > RANK[best.risk_floor] ? c : best)', '(best === null || RANK[c.risk_floor] >= RANK[best.risk_floor] ? c : best)', 'main class ties go to the later class'],
  ['src/lib/link.ts', 'const contact = matched.length === 1 ?', 'const contact = matched.length >= 1 ?', 'shared address linked to the first contact'],
  ['src/lib/link.ts', 'return contact.investorIds.includes(commitmentKeyLinked) || contact.authorisedFor.includes(commitmentKeyLinked)', 'return contact.investorIds.includes(commitmentKeyLinked)', 'authorised_for ignored'],
  ['src/lib/link.ts', 'if (!authenticatedSender || !commitmentKeyLinked || !contact) return false', 'if (!commitmentKeyLinked || !contact) return false', 'unauthenticated sender may be told'],
  ['src/lib/link.ts', 'daysApart(l.date, i.paymentDate) <= 5', 'daysApart(l.date, i.paymentDate) <= 6', 'bank line 6 days apart listed'],
  ['src/lib/link.ts', "(l.status === 'auto' || l.status === 'confirmed') && l.commitmentKeyHmac === c.keyHmac && l.currency === currency", "(l.status === 'auto' || l.status === 'confirmed') && l.commitmentKeyHmac === c.keyHmac", 'another currency counted as received'],
  ['src/lib/link.ts', "(l.status === 'auto' || l.status === 'confirmed') && l.commitmentKeyHmac", "(l.status !== 'rejected') && l.commitmentKeyHmac", 'unmatched rows counted as received'],
  ['src/lib/link.ts', 'conflict: i.deal !== null && i.deal !== dealOf(commitment.dealKey)', 'conflict: false', 'deal conflict not shown'],
  ['src/lib/link.ts', 'if (byRef.length === 1) {', 'if (byRef.length >= 1) {', 'two reference matches linked to the first'],
  ['src/lib/verification.ts', "if (['created', 'role_granted', 'credential_reset'].includes(e.type)", "if (['created', 'role_granted'].includes(e.type)", 'a credential reset by the other person allowed'],
  ['src/lib/verification.ts', 'if (t(i.now) < t(i.checklistDoneAt) + i.coolingMs)', 'if (t(i.now) < t(i.checklistDoneAt))', 'no cooling-off period'],
  ['src/lib/verification.ts', "if (i.approver.role !== 'approver' && i.approver.role !== 'admin')", 'if (false)', 'a reviewer may approve'],
  ['src/lib/verification.ts', 'task.manualRevision !== now.manualRevision || task.contactId !== now.contactId ||', 'task.manualRevision !== now.manualRevision ||', 'a contact change keeps the task'],
  ['src/lib/verification.ts', "if (mine.some((e) => e.type === 'credential_reset' && t(e.at) > limit", "if (mine.some((e) => e.type === 'credential_reset' && t(e.at) > limit + 1e15", 'a recent reset allowed'],
  ['src/lib/events.ts', 'if (cond && !last.has(type)) out.push', 'if (cond) out.push', 'first-time events sent again'],
  ['src/lib/events.ts', 'uetr: s.ruleUetrs.length === 1 ? s.ruleUetrs[0]! : null', 'uetr: s.ruleUetrs.length >= 1 ? s.ruleUetrs[0]! : null', 'two UETRs: the first one sent'],
  ['src/lib/events.ts', "for (const k of Object.keys(e)) if (!COMMON.includes(k)) p.push(`unknown field ${k}`)", '', 'an extra common field accepted'],
  ['src/lib/actions.ts', 'i.adopted.includes(\'closing_confirmation\') && single(i.confirms) === \'yes\' && i.confirmsByPerson &&', 'i.adopted.includes(\'closing_confirmation\') && single(i.confirms) === \'yes\' &&', 'lead confirmation without a person'],
  ['src/lib/actions.ts', "if (payment && i.template === 'payment_need_evidence')", "if (payment && i.template !== null)", 'evidence asked whatever the template'],
  ['src/lib/workdays.ts', 'return w !== 0 && w !== 6 && !cal.holidays.has(iso)', 'return w !== 0 && w !== 6', 'bank holidays are working days'],
  ['src/lib/workdays.ts', "if (Date.parse(nowUtc) > Date.parse(dueUtc)) return 'overdue'", "if (Date.parse(nowUtc) >= Date.parse(dueUtc) + 3_600_000) return 'overdue'", 'overdue an hour late'],
  ['src/lib/output.ts', 'const guard = (v: string) => (/^[=+\\-@\\t\\r]/.test(v)', 'const guard = (v: string) => (/^[=+@\\t\\r]/.test(v)', 'a cell starting with - not guarded'],
  ['src/lib/output.ts', '(b === null || RANK[c.risk_floor] > RANK[b.risk_floor] ? c : b)', '(b === null || RANK[c.risk_floor] >= RANK[b.risk_floor] ? c : b)', 'queue ties go to the later class'],
  ['eval/metrics-e3.ts', "if (a.links.ambiguous) return 'says «received» where the commitment is ambiguous'", '', 'ambiguous commitment passes no-overreach'],
  ['eval/metrics-e3.ts', 'cash_due_minor: due !== null && due > 0 ? due : null', 'cash_due_minor: due', 'an unreadable amount due counts as received'],
  ['eval/metrics-e3.ts', "if (!a.classes.some((c) => PAYMENT_CLASSES.includes(c))) return", "if (false) return", '«received» in a non-payment mail passes'],
  // E3 write paths, caught by the database tests
  ['src/server/actions.ts', "if (lowers && !approved) throw new Refused(403", "if (false) throw new Refused(403", 'a reviewer lowers the risk by removing a class (C-CLS-5, v0.7.15 full risk)', DB],
  ['src/pipeline/stages-e3.ts', 'const held = hold !== null && rank(applied.level) < rank(hold) ? hold : null', 'const held = null', "a person's change lowers the risk without an approver (C-RSK-3 v0.7.15)", DB],
  ['src/pipeline/stages-e3.ts', "const replyTo = sig.reply_to_mismatch === false ? (hdr?.reply_to ?? []) : []", "const replyTo = m.headers.filter(([n]) => n.toLowerCase() === 'reply-to').flatMap(([, v]) => v.match(/[^\\s<>,;\"]+@[^\\s<>,;\"]+/g) ?? [])", 'recipients scanned from the raw Reply-To (A1)', DB],
  ['src/server/actions.ts', "if (r.generation !== cr.processing_generation) p.push(", "if (false) p.push(", 'a reply from an earlier generation approved (A3)', DB],
  ['src/server/actions.ts', "if (remove.some((x) => ruleLabels.has(x))) throw", 'if (false) throw', 'a rule label removed (TC-CLS-08)', DB],
  ['src/server/actions.ts', "if (forCopy && (r.approved_generation !== cr.processing_generation || r.approved_manual_revision !== cr.manual_revision))", 'if (false)', 'copy after a change (C-DRF-8)', DB],
  ['src/server/actions.ts', "if (r.needsApprover && (req.user!.role === 'reviewer' || !reason))", 'if (false)', 'a reviewer lowers the risk (C-RSK-3)', DB],
  ['src/server/actions.ts', "if (!allowedManualTemplates(ctx.select).includes(req.body.templateId)) throw", 'if (false) throw', 'any template chosen (C-DRF-7)', DB],
  ['src/pipeline/stages-e3.ts', 'const authenticated = sig.dmarc_pass === true && sender !== null', 'const authenticated = sender !== null', 'C-SIG-3 without dmarc', DB],
  ['src/pipeline/stages-e3.ts', 'const blocked = sensitiveIn(serialised, fullNumbers)', 'const blocked = false', 'events with a full IBAN sent', DB],
  // Codex E3 round 2
  ['src/pipeline/stages-e3.ts', 'JSON.stringify(noticeProblems(d.config, notice.subject, notice.text, tcon?.emails[0] ?? null))]', "'[]']", 'the rendered notice not checked (F13)', DB],
  ['src/server/cases.ts', 'notifyText: (x.notify_problems as string[]).length ? null : t(x.notify_text_blob)', 'notifyText: t(x.notify_text_blob)', 'a notice with problems offered for copying (F13)', DB],
  ['src/pipeline/stages-e3.ts', 'const accountPresent = texts.some(', 'const accountPresent = texts.slice(0, 3).some(', 'attachment names not looked at for accounts (F14)', DB],
  ['src/server/actions.ts', 'WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', 'WHERE id = ANY($1::uuid[]) ORDER BY id', 'the two users not locked during approval (F15)', DB],
  ['src/server/actions.ts', 'if (!me || me.disabled || me.credential_version !== req.user!.credentialVersion || me.role !== req.user!.role) throw', 'if (!me) throw', "the approver's current account not rechecked (F15)", DB],
  ['src/pipeline/stages-e3.ts', ".filter((e) => coherent || e.type === 'case.created' || e.type === 'case.assigned' || e.type === 'case.closed')", '', 'derived events from a half-done generation (F16)', DB],
  ['src/pipeline/stages-e3.ts', 'return n === 2 ? { gen: current, coherent: true }', 'return n >= 1 ? { gen: current, coherent: true }', '«not computed yet» sent as no actions (F16, R2)', DB],
  ['src/pipeline/stages-e3.ts', 'inputHash: sha256(JSON.stringify([gen, selection,', 'inputHash: sha256(JSON.stringify([selection,', 'a reply step reused across generations (F17)', DB],
  ['src/pipeline/stages-e3.ts', 'template: inUse?.template_id ?? rp.selection.template', 'template: rp.selection.template', 'actions from the automatic choice, not the reply in use (F18)', DB],
  ['src/server/cases.ts', 'actions: await currentActions(db, id, shown,', 'actions: rp.actions ?? await currentActions(db, id, shown,', 'the detail shows the stored actions (F18)', DB],
  ['src/server/exports.ts', 'const acts = rp ? await currentActions(d.db, x.id, gen, rp) : []', 'const acts = rp ? rp.actions : []', 'the CSV skips the reply in use (F18)', DB],
  ['src/pipeline/stages-e3.ts', "'UPDATE \"case\" SET due_at = $2, follow_up_at = $3 WHERE id = $1'", "'UPDATE \"case\" SET due_at = COALESCE(due_at, $2), follow_up_at = $3 WHERE id = $1'", "a person's queue keeps its old due time (F19)", DB],
  // (replacing now.queue with r.queue is equivalent outside a race: the step was prepared with the person's queue)
  ['src/pipeline/stages-e3.ts', 'info.received_at.toISOString(), now.queue)', 'info.received_at.toISOString(), null)', "the due time of the system's queue, not the person's (F19)", DB],
  ['src/server/actions.ts', 'const previousLink = personRow ?', 'const previousLink = false ?', "the person's active link ignored in the audit (F12)", DB],
  ['src/server/actions.ts', 'const lkDone = lkNow ?? (', 'const lkDone = lkNow ?? (false && ', 'no fall-back to the last complete generation (F12)', DB],
  // self-review of the round-2 fixes
  ['src/server/actions.ts', 'await emitEvents(c, sd, cr.id) // the reply in use, and so the actions, may change (C-OUT-3, self-review R1)', '', 'rejecting a reply sends no action change (R1)', DB],
  ['src/server/exports.ts', 'const { gen } = await outputGeneration(d.db, x.id, x.processing_generation, x.pipeline_complete_generation)\n    const rp', 'const gen = x.processing_generation\n    const rp', 'the CSV reads a half-done generation (R2)', DB],
  ['src/pipeline/stages-e3.ts', ".problems.filter((p) => p !== 'no_recipient')", '.problems', 'a notice without an address on file hidden (R3)', DB],
  ['src/pipeline/stages-e3.ts', "if (JSON.stringify(problems) !== JSON.stringify(live.notify_problems)) await", 'if (false) await', "a kept task's notice not checked again (R3)", DB],
  // Codex E3 round 3
  ['src/pipeline/stages-e3.ts', 'inputHash: sha256(JSON.stringify([gen, computed,', 'inputHash: sha256(JSON.stringify([computed,', 'a risk result reused without writing the Case (F20)', DB],
  ['src/pipeline/stages-e3.ts', 'return suggestedActions({ ...rp.actionInput, template:', 'return suggestedActions({ ...rp.actionInput, leadConfirmed: rp.actionInput.leadConfirmed || rp.actionInput.adopted.includes(\'closing_confirmation\'), template:', 'actions from pending changes (F21)', DB],
  ['src/pipeline/stages-e3.ts', "ORDER BY (status IN ('approved', 'sent')) DESC, approved_at DESC NULLS LAST, created_at DESC LIMIT 1", "ORDER BY (status IN ('approved', 'sent')) DESC, created_at DESC LIMIT 1", 'an older sent reply decides the actions (F23)', DB],
  ['src/pipeline/stages-e3.ts', 'const facts: CaseFacts = lk && cr.risk ?', 'if (!lk || !cr.risk) return 0\n  const facts: CaseFacts = lk && cr.risk ?', 'no assignment events before the first link step (F22)', DB],
  ['eval/metrics-e3.ts', "'party_role', 'account_last4', 'change_fields', 'document_types', 'deal'", "'party_role', 'deal'", 'injection scoring skips the enum arrays (F24)'],
  ['eval/metrics-e3.ts', '[...new Set(v.map((x) => JSON.stringify(x)))].sort() : null', 'v.map((x) => JSON.stringify(x)) : null', 'enum arrays compared in order (F24)'],
  // self-review of the round-3 fixes
  ['src/pipeline/stages-e3.ts', '  const { gen, coherent } = await outputGeneration(', '  if (!cr.queue) return 0\n  const { gen, coherent } = await outputGeneration(', 'no case.closed before the Case is routed (S1)', DB],
  ['src/pipeline/stages-e3.ts', "filter((e) => coherent || e.type === 'case.created' || e.type", "filter((e) => coherent || e.type", 'assignments sent before case.created (S2)', DB],
  ['src/server/cases.ts', 'const shown = (await outputGeneration(db, id, gen, done)).gen', 'const shown = done ?? gen', 'the page reads another generation than the CSV (S5)', DB],
  ['eval/metrics-e3.ts', 'if (Array.isArray(v)) return v.length ?', 'if (Array.isArray(v)) return true ?', 'an empty array differs from an empty field (S6)'],
  // Codex E3 round 4
  ['src/pipeline/stages-e3.ts', 'WHERE case_id = $1 AND generation = $2 AND approved_generation = $2 AND status IN', 'WHERE case_id = $1 AND $2::int IS NOT NULL AND status IN', 'an older sent reply sent as the current approval (F25)', DB],
  ['src/server/exports.ts', "const labels = [...((await resultOf<ReplyStageResult>(d, x.id, 'reply', gen))?.labels.adopted ?? [])]", "const labels = [...(await (await import('../pipeline/stages-e3.ts')).effectiveLabels(d, x.id, gen)).adopted]", 'the case CSV shows pending classes beside the old risk (F26)', DB],
  ['src/server/cases.ts', 'adopted: rp.labels.adopted, low: rp.labels.low,', 'adopted: labels.adopted, low: labels.low,', 'the page shows pending classes beside the old risk (F26)', DB],
  // self-review of the round-4 fixes
  ['src/server/cases.ts', 'final: rk.final, by: rk.by,', 'final: c.risk ?? rk.final, by: c.risk_by ?? rk.by,', 'the page shows the newer risk beside the older classes (T2)', DB],
  ['src/server/exports.ts', "classes: labels.sort().join(';'), risk,", "classes: labels.sort().join(';'), risk: x.risk,", 'the case CSV shows the newer risk beside the older classes (T2)', DB],
  ['src/pipeline/stages-e3.ts', "WHERE case_id = $1 AND status = 'approved' AND generation < $2 RETURNING id", "WHERE false AND case_id = $1 AND status = 'approved' AND generation < $2 RETURNING id", 'an approval from an earlier generation stays live until the next copy (owner acceptance S1)', DB],
  ['src/pipeline/stages-e3.ts', "await c.query(`UPDATE \"case\" SET status = 'open' WHERE id = $1 AND status = 'approved'`, [cr.id])\n        await appendAudit", "await appendAudit", 'the Case still says approved after its approval lapsed (owner acceptance S1)', DB],
  ['src/server/cases.ts', "outOfDate: r.generation !== gen && (r.status === 'draft' || r.status === 'approved')", "outOfDate: r.generation !== gen && r.status === 'draft'", 'an approved reply from an earlier generation is not shown as out of date (owner acceptance S1)', DB],
  ['src/server/cases.ts', "FILTER (WHERE s.value AND s.signal <> 'dmarc_pass')", "FILTER (WHERE s.value)", 'the case list counts an authenticated sender as a warning (owner acceptance S2)', DB],
  // Codex E2 round 3
  ['src/lib/kyc.ts', "const tree = contentReason(treeText(a.text, a.facts))", 'const tree = null as string | null', 'birth details at two levels of an attachment not counted together (F14)'],
  ['src/adapters/llm/ollama.ts', 'throw new SetupError(`cannot connect to ollama (${code})`)', 'throw new SetupError(`cannot connect to ollama at ${this.host}: ${(e as Error).message}`)', 'the Ollama address and transport text in the setup error (F15)'],
  ['src/adapters/llm/types.ts', "const UNSENT = new Set(['ECONNREFUSED',", "const UNSENT = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'ECONNREFUSED',", 'a connection broken after the request counted as unsent (F16)'],
  ['src/adapters/llm/anthropic.ts', 'const code = e instanceof Anthropic.APIConnectionError && !(e instanceof Anthropic.APIConnectionTimeoutError) ? unsentCode(e) : null', "const code = e instanceof Anthropic.APIConnectionError && !(e instanceof Anthropic.APIConnectionTimeoutError) ? 'any' : null", 'every Anthropic connection error a setup error (F16)'],
  ['src/adapters/llm/types.ts', 'return unsentCode(x.cause, depth + 1)', 'return null', 'the cause of a fetch failure not looked at (F16)'],
  ['src/lib/fields.ts', 'const failed = r.invalid || voided', 'const failed = r.invalid', 'a candidate voided for its quote beside a valid one not yellow (F17)'],
  // self-review of the round-3 fixes
  ['src/adapters/llm/types.ts', "'ERR_INVALID_URL',\n  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',", "'ERR_INVALID_URL',\n  'CERT_HAS_EXPIRED_X', 'CERT_NOT_YET_VALID',", 'a failed TLS handshake counted as an attempt (S4)'],
  // Codex E2 round 4
  ['src/lib/text.ts', "word: m[0].replace(MARK, '').toLowerCase()", 'word: m[0].toLowerCase()', 'a combining mark hides a KYC word (F18)'],
  // self-review of the round-4 fixes
  ['src/lib/text.ts', 'const WORD = /[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}]*/gu', 'const WORD = /[\\p{L}\\p{N}]+/gu', 'a vowel sign cuts a Devanagari name (T1)'],
  ['src/lib/redact.ts', '.filter((w) => w.length >= 3)', '.filter((w) => Array.from(w.word).length >= 3)', 'a name word measured without its marks (T1)'],
  // Codex E2 round 5
  ['src/adapters/llm/types.ts', "'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'])", "'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER'])", 'a TLS error after the request counted as unsent (F23)'],
  ['src/adapters/llm/ollama.ts', "throw new SetupError(`cannot connect to ollama (${errorCode(e) ?? 'no answer'})`)", 'throw new SetupError(`cannot connect to ollama at ${this.host}: ${(e as Error).message}`)', 'the address in the probe error (F23)'],
  ['src/adapters/llm/ollama.ts', '    if (this.probed) return\n', '', 'the probe sent before every request (F23)'],
  ['src/adapters/llm/ollama.ts', '    await this.probe()\n', '', 'https to a plain-http port found only by a model request (F21)'],
  ['src/lib/fields.ts', 'return { ...resolveField(field, undefined, ctx), reason, needsConfirmation: true }', 'return resolveField(field, undefined, ctx)', 'a rejected placeholder beside the rule value not yellow (F22)'],
  // E4 (self-test gate). Equivalent mutants, by reasoning: dueMessages' recursion over the earlier Cases of a held thread
  // (deleteMessage re-checks the later Cases under their locks, the decisive check); runFileDeletions deleteAllVersions →
  // delete on disk (one version); createDeliveries «NOT source_deleted» (the attachment already has its row, which
  // NOT EXISTS and the unique key keep single); replaceableMessages: «bool_and» and the per-attachment condition are
  // redundant on purpose; each alone is equivalent, so the mutant below turns both off.
  ['src/maintenance/retention.ts', "if (thread.some((x) => x.hold)) return 'kept'", 'if (false) return \'kept\'', 'a hold on a later Case of the thread ignored under the locks', R4],
  ['src/maintenance/retention.ts', '      if (next.rowCount) {', '      if (false) {', 'a cleared thread link not audited', R4],
  ['src/maintenance/retention.ts', '\n   OR v.id = (SELECT w.id FROM directory_version w WHERE w.kind = v.kind AND w.deal_key IS NOT DISTINCT FROM v.deal_key ORDER BY w.imported_at DESC, w.id DESC LIMIT 1))', ')', 'the current directory version counted as unreferenced (E5)', R4],
  ['src/maintenance/retention.ts', 'b.created_at < $1 AND ${unused} LIMIT 1000)`, [new Date(now.getTime() - DAY_MS)])', 'b.created_at < $1 AND ${unused} LIMIT 1000)`, [now])', 'a fresh unreferenced blob swept (review #11)', R4],
  ['src/maintenance/kyc.ts', "HAVING bool_and(d.state IN ('delivered', 'discarded'))\n        AND NOT EXISTS (SELECT 1 FROM kyc_replacement r WHERE r.message_id = d.message_id AND r.step = 5)\n        AND NOT EXISTS (SELECT 1 FROM attachment a WHERE", "HAVING bool_or(d.state IN ('delivered', 'discarded'))\n        AND NOT EXISTS (SELECT 1 FROM kyc_replacement r WHERE r.message_id = d.message_id AND r.step = 5)\n        AND NOT EXISTS (SELECT 1 FROM attachment a WHERE false AND", 'replaced while one transfer has failed (C-PRV-2; both redundant checks off)', K4],
  ['src/maintenance/kyc.ts', 'if (ack?.delivery_id !== meta.deliveryId || ack?.sha256 !== meta.sha256)', 'if (false)', 'any 2xx counted as a receipt (E4)', K4],
  ['src/maintenance/kyc.ts', 'const QUICK_ATTEMPTS = 3', 'const QUICK_ATTEMPTS = 1', 'failed after one attempt', K4],
  ['src/maintenance/kyc.ts', "const LATER_STAGES = ['extract', 'redact',", "const LATER_STAGES = ['redact',", 'the old extraction kept after the KYC deletion', K4],
  ['src/ingest/mime.ts', 'Buffer.concat([copy.subarray(0, s.start), REMOVED_PART, copy.subarray(s.end)])', 'copy', 'the KYC part left in the stripped copy', K4],
  ['src/maintenance/rotation.ts', ' OR EXISTS (SELECT 1 FROM attachment WHERE file_ref = $1)\n', '\n', 'a live attachment with a stale deletion job not rotated (Codex round 4 F3)', T4],
  ['src/maintenance/rotation.ts', 'if (last !== to) throw', 'if (false) throw', 'rotation before the service writes with the new key', T4],
  ['src/maintenance/rotation.ts', '      if (starts.every((x) => x === to)) {', '      if (true) {', 'a start with the old key during the rotation not caught (review round 2 #2)', T4],
  ['src/maintenance/rotation.ts', "        if (expected.length && !expected.includes(createHash('sha256').update(plain).digest('hex')))", '        if (false)', 'an object holding another object\'s content accepted (Codex round 6 F2)', T4],
  ['src/store/s3.ts', "    await this.pruneOldVersions(key, r.headers.get('x-amz-version-id'))\n", '', 'old S3 versions kept after a rewrite', T4],
  ['src/maintenance/rotation.ts', '    if (used.includes(id)) out.push', '    if (false) out.push', 'a missing key that data still needs not refused', T4],
  ['src/adapters/mailbox/gmail.ts', 'return !l.some((x) => NEVER.has(x)) && l.some', 'return l.some', 'sent / draft messages received (C-ING-6)', M4],
  ['src/adapters/mailbox/gmail.ts', "if (r.body.scope !== undefined && r.body.scope.split(' ').sort().join(' ') !== GMAIL_SCOPE)", 'if (false)', 'a token with a broader scope used', M4],
  ['src/adapters/mailbox/gmail.ts', 'if (p.body?.emailAddress?.toLowerCase() !== this.o.address.toLowerCase())', 'if (false)', 'a token for another account used (review #7)', M4],
  ['src/adapters/mailbox/gmail.ts', '      if (r.status === 404) return null\n', '', 'an expired historyId not resynced', M4],
  ['src/adapters/mailbox/http.ts', "r.method === method && r.host === u.hostname && r.re.test(path)", 'r.method === method && r.re.test(path)', 'any host allowed (review #9)', M4],
  ['src/adapters/mailbox/http.ts', "redirect: 'error'", "redirect: 'follow'", 'redirects followed', M4],
  ['src/adapters/mailbox/graph.ts', "else if (!(n.status === 403 && /AccessDenied/i.test(code)))", 'else if (false)', 'an uncertain negative probe accepted (C-ING-4 ④)', M4],
  ['src/adapters/mailbox/graph.ts', ".filter((v) => v.startsWith('Mail.') || v === '?')", ".filter((v) => v === 'Mail.Send')", 'Mail.ReadWrite / tenant-wide Mail.Read accepted (C-ING-4 ②)', M4],
  ['src/adapters/mailbox/graph.ts', '> 180 * 86_400_000', '> 365 * 86_400_000', 'a review older than 180 days accepted (C-ING-4 ①)', M4],
  ['src/adapters/mailbox/graph.ts', "if ((r.status === 410 ||", "if (false && (r.status === 410 ||", 'an invalid sync state not resynced (C-ING-5)', M4],
  ['src/server/actions.ts', "'/api/cases/:id/hold', { ...OPTS, preHandler: need('approver') }", "'/api/cases/:id/hold', OPTS", 'a reviewer sets a hold (R-REV-07)', H4],
  ['src/server/actions.ts', "'/api/kyc/deliveries/:id/retry', { ...OPTS, preHandler: need('admin') }", "'/api/kyc/deliveries/:id/retry', OPTS", 'a reviewer retries a KYC transfer', K4],
  // D8 (PRD v0.7.21). Not listed, by reasoning: cases.ts impersonatedContact's comparison with the bound contact — a task
  // bound to another contact always comes with a linked contact, and then taskContact is not «impersonated» either.
  ['src/lib/verification.ts', 'return named.length === 1 ?', 'return named.length >= 1 ?', 'one of two namesakes chosen as the task contact (D8)'],
  ['src/lib/verification.ts', 'if (displayNameMismatch !== true) return null', 'if (displayNameMismatch === false) return null', 'an unknown display-name signal counts as impersonation (D8)'],
  ['src/lib/signals.ts', "'instructions to the assistant', 'choose template', ", "'instructions to the assistant', ", 'choose template missing from the injection list (D8)'],
  ['src/pipeline/stages-e3.ts', 'placeholderValues({ lk: { ...lk, contact: tcon }, fields: {}', 'placeholderValues({ lk, fields: {}', 'the notice names the linked contact, not the task contact (D8)', DB],
  ['src/pipeline/stages-e3.ts', 'tcon?.emails[0] ? await putBlob(c, d.k, tcon.emails[0])', 'lk.contact?.emails[0] ? await putBlob(c, d.k, lk.contact.emails[0])', 'the notice goes to the linked contact only (D8)', DB],
  ['src/lib/risk.ts', "const floorClasses = base === 'low' ? [] : ", 'const floorClasses = ', 'a low class floor named as a reason (D8)'],
  ['src/lib/risk.ts', 'labels.filter((l) => floors.get(l) === base)', 'labels', 'a class below the base level named as the floor (D8)'],
  ['src/server/cases.ts', ".filter((x) => x.action === 'remove' && !rp.labels.adopted.includes(x.class_id) && !rp.labels.low.includes(x.class_id))", ".filter((x) => x.action === 'remove' && !rp.labels.low.includes(x.class_id))", 'a class the shown generation still adopts listed as removed (D8, review F2)', DB],
  ['src/server/cases.ts', " && !rp.labels.low.includes(x.class_id)) // low counts", ") // low counts", 'a low label of the shown generation listed as removed (Codex D8 F2)', DB],
  ['src/server/actions.ts', 'bound !== (taskContactOf(lk)?.contact.contactId ?? null)', 'bound !== (lk?.contact?.contactId ?? null)', 'an impersonation task can never be completed (Codex D8 F1)', DB],
  ['src/web/api.ts', String.raw`(?:[CRI]-[A-Z]+-\d+[a-z]?|I-\d+)`, String.raw`(?:C-[A-Z]+-\d+[a-z]?|I-\d+)`, 'R-* ids left in error texts (D8)', 'npx vitest run src/web --reporter=dot'],
  // E5 (PRD v0.7.22, tech design v0.7.11). Not listed, by reasoning: the compose files, the AppArmor and seccomp profiles
  // and scripts/demo-snapshot.ts are checked by the compose and parser CI jobs (TC-DEMO-01/03/04, TC-OPS-01–03/06/07,
  // TC-ING-10 under the profiles), which a mutation run cannot start; the seccomp file is compared with its generator.
  ['src/store/migrate.ts', 'if (opts.demo && !state.empty && !state.demo) throw', 'if (false) throw', 'DEMO=1 wipes a database with data and no marker (E5 R2)', E5M],
  ['src/store/migrate.ts', 'if (!opts.demo && state.demo) throw', 'if (false) throw', 'a demo database migrated as a real one (E5 R1)', E5M],
  ['src/store/migrate.ts', '    const state = await dbState(c)\n', '    await setRoles(c, passwords)\n    const state = await dbState(c)\n', 'role passwords changed before a refusal (E5 R2)', E5M],
  ['src/store/migrate.ts', '; GRANT USAGE ON SCHEMA public TO PUBLIC', '', 'the rebuilt demo schema unusable by the roles (E5)', E5M],
  ['src/store/migrate.ts', "await c.query('INSERT INTO demo_marker (id) VALUES (1)')", '', 'an empty database migrated by the demo without its marker (E5 V1)', E5M],
  ['src/startup.ts', 'if (!demoMode && demoDb) throw', 'if (false) throw', 'serve / maintain run a demo database without DEMO=1 (E5 R1, W1)', E5G],
  ['src/startup.ts', 'if (demoMode && !demoDb) throw', 'if (false) throw', 'DEMO=1 on a database without the marker (E5)', E5G],
  ['src/server/auth.ts', 'return a.length === b.length && timingSafeEqual(a, b)', 'return a.length === b.length', 'any CSRF token of the right length accepted (E5 F4)', E5S],
  ['src/server/auth.ts', "k.hmac(`csrf-token\\0${session}`)", "k.hmac('csrf-token')", 'one CSRF token for every session (E5 F4)', E5S],
  ['src/server/app.ts', "'/api/logout', '/api/csrf'])", "'/api/logout'])", 'a must-change-password tab cannot fetch its token (E5 R12)', E5S],
  ['src/ops/secrets.ts', '    if (existsSync(file)) {', '    if (false) {', 'init-secrets overwrites an existing secret (E5 TC-OPS-01)', 'npx vitest run src/ops --reporter=dot'],
  ['src/ops/env-files.ts', "!file || env[name] !== undefined", '!file', 'a _FILE variable overrides one already set (E5)', 'npx vitest run src/ops --reporter=dot'],
  ['src/ops/head-export.ts', 'if (m !== lastError) report(', 'report(', 'an export failure reported on every attempt (E5 F5)', 'npx vitest run src/ops --reporter=dot'],
  ['src/ops/demo.ts', "if (m.kind !== 'eml') problems.push", "if (false) problems.push", 'the demo starts with a real mailbox (E5 R6)', 'npx vitest run src/ops --reporter=dot'],
  ['src/ops/demo.ts', "if (c.model?.provider !== 'replay') problems.push", "if (c.model?.provider === 'anthropic') problems.push", 'the demo starts with a local model (E5 R6)', 'npx vitest run src/ops --reporter=dot'],
  ['src/maintenance/daily.ts', '  if (opts.kycReplacement) await runKycReplacements(d).catch(log(\'KYC replacement\'))\n', '', 'maintain --once skips the KYC replacement (E5 self-test F3)', E5R],
  ['src/maintenance/daily.ts', '  await runDaily(d, config, now)\n}', '}', 'maintain --once skips retention (E5 self-test F3)', E5R],
  ['src/web/static-demo.ts', "if (method !== 'GET') return null", '', 'the static demo answers a change instead of refusing it (E5 TC-DEMO-04)', 'npx vitest run src/web --reporter=dot'],
  ['scripts/public-export.ts', ".replace(/负责人：[^·（\\n]+（产品）/g, '负责人：项目负责人（产品）')", '', "the owner's name left in the public documents (E5 TC-OPS-05)", E5P],
  ['scripts/public-export.ts', "if (/(?:^|[\\s`'\"(（=:])(?:~\\/(?:Documents|\\.config|Library)|\\/Users\\/[a-z]|\\/home\\/[a-z])/m.test(text)) problems.push(`${rel}: a local path`)", 'if (false) problems.push(`${rel}: a local path`)', 'a local path published (E5 TC-OPS-05)', E5P],
  ['src/store/directory.ts', '!!v.ledger && !clearedVersions.has(v.ledger)', '!!v.ledger', 'a cleared ledger counts as an empty ledger, not as none (C-DRF-6 v0.7.24, TC-DIR-09)', E5S],
  ['src/store/directory.ts', 'fileSha, o.clear === true])', 'fileSha, true])', 'every import marked as a clear (Codex D9 round 2 F2)', E5S],
  ['src/lib/directory.ts', "if (r.ok) return { ok: false, errors: [{ where: 'file', message: 'clear=yes needs", "if (false) return { ok: false, errors: [{ where: 'file', message: 'clear=yes needs", 'clear=yes with data rows imports them (PRD R-DIR-04 v0.7.24, TC-DIR-09)'],
  ['src/lib/directory.ts', "return r.errors.length === 1 && r.errors[0]!.where === 'file'", "return true || r.errors.length === 1 && r.errors[0]!.where === 'file'", 'clear=yes turns any broken file into an empty list (TC-DIR-09)'],
  ['src/lib/directory.ts', 'if (headerRec && body.length === 0) errors.push', 'if (false) errors.push', 'a header-only file replaces the list with an empty one (PRD R-DIR-04 v0.7.24, TC-DIR-09)'],
  ['src/pipeline/restart.ts', "if (!row || row.status !== 'failed' || ", 'if (!row || ', 'rerun-failed restarts a Case that is not failed (E5 acceptance G3, TC-OPS-09)', E5C],
  ['src/pipeline/restart.ts', "caseId, start, 'system')", "caseId, start, 'person')", "a re-run counted as a person's change (E5 acceptance G3, TC-OPS-09)", E5C],
  ['src/pipeline/restart.ts', "await appendAudit(c, k, [{ actor: 'system', type: 'case.rerun_failed'", "if (0) await appendAudit(c, k, [{ actor: 'system', type: 'case.rerun_failed'", 'a re-run not audited (E5 acceptance G3, TC-OPS-09)', E5C],
  ['src/pipeline/restart.ts', "> STAGES.indexOf('reply') ? 'reply' : row.failed_stage", "> STAGES.indexOf('reply') ? row.failed_stage : row.failed_stage", 'a re-run after route keeps the old generation\'s draft, which cannot be approved (Codex E5 round 5 F1)', E5C],
  ['src/server/app.ts', '({ oidc: !!d.oidc })', '({ oidc: true })', 'the organisation sign-in offered without OIDC (E5 acceptance G4)', E5S],
  ['scripts/public-export.ts', "(^|[^a-z0-9])${n.replace", "${n.replace", 'a forbidden name inside an ordinary word reported, hiding real hits (E5)', E5P],
  ['src/web/App.tsx', '{on.length === 0 && <p className="meta">', '{true && <p className="meta">', '«No warning signals» beside fired signals (R-REV-02 v0.7.25)', W],
  ['src/web/App.tsx', '{unknown.length > 0 && <ul', '{false && <ul', 'unchecked signals hidden (R-REV-02 v0.7.25)', W],
  ['src/web/App.tsx', '`No warning signals; ${unknown.length} could not be checked`', "'No warning signals'", 'unchecked signals not counted (R-REV-02 v0.7.25)', W],
  ['src/web/styles.css', "grid-template-areas: 'main side'", "grid-template-areas: 'side main'", 'the mail on the right (界面规则 v0.3.4)', WE],
  ['src/web/styles.css', 'appearance: none; -webkit-appearance: none; padding-right: 36px;', 'appearance: none; -webkit-appearance: none; padding-right: 12px;', 'the select arrow against the edge (界面规则 v0.3.4)', WE],
  ['src/web/CaseE3.tsx', '(STATIC_DEMO ? null : <>{children}</>)', '(<>{children}</>)', 'change controls in the static demo (R-DEMO-02 v0.7.25)', DEMO],
  ['src/web/CaseE3.tsx', "{STATIC_DEMO ? <><span aria-label={c.checked ? 'done' : 'not done'}>", "{false ? <><span aria-label={c.checked ? 'done' : 'not done'}>", 'checklist boxes in the static demo (R-DEMO-02 v0.7.25)', DEMO],
  ['src/web/App.tsx', '...Object.keys(SIGNAL_TEXT).filter((k) => !known.has(k))', '...([] as string[]).filter((k) => !known.has(k))', 'a signal without a row counted as clean (self-test F1)', W],
  ['src/web/App.tsx', '      {STATIC_DEMO ? (\n', '      {false ? (\n', 'user, role and Sign out in the static demo (R-DEMO-02 v0.7.25)', DEMO],
]

// the parity test with the Python oracle is a separate CI step; its result must not count as a catch here
const RUN = 'npx vitest run src/lib scripts eval/metrics.test.ts eval/metrics-e3.test.ts src/adapters/llm --exclude src/lib/oracle.test.ts --reporter=dot'
try {
  execSync(RUN, { stdio: 'ignore' })
} catch {
  console.log('the unmutated tests fail: fix them before the mutation check')
  process.exit(1)
}

let survived = 0
// MUTANTS_ONLY=src/server,src/pipeline runs the mutants of those paths only (a re-check after fixes)
const ONLY = process.env.MUTANTS_ONLY?.split(',') ?? null
for (const [file, from, to, what, cmd = RUN] of MUTANTS.filter(([f]) => !ONLY || ONLY.some((p) => f.startsWith(p)))) {
  const orig = readFileSync(file, 'utf8')
  if (orig.split(from).length !== 2) {
    console.log(`SETUP ${file}: original text not found exactly once (${what})`)
    survived++
    continue
  }
  writeFileSync(file, orig.replace(from, to))
  let caught = false
  try {
    execSync(cmd, { stdio: 'ignore' })
  } catch {
    caught = true
  } finally {
    writeFileSync(file, orig)
  }
  console.log(`${caught ? 'caught  ' : 'SURVIVED'} ${file}: ${what}`)
  if (!caught) survived++
}
const ran = MUTANTS.filter(([f]) => !ONLY || ONLY.some((p) => f.startsWith(p))).length
console.log(`${ran - survived} / ${ran} caught`)
process.exit(survived ? 1 : 0)
