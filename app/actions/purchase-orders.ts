'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { queueAccountingSync, queueAccountingSyncTx, getAccountingSettings, getActiveAccountingConnectorInfo, isAccountingSyncTypeEnabled, listAccountingBankAccounts, type AccountingBankAccount } from '@/lib/accounting'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { multiComponentTaxRateNames } from '@/lib/accounting/multi-component-warning'
import { enqueueStockSync } from '@/lib/shopping'
import { allocateBackordersForProducts } from '@/lib/fulfillment/backorder-allocator'
import { releaseOverallocations } from '@/lib/fulfillment/overallocation-rebalancer'
import { cogsEntryDataFromConsumed, consumeFifoLayersStrict } from '@/lib/cost-layers'
import { toInventoryConstraintMessage } from '@/lib/domain/inventory/prisma-errors'
import { isPurchasableProductStatus } from '@/lib/products/lifecycle'
import { updatePreferredSuppliersForPlacedPurchaseOrder } from '@/lib/domain/purchasing/preferred-supplier'
import {
  resolvedTaxRateFromProfile,
  taxRateProfileSelect,
  type ResolvedTaxRate,
} from '@/lib/tax/resolve-rate'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { cancelPurchaseOrderAction } from '@/lib/domain/purchasing/cancel-purchase-order-action'
import { resolvePurchaseOrderFxRateToBase } from '@/lib/domain/purchasing/purchase-order-fx'
import { validateRecordSupplierCreditNote, buildSupplierCreditNoteSyncPayload, resolveSupplierCreditNoteTaxType } from '@/lib/domain/purchasing/supplier-credit-note'
import {
  updatePurchaseOrderFxRateOnly,
  type PurchaseOrderFxRateOnlyUpdateDb,
} from '@/lib/domain/purchasing/purchase-order-fx-update'
import {
  assertPurchaseInvoiceEditable,
  buildPurchaseInvoiceAccountingPayload,
  buildPurchaseInvoiceUpdateIdempotencyKey,
  calculatePurchaseInvoice,
  dateKey,
  hasPurchaseInvoiceEditChanges,
  optionalText,
  purchaseInvoiceLineChangeSnapshot,
  validatePurchaseInvoiceLineLimits,
  type PurchaseInvoiceInputLine,
} from '@/lib/domain/purchasing/purchase-invoice-edit'
import { maybeQueuePurchaseInvoiceUpdate } from '@/lib/domain/purchasing/purchase-invoice-update-sync'
import {
  computeGrossUnitCostBaseByLine,
  queueLandedCostAdjustmentJournals,
  recalculateDirectLandedCosts,
  recalculateLandedCosts,
} from '@/lib/domain/purchasing/landed-cost-service'
import type { CancelPurchaseOrderResult } from '@/lib/domain/purchasing/cancellation-service'
import { assertFinitePurchaseReceiptUnitCost } from '@/lib/domain/purchasing/purchase-receipt-cost'
import { computePurchaseOrderOverBilling, type PurchaseOrderOverBillingSummary } from '@/lib/domain/purchasing/purchasing-reversal-alerts'
import { computeReturnCreditNoteDraft } from '@/lib/domain/purchasing/return-credit-note'
import { findDivergentReceiptLines } from '@/lib/domain/purchasing/receipt-warehouse-divergence'
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
import { Prisma } from '@/app/generated/prisma/client'
import { addMoney, multiplyMoney, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import {
  buildStockMovementValueFields,
  buildStockMovementValueFieldsFromConsumed,
} from '@/lib/domain/inventory/stock-movement-value'

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
  /** Per-line tax rate id (the order/supplier rate, or a per-line override). */
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
  supplierPrepaid: boolean
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
  skipPreferredSupplierUpdate: boolean
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

export type SupplierCreditNoteRow = {
  id: string
  creditNoteNumber: string | null
  reference: string | null
  amountForeign: number
  currency: string
  reason: string | null
  status: string
  accountingCreditNoteId: string | null
  recordedAt: string
  postedAt: string | null
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
  supplierCreditNotes: SupplierCreditNoteRow[]
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
   * the line takes the order/supplier rate (the PO's order-level tax rate).
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
  fxRateToBase?: number
  destinationWarehouseId?: string
  supplierRef?: string
  expectedDelivery?: string
  notes?: string
  internalNotes?: string
  skipPreferredSupplierUpdate?: boolean
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
  skipPreferredSupplierUpdate: true,
  createdAt: true,
  updatedAt: true,
  supplier: { select: { id: true, name: true, prepaid: true } },
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
  skipPreferredSupplierUpdate: boolean
  createdAt: Date
  updatedAt: Date
  trackingNumber: string | null
  shippingProvider: string | null
  supplier: { name: string; prepaid: boolean }
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
    supplierPrepaid: po.supplier.prepaid,
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
    skipPreferredSupplierUpdate: po.skipPreferredSupplierUpdate,
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
                  taxRate: { select: { rate: true } },
                },
              },
              costLine: {
                select: {
                  description: true,
                  vatable: true,
                },
              },
            },
          },
        },
        orderBy: { invoiceDate: 'desc' },
      },
      // audit-g5u2.5: supplier credit notes recorded against this PO.
      supplierCreditNotes: {
        select: {
          id: true,
          creditNoteNumber: true,
          reference: true,
          amountForeign: true,
          currency: true,
          reason: true,
          status: true,
          accountingCreditNoteId: true,
          recordedAt: true,
          postedAt: true,
        },
        orderBy: { recordedAt: 'desc' },
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
          taxRatePercent: isProduct ? Number(il.poLine?.taxRate?.rate ?? po.taxRatePercent ?? 0) : null,
          vatable: !isProduct ? !!il.costLine?.vatable : null,
        }
      }),
    })),
    supplierCreditNotes: po.supplierCreditNotes.map((cn) => ({
      id: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      reference: cn.reference,
      amountForeign: Number(cn.amountForeign),
      currency: cn.currency,
      reason: cn.reason,
      status: cn.status,
      accountingCreditNoteId: cn.accountingCreditNoteId ?? null,
      recordedAt: cn.recordedAt.toISOString(),
      postedAt: cn.postedAt?.toISOString() ?? null,
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

/** Order-level tax context — the supplier's Default VAT Rate (or a per-PO override of it). */
type OrderDefaultTaxCtx = {
  id: ResolvedTaxRate['taxRateId']
  name: ResolvedTaxRate['taxRateName']
  rate: ResolvedTaxRate['taxRateValue']
  accountingTaxType: ResolvedTaxRate['accountingTaxType']
  isCompound: ResolvedTaxRate['isCompound']
  reverseCharge: ResolvedTaxRate['reverseCharge']
  reportingCategory: ResolvedTaxRate['reportingCategory']
  components: ResolvedTaxRate['components']
}

/**
 * Resolve the tax rate for each purchase-order line.
 *
 * Purchases follow the supplier's Default VAT Rate (carried here as the
 * order-level `orderDefault`): every non-overridden line takes that rate, so a
 * "No VAT" supplier (id null, rate 0) yields 0% on every line. There is
 * intentionally NO destination-country/category auto-resolution for POs — that
 * is sales-only. A per-line manual override (`line.taxRateId`) still wins and is
 * looked up from the DB.
 */
async function resolvePurchaseLineTaxRates(
  lines: Array<{ taxRateId?: string | null }>,
  orderDefault: OrderDefaultTaxCtx,
): Promise<ResolvedTaxRate[]> {
  const overrideIds = Array.from(
    new Set(
      lines
        .map((l) => l.taxRateId)
        .filter((x): x is string => typeof x === 'string' && x.length > 0),
    ),
  )
  const overrideRows = overrideIds.length
    ? await db.taxRate.findMany({ where: { id: { in: overrideIds } }, select: taxRateProfileSelect })
    : []
  const overrideById = new Map(overrideRows.map((r) => [r.id, r]))

  return lines.map((l) => {
    if (l.taxRateId) {
      const row = overrideById.get(l.taxRateId)
      if (row) {
        return resolvedTaxRateFromProfile(row, 'exact')
      }
    }
    return {
      taxRateId: orderDefault.id,
      taxRateName: orderDefault.name,
      taxRateValue: orderDefault.rate,
      accountingTaxType: orderDefault.accountingTaxType,
      isCompound: orderDefault.isCompound,
      reverseCharge: orderDefault.reverseCharge,
      reportingCategory: orderDefault.reportingCategory,
      components: orderDefault.components,
      matched: 'fallback' as const,
      warning: null,
    }
  })
}

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

    const baseCurrency = await getBaseCurrencyCode()
    const fxRate = await resolvePurchaseOrderFxRateToBase(db, {
      currency: input.currency,
      baseCurrency,
      asOf: new Date(),
      inputRateToBase: input.fxRateToBase,
    })
    const vatRate = input.taxRateValue ?? 0
    const inclVat = !!input.pricesIncludeVat
    let subtotalForeign = 0
    let subtotalBase = 0
    let totalTaxForeign = 0
    let totalTaxBase = 0

    // --- Tax rate resolution -------------------------------------------
    // Each line either has a manual override (`l.taxRateId`) or takes the
    // order/supplier rate (see resolvePurchaseLineTaxRates).

    // Order-level rate = the supplier's Default VAT Rate (or a per-PO override
    // of it). Applied to every non-override line + additional costs / discount.
    const orderDefaultRate = input.taxRateId
      ? await db.taxRate.findUnique({
          where: { id: input.taxRateId },
          select: taxRateProfileSelect,
        })
      : input.taxRateName
      ? await db.taxRate.findFirst({
          where: { name: input.taxRateName, active: true },
          select: taxRateProfileSelect,
        })
      : null
    const orderDefaultProfile = orderDefaultRate ? resolvedTaxRateFromProfile(orderDefaultRate, 'fallback') : null
    const orderDefaultCtx = {
      id: orderDefaultProfile?.taxRateId ?? null,
      name: orderDefaultProfile?.taxRateName ?? input.taxRateName ?? null,
      rate: orderDefaultProfile?.taxRateValue ?? vatRate,
      accountingTaxType: orderDefaultProfile?.accountingTaxType ?? null,
      isCompound: orderDefaultProfile?.isCompound ?? false,
      reverseCharge: orderDefaultProfile?.reverseCharge ?? false,
      reportingCategory: orderDefaultProfile?.reportingCategory ?? null,
      components: orderDefaultProfile?.components ?? [],
    }

    // Validate every line's product is purchasable.
    const productIdsForTax = Array.from(new Set(input.lines.map((l) => l.productId).filter(Boolean)))
    if (productIdsForTax.length) {
      const productRows = await db.product.findMany({
        where: { id: { in: productIdsForTax } },
        select: { id: true, lifecycleStatus: true },
      })
      const nonPurchasableProduct = productRows.find((p) => !isPurchasableProductStatus(p.lifecycleStatus))
      if (nonPurchasableProduct) {
        return { success: false, error: 'Only active and draft products can be added to new purchase orders' }
      }
    }

    // Supplier's Default VAT Rate is authoritative for every line (per-line manual override still wins).
    const lineResolved = await resolvePurchaseLineTaxRates(input.lines, orderDefaultCtx)

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
        skipPreferredSupplierUpdate: input.skipPreferredSupplierUpdate ?? false,
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
    const session = await requirePermission('purchasing.create')
    const existing = await db.purchaseOrder.findUnique({
      where: { id },
      select: {
        status: true,
        currency: true,
        fxRateToBase: true,
        subtotalForeign: true,
        taxForeign: true,
        totalForeign: true,
        directFreightForeign: true,
        directFreightBase: true,
      },
    })
    if (!existing) return { success: false, error: 'PO not found' }
    if (existing.status !== 'DRAFT') return { success: false, error: 'Only DRAFT POs can be edited' }

    const shouldRefreshFxRate = input.currency !== undefined || input.fxRateToBase !== undefined
    const rateOnlyFxRefresh = shouldRefreshFxRate && input.lines === undefined && input.additionalCosts === undefined
    const baseCurrency = shouldRefreshFxRate ? await getBaseCurrencyCode() : null
    const fxRate = shouldRefreshFxRate && !rateOnlyFxRefresh
      ? await resolvePurchaseOrderFxRateToBase(db, {
          currency: input.currency ?? existing.currency,
          baseCurrency: baseCurrency!,
          asOf: new Date(),
          inputRateToBase: input.fxRateToBase,
        })
      : Number(existing.fxRateToBase)
    const inclVat = !!input.pricesIncludeVat
    const vatRate = input.taxRateValue ?? 0

    const updates: Record<string, unknown> = {
      ...(input.supplierId !== undefined && { supplierId: input.supplierId }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(shouldRefreshFxRate && !rateOnlyFxRefresh && { fxRateToBase: fxRate }),
      ...(input.destinationWarehouseId !== undefined && { destinationWarehouseId: input.destinationWarehouseId || null }),
      ...(input.supplierRef !== undefined && { supplierRef: input.supplierRef || null }),
      ...(input.expectedDelivery !== undefined && { expectedDelivery: input.expectedDelivery ? new Date(input.expectedDelivery) : null }),
      ...(input.notes !== undefined && { notes: input.notes || null }),
      ...(input.internalNotes !== undefined && { internalNotes: input.internalNotes || null }),
      ...(input.skipPreferredSupplierUpdate !== undefined && { skipPreferredSupplierUpdate: input.skipPreferredSupplierUpdate }),
    }

    // Order-level tax rate update (always apply when lines are being saved,
    // because line VAT has to be recomputed in the same pass).
    if (input.lines || input.taxRateId !== undefined || input.taxRateName !== undefined) {
      updates.taxRateName = input.taxRateName || null
      updates.taxRatePercent = vatRate > 0 ? vatRate : null
    }

    if (input.lines) {
      // --- Tax rate resolution (mirror createPurchaseOrder) -------------
      const orderDefaultRate = input.taxRateId
        ? await db.taxRate.findUnique({
            where: { id: input.taxRateId },
            select: taxRateProfileSelect,
          })
        : input.taxRateName
        ? await db.taxRate.findFirst({
            where: { name: input.taxRateName, active: true },
            select: taxRateProfileSelect,
          })
        : null
      const orderDefaultProfile = orderDefaultRate ? resolvedTaxRateFromProfile(orderDefaultRate, 'fallback') : null
      const orderDefaultCtx = {
        id: orderDefaultProfile?.taxRateId ?? null,
        name: orderDefaultProfile?.taxRateName ?? input.taxRateName ?? null,
        rate: orderDefaultProfile?.taxRateValue ?? vatRate,
        accountingTaxType: orderDefaultProfile?.accountingTaxType ?? null,
        isCompound: orderDefaultProfile?.isCompound ?? false,
        reverseCharge: orderDefaultProfile?.reverseCharge ?? false,
        reportingCategory: orderDefaultProfile?.reportingCategory ?? null,
        components: orderDefaultProfile?.components ?? [],
      }

      // Validate every line's product is purchasable.
      const productIdsForTax = Array.from(new Set(input.lines.map((l) => l.productId).filter(Boolean)))
      if (productIdsForTax.length) {
        const productRows = await db.product.findMany({
          where: { id: { in: productIdsForTax } },
          select: { id: true, lifecycleStatus: true },
        })
        const nonPurchasableProduct = productRows.find((p) => !isPurchasableProductStatus(p.lifecycleStatus))
        if (nonPurchasableProduct) {
          return { success: false, error: 'Only active and draft products can be added to purchase orders' }
        }
      }

      // Supplier's Default VAT Rate is authoritative for every line (per-line manual override still wins).
      const lineResolved = await resolvePurchaseLineTaxRates(input.lines, orderDefaultCtx)

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

    const po = rateOnlyFxRefresh
      ? await updatePurchaseOrderFxRateOnly(
          db as unknown as PurchaseOrderFxRateOnlyUpdateDb<Parameters<typeof mapPoRow>[0]>,
          id,
          {
            currency: existing.currency,
            subtotalForeign: existing.subtotalForeign,
            taxForeign: existing.taxForeign,
            totalForeign: existing.totalForeign,
            directFreightForeign: existing.directFreightForeign,
          },
          {
            currency: input.currency,
            fxRateToBase: input.fxRateToBase,
          },
          {
            baseCurrency: baseCurrency!,
            asOf: new Date(),
            parentUpdate: { data: updates, select: PO_SELECT },
          },
        )
      : await db.purchaseOrder.update({
          where: { id },
          data: updates,
          select: PO_SELECT,
        })

    // If additional costs were changed on a GOODS PO that has already been
    // received (cost layers exist), recalculate the landed unit cost on
    // each PO line and update the corresponding cost layers. This also
    // computes retrospective COGS adjustments for consumed stock.
    let landedCostAuditRunIds: string[] = []
    if (input.additionalCosts !== undefined && ['PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED'].includes(existing.status)) {
      try {
        const landedResult = await db.$transaction(async (tx) => {
          return recalculateDirectLandedCosts(tx, id, undefined, {
            triggeredById: session.user.id,
            reason: 'purchase_order_additional_costs_updated',
            scheduleAdjustmentJournals: true, // audit-grob durable backstop
          })
        }, STOCK_TX_OPTIONS)
        landedCostAuditRunIds = landedResult.auditRunIds

        try {
          await queueLandedCostAdjustmentJournals(landedResult)
        } catch { /* Accounting queue errors should not block the main flow */ }
        for (const adj of landedResult.cogsAdjustments) {
          await logActivity({
            entityType: 'PURCHASE_ORDER', entityId: id, action: 'cogs_adjusted', tag: 'purchase', level: 'INFO',
            description: `Retrospective COGS adjustment of £${adj.totalDelta.toFixed(2)} for ${adj.primaryPoRef} due to additional cost change`,
            metadata: { totalDelta: adj.totalDelta, landedCostAuditRunIds: landedResult.auditRunIds },
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
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'purchase',
      level: 'INFO',
      description: `Updated PO ${mapped.reference}`,
      metadata: { reference: mapped.reference, landedCostAuditRunIds },
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
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`
      const existing = await tx.purchaseOrder.findUnique({ where: { id }, select: { status: true, reference: true } })
      if (!existing) throw new Error('PO not found')
      if (existing.status === targetStatus) {
        return { existing, changed: false, preferredSupplierUpdate: { productIds: [], updatedCount: 0 } }
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
      const preferredSupplierUpdate = targetStatus === 'PO_SENT'
        ? await updatePreferredSuppliersForPlacedPurchaseOrder(tx, id, now)
        : { productIds: [], updatedCount: 0 }
      return { existing, changed: true, preferredSupplierUpdate }
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
        metadata: {
          reference: result.existing.reference,
          previousStatus: result.existing.status,
          newStatus: targetStatus,
          preferredSupplierUpdatedCount: result.preferredSupplierUpdate.updatedCount,
          preferredSupplierCandidateCount: result.preferredSupplierUpdate.productIds.length,
        },
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
  options?: { confirmWarehouseDivergence?: boolean },
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
        destinationWarehouseId: true,
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

    // audit-H7: lines received into a warehouse other than the PO destination
    // send stock + cost layers to the wrong site (and landed-cost distribution
    // assumed the planned location). Require explicit confirmation, and record
    // the divergence on the receipt log.
    const divergentLines = findDivergentReceiptLines({
      destinationWarehouseId: po.destinationWarehouseId,
      lines: linesWithQty.map((rl) => ({ poLineId: rl.poLineId, warehouseId: rl.warehouseId })),
    })
    if (divergentLines.length > 0 && !options?.confirmWarehouseDivergence) {
      return {
        success: false,
        error: `${divergentLines.length} line(s) are being received into a warehouse other than the PO destination. Confirm the divergence to proceed.`,
      }
    }

    const receiptRef = `RCP-${po.reference}-${Date.now().toString(36).toUpperCase()}`
    const receiptResult = await db.$transaction(async (tx) => {
      // Lock the PO row to prevent concurrent receipts from over-receiving
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`

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

        const unitCostBaseInput = grossUnitCostBaseByLine.get(poLine.id) ?? poLine.unitCostBase
        assertFinitePurchaseReceiptUnitCost(unitCostBaseInput, {
          poLineId: poLine.id,
          poRef: currentPo.reference,
        })
        const unitCostBase = toDecimal(unitCostBaseInput)
        totalReceiptValue += rl.qtyReceived * unitCostBase.toNumber()

        await tx.stockMovement.create({
          data: {
            type: 'PURCHASE_RECEIPT',
            productId: poLine.productId,
            toWarehouseId: rl.warehouseId,
            qty: rl.qtyReceived,
            ...buildStockMovementValueFields({ qty: rl.qtyReceived, unitCostBase }),
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
      description: divergentLines.length > 0
        ? `Received PO ${po.reference} (${linesWithQty.length} lines; ${divergentLines.length} into a non-destination warehouse)`
        : `Received PO ${po.reference} (${linesWithQty.length} lines)`,
      metadata: {
        reference: po.reference,
        lineCount: linesWithQty.length,
        newStatus: receiptResult.newStatus,
        ...(divergentLines.length > 0 ? { warehouseDivergence: divergentLines } : {}),
      },
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

export async function cancelPurchaseOrder(id: string): Promise<CancelPurchaseOrderResult> {
  return cancelPurchaseOrderAction(id)
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
    const session = await requirePermission('purchasing.receive')
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      select: {
        id: true,
        reference: true,
        status: true,
        supplierId: true,
        currency: true,
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
    let totalReturnedCostBase = toDecimal(0)
    const { overBilling, creditNote } = await db.$transaction(async (tx): Promise<{ overBilling: PurchaseOrderOverBillingSummary; creditNote: { id: string; amountForeign: number; invoiceId: string } | null }> => {
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
        await tx.$queryRaw`
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
        await tx.stockMovement.update({
          where: { id: movement.id },
          data: buildStockMovementValueFieldsFromConsumed(consumed),
        })
        totalReturnedCostBase = consumed.reduce(
          (sum, entry) => addMoney(sum, multiplyMoney(entry.qty, entry.unitCostBase)),
          totalReturnedCostBase,
        )
        if (consumed.length > 0) {
          await tx.cogsEntry.createMany({
            data: consumed.map((entry) => cogsEntryDataFromConsumed(movement.id, entry)),
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

      // audit-C4: compute over-billing inside the tx so qtyReturned reflects
      // exactly this return (a concurrent return cannot inflate the figure).
      const billingLines = await tx.purchaseOrderLine.findMany({
        where: { poId: id },
        select: { id: true, productId: true, qtyReceived: true, qtyReturned: true, product: { select: { sku: true } } },
      })
      const billingInvoices = await tx.purchaseInvoice.findMany({
        where: { poId: id },
        select: {
          id: true, invoiceNumber: true, totalBase: true,
          subtotalForeign: true, totalForeign: true, fxRateToBase: true, createdAt: true,
          lines: { select: { poLineId: true, qtyBilled: true, totalBase: true, totalForeign: true } },
        },
      })
      const overBillingComputed = computePurchaseOrderOverBilling({
        lines: billingLines.map((l) => ({ id: l.id, productId: l.productId, sku: l.product?.sku ?? null, qtyReceived: l.qtyReceived, qtyReturned: l.qtyReturned })),
        invoices: billingInvoices.map((inv) => ({ id: inv.id, invoiceNumber: inv.invoiceNumber, totalBase: inv.totalBase, lines: inv.lines })),
      })

      // Auto-create a DRAFT supplier credit note for the returned (over-billed)
      // goods so the AP liability is reduced; finance reviews + posts it. Net out
      // credit notes already recorded against the bill so repeated returns top up
      // rather than double-credit.
      let createdCreditNote: { id: string; amountForeign: number; invoiceId: string } | null = null
      if (billingInvoices.length > 0) {
        const invoiceIds = billingInvoices.map((inv) => inv.id)
        const existingCredits = await tx.supplierCreditNote.groupBy({
          by: ['purchaseInvoiceId'],
          where: { purchaseInvoiceId: { in: invoiceIds } },
          _sum: { amountForeign: true },
        })
        const creditedByInvoice = new Map(
          existingCredits.map((c) => [c.purchaseInvoiceId, Number(c._sum.amountForeign ?? 0)]),
        )
        const draft = computeReturnCreditNoteDraft({
          poLines: billingLines.map((l) => ({ poLineId: l.id, qtyReceived: l.qtyReceived, qtyReturned: l.qtyReturned })),
          bills: billingInvoices.map((inv) => ({
            invoiceId: inv.id,
            subtotalForeign: inv.subtotalForeign,
            totalForeign: inv.totalForeign,
            fxRateToBase: inv.fxRateToBase,
            alreadyCreditedForeign: creditedByInvoice.get(inv.id) ?? 0,
            createdAt: inv.createdAt.getTime(),
            lines: inv.lines.map((il) => ({ poLineId: il.poLineId, qtyBilled: il.qtyBilled, totalForeign: il.totalForeign })),
          })),
        })
        if (draft) {
          const cn = await tx.supplierCreditNote.create({
            data: {
              poId: id,
              purchaseInvoiceId: draft.invoiceId,
              supplierId: po.supplierId,
              reference: returnRef,
              amountForeign: draft.amountForeign,
              amountBase: draft.amountBase,
              currency: po.currency,
              fxRateToBase: draft.fxRateToBase,
              reason: `Supplier return ${returnRef}${reason ? ` — ${reason}` : ''}`,
              status: 'DRAFT',
              createdBy: session.user.id,
            },
            select: { id: true },
          })
          createdCreditNote = { id: cn.id, amountForeign: draft.amountForeign, invoiceId: draft.invoiceId }
        }
      }

      if (accountingSettings.syncEnabled && totalReturnedCostBase.gt(0.000001)) {
        const amount = roundQuantity(totalReturnedCostBase, 2).toNumber()
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
      return { overBilling: overBillingComputed, creditNote: createdCreditNote }
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

    // audit-C4: returns reverse stock/cost but never touch supplier bills. When a
    // line is now billed beyond what is kept, flag the over-billed bill(s) so
    // finance can raise a supplier credit. Computed inside the tx above; logging
    // is isolated so a log failure can't fail the already-committed return.
    try {
      if (overBilling.hasInvoices && overBilling.hasOverBilling) {
        await logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: id,
          action: 'return_overbilled_bill',
          tag: 'purchase',
          level: creditNote ? 'INFO' : 'WARNING',
          description: creditNote
            ? `Return on PO ${po.reference} leaves ${overBilling.totalOverBilledQty} unit(s) billed but not kept — a DRAFT supplier credit note of ${po.currency} ${creditNote.amountForeign.toFixed(2)} was created for review. Post it to credit the supplier bill.`
            : `Return on PO ${po.reference} leaves ${overBilling.totalOverBilledQty} unit(s) billed but not kept — ${overBilling.totalOverBilledValueBase} over-billed (base currency) across ${overBilling.bills.length} bill(s). Raise a supplier credit.`,
          metadata: {
            reference: po.reference,
            totalOverBilledQty: overBilling.totalOverBilledQty,
            totalOverBilledValueBase: overBilling.totalOverBilledValueBase,
            overBilledLines: overBilling.lines,
            bills: overBilling.bills,
            ...(creditNote ? { draftCreditNoteId: creditNote.id, draftCreditNoteAmountForeign: creditNote.amountForeign, currency: po.currency } : {}),
          },
        })
      }
    } catch (billingWarnError) {
      console.error(billingWarnError)
    }

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
    const message = toInventoryConstraintMessage(e, 'Failed to return purchase order stock.')
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'returned',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to return PO ${id}: ${message}`,
      metadata: null,
    })
    return { success: false, error: message }
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

export type UpdateInvoiceLineInput = {
  id: string
  qtyBilled?: number
  unitCostForeign?: number
  description?: string
  amountForeign?: number
}

export type UpdateInvoiceInput = {
  invoiceNumber?: string
  invoiceDate: string
  dueDate?: string
  notes?: string
  supplierInvoiceUrl?: string
  lines: UpdateInvoiceLineInput[]
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
    taxRatePercent: number | null
    vatable: boolean | null
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
            qtyReceived: true,
            qtyReturned: true,
            product: { select: { sku: true } },
            taxRate: {
              select: {
                accountingTaxType: true,
                reverseCharge: true,
                name: true,
                isCompound: true,
                components: { where: { active: true }, select: { id: true }, take: 1 },
              },
            },
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
    const [accountingSettings, supplierData] = await Promise.all([
      getAccountingSettings(),
      db.purchaseOrder.findUnique({
        where: { id: poId },
        select: { supplier: { select: { name: true, taxRate: { select: { accountingTaxType: true } } } }, currency: true },
      }),
    ])
    const fallbackTaxType = supplierData?.supplier?.taxRate?.accountingTaxType ?? undefined
    const invoiceCalculation = calculatePurchaseInvoice({
      lines: [
        ...productInputs.map((l): PurchaseInvoiceInputLine => ({
          kind: 'product',
          poLineId: l.poLineId,
          qtyBilled: l.qtyBilled,
          unitCostForeign: l.unitCostForeign,
        })),
        ...costInputs.map((l): PurchaseInvoiceInputLine => ({
          kind: 'cost',
          costLineId: l.costLineId,
          description: l.description,
          amountForeign: l.amountForeign,
        })),
      ],
      fxRateToBase: fxRate,
      poReference: po.reference,
      poSubtotalForeign: Number(po.subtotalForeign),
      poTaxForeign: Number(po.taxForeign),
      transitAccount: accountingSettings.transitAccount,
      fallbackTaxType,
      reverseChargeTaxType: accountingSettings.reverseChargePurchaseTaxType || undefined,
      poLineById,
      costLineById,
    })
    const accountingPayload = buildPurchaseInvoiceAccountingPayload({
      poReference: po.reference,
      contactName: supplierData?.supplier?.name,
      date: input.invoiceDate,
      dueDate: input.dueDate,
      currency: supplierData?.currency ?? baseCurrency,
      fxRateToBase: fxRate,
      reference: input.invoiceNumber,
      lines: invoiceCalculation.accountingLines,
      supplierInvoicePath: input.supplierInvoiceUrl,
    })

    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM purchase_order_lines WHERE "poId" = ${poId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM freight_cost_lines WHERE "poId" = ${poId} FOR UPDATE`

      const existing = await tx.purchaseInvoiceLine.findMany({
        where: { invoice: { poId } },
        select: { poLineId: true, costLineId: true, qtyBilled: true, totalForeign: true },
      })
      // Re-read quantities + supplier policy UNDER the locks just acquired.
      // The pre-transaction reads above feed pricing/tax; the three-way match
      // must validate against locked rows or a return / receipt / prepaid
      // toggle committed between the pre-read and the lock could let a bill
      // through against stale quantities.
      const lockedPo = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: poId },
        select: {
          supplier: { select: { prepaid: true } },
          lines: {
            select: {
              id: true,
              qty: true,
              qtyReceived: true,
              qtyReturned: true,
              product: { select: { sku: true } },
            },
          },
          freightCostLines: {
            select: { id: true, description: true, amountForeign: true, vatable: true },
          },
        },
      })
      validatePurchaseInvoiceLineLimits({
        lineData: invoiceCalculation.lineData,
        alreadyBilledLines: existing,
        poLineById: new Map(lockedPo.lines.map((l) => [l.id, l])),
        costLineById: new Map(lockedPo.freightCostLines.map((c) => [c.id, c])),
        allowBillBeforeReceipt: lockedPo.supplier.prepaid,
      })

      await tx.purchaseInvoice.create({
        data: {
          poId,
          invoiceNumber: input.invoiceNumber || null,
          invoiceDate,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          subtotalForeign: invoiceCalculation.subtotalForeign,
          subtotalBase: invoiceCalculation.subtotalBase,
          taxForeign: invoiceCalculation.taxForeign,
          taxBase: invoiceCalculation.taxBase,
          totalForeign: invoiceCalculation.totalForeign,
          totalBase: invoiceCalculation.totalBase,
          fxRateToBase: fxRate,
          notes: input.notes || null,
          supplierInvoiceUrl: input.supplierInvoiceUrl || null,
          lines: {
            create: invoiceCalculation.lineData.map((line) => ({
              poLineId: line.poLineId,
              costLineId: line.costLineId,
              description: line.description,
              qtyBilled: line.qtyBilled,
              unitCostForeign: line.unitCostForeign,
              totalForeign: line.totalForeign,
              totalBase: line.totalBase,
            })),
          },
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
    if (accountingSettings.syncEnabled) {
      const multiComponentRateNames = multiComponentTaxRateNames(po.lines)
      if (multiComponentRateNames.length > 0) {
        await logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: poId,
          action: 'purchase_invoice_tax_components_not_pushed',
          tag: 'accounting',
          level: 'WARNING',
          description: `Multi-component tax rates on this bill will post to the accounting system as a single TaxType: ${multiComponentRateNames.join(', ')}. Configure the equivalent TaxComponents on the accounting side or the per-component breakdown will not appear on the VAT return.`,
          metadata: { taxRateNames: multiComponentRateNames },
        })
      }
    }

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

export async function updateInvoice(
  invoiceId: string,
  input: UpdateInvoiceInput,
): Promise<{ success: boolean; error?: string; notice?: string }> {
  try {
    await requirePermission('purchasing.invoice')
    if (!input.invoiceDate) return { success: false, error: 'Invoice date is required' }
    if (!input.lines.length) return { success: false, error: 'Bill must have at least one line' }

    const invoice = await db.purchaseInvoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        poId: true,
        invoiceNumber: true,
        invoiceDate: true,
        dueDate: true,
        subtotalForeign: true,
        subtotalBase: true,
        taxForeign: true,
        taxBase: true,
        totalForeign: true,
        totalBase: true,
        fxRateToBase: true,
        notes: true,
        supplierInvoiceUrl: true,
        accountingInvoiceId: true,
        paidAt: true,
        po: {
          select: {
            id: true,
            reference: true,
            currency: true,
            fxRateToBase: true,
            taxForeign: true,
            subtotalForeign: true,
            supplier: {
              select: {
                name: true,
                email: true,
                prepaid: true,
                taxRate: { select: { accountingTaxType: true } },
              },
            },
            lines: {
              select: {
                id: true,
                qty: true,
                qtyReceived: true,
                qtyReturned: true,
                product: { select: { sku: true } },
                taxRate: {
                  select: {
                    accountingTaxType: true,
                    reverseCharge: true,
                    name: true,
                    isCompound: true,
                    components: { where: { active: true }, select: { id: true }, take: 1 },
                  },
                },
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
        },
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
          },
        },
      },
    })
    if (!invoice) return { success: false, error: 'Bill not found' }
    try {
      assertPurchaseInvoiceEditable(invoice)
    } catch (error) {
      return { success: false, error: String(error instanceof Error ? error.message : error) }
    }

    const lineInputById = new Map(input.lines.map((line) => [line.id, line]))
    if (lineInputById.size !== input.lines.length) {
      return { success: false, error: 'Duplicate bill line in edit request' }
    }
    for (const line of invoice.lines) {
      if (!lineInputById.has(line.id)) {
        return { success: false, error: 'All existing bill lines must be included when editing a bill' }
      }
    }
    for (const line of input.lines) {
      if (!invoice.lines.some((existing) => existing.id === line.id)) {
        return { success: false, error: `Unknown bill line ${line.id}` }
      }
    }

    const invoiceDate = new Date(input.invoiceDate)
    const dueDate = input.dueDate ? new Date(input.dueDate) : null
    const fxRate = Number(invoice.fxRateToBase)
    if (!Number.isFinite(fxRate) || fxRate <= 0) {
      return { success: false, error: `Invalid FX rate on bill ${invoice.invoiceNumber ?? invoice.id}` }
    }
    const baseCurrency = await getBaseCurrencyCode()
    const poLineById = new Map(invoice.po.lines.map((line) => [line.id, line]))
    const costLineById = new Map(invoice.po.freightCostLines.map((line) => [line.id, line]))
    const fallbackTaxType = invoice.po.supplier.taxRate?.accountingTaxType ?? undefined
    const accountingSettings = await getAccountingSettings()
    const invoiceInputLines: PurchaseInvoiceInputLine[] = []
    for (const existingLine of invoice.lines) {
      const lineInput = lineInputById.get(existingLine.id)!
      if (existingLine.poLineId) {
        const poLine = poLineById.get(existingLine.poLineId)
        if (!poLine) return { success: false, error: `Unknown PO line ${existingLine.poLineId}` }
        invoiceInputLines.push({
          kind: 'product',
          id: existingLine.id,
          poLineId: existingLine.poLineId,
          qtyBilled: Number(lineInput.qtyBilled ?? existingLine.qtyBilled),
          unitCostForeign: Number(lineInput.unitCostForeign ?? existingLine.unitCostForeign),
        })
      } else if (existingLine.costLineId) {
        const costLine = costLineById.get(existingLine.costLineId)
        if (!costLine) return { success: false, error: `Unknown cost line ${existingLine.costLineId}` }
        invoiceInputLines.push({
          kind: 'cost',
          id: existingLine.id,
          costLineId: existingLine.costLineId,
          description: optionalText(lineInput.description ?? existingLine.description ?? costLine.description) ?? costLine.description,
          amountForeign: Number(lineInput.amountForeign ?? lineInput.unitCostForeign ?? existingLine.totalForeign),
        })
      } else {
        return { success: false, error: `Bill line ${existingLine.id} is not linked to a PO or cost line` }
      }
    }

    let invoiceCalculation
    try {
      invoiceCalculation = calculatePurchaseInvoice({
        lines: invoiceInputLines,
        fxRateToBase: fxRate,
        poReference: invoice.po.reference,
        poSubtotalForeign: Number(invoice.po.subtotalForeign),
        poTaxForeign: Number(invoice.po.taxForeign),
        transitAccount: accountingSettings.transitAccount,
        fallbackTaxType,
        reverseChargeTaxType: accountingSettings.reverseChargePurchaseTaxType || undefined,
        poLineById,
        costLineById,
      })
    } catch (error) {
      return { success: false, error: String(error instanceof Error ? error.message : error) }
    }
    const lineUpdates = invoiceCalculation.lineData

    const normalizedHeader = {
      invoiceNumber: optionalText(input.invoiceNumber),
      invoiceDate: dateKey(invoiceDate),
      dueDate: dateKey(dueDate),
      notes: optionalText(input.notes),
      supplierInvoiceUrl: optionalText(input.supplierInvoiceUrl),
    }
    const existingHeader = {
      invoiceNumber: optionalText(invoice.invoiceNumber),
      invoiceDate: dateKey(invoice.invoiceDate),
      dueDate: dateKey(invoice.dueDate),
      notes: optionalText(invoice.notes),
      supplierInvoiceUrl: optionalText(invoice.supplierInvoiceUrl),
    }
    const existingLines = invoice.lines.map((line) => ({
      id: line.id,
      description: optionalText(line.description),
      qtyBilled: Number(line.qtyBilled),
      unitCostForeign: Number(line.unitCostForeign),
      totalForeign: Number(line.totalForeign),
    })).sort((a, b) => a.id.localeCompare(b.id))
    const nextLines = lineUpdates.map((line) => purchaseInvoiceLineChangeSnapshot(line)).sort((a, b) => a.id.localeCompare(b.id))
    const hasChanges = hasPurchaseInvoiceEditChanges({
      existingHeader,
      nextHeader: normalizedHeader,
      existingLines,
      nextLines,
    })
    if (!hasChanges) {
      return { success: true, notice: 'No bill changes to save' }
    }

    const accountingPayload = buildPurchaseInvoiceAccountingPayload({
      accountingInvoiceId: invoice.accountingInvoiceId,
      poReference: invoice.po.reference,
      contactName: invoice.po.supplier.name,
      date: input.invoiceDate,
      dueDate: input.dueDate,
      currency: invoice.po.currency ?? baseCurrency,
      fxRateToBase: fxRate,
      reference: normalizedHeader.invoiceNumber,
      lines: invoiceCalculation.accountingLines,
      supplierInvoicePath: normalizedHeader.supplierInvoiceUrl,
    })
    const idempotencyKey = invoice.accountingInvoiceId
      ? buildPurchaseInvoiceUpdateIdempotencyKey({
          invoiceId: invoice.id,
          accountingInvoiceId: invoice.accountingInvoiceId,
          payload: accountingPayload,
        })
      : null

    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE id = ${invoice.id} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${invoice.poId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM purchase_invoice_lines WHERE "invoiceId" = ${invoice.id} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM purchase_order_lines WHERE "poId" = ${invoice.poId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM freight_cost_lines WHERE "poId" = ${invoice.poId} FOR UPDATE`

      const lockedInvoice = await tx.purchaseInvoice.findUnique({
        where: { id: invoice.id },
        select: {
          paidAt: true,
          lines: { select: { poLineId: true, qtyBilled: true } },
        },
      })
      if (!lockedInvoice) throw new Error('Bill not found')
      assertPurchaseInvoiceEditable(lockedInvoice)

      const otherLines = await tx.purchaseInvoiceLine.findMany({
        where: { invoice: { poId: invoice.poId, id: { not: invoice.id } } },
        select: { poLineId: true, costLineId: true, qtyBilled: true, totalForeign: true },
      })
      // Re-read quantities + supplier policy UNDER the locks (the pre-tx reads
      // feed pricing/tax only) so a return / receipt / prepaid toggle committed
      // between the pre-read and the lock cannot let stale quantities through.
      const lockedPo = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: invoice.poId },
        select: {
          supplier: { select: { prepaid: true } },
          lines: {
            select: {
              id: true,
              qty: true,
              qtyReceived: true,
              qtyReturned: true,
              product: { select: { sku: true } },
            },
          },
          freightCostLines: {
            select: { id: true, description: true, amountForeign: true, vatable: true },
          },
        },
      })
      // Grandfather this invoice's current quantities: lines billed under the
      // policy in force at creation (prepaid then, or returns landed after
      // billing) stay editable at their existing level; only increases must
      // satisfy today's cap.
      const grandfatheredQtyByPoLineId = new Map<string, number>()
      for (const line of lockedInvoice.lines) {
        if (!line.poLineId) continue
        grandfatheredQtyByPoLineId.set(
          line.poLineId,
          (grandfatheredQtyByPoLineId.get(line.poLineId) ?? 0) + Number(line.qtyBilled),
        )
      }
      validatePurchaseInvoiceLineLimits({
        lineData: lineUpdates,
        alreadyBilledLines: otherLines,
        poLineById: new Map(lockedPo.lines.map((l) => [l.id, l])),
        costLineById: new Map(lockedPo.freightCostLines.map((c) => [c.id, c])),
        // Prepaid suppliers bill up to ordered qty; others up to received qty.
        allowBillBeforeReceipt: lockedPo.supplier.prepaid,
        grandfatheredQtyByPoLineId,
      })

      await tx.purchaseInvoice.update({
        where: { id: invoice.id },
        data: {
          invoiceNumber: normalizedHeader.invoiceNumber,
          invoiceDate,
          dueDate,
          subtotalForeign: invoiceCalculation.subtotalForeign,
          subtotalBase: invoiceCalculation.subtotalBase,
          taxForeign: invoiceCalculation.taxForeign,
          taxBase: invoiceCalculation.taxBase,
          totalForeign: invoiceCalculation.totalForeign,
          totalBase: invoiceCalculation.totalBase,
          notes: normalizedHeader.notes,
          supplierInvoiceUrl: normalizedHeader.supplierInvoiceUrl,
        },
      })
      // Interactive Prisma transactions run on one connection; keep these
      // small line updates sequential so errors surface at the exact row.
      for (const line of lineUpdates) {
        if (!line.id) throw new Error('Bill line update is missing an id')
        await tx.purchaseInvoiceLine.update({
          where: { id: line.id },
          data: {
            description: line.description,
            qtyBilled: line.qtyBilled,
            unitCostForeign: line.unitCostForeign,
            totalForeign: line.totalForeign,
            totalBase: line.totalBase,
          },
        })
      }

      await maybeQueuePurchaseInvoiceUpdate({
        tx,
        syncEnabled: accountingSettings.syncEnabled,
        invoiceId: invoice.id,
        poId: invoice.poId,
        poReference: invoice.po.reference,
        accountingInvoiceId: invoice.accountingInvoiceId,
        accountingPayload,
        idempotencyKey,
        deps: {
          getActiveAccountingConnectorInfo,
          isAccountingSyncTypeEnabled,
          queueAccountingSyncTx,
        },
      })
    }, STOCK_TX_OPTIONS)

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${invoice.poId}`)
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: invoice.poId,
      action: 'bill_updated',
      tag: 'purchase',
      level: 'INFO',
      description: `Updated bill ${normalizedHeader.invoiceNumber ?? invoice.invoiceNumber ?? invoice.id} for PO ${invoice.po.reference}`,
      metadata: {
        reference: invoice.po.reference,
        invoiceId: invoice.id,
        accountingInvoiceId: invoice.accountingInvoiceId,
        queuedAccountingUpdate: Boolean(invoice.accountingInvoiceId && idempotencyKey),
      },
    })
    if (accountingSettings.syncEnabled) {
      const multiComponentRateNames = multiComponentTaxRateNames(invoice.po.lines)
      if (multiComponentRateNames.length > 0) {
        await logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: invoice.poId,
          action: 'purchase_invoice_tax_components_not_pushed',
          tag: 'accounting',
          level: 'WARNING',
          description: `Multi-component tax rates on this bill will post to the accounting system as a single TaxType: ${multiComponentRateNames.join(', ')}. Configure the equivalent TaxComponents on the accounting side or the per-component breakdown will not appear on the VAT return.`,
          metadata: { taxRateNames: multiComponentRateNames },
        })
      }
    }

    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: null,
      action: 'bill_updated',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to update bill ${invoiceId}: ${String(e)}`,
      metadata: { invoiceId },
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
        referenceType: 'PurchaseInvoice',
        referenceId: invoice.id,
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
    //
    // Ordering invariant (audit-68cv): accountingInvoiceId is written back ONLY
    // after the PURCHASE_INVOICE CREATE posts to Xero, so this guard means a
    // BILL_PAYMENT can never be queued ahead of its bill's CREATE. Unlike
    // SALES_INVOICE_UPDATE / PURCHASE_INVOICE_UPDATE (which CAN be queued before
    // their CREATE and so need findInvoiceUpdatesBlockedByPendingCreate
    // deferral, audit-H5), BILL_PAYMENT needs no CREATE-ordering deferral — it is
    // safe by construction, exactly like INVOICE_PAYMENT.
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

// audit-g5u2.3: record a supplier credit note (DRAFT) against a billed (freight)
// PO — e.g. crediting a duplicate freight bill. POSTED later via
// postSupplierCreditNote, which pushes it to the accounting connector.
export async function recordSupplierFreightCreditNote(input: {
  poId: string
  amountForeign: number
  reason?: string
  creditNoteNumber?: string
  notes?: string
  purchaseInvoiceId?: string
}): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const session = await requirePermission('purchasing.invoice')
    const po = await db.purchaseOrder.findUnique({
      where: { id: input.poId },
      select: {
        id: true,
        reference: true,
        currency: true,
        fxRateToBase: true,
        supplierId: true,
        invoices: { select: { id: true, fxRateToBase: true, totalForeign: true }, orderBy: { createdAt: 'desc' } },
      },
    })
    if (!po) return { success: false, error: 'Purchase order not found' }

    const selectedInvoice = input.purchaseInvoiceId
      ? po.invoices.find((inv) => inv.id === input.purchaseInvoiceId) ?? null
      : po.invoices[0] ?? null

    // Remaining creditable = the bill's total minus credit notes already recorded
    // against it, so a PO can't be over-credited (Codex review).
    let remainingCreditableForeign: number | null = null
    if (selectedInvoice) {
      const existing = await db.supplierCreditNote.aggregate({
        where: { purchaseInvoiceId: selectedInvoice.id },
        _sum: { amountForeign: true },
      })
      remainingCreditableForeign = Number(selectedInvoice.totalForeign) - Number(existing._sum.amountForeign ?? 0)
    }

    const validationError = validateRecordSupplierCreditNote({
      amountForeign: input.amountForeign,
      hasInvoice: po.invoices.length > 0,
      selectedInvoiceBelongsToPo: input.purchaseInvoiceId ? Boolean(selectedInvoice) : null,
      remainingCreditableForeign,
    })
    if (validationError) return { success: false, error: validationError }

    const fxRateToBase = Number(selectedInvoice?.fxRateToBase ?? po.fxRateToBase ?? 1)
    const amountBase = roundQuantity(toDecimal(input.amountForeign).mul(fxRateToBase), 4).toNumber()

    const creditNote = await db.supplierCreditNote.create({
      data: {
        poId: po.id,
        purchaseInvoiceId: selectedInvoice?.id ?? null,
        supplierId: po.supplierId,
        reference: input.creditNoteNumber || po.reference,
        creditNoteNumber: input.creditNoteNumber || null,
        amountForeign: roundQuantity(input.amountForeign, 4).toNumber(),
        amountBase,
        currency: po.currency,
        fxRateToBase,
        reason: input.reason || null,
        notes: input.notes || null,
        status: 'DRAFT',
        createdBy: session.user.id,
      },
      select: { id: true },
    })

    revalidatePath(`/purchase-orders/${po.id}`)
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: po.id,
      action: 'supplier_credit_note_recorded',
      tag: 'purchase',
      level: 'INFO',
      description: `Recorded supplier credit note of ${po.currency} ${input.amountForeign.toFixed(2)} against ${po.reference}`,
      metadata: { creditNoteId: creditNote.id, amountForeign: input.amountForeign, currency: po.currency, reason: input.reason ?? null },
    })
    return { success: true, id: creditNote.id }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// audit-g5u2.3: post a DRAFT supplier credit note — mark POSTED and (Xero only)
// queue the ACCPAYCREDIT push so the GL is credited.
export async function postSupplierCreditNote(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('purchasing.invoice')
    const cn = await db.supplierCreditNote.findUnique({
      where: { id },
      select: {
        id: true, poId: true, supplierId: true, currency: true, fxRateToBase: true,
        amountForeign: true, creditNoteNumber: true, reference: true, reason: true, status: true,
        // audit-oy5p: the offset bill's tax + supplier tax type, to mirror the bill's tax treatment.
        // audit-v08m: + the bill's external (Xero) id, to allocate the credit to it.
        purchaseInvoice: { select: { taxForeign: true, accountingInvoiceId: true } },
        po: {
          select: {
            reference: true, type: true,
            supplier: { select: { name: true, taxRate: { select: { accountingTaxType: true, reverseCharge: true } } } },
            // Per-line tax rates drive the bill's per-line tax choice. A null line
            // rate means the line follows the order/supplier default rate.
            lines: { select: { taxRate: { select: { accountingTaxType: true, reverseCharge: true } } } },
          },
        },
      },
    })
    if (!cn) return { success: false, error: 'Credit note not found' }
    if (cn.status !== 'DRAFT') return { success: false, error: 'Credit note is already posted' }

    // Resolve connector/settings BEFORE the transaction (Codex review: a lookup
    // failure must not occur after the row is already POSTED).
    const connector = await getActiveAccountingConnectorInfo()
    const settings = await getAccountingSettings()

    // Mirror the bill's tax treatment, derived from the PO LINES' effective tax
    // rates (a null line rate follows the supplier default) rather than the
    // supplier default alone, so per-line overrides are respected. Reverse charge
    // only when GOODS lines are UNIFORMLY reverse-charge (a single-amount credit
    // can't represent a mixed-tax bill).
    const supplierRate = cn.po.supplier.taxRate
    const goodsLineRates = cn.po.type === 'GOODS'
      ? cn.po.lines.map((l) => l.taxRate ?? supplierRate).filter((r): r is NonNullable<typeof r> => !!r)
      : []
    const isReverseCharge = goodsLineRates.length > 0 && goodsLineRates.every((r) => r.reverseCharge)
    // Base (non-RC) tax type: the line rate where overridden, else the supplier default.
    const baseTaxType = (cn.po.lines.find((l) => l.taxRate)?.taxRate ?? supplierRate)?.accountingTaxType

    // A reverse-charge goods PO carries no supplier VAT (taxForeign 0) but its bill
    // posts on the reverse-charge tax type, so the credit must reverse on that SAME
    // type (not NONE) to unwind the notional VAT. Otherwise: the line/supplier tax
    // type when the bill carried VAT, else NONE.
    const creditNoteTaxType = resolveSupplierCreditNoteTaxType({
      billHadTax: Number(cn.purchaseInvoice?.taxForeign ?? 0) > 0,
      supplierTaxType: baseTaxType,
      isReverseCharge,
      reverseChargeTaxType: settings.reverseChargePurchaseTaxType || null,
    })
    // Xero-only: the ACCPAYCREDIT poster exists for Xero. For other connectors the
    // credit note still records as POSTED in IMS (consistent with sync being off).
    const shouldQueueXero =
      connector?.id === 'xero' && settings.syncEnabled && (await isAccountingSyncTypeEnabled('PURCHASE_CREDIT_NOTE'))

    // CRITICAL (Codex review): claim DRAFT->POSTED and enqueue the sync in ONE
    // transaction. If the queue insert fails, the whole tx rolls back and the row
    // stays DRAFT (retryable) — never "POSTED in IMS but never sent to Xero".
    const posted = await db.$transaction(async (tx) => {
      const claimed = await tx.supplierCreditNote.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'POSTED', postedAt: new Date() },
      })
      if (claimed.count === 0) return false
      if (shouldQueueXero) {
        await queueAccountingSyncTx(tx, {
          type: 'PURCHASE_CREDIT_NOTE',
          referenceType: 'SupplierCreditNote',
          referenceId: cn.id,
          payload: buildSupplierCreditNoteSyncPayload({
            creditNoteId: cn.id,
            creditNoteNumber: cn.creditNoteNumber,
            reference: cn.reference,
            reason: cn.reason,
            supplierName: cn.po.supplier.name,
            supplierId: cn.supplierId,
            currency: cn.currency,
            fxRateToBase: Number(cn.fxRateToBase),
            amountForeign: Number(cn.amountForeign),
            transitAccount: settings.transitAccount,
            taxType: creditNoteTaxType,
            // Reverse-charge credits carry a NET amount → post EXCLUSIVE so Xero
            // adds the notional VAT (mirroring the net/exclusive RC bill); all
            // others carry a GROSS amount → INCLUSIVE.
            lineAmountsIncludeTax: !isReverseCharge,
            date: new Date().toISOString().slice(0, 10),
            // audit-v08m: allocate the credit to the bill once both have posted to
            // Xero. Skipped when the bill has no external id yet (allocation needs it).
            allocateToInvoiceId: cn.purchaseInvoice?.accountingInvoiceId ?? null,
            allocateAmount: Number(cn.amountForeign),
          }),
          idempotencyKey: `supplier-credit-note:${cn.id}`,
        })
      }
      return true
    }, STOCK_TX_OPTIONS)
    if (!posted) return { success: false, error: 'Credit note is already posted' }

    revalidatePath(`/purchase-orders/${cn.poId}`)
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: cn.poId,
      action: 'supplier_credit_note_posted',
      tag: 'purchase',
      level: 'INFO',
      description: `Posted supplier credit note of ${cn.currency} ${Number(cn.amountForeign).toFixed(2)} for ${cn.po.reference}`,
      metadata: { creditNoteId: cn.id, amountForeign: Number(cn.amountForeign), currency: cn.currency },
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function createFreightPo(input: CreateFreightPoInput): Promise<{ success: boolean; po?: PoRow; error?: string }> {
  try {
    const session = await requirePermission('purchasing.create')
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
    const landedResult = await db.$transaction(
      async (tx) => recalculateLandedCosts(tx, po.id, undefined, {
        triggeredById: session.user.id,
        reason: 'freight_purchase_order_created',
        scheduleAdjustmentJournals: true, // audit-grob durable backstop
      }),
      STOCK_TX_OPTIONS,
    )

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
      metadata: {
        reference: mapped.reference,
        supplierId: input.supplierId,
        primaryPoIds: input.primaryPoIds,
        costLineCount: input.costLines.length,
        landedCostAuditRunIds: landedResult.auditRunIds,
      },
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
    const session = await requirePermission('purchasing.create')
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

      const landedResult = await recalculateLandedCosts(tx, freightPoId, undefined, {
        triggeredById: session.user.id,
        reason: 'freight_purchase_order_costs_updated',
        scheduleAdjustmentJournals: true, // audit-grob durable backstop
      })
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
      metadata: { reference, costLineCount: costLines.length, landedCostAuditRunIds: landedResult.auditRunIds },
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
        metadata: { totalDelta: adj.totalDelta, freightPoId, landedCostAuditRunIds: landedResult.auditRunIds },
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
