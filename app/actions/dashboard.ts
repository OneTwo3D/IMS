'use server'

import { db } from '@/lib/db'
import { outstandingPoValueBase } from '@/lib/domain/purchasing/outstanding-po-value'
import { INCOMING_PO_STATUSES } from '@/lib/domain/inventory/po-status-sets'
import { getSetting } from '@/app/actions/settings'
import { requirePermission } from '@/lib/auth/server'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { normalizeLineDiscountBase, normalizeOrderDiscountBase } from '@/lib/sales-currency'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatDateTime } from '@/lib/format-datetime'
import { marginFigureBound, netLinearFigureBound, refundLineBucket, unplacedCreditBoundFromParts, type DerivedFigureBound } from '@/lib/domain/sales/refund-basis-analytics'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * o3d-iigc round 5: BEST SELLERS WAS THE SIXTH REFUND-BLIND SURFACE.
 *
 * Rounds 1-4 each declared an enumeration complete and each missed one. Round 4's own note reached
 * this figure and filed it as a NAMING problem — "`netRevenue` never subtracts refunds at all" —
 * which is exactly backwards: a figure called net revenue that has never seen a refund is the same
 * defect as one that subtracted a credit in the wrong unit, only louder. It was published bare, it
 * ranked the list, and the card links straight to the sales-statistics report where the same
 * product's net revenue IS refund-aware, so the two surfaces disagreed by the whole credit.
 *
 * It is now built exactly like that report's rows: refund LINES bucketed by their stamped basis,
 * only the NET bucket subtracted, the other two carried beside the figure, and the figure marked.
 * `qtyRefunded`/`netQty` are EXACT and carry no marker — quantity is basis-independent, so netting
 * it off needs no conversion and refusing it would be this branch's other failure mode.
 */
export type TopProduct = {
  productId: string
  sku: string
  name: string
  /**
   * Ex-VAT line revenue less its discounts less its NET-BASIS credits only. When
   * `refundBasisComplete` is false this is an UPPER BOUND, too high by at most
   * `refundsGrossBasis + refundsUnknownBasis` — and note that the LIST ORDER inherits that, since
   * the ranking is by this figure.
   */
  netRevenue: number
  /** NET-basis refund value, the only kind subtracted from `netRevenue`. */
  refundsNetBasis: number
  /** Refund value recorded on the GROSS basis. Reported, never subtracted from an ex-VAT figure. */
  refundsGrossBasis: number
  /** Refund value whose basis was never proved. Reported, never guessed at. */
  refundsUnknownBasis: number
  /** False when any of this product's credit could not be placed on the net basis. */
  refundBasisComplete: boolean
  /** Which way `netRevenue`'s error runs. `netRevenue - k` for non-negative k, so it is linear. */
  netRevenueBound: DerivedFigureBound
  /** Units sold in the period, BEFORE returns. */
  qtySold: number
  /** Units credited back. Basis-independent, so this is exact whatever the credits' basis. */
  qtyRefunded: number
  /** `qtySold - qtyRefunded`. Exact — never marked. */
  netQty: number
  marginPct: number
  /** Margin is a RATIO: see marginFigureBound. Never derived from `refundBasisComplete`. */
  marginPctBound: DerivedFigureBound
}

