'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { auth } from '@/lib/auth'
import { logActivity } from '@/lib/activity-log'
import { checkRateLimit } from '@/lib/rate-limit'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { assertSupplierOwnsResource, SupplierPortalAccessError } from '@/lib/security/supplier-portal-boundary'
import { applyHeaderOrderDiscount, resolveHeaderOrderDiscountForeign } from '@/lib/domain/purchasing/order-discount'
import { calcRequotedLineAmounts } from '@/lib/domain/purchasing/quote-line-amounts'
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

function roundDecimalString(value: ReturnType<typeof toDecimal>, precision: number): string {
  return roundQuantity(value, precision).toString()
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

  try {
    const po = await db.purchaseOrder.findUnique({
      where: { id: poId },
      select: {
        id: true, supplierId: true, reference: true, status: true, currency: true,
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
    assertSupplierOwnsResource(ctx, po)
    if (!['DRAFT', 'RFQ_SENT'].includes(po.status)) return null

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
  } catch (e) {
    if (e instanceof SupplierPortalAccessError) return null
    throw e
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
      await tx.$queryRaw`
        SELECT id
        FROM purchase_orders
        WHERE id = ${poId}
          AND "supplierId" = ${ctx.supplierId}
        FOR UPDATE
      `
      const lockedPo = await tx.purchaseOrder.findFirst({
        where: { id: poId, supplierId: ctx.supplierId, status: { in: ['DRAFT', 'RFQ_SENT'] } },
        select: {
          id: true, supplierId: true, reference: true, currency: true, fxRateToBase: true,
          discountStr: true, discountAmount: true, pricesIncludeVat: true,
          // o3d-4rp: the order-level fallback rate for lines with no per-line taxRate override,
          // mirroring createPurchaseOrder's orderDefaultCtx.rate.
          taxRatePercent: true,
        },
      })
      if (!lockedPo) throw new Error('RFQ not found or not accessible')
      assertSupplierOwnsResource(ctx, lockedPo)

      const fxRate = toDecimal(lockedPo.fxRateToBase)
      if (!fxRate.gt(0)) {
        throw new Error(`Purchase order ${lockedPo.reference} has no valid FX rate; ask finance to refresh the RFQ before submitting a quote.`)
      }
      const effectiveFxRate = fxRate
      for (const line of safeData.lines) {
        // Verify line belongs to this PO (prevent cross-PO manipulation)
        const poLine = await tx.purchaseOrderLine.findFirst({
          where: { id: line.lineId, poId },
          // o3d-4rp: the line's own rate, falling back to the order rate — the same precedence
          // resolvePurchaseLineTaxRates gives createPurchaseOrder.
          select: { id: true, taxRate: { select: { rate: true } } },
        })
        if (!poLine) continue

        // o3d-4rp: RECOMPUTE THE LINE TAX ON THE REQUOTED PRICE. Previously qty/unitCost/total were
        // rewritten here and taxForeign/taxBase were left at the ORIGINAL RFQ prices, then summed
        // into the PO tax totals and consumed by the o3d-lx1 header-discount split. See
        // calcRequotedLineAmounts for the conventions.
        const amounts = calcRequotedLineAmounts({
          qty: line.qty,
          quotedUnitPriceForeign: line.unitPrice,
          taxRate: poLine.taxRate?.rate ?? lockedPo.taxRatePercent ?? 0,
          pricesIncludeVat: lockedPo.pricesIncludeVat,
          fxRateToBase: effectiveFxRate,
        })

        await tx.purchaseOrderLine.update({
          where: { id: line.lineId },
          data: {
            qty: roundDecimalString(toDecimal(line.qty), 4),
            unitCostForeign: roundDecimalString(amounts.unitCostForeign, 6),
            unitCostBase: roundDecimalString(amounts.unitCostBase, 6),
            totalForeign: roundDecimalString(amounts.totalForeign, 4),
            totalBase: roundDecimalString(amounts.totalBase, 4),
            taxForeign: roundDecimalString(amounts.taxForeign, 4),
            taxBase: roundDecimalString(amounts.taxBase, 4),
          },
        })
      }

      const updatedLines = await tx.purchaseOrderLine.findMany({
        where: { poId },
        select: { totalForeign: true, totalBase: true, taxForeign: true, taxBase: true },
      })
      const grossSubtotalForeign = updatedLines.reduce((sum, line) => sum.add(line.totalForeign), toDecimal(0))
      const grossSubtotalBase = updatedLines.reduce((sum, line) => sum.add(line.totalBase), toDecimal(0))
      const grossTaxForeign = updatedLines.reduce((sum, line) => sum.add(line.taxForeign), toDecimal(0))
      const grossTaxBase = updatedLines.reduce((sum, line) => sum.add(line.taxBase), toDecimal(0))
      const shippingForeign = toDecimal(safeData.shippingCost)
      const shippingBase = shippingForeign.div(effectiveFxRate)

      // o3d-lx1: reapply the RFQ's header discount to the requoted subtotal instead of leaving
      // discountAmount orphaned (which overstated subtotalBase/totalBase). A percentage discount
      // (discountStr like "10%") scales with the new prices; a fixed amount is kept (capped). The same
      // net/VAT split as createPurchaseOrder is applied so subtotalBase/taxBase/totalBase stay consistent.
      // Reapply in the SAME VAT convention the PO was created in (persisted per o3d-lx1), so a FIXED
      // inclusive-VAT discount is treated as gross — not re-grossed-up as if it were net. Existing RFQs
      // predating the column default to false (net), the typical purchase-order convention.
      const inclVat = lockedPo.pricesIncludeVat
      const orderDiscountForeign = resolveHeaderOrderDiscountForeign({
        discountStr: lockedPo.discountStr,
        originalDiscountForeign: Number(lockedPo.discountAmount ?? 0),
        subtotalForeign: grossSubtotalForeign.toNumber(),
        taxForeign: grossTaxForeign.toNumber(),
        inclVat,
      })
      const netted = applyHeaderOrderDiscount({
        subtotalForeign: grossSubtotalForeign.toNumber(),
        subtotalBase: grossSubtotalBase.toNumber(),
        taxForeign: grossTaxForeign.toNumber(),
        taxBase: grossTaxBase.toNumber(),
        orderDiscountForeign,
        inclVat,
        fxRate: effectiveFxRate.toNumber(),
      })
      const subtotalForeign = toDecimal(netted.subtotalForeign)
      const subtotalBase = toDecimal(netted.subtotalBase)
      const taxForeign = toDecimal(netted.taxForeign)
      const taxBase = toDecimal(netted.taxBase)

      const updated = await tx.purchaseOrder.updateMany({
        where: { id: poId, supplierId: ctx.supplierId, status: { in: ['DRAFT', 'RFQ_SENT'] } },
        data: {
          subtotalForeign: roundDecimalString(subtotalForeign, 4),
          subtotalBase: roundDecimalString(subtotalBase, 4),
          taxForeign: roundDecimalString(taxForeign, 4),
          taxBase: roundDecimalString(taxBase, 4),
          totalForeign: roundDecimalString(subtotalForeign.add(taxForeign).add(shippingForeign), 4),
          totalBase: roundDecimalString(subtotalBase.add(taxBase).add(shippingBase), 4),
          directFreightForeign: roundDecimalString(shippingForeign, 4),
          directFreightBase: roundDecimalString(shippingBase, 4),
          discountAmount: roundDecimalString(toDecimal(orderDiscountForeign), 4),
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
    if (e instanceof SupplierPortalAccessError) return { success: false, error: 'RFQ not found or not accessible' }
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
    assertSupplierOwnsResource(ctx, link)

    await logActivity({
      entityType: 'PRODUCT', entityId: productId, action: 'supplier_edit_proposed', tag: 'inventory', level: 'INFO',
      description: `Supplier proposed edits for SKU ${link.product.sku}`,
      metadata: { supplierId: ctx.supplierId, proposedChanges: safeData },
    })
    revalidatePath('/supplier/products')
    return { success: true }
  } catch (e) {
    if (e instanceof SupplierPortalAccessError) return { success: false, error: 'Product not accessible' }
    return { success: false, error: String(e) }
  }
}
