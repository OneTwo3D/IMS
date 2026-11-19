/**
 * Pure variance-triage helpers for a stock count's reconciliation view.
 *
 * Reconciliation used to be a flat list worked in order. Triage splits it: lines with no variance, lines
 * whose variance is within a configured small threshold, and lines that need a human look, sorted by how
 * far off they are. The same classification decides, on the server under the stock locks, which lines a
 * bulk accept may touch (app/actions/stock-counts.ts), so what the page shows and what the commit accepts
 * cannot drift apart.
 *
 * CLIENT-SAFE: the reconciliation page imports this module, so it must not reach the database, Prisma's runtime or any node:* module
 * (the Turbopack client build fails on them). Arithmetic is therefore exact integer (BigInt) arithmetic at the 6dp scale of stock_levels,
 * not Prisma.Decimal. tests/domain/inventory/stock-count-client-imports.test.ts pins the import graph.
 *
 * Variance here is counted minus on-hand (the live book at commit time, or the line's book figure on the
 * page). Never counted lines are not triaged: there is no variance to judge.
 */

export type VarianceClass = 'NONE' | 'SMALL' | 'REVIEW' | 'UNCOUNTED'
export type VarianceTab = 'ALL' | 'NONE' | 'SMALL' | 'REVIEW'
export type VarianceSort = 'DEFAULT' | 'QTY' | 'VALUE'

export const VARIANCE_TABS: readonly VarianceTab[] = ['ALL', 'NONE', 'SMALL', 'REVIEW']
export const VARIANCE_SORTS: readonly VarianceSort[] = ['DEFAULT', 'QTY', 'VALUE']

/** 0 = the criterion is not set. With both at 0 (the default) no line is ever small. */
export type SmallVarianceThreshold = { qty: number; pct: number }
export const NO_SMALL_VARIANCE: SmallVarianceThreshold = { qty: 0, pct: 0 }

/** Mirrors StockCountLine.countedQty, a Decimal(12,4). */
const MAX_THRESHOLD_QTY = 99_999_999.9999
const MAX_THRESHOLD_PCT = 100


const SCALE = BigInt(1_000_000)

/** A quantity as an exact integer count of millionths (the 6dp scale of stock_levels). */
function micro(n: number): bigint {
  return BigInt(n.toFixed(6).replace('.', ''))
}

/** Divide with half-away-from-zero rounding, like Decimal's default. */
function divRound(a: bigint, b: bigint): bigint {
  const neg = (a < BigInt(0)) !== (b < BigInt(0))
  const x = a < BigInt(0) ? -a : a
  const y = b < BigInt(0) ? -b : b
  const q = (BigInt(2) * x + y) / (BigInt(2) * y)
  return neg ? -q : q
}

function varianceMicro(countedQty: number, onHand: number): bigint {
  return micro(countedQty) - micro(onHand)
}

/** A variance is exactly zero at the 6dp scale of stock_levels. */
export function isZeroVariance(countedQty: number, onHand: number): boolean {
  return varianceMicro(countedQty, onHand) === BigInt(0)
}

/**
 * Classify one line. SMALL needs a non-zero variance within EVERY criterion that is set:
 *   - qty > 0: |variance| <= qty
 *   - pct > 0: |variance| / |on hand| * 100 <= pct; a line with nothing on hand has no percentage, so it is never small by percentage
 * When neither is set nothing is small, so the default threshold sends every non-zero variance to review.
 */
export function classifyVariance(
  countedQty: number | null,
  onHand: number,
  threshold: SmallVarianceThreshold,
): VarianceClass {
  if (countedQty == null) return 'UNCOUNTED'
  const variance = varianceMicro(countedQty, onHand)
  if (variance === BigInt(0)) return 'NONE'
  const abs = variance < BigInt(0) ? -variance : variance
  const useQty = threshold.qty > 0
  const usePct = threshold.pct > 0
  if (!useQty && !usePct) return 'REVIEW'
  if (useQty && abs > micro(threshold.qty)) return 'REVIEW'
  if (usePct) {
    const base = micro(onHand) < BigInt(0) ? -micro(onHand) : micro(onHand)
    if (base === BigInt(0)) return 'REVIEW'
    // |variance| / base * 100 > pct, kept in integers: |variance| * 100 * 1e6 > pct(micro) * base
    if (abs * BigInt(100) * SCALE > micro(threshold.pct) * base) return 'REVIEW'
  }
  return 'SMALL'
}

export type TriageLineInput = {
  id: string
  sku: string
  /** Book quantity the page shows for the line. */
  expectedQty: number
  countedQty: number | null
  /** Average unit cost of the stock on hand (base currency); null when no cost layer exists. */
  unitCost: number | null
}

export type TriagedLine<T extends TriageLineInput> = {
  line: T
  varianceClass: VarianceClass
  variance: number | null
  /** variance x unitCost, base currency; null when uncounted or no cost exists. */
  varianceValue: number | null
}