export type KpiSummary = {
  // Selected period
  ordersCurrent: number
  grossSalesCurrent: number
  discountsCurrent: number
  /**
   * NET-basis refund value only. o3d-iigc: this used to be every refund's totalBase regardless of
   * basis, subtracted from an ex-VAT sales figure — so a legacy GROSS credit removed its VAT too.
   */
  refundsCurrent: number
  /** Refund value recorded on the GROSS basis. EXCLUDED from netSalesCurrent — it is not net. */
  refundsGrossBasisCurrent: number
  /** Refund value whose basis was never proved. EXCLUDED rather than guessed at. */
  refundsUnknownBasisCurrent: number
  /**
   * False when the period carried refund value that could not be placed on the net basis. The
   * figures that move ONE-FOR-ONE with net sales — netSalesCurrent, profitCurrent, avgOrderValue —
   * are then UPPER BOUNDS, too high by at most refundsGrossBasisCurrent + refundsUnknownBasisCurrent.
   * marginCurrent is a RATIO and is NOT covered by this flag: see marginBoundCurrent.
   */
  refundBasisCompleteCurrent: boolean
  /**
   * o3d-7jfq: WHICH RELATION netSalesCurrent / profitCurrent / avgOrderValue bear to the true
   * figures. The flag above says unplaced credit EXISTS; it cannot say which side of the published
   * number the truth is on, and the cards used to read `≤` straight off it. Where the unsubtracted
   * credit contains a negative entry — two opposite gross credits, say — there is no ceiling, and
   * this is `indeterminate` rather than a claim the arithmetic does not support.
   */
  netSalesBoundCurrent: DerivedFigureBound
  netSalesCurrent: number
  cogsCurrent: number
  profitCurrent: number
  marginCurrent: number
  /**
   * o3d-iigc round 4: which way marginCurrent's error runs, or that it is not established. Marking
   * a ratio `≤` because its denominator is bounded is a claim the arithmetic does not support —
   * marginFigureBound carries the case analysis.
   */
  marginBoundCurrent: DerivedFigureBound
  shippingCurrent: number
  // Comparison period
  ordersComparison: number
  grossSalesComparison: number
  /** As refundBasisCompleteCurrent, for the comparison period. */
  refundBasisCompleteComparison: boolean
  /** As netSalesBoundCurrent, for the comparison period. */
  netSalesBoundComparison: DerivedFigureBound
  netSalesComparison: number
  cogsComparison: number
  marginComparison: number
  /** As marginBoundCurrent, for the comparison period. */
  marginBoundComparison: DerivedFigureBound
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
  /**
   * o3d-iigc: this bucket held refund value that is not on the net basis, so netSales left it out
   * rather than subtracting it in the wrong unit. It says NOTHING about marginPct; that is
   * marginPctBound's job.
   *
   * o3d-7jfq: WAS A BOOLEAN, AND A BOOLEAN COULD ONLY EVER SAY `≤`. A bucket whose unsubtracted
   * credit contains a negative entry has no ceiling — the true netSales may be ABOVE the published
   * one — and `netSalesUpperBound: !refundBasisComplete` printed one anyway. Three-valued now, from
   * the same interval the margin marker beside it is classified from.
   */
  netSalesBound: DerivedFigureBound
  /**
   * o3d-iigc round 4: the bucket's own margin classification. Carried PER BUCKET rather than taken
   * from the period, because a period whose margin is a sound upper bound can contain a day whose
   * margin is indeterminate, and the chart tooltip reads the bucket.
   */
  marginPctBound: DerivedFigureBound
  compNetSales: number
  compCogs: number
  compMarginPct: number
  /** As netSalesBound, for the comparison bucket. */
  compNetSalesBound: DerivedFigureBound
  /** As marginPctBound, for the comparison bucket. */
  compMarginPctBound: DerivedFigureBound
}

export type IncomingPO = {
  id: string
  reference: string
  supplierName: string
  totalBase: number
  status: string
  expectedDelivery: string | null
  createdAt: string
  lineCount: number
}

export type RecentOrder = { id: string; orderNumber: string; customerName: string; totalBase: number; status: string; createdAt: string }

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

