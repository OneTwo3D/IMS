'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth/server'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { getSalesOrderReference } from '@/lib/sales-order-display'

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
  discounts: number
  refunds: number
  netRevenue: number
  cogs: number
  grossProfit: number
  marginPct: number
  orderCount: number
  avgOrderValue: number
  salesPrice: number | null
  weight: number | null
}

export type SalesStatSummary = {
  totalOrders: number
  totalGrossRevenue: number
  totalDiscounts: number
  totalRefunds: number
  totalNetRevenue: number
  totalCogs: number
  totalGrossProfit: number
  avgMarginPct: number
  avgOrderValue: number
  totalQtySold: number
}

export async function getProductSalesStats(dateFrom?: string, dateTo?: string): Promise<{ rows: SalesStatRow[]; summary: SalesStatSummary }> {
  await requireAuth()
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')
  const hasDateFilter = Object.keys(dateFilter).length > 0

  const orders = await db.salesOrder.findMany({
    where: { status: { in: ['SHIPPED', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, ...(hasDateFilter ? { createdAt: dateFilter } : {}) },
    select: {
      id: true, totalBase: true, discountAmount: true, fxRateToBase: true, customerName: true, salesRep: true,
      lines: { select: { productId: true, sku: true, description: true, qty: true, totalBase: true, discountAmount: true, cogsBase: true } },
      refunds: { select: { totalBase: true, lines: { select: { productId: true, qty: true, totalBase: true } } } },
    },
  })

  const products = await db.product.findMany({
    select: { id: true, sku: true, name: true, type: true, stockUnit: true, barcode: true, weight: true, salesPriceBase: true, lifecycleStatus: true,
      stockLevels: { select: { quantity: true, reservedQty: true } } },
  })
  const productInfo = new Map(products.map((p) => [p.id, p]))
  const productMap = new Map<string, SalesStatRow>()

  for (const order of orders) {
    for (const line of order.lines) {
      if (!line.productId) continue
      const pid = line.productId; const info = productInfo.get(pid)
      if (!productMap.has(pid)) {
        productMap.set(pid, {
          productId: pid, sku: info?.sku ?? line.sku ?? '', name: info?.name ?? line.description,
          type: info?.type ?? 'SIMPLE', stockUnit: info?.stockUnit ?? 'pcs', barcode: info?.barcode ?? null,
          lifecycleStatus: info?.lifecycleStatus ?? 'ACTIVE',
          currentStock: info?.stockLevels.reduce((s, sl) => s + Number(sl.quantity), 0) ?? 0,
          reservedQty: info?.stockLevels.reduce((s, sl) => s + Number(sl.reservedQty), 0) ?? 0,
          availableStock: info ? info.stockLevels.reduce((s, sl) => s + Number(sl.quantity) - Number(sl.reservedQty), 0) : 0,
          customerName: order.customerName, salesRep: order.salesRep,
          salesPrice: info?.salesPriceBase ? Number(info.salesPriceBase) : null,
          weight: info?.weight ? Number(info.weight) : null,
          qtySold: 0, qtyRefunded: 0, netQty: 0, grossRevenue: 0, discounts: 0, refunds: 0,
          netRevenue: 0, cogs: 0, grossProfit: 0, marginPct: 0, orderCount: 0, avgOrderValue: 0,
        })
      }
      const row = productMap.get(pid)!
      row.qtySold += Number(line.qty)
      row.grossRevenue += Number(line.totalBase) + Number(line.discountAmount) / Number(order.fxRateToBase || 1)
      row.discounts += Number(line.discountAmount) / Number(order.fxRateToBase || 1)
      row.cogs += Number(line.cogsBase ?? 0)
      row.orderCount++
    }
    for (const refund of order.refunds) {
      for (const rl of refund.lines) {
        if (!rl.productId) continue
        const row = productMap.get(rl.productId)
        if (row) { row.qtyRefunded += Number(rl.qty); row.refunds += Number(rl.totalBase) }
      }
    }
  }

  const rows: SalesStatRow[] = []
  for (const row of productMap.values()) {
    row.netQty = row.qtySold - row.qtyRefunded
    row.netRevenue = row.grossRevenue - row.discounts - row.refunds
    row.grossProfit = row.netRevenue - row.cogs
    row.marginPct = row.netRevenue > 0 ? (row.grossProfit / row.netRevenue) * 100 : 0
    row.avgOrderValue = row.orderCount > 0 ? row.netRevenue / row.orderCount : 0
    row.grossRevenue = Math.round(row.grossRevenue * 100) / 100; row.discounts = Math.round(row.discounts * 100) / 100
    row.refunds = Math.round(row.refunds * 100) / 100; row.netRevenue = Math.round(row.netRevenue * 100) / 100
    row.cogs = Math.round(row.cogs * 100) / 100; row.grossProfit = Math.round(row.grossProfit * 100) / 100
    row.marginPct = Math.round(row.marginPct * 10) / 10; row.avgOrderValue = Math.round(row.avgOrderValue * 100) / 100
    rows.push(row)
  }
  rows.sort((a, b) => b.netRevenue - a.netRevenue)

  const summary: SalesStatSummary = {
    totalOrders: orders.length, totalGrossRevenue: rows.reduce((s, r) => s + r.grossRevenue, 0),
    totalDiscounts: rows.reduce((s, r) => s + r.discounts, 0), totalRefunds: rows.reduce((s, r) => s + r.refunds, 0),
    totalNetRevenue: rows.reduce((s, r) => s + r.netRevenue, 0), totalCogs: rows.reduce((s, r) => s + r.cogs, 0),
    totalGrossProfit: rows.reduce((s, r) => s + r.grossProfit, 0), avgMarginPct: 0, avgOrderValue: 0,
    totalQtySold: rows.reduce((s, r) => s + r.netQty, 0),
  }
  summary.avgMarginPct = summary.totalNetRevenue > 0 ? Math.round((summary.totalGrossProfit / summary.totalNetRevenue) * 1000) / 10 : 0
  summary.avgOrderValue = summary.totalOrders > 0 ? Math.round((summary.totalNetRevenue / summary.totalOrders) * 100) / 100 : 0
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
  await requireAuth()
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const orders = await db.salesOrder.findMany({
    where: { shippedAt: { not: null, ...(Object.keys(dateFilter).length ? dateFilter : {}) } },
    select: {
      id: true, orderNumber: true, externalOrderNumber: true, customerName: true, salesRep: true, shippedAt: true,
      trackingNumber: true, shippingService: true, shipFromWarehouse: { select: { code: true } },
      lines: { select: { productId: true, sku: true, description: true, qty: true, totalBase: true, product: { select: { barcode: true } } } },
    },
    orderBy: { shippedAt: 'desc' },
  })

  const rows: ShipmentRow[] = []
  for (const o of orders) {
    for (const l of o.lines) {
      rows.push({
        orderId: o.id, orderNumber: getSalesOrderReference(o),
        shipmentNumber: o.trackingNumber, sku: l.sku ?? '', productName: l.description,
        productId: l.productId, barcode: l.product?.barcode ?? null,
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
  await requireAuth()
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const orders = await db.salesOrder.findMany({
    where: Object.keys(dateFilter).length ? { createdAt: dateFilter } : undefined,
    select: {
      id: true, orderNumber: true, externalOrderNumber: true, status: true, customerName: true, customerEmail: true, salesRep: true, createdAt: true,
      lines: { select: { productId: true, sku: true, description: true, qty: true, totalBase: true, product: { select: { barcode: true, type: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const rows: DetailRow[] = []
  for (const o of orders) {
    for (const l of o.lines) {
      rows.push({
        orderId: o.id, orderNumber: getSalesOrderReference(o),
        productId: l.productId, sku: l.sku ?? '', productName: l.description,
        barcode: l.product?.barcode ?? null, type: l.product?.type ?? null,
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
  await requireAuth()
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
  pctOfSale: number
}

export async function getRefundStats(dateFrom?: string, dateTo?: string): Promise<RefundRow[]> {
  await requireAuth()
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const refunds = await db.salesOrderRefund.findMany({
    where: Object.keys(dateFilter).length ? { refundedAt: dateFilter } : undefined,
    select: {
      id: true, creditNoteNumber: true, reason: true, totalBase: true, refundedAt: true,
      order: { select: { id: true, orderNumber: true, externalOrderNumber: true, customerName: true, salesRep: true, totalBase: true } },
      lines: { select: { id: true, productId: true, description: true, qty: true, totalBase: true } },
    },
    orderBy: { refundedAt: 'desc' },
  })

  const rows: RefundRow[] = []
  for (const r of refunds) {
    const orderTotal = Number(r.order.totalBase)
    for (const l of r.lines) {
      const lineTotal = Number(l.totalBase)
      rows.push({
        id: l.id, orderId: r.order.id, orderNumber: getSalesOrderReference(r.order),
        creditNoteNumber: r.creditNoteNumber, productId: l.productId,
        sku: '', productName: l.description,
        customerName: r.order.customerName ?? '—', salesRep: r.order.salesRep,
        reason: r.reason, refundedAt: r.refundedAt.toISOString(),
        qty: Number(l.qty), totalBase: lineTotal,
        pctOfSale: orderTotal > 0 ? Math.round((lineTotal / orderTotal) * 1000) / 10 : 0,
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
  salesTotal: number
  refundsTotal: number
  netTotal: number
  dueAmount: number
  avgDso: number
  overdue0_30: number
  overdue31_60: number
  overdue61_90: number
  overdue91plus: number
}

export async function getCustomerAging(): Promise<CustomerAgingRow[]> {
  await requireAuth()
  const orders = await db.salesOrder.findMany({
    where: { invoiceNumber: { not: null } },
    select: {
      id: true, orderNumber: true, externalOrderNumber: true, customerId: true, customerName: true, salesRep: true,
      currency: true, totalBase: true, invoicedAt: true, paidAt: true, createdAt: true,
      shipFromWarehouse: { select: { code: true } },
      payments: { where: { refundId: null }, select: { amount: true } },
      refunds: { select: { totalBase: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const now = Date.now()
  return orders.map((o) => {
    const total = Number(o.totalBase)
    const paid = o.payments.reduce((s, p) => s + Number(p.amount), 0)
    const refundsTotal = o.refunds.reduce((s, r) => s + Number(r.totalBase), 0)
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
      refundsTotal: Math.round(refundsTotal * 100) / 100,
      netTotal: Math.round((total - refundsTotal) * 100) / 100,
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
  await requireAuth()
  const row = await db.setting.findUnique({ where: { key: 'sales_stats_views' } })
  if (row?.value) { try { return JSON.parse(row.value) } catch {} }
  return []
}

export async function saveView(view: SavedView): Promise<void> {
  await requireAuth()
  const views = await getSavedViews()
  const existing = views.findIndex((v) => v.id === view.id)
  if (existing >= 0) views[existing] = view; else views.push(view)
  await db.setting.upsert({ where: { key: 'sales_stats_views' }, create: { key: 'sales_stats_views', value: JSON.stringify(views) }, update: { value: JSON.stringify(views) } })
  revalidatePath('/analytics/sales-stats')
}

export async function deleteView(viewId: string): Promise<void> {
  await requireAuth()
  const views = await getSavedViews()
  await db.setting.upsert({ where: { key: 'sales_stats_views' }, create: { key: 'sales_stats_views', value: JSON.stringify(views.filter((v) => v.id !== viewId)) }, update: { value: JSON.stringify(views.filter((v) => v.id !== viewId)) } })
  revalidatePath('/analytics/sales-stats')
}
