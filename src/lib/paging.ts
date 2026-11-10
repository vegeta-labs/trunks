// PRD R-REV-01 v0.7.29: the page of the Case list a request asks for, for the server and the static demo alike. A limit
// or offset that is not a whole number in range counts as absent, never as a failed query.
export const DEFAULT_PAGE = 50
export const MAX_PAGE = 200

export function pageOf(limit: number | undefined, offset: number | undefined): { limit: number; offset: number } {
  return {
    limit: Number.isSafeInteger(limit) && limit! >= 1 ? Math.min(limit!, MAX_PAGE) : DEFAULT_PAGE,
    offset: Number.isSafeInteger(offset) && offset! >= 0 ? offset! : 0,
  }
}
