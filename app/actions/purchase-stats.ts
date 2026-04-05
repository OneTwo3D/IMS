'use server'

import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Product purchase stats (Products tab)
// ---------------------------------------------------------------------------

export type PurchaseProductRow = {
  productId: string
  sku: string
  name: string
  type: string
  stockUnit: string
  barcode: string | null
  supplierName: string | null
  qtyOrdered: number
  qtyReceived: number
  qtyReturned: number
  netQty: number
  totalGbp: number
  landedCostGbp: number
  avgUnitCostGbp: number
  incomingQty: number
  supplierCount: number
  poCount: number
  createdAt: string | null
}

export async function getPurchaseProductStats(dateFrom?: string, dateTo?: string): Promise<PurchaseProductRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')
  const hasDate = Object.keys(dateFilter).length > 0

  const pos = await db.purchaseOrder.findMany({
    where: { type: 'GOODS', status: { notIn: ['DRAFT', 'CANCELLED'] }, ...(hasDate ? { createdAt: dateFilter } : {}) },
    select: {
      id: true, supplierId: true, createdAt: true,
      supplier: { select: { name: true } },
      lines: {
        select: {
          productId: true, qty: true, qtyReceived: true, qtyReturned: true,
          totalGbp: true, landedUnitCostGbp: true,
          product: { select: { sku: true, name: true, type: true, stockUnit: true, barcode: true } },
        },
      },
    },
  })

  const map = new Map<string, PurchaseProductRow>()
  const suppliersByProduct = new Map<string, Set<string>>()
  const posByProduct = new Map<string, Set<string>>()

  for (const po of pos) {
    for (const l of po.lines) {
      const pid = l.productId
      if (!map.has(pid)) {
        map.set(pid, {
          productId: pid, sku: l.product.sku, name: l.product.name,
          type: l.product.type, stockUnit: l.product.stockUnit, barcode: l.product.barcode,
          supplierName: po.supplier.name,
          qtyOrdered: 0, qtyReceived: 0, qtyReturned: 0, netQty: 0,
          totalGbp: 0, landedCostGbp: 0, avgUnitCostGbp: 0,
          incomingQty: 0, supplierCount: 0, poCount: 0, createdAt: null,
        })
        suppliersByProduct.set(pid, new Set())
        posByProduct.set(pid, new Set())
      }
      const row = map.get(pid)!
      row.qtyOrdered += Number(l.qty)
      row.qtyReceived += Number(l.qtyReceived)
      row.qtyReturned += Number(l.qtyReturned)
      row.incomingQty += Math.max(0, Number(l.qty) - Number(l.qtyReceived))
      row.totalGbp += Number(l.totalGbp)
      const landed = Number(l.landedUnitCostGbp)
      if (landed > 0) row.landedCostGbp += landed * Number(l.qty)
      row.supplierName = po.supplier.name
      if (!row.createdAt || po.createdAt.toISOString() > row.createdAt) row.createdAt = po.createdAt.toISOString()
      suppliersByProduct.get(pid)!.add(po.supplierId)
      posByProduct.get(pid)!.add(po.id)
    }
  }

  const rows: PurchaseProductRow[] = []
  for (const row of map.values()) {
    row.netQty = row.qtyReceived - row.qtyReturned
    row.avgUnitCostGbp = row.qtyOrdered > 0 ? Math.round((row.totalGbp / row.qtyOrdered) * 10000) / 10000 : 0
    row.supplierCount = suppliersByProduct.get(row.productId)?.size ?? 0
    row.poCount = posByProduct.get(row.productId)?.size ?? 0
    row.totalGbp = Math.round(row.totalGbp * 100) / 100
    row.landedCostGbp = Math.round(row.landedCostGbp * 100) / 100
    rows.push(row)
  }
  rows.sort((a, b) => b.totalGbp - a.totalGbp)
  return rows
}

// ---------------------------------------------------------------------------
// Received goods (line-level)
// ---------------------------------------------------------------------------

export type ReceivedGoodsRow = {
  receiptLineId: string
  poReference: string
  poId: string
  supplierName: string
  grnReference: string | null
  sku: string
  productName: string
  productId: string
  receivedAt: string
  warehouseCode: string | null
  qtyReceived: number
  unitCostGbp: number
  totalGbp: number
  landedUnitCostGbp: number
  status: string
}

