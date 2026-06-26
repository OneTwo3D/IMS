'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import type { WmsOrderStatusView } from '@/app/actions/wms-order-status'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import {
  queueAccountingSync,
  queueAccountingSyncTx,
  getAccountingSettings,
  getActiveAccountingConnectorInfo,
  type AccountingSettings,
} from '@/lib/accounting'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'
import { multiComponentTaxRateNames } from '@/lib/accounting/multi-component-warning'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync, pushOrderDeliveryMetadata, pushSalesOrderStatus } from '@/lib/shopping'
import { isSellableProductStatus } from '@/lib/products/lifecycle'
import {
  resolveLineTaxRateBatch,
  resolvedTaxRateFromProfile,
  taxRateProfileSelect,
  type ResolvedTaxRate,
} from '@/lib/tax/resolve-rate'
import { INTERNAL_STATUS_TRANSITION_BYPASS } from '@/lib/sales/status-transition-bypass'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { decimalToNumber } from '@/lib/decimal'
import { multiplyMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { validateManualSalesOrderStatusTransition } from '@/lib/domain/workflows/action-guards'
import {
  buildRealisedFxJournal,
  computeRealisedFx,
  getRealisedFxAccounts,
  resolveSettlementFxRateToBase,
} from '@/lib/accounting-fx'
import { toIsoCountryCode } from '@/lib/countries'
import {
  buildChargebackRefundLines,
  createSalesOrderRefund,
  recordRefundCogsReversalFromSync,
  retrySalesOrderRefundAccounting,
  type CreatedRefundLine,
  type RefundAccountingSyncRequest,
  type RefundRequestLine,
} from '@/lib/domain/sales/refund-service'
import {
  expectedSalesOrderLineTaxForeign,
  validateSalesOrderLineTaxInputs,
} from '@/lib/domain/sales/sales-order-tax-validation'
import { isExternalRefundIdUniqueConflict } from '@/lib/domain/sales/refund-idempotency'
import { shouldWarnPaidWithoutInvoice, shouldWarnPaidOrderCancelledWithoutInvoice } from '@/lib/domain/sales/paid-without-invoice'
import { isPaymentStatusMismatch } from '@/lib/domain/sales/o2c-guards'
import {
  cancelSalesOrderFulfillmentState,
  updateSalesOrderStatusUnderLock,
} from '@/lib/domain/sales/allocation-service'
import { queueSalesInvoiceUpdateForExistingAccountingInvoice } from '@/lib/domain/sales/sales-invoice-update-sync'
import { Prisma, type ProductType, type TaxCategory } from '@/app/generated/prisma/client'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

function roundDecimalNumber(value: DecimalInput, precision: number): number {
  return roundQuantity(value, precision).toNumber()
}

function divideRoundedNumber(value: DecimalInput, divisor: DecimalInput, precision: number): number {
  return roundDecimalNumber(toDecimal(value).div(toDecimal(divisor)), precision)
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
  productType: ProductType | null
  oversellAllowed: boolean
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
  externalOrderId: string | null
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
  /** Cached live WMS order status (sales-list chip); null when none/disabled. */
  wmsStatus: WmsOrderStatusView | null
  /** Outbound WMS dispatch-push state (sales-list chip); null when never pushed. */
  wmsPush: { state: string; lastError: string | null } | null
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
    accountingRetryRequired: boolean
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
   * Optional caller-supplied tax assertion used by import/API boundaries. The
   * action still computes persisted tax itself; when present, this value must
   * match the resolved tax rate and inclusive/exclusive pricing mode.
   */
  taxForeign?: number | null
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

async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  params: { key: string; prefix: string; date?: Date },
): Promise<string> {
  const date = params.date ?? new Date()
  const year = date.getFullYear()
  const counterKey = `document_counter:${params.key}:${year}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${counterKey}))`
  const row = await tx.setting.findUnique({
    where: { key: counterKey },
    select: { value: true },
  })
  const current = row?.value
    ? Number.parseInt(row.value, 10)
    : await getExistingDocumentNumberMax(tx, params.key, `${params.prefix}${year}-`)
  const next = Number.isFinite(current) && current >= 0 ? current + 1 : 1
  await tx.setting.upsert({
    where: { key: counterKey },
    create: { key: counterKey, value: String(next) },
    update: { value: String(next) },
  })
  return `${params.prefix}${year}-${String(next).padStart(5, '0')}`
}

async function getExistingDocumentNumberMax(
  tx: Prisma.TransactionClient,
  key: string,
  prefix: string,
): Promise<number> {
  const parseSuffix = (value: string | null): number => {
    if (!value?.startsWith(prefix)) return 0
    const suffix = value.slice(prefix.length)
    return /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : 0
  }
  if (key === 'invoice') {
    const rows = await tx.salesOrder.findMany({
      where: { invoiceNumber: { startsWith: prefix } },
      select: { invoiceNumber: true },
    })
    return rows.reduce((max, row) => Math.max(max, parseSuffix(row.invoiceNumber)), 0)
  }
  if (key === 'credit_note') {
    const rows = await tx.salesOrderRefund.findMany({
      where: { creditNoteNumber: { startsWith: prefix } },
      select: { creditNoteNumber: true },
    })
    return rows.reduce((max, row) => Math.max(max, parseSuffix(row.creditNoteNumber)), 0)
  }
  return 0
}

async function resolveFxRateToBase(
  tx: Prisma.TransactionClient,
  currency: string,
  baseCurrency: string,
  asOf: Date,
): Promise<number> {
  const normalizedCurrency = currency.trim().toUpperCase()
  const normalizedBase = baseCurrency.trim().toUpperCase()
  if (!normalizedCurrency || normalizedCurrency === normalizedBase) return 1
  const rate = await tx.fxRate.findFirst({
    where: {
      fromCurrency: normalizedBase,
      toCurrency: normalizedCurrency,
      fetchedAt: { lte: asOf },
    },
    orderBy: { fetchedAt: 'desc' },
    select: { rate: true },
  })
  if (!rate) {
    throw new Error(`Missing ${normalizedBase} FX rate for ${normalizedCurrency} on or before ${asOf.toISOString().slice(0, 10)}`)
  }
  return Number(rate.rate)
}

async function refreshDraftOrderFxAtFinalization(
  orderId: string,
  asOf: Date,
): Promise<void> {
  const baseCurrency = await getBaseCurrencyCode()
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
    const order = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        currency: true,
        subtotalForeign: true,
        shippingForeign: true,
        taxForeign: true,
        totalForeign: true,
        lines: {
          select: {
            id: true,
            unitPriceForeign: true,
            totalForeign: true,
            taxForeign: true,
          },
        },
      },
    })
    if (!order || order.status !== 'DRAFT') return
    const fxRate = await resolveFxRateToBase(tx, order.currency, baseCurrency, asOf)
    await tx.salesOrder.update({
      where: { id: orderId },
      data: {
        fxRateToBase: fxRate,
        subtotalBase: divideRoundedNumber(order.subtotalForeign, fxRate, 4),
        shippingBase: divideRoundedNumber(order.shippingForeign, fxRate, 4),
        taxBase: divideRoundedNumber(order.taxForeign, fxRate, 4),
        totalBase: divideRoundedNumber(order.totalForeign, fxRate, 4),
      },
    })
    for (const line of order.lines) {
      await tx.salesOrderLine.update({
        where: { id: line.id },
        data: {
          unitPriceBase: divideRoundedNumber(line.unitPriceForeign, fxRate, 6),
          taxBase: divideRoundedNumber(line.taxForeign, fxRate, 4),
          totalBase: divideRoundedNumber(line.totalForeign, fxRate, 4),
        },
      })
    }
  }, STOCK_TX_OPTIONS)
}

const SO_SELECT = {
  id: true,
  externalOrderNumber: true,
  shoppingLinks: {
    select: { connector: true, externalOrderId: true },
    orderBy: { createdAt: 'asc' },
    take: 1,
  },
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
  wmsOrderStatus: {
    select: {
      connector: true,
      connectorLabel: true,
      externalOrderId: true,
      externalOrderNumber: true,
      status: true,
      statusLabel: true,
      isSplit: true,
      partCount: true,
      isMerged: true,
      mergedOrderNumbers: true,
      deepLinkUrl: true,
      trackingNumber: true,
      carrier: true,
    },
  },
  wmsOrderPush: { select: { state: true, lastError: true } },
  _count: { select: { lines: true } },
  lines: { select: { cogsBase: true } },
} as const

