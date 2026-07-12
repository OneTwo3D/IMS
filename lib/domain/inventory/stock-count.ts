/**
 * Pure stock-count (stocktake) domain helpers (om9w).
 *
 * The write path lives in app/actions/stock-counts.ts; this module holds the
 * unit-testable math so the variance/posting rules are verified independently of
 * Prisma/transactions.
 */
import { toDecimal } from '@/lib/domain/math/decimal'

export type StockCountLineForPost = {
  lineId: string
  productId: string
  sku: string
  /** Book quantity snapshotted (under lock) when the count was created. */
  expectedQty: number
  /** Operator's physical count. null = the line was never counted. */
  countedQty: number | null
}

export type StockCountPosting = {
  lineId: string
  productId: string
  sku: string
  countedQty: number
  expectedQty: number
  /** countedQty - expectedQty (the count's finding vs the snapshot) — recorded on the line. */
  reportedVariance: number
  /** Live book quantity at post time (may differ from expectedQty if stock moved since the snapshot). */
  currentBook: number
  /**
   * The signed ADJUSTMENT to post: countedQty - currentBook. Targeting the LIVE
   * book (not the snapshot) guarantees on-hand ends exactly at countedQty even if
   * movements happened between snapshot and posting (snapshot-staleness safe).
   */
  adjustmentQty: number
}

/** Round a quantity to the 6dp FIFO engine scale. */
function round6(value: number): number {
  return toDecimal(value).toDecimalPlaces(6).toNumber()
}

/** Round a reported variance to the 4dp count scale (StockCountLine.variance is Decimal(12,4)). */
function round4(value: number): number {
  return toDecimal(value).toDecimalPlaces(4).toNumber()
}

/**
 * Compute the postings for a stock count. Lines that were never counted
 * (countedQty == null) are skipped. The reported variance compares the count to
 * the snapshot; the adjustment to post compares it to the LIVE book.
 */
export function computeStockCountPostings(
  lines: StockCountLineForPost[],
  currentBookByProduct: Map<string, number>,
): StockCountPosting[] {
  const postings: StockCountPosting[] = []
  for (const line of lines) {
    if (line.countedQty == null) continue
    const currentBook = round6(currentBookByProduct.get(line.productId) ?? 0)
    postings.push({
      lineId: line.lineId,
      productId: line.productId,
      sku: line.sku,
      countedQty: line.countedQty,
      expectedQty: line.expectedQty,
      reportedVariance: round4(line.countedQty - line.expectedQty),
      currentBook,
      adjustmentQty: round6(line.countedQty - currentBook),
    })
  }
  return postings
}

/** Stock-count reference, e.g. SC-20260624-AB12. */
export function makeStockCountReference(now: Date, rand: string): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  return `SC-${ymd}-${rand.slice(0, 4).toUpperCase()}`
}

// ---------------------------------------------------------------------------
// WMS coordination (6oyu.3)
// ---------------------------------------------------------------------------

export type StockCountWmsPolicy =
  | { policy: 'allow' }
  | { policy: 'warn'; message: string }
  | { policy: 'block'; message: string }

/**
 * 6oyu.3: whether an IMS-side stocktake may post against a warehouse, given its
 * WMS binding. For a mirrored warehouse the IMS book is a REFLECTION of WMS
 * stock, so a manual count fights the stock sync:
 *
 *  - ALIGN_TO_WMS: the WMS is the stock master — an IMS adjustment would be
 *    re-flagged and (upward) re-corrected by the next sync, oscillating the
 *    book and polluting ASN alignment credits. BLOCK: physical counts belong in
 *    the WMS; the sync imports the corrections.
 *  - NOTIFICATION_ONLY: IMS is authoritative and a count is a legitimate way to
 *    fix the book after investigating a discrepancy — but any remaining
 *    divergence vs the WMS will be re-flagged on the next sync. WARN and
 *    require explicit acknowledgement.
 *  - DISABLED binding or no binding: unmanaged warehouse — ALLOW.
 */
export function classifyStockCountWmsPolicy(
  binding: { connector: string; stockSyncMode: string } | null,
): StockCountWmsPolicy {
  if (!binding || binding.stockSyncMode === 'DISABLED') return { policy: 'allow' }

  if (binding.stockSyncMode === 'ALIGN_TO_WMS') {
    return {
      policy: 'block',
      message: `This warehouse mirrors the WMS (${binding.connector}) in Align To WMS mode — the WMS is the stock master, and an IMS-side count would be re-corrected by the next stock sync. Perform the stocktake in the WMS instead; the sync imports the corrections.`,
    }
  }

  return {
    policy: 'warn',
    message: `This warehouse is synced with the WMS (${binding.connector}) in notification-only mode. Posting this count adjusts the IMS book, and any remaining divergence against the WMS will be re-flagged as a discrepancy on the next stock sync. Resolve the physical difference in the WMS too, or expect the discrepancy.`,
  }
}
