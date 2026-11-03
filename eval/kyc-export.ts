// Test plan §3 export for the oracle's C-RED-0 check (Codex E4 F12, round 2 F13): kept apart from eval/run.ts so it can be
// tested on its own.
/**
 * Test plan §3 (v0.7.13, Codex E4 F12): each top-level attachment as C-RED-0 saw it, and the system's `maybe_kyc`, for the
 * oracle's independent KYC check. Status values are the export's own (ok, unsupported, over_limit, failed, timeout,
 * blocked, encrypted, too_deep); `text` is the attachment's own text, `children` its nested parts.
 */
export type NestedFacts = { pages?: number; pagesWithoutText?: number; encrypted?: boolean; tooDeep?: boolean; nested?: Array<{ filename: string; kind: string; offset: number; result: { status: string; text: string; facts: NestedFacts } }> }
/** A node's own text: the parser places each nested part's text inside its parent's; the export keeps them apart (round 2 F13). */
export const ownText = (text: string, facts: NestedFacts | null): string => {
  let out = text
  for (const n of [...(facts?.nested ?? [])].sort((a, b) => b.offset - a.offset)) {
    if (n.offset >= 0 && out.slice(n.offset, n.offset + n.result.text.length) === n.result.text) out = out.slice(0, n.offset) + out.slice(n.offset + n.result.text.length)
  }
  return out
}
export const exportStatus = (status: string, facts: NestedFacts | null): string => {
  if (facts?.encrypted) return 'encrypted'
  if (facts?.tooDeep) return 'too_deep'
  return ({ parsed: 'ok', not_parsed: 'unsupported', over_limit: 'over_limit', failed: 'failed', timeout: 'timeout', blocked: 'blocked' } as Record<string, string>)[status] ?? 'failed'
}
export const exportChildren = (facts: NestedFacts | null): unknown[] =>
  (facts?.nested ?? []).map((n) => ({
    filename: n.filename, kind: n.kind, parse_status: exportStatus(n.result.status, n.result.facts), pdf_pages: n.result.facts.pages ?? null,
    pdf_pages_without_text: n.result.facts.pagesWithoutText ?? null, text: ownText(n.result.text, n.result.facts), children: exportChildren(n.result.facts),
  }))
