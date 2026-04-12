'use server'

import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth/server'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ForecastTier = 'new' | 'established' | 'mature'
export type AbcClass = 'A' | 'B' | 'C'

export type ProductForecast = {
  productId: string
  sku: string
  name: string
  imageUrl: string | null
  stockUnit: string
  // Current state
  currentStock: number
  reservedStock: number
  availableStock: number
  // Demand
  tier: ForecastTier
  avgDailyDemand: number       // units/day
  demandTrend: number          // +/- % vs prior period
  coefficientOfVariation: number // demand variability (0 = stable, >1 = erratic)
  abcClass: AbcClass
  // Supplier
  supplierId: string | null
  supplierName: string | null
  avgLeadTimeDays: number
  // Forecast
  reorderPoint: number
  safetyStock: number
  recommendedOrderQty: number
  daysUntilStockout: number
  urgency: 'critical' | 'low' | 'ok' | 'overstock'
}

export type ForecastSettings = {
  serviceLevelPercent: number   // e.g. 95
  defaultLeadTimeDays: number   // fallback if no PO history
  reviewPeriodDays: number      // how far back to look for demand
  reorderQtyWeeks: number       // weeks of supply to order
  retentionMonths: number       // how long to keep historical demand data
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: ForecastSettings = {
  serviceLevelPercent: 95,
  defaultLeadTimeDays: 14,
  reviewPeriodDays: 90,
  reorderQtyWeeks: 8,
  retentionMonths: 24,
}

export async function getForecastSettings(): Promise<ForecastSettings> {
  await requireAuth()
  const [row, retentionRow] = await Promise.all([
    db.setting.findUnique({ where: { key: 'forecast_settings' } }),
    db.setting.findUnique({ where: { key: 'forecast_retention_months' } }),
  ])
  let settings = { ...DEFAULT_SETTINGS }
  if (row?.value) {
    try { settings = { ...settings, ...JSON.parse(row.value) } } catch {}
  }
  if (retentionRow?.value) {
    settings.retentionMonths = Math.max(1, parseInt(retentionRow.value) || DEFAULT_SETTINGS.retentionMonths)
  }
  return settings
}

export async function saveForecastSettings(settings: ForecastSettings): Promise<void> {
  await requireAuth()
  await db.$transaction([
    db.setting.upsert({
      where: { key: 'forecast_settings' },
      create: { key: 'forecast_settings', value: JSON.stringify(settings) },
      update: { value: JSON.stringify(settings) },
    }),
    // Store retention separately so the purge cron can read it without parsing JSON
    db.setting.upsert({
      where: { key: 'forecast_retention_months' },
      create: { key: 'forecast_retention_months', value: String(settings.retentionMonths) },
      update: { value: String(settings.retentionMonths) },
    }),
  ])
}

// ---------------------------------------------------------------------------
// Z-score for service level
// ---------------------------------------------------------------------------

function zScore(serviceLevelPct: number): number {
  // Common values — avoids needing a stats library
  if (serviceLevelPct >= 99) return 2.33
  if (serviceLevelPct >= 97.5) return 1.96
  if (serviceLevelPct >= 95) return 1.65
  if (serviceLevelPct >= 90) return 1.28
  if (serviceLevelPct >= 85) return 1.04
  return 0.84 // 80%
}

// ---------------------------------------------------------------------------
// Exponential smoothing
// ---------------------------------------------------------------------------

function exponentialSmoothing(data: number[], alpha = 0.3): number {
  if (data.length === 0) return 0
  let smoothed = data[0]
  for (let i = 1; i < data.length; i++) {
    smoothed = alpha * data[i] + (1 - alpha) * smoothed
  }
  return smoothed
}

// ---------------------------------------------------------------------------
// Core forecast calculation
// ---------------------------------------------------------------------------

export async function generateForecasts(): Promise<ProductForecast[]> {
  await requireAuth()
  const settings = await getForecastSettings()
  const now = new Date()
  const reviewStart = new Date(now.getTime() - settings.reviewPeriodDays * 86400000)
  const priorStart = new Date(reviewStart.getTime() - settings.reviewPeriodDays * 86400000)
  const z = zScore(settings.serviceLevelPercent)

  // 1. Get all stockable products with current stock levels
  const products = await db.product.findMany({
    where: { active: true, type: { notIn: ['VARIABLE', 'NON_INVENTORY'] } },
    select: {
      id: true, sku: true, name: true, imageUrl: true, parent: { select: { imageUrl: true } }, stockUnit: true,
      stockLevels: { select: { quantity: true, reservedQty: true } },
    },
  })

  // 2. Get sales movements for the review period + prior period (for trend)
  const movements = await db.stockMovement.findMany({
    where: {
      type: 'SALE_DISPATCH',
      createdAt: { gte: priorStart },
    },
    select: { productId: true, qty: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  // Group movements by product
  const movementsByProduct = new Map<string, { qty: number; date: Date }[]>()
  for (const m of movements) {
    const list = movementsByProduct.get(m.productId) ?? []
    list.push({ qty: Number(m.qty), date: m.createdAt })
    movementsByProduct.set(m.productId, list)
  }

  // 3. Get preferred supplier per product (from SupplierProduct — most recent)
  const supplierProducts = await db.supplierProduct.findMany({
    select: { productId: true, supplierId: true, supplier: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  })
  const preferredSupplier = new Map<string, { supplierId: string; supplierName: string }>()
  for (const sp of supplierProducts) {
    if (!preferredSupplier.has(sp.productId)) {
      preferredSupplier.set(sp.productId, { supplierId: sp.supplierId, supplierName: sp.supplier.name })
    }
  }

  // 4. Calculate avg lead time per supplier from PO history
  const poLeadTimes = await db.purchaseOrder.findMany({
    where: { status: 'RECEIVED', poSentAt: { not: null }, receivedAt: { not: null } },
    select: { supplierId: true, poSentAt: true, receivedAt: true },
  })
  const leadTimeBySupplier = new Map<string, number[]>()
  for (const po of poLeadTimes) {
    if (!po.poSentAt || !po.receivedAt) continue
    const days = Math.round((po.receivedAt.getTime() - po.poSentAt.getTime()) / 86400000)
    if (days > 0 && days < 365) {
      const list = leadTimeBySupplier.get(po.supplierId) ?? []
      list.push(days)
      leadTimeBySupplier.set(po.supplierId, list)
    }
  }

  // 5. Total revenue by product for ABC classification
  const salesLines = await db.salesOrderLine.findMany({
    where: { order: { status: { in: ['SHIPPED', 'COMPLETED'] } } },
    select: { productId: true, totalGbp: true },
  })
  const revenueByProduct = new Map<string, number>()
  for (const sl of salesLines) {
    if (!sl.productId) continue
    revenueByProduct.set(sl.productId, (revenueByProduct.get(sl.productId) ?? 0) + Number(sl.totalGbp))
  }
  const totalRevenue = Array.from(revenueByProduct.values()).reduce((s, v) => s + v, 0)

  // Sort products by revenue descending for ABC
  const productsByRevenue = Array.from(revenueByProduct.entries()).sort((a, b) => b[1] - a[1])
  const abcMap = new Map<string, AbcClass>()
  let cumulative = 0
  for (const [pid, rev] of productsByRevenue) {
    cumulative += rev
    const pct = totalRevenue > 0 ? cumulative / totalRevenue : 1
    abcMap.set(pid, pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C')
  }

  // 6. Generate forecast per product
  const forecasts: ProductForecast[] = []

  for (const p of products) {
    const totalStock = p.stockLevels.reduce((s, sl) => s + Number(sl.quantity), 0)
    const reservedStock = p.stockLevels.reduce((s, sl) => s + Number(sl.reservedQty), 0)
    const availableStock = totalStock - reservedStock

    const allMovements = movementsByProduct.get(p.id) ?? []
    const recentMovements = allMovements.filter((m) => m.date >= reviewStart)
    const priorMovements = allMovements.filter((m) => m.date >= priorStart && m.date < reviewStart)

    // Determine tier
    const daysSinceFirstSale = allMovements.length > 0
      ? Math.round((now.getTime() - allMovements[0].date.getTime()) / 86400000)
      : 0
    const tier: ForecastTier = daysSinceFirstSale < 30 ? 'new' : daysSinceFirstSale < 365 ? 'established' : 'mature'

    // Calculate daily demand using appropriate method
    let avgDailyDemand: number
    const reviewDays = settings.reviewPeriodDays

    if (tier === 'new' || recentMovements.length < 3) {
      // Tier 1: Simple average
      const totalQty = recentMovements.reduce((s, m) => s + m.qty, 0)
      avgDailyDemand = reviewDays > 0 ? totalQty / reviewDays : 0
    } else {
      // Tier 2/3: Exponential smoothing on weekly buckets
      const weeklyBuckets: number[] = []
      const weeksInPeriod = Math.ceil(reviewDays / 7)
      for (let w = 0; w < weeksInPeriod; w++) {
        const weekStart = new Date(reviewStart.getTime() + w * 7 * 86400000)
        const weekEnd = new Date(weekStart.getTime() + 7 * 86400000)
        const weekQty = recentMovements
          .filter((m) => m.date >= weekStart && m.date < weekEnd)
          .reduce((s, m) => s + m.qty, 0)
        weeklyBuckets.push(weekQty)
      }
      const smoothedWeekly = exponentialSmoothing(weeklyBuckets, 0.3)
      avgDailyDemand = smoothedWeekly / 7
    }

    // Demand trend: compare current period vs prior period
    const recentTotal = recentMovements.reduce((s, m) => s + m.qty, 0)
    const priorTotal = priorMovements.reduce((s, m) => s + m.qty, 0)
    const demandTrend = priorTotal > 0 ? ((recentTotal - priorTotal) / priorTotal) * 100 : 0

    // Coefficient of variation (demand variability)
    let coefficientOfVariation = 0
    if (recentMovements.length >= 7) {
      const dailyQtys: number[] = []
      for (let d = 0; d < reviewDays; d++) {
        const dayStart = new Date(reviewStart.getTime() + d * 86400000)
        const dayEnd = new Date(dayStart.getTime() + 86400000)
        const dayQty = recentMovements.filter((m) => m.date >= dayStart && m.date < dayEnd).reduce((s, m) => s + m.qty, 0)
        dailyQtys.push(dayQty)
      }
      const mean = dailyQtys.reduce((s, v) => s + v, 0) / dailyQtys.length
      if (mean > 0) {
        const variance = dailyQtys.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyQtys.length
        coefficientOfVariation = Math.sqrt(variance) / mean
      }
    }

    // Supplier + lead time
    const supplier = preferredSupplier.get(p.id)
    const supplierLeadTimes = supplier ? leadTimeBySupplier.get(supplier.supplierId) : undefined
    const avgLeadTimeDays = supplierLeadTimes?.length
      ? Math.round(supplierLeadTimes.reduce((s, v) => s + v, 0) / supplierLeadTimes.length)
      : settings.defaultLeadTimeDays

    // Safety stock
    const demandStdDev = avgDailyDemand * coefficientOfVariation
    const safetyStock = Math.ceil(z * demandStdDev * Math.sqrt(avgLeadTimeDays))

    // Reorder point
    const reorderPoint = Math.ceil(avgDailyDemand * avgLeadTimeDays + safetyStock)

    // Recommended order qty (weeks of supply)
    const recommendedOrderQty = Math.max(
      Math.ceil(avgDailyDemand * 7 * settings.reorderQtyWeeks),
      1,
    )

    // Days until stockout
    const daysUntilStockout = avgDailyDemand > 0
      ? Math.round(availableStock / avgDailyDemand)
      : availableStock > 0 ? 999 : 0

    // Urgency
    let urgency: ProductForecast['urgency']
    if (availableStock <= 0) urgency = 'critical'
    else if (availableStock <= reorderPoint) urgency = 'low'
    else if (daysUntilStockout > settings.reorderQtyWeeks * 7 * 2) urgency = 'overstock'
    else urgency = 'ok'

    // ABC class
    const abcClass = abcMap.get(p.id) ?? 'C'

    forecasts.push({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      imageUrl: p.imageUrl ?? p.parent?.imageUrl ?? null,
      stockUnit: p.stockUnit,
      currentStock: totalStock,
      reservedStock,
      availableStock,
      tier,
      avgDailyDemand: Math.round(avgDailyDemand * 100) / 100,
      demandTrend: Math.round(demandTrend * 10) / 10,
      coefficientOfVariation: Math.round(coefficientOfVariation * 100) / 100,
      abcClass,
      supplierId: supplier?.supplierId ?? null,
      supplierName: supplier?.supplierName ?? null,
      avgLeadTimeDays,
      reorderPoint,
      safetyStock,
      recommendedOrderQty: avgDailyDemand > 0 ? recommendedOrderQty : 0,
      daysUntilStockout,
      urgency,
    })
  }

  // Sort: critical first, then low, then by days until stockout
  forecasts.sort((a, b) => {
    const urgencyOrder = { critical: 0, low: 1, ok: 2, overstock: 3 }
    const diff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
    if (diff !== 0) return diff
    return a.daysUntilStockout - b.daysUntilStockout
  })

  return forecasts
}

// ---------------------------------------------------------------------------
// Auto-generate draft POs from reorder suggestions
// ---------------------------------------------------------------------------

export async function createReorderPOs(
  productIds: string[],
): Promise<{ success: boolean; poCount: number; error?: string }> {
  await requireAuth()
  try {
    const forecasts = await generateForecasts()
    const selected = forecasts.filter((f) => productIds.includes(f.productId) && f.supplierId)

    // Group by supplier
    const bySupplier = new Map<string, ProductForecast[]>()
    for (const f of selected) {
      const list = bySupplier.get(f.supplierId!) ?? []
      list.push(f)
      bySupplier.set(f.supplierId!, list)
    }

    let poCount = 0
    for (const [supplierId, items] of bySupplier) {
      // Get supplier info for currency
      const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { currency: true } })
      const currency = supplier?.currency ?? 'GBP'

      // Get last prices
      const lastPrices = await db.supplierProduct.findMany({
        where: { supplierId, productId: { in: items.map((i) => i.productId) } },
        select: { productId: true, lastUnitCost: true },
      })
      const priceMap = new Map(lastPrices.map((lp) => [lp.productId, Number(lp.lastUnitCost)]))

      const ref = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

      let subtotal = 0
      const lineData = items.map((item, i) => {
        const unitCost = priceMap.get(item.productId) ?? 0
        const total = item.recommendedOrderQty * unitCost
        subtotal += total
        return {
          productId: item.productId,
          qty: item.recommendedOrderQty,
          unitCostForeign: unitCost,
          unitCostGbp: unitCost, // approximate — will be recalculated with FX
          taxForeign: 0, taxGbp: 0,
          totalForeign: total,
          totalGbp: total,
          sortOrder: i,
        }
      })

      await db.purchaseOrder.create({
        data: {
          reference: ref,
          type: 'GOODS',
          supplierId,
          currency,
          fxRateToGbp: 1, // user can update FX rate on the PO
          subtotalForeign: subtotal,
          subtotalGbp: subtotal,
          taxForeign: 0, taxGbp: 0,
          totalForeign: subtotal,
          totalGbp: subtotal,
          notes: 'Auto-generated from reorder forecast',
          lines: { create: lineData },
        },
      })
      poCount++
    }

    return { success: true, poCount }
  } catch (e) {
    return { success: false, poCount: 0, error: String(e) }
  }
}