function mapSoRow(so: {
  id: string
  externalOrderNumber: string | null
  shoppingLinks: { connector: string; externalOrderId: string }[]
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
  wmsOrderStatus: {
    connector: string
    connectorLabel: string
    externalOrderId: string
    externalOrderNumber: string
    status: string
    statusLabel: string
    isSplit: boolean
    partCount: number | null
    isMerged: boolean
    mergedOrderNumbers: string[]
    deepLinkUrl: string | null
    trackingNumber: string | null
    carrier: string | null
  } | null
  wmsOrderPush: { state: string; lastError: string | null } | null
}): SoRow {
  const totalBase = Number(so.totalBase)
  const lineCogs = so.lines.map((l) => l.cogsBase != null ? Number(l.cogsBase) : null)
  const hasAnyCogs = lineCogs.some((c) => c !== null)
  const cogsBase = hasAnyCogs ? lineCogs.reduce((s: number, c) => s + (c ?? 0), 0) : null
  const profitMarginPercent = cogsBase != null && totalBase > 0
    ? ((totalBase - cogsBase) / totalBase) * 100
    : null
  const externalLink = so.shoppingLinks[0] ?? null
  const hasExternalSource = !!externalLink
  const wms = so.wmsOrderStatus
  return {
    id: so.id,
    wmsPush: so.wmsOrderPush ? { state: so.wmsOrderPush.state, lastError: so.wmsOrderPush.lastError } : null,
    wmsStatus: wms
      ? {
          connectorLabel: wms.connectorLabel,
          externalOrderId: wms.externalOrderId,
          externalOrderNumber: wms.externalOrderNumber,
          status: wms.status,
          statusLabel: wms.statusLabel,
          isSplit: wms.isSplit,
          partCount: wms.partCount,
          isMerged: wms.isMerged,
          mergedOrderNumbers: wms.mergedOrderNumbers,
          deepLinkUrl: wms.deepLinkUrl,
          tracking: wms.trackingNumber || wms.carrier
            ? [{ trackingNumber: wms.trackingNumber, carrier: wms.carrier, despatchedAt: null }]
            : [],
        }
      : null,
    externalOrderId: externalLink?.externalOrderId ?? null,
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
  product?: { imageUrl: string | null; type?: ProductType; oversellAllowed?: boolean; parent?: { imageUrl: string | null } | null } | null
}): SoLineRow {
  return {
    id: l.id,
    productId: l.productId,
    sku: l.sku ?? '',
    imageUrl: l.product?.imageUrl ?? l.product?.parent?.imageUrl ?? null,
    description: l.description,
    productType: l.product?.type ?? null,
    oversellAllowed: l.product?.oversellAllowed ?? false,
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
  const [orders, pluginState] = await Promise.all([
    db.salesOrder.findMany({
      where,
      select: SO_SELECT,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    getIntegrationPluginState(),
  ])
  const activeWmsConnector = WMS_CONNECTOR_IDS.find((id) => pluginState[id]) ?? null
  return orders.map((order) => {
    const row = mapSoRow(order)
    // Only surface a cached chip from the currently-active WMS connector, so
    // disabling/switching the connector clears stale chips (matching the live
    // detail view, which returns null when no WMS connector is enabled).
    if (row.wmsStatus && order.wmsOrderStatus?.connector !== activeWmsConnector) {
      row.wmsStatus = null
    }
    return row
  })
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
          product: { select: { imageUrl: true, type: true, oversellAllowed: true, parent: { select: { imageUrl: true } } } },
        },
      },
      refunds: {
        select: {
          id: true, creditNoteNumber: true, reason: true, totalForeign: true, totalBase: true, refundedAt: true,
          accountingRetryRequired: true,
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
      accountingRetryRequired: r.accountingRetryRequired,
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
    const externalOrderNumber = input.externalOrderNumber?.trim() || null
    if (externalOrderNumber) {
      const existing = await db.salesOrder.findFirst({
        where: { externalOrderNumber },
        select: { id: true },
      })
      if (existing) return { success: false, error: `Order ${externalOrderNumber} already exists` }
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
    let linesSubtotalForeign = toDecimal(0) // sum of line NETs, before order discount
    let linesSubtotalBase = toDecimal(0)
    let totalTaxForeign = toDecimal(0)
    let totalTaxBase = toDecimal(0)

    const round4 = (value: DecimalInput) => roundDecimalNumber(value, 4)

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
          select: taxRateProfileSelect,
        })
      : []
    const overrideById = new Map(overrideRows.map((r) => [r.id, r]))

    const lineResolved: ResolvedTaxRate[] = input.lines.map((l, idx) => {
      if (l.taxRateId) {
        const row = overrideById.get(l.taxRateId)
        if (row) {
          return resolvedTaxRateFromProfile(row, 'exact')
        }
      }
      return (
        resolvedMap.get(String(idx)) ?? {
          taxRateId: orderDefaultCtx.id,
          taxRateName: orderDefaultCtx.name,
          taxRateValue: orderDefaultCtx.rate,
          accountingTaxType: orderDefaultCtx.accountingTaxType,
          isCompound: orderDefaultCtx.isCompound,
          reverseCharge: orderDefaultCtx.reverseCharge,
          reportingCategory: orderDefaultCtx.reportingCategory,
          components: orderDefaultCtx.components,
          matched: 'fallback',
          warning: null,
        }
      )
    })

    const taxValidation = validateSalesOrderLineTaxInputs(
      input.lines.map((line, idx) => ({
        sku: line.sku,
        qty: line.qty,
        unitPriceForeign: line.unitPriceForeign,
        discountAmount: line.discountAmount ?? 0,
        taxRateValue: lineResolved[idx]?.taxRateValue ?? 0,
        taxForeign: line.taxForeign ?? null,
      })),
      inclVat,
    )
    if (!taxValidation.success) return { success: false, error: taxValidation.error }

    const lineData = input.lines.map((l, idx) => {
      const resolved = lineResolved[idx]
      const lineRate = resolved.taxRateValue
      const lineInclVat = inclVat && lineRate > 0
      const discAmt = l.discountAmount ?? 0 // in gross if inclVat, else net
      const lineGross = toDecimal(l.qty).mul(l.unitPriceForeign).sub(discAmt)
      const netForeign = lineInclVat ? lineGross.div(toDecimal(1).add(lineRate)) : lineGross
      const unitPriceBase = divideRoundedNumber(l.unitPriceForeign, fxRate, 6)
      const totalForeign = round4(netForeign)
      const totalBase = divideRoundedNumber(totalForeign, fxRate, 4)
      const lineTax = expectedSalesOrderLineTaxForeign({
        sku: l.sku,
        qty: l.qty,
        unitPriceForeign: l.unitPriceForeign,
        discountAmount: discAmt,
        taxRateValue: lineRate,
        taxForeign: l.taxForeign ?? null,
      }, inclVat)
      const lineTaxForeign = round4(lineTax)
      const lineTaxBase = divideRoundedNumber(lineTaxForeign, fxRate, 4)
      linesSubtotalForeign = linesSubtotalForeign.add(totalForeign)
      linesSubtotalBase = linesSubtotalBase.add(totalBase)
      totalTaxForeign = totalTaxForeign.add(lineTaxForeign)
      totalTaxBase = totalTaxBase.add(lineTaxBase)
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
    let feesTotalForeign = toDecimal(0)
    if (input.fees?.length) for (const f of input.fees) feesTotalForeign = feesTotalForeign.add(f.amount)
    const totalShippingInput = toDecimal(shippingInput).add(feesTotalForeign)
    const shippingNetForeign = shippingInclVat ? totalShippingInput.div(toDecimal(1).add(vatRate)) : totalShippingInput
    const shippingTaxForeign = shippingInclVat
      ? totalShippingInput.sub(shippingNetForeign)
      : (vatRate > 0 ? shippingNetForeign.mul(vatRate) : toDecimal(0))
    const shippingNetForeignR = round4(shippingNetForeign)
    const shippingTaxForeignR = round4(shippingTaxForeign)
    const shippingNetBase = divideRoundedNumber(shippingNetForeignR, fxRate, 4)
    const shippingTaxBase = divideRoundedNumber(shippingTaxForeignR, fxRate, 4)
    totalTaxForeign = totalTaxForeign.add(shippingTaxForeignR)
    totalTaxBase = totalTaxBase.add(shippingTaxBase)

    // Order-level discount — cap at line subtotal (compare in gross when inclVat).
    const rawOrderDisc = input.orderDiscountForeign ?? 0
    const linesGrossForCap = shippingInclVat
      ? toDecimal(linesSubtotalForeign).mul(toDecimal(1).add(vatRate))
      : toDecimal(linesSubtotalForeign)
    const orderDiscForeign = Prisma.Decimal.min(toDecimal(rawOrderDisc), linesGrossForCap)
    const discNetForeign = shippingInclVat ? orderDiscForeign.div(toDecimal(1).add(vatRate)) : orderDiscForeign
    const discTaxForeign = shippingInclVat ? orderDiscForeign.sub(discNetForeign) : (vatRate > 0 ? discNetForeign.mul(vatRate) : toDecimal(0))
    const discNetForeignR = round4(discNetForeign)
    const discTaxForeignR = round4(discTaxForeign)
    const discNetBase = divideRoundedNumber(discNetForeignR, fxRate, 4)
    const discTaxBase = divideRoundedNumber(discTaxForeignR, fxRate, 4)
    totalTaxForeign = totalTaxForeign.sub(discTaxForeignR)
    totalTaxBase = totalTaxBase.sub(discTaxBase)

    // Subtotal stored PRE-discount (sum of line nets) — matches the WC
    // importer convention so display / accounting code can handle both
    // sources uniformly.
    const subtotalForeign = round4(linesSubtotalForeign)
    const subtotalBase = round4(linesSubtotalBase)
    const totalTaxForeignRounded = round4(totalTaxForeign)
    const totalTaxBaseRounded = round4(totalTaxBase)

    // Grand total = subtotal (net, pre-discount) − net discount + net
    // shipping + total tax. Tax already nets the discount VAT above.
    const grandTotalForeign = round4(toDecimal(subtotalForeign).sub(discNetForeignR).add(shippingNetForeignR).add(totalTaxForeignRounded))
    const grandTotalBase = round4(toDecimal(subtotalBase).sub(discNetBase).add(shippingNetBase).add(totalTaxBaseRounded))

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
    const so = await db.$transaction(async (tx) => {
      if (externalOrderNumber) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales_orders.external_order_number:${externalOrderNumber}`}))`
        const existing = await tx.salesOrder.findFirst({
          where: { externalOrderNumber },
          select: { id: true },
        })
        if (existing) throw new Error(`Order ${externalOrderNumber} already exists`)
      }

      return tx.salesOrder.create({
        data: {
          externalOrderNumber,
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
          taxForeign: totalTaxForeignRounded,
          pricesIncludeVat: inclVat,
          totalForeign: grandTotalForeign,
          subtotalBase,
          shippingBase: totalShippingBase,
          taxBase: totalTaxBaseRounded,
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
    }, STOCK_TX_OPTIONS)

    for (const warning of taxValidation.warnings ?? []) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'sales_order_line_tax_assertion_missing',
        tag: 'sales',
        level: 'WARNING',
        description: `Sales order ${getSalesOrderReference(so)} line ${warning.sku} omitted caller tax assertion`,
        metadata: {
          sku: warning.sku,
          expectedTaxForeign: warning.expectedTaxForeign,
          pricesIncludeVat: inclVat,
          currency: input.currency,
        },
      })
    }

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
      } catch (accountingError) {
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: so.id,
          action: 'sales_invoice_accounting_queue_failed',
          tag: 'accounting',
          level: 'WARNING',
          description: `Failed to queue sales invoice for order ${getSalesOrderReference(so)} after creation`,
          metadata: {
            orderNumber: getSalesOrderReference(so),
            errorName: accountingError instanceof Error ? accountingError.name : typeof accountingError,
          },
        })
      }
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
 * Safe to call multiple times. Once the connector has returned an external
 * invoice id, IMS cannot mutate that accounting document through this create
 * queue; attempts are logged so post-push changes are not silently dropped.
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
    },
  })
  if (!so) return
  const settings = await getAccountingSettings()
  if (!settings.syncEnabled) return
  const multiComponentRateNames = multiComponentTaxRateNames(so.lines)
  if (multiComponentRateNames.length > 0) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'sales_invoice_tax_components_not_pushed',
      tag: 'accounting',
      level: 'WARNING',
      description: `Multi-component tax rates on this order will post to the accounting system as a single TaxType: ${multiComponentRateNames.join(', ')}. Configure the equivalent TaxComponents on the accounting side or the per-component breakdown will not appear on the VAT return.`,
      metadata: { taxRateNames: multiComponentRateNames },
    })
  }

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
    ? roundDecimalNumber(toDecimal(shippingNetForeign).mul(toDecimal(1).add(vatPct)), 4)
    : shippingNetForeign

  // `discountAmount` is stored in the same inclusive/exclusive convention as
  // the order (matching WC import), so it can be passed through directly.
  const discountForeign = roundDecimalNumber(so.discountAmount ?? 0, 2)

  const payload = {
    invoiceNumber: `${manualPrefix}${orderNumber}`,
    contactName: so.customerName ?? 'Unknown',
    contactEmail: so.customerEmail ?? undefined,
    date: new Date().toISOString().slice(0, 10),
    currency: so.currency,
    // Stamp IMS's FX rate on the document so Xero/QuickBooks don't apply
    // their own daily rate (which causes 1-3 % drift on multi-currency
    // invoices). Connector adapter inverts to the platform's convention.
    currencyRateToBase: Number(so.fxRateToBase) || undefined,
    reference: orderNumber,
    lines: so.lines.map((l) => {
      const qty = Number(l.qty)
      const discForeign = Number(l.discountAmount ?? 0)
      // Reverse-charge B2B: customer self-accounts, so we swap to the
      // configured reverse-charge accounting tax type (shared helper, same
      // logic as the credit-note path — see resolveSalesLineTaxType).
      const taxType = resolveSalesLineTaxType({
        baseTaxType: l.taxRate?.accountingTaxType ?? orderDefaultTaxType,
        reverseCharge: l.taxRate?.reverseCharge,
        reverseChargeSalesTaxType: settings.reverseChargeSalesTaxType,
      })
      return {
        itemCode: l.sku ?? undefined,
        description: l.description ?? l.sku ?? 'Item',
        quantity: qty,
        unitAmount: Number(l.unitPriceForeign),
        accountCode: settings.salesAccount,
        taxType,
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
  }

  if (so.accountingInvoiceId) {
    const updatePayload = {
      ...payload,
      accountingInvoiceId: so.accountingInvoiceId,
    }
    const idempotencyKey = accountingPayloadKey(`sales-invoice-update:${so.id}:${so.accountingInvoiceId}`, updatePayload)
    const { queueXeroSync } = await import('@/lib/connectors/xero/queue')
    const { getActiveAccountingConnectorInfo, isAccountingSyncTypeEnabled } = await import('@/lib/accounting')
    await queueSalesInvoiceUpdateForExistingAccountingInvoice({
      salesOrderId: so.id,
      orderNumber,
      accountingInvoiceId: so.accountingInvoiceId,
      payload: updatePayload,
      idempotencyKey,
    }, {
      getActiveAccountingConnectorInfo,
      isAccountingSyncTypeEnabled,
      queueXeroSync,
      logActivity,
    })
    return
  }

  await queueAccountingSync({
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: so.id,
    payload,
    idempotencyKey: accountingPayloadKey(`sales-invoice:${so.id}`, payload),
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
  options?: { pushStatusToWooCommerce?: boolean; internalBypassToken?: symbol; skipPermissionCheck?: boolean },
): Promise<{ success: boolean; error?: string }> {
  try {
    // internalBypassToken skips BOTH the permission check and the state-machine
    // guard — used by external systems (WooCommerce) that may legitimately force
    // a mapped status. skipPermissionCheck is narrower: it skips ONLY the
    // permission check (for sessionless internal callers such as the delivery
    // cron) while the state-machine guard still runs, so a stale transition
    // (e.g. an order cancelled after the poll's SHIPPED query) is still rejected.
    const bypassPermission = options?.internalBypassToken === INTERNAL_STATUS_TRANSITION_BYPASS
    if (!bypassPermission && !options?.skipPermissionCheck) {
      await requirePermission('sales.process')
    }
    const so = await db.salesOrder.findUnique({
      where: { id },
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        status: true,
        archived: true,
        shipFromWarehouseId: true,
        // audit-s3en/45kd: detect a paid (full or partial), uninvoiced order being cancelled.
        paidAt: true,
        invoiceNumber: true,
        currency: true,
        // b8i6.1: detect a shopping order via ANY connector (not just WooCommerce)
        // so a Shopify-linked order also gets its IMS status pushed back.
        shoppingLinks: { select: { id: true }, take: 1 },
        lines: { select: { id: true, productId: true, sku: true, qty: true } },
      },
    })
    if (!so) return { success: false, error: 'Order not found' }
    // audit-M-o2c: an archived order is filed away — block MANUAL status edits.
    // Automated data-pushes still apply: the WooCommerce force-sync
    // (internalBypassToken) and the sessionless delivery cron (skipPermissionCheck)
    // are carrier/source-of-truth signals, so they bypass this guard — otherwise an
    // archived-but-shipped order could never auto-reach DELIVERED.
    if (so.archived && !bypassPermission && !options?.skipPermissionCheck) {
      return { success: false, error: 'This order is archived; unarchive it before changing its status.' }
    }

    const transition = validateManualSalesOrderStatusTransition(so.status, targetStatus, {
      bypass: bypassPermission,
    })
    if (!transition.success) {
      return { success: false, error: transition.error }
    }

    const data: Record<string, unknown> = { status: targetStatus }
    let orderUpdated = false
    let previousStatusForLog: string = so.status

    // On SHIPPED: orders must already have shipment rows, and all of them must
    // be shipped through the shipment workflow. The counts are checked again
    // under the order lock before the status update below.
    if (targetStatus === 'SHIPPED') {
      data.shippedAt = new Date()
      if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
    }

    const isDraftFinalization = so.status === 'DRAFT' && targetStatus !== 'CANCELLED' && targetStatus !== 'DRAFT'

    // On CANCEL: release all allocations
    if (targetStatus === 'CANCELLED') {
      const cancellation = await db.$transaction(async (tx) => (
        cancelSalesOrderFulfillmentState(tx, { orderId: id, data, bypass: bypassPermission })
      ), STOCK_TX_OPTIONS)
      previousStatusForLog = cancellation.previousStatus
      if (cancellation.deletedShipmentCount > 0) {
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: id,
          action: 'pending_shipments_deleted',
          tag: 'sales',
          level: 'INFO',
          description: `Deleted ${cancellation.deletedShipmentCount} pending shipment(s) while cancelling order ${getSalesOrderReference(so)}`,
          metadata: {
            orderNumber: getSalesOrderReference(so),
            deletedShipments: cancellation.deletedShipmentCount,
            releasedAllocations: cancellation.releasedAllocationCount,
            releasedReservationScopes: cancellation.releasedReservationScopes,
          },
        })
      }
      // audit-s3en/45kd: a paid order (fully OR partially) with no invoice that is
      // cancelled will never auto-generate one (on_shipped generates at dispatch,
      // which no longer happens) — leaving settled customer money with no invoice
      // and, for on_shipped, no prior warning (H2 suppressed it at payment).
      // Surface the gap so finance reverses/refunds the receivable. Sum settled
      // customer payments (refundId null) so partial prepayments aren't dropped.
      const settledPaymentAgg = await db.payment.aggregate({
        where: { orderId: id, refundId: null },
        _sum: { amount: true },
      })
      const settledPaymentTotal = Number(settledPaymentAgg._sum.amount ?? 0)
      const isFullyPaid = so.paidAt !== null
      const hasSettledPayment = isFullyPaid || settledPaymentTotal > 0
      if (shouldWarnPaidOrderCancelledWithoutInvoice({ hasSettledPayment, hasInvoiceNumber: Boolean(so.invoiceNumber) })) {
        const paidDescriptor = isFullyPaid
          ? 'was fully paid'
          : `was partially paid (${so.currency} ${settledPaymentTotal.toFixed(2)} received)`
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: id,
          action: 'paid_order_cancelled_without_invoice',
          tag: 'sales',
          level: 'WARNING',
          description: `Cancelled order ${getSalesOrderReference(so)} ${paidDescriptor} but has no invoice — no invoice will auto-generate now. Reverse/refund the receivable to keep the GL in sync.`,
          metadata: { orderNumber: getSalesOrderReference(so), previousStatus: cancellation.previousStatus, fullyPaid: isFullyPaid, settledPaymentTotal },
        })
      }
      orderUpdated = true
    }

    if (isDraftFinalization) {
      await refreshDraftOrderFxAtFinalization(id, new Date())
    }

    if (!orderUpdated) {
      const transitionResult = await db.$transaction(async (tx) => {
        return updateSalesOrderStatusUnderLock(tx, {
          orderId: id,
          targetStatus,
          data,
          bypass: bypassPermission,
          beforeUpdate: async ({ tx: lockedTx }) => {
            if (targetStatus === 'PICKING') {
              const allocCount = await lockedTx.orderAllocation.count({ where: { orderId: id } })
              if (allocCount === 0) {
                throw new Error('Cannot start picking — no products have been allocated. Allocate stock first.')
              }
              return
            }
            if (targetStatus === 'SHIPPED') {
              const shipmentCount = await lockedTx.shipment.count({ where: { orderId: id } })
              if (shipmentCount === 0) {
                throw new Error('Shipments are required before an order can be marked as shipped')
              }
              const unshipped = await lockedTx.shipment.count({ where: { orderId: id, status: { not: 'SHIPPED' } } })
              if (unshipped > 0) {
                throw new Error('Ship individual shipments first — not all shipments are shipped yet')
              }
            }
          },
        })
      }, STOCK_TX_OPTIONS)
      previousStatusForLog = transitionResult.previousStatus
      orderUpdated = true
    }

    // Draft finalisation: when a DRAFT is moved to any non-cancelled status,
    // allocate stock and queue the sales invoice for accounting sync.
    if (isDraftFinalization) {
      const { autoAllocateOrder, deallocateOrder } = await import('./allocation')
      const allocation = await autoAllocateOrder(id)
      if (!allocation.success) {
        if ((allocation.allocationCount ?? 0) > 0) {
          await deallocateOrder(id)
        }
        await db.salesOrder.update({ where: { id }, data: { status: 'DRAFT' } })
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: id,
          action: 'draft_finalization_allocation_failed',
          tag: 'sales',
          level: 'WARNING',
          description: `Reverted finalizing order ${getSalesOrderReference(so)} because stock allocation failed: ${allocation.error ?? 'unknown allocation error'}`,
          metadata: { orderNumber: getSalesOrderReference(so), targetStatus, error: allocation.error ?? null },
        })
        return { success: false, error: allocation.error ?? 'Could not allocate stock for this order' }
      }
      try {
        await queueSalesInvoiceForOrder(id)
      } catch (accountingError) {
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: id,
          action: 'draft_finalization_accounting_queue_failed',
          tag: 'accounting',
          level: 'WARNING',
          description: `Failed to queue sales invoice for order ${getSalesOrderReference(so)} after status change`,
          metadata: {
            orderNumber: getSalesOrderReference(so),
            targetStatus,
            errorName: accountingError instanceof Error ? accountingError.name : typeof accountingError,
          },
        })
      }
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
      metadata: { orderNumber: statusOrderRef, previousStatus: previousStatusForLog, newStatus: targetStatus },
    })

    // Push status back to the order's shopping connector(s) (fire-and-forget).
    // b8i6.1: routed through the facade so it dispatches to the order's actual
    // connector (WooCommerce pushes; Shopify is skipped until it gains a push).
    if ((options?.pushStatusToWooCommerce ?? true) && so.shoppingLinks.length > 0) {
      pushSalesOrderStatus(id, targetStatus)
        .then((res) => {
          if (!res.success) throw new Error(res.error ?? 'unknown error')
        })
        .catch(async (syncError) => {
          await logActivity({
            entityType: 'SALES_ORDER',
            entityId: id,
            action: 'shopping_status_push_failed',
            tag: 'sync',
            level: 'WARNING',
            description: `Failed to push status ${targetStatus} for order ${getSalesOrderReference(so)} to shopping connector: ${syncError instanceof Error ? syncError.message : String(syncError)}`,
            metadata: { orderNumber: getSalesOrderReference(so), targetStatus, error: String(syncError) },
          })
        })
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
    const errorMessage = e instanceof Error ? e.message : String(e)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'status_changed',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to update sales order status: ${errorMessage}`,
      metadata: null,
    })
    return { success: false, error: errorMessage }
  }
}

function formatRefundAccountingQueueError(error: unknown): string {
  return `Refund was created, but accounting queueing failed: ${error instanceof Error ? error.message : String(error)}`
}

async function markRefundAccountingRetryRequired(
  refundId: string,
  warning: string,
): Promise<void> {
  await db.salesOrderRefund.update({
    where: { id: refundId },
    data: {
      accountingRetryRequired: true,
      accountingWarning: warning,
    },
  })
}

async function clearRefundAccountingRetryState(refundId: string): Promise<void> {
  await db.salesOrderRefund.update({
    where: { id: refundId },
    data: {
      accountingRetryRequired: false,
      accountingWarning: null,
      accountingRetrySyncs: Prisma.DbNull,
    },
  })
}

async function queueRefundAccountingActions(input: {
  orderId: string
  refundId: string
  creditNoteNumber: string | null
  refundFxRate: number
  externalOrderNumber: string | null
  lines: CreatedRefundLine[]
  accountingSyncs: RefundAccountingSyncRequest[]
  accountingSettings?: AccountingSettings
}): Promise<void> {
  const [settings, orderForCN, baseCurrency] = await Promise.all([
    input.accountingSettings ? Promise.resolve(input.accountingSettings) : getAccountingSettings(),
    db.salesOrder.findUnique({
      where: { id: input.orderId },
      select: {
        customer: { select: { firstName: true, lastName: true, email: true } },
        currency: true,
        taxRateName: true,
        lines: {
          select: {
            id: true,
            taxRate: { select: { accountingTaxType: true, reverseCharge: true } },
          },
        },
      },
    }),
    getBaseCurrencyCode(),
  ])
  const cnContactName = orderForCN?.customer
    ? `${orderForCN.customer.firstName} ${orderForCN.customer.lastName}`.trim()
    : 'Walk-in Customer'
  const cnTaxRate = orderForCN?.taxRateName
    ? await db.taxRate.findFirst({
        where: { name: orderForCN.taxRateName, active: true },
        select: { accountingTaxType: true },
      })
    : null
  // Credit-note PRODUCT lines must apply the SAME per-line reverse-charge swap
  // the original invoice did (audit H1), keyed on each sales line's own
  // TaxRate.reverseCharge — or a refund of a reverse-charged sale posts under
  // the standard code and the VAT return no longer balances.
  const taxTypeBySalesLineId = new Map(
    (orderForCN?.lines ?? []).map((line) => [
      line.id,
      resolveSalesLineTaxType({
        baseTaxType: line.taxRate?.accountingTaxType,
        reverseCharge: line.taxRate?.reverseCharge,
        reverseChargeSalesTaxType: settings.reverseChargeSalesTaxType,
      }),
    ]),
  )
  // Fallback for refund lines with no mapped sales line (shipping, ad-hoc):
  // the order-level tax type WITHOUT the swap, mirroring exactly how the
  // invoice posts its shipping/discount lines (shippingTaxType =
  // orderDefaultTaxType, no swap). Swapping here would post credit-note
  // shipping under the reverse-charge code while the invoice posted it under
  // the standard code — an asymmetry the VAT return would flag.
  const fallbackCnTaxType = cnTaxRate?.accountingTaxType ?? undefined

  await queueAccountingSync({
    type: 'CREDIT_NOTE',
    referenceType: 'SalesOrderRefund',
    referenceId: input.refundId,
    idempotencyKey: `sales-order-refund:${input.refundId}:credit-note`,
    payload: {
      creditNoteNumber: input.creditNoteNumber ?? undefined,
      contactName: cnContactName,
      contactEmail: orderForCN?.customer?.email ?? undefined,
      date: new Date().toISOString().slice(0, 10),
      currency: orderForCN?.currency ?? baseCurrency,
      reference: input.externalOrderNumber ?? undefined,
      lines: input.lines.map((line) => ({
        description: line.description || 'Refund line',
        quantity: line.qty > 0 ? line.qty : 1,
        unitAmount: orderForCN?.currency === baseCurrency
          ? (line.qty > 0 ? line.unitPriceBase : line.totalBase)
          : (line.qty > 0 ? line.unitPriceForeign : line.totalForeign),
        accountCode: line.lineKind === 'shipping'
          ? (settings.shippingAccount || settings.salesAccount)
          : line.lineKind === 'discount'
            ? (settings.discountAccount || settings.salesAccount)
            : settings.salesAccount,
        taxType: (line.lineId ? taxTypeBySalesLineId.get(line.lineId) : undefined) ?? fallbackCnTaxType,
      })),
      lineAmountsIncludeTax: false,
      currencyRateToBase: Number(input.refundFxRate) || undefined,
    },
  })

  for (const sync of input.accountingSyncs) {
    if (sync.type === 'COGS_REVERSAL') {
      // bcz9.4: queue the COGS_REVERSAL journal and record its COGS subledger row in
      // ONE transaction. Recording at queue time (not at refund staging) guarantees the
      // negative ledger row exists only once the GL reversal is durably queued, so the
      // daily-batch COGS reconciliation can't sweep a not-yet-queued reversal as rounding
      // and then double-count it when a retry posts the real journal (Codex PR #353 F5).
      // Idempotent on the sync key, so initial + retry record exactly once.
      await db.$transaction(async (tx) => {
        // Record based on the queue's OWN decision (not a separate settings recheck) so
        // a connector/setting flip between the two can't desync queue vs ledger (Codex).
        const queued = await queueAccountingSyncTx(tx, sync)
        await recordRefundCogsReversalFromSync(tx, sync, queued)
      })
    } else {
      await queueAccountingSync(sync)
    }
  }
}

async function loadRefundAccountingQueueInput(
  refundId: string,
  accountingSyncs: RefundAccountingSyncRequest[],
): Promise<Parameters<typeof queueRefundAccountingActions>[0]> {
  const refund = await db.salesOrderRefund.findUnique({
    where: { id: refundId },
    select: {
      id: true,
      orderId: true,
      creditNoteNumber: true,
      order: {
        select: {
          fxRateToBase: true,
          externalOrderNumber: true,
        },
      },
      lines: {
        select: {
          id: true,
          salesOrderLineId: true,
          productId: true,
          description: true,
          qty: true,
          unitPriceForeign: true,
          unitPriceBase: true,
          totalForeign: true,
          totalBase: true,
        },
      },
    },
  })
  if (!refund) throw new Error('Refund not found')

  return {
    orderId: refund.orderId,
    refundId: refund.id,
    creditNoteNumber: refund.creditNoteNumber,
    refundFxRate: decimalToNumber(refund.order.fxRateToBase) || 1,
    externalOrderNumber: refund.order.externalOrderNumber,
    lines: refund.lines.map((line) => ({
      id: line.id,
      lineId: line.salesOrderLineId,
      productId: line.productId,
      description: line.description,
      qty: decimalToNumber(line.qty),
      unitPriceForeign: decimalToNumber(line.unitPriceForeign),
      unitPriceBase: decimalToNumber(line.unitPriceBase),
      totalForeign: decimalToNumber(line.totalForeign),
      totalBase: decimalToNumber(line.totalBase),
      // lineKind isn't persisted: a null-product line is shipping, UNLESS its total is
      // negative — that's the mirrored order-discount line, which must reload as
      // 'discount' so an accounting RETRY re-posts it to the discount account (not
      // shipping). Matches the replay reconstruction in refund-service.
      lineKind: line.productId
        ? 'sale'
        : (decimalToNumber(line.totalBase) < 0 ? 'discount' : 'shipping'),
    })),
    accountingSyncs,
  }
}

async function loadRefundAuditContext(
  refundId: string,
): Promise<{ orderId: string; refundOrderRef: string } | null> {
  const refund = await db.salesOrderRefund.findUnique({
    where: { id: refundId },
    select: {
      orderId: true,
      order: {
        select: {
          id: true,
          externalOrderNumber: true,
          orderNumber: true,
        },
      },
    },
  })
  if (!refund) return null
  return {
    orderId: refund.orderId,
    refundOrderRef: getSalesOrderReference(refund.order),
  }
}

export async function createRefund(
  orderId: string,
  lines: RefundRequestLine[],
  reason: string,
  returnWarehouseId?: string,
  options?: { internalBypassToken?: symbol; externalRefundId?: number; chargeback?: boolean },
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    if (options?.internalBypassToken !== INTERNAL_ACTION_BYPASS) {
      await requirePermission('sales.refund')
    }

    const { getNumberingFormats } = await import('./company')
    const [numbering, accountingSettings] = await Promise.all([
      // scjz.71: internal callers (the payment-poller chargeback) have no session, so
      // pass the bypass through to skip getNumberingFormats' requireAuth (NEXT_REDIRECT).
      getNumberingFormats(options?.internalBypassToken ? { internalBypassToken: options.internalBypassToken } : undefined),
      getAccountingSettings().catch(() => null),
    ])

    const refundResult = await createSalesOrderRefund(db, {
      orderId,
      lines,
      reason,
      returnWarehouseId,
      externalRefundId: options?.externalRefundId,
      creditNotePrefix: numbering.cn_prefix,
      accountingSettings,
      // scjz.70: revenue-only chargeback (credit note reverses recognised revenue,
      // COGS + restock suppressed). Used by the payment-poller on a payment reversal.
      chargeback: options?.chargeback,
      activeAccountingConnector: (await getActiveAccountingConnectorInfo())?.id,
    })
    if (!refundResult.success) return refundResult

    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'refunded',
      tag: 'sales',
      level: 'INFO',
      description: `Created refund for order ${refundResult.refundOrderRef} — £${refundResult.totalBase.toFixed(2)}`,
      metadata: {
        orderNumber: refundResult.refundOrderRef,
        totalBase: refundResult.totalBase,
        creditNoteNumber: refundResult.creditNoteNumber,
        reason,
      },
    })
    if (refundResult.accountingWarning) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'refund_accounting_warning',
        tag: 'accounting',
        level: 'WARNING',
        description: refundResult.accountingWarning,
        metadata: {
          orderNumber: refundResult.refundOrderRef,
          refundId: refundResult.createdRefund.id,
          creditNoteNumber: refundResult.creditNoteNumber,
        },
      })
    }

    let accountingWarning = refundResult.accountingWarning
    try {
      await queueRefundAccountingActions({
        orderId,
        refundId: refundResult.createdRefund.id,
        creditNoteNumber: refundResult.creditNoteNumber,
        refundFxRate: refundResult.refundFxRate,
        externalOrderNumber: refundResult.so.externalOrderNumber,
        lines: refundResult.createdRefundLines,
        accountingSyncs: refundResult.accountingSyncs,
        accountingSettings: accountingSettings ?? undefined,
      })
    } catch (queueError) {
      const queueWarning = formatRefundAccountingQueueError(queueError)
      accountingWarning = accountingWarning ? `${accountingWarning}; ${queueWarning}` : queueWarning
      await markRefundAccountingRetryRequired(refundResult.createdRefund.id, accountingWarning)
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'refund_accounting_warning',
        tag: 'accounting',
        level: 'WARNING',
        description: queueWarning,
        metadata: {
          orderNumber: refundResult.refundOrderRef,
          refundId: refundResult.createdRefund.id,
          creditNoteNumber: refundResult.creditNoteNumber,
        },
      })
    }

    if (!accountingWarning) {
      await clearRefundAccountingRetryState(refundResult.createdRefund.id)
    }

    if (returnWarehouseId && refundResult.returnedRows.length > 0) {
      for (const row of refundResult.returnedRows) {
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: row.productId,
          action: 'return_inbound',
          tag: 'stock',
          level: 'INFO',
          description: `Returned ${row.qty} units of SKU ${row.sku} to warehouse ${returnWarehouseId} for refund on order ${refundResult.refundOrderRef}`,
          metadata: { productId: row.productId, qty: row.qty, orderNumber: refundResult.refundOrderRef, warehouseId: returnWarehouseId },
        })
      }

      const uniqueReturnedIds = [...new Set(refundResult.returnedRows.map((row) => row.productId))]
      try {
        const { allocateBackordersForProducts } = await import('@/lib/fulfillment/backorder-allocator')
        await allocateBackordersForProducts(uniqueReturnedIds, {
          source: 'customer_return',
          referenceId: orderId,
          referenceLabel: `customer return on order ${refundResult.refundOrderRef}`,
        })
      } catch (allocError) {
        console.error(allocError)
      }
      try {
        await enqueueStockSync(uniqueReturnedIds, 'IMS_CHANGE')
      } catch (syncError) {
        console.error(syncError)
      }
    }

    return { success: true, warning: accountingWarning }
  } catch (e) {
    if (options?.externalRefundId && isExternalRefundIdUniqueConflict(e)) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'refund_create_deduped',
        tag: 'sales',
        level: 'INFO',
        description: `Refund creation deduped on external refund id ${options.externalRefundId}`,
        metadata: { externalRefundId: options.externalRefundId },
        resolveUser: false,
      })
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

/**
 * scjz.71: raise a revenue-only chargeback for an order whose payment was reversed
 * (detected by the payment-poller). Idempotent — at most one chargeback per order;
 * a second call (e.g. a later poll) is a no-op. Builds the full remaining-order
 * refund lines + shipping and runs the chargeback path (credit note reverses
 * recognised revenue against AR; COGS kept as a loss; no restock). Internal/cron
 * context, so it bypasses the interactive permission check.
 */
export async function raiseChargebackForReversedOrder(
  orderId: string,
  options?: { internalBypassToken?: symbol },
): Promise<{ raised: boolean; reason?: string; error?: string }> {
  // SECURITY: this is a privileged path — it calls createRefund with
  // INTERNAL_ACTION_BYPASS, skipping the sales.refund permission. As an export of a
  // 'use server' module it is reachable as a Server Function via direct POST, so it
  // must gate itself exactly like createRefund: the in-process payment-poller passes
  // the unforgeable symbol token; any network caller (which cannot transmit a JS
  // symbol over the RPC boundary) falls through to the sales.refund permission check.
  if (options?.internalBypassToken !== INTERNAL_ACTION_BYPASS) {
    await requirePermission('sales.refund')
  }
  // Idempotency: one chargeback per order. A prior chargeback means the refund row
  // already exists (avoids duplicate credit notes). BUT if that chargeback's
  // accounting (credit-note / reversal staging) hasn't completed yet
  // (accountingRetryRequired), the financial reversal is NOT done — surface an error
  // so the payment poller holds paidAt and re-surfaces the failure instead of
  // clearing payment state on an incomplete reversal. The refund-accounting retry
  // sweep re-queues the credit note; once it succeeds the flag clears and a later
  // poll returns the benign "already exists".
  const existingChargeback = await db.salesOrderRefund.findFirst({
    where: { orderId, chargeback: true },
    select: { id: true, accountingRetryRequired: true },
  })
  if (existingChargeback) {
    if (existingChargeback.accountingRetryRequired) {
      return { raised: false, error: 'chargeback exists but its accounting reversal is still pending retry' }
    }
    return { raised: false, reason: 'chargeback already exists' }
  }

  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      shippingBase: true,
      totalBase: true,
      taxBase: true,
      discountAmount: true,
      fxRateToBase: true,
      pricesIncludeVat: true,
      taxRatePercent: true,
      orderNumber: true,
      externalOrderNumber: true,
      lines: { select: { id: true, productId: true, description: true, qty: true, totalBase: true } },
      shipments: { select: { status: true, shipmentJournalDate: true } },
      refunds: { select: { id: true } },
    },
  })
  if (!order) return { raised: false, error: 'Order not found' }

  // Codex P2: a chargeback marks the order REFUNDED and keeps the dispatched-stock
  // COGS as a loss (no reversal). That is only correct once the dispatch has been
  // journaled by the Group B daily batch — Group B EXCLUDES REFUNDED orders, so
  // charging back a shipped-but-unjournaled order would mean its COGS never posts at
  // all (and the allocation could be unwound as if the stock were still on hand).
  // Defer until every shipped shipment is journaled: surface an error so the poller
  // holds paidAt and re-attempts after the next Group B run posts the COGS.
  if (order.shipments.some((s) => s.status === 'SHIPPED' && s.shipmentJournalDate == null)) {
    return { raised: false, error: 'shipped quantity not yet journaled by the daily batch — deferring chargeback until COGS is posted' }
  }

  // A chargeback unwinds the WHOLE remaining order. Prior partial refunds make the
  // remaining balance ambiguous — amount-only/ad-hoc refunds aren't tied to a line, a
  // prior refund may have already reversed part of the discount/shipping, etc. — so the
  // auto-mirror can over- or under-credit. Safe-skip any previously-refunded order to
  // manual handling; the common chargeback case (payment reversal, no prior refund) is
  // fully covered.
  if (order.refunds.length > 0) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'chargeback_requires_manual_handling',
      tag: 'accounting',
      level: 'WARNING',
      description: `Payment reversed on order ${order.orderNumber ?? order.externalOrderNumber ?? orderId} that already has prior refunds — auto-chargeback skipped (remaining balance is ambiguous); raise the credit note manually.`,
      resolveUser: false,
    })
    return { raised: false, reason: 'order has prior refunds — manual chargeback required' }
  }

  // scjz.71: chargeback lines are NET (ex-tax) — they match the credit note's net
  // unitAmounts, and the credit note carries the order's per-line taxType
  // (lineAmountsIncludeTax: false) so Xero grosses them back up to reverse the full
  // tax-inclusive AR. createSalesOrderRefund compares the net refund total against the
  // net order total for chargebacks so a full taxable unwind reads as REFUNDED.
  // Taxable + non-taxable are both handled; non-taxable simply has taxBase 0.
  // An order-level discount is mirrored as a separate negative discount line below
  // (exactly as the invoice posted it), not spread across the goods.

  // scjz.71: order-level discount handling mirrors the invoice. The invoice posts the
  // discount as a SEPARATE negative line to settings.discountAccount only when that
  // account is configured (otherwise it posted no discount line — full goods). And a
  // discount combined with prior partial refunds makes the remaining discount basis
  // ambiguous. Safe-skip both edge cases to manual; otherwise pass the discount through
  // as its own mirrored line (in BASE currency = discountAmount / fxRateToBase).
  let discountInput: { totalBase: number } | undefined
  if (decimalToNumber(order.discountAmount) > 0) {
    const cbSettings = await getAccountingSettings().catch(() => null)
    // The invoice only posts a separate discount line when a discount account is
    // configured (otherwise it posted full goods, no discount line). Without one we
    // can't mirror it — safe-skip to manual. (Prior-refund orders were already skipped.)
    if (!cbSettings?.discountAccount) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'chargeback_requires_manual_handling',
        tag: 'accounting',
        level: 'WARNING',
        description: `Payment reversed on order ${order.orderNumber ?? order.externalOrderNumber ?? orderId} carrying an order-level discount but no discount account is configured — auto-chargeback skipped; raise the credit note manually.`,
        resolveUser: false,
      })
      return { raised: false, reason: 'order-level discount but no discount account — manual chargeback required' }
    }
    // Convert to the NET (ex-VAT) basis the credit note posts on (lineAmountsIncludeTax
    // is false). discountAmount is stored in the order's inclusive/exclusive convention,
    // so strip VAT when the order is tax-inclusive, then to base currency.
    const fxRate = decimalToNumber(order.fxRateToBase) || 1
    const vatPct = decimalToNumber(order.taxRatePercent)
    const discountForeignNet = order.pricesIncludeVat && vatPct > 0
      ? decimalToNumber(order.discountAmount) / (1 + vatPct)
      : decimalToNumber(order.discountAmount)
    discountInput = { totalBase: discountForeignNet / fxRate }
  }

  const lines = buildChargebackRefundLines({
    lines: order.lines.map((line) => ({
      lineId: line.id,
      productId: line.productId,
      description: line.description,
      qty: decimalToNumber(line.qty),
      totalBase: decimalToNumber(line.totalBase),
    })),
    shipping: { totalBase: decimalToNumber(order.shippingBase) },
    discount: discountInput,
  })
  if (lines.length === 0) return { raised: false, reason: 'nothing left to charge back' }

  const result = await createRefund(orderId, lines, 'Payment reversed (chargeback)', undefined, {
    internalBypassToken: INTERNAL_ACTION_BYPASS,
    chargeback: true,
  })
  // A surfaced accounting warning means the refund row was created but its
  // credit-note / reversal staging did not fully complete. Treat it as an error so
  // the payment poller logs the failure and leaves paidAt set, rather than silently
  // advancing as if the chargeback fully posted — the existing-chargeback pre-check
  // would otherwise block any further automatic attempt. The refund's
  // accountingRetryRequired flag still drives the refund-accounting retry sweep that
  // re-queues the failed credit note.
  if (result.warning) return { raised: false, error: result.warning }
  return { raised: result.success, error: result.error }
}

export async function retryRefundAccounting(
  refundId: string,
): Promise<{ success: boolean; error?: string }> {
  await requirePermission('sales.refund')

  try {
    const accountingSettings = await getAccountingSettings()
    const result = await retrySalesOrderRefundAccounting(db, {
      refundId,
      accountingSettings,
      activeAccountingConnector: (await getActiveAccountingConnectorInfo())?.id,
    })
    if (!result.success) {
      const auditContext = await loadRefundAuditContext(refundId)
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: auditContext?.orderId ?? refundId,
        action: 'refund_accounting_retry_failed',
        tag: 'accounting',
        level: 'WARNING',
        description: result.error,
        metadata: { refundId, orderNumber: auditContext?.refundOrderRef },
      })
      return result
    }

    await queueRefundAccountingActions({
      ...await loadRefundAccountingQueueInput(result.refundId, result.accountingSyncs),
      accountingSettings,
    })

    await db.salesOrderRefund.update({
      where: { id: result.refundId },
      data: {
        accountingRetryRequired: false,
        accountingWarning: null,
        accountingRetrySyncs: Prisma.DbNull,
      },
    })

    for (const row of result.returnedRows) {
      await logActivity({
        entityType: 'STOCK_ADJUSTMENT',
        entityId: row.productId,
        action: 'return_inbound',
        tag: 'stock',
        level: 'INFO',
        description: `Returned ${row.qty} units of SKU ${row.sku} for accounting retry on refund ${refundId}`,
        metadata: { productId: row.productId, qty: row.qty, orderNumber: result.refundOrderRef, refundId },
      })
    }

    if (result.returnedRows.length > 0) {
      const uniqueReturnedIds = [...new Set(result.returnedRows.map((row) => row.productId))]
      try {
        const { allocateBackordersForProducts } = await import('@/lib/fulfillment/backorder-allocator')
        await allocateBackordersForProducts(uniqueReturnedIds, {
          source: 'customer_return',
          referenceId: result.orderId,
          referenceLabel: `customer return accounting retry on order ${result.refundOrderRef}`,
        })
      } catch (allocError) {
        console.error(allocError)
      }
      try {
        await enqueueStockSync(uniqueReturnedIds, 'IMS_CHANGE')
      } catch (syncError) {
        console.error(syncError)
      }
    }

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: result.orderId,
      action: 'refund_accounting_retried',
      tag: 'accounting',
      level: 'INFO',
      description: `Retried refund accounting for order ${result.refundOrderRef}`,
      metadata: {
        refundId,
        accountingSyncCount: result.accountingSyncs.length + 1,
        returnedRows: result.returnedRows,
      },
    })

    revalidatePath('/sales')
    revalidatePath(`/sales/${result.orderId}`)
    return { success: true }
  } catch (e) {
    const auditContext = await loadRefundAuditContext(refundId).catch(() => null)
    await db.salesOrderRefund.update({
      where: { id: refundId },
      data: {
        accountingRetryRequired: true,
        accountingWarning: String(e),
      },
    }).catch(() => undefined)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: auditContext?.orderId ?? refundId,
      action: 'refund_accounting_retry_failed',
      tag: 'accounting',
      level: 'ERROR',
      description: `Failed to retry refund accounting: ${String(e)}`,
      metadata: { refundId, orderNumber: auditContext?.refundOrderRef },
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
    // audit-mmvp: lock the order row (same FOR UPDATE pattern as addPayment) so a
    // concurrent addPayment/markSalesOrderPaid can't both observe paidAt=null,
    // both flip it, and both run the warn/generate block — double-warning the
    // same paid_without_invoice transition. Reading + flipping paidAt under one
    // lock makes exactly one caller see the unpaid→paid transition.
    const locked = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id} FOR UPDATE`
      const row = await tx.salesOrder.findUnique({ where: { id }, select: { orderNumber: true, externalOrderNumber: true, paidAt: true, invoiceNumber: true } })
      if (!row) return null
      const markingAsPaid = !row.paidAt // transitioning from unpaid to paid
      await tx.salesOrder.update({
        where: { id },
        data: { paidAt: markingAsPaid ? new Date() : null },
      })
      return { so: row, markingAsPaid }
    }, STOCK_TX_OPTIONS)
    if (!locked) return { success: false, error: 'Order not found' }
    const { so, markingAsPaid } = locked

    // Only auto-generate invoice when transitioning TO paid (not when toggling off).
    // Skip its own log — the 'paid' entry below covers both actions.
    if (markingAsPaid && !so.invoiceNumber) {
      const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
      if (trigger?.value === 'on_paid') {
        await generateInvoiceNumber(id, { skipLog: true })
      } else {
        // Re-read invoiceNumber: a concurrent generateInvoiceNumber could have set
        // it between the tx commit and here — avoid a spurious warning (matches
        // addPayment's H2 path).
        const current = await db.salesOrder.findUnique({ where: { id }, select: { invoiceNumber: true } })
        if (shouldWarnPaidWithoutInvoice({ becamePaid: true, hasInvoiceNumber: Boolean(current?.invoiceNumber), invoiceTrigger: trigger?.value })) {
          // audit-H2: surface the paid-without-invoice gap for manual/unset triggers.
          await logActivity({
            entityType: 'SALES_ORDER',
            entityId: id,
            action: 'paid_without_invoice',
            tag: 'sales',
            level: 'WARNING',
            description: `Order ${getSalesOrderReference({ id, ...so })} is fully paid but has no invoice (trigger: ${trigger?.value ?? 'manual'}). Generate an invoice to keep the GL receivable and invoice in sync.`,
            metadata: { orderNumber: getSalesOrderReference({ id, ...so }), invoiceTrigger: trigger?.value ?? null },
          })
        }
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
    const { getNumberingFormats } = await import('./company')
    const numbering = await getNumberingFormats()
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id} FOR UPDATE`
      const so = await tx.salesOrder.findUnique({ where: { id }, select: { externalOrderNumber: true, orderNumber: true, invoiceNumber: true } })
      if (!so) throw new Error('Order not found')
      if (so.invoiceNumber) return { invoiceNumber: so.invoiceNumber, orderNumber: getSalesOrderReference({ id, ...so }) }
      const invNum = await nextDocumentNumber(tx, {
        key: 'invoice',
        prefix: numbering.inv_prefix,
      })
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
    const baseCurrency = await getBaseCurrencyCode()
    const txResult = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${input.orderId} FOR UPDATE`
      const so = await tx.salesOrder.findUnique({
        where: { id: input.orderId },
        select: {
          id: true,
          orderNumber: true,
          externalOrderNumber: true,
          status: true,
          currency: true,
          totalForeign: true,
          totalBase: true,
          fxRateToBase: true,
          paidAt: true,
          invoiceNumber: true,
        },
      })
      if (!so) return { error: 'Order not found' }
      if (so.status === 'CANCELLED' || so.status === 'REFUNDED') {
        return { error: `Cannot add payments to ${so.status.toLowerCase()} orders` }
      }
      if (input.currency !== so.currency) {
        return { error: `Payment currency must match order currency (${so.currency})` }
      }

      const refundId = input.refundId || null
      let payableTotal = Number(so.totalForeign)
      if (refundId) {
        const refund = await tx.salesOrderRefund.findFirst({
          where: { id: refundId, orderId: input.orderId },
          select: { totalForeign: true },
        })
        if (!refund) return { error: 'Refund not found for this order' }
        payableTotal = Number(refund.totalForeign)
      }

      const existingPayments = await tx.payment.findMany({
        where: { orderId: input.orderId, refundId },
        select: { amount: true, currency: true },
      })
      const totalPaid = existingPayments.reduce((sum, payment) => {
        if (payment.currency !== so.currency) return sum
        return sum + Number(payment.amount)
      }, 0)
      if (totalPaid + input.amount > payableTotal + 0.0001) {
        return { error: `Payment exceeds remaining balance (${so.currency} ${(payableTotal - totalPaid).toFixed(2)})` }
      }

      const paidAt = input.paidAt ? new Date(input.paidAt) : new Date()
      const payment = await tx.payment.create({
        data: {
          orderId: input.orderId,
          refundId,
          amount: input.amount,
          currency: input.currency,
          method: input.method || null,
          reference: input.reference || null,
          notes: input.notes || null,
          paidAt,
        },
        select: { id: true, paidAt: true },
      })

      const becamePaid = !refundId && !so.paidAt && totalPaid + input.amount >= Number(so.totalForeign) - 0.0001
      if (becamePaid) {
        await tx.salesOrder.update({ where: { id: input.orderId }, data: { paidAt: new Date() } })
      }
      const settlementRateToBase = await resolveSettlementFxRateToBase(tx, {
        currency: so.currency,
        baseCurrency,
        asOf: payment.paidAt,
        fallbackRateToBase: Number(so.fxRateToBase),
        referenceType: 'Payment',
        referenceId: payment.id,
      })
      return { so, becamePaid, paymentId: payment.id, paidAt: payment.paidAt, settlementRateToBase, baseCurrency }
    }, STOCK_TX_OPTIONS)
    if ('error' in txResult) return { success: false, error: txResult.error }

    if (txResult.becamePaid) {
      const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
      if (trigger?.value === 'on_paid') {
        await generateInvoiceNumber(input.orderId, { skipLog: true })
      } else if (!txResult.so.invoiceNumber) {
        // Re-read invoiceNumber: a concurrent generateInvoiceNumber could have
        // set it between the tx commit and here — avoid a spurious warning.
        const current = await db.salesOrder.findUnique({ where: { id: input.orderId }, select: { invoiceNumber: true } })
        if (shouldWarnPaidWithoutInvoice({ becamePaid: txResult.becamePaid, hasInvoiceNumber: Boolean(current?.invoiceNumber), invoiceTrigger: trigger?.value })) {
          // audit-H2: manual/unset trigger won't generate an invoice — make the
          // receivable/invoice gap loud rather than auto-generating.
          await logActivity({
            entityType: 'SALES_ORDER',
            entityId: input.orderId,
            action: 'paid_without_invoice',
            tag: 'sales',
            level: 'WARNING',
            description: `Order ${getSalesOrderReference(txResult.so)} is fully paid but has no invoice (trigger: ${trigger?.value ?? 'manual'}). Generate an invoice to keep the GL receivable and invoice in sync.`,
            metadata: { orderNumber: getSalesOrderReference(txResult.so), invoiceTrigger: trigger?.value ?? null },
          })
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
      description: `Added ${input.currency} ${input.amount.toFixed(2)} payment to order ${getSalesOrderReference(txResult.so)}`,
      metadata: { orderNumber: getSalesOrderReference(txResult.so), amount: input.amount, currency: input.currency, method: input.method },
    })

    if (!input.refundId) {
      try {
        const accountingSettings = await getAccountingSettings()
        const accounts = getRealisedFxAccounts(accountingSettings, 'receivable')
        if (accountingSettings.syncEnabled && accounts && txResult.so.currency !== txResult.baseCurrency) {
          const realised = computeRealisedFx({
            side: 'receivable',
            amountForeign: input.amount,
            bookedRateToBase: Number(txResult.so.fxRateToBase),
            settlementRateToBase: txResult.settlementRateToBase,
            // Booked base for this payment = the order's stored base prorated by the
            // settled foreign share, so realised FX measures against the real AR
            // carrying value rather than a re-derived figure (cogs-audit scjz.55).
            bookedBase: Number(txResult.so.totalForeign) > 0
              ? multiplyMoney(txResult.so.totalBase, input.amount).div(toDecimal(txResult.so.totalForeign)).toNumber()
              : undefined,
          })
          const lines = buildRealisedFxJournal({
            side: 'receivable',
            gainLossBase: realised.gainLossBase,
            controlAccount: accounts.controlAccount,
            fxGainLossAccount: accounts.fxGainLossAccount,
            description: `Realised FX ${realised.outcome} on payment for ${getSalesOrderReference(txResult.so)}`,
          })
          if (lines.length > 0) {
            await queueAccountingSync({
              type: 'REALISED_FX_JOURNAL',
              referenceType: 'Payment',
              referenceId: txResult.paymentId,
              payload: {
                date: txResult.paidAt.toISOString().slice(0, 10),
                reference: getSalesOrderReference(txResult.so),
                narration: `Realised FX ${realised.outcome} on customer payment ${getSalesOrderReference(txResult.so)}`,
                lines,
                side: 'receivable',
                amountForeign: input.amount,
                currency: txResult.so.currency,
                bookedRateToBase: Number(txResult.so.fxRateToBase),
                settlementRateToBase: txResult.settlementRateToBase,
                bookedBase: realised.bookedBase,
                settlementBase: realised.settlementBase,
                gainLossBase: realised.gainLossBase,
              },
              idempotencyKey: `realised-fx:payment:${txResult.paymentId}`,
            })
          }
        }
      } catch {
        // FX journal queueing must not block payment capture.
      }
    }
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
    const txResult = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
      const so = await tx.salesOrder.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          externalOrderNumber: true,
          currency: true,
          totalForeign: true,
          status: true,
          paidAt: true,
        },
      })
      if (!so) return { error: 'Order not found' }
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        select: { orderId: true, refundId: true, amount: true, currency: true },
      })
      if (!payment || payment.orderId !== orderId) {
        return { error: 'Payment not found for this order' }
      }
      await tx.payment.delete({ where: { id: paymentId } })
      let becameUnpaid = false
      if (!payment.refundId) {
        const remainingPayments = await tx.payment.findMany({
          where: { orderId, refundId: null },
          select: { amount: true, currency: true },
        })
        const totalPaid = remainingPayments.reduce((sum, p) => {
          if (p.currency !== so.currency) return sum
          return sum + Number(p.amount)
        }, 0)
        const stillFullyPaid = totalPaid >= Number(so.totalForeign) - 0.0001
        // Only a genuine paid → not-paid transition is a mismatch. An order that
        // was never fully paid (e.g. shipped on credit terms) isn't flagged just
        // because a partial payment was removed.
        becameUnpaid = so.paidAt !== null && !stillFullyPaid
        await tx.salesOrder.update({
          where: { id: orderId },
          data: { paidAt: stillFullyPaid ? undefined : null },
        })
      }
      return { so, becameUnpaid, payment: { refundId: payment.refundId, amount: Number(payment.amount), currency: payment.currency } }
    }, STOCK_TX_OPTIONS)
    if ('error' in txResult) return { success: false, error: txResult.error }
    if (!txResult.payment.refundId) {
      const paymentLogs = await db.accountingSyncLog.findMany({
        where: {
          type: 'INVOICE_PAYMENT',
          referenceType: 'SalesOrder',
          referenceId: orderId,
          status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
        },
        select: { id: true, status: true, payload: true },
      })
      const matchingLogs = paymentLogs.filter((log) => {
        const payload = log.payload as { amount?: unknown; currency?: unknown } | null
        const amount = typeof payload?.amount === 'number' ? payload.amount : Number(payload?.amount)
        const currency = typeof payload?.currency === 'string' ? payload.currency : txResult.payment.currency
        return Math.abs(amount - txResult.payment.amount) <= 0.0001 && currency === txResult.payment.currency
      })
      const pendingIds = matchingLogs.filter((log) => log.status === 'PENDING').map((log) => log.id)
      if (pendingIds.length > 0) {
        await db.accountingSyncLog.deleteMany({ where: { id: { in: pendingIds } } })
      }
      const externalLogs = matchingLogs.filter((log) => log.status === 'PROCESSING' || log.status === 'SYNCED')
      if (externalLogs.length > 0) {
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: orderId,
          action: 'payment_external_reversal_required',
          tag: 'accounting',
          level: 'WARNING',
          description: `Deleted local payment for ${getSalesOrderReference(txResult.so)} after payment sync had already started; reverse the payment in the accounting connector if required.`,
          metadata: { orderNumber: getSalesOrderReference(txResult.so), paymentId, accountingSyncLogIds: externalLogs.map((log) => log.id) },
        })
      }
    }
    revalidatePath(`/sales/${orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'payment_deleted',
      tag: 'sales',
      level: 'INFO',
      description: `Deleted payment from order ${getSalesOrderReference(txResult.so)}`,
      metadata: { orderNumber: getSalesOrderReference(txResult.so), paymentId },
    })
    // audit-M-o2c: deleting the last payment clears paidAt but does not revert
    // status — flag the mismatch when the order has already advanced past
    // payment (shipped/completed) so it doesn't sit silently unpaid-but-shipped.
    if (isPaymentStatusMismatch(txResult.so.status, txResult.becameUnpaid)) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'payment_status_mismatch',
        tag: 'sales',
        level: 'WARNING',
        description: `Order ${getSalesOrderReference(txResult.so)} is ${txResult.so.status} but is no longer fully paid after deleting a payment. Review whether the status should be reverted.`,
        metadata: { orderNumber: getSalesOrderReference(txResult.so), status: txResult.so.status, paymentId },
      })
    }
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
