'use server'

import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PurchaseProductRow = {
  productId: string
  sku: string
  name: string
  type: string
  stockUnit: string
  qtyOrdered: number
  qtyReceived: number
  qtyReturned: number
  netQty: number
  totalForeign: number
  totalGbp: number
  landedCostGbp: number
  avgUnitCostGbp: number
  incomingQty: number
  supplierCount: number
  poCount: number
}

export type ReceivedGoodsRow = {
  receiptId: string
  poReference: string
  poId: string
  supplierName: string
  receivedAt: string
  warehouseCode: string | null
  lineCount: number
  totalQty: number
}

export type BillRow = {
  invoiceId: string
  poId: string
  poReference: string
  invoiceNumber: string | null
  supplierName: string
  invoiceDate: string
  totalForeign: number
  totalGbp: number
  supplierInvoiceUrl: string | null
}

export type SupplierAgingRow = {
  supplierId: string
  supplierName: string
  totalInvoiced: number
  totalPaid: number
  outstanding: number
  poCount: number
  avgLeadTimeDays: number | null
}

export type PurchaseDetailRow = {
  poId: string
  reference: string
  type: string
  status: string
  supplierName: string
  currency: string
  subtotalForeign: number
  totalForeign: number
  totalGbp: number
  lineCount: number
  expectedDelivery: string | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// Product purchase stats
// ---------------------------------------------------------------------------

export async function getPurchaseProductStats(dateFrom?: string, dateTo?: string): Promise<PurchaseProductRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')
  const hasDate = Object.keys(dateFilter).length > 0

  const pos = await db.purchaseOrder.findMany({
    where: {
      type: 'GOODS',
      status: { notIn: ['DRAFT', 'CANCELLED'] },
      ...(hasDate ? { createdAt: dateFilter } : {}),
    },
    select: {
      id: true,
      supplierId: true,
      lines: {
        select: {
          productId: true, qty: true, qtyReceived: true, qtyReturned: true,
          totalGbp: true, landedUnitCostGbp: true, unitCostGbp: true,
          product: { select: { sku: true, name: true, type: true, stockUnit: true } },
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
          type: l.product.type, stockUnit: l.product.stockUnit,
          qtyOrdered: 0, qtyReceived: 0, qtyReturned: 0, netQty: 0,
          totalForeign: 0, totalGbp: 0, landedCostGbp: 0, avgUnitCostGbp: 0,
          incomingQty: 0, supplierCount: 0, poCount: 0,
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
// Received goods
// ---------------------------------------------------------------------------

export async function getReceivedGoods(dateFrom?: string, dateTo?: string): Promise<ReceivedGoodsRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const receipts = await db.purchaseReceipt.findMany({
    where: Object.keys(dateFilter).length ? { receivedAt: dateFilter } : undefined,
    select: {
      id: true, reference: true, receivedAt: true,
      po: { select: { id: true, reference: true, supplier: { select: { name: true } } } },
      lines: { select: { qtyReceived: true, warehouseId: true } },
    },
    orderBy: { receivedAt: 'desc' },
  })

  // Get warehouse codes
  const warehouses = await db.warehouse.findMany({ select: { id: true, code: true } })
  const whMap = new Map(warehouses.map((w) => [w.id, w.code]))

  return receipts.map((r) => {
    const whIds = new Set(r.lines.map((l) => l.warehouseId).filter(Boolean))
    const whCode = whIds.size === 1 ? whMap.get([...whIds][0]!) ?? null : whIds.size > 1 ? 'Multiple' : null
    return {
      receiptId: r.id, poReference: r.po.reference, poId: r.po.id,
      supplierName: r.po.supplier.name, receivedAt: r.receivedAt.toISOString(),
      warehouseCode: whCode, lineCount: r.lines.length,
      totalQty: r.lines.reduce((s, l) => s + Number(l.qtyReceived), 0),
    }
  })
}

// ---------------------------------------------------------------------------
// Bills (purchase invoices)
// ---------------------------------------------------------------------------

export async function getPurchaseBills(dateFrom?: string, dateTo?: string): Promise<BillRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const invoices = await db.purchaseInvoice.findMany({
    where: Object.keys(dateFilter).length ? { invoiceDate: dateFilter } : undefined,
    select: {
      id: true, invoiceNumber: true, invoiceDate: true,
      totalForeign: true, totalGbp: true, supplierInvoiceUrl: true,
      po: { select: { id: true, reference: true, supplier: { select: { name: true } } } },
    },
    orderBy: { invoiceDate: 'desc' },
  })
  return invoices.map((i) => ({
    invoiceId: i.id, poId: i.po.id, poReference: i.po.reference,
    invoiceNumber: i.invoiceNumber, supplierName: i.po.supplier.name,
    invoiceDate: i.invoiceDate.toISOString(),
    totalForeign: Number(i.totalForeign), totalGbp: Number(i.totalGbp),
    supplierInvoiceUrl: i.supplierInvoiceUrl,
  }))
}

// ---------------------------------------------------------------------------
// Supplier aging
// ---------------------------------------------------------------------------

export async function getSupplierAging(): Promise<SupplierAgingRow[]> {
  const suppliers = await db.supplier.findMany({
    where: { active: true },
    select: {
      id: true, name: true,
      purchaseOrders: {
        where: { status: { notIn: ['DRAFT', 'CANCELLED'] } },
        select: {
          id: true, totalGbp: true, poSentAt: true, receivedAt: true,
          invoices: { select: { totalGbp: true } },
        },
      },
    },
  })

  return suppliers.map((s) => {
    const totalInvoiced = s.purchaseOrders.reduce((sum, po) =>
      sum + po.invoices.reduce((s2, inv) => s2 + Number(inv.totalGbp), 0), 0)
    const poCount = s.purchaseOrders.length
    const leadTimes = s.purchaseOrders
      .filter((po) => po.poSentAt && po.receivedAt)
      .map((po) => Math.round((po.receivedAt!.getTime() - po.poSentAt!.getTime()) / 86400000))
      .filter((d) => d > 0 && d < 365)
    const avgLead = leadTimes.length ? Math.round(leadTimes.reduce((s2, v) => s2 + v, 0) / leadTimes.length) : null

    return {
      supplierId: s.id, supplierName: s.name,
      totalInvoiced: Math.round(totalInvoiced * 100) / 100,
      totalPaid: 0, outstanding: Math.round(totalInvoiced * 100) / 100,
      poCount, avgLeadTimeDays: avgLead,
    }
  }).filter((r) => r.poCount > 0).sort((a, b) => b.totalInvoiced - a.totalInvoiced)
}

// ---------------------------------------------------------------------------
// PO details
// ---------------------------------------------------------------------------

export async function getPurchaseDetails(dateFrom?: string, dateTo?: string): Promise<PurchaseDetailRow[]> {
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const pos = await db.purchaseOrder.findMany({
    where: Object.keys(dateFilter).length ? { createdAt: dateFilter } : undefined,
    select: {
      id: true, reference: true, type: true, status: true, currency: true,
      subtotalForeign: true, totalForeign: true, totalGbp: true,
      expectedDelivery: true, createdAt: true,
      supplier: { select: { name: true } },
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  return pos.map((po) => ({
    poId: po.id, reference: po.reference, type: po.type, status: po.status,
    supplierName: po.supplier.name, currency: po.currency,
    subtotalForeign: Number(po.subtotalForeign), totalForeign: Number(po.totalForeign),
    totalGbp: Number(po.totalGbp), lineCount: po._count.lines,
    expectedDelivery: po.expectedDelivery?.toISOString() ?? null,
    createdAt: po.createdAt.toISOString(),
  }))
}
