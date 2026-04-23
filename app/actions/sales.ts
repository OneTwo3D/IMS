'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { queueAccountingSync, getAccountingSettings } from '@/lib/accounting'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync, pushOrderDeliveryMetadata } from '@/lib/shopping'
import { isSellableProductStatus } from '@/lib/products/lifecycle'
import { resolveLineTaxRateBatch, type ResolvedTaxRate } from '@/lib/tax/resolve-rate'
import { INTERNAL_STATUS_TRANSITION_BYPASS } from '@/lib/sales/status-transition-bypass'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { toIsoCountryCode } from '@/lib/countries'
import { copyCostLayerSourceLinesProportionally } from '@/lib/cost-layers'
import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  sumCostLayerSnapshot,
  takeFromSnapshotEntries,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'
import { Prisma, type TaxCategory } from '@/app/generated/prisma/client'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

async function lockCostLayers(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "cost_layers" WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`,
  )
}

export type RefundReturnRow = {
  productId: string
  qty: number
  unitCostBase?: number
  poLineId?: string | null
  sourceCostLayerId?: string | null
}

type RefundRequestLine = {
  lineId?: string | null
  productId: string | null
  description: string
  qty: number
  totalForeign?: number | null
  totalBase: number
  lineKind?: 'sale' | 'shipping'
}

function aggregateRefundReturnRows(
  rows: RefundReturnRow[],
): RefundReturnRow[] {
  const aggregated = new Map<string, RefundReturnRow>()

  for (const row of rows) {
    if (!row.productId || !Number.isFinite(row.qty) || row.qty <= 0) continue
    const existing = aggregated.get(row.productId)
    if (existing) {
      existing.qty += row.qty
      continue
    }
    aggregated.set(row.productId, { ...row })
  }

  return [...aggregated.values()]
}

async function buildRefundFallbackReturnRows(
  orderId: string,
  lines: RefundRequestLine[],
): Promise<RefundReturnRow[]> {
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      lines: {
        select: {
          id: true,
          productId: true,
          description: true,
          qty: true,
        },
      },
      allocations: {
        select: {
          lineId: true,
          productId: true,
          qty: true,
        },
      },
      shipments: {
        where: { status: { not: 'PENDING' } },
        select: {
          lines: {
            select: {
              lineId: true,
              productId: true,
              qty: true,
            },
          },
        },
      },
      // Load prior refund lines that actually returned stock (returnWarehouseId
      // is set) to subtract already-returned quantities. Monetary-only refunds
      // (returnWarehouseId IS NULL) did not put stock back, so they must not
      // reduce future physical return capacity.
      refunds: {
        where: { returnWarehouseId: { not: null } },
        select: {
          lines: {
            select: { productId: true, qty: true },
          },
        },
      },
    },
  })
  if (!order) return []

  // Compute already-returned qty per product across all prior refunds
  const priorReturnedByProduct = new Map<string, number>()
  for (const refund of order.refunds) {
    for (const rl of refund.lines) {
      if (!rl.productId) continue
      priorReturnedByProduct.set(
        rl.productId,
        (priorReturnedByProduct.get(rl.productId) ?? 0) + Number(rl.qty),
      )
    }
  }

  const lineById = new Map(order.lines.map((line) => [line.id, line]))
  const lineCandidatesByProduct = new Map<string, typeof order.lines>()
  for (const line of order.lines) {
    if (!line.productId) continue
    const existing = lineCandidatesByProduct.get(line.productId) ?? []
    existing.push(line)
    lineCandidatesByProduct.set(line.productId, existing)
  }

  const sourceRowsByLine = new Map<string, Map<string, number>>()
  const addSourceQty = (lineId: string, productId: string, qty: number) => {
    if (!Number.isFinite(qty) || qty <= 0) return
    const byProduct = sourceRowsByLine.get(lineId) ?? new Map<string, number>()
    byProduct.set(productId, (byProduct.get(productId) ?? 0) + qty)
    sourceRowsByLine.set(lineId, byProduct)
  }

  for (const allocation of order.allocations) {
    addSourceQty(allocation.lineId, allocation.productId, Number(allocation.qty))
  }
  for (const shipment of order.shipments) {
    for (const line of shipment.lines) {
      const existing = sourceRowsByLine.get(line.lineId)
      if (existing && existing.size > 0) continue
      addSourceQty(line.lineId, line.productId, Number(line.qty))
    }
  }

  // Build remaining returnable qty per (lineId, productId) so the same
  // product appearing on multiple SO lines doesn't deplete a shared bucket.
  // Only subtract prior refunds that actually returned stock (the query
  // already filters on returnWarehouseId != null above).
  const priorReturnedByLineProduct = new Map<string, number>()
  for (const refund of order.refunds) {
    for (const rl of refund.lines) {
      if (!rl.productId) continue
      // Prior refund lines don't carry lineId, so attribute returns to the
      // first matching source line for this product. Imprecise but safe —
      // it can only *over*-subtract from one line and *under*-subtract from
      // another, which means we might return slightly less than allowed on
      // edge cases, never more.
      const key = `${rl.productId}`
      priorReturnedByLineProduct.set(key, (priorReturnedByLineProduct.get(key) ?? 0) + Number(rl.qty))
    }
  }

  // Compute total dispatched per product across all source lines
  const totalDispatchedByProduct = new Map<string, number>()
  for (const [, sourceRows] of sourceRowsByLine) {
    for (const [productId, qty] of sourceRows) {
      totalDispatchedByProduct.set(productId, (totalDispatchedByProduct.get(productId) ?? 0) + qty)
    }
  }

  // Remaining returnable = total dispatched − prior physical returns
  const remainingReturnable = new Map<string, number>()
  for (const [productId, dispatched] of totalDispatchedByProduct) {
    const priorReturned = priorReturnedByLineProduct.get(productId) ?? 0
    remainingReturnable.set(productId, Math.max(0, dispatched - priorReturned))
  }

  return lines.flatMap((line) => {
    if (!line.productId || line.qty <= 0) return []

    const sourceLine = line.lineId
      ? lineById.get(line.lineId) ?? null
      : (lineCandidatesByProduct.get(line.productId) ?? []).find((candidate) => candidate.description === line.description)
        ?? (lineCandidatesByProduct.get(line.productId) ?? [])[0]
        ?? null

    if (!sourceLine) {
      return [{ productId: line.productId, qty: line.qty }]
    }

    const sourceRows = sourceRowsByLine.get(sourceLine.id)
    const sourceLineQty = Number(sourceLine.qty)
    if (!sourceRows || sourceRows.size === 0 || !Number.isFinite(sourceLineQty) || sourceLineQty <= 0) {
      return [{ productId: sourceLine.productId ?? line.productId, qty: line.qty }]
    }

    return [...sourceRows.entries()].flatMap(([productId, totalQty]) => {
      const perUnitQty = totalQty / sourceLineQty
      if (!Number.isFinite(perUnitQty) || perUnitQty <= 0) return []
      const rawReturnQty = perUnitQty * line.qty

      // Cap against remaining returnable for this product
      const available = Math.max(0, remainingReturnable.get(productId) ?? 0)
      const cappedQty = Math.min(rawReturnQty, available)
      remainingReturnable.set(productId, available - cappedQty)

      if (cappedQty <= 0) return []
      return [{ productId, qty: cappedQty }]
    })
  })
}

export async function applyReturnInboundStockTx(
  tx: Prisma.TransactionClient,
  params: {
    referenceType: string
    referenceId: string
    warehouseId: string
    rows: RefundReturnRow[]
    note: string
  },
): Promise<Array<{ productId: string; sku: string; qty: number }>> {
  const aggregatedRows = aggregateRefundReturnRows(params.rows)
  if (aggregatedRows.length === 0) return []

  for (const row of aggregatedRows) {
    await tx.stockMovement.create({
      data: {
        type: 'RETURN_INBOUND',
        productId: row.productId,
        toWarehouseId: params.warehouseId,
        qty: row.qty,
        note: params.note,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    })
    await tx.stockLevel.upsert({
      where: { productId_warehouseId: { productId: row.productId, warehouseId: params.warehouseId } },
      create: { productId: row.productId, warehouseId: params.warehouseId, quantity: row.qty, reservedQty: 0 },
      update: { quantity: { increment: row.qty } },
    })
  }

  for (const row of params.rows) {
    if (!Number.isFinite(row.unitCostBase) || row.unitCostBase == null || row.qty <= 0) continue
    await tx.costLayer.create({
      data: {
        productId: row.productId,
        warehouseId: params.warehouseId,
        receivedQty: row.qty,
        remainingQty: row.qty,
        unitCostBase: row.unitCostBase,
        poLineId: row.poLineId ?? null,
      },
      select: { id: true },
    }).then(async (newLayer) => {
      if (row.sourceCostLayerId) {
        await copyCostLayerSourceLinesProportionally(tx, row.sourceCostLayerId, newLayer.id, row.qty)
      }
    })
  }

  const returnedProducts = await tx.product.findMany({
    where: { id: { in: aggregatedRows.map((row) => row.productId) } },
    select: { id: true, sku: true },
  })
  const skuByProductId = new Map(returnedProducts.map((product) => [product.id, product.sku]))

  return aggregatedRows.map((row) => ({
    productId: row.productId,
    sku: skuByProductId.get(row.productId) ?? row.productId,
    qty: row.qty,
  }))
}

async function applyRefundReturnStock(
  orderId: string,
  orderRef: string,
  warehouseId: string,
  rows: RefundReturnRow[],
): Promise<string[]> {
  const returnedRows = await db.$transaction((tx) => (
    applyReturnInboundStockTx(tx, {
      referenceType: 'SalesOrder',
      referenceId: orderId,
      warehouseId,
      rows,
      note: 'Refund return',
    })
  ), STOCK_TX_OPTIONS)

  for (const row of returnedRows) {
    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: row.productId,
      action: 'return_inbound',
      tag: 'stock',
      level: 'INFO',
      description: `Returned ${row.qty} units of SKU ${row.sku} to warehouse ${warehouseId} for refund on order ${orderRef}`,
      metadata: { productId: row.productId, qty: row.qty, orderNumber: orderRef, warehouseId },
    })
  }

  return returnedRows.map((row) => row.productId)
}

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
  imageUrl: string | null
  description: string
  qty: number
  unitPriceForeign: number  // original price before discount
  unitPriceBase: number
  discountStr: string | null
  discountAmount: number
  taxForeign: number
  taxBase: number
  totalForeign: number
  totalBase: number
  cogsBase: number | null
  /** Per-line tax rate id (resolved from product category + destination). */
  taxRateId: string | null
  /** Per-line effective rate percentage (0..1). Falls back to null if no per-line rate. */
  taxRatePercent: number | null
  /** Short label for the rate (e.g. "REDUCED 5%"). Null when no per-line rate. */
  taxRateName: string | null
}

export type SoRow = {
  id: string
  externalOrderId: number | null
  externalOrderNumber: string | null
  orderNumber: string | null
  displayOrderNumber: string
  sourceLabel: string
  hasExternalSource: boolean
  externalOrderDate: string | null
  status: SoStatus
  currency: string
  fxRateToBase: number
  customerName: string | null
  customerEmail: string | null
  subtotalForeign: number
  shippingService: string | null
  shippingForeign: number
  taxRateName: string | null
  taxRatePercent: number | null
  taxForeign: number
  pricesIncludeVat: boolean
  totalForeign: number
  totalBase: number
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
  accountingInvoiceId: string | null
  paidAt: string | null
  notes: string | null
  internalNotes: string | null
  shippingCountryCode: string | null
  paymentMethodTitle: string | null
  externalCreatedAt: string | null
  createdAt: string
  lineCount: number
  cogsBase: number | null
  profitMarginPercent: number | null
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
    totalBase: number
    refundedAt: string
    payments: PaymentRow[]
    lines: {
      id: string
      productId: string | null
      description: string
      qty: number
      totalBase: number
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
  /**
   * Optional manual override of the tax rate for this line. When null/omitted
   * the server resolves a rate from the product's tax category + destination
   * country. When set, this rate is used verbatim.
   */
  taxRateId?: string | null
}

export type CreateSoInput = {
  externalOrderNumber?: string
  customerId?: string
  customerName: string
  customerEmail?: string
  billingAddress?: unknown
  shippingAddress?: unknown
  currency: string
  fxRateToBase: number
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
  /**
   * When true, the order is saved as a DRAFT and is NOT queued for accounting
   * sync. Drafts remain editable until finalised (moved to PENDING_PAYMENT,
   * PROCESSING, etc.) at which point the accounting invoice is queued.
   */
  isDraft?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReference(prefix: string): string {
  const now = new Date()
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${prefix}${ymd}-${rand}`
}