export async function getReceivedGoods(dateFrom?: string, dateTo?: string): Promise<ReceivedGoodsRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const receipts = await db.purchaseReceipt.findMany({
    where: Object.keys(dateFilter).length ? { receivedAt: dateFilter } : undefined,
    select: {
      id: true, reference: true, receivedAt: true,
      po: { select: { id: true, reference: true, status: true, supplier: { select: { name: true } } } },
      lines: {
        select: {
          id: true, qtyReceived: true, warehouseId: true,
          poLine: { select: { unitCostGbp: true, landedUnitCostGbp: true, product: { select: { id: true, sku: true, name: true } } } },
        },
      },
    },
    orderBy: { receivedAt: 'desc' },
  })

  const warehouses = await db.warehouse.findMany({ select: { id: true, code: true } })
  const whMap = new Map(warehouses.map((w) => [w.id, w.code]))

  const rows: ReceivedGoodsRow[] = []
  for (const r of receipts) {
    for (const l of r.lines) {
      const qty = Number(l.qtyReceived)
      const unitCost = Number(l.poLine.unitCostGbp)
      rows.push({
        receiptLineId: l.id, poReference: r.po.reference, poId: r.po.id,
        supplierName: r.po.supplier.name, grnReference: r.reference,
        sku: l.poLine.product.sku, productName: l.poLine.product.name, productId: l.poLine.product.id,
        receivedAt: r.receivedAt.toISOString(),
        warehouseCode: l.warehouseId ? whMap.get(l.warehouseId) ?? null : null,
        qtyReceived: qty, unitCostGbp: unitCost,
        totalGbp: Math.round(qty * unitCost * 100) / 100,
        landedUnitCostGbp: Number(l.poLine.landedUnitCostGbp),
        status: r.po.status,
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Bills (line-level purchase invoices)
// ---------------------------------------------------------------------------

export type BillRow = {
  invoiceLineId: string
  poId: string
  poReference: string
  invoiceNumber: string | null
  supplierName: string
  sku: string
  productName: string
  productId: string
  invoiceDate: string
  qtyBilled: number
  totalForeign: number
  totalGbp: number
  supplierInvoiceUrl: string | null
  status: string
}

export async function getPurchaseBills(dateFrom?: string, dateTo?: string): Promise<BillRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const invoices = await db.purchaseInvoice.findMany({
    where: Object.keys(dateFilter).length ? { invoiceDate: dateFilter } : undefined,
    select: {
      id: true, invoiceNumber: true, invoiceDate: true, supplierInvoiceUrl: true,
      po: { select: { id: true, reference: true, status: true, supplier: { select: { name: true } } } },
      lines: { select: { id: true, qtyBilled: true, totalForeign: true, totalGbp: true, poLine: { select: { product: { select: { id: true, sku: true, name: true } } } } } },
    },
    orderBy: { invoiceDate: 'desc' },
  })

  const rows: BillRow[] = []
  for (const inv of invoices) {
    for (const l of inv.lines) {
      rows.push({
        invoiceLineId: l.id, poId: inv.po.id, poReference: inv.po.reference,
        invoiceNumber: inv.invoiceNumber, supplierName: inv.po.supplier.name,
        sku: l.poLine.product.sku, productName: l.poLine.product.name, productId: l.poLine.product.id,
        invoiceDate: inv.invoiceDate.toISOString(),
        qtyBilled: Number(l.qtyBilled),
        totalForeign: Number(l.totalForeign), totalGbp: Number(l.totalGbp),
        supplierInvoiceUrl: inv.supplierInvoiceUrl, status: inv.po.status,
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Supplier aging (with aging buckets)
// ---------------------------------------------------------------------------

export type SupplierAgingRow = {
  supplierId: string
  supplierName: string
  grossAmount: number
  discounts: number
  refunds: number
  netAmount: number
  landedCosts: number
  tax: number
  totalAmount: number
  billedAmount: number
  paidAmount: number
  dueAmount: number
  overdue0_30: number
  overdue31_60: number
  overdue61_90: number
  overdue91plus: number
  poCount: number
  avgLeadTimeDays: number | null
}

export async function getSupplierAging(): Promise<SupplierAgingRow[]> {
  const suppliers = await db.supplier.findMany({
    where: { active: true },
    select: {
      id: true, name: true,
      purchaseOrders: {
        where: { type: 'GOODS', status: { notIn: ['DRAFT', 'CANCELLED'] } },
        select: {
          totalGbp: true, taxGbp: true, directFreightGbp: true, poSentAt: true, receivedAt: true,
          invoices: { select: { totalGbp: true, invoiceDate: true } },
          returns: { select: { lines: { select: { qtyReturned: true, poLine: { select: { unitCostGbp: true } } } } } },
        },
      },
    },
  })

  const now = Date.now()
  return suppliers.map((s) => {
    let grossAmount = 0, tax = 0, landedCosts = 0, billedAmount = 0, refunds = 0
    let overdue0_30 = 0, overdue31_60 = 0, overdue61_90 = 0, overdue91plus = 0
    const leadTimes: number[] = []

    for (const po of s.purchaseOrders) {
      grossAmount += Number(po.totalGbp)
      tax += Number(po.taxGbp)
      landedCosts += Number(po.directFreightGbp)
      refunds += po.returns.reduce((sum, r) => sum + r.lines.reduce((s2, rl) => s2 + Number(rl.qtyReturned) * Number(rl.poLine.unitCostGbp), 0), 0)
      for (const inv of po.invoices) {
        const t = Number(inv.totalGbp); billedAmount += t
        const d = Math.round((now - inv.invoiceDate.getTime()) / 86400000)
        if (d > 90) overdue91plus += t; else if (d > 60) overdue61_90 += t; else if (d > 30) overdue31_60 += t; else overdue0_30 += t
      }
      if (po.poSentAt && po.receivedAt) { const d = Math.round((po.receivedAt.getTime() - po.poSentAt.getTime()) / 86400000); if (d > 0 && d < 365) leadTimes.push(d) }
    }

    return {
      supplierId: s.id, supplierName: s.name,
      grossAmount: Math.round(grossAmount * 100) / 100, discounts: 0,
      refunds: Math.round(refunds * 100) / 100, netAmount: Math.round((grossAmount - refunds) * 100) / 100,
      landedCosts: Math.round(landedCosts * 100) / 100, tax: Math.round(tax * 100) / 100,
      totalAmount: Math.round(grossAmount * 100) / 100,
      billedAmount: Math.round(billedAmount * 100) / 100, paidAmount: 0,
      dueAmount: Math.round(billedAmount * 100) / 100,
      overdue0_30: Math.round(overdue0_30 * 100) / 100, overdue31_60: Math.round(overdue31_60 * 100) / 100,
      overdue61_90: Math.round(overdue61_90 * 100) / 100, overdue91plus: Math.round(overdue91plus * 100) / 100,
      poCount: s.purchaseOrders.length,
      avgLeadTimeDays: leadTimes.length ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) : null,
    }
  }).filter((r) => r.poCount > 0).sort((a, b) => b.totalAmount - a.totalAmount)
}

// ---------------------------------------------------------------------------
// PO details (line-level)
// ---------------------------------------------------------------------------

export type PurchaseDetailRow = {
  poId: string
  reference: string
  lineProductId: string
  sku: string
  productName: string
  barcode: string | null
  type: string
  status: string
  supplierName: string
  currency: string
  qty: number
  unitCostForeign: number
  totalForeign: number
  totalGbp: number
  createdAt: string
}

export async function getPurchaseDetails(dateFrom?: string, dateTo?: string): Promise<PurchaseDetailRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const pos = await db.purchaseOrder.findMany({
    where: { type: 'GOODS', ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}) },
    select: {
      id: true, reference: true, status: true, currency: true, createdAt: true,
      supplier: { select: { name: true } },
      lines: { select: { productId: true, qty: true, unitCostForeign: true, totalForeign: true, totalGbp: true, product: { select: { sku: true, name: true, barcode: true, type: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const rows: PurchaseDetailRow[] = []
  for (const po of pos) {
    for (const l of po.lines) {
      rows.push({
        poId: po.id, reference: po.reference, lineProductId: l.productId,
        sku: l.product.sku, productName: l.product.name, barcode: l.product.barcode,
        type: l.product.type, status: po.status, supplierName: po.supplier.name,
        currency: po.currency, qty: Number(l.qty),
        unitCostForeign: Number(l.unitCostForeign), totalForeign: Number(l.totalForeign),
        totalGbp: Number(l.totalGbp), createdAt: po.createdAt.toISOString(),
      })
    }
  }
  return rows
}
