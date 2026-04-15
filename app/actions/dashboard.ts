'use server'

import { db } from '@/lib/db'
import { getSetting } from '@/app/actions/settings'
import { requireAuth } from '@/lib/auth/server'
import { getSalesOrderReference } from '@/lib/sales-order-display'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TopProduct = {
  productId: string
  sku: string
  name: string
  netRevenue: number
  qtySold: number
  marginPct: number
}

export type KpiSummary = {
  // Selected period
  ordersCurrent: number
  grossSalesCurrent: number
  discountsCurrent: number
  refundsCurrent: number
  netSalesCurrent: number
  cogsCurrent: number
  profitCurrent: number
  marginCurrent: number
  shippingCurrent: number
  // Comparison period
  ordersComparison: number
  grossSalesComparison: number
  netSalesComparison: number
  cogsComparison: number
  marginComparison: number
  // Other KPIs
  totalProducts: number
  activeProducts: number
  inventoryValue: number
  openPurchaseOrders: number
  openPOValue: number
  pendingSalesOrders: number
  pendingSalesValue: number
  avgOrderValue: number
  lowStockCount: number
  outOfStockCount: number
}

export type ChartPoint = {
  label: string
  grossSales: number
  netSales: number
  cogs: number
  marginPct: number
  compNetSales: number
  compCogs: number
  compMarginPct: number
}

export type IncomingPO = {
  id: string
  reference: string
  supplierName: string
  totalGbp: number
  status: string
  expectedDelivery: string | null
  createdAt: string
  lineCount: number
}

export type RecentOrder = { id: string; orderNumber: string; customerName: string; totalGbp: number; status: string; createdAt: string }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }
function startOfWeek(d: Date): Date { const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); return new Date(d.getFullYear(), d.getMonth(), diff) }
function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1) }
function startOfYear(d: Date): Date { return new Date(d.getFullYear(), 0, 1) }
function endOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999) }
function addDays(d: Date, n: number): Date { const r = new Date(d); r.setDate(r.getDate() + n); return r }

function startOfFY(d: Date, fyMonth: number, fyDay: number): Date {
  const fyStart = new Date(d.getFullYear(), fyMonth - 1, fyDay)
  return d >= fyStart ? fyStart : new Date(d.getFullYear() - 1, fyMonth - 1, fyDay)
}

export type Period = 'today' | 'this_week' | 'this_month' | 'this_quarter' | 'this_year' | 'this_fy' | 'last_7d' | 'last_30d' | 'last_90d' | 'last_365d' | 'custom'
export type CompareMode = 'previous_period' | 'previous_year' | 'previous_fy'

function getPeriodRange(period: Period, now: Date, fyMonth: number, fyDay: number, customFrom?: string, customTo?: string): [Date, Date] {
  const today = startOfDay(now)
  switch (period) {
    case 'today': return [today, endOfDay(today)]
    case 'this_week': return [startOfWeek(now), endOfDay(today)]
    case 'this_month': return [startOfMonth(now), endOfDay(today)]
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3) * 3
      return [new Date(now.getFullYear(), q, 1), endOfDay(today)]
    }
    case 'this_year': return [startOfYear(now), endOfDay(today)]
    case 'this_fy': return [startOfFY(now, fyMonth, fyDay), endOfDay(today)]
    case 'last_7d': return [addDays(today, -6), endOfDay(today)]
    case 'last_30d': return [addDays(today, -29), endOfDay(today)]
    case 'last_90d': return [addDays(today, -89), endOfDay(today)]
    case 'last_365d': return [addDays(today, -364), endOfDay(today)]
    case 'custom': {
      const from = customFrom ? new Date(customFrom) : addDays(today, -29)
      const to = customTo ? new Date(customTo + 'T23:59:59.999') : endOfDay(today)
      return [from, to]
    }
  }
}

function getComparisonRange(from: Date, to: Date, mode: CompareMode, fyMonth: number, fyDay: number): [Date, Date] {
  const durationMs = to.getTime() - from.getTime()
  switch (mode) {
    case 'previous_period': {
      const compTo = new Date(from.getTime() - 1)
      const compFrom = new Date(compTo.getTime() - durationMs)
      return [startOfDay(compFrom), endOfDay(compTo)]
    }
    case 'previous_year': {
      const compFrom = new Date(from.getFullYear() - 1, from.getMonth(), from.getDate())
      const compTo = new Date(to.getFullYear() - 1, to.getMonth(), to.getDate(), 23, 59, 59, 999)
      return [compFrom, compTo]
    }
    case 'previous_fy': {
      const currentFYStart = startOfFY(from, fyMonth, fyDay)
      const prevFYStart = new Date(currentFYStart.getFullYear() - 1, fyMonth - 1, fyDay)
      const prevFYEnd = new Date(currentFYStart.getTime() - 1)
      return [prevFYStart, endOfDay(prevFYEnd)]
    }
  }
}

