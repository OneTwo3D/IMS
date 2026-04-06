'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SoStatus =
  | 'DRAFT' | 'PENDING_PAYMENT' | 'ON_HOLD'
  | 'PROCESSING' | 'ALLOCATED' | 'PICKING' | 'PACKING'
  | 'SHIPPED' | 'COMPLETED' | 'DELIVERED'
  | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_REFUNDED'

export type SoLineRow = {
  id: string
  productId: string | null
  sku: string
  description: string
  qty: number
  unitPriceForeign: number  // original price before discount
  unitPriceGbp: number
  discountStr: string | null
  discountAmount: number
  taxForeign: number
  taxGbp: number
  totalForeign: number
  totalGbp: number
  cogsGbp: number | null
}

export type SoRow = {
  id: string
  wcOrderId: number | null
  wcOrderNumber: string | null
  status: SoStatus
  currency: string
  fxRateToGbp: number
  customerName: string | null
  customerEmail: string | null
  subtotalForeign: number
  shippingService: string | null
  shippingForeign: number
  taxRateName: string | null
  taxRatePercent: number | null
  taxForeign: number
  totalForeign: number
  totalGbp: number
  shipFromWarehouseId: string | null
  shipFromWarehouseName: string | null
  expectedDelivery: string | null
  salesRep: string | null
  trackingNumber: string | null
  shippedAt: string | null
  discountStr: string | null
  discountAmount: number
  invoiceNumber: string | null
  invoicedAt: string | null
  paidAt: string | null
  notes: string | null
  internalNotes: string | null
  createdAt: string
  lineCount: number
}

export type SoDetail = SoRow & {
  billingAddress: unknown
  shippingAddress: unknown
  lines: SoLineRow[]
  refunds: {
    id: string
    creditNoteNumber: string | null
    reason: string | null
    totalForeign: number
    totalGbp: number
    refundedAt: string
    payments: PaymentRow[]
    lines: {
      id: string
      productId: string | null
      description: string
      qty: number
      totalGbp: number
    }[]
  }[]
  payments: PaymentRow[]
}

export type SoLineInput = {
  productId: string
  sku: string
  description: string
  qty: number
  unitPriceForeign: number
}

