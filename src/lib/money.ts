// PRD I-01: money is integer minor units plus an ISO 4217 code. Supported currencies come from config.

export type Currency = string // ISO 4217, upper case; the supported set is configuration (default GBP, EUR, USD)
export const DEFAULT_CURRENCIES: readonly Currency[] = ['GBP', 'EUR', 'USD']

export interface Money {
  minor: number
  currency: Currency
}

/** I-01 upper bound (v0.7.1, the Toolkit's limit): 1,000,000,000.00 */
export const MAX_MINOR = 100_000_000_000

// Thousands commas in groups of three, or no grouping; dot decimal point with 1–2 decimals.
const NUMBER = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

/**
 * I-01 number part. Returns minor units or null when it cannot be parsed. Negative, empty, above the limit, more than two decimals,
 * dot thousands and comma decimals (`10.000,00`, `1.234,56`, `10,00`) are all unparseable; nothing is guessed.
 */
export function parseAmountNumber(s: string): number | null {
  const m = NUMBER.exec(s)
  if (!m) return null
  const [whole, frac = ''] = s.replace(/,/g, '').split('.') as [string, string?]
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return Number.isSafeInteger(minor) && minor <= MAX_MINOR ? minor : null
}
