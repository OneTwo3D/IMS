'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { REORDER_ELIGIBLE_PRODUCT_STATUSES } from '@/lib/products/lifecycle'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { resolvePurchaseOrderFxRateToBase } from '@/lib/domain/purchasing/purchase-order-fx'
import { partitionReorderMoCandidates, type ReorderMoSkip } from '@/lib/domain/manufacturing/reorder-mo-planning'
import { selectReorderPoCandidates, type ReorderPoSkip } from '@/lib/domain/purchasing/reorder-po-planning'
import type { StockPositionFilters } from '@/lib/domain/inventory/stock-position-reports'
import { ProductType } from '@/app/generated/prisma/client'

// audit-pcc0: the filter subset the Reorder Planning page passes to the PO/MO
// buttons so draft quantities are computed from the SAME getReorderReport the
// operator is looking at (same demand window, weeks-of-supply, warehouse/supplier
// scope, ABC/urgency/search), instead of a separately-recomputed default.
export type ReorderActionFilters = Pick<
  StockPositionFilters,
  'warehouseId' | 'categoryId' | 'supplierId' | 'productType' | 'thresholdDays' | 'targetCoverWeeks' | 'abcClass' | 'urgency' | 'search'
>

// Server actions can't trust their argument — the ReorderActionFilters type is only a
// compile-time hint. Rebuild a clean object from known keys (dropping anything else),
// clamp the numeric controls, and bound the search string so a crafted call can't push
// unbounded values into getReorderReport or the persisted reorder evidence. (Quantities
// are still authoritative — getReorderReport recomputes them server-side.)
function sanitizeReorderActionFilters(filters?: ReorderActionFilters): ReorderActionFilters {
  const f = filters ?? {}
  const positiveInt = (n: unknown): number | undefined => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined)
  const weeks = positiveInt(f.targetCoverWeeks)
  return {
    warehouseId: f.warehouseId || undefined,
    categoryId: f.categoryId || undefined,
    supplierId: f.supplierId || undefined,
    productType: f.productType && (Object.values(ProductType) as string[]).includes(f.productType) ? f.productType : undefined,
    thresholdDays: positiveInt(f.thresholdDays),
    targetCoverWeeks: weeks === undefined ? undefined : Math.min(52, weeks),
    abcClass: f.abcClass === 'A' || f.abcClass === 'B' || f.abcClass === 'C' ? f.abcClass : undefined,
    urgency: f.urgency === 'critical' || f.urgency === 'reorder' || f.urgency === 'watch' ? f.urgency : undefined,
    search: typeof f.search === 'string' ? f.search.trim().slice(0, 100) || undefined : undefined,
  }
}

// audit-M-mfg #2: a freshly-created reorder draft within this window suppresses a
// duplicate re-submit (e.g. a refresh-and-resubmit), without blocking a deliberate
// re-order later. The UI button is also disabled while the request is in flight
// (useTransition), which is the first line of defence against a true double-click;
// this server window catches the slower re-submit that the disabled button misses.
const REORDER_DEDUP_WINDOW_MS = 10 * 60 * 1000
// Stable marker for reorder-generated POs — used both to stamp and to dedup, so
// the two can't drift.
const REORDER_PO_NOTE = 'Auto-generated from reorder forecast'

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