export function triageLine<T extends TriageLineInput>(line: T, threshold: SmallVarianceThreshold): TriagedLine<T> {
  const varianceClass = classifyVariance(line.countedQty, line.expectedQty, threshold)
  if (line.countedQty == null) return { line, varianceClass, variance: null, varianceValue: null }
  const v6 = varianceMicro(line.countedQty, line.expectedQty)
  const v4 = divRound(v6, BigInt(100)) // variance at 4dp (ten-thousandths)
  const variance = Number(v4) / 10_000
  // variance (1e-4) x unit cost (1e-6) = 1e-10; round to pence (1e-2)
  const varianceValue = line.unitCost == null ? null : Number(divRound(v4 * micro(line.unitCost), BigInt(100_000_000))) / 100
  return { line, varianceClass, variance, varianceValue }
}

export function filterByTab<T extends TriageLineInput>(lines: TriagedLine<T>[], tab: VarianceTab): TriagedLine<T>[] {
  if (tab === 'ALL') return lines
  return lines.filter((l) => l.varianceClass === tab)
}

export function tabCounts<T extends TriageLineInput>(lines: TriagedLine<T>[]): Record<VarianceTab, number> {
  const out: Record<VarianceTab, number> = { ALL: lines.length, NONE: 0, SMALL: 0, REVIEW: 0 }
  for (const l of lines) {
    if (l.varianceClass === 'NONE' || l.varianceClass === 'SMALL' || l.varianceClass === 'REVIEW') out[l.varianceClass] += 1
  }
  return out
}

function absOf(n: number | null): number {
  return n == null ? -1 : Math.abs(n)
}

/**
 * Sort by absolute variance magnitude, largest first. DEFAULT keeps the order given (SKU order today).
 *   - QTY:   |variance| descending
 *   - VALUE: |variance value| descending, lines with no cost after the costed ones (ordered by quantity among themselves)
 * Ties fall back to the SKU so the order is stable. Uncounted lines sort last.
 */
export function sortTriaged<T extends TriageLineInput>(lines: TriagedLine<T>[], sort: VarianceSort): TriagedLine<T>[] {
  if (sort === 'DEFAULT') return lines
  const bySku = (a: TriagedLine<T>, b: TriagedLine<T>) => (a.line.sku < b.line.sku ? -1 : a.line.sku > b.line.sku ? 1 : 0)
  return [...lines].sort((a, b) => {
    if (sort === 'VALUE') {
      const av = absOf(a.varianceValue)
      const bv = absOf(b.varianceValue)
      if (av !== bv) return bv - av
    }
    const aq = absOf(a.variance)
    const bq = absOf(b.variance)
    if (aq !== bq) return bq - aq
    return bySku(a, b)
  })
}

/** Parse a URL/search-param value into a tab; anything unknown is ALL (the view as it was). */
export function parseVarianceTab(raw: string | null | undefined): VarianceTab {
  const v = (raw ?? '').toUpperCase()
  return (VARIANCE_TABS as readonly string[]).includes(v) ? (v as VarianceTab) : 'ALL'
}

export function parseVarianceSort(raw: string | null | undefined): VarianceSort {
  const v = (raw ?? '').toUpperCase()
  return (VARIANCE_SORTS as readonly string[]).includes(v) ? (v as VarianceSort) : 'DEFAULT'
}

/** Validate a threshold entered by an operator. A blank value means "not set" (0). */
export function parseSmallVarianceThreshold(input: { qty: unknown; pct: unknown }): { ok: true; value: SmallVarianceThreshold } | { ok: false; message: string } {
  const read = (raw: unknown, label: string, max: number): { ok: true; value: number } | { ok: false; message: string } => {
    if (raw == null || raw === '') return { ok: true, value: 0 }
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
    if (!Number.isFinite(n) || n < 0) return { ok: false, message: `${label} must be a number of zero or more.` }
    if (n > max) return { ok: false, message: `${label} cannot be more than ${max}.` }
    return { ok: true, value: n }
  }
  const qty = read(input.qty, 'The small-variance quantity', MAX_THRESHOLD_QTY)
  if (!qty.ok) return qty
  const pct = read(input.pct, 'The small-variance percentage', MAX_THRESHOLD_PCT)
  if (!pct.ok) return pct
  return { ok: true, value: { qty: qty.value, pct: pct.value } }
}

export type BulkAcceptMode = 'NO_VARIANCE' | 'SMALL_VARIANCE'

/** Whether a line may be bulk-accepted in this mode, judged against the live on-hand at commit time. */
export function isBulkAcceptable(mode: BulkAcceptMode, countedQty: number | null, liveOnHand: number, threshold: SmallVarianceThreshold): boolean {
  const cls = classifyVariance(countedQty, liveOnHand, threshold)
  return mode === 'NO_VARIANCE' ? cls === 'NONE' : cls === 'SMALL'
}
