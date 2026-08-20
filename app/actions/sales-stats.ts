'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { allocateOrderDiscountBase, normalizeLineDiscountBase } from '@/lib/sales-currency'
import { marginFigureBound, netOfRefunds, refundLineBucket, refundPctOfSale, refundTotalsBasis, type DerivedFigureBound, type RefundSetBasis, type RefundTotalsBasis } from '@/lib/domain/sales/refund-basis-analytics'

// ---------------------------------------------------------------------------
// Products tab (line-level)
// ---------------------------------------------------------------------------

export type SalesStatRow = {
  productId: string
  sku: string
  name: string
  type: string
  stockUnit: string
  barcode: string | null
  mpn: string | null
  lifecycleStatus: ProductLifecycleStatus
  currentStock: number
  reservedQty: number
  availableStock: number
  customerName: string | null
  salesRep: string | null
  qtySold: number
  qtyRefunded: number
  netQty: number
  grossRevenue: number
  /**
   * NET-basis refund value only. o3d-iigc: `grossRevenue`/`netRevenue` are built from ex-VAT line
   * totals, so a GROSS or unstamped credit is not the same unit and is bucketed below instead.
   */
  refunds: number
  discounts: number
  /** Refund value recorded on the GROSS basis — reported, NOT subtracted from `netRevenue`. */
  refundsGrossBasis: number
  /** Refund value with no proven basis — reported, NOT subtracted from `netRevenue`. */
  refundsUnknownBasis: number
  /**
   * False when this product carried refund value that could not be placed on the net basis. When
   * false, `netRevenue`, `grossProfit` and `avgOrderValue` are UPPER BOUNDS, loose by at most
   * refundsGrossBasis + refundsUnknownBasis. `marginPct` is NOT covered by this flag — see
   * `marginPctBound`.
   */
  refundBasisComplete: boolean
  netRevenue: number
  cogs: number
  grossProfit: number
  marginPct: number
  /**
   * o3d-iigc round 4: margin is a RATIO, and an unsubtracted credit moves its numerator and its
   * denominator together, so `refundBasisComplete === false` does NOT make it an upper bound the way
   * it does the three figures above. Classified by marginFigureBound; 'indeterminate' means the
   * figure stands but the direction of its error does not. Never marked from refundBasisComplete.
   */
  marginPctBound: DerivedFigureBound
  orderCount: number
  avgOrderValue: number
  salesPrice: number | null
  weight: number | null
}

export type SalesStatSummary = {
  totalOrders: number
  totalGrossRevenue: number
  totalDiscounts: number
  /** NET-basis refunds only — see SalesStatRow.refunds. */
  totalRefunds: number
  totalRefundsGrossBasis: number
  totalRefundsUnknownBasis: number
  /**
   * False when ANY row's refunds could not all be placed on the net basis. Governs totalNetRevenue,
   * totalGrossProfit and avgOrderValue. NOT avgMarginPct — see avgMarginPctBound.
   */
  refundBasisComplete: boolean
  totalNetRevenue: number
  totalCogs: number
  totalGrossProfit: number
  avgMarginPct: number
  /** As SalesStatRow.marginPctBound, for the whole-period Avg Margin figure. */
  avgMarginPctBound: DerivedFigureBound
  avgOrderValue: number
  totalQtySold: number
}