const SO_SELECT = {
  id: true,
  externalOrderId: true,
  externalOrderNumber: true,
  orderNumber: true,
  status: true,
  currency: true,
  fxRateToBase: true,
  customerName: true,
  customerEmail: true,
  subtotalForeign: true,
  shippingService: true,
  shippingForeign: true,
  taxRateName: true,
  taxRatePercent: true,
  taxForeign: true,
  pricesIncludeVat: true,
  totalForeign: true,
  totalBase: true,
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
  accountingInvoiceId: true,
  paidAt: true,
  notes: true,
  internalNotes: true,
  shippingAddress: true,
  paymentMethodTitle: true,
  externalCreatedAt: true,
  createdAt: true,
  _count: { select: { lines: true } },
  lines: { select: { cogsBase: true } },
} as const

function mapSoRow(so: {
  id: string
  externalOrderId: number | null
  externalOrderNumber: string | null
  orderNumber: string | null
  status: string
  currency: string
  fxRateToBase: unknown
  customerName: string | null
  customerEmail: string | null
  subtotalForeign: unknown
  shippingService: string | null
  shippingForeign: unknown
  taxRateName: string | null
  taxRatePercent: unknown
  taxForeign: unknown
  pricesIncludeVat: boolean
  totalForeign: unknown
  totalBase: unknown
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
  accountingInvoiceId: string | null
  paidAt: Date | null
  notes: string | null
  internalNotes: string | null
  shippingAddress: unknown
  paymentMethodTitle: string | null
  externalCreatedAt: Date | null
  createdAt: Date
  _count: { lines: number }
  lines: { cogsBase: unknown }[]
}): SoRow {
  const totalBase = Number(so.totalBase)
  const lineCogs = so.lines.map((l) => l.cogsBase != null ? Number(l.cogsBase) : null)
  const hasAnyCogs = lineCogs.some((c) => c !== null)
  const cogsBase = hasAnyCogs ? lineCogs.reduce((s: number, c) => s + (c ?? 0), 0) : null
  const profitMarginPercent = cogsBase != null && totalBase > 0
    ? ((totalBase - cogsBase) / totalBase) * 100
    : null
  const hasExternalSource = !!so.externalOrderId
  return {
    id: so.id,
    externalOrderId: so.externalOrderId,
    externalOrderNumber: so.externalOrderNumber,
    orderNumber: so.orderNumber,
    displayOrderNumber: so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8),
    sourceLabel: hasExternalSource ? 'Store' : 'Manual',
    hasExternalSource,
    externalOrderDate: so.externalCreatedAt?.toISOString() ?? null,
    status: so.status as SoStatus,
    currency: so.currency,
    fxRateToBase: Number(so.fxRateToBase),
    customerName: so.customerName,
    customerEmail: so.customerEmail,
    subtotalForeign: Number(so.subtotalForeign),
    shippingService: so.shippingService,
    shippingForeign: Number(so.shippingForeign),
    taxRateName: so.taxRateName,
    taxRatePercent: so.taxRatePercent != null ? Number(so.taxRatePercent) : null,
    taxForeign: Number(so.taxForeign),
    pricesIncludeVat: !!so.pricesIncludeVat,
    totalForeign: Number(so.totalForeign),
    totalBase: Number(so.totalBase),
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
    accountingInvoiceId: so.accountingInvoiceId,
    paidAt: so.paidAt?.toISOString() ?? null,
    notes: so.notes,
    internalNotes: so.internalNotes,
    shippingCountryCode: toIsoCountryCode((so.shippingAddress as Record<string, string> | null)?.country) ?? null,
    paymentMethodTitle: so.paymentMethodTitle,
    externalCreatedAt: so.externalCreatedAt?.toISOString() ?? null,
    createdAt: so.createdAt.toISOString(),
    lineCount: so._count.lines,
    cogsBase,
    profitMarginPercent,
  }
}