export type GenerateForecastOptions = {
  supplierId?: string | null
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
  await requirePermission('analytics')
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
  await requirePermission('analytics')
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
  await logActivity({
    entityType: 'SETTING',
    tag: 'analytics',
    action: 'updated',
    description: 'Updated forecast settings',
    metadata: settings,
  })
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

export async function generateForecasts(options: GenerateForecastOptions = {}): Promise<ProductForecast[]> {
  await requirePermission('analytics')
  const settings = await getForecastSettings()
  const now = new Date()
  const reviewStart = new Date(now.getTime() - settings.reviewPeriodDays * 86400000)
  const priorStart = new Date(reviewStart.getTime() - settings.reviewPeriodDays * 86400000)
  const z = zScore(settings.serviceLevelPercent)

  // 1. Get all stockable products with current stock levels
  const products = await db.product.findMany({
    where: {
      lifecycleStatus: { in: REORDER_ELIGIBLE_PRODUCT_STATUSES },
      type: { notIn: ['VARIABLE', 'NON_INVENTORY'] },
      ...(options.supplierId ? { preferredSupplierId: options.supplierId } : {}),
    },
    select: {
      id: true, sku: true, name: true, imageUrl: true, parent: { select: { imageUrl: true } }, stockUnit: true,
      preferredSupplierId: true,
      preferredSupplier: { select: { id: true, name: true } },
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

  // 3. Calculate avg lead time per supplier from PO history
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

  // 4. Total revenue by product for ABC classification
  const salesLines = await db.salesOrderLine.findMany({
    where: { order: { status: { in: ['SHIPPED', 'COMPLETED'] } } },
    select: { productId: true, totalBase: true },
  })
  const revenueByProduct = new Map<string, number>()
  for (const sl of salesLines) {
    if (!sl.productId) continue
    revenueByProduct.set(sl.productId, (revenueByProduct.get(sl.productId) ?? 0) + Number(sl.totalBase))
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

  // 5. Generate forecast per product
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
    const supplier = p.preferredSupplier
      ? { supplierId: p.preferredSupplier.id, supplierName: p.preferredSupplier.name }
      : null
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
  options: { filters?: ReorderActionFilters } = {},
): Promise<{ success: boolean; poCount: number; skippedSupplierCount?: number; skippedProducts?: ReorderPoSkip[]; error?: string }> {
  await requirePermission('purchasing.create')
  try {
    const generatedAt = new Date().toISOString()
    const actionFilters = sanitizeReorderActionFilters(options.filters)
    // audit-pcc0: source draft-PO quantities from the SAME Reorder Planning report
    // the operator selected from (whole-unit order-up-to suggestedReorderQty, the
    // page's filters, inbound netting, lowest-cost supplier choice) — not the legacy
    // generateForecasts engine, which used a different quantity and urgency model.
    const { getReorderReport } = await import('@/lib/domain/inventory/replenishment-reports')
    const report = await getReorderReport(actionFilters as StockPositionFilters, { paginate: false })
    const { bySupplier, skipped: skippedProducts } = selectReorderPoCandidates(report.rows, productIds)

    const baseCurrency = await getBaseCurrencyCode()
    // audit-M-mfg #2: double-click idempotency — skip suppliers that already have
    // a reorder-sourced DRAFT PO created in the last few minutes.
    const recentReorderPoCutoff = new Date(Date.now() - REORDER_DEDUP_WINDOW_MS)
    const recentReorderPos = await db.purchaseOrder.findMany({
      where: {
        supplierId: { in: [...bySupplier.keys()] },
        status: 'DRAFT',
        notes: REORDER_PO_NOTE,
        createdAt: { gte: recentReorderPoCutoff },
      },
      select: { supplierId: true },
    })
    const recentReorderSupplierIds = new Set(recentReorderPos.map((po) => po.supplierId))
    let poCount = 0
    let skippedSupplierCount = 0
    for (const [supplierId, items] of bySupplier) {
      if (recentReorderSupplierIds.has(supplierId)) {
        skippedSupplierCount += 1
        continue
      }
      // Get supplier info for currency
      const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { currency: true } })
      const currency = supplier?.currency ?? 'GBP'
      const fxRate = await resolvePurchaseOrderFxRateToBase(db, {
        currency,
        baseCurrency,
        asOf: new Date(),
      })

      // Get last prices
      const lastPrices = await db.supplierProduct.findMany({
        where: { supplierId, productId: { in: items.map((c) => c.row.productId) } },
        select: { productId: true, lastUnitCost: true },
      })
      const priceMap = new Map(lastPrices.map((lp) => [lp.productId, Number(lp.lastUnitCost)]))

      const ref = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

      let subtotal = 0
      const lineData = items.map((candidate, i) => {
        const row = candidate.row
        const qty = candidate.qty
        const unitCost = priceMap.get(row.productId) ?? 0
        const total = qty * unitCost
        const unitCostBase = Math.round((unitCost / fxRate) * 1000000) / 1000000
        const totalBase = Math.round((total / fxRate) * 10000) / 10000
        subtotal += total
        const reorderEvidence = {
          source: 'reorder_planning',
          generatedAt,
          filters: actionFilters,
          supplierId,
          productId: row.productId,
          sku: row.sku,
          averageDailyDemand: row.averageDailyDemand,
          abcClass: row.abcClass,
          availableQty: row.availableQty,
          inboundOpenPoQty: row.inboundOpenPoQty,
          leadTimeDays: row.leadTimeDays,
          reorderPoint: row.reorderPoint,
          safetyStockQty: row.safetyStockQty,
          suggestedReorderQty: row.suggestedReorderQty,
          urgency: row.urgency,
        }
        return {
          productId: row.productId,
          qty,
          unitCostForeign: unitCost,
          unitCostBase,
          taxForeign: 0, taxBase: 0,
          totalForeign: total,
          totalBase,
          reorderEvidence,
          sortOrder: i,
        }
      })
      const subtotalBase = Math.round((subtotal / fxRate) * 10000) / 10000

      await db.purchaseOrder.create({
        data: {
          reference: ref,
          type: 'GOODS',
          supplierId,
          currency,
          fxRateToBase: fxRate,
          subtotalForeign: subtotal,
          subtotalBase,
          taxForeign: 0, taxBase: 0,
          totalForeign: subtotal,
          totalBase: subtotalBase,
          notes: REORDER_PO_NOTE,
          lines: { create: lineData },
        },
      })
      poCount++
    }

    await logActivity({
      entityType: 'PURCHASE_ORDER',
      tag: 'purchasing',
      action: 'created',
      description: `Auto-generated ${poCount} reorder PO(s) from Reorder Planning${skippedSupplierCount > 0 ? ` (skipped ${skippedSupplierCount} supplier(s) with a recent reorder draft)` : ''}`,
      metadata: { poCount, skippedSupplierCount, productIds, skippedProducts },
    })

    return { success: true, poCount, skippedSupplierCount, skippedProducts }
  } catch (e) {
    return { success: false, poCount: 0, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Auto-generate draft Manufacturing Orders from reorder suggestions for
// manufactured (BOM) products.
//
// Mirrors createReorderPOs but emits ProductionOrder rows instead of
// PurchaseOrder rows. For each selected BOM product the helper:
//   - looks up the latest ProductionOrder to copy the manufacturer and
//     warehouse (falling back to the first warehouse if none exists),
//   - picks the most recently-updated active Bom for that product,
//   - re-runs getReorderReport to read the suggestedReorderQty consistent
//     with the report the operator selected from, and
//   - creates a DRAFT ProductionOrder for that quantity.
// ---------------------------------------------------------------------------

export async function createReorderMOs(
  productIds: string[],
  options: { filters?: ReorderActionFilters } = {},
): Promise<{ success: boolean; moCount: number; skipped?: ReorderMoSkip[]; error?: string }> {
  await requirePermission('manufacturing')
  try {
    const { getReorderReport } = await import('@/lib/domain/inventory/replenishment-reports')
    // audit-pcc0: use the page's filters so the MO quantity matches the report row
    // the operator selected from, not a default-filtered recompute.
    const report = await getReorderReport(sanitizeReorderActionFilters(options.filters) as StockPositionFilters, { paginate: false })
    const suggestedByProduct = new Map(report.rows.map((row) => [row.productId, row]))

    const eligible = productIds.filter((productId) => {
      const row = suggestedByProduct.get(productId)
      return row && row.productType === 'BOM' && Number(row.suggestedReorderQty) > 0
    })
    if (eligible.length === 0) return { success: true, moCount: 0 }

    // Latest production order per product gives us manufacturer + warehouse
    // to copy. orderBy then keep-first wins so a single query covers it.
    const latestMoRows = await db.productionOrder.findMany({
      where: { outputProductId: { in: eligible } },
      select: { outputProductId: true, warehouseId: true, manufacturerId: true },
      orderBy: { createdAt: 'desc' },
    })
    const latestByProduct = new Map<string, { warehouseId: string; manufacturerId: string | null }>()
    for (const row of latestMoRows) {
      if (!latestByProduct.has(row.outputProductId)) {
        latestByProduct.set(row.outputProductId, {
          warehouseId: row.warehouseId,
          manufacturerId: row.manufacturerId,
        })
      }
    }

    // Active BOMs per product. We pick the most recently-updated active BOM
    // that lists the product as a parent on any of its items — that's the
    // BOM the operator most recently shaped, mirroring the "latest MO" pick.
    const bomCandidates = await db.bom.findMany({
      where: {
        active: true,
        items: { some: { parentProductId: { in: eligible } } },
      },
      select: {
        id: true,
        updatedAt: true,
        items: { where: { parentProductId: { in: eligible } }, select: { parentProductId: true } },
      },
      orderBy: { updatedAt: 'desc' },
    })
    const bomIdByProduct = new Map<string, string>()
    for (const bom of bomCandidates) {
      for (const item of bom.items) {
        if (!bomIdByProduct.has(item.parentProductId)) {
          bomIdByProduct.set(item.parentProductId, bom.id)
        }
      }
    }

    const fallbackWarehouse = await db.warehouse.findFirst({
      orderBy: { code: 'asc' },
      select: { id: true },
    })

    // audit-M-mfg #2: double-click idempotency — skip products that already have
    // a DRAFT MO created in the last few minutes (a re-order minutes later is
    // still allowed).
    const recentDraftCutoff = new Date(Date.now() - REORDER_DEDUP_WINDOW_MS)
    const recentDraftMos = await db.productionOrder.findMany({
      where: { outputProductId: { in: eligible }, status: 'DRAFT', createdAt: { gte: recentDraftCutoff } },
      select: { outputProductId: true },
    })
    const recentDraftProductIds = new Set(recentDraftMos.map((mo) => mo.outputProductId))

    // audit-M-mfg #2/#3: partition into create vs skipped(reason) — no silent drops.
    const { toCreate, skipped } = partitionReorderMoCandidates({
      productIds: eligible,
      rowByProduct: new Map([...suggestedByProduct].map(([id, row]) => [id, { sku: row.sku, suggestedReorderQty: Number(row.suggestedReorderQty) }])),
      bomIdByProduct,
      warehouseByProduct: new Map(eligible.map((id) => [id, latestByProduct.get(id)?.warehouseId ?? fallbackWarehouse?.id])),
      recentDraftProductIds,
    })

    let moCount = 0
    for (const candidate of toCreate) {
      const latest = latestByProduct.get(candidate.productId)
      const reference = `MO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
      await db.productionOrder.create({
        data: {
          reference,
          orderType: 'ASSEMBLY',
          bomId: candidate.bomId,
          outputProductId: candidate.productId,
          warehouseId: candidate.warehouseId,
          manufacturerId: latest?.manufacturerId ?? null,
          qtyPlanned: candidate.qtyPlanned,
          status: 'DRAFT',
        },
      })
      await logActivity({
        entityType: 'PRODUCTION_ORDER',
        entityId: reference,
        tag: 'manufacturing',
        action: 'created',
        description: `Created draft MO ${reference} for ${candidate.sku} from reorder report (qty ${candidate.qtyPlanned})`,
        metadata: { productId: candidate.productId, bomId: candidate.bomId, qtyPlanned: candidate.qtyPlanned, source: 'reorder_report' },
      })
      moCount += 1
    }

    // audit-M-mfg #3: surface skipped products (no active BOM / no warehouse /
    // recent duplicate) so the operator knows why fewer MOs were created.
    if (skipped.length > 0) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'reorder_mos_skipped',
        tag: 'manufacturing',
        level: 'WARNING',
        description: `Reorder MO creation skipped ${skipped.length} product(s): ${skipped.map((s) => `${s.sku} (${s.reason})`).join(', ')}.`,
        metadata: { skipped },
      })
    }
    return { success: true, moCount, skipped }
  } catch (e) {
    return { success: false, moCount: 0, error: String(e) }
  }
}
