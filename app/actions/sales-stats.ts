'use server'

import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SalesStatRow = {
  productId: string
  sku: string
  name: string
  stockUnit: string
  qtySold: number
  qtyRefunded: number
  netQty: number
  grossRevenue: number    // GBP
  discounts: number       // GBP
  refunds: number         // GBP
  netRevenue: number      // GBP
  cogs: number            // GBP
  grossProfit: number     // GBP
  marginPct: number       // %
  orderCount: number
  avgOrderValue: number   // GBP
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

export type ShipmentRow = {
  orderId: string
  orderNumber: string
  customerName: string
  shippedAt: string
  trackingNumber: string | null
  shippingService: string | null
  warehouse: string | null
  lineCount: number
  totalGbp: number
}

export type InvoiceRow = {
  orderId: string
  orderNumber: string
  invoiceNumber: string
  customerName: string
  invoicedAt: string
  totalGbp: number
  paidAt: string | null
  balance: number
}

export type RefundRow = {
  id: string
  orderId: string
  orderNumber: string
  creditNoteNumber: string | null
  customerName: string
  reason: string | null
  totalGbp: number
  refundedAt: string
}

export type CustomerAgingRow = {
  customerId: string
  customerName: string
  totalInvoiced: number
  totalPaid: number
  outstanding: number
  overdueAmount: number
  oldestUnpaidDays: number
}

// ---------------------------------------------------------------------------
// Product sales stats
// ---------------------------------------------------------------------------

export async function getProductSalesStats(
  dateFrom?: string,
  dateTo?: string,
): Promise<{ rows: SalesStatRow[]; summary: SalesStatSummary }> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')
  const hasDateFilter = Object.keys(dateFilter).length > 0

  const orders = await db.salesOrder.findMany({
    where: {
      status: { in: ['SHIPPED', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    select: {
      id: true,
      totalGbp: true,
      discountAmount: true,
      fxRateToGbp: true,
      lines: { select: { productId: true, sku: true, description: true, qty: true, totalGbp: true, discountAmount: true, cogsGbp: true } },
      refunds: { select: { totalGbp: true, lines: { select: { productId: true, qty: true, totalGbp: true } } } },
    },
  })

  const productMap = new Map<string, SalesStatRow>()

  // Get product details
  const products = await db.product.findMany({ select: { id: true, sku: true, name: true, stockUnit: true } })
  const productInfo = new Map(products.map((p) => [p.id, p]))

  for (const order of orders) {
    for (const line of order.lines) {
      if (!line.productId) continue
      const pid = line.productId
      const info = productInfo.get(pid)
      if (!productMap.has(pid)) {
        productMap.set(pid, {
          productId: pid,
          sku: info?.sku ?? line.sku ?? '',
          name: info?.name ?? line.description,
          stockUnit: info?.stockUnit ?? 'pcs',
          qtySold: 0, qtyRefunded: 0, netQty: 0,
          grossRevenue: 0, discounts: 0, refunds: 0, netRevenue: 0,
          cogs: 0, grossProfit: 0, marginPct: 0,
          orderCount: 0, avgOrderValue: 0,
        })
      }
      const row = productMap.get(pid)!
      const qty = Number(line.qty)
      const revenue = Number(line.totalGbp)
      const discount = Number(line.discountAmount) / Number(order.fxRateToGbp || 1)
      const cogs = Number(line.cogsGbp ?? 0)

      row.qtySold += qty
      row.grossRevenue += revenue + discount
      row.discounts += discount
      row.cogs += cogs
      row.orderCount++
    }

    // Refunds
    for (const refund of order.refunds) {
      for (const rl of refund.lines) {
        if (!rl.productId) continue
        const row = productMap.get(rl.productId)
        if (row) {
          row.qtyRefunded += Number(rl.qty)
          row.refunds += Number(rl.totalGbp)
        }
      }
    }
  }

  // Calculate derived fields
  const rows: SalesStatRow[] = []
  for (const row of productMap.values()) {
    row.netQty = row.qtySold - row.qtyRefunded
    row.netRevenue = row.grossRevenue - row.discounts - row.refunds
    row.grossProfit = row.netRevenue - row.cogs
    row.marginPct = row.netRevenue > 0 ? (row.grossProfit / row.netRevenue) * 100 : 0
    row.avgOrderValue = row.orderCount > 0 ? row.netRevenue / row.orderCount : 0
    // Round
    row.grossRevenue = Math.round(row.grossRevenue * 100) / 100
    row.discounts = Math.round(row.discounts * 100) / 100
    row.refunds = Math.round(row.refunds * 100) / 100
    row.netRevenue = Math.round(row.netRevenue * 100) / 100
    row.cogs = Math.round(row.cogs * 100) / 100
    row.grossProfit = Math.round(row.grossProfit * 100) / 100
    row.marginPct = Math.round(row.marginPct * 10) / 10
    row.avgOrderValue = Math.round(row.avgOrderValue * 100) / 100
    rows.push(row)
  }

  rows.sort((a, b) => b.netRevenue - a.netRevenue)

  const summary: SalesStatSummary = {
    totalOrders: orders.length,
    totalGrossRevenue: rows.reduce((s, r) => s + r.grossRevenue, 0),
    totalDiscounts: rows.reduce((s, r) => s + r.discounts, 0),
    totalRefunds: rows.reduce((s, r) => s + r.refunds, 0),
    totalNetRevenue: rows.reduce((s, r) => s + r.netRevenue, 0),
    totalCogs: rows.reduce((s, r) => s + r.cogs, 0),
    totalGrossProfit: rows.reduce((s, r) => s + r.grossProfit, 0),
    avgMarginPct: 0,
    avgOrderValue: 0,
    totalQtySold: rows.reduce((s, r) => s + r.netQty, 0),
  }
  summary.avgMarginPct = summary.totalNetRevenue > 0 ? Math.round((summary.totalGrossProfit / summary.totalNetRevenue) * 1000) / 10 : 0
  summary.avgOrderValue = summary.totalOrders > 0 ? Math.round((summary.totalNetRevenue / summary.totalOrders) * 100) / 100 : 0

  return { rows, summary }
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

export async function getShipments(dateFrom?: string, dateTo?: string): Promise<ShipmentRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const orders = await db.salesOrder.findMany({
    where: { shippedAt: { not: null, ...(Object.keys(dateFilter).length ? dateFilter : {}) } },
    select: {
      id: true, wcOrderNumber: true, customerName: true, shippedAt: true,
      trackingNumber: true, shippingService: true, totalGbp: true,
      shipFromWarehouse: { select: { code: true } },
      _count: { select: { lines: true } },
    },
    orderBy: { shippedAt: 'desc' },
  })
  return orders.map((o) => ({
    orderId: o.id, orderNumber: o.wcOrderNumber ?? o.id.slice(0, 8),
    customerName: o.customerName ?? '—', shippedAt: o.shippedAt!.toISOString(),
    trackingNumber: o.trackingNumber, shippingService: o.shippingService,
    warehouse: o.shipFromWarehouse?.code ?? null, lineCount: o._count.lines,
    totalGbp: Number(o.totalGbp),
  }))
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export async function getInvoiceStats(dateFrom?: string, dateTo?: string): Promise<InvoiceRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const orders = await db.salesOrder.findMany({
    where: { invoiceNumber: { not: null }, ...(Object.keys(dateFilter).length ? { invoicedAt: dateFilter } : {}) },
    select: {
      id: true, wcOrderNumber: true, invoiceNumber: true, customerName: true,
      invoicedAt: true, totalGbp: true, paidAt: true,
      payments: { where: { refundId: null }, select: { amount: true } },
    },
    orderBy: { invoicedAt: 'desc' },
  })
  return orders.map((o) => {
    const paid = o.payments.reduce((s, p) => s + Number(p.amount), 0)
    return {
      orderId: o.id, orderNumber: o.wcOrderNumber ?? o.id.slice(0, 8),
      invoiceNumber: o.invoiceNumber!, customerName: o.customerName ?? '—',
      invoicedAt: o.invoicedAt!.toISOString(), totalGbp: Number(o.totalGbp),
      paidAt: o.paidAt?.toISOString() ?? null,
      balance: Math.round((Number(o.totalGbp) - paid) * 100) / 100,
    }
  })
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export async function getRefundStats(dateFrom?: string, dateTo?: string): Promise<RefundRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const refunds = await db.salesOrderRefund.findMany({
    where: Object.keys(dateFilter).length ? { refundedAt: dateFilter } : undefined,
    select: {
      id: true, creditNoteNumber: true, reason: true, totalGbp: true, refundedAt: true,
      order: { select: { id: true, wcOrderNumber: true, customerName: true } },
    },
    orderBy: { refundedAt: 'desc' },
  })
  return refunds.map((r) => ({
    id: r.id, orderId: r.order.id, orderNumber: r.order.wcOrderNumber ?? r.order.id.slice(0, 8),
    creditNoteNumber: r.creditNoteNumber, customerName: r.order.customerName ?? '—',
    reason: r.reason, totalGbp: Number(r.totalGbp), refundedAt: r.refundedAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Customer Aging
// ---------------------------------------------------------------------------

export async function getCustomerAging(): Promise<CustomerAgingRow[]> {
  const orders = await db.salesOrder.findMany({
    where: { invoiceNumber: { not: null } },
    select: {
      customerId: true, customerName: true, totalGbp: true, invoicedAt: true, paidAt: true,
      payments: { where: { refundId: null }, select: { amount: true } },
    },
  })

  const customerMap = new Map<string, CustomerAgingRow>()
  const now = Date.now()

  for (const o of orders) {
    const key = o.customerId ?? o.customerName ?? 'Unknown'
    if (!customerMap.has(key)) {
      customerMap.set(key, {
        customerId: o.customerId ?? '', customerName: o.customerName ?? 'Unknown',
        totalInvoiced: 0, totalPaid: 0, outstanding: 0, overdueAmount: 0, oldestUnpaidDays: 0,
      })
    }
    const row = customerMap.get(key)!
    const total = Number(o.totalGbp)
    const paid = o.payments.reduce((s, p) => s + Number(p.amount), 0)
    const balance = total - paid

    row.totalInvoiced += total
    row.totalPaid += paid
    row.outstanding += Math.max(0, balance)

    if (balance > 0.01 && o.invoicedAt) {
      const ageDays = Math.round((now - o.invoicedAt.getTime()) / 86400000)
      if (ageDays > 30) row.overdueAmount += balance
      if (ageDays > row.oldestUnpaidDays) row.oldestUnpaidDays = ageDays
    }
  }

  const rows = Array.from(customerMap.values())
    .filter((r) => r.totalInvoiced > 0)
    .sort((a, b) => b.outstanding - a.outstanding)

  // Round
  for (const r of rows) {
    r.totalInvoiced = Math.round(r.totalInvoiced * 100) / 100
    r.totalPaid = Math.round(r.totalPaid * 100) / 100
    r.outstanding = Math.round(r.outstanding * 100) / 100
    r.overdueAmount = Math.round(r.overdueAmount * 100) / 100
  }

  return rows
}