function mapLine(l: {
  id: string
  productId: string | null
  sku: string | null
  description: string
  qty: unknown
  unitPriceForeign: unknown
  unitPriceBase: unknown
  discountStr: string | null
  discountAmount: unknown
  taxForeign: unknown
  taxBase: unknown
  totalForeign: unknown
  totalBase: unknown
  cogsBase: unknown
  taxRateId?: string | null
  taxRate?: { id: string; name: string; rate: unknown; taxCategory?: string } | null
  product?: { imageUrl: string | null; parent?: { imageUrl: string | null } | null } | null
}): SoLineRow {
  return {
    id: l.id,
    productId: l.productId,
    sku: l.sku ?? '',
    imageUrl: l.product?.imageUrl ?? l.product?.parent?.imageUrl ?? null,
    description: l.description,
    qty: Number(l.qty),
    unitPriceForeign: Number(l.unitPriceForeign),
    unitPriceBase: Number(l.unitPriceBase),
    discountStr: l.discountStr ?? null,
    discountAmount: Number(l.discountAmount ?? 0),
    taxForeign: Number(l.taxForeign),
    taxBase: Number(l.taxBase),
    totalForeign: Number(l.totalForeign),
    totalBase: Number(l.totalBase),
    cogsBase: l.cogsBase != null ? Number(l.cogsBase) : null,
    taxRateId: l.taxRateId ?? l.taxRate?.id ?? null,
    taxRatePercent: l.taxRate?.rate != null ? Number(l.taxRate.rate) : null,
    taxRateName: l.taxRate?.name ?? null,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getSalesOrders(
  limit = 200,
  opts?: { includeCompleted?: boolean }
): Promise<SoRow[]> {
  await requireAuth()
  const where: Prisma.SalesOrderWhereInput = { archived: { not: true } }
  if (!opts?.includeCompleted) {
    where.status = { notIn: ['COMPLETED', 'DELIVERED'] }
  }
  const orders = await db.salesOrder.findMany({
    where,
    select: SO_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return orders.map(mapSoRow)
}

export async function getSalesOrder(id: string): Promise<SoDetail | null> {
  await requireAuth()
  const so = await db.salesOrder.findUnique({
    where: { id },
    select: {
      ...SO_SELECT,
      billingAddress: true,
      shippingAddress: true,
      lines: {
        select: {
          id: true, productId: true, sku: true, description: true,
          qty: true, unitPriceForeign: true, unitPriceBase: true, discountStr: true, discountAmount: true,
          taxForeign: true, taxBase: true, totalForeign: true, totalBase: true,
          cogsBase: true,
          taxRateId: true,
          taxRate: { select: { id: true, name: true, rate: true, taxCategory: true } },
          product: { select: { imageUrl: true, parent: { select: { imageUrl: true } } } },
        },
      },
      refunds: {
        select: {
          id: true, creditNoteNumber: true, reason: true, totalForeign: true, totalBase: true, refundedAt: true,
          lines: {
            select: { id: true, productId: true, description: true, qty: true, totalBase: true },
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
      totalBase: Number(r.totalBase),
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
        totalBase: Number(rl.totalBase),
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
    await requirePermission('sales.create')
    if (!input.lines.length) return { success: false, error: 'Add at least one line item' }
    if (!input.customerName?.trim()) return { success: false, error: 'Customer name is required' }
    for (const l of input.lines) {
      if (l.qty <= 0) return { success: false, error: `Invalid qty for ${l.sku}` }
      if (l.unitPriceForeign < 0) return { success: false, error: `Negative price for ${l.sku}` }
    }
    if (input.externalOrderNumber?.trim()) {
      const existing = await db.salesOrder.findFirst({
        where: { externalOrderNumber: input.externalOrderNumber.trim() },
        select: { id: true },
      })
      if (existing) return { success: false, error: `Order ${input.externalOrderNumber.trim()} already exists` }
    }

    const fxRate = input.fxRateToBase && input.fxRateToBase > 0 ? input.fxRateToBase : 1
    const vatRate = input.taxRateValue ?? 0
    const inclVat = !!input.pricesIncludeVat
    // Storage convention:
    //   All *Foreign / *Gbp totals on SalesOrder are NET of tax (subtotal,
    //   shipping, discount). `taxForeign` holds the total VAT, `totalForeign`
    //   is the grand total (net + tax). Line rows also store NET totals.
    //   When pricesIncludeVat is true, unitPriceForeign remains the gross
    //   user-entered price so the UI can display gross values, but every
    //   aggregate field is net. The Xero payload reconstructs gross from
    //   stored net when lineAmountsIncludeTax is true.
    let linesSubtotalForeign = 0 // sum of line NETs, before order discount
    let linesSubtotalBase = 0
    let totalTaxForeign = 0
    let totalTaxBase = 0

    const round4 = (n: number) => Math.round(n * 10000) / 10000

    // --- Tax category resolution ---------------------------------------
    // Load each line's product category + the order default rate so we can
    // resolve a per-line VAT rate via `(destCountry, category, SALES)`.
    // Manual overrides (input.lines[i].taxRateId) skip the resolver and use
    // the rate row directly.
    const shipAddr = input.shippingAddress as { country?: string | null } | null | undefined
    const billAddr = input.billingAddress as { country?: string | null } | null | undefined
    let destCountryRaw: string | null =
      (shipAddr?.country as string | null | undefined) ??
      (billAddr?.country as string | null | undefined) ??
      null
    if (!destCountryRaw) {
      try {
        const { getOrganisation } = await import('./company')
        const org = await getOrganisation()
        destCountryRaw = org?.country ?? null
      } catch { /* Fallback to null — resolver will use order default */ }
    }
    // Normalize free-text country values ("United Kingdom", "UK", "gb") to
    // the lowercase ISO-2 code the resolver compares against.
    const destCountryIso = toIsoCountryCode(destCountryRaw)
    const destCountry: string | null = destCountryIso ? destCountryIso.toLowerCase() : (destCountryRaw ? destCountryRaw.toLowerCase() : null)

    const productIds = Array.from(new Set(input.lines.map((l) => l.productId).filter(Boolean)))
    const productRows = productIds.length
      ? await db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, taxCategory: true, lifecycleStatus: true },
        })
      : []
    const invalidSalesProduct = productRows.find((p) => !isSellableProductStatus(p.lifecycleStatus))
    if (invalidSalesProduct) {
      return { success: false, error: 'Only active products can be sold on sales orders' }
    }
    const productCategoryById = new Map<string, TaxCategory>(
      productRows.map((p) => [p.id, p.taxCategory]),
    )

    // Order-level default for the resolver fallback step
    const orderDefaultRate = input.taxRateName
      ? await db.taxRate.findFirst({
          where: { name: input.taxRateName, active: true },
          select: { id: true, name: true, rate: true, accountingTaxType: true },
        })
      : null
    const orderDefaultCtx = {
      id: orderDefaultRate?.id ?? null,
      name: orderDefaultRate?.name ?? input.taxRateName ?? null,
      rate: orderDefaultRate ? Number(orderDefaultRate.rate) : vatRate,
      accountingTaxType: orderDefaultRate?.accountingTaxType ?? null,
    }

    // Batch-resolve all lines that don't already carry a manual taxRateId.
    const autoLines = input.lines
      .map((l, idx) => ({
        id: String(idx),
        productCategory: (l.productId && productCategoryById.get(l.productId)) || ('STANDARD' as TaxCategory),
        override: l.taxRateId ?? null,
      }))
      .filter((l) => !l.override)
    const resolvedMap = await resolveLineTaxRateBatch(autoLines, {
      destinationCountry: destCountry,
      usedFor: 'SALES',
      orderDefault: orderDefaultCtx,
    })

    // Load any manual override tax rates in one query.
    const overrideIds = Array.from(
      new Set(
        input.lines
          .map((l) => l.taxRateId)
          .filter((x): x is string => typeof x === 'string' && x.length > 0),
      ),
    )
    const overrideRows = overrideIds.length
      ? await db.taxRate.findMany({
          where: { id: { in: overrideIds } },
          select: { id: true, name: true, rate: true, accountingTaxType: true },
        })
      : []
    const overrideById = new Map(overrideRows.map((r) => [r.id, r]))

    const lineResolved: ResolvedTaxRate[] = input.lines.map((l, idx) => {
      if (l.taxRateId) {
        const row = overrideById.get(l.taxRateId)
        if (row) {
          return {
            taxRateId: row.id,
            taxRateName: row.name,
            taxRateValue: Number(row.rate),
            accountingTaxType: row.accountingTaxType,
            matched: 'exact',
            warning: null,
          }
        }
      }
      return (
        resolvedMap.get(String(idx)) ?? {
          taxRateId: orderDefaultCtx.id,
          taxRateName: orderDefaultCtx.name,
          taxRateValue: orderDefaultCtx.rate,
          accountingTaxType: orderDefaultCtx.accountingTaxType,
          matched: 'fallback',
          warning: null,
        }
      )
    })

    const lineData = input.lines.map((l, idx) => {
      const resolved = lineResolved[idx]
      const lineRate = resolved.taxRateValue
      const lineInclVat = inclVat && lineRate > 0
      const discAmt = l.discountAmount ?? 0 // in gross if inclVat, else net
      const lineGross = l.qty * l.unitPriceForeign - discAmt
      const netForeign = lineInclVat ? lineGross / (1 + lineRate) : lineGross
      const unitPriceBase = Math.round((l.unitPriceForeign / fxRate) * 1000000) / 1000000
      const totalForeign = round4(netForeign)
      const totalBase = round4(totalForeign / fxRate)
      const lineTax = lineInclVat ? lineGross - netForeign : netForeign * lineRate
      const lineTaxForeign = round4(lineTax)
      const lineTaxBase = round4(lineTaxForeign / fxRate)
      linesSubtotalForeign += totalForeign
      linesSubtotalBase += totalBase
      totalTaxForeign += lineTaxForeign
      totalTaxBase += lineTaxBase
      return {
        productId: l.productId,
        sku: l.sku,
        description: l.description,
        qty: l.qty,
        unitPriceForeign: l.unitPriceForeign, // ORIGINAL (gross if inclVat)
        unitPriceBase,
        discountStr: l.discountStr || null,
        discountAmount: discAmt,
        taxForeign: lineTaxForeign,
        taxBase: lineTaxBase,
        totalForeign, // NET
        totalBase,
        taxRateId: resolved.taxRateId,
      }
    })

    // Shipping (+ fees). Input shippingForeign is gross when inclVat.
    // Shipping / fees / order discount are always taxed at the order-default
    // rate (the per-line resolver only applies to line items).
    const shippingInclVat = inclVat && vatRate > 0
    const shippingInput = input.shippingForeign ?? 0
    let feesTotalForeign = 0
    if (input.fees?.length) for (const f of input.fees) feesTotalForeign += f.amount
    const totalShippingInput = shippingInput + feesTotalForeign
    const shippingNetForeign = shippingInclVat ? totalShippingInput / (1 + vatRate) : totalShippingInput
    const shippingTaxForeign = shippingInclVat
      ? totalShippingInput - shippingNetForeign
      : (vatRate > 0 ? shippingNetForeign * vatRate : 0)
    const shippingNetForeignR = round4(shippingNetForeign)
    const shippingTaxForeignR = round4(shippingTaxForeign)
    const shippingNetBase = round4(shippingNetForeignR / fxRate)
    const shippingTaxBase = round4(shippingTaxForeignR / fxRate)
    totalTaxForeign += shippingTaxForeignR
    totalTaxBase += shippingTaxBase

    // Order-level discount — cap at line subtotal (compare in gross when inclVat).
    const rawOrderDisc = input.orderDiscountForeign ?? 0
    const linesGrossForCap = shippingInclVat
      ? linesSubtotalForeign * (1 + vatRate)
      : linesSubtotalForeign
    const orderDiscForeign = Math.min(rawOrderDisc, linesGrossForCap)
    const discNetForeign = shippingInclVat ? orderDiscForeign / (1 + vatRate) : orderDiscForeign
    const discTaxForeign = shippingInclVat ? orderDiscForeign - discNetForeign : (vatRate > 0 ? discNetForeign * vatRate : 0)
    const discNetForeignR = round4(discNetForeign)
    const discTaxForeignR = round4(discTaxForeign)
    const discNetBase = round4(discNetForeignR / fxRate)
    const discTaxBase = round4(discTaxForeignR / fxRate)
    totalTaxForeign -= discTaxForeignR
    totalTaxBase -= discTaxBase

    // Subtotal stored PRE-discount (sum of line nets) — matches the WC
    // importer convention so display / accounting code can handle both
    // sources uniformly.
    const subtotalForeign = round4(linesSubtotalForeign)
    const subtotalBase = round4(linesSubtotalBase)
    totalTaxForeign = round4(totalTaxForeign)
    totalTaxBase = round4(totalTaxBase)

    // Grand total = subtotal (net, pre-discount) − net discount + net
    // shipping + total tax. Tax already nets the discount VAT above.
    const grandTotalForeign = round4(subtotalForeign - discNetForeignR + shippingNetForeignR + totalTaxForeign)
    const grandTotalBase = round4(subtotalBase - discNetBase + shippingNetBase + totalTaxBase)

    // Keep locals that downstream Prisma / accounting queue references expect.
    const totalShippingForeign = shippingNetForeignR
    const totalShippingBase = shippingNetBase
    // Store the order discount in the same convention as WC import: the raw
    // user-entered amount (gross when inclVat).
    const storedDiscountAmount = round4(orderDiscForeign)

    // Generate order number using configured prefix (Settings → Company → Numbering)
    const { getNumberingFormats } = await import('./company')
    const numbering = await getNumberingFormats()
    const ref = makeReference(numbering.so_prefix)
    const orderNumber = ref

    // Drafts stay in DRAFT and are NOT queued for accounting sync. When the
    // order is finalised later (e.g. moved to PENDING_PAYMENT), the invoice
    // will be queued via updateSalesOrderStatus.
    const initialStatus = input.isDraft ? 'DRAFT' : 'PENDING_PAYMENT'
    const so = await db.salesOrder.create({
      data: {
        externalOrderNumber: input.externalOrderNumber || null,
        orderNumber,
        status: initialStatus,
        currency: input.currency,
        fxRateToBase: fxRate,
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
        pricesIncludeVat: inclVat,
        totalForeign: grandTotalForeign,
        subtotalBase,
        shippingBase: totalShippingBase,
        taxBase: totalTaxBase,
        totalBase: grandTotalBase,
        shipFromWarehouseId: input.shipFromWarehouseId || null,
        expectedDelivery: input.expectedDelivery ? new Date(input.expectedDelivery) : null,
        salesRep: input.salesRep || null,
        discountStr: input.orderDiscountStr || null,
        discountAmount: storedDiscountAmount,
        notes: input.notes || null,
        internalNotes: input.internalNotes || null,
        lines: { create: lineData },
      },
      select: SO_SELECT,
    })

    // Auto-allocate stock across warehouses. Drafts stay unallocated —
    // allocation happens when the draft is finalised so the draft can still
    // be freely edited without holding stock.
    if (!input.isDraft) {
      const { autoAllocateOrder } = await import('./allocation')
      await autoAllocateOrder(so.id)
    }

    // Queue accounting sales invoice (DRAFT — manual orders have no payment yet).
    // Skipped entirely for DRAFT orders — drafts are not posted to accounting
    // until they are finalised via updateSalesOrderStatus.
    if (!input.isDraft) {
      try {
        await queueSalesInvoiceForOrder(so.id)
      } catch { /* Accounting queue errors should never block the main flow */ }
    }

    // Aggregated warning when any line fell back to the order default.
    const fallbackLines = lineResolved
      .map((r, i) => ({ r, sku: input.lines[i].sku, cat: productCategoryById.get(input.lines[i].productId) ?? 'STANDARD' }))
      .filter((x) => x.r.matched === 'fallback')
    if (fallbackLines.length > 0) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'tax_rate_fallback',
        tag: 'sales',
        level: 'WARNING',
        description: `No matching tax rate for ${destCountry?.toUpperCase() ?? 'unknown country'} on ${fallbackLines.length} line(s); used order default.`,
        metadata: {
          orderNumber: so.orderNumber,
          destCountry,
          lines: fallbackLines.map((x) => ({ sku: x.sku, category: x.cat })),
        },
      })
    }

    revalidatePath('/sales')
    const mapped = mapSoRow(so)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'created',
      tag: 'sales',
      level: 'INFO',
      description: `Created sales order ${mapped.displayOrderNumber}`,
      metadata: { orderNumber: mapped.displayOrderNumber, totalBase: mapped.totalBase, currency: mapped.currency },
    })
    return { success: true, order: mapped }
  } catch (e) {
    await logActivity({
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

/**
 * Queue the accounting sales invoice for an existing SalesOrder. Used when a
 * draft order is finalised (DRAFT → PENDING_PAYMENT / PROCESSING / etc.) — the
 * invoice was skipped at creation time and must now be sent to Xero.
 *
 * Safe to call multiple times: checks `accountingInvoiceId` and bails if the
 * invoice has already been posted.
 */
async function queueSalesInvoiceForOrder(id: string): Promise<void> {
  const so = await db.salesOrder.findUnique({
    where: { id },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      currency: true,
      fxRateToBase: true,
      customerName: true,
      customerEmail: true,
      shippingForeign: true,
      shippingBase: true,
      taxRateName: true,
      taxRatePercent: true,
      pricesIncludeVat: true,
      discountAmount: true,
      accountingInvoiceId: true,
      lines: {
        select: {
          sku: true,
          description: true,
          qty: true,
          unitPriceBase: true,
          unitPriceForeign: true,
          discountAmount: true,
          totalForeign: true,
          taxRateId: true,
          taxRate: { select: { accountingTaxType: true } },
        },
      },
    },
  })
  if (!so) return
  if (so.accountingInvoiceId) return // already posted to accounting

  const settings = await getAccountingSettings()
  if (!settings.syncEnabled) return

  const { getNumberingFormats } = await import('./company')
  const numbering = await getNumberingFormats()
  const manualPrefix = numbering.inv_prefix
  const orderNumber = getSalesOrderReference(so)

  const orderDefaultTaxType = so.taxRateName
    ? (await db.taxRate.findFirst({
        where: { name: so.taxRateName, active: true },
        select: { accountingTaxType: true },
      }))?.accountingTaxType ?? null
    : null

  const vatPct = Number(so.taxRatePercent ?? 0)
  const lineAmountsIncludeTax = !!so.pricesIncludeVat && vatPct > 0

  // Shipping is stored NET on the SalesOrder. Reconstruct gross when
  // sending inclusive so Xero calculates the correct tax.
  const shippingNetForeign = Number(so.shippingForeign ?? 0)
  const shippingSendForeign = lineAmountsIncludeTax
    ? Math.round(shippingNetForeign * (1 + vatPct) * 10000) / 10000
    : shippingNetForeign

  // `discountAmount` is stored in the same inclusive/exclusive convention as
  // the order (matching WC import), so it can be passed through directly.
  const discountForeign = Math.round(Number(so.discountAmount ?? 0) * 100) / 100

  await queueAccountingSync({
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: so.id,
    payload: {
      invoiceNumber: `${manualPrefix}${orderNumber}`,
      contactName: so.customerName ?? 'Unknown',
      contactEmail: so.customerEmail ?? undefined,
      date: new Date().toISOString().slice(0, 10),
      currency: so.currency,
      reference: orderNumber,
      lines: so.lines.map((l) => {
        const qty = Number(l.qty)
        const discForeign = Number(l.discountAmount ?? 0)
        return {
          itemCode: l.sku ?? undefined,
          description: l.description ?? l.sku ?? 'Item',
          quantity: qty,
          unitAmount: Number(l.unitPriceForeign),
          accountCode: settings.salesAccount,
          taxType: l.taxRate?.accountingTaxType ?? orderDefaultTaxType ?? undefined,
          discountAmount: discForeign > 0 ? discForeign : undefined,
        }
      }),
      shippingAmount: shippingSendForeign > 0 ? shippingSendForeign : undefined,
      shippingDescription: 'Shipping',
      shippingAccountCode: settings.shippingAccount || undefined,
      shippingTaxType: orderDefaultTaxType ?? undefined,
      discountAmount: discountForeign > 0 ? discountForeign : undefined,
      discountAccountCode: settings.discountAccount || undefined,
      discountTaxType: orderDefaultTaxType ?? undefined,
      lineAmountsIncludeTax,
      _postingMode: 'draft',
    },
  })
}

export async function updateSalesOrderStatus(
  id: string,
  targetStatus: SoStatus,
  extra?: { trackingNumber?: string; shipFromWarehouseId?: string },
): Promise<{ success: boolean; error?: string }> {
  return applySalesOrderStatusTransition(id, targetStatus, extra, {
    pushStatusToWooCommerce: true,
  })
}

export async function applySalesOrderStatusTransition(
  id: string,
  targetStatus: SoStatus,
  extra?: { trackingNumber?: string; shipFromWarehouseId?: string },
  options?: { pushStatusToWooCommerce?: boolean; internalBypassToken?: symbol },
): Promise<{ success: boolean; error?: string }> {
  try {
    const bypassPermission = options?.internalBypassToken === INTERNAL_STATUS_TRANSITION_BYPASS
    if (!bypassPermission) {
      await requirePermission('sales.process')
    }
    const so = await db.salesOrder.findUnique({
      where: { id },
      select: { id: true, orderNumber: true, externalOrderId: true, externalOrderNumber: true, status: true, shipFromWarehouseId: true, lines: { select: { id: true, productId: true, sku: true, qty: true } } },
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

    // Guard: cannot start picking without allocations
    if (targetStatus === 'PICKING') {
      const allocCount = await db.orderAllocation.count({ where: { orderId: id } })
      if (allocCount === 0) {
        return { success: false, error: 'Cannot start picking — no products have been allocated. Allocate stock first.' }
      }
    }

    const data: Record<string, unknown> = { status: targetStatus }
    let orderUpdated = false

    // On SHIPPED: orders must already have shipment rows, and all of them must
    // be shipped through the shipment workflow.
    if (targetStatus === 'SHIPPED') {
      const shipmentCount = await db.shipment.count({ where: { orderId: id } })
      if (shipmentCount === 0) {
        return { success: false, error: 'Shipments are required before an order can be marked as shipped' }
      }
      const unshipped = await db.shipment.count({ where: { orderId: id, status: { not: 'SHIPPED' } } })
      if (unshipped > 0) {
        return { success: false, error: 'Ship individual shipments first — not all shipments are shipped yet' }
      }
      data.shippedAt = new Date()
      if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
    }

    if (targetStatus === 'CANCELLED' && so.status === 'SHIPPED') {
      return { success: false, error: 'Cannot cancel a shipped order — process a refund instead' }
    }

    // On CANCEL: release all allocations
    if (targetStatus === 'CANCELLED') {
      const { deallocateOrder } = await import('./allocation')
      await deallocateOrder(id)
      await db.$transaction(async (tx) => {
        await tx.shipment.deleteMany({ where: { orderId: id, status: { in: ['PENDING', 'PICKING', 'PACKED'] as const } } })
        await tx.salesOrder.update({ where: { id }, data })
      }, STOCK_TX_OPTIONS)
      orderUpdated = true
    }

    if (!orderUpdated) {
      await db.salesOrder.update({ where: { id }, data })
    }

    // Draft finalisation: when a DRAFT is moved to any non-cancelled status,
    // allocate stock (skipped at creation) and queue the sales invoice for
    // accounting sync (also skipped at creation).
    if (so.status === 'DRAFT' && targetStatus !== 'CANCELLED' && targetStatus !== 'DRAFT') {
      try {
        const { autoAllocateOrder } = await import('./allocation')
        await autoAllocateOrder(id)
      } catch { /* Allocation failures must not block the status transition */ }
      try {
        await queueSalesInvoiceForOrder(id)
      } catch { /* Accounting queue errors should never block status transitions */ }
    }

    // Auto-generate invoice on ship if configured (skip its own log —
    // the status_changed entry below covers both actions)
    if (targetStatus === 'SHIPPED') {
      const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
      if (trigger?.value === 'on_shipped') {
        await generateInvoiceNumber(id, { skipLog: true })
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${id}`)
    const statusOrderRef = getSalesOrderReference(so)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'status_changed',
      tag: 'sales',
      level: 'INFO',
      description: `Updated sales order ${statusOrderRef} status to ${targetStatus}`,
      metadata: { orderNumber: statusOrderRef, previousStatus: so.status, newStatus: targetStatus },
    })

    // Push status to WooCommerce (fire-and-forget)
    if ((options?.pushStatusToWooCommerce ?? true) && so.externalOrderId) {
      import('@/lib/connectors/woocommerce/sync/order-status').then((m) =>
        m.pushImsStatusToWc(id, targetStatus as never).catch(() => {}),
      )
    }

    if (targetStatus === 'SHIPPED') {
      try {
        await pushOrderDeliveryMetadata(id)
      } catch (syncError) {
        console.error(syncError)
      }
    }

    return { success: true }
  } catch (e) {
    await logActivity({
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
  lines: RefundRequestLine[],
  reason: string,
  returnWarehouseId?: string,
  options?: { internalBypassToken?: symbol; externalRefundId?: number },
): Promise<{ success: boolean; error?: string }> {
  try {
    if (options?.internalBypassToken !== INTERNAL_ACTION_BYPASS) {
      await requirePermission('sales.refund')
    }
    // Accept lines with qty > 0 (item refund) or totalBase > 0 (monetary-only refund)
    const refundLines = lines.filter((l) => l.qty > 0 || l.totalBase > 0)
    if (!refundLines.length) return { success: false, error: 'Select at least one line to refund' }

    const totalBase = refundLines.reduce((s, l) => s + l.totalBase, 0)

    // --- Atomic refund creation ------------------------------------------
    // Lock the SO row first to serialize concurrent refund requests (double-
    // click, duplicate webhook, concurrent operators). All validation,
    // refund creation, line insertion, and status update happen inside a
    // single transaction so the read-check-write race on cumulative totals
    // and per-line quantities is eliminated.
    const { getNumberingFormats } = await import('./company')
    const numbering = await getNumberingFormats()

    type CreatedRefundLine = {
      id: string; lineId: string | null; productId: string | null; description: string
      qty: number; unitPriceForeign: number; unitPriceBase: number; totalForeign: number; totalBase: number
      lineKind: 'sale' | 'shipping'
    }

    const txResult = await db.$transaction(async (tx) => {
      // Lock the sales order row — prevents concurrent refund creation
      await tx.$executeRaw`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`

      const so = await tx.salesOrder.findUnique({
        where: { id: orderId },
        select: {
          id: true, externalOrderNumber: true, orderNumber: true, status: true,
          fxRateToBase: true, totalBase: true,
          taxRatePercent: true, pricesIncludeVat: true,
          revenueDeferredDate: true, unearnedRevenueAmount: true,
          inventoryAllocatedDate: true, allocationBatchAmount: true,
          lines: { select: { id: true, productId: true, qty: true } },
        },
      })
      if (!so) return { error: 'Order not found' }

      const fxRate = Number(so.fxRateToBase) || 1

      // Validate total refund doesn't exceed order total
      const existingRefunds = await tx.salesOrderRefund.findMany({
        where: { orderId },
        select: { totalBase: true },
      })
      const previouslyRefunded = existingRefunds.reduce((s, r) => s + Number(r.totalBase), 0)
      if (totalBase + previouslyRefunded > Number(so.totalBase) * 1.001) {
        return { error: 'Refund total would exceed order total' }
      }

      // Validate per-line qty doesn't exceed remaining refundable qty
      const existingRefundLines = await tx.salesOrderRefundLine.findMany({
        where: { refund: { orderId } },
        select: { productId: true, qty: true },
      })
      const refundedQtyByProduct = new Map<string, number>()
      for (const rl of existingRefundLines) {
        if (!rl.productId) continue
        refundedQtyByProduct.set(rl.productId, (refundedQtyByProduct.get(rl.productId) ?? 0) + Number(rl.qty))
      }
      const originalQtyByProduct = new Map<string, number>()
      for (const sl of so.lines) {
        if (!sl.productId) continue
        originalQtyByProduct.set(sl.productId, (originalQtyByProduct.get(sl.productId) ?? 0) + Number(sl.qty))
      }
      // Validate per-line qty and block individual kit component refunds.
      // Refund lines must target the SO-line product (the kit), not a
      // component product that only appears in allocations/shipments.
      // Allowing component-level refunds would break kit ratio integrity.
      const soLineProductIds = new Set(
        so.lines.map((sl) => sl.productId).filter((pid): pid is string => pid != null),
      )
      for (const rl of refundLines) {
        if (!rl.productId || rl.qty <= 0) continue
        // Skip external refunds (WC may send component-level data we must accept)
        if (!options?.externalRefundId && !soLineProductIds.has(rl.productId)) {
          return {
            error: `Product ${rl.productId} is a kit component, not a sales line product. ` +
              'Refund the kit product instead — component stock will be returned proportionally.',
          }
        }
        const originalQty = originalQtyByProduct.get(rl.productId) ?? 0
        const alreadyRefunded = refundedQtyByProduct.get(rl.productId) ?? 0
        const remainingRefundable = originalQty - alreadyRefunded
        if (rl.qty > remainingRefundable + 0.001) {
          return { error: `Refund qty ${rl.qty} for product ${rl.productId} exceeds remaining refundable qty ${remainingRefundable.toFixed(2)}` }
        }
      }

      const totalForeign = Math.round(totalBase * fxRate * 10000) / 10000
      // Serialize credit note number generation globally — the SO row lock
      // is per-order, but CN numbers are system-wide. Without this, two
      // concurrent refunds on different orders could read the same count
      // and generate duplicate CN numbers. Advisory lock key chosen to
      // avoid colliding with other lock users in the codebase.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(8675309)`
      const cnCount = await tx.salesOrderRefund.count({ where: { creditNoteNumber: { not: null } } })
      const creditNoteNumber = `${numbering.cn_prefix}${new Date().getFullYear()}-${String(cnCount + 1).padStart(5, '0')}`

      const createdRefund = await tx.salesOrderRefund.create({
        data: {
          orderId,
          creditNoteNumber,
          externalRefundId: options?.externalRefundId ?? null,
          reason: reason || null,
          totalForeign,
          totalBase,
          returnWarehouseId: returnWarehouseId || null,
        },
        select: { id: true },
      })

      const createdRefundLines: CreatedRefundLine[] = []
      for (const refundLine of refundLines) {
        const totalForeign = refundLine.totalForeign != null
          ? Math.round(refundLine.totalForeign * 10000) / 10000
          : Math.round(refundLine.totalBase * fxRate * 10000) / 10000
        const createdLine = await tx.salesOrderRefundLine.create({
          data: {
            refundId: createdRefund.id,
            productId: refundLine.productId,
            description: refundLine.description,
            qty: refundLine.qty,
            unitPriceForeign: refundLine.qty > 0 ? totalForeign / refundLine.qty : 0,
            unitPriceBase: refundLine.qty > 0 ? refundLine.totalBase / refundLine.qty : 0,
            totalForeign,
            totalBase: refundLine.totalBase,
          },
          select: {
            id: true,
            productId: true,
            description: true,
            qty: true,
            unitPriceForeign: true,
            unitPriceBase: true,
            totalForeign: true,
            totalBase: true,
          },
        })
        createdRefundLines.push({
          id: createdLine.id, lineId: refundLine.lineId ?? null, productId: createdLine.productId,
          description: createdLine.description,
          qty: Number(createdLine.qty),
          unitPriceForeign: Number(createdLine.unitPriceForeign),
          unitPriceBase: Number(createdLine.unitPriceBase),
          totalForeign: Number(createdLine.totalForeign),
          totalBase: Number(createdLine.totalBase),
          lineKind: refundLine.lineKind === 'shipping' ? 'shipping' : 'sale',
        })
      }

      // Update order status
      const totalRefundedNow = previouslyRefunded + totalBase
      const orderTotal = Number(so.totalBase)
      const newStatus = totalRefundedNow >= orderTotal * 0.999 ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
      await tx.salesOrder.update({ where: { id: orderId }, data: { status: newStatus } })

      return { so, fxRate, createdRefund, createdRefundLines, previouslyRefunded, creditNoteNumber, newStatus }
    })

    if ('error' in txResult) return { success: false, error: txResult.error }

    const { so, createdRefund, createdRefundLines, creditNoteNumber, newStatus } = txResult

    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
    const refundOrderRef = getSalesOrderReference(so)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'refunded',
      tag: 'sales',
      level: 'INFO',
      description: `Created refund for order ${refundOrderRef} — £${totalBase.toFixed(2)}`,
      metadata: { orderNumber: refundOrderRef, totalBase, creditNoteNumber, reason },
    })

    // Queue accounting credit note sync
    try {
      const [settings, orderForCN, baseCurrency] = await Promise.all([
        getAccountingSettings(),
        db.salesOrder.findUnique({
          where: { id: orderId },
          select: {
            customer: { select: { firstName: true, lastName: true, email: true } },
            currency: true,
            taxRateName: true,
            lines: {
              select: {
                id: true,
                taxRate: { select: { accountingTaxType: true } },
              },
            },
          },
        }),
        getBaseCurrencyCode(),
      ])
      const cnContactName = orderForCN?.customer
        ? `${orderForCN.customer.firstName} ${orderForCN.customer.lastName}`.trim()
        : 'Walk-in Customer'
      // Look up accounting tax type from the order's tax rate
      const cnTaxRate = orderForCN?.taxRateName
        ? await db.taxRate.findFirst({ where: { name: orderForCN.taxRateName, active: true }, select: { accountingTaxType: true } })
        : null
      const taxTypeBySalesLineId = new Map(
        (orderForCN?.lines ?? []).map((line) => [line.id, line.taxRate?.accountingTaxType ?? undefined]),
      )
      await queueAccountingSync({
        type: 'CREDIT_NOTE',
        referenceType: 'SalesOrderRefund',
        referenceId: createdRefund.id,
        payload: {
          creditNoteNumber,
          contactName: cnContactName,
          contactEmail: orderForCN?.customer?.email ?? undefined,
          date: new Date().toISOString().slice(0, 10),
          currency: orderForCN?.currency ?? baseCurrency,
          reference: so.externalOrderNumber ?? undefined,
          lines: createdRefundLines.map((l) => ({
            description: l.description || 'Refund line',
            quantity: l.qty > 0 ? l.qty : 1,
            unitAmount: orderForCN?.currency === baseCurrency
              ? (l.qty > 0 ? l.unitPriceBase : l.totalBase)
              : (l.qty > 0 ? l.unitPriceForeign : l.totalForeign),
            accountCode: l.lineKind === 'shipping'
              ? (settings.shippingAccount || settings.salesAccount)
              : settings.salesAccount,
            taxType: (l.lineId ? taxTypeBySalesLineId.get(l.lineId) : undefined) ?? cnTaxRate?.accountingTaxType ?? undefined,
          })),
          lineAmountsIncludeTax: false,
        },
      })
    } catch { /* Accounting queue errors should never block the main flow */ }

    // Queue sub-ledger reversal journals based on state
    // Scenario 1: paidAt set but revenueDeferredDate NULL → no journals to reverse
    // Scenario 2: revenueDeferredDate set, inventoryAllocatedDate NULL (backorder) → reverse unearned revenue only
    // Scenario 3: inventoryAllocatedDate set, no shipments journaled → reverse unearned revenue + inventory allocation
    // Scenario 4: shipments journaled → reverse COGS for shipped portion + unearned for unshipped portion
    let snapshotReturnRows: RefundReturnRow[] | null = null
    try {
      const settings = await getAccountingSettings()
      const orderRef = getSalesOrderReference(so)

      if (so.revenueDeferredDate) {
        const toNetRevenue = (amountBase: number): number => Math.round(amountBase * 100) / 100

        const refundRevenue = Math.round(createdRefundLines.reduce((sum, line) => sum + toNetRevenue(line.totalBase), 0) * 100) / 100
        const reversalAmounts = await db.$transaction(async (tx) => {
          const orderAccounting = await tx.salesOrder.findUnique({
            where: { id: orderId },
            select: {
              allocations: {
                select: {
                  id: true,
                  lineId: true,
                  warehouseId: true,
                  costLayerSnapshot: true,
                },
              },
              lines: {
                select: {
                  id: true,
                  productId: true,
                  description: true,
                  qty: true,
                  totalBase: true,
                },
              },
              shipments: {
                where: { shipmentJournalDate: { not: null } },
                select: {
                  revenueRecognizedAmount: true,
                  cogsBatchAmount: true,
                  lines: {
                    select: {
                      id: true,
                      lineId: true,
                      qty: true,
                      costLayerSnapshot: true,
                    },
                  },
                },
              },
              refunds: {
                where: { id: { not: createdRefund.id } },
                select: {
                  lines: {
                    select: {
                      id: true,
                      productId: true,
                      description: true,
                      qty: true,
                      totalBase: true,
                      unitPriceBase: true,
                      costLayerSnapshot: true,
                    },
                  },
                },
              },
            },
          })

          const priorReversals = await tx.accountingSyncLog.findMany({
            where: {
              connector: 'xero',
              referenceType: 'SalesOrder',
              referenceId: orderId,
              type: { in: ['COGS_REVERSAL', 'UNEARNED_REV_REVERSAL'] },
              status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
            },
            select: { type: true, payload: true },
          })

          const referencedCostLayerIds = Array.from(new Set([
            ...(orderAccounting?.allocations ?? []).flatMap((allocation) => (
              parseCostLayerSnapshot(allocation.costLayerSnapshot).map((entry) => entry.costLayerId)
            )),
            ...(orderAccounting?.shipments ?? []).flatMap((shipment) => (
              shipment.lines.flatMap((line) => (
                parseCostLayerSnapshot(line.costLayerSnapshot).map((entry) => entry.costLayerId)
              ))
            )),
            ...(orderAccounting?.refunds ?? []).flatMap((refund) => (
              refund.lines.flatMap((line) => (
                parseCostLayerSnapshot(line.costLayerSnapshot).map((entry) => entry.costLayerId)
              ))
            )),
          ]))
          await lockCostLayers(tx, referencedCostLayerIds)
          const referencedCostLayers = referencedCostLayerIds.length > 0
            ? await tx.costLayer.findMany({
                where: { id: { in: referencedCostLayerIds } },
                select: { id: true, productId: true, poLineId: true },
              })
            : []
          const productIdByCostLayerId = new Map(referencedCostLayers.map((layer) => [layer.id, layer.productId]))
          const poLineIdByCostLayerId = new Map(referencedCostLayers.map((layer) => [layer.id, layer.poLineId]))

          const extractPayloadAmount = (
            payload: unknown,
            accountCode: string,
          ): number => {
            const linesPayload = (payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> } | null)?.lines
            if (!Array.isArray(linesPayload)) return 0
            return linesPayload.reduce((sum, line) => (
              line.accountCode === accountCode ? sum + Number(line.debit ?? 0) : sum
            ), 0)
          }

          const priorUnearnedReversed = priorReversals
            .filter((row) => row.type === 'UNEARNED_REV_REVERSAL')
            .reduce((sum, row) => sum + extractPayloadAmount(row.payload, settings.unearnedRevenueAccount), 0)

          const lineContexts = (orderAccounting?.lines ?? []).map((line) => ({
            id: line.id,
            productId: line.productId,
            description: line.description,
            qty: Number(line.qty),
            totalBase: Number(line.totalBase),
          }))

          function priceMatches(unitRevenue: number, candidateUnitPrice: number | null): boolean {
            if (candidateUnitPrice == null) return false
            return Math.abs(unitRevenue - candidateUnitPrice) < 0.0001
          }

          function consumeRefundLineQuantity(
            lineStates: Array<{
              id: string
              productId: string | null
              description: string
              qty: number
              totalBase: number
            }>,
            remainingShipped: Map<string, number>,
            remainingUnshipped: Map<string, number>,
            refundLine: { productId: string | null; description: string; qty: number; totalBase: number; unitPriceBase?: number | null },
          ): {
            shippedRevenue: number
            unshippedRevenue: number
            assignedRevenue: number
            shippedQty: number
            unshippedQty: number
            lineAllocations: Array<{ lineId: string; shippedQty: number; unshippedQty: number }>
          } {
            if (!refundLine.productId || refundLine.qty <= 0) {
              return {
                shippedRevenue: 0,
                unshippedRevenue: 0,
                assignedRevenue: 0,
                shippedQty: 0,
                unshippedQty: 0,
                lineAllocations: [],
              }
            }

            let remainingQty = refundLine.qty
            let shippedRevenue = 0
            let unshippedRevenue = 0
            let assignedRevenue = 0
            let shippedQty = 0
            let unshippedQty = 0
            const lineAllocations: Array<{ lineId: string; shippedQty: number; unshippedQty: number }> = []
            const refundUnitPrice = refundLine.unitPriceBase != null
              ? Number(refundLine.unitPriceBase)
              : (refundLine.qty > 0 ? refundLine.totalBase / refundLine.qty : null)

            const matchingLines = lineStates
              .filter((line) => line.productId === refundLine.productId)
              .sort((a, b) => {
                const aUnitRevenue = a.qty > 0 ? a.totalBase / a.qty : 0
                const bUnitRevenue = b.qty > 0 ? b.totalBase / b.qty : 0
                const aPriceMatch = priceMatches(aUnitRevenue, refundUnitPrice)
                const bPriceMatch = priceMatches(bUnitRevenue, refundUnitPrice)
                if (aPriceMatch !== bPriceMatch) return aPriceMatch ? -1 : 1

                const aDescMatch = a.description === refundLine.description
                const bDescMatch = b.description === refundLine.description
                if (aDescMatch !== bDescMatch) return aDescMatch ? -1 : 1

                return 0
              })

            for (const line of matchingLines) {
              if (remainingQty <= 0 || line.qty <= 0) break

              const unitRevenue = line.totalBase / line.qty
              const shippedQtyAvailable = remainingShipped.get(line.id) ?? 0
              const shippedTake = Math.min(remainingQty, shippedQtyAvailable)
              if (shippedTake > 0) {
                const shippedValue = unitRevenue * shippedTake
                shippedRevenue += shippedValue
                shippedQty += shippedTake
                assignedRevenue += shippedValue
                remainingQty -= shippedTake
                remainingShipped.set(line.id, shippedQtyAvailable - shippedTake)
                lineAllocations.push({ lineId: line.id, shippedQty: shippedTake, unshippedQty: 0 })
              }

              const unshippedQtyAvailable = remainingUnshipped.get(line.id) ?? 0
              const unshippedTake = Math.min(remainingQty, unshippedQtyAvailable)
              if (unshippedTake > 0) {
                const unshippedValue = unitRevenue * unshippedTake
                unshippedRevenue += unshippedValue
                unshippedQty += unshippedTake
                assignedRevenue += unshippedValue
                remainingQty -= unshippedTake
                remainingUnshipped.set(line.id, unshippedQtyAvailable - unshippedTake)
                lineAllocations.push({ lineId: line.id, shippedQty: 0, unshippedQty: unshippedTake })
              }
            }

            return { shippedRevenue, unshippedRevenue, assignedRevenue, shippedQty, unshippedQty, lineAllocations }
          }

          const shippedQtyByLine = new Map<string, number>()
          let totalRecognized = 0

          for (const shipment of orderAccounting?.shipments ?? []) {
            totalRecognized += Number(shipment.revenueRecognizedAmount ?? 0)
            for (const line of shipment.lines) {
              shippedQtyByLine.set(
                line.lineId,
                (shippedQtyByLine.get(line.lineId) ?? 0) + Number(line.qty),
              )
            }
          }

          const remainingShippedQtyByLine = new Map<string, number>()
          const remainingUnshippedQtyByLine = new Map<string, number>()

          for (const line of lineContexts) {
            const shippedQty = Math.min(line.qty, shippedQtyByLine.get(line.id) ?? 0)
            const unshippedQty = Math.max(0, line.qty - shippedQty)
            remainingShippedQtyByLine.set(line.id, shippedQty)
            remainingUnshippedQtyByLine.set(line.id, unshippedQty)
          }

          for (const priorRefund of orderAccounting?.refunds ?? []) {
            for (const priorRefundLine of priorRefund.lines) {
              consumeRefundLineQuantity(
                lineContexts,
                remainingShippedQtyByLine,
                remainingUnshippedQtyByLine,
                {
                  productId: priorRefundLine.productId,
                  description: priorRefundLine.description,
                  qty: Number(priorRefundLine.qty),
                  totalBase: Number(priorRefundLine.totalBase),
                  unitPriceBase: Number(priorRefundLine.unitPriceBase),
                },
              )
            }
          }

          let shippedQtyRevenue = 0
          let unshippedQtyRevenue = 0
          let nonQtyRevenue = 0
          const refundLayerSnapshots = new Map<string, CostLayerSnapshotEntry[]>()
          const shipmentLineAvailability = new Map<string, CostLayerSnapshotEntry[]>()
          const allocationAvailability = new Map<string, CostLayerSnapshotEntry[]>()

          for (const shipment of orderAccounting?.shipments ?? []) {
            for (const shipmentLine of shipment.lines) {
              shipmentLineAvailability.set(
                shipmentLine.id,
                parseCostLayerSnapshot(shipmentLine.costLayerSnapshot),
              )
            }
          }

          for (const allocation of orderAccounting?.allocations ?? []) {
            allocationAvailability.set(
              allocation.id,
              parseCostLayerSnapshot(allocation.costLayerSnapshot),
            )
          }

          for (const shipment of orderAccounting?.shipments ?? []) {
            for (const shipmentLine of shipment.lines) {
              for (const entry of parseCostLayerSnapshot(shipmentLine.costLayerSnapshot)) {
                if (!entry.orderAllocationId) continue
                const available = allocationAvailability.get(entry.orderAllocationId) ?? []
                allocationAvailability.set(
                  entry.orderAllocationId,
                  reduceSnapshotByCostLayer(available, [{ costLayerId: entry.costLayerId, qty: entry.qty }]),
                )
              }
            }
          }

          for (const priorRefund of orderAccounting?.refunds ?? []) {
            for (const priorRefundLine of priorRefund.lines) {
              for (const entry of parseCostLayerSnapshot(priorRefundLine.costLayerSnapshot)) {
                if (entry.source === 'shipment' && entry.shipmentLineId) {
                  const available = shipmentLineAvailability.get(entry.shipmentLineId) ?? []
                  shipmentLineAvailability.set(
                    entry.shipmentLineId,
                    reduceSnapshotByCostLayer(available, [{ costLayerId: entry.costLayerId, qty: entry.qty }]),
                  )
                }
                if (entry.source === 'allocation' && entry.orderAllocationId) {
                  const available = allocationAvailability.get(entry.orderAllocationId) ?? []
                  allocationAvailability.set(
                    entry.orderAllocationId,
                    reduceSnapshotByCostLayer(available, [{ costLayerId: entry.costLayerId, qty: entry.qty }]),
                  )
                }
              }
            }
          }

          const consumeShipmentCostForLine = (lineId: string, qty: number): CostLayerSnapshotEntry[] => {
            let remainingQty = qty
            const consumed: CostLayerSnapshotEntry[] = []
            for (const shipment of orderAccounting?.shipments ?? []) {
              for (const shipmentLine of shipment.lines) {
                if (shipmentLine.lineId !== lineId || remainingQty <= 0) continue
                const available = shipmentLineAvailability.get(shipmentLine.id) ?? []
                const taken = takeFromSnapshotEntries(available, remainingQty, {
                  shipmentLineId: shipmentLine.id,
                  source: 'shipment',
                })
                consumed.push(...taken.taken)
                remainingQty = taken.remainingQty
                shipmentLineAvailability.set(
                  shipmentLine.id,
                  reduceSnapshotByCostLayer(
                    available,
                    taken.taken.map((entry) => ({ costLayerId: entry.costLayerId, qty: entry.qty })),
                  ),
                )
              }
            }
            if (remainingQty > 0.0000001) {
              throw new Error(`Missing shipped FIFO history for refunded line ${lineId}`)
            }
            return consumed
          }

          const consumeAllocationCostForLine = (lineId: string, qty: number): CostLayerSnapshotEntry[] => {
            let remainingQty = qty
            const consumed: CostLayerSnapshotEntry[] = []
            for (const allocation of orderAccounting?.allocations ?? []) {
              if (allocation.lineId !== lineId || remainingQty <= 0) continue
              const available = allocationAvailability.get(allocation.id) ?? []
              const taken = takeFromSnapshotEntries(available, remainingQty, {
                orderAllocationId: allocation.id,
                source: 'allocation',
              })
              consumed.push(...taken.taken)
              remainingQty = taken.remainingQty
              allocationAvailability.set(
                allocation.id,
                reduceSnapshotByCostLayer(
                  available,
                  taken.taken.map((entry) => ({ costLayerId: entry.costLayerId, qty: entry.qty })),
                ),
              )
            }
            if (remainingQty > 0.0000001) {
              throw new Error(`Missing allocated FIFO history for refunded line ${lineId}`)
            }
            return consumed
          }

          for (const refundLine of createdRefundLines) {
            const refundLineNet = toNetRevenue(refundLine.totalBase)
            if (!refundLine.productId || refundLine.qty <= 0) {
              nonQtyRevenue += refundLineNet
              continue
            }

            const allocation = consumeRefundLineQuantity(
              lineContexts,
              remainingShippedQtyByLine,
              remainingUnshippedQtyByLine,
              refundLine,
            )
            shippedQtyRevenue += allocation.shippedRevenue
            unshippedQtyRevenue += allocation.unshippedRevenue

            const costSnapshot: CostLayerSnapshotEntry[] = []
            for (const lineAllocation of allocation.lineAllocations) {
              if (lineAllocation.shippedQty > 0) {
                costSnapshot.push(...consumeShipmentCostForLine(lineAllocation.lineId, lineAllocation.shippedQty))
              }
              if (lineAllocation.unshippedQty > 0) {
                costSnapshot.push(...consumeAllocationCostForLine(lineAllocation.lineId, lineAllocation.unshippedQty))
              }
            }
            refundLayerSnapshots.set(refundLine.id, costSnapshot)
            nonQtyRevenue += Math.max(0, refundLineNet - allocation.assignedRevenue)
          }

          const componentTotal = shippedQtyRevenue + unshippedQtyRevenue + nonQtyRevenue
          const roundingDelta = Math.round((refundRevenue - componentTotal) * 100) / 100
          if (roundingDelta > 0) {
            nonQtyRevenue += roundingDelta
          }

          for (const refundLine of createdRefundLines) {
            const costSnapshot = refundLayerSnapshots.get(refundLine.id) ?? []
            await tx.salesOrderRefundLine.update({
              where: { id: refundLine.id },
              data: {
                costLayerSnapshot: costSnapshot as never,
              },
            })
          }

          if (returnWarehouseId) {
            snapshotReturnRows = createdRefundLines.flatMap((refundLine) => (
              (refundLayerSnapshots.get(refundLine.id) ?? []).flatMap((entry) => {
                const productId = productIdByCostLayerId.get(entry.costLayerId)
                if (!productId) return []
                return [{
                  productId,
                  qty: entry.qty,
                  unitCostBase: entry.unitCostBase,
                  poLineId: poLineIdByCostLayerId.get(entry.costLayerId) ?? null,
                  sourceCostLayerId: entry.costLayerId,
                }]
              })
            ))
          }

          const remainingUnearned = Math.round(Math.max(
            0,
            Number(so.unearnedRevenueAmount ?? 0) - totalRecognized - priorUnearnedReversed,
          ) * 100) / 100
          const shipmentRefundSnapshot = createdRefundLines.flatMap((line) => (
            (refundLayerSnapshots.get(line.id) ?? []).filter((entry) => entry.source === 'shipment')
          ))
          const allocationRefundSnapshot = createdRefundLines.flatMap((line) => (
            (refundLayerSnapshots.get(line.id) ?? []).filter((entry) => entry.source === 'allocation')
          ))

          return {
            cogsReversal: Math.round(sumCostLayerSnapshot(shipmentRefundSnapshot) * 100) / 100,
            unearnedReversal: Math.min(
              remainingUnearned,
              Math.round((unshippedQtyRevenue + nonQtyRevenue) * 100) / 100,
            ),
            allocationReversal: Math.round(sumCostLayerSnapshot(allocationRefundSnapshot) * 100) / 100,
          }
        }, STOCK_TX_OPTIONS)

        if (reversalAmounts.cogsReversal > 0) {
          await queueAccountingSync({
            type: 'COGS_REVERSAL',
            referenceType: 'SalesOrder',
            referenceId: orderId,
            payload: {
              date: new Date().toISOString().slice(0, 10),
              reference: `COGS reversal: ${orderRef}`,
              narration: `COGS reversal — refund on order ${orderRef}`,
              lines: [
                { accountCode: settings.inventoryAccount, description: `COGS reversal: ${orderRef}`, debit: reversalAmounts.cogsReversal },
                { accountCode: settings.cogsAccount, description: `COGS reversal: ${orderRef}`, credit: reversalAmounts.cogsReversal },
              ],
            },
          })
        }

        const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []
        if (reversalAmounts.unearnedReversal > 0) {
          journalLines.push(
            { accountCode: settings.unearnedRevenueAccount, description: `Unearned revenue reversal: ${orderRef}`, debit: reversalAmounts.unearnedReversal },
            { accountCode: settings.salesAccount, description: `Unearned revenue reversal: ${orderRef}`, credit: reversalAmounts.unearnedReversal },
          )
        }
        if (reversalAmounts.allocationReversal > 0) {
          journalLines.push(
            { accountCode: settings.inventoryAccount, description: `Allocation reversal: ${orderRef}`, debit: reversalAmounts.allocationReversal },
            { accountCode: settings.allocatedInventoryAccount, description: `Allocation reversal: ${orderRef}`, credit: reversalAmounts.allocationReversal },
          )
        }

        if (journalLines.length > 0) {
          const hasInventoryReversal = reversalAmounts.allocationReversal > 0
          await queueAccountingSync({
            type: 'UNEARNED_REV_REVERSAL',
            referenceType: 'SalesOrder',
            referenceId: orderId,
            payload: {
              date: new Date().toISOString().slice(0, 10),
              reference: `Unearned reversal: ${orderRef}`,
              narration: hasInventoryReversal
                ? `Unearned revenue + allocation reversal — refund on order ${orderRef}`
                : `Unearned revenue reversal — refund on order ${orderRef}`,
              lines: journalLines,
            },
          })
        }

        if (newStatus === 'REFUNDED') {
          await db.salesOrder.update({
            where: { id: orderId },
            data: {
              revenueDeferredDate: null,
              inventoryAllocatedDate: null,
            },
          })
        }
      }
      // Scenario 1: no revenueDeferredDate → no sub-ledger journals to reverse
    } catch { /* Accounting queue errors should never block the main flow */ }

    if (returnWarehouseId) {
      const snapshotRows: RefundReturnRow[] = snapshotReturnRows ?? []
      const returnRows = snapshotRows.length > 0
        ? snapshotRows
        : await buildRefundFallbackReturnRows(orderId, refundLines)

      const returnedProductIds = await applyRefundReturnStock(
        orderId,
        refundOrderRef,
        returnWarehouseId,
        returnRows,
      )

      if (returnedProductIds.length > 0) {
        try {
          await enqueueStockSync(
            [...new Set(returnedProductIds)],
            'IMS_CHANGE',
          )
        } catch (syncError) {
          console.error(syncError)
        }
      }
    }

    return { success: true }
  } catch (e) {
    if (
      options?.externalRefundId &&
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code?: string }).code === 'P2002'
    ) {
      return { success: true }
    }
    await logActivity({
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
    await requirePermission('sales.create')
    const so = await db.salesOrder.findUnique({
      where: { id },
      include: { lines: true },
    })
    if (!so) return { success: false, error: 'Order not found' }

    const ref = `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const clone = await db.salesOrder.create({
      data: {
        orderNumber: ref,
        status: 'DRAFT',
        currency: so.currency,
        fxRateToBase: so.fxRateToBase,
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
        subtotalBase: so.subtotalBase,
        shippingBase: so.shippingBase,
        taxBase: so.taxBase,
        totalBase: so.totalBase,
        shipFromWarehouseId: so.shipFromWarehouseId,
        salesRep: so.salesRep,
        discountStr: so.discountStr,
        discountAmount: so.discountAmount,
        taxRateName: so.taxRateName,
        taxRatePercent: so.taxRatePercent,
        notes: so.notes,
        internalNotes: so.internalNotes,
        lines: {
          create: so.lines.map((l) => ({
            productId: l.productId,
            sku: l.sku,
            description: l.description,
            qty: l.qty,
            unitPriceForeign: l.unitPriceForeign,
            unitPriceBase: l.unitPriceBase,
            discountStr: l.discountStr,
            discountAmount: l.discountAmount,
            taxRateId: l.taxRateId,
            taxForeign: l.taxForeign,
            taxBase: l.taxBase,
            totalForeign: l.totalForeign,
            totalBase: l.totalBase,
          })),
        },
      },
    })

    // Auto-allocate stock for cloned order
    const { autoAllocateOrder } = await import('./allocation')
    await autoAllocateOrder(clone.id)

    revalidatePath('/sales')
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: clone.id,
      action: 'cloned',
      tag: 'sales',
      level: 'INFO',
      description: `Cloned sales order ${getSalesOrderReference(so)}`,
      metadata: { sourceOrderId: id, sourceOrderNumber: getSalesOrderReference(so), newOrderNumber: ref },
    })
    return { success: true, newId: clone.id }
  } catch (e) {
    await logActivity({
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
    await requirePermission('sales.create')
    const so = await db.salesOrder.findUnique({
      where: { id },
      select: { orderNumber: true, externalOrderNumber: true, status: true, shipFromWarehouseId: true, lines: { select: { productId: true, qty: true } }, _count: { select: { refunds: true, payments: true } } },
    })
    if (!so) return { success: false, error: 'Order not found' }
    if (!['DRAFT', 'PENDING_PAYMENT', 'ALLOCATED'].includes(so.status)) return { success: false, error: 'Only draft, pending payment, or allocated orders can be deleted' }
    if (so._count.refunds > 0 || so._count.payments > 0) return { success: false, error: 'Cannot delete an order with refunds or payments' }

    // Release allocations
    const { deallocateOrder } = await import('./allocation')
    await deallocateOrder(id)

    await db.salesOrderLine.deleteMany({ where: { orderId: id } })
    await db.salesOrder.delete({ where: { id } })
    revalidatePath('/sales')
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'deleted',
      tag: 'sales',
      level: 'INFO',
      description: `Deleted sales order ${getSalesOrderReference({ id, ...so })}`,
      metadata: { orderNumber: getSalesOrderReference({ id, ...so }) },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
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
    await requirePermission('sales.refund')
    const so = await db.salesOrder.findUnique({ where: { id }, select: { orderNumber: true, externalOrderNumber: true, paidAt: true, invoiceNumber: true } })
    if (!so) return { success: false, error: 'Order not found' }

    const markingAsPaid = !so.paidAt // transitioning from unpaid to paid
    await db.salesOrder.update({
      where: { id },
      data: { paidAt: markingAsPaid ? new Date() : null },
    })

    // Only auto-generate invoice when transitioning TO paid (not when toggling off).
    // Skip its own log — the 'paid' entry below covers both actions.
    if (markingAsPaid && !so.invoiceNumber) {
      const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
      if (trigger?.value === 'on_paid') {
        await generateInvoiceNumber(id, { skipLog: true })
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${id}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'paid',
      tag: 'sales',
      level: 'INFO',
      description: `Marked sales order ${getSalesOrderReference({ id, ...so })} as paid`,
      metadata: { orderNumber: getSalesOrderReference({ id, ...so }), markingAsPaid },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
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
    await requirePermission('sales.create')
    const so = await db.salesOrder.update({
      where: { id },
      data: { notes: notes || null, internalNotes: internalNotes || null },
      select: { orderNumber: true, externalOrderNumber: true },
    })
    revalidatePath(`/sales/${id}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'sales',
      level: 'INFO',
      description: `Updated notes for order ${getSalesOrderReference({ id, ...so })}`,
      metadata: { orderNumber: getSalesOrderReference({ id, ...so }) },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
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

export async function generateInvoiceNumber(id: string, options?: { skipLog?: boolean }): Promise<{ success: boolean; invoiceNumber?: string; error?: string }> {
  try {
    await requirePermission('sales.process')
    // Use a transaction with an advisory lock to prevent race conditions
    // on invoice numbering. The SO row lock (implicit via update) is
    // per-order, but invoice numbers are system-wide — without the
    // advisory lock, two concurrent calls on different orders can read
    // the same count and generate duplicate invoice numbers.
    const result = await db.$transaction(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id }, select: { externalOrderNumber: true, orderNumber: true, invoiceNumber: true } })
      if (!so) throw new Error('Order not found')
      if (so.invoiceNumber) return { invoiceNumber: so.invoiceNumber, orderNumber: getSalesOrderReference({ id, ...so }) }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(8675310)`
      const count = await tx.salesOrder.count({ where: { invoiceNumber: { not: null } } })
      const invNum = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`
      await tx.salesOrder.update({ where: { id }, data: { invoiceNumber: invNum, invoicedAt: new Date() } })
      return { invoiceNumber: invNum, orderNumber: getSalesOrderReference({ id, ...so }) }
    })
    revalidatePath(`/sales/${id}`)
    if (!options?.skipLog) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: id,
        action: 'invoice_generated',
        tag: 'sales',
        level: 'INFO',
        description: `Generated invoice number for order ${result.orderNumber}`,
        metadata: { orderNumber: result.orderNumber, invoiceNumber: result.invoiceNumber },
      })
    }

    // Note: Accounting invoice is now created at order creation time (not here)

    return { success: true, invoiceNumber: result.invoiceNumber }
  } catch (e) {
    await logActivity({
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
    await requirePermission('sales.refund')
    if (!input.amount || input.amount <= 0) return { success: false, error: 'Amount must be greater than 0' }
    const so = await db.salesOrder.findUnique({
      where: { id: input.orderId },
      select: {
        orderNumber: true,
        externalOrderNumber: true,
        currency: true,
        totalForeign: true,
        paidAt: true,
      },
    })
    if (so && input.currency !== so.currency) {
      return { success: false, error: `Payment currency must match order currency (${so.currency})` }
    }
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
    if (so && !so.paidAt) {
      const payments = await db.payment.findMany({
        where: { orderId: input.orderId, refundId: null },
        select: { amount: true, currency: true },
      })
      const totalPaid = payments.reduce((sum, payment) => {
        if (payment.currency !== so.currency) return sum
        return sum + Number(payment.amount)
      }, 0)
      if (totalPaid >= Number(so.totalForeign)) {
        await db.salesOrder.update({ where: { id: input.orderId }, data: { paidAt: new Date() } })

        // Auto-generate invoice if trigger is on_paid (skip its own log —
        // the payment_added entry below covers both actions)
        const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
        if (trigger?.value === 'on_paid') {
          await generateInvoiceNumber(input.orderId, { skipLog: true })
        }
      }
    }

    revalidatePath(`/sales/${input.orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: input.orderId,
      action: 'payment_added',
      tag: 'sales',
      level: 'INFO',
      description: `Added ${input.currency} ${input.amount.toFixed(2)} payment to order ${so ? getSalesOrderReference({ id: input.orderId, ...so }) : input.orderId}`,
      metadata: { orderNumber: so ? getSalesOrderReference({ id: input.orderId, ...so }) : input.orderId, amount: input.amount, currency: input.currency, method: input.method },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
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
    await requirePermission('sales.refund')
    await db.payment.delete({ where: { id: paymentId } })
    const so = await db.salesOrder.findUnique({ where: { id: orderId }, select: { orderNumber: true, externalOrderNumber: true } })
    revalidatePath(`/sales/${orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'payment_deleted',
      tag: 'sales',
      level: 'INFO',
      description: `Deleted payment from order ${so ? getSalesOrderReference({ id: orderId, ...so }) : orderId}`,
      metadata: { orderNumber: so ? getSalesOrderReference({ id: orderId, ...so }) : orderId, paymentId },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
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
