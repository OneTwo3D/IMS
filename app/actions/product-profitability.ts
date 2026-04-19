'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'

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
  currentFyRevenue: number
  currentFyCogs: number
  currentFyProfit: number
  currentFyQtySold: number
  // Previous FY
  previousFyRevenue: number
  previousFyCogs: number
  previousFyProfit: number
  previousFyQtySold: number
}

export type ProfitabilitySummary = {
  totalProducts: number
  currentFyRevenue: number
  currentFyCogs: number
  currentFyProfit: number
  previousFyRevenue: number
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
  const FULFILLED = ['SHIPPED', 'COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const
  const [currentFyOrders, previousFyOrders] = await Promise.all([
    db.salesOrder.findMany({
      where: { status: { in: [...FULFILLED] }, createdAt: { gte: currentFyStart, lt: currentFyEnd } },
      select: {
        fxRateToBase: true, discountAmount: true, pricesIncludeVat: true, taxRatePercent: true,
        lines: { select: { productId: true, qty: true, totalBase: true, discountAmount: true, cogsBase: true } },
        refunds: { select: { lines: { select: { productId: true, qty: true, totalBase: true } } } },
      },
    }),
    db.salesOrder.findMany({
      where: { status: { in: [...FULFILLED] }, createdAt: { gte: previousFyStart, lt: previousFyEnd } },
      select: {
        fxRateToBase: true, discountAmount: true, pricesIncludeVat: true, taxRatePercent: true,
        lines: { select: { productId: true, qty: true, totalBase: true, discountAmount: true, cogsBase: true } },
        refunds: { select: { lines: { select: { productId: true, qty: true, totalBase: true } } } },
      },
    }),
  ])

  // 5. Aggregate by product for each FY
  type FyAgg = { revenue: number; cogs: number; qtySold: number }
  function aggregateOrders(orders: typeof currentFyOrders): Map<string, FyAgg> {
    const map = new Map<string, FyAgg>()
    for (const order of orders) {
      const fxRate = Number(order.fxRateToBase) || 1
      const orderLineTotal = order.lines.reduce((sum, line) => sum + Number(line.totalBase), 0)
      const orderDiscountBaseRaw = Number(order.discountAmount ?? 0) / fxRate
      const orderDiscountBase = order.pricesIncludeVat && Number(order.taxRatePercent ?? 0) > 0
        ? orderDiscountBaseRaw / (1 + Number(order.taxRatePercent))
        : orderDiscountBaseRaw
      for (const line of order.lines) {
        if (!line.productId) continue
        const agg = map.get(line.productId) ?? { revenue: 0, cogs: 0, qtySold: 0 }
        agg.revenue += Number(line.totalBase)
        agg.cogs += Number(line.cogsBase ?? 0)
        agg.qtySold += Number(line.qty)
        // Add back line discount (already subtracted from totalBase)
        agg.revenue += Number(line.discountAmount) / fxRate
        if (orderDiscountBase > 0 && orderLineTotal > 0) {
          agg.revenue -= orderDiscountBase * (Number(line.totalBase) / orderLineTotal)
        }
        map.set(line.productId, agg)
      }
      // Subtract refunds
      for (const refund of order.refunds) {
        for (const rl of refund.lines) {
          if (!rl.productId) continue
          const agg = map.get(rl.productId)
          if (agg) {
            agg.revenue -= Number(rl.totalBase)
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
      currentFyCogs,
      currentFyProfit: Math.round((currentFyRevenue - currentFyCogs) * 100) / 100,
      currentFyQtySold: Math.round((cfy?.qtySold ?? 0) * 100) / 100,
      previousFyRevenue,
      previousFyCogs,
      previousFyProfit: Math.round((previousFyRevenue - previousFyCogs) * 100) / 100,
      previousFyQtySold: Math.round((pfy?.qtySold ?? 0) * 100) / 100,
    })
  }

  rows.sort((a, b) => b.currentFyRevenue - a.currentFyRevenue)

  const summary: ProfitabilitySummary = {
    totalProducts: rows.length,
    currentFyRevenue: rows.reduce((s, r) => s + r.currentFyRevenue, 0),
    currentFyCogs: rows.reduce((s, r) => s + r.currentFyCogs, 0),
    currentFyProfit: rows.reduce((s, r) => s + r.currentFyProfit, 0),
    previousFyRevenue: rows.reduce((s, r) => s + r.previousFyRevenue, 0),
    previousFyCogs: rows.reduce((s, r) => s + r.previousFyCogs, 0),
    previousFyProfit: rows.reduce((s, r) => s + r.previousFyProfit, 0),
    fyLabel,
    prevFyLabel,
  }

  return { rows, summary }
}