// "Completed" sales for dashboard metrics: shipped/completed orders, plus any
// refunded order (refund state is orthogonal to the lifecycle status now).
const COMPLETED_LIFECYCLE_STATUSES: ('SHIPPED' | 'COMPLETED')[] = ['SHIPPED', 'COMPLETED']
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
  await requirePermission('dashboard')
  const tz = await getDisplayTimeZone()
  const fyStartStr = await getSetting('financial_year_start') ?? '04-06'
  const [fyMonth, fyDay] = fyStartStr.split('-').map(Number)

  const now = new Date()
  const [periodFrom, periodTo] = getPeriodRange(period, now, fyMonth, fyDay, customFrom, customTo)
  const [compFrom, compTo] = getComparisonRange(periodFrom, periodTo, compareMode, fyMonth, fyDay)

  // Fetch all data needed — go back far enough to cover comparison range
  const fetchFrom = new Date(Math.min(compFrom.getTime(), periodFrom.getTime(), now.getTime() - 2 * 365 * 86400000))

  const [orders, products, openPOs, pendingSales, , costLayers, incomingPOData, allRecent] = await Promise.all([
    db.salesOrder.findMany({
      where: {
        createdAt: { gte: fetchFrom },
        OR: [
          { status: { in: COMPLETED_LIFECYCLE_STATUSES } },
          { refundStatus: { not: 'NONE' } },
        ],
      },
      select: {
        id: true, externalOrderNumber: true, customerName: true, status: true, createdAt: true,
        totalBase: true, subtotalBase: true, shippingBase: true, discountAmount: true, fxRateToBase: true, pricesIncludeVat: true, taxRatePercent: true,
        shoppingLinks: { select: { connector: true } },
        lines: { select: { cogsBase: true, qty: true, totalBase: true, discountAmount: true, productId: true, sku: true, description: true, taxRate: { select: { rate: true } } } },
        // o3d-iigc round 5: the refund LINES are what Best Sellers needs — the header total says
        // nothing about which product was credited. `totalsBasis` lives on the header and governs
        // its lines (verified in round 2: the basis audit requires header/line reconciliation).
        refunds: { select: { totalsBasis: true, totalBase: true, lines: { select: { productId: true, qty: true, totalBase: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.product.findMany({
      // o3d-iigc round 5: sku/name are read by the Best Sellers list so a product that appears there
      // ONLY through a refund line still has a label. Without them such a row rendered blank.
      select: { id: true, sku: true, name: true, lifecycleStatus: true, stockLevels: { select: { quantity: true, reservedQty: true } } },
    }),
    // Open POs KPI (o3d-1di): the canonical COMMITTED-incoming set (includes SHIPPED, excludes the
    // RFQ_SENT/QUOTE_RECEIVED quote pipeline) so this agrees with the incoming card and the
    // product/replenishment views. Line qty/received drive the outstanding (not whole) value below.
    db.purchaseOrder.findMany({
      where: { type: 'GOODS', status: { in: INCOMING_PO_STATUSES } },
      select: {
        subtotalBase: true,
        lines: { select: { qty: true, qtyReceived: true, unitCostBase: true } },
      },
    }),
    db.salesOrder.findMany({
      where: { status: { in: ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] } },
      select: { totalBase: true },
    }),
    db.salesOrderRefund.findMany({
      where: { refundedAt: { gte: periodFrom, lte: periodTo } },
      select: { totalBase: true },
    }),
    db.costLayer.findMany({
      where: { remainingQty: { gt: 0 } },
      select: { remainingQty: true, unitCostBase: true },
    }),
    // Next 5 incoming purchase orders (o3d-s8n.8: use the canonical incoming set so a SHIPPED PO does
    // not vanish from this card while still counting as Incoming on the product/replenishment views).
    db.purchaseOrder.findMany({
      where: { type: 'GOODS', status: { in: INCOMING_PO_STATUSES } },
      select: {
        id: true, reference: true, status: true, totalBase: true, expectedDelivery: true, createdAt: true,
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
      select: { id: true, orderNumber: true, externalOrderNumber: true, customerName: true, totalBase: true, status: true, createdAt: true },
    }),
  ])

  const inventoryValue = costLayers.reduce((s, cl) => s + Number(cl.remainingQty) * Number(cl.unitCostBase), 0)

  // Period helpers
  function ordersInRange(from: Date, to: Date) { return orders.filter((o) => o.createdAt >= from && o.createdAt <= to) }

  type OrderAgg = {
    gross: number; discounts: number; refunds: number
    refundsGrossBasis: number; refundsUnknownBasis: number; refundBasisComplete: boolean
    /**
     * o3d-7jfq: `Σ max(entry, 0)` for the two buckets a NET figure cannot place. The signed totals
     * beside them cancel — +120 and −120 of gross-basis credit make a bucket of zero, and zero is
     * not negative, so every classifier fed that sum answered `upper` about a figure that can move
     * 120 either way. The positive part is recorded AT THE ENTRY, in the loop below, because that
     * is the last place an individual credit exists.
     */
    refundsGrossBasisPositive: number; refundsUnknownBasisPositive: number
    net: number; cogs: number; shipping: number
  }
  function aggregate(list: typeof orders): OrderAgg {
    let gross = 0, discounts = 0, refunds = 0, cogs = 0, shipping = 0
    let refundsGrossBasis = 0, refundsUnknownBasis = 0, refundBasisComplete = true
    let refundsGrossBasisPositive = 0, refundsUnknownBasisPositive = 0
    for (const o of list) {
      const lineTotal = o.lines.reduce((s, l) => s + Number(l.totalBase), 0)
      const lineDisc = o.lines.reduce((sum, line) => sum + normalizeLineDiscountBase(o, line.discountAmount, line.taxRate?.rate), 0)
      const orderDisc = normalizeOrderDiscountBase(o, o.lines)
      gross += lineTotal + lineDisc + orderDisc
      discounts += lineDisc + orderDisc
      // o3d-iigc: `gross` and `discounts` above are built from ex-VAT line totals, so `net` is a NET
      // figure and only a NET-basis refund is the same unit. A GROSS credit over-subtracts by its
      // whole VAT and an unstamped one cannot be placed at all; both are counted separately and left
      // OUT of `net`, which is then flagged as an upper bound rather than quietly wrong.
      for (const r of o.refunds) {
        const amount = Number(r.totalBase)
        const placement = refundLineBucket(r.totalsBasis, r.totalBase)
        const positive = Math.max(amount, 0)
        if (placement.bucket === 'net') refunds += amount
        else if (placement.bucket === 'gross') { refundsGrossBasis += amount; refundsGrossBasisPositive += positive }
        else { refundsUnknownBasis += amount; refundsUnknownBasisPositive += positive }
        if (!placement.placeableOnNetBasis) refundBasisComplete = false
      }
      cogs += o.lines.reduce((s, l) => s + Number(l.cogsBase ?? 0), 0)
      shipping += Number(o.shippingBase ?? 0)
    }
    const net = gross - discounts - refunds
    return { gross, discounts, refunds, refundsGrossBasis, refundsUnknownBasis, refundBasisComplete, refundsGrossBasisPositive, refundsUnknownBasisPositive, net, cogs, shipping }
  }

  /** The unplaced-credit interval an aggregate leaves behind, as the classifiers' one input. */
  const unplacedOf = (agg: OrderAgg) => unplacedCreditBoundFromParts([
    { total: agg.refundsGrossBasis, positive: agg.refundsGrossBasisPositive },
    { total: agg.refundsUnknownBasis, positive: agg.refundsUnknownBasisPositive },
  ])

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
    refundsGrossBasisCurrent: r2(cur.refundsGrossBasis),
    refundsUnknownBasisCurrent: r2(cur.refundsUnknownBasis),
    refundBasisCompleteCurrent: cur.refundBasisComplete,
    netSalesBoundCurrent: netLinearFigureBound({ basisComplete: cur.refundBasisComplete, unplacedCredit: unplacedOf(cur) }),
    netSalesCurrent: r2(cur.net),
    cogsCurrent: r2(cur.cogs),
    profitCurrent: r2(cur.net - cur.cogs),
    marginCurrent: cur.net > 0 ? Math.round(((cur.net - cur.cogs) / cur.net) * 1000) / 10 : 0,
    marginBoundCurrent: marginFigureBound({
      netRevenue: cur.net, cogs: cur.cogs,
      unplacedCredit: unplacedOf(cur),
      basisComplete: cur.refundBasisComplete,
    }),
    shippingCurrent: r2(cur.shipping),
    ordersComparison: compOrders.length,
    grossSalesComparison: r2(comp.gross),
    refundBasisCompleteComparison: comp.refundBasisComplete,
    netSalesBoundComparison: netLinearFigureBound({ basisComplete: comp.refundBasisComplete, unplacedCredit: unplacedOf(comp) }),
    netSalesComparison: r2(comp.net),
    cogsComparison: r2(comp.cogs),
    marginComparison: comp.net > 0 ? Math.round(((comp.net - comp.cogs) / comp.net) * 1000) / 10 : 0,
    marginBoundComparison: marginFigureBound({
      netRevenue: comp.net, cogs: comp.cogs,
      unplacedCredit: unplacedOf(comp),
      basisComplete: comp.refundBasisComplete,
    }),
    totalProducts: products.length,
    activeProducts: products.filter((p) => p.lifecycleStatus === 'ACTIVE').length,
    inventoryValue: r2(inventoryValue),
    openPurchaseOrders: openPOs.length,
    openPOValue: r2(outstandingPoValueBase(openPOs)),
    pendingSalesOrders: pendingSales.length,
    pendingSalesValue: r2(pendingSales.reduce((s, so) => s + Number(so.totalBase), 0)),
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
      netSalesBound: netLinearFigureBound({ basisComplete: c.refundBasisComplete, unplacedCredit: unplacedOf(c) }),
      marginPctBound: marginFigureBound({
        netRevenue: c.net, cogs: c.cogs,
        unplacedCredit: unplacedOf(c),
        basisComplete: c.refundBasisComplete,
      }),
      compNetSales: r2(p.net), compCogs: r2(p.cogs),
      compMarginPct: p.net > 0 ? Math.round(((p.net - p.cogs) / p.net) * 1000) / 10 : 0,
      compNetSalesBound: netLinearFigureBound({ basisComplete: p.refundBasisComplete, unplacedCredit: unplacedOf(p) }),
      compMarginPctBound: marginFigureBound({
        netRevenue: p.net, cogs: p.cogs,
        unplacedCredit: unplacedOf(p),
        basisComplete: p.refundBasisComplete,
      }),
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
  /**
   * What the accumulation needs and the published row does not carry.
   *
   * `totalCogs` is the margin's numerator offset; the two `*Positive` fields are `Σ max(entry, 0)`
   * for the buckets a NET figure cannot place — the interval's other endpoint, recorded at the
   * entry because the published bucket columns are signed sums that have already cancelled
   * (o3d-7jfq). They stay OFF `TopProduct`: what a consumer needs is the verdict, and the verdict
   * is `netRevenueBound`.
   */
  type TopProductWorking = { totalCogs: number; refundsGrossBasisPositive: number; refundsUnknownBasisPositive: number }
  const productMap = new Map<string, TopProduct & TopProductWorking>()
  const productLabels = new Map(products.map((p) => [p.id, p]))
  function topProductRow(productId: string, sku: string, name: string): TopProduct & TopProductWorking {
    const existing = productMap.get(productId)
    // A row created by a refund line before its sales line was seen (or with no sales line at all)
    // starts unlabelled; fill the label in the moment one becomes available rather than leaving the
    // blank row the first writer happened to create.
    if (existing) {
      if (!existing.sku && sku) existing.sku = sku
      if (!existing.name && name) existing.name = name
      return existing
    }
    const info = productLabels.get(productId)
    const created: TopProduct & TopProductWorking = {
      productId, sku: sku || info?.sku || '', name: name || info?.name || '',
      netRevenue: 0, refundsNetBasis: 0, refundsGrossBasis: 0, refundsUnknownBasis: 0,
      refundBasisComplete: true, netRevenueBound: 'exact',
      qtySold: 0, qtyRefunded: 0, netQty: 0, marginPct: 0, marginPctBound: 'exact', totalCogs: 0,
      refundsGrossBasisPositive: 0, refundsUnknownBasisPositive: 0,
    }
    productMap.set(productId, created)
    return created
  }
  for (const o of currentOrders) {
    for (const l of o.lines) {
      if (!l.productId) continue
      const row = topProductRow(l.productId, l.sku ?? '', l.description)
      row.netRevenue += Number(l.totalBase)
      row.qtySold += Number(l.qty)
      row.totalCogs += Number(l.cogsBase ?? 0)
    }
    // o3d-iigc round 5. `netRevenue` above is a sum of ex-VAT line totals, so only a NET-basis
    // credit is the same unit. A GROSS one carries its whole VAT; an unstamped one cannot be placed
    // at all. Neither is converted — on a mixed-rate order the rate that produced the gross figure
    // is not recoverable — so both are bucketed beside the figure and the row is flagged.
    //
    // A refund line for a product with NO sales line in this period creates its own row rather than
    // being dropped: dropping it would silently restore the blindness for exactly the product whose
    // whole period was credited back, and a product that is all returns is precisely what a
    // best-sellers list must not rank on gross sales alone.
    for (const refund of o.refunds) {
      for (const rl of refund.lines) {
        if (!rl.productId) continue
        const row = topProductRow(rl.productId, '', '')
        row.qtyRefunded += Number(rl.qty)
        const amount = Number(rl.totalBase)
        const placement = refundLineBucket(refund.totalsBasis, rl.totalBase)
        const positive = Math.max(amount, 0)
        if (placement.bucket === 'net') { row.refundsNetBasis += amount; row.netRevenue -= amount }
        else if (placement.bucket === 'gross') { row.refundsGrossBasis += amount; row.refundsGrossBasisPositive += positive }
        else { row.refundsUnknownBasis += amount; row.refundsUnknownBasisPositive += positive }
        if (!placement.placeableOnNetBasis) row.refundBasisComplete = false
      }
    }
  }
  const topProducts = Array.from(productMap.values())
    .map((p) => ({
      ...p,
      // Classified from the UNROUNDED figures: the classification is about which side of the
      // published number the truth lies on, not about its last penny. o3d-7jfq: and from the
      // INTERVAL, not from `refundsGrossBasis + refundsUnknownBasis` — a product credited +120 on
      // the gross basis and −120 on it again summed to zero, and a `≤` came out of a figure that
      // may be 120 above the published one. The list is RANKED on that figure, so the false claim
      // reached the ordering too.
      netRevenueBound: netLinearFigureBound({
        basisComplete: p.refundBasisComplete,
        unplacedCredit: unplacedCreditBoundFromParts([
          { total: p.refundsGrossBasis, positive: p.refundsGrossBasisPositive },
          { total: p.refundsUnknownBasis, positive: p.refundsUnknownBasisPositive },
        ]),
      }),
      marginPctBound: marginFigureBound({
        netRevenue: p.netRevenue, cogs: p.totalCogs,
        unplacedCredit: unplacedCreditBoundFromParts([
          { total: p.refundsGrossBasis, positive: p.refundsGrossBasisPositive },
          { total: p.refundsUnknownBasis, positive: p.refundsUnknownBasisPositive },
        ]),
        basisComplete: p.refundBasisComplete,
      }),
      netQty: Math.round((p.qtySold - p.qtyRefunded) * 1000) / 1000,
      netRevenue: r2(p.netRevenue),
      refundsNetBasis: r2(p.refundsNetBasis),
      refundsGrossBasis: r2(p.refundsGrossBasis),
      refundsUnknownBasis: r2(p.refundsUnknownBasis),
      marginPct: p.netRevenue > 0 ? Math.round(((p.netRevenue - p.totalCogs) / p.netRevenue) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.netRevenue - a.netRevenue)
    .slice(0, 10)

  // ---------------------------------------------------------------------------
  // Incoming POs
  // ---------------------------------------------------------------------------
  const incomingPOs: IncomingPO[] = incomingPOData.map((po) => ({
    id: po.id,
    reference: po.reference,
    supplierName: po.supplier.name,
    totalBase: Number(po.totalBase),
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
    totalBase: Number(o.totalBase),
    status: o.status,
    createdAt: o.createdAt.toISOString(),
  }))

  // Period labels
  const periodLabels: Record<Period, string> = {
    today: 'Today', this_week: 'This Week', this_month: 'This Month', this_quarter: 'This Quarter',
    this_year: 'This Year', this_fy: 'Financial Year', last_7d: 'Last 7 Days', last_30d: 'Last 30 Days',
    last_90d: 'Last 90 Days', last_365d: 'Last 365 Days',
    custom: `${formatDateTime(periodFrom, { dateStyle: 'short' }, tz)} – ${formatDateTime(periodTo, { dateStyle: 'short' }, tz)}`,
  }
  const compLabels: Record<CompareMode, string> = {
    previous_period: 'Previous Period', previous_year: 'Previous Year', previous_fy: 'Previous FY',
  }

  return { kpi, chartData, topProducts, recentOrders, incomingPOs, periodLabel: periodLabels[period], compLabel: compLabels[compareMode] }
}
