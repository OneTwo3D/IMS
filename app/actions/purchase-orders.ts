'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { queueAccountingSync, queueAccountingSyncTx, getAccountingSettings, listAccountingBankAccounts, type AccountingBankAccount } from '@/lib/accounting'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { enqueueStockSync } from '@/lib/shopping'
import { allocateBackordersForProducts } from '@/lib/fulfillment/backorder-allocator'
import { releaseOverallocations } from '@/lib/fulfillment/overallocation-rebalancer'
import { consumeFifoLayersStrict } from '@/lib/cost-layers'
import { isOperationalProductStatus } from '@/lib/products/lifecycle'
import { resolveLineTaxRateBatch, type ResolvedTaxRate } from '@/lib/tax/resolve-rate'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import {
  computeGrossUnitCostBaseByLine,
  queueLandedCostAdjustmentJournals,
  recalculateDirectLandedCosts,
  recalculateLandedCosts,
} from '@/lib/domain/purchasing/landed-cost-service'
import {
  validateLinkedFreightReceiptStatus,
  validatePurchaseOrderStatusTransition,
  validatePurchaseReceiptStatusUpdate,
} from '@/lib/domain/workflows/action-guards'
import {
  buildRealisedFxJournal,
  computeRealisedFx,
  getRealisedFxAccounts,
  resolveSettlementFxRateToBase,
} from '@/lib/accounting-fx'
import { Prisma, type TaxCategory } from '@/app/generated/prisma/client'
import { addMoney, multiplyMoney, roundQuantity } from '@/lib/domain/math/decimal'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PoStatus = 'DRAFT' | 'RFQ_SENT' | 'QUOTE_RECEIVED' | 'PO_SENT' | 'SHIPPED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'INVOICED' | 'PARTIALLY_RETURNED' | 'RETURNED' | 'CANCELLED'

export type PoLineRow = {
  id: string
  productId: string
  sku: string
  productName: string
  imageUrl: string | null
  description: string | null
  qty: number
  unitCostForeign: number
  unitCostBase: number
  discountStr: string | null
  discountAmount: number
  totalForeign: number
  totalBase: number
  qtyReceived: number
  qtyBilled: number
  purchaseUnitId: string | null
  purchaseUnitName: string | null
  purchaseUnitStockName: string | null
  purchaseUnitQty: number | null
  qtyReturned: number
  grossUnitCostBase: number // unitCostBase + landed cost per unit
  qtyToReceive: number  // qty - qtyReceived (still outstanding)
  qtyRemaining: number  // qtyReceived - qtyReturned (net on hand)
  sortOrder: number
  /** Per-line tax rate id (resolved from product category + destination). */
  taxRateId: string | null
  /** Per-line effective rate percentage (0..1). Null when no per-line rate. */
  taxRatePercent: number | null
  /** Short label for the rate (e.g. "REDUCED 5%"). Null when no per-line rate. */
  taxRateName: string | null
}

export type PoRow = {
  id: string
  reference: string
  type: 'GOODS' | 'FREIGHT'
  status: PoStatus
  supplierId: string
  supplierName: string
  currency: string
  fxRateToBase: number
  subtotalForeign: number
  subtotalBase: number
  taxRateName: string | null
  taxRatePercent: number | null
  taxForeign: number
  taxBase: number
  totalForeign: number
  totalBase: number
  directFreightForeign: number
  directFreightBase: number
  orderDiscountStr: string | null
  orderDiscountForeign: number
  landedCostMethod: string
  destinationWarehouseId: string | null
  destinationWarehouseName: string | null
  supplierRef: string | null
  expectedDelivery: string | null
  notes: string | null
  internalNotes: string | null
  createdAt: string
  updatedAt: string
  lineCount: number
  // Derived flags for multi-status display
  isInvoiced: boolean
  invoiceCount: number
  isPartiallyReturned: boolean
  isFullyReturned: boolean
  trackingNumber: string | null
  shippingProvider: string | null
}

export type PoReturn = {
  id: string
  reference: string | null
  reason: string | null
  notes: string | null
  returnedAt: string
  lines: {
    id: string
    poLineId: string
    productId: string
    sku: string
    productName: string
    qtyReturned: number
    warehouseId: string | null
  }[]
}

export type PoDetail = PoRow & {
  lines: PoLineRow[]
  receipts: {
    id: string
    reference: string | null
    receivedAt: string
    notes: string | null
    lines: {
      id: string
      poLineId: string
      productId: string
      sku: string
      productName: string
      qtyReceived: number
      warehouseId: string | null
      warehouseName: string | null
    }[]
  }[]
  returns: PoReturn[]
  invoices: InvoiceRow[]
  freightCostLines: { id: string; description: string; amountForeign: number; amountBase: number; amountBilled: number; vatable: boolean; distributionMethod: string }[]
  linkedFreightPos: {
    linkId: string
    method: string
    freightPo: {
      id: string
      reference: string
      supplierName: string
      totalForeign: number
      totalBase: number
      costLines: { description: string; amountBase: number; distributionMethod: string }[]
    }
  }[]
  totalLandedCostBase: number
  linkedPrimaryPos: { id: string; reference: string; supplierName: string; totalBase: number }[]
}

export type PoLineInput = {
  productId: string
  sku: string
  productName: string
  description?: string
  qty: number // stock units
  purchaseUnitId?: string
  purchaseUnitQty?: number // qty in purchase units
  unitCostForeign: number // user-entered cost per stock unit (gross if pricesIncludeVat, else net) — pre-discount
  sortOrder?: number
  /**
   * Optional manual override of the tax rate for this line. When null/omitted
   * the server resolves a rate from the product's tax category + destination
   * warehouse country.
   */
  taxRateId?: string | null
  /** Original user input for the per-line discount, e.g. "5%" or "2.50". */
  discountStr?: string | null
  /**
   * Per-line discount amount in the order's foreign currency, in the same
   * tax convention as `unitCostForeign` (gross when `pricesIncludeVat`, else
   * net). Stored as entered; subtracted from the line total before VAT
   * extraction on the server.
   */
  discountAmount?: number
}

export type CreatePoInput = {
  reference?: string
  supplierId: string
  currency: string
  fxRateToBase: number
  destinationWarehouseId?: string
  supplierRef?: string
  expectedDelivery?: string
  notes?: string
  internalNotes?: string
  pricesIncludeVat: boolean
  taxRateId?: string
  taxRateName?: string
  taxRateValue?: number // e.g. 0.20 for 20%
  additionalCosts?: { description: string; amountForeign: number; vatable: boolean; distributionMethod: string }[]
  /** Original user input for the order-level discount, e.g. "10%" or "50.00". */
  orderDiscountStr?: string | null
  /**
   * Computed order-level discount in the order's foreign currency, in the
   * same tax convention as line `unitCostForeign` (gross when
   * `pricesIncludeVat`, else net). Applied after per-line discounts.
   */
  orderDiscountForeign?: number
  lines: PoLineInput[]
}

