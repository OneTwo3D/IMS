'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { allocateOrderDiscountBase, normalizeLineDiscountBase } from '@/lib/sales-currency'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { refundLineBucket, unplacedCreditBoundFromParts } from '@/lib/domain/sales/refund-basis-analytics'
import {
  combineNetLinearFigureBounds,
  netLinearFigureBound,
  type DerivedFigureBound,
} from '@/lib/domain/sales/derived-figure-bound'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  // Computed margin (from list price vs latest COGS)
  unitMargin: number | null
  unitMarginPct: number | null
  // Current FY
  /**
   * Revenue net of NET-BASIS refunds only. o3d-iigc: this is built from ex-VAT line totals, so a
   * GROSS-basis credit is not the same unit and an unstamped one cannot be placed at all; both are
   * reported in the two fields below and left OUT of this figure rather than subtracted on a guess.
   */
  currentFyRevenue: number
  /** Refund value on the GROSS basis, NOT subtracted from currentFyRevenue. */
  currentFyRefundsGrossBasis: number
  /** Refund value with no proven basis, NOT subtracted from currentFyRevenue. */
  currentFyRefundsUnknownBasis: number
  /**
   * False when this product carried FY refund value that could not be placed on the net basis.
   *
   * o3d-la3n: THIS BOOLEAN IS NOT THE BOUND, and nothing may print a `≤` off it. It says only that
   * SOMETHING was left unsubtracted; which side of the published figure the truth then lies on is
   * `currentFyRevenueBound` below, and a boolean has no third value with which to say
   * `indeterminate` at all.
   */
  currentFyRefundBasisComplete: boolean
  /**
   * HOW currentFyRevenue AND currentFyProfit RELATE TO THE FIGURES A COMPLETE REFUND BASIS WOULD
   * HAVE PRODUCED — the producer's verdict, published so that no consumer re-derives it, and so
   * that none of them can re-derive it wrongly (o3d-la3n; o3d-7jfq did this for Sales Statistics).
   *
   * One marker for both figures because profit is `revenue - cogs` and no refund line moves COGS,
   * so the two move with the unplaced credit ONE FOR ONE and carry the same relation. Classified
   * from the UNROUNDED aggregate over the credit INTERVAL — `Σ min(entry, 0)` to `Σ max(entry, 0)`
   * — and not from `currentFyRefundsGrossBasis + currentFyRefundsUnknownBasis`, which is a signed
   * sum in which +£120 and −£120 of gross-basis credit cancel to a zero that is not negative.
   */
  currentFyRevenueBound: DerivedFigureBound
  currentFyCogs: number
  currentFyProfit: number
  currentFyQtySold: number
  // Previous FY
  previousFyRevenue: number
  previousFyRefundsGrossBasis: number
  previousFyRefundsUnknownBasis: number
  previousFyRefundBasisComplete: boolean
  /** As currentFyRevenueBound, for previousFyRevenue and previousFyProfit. */
  previousFyRevenueBound: DerivedFigureBound
  previousFyCogs: number
  previousFyProfit: number
  previousFyQtySold: number
}

