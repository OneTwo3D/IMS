'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { auth } from '@/lib/auth'
import { logActivity } from '@/lib/activity-log'
import { checkRateLimit } from '@/lib/rate-limit'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Auth helper — get supplier ID from session
// ---------------------------------------------------------------------------

async function requireSupplier(): Promise<{ userId: string; supplierId: string } | null> {
  const session = await auth()
  if (!session?.user || session.user.role !== 'SUPPLIER' || !session.user.supplierId) return null
  return { userId: session.user.id, supplierId: session.user.supplierId }
}

function sanitizeSupplierRef(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 120)
}

const supplierQuoteSchema = z.object({
  supplierRef: z.string().trim().min(1).max(120),
  expectedDelivery: z.string()
    .trim()
    .max(40)
    .refine((value) => value === '' || !Number.isNaN(Date.parse(value)), 'Expected delivery must be a valid date')
    .optional()
    .default(''),
  shippingCost: z.number().finite().min(0).max(1_000_000),
  shippingMethod: z.string()
    .trim()
    .max(160)
    .regex(/^[\p{L}\p{N}\s.,'’()/_+-]*$/u, 'Shipping method contains unsupported characters')
    .optional()
    .default(''),
  lines: z.array(z.object({
    lineId: z.string().min(1),
    unitPrice: z.number().finite().min(0).max(1_000_000),
    qty: z.number().finite().positive().max(1_000_000),
  })).max(500),
})

const supplierProductEditSchema = z.object({
  name: z.string().trim().max(160).optional(),
  description: z.string().trim().max(5000).optional(),
  supplierSku: z.string()
    .trim()
    .max(120)
    .regex(/^[A-Za-z0-9._:/#@+ -]*$/, 'Supplier SKU contains unsupported characters')
    .optional(),
})

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
  lifecycleStatus: ProductLifecycleStatus
}

export async function getSupplierProducts(): Promise<SupplierProductRow[]> {
  const ctx = await requireSupplier()
  if (!ctx) return []

  const links = await db.supplierProduct.findMany({
    where: { supplierId: ctx.supplierId },
    select: {
      supplierSku: true,
      product: {
        select: { id: true, sku: true, name: true, description: true, imageUrl: true, parent: { select: { imageUrl: true } }, lifecycleStatus: true },
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
    lifecycleStatus: l.product.lifecycleStatus,
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
          id: true, qty: true, productId: true,
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
      supplierSku: spMap.get(l.productId) ?? null,
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
    const rl = await checkRateLimit(`supplier-quote:${ctx.supplierId}`, 20, 5 * 60_000)
    if (!rl.allowed) return { success: false, error: `Too many quote updates. Try again in ${rl.retryAfterSec}s.` }

    const parsed = supplierQuoteSchema.safeParse(data)
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid quote data' }
    const safeData = parsed.data
    const supplierRef = sanitizeSupplierRef(safeData.supplierRef)
    if (!supplierRef) return { success: false, error: 'Supplier reference is required' }

    const po = await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT id
        FROM purchase_orders
        WHERE id = ${poId}
          AND "supplierId" = ${ctx.supplierId}
        FOR UPDATE
      `
      const lockedPo = await tx.purchaseOrder.findFirst({
        where: { id: poId, supplierId: ctx.supplierId, status: { in: ['DRAFT', 'RFQ_SENT'] } },
        select: { id: true, reference: true, currency: true, fxRateToBase: true },
      })
      if (!lockedPo) throw new Error('RFQ not found or not accessible')

      const fxRate = Number(lockedPo.fxRateToBase) || 1
      for (const line of safeData.lines) {
        // Verify line belongs to this PO (prevent cross-PO manipulation)
        const poLine = await tx.purchaseOrderLine.findFirst({ where: { id: line.lineId, poId } })
        if (!poLine) continue

        const totalForeign = line.qty * line.unitPrice
        const unitCostBase = Math.round((line.unitPrice / fxRate) * 1000000) / 1000000
        const totalBase = Math.round((totalForeign / fxRate) * 10000) / 10000

        await tx.purchaseOrderLine.update({
          where: { id: line.lineId },
          data: {
            qty: line.qty,
            unitCostForeign: line.unitPrice,
            unitCostBase,
            totalForeign,
            totalBase,
          },
        })
      }

      const updatedLines = await tx.purchaseOrderLine.findMany({
        where: { poId },
        select: { totalForeign: true, totalBase: true, taxForeign: true, taxBase: true },
      })
      const subtotalForeign = updatedLines.reduce((s, l) => s + Number(l.totalForeign), 0)
      const subtotalBase = updatedLines.reduce((s, l) => s + Number(l.totalBase), 0)
      const taxForeign = updatedLines.reduce((s, l) => s + Number(l.taxForeign), 0)
      const taxBase = updatedLines.reduce((s, l) => s + Number(l.taxBase), 0)
      const shippingBase = Math.round((safeData.shippingCost / fxRate) * 10000) / 10000

      const updated = await tx.purchaseOrder.updateMany({
        where: { id: poId, supplierId: ctx.supplierId, status: { in: ['DRAFT', 'RFQ_SENT'] } },
        data: {
          subtotalForeign,
          subtotalBase,
          taxForeign,
          taxBase,
          totalForeign: subtotalForeign + taxForeign + safeData.shippingCost,
          totalBase: subtotalBase + taxBase + shippingBase,
          directFreightForeign: safeData.shippingCost,
          directFreightBase: shippingBase,
          supplierRef,
          expectedDelivery: safeData.expectedDelivery ? new Date(safeData.expectedDelivery) : null,
          notes: safeData.shippingMethod ? `Shipping: ${safeData.shippingMethod}` : undefined,
          // Admin review is still required before a binding PO is sent.
          status: 'QUOTE_RECEIVED',
          poSentAt: null,
        },
      })
      if (updated.count === 0) throw new Error('RFQ status changed while quote was being submitted')
      return lockedPo
    })

    revalidatePath('/supplier/rfqs')
    revalidatePath('/supplier/orders')
    await logActivity({
      entityType: 'PURCHASE_ORDER', entityId: poId, action: 'supplier_quoted', tag: 'purchase', level: 'INFO',
      description: `Supplier submitted quote for ${po.reference} — ref: ${supplierRef}`,
      metadata: { supplierRef, shippingCost: safeData.shippingCost },
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

    const parsed = supplierProductEditSchema.safeParse(data)
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid product edit data' }
    const safeData = parsed.data

    // Verify product belongs to this supplier
    const link = await db.supplierProduct.findUnique({
      where: { supplierId_productId: { supplierId: ctx.supplierId, productId } },
      include: { product: { select: { sku: true } } },
    })
    if (!link) return { success: false, error: 'Product not accessible' }

    await logActivity({
      entityType: 'PRODUCT', entityId: productId, action: 'supplier_edit_proposed', tag: 'inventory', level: 'INFO',
      description: `Supplier proposed edits for SKU ${link.product.sku}`,
      metadata: { supplierId: ctx.supplierId, proposedChanges: safeData },
    })
    revalidatePath('/supplier/products')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
