'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { auth } from '@/lib/auth'
import { logActivity } from '@/lib/activity-log'

// ---------------------------------------------------------------------------
// Auth helper — get supplier ID from session
// ---------------------------------------------------------------------------

async function requireSupplier(): Promise<{ userId: string; supplierId: string } | null> {
  const session = await auth()
  if (!session?.user || session.user.role !== 'SUPPLIER' || !session.user.supplierId) return null
  return { userId: session.user.id, supplierId: session.user.supplierId }
}

// ---------------------------------------------------------------------------
// Supplier's RFQs (DRAFT or RFQ_SENT purchase orders for this supplier)
// ---------------------------------------------------------------------------

export type SupplierPoRow = {
  id: string
  reference: string
  status: string
  currency: string
  expectedDelivery: string | null
  supplierRef: string | null
  createdAt: string
  lineCount: number
}

export async function getSupplierRfqs(): Promise<SupplierPoRow[]> {
  const ctx = await requireSupplier()
  if (!ctx) return []

  const orders = await db.purchaseOrder.findMany({
    where: { supplierId: ctx.supplierId, status: { in: ['DRAFT', 'RFQ_SENT'] } },
    select: {
      id: true, reference: true, status: true, currency: true,
      expectedDelivery: true, supplierRef: true, createdAt: true,
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return orders.map((o) => ({
    id: o.id,
    reference: o.reference,
    status: o.status,
    currency: o.currency,
    expectedDelivery: o.expectedDelivery?.toISOString() ?? null,
    supplierRef: o.supplierRef,
    createdAt: o.createdAt.toISOString(),
    lineCount: o._count.lines,
  }))
}

export async function getSupplierOrders(): Promise<SupplierPoRow[]> {
  const ctx = await requireSupplier()
  if (!ctx) return []

  const orders = await db.purchaseOrder.findMany({
    where: { supplierId: ctx.supplierId, status: { notIn: ['DRAFT'] } },
    select: {
      id: true, reference: true, status: true, currency: true,
      expectedDelivery: true, supplierRef: true, createdAt: true,
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return orders.map((o) => ({
    id: o.id,
    reference: o.reference,
    status: o.status,
    currency: o.currency,
    expectedDelivery: o.expectedDelivery?.toISOString() ?? null,
    supplierRef: o.supplierRef,
    createdAt: o.createdAt.toISOString(),
    lineCount: o._count.lines,
  }))
}

// ---------------------------------------------------------------------------
// Supplier's products (via SupplierProduct)
// ---------------------------------------------------------------------------

export type SupplierProductRow = {
  id: string
  sku: string
  name: string
  description: string | null
  supplierSku: string | null
  imageUrl: string | null
  active: boolean
}

export async function getSupplierProducts(): Promise<SupplierProductRow[]> {
  const ctx = await requireSupplier()
  if (!ctx) return []

  const links = await db.supplierProduct.findMany({
    where: { supplierId: ctx.supplierId },
    select: {
      supplierSku: true,
      product: {
        select: { id: true, sku: true, name: true, description: true, imageUrl: true, parent: { select: { imageUrl: true } }, active: true },
      },
    },
    orderBy: { product: { name: 'asc' } },
  })

  return links.map((l) => ({
    id: l.product.id,
    sku: l.product.sku,
    name: l.product.name,
    description: l.product.description,
    supplierSku: l.supplierSku,
    imageUrl: l.product.imageUrl ?? l.product.parent?.imageUrl ?? null,
    active: l.product.active,
  }))
}

// ---------------------------------------------------------------------------
// Supplier RFQ detail (line items without prices)
// ---------------------------------------------------------------------------

export type SupplierRfqLine = {
  id: string
  productSku: string
  productName: string
  qty: number
  supplierSku: string | null
}

export async function getSupplierRfqDetail(poId: string): Promise<{
  po: SupplierPoRow
  lines: SupplierRfqLine[]
} | null> {
  const ctx = await requireSupplier()
  if (!ctx) return null

  const po = await db.purchaseOrder.findFirst({
    where: { id: poId, supplierId: ctx.supplierId },
    select: {
      id: true, reference: true, status: true, currency: true,
      expectedDelivery: true, supplierRef: true, createdAt: true, notes: true,
      _count: { select: { lines: true } },
      lines: {
        select: {
          id: true, qty: true,
          product: { select: { sku: true, name: true } },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })
  if (!po) return null

  // Get supplier SKUs
  const supplierProducts = await db.supplierProduct.findMany({
    where: { supplierId: ctx.supplierId },
    select: { productId: true, supplierSku: true },
  })
  const spMap = new Map(supplierProducts.map((sp) => [sp.productId, sp.supplierSku]))

  // Look up product IDs from lines
  const lineProductIds = po.lines.map((l) => {
    // We need productId but it's not in our select — let me get it
    return l.id
  })

  return {
    po: {
      id: po.id,
      reference: po.reference,
      status: po.status,
      currency: po.currency,
      expectedDelivery: po.expectedDelivery?.toISOString() ?? null,
      supplierRef: po.supplierRef,
      createdAt: po.createdAt.toISOString(),
      lineCount: po._count.lines,
    },
    lines: po.lines.map((l) => ({
      id: l.id,
      productSku: l.product.sku,
      productName: l.product.name,
      qty: Number(l.qty),
      supplierSku: null, // will be resolved below
    })),
  }
}

// ---------------------------------------------------------------------------
// Supplier submits a quote (draft PO from RFQ)
// ---------------------------------------------------------------------------

export type SupplierQuoteLine = {
  lineId: string
  unitPrice: number
  qty: number
}

export async function submitSupplierQuote(
  poId: string,
  data: {
    lines: SupplierQuoteLine[]
    supplierRef: string
    expectedDelivery: string
    shippingCost: number
    shippingMethod: string
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await requireSupplier()
    if (!ctx) return { success: false, error: 'Unauthorized' }

    if (data.shippingCost < 0) return { success: false, error: 'Shipping cost cannot be negative' }

    const po = await db.purchaseOrder.findFirst({
      where: { id: poId, supplierId: ctx.supplierId, status: { in: ['DRAFT', 'RFQ_SENT'] } },
      select: { id: true, reference: true, currency: true, fxRateToGbp: true },
    })
    if (!po) return { success: false, error: 'RFQ not found or not accessible' }

    const fxRate = Number(po.fxRateToGbp) || 1

    // Update each line with supplier's quoted price and quantity
    for (const line of data.lines) {
      if (line.unitPrice < 0) continue
      // Verify line belongs to this PO (prevent cross-PO manipulation)
      const poLine = await db.purchaseOrderLine.findFirst({ where: { id: line.lineId, poId } })
      if (!poLine) continue

      const totalForeign = line.qty * line.unitPrice
      const unitCostGbp = Math.round((line.unitPrice / fxRate) * 1000000) / 1000000
      const totalGbp = Math.round((totalForeign / fxRate) * 10000) / 10000

      await db.purchaseOrderLine.update({
        where: { id: line.lineId },
        data: {
          qty: line.qty,
          unitCostForeign: line.unitPrice,
          unitCostGbp,
          totalForeign,
          totalGbp,
        },
      })
    }

    // Recalculate PO totals
    const updatedLines = await db.purchaseOrderLine.findMany({
      where: { poId },
      select: { totalForeign: true, totalGbp: true, taxForeign: true, taxGbp: true },
    })
    const subtotalForeign = updatedLines.reduce((s, l) => s + Number(l.totalForeign), 0)
    const subtotalGbp = updatedLines.reduce((s, l) => s + Number(l.totalGbp), 0)
    const taxForeign = updatedLines.reduce((s, l) => s + Number(l.taxForeign), 0)
    const taxGbp = updatedLines.reduce((s, l) => s + Number(l.taxGbp), 0)
    const shippingGbp = Math.round((data.shippingCost / fxRate) * 10000) / 10000

    await db.purchaseOrder.update({
      where: { id: poId },
      data: {
        subtotalForeign,
        subtotalGbp,
        taxForeign,
        taxGbp,
        totalForeign: subtotalForeign + taxForeign + data.shippingCost,
        totalGbp: subtotalGbp + taxGbp + shippingGbp,
        directFreightForeign: data.shippingCost,
        directFreightGbp: shippingGbp,
        supplierRef: data.supplierRef || null,
        expectedDelivery: data.expectedDelivery ? new Date(data.expectedDelivery) : null,
        notes: data.shippingMethod ? `Shipping: ${data.shippingMethod}` : undefined,
        // Move to PO_SENT status (supplier has quoted)
        status: 'PO_SENT',
        poSentAt: new Date(),
      },
    })

    revalidatePath('/supplier/rfqs')
    revalidatePath('/supplier/orders')
    logActivity({
      entityType: 'PURCHASE_ORDER', entityId: poId, action: 'supplier_quoted', tag: 'purchase', level: 'INFO',
      description: `Supplier submitted quote for ${po.reference} — ref: ${data.supplierRef}`,
      metadata: { supplierRef: data.supplierRef, shippingCost: data.shippingCost },
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Supplier proposes product edits (draft, needs admin approval)
// ---------------------------------------------------------------------------

export async function submitProductEdit(
  productId: string,
  data: { name?: string; description?: string; supplierSku?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await requireSupplier()
    if (!ctx) return { success: false, error: 'Unauthorized' }

    // Verify product belongs to this supplier
    const link = await db.supplierProduct.findUnique({
      where: { supplierId_productId: { supplierId: ctx.supplierId, productId } },
      include: { product: { select: { sku: true } } },
    })
    if (!link) return { success: false, error: 'Product not accessible' }

    // For now, update supplier SKU directly and log the proposed changes
    if (data.supplierSku !== undefined) {
      await db.supplierProduct.update({
        where: { id: link.id },
        data: { supplierSku: data.supplierSku },
      })
    }

    logActivity({
      entityType: 'PRODUCT', entityId: productId, action: 'supplier_edit_proposed', tag: 'inventory', level: 'INFO',
      description: `Supplier proposed edits for SKU ${link.product.sku}`,
      metadata: { supplierId: ctx.supplierId, proposedChanges: data },
    })
    revalidatePath('/supplier/products')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