export type ProfitabilitySummary = {
  totalProducts: number
  /** NET-basis refunds only — see ProfitabilityRow.currentFyRevenue. */
  currentFyRevenue: number
  currentFyRefundsGrossBasis: number
  currentFyRefundsUnknownBasis: number
  /** False when ANY row's FY refunds could not all be placed on the net basis. Not the bound. */
  currentFyRefundBasisComplete: boolean
  /**
   * The total's own verdict, for currentFyRevenue and currentFyProfit. Combined from the rows'
   * markers through the one shared rule the client's FILTERED total also goes through, so a
   * filtered subtotal and the whole-table total cannot disagree about what a `≤` means (o3d-la3n).
   */
  currentFyRevenueBound: DerivedFigureBound
  currentFyCogs: number
  currentFyProfit: number
  previousFyRevenue: number
  previousFyRefundsGrossBasis: number
  previousFyRefundsUnknownBasis: number
  previousFyRefundBasisComplete: boolean
  /** As currentFyRevenueBound, for previousFyRevenue and previousFyProfit. */
  previousFyRevenueBound: DerivedFigureBound
  previousFyCogs: number
  previousFyProfit: number
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
  type FyAgg = {
    revenue: number; cogs: number; qtySold: number
    refundsGrossBasis: number; refundsUnknownBasis: number; refundBasisComplete: boolean
    /**
     * o3d-la3n: the unplaced credit's OTHER interval endpoint, `Σ max(entry, 0)`, accumulated
     * beside the signed bucket AT THE ENTRY. It has to be recorded here because by the time a
     * bucket is a total there is no entry left to look at, and the signed total alone cannot tell
     * "no credit" from "+£120 and −£120 of credit".
     */
    refundsGrossBasisPositive: number; refundsUnknownBasisPositive: number
  }
  function aggregateOrders(orders: typeof currentFyOrders): Map<string, FyAgg> {
    const map = new Map<string, FyAgg>()
    for (const order of orders) {
      const orderDiscountAllocations = allocateOrderDiscountBase(order, order.lines)
      for (const [lineIndex, line] of order.lines.entries()) {
        if (!line.productId) continue
        const agg = map.get(line.productId) ?? { revenue: 0, cogs: 0, qtySold: 0, refundsGrossBasis: 0, refundsUnknownBasis: 0, refundBasisComplete: true, refundsGrossBasisPositive: 0, refundsUnknownBasisPositive: 0 }
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
            if (!placement.placeableOnNetBasis) agg.refundBasisComplete = false
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

    const cfy = currentFyMap.get(p.id)
    const pfy = previousFyMap.get(p.id)

    /**
     * THE BOUND IS CLASSIFIED HERE, FROM THE UNROUNDED AGGREGATE, and published (o3d-la3n).
     *
     * Unrounded because the classification is about which SIDE of the published figure the truth
     * lies on, and rounding the interval's two endpoints independently can turn a genuinely
     * negative lower endpoint into a zero — +£0.001 and −£0.004 of gross-basis credit round to a
     * total of 0.00 and a positive part of 0.00, which is the false `≤` wearing two decimal places.
     *
     * Published rather than left for the page: `currentFyRevenue` and `currentFyProfit` leave here
     * rounded, and there is no way back from those two columns to the entries the interval needs.
     */
    const currentFyRevenueBound = netLinearFigureBound({
      basisComplete: cfy?.refundBasisComplete ?? true,
      unplacedCredit: unplacedCreditBoundFromParts([
        { total: cfy?.refundsGrossBasis ?? 0, positive: cfy?.refundsGrossBasisPositive ?? 0 },
        { total: cfy?.refundsUnknownBasis ?? 0, positive: cfy?.refundsUnknownBasisPositive ?? 0 },
      ]),
    })
    const previousFyRevenueBound = netLinearFigureBound({
      basisComplete: pfy?.refundBasisComplete ?? true,
      unplacedCredit: unplacedCreditBoundFromParts([
        { total: pfy?.refundsGrossBasis ?? 0, positive: pfy?.refundsGrossBasisPositive ?? 0 },
        { total: pfy?.refundsUnknownBasis ?? 0, positive: pfy?.refundsUnknownBasisPositive ?? 0 },
      ]),
    })

    const currentFyRevenue = Math.round((cfy?.revenue ?? 0) * 100) / 100
    const currentFyCogs = Math.round((cfy?.cogs ?? 0) * 100) / 100
    const previousFyRevenue = Math.round((pfy?.revenue ?? 0) * 100) / 100
    const previousFyCogs = Math.round((pfy?.cogs ?? 0) * 100) / 100

    rows.push({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      type: p.type,
      lifecycleStatus: p.lifecycleStatus,
      totalStock: p.stockLevels.reduce((s, sl) => s + Number(sl.quantity), 0),
      salesPrice,
      salePrice,
      latestCogs: latestCogs != null ? Math.round(latestCogs * 100) / 100 : null,
      unitMargin: unitMargin != null ? Math.round(unitMargin * 100) / 100 : null,
      unitMarginPct: unitMarginPct != null ? Math.round(unitMarginPct * 10) / 10 : null,
      currentFyRevenue,
      currentFyRefundsGrossBasis: Math.round((cfy?.refundsGrossBasis ?? 0) * 100) / 100,
      currentFyRefundsUnknownBasis: Math.round((cfy?.refundsUnknownBasis ?? 0) * 100) / 100,
      // A product with no sales at all in the window has nothing unplaceable, so it stays complete.
      currentFyRefundBasisComplete: cfy?.refundBasisComplete ?? true,
      currentFyRevenueBound,
      currentFyCogs,
      currentFyProfit: Math.round((currentFyRevenue - currentFyCogs) * 100) / 100,
      currentFyQtySold: Math.round((cfy?.qtySold ?? 0) * 100) / 100,
      previousFyRevenue,
      previousFyRefundsGrossBasis: Math.round((pfy?.refundsGrossBasis ?? 0) * 100) / 100,
      previousFyRefundsUnknownBasis: Math.round((pfy?.refundsUnknownBasis ?? 0) * 100) / 100,
      previousFyRefundBasisComplete: pfy?.refundBasisComplete ?? true,
      previousFyRevenueBound,
      previousFyCogs,
      previousFyProfit: Math.round((previousFyRevenue - previousFyCogs) * 100) / 100,
      previousFyQtySold: Math.round((pfy?.qtySold ?? 0) * 100) / 100,
    })
  }

  rows.sort((a, b) => b.currentFyRevenue - a.currentFyRevenue)

  const summary: ProfitabilitySummary = {
    totalProducts: rows.length,
    currentFyRevenue: rows.reduce((s, r) => s + r.currentFyRevenue, 0),
    currentFyRefundsGrossBasis: rows.reduce((s, r) => s + r.currentFyRefundsGrossBasis, 0),
    currentFyRefundsUnknownBasis: rows.reduce((s, r) => s + r.currentFyRefundsUnknownBasis, 0),
    currentFyRefundBasisComplete: rows.every((r) => r.currentFyRefundBasisComplete),
    // The whole table's verdict, through the SAME rule the client's filtered subtotal uses — see
    // combineNetLinearFigureBounds for why combining row verdicts is exact for a linear figure and
    // is not a licence to do the same to a ratio (o3d-la3n).
    currentFyRevenueBound: combineNetLinearFigureBounds(rows.map((r) => r.currentFyRevenueBound)),
    currentFyCogs: rows.reduce((s, r) => s + r.currentFyCogs, 0),
    currentFyProfit: rows.reduce((s, r) => s + r.currentFyProfit, 0),
    previousFyRevenue: rows.reduce((s, r) => s + r.previousFyRevenue, 0),
    previousFyRefundsGrossBasis: rows.reduce((s, r) => s + r.previousFyRefundsGrossBasis, 0),
    previousFyRefundsUnknownBasis: rows.reduce((s, r) => s + r.previousFyRefundsUnknownBasis, 0),
    previousFyRefundBasisComplete: rows.every((r) => r.previousFyRefundBasisComplete),
    previousFyRevenueBound: combineNetLinearFigureBounds(rows.map((r) => r.previousFyRevenueBound)),
    previousFyCogs: rows.reduce((s, r) => s + r.previousFyCogs, 0),
    previousFyProfit: rows.reduce((s, r) => s + r.previousFyProfit, 0),
    fyLabel,
    prevFyLabel,
  }

  return { rows, summary }
}
