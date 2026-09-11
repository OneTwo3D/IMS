'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { allocateOrderDiscountBase, normalizeLineDiscountBase } from '@/lib/sales-currency'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { refundLineBucket } from '@/lib/domain/sales/refund-basis-analytics'
import {
  linearFigureBoundFromUnplacedCredit,
  sumLinearFigureBounds,
  type LinearFigureBoundInterval,
} from '@/lib/domain/sales/derived-figure-bound'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * ONE FINANCIAL YEAR'S FIGURES FOR ONE PRODUCT — THE PUBLIC VIEW MODEL (o3d-la3n r2).
 *
 * WHAT THIS TYPE DELIBERATELY NO LONGER CARRIES. Until round 2 a row published
 * `…RefundBasisComplete` — a boolean — beside `refundsGrossBasis` and `refundsUnknownBasis`, the
 * two ROUNDED signed buckets. Those three fields are precisely the inputs of the broken rule this
 * branch removed (`!complete && gross + unknown >= 0 ⇒ ≤`), so while they remained on the wire the
 * old classification was still reconstructible by any current or future reader, and its absence was
 * a convention rather than a property of the type. The boolean is gone. It was redundant anyway:
 * an exactly-zero credit entry is placeable on either basis and contributes nothing to `bound`,
 * while every UNPLACEABLE entry is non-zero and moves an endpoint — so `bound` is
 * `EXACT_LINEAR_FIGURE_BOUND` exactly when the flag would have been true, and it says strictly more.
 *
 * EVERY AMOUNT HERE IS UNROUNDED, and that is a contract, not an oversight (o3d-l4zz, folded in).
 * The page re-sums an arbitrary filtered subset in the browser. Round the rows to cents first and
 * the subtotal inherits every row's rounding error: two products with raw revenue £0.014 and £0.001
 * of positive unplaced credit each publish £0.01, sum to £0.02, and the page prints "at most £0.02"
 * over a completed-basis truth that lies in [£0.026, £0.028]. The relation itself fails, not merely
 * the last penny. Sum these figures unrounded and round ONCE, at display, through
 * `roundBoundedAmountForDisplay`, which rounds in the direction the relation allows.
 */
export type ProfitabilityFyFigures = {
  /**
   * Revenue net of NET-BASIS refunds only. o3d-iigc: this is built from ex-VAT line totals, so a
   * GROSS-basis credit is not the same unit and an unstamped one cannot be placed at all; both are
   * reported in the two fields below and left OUT of this figure rather than subtracted on a guess.
   */
  revenue: number
  /** Basis-independent — no refund line reduces COGS — so it carries no bound of its own. */
  cogs: number
  /** `revenue - cogs`. Carries `bound` unchanged: COGS is fixed, so profit moves with revenue. */
  profit: number
  /** Basis-independent: quantity nets off every refund line whatever basis it was stamped with. */
  qtySold: number
  /**
   * WHERE THE COMPLETE-BASIS `revenue` AND `profit` LIE RELATIVE TO THE ONES PUBLISHED HERE:
   * `true = published + δ` for `δ` anywhere in this interval. The producer's finding, published so
   * that no consumer re-derives it — and so that none of them can re-derive it wrongly.
   *
   * The INTERVAL and not a verdict, because a filtered subtotal's bound is the SUM of its rows'
   * bounds and endpoints are what add. Fold with `sumLinearFigureBounds`, classify with
   * `classifyLinearFigureBound` at the point of display.
   */
  bound: LinearFigureBoundInterval
  /**
   * Refund value bucketed on the GROSS basis and left unsubtracted — DISCLOSURE ONLY, and a SIGNED
   * total: +£120 and −£120 of gross-basis credit appear here as £0.00. No relation may be derived
   * from it; that is what `bound` is for, and `bound` alone can tell those two cases apart.
   */
  refundsGrossBasis: number
  /** As `refundsGrossBasis`, for credit whose basis was never proved. Disclosure only. */
  refundsUnknownBasis: number
}

export type ProfitabilityRow = {
  productId: string
  sku: string
  name: string
  type: string
  lifecycleStatus: ProductLifecycleStatus
  // Stock
  totalStock: number
  // Pricing
  salesPrice: number | null   // list / regular price
  salePrice: number | null    // discounted price
  latestCogs: number | null   // most recent cost layer unit cost
  // Computed margin (from list price vs latest COGS) — a RATIO, and no refund line touches either
  // of its inputs, so it is deliberately unbounded and unmarked.
  unitMargin: number | null
  unitMarginPct: number | null
  currentFy: ProfitabilityFyFigures
  previousFy: ProfitabilityFyFigures
}