export type CreateSoInput = {
  customerId?: string
  customerName: string
  customerEmail?: string
  billingAddress?: unknown
  shippingAddress?: unknown
  currency: string
  fxRateToGbp: number
  shipFromWarehouseId?: string
  expectedDelivery?: string
  salesRep?: string
  notes?: string
  internalNotes?: string
  shippingService?: string
  shippingForeign?: number
  taxRateName?: string
  taxRateValue?: number
  pricesIncludeVat?: boolean
  fees?: { description: string; amount: number }[]
  orderDiscountForeign?: number
  orderDiscountStr?: string
  lines: (SoLineInput & { discountStr?: string; discountAmount?: number })[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReference(): string {
  const now = new Date()
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `SO-${ymd}-${rand}`
}

const SO_SELECT = {
  id: true,
  wcOrderId: true,
  wcOrderNumber: true,
  status: true,
  currency: true,
  fxRateToGbp: true,
  customerName: true,
  customerEmail: true,
  subtotalForeign: true,
  shippingService: true,
  shippingForeign: true,
  taxRateName: true,
  taxRatePercent: true,
  taxForeign: true,
  totalForeign: true,
  totalGbp: true,
  shipFromWarehouseId: true,
  shipFromWarehouse: { select: { name: true } },
  expectedDelivery: true,
  salesRep: true,
  trackingNumber: true,
  shippedAt: true,
  discountStr: true,
  discountAmount: true,
  invoiceNumber: true,
  invoicedAt: true,
  paidAt: true,
  notes: true,
  internalNotes: true,
  createdAt: true,
  _count: { select: { lines: true } },
} as const

function mapSoRow(so: {
  id: string
  wcOrderId: number | null
  wcOrderNumber: string | null
  status: string
  currency: string
  fxRateToGbp: unknown
  customerName: string | null
  customerEmail: string | null
  subtotalForeign: unknown
  shippingService: string | null
  shippingForeign: unknown
  taxRateName: string | null
  taxRatePercent: unknown
  taxForeign: unknown
  totalForeign: unknown
  totalGbp: unknown
  shipFromWarehouseId: string | null
  shipFromWarehouse: { name: string } | null
  expectedDelivery: Date | null
  salesRep: string | null
  trackingNumber: string | null
  shippedAt: Date | null
  discountStr: string | null
  discountAmount: unknown
  invoiceNumber: string | null
  invoicedAt: Date | null
  paidAt: Date | null
  notes: string | null
  internalNotes: string | null
  createdAt: Date
  _count: { lines: number }
}): SoRow {
  return {
    id: so.id,
    wcOrderId: so.wcOrderId,
    wcOrderNumber: so.wcOrderNumber,
    status: so.status as SoStatus,
    currency: so.currency,
    fxRateToGbp: Number(so.fxRateToGbp),
    customerName: so.customerName,
    customerEmail: so.customerEmail,
    subtotalForeign: Number(so.subtotalForeign),
    shippingService: so.shippingService,
    shippingForeign: Number(so.shippingForeign),
    taxRateName: so.taxRateName,
    taxRatePercent: so.taxRatePercent != null ? Number(so.taxRatePercent) : null,
    taxForeign: Number(so.taxForeign),
    totalForeign: Number(so.totalForeign),
    totalGbp: Number(so.totalGbp),
    shipFromWarehouseId: so.shipFromWarehouseId,
    shipFromWarehouseName: so.shipFromWarehouse?.name ?? null,
    expectedDelivery: so.expectedDelivery?.toISOString() ?? null,
    salesRep: so.salesRep,
    trackingNumber: so.trackingNumber,
    shippedAt: so.shippedAt?.toISOString() ?? null,
    discountStr: so.discountStr,
    discountAmount: Number(so.discountAmount),
    invoiceNumber: so.invoiceNumber,
    invoicedAt: so.invoicedAt?.toISOString() ?? null,
    paidAt: so.paidAt?.toISOString() ?? null,
    notes: so.notes,
    internalNotes: so.internalNotes,
    createdAt: so.createdAt.toISOString(),
    lineCount: so._count.lines,
  }
}

function mapLine(l: {
  id: string
  productId: string | null
  sku: string | null
  description: string
  qty: unknown
  unitPriceForeign: unknown
  unitPriceGbp: unknown
  discountStr: string | null
  discountAmount: unknown
  taxForeign: unknown
  taxGbp: unknown
  totalForeign: unknown
  totalGbp: unknown
  cogsGbp: unknown
}): SoLineRow {
  return {
    id: l.id,
    productId: l.productId,
    sku: l.sku ?? '',
    description: l.description,
    qty: Number(l.qty),
    unitPriceForeign: Number(l.unitPriceForeign),
    unitPriceGbp: Number(l.unitPriceGbp),
    discountStr: l.discountStr ?? null,
    discountAmount: Number(l.discountAmount ?? 0),
    taxForeign: Number(l.taxForeign),
    taxGbp: Number(l.taxGbp),
    totalForeign: Number(l.totalForeign),
    totalGbp: Number(l.totalGbp),
    cogsGbp: l.cogsGbp != null ? Number(l.cogsGbp) : null,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getSalesOrders(limit = 200): Promise<SoRow[]> {
  const orders = await db.salesOrder.findMany({
    select: SO_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return orders.map(mapSoRow)
}

export async function getSalesOrder(id: string): Promise<SoDetail | null> {
  const so = await db.salesOrder.findUnique({
    where: { id },
    select: {
      ...SO_SELECT,
      billingAddress: true,
      shippingAddress: true,
      lines: {
        select: {
          id: true, productId: true, sku: true, description: true,
          qty: true, unitPriceForeign: true, unitPriceGbp: true, discountStr: true, discountAmount: true,
          taxForeign: true, taxGbp: true, totalForeign: true, totalGbp: true,
          cogsGbp: true,
        },
      },
      refunds: {
        select: {
          id: true, creditNoteNumber: true, reason: true, totalForeign: true, totalGbp: true, refundedAt: true,
          lines: {
            select: { id: true, productId: true, description: true, qty: true, totalGbp: true },
          },
          payments: {
            select: { id: true, amount: true, currency: true, method: true, reference: true, notes: true, paidAt: true },
            orderBy: { paidAt: 'desc' },
          },
        },
        orderBy: { refundedAt: 'desc' },
      },
      payments: {
        select: { id: true, refundId: true, amount: true, currency: true, method: true, reference: true, notes: true, paidAt: true },
        orderBy: { paidAt: 'desc' },
      },
    },
  })
  if (!so) return null

  return {
    ...mapSoRow(so),
    billingAddress: so.billingAddress,
    shippingAddress: so.shippingAddress,
    lines: so.lines.map(mapLine),
    refunds: so.refunds.map((r) => ({
      id: r.id,
      creditNoteNumber: r.creditNoteNumber,
      reason: r.reason,
      totalForeign: Number(r.totalForeign),
      totalGbp: Number(r.totalGbp),
      refundedAt: r.refundedAt.toISOString(),
      payments: (r.payments ?? []).map((p) => ({
        id: p.id, refundId: r.id, creditNoteNumber: r.creditNoteNumber,
        amount: Number(p.amount), currency: p.currency, method: p.method, reference: p.reference, notes: p.notes, paidAt: p.paidAt.toISOString(),
      })),
      lines: r.lines.map((rl) => ({
        id: rl.id,
        productId: rl.productId,
        description: rl.description,
        qty: Number(rl.qty),
        totalGbp: Number(rl.totalGbp),
      })),
    })),
    payments: so.payments.map((p) => ({
      id: p.id, refundId: p.refundId, creditNoteNumber: null,
      amount: Number(p.amount), currency: p.currency, method: p.method, reference: p.reference, notes: p.notes, paidAt: p.paidAt.toISOString(),
    })),
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createSalesOrder(input: CreateSoInput): Promise<{ success: boolean; order?: SoRow; error?: string }> {
  try {
    if (!input.lines.length) return { success: false, error: 'Add at least one line item' }
    if (!input.customerName?.trim()) return { success: false, error: 'Customer name is required' }
    for (const l of input.lines) {
      if (l.qty <= 0) return { success: false, error: `Invalid qty for ${l.sku}` }
      if (l.unitPriceForeign < 0) return { success: false, error: `Negative price for ${l.sku}` }
    }

    const fxRate = input.fxRateToGbp && input.fxRateToGbp > 0 ? input.fxRateToGbp : 1
    const vatRate = input.taxRateValue ?? 0
    const inclVat = input.pricesIncludeVat && vatRate > 0
    let subtotalForeign = 0
    let subtotalGbp = 0
    let totalTaxForeign = 0
    let totalTaxGbp = 0

    const lineData = input.lines.map((l) => {
      const discAmt = l.discountAmount ?? 0
      const grossLine = l.qty * l.unitPriceForeign - discAmt // original price * qty - discount
      const netForeign = inclVat ? grossLine / (1 + vatRate) : grossLine
      const unitPriceGbp = Math.round((l.unitPriceForeign / fxRate) * 1000000) / 1000000
      const totalForeign = Math.round(netForeign * 10000) / 10000
      const totalGbp = Math.round((totalForeign / fxRate) * 10000) / 10000
      const lineTax = inclVat ? grossLine - netForeign : netForeign * vatRate
      const lineTaxForeign = Math.round(lineTax * 10000) / 10000
      const lineTaxGbp = Math.round((lineTaxForeign / fxRate) * 10000) / 10000
      subtotalForeign += totalForeign
      subtotalGbp += totalGbp
      totalTaxForeign += lineTaxForeign
      totalTaxGbp += lineTaxGbp
      return {
        productId: l.productId,
        sku: l.sku,
        description: l.description,
        qty: l.qty,
        unitPriceForeign: l.unitPriceForeign, // store ORIGINAL price
        unitPriceGbp,
        discountStr: l.discountStr || null,
        discountAmount: discAmt,
        taxForeign: lineTaxForeign,
        taxGbp: lineTaxGbp,
        totalForeign,
        totalGbp,
      }
    })

    // Shipping
    const shippingForeign = input.shippingForeign ?? 0
    const shippingGbp = Math.round((shippingForeign / fxRate) * 10000) / 10000

    // Additional fees → add to shipping (stored in shippingForeign)
    let feesTotalForeign = 0
    if (input.fees?.length) {
      for (const f of input.fees) feesTotalForeign += f.amount
    }
    const totalShippingForeign = shippingForeign + feesTotalForeign
    const totalShippingGbp = Math.round((totalShippingForeign / fxRate) * 10000) / 10000

    // VAT on shipping/fees
    if (vatRate > 0) {
      const shippingTax = inclVat
        ? totalShippingForeign - totalShippingForeign / (1 + vatRate)
        : totalShippingForeign * vatRate
      totalTaxForeign += Math.round(shippingTax * 10000) / 10000
      totalTaxGbp += Math.round((shippingTax / fxRate) * 10000) / 10000
    }

    // Order-level discount — cap at subtotal to prevent negative totals
    const orderDiscForeign = Math.min(input.orderDiscountForeign ?? 0, subtotalForeign)
    const orderDiscGbp = Math.round((orderDiscForeign / fxRate) * 10000) / 10000
    // Reduce subtotal by order discount (already net if inclVat)
    const discNetForeign = inclVat ? orderDiscForeign / (1 + vatRate) : orderDiscForeign
    const discNetGbp = Math.round((discNetForeign / fxRate) * 10000) / 10000
    subtotalForeign -= discNetForeign
    subtotalGbp -= discNetGbp
    if (vatRate > 0) {
      const discTax = inclVat ? orderDiscForeign - discNetForeign : discNetForeign * vatRate
      totalTaxForeign -= Math.round(discTax * 10000) / 10000
      totalTaxGbp -= Math.round((discTax / fxRate) * 10000) / 10000
    }

    const grandTotalForeign = subtotalForeign + totalTaxForeign + totalShippingForeign
    const grandTotalGbp = subtotalGbp + totalTaxGbp + totalShippingGbp

    const so = await db.salesOrder.create({
      data: {
        wcOrderNumber: makeReference(),
        status: 'DRAFT',
        currency: input.currency,
        fxRateToGbp: fxRate,
        customerId: input.customerId || null,
        customerName: input.customerName,
        customerEmail: input.customerEmail || null,
        billingAddress: input.billingAddress ?? undefined,
        shippingAddress: input.shippingAddress ?? undefined,
        subtotalForeign,
        shippingService: input.shippingService || null,
        shippingForeign: totalShippingForeign,
        taxRateName: input.taxRateName || null,
        taxRatePercent: vatRate > 0 ? vatRate : null,
        taxForeign: totalTaxForeign,
        totalForeign: grandTotalForeign,
        subtotalGbp,
        shippingGbp: totalShippingGbp,
        taxGbp: totalTaxGbp,
        totalGbp: grandTotalGbp,
        shipFromWarehouseId: input.shipFromWarehouseId || null,
        expectedDelivery: input.expectedDelivery ? new Date(input.expectedDelivery) : null,
        salesRep: input.salesRep || null,
        discountStr: input.orderDiscountStr || null,
        discountAmount: input.orderDiscountForeign ?? 0,
        notes: input.notes || null,
        internalNotes: input.internalNotes || null,
        lines: { create: lineData },
      },
      select: SO_SELECT,
    })

    // Auto-allocate stock across warehouses
    const { autoAllocateOrder } = await import('./allocation')
    await autoAllocateOrder(so.id)

    revalidatePath('/sales')
    const mapped = mapSoRow(so)
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'created',
      tag: 'sales',
      level: 'INFO',
      description: `Created sales order ${mapped.wcOrderNumber}`,
      metadata: { orderNumber: mapped.wcOrderNumber, totalGbp: mapped.totalGbp, currency: mapped.currency },
    })
    return { success: true, order: mapped }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: null,
      action: 'created',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to create sales order: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

/** Release reserved stock for all lines of an order */
async function releaseReservedStock(orderId: string, warehouseId: string, lines: { productId: string | null; qty: unknown }[]) {
  for (const line of lines) {
    if (!line.productId) continue
    const qty = Number(line.qty)
    await db.stockLevel.updateMany({
      where: { productId: line.productId, warehouseId },
      data: { reservedQty: { decrement: qty } },
    })
  }
  logActivity({
    entityType: 'STOCK_ADJUSTMENT',
    entityId: orderId,
    action: 'reservation_released',
    tag: 'stock',
    level: 'INFO',
    description: `Released reserved stock for order ${orderId}`,
    metadata: { orderId, warehouseId },
  })
}

export async function updateSalesOrderStatus(
  id: string,
  targetStatus: SoStatus,
  extra?: { trackingNumber?: string; shipFromWarehouseId?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    const so = await db.salesOrder.findUnique({
      where: { id },
      select: { id: true, wcOrderId: true, wcOrderNumber: true, status: true, shipFromWarehouseId: true, lines: { select: { id: true, productId: true, sku: true, qty: true } } },
    })
    if (!so) return { success: false, error: 'Order not found' }

    // Valid status transitions
    const VALID_TRANSITIONS: Record<string, string[]> = {
      DRAFT: ['PROCESSING', 'PENDING_PAYMENT', 'CANCELLED', 'ON_HOLD'],
      PENDING_PAYMENT: ['PROCESSING', 'DRAFT', 'CANCELLED', 'ON_HOLD'],
      ON_HOLD: ['DRAFT', 'PROCESSING', 'CANCELLED'],
      PROCESSING: ['ALLOCATED', 'CANCELLED', 'ON_HOLD'],
      ALLOCATED: ['PICKING', 'PROCESSING', 'CANCELLED', 'ON_HOLD'],
      PICKING: ['PACKING', 'CANCELLED', 'ON_HOLD'],
      PACKING: ['SHIPPED', 'CANCELLED', 'ON_HOLD'],
      SHIPPED: ['COMPLETED'],
      COMPLETED: ['DELIVERED'],
    }
    const allowed = VALID_TRANSITIONS[so.status] ?? []
    if (!allowed.includes(targetStatus)) {
      return { success: false, error: `Cannot transition from ${so.status} to ${targetStatus}` }
    }

    const data: Record<string, unknown> = { status: targetStatus }

    // On SHIPPED: check if shipments exist (new flow) or use legacy single-warehouse flow
    if (targetStatus === 'SHIPPED') {
      const shipmentCount = await db.shipment.count({ where: { orderId: id } })
      if (shipmentCount > 0) {
        // New multi-shipment flow — shipping is handled per-shipment via updateShipmentStatus
        // This direct SHIPPED transition should only happen when all shipments are already shipped
        const unshipped = await db.shipment.count({ where: { orderId: id, status: { not: 'SHIPPED' } } })
        if (unshipped > 0) {
          return { success: false, error: 'Ship individual shipments first — not all shipments are shipped yet' }
        }
        data.shippedAt = new Date()
        if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
      } else {
        // Legacy single-warehouse flow
        const warehouseId = extra?.shipFromWarehouseId || so.shipFromWarehouseId
        if (!warehouseId) return { success: false, error: 'A warehouse must be selected before shipping' }
        data.shippedAt = new Date()
        if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
        if (extra?.shipFromWarehouseId) data.shipFromWarehouseId = extra.shipFromWarehouseId

        // Release allocations
        const allocs = await db.orderAllocation.findMany({ where: { orderId: id } })
        if (allocs.length > 0) {
          for (const alloc of allocs) {
            await db.stockLevel.updateMany({
              where: { productId: alloc.productId, warehouseId: alloc.warehouseId },
              data: { reservedQty: { decrement: Number(alloc.qty) } },
            })
          }
        } else if (so.shipFromWarehouseId) {
          await releaseReservedStock(id, warehouseId, so.lines)
        }

        for (const line of so.lines) {
          if (!line.productId) continue
          const qty = Number(line.qty)
          await db.stockMovement.create({
            data: {
              type: 'SALE_DISPATCH',
              productId: line.productId,
              fromWarehouseId: warehouseId,
              qty,
              note: `Dispatched for order`,
              referenceType: 'SalesOrder',
              referenceId: id,
            },
          })
          await db.stockLevel.updateMany({
            where: { productId: line.productId, warehouseId },
            data: { quantity: { decrement: qty } },
          })
          logActivity({
            entityType: 'STOCK_ADJUSTMENT',
            entityId: line.productId,
            action: 'dispatched',
            tag: 'stock',
            level: 'INFO',
            description: `Dispatched ${qty} units of SKU ${line.sku ?? line.productId} for order ${so.wcOrderNumber}`,
            metadata: { sku: line.sku, productId: line.productId, qty, orderNumber: so.wcOrderNumber, warehouseId },
          })
        }
      }
    }

    if (targetStatus === 'CANCELLED' && so.status === 'SHIPPED') {
      return { success: false, error: 'Cannot cancel a shipped order — process a refund instead' }
    }

    // On CANCEL: release all allocations
    if (targetStatus === 'CANCELLED') {
      const { deallocateOrder } = await import('./allocation')
      await deallocateOrder(id)
      // Also delete any pending shipments
      await db.shipment.deleteMany({ where: { orderId: id, status: { in: ['PENDING', 'PICKING', 'PACKED'] as const } } })
    }

    await db.salesOrder.update({ where: { id }, data })

    // Auto-generate invoice on ship if configured
    if (targetStatus === 'SHIPPED') {
      const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
      if (trigger?.value === 'on_shipped') {
        await generateInvoiceNumber(id)
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${id}`)
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'status_changed',
      tag: 'sales',
      level: 'INFO',
      description: `Updated sales order ${so.wcOrderNumber} status to ${targetStatus}`,
      metadata: { orderNumber: so.wcOrderNumber, previousStatus: so.status, newStatus: targetStatus },
    })

    // Push status to WooCommerce (fire-and-forget)
    if (so.wcOrderId) {
      import('@/lib/connectors/woocommerce/sync/order-status').then((m) =>
        m.pushImsStatusToWc(id, targetStatus as never).catch(() => {}),
      )
    }

    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'status_changed',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to update sales order status: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function createRefund(
  orderId: string,
  lines: { productId: string | null; description: string; qty: number; totalGbp: number }[],
  reason: string,
  returnWarehouseId?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { id: true, wcOrderNumber: true, status: true, fxRateToGbp: true, totalGbp: true },
    })
    if (!so) return { success: false, error: 'Order not found' }

    const refundLines = lines.filter((l) => l.qty > 0)
    if (!refundLines.length) return { success: false, error: 'Select at least one line to refund' }

    const fxRate = Number(so.fxRateToGbp) || 1
    const totalGbp = refundLines.reduce((s, l) => s + l.totalGbp, 0)

    // Validate refund doesn't exceed order total
    const existingRefunds = await db.salesOrderRefund.findMany({ where: { orderId }, select: { totalGbp: true } })
    const previouslyRefunded = existingRefunds.reduce((s, r) => s + Number(r.totalGbp), 0)
    if (totalGbp + previouslyRefunded > Number(so.totalGbp) * 1.001) { // small tolerance for rounding
      return { success: false, error: 'Refund total would exceed order total' }
    }
    const totalForeign = Math.round(totalGbp * fxRate * 10000) / 10000

    // Generate credit note number
    const cnCount = await db.salesOrderRefund.count({ where: { creditNoteNumber: { not: null } } })
    const creditNoteNumber = `CN-${new Date().getFullYear()}-${String(cnCount + 1).padStart(5, '0')}`

    await db.salesOrderRefund.create({
      data: {
        orderId,
        creditNoteNumber,
        reason: reason || null,
        totalForeign,
        totalGbp,
        returnWarehouseId: returnWarehouseId || null,
        lines: {
          create: refundLines.map((l) => ({
            productId: l.productId,
            description: l.description,
            qty: l.qty,
            unitPriceGbp: l.qty > 0 ? l.totalGbp / l.qty : 0,
            totalGbp: l.totalGbp,
          })),
        },
      },
    })

    // Return stock if warehouse specified
    if (returnWarehouseId) {
      for (const l of refundLines) {
        if (!l.productId) continue
        await db.stockMovement.create({
          data: {
            type: 'RETURN_INBOUND',
            productId: l.productId,
            toWarehouseId: returnWarehouseId,
            qty: l.qty,
            note: `Refund return`,
            referenceType: 'SalesOrder',
            referenceId: orderId,
          },
        })
        await db.stockLevel.upsert({
          where: { productId_warehouseId: { productId: l.productId, warehouseId: returnWarehouseId } },
          create: { productId: l.productId, warehouseId: returnWarehouseId, quantity: l.qty, reservedQty: 0 },
          update: { quantity: { increment: l.qty } },
        })
        logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: l.productId,
          action: 'return_inbound',
          tag: 'stock',
          level: 'INFO',
          description: `Returned ${l.qty} units of ${l.description} to warehouse ${returnWarehouseId} for refund on order ${so.wcOrderNumber}`,
          metadata: { productId: l.productId, qty: l.qty, orderNumber: so.wcOrderNumber, warehouseId: returnWarehouseId },
        })
      }
    }

    // Update order status based on total refunded vs order total
    const totalRefundedNow = previouslyRefunded + totalGbp
    const orderTotal = Number(so.totalGbp)
    const newStatus = totalRefundedNow >= orderTotal * 0.999 ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    await db.salesOrder.update({
      where: { id: orderId },
      data: { status: newStatus },
    })

    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'refunded',
      tag: 'sales',
      level: 'INFO',
      description: `Created refund for order ${so.wcOrderNumber} — £${totalGbp.toFixed(2)}`,
      metadata: { orderNumber: so.wcOrderNumber, totalGbp, creditNoteNumber, reason },
    })
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'refunded',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to create refund: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Clone, Delete, Mark Paid, Update Notes
// ---------------------------------------------------------------------------

export async function cloneSalesOrder(id: string): Promise<{ success: boolean; newId?: string; error?: string }> {
  try {
    const so = await db.salesOrder.findUnique({
      where: { id },
      include: { lines: true },
    })
    if (!so) return { success: false, error: 'Order not found' }

    const ref = `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const clone = await db.salesOrder.create({
      data: {
        wcOrderNumber: ref,
        status: 'DRAFT',
        currency: so.currency,
        fxRateToGbp: so.fxRateToGbp,
        customerId: so.customerId,
        customerName: so.customerName,
        customerEmail: so.customerEmail,
        billingAddress: so.billingAddress ?? undefined,
        shippingAddress: so.shippingAddress ?? undefined,
        subtotalForeign: so.subtotalForeign,
        shippingService: so.shippingService,
        shippingForeign: so.shippingForeign,
        taxForeign: so.taxForeign,
        totalForeign: so.totalForeign,
        subtotalGbp: so.subtotalGbp,
        shippingGbp: so.shippingGbp,
        taxGbp: so.taxGbp,
        totalGbp: so.totalGbp,
        shipFromWarehouseId: so.shipFromWarehouseId,
        salesRep: so.salesRep,
        discountStr: so.discountStr,
        discountAmount: so.discountAmount,
        notes: so.notes,
        internalNotes: so.internalNotes,
        lines: {
          create: so.lines.map((l) => ({
            productId: l.productId,
            sku: l.sku,
            description: l.description,
            qty: l.qty,
            unitPriceForeign: l.unitPriceForeign,
            unitPriceGbp: l.unitPriceGbp,
            discountStr: l.discountStr,
            discountAmount: l.discountAmount,
            taxForeign: l.taxForeign,
            taxGbp: l.taxGbp,
            totalForeign: l.totalForeign,
            totalGbp: l.totalGbp,
          })),
        },
      },
    })

    // Auto-allocate stock for cloned order
    const { autoAllocateOrder } = await import('./allocation')
    await autoAllocateOrder(clone.id)

    revalidatePath('/sales')
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: clone.id,
      action: 'cloned',
      tag: 'sales',
      level: 'INFO',
      description: `Cloned sales order ${so.wcOrderNumber}`,
      metadata: { sourceOrderId: id, sourceOrderNumber: so.wcOrderNumber, newOrderNumber: ref },
    })
    return { success: true, newId: clone.id }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'cloned',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to clone sales order: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function deleteSalesOrder(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const so = await db.salesOrder.findUnique({
      where: { id },
      select: { wcOrderNumber: true, status: true, shipFromWarehouseId: true, lines: { select: { productId: true, qty: true } }, _count: { select: { refunds: true, payments: true } } },
    })
    if (!so) return { success: false, error: 'Order not found' }
    if (!['DRAFT', 'PENDING_PAYMENT', 'ALLOCATED'].includes(so.status)) return { success: false, error: 'Only draft/pending payment orders can be deleted' }
    if (so._count.refunds > 0 || so._count.payments > 0) return { success: false, error: 'Cannot delete an order with refunds or payments' }

    // Release allocations
    const { deallocateOrder } = await import('./allocation')
    await deallocateOrder(id)

    await db.salesOrderLine.deleteMany({ where: { orderId: id } })
    await db.salesOrder.delete({ where: { id } })
    revalidatePath('/sales')
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'deleted',
      tag: 'sales',
      level: 'INFO',
      description: `Deleted sales order ${so.wcOrderNumber}`,
      metadata: { orderNumber: so.wcOrderNumber },
    })
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'deleted',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to delete sales order: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function markSalesOrderPaid(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const so = await db.salesOrder.findUnique({ where: { id }, select: { wcOrderNumber: true, paidAt: true, invoiceNumber: true } })
    if (!so) return { success: false, error: 'Order not found' }

    const markingAsPaid = !so.paidAt // transitioning from unpaid to paid
    await db.salesOrder.update({
      where: { id },
      data: { paidAt: markingAsPaid ? new Date() : null },
    })

    // Only auto-generate invoice when transitioning TO paid (not when toggling off)
    if (markingAsPaid && !so.invoiceNumber) {
      const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
      if (trigger?.value === 'on_paid') {
        await generateInvoiceNumber(id)
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${id}`)
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'paid',
      tag: 'sales',
      level: 'INFO',
      description: `Marked sales order ${so.wcOrderNumber} as paid`,
      metadata: { orderNumber: so.wcOrderNumber, markingAsPaid },
    })
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'paid',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to mark sales order as paid: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function updateSalesOrderNotes(
  id: string,
  notes: string,
  internalNotes: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const so = await db.salesOrder.update({
      where: { id },
      data: { notes: notes || null, internalNotes: internalNotes || null },
      select: { wcOrderNumber: true },
    })
    revalidatePath(`/sales/${id}`)
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'sales',
      level: 'INFO',
      description: `Updated notes for order ${so.wcOrderNumber}`,
      metadata: { orderNumber: so.wcOrderNumber },
    })
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to update sales order notes: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function generateInvoiceNumber(id: string): Promise<{ success: boolean; invoiceNumber?: string; error?: string }> {
  try {
    // Use a transaction to prevent race conditions on invoice numbering
    const result = await db.$transaction(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id }, select: { wcOrderNumber: true, invoiceNumber: true } })
      if (!so) throw new Error('Order not found')
      if (so.invoiceNumber) return { invoiceNumber: so.invoiceNumber, orderNumber: so.wcOrderNumber }
      const count = await tx.salesOrder.count({ where: { invoiceNumber: { not: null } } })
      const invNum = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`
      await tx.salesOrder.update({ where: { id }, data: { invoiceNumber: invNum, invoicedAt: new Date() } })
      return { invoiceNumber: invNum, orderNumber: so.wcOrderNumber }
    })
    revalidatePath(`/sales/${id}`)
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'invoice_generated',
      tag: 'sales',
      level: 'INFO',
      description: `Generated invoice number for order ${result.orderNumber}`,
      metadata: { orderNumber: result.orderNumber, invoiceNumber: result.invoiceNumber },
    })
    return { success: true, invoiceNumber: result.invoiceNumber }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'invoice_generated',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to generate invoice number: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentRow = {
  id: string
  refundId: string | null
  creditNoteNumber: string | null
  amount: number
  currency: string
  method: string | null
  reference: string | null
  notes: string | null
  paidAt: string
}

export async function addPayment(input: {
  orderId: string
  refundId?: string
  amount: number
  currency: string
  method?: string
  reference?: string
  notes?: string
  paidAt?: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (!input.amount || input.amount <= 0) return { success: false, error: 'Amount must be greater than 0' }
    await db.payment.create({
      data: {
        orderId: input.orderId,
        refundId: input.refundId || null,
        amount: input.amount,
        currency: input.currency,
        method: input.method || null,
        reference: input.reference || null,
        notes: input.notes || null,
        paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
      },
    })

    // Auto-set paidAt on the order if invoice total is fully paid
    const so = await db.salesOrder.findUnique({
      where: { id: input.orderId },
      select: { wcOrderNumber: true, totalGbp: true, paidAt: true },
    })
    if (so && !so.paidAt) {
      const payments = await db.payment.findMany({
        where: { orderId: input.orderId, refundId: null },
        select: { amount: true },
      })
      const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0)
      if (totalPaid >= Number(so.totalGbp)) {
        await db.salesOrder.update({ where: { id: input.orderId }, data: { paidAt: new Date() } })

        // Auto-generate invoice if trigger is on_paid
        const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
        if (trigger?.value === 'on_paid') {
          await generateInvoiceNumber(input.orderId)
        }
      }
    }

    revalidatePath(`/sales/${input.orderId}`)
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: input.orderId,
      action: 'payment_added',
      tag: 'sales',
      level: 'INFO',
      description: `Added £${input.amount.toFixed(2)} payment to order ${so?.wcOrderNumber ?? input.orderId}`,
      metadata: { orderNumber: so?.wcOrderNumber, amount: input.amount, currency: input.currency, method: input.method },
    })
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: input.orderId,
      action: 'payment_added',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to add payment: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function deletePayment(paymentId: string, orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await db.payment.delete({ where: { id: paymentId } })
    const so = await db.salesOrder.findUnique({ where: { id: orderId }, select: { wcOrderNumber: true } })
    revalidatePath(`/sales/${orderId}`)
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'payment_deleted',
      tag: 'sales',
      level: 'INFO',
      description: `Deleted payment from order ${so?.wcOrderNumber ?? orderId}`,
      metadata: { orderNumber: so?.wcOrderNumber, paymentId },
    })
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'payment_deleted',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to delete payment: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}
