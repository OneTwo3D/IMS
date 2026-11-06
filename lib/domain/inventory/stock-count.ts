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

export type StockCountLineForDrift = {
  lineId: string
  productId: string
  sku: string
  countedQty: number
  /** On-hand this line was reconciled against; null = never reconciled (or the count changed since). */
  reconciledQty: number | null
}

export type StockCountDrift = {
  lineId: string
  productId: string
  sku: string
  /** The on-hand the line was reconciled against; null when it was never reconciled. */
  earlierOnHand: number | null
  currentOnHand: number
  countedQty: number
  /** countedQty - currentOnHand: what the variance would be against the stock as it is NOW. */
  revisedVariance: number
}

/**
 * The counted lines whose live on-hand is no longer the figure they were reconciled against, or that
 * were never reconciled. Authorising a count refuses while this is non-empty: the count and its variance
 * were decided against a quantity that is no longer true (a receipt landed, an order shipped, the WMS
 * stock sync ran), and the adjustment would flow straight into valuation.
 *
 * A line with no stamp counts as drifted, deliberately: "unknown" must not read as "unchanged".
 * Compared at the 6dp scale of stock_levels, so a stamp read back from the database is equal to itself.
 */
export function detectStockCountDrift(
  lines: StockCountLineForDrift[],
  currentBookByProduct: Map<string, number>,
): StockCountDrift[] {
  const drift: StockCountDrift[] = []
  for (const line of lines) {
    const currentOnHand = round6(currentBookByProduct.get(line.productId) ?? 0)
    if (line.reconciledQty != null && round6(line.reconciledQty) === currentOnHand) continue
    drift.push({
      lineId: line.lineId,
      productId: line.productId,
      sku: line.sku,
      earlierOnHand: line.reconciledQty == null ? null : round6(line.reconciledQty),
      currentOnHand,
      countedQty: line.countedQty,
      revisedVariance: round4(line.countedQty - currentOnHand),
    })
  }
  return drift
}

/** The operator-facing refusal for a drifted count. Names every affected product. */
export function describeStockCountDrift(drift: StockCountDrift[]): string {
  const parts = drift.map((d) => d.earlierOnHand == null
    ? `${d.sku}: not reconciled (on hand now ${d.currentOnHand}, counted ${d.countedQty}, variance ${d.revisedVariance})`
    : `${d.sku}: was ${d.earlierOnHand}, now ${d.currentOnHand}, counted ${d.countedQty}, revised variance ${d.revisedVariance}`)
  return `Nothing was posted: stock has moved since this count was reconciled (or it was never reconciled) for ${drift.length} product(s). `
    + `${parts.join('; ')}. Reconcile the count to refresh these lines to current figures and authorise again, or investigate first. Counts are preserved.`
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