export type ProfitabilitySummary = {
  totalProducts: number
  /**
   * The WHOLE table's figures — the unfiltered total, summed unrounded from the rows with its
   * bound folded through the same `sumLinearFigureBounds` the browser's filtered subtotal uses, so
   * a subtotal and the grand total cannot disagree about what a mark means.
   */
  currentFy: ProfitabilityFyFigures
  previousFy: ProfitabilityFyFigures
  fyLabel: string       // e.g. "May 2025 – Apr 2026"
  prevFyLabel: string   // e.g. "May 2024 – Apr 2025"
}

// ---------------------------------------------------------------------------
// FY helpers
// ---------------------------------------------------------------------------

function getFyBoundaries(startMonth: number, startDay: number): {
  currentFyStart: Date; currentFyEnd: Date
  previousFyStart: Date; previousFyEnd: Date
  fyLabel: string; prevFyLabel: string
} {
  const now = new Date()
  const year = now.getFullYear()

  // Determine if we're already past the FY start date this calendar year
  const fyStartThisYear = new Date(year, startMonth - 1, startDay)
  let currentFyStart: Date
  if (now >= fyStartThisYear) {
    currentFyStart = fyStartThisYear
  } else {
    currentFyStart = new Date(year - 1, startMonth - 1, startDay)
  }

  const currentFyEnd = new Date(currentFyStart.getFullYear() + 1, startMonth - 1, startDay)
  const previousFyStart = new Date(currentFyStart.getFullYear() - 1, startMonth - 1, startDay)
  const previousFyEnd = new Date(currentFyStart)

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const endMonth = startMonth === 1 ? 12 : startMonth - 1
  const fyLabel = `${monthNames[startMonth - 1]} ${currentFyStart.getFullYear()} – ${monthNames[endMonth - 1]} ${currentFyEnd.getFullYear()}`
  const prevFyLabel = `${monthNames[startMonth - 1]} ${previousFyStart.getFullYear()} – ${monthNames[endMonth - 1]} ${previousFyEnd.getFullYear()}`

  return { currentFyStart, currentFyEnd, previousFyStart, previousFyEnd, fyLabel, prevFyLabel }
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

export async function getProductProfitability(): Promise<{
  rows: ProfitabilityRow[]
  summary: ProfitabilitySummary
}> {
  await requirePermission('analytics')

  // 1. Organisation FY settings
  const org = await db.organisation.findFirst({
    select: { financialYearStartMonth: true, financialYearStartDay: true },
  })
  const startMonth = org?.financialYearStartMonth ?? 5
  const startDay = org?.financialYearStartDay ?? 1
  const { currentFyStart, currentFyEnd, previousFyStart, previousFyEnd, fyLabel, prevFyLabel } = getFyBoundaries(startMonth, startDay)

  // 2. All products (excluding VARIABLE parents — they're just grouping containers)
  const products = await db.product.findMany({
    where: { type: { not: 'VARIABLE' } },
    select: {
      id: true, sku: true, name: true, type: true, lifecycleStatus: true,
      salesPriceBase: true, salePriceBase: true,
      stockLevels: { select: { quantity: true } },
    },
  })

  // 3. Latest COGS per product — most recent cost layer with remaining qty > 0
  const costLayers = await db.costLayer.findMany({
    where: { remainingQty: { gt: 0 } },
    select: { productId: true, unitCostBase: true, receivedAt: true },
    orderBy: { receivedAt: 'desc' },
  })
  const latestCostMap = new Map<string, number>()
  for (const cl of costLayers) {
    if (!latestCostMap.has(cl.productId)) {
      latestCostMap.set(cl.productId, Number(cl.unitCostBase))
    }
  }

  // 4. Sales data — fulfilled orders in both FY windows
  const FULFILLED = ['SHIPPED', 'COMPLETED', 'DELIVERED'] as const
  const [currentFyOrders, previousFyOrders] = await Promise.all([
    db.salesOrder.findMany({
      where: { status: { in: [...FULFILLED] }, createdAt: { gte: currentFyStart, lt: currentFyEnd } },
      select: {
        fxRateToBase: true, discountAmount: true, pricesIncludeVat: true, taxRatePercent: true,
        shoppingLinks: { select: { connector: true } },
        lines: { select: { productId: true, qty: true, totalBase: true, discountAmount: true, cogsBase: true, taxRate: { select: { rate: true } } } },
        refunds: { select: { totalsBasis: true, lines: { select: { productId: true, qty: true, totalBase: true } } } },
      },
    }),
    db.salesOrder.findMany({
      where: { status: { in: [...FULFILLED] }, createdAt: { gte: previousFyStart, lt: previousFyEnd } },
      select: {
        fxRateToBase: true, discountAmount: true, pricesIncludeVat: true, taxRatePercent: true,
        shoppingLinks: { select: { connector: true } },
        lines: { select: { productId: true, qty: true, totalBase: true, discountAmount: true, cogsBase: true, taxRate: { select: { rate: true } } } },
        refunds: { select: { totalsBasis: true, lines: { select: { productId: true, qty: true, totalBase: true } } } },
      },
    }),
  ])

  // 5. Aggregate by product for each FY
  /**
   * THE INTERNAL AGGREGATION TYPE, which is where the bookkeeping the public view model must not
   * carry now lives (o3d-la3n r2).
   *
   * `…Positive` is the unplaced credit's other interval endpoint, `Σ max(entry, 0)`, accumulated
   * beside the signed bucket AT THE ENTRY. It has to be recorded here because by the time a bucket
   * is a total there is no entry left to look at, and the signed total alone cannot tell "no
   * credit" from "+£120 and −£120 of credit".
   *
   * There is no `refundBasisComplete` any more. `refundLineBucket` reports an exactly-zero amount
   * as placeable on either basis and everything else on a foreign basis as unplaceable, so a
   * non-placeable entry is by construction non-zero and moves one of these endpoints: the flag
   * carried no information the two endpoints do not, and one fewer parallel fact is one fewer thing
   * that can disagree with the other.
   */
  type FyAgg = {
    revenue: number; cogs: number; qtySold: number
    refundsGrossBasis: number; refundsUnknownBasis: number
    refundsGrossBasisPositive: number; refundsUnknownBasisPositive: number
  }
  function aggregateOrders(orders: typeof currentFyOrders): Map<string, FyAgg> {
    const map = new Map<string, FyAgg>()
    for (const order of orders) {
      const orderDiscountAllocations = allocateOrderDiscountBase(order, order.lines)
      for (const [lineIndex, line] of order.lines.entries()) {
        if (!line.productId) continue
        const agg = map.get(line.productId) ?? { revenue: 0, cogs: 0, qtySold: 0, refundsGrossBasis: 0, refundsUnknownBasis: 0, refundsGrossBasisPositive: 0, refundsUnknownBasisPositive: 0 }
        agg.revenue += Number(line.totalBase)
        agg.cogs += Number(line.cogsBase ?? 0)
        agg.qtySold += Number(line.qty)
        // Add back line discount (already subtracted from totalBase)
        agg.revenue += normalizeLineDiscountBase(order, line.discountAmount, line.taxRate?.rate)
        agg.revenue -= orderDiscountAllocations[lineIndex] ?? 0
        map.set(line.productId, agg)
      }
      // Subtract refunds.
      //
      // o3d-iigc: `revenue` above is built from ex-VAT line totals, so only a NET-basis refund is
      // the same unit. A GROSS one carries its VAT and would over-subtract; an unstamped one cannot
      // be placed at all. Neither is converted — on a mixed-rate order the rate that produced the
      // gross figure is not recoverable — so both are bucketed beside the revenue and the row is
      // flagged, making `revenue` an upper bound rather than a number that is wrong in an
      // undisclosed direction. Quantity is basis-independent, so qtySold keeps netting off every
      // refund line.
      for (const refund of order.refunds) {
        for (const rl of refund.lines) {
          if (!rl.productId) continue
          const agg = map.get(rl.productId)
          if (agg) {
            const amount = Number(rl.totalBase)
            const placement = refundLineBucket(refund.totalsBasis, rl.totalBase)
            // The positive part is taken from the ENTRY, beside the signed bucket (o3d-la3n).
            const positive = Math.max(amount, 0)
            if (placement.bucket === 'net') agg.revenue -= amount
            else if (placement.bucket === 'gross') { agg.refundsGrossBasis += amount; agg.refundsGrossBasisPositive += positive }
            else { agg.refundsUnknownBasis += amount; agg.refundsUnknownBasisPositive += positive }
            agg.qtySold -= Number(rl.qty)
          }
        }
      }
    }
    return map
  }

  const currentFyMap = aggregateOrders(currentFyOrders)
  const previousFyMap = aggregateOrders(previousFyOrders)

  // 6. Build rows

  /**
   * ONE FY'S PUBLIC FIGURES FROM ONE FY'S INTERNAL AGGREGATE.
   *
   * Nothing is rounded here. The bound is minted from the ENTRY-LEVEL endpoints — never from
   * `refundsGrossBasis + refundsUnknownBasis`, a signed sum in which +£120 and −£120 of gross-basis
   * credit cancel to a zero that is not negative — and the amounts travel to the browser exactly as
   * computed, because the page sums an arbitrary filtered subset of them and a sum of rounded rows
   * can breach the very relation the bound publishes.
   */
  function fyFigures(agg: FyAgg | undefined): ProfitabilityFyFigures {
    const revenue = agg?.revenue ?? 0
    const cogs = agg?.cogs ?? 0
    return {
      revenue,
      cogs,
      profit: revenue - cogs,
      qtySold: agg?.qtySold ?? 0,
      bound: linearFigureBoundFromUnplacedCredit([
        { total: agg?.refundsGrossBasis ?? 0, positive: agg?.refundsGrossBasisPositive ?? 0 },
        { total: agg?.refundsUnknownBasis ?? 0, positive: agg?.refundsUnknownBasisPositive ?? 0 },
      ]),
      refundsGrossBasis: agg?.refundsGrossBasis ?? 0,
      refundsUnknownBasis: agg?.refundsUnknownBasis ?? 0,
    }
  }

  /** The whole table's figures: amounts summed unrounded, bounds folded endpoint by endpoint. */
  function totalFyFigures(pick: (r: ProfitabilityRow) => ProfitabilityFyFigures): ProfitabilityFyFigures {
    const parts = rows.map(pick)
    const sum = (get: (f: ProfitabilityFyFigures) => number) => parts.reduce((s, f) => s + get(f), 0)
    return {
      revenue: sum((f) => f.revenue),
      cogs: sum((f) => f.cogs),
      profit: sum((f) => f.profit),
      qtySold: sum((f) => f.qtySold),
      bound: sumLinearFigureBounds(parts.map((f) => f.bound)),
      refundsGrossBasis: sum((f) => f.refundsGrossBasis),
      refundsUnknownBasis: sum((f) => f.refundsUnknownBasis),
    }
  }

  const rows: ProfitabilityRow[] = []

  for (const p of products) {
    const latestCogs = latestCostMap.get(p.id) ?? null
    const salesPrice = p.salesPriceBase ? Number(p.salesPriceBase) : null
    const salePrice = p.salePriceBase ? Number(p.salePriceBase) : null
    const effectivePrice = salePrice ?? salesPrice

    let unitMargin: number | null = null
    let unitMarginPct: number | null = null
    if (effectivePrice != null && latestCogs != null && effectivePrice > 0) {
      unitMargin = effectivePrice - latestCogs
      unitMarginPct = (unitMargin / effectivePrice) * 100
    }

    rows.push({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      type: p.type,
      lifecycleStatus: p.lifecycleStatus,
      totalStock: p.stockLevels.reduce((s, sl) => s + Number(sl.quantity), 0),
      salesPrice,
      salePrice,
      // Unit pricing is not summed by anything and carries no bound, so it is rounded at the source
      // as it always was.
      latestCogs: latestCogs != null ? Math.round(latestCogs * 100) / 100 : null,
      unitMargin: unitMargin != null ? Math.round(unitMargin * 100) / 100 : null,
      unitMarginPct: unitMarginPct != null ? Math.round(unitMarginPct * 10) / 10 : null,
      currentFy: fyFigures(currentFyMap.get(p.id)),
      previousFy: fyFigures(previousFyMap.get(p.id)),
    })
  }

  rows.sort((a, b) => b.currentFy.revenue - a.currentFy.revenue)

  const summary: ProfitabilitySummary = {
    totalProducts: rows.length,
    currentFy: totalFyFigures((r) => r.currentFy),
    previousFy: totalFyFigures((r) => r.previousFy),
    fyLabel,
    prevFyLabel,
  }

  return { rows, summary }
}