const COMPLETED_STATUSES: ('SHIPPED' | 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED')[] = ['SHIPPED', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ---------------------------------------------------------------------------
// Main dashboard data fetcher
// ---------------------------------------------------------------------------

export async function getDashboardData(
  period: Period = 'this_month',
  compareMode: CompareMode = 'previous_period',
  customFrom?: string,
  customTo?: string,
): Promise<{
  kpi: KpiSummary
  chartData: ChartPoint[]
  topProducts: TopProduct[]
  recentOrders: RecentOrder[]
  incomingPOs: IncomingPO[]
  periodLabel: string
  compLabel: string
}> {
  await requireAuth()
  const fyStartStr = await getSetting('financial_year_start') ?? '04-06'
  const [fyMonth, fyDay] = fyStartStr.split('-').map(Number)

  const now = new Date()
  const [periodFrom, periodTo] = getPeriodRange(period, now, fyMonth, fyDay, customFrom, customTo)
  const [compFrom, compTo] = getComparisonRange(periodFrom, periodTo, compareMode, fyMonth, fyDay)

  // Fetch all data needed — go back far enough to cover comparison range
  const fetchFrom = new Date(Math.min(compFrom.getTime(), periodFrom.getTime(), now.getTime() - 2 * 365 * 86400000))

  const [orders, products, openPOs, pendingSales, , costLayers, incomingPOData, allRecent] = await Promise.all([
    db.salesOrder.findMany({
      where: { status: { in: COMPLETED_STATUSES }, createdAt: { gte: fetchFrom } },
      select: {
        id: true, externalOrderNumber: true, customerName: true, status: true, createdAt: true,
        totalGbp: true, subtotalGbp: true, shippingGbp: true, discountAmount: true, fxRateToGbp: true,
        lines: { select: { cogsGbp: true, qty: true, totalGbp: true, discountAmount: true, productId: true, sku: true, description: true } },
        refunds: { select: { totalGbp: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.product.findMany({
      select: { id: true, lifecycleStatus: true, stockLevels: { select: { quantity: true, reservedQty: true } } },
    }),
    db.purchaseOrder.findMany({
      where: { type: 'GOODS', status: { in: ['PO_SENT', 'PARTIALLY_RECEIVED', 'RFQ_SENT'] } },
      select: { totalGbp: true },
    }),
    db.salesOrder.findMany({
      where: { status: { in: ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] } },
      select: { totalGbp: true },
    }),
    db.salesOrderRefund.findMany({
      where: { refundedAt: { gte: periodFrom, lte: periodTo } },
      select: { totalGbp: true },
    }),
    db.costLayer.findMany({
      where: { remainingQty: { gt: 0 } },
      select: { remainingQty: true, unitCostGbp: true },
    }),
    // Next 5 incoming purchase orders
    db.purchaseOrder.findMany({
      where: { type: 'GOODS', status: { in: ['PO_SENT', 'PARTIALLY_RECEIVED'] } },
      select: {
        id: true, reference: true, status: true, totalGbp: true, expectedDelivery: true, createdAt: true,
        supplier: { select: { name: true } },
        lines: { select: { id: true } },
      },
      orderBy: [{ expectedDelivery: 'asc' }, { createdAt: 'asc' }],
      take: 5,
    }),
    // Recent 10 orders
    db.salesOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, orderNumber: true, externalOrderNumber: true, customerName: true, totalGbp: true, status: true, createdAt: true },
    }),
  ])

  const inventoryValue = costLayers.reduce((s, cl) => s + Number(cl.remainingQty) * Number(cl.unitCostGbp), 0)

  // Period helpers
  function ordersInRange(from: Date, to: Date) { return orders.filter((o) => o.createdAt >= from && o.createdAt <= to) }

  type OrderAgg = { gross: number; discounts: number; refunds: number; net: number; cogs: number; shipping: number }
  function aggregate(list: typeof orders): OrderAgg {
    let gross = 0, discounts = 0, refunds = 0, cogs = 0, shipping = 0
    for (const o of list) {
      const lineTotal = o.lines.reduce((s, l) => s + Number(l.totalGbp), 0)
      const lineDisc = o.lines.reduce((s, l) => s + Number(l.discountAmount ?? 0), 0) / Number(o.fxRateToGbp || 1)
      gross += lineTotal + lineDisc
      discounts += lineDisc
      refunds += o.refunds.reduce((s, r) => s + Number(r.totalGbp), 0)
      cogs += o.lines.reduce((s, l) => s + Number(l.cogsGbp ?? 0), 0)
      shipping += Number(o.shippingGbp ?? 0)
    }
    const net = gross - discounts - refunds
    return { gross, discounts, refunds, net, cogs, shipping }
  }

  const currentOrders = ordersInRange(periodFrom, periodTo)
  const compOrders = ordersInRange(compFrom, compTo)
  const cur = aggregate(currentOrders)
  const comp = aggregate(compOrders)

  const r2 = (v: number) => Math.round(v * 100) / 100

  const kpi: KpiSummary = {
    ordersCurrent: currentOrders.length,
    grossSalesCurrent: r2(cur.gross),
    discountsCurrent: r2(cur.discounts),
    refundsCurrent: r2(cur.refunds),
    netSalesCurrent: r2(cur.net),
    cogsCurrent: r2(cur.cogs),
    profitCurrent: r2(cur.net - cur.cogs),
    marginCurrent: cur.net > 0 ? Math.round(((cur.net - cur.cogs) / cur.net) * 1000) / 10 : 0,
    shippingCurrent: r2(cur.shipping),
    ordersComparison: compOrders.length,
    grossSalesComparison: r2(comp.gross),
    netSalesComparison: r2(comp.net),
    cogsComparison: r2(comp.cogs),
    marginComparison: comp.net > 0 ? Math.round(((comp.net - comp.cogs) / comp.net) * 1000) / 10 : 0,
    totalProducts: products.length,
    activeProducts: products.filter((p) => p.lifecycleStatus === 'ACTIVE').length,
    inventoryValue: r2(inventoryValue),
    openPurchaseOrders: openPOs.length,
    openPOValue: r2(openPOs.reduce((s, po) => s + Number(po.totalGbp), 0)),
    pendingSalesOrders: pendingSales.length,
    pendingSalesValue: r2(pendingSales.reduce((s, so) => s + Number(so.totalGbp), 0)),
    avgOrderValue: currentOrders.length > 0 ? r2(cur.net / currentOrders.length) : 0,
    lowStockCount: 0,
    outOfStockCount: 0,
  }

  for (const p of products) {
    if (p.lifecycleStatus !== 'ACTIVE') continue
    const totalStock = p.stockLevels.reduce((s, sl) => s + Number(sl.quantity), 0)
    const available = p.stockLevels.reduce((s, sl) => s + Number(sl.quantity) - Number(sl.reservedQty), 0)
    if (totalStock <= 0) kpi.outOfStockCount++
    else if (available > 0 && available <= 5) kpi.lowStockCount++
  }

  // ---------------------------------------------------------------------------
  // Chart data — auto-select granularity based on period length
  // ---------------------------------------------------------------------------
  const durationDays = Math.round((periodTo.getTime() - periodFrom.getTime()) / 86400000)
  const compDurationDays = Math.round((compTo.getTime() - compFrom.getTime()) / 86400000)
  const chartData: ChartPoint[] = []

  function makePoint(label: string, curOrders: typeof orders, compOrders: typeof orders): ChartPoint {
    const c = aggregate(curOrders)
    const p = aggregate(compOrders)
    return {
      label,
      grossSales: r2(c.gross), netSales: r2(c.net), cogs: r2(c.cogs),
      marginPct: c.net > 0 ? Math.round(((c.net - c.cogs) / c.net) * 1000) / 10 : 0,
      compNetSales: r2(p.net), compCogs: r2(p.cogs),
      compMarginPct: p.net > 0 ? Math.round(((p.net - p.cogs) / p.net) * 1000) / 10 : 0,
    }
  }

  if (durationDays <= 1) {
    for (let h = 0; h < 24; h++) {
      const hStart = new Date(periodFrom.getFullYear(), periodFrom.getMonth(), periodFrom.getDate(), h)
      const hEnd = new Date(periodFrom.getFullYear(), periodFrom.getMonth(), periodFrom.getDate(), h, 59, 59, 999)
      const chStart = new Date(compFrom.getFullYear(), compFrom.getMonth(), compFrom.getDate(), h)
      const chEnd = new Date(compFrom.getFullYear(), compFrom.getMonth(), compFrom.getDate(), h, 59, 59, 999)
      chartData.push(makePoint(`${h}:00`, ordersInRange(hStart, hEnd), ordersInRange(chStart, chEnd)))
    }
  } else if (durationDays <= 90) {
    for (let i = 0; i < durationDays; i++) {
      const d = addDays(periodFrom, i)
      const cd = addDays(compFrom, Math.min(i, compDurationDays - 1))
      chartData.push(makePoint(`${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`, ordersInRange(d, endOfDay(d)), ordersInRange(cd, endOfDay(cd))))
    }
  } else {
    const startMonth = new Date(periodFrom.getFullYear(), periodFrom.getMonth(), 1)
    const endMonth = new Date(periodTo.getFullYear(), periodTo.getMonth() + 1, 0)
    let cursor = startMonth
    while (cursor <= endMonth) {
      const mEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999)
      let cm: Date
      if (compareMode === 'previous_year' || compareMode === 'previous_fy') {
        cm = new Date(cursor.getFullYear() - 1, cursor.getMonth(), 1)
      } else {
        const monthsOffset = (periodFrom.getFullYear() - compFrom.getFullYear()) * 12 + (periodFrom.getMonth() - compFrom.getMonth())
        cm = new Date(cursor.getFullYear(), cursor.getMonth() - monthsOffset, 1)
      }
      const cmEnd = new Date(cm.getFullYear(), cm.getMonth() + 1, 0, 23, 59, 59, 999)
      chartData.push(makePoint(`${MONTH_NAMES[cursor.getMonth()]} ${String(cursor.getFullYear()).slice(2)}`, ordersInRange(cursor, mEnd), ordersInRange(cm, cmEnd)))
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
  }

  // ---------------------------------------------------------------------------
  // Top 10 products (in selected period)
  // ---------------------------------------------------------------------------
  const productMap = new Map<string, TopProduct & { totalCogs: number }>()
  for (const o of currentOrders) {
    for (const l of o.lines) {
      if (!l.productId) continue
      if (!productMap.has(l.productId)) {
        productMap.set(l.productId, { productId: l.productId, sku: l.sku ?? '', name: l.description, netRevenue: 0, qtySold: 0, marginPct: 0, totalCogs: 0 })
      }
      const row = productMap.get(l.productId)!
      row.netRevenue += Number(l.totalGbp)
      row.qtySold += Number(l.qty)
      row.totalCogs += Number(l.cogsGbp ?? 0)
    }
  }
  const topProducts = Array.from(productMap.values())
    .map((p) => ({ ...p, netRevenue: Math.round(p.netRevenue * 100) / 100, marginPct: p.netRevenue > 0 ? Math.round(((p.netRevenue - p.totalCogs) / p.netRevenue) * 1000) / 10 : 0 }))
    .sort((a, b) => b.netRevenue - a.netRevenue)
    .slice(0, 10)

  // ---------------------------------------------------------------------------
  // Incoming POs
  // ---------------------------------------------------------------------------
  const incomingPOs: IncomingPO[] = incomingPOData.map((po) => ({
    id: po.id,
    reference: po.reference,
    supplierName: po.supplier.name,
    totalGbp: Number(po.totalGbp),
    status: po.status,
    expectedDelivery: po.expectedDelivery?.toISOString() ?? null,
    createdAt: po.createdAt.toISOString(),
    lineCount: po.lines.length,
  }))

  // ---------------------------------------------------------------------------
  // Recent orders
  // ---------------------------------------------------------------------------
  const recentOrders: RecentOrder[] = allRecent.map((o) => ({
    id: o.id,
    orderNumber: getSalesOrderReference(o),
    customerName: o.customerName ?? '—',
    totalGbp: Number(o.totalGbp),
    status: o.status,
    createdAt: o.createdAt.toISOString(),
  }))

  // Period labels
  const periodLabels: Record<Period, string> = {
    today: 'Today', this_week: 'This Week', this_month: 'This Month', this_quarter: 'This Quarter',
    this_year: 'This Year', this_fy: 'Financial Year', last_7d: 'Last 7 Days', last_30d: 'Last 30 Days',
    last_90d: 'Last 90 Days', last_365d: 'Last 365 Days',
    custom: `${periodFrom.toLocaleDateString('en-GB')} – ${periodTo.toLocaleDateString('en-GB')}`,
  }
  const compLabels: Record<CompareMode, string> = {
    previous_period: 'Previous Period', previous_year: 'Previous Year', previous_fy: 'Previous FY',
  }

  return { kpi, chartData, topProducts, recentOrders, incomingPOs, periodLabel: periodLabels[period], compLabel: compLabels[compareMode] }
}
