import { balanceDateString } from './balance-date'

/**
 * Coverage gate (pure, testable): a reconciliation window may only run when the
 * ledger fully covers it. A window (opening, closing] counts only postings dated
 * strictly after `opening`, so `opening >= watermark` guarantees full coverage.
 * Fails CLOSED on a missing/malformed watermark — a bad watermark must NEVER let
 * reconciliation run against an incompletely-covered ledger (which would false-flag).
 * ISO YYYY-MM-DD strings compare correctly by lexicographic order.
 */
export function isTransitLedgerCoverageSatisfied(
  coverageStart: string | undefined | null,
  openingBalanceDate: Date,
): boolean {
  const trimmed = coverageStart?.trim()
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false
  return balanceDateString(openingBalanceDate) >= trimmed
}