export type ReceiptLineInput = {
  poLineId: string
  qtyReceived: number
  warehouseId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeReference(): Promise<string> {
  const now = new Date()
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  const { getNumberingFormats } = await import('./company')
  const { po_prefix } = await getNumberingFormats()
  return `${po_prefix}${ymd}-${rand}`
}

function safeFxRate(rate: number): number {
  return rate > 0 ? rate : 1
}

function calcLineTotals(unitCostForeign: number, qty: number, fxRate: number) {
  const rate = safeFxRate(fxRate)
  const totalForeign = Math.round(unitCostForeign * qty * 10000) / 10000
  const unitCostBase = Math.round((unitCostForeign / rate) * 1000000) / 1000000
  const totalBase = Math.round((totalForeign / rate) * 10000) / 10000
  return { unitCostBase, totalForeign, totalBase }
}

const PO_SELECT = {
  id: true,
  reference: true,
  type: true,
  status: true,
  supplierId: true,
  currency: true,
  fxRateToBase: true,
  subtotalForeign: true,
  subtotalBase: true,
  taxRateName: true,
  taxRatePercent: true,
  taxForeign: true,
  taxBase: true,
  totalForeign: true,
  totalBase: true,
  directFreightForeign: true,
  directFreightBase: true,
  discountStr: true,
  discountAmount: true,
  landedCostMethod: true,
  destinationWarehouseId: true,
  trackingNumber: true,
  shippingProvider: true,
  supplierRef: true,
  expectedDelivery: true,
  notes: true,
  internalNotes: true,
  createdAt: true,
  updatedAt: true,
  supplier: { select: { id: true, name: true } },
  destinationWarehouse: { select: { id: true, name: true } },
  lines: {
    select: {
      id: true,
      productId: true,
      description: true,
      qty: true,
      unitCostForeign: true,
      unitCostBase: true,
      discountStr: true,
      discountAmount: true,
      totalForeign: true,
      totalBase: true,
      purchaseUnitId: true,
      purchaseUnitQty: true,
      purchaseUnit: { select: { name: true, abbreviation: true, conversionFactor: true, stockUnitName: true } },
      qtyReceived: true,
      qtyReturned: true,
      sortOrder: true,
      taxRateId: true,
      taxRate: { select: { id: true, name: true, rate: true, taxCategory: true } },
      landedUnitCostBase: true,
      product: { select: { sku: true, name: true, imageUrl: true, weight: true, parent: { select: { imageUrl: true } } } },
    },
    orderBy: { sortOrder: 'asc' as const },
  },
  _count: { select: { invoices: true, returns: true } },
} as const

function mapPoRow(po: {
  id: string
  reference: string
  type: string
  status: string
  supplierId: string
  currency: string
  fxRateToBase: unknown
  subtotalForeign: unknown
  subtotalBase: unknown
  taxRateName: string | null
  taxRatePercent: unknown
  taxForeign: unknown
  taxBase: unknown
  totalForeign: unknown
  totalBase: unknown
  directFreightForeign: unknown
  directFreightBase: unknown
  discountStr: string | null
  discountAmount: unknown
  landedCostMethod: string
  destinationWarehouseId: string | null
  supplierRef: string | null
  expectedDelivery: Date | null
  notes: string | null
  internalNotes: string | null
  createdAt: Date
  updatedAt: Date
  trackingNumber: string | null
  shippingProvider: string | null
  supplier: { name: string }
  destinationWarehouse: { name: string } | null
  lines: { id: string; qtyReceived: unknown; qtyReturned: unknown }[]
  _count: { invoices: number; returns: number }
}): PoRow {
  const anyReturned = po.lines.some((l) => Number(l.qtyReturned) > 0)
  const allReturned = po.lines.length > 0 && po.lines.every(
    (l) => Number(l.qtyReceived) > 0 && Number(l.qtyReturned) >= Number(l.qtyReceived),
  )
  return {
    id: po.id,
    reference: po.reference,
    type: po.type as 'GOODS' | 'FREIGHT',
    status: po.status as PoStatus,
    supplierId: po.supplierId,
    supplierName: po.supplier.name,
    currency: po.currency,
    fxRateToBase: Number(po.fxRateToBase),
    subtotalForeign: Number(po.subtotalForeign),
    subtotalBase: Number(po.subtotalBase),
    taxRateName: po.taxRateName,
    taxRatePercent: po.taxRatePercent != null ? Number(po.taxRatePercent) : null,
    taxForeign: Number(po.taxForeign),
    taxBase: Number(po.taxBase),
    totalForeign: Number(po.totalForeign),
    totalBase: Number(po.totalBase),
    directFreightForeign: Number(po.directFreightForeign),
    directFreightBase: Number(po.directFreightBase),
    orderDiscountStr: po.discountStr,
    orderDiscountForeign: Number(po.discountAmount ?? 0),
    landedCostMethod: po.landedCostMethod as string,
    destinationWarehouseId: po.destinationWarehouseId,
    destinationWarehouseName: po.destinationWarehouse?.name ?? null,
    supplierRef: po.supplierRef,
    expectedDelivery: po.expectedDelivery?.toISOString() ?? null,
    notes: po.notes,
    internalNotes: po.internalNotes,
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
    lineCount: po.lines.length,
    isInvoiced: po._count.invoices > 0,
    invoiceCount: po._count.invoices,
    isPartiallyReturned: anyReturned && !allReturned,
    isFullyReturned: allReturned,
    trackingNumber: po.trackingNumber ?? null,
    shippingProvider: po.shippingProvider ?? null,
  }
}

function mapLine(l: {
  id: string
  productId: string
  description: string | null
  qty: unknown
  unitCostForeign: unknown
  unitCostBase: unknown
  discountStr?: string | null
  discountAmount?: unknown
  totalForeign: unknown
  totalBase: unknown
  purchaseUnitId: string | null
  purchaseUnitQty: unknown
  purchaseUnit: { name: string; abbreviation: string; conversionFactor: unknown; stockUnitName: string } | null
  qtyReceived: unknown
  qtyReturned: unknown
  sortOrder: number
  taxRateId?: string | null
  taxRate?: { id: string; name: string; rate: unknown; taxCategory?: string } | null
  product: { sku: string; name: string; imageUrl: string | null; parent?: { imageUrl: string | null } | null }
}): PoLineRow {
  const qty = Number(l.qty)
  const qtyReceived = Number(l.qtyReceived)
  const qtyReturned = Number(l.qtyReturned)
  return {
    id: l.id,
    productId: l.productId,
    sku: l.product.sku,
    productName: l.product.name,
    imageUrl: l.product.imageUrl ?? l.product.parent?.imageUrl ?? null,
    description: l.description,
    qty,
    unitCostForeign: Number(l.unitCostForeign),
    unitCostBase: Number(l.unitCostBase),
    discountStr: l.discountStr ?? null,
    discountAmount: Number(l.discountAmount ?? 0),
    totalForeign: Number(l.totalForeign),
    totalBase: Number(l.totalBase),
    purchaseUnitId: l.purchaseUnitId,
    purchaseUnitName: l.purchaseUnit ? l.purchaseUnit.abbreviation : null,
    purchaseUnitStockName: l.purchaseUnit?.stockUnitName ?? null,
    purchaseUnitQty: l.purchaseUnitQty != null ? Number(l.purchaseUnitQty) : null,
    grossUnitCostBase: Number(l.unitCostBase), // overridden by getPurchaseOrder with actual landed cost
    qtyReceived,
    qtyBilled: 0, // overridden by getPurchaseOrder with sum across invoices
    qtyReturned,
    qtyToReceive: Math.max(0, qty - qtyReceived),
    qtyRemaining: Math.max(0, qtyReceived - qtyReturned),
    sortOrder: l.sortOrder,
    taxRateId: l.taxRateId ?? l.taxRate?.id ?? null,
    taxRatePercent: l.taxRate?.rate != null ? Number(l.taxRate.rate) : null,
    taxRateName: l.taxRate?.name ?? null,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getPurchaseOrders(limit = 200): Promise<PoRow[]> {
  await requireAuth()
  const pos = await db.purchaseOrder.findMany({
    where: { archived: { not: true } },
    select: PO_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return pos.map(mapPoRow)
}

export async function getPurchaseOrder(id: string): Promise<PoDetail | null> {
  await requireAuth()
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    select: {
      ...PO_SELECT,
      receipts: {
        select: {
          id: true,
          reference: true,
          receivedAt: true,
          notes: true,
          lines: {
            select: {
              id: true,
              poLineId: true,
              qtyReceived: true,
              warehouseId: true,
              poLine: {
                select: {
                  productId: true,
                  product: { select: { sku: true, name: true, imageUrl: true, parent: { select: { imageUrl: true } } } },
                },
              },
            },
          },
        },
        orderBy: { receivedAt: 'desc' },
      },
      returns: {
        select: {
          id: true,
          reference: true,
          reason: true,
          notes: true,
          returnedAt: true,
          lines: {
            select: {
              id: true,
              poLineId: true,
              qtyReturned: true,
              warehouseId: true,
              poLine: {
                select: {
                  productId: true,
                  product: { select: { sku: true, name: true, imageUrl: true, parent: { select: { imageUrl: true } } } },
                },
              },
            },
          },
        },
        orderBy: { returnedAt: 'desc' },
      },
      invoices: {
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          dueDate: true,
          subtotalForeign: true,
          subtotalBase: true,
          taxForeign: true,
          taxBase: true,
          totalForeign: true,
          totalBase: true,
          notes: true,
          supplierInvoiceUrl: true,
          accountingInvoiceId: true,
          paidAt: true,
          paymentAccountId: true,
          paymentAccountName: true,
          paymentReference: true,
          createdAt: true,
          lines: {
            select: {
              id: true,
              poLineId: true,
              costLineId: true,
              description: true,
              qtyBilled: true,
              unitCostForeign: true,
              totalForeign: true,
              totalBase: true,
              poLine: {
                select: {
                  productId: true,
                  product: { select: { sku: true, name: true, imageUrl: true, parent: { select: { imageUrl: true } } } },
                },
              },
              costLine: {
                select: {
                  description: true,
                },
              },
            },
          },
        },
        orderBy: { invoiceDate: 'desc' },
      },
      freightCostLines: {
        select: {
          id: true,
          description: true,
          amountForeign: true,
          amountBase: true,
          vatable: true,
          distributionMethod: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })
  if (!po) return null

  // Fetch linked freight POs for landed cost calculation
  const freightLinks = await getLinkedFreightPos(id)
  let totalLandedCostBase = 0
  for (const fl of freightLinks) {
    totalLandedCostBase += fl.freightPo.totalBase
  }
  // Also add direct freight from the PO itself
  totalLandedCostBase += Number(po.directFreightBase)

  // Aggregate billed totals across all invoices — used to enforce partial-bill
  // limits on the next bill and to hide the "Create Bill" action when nothing
  // is left to bill.
  const qtyBilledByLine = new Map<string, number>()
  const amountBilledByCostLine = new Map<string, number>()
  for (const inv of po.invoices) {
    for (const il of inv.lines) {
      if (il.poLineId) {
        qtyBilledByLine.set(il.poLineId, (qtyBilledByLine.get(il.poLineId) ?? 0) + Number(il.qtyBilled))
      }
      if (il.costLineId) {
        amountBilledByCostLine.set(il.costLineId, (amountBilledByCostLine.get(il.costLineId) ?? 0) + Number(il.totalForeign))
      }
    }
  }

  const grossUnitCostBaseByLine = computeGrossUnitCostBaseByLine({
    lines: po.lines.map((line) => ({
      id: line.id,
      qty: line.qty,
      unitCostBase: line.unitCostBase,
      totalBase: line.totalBase,
      landedUnitCostBase: line.landedUnitCostBase,
      weight: line.product?.weight ?? null,
    })),
    directCostLines: po.freightCostLines.map((costLine) => ({
      amountBase: costLine.amountBase,
      distributionMethod: costLine.distributionMethod,
    })),
    linkedCostLines: freightLinks.flatMap((link) => (
      link.freightPo.costLines.map((costLine) => ({
        amountBase: costLine.amountBase,
        distributionMethod: costLine.distributionMethod,
      }))
    )),
  })

  const mappedLines = po.lines.map(mapLine).map((line) => {
    return {
      ...line,
      grossUnitCostBase: grossUnitCostBaseByLine.get(line.id) ?? line.unitCostBase,
      qtyBilled: qtyBilledByLine.get(line.id) ?? 0,
    }
  })

  const row = mapPoRow(po)
  return {
    ...row,
    lines: mappedLines,
    receipts: po.receipts.map((r) => ({
      id: r.id,
      reference: r.reference,
      receivedAt: r.receivedAt.toISOString(),
      notes: r.notes,
      lines: r.lines.map((rl) => ({
        id: rl.id,
        poLineId: rl.poLineId,
        productId: rl.poLine.productId,
        sku: rl.poLine.product.sku,
        productName: rl.poLine.product.name,
        qtyReceived: Number(rl.qtyReceived),
        warehouseId: rl.warehouseId,
        warehouseName: null,
      })),
    })),
    returns: po.returns.map((r) => ({
      id: r.id,
      reference: r.reference,
      reason: r.reason,
      notes: r.notes,
      returnedAt: r.returnedAt.toISOString(),
      lines: r.lines.map((rl) => ({
        id: rl.id,
        poLineId: rl.poLineId,
        productId: rl.poLine.productId,
        sku: rl.poLine.product.sku,
        productName: rl.poLine.product.name,
        qtyReturned: Number(rl.qtyReturned),
        warehouseId: rl.warehouseId,
      })),
    })),
    invoices: po.invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate.toISOString(),
      dueDate: inv.dueDate?.toISOString() ?? null,
      subtotalForeign: Number(inv.subtotalForeign),
      subtotalBase: Number(inv.subtotalBase),
      taxForeign: Number(inv.taxForeign),
      taxBase: Number(inv.taxBase),
      totalForeign: Number(inv.totalForeign),
      totalBase: Number(inv.totalBase),
      notes: inv.notes,
      supplierInvoiceUrl: inv.supplierInvoiceUrl,
      accountingInvoiceId: inv.accountingInvoiceId ?? null,
      paidAt: inv.paidAt?.toISOString() ?? null,
      paymentAccountId: inv.paymentAccountId ?? null,
      paymentAccountName: inv.paymentAccountName ?? null,
      paymentReference: inv.paymentReference ?? null,
      createdAt: inv.createdAt.toISOString(),
      lines: inv.lines.map((il) => {
        const isProduct = il.poLineId != null && il.poLine != null
        const productName = isProduct
          ? il.poLine!.product.name
          : il.description ?? il.costLine?.description ?? '—'
        const sku = isProduct ? il.poLine!.product.sku : '—'
        const productId = isProduct ? il.poLine!.productId : ''
        return {
          id: il.id,
          poLineId: il.poLineId,
          costLineId: il.costLineId,
          productId,
          sku,
          productName,
          description: productName,
          qtyBilled: Number(il.qtyBilled),
          unitCostForeign: Number(il.unitCostForeign),
          totalForeign: Number(il.totalForeign),
          totalBase: Number(il.totalBase),
        }
      }),
    })),
    freightCostLines: (po.freightCostLines ?? []).map((cl) => ({
      id: cl.id,
      description: cl.description,
      amountForeign: Number(cl.amountForeign),
      amountBase: Number(cl.amountBase),
      amountBilled: amountBilledByCostLine.get(cl.id) ?? 0,
      vatable: cl.vatable,
      distributionMethod: cl.distributionMethod as string,
    })),
    linkedFreightPos: freightLinks.map((fl) => ({
      linkId: fl.linkId,
      method: fl.method,
      freightPo: {
        id: fl.freightPo.id,
        reference: fl.freightPo.reference,
        supplierName: fl.freightPo.supplierName,
        totalForeign: fl.freightPo.totalForeign,
        totalBase: fl.freightPo.totalBase,
        costLines: fl.freightPo.costLines.map((cl) => ({
          description: cl.description,
          amountBase: cl.amountBase,
          distributionMethod: cl.distributionMethod,
        })),
      },
    })),
    totalLandedCostBase,
    linkedPrimaryPos: await (async () => {
      // For FREIGHT POs: show which primary POs this is linked to
      const primaryLinks = await db.landedCostLink.findMany({
        where: { freightPoId: id },
        select: {
          primaryPO: { select: { id: true, reference: true, totalBase: true, supplier: { select: { name: true } } } },
        },
      })
      return primaryLinks.map((l) => ({
        id: l.primaryPO.id,
        reference: l.primaryPO.reference,
        supplierName: l.primaryPO.supplier.name,
        totalBase: Number(l.primaryPO.totalBase),
      }))
    })(),
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createPurchaseOrder(input: CreatePoInput): Promise<{ success: boolean; po?: PoRow; error?: string }> {
  try {
    await requirePermission('purchasing.create')
    if (!input.lines.length) return { success: false, error: 'At least one line is required' }
    if (input.reference?.trim()) {
      const existing = await db.purchaseOrder.findUnique({
        where: { reference: input.reference.trim() },
        select: { id: true },
      })
      if (existing) return { success: false, error: `Purchase order ${input.reference.trim()} already exists` }
    }
    // Validate line inputs
    for (const l of input.lines) {
      if (l.qty <= 0) return { success: false, error: `Invalid qty for ${l.sku}` }
      if (l.unitCostForeign < 0) return { success: false, error: `Negative cost for ${l.sku}` }
    }

    const fxRate = safeFxRate(input.fxRateToBase || 1)
    const vatRate = input.taxRateValue ?? 0
    const inclVat = !!input.pricesIncludeVat
    let subtotalForeign = 0
    let subtotalBase = 0
    let totalTaxForeign = 0
    let totalTaxBase = 0

    // --- Tax rate resolution -------------------------------------------
    // Each line either:
    //   - has a manual override (`l.taxRateId`) — use that rate
    //   - is auto-resolved via `(destinationWarehouse.country, productCategory,
    //     PURCHASE)` against the configured TaxRate rows; falls back to the
    //     order default if no match.

    // Order-level default rate (used as resolver fallback + for additional
    // costs / order discount VAT).
    const orderDefaultRate = input.taxRateId
      ? await db.taxRate.findUnique({
          where: { id: input.taxRateId },
          select: { id: true, name: true, rate: true, accountingTaxType: true },
        })
      : input.taxRateName
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

    // Destination country: receiving warehouse → company home country.
    let destCountryRaw: string | null = null
    if (input.destinationWarehouseId) {
      const wh = await db.warehouse.findUnique({
        where: { id: input.destinationWarehouseId },
        select: { country: true },
      })
      destCountryRaw = wh?.country ?? null
    }
    if (!destCountryRaw) {
      try {
        const { getOrganisation } = await import('./company')
        const org = await getOrganisation()
        destCountryRaw = org?.country ?? null
      } catch { /* fall through to null */ }
    }
    const { toIsoCountryCode } = await import('@/lib/countries')
    const destCountryIso = toIsoCountryCode(destCountryRaw)
    const destCountry: string | null = destCountryIso
      ? destCountryIso.toLowerCase()
      : (destCountryRaw ? destCountryRaw.toLowerCase() : null)

    // Load product categories.
    const productIdsForTax = Array.from(new Set(input.lines.map((l) => l.productId).filter(Boolean)))
    const productRows = productIdsForTax.length
      ? await db.product.findMany({
          where: { id: { in: productIdsForTax } },
          select: { id: true, taxCategory: true, lifecycleStatus: true },
        })
      : []
    const archivedProduct = productRows.find((p) => !isOperationalProductStatus(p.lifecycleStatus))
    if (archivedProduct) {
      return { success: false, error: 'Archived products cannot be added to new purchase orders' }
    }
    const productCategoryById = new Map<string, TaxCategory>(
      productRows.map((p) => [p.id, p.taxCategory]),
    )

    // Auto-resolve every line that doesn't have a manual override.
    const autoLines = input.lines
      .map((l, idx) => ({
        id: String(idx),
        productCategory: (l.productId && productCategoryById.get(l.productId)) || ('STANDARD' as TaxCategory),
        override: l.taxRateId ?? null,
      }))
      .filter((l) => !l.override)
    const resolvedMap = await resolveLineTaxRateBatch(autoLines, {
      destinationCountry: destCountry,
      usedFor: 'PURCHASE',
      orderDefault: orderDefaultCtx,
    })

    // Manual overrides → lookup by id in one query.
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

    const lineData = input.lines.map((l, i) => {
      const resolved = lineResolved[i]
      const lineRate = resolved.taxRateValue
      const lineInclVat = inclVat && lineRate > 0
      // `discountAmount` is in the same tax convention as the user-entered
      // `unitCostForeign` (gross when inclVat, else net).
      const discAmt = l.discountAmount ?? 0
      const grossAfterDisc = Math.max(0, l.qty * l.unitCostForeign - discAmt)
      // If prices include VAT, extract net; otherwise use as-is
      const netLineForeign = lineInclVat ? grossAfterDisc / (1 + lineRate) : grossAfterDisc
      const netUnitForeign = l.qty > 0 ? netLineForeign / l.qty : 0
      const { unitCostBase, totalForeign, totalBase } = calcLineTotals(netUnitForeign, l.qty, fxRate)
      const lineTaxForeign = lineInclVat
        ? Math.round((grossAfterDisc - totalForeign) * 10000) / 10000
        : Math.round(totalForeign * lineRate * 10000) / 10000
      const lineTaxBase = Math.round((lineTaxForeign / fxRate) * 10000) / 10000
      subtotalForeign += totalForeign
      subtotalBase += totalBase
      totalTaxForeign += lineTaxForeign
      totalTaxBase += lineTaxBase
      return {
        productId: l.productId,
        description: l.description || null,
        qty: l.qty,
        purchaseUnitId: l.purchaseUnitId || null,
        purchaseUnitQty: l.purchaseUnitQty ?? null,
        unitCostForeign: netUnitForeign,
        unitCostBase,
        discountStr: l.discountStr || null,
        discountAmount: discAmt,
        taxRateId: resolved.taxRateId,
        taxForeign: lineTaxForeign,
        taxBase: lineTaxBase,
        totalForeign,
        totalBase,
        sortOrder: l.sortOrder ?? i,
      }
    })

    // Order-level discount (applied after per-line discounts, before
    // additional costs). It's provided in the same tax convention as the
    // line costs (gross when `pricesIncludeVat`, else net). To keep the
    // books consistent we split it proportionally across net subtotal and
    // line tax, so the per-line taxRate totals each drop by the same
    // percentage. The user input string is stored for re-display only.
    const orderDiscountForeignInput = Math.max(0, input.orderDiscountForeign ?? 0)
    let orderDiscountNetForeign = 0
    let orderDiscountNetBase = 0
    let orderDiscountVatForeign = 0
    let orderDiscountVatBase = 0
    if (orderDiscountForeignInput > 0 && subtotalForeign > 0) {
      // The user enters the discount in the same tax convention as unit
      // costs. Convert to net + vat using the overall line blend:
      //   netFrac = subtotalForeign / (subtotalForeign + totalTaxForeign)
      const grossBase = subtotalForeign + totalTaxForeign
      const netFrac = grossBase > 0 ? subtotalForeign / grossBase : 1
      // When prices are entered incl. VAT the input is a gross amount; when
      // excl. VAT the input is a net amount. Translate to net+vat either
      // way so both sides of the ledger reduce.
      const grossDisc = inclVat ? orderDiscountForeignInput : orderDiscountForeignInput / Math.max(netFrac, 0.000001)
      const cappedGrossDisc = Math.min(grossDisc, grossBase)
      orderDiscountNetForeign = Math.round(cappedGrossDisc * netFrac * 10000) / 10000
      orderDiscountVatForeign = Math.round((cappedGrossDisc - orderDiscountNetForeign) * 10000) / 10000
      orderDiscountNetBase = Math.round((orderDiscountNetForeign / fxRate) * 10000) / 10000
      orderDiscountVatBase = Math.round((orderDiscountVatForeign / fxRate) * 10000) / 10000
      subtotalForeign = Math.max(0, subtotalForeign - orderDiscountNetForeign)
      subtotalBase = Math.max(0, subtotalBase - orderDiscountNetBase)
      totalTaxForeign = Math.max(0, totalTaxForeign - orderDiscountVatForeign)
      totalTaxBase = Math.max(0, totalTaxBase - orderDiscountVatBase)
    }

    // Additional costs (shipping, fees, etc.) → directFreight fields
    let directFreightForeign = 0
    let directFreightBase = 0
    let additionalCostVatForeign = 0
    let additionalCostVatBase = 0
    if (input.additionalCosts?.length) {
      for (const ac of input.additionalCosts) {
        directFreightForeign += ac.amountForeign
        if (ac.vatable && vatRate > 0) {
          additionalCostVatForeign += Math.round(ac.amountForeign * vatRate * 10000) / 10000
        }
      }
      directFreightBase = Math.round((directFreightForeign / fxRate) * 10000) / 10000
      additionalCostVatBase = Math.round((additionalCostVatForeign / fxRate) * 10000) / 10000
      totalTaxForeign += additionalCostVatForeign
      totalTaxBase += additionalCostVatBase
    }

    // Use the first additional cost's distribution method, or BY_VALUE as default
    const firstMethod = input.additionalCosts?.find((ac) => ac.amountForeign > 0)?.distributionMethod
    const lcMethod = (['BY_VALUE', 'BY_WEIGHT', 'BY_QUANTITY', 'EQUAL_SPLIT'].includes(firstMethod ?? '')
      ? firstMethod!
      : 'BY_VALUE') as 'BY_VALUE' | 'BY_WEIGHT' | 'BY_QUANTITY' | 'EQUAL_SPLIT'

    const grandTotalForeign = subtotalForeign + totalTaxForeign + directFreightForeign
    const grandTotalBase = subtotalBase + totalTaxBase + directFreightBase

    // Persist each additional cost as its own freightCostLine so the edit
    // form can prefill and modify them. The aggregate directFreight fields
    // above are kept in sync for downstream landed-cost math that reads them
    // directly.
    const freightCostLineData = (input.additionalCosts ?? [])
      .filter((ac) => ac.amountForeign > 0)
      .map((ac, i) => ({
        description: ac.description || 'Additional cost',
        amountForeign: ac.amountForeign,
        amountBase: Math.round((ac.amountForeign / fxRate) * 10000) / 10000,
        vatable: ac.vatable,
        distributionMethod: ac.distributionMethod as 'BY_VALUE' | 'BY_WEIGHT' | 'BY_QUANTITY' | 'EQUAL_SPLIT',
        sortOrder: i,
      }))

    const poReference = input.reference || await makeReference()
    const po = await db.purchaseOrder.create({
      data: {
        reference: poReference,
        type: 'GOODS',
        supplierId: input.supplierId,
        currency: input.currency,
        fxRateToBase: fxRate,
        subtotalForeign,
        subtotalBase,
        taxRateName: input.taxRateName || null,
        taxRatePercent: vatRate > 0 ? vatRate : null,
        taxForeign: totalTaxForeign,
        taxBase: totalTaxBase,
        totalForeign: grandTotalForeign,
        totalBase: grandTotalBase,
        directFreightForeign,
        directFreightBase,
        discountStr: input.orderDiscountStr ?? null,
        discountAmount: orderDiscountForeignInput,
        landedCostMethod: lcMethod,
        destinationWarehouseId: input.destinationWarehouseId || null,
        supplierRef: input.supplierRef || null,
        expectedDelivery: input.expectedDelivery ? new Date(input.expectedDelivery) : null,
        notes: input.notes || null,
        internalNotes: input.internalNotes || null,
        lines: { create: lineData },
        ...(freightCostLineData.length > 0 && {
          freightCostLines: { create: freightCostLineData },
        }),
      },
      select: PO_SELECT,
    })

    // Update SupplierProduct last prices (in supplier's currency, net of VAT)
    for (const ld of lineData) {
      await db.supplierProduct.upsert({
        where: { supplierId_productId: { supplierId: input.supplierId, productId: ld.productId } },
        create: {
          supplierId: input.supplierId,
          productId: ld.productId,
          supplierSku: null,
          lastUnitCost: ld.unitCostForeign,
          currency: input.currency,
        },
        update: {
          lastUnitCost: ld.unitCostForeign,
          currency: input.currency,
        },
      })
    }

    // Aggregated warning when any line fell back to the order default.
    const fallbackLines = lineResolved
      .map((r, i) => ({
        r,
        sku: input.lines[i].sku,
        cat:
          (input.lines[i].productId && productCategoryById.get(input.lines[i].productId)) ||
          'STANDARD',
      }))
      .filter((x) => x.r.matched === 'fallback')
    if (fallbackLines.length > 0) {
      await logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: po.id,
        action: 'tax_rate_fallback',
        tag: 'purchase',
        level: 'WARNING',
        description: `No matching purchase tax rate for ${destCountry?.toUpperCase() ?? 'unknown country'} on ${fallbackLines.length} line(s); used order default.`,
        metadata: {
          reference: poReference,
          destCountry,
          lines: fallbackLines.map((x) => ({ sku: x.sku, category: x.cat })),
        },
      })
    }

    revalidatePath('/purchase-orders')
    const mapped = mapPoRow(po)
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: mapped.id,
      action: 'created',
      tag: 'purchase',
      level: 'INFO',
      description: `Created PO ${mapped.reference} for ${mapped.supplierName}`,
      metadata: { reference: mapped.reference, supplierId: input.supplierId, currency: input.currency, lineCount: input.lines.length },
    })

    return { success: true, po: mapped }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: null,
      action: 'created',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to create PO: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function updatePurchaseOrder(
  id: string,
  input: Partial<CreatePoInput>,
): Promise<{ success: boolean; po?: PoRow; error?: string }> {
  try {
    await requirePermission('purchasing.create')
    const existing = await db.purchaseOrder.findUnique({
      where: { id },
      select: { status: true, fxRateToBase: true, directFreightForeign: true, directFreightBase: true },
    })
    if (!existing) return { success: false, error: 'PO not found' }
    if (existing.status !== 'DRAFT') return { success: false, error: 'Only DRAFT POs can be edited' }

    const fxRate = input.fxRateToBase ?? Number(existing.fxRateToBase)
    const inclVat = !!input.pricesIncludeVat
    const vatRate = input.taxRateValue ?? 0

    const updates: Record<string, unknown> = {
      ...(input.supplierId !== undefined && { supplierId: input.supplierId }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.fxRateToBase !== undefined && { fxRateToBase: input.fxRateToBase }),
      ...(input.destinationWarehouseId !== undefined && { destinationWarehouseId: input.destinationWarehouseId || null }),
      ...(input.supplierRef !== undefined && { supplierRef: input.supplierRef || null }),
      ...(input.expectedDelivery !== undefined && { expectedDelivery: input.expectedDelivery ? new Date(input.expectedDelivery) : null }),
      ...(input.notes !== undefined && { notes: input.notes || null }),
      ...(input.internalNotes !== undefined && { internalNotes: input.internalNotes || null }),
    }

    // Order-level tax rate update (always apply when lines are being saved,
    // because line VAT has to be recomputed in the same pass).
    if (input.lines || input.taxRateId !== undefined || input.taxRateName !== undefined) {
      updates.taxRateName = input.taxRateName || null
      updates.taxRatePercent = vatRate > 0 ? vatRate : null
    }

    let updateFallbackInfo: {
      destCountry: string | null
      lines: { sku: string; category: TaxCategory }[]
    } | null = null

    if (input.lines) {
      // --- Tax rate resolution (mirror createPurchaseOrder) -------------
      const orderDefaultRate = input.taxRateId
        ? await db.taxRate.findUnique({
            where: { id: input.taxRateId },
            select: { id: true, name: true, rate: true, accountingTaxType: true },
          })
        : input.taxRateName
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

      // Destination country: receiving warehouse (use new value when set,
      // else fall back to the existing PO's warehouse) → company home.
      let destWarehouseId: string | null | undefined =
        input.destinationWarehouseId !== undefined
          ? input.destinationWarehouseId || null
          : undefined
      if (destWarehouseId === undefined) {
        const cur = await db.purchaseOrder.findUnique({
          where: { id },
          select: { destinationWarehouseId: true },
        })
        destWarehouseId = cur?.destinationWarehouseId ?? null
      }
      let destCountryRaw: string | null = null
      if (destWarehouseId) {
        const wh = await db.warehouse.findUnique({
          where: { id: destWarehouseId },
          select: { country: true },
        })
        destCountryRaw = wh?.country ?? null
      }
      if (!destCountryRaw) {
        try {
          const { getOrganisation } = await import('./company')
          const org = await getOrganisation()
          destCountryRaw = org?.country ?? null
        } catch { /* fall through */ }
      }
      const { toIsoCountryCode } = await import('@/lib/countries')
      const destCountryIso = toIsoCountryCode(destCountryRaw)
      const destCountry: string | null = destCountryIso
        ? destCountryIso.toLowerCase()
        : (destCountryRaw ? destCountryRaw.toLowerCase() : null)

      // Load product categories.
      const productIdsForTax = Array.from(new Set(input.lines.map((l) => l.productId).filter(Boolean)))
      const productRows = productIdsForTax.length
        ? await db.product.findMany({
            where: { id: { in: productIdsForTax } },
            select: { id: true, taxCategory: true, lifecycleStatus: true },
          })
        : []
      const archivedProduct = productRows.find((p) => !isOperationalProductStatus(p.lifecycleStatus))
      if (archivedProduct) {
        return { success: false, error: 'Archived products cannot be added to purchase orders' }
      }
      const productCategoryById = new Map<string, TaxCategory>(
        productRows.map((p) => [p.id, p.taxCategory]),
      )

      // Auto-resolve every line that doesn't have a manual override.
      const autoLines = input.lines
        .map((l, idx) => ({
          id: String(idx),
          productCategory:
            (l.productId && productCategoryById.get(l.productId)) || ('STANDARD' as TaxCategory),
          override: l.taxRateId ?? null,
        }))
        .filter((l) => !l.override)
      const resolvedMap = await resolveLineTaxRateBatch(autoLines, {
        destinationCountry: destCountry,
        usedFor: 'PURCHASE',
        orderDefault: orderDefaultCtx,
      })

      // Batch-load any per-line manual overrides.
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

      const fallbackForActivity = lineResolved
        .map((r, i) => ({
          r,
          sku: input.lines![i].sku,
          cat:
            (input.lines![i].productId && productCategoryById.get(input.lines![i].productId)) ||
            ('STANDARD' as TaxCategory),
        }))
        .filter((x) => x.r.matched === 'fallback')
      if (fallbackForActivity.length > 0) {
        updateFallbackInfo = {
          destCountry,
          lines: fallbackForActivity.map((x) => ({ sku: x.sku, category: x.cat })),
        }
      }

      // Delete existing lines and recreate
      await db.purchaseOrderLine.deleteMany({ where: { poId: id } })
      // Also clear any pre-existing purchase-unit aggregate data on the PO
      // line level — the edit form currently operates in stock-unit terms
      // (purchaseUnitId is not edited inline), so we preserve only what
      // the form sends.
      let subtotalForeign = 0
      let subtotalBase = 0
      let totalTaxForeign = 0
      let totalTaxBase = 0

      const lineData = input.lines.map((l, i) => {
        const resolved = lineResolved[i]
        const resolvedId = resolved.taxRateId
        const lineRate = resolved.taxRateValue
        const lineInclVat = inclVat && lineRate > 0

        // `unitCostForeign` is the user-entered pre-discount price per unit
        // (gross when `pricesIncludeVat`, else net). `discountAmount` is in
        // the same tax convention. Mirrors `createPurchaseOrder` exactly.
        const discAmt = l.discountAmount ?? 0
        const grossAfterDisc = Math.max(0, l.qty * l.unitCostForeign - discAmt)
        const netLineForeign = lineInclVat ? grossAfterDisc / (1 + lineRate) : grossAfterDisc
        const netUnitForeign = l.qty > 0 ? netLineForeign / l.qty : 0
        const { unitCostBase, totalForeign, totalBase } = calcLineTotals(netUnitForeign, l.qty, fxRate)
        const lineTaxForeign = lineInclVat
          ? Math.round((grossAfterDisc - totalForeign) * 10000) / 10000
          : Math.round(totalForeign * lineRate * 10000) / 10000
        const lineTaxBase = Math.round((lineTaxForeign / fxRate) * 10000) / 10000
        subtotalForeign += totalForeign
        subtotalBase += totalBase
        totalTaxForeign += lineTaxForeign
        totalTaxBase += lineTaxBase
        return {
          poId: id,
          productId: l.productId,
          description: l.description || null,
          qty: l.qty,
          purchaseUnitId: l.purchaseUnitId || null,
          purchaseUnitQty: l.purchaseUnitQty ?? null,
          unitCostForeign: netUnitForeign,
          unitCostBase,
          discountStr: l.discountStr ?? null,
          discountAmount: discAmt,
          taxRateId: resolvedId,
          taxForeign: lineTaxForeign,
          taxBase: lineTaxBase,
          totalForeign,
          totalBase,
          sortOrder: l.sortOrder ?? i,
        }
      })
      await db.purchaseOrderLine.createMany({ data: lineData })

      // Order-level discount (mirrors createPurchaseOrder exactly). Split
      // proportionally across net subtotal and line VAT using the pre-
      // discount blend so per-rate totals each drop by the same %. Runs
      // BEFORE additional-cost VAT is folded in so the discount only
      // scales the line portion of the order.
      const orderDiscountForeignInput = Math.max(0, input.orderDiscountForeign ?? 0)
      if (orderDiscountForeignInput > 0 && subtotalForeign > 0) {
        const grossBase = subtotalForeign + totalTaxForeign
        const netFrac = grossBase > 0 ? subtotalForeign / grossBase : 1
        const grossDisc = inclVat
          ? orderDiscountForeignInput
          : orderDiscountForeignInput / Math.max(netFrac, 0.000001)
        const cappedGrossDisc = Math.min(grossDisc, grossBase)
        const orderDiscountNetForeign = Math.round(cappedGrossDisc * netFrac * 10000) / 10000
        const orderDiscountVatForeign = Math.round((cappedGrossDisc - orderDiscountNetForeign) * 10000) / 10000
        const orderDiscountNetBase = Math.round((orderDiscountNetForeign / fxRate) * 10000) / 10000
        const orderDiscountVatBase = Math.round((orderDiscountVatForeign / fxRate) * 10000) / 10000
        subtotalForeign = Math.max(0, subtotalForeign - orderDiscountNetForeign)
        subtotalBase = Math.max(0, subtotalBase - orderDiscountNetBase)
        totalTaxForeign = Math.max(0, totalTaxForeign - orderDiscountVatForeign)
        totalTaxBase = Math.max(0, totalTaxBase - orderDiscountVatBase)
      }
      updates.discountStr = input.orderDiscountStr ?? null
      updates.discountAmount = orderDiscountForeignInput

      // Additional costs (shipping, customs, handling, etc.) — mirror
      // createPurchaseOrder exactly: replace all freightCostLines, rebuild
      // directFreight aggregates, and fold VAT on vatable costs into the
      // order tax totals.
      if (input.additionalCosts !== undefined) {
        await db.freightCostLine.deleteMany({ where: { poId: id } })
        let directFreightForeign = 0
        let additionalCostVatForeign = 0
        const costLineData = (input.additionalCosts ?? [])
          .filter((ac) => ac.amountForeign > 0)
          .map((ac, i) => {
            directFreightForeign += ac.amountForeign
            if (ac.vatable && vatRate > 0) {
              additionalCostVatForeign += Math.round(ac.amountForeign * vatRate * 10000) / 10000
            }
            return {
              poId: id,
              description: ac.description || 'Additional cost',
              amountForeign: ac.amountForeign,
              amountBase: Math.round((ac.amountForeign / fxRate) * 10000) / 10000,
              vatable: ac.vatable,
              distributionMethod: ac.distributionMethod as 'BY_VALUE' | 'BY_WEIGHT' | 'BY_QUANTITY' | 'EQUAL_SPLIT',
              sortOrder: i,
            }
          })
        if (costLineData.length > 0) {
          await db.freightCostLine.createMany({ data: costLineData })
        }
        const directFreightBase = Math.round((directFreightForeign / fxRate) * 10000) / 10000
        const additionalCostVatBase = Math.round((additionalCostVatForeign / fxRate) * 10000) / 10000
        totalTaxForeign += additionalCostVatForeign
        totalTaxBase += additionalCostVatBase
        updates.directFreightForeign = directFreightForeign
        updates.directFreightBase = directFreightBase
        // Preserve the first cost's distribution method as the PO-level
        // landedCostMethod (matches createPurchaseOrder behaviour).
        const firstMethod = (input.additionalCosts ?? []).find((ac) => ac.amountForeign > 0)?.distributionMethod
        if (firstMethod && ['BY_VALUE', 'BY_WEIGHT', 'BY_QUANTITY', 'EQUAL_SPLIT'].includes(firstMethod)) {
          updates.landedCostMethod = firstMethod
        }
      }

      // directFreight may have been updated above; use the new values
      // when present, otherwise preserve the existing amounts from the PO.
      const currentDirectFreightForeign =
        (updates.directFreightForeign as number | undefined) ?? Number(existing.directFreightForeign)
      const currentDirectFreightBase =
        (updates.directFreightBase as number | undefined) ?? Number(existing.directFreightBase)
      updates.subtotalForeign = subtotalForeign
      updates.subtotalBase = subtotalBase
      updates.taxForeign = totalTaxForeign
      updates.taxBase = totalTaxBase
      updates.totalForeign = subtotalForeign + totalTaxForeign + currentDirectFreightForeign
      updates.totalBase = subtotalBase + totalTaxBase + currentDirectFreightBase
    }

    const po = await db.purchaseOrder.update({
      where: { id },
      data: updates,
      select: PO_SELECT,
    })

    // If additional costs were changed on a GOODS PO that has already been
    // received (cost layers exist), recalculate the landed unit cost on
    // each PO line and update the corresponding cost layers. This also
    // computes retrospective COGS adjustments for consumed stock.
    if (input.additionalCosts !== undefined && ['PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED'].includes(existing.status)) {
      try {
        const landedResult = await db.$transaction(async (tx) => {
          return recalculateDirectLandedCosts(tx, id)
        }, STOCK_TX_OPTIONS)

        try {
          await queueLandedCostAdjustmentJournals(landedResult)
        } catch { /* Accounting queue errors should not block the main flow */ }
        for (const adj of landedResult.cogsAdjustments) {
          await logActivity({
            entityType: 'PURCHASE_ORDER', entityId: id, action: 'cogs_adjusted', tag: 'purchase', level: 'INFO',
            description: `Retrospective COGS adjustment of £${adj.totalDelta.toFixed(2)} for ${adj.primaryPoRef} due to additional cost change`,
            metadata: { totalDelta: adj.totalDelta },
          })
        }
      } catch (e) {
        // Log but don't fail the PO update — the cost lines are saved,
        // the recalculation can be retried via the freight PO path later.
        await logActivity({
          entityType: 'PURCHASE_ORDER', entityId: id, action: 'landed_cost_recalc_failed', tag: 'purchase', level: 'WARNING',
          description: `Failed to recalculate landed costs after additional cost edit: ${String(e)}`,
        })
      }
    }

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    // Dynamic-route pattern form — guaranteed to bust the Router Cache
    // for the active detail page in Next.js App Router so `router.refresh()`
    // actually re-fetches fresh data.
    revalidatePath('/purchase-orders/[id]', 'page')
    const mapped = mapPoRow(po)
    if (updateFallbackInfo && updateFallbackInfo.lines.length > 0) {
      await logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: id,
        action: 'tax_rate_fallback',
        tag: 'purchase',
        level: 'WARNING',
        description: `No matching purchase tax rate for ${updateFallbackInfo.destCountry?.toUpperCase() ?? 'unknown country'} on ${updateFallbackInfo.lines.length} line(s); used order default.`,
        metadata: {
          reference: mapped.reference,
          destCountry: updateFallbackInfo.destCountry,
          lines: updateFallbackInfo.lines,
        },
      })
    }
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'purchase',
      level: 'INFO',
      description: `Updated PO ${mapped.reference}`,
      metadata: { reference: mapped.reference },
    })
    return { success: true, po: mapped }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to update PO ${id}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function advancePoStatus(
  id: string,
  targetStatus: 'PO_SENT' | 'RFQ_SENT' | 'QUOTE_RECEIVED' | 'SHIPPED' | 'CLOSED',
  payload?: { trackingNumber?: string; shippingProvider?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('purchasing.create')
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`
      const existing = await tx.purchaseOrder.findUnique({ where: { id }, select: { status: true, reference: true } })
      if (!existing) throw new Error('PO not found')
      if (existing.status === targetStatus) {
        return { existing, changed: false }
      }
      const transition = validatePurchaseOrderStatusTransition(existing.status, targetStatus)
      if (!transition.success) throw new Error(transition.error)

      const now = new Date()
      const data: Record<string, unknown> = { status: targetStatus }
      if (targetStatus === 'RFQ_SENT') data.rfqSentAt = now
      if (targetStatus === 'PO_SENT') data.poSentAt = now
      if (targetStatus === 'SHIPPED') {
        if (payload?.trackingNumber) data.trackingNumber = payload.trackingNumber
        if (payload?.shippingProvider) data.shippingProvider = payload.shippingProvider
      }

      await tx.purchaseOrder.update({ where: { id }, data })
      return { existing, changed: true }
    }, STOCK_TX_OPTIONS)
    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    if (result.changed) {
      await logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: id,
        action: 'status_changed',
        tag: 'purchase',
        level: 'INFO',
        description: `Advanced PO ${result.existing.reference} to ${targetStatus}`,
        metadata: { reference: result.existing.reference, previousStatus: result.existing.status, newStatus: targetStatus },
      })
    }

    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'status_changed',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to advance PO ${id} status: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function updatePoTracking(
  id: string,
  payload: { trackingNumber?: string; shippingProvider?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('purchasing.create')
    const existing = await db.purchaseOrder.findUnique({ where: { id }, select: { status: true, reference: true } })
    if (!existing) return { success: false, error: 'PO not found' }

    await db.purchaseOrder.update({
      where: { id },
      data: {
        trackingNumber: payload.trackingNumber ?? null,
        shippingProvider: payload.shippingProvider ?? null,
      },
    })
    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'tracking_updated',
      tag: 'purchase',
      level: 'INFO',
      description: `Updated tracking for PO ${existing.reference}: ${payload.shippingProvider ?? '—'} / ${payload.trackingNumber ?? '—'}`,
      metadata: { reference: existing.reference, ...payload },
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function receivePurchaseOrder(
  id: string,
  receiptLines: ReceiptLineInput[],
  notes?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('purchasing.receive')
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      select: {
        id: true,
        reference: true,
        status: true,
        fxRateToBase: true,
        lines: {
          select: {
            id: true,
            productId: true,
            qty: true,
            qtyReceived: true,
            unitCostBase: true,
            landedUnitCostBase: true,
            totalBase: true,
            product: { select: { weight: true } },
          },
        },
        freightCostLines: {
          select: { amountBase: true, distributionMethod: true },
        },
        landedCostLinks: {
          select: {
            freightPO: {
              select: {
                freightCostLines: {
                  select: { amountBase: true, distributionMethod: true },
                },
              },
            },
          },
        },
      },
    })
    if (!po) return { success: false, error: 'PO not found' }
    if (!['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
      return { success: false, error: 'PO cannot be received in its current status' }
    }

    const linesWithQty = receiptLines.filter((rl) => rl.qtyReceived > 0)
    if (!linesWithQty.length) return { success: false, error: 'No quantities to receive' }
    const [accountingSettings, receiptWarehouseNames] = await Promise.all([
      getAccountingSettings(),
      db.warehouse.findMany({
        where: { id: { in: linesWithQty.map((rl) => rl.warehouseId) } },
        select: { id: true, name: true },
      }),
    ])
    const whNameMap = Object.fromEntries(receiptWarehouseNames.map((w) => [w.id, w.name]))
    const warehouseNamesList = [...new Set(linesWithQty.map((rl) => whNameMap[rl.warehouseId] ?? rl.warehouseId))].join(', ')

    // Validate: can't receive more than outstanding qty
    for (const rl of linesWithQty) {
      if (!rl.warehouseId) return { success: false, error: 'Warehouse is required for each line' }
      const poLine = po.lines.find((l) => l.id === rl.poLineId)
      if (!poLine) return { success: false, error: 'Invalid PO line' }
      const outstanding = Number(poLine.qty) - Number(poLine.qtyReceived)
      if (rl.qtyReceived > outstanding) {
        return { success: false, error: `Cannot receive more than outstanding qty (${outstanding})` }
      }
    }

    const receiptRef = `RCP-${po.reference}-${Date.now().toString(36).toUpperCase()}`
    const receiptResult = await db.$transaction(async (tx) => {
      // Lock the PO row to prevent concurrent receipts from over-receiving
      await tx.$executeRaw`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`

      const currentPo = await tx.purchaseOrder.findUnique({
        where: { id },
        select: {
          reference: true,
          status: true,
          lines: {
            select: {
              id: true,
              productId: true,
              qty: true,
              qtyReceived: true,
              unitCostBase: true,
              landedUnitCostBase: true,
              totalBase: true,
              product: { select: { weight: true } },
            },
          },
          freightCostLines: {
            select: { amountBase: true, distributionMethod: true },
          },
          landedCostLinks: {
            select: {
              freightPO: {
                select: {
                  freightCostLines: {
                    select: { amountBase: true, distributionMethod: true },
                  },
                },
              },
            },
          },
        },
      })
      if (!currentPo) throw new Error('PO not found')
      const canPartiallyReceive = validatePurchaseOrderStatusTransition(currentPo.status, 'PARTIALLY_RECEIVED')
      const canFullyReceive = validatePurchaseOrderStatusTransition(currentPo.status, 'RECEIVED')
      if (!canPartiallyReceive.success && !canFullyReceive.success) {
        throw new Error(canFullyReceive.error)
      }

      const grossUnitCostBaseByLine = computeGrossUnitCostBaseByLine({
        lines: currentPo.lines.map((line) => ({
          id: line.id,
          qty: line.qty,
          unitCostBase: line.unitCostBase,
          totalBase: line.totalBase,
          landedUnitCostBase: line.landedUnitCostBase,
          weight: line.product?.weight ?? null,
        })),
        directCostLines: currentPo.freightCostLines.map((costLine) => ({
          amountBase: costLine.amountBase,
          distributionMethod: costLine.distributionMethod,
        })),
        linkedCostLines: currentPo.landedCostLinks.flatMap((link) => (
          link.freightPO.freightCostLines.map((costLine) => ({
            amountBase: costLine.amountBase,
            distributionMethod: costLine.distributionMethod,
          }))
        )),
      })

      // Re-validate outstanding qty under lock — the pre-tx check used a
      // stale snapshot that concurrent receipts could have advanced past.
      const lockedLineMap = new Map(currentPo.lines.map((line) => [line.id, line]))
      for (const rl of linesWithQty) {
        const poLine = lockedLineMap.get(rl.poLineId)
        if (!poLine) throw new Error('Invalid PO line')
        const outstanding = Number(poLine.qty) - Number(poLine.qtyReceived)
        if (rl.qtyReceived > outstanding) {
          throw new Error(`Cannot receive more than outstanding qty (${outstanding}) for line ${rl.poLineId}`)
        }
      }

      await tx.purchaseReceipt.create({
        data: {
          poId: id,
          reference: receiptRef,
          notes: notes || null,
          lines: {
            create: linesWithQty.map((rl) => ({
              poLineId: rl.poLineId,
              qtyReceived: rl.qtyReceived,
              warehouseId: rl.warehouseId || null,
            })),
          },
        },
      })

      let totalReceiptValue = 0
      for (const rl of linesWithQty) {
        const poLine = currentPo.lines.find((l) => l.id === rl.poLineId)
        if (!poLine) continue

        const unitCostBase = grossUnitCostBaseByLine.get(poLine.id) ?? Number(poLine.unitCostBase)
        totalReceiptValue += rl.qtyReceived * unitCostBase

        await tx.stockMovement.create({
          data: {
            type: 'PURCHASE_RECEIPT',
            productId: poLine.productId,
            toWarehouseId: rl.warehouseId,
            qty: rl.qtyReceived,
            note: `Received against ${currentPo.reference}`,
            referenceType: 'PurchaseOrder',
            referenceId: id,
          },
        })

        await tx.costLayer.create({
          data: {
            productId: poLine.productId,
            warehouseId: rl.warehouseId,
            receivedQty: rl.qtyReceived,
            remainingQty: rl.qtyReceived,
            unitCostBase,
            poLineId: poLine.id,
            isOpeningStock: false,
          },
        })

        await tx.stockLevel.upsert({
          where: {
            productId_warehouseId: {
              productId: poLine.productId,
              warehouseId: rl.warehouseId,
            },
          },
          create: {
            productId: poLine.productId,
            warehouseId: rl.warehouseId,
            quantity: rl.qtyReceived,
            reservedQty: 0,
          },
          update: {
            quantity: { increment: rl.qtyReceived },
          },
        })

        await tx.purchaseOrderLine.update({
          where: { id: rl.poLineId },
          data: { qtyReceived: { increment: rl.qtyReceived } },
        })
      }

      const updatedLines = await tx.purchaseOrderLine.findMany({
        where: { poId: id },
        select: { qty: true, qtyReceived: true },
      })
      const allReceived = updatedLines.every((line) => Number(line.qtyReceived) >= Number(line.qty))
      const newStatus = allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED'
      const receiptTransition = validatePurchaseReceiptStatusUpdate(currentPo.status, newStatus)
      if (!receiptTransition.success) throw new Error(receiptTransition.error)
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status: newStatus,
          ...(allReceived && { receivedAt: new Date() }),
        },
      })

      const freightPoIds: string[] = []
      if (allReceived) {
        const freightLinks = await tx.landedCostLink.findMany({
          where: { primaryPoId: id },
          select: { freightPoId: true },
        })
        if (freightLinks.length > 0) {
          await tx.landedCostLink.updateMany({
            where: { primaryPoId: id },
            data: { allocated: true },
          })
        }
        for (const fl of freightLinks) {
          const allLinks = await tx.landedCostLink.findMany({
            where: { freightPoId: fl.freightPoId },
            select: { primaryPO: { select: { status: true } } },
          })
          if (allLinks.every((link) => link.primaryPO.status === 'RECEIVED')) {
            const freightPo = await tx.purchaseOrder.findUnique({
              where: { id: fl.freightPoId },
              select: { status: true, type: true },
            })
            if (!freightPo) throw new Error('Linked freight PO not found')
            if (freightPo.type === 'FREIGHT') {
              const freightTransition = validateLinkedFreightReceiptStatus(freightPo.status)
              if (!freightTransition.success) throw new Error(freightTransition.error)
            } else {
              const freightTransition = validatePurchaseOrderStatusTransition(freightPo.status, 'RECEIVED')
              if (!freightTransition.success) throw new Error(freightTransition.error)
            }
            await tx.purchaseOrder.update({
              where: { id: fl.freightPoId },
              data: { status: 'RECEIVED', receivedAt: new Date() },
            })
            freightPoIds.push(fl.freightPoId)
          }
        }
      }

      if (accountingSettings.syncEnabled && totalReceiptValue > 0) {
        const amount = Math.round(totalReceiptValue * 100) / 100
        const payload = {
          date: new Date().toISOString().slice(0, 10),
          reference: `Receipt: ${po.reference}`,
          narration: `Stock receipt for PO ${po.reference} — ${linesWithQty.length} lines into ${warehouseNamesList}`,
          lines: [
            { accountCode: accountingSettings.inventoryAccount, description: `Stock receipt: ${po.reference}`, debit: amount },
            { accountCode: accountingSettings.transitAccount, description: `Stock receipt: ${po.reference}`, credit: amount },
          ],
        }
        await queueAccountingSyncTx(tx, {
          type: 'STOCK_RECEIPT',
          referenceType: 'PurchaseOrder',
          referenceId: id,
          payload,
          idempotencyKey: accountingPayloadKey(`purchase-receipt:${id}:${receiptRef}`, payload),
        })
      }

      return { allReceived, newStatus, freightPoIds, totalReceiptValue }
    }, STOCK_TX_OPTIONS)

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    for (const freightPoId of receiptResult.freightPoIds) {
      revalidatePath(`/purchase-orders/${freightPoId}`)
    }
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'received',
      tag: 'purchase',
      level: 'INFO',
      description: `Received PO ${po.reference} (${linesWithQty.length} lines)`,
      metadata: { reference: po.reference, lineCount: linesWithQty.length, newStatus: receiptResult.newStatus },
    })

    // Log stock movement for the receipt
    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'purchase_receipt',
      tag: 'stock',
      level: 'INFO',
      description: `Received ${linesWithQty.length} lines for PO ${po.reference} into ${warehouseNamesList}`,
      metadata: { reference: po.reference, lineCount: linesWithQty.length },
    })

    const receivedProductIds = [
      ...new Set(
        linesWithQty
          .map((rl) => po.lines.find((line) => line.id === rl.poLineId)?.productId)
          .filter((value): value is string => !!value),
      ),
    ]

    try {
      await allocateBackordersForProducts(receivedProductIds, {
        source: 'purchase_receipt',
        referenceId: id,
        referenceLabel: `PO receipt ${po.reference}`,
      })
    } catch (allocError) {
      console.error(allocError)
    }

    try {
      await enqueueStockSync(receivedProductIds, 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }

    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'received',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to receive PO ${id}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function cancelPurchaseOrder(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('purchasing.create')
    const existing = await db.purchaseOrder.findUnique({ where: { id }, select: { status: true, reference: true } })
    if (!existing) return { success: false, error: 'PO not found' }
    const transition = validatePurchaseOrderStatusTransition(existing.status, 'CANCELLED')
    if (!transition.success) return { success: false, error: transition.error }

    await db.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'cancelled',
      tag: 'purchase',
      level: 'INFO',
      description: `Cancelled PO ${existing.reference}`,
      metadata: { reference: existing.reference },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'cancelled',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to cancel PO ${id}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function getSupplierLastPrices(
  supplierId: string,
): Promise<Record<string, { lastUnitCost: number; currency: string; supplierSku: string | null }>> {
  await requireAuth()
  const rows = await db.supplierProduct.findMany({
    where: { supplierId },
    select: { productId: true, lastUnitCost: true, currency: true, supplierSku: true },
  })
  const result: Record<string, { lastUnitCost: number; currency: string; supplierSku: string | null }> = {}
  for (const r of rows) {
    result[r.productId] = {
      lastUnitCost: Number(r.lastUnitCost),
      currency: r.currency,
      supplierSku: r.supplierSku,
    }
  }
  return result
}

export type ReturnLineInput = {
  poLineId: string
  qtyReturned: number
  warehouseId: string
}

export async function returnPurchaseOrder(
  id: string,
  returnLines: ReturnLineInput[],
  reason: string,
  notes?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('purchasing.receive')
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      select: {
        id: true,
        reference: true,
        status: true,
        lines: {
          select: {
            id: true,
            productId: true,
            qtyReceived: true,
            qtyReturned: true,
          },
        },
      },
    })
    if (!po) return { success: false, error: 'PO not found' }

    const returnable: PoStatus[] = ['PO_SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED', 'PARTIALLY_RETURNED']
    if (!returnable.includes(po.status as PoStatus)) {
      return { success: false, error: 'Cannot return from a PO in this status' }
    }

    const linesWithQty = returnLines.filter((rl) => rl.qtyReturned > 0)
    if (!linesWithQty.length) return { success: false, error: 'Enter at least one quantity to return' }
    const accountingSettings = await getAccountingSettings()

    // Validate: can't return more than net received (received - already returned)
    for (const rl of linesWithQty) {
      const poLine = po.lines.find((l) => l.id === rl.poLineId)
      if (!poLine) return { success: false, error: 'Invalid PO line' }
      const netReceived = Number(poLine.qtyReceived) - Number(poLine.qtyReturned)
      if (rl.qtyReturned > netReceived) {
        return { success: false, error: `Cannot return more than net received quantity` }
      }
      // Check stock level won't go negative
      const stockLevel = await db.stockLevel.findUnique({
        where: { productId_warehouseId: { productId: poLine.productId, warehouseId: rl.warehouseId } },
      })
      if (stockLevel && Number(stockLevel.quantity) < rl.qtyReturned) {
        return { success: false, error: `Insufficient stock to return (only ${Number(stockLevel.quantity)} available)` }
      }
    }

    const returnRef = `RTN-${po.reference}-${Date.now().toString(36).toUpperCase()}`
    let purchaseReturnId = ''
    let totalReturnedCostBase = 0
    await db.$transaction(async (tx) => {
      const purchaseReturn = await tx.purchaseReturn.create({
        data: {
          poId: id,
          reference: returnRef,
          reason: reason || null,
          notes: notes || null,
          lines: {
            create: linesWithQty.map((rl) => ({
              poLineId: rl.poLineId,
              qtyReturned: rl.qtyReturned,
              warehouseId: rl.warehouseId || null,
            })),
          },
        },
        select: { id: true },
      })
      purchaseReturnId = purchaseReturn.id

      for (const rl of linesWithQty) {
        const poLine = po.lines.find((l) => l.id === rl.poLineId)!
        await tx.stockLevel.upsert({
          where: { productId_warehouseId: { productId: poLine.productId, warehouseId: rl.warehouseId } },
          create: { productId: poLine.productId, warehouseId: rl.warehouseId, quantity: 0 },
          update: {},
        })
        await tx.$executeRaw`
          SELECT "productId", "warehouseId"
          FROM stock_levels
          WHERE "productId" = ${poLine.productId}
            AND "warehouseId" = ${rl.warehouseId}
          FOR UPDATE
        `
        const lockedLevel = await tx.stockLevel.findUnique({
          where: { productId_warehouseId: { productId: poLine.productId, warehouseId: rl.warehouseId } },
          select: { quantity: true },
        })
        if (!lockedLevel || Number(lockedLevel.quantity) < rl.qtyReturned) {
          throw new Error(`Insufficient stock to return (only ${Number(lockedLevel?.quantity ?? 0)} available)`)
        }
        const movement = await tx.stockMovement.create({
          data: {
            type: 'ADJUSTMENT',
            productId: poLine.productId,
            fromWarehouseId: rl.warehouseId,
            qty: rl.qtyReturned,
            note: `Return to supplier against ${po.reference}${reason ? ` — ${reason}` : ''}`,
            referenceType: 'PurchaseReturn',
            referenceId: purchaseReturn.id,
          },
        })
        const { consumed } = await consumeFifoLayersStrict(tx, poLine.productId, rl.warehouseId, rl.qtyReturned)
        totalReturnedCostBase = consumed.reduce(
          (sum, entry) => addMoney(sum, multiplyMoney(entry.qty, entry.unitCostBase)).toNumber(),
          totalReturnedCostBase,
        )
        if (consumed.length > 0) {
          await tx.cogsEntry.createMany({
            data: consumed.map((entry) => ({
              costLayerId: entry.costLayerId,
              movementId: movement.id,
              qty: entry.qty.toNumber(),
              unitCostBase: entry.unitCostBase.toNumber(),
              totalCostBase: roundQuantity(multiplyMoney(entry.qty, entry.unitCostBase), 6).toNumber(),
            })),
          })
        }
        await tx.stockLevel.updateMany({
          where: { productId: poLine.productId, warehouseId: rl.warehouseId },
          data: { quantity: { decrement: rl.qtyReturned } },
        })
        await tx.purchaseOrderLine.update({
          where: { id: rl.poLineId },
          data: { qtyReturned: { increment: rl.qtyReturned } },
        })
      }
      const updatedLines = await tx.purchaseOrderLine.findMany({
        where: { poId: id },
        select: { qtyReceived: true, qtyReturned: true },
      })
      const anyReturned = updatedLines.some((line) => Number(line.qtyReturned) > 0)
      const allReceivedReturned = updatedLines
        .filter((line) => Number(line.qtyReceived) > 0)
        .every((line) => Number(line.qtyReturned) >= Number(line.qtyReceived) - 1e-6)
      if (anyReturned) {
        await tx.purchaseOrder.update({
          where: { id },
          data: { status: allReceivedReturned ? 'RETURNED' : 'PARTIALLY_RETURNED' },
        })
      }
      if (accountingSettings.syncEnabled && totalReturnedCostBase > 0.000001) {
        const amount = Math.round(totalReturnedCostBase * 100) / 100
        const payload = {
          date: new Date().toISOString().slice(0, 10),
          reference: returnRef,
          narration: `Supplier return for PO ${po.reference}`,
          lines: [
            {
              accountCode: accountingSettings.transitAccount,
              description: `Reverse supplier return ${returnRef}`,
              debit: amount,
            },
            {
              accountCode: accountingSettings.inventoryAccount,
              description: `Reduce inventory for supplier return ${returnRef}`,
              credit: amount,
            },
          ],
        }
        await queueAccountingSyncTx(tx, {
          type: 'INVENTORY_ADJUSTMENT',
          referenceType: 'PurchaseReturn',
          referenceId: purchaseReturn.id,
          payload,
          idempotencyKey: accountingPayloadKey(`purchase-return:${purchaseReturn.id}`, payload),
        })
      }
    }, STOCK_TX_OPTIONS)

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'returned',
      tag: 'purchase',
      level: 'INFO',
      description: `Created return for PO ${po.reference}`,
      metadata: { reference: po.reference, lineCount: linesWithQty.length, reason },
    })

    // Log stock movement for the return
    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'purchase_return',
      tag: 'stock',
      level: 'INFO',
      description: `Returned stock for PO ${po.reference}`,
      metadata: { reference: po.reference, lineCount: linesWithQty.length, reason },
    })

    try {
      const returnedPairs = linesWithQty.map((rl) => ({
        productId: po.lines.find((l) => l.id === rl.poLineId)!.productId,
        warehouseId: rl.warehouseId,
      }))
      await releaseOverallocations(returnedPairs, {
        source: 'stock_adjustment',
        referenceId: purchaseReturnId,
        referenceLabel: `supplier return ${returnRef}`,
      })
    } catch (rebalanceError) {
      console.error(rebalanceError)
    }

    try {
      const returnedProductIds = [...new Set(
        linesWithQty.map((rl) => po.lines.find((l) => l.id === rl.poLineId)?.productId).filter((v): v is string => !!v),
      )]
      if (returnedProductIds.length > 0) {
        await enqueueStockSync(returnedProductIds, 'IMS_CHANGE')
      }
    } catch (syncError) {
      console.error(syncError)
    }

    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'returned',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to return PO ${id}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Billing / Invoicing
// ---------------------------------------------------------------------------

export type InvoiceLineInput =
  | { kind: 'product'; poLineId: string; qtyBilled: number; unitCostForeign: number }
  | { kind: 'cost'; costLineId: string; description: string; amountForeign: number }

export type CreateInvoiceInput = {
  invoiceNumber?: string
  invoiceDate: string
  dueDate?: string
  notes?: string
  supplierInvoiceUrl?: string
  lines: InvoiceLineInput[]
}

export type InvoiceRow = {
  id: string
  invoiceNumber: string | null
  invoiceDate: string
  dueDate: string | null
  subtotalForeign: number
  subtotalBase: number
  taxForeign: number
  taxBase: number
  totalForeign: number
  totalBase: number
  notes: string | null
  supplierInvoiceUrl: string | null
  accountingInvoiceId: string | null
  paidAt: string | null
  paymentAccountId: string | null
  paymentAccountName: string | null
  paymentReference: string | null
  createdAt: string
  lines: {
    id: string
    poLineId: string | null
    costLineId: string | null
    productId: string
    sku: string
    productName: string
    description: string
    qtyBilled: number
    unitCostForeign: number
    totalForeign: number
    totalBase: number
  }[]
}

export async function createInvoice(
  poId: string,
  input: CreateInvoiceInput,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('purchasing.invoice')
    const po = await db.purchaseOrder.findUnique({
      where: { id: poId },
      select: {
        id: true,
        reference: true,
        status: true,
        currency: true,
        fxRateToBase: true,
        taxForeign: true,
        subtotalForeign: true,
        lines: {
          select: {
            id: true,
            qty: true,
            product: { select: { sku: true } },
            taxRate: { select: { accountingTaxType: true } },
          },
        },
        freightCostLines: {
          select: {
            id: true,
            description: true,
            amountForeign: true,
            vatable: true,
          },
        },
      },
    })
    if (!po) return { success: false, error: 'PO not found' }

    // Split inputs into product vs cost lines.
    const productInputs = input.lines.filter(
      (l): l is Extract<InvoiceLineInput, { kind: 'product' }> =>
        l.kind === 'product' && l.qtyBilled > 0,
    )
    const costInputs = input.lines.filter(
      (l): l is Extract<InvoiceLineInput, { kind: 'cost' }> =>
        l.kind === 'cost' && l.amountForeign > 0,
    )
    if (!productInputs.length && !costInputs.length) {
      return { success: false, error: 'Select at least one line to bill' }
    }

    // Enforce limits + build maps to the underlying PO line rows.
    const poLineById = new Map(po.lines.map((l) => [l.id, l]))
    const costLineById = new Map(po.freightCostLines.map((c) => [c.id, c]))

    for (const l of productInputs) {
      const poLine = poLineById.get(l.poLineId)
      if (!poLine) return { success: false, error: `Unknown PO line ${l.poLineId}` }
    }
    for (const l of costInputs) {
      const costLine = costLineById.get(l.costLineId)
      if (!costLine) return { success: false, error: `Unknown cost line ${l.costLineId}` }
    }

    const invoiceDate = new Date(input.invoiceDate)
    const baseCurrency = await getBaseCurrencyCode()
    // FIFO layers are valued from the PO's booked base cost at receipt time.
    // Keep supplier bills on that same FX basis so AP, transit, and inventory
    // reconcile instead of letting invoice-date rates reprice the layer.
    const fxRate = Number(po.fxRateToBase)
    if (!Number.isFinite(fxRate) || fxRate <= 0) {
      return { success: false, error: `Invalid FX rate on PO ${po.reference}` }
    }
    let subtotalForeign = 0
    let subtotalBase = 0
    let taxBaseForeign = 0

    const productLineData = productInputs.map((l) => {
      const totalForeign = Math.round(l.qtyBilled * l.unitCostForeign * 10000) / 10000
      const totalBase = Math.round((totalForeign / fxRate) * 10000) / 10000
      subtotalForeign += totalForeign
      subtotalBase += totalBase
      // Product lines always contribute to the tax base (the existing
      // PO-level ratio heuristic is applied across the whole product subtotal).
      taxBaseForeign += totalForeign
      return {
        poLineId: l.poLineId,
        costLineId: null,
        description: null,
        qtyBilled: l.qtyBilled,
        unitCostForeign: l.unitCostForeign,
        totalForeign,
        totalBase,
      }
    })

    const costLineData = costInputs.map((l) => {
      const totalForeign = Math.round(l.amountForeign * 10000) / 10000
      const totalBase = Math.round((totalForeign / fxRate) * 10000) / 10000
      subtotalForeign += totalForeign
      subtotalBase += totalBase
      const costLine = costLineById.get(l.costLineId)!
      // Only vatable cost lines contribute to the tax base.
      if (costLine.vatable) taxBaseForeign += totalForeign
      return {
        poLineId: null,
        costLineId: l.costLineId,
        description: l.description,
        qtyBilled: 1,
        unitCostForeign: l.amountForeign,
        totalForeign,
        totalBase,
      }
    })

    const lineData = [...productLineData, ...costLineData]

    // Calculate tax proportion (same ratio as PO) — applied only to the portion
    // of the bill that is actually vatable (product subtotal + vatable cost lines).
    const poSubtotal = Number(po.subtotalForeign)
    const poTax = Number(po.taxForeign)
    const taxRate = poSubtotal > 0 ? poTax / poSubtotal : 0
    const taxForeign = Math.round(taxBaseForeign * taxRate * 10000) / 10000
    const taxBase = Math.round((taxForeign / fxRate) * 10000) / 10000

    const totalForeign = subtotalForeign + taxForeign
    const totalBase = subtotalBase + taxBase
    const [accountingSettings, supplierData] = await Promise.all([
      getAccountingSettings(),
      db.purchaseOrder.findUnique({
        where: { id: poId },
        select: { supplier: { select: { name: true, taxRate: { select: { accountingTaxType: true } } } }, currency: true },
      }),
    ])
    const fallbackTaxType = supplierData?.supplier?.taxRate?.accountingTaxType ?? undefined
    const taxTypeByLine = new Map(
      po.lines.map((r) => [r.id, r.taxRate?.accountingTaxType ?? undefined]),
    )
    const productPayloadLines = productInputs.map((l) => ({
      description: `PO ${po.reference} line`,
      quantity: l.qtyBilled,
      unitAmount: Math.round(l.unitCostForeign * 10000) / 10000,
      accountCode: accountingSettings.transitAccount,
      taxType: taxTypeByLine.get(l.poLineId) ?? fallbackTaxType,
    }))
    const costPayloadLines = costInputs.map((l) => {
      const costLine = costLineById.get(l.costLineId)!
      return {
        description: l.description || costLine.description,
        quantity: 1,
        unitAmount: Math.round(l.amountForeign * 10000) / 10000,
        accountCode: accountingSettings.transitAccount,
        taxType: costLine.vatable ? fallbackTaxType : undefined,
      }
    })
    const accountingPayload = {
      invoiceNumber: po.reference,
      contactName: supplierData?.supplier?.name ?? 'Unknown Supplier',
      date: input.invoiceDate,
      dueDate: input.dueDate ?? undefined,
      currency: supplierData?.currency ?? baseCurrency,
      // Stamp IMS's FX rate so Xero/QB don't apply their own daily rate.
      currencyRateToBase: Number(fxRate) || undefined,
      reference: input.invoiceNumber ?? undefined,
      // Bills always debit transit first. For landed-cost changes that arrive
      // after receipt, the recalculation path posts a separate reclass from
      // transit into inventory/COGS for the delta on already-received stock.
      lines: [...productPayloadLines, ...costPayloadLines],
      supplierInvoicePath: input.supplierInvoiceUrl ?? undefined,
    }

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
      await tx.$executeRaw`SELECT id FROM purchase_order_lines WHERE "poId" = ${poId} FOR UPDATE`
      await tx.$executeRaw`SELECT id FROM freight_cost_lines WHERE "poId" = ${poId} FOR UPDATE`

      const existing = await tx.purchaseInvoiceLine.findMany({
        where: { invoice: { poId } },
        select: { poLineId: true, costLineId: true, qtyBilled: true, totalForeign: true },
      })
      const alreadyProductByLine = new Map<string, number>()
      const alreadyCostByLine = new Map<string, number>()
      for (const el of existing) {
        if (el.poLineId) {
          alreadyProductByLine.set(el.poLineId, (alreadyProductByLine.get(el.poLineId) ?? 0) + Number(el.qtyBilled))
        }
        if (el.costLineId) {
          alreadyCostByLine.set(el.costLineId, (alreadyCostByLine.get(el.costLineId) ?? 0) + Number(el.totalForeign))
        }
      }

      for (const l of productInputs) {
        const poLine = poLineById.get(l.poLineId)
        if (!poLine) throw new Error(`Unknown PO line ${l.poLineId}`)
        const already = alreadyProductByLine.get(l.poLineId) ?? 0
        if (already + l.qtyBilled > Number(poLine.qty) + 1e-6) {
          throw new Error(`Line ${poLine.product.sku} exceeds remaining qty`)
        }
      }
      for (const l of costInputs) {
        const costLine = costLineById.get(l.costLineId)
        if (!costLine) throw new Error(`Unknown cost line ${l.costLineId}`)
        const already = alreadyCostByLine.get(l.costLineId) ?? 0
        if (already + l.amountForeign > Number(costLine.amountForeign) + 1e-4) {
          throw new Error(`Cost line "${costLine.description}" exceeds remaining amount`)
        }
      }

      await tx.purchaseInvoice.create({
        data: {
          poId,
          invoiceNumber: input.invoiceNumber || null,
          invoiceDate,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          subtotalForeign,
          subtotalBase,
          taxForeign,
          taxBase,
          totalForeign,
          totalBase,
          fxRateToBase: fxRate,
          notes: input.notes || null,
          supplierInvoiceUrl: input.supplierInvoiceUrl || null,
          lines: { create: lineData },
        },
      })

      // Mark invoicedAt (don't change primary status — it's shown as a secondary badge)
      await tx.purchaseOrder.update({
        where: { id: poId },
        data: { invoicedAt: new Date() },
      })

      if (accountingSettings.syncEnabled) {
        await queueAccountingSyncTx(tx, {
          type: 'PURCHASE_INVOICE',
          referenceType: 'PurchaseOrder',
          referenceId: poId,
          payload: accountingPayload,
          idempotencyKey: accountingPayloadKey(`purchase-invoice:${poId}`, accountingPayload),
        })
      }
    }, STOCK_TX_OPTIONS)

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${poId}`)
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: poId,
      action: 'invoiced',
      tag: 'purchase',
      level: 'INFO',
      description: `Created invoice for PO ${po.reference}`,
      metadata: {
        reference: po.reference,
        invoiceNumber: input.invoiceNumber ?? null,
        lineCount: productInputs.length + costInputs.length,
      },
    })

    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: poId,
      action: 'invoiced',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to create invoice for PO ${poId}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Bill payment (mark a supplier bill as paid + push payment to accounting)