export async function getProductSalesStats(dateFrom?: string, dateTo?: string): Promise<{ rows: SalesStatRow[]; summary: SalesStatSummary }> {
  await requirePermission('analytics')
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')
  const hasDateFilter = Object.keys(dateFilter).length > 0

  const orders = await db.salesOrder.findMany({
    where: {
      // Shipped/completed sales plus any refunded order (refund state is orthogonal now).
      OR: [
        { status: { in: ['SHIPPED', 'COMPLETED'] } },
        { refundStatus: { not: 'NONE' } },
      ],
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    select: {
      id: true, totalBase: true, discountAmount: true, fxRateToBase: true, pricesIncludeVat: true, taxRatePercent: true, customerName: true, salesRep: true,
      shoppingLinks: { select: { connector: true } },
      lines: { select: { productId: true, sku: true, description: true, qty: true, totalBase: true, discountAmount: true, cogsBase: true, taxRate: { select: { rate: true } } } },
      // o3d-iigc: the basis was not even fetched before, so the report could not have respected it.
      refunds: { select: { totalsBasis: true, lines: { select: { productId: true, qty: true, totalBase: true } } } },
    },
  })

  const products = await db.product.findMany({
    select: { id: true, sku: true, name: true, type: true, stockUnit: true, barcode: true, mpn: true, weight: true, salesPriceBase: true, lifecycleStatus: true,
      stockLevels: { select: { quantity: true, reservedQty: true } } },
  })
  const productInfo = new Map(products.map((p) => [p.id, p]))
  const productMap = new Map<string, SalesStatRow>()

  for (const order of orders) {
    const orderDiscountAllocations = allocateOrderDiscountBase(order, order.lines)
    for (const [lineIndex, line] of order.lines.entries()) {
      if (!line.productId) continue
      const pid = line.productId; const info = productInfo.get(pid)
      if (!productMap.has(pid)) {
        productMap.set(pid, {
          productId: pid, sku: info?.sku ?? line.sku ?? '', name: info?.name ?? line.description,
          type: info?.type ?? 'SIMPLE', stockUnit: info?.stockUnit ?? 'pcs', barcode: info?.barcode ?? null,
          mpn: info?.mpn ?? null,
          lifecycleStatus: info?.lifecycleStatus ?? 'ACTIVE',
          currentStock: info?.stockLevels.reduce((s, sl) => s + Number(sl.quantity), 0) ?? 0,
          reservedQty: info?.stockLevels.reduce((s, sl) => s + Number(sl.reservedQty), 0) ?? 0,
          availableStock: info ? info.stockLevels.reduce((s, sl) => s + Number(sl.quantity) - Number(sl.reservedQty), 0) : 0,
          customerName: order.customerName, salesRep: order.salesRep,
          salesPrice: info?.salesPriceBase ? Number(info.salesPriceBase) : null,
          weight: info?.weight ? Number(info.weight) : null,
          qtySold: 0, qtyRefunded: 0, netQty: 0, grossRevenue: 0, discounts: 0, refunds: 0,
          refundsGrossBasis: 0, refundsUnknownBasis: 0, refundBasisComplete: true,
          netRevenue: 0, cogs: 0, grossProfit: 0, marginPct: 0, marginPctBound: 'exact', orderCount: 0, avgOrderValue: 0,
        })
      }
      const row = productMap.get(pid)!
      const lineDiscountBase = normalizeLineDiscountBase(order, line.discountAmount, line.taxRate?.rate)
      row.qtySold += Number(line.qty)
      row.grossRevenue += Number(line.totalBase) + lineDiscountBase
      row.discounts += lineDiscountBase
      const allocatedOrderDiscount = orderDiscountAllocations[lineIndex] ?? 0
      row.grossRevenue += allocatedOrderDiscount
      row.discounts += allocatedOrderDiscount
      row.cogs += Number(line.cogsBase ?? 0)
      row.orderCount++
    }
    // o3d-iigc: `grossRevenue` above is built from ex-VAT line totals, so `netRevenue` is a NET
    // figure and only a NET-basis refund is the same unit. A GROSS credit carries its whole VAT and
    // would over-subtract; an unstamped one cannot be placed at all. Neither is CONVERTED — on a
    // mixed-rate order the rate that produced the gross figure is not recoverable — so both are
    // bucketed beside the figure and the row is flagged, which makes `netRevenue` an upper bound
    // rather than a number wrong in an undisclosed direction. Quantity is basis-independent, so
    // qtyRefunded keeps netting off EVERY refund line.
    for (const refund of order.refunds) {
      for (const rl of refund.lines) {
        if (!rl.productId) continue
        const row = productMap.get(rl.productId)
        if (!row) continue
        row.qtyRefunded += Number(rl.qty)
        const amount = Number(rl.totalBase)
        const placement = refundLineBucket(refund.totalsBasis, rl.totalBase)
        if (placement.bucket === 'net') row.refunds += amount
        else if (placement.bucket === 'gross') row.refundsGrossBasis += amount
        else row.refundsUnknownBasis += amount
        if (!placement.placeableOnNetBasis) row.refundBasisComplete = false
      }
    }
  }

  const rows: SalesStatRow[] = []
  /**
   * o3d-iigc round 5 (Codex finding 2): THE PERIOD TOTALS ARE ACCUMULATED BEFORE THE ROWS ARE
   * ROUNDED, and the period margin and its bound are both computed from these.
   *
   * They used to be re-summed from the ROUNDED row fields, which put the published summary margin
   * and marginFigureBound's model of it on different numbers — and the helper's whole case analysis
   * is about which side of the published figure the truth lies on. Worked, on one product with
   * 0.016 of revenue, 0.025 of COGS and 0.014 of UNKNOWN-basis credit: rounding each row field
   * first gives revenue 0.02, COGS 0.03, unplaced credit 0.01, so the summary published -50% and
   * case 3 (0.02 - 0.01 > 0) marked it `≤`. Place that credit on the net basis and revenue is 0.002,
   * which rounds to 0.00, so the report's own `> 0` guard publishes 0% — AND 0% IS NOT AT MOST -50%.
   * The `≤` was a false claim produced entirely by rounding twice.
   *
   * Summing unrounded and rounding once is also simply the module's stated rule ("rounding happens
   * once, in the caller-facing figure, never on the intermediate sums").
   */
  const period = {
    grossRevenue: 0, discounts: 0, refunds: 0, refundsGrossBasis: 0, refundsUnknownBasis: 0,
    netRevenue: 0, cogs: 0, grossProfit: 0, netQty: 0, refundBasisComplete: true,
  }
  for (const row of productMap.values()) {
    row.netQty = row.qtySold - row.qtyRefunded
    row.netRevenue = row.grossRevenue - row.discounts - row.refunds
    row.grossProfit = row.netRevenue - row.cogs
    row.marginPct = row.netRevenue > 0 ? (row.grossProfit / row.netRevenue) * 100 : 0
    row.avgOrderValue = row.orderCount > 0 ? row.netRevenue / row.orderCount : 0
    // Classified from the UNROUNDED figures, before the roundings below, because the classification
    // is about which side of the published number the truth lies on, not about its last penny.
    row.marginPctBound = marginFigureBound({
      netRevenue: row.netRevenue,
      cogs: row.cogs,
      unplacedCredit: row.refundsGrossBasis + row.refundsUnknownBasis,
      basisComplete: row.refundBasisComplete,
    })
    period.grossRevenue += row.grossRevenue; period.discounts += row.discounts
    period.refunds += row.refunds; period.refundsGrossBasis += row.refundsGrossBasis
    period.refundsUnknownBasis += row.refundsUnknownBasis
    period.netRevenue += row.netRevenue; period.cogs += row.cogs; period.grossProfit += row.grossProfit
    period.netQty += row.netQty
    if (!row.refundBasisComplete) period.refundBasisComplete = false
    row.grossRevenue = Math.round(row.grossRevenue * 100) / 100; row.discounts = Math.round(row.discounts * 100) / 100
    row.refunds = Math.round(row.refunds * 100) / 100; row.netRevenue = Math.round(row.netRevenue * 100) / 100
    row.refundsGrossBasis = Math.round(row.refundsGrossBasis * 100) / 100
    row.refundsUnknownBasis = Math.round(row.refundsUnknownBasis * 100) / 100
    row.cogs = Math.round(row.cogs * 100) / 100; row.grossProfit = Math.round(row.grossProfit * 100) / 100
    row.marginPct = Math.round(row.marginPct * 10) / 10; row.avgOrderValue = Math.round(row.avgOrderValue * 100) / 100
    rows.push(row)
  }
  rows.sort((a, b) => b.netRevenue - a.netRevenue)

  const m2 = (v: number) => Math.round(v * 100) / 100
  const summary: SalesStatSummary = {
    totalOrders: orders.length, totalGrossRevenue: m2(period.grossRevenue),
    totalDiscounts: m2(period.discounts), totalRefunds: m2(period.refunds),
    totalRefundsGrossBasis: m2(period.refundsGrossBasis),
    totalRefundsUnknownBasis: m2(period.refundsUnknownBasis),
    refundBasisComplete: period.refundBasisComplete,
    totalNetRevenue: m2(period.netRevenue), totalCogs: m2(period.cogs),
    totalGrossProfit: m2(period.grossProfit), avgMarginPct: 0, avgMarginPctBound: 'exact', avgOrderValue: 0,
    // Quantity is left unrounded exactly as it was: it may carry fractional units, and rounding it
    // to two places here would be a change this finding did not call for.
    totalQtySold: period.netQty,
  }
  // From the UNROUNDED period figures, so the published ratio and the counterfactual the bound is
  // classified against are the same function of the same quantities.
  summary.avgMarginPct = period.netRevenue > 0 ? Math.round((period.grossProfit / period.netRevenue) * 1000) / 10 : 0
  // The whole-period margin is the same ratio over the same two quantities, so it is classified the
  // same way — from the period's own COGS and its own unplaced credit, NOT by OR-ing the rows'
  // verdicts: a row whose margin is indeterminate can sit inside a period whose margin is a sound
  // upper bound, and the reverse.
  summary.avgMarginPctBound = marginFigureBound({
    netRevenue: period.netRevenue,
    cogs: period.cogs,
    unplacedCredit: period.refundsGrossBasis + period.refundsUnknownBasis,
    basisComplete: period.refundBasisComplete,
  })
  summary.avgOrderValue = summary.totalOrders > 0 ? Math.round((period.netRevenue / summary.totalOrders) * 100) / 100 : 0
  return { rows, summary }
}

// ---------------------------------------------------------------------------
// Shipments (line-level)
// ---------------------------------------------------------------------------

export type ShipmentRow = {
  orderId: string
  orderNumber: string
  shipmentNumber: string | null
  sku: string
  productName: string
  productId: string | null
  barcode: string | null
  mpn: string | null
  customerName: string
  salesRep: string | null
  shippedAt: string
  shippingService: string | null
  trackingNumber: string | null
  warehouse: string | null
  qty: number
  totalBase: number
}

export async function getShipments(dateFrom?: string, dateTo?: string): Promise<ShipmentRow[]> {
  await requirePermission('analytics')
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const orders = await db.salesOrder.findMany({
    where: { shippedAt: { not: null, ...(Object.keys(dateFilter).length ? dateFilter : {}) } },
    select: {
      id: true, orderNumber: true, externalOrderNumber: true, customerName: true, salesRep: true, shippedAt: true,
      trackingNumber: true, shippingService: true, shipFromWarehouse: { select: { code: true } },
      lines: { select: { productId: true, sku: true, description: true, qty: true, totalBase: true, product: { select: { barcode: true, mpn: true } } } },
    },
    orderBy: { shippedAt: 'desc' },
  })

  const rows: ShipmentRow[] = []
  for (const o of orders) {
    for (const l of o.lines) {
      rows.push({
        orderId: o.id, orderNumber: getSalesOrderReference(o),
        shipmentNumber: o.trackingNumber, sku: l.sku ?? '', productName: l.description,
        productId: l.productId, barcode: l.product?.barcode ?? null, mpn: l.product?.mpn ?? null,
        customerName: o.customerName ?? '—', salesRep: o.salesRep,
        shippedAt: o.shippedAt!.toISOString(), shippingService: o.shippingService,
        trackingNumber: o.trackingNumber, warehouse: o.shipFromWarehouse?.code ?? null,
        qty: Number(l.qty), totalBase: Number(l.totalBase),
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Details (line-level order details)
// ---------------------------------------------------------------------------

export type DetailRow = {
  orderId: string
  orderNumber: string
  productId: string | null
  sku: string
  productName: string
  barcode: string | null
  mpn: string | null
  type: string | null
  customerName: string
  customerEmail: string | null
  salesRep: string | null
  status: string
  qty: number
  totalBase: number
  createdAt: string
}

export async function getDetails(dateFrom?: string, dateTo?: string): Promise<DetailRow[]> {
  await requirePermission('analytics')
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const orders = await db.salesOrder.findMany({
    where: Object.keys(dateFilter).length ? { createdAt: dateFilter } : undefined,
    select: {
      id: true, orderNumber: true, externalOrderNumber: true, status: true, customerName: true, customerEmail: true, salesRep: true, createdAt: true,
      lines: { select: { productId: true, sku: true, description: true, qty: true, totalBase: true, product: { select: { barcode: true, mpn: true, type: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const rows: DetailRow[] = []
  for (const o of orders) {
    for (const l of o.lines) {
      rows.push({
        orderId: o.id, orderNumber: getSalesOrderReference(o),
        productId: l.productId, sku: l.sku ?? '', productName: l.description,
        barcode: l.product?.barcode ?? null, mpn: l.product?.mpn ?? null, type: l.product?.type ?? null,
        customerName: o.customerName ?? '—', customerEmail: o.customerEmail,
        salesRep: o.salesRep, status: o.status,
        qty: Number(l.qty), totalBase: Number(l.totalBase), createdAt: o.createdAt.toISOString(),
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Invoices (line-level)
// ---------------------------------------------------------------------------

export type InvoiceRow = {
  orderId: string
  orderNumber: string
  invoiceNumber: string
  productId: string | null
  sku: string
  productName: string
  customerName: string
  salesRep: string | null
  invoicedAt: string
  status: string
  qty: number
  totalBase: number
  paidAt: string | null
  balance: number
}

export async function getInvoiceStats(dateFrom?: string, dateTo?: string): Promise<InvoiceRow[]> {
  await requirePermission('analytics')
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const orders = await db.salesOrder.findMany({
    where: { invoiceNumber: { not: null }, ...(Object.keys(dateFilter).length ? { invoicedAt: dateFilter } : {}) },
    select: {
      id: true, orderNumber: true, externalOrderNumber: true, invoiceNumber: true, customerName: true, salesRep: true,
      invoicedAt: true, status: true, totalBase: true, paidAt: true,
      lines: { select: { productId: true, sku: true, description: true, qty: true, totalBase: true } },
      payments: { where: { refundId: null }, select: { amount: true } },
    },
    orderBy: { invoicedAt: 'desc' },
  })

  const rows: InvoiceRow[] = []
  for (const o of orders) {
    const paid = o.payments.reduce((s, p) => s + Number(p.amount), 0)
    const balance = Math.round((Number(o.totalBase) - paid) * 100) / 100
    for (const l of o.lines) {
      rows.push({
        orderId: o.id, orderNumber: getSalesOrderReference(o),
        invoiceNumber: o.invoiceNumber!, productId: l.productId, sku: l.sku ?? '',
        productName: l.description, customerName: o.customerName ?? '—', salesRep: o.salesRep,
        invoicedAt: o.invoicedAt!.toISOString(), status: o.status,
        qty: Number(l.qty), totalBase: Number(l.totalBase),
        paidAt: o.paidAt?.toISOString() ?? null, balance,
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Refunds (line-level)
// ---------------------------------------------------------------------------

export type RefundRow = {
  id: string
  orderId: string
  orderNumber: string
  creditNoteNumber: string | null
  productId: string | null
  sku: string
  productName: string
  customerName: string
  salesRep: string | null
  reason: string | null
  refundedAt: string
  qty: number
  totalBase: number
  /**
   * What this credit's stored totals MEAN — NET (ex-VAT), GROSS (VAT-inclusive), or UNKNOWN for a
   * row that was never stamped (o3d-lvk).
   *
   * It exists because `pctOfSale` below is withheld on an unproven basis, and a withheld figure
   * with no stated cause is just a gap. In the UI the cause is a tooltip; in the CSV there are no
   * tooltips at all — the same reason o3d-iigc round 3 renamed `netAmount` to `netAmountExVat` —
   * so the basis travels as its own column and the blank is legible in a spreadsheet too.
   */
  totalsBasis: RefundTotalsBasis
  /**
   * The credit as a proportion of the order total ON THE CREDIT'S OWN BASIS.
   *
   * o3d-iigc: `null` when the refund's basis is unproven, or when no comparable order total exists.
   * It is NOT 0 — a zero here would read as "refunded nothing", which is the opposite of "we cannot
   * say what fraction this is".
   */
  pctOfSale: number | null
}

export async function getRefundStats(dateFrom?: string, dateTo?: string): Promise<RefundRow[]> {
  await requirePermission('analytics')
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const refunds = await db.salesOrderRefund.findMany({
    where: Object.keys(dateFilter).length ? { refundedAt: dateFilter } : undefined,
    select: {
      id: true, creditNoteNumber: true, reason: true, totalBase: true, refundedAt: true, totalsBasis: true,
      // taxBase is what makes the order's NET total derivable, so a NET credit can be measured
      // against a NET total instead of against the VAT-inclusive one.
      order: { select: { id: true, orderNumber: true, externalOrderNumber: true, customerName: true, salesRep: true, totalBase: true, taxBase: true } },
      lines: { select: { id: true, productId: true, description: true, qty: true, totalBase: true } },
    },
    orderBy: { refundedAt: 'desc' },
  })

  const rows: RefundRow[] = []
  for (const r of refunds) {
    for (const l of r.lines) {
      const lineTotal = Number(l.totalBase)
      rows.push({
        id: l.id, orderId: r.order.id, orderNumber: getSalesOrderReference(r.order),
        creditNoteNumber: r.creditNoteNumber, productId: l.productId,
        sku: '', productName: l.description,
        customerName: r.order.customerName ?? '—', salesRep: r.order.salesRep,
        reason: r.reason, refundedAt: r.refundedAt.toISOString(),
        qty: Number(l.qty), totalBase: lineTotal,
        // o3d-lvk: the same classifier `pctOfSale` consults, so the stated basis and the decision to
        // withhold the proportion can never disagree about the same row.
        totalsBasis: refundTotalsBasis(r.totalsBasis),
        // o3d-iigc: divided by the order total on the CREDIT'S basis. Against the GROSS total a
        // full NET refund of a 20%-taxable order read as 83.3% — a full credit shown as partial.
        pctOfSale: refundPctOfSale(l.totalBase, r.order, r.totalsBasis),
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Customer Aging (order-level with aging buckets)
// ---------------------------------------------------------------------------

export type CustomerAgingRow = {
  orderId: string
  orderNumber: string
  customerId: string
  customerName: string
  salesRep: string | null
  warehouse: string | null
  createdAt: string
  currency: string
  /** The order's GROSS (VAT-inclusive) invoice total. */
  salesTotal: number
  /** Total credit raised against the order, whatever basis each credit carries. */
  refundsTotal: number
  /**
   * The order total less its refunds, expressed on `netTotalBasis`.
   *
   * o3d-iigc: `null` when the credits are not all on one proven basis. Subtracting a NET credit
   * from the GROSS invoice total understated the credit by its VAT; subtracting a mixed set is not
   * a subtraction at all. Neither is converted — the rate behind a legacy gross total is not
   * recoverable on a mixed-rate order — so the figure is withheld rather than guessed.
   */
  netTotal: number | null
  /**
   * Which total `netTotal` is: `NONE` (no credits — the gross invoice total), `GROSS`
   * (VAT-inclusive), `NET` (ex-VAT), or `UNKNOWN` (netTotal is null).
   */
  netTotalBasis: RefundSetBasis
  dueAmount: number
  avgDso: number
  overdue0_30: number
  overdue31_60: number
  overdue61_90: number
  overdue91plus: number
}

export async function getCustomerAging(): Promise<CustomerAgingRow[]> {
  await requirePermission('analytics')
  const orders = await db.salesOrder.findMany({
    where: { invoiceNumber: { not: null } },
    select: {
      id: true, orderNumber: true, externalOrderNumber: true, customerId: true, customerName: true, salesRep: true,
      currency: true, totalBase: true, taxBase: true, invoicedAt: true, paidAt: true, createdAt: true,
      shipFromWarehouse: { select: { code: true } },
      payments: { where: { refundId: null }, select: { amount: true } },
      // o3d-iigc: the basis was not fetched before, so the report could not have respected it.
      refunds: { select: { totalBase: true, totalsBasis: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const now = Date.now()
  return orders.map((o) => {
    const total = Number(o.totalBase)
    const paid = o.payments.reduce((s, p) => s + Number(p.amount), 0)
    // `balance` stays GROSS-on-GROSS and is untouched: Payment.amount is cash actually moved, which
    // is the same unit as the VAT-inclusive invoice total. Only the net-of-credits figure below has
    // a basis question, because a credit's stored total does not.
    const credits = netOfRefunds(o, o.refunds)
    const balance = Math.max(0, total - paid)
    const ageDays = o.invoicedAt ? Math.round((now - o.invoicedAt.getTime()) / 86400000) : 0
    let o0 = 0, o31 = 0, o61 = 0, o91 = 0
    if (balance > 0.01) {
      if (ageDays > 90) o91 = balance
      else if (ageDays > 60) o61 = balance
      else if (ageDays > 30) o31 = balance
      else o0 = balance
    }
    return {
      orderId: o.id, orderNumber: getSalesOrderReference(o),
      customerId: o.customerId ?? '', customerName: o.customerName ?? '—',
      salesRep: o.salesRep, warehouse: o.shipFromWarehouse?.code ?? null,
      createdAt: o.createdAt.toISOString(), currency: o.currency,
      salesTotal: Math.round(total * 100) / 100,
      refundsTotal: credits.refundsTotal,
      netTotal: credits.netTotal,
      netTotalBasis: credits.basis,
      dueAmount: Math.round(balance * 100) / 100, avgDso: ageDays,
      overdue0_30: Math.round(o0 * 100) / 100, overdue31_60: Math.round(o31 * 100) / 100,
      overdue61_90: Math.round(o61 * 100) / 100, overdue91plus: Math.round(o91 * 100) / 100,
    }
  })
}

// ---------------------------------------------------------------------------
// Saved Views (shared across all analytics)
// ---------------------------------------------------------------------------

export type SavedView = {
  id: string
  name: string
  tab: string
  columns: string[]
  filters: { field: string; operator: string; value: string }[]
}

export async function getSavedViews(): Promise<SavedView[]> {
  await requirePermission('analytics')
  const row = await db.setting.findUnique({ where: { key: 'sales_stats_views' } })
  if (row?.value) { try { return JSON.parse(row.value) } catch {} }
  return []
}

export async function saveView(view: SavedView): Promise<void> {
  await requirePermission('analytics')
  const views = await getSavedViews()
  const existing = views.findIndex((v) => v.id === view.id)
  if (existing >= 0) views[existing] = view; else views.push(view)
  await db.setting.upsert({ where: { key: 'sales_stats_views' }, create: { key: 'sales_stats_views', value: JSON.stringify(views) }, update: { value: JSON.stringify(views) } })
  await logActivity({
    entityType: 'SETTING',
    tag: 'analytics',
    action: existing >= 0 ? 'updated' : 'created',
    description: `${existing >= 0 ? 'Updated' : 'Created'} sales stats view: ${view.name}`,
  })
  revalidatePath('/analytics/sales-stats')
}

export async function deleteView(viewId: string): Promise<void> {
  await requirePermission('analytics')
  const views = await getSavedViews()
  const deleted = views.find((v) => v.id === viewId)
  await db.setting.upsert({ where: { key: 'sales_stats_views' }, create: { key: 'sales_stats_views', value: JSON.stringify(views.filter((v) => v.id !== viewId)) }, update: { value: JSON.stringify(views.filter((v) => v.id !== viewId)) } })
  await logActivity({
    entityType: 'SETTING',
    tag: 'analytics',
    action: 'deleted',
    description: `Deleted sales stats view: ${deleted?.name ?? viewId}`,
  })
  revalidatePath('/analytics/sales-stats')
}