// ---------------------------------------------------------------------------

export async function getBillPaymentAccounts(): Promise<AccountingBankAccount[]> {
  await requireAuth()
  return listAccountingBankAccounts()
}

export type MarkBillPaidInput = {
  bankAccountId: string            // connector account id (Xero AccountID)
  paymentDate: string              // YYYY-MM-DD
  reference?: string
  amountForeign?: number           // optional partial payment; defaults to full bill total
}

export async function markBillPaid(
  invoiceId: string,
  input: MarkBillPaidInput,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('purchasing.invoice')

    const invoice = await db.purchaseInvoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        poId: true,
        invoiceNumber: true,
        totalForeign: true,
        fxRateToBase: true,
        paidAt: true,
        accountingInvoiceId: true,
        po: { select: { reference: true, currency: true } },
      },
    })
    if (!invoice) return { success: false, error: 'Bill not found' }
    if (invoice.paidAt) return { success: false, error: 'Bill is already marked as paid' }
    if (!input.bankAccountId) return { success: false, error: 'Select a bank account' }
    if (!input.paymentDate) return { success: false, error: 'Payment date is required' }

    // Resolve bank account name for snapshot (connector-agnostic).
    const accounts = await listAccountingBankAccounts()
    const account = accounts.find((a) => a.id === input.bankAccountId)
    if (!account) return { success: false, error: 'Unknown bank account' }

    const paymentAmount = input.amountForeign ?? Number(invoice.totalForeign)
    const paymentDate = new Date(input.paymentDate)
    const baseCurrency = await getBaseCurrencyCode()
    const settlementRateToBase = await db.$transaction(
      (tx) => resolveSettlementFxRateToBase(tx, {
        currency: invoice.po.currency,
        baseCurrency,
        asOf: paymentDate,
        fallbackRateToBase: Number(invoice.fxRateToBase),
      }),
      STOCK_TX_OPTIONS,
    )

    const paidUpdate = await db.purchaseInvoice.updateMany({
      where: { id: invoiceId, paidAt: null },
      data: {
        paidAt: paymentDate,
        paymentAccountId: input.bankAccountId,
        paymentAccountName: account.name,
        paymentReference: input.reference || null,
      },
    })
    if (paidUpdate.count === 0) {
      return { success: false, error: 'Bill is already marked as paid' }
    }

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${invoice.poId}`)

    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: invoice.poId,
      action: 'bill_paid',
      tag: 'purchase',
      level: 'INFO',
      description: `Marked bill ${invoice.invoiceNumber ?? '(no number)'} as paid from ${account.name}`,
      metadata: {
        reference: invoice.po.reference,
        invoiceId: invoice.id,
        bankAccountName: account.name,
        paymentDate: input.paymentDate,
        amountForeign: paymentAmount,
      },
    })

    // Queue accounting payment sync — only if the bill has actually been
    // pushed to the accounting connector already (has an external id).
    // Otherwise the payment would have nothing to attach to; users should
    // wait for the bill to sync before marking paid.
    if (invoice.accountingInvoiceId) {
      try {
        await queueAccountingSync({
          type: 'BILL_PAYMENT',
          referenceType: 'PurchaseInvoice',
          referenceId: invoice.id,
          payload: {
            accountingInvoiceId: invoice.accountingInvoiceId,
            bankAccountId: input.bankAccountId,
            paymentDate: input.paymentDate,
            amount: paymentAmount,
            currency: invoice.po.currency,
            reference: input.reference ?? undefined,
          },
        })
      } catch {
        // Accounting queue errors should never block the main flow.
      }
    }

    try {
      const accountingSettings = await getAccountingSettings()
      const accounts = getRealisedFxAccounts(accountingSettings, 'payable')
      if (accountingSettings.syncEnabled && accounts && invoice.po.currency !== baseCurrency) {
        const realised = computeRealisedFx({
          side: 'payable',
          amountForeign: paymentAmount,
          bookedRateToBase: Number(invoice.fxRateToBase),
          settlementRateToBase,
        })
        const lines = buildRealisedFxJournal({
          side: 'payable',
          gainLossBase: realised.gainLossBase,
          controlAccount: accounts.controlAccount,
          fxGainLossAccount: accounts.fxGainLossAccount,
          description: `Realised FX ${realised.outcome} on payment for bill ${invoice.invoiceNumber ?? invoice.po.reference}`,
        })
        if (lines.length > 0) {
          await queueAccountingSync({
            type: 'REALISED_FX_JOURNAL',
            referenceType: 'PurchaseInvoice',
            referenceId: invoice.id,
            payload: {
              date: paymentDate.toISOString().slice(0, 10),
              reference: invoice.invoiceNumber ?? invoice.po.reference,
              narration: `Realised FX ${realised.outcome} on supplier payment ${invoice.invoiceNumber ?? invoice.po.reference}`,
              lines,
              side: 'payable',
              amountForeign: paymentAmount,
              currency: invoice.po.currency,
              bookedRateToBase: Number(invoice.fxRateToBase),
              settlementRateToBase,
              bookedBase: realised.bookedBase,
              settlementBase: realised.settlementBase,
              gainLossBase: realised.gainLossBase,
            },
            idempotencyKey: `realised-fx:bill-payment:${invoice.id}:${paymentDate.toISOString().slice(0, 10)}:${paymentAmount}`,
          })
        }
      }
    } catch {
      // FX journal queueing must not block bill payment capture.
    }

    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: invoiceId,
      action: 'bill_paid',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to mark bill ${invoiceId} as paid: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Freight / Landed Cost POs
// ---------------------------------------------------------------------------

export type FreightCostLineInput = {
  description: string
  amountForeign: number
  vatable: boolean
  distributionMethod: string
}

export type CreateFreightPoInput = {
  supplierId: string
  currency: string
  fxRateToBase: number
  primaryPoIds: string[]
  supplierRef?: string
  notes?: string
  taxRateValue?: number
  costLines: FreightCostLineInput[]
}

export async function createFreightPo(input: CreateFreightPoInput): Promise<{ success: boolean; po?: PoRow; error?: string }> {
  try {
    await requirePermission('purchasing.create')
    if (!input.costLines.length) return { success: false, error: 'Add at least one cost line' }
    if (!input.primaryPoIds.length) return { success: false, error: 'Link to at least one primary PO' }

    const fxRate = input.fxRateToBase || 1
    const vatRate = input.taxRateValue ?? 0

    let subtotalForeign = 0
    let taxForeign = 0
    const costLineData = input.costLines.map((cl, i) => {
      const amountBase = Math.round((cl.amountForeign / fxRate) * 10000) / 10000
      subtotalForeign += cl.amountForeign
      if (cl.vatable && vatRate > 0) taxForeign += Math.round(cl.amountForeign * vatRate * 10000) / 10000
      return {
        description: cl.description,
        amountForeign: cl.amountForeign,
        amountBase,
        vatable: cl.vatable,
        distributionMethod: cl.distributionMethod as 'BY_VALUE' | 'BY_WEIGHT' | 'BY_QUANTITY' | 'EQUAL_SPLIT',
        sortOrder: i,
      }
    })

    const subtotalBase = Math.round((subtotalForeign / fxRate) * 10000) / 10000
    const taxBase = Math.round((taxForeign / fxRate) * 10000) / 10000
    const totalForeign = subtotalForeign + taxForeign
    const totalBase = subtotalBase + taxBase

    const freightReference = await makeReference()
    const po = await db.purchaseOrder.create({
      data: {
        reference: freightReference,
        type: 'FREIGHT',
        supplierId: input.supplierId,
        currency: input.currency,
        fxRateToBase: fxRate,
        subtotalForeign,
        subtotalBase,
        taxForeign,
        taxBase,
        totalForeign,
        totalBase,
        directFreightForeign: subtotalForeign,
        directFreightBase: subtotalBase,
        supplierRef: input.supplierRef || null,
        notes: input.notes || null,
        freightCostLines: { create: costLineData },
        asFreightFor: {
          create: input.primaryPoIds.map((pid) => ({
            primaryPoId: pid,
            method: costLineData[0]?.distributionMethod ?? 'BY_VALUE',
          })),
        },
      },
      select: PO_SELECT,
    })
    const landedResult = await db.$transaction(async (tx) => recalculateLandedCosts(tx, po.id), STOCK_TX_OPTIONS)

    // Revalidate linked primary POs
    for (const pid of landedResult.revalidatePoIds) {
      revalidatePath(`/purchase-orders/${pid}`)
    }
    revalidatePath('/purchase-orders')
    const mapped = mapPoRow(po)
    try {
      await queueLandedCostAdjustmentJournals(landedResult)
    } catch { /* Accounting queue errors should not block the main flow */ }
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: mapped.id,
      action: 'created',
      tag: 'purchase',
      level: 'INFO',
      description: `Created freight PO ${mapped.reference}`,
      metadata: { reference: mapped.reference, supplierId: input.supplierId, primaryPoIds: input.primaryPoIds, costLineCount: input.costLines.length },
    })
    return { success: true, po: mapped }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: null,
      action: 'created',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to create freight PO: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

/** Get linked freight POs for a primary PO, with their cost lines */
export async function getLinkedFreightPos(primaryPoId: string) {
  await requireAuth()
  const links = await db.landedCostLink.findMany({
    where: { primaryPoId },
    select: {
      id: true,
      method: true,
      freightPO: {
        select: {
          id: true,
          reference: true,
          status: true,
          currency: true,
          fxRateToBase: true,
          totalForeign: true,
          totalBase: true,
          supplier: { select: { name: true } },
          freightCostLines: {
            select: {
              id: true,
              description: true,
              amountForeign: true,
              amountBase: true,
              distributionMethod: true,
              vatable: true,
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  })
  return links.map((l) => ({
    linkId: l.id,
    method: l.method,
    freightPo: {
      id: l.freightPO.id,
      reference: l.freightPO.reference,
      status: l.freightPO.status,
      currency: l.freightPO.currency,
      supplierName: l.freightPO.supplier.name,
      totalForeign: Number(l.freightPO.totalForeign),
      totalBase: Number(l.freightPO.totalBase),
      costLines: l.freightPO.freightCostLines.map((cl) => ({
        id: cl.id,
        description: cl.description,
        amountForeign: Number(cl.amountForeign),
        amountBase: Number(cl.amountBase),
        distributionMethod: cl.distributionMethod,
        vatable: cl.vatable,
      })),
    },
  }))
}

/** Get all GOODS-type POs for linking (for the freight PO form) */
export async function getGoodsPosForLinking(): Promise<{ id: string; reference: string; supplierName: string; totalForeign: number; currency: string }[]> {
  await requireAuth()
  const pos = await db.purchaseOrder.findMany({
    where: { type: 'GOODS', status: { notIn: ['DRAFT', 'CANCELLED'] } },
    select: {
      id: true,
      reference: true,
      currency: true,
      totalForeign: true,
      supplier: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return pos.map((p) => ({
    id: p.id,
    reference: p.reference,
    supplierName: p.supplier.name,
    totalForeign: Number(p.totalForeign),
    currency: p.currency,
  }))
}

/** Update a freight PO's cost lines and recalculate landed costs on linked primary POs */
export async function updateFreightPoCosts(
  freightPoId: string,
  costLines: FreightCostLineInput[],
  taxRateValue?: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('purchasing.create')
    const { reference, landedResult } = await db.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({
        where: { id: freightPoId },
        select: { id: true, reference: true, type: true, fxRateToBase: true },
      })
      if (!po) throw new Error('PO not found')
      if (po.type !== 'FREIGHT') throw new Error('Not a freight PO')

      const fxRate = new Prisma.Decimal(po.fxRateToBase)
      const vatRate = new Prisma.Decimal(taxRateValue ?? 0)

      await tx.freightCostLine.deleteMany({ where: { poId: freightPoId } })

      let subtotalForeign = new Prisma.Decimal(0)
      let taxForeign = new Prisma.Decimal(0)
      const lineData = costLines.map((cl, i) => {
        const amountForeign = new Prisma.Decimal(cl.amountForeign)
        const amountBase = amountForeign.div(fxRate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
        subtotalForeign = subtotalForeign.add(amountForeign)
        if (cl.vatable && vatRate.gt(0)) {
          taxForeign = taxForeign.add(amountForeign.mul(vatRate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP))
        }
        return {
          poId: freightPoId,
          description: cl.description,
          amountForeign,
          amountBase,
          vatable: cl.vatable,
          distributionMethod: cl.distributionMethod as 'BY_VALUE' | 'BY_WEIGHT' | 'BY_QUANTITY' | 'EQUAL_SPLIT',
          sortOrder: i,
        }
      })
      if (lineData.length > 0) {
        await tx.freightCostLine.createMany({ data: lineData })
      }

      const subtotalBase = subtotalForeign.div(fxRate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
      const taxBase = taxForeign.div(fxRate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
      const totalForeign = subtotalForeign.add(taxForeign)
      const totalBase = subtotalBase.add(taxBase)

      await tx.purchaseOrder.update({
        where: { id: freightPoId },
        data: {
          subtotalForeign,
          subtotalBase,
          taxForeign,
          taxBase,
          totalForeign,
          totalBase,
          directFreightForeign: subtotalForeign,
          directFreightBase: subtotalBase,
        },
      })

      const landedResult = await recalculateLandedCosts(tx, freightPoId)
      return { reference: po.reference, landedResult }
    }, STOCK_TX_OPTIONS)

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${freightPoId}`)
    for (const primaryPoId of landedResult.revalidatePoIds) {
      revalidatePath(`/purchase-orders/${primaryPoId}`)
    }
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: freightPoId,
      action: 'updated',
      tag: 'purchase',
      level: 'INFO',
      description: `Updated freight costs for PO ${reference}`,
      metadata: { reference, costLineCount: costLines.length },
    })

    try {
      await queueLandedCostAdjustmentJournals(landedResult)
    } catch { /* Accounting queue errors should not block the main flow */ }
    for (const adj of landedResult.cogsAdjustments) {
      await logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: adj.primaryPoId,
        action: 'cogs_adjusted',
        tag: 'purchase',
        level: 'INFO',
        description: `Retrospective COGS adjustment of £${adj.totalDelta.toFixed(2)} for ${adj.primaryPoRef} due to landed cost change`,
        metadata: { totalDelta: adj.totalDelta, freightPoId },
      })
    }

    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: freightPoId,
      action: 'updated',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to update freight costs for PO ${freightPoId}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}
