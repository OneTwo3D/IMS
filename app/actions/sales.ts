'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import type { WmsOrderStatusView } from '@/app/actions/wms-order-status'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS, isWmsConnectorId } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { logActivity } from '@/lib/activity-log'
import { entersFulfilment, reconcileAllocationBeforeFulfilment, recordShortfallUnderLock } from '@/lib/fulfillment/pre-fulfilment-reallocation'
import { recordWmsMutationEvent } from '@/lib/domain/wms/mutation-audit'
import { freshAuthFailureResult, requireFreshPermission, requireInternalUser, requirePermission } from '@/lib/auth/server'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'
import { xeroGet } from '@/lib/connectors/xero/api'
import {
  HOLD_MOVED_REFUSAL,
  NO_LEDGER_HOLD_REFUSAL,
  PAYMENT_REGISTRATION_TYPE,
  READABLE_REGISTRATION_STATUSES,
  REGISTRATION_IN_FLIGHT_REFUSAL,
  RETIRABLE_REGISTRATION_STATUSES,
  UNDECIDED_ATTEMPTS_AMBIGUOUS_REFUSAL,
  UNDECIDED_ATTEMPT_REVERSAL_REFUSAL,
  UNVERIFIABLE_IN_FLIGHT_REFUSAL,
  VERIFIABLE_REVERSAL_CONNECTORS,
  assertedReversalNote,
  buildAssertedReversalData,
  buildVerifiedReversalData,
  describeAttemptUndecidedRefusal,
  describeLedgerHoldRefusal,
  hasPostEvidence,
  isReversedInLedger,
  ledgerReversalNote,
  normalizeAssertedPaymentReference,
  canonicalCurrencyCode,
  canonicalLedgerAmount,
  refuseAssertedPaymentAmountMismatch,
  refuseAssertedPaymentCurrencyMismatch,
  refuseAssertedPaymentNotOnInvoice,
  refuseAssertedPaymentStillOnInvoice,
  refuseAssertedPaymentUnattributable,
  refuseLedgerLookupFailure,
  refuseLedgerStillHolds,
  refuseUnverifiableConnector,
  sameLedgerIdentifier,
  splitPaymentRegistrations,
  type LedgerReversalRefusalCode,
  type PaymentDeleteRefusalCode,
  type PaymentRegistrationRow,
} from '@/lib/domain/accounting/payment-ledger-hold'
import {
  queueAccountingSync,
  queueAccountingSyncTx,
  getAccountingSettings,
  getActiveAccountingConnectorInfo,
  isAccountingSyncTypeEnabled,
  type AccountingSettings,
} from '@/lib/accounting'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'
import { creditNoteLineTaxTypeResolver } from '@/lib/domain/sales/refund-posted-tax-identity'
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
import { INTERNAL_STATUS_TRANSITION_BYPASS, INTERNAL_STATUS_TRANSITION_AUTH_ONLY } from '@/lib/sales/status-transition-bypass'
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
  type RefundCreationConflict,
  type RefundExpectedTaxIdentity,
  type RefundRequestLine,
} from '@/lib/domain/sales/refund-service'
import {
  expectedSalesOrderLineTaxForeign,
  validateSalesOrderLineTaxInputs,
} from '@/lib/domain/sales/sales-order-tax-validation'
import { decideChargebackOrderDiscount, resolvePostedOrderDiscount } from '@/lib/domain/accounting/posted-order-discount'
import { invoiceNumberIsExternallySupplied, resolveSalesInvoiceNumberForPost } from '@/lib/domain/accounting/sales-invoice-number'
import { decideChargebackDiscountLine, readPostedSalesInvoiceDiscountForOrder } from '@/lib/domain/accounting/posted-document-discount'
import {
  loadInvoicePaymentSyncRows,
  payloadPaymentId,
  registerInvoicePaymentWithLedger,
} from '@/lib/domain/accounting/invoice-payment-enqueue'
import {
  aggregatePaymentSyncRows,
  effectivePaymentSyncRows,
  ledgerSalesInvoiceTotalForeign,
  settlementStatus,
  type SettlementVerdict,
} from '@/lib/domain/accounting/settlement-status'
import { isExternalRefundIdUniqueConflict } from '@/lib/domain/sales/refund-idempotency'
import { releaseReservationsAfterRefund } from '@/lib/domain/sales/post-refund-release'
import { shouldWarnPaidWithoutInvoice, shouldWarnPaidOrderCancelledWithoutInvoice } from '@/lib/domain/sales/paid-without-invoice'
import { PermanentStatusTransitionError, isPermanentStatusTransitionError } from '@/lib/domain/sales/status-transition-errors'
import { canTransitionSalesOrder } from '@/lib/domain/workflows/sales-order-state'
import { isPaymentStatusMismatch } from '@/lib/domain/sales/o2c-guards'
import {
  cancelSalesOrderFulfillmentState,
  lockSalesOrder,
  releaseOrderAllocationsInTx,
  updateSalesOrderStatusUnderLock,
} from '@/lib/domain/sales/allocation-service'
import { findSalesOrderDeleteBlocker } from '@/lib/domain/sales/order-delete-guard'
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
  | 'CANCELLED'

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
  refundStatus: 'NONE' | 'PARTIAL' | 'FULL'
  /// o3d-e1yb [wdraw]: set while an EU withdrawal request holds this order.
  withdrawalHoldAt: string | null
  /// o3d-rbyg r4: WHICH request the hold is — carried to the release so the button cannot clear a
  /// newer one filed since this page was drawn. Advances per new submission.
  withdrawalHoldGeneration: number
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
      salesOrderLineId: string | null
      productId: string | null
      description: string
      qty: number
      unitPriceForeign: number
      totalForeign: number
      totalBase: number
    }[]
  }[]
  payments: PaymentRow[]
  /**
   * Whether the LEDGER agrees this order is settled (o3d-lgo.15). paidAt and the local payment rows only
   * say IMS was told money arrived; registering it against the ledger invoice is a separate sync that can
   * fail, be cancelled, or never have been queued — and the UI showed an unconditional green "Paid" over
   * all three.
   */
  settlement: SettlementVerdict
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
    await lockSalesOrder(tx, orderId)
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
  refundStatus: true,
  withdrawalHoldAt: true,
  withdrawalHoldGeneration: true,
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
  refundStatus: string
  withdrawalHoldAt: Date | null
  withdrawalHoldGeneration: number
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
    refundStatus: so.refundStatus as 'NONE' | 'PARTIAL' | 'FULL',
    withdrawalHoldAt: so.withdrawalHoldAt ? so.withdrawalHoldAt.toISOString() : null,
    withdrawalHoldGeneration: so.withdrawalHoldGeneration,
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
  await requireInternalUser()
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

/**
 * What IMS claims has been RECEIVED against the order invoice, in the order currency — the figure the
 * ledger has to match.
 *
 * Not simply the order total: an order can be part-paid, and a part payment the ledger registered in
 * full is perfectly consistent. Refund payments are excluded — they settle a credit note, not this
 * invoice — as are payments in some other currency, which cannot be summed with these.
 */
function claimedReceivedForeign(so: {
  currency: string
  totalForeign: unknown
  paidAt: Date | null
  payments: { refundId: string | null; amount: unknown; currency: string }[]
}): number {
  const local = so.payments
    .filter((p) => !p.refundId && p.currency === so.currency)
    .reduce((sum, p) => sum + Number(p.amount), 0)
  // An imported paid order (WooCommerce) has paidAt but NO local payment rows — its receipt was never
  // recorded as a Payment. Paid-in-full is then the claim, and the order total is its size.
  return so.paidAt ? Math.max(local, Number(so.totalForeign)) : local
}

export async function getSalesOrder(id: string): Promise<SoDetail | null> {
  await requireInternalUser()
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
            select: { id: true, salesOrderLineId: true, productId: true, description: true, qty: true, unitPriceForeign: true, totalForeign: true, totalBase: true },
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

  // THE LEDGER'S OWN VIEW of this order's receipts (o3d-lgo.15). Read alongside the order rather than
  // per payment row: the verdict is about the order's settlement as a whole, and one rejected payment
  // among several means the ledger still shows a balance.
  const activeConnector = await getActiveAccountingConnectorInfo().catch(() => null)
  const [paymentSyncEnabled, paymentSyncRows] = await Promise.all([
    // The TYPE's own posting mode, not just the connector flag: an installation that has payment sync
    // switched off expects no payment to post, and calling that a discrepancy would paint every paid
    // order permanently red for a setting someone chose on purpose.
    isAccountingSyncTypeEnabled('INVOICE_PAYMENT').catch(() => false),
    loadInvoicePaymentSyncRows(so.id, activeConnector?.id ?? null),
  ])
  const claimedForeign = claimedReceivedForeign(so)
  const settlement = settlementStatus({
    paidLocally: !!so.paidAt || claimedForeign > 0,
    syncEnabled: paymentSyncEnabled,
    documentPosted: !!so.accountingInvoiceId,
    // History first: a registration whose receipt was deleted, or one a later success overtook, describes
    // nothing that is still true — and worst-first would let it alarm over a settled invoice for ever.
    payment: aggregatePaymentSyncRows(
      effectivePaymentSyncRows(paymentSyncRows, {
        livePaymentIds: new Set(so.payments.map((p) => p.id)),
      }),
    ),
    // Compared against what the ledger's copy of the invoice was built at, capped by what IMS actually
    // claims to have received — a part payment fully registered is settled for its size.
    totalForeign: Math.min(
      claimedForeign,
      ledgerSalesInvoiceTotalForeign({
        totalForeign: Number(so.totalForeign),
        taxForeign: Number(so.taxForeign),
        pricesIncludeVat: so.pricesIncludeVat,
        importedFromShop: so.shoppingLinks.length > 0,
      }),
    ),
  })

  return {
    ...mapSoRow(so),
    settlement,
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
        salesOrderLineId: rl.salesOrderLineId,
        productId: rl.productId,
        description: rl.description,
        qty: Number(rl.qty),
        unitPriceForeign: Number(rl.unitPriceForeign),
        totalForeign: Number(rl.totalForeign),
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
      invoiceNumber: true,
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

  // o3d-k26m.1: prefer the number already recorded on the order over one derived here. See
  // lib/domain/accounting/sales-invoice-number.ts — the create is an upsert on InvoiceNumber, so
  // two routes deriving two numbers for one order post two documents.
  const { invoiceNumber: accountingInvoiceNumber } = resolveSalesInvoiceNumberForPost({
    persistedInvoiceNumber: so.invoiceNumber,
    fallbackPrefix: manualPrefix,
    orderReference: orderNumber,
  })

  const payload = {
    invoiceNumber: accountingInvoiceNumber,
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
  // NB: no boolean authorization bypass. This action is exported from a
  // module-wide 'use server' file, so Next.js makes it directly POST-callable
  // and every option here crosses the RPC boundary. A `skipPermissionCheck?:
  // boolean` used to live here, and a client could simply send it to suppress
  // requirePermission('sales.process') — then drive any state-machine-legal
  // transition, including CANCELLED from PROCESSING/ALLOCATED/PICKING/PACKING,
  // which releases reservations and deletes pending shipments. Symbols cannot
  // be serialized, so the capability tokens are not forgeable. (o3d-43oz)
  options?: { pushStatusToWooCommerce?: boolean; internalBypassToken?: symbol },
  // `permanent: true` marks a failure a stable business rule refused, so a caller driving this from a
  // retrying transport (the Woo webhook inbox) can acknowledge it instead of retrying forever (o3d-bx9).
): Promise<{ success: boolean; error?: string; permanent?: boolean }> {
  try {
    // INTERNAL_STATUS_TRANSITION_BYPASS skips BOTH the permission check and the
    // state-machine guard — for external systems (WooCommerce) that may
    // legitimately force a mapped status.
    // INTERNAL_STATUS_TRANSITION_AUTH_ONLY is narrower: it skips ONLY the
    // permission check, for sessionless internal callers such as the delivery
    // cron, while the state-machine guard still runs — so a stale transition
    // (e.g. an order cancelled after the poll's SHIPPED query) is still
    // rejected. Both are symbols, hence unforgeable across the RPC boundary.
    // Two distinct capabilities. The full bypass skips the state machine too;
    // the auth-only token does NOT, so a sessionless caller cannot force an
    // invalid transition. Both are symbols and therefore unforgeable across
    // the Server Action boundary. (o3d-e1yb)
    const bypassPermission = options?.internalBypassToken === INTERNAL_STATUS_TRANSITION_BYPASS
    const authOnly = options?.internalBypassToken === INTERNAL_STATUS_TRANSITION_AUTH_ONLY
    if (!bypassPermission && !authOnly) {
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
        // o3d-e1yb [wdraw]: read here so the guard below runs against the row
        // this transition itself read, not a caller's earlier snapshot.
        withdrawalApprovedAt: true,
        // b8i6.1: detect a shopping order via ANY connector (not just WooCommerce)
        // so a Shopify-linked order also gets its IMS status pushed back.
        shoppingLinks: { select: { id: true }, take: 1 },
        lines: { select: { id: true, productId: true, sku: true, qty: true } },
      },
    })
    if (!so) return { success: false, error: 'Order not found' }
    // audit-M-o2c: an archived order is filed away — block MANUAL status edits.
    // Automated data-pushes still apply: the WooCommerce force-sync
    // (INTERNAL_STATUS_TRANSITION_BYPASS) and the sessionless delivery cron
    // (INTERNAL_STATUS_TRANSITION_AUTH_ONLY) are carrier/source-of-truth signals,
    // so they bypass this guard — otherwise an archived-but-shipped order could
    // never auto-reach DELIVERED.
    if (so.archived && !bypassPermission && !authOnly) {
      return { success: false, error: 'This order is archived; unarchive it before changing its status.' }
    }

    // o3d-e1yb [wdraw]: an APPROVED withdrawal is terminal. The inbound status
    // handler already refuses ordinary storefront statuses for such an order,
    // but that check reads an unlocked snapshot: an ordinary event can be
    // classified before a concurrent approval commits and then apply its
    // full-bypass mapping afterwards, overwriting CANCELLED with PROCESSING and
    // making the order warehouse-eligible again. Enforcing it HERE is what
    // makes it atomic with the status write.
    // Cheap early-out only; the authoritative check is under the row lock in
    // beforeUpdate below. Same rule, so the two cannot disagree.
    if (so.withdrawalApprovedAt && targetStatus !== 'CANCELLED'
        && !canTransitionSalesOrder(so.status as SoStatus, targetStatus)) {
      return {
        success: false,
        permanent: true,
        error: 'This order\u2019s EU withdrawal request was approved; its status cannot be moved backwards.',
      }
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
      if (cancellation.repairedFalseShipped) {
        // o3d-gz6: the order was SHIPPED with no dispatch evidence (a configurable WC status mapping
        // wrote SHIPPED without a real shipment). We repaired the false status so this cancel could
        // proceed instead of dead-lettering forever — surface the data anomaly for review.
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: id,
          action: 'false_shipped_status_repaired',
          tag: 'sales',
          level: 'WARNING',
          description: `Order ${getSalesOrderReference(so)} was SHIPPED with no dispatch evidence; repaired the false status to allow cancellation (o3d-gz6)`,
          metadata: {
            orderNumber: getSalesOrderReference(so),
            releasedAllocations: cancellation.releasedAllocationCount,
          },
        })
      }
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

    // o3d-c9mi: PICKING / PACKING are outside the reallocation sweep's reach, and nothing
    // moves an order back out of them automatically — so this is the LAST point at which a
    // partially-allocated order will ever be retried, and its one-shot replenishment trigger
    // has already been consumed. Runs before the lock because autoAllocateOrder opens its own
    // transaction; see the module docstring for why this is a backstop rather than a gate.
    if (!orderUpdated && entersFulfilment(so.status, targetStatus)) {
      await reconcileAllocationBeforeFulfilment(id)
    }

    if (!orderUpdated) {
      const transitionResult = await db.$transaction(async (tx) => {
        return updateSalesOrderStatusUnderLock(tx, {
          orderId: id,
          targetStatus,
          data,
          bypass: bypassPermission,
          beforeUpdate: async ({ tx: lockedTx }) => {
            // o3d-e1yb [wdraw]: enforce the terminal-approval fact HERE, under
            // the row lock, immediately before the write. The pre-flight check
            // above reads an unlocked snapshot, so an ordinary storefront
            // event can read null, pause while a concurrent approval records
            // the fact and cancels the order, then acquire this lock and use
            // the full bypass to overwrite CANCELLED with PROCESSING — the
            // exact resurrection this guard exists to prevent.
            if (targetStatus !== 'CANCELLED') {
              const fresh = await lockedTx.salesOrder.findUnique({
                where: { id },
                select: { withdrawalApprovedAt: true, status: true },
              })
              // Permit only what the state machine itself would permit from
              // the CURRENT status. That allows a post-dispatch return to
              // finish (SHIPPED -> COMPLETED/DELIVERED) while refusing every
              // backward, bypassed move — CANCELLED -> PROCESSING and
              // SHIPPED -> PROCESSING are both machine-illegal, and the full
              // bypass is exactly what would otherwise force them.
              if (fresh?.withdrawalApprovedAt
                  && !canTransitionSalesOrder(fresh.status as SoStatus, targetStatus)) {
                // PermanentStatusTransitionError, not a plain Error: a generic
                // throw is classified TRANSIENT, so the webhook inbox would
                // retry a business rule that can never pass and could
                // dead-letter on a final-attempt race.
                throw new PermanentStatusTransitionError(
                  'This order\u2019s EU withdrawal request was approved; its status cannot be moved backwards.',
                )
              }
            }
            // o3d-c9mi: the AUTHORITATIVE record, under the lock, against the real previous
            // status. The attempt above runs outside it and can therefore be skipped or
            // wrong; this cannot be. Detection only — the transition still proceeds, because
            // partial fulfilment is intentional.
            const beforeStatus = (await lockedTx.salesOrder.findUnique({
              where: { id }, select: { status: true },
            }))?.status
            if (beforeStatus) {
              await recordShortfallUnderLock({
                tx: lockedTx as never,
                orderId: id,
                previousStatus: beforeStatus,
                targetStatus,
              })
            }
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
      // Direct (non-storefront) orders: courtesy dispatch email, opt-in and
      // queued at most once per order. Self-guarded (order must be SHIPPED,
      // dedup under the order row lock) and never throws.
      const { queueDispatchEmailIfEligible } = await import('@/lib/dispatch-email')
      await queueDispatchEmailIfEligible(id)
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
    // Classify rather than flatten (o3d-bx9). A stable business rejection and a transient DB/lock
    // failure both land here as thrown Errors; returning them identically is what made the Woo webhook
    // retry an impossible cancellation ~24 times into the dead-letter queue. Anything unrecognised stays
    // transient, so a new failure mode keeps retrying rather than being silently acknowledged.
    return { success: false, error: errorMessage, permanent: isPermanentStatusTransitionError(e) }
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
  // The code each credit-note line carries, from the ONE definition the retry fence also reads
  // (o3d-w00, Codex r10 #2) — the snapshot where there is one, else the line's own re-derived sales tax
  // type, else the order default, else no code at all. Two definitions of this is a fence that checks a
  // different set of lines from the set that posts.
  //
  // Credit-note PRODUCT lines must apply the SAME per-line reverse-charge swap the original invoice did
  // (audit H1), keyed on each sales line's own TaxRate.reverseCharge — or a refund of a reverse-charged
  // sale posts under the standard code and the VAT return no longer balances. The fallback for a line
  // with no mapped sales line (shipping, ad-hoc) is the order-level tax type WITHOUT the swap, mirroring
  // exactly how the invoice posts its shipping/discount lines (shippingTaxType = orderDefaultTaxType, no
  // swap): swapping there would post credit-note shipping under the reverse-charge code while the
  // invoice posted it under the standard code — an asymmetry the VAT return would flag.
  const creditNoteTaxTypeOf = creditNoteLineTaxTypeResolver({
    orderLines: orderForCN?.lines ?? [],
    reverseChargeSalesTaxType: settings.reverseChargeSalesTaxType,
    orderDefaultTaxType: cnTaxRate?.accountingTaxType ?? null,
  })

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
        // Post under the tax identity SNAPSHOTTED at refund creation (o3d-w00) — the rate the invoice
        // actually validated — instead of re-predicting it from the order default here, which mis-taxed
        // deactivated-rate/reverse-charge/mixed-rate refunds. Fall back to the old prediction only for
        // legacy rows with no snapshot (created before the column existed).
        taxType: creditNoteTaxTypeOf(line) ?? undefined,
      })),
      // Every stored refund line is NET (o3d-w00): the WooCommerce monetary-only refund — the one caller
      // that had a gross amount — is now netted at source, so this correctly grosses every line up.
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
        // o3d-3zgy: the order row lock comes FIRST, before anything else this transaction touches.
        // queueAccountingSyncTx writes inside our transaction so it cannot take the lock itself
        // (doing so would take it after any stock locks and invert the ordering allocation-service
        // establishes), which left this enqueue racing a hard delete of the same order — the
        // o3d-hrak race, still open through this path. Hoisting it here serialises the two.
        await lockSalesOrder(tx, input.orderId)
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
          // Snapshot resolved at creation (o3d-w00). Selecting them here means an accounting RETRY posts
          // under the SAME tax identity and to the SAME account as the first attempt, instead of
          // re-predicting the tax type and re-inferring the kind (which mis-posted monetary refunds).
          lineKind: true,
          accountingTaxType: true,
          reverseCharge: true,
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
      // Prefer the PERSISTED kind (o3d-w00 #4). Only a legacy row (created before the column existed)
      // carries NULL, and for those we keep the historical inference: a null-product line is shipping
      // UNLESS its total is negative — the mirrored order-discount line, which must reload as 'discount'
      // so a retry re-posts it to the discount account. New monetary-only 'sale' lines no longer get
      // mis-reconstructed as 'shipping'.
      lineKind: (line.lineKind as 'sale' | 'shipping' | 'discount' | null) ?? (
        line.productId ? 'sale' : (decimalToNumber(line.totalBase) < 0 ? 'discount' : 'shipping')
      ),
      accountingTaxType: line.accountingTaxType,
      reverseCharge: line.reverseCharge,
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
  options?: {
    internalBypassToken?: symbol
    externalRefundId?: number
    chargeback?: boolean
    /**
     * o3d-w00 (Codex r3 #2): cap each order line / the shipping charge at its own remaining balance,
     * inside the refund transaction's order lock. Internal-only, like the other provenance-bearing
     * options: it is set by the exception inbox's hand-recording path.
     */
    enforcePerTargetBalances?: boolean
    /**
     * o3d-w00 (Codex r4 #2): the accounting tax identity each target was CONVERTED at, to be re-checked
     * against the identity the credit note will actually post under, inside the refund transaction's
     * order lock. Internal-only and a pure TIGHTENING — it can only refuse a refund, never widen one.
     */
    expectedTaxIdentities?: RefundExpectedTaxIdentity[]
  },
  // Two independent outcomes ride alongside `error`:
  //   `conflict`   (o3d-6oyu.18) — the refund transaction refused this credit note because the
  //                OTHER reversal path (WC refund webhook vs payment-poller chargeback) had
  //                already committed one for this order. A no-op the caller must not retry.
  //   `quarantine` (o3d-w00) — the refund is monetary-only and the order cannot be taxed
  //                uniformly, so it was parked for a human rather than posted on a guess.
): Promise<{
  success: boolean
  error?: string
  warning?: string
  conflict?: RefundCreationConflict
  quarantine?: true
}> {
  try {
    const isInternal = options?.internalBypassToken === INTERNAL_ACTION_BYPASS
    if (!isInternal) {
      await requirePermission('sales.refund')
    }
    // o3d-n8p (Codex): chargeback and externalRefundId are provenance-bearing and have material effects —
    // chargeback suppresses restock + COGS reversal, and externalRefundId occupies the globally unique Woo
    // replay key. They must come only from the trusted internal entry points (Woo sync, chargeback poller),
    // which supply the unforgeable internal capability. Reject them from a public/manual caller so a
    // network client with sales.refund can't forge a chargeback or squat a replay key (and so the derived
    // `source` is trustworthy).
    if (!isInternal && (options?.chargeback || options?.externalRefundId != null)) {
      return { success: false, error: 'chargeback and externalRefundId may only be set by internal sync callers' }
    }
    // o3d-w00 (Codex r3 #2): the per-target cap is a TIGHTENING, so a forged `true` cannot over-refund —
    // but a forged `false` from a public caller could turn it off for the hand-recording path, so it is
    // read only from an internal caller.
    const enforcePerTargetBalances = isInternal && options?.enforcePerTargetBalances === true

    const { getNumberingFormats } = await import('./company')
    const [numbering, accountingSettings] = await Promise.all([
      // scjz.71: internal callers (the payment-poller chargeback) have no session, so
      // pass the bypass through to skip getNumberingFormats' requireAuth (NEXT_REDIRECT).
      getNumberingFormats(options?.internalBypassToken ? { internalBypassToken: options.internalBypassToken } : undefined),
      getAccountingSettings().catch(() => null),
    ])

    const refundResult = await createSalesOrderRefund(db, {
      orderId,
      // o3d-w00 (Codex r7 #1/#4): `chargedTaxForeign` is what the SOURCE OF THE REFUND states this line
      // bore, and the writer's posted-VAT fence checks the posting identity against it INSTEAD of
      // against the order's own snapshot — so a forged value from a public caller could wave a divergent
      // credit note straight through. Like chargeback/externalRefundId it is provenance-bearing, and
      // like them it is honoured only from the trusted internal entry points (the WooCommerce sync).
      // Stripped rather than rejected: a public caller has no way to send it deliberately, and the
      // refund itself is still perfectly recordable against the order's own figures.
      lines: isInternal
        ? lines
        : lines.map((line) => ({ ...line, chargedTaxForeign: undefined })),
      reason,
      returnWarehouseId,
      externalRefundId: options?.externalRefundId,
      creditNotePrefix: numbering.cn_prefix,
      accountingSettings,
      // scjz.70: revenue-only chargeback (credit note reverses recognised revenue,
      // COGS + restock suppressed). Used by the payment-poller on a payment reversal.
      chargeback: options?.chargeback,
      activeAccountingConnector: (await getActiveAccountingConnectorInfo())?.id,
      // o3d-w00 (Codex r8 #6): the posted-VAT fence is gated on a credit note ACTUALLY being posted,
      // which is not the same as an accounting plugin being enabled — both connector queues no-op when
      // the connector's sync is off or its CREDIT_NOTE type is set to `off`. Gating on plugin
      // activation refused (and quarantined) refunds on stores that had deliberately turned
      // credit-note posting off, over a ledger entry nobody was going to write.
      creditNotePostingEnabled: await isAccountingSyncTypeEnabled('CREDIT_NOTE'),
      enforcePerTargetBalances,
      // o3d-w00 (Codex r4 #2): like enforcePerTargetBalances this is a tightening, but a forged EMPTY
      // list from a public caller would switch the fence off for the hand-recording path, so it is read
      // only from an internal caller.
      expectedTaxIdentities: isInternal ? options?.expectedTaxIdentities : undefined,
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

    // o3d-67y: release the refunded units' stock reservation immediately, for
    // timeliness. Run this BEFORE the fallible accounting queueing below so a throw
    // there cannot bypass it (Codex review). DURABILITY does not depend on this call
    // or on its activity-log warning (logActivity swallows write failures): a backstop
    // row was enqueued INSIDE the refund transaction
    // (scheduleRefundReservationReleaseOutbox), and the refund-reservation-release cron
    // re-runs allocation idempotently if this immediate attempt was bypassed or lost.
    // The allocator nets refunded qty (kit/BOM aware) and re-reserves only remaining
    // demand; refuseIfShipmentsExist makes it a no-op once any shipment exists (the
    // shipment build caps shippable qty net of refunds). Limited to PROCESSING/ALLOCATED
    // so a refund can't promote a DRAFT/PENDING_PAYMENT order to ALLOCATED.
    await releaseReservationsAfterRefund(
      { orderId, refundId: refundResult.createdRefund?.id, eligible: refundResult.releaseEligible === true },
      {
        // The dynamic import lives INSIDE the guarded closure so a module-load/eval rejection is
        // caught by releaseReservationsAfterRefund rather than bubbling to createRefund's outer
        // catch, which would report success:false for an ALREADY-COMMITTED refund.
        allocate: async (id) => {
          const { autoAllocateOrder } = await import('./allocation')
          const { resolveRefundReservationReleaseOutbox } = await import('@/lib/domain/sales/refund-reservation-release-outbox')
          return autoAllocateOrder(id, {
            internalBypassToken: INTERNAL_ACTION_BYPASS,
            refuseIfShipmentsExist: true,
            // o3d-67y (Codex r11): resolve the durable backstop ATOMICALLY with the reservation mutations. The
            // committed allocation and the outbox SUCCEEDED write share one transaction, so a crash cannot leave
            // the row pending for a redundant, non-idempotent re-allocation. Runs on the committed path only; a
            // refuse/bail leaves the row PENDING for the drain to retry.
            onReconciledInTx: async (tx) => {
              await resolveRefundReservationReleaseOutbox(refundResult.createdRefund.id, { client: tx })
            },
          })
        },
        log: logActivity,
      },
    )

    // o3d-67y (Codex r8): an unmatched external refund quantity (positive-qty sale line with no persisted
    // sales-order-line link) cannot be released — allocation ignores it — but the order still holds a
    // reservation a later shipment could dispatch. Surface it so an operator reconciles it manually.
    if (refundResult.releaseUnmatchedAnomaly) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'refund_reservation_release_unmatched',
        tag: 'sales',
        level: 'WARNING',
        description: `Refund on order ${refundResult.refundOrderRef} includes a quantity line that is not linked to any order line, so its stock reservation could not be released automatically. Reconcile the reservation manually — a later shipment could otherwise include the refunded quantity.`,
        metadata: {
          orderNumber: refundResult.refundOrderRef,
          refundId: refundResult.createdRefund.id,
          reason: 'unmatched_refund_line',
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

    // Propagate the refund to a WMS the order was already pushed to. The push sweep drives
    // the automatic side: a full refund cancels the WMS order while it is still NEW; a
    // partial refund's reduced line quantities are reconciled while NEW. Past NEW the WMS
    // can no longer be cancelled/amended via API, so here we (a) drop an operator-facing
    // comment on the WMS order itself so the warehouse sees the refund, and (b) keep the IMS
    // activity-log breadcrumb for partial refunds. Only for newly-created refunds (not
    // idempotent replays), best-effort so a transient failure can't fail a committed refund.
    if (!refundResult.replayed) {
      try {
        const wmsLink = await db.wmsOrderPushLink.findUnique({
          where: { orderId },
          select: { state: true, connector: true, externalOrderId: true },
        })
        if (wmsLink?.state === 'SYNCED') {
          const isFull = refundResult.newStatus === 'REFUNDED'
          // A partial refund only affects WMS fulfilment when it reduces a sale line's
          // quantity; amount-only partials (shipping / discount / goodwill) leave demand
          // unchanged, so they need no WMS amendment, note, or operator query.
          const reducesFulfilment = refundResult.createdRefundLines.some(
            (line) => line.lineKind === 'sale' && line.qty > 0,
          )
          if (isFull || reducesFulfilment) {
            const orderRef = refundResult.so.orderNumber ?? orderId
            const creditNote = refundResult.creditNoteNumber

            if (!isFull) {
              await logActivity({
                entityType: 'SALES_ORDER',
                entityId: orderId,
                action: 'wms_amendment_query_required',
                tag: 'sync',
                level: 'WARNING',
                description: `Partial refund on order ${orderRef} already sent to ${wmsLink.connector} — line quantities are auto-amended in the WMS while the order is still NEW; if it has progressed past NEW, raise a line-item cancellation query in the WMS for the refunded items.`,
                metadata: { connector: wmsLink.connector, creditNoteNumber: creditNote },
              })
            }

            if (wmsLink.externalOrderId && isWmsConnectorId(wmsLink.connector)) {
              const connector = getWmsConnector(wmsLink.connector)
              if (connector.addOrderComment) {
                const comment = isFull
                  ? `IMS: Order fully refunded (credit note ${creditNote}). If not yet dispatched it will be cancelled automatically; if already in progress please treat this as a cancellation request / raise a cancellation query.`
                  : `IMS: Partial refund (credit note ${creditNote}). Line quantities have been reduced — if the order is still amendable the items are updated automatically; otherwise please raise a line-item cancellation query for the refunded items.`
                // q66in.4.6 audit timeline (Codex r1): the refund note is a WMS
                // mutation outside the order-push sweep, so it records here.
                try {
                  await connector.addOrderComment(wmsLink.externalOrderId, comment)
                  await recordWmsMutationEvent({
                    connector: wmsLink.connector, direction: 'OUTBOUND', action: 'order_comment', outcome: 'SUCCEEDED',
                    entityType: 'SALES_ORDER', entityId: orderId, externalId: wmsLink.externalOrderId,
                    summary: `Refund note (credit note ${creditNote}) posted on WMS order ${orderRef}`,
                    after: { comment },
                    triggeredBy: 'refund',
                  })
                } catch (commentError) {
                  await recordWmsMutationEvent({
                    connector: wmsLink.connector, direction: 'OUTBOUND', action: 'order_comment', outcome: 'FAILED',
                    entityType: 'SALES_ORDER', entityId: orderId, externalId: wmsLink.externalOrderId,
                    summary: `Failed to post refund note (credit note ${creditNote}) on WMS order ${orderRef}`,
                    after: { comment },
                    error: commentError instanceof Error ? commentError.message : 'WMS comment failed',
                    triggeredBy: 'refund',
                  })
                  throw commentError
                }
              }
            }
          }
        }
      } catch (wmsNotifyError) {
        console.error(wmsNotifyError)
      }
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
      // o3d-7yf: externalRefundId is globally unique, so this conflict may be a CROSS-ORDER race — the
      // winning refund could belong to a different order. Only report idempotent success when the existing
      // refund is on THIS order; otherwise the loser would be marked synced while its refund lives elsewhere.
      const winner = await db.salesOrderRefund.findFirst({ where: { externalRefundId: options.externalRefundId }, select: { orderId: true } })
      if (winner && winner.orderId !== orderId) {
        return { success: false, error: `A refund with external id ${options.externalRefundId} already exists on a different order; refusing to dedupe it here.` }
      }
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
  // o3d-w00 (Codex r8 #3): `manualResolutionRequired` distinguishes an error the next poll can clear
  // (a Xero outage, an unjournaled shipment) from one it cannot — the posted-VAT fence refusing to
  // unwind the invoice at a rate the order never charged, which stands until an admin fixes the tax
  // configuration. The poller must not hold paidAt on the second kind.
): Promise<{ raised: boolean; reason?: string; error?: string; manualResolutionRequired?: boolean }> {
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
      // o3d-y14 r3 finding 1: the credit note mirrors WHAT THE INVOICE POSTED, so the discount
      // resolution needs the order's currency, its restatement record and its invoice link.
      currency: true,
      discountRestatement: true,
      accountingInvoiceId: true,
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
  //
  // TWO INDEPENDENT FIXES OF THIS PARAGRAPH LANDED IN THE SAME MERGE, AND BOTH SURVIVE. They ask
  // DIFFERENT questions about the same posted document and neither answers the other's:
  //
  //   • HOW MUCH did the document discount?  o3d-y14, `resolvePostedOrderDiscount` below. The
  //     backfill rewrites `discountAmount` on legacy orders whose invoices already posted, so the
  //     live column is not evidence of what the document charged.
  //   • WHERE did that discount line go?     o3d-356o, `decideChargebackDiscountLine` further down.
  //     The credit-note builder takes its account code from the LIVE setting, so a discount posted
  //     to an account that has since been changed or cleared cannot be reversed where the debit
  //     went, whatever the amount is.
  //
  // Reading the amount correctly does not make the account right, and vice versa; each module stays
  // the single definition of its own question rather than one growing a hand-spelt copy of the other.
  //
  // o3d-y14 r3 finding 1: THE FIGURE MIRRORED MUST BE THE ONE THE INVOICE POSTED, not the one the
  // order carries now — and where those two cannot be reconciled automatically, no credit note is
  // raised at all.
  //
  // The o3d-y14 backfill rewrites `discountAmount` on legacy WooCommerce orders whose invoices are
  // already in the ledger. On such an order the live column says what the order SHOULD have said,
  // while the document this credit note reverses charged the old, larger figure — so building the
  // reversal from the live column omits the invoice's discount leg and over-reverses AR and revenue
  // by the cleared amount. That is the defect. `resolvePostedOrderDiscount` recovers what the
  // document actually charged from the mirrored AccountingEvent — replaying the connector's own
  // line-omission rule over the payload the mirror recorded, because the mirror records what IMS
  // ENQUEUED and Xero omits the discount line when no discount account was configured (see that
  // module for that derivation, and for why the sync log, the ActivityLog marker and the batch
  // stamp are all unusable here).
  //
  // WHY A DISAGREEMENT IS A REFUSAL RATHER THAN "USE THE POSTED FIGURE". Because the backfill's own
  // output puts every one of these orders on an operator's must-fix list: the posted document
  // understates and needs a manual credit/adjustment in the accounting system. Whether that
  // adjustment has been made is invisible from IMS — it happens in Xero/QuickBooks, and neither the
  // order nor the mirror records it. Before it, the ledger holds the posted figure and mirroring
  // that is right; after it, the ledger holds the corrected figure and mirroring the posted one
  // under-reverses by the same amount. Both candidate credit notes are wrong in one of the two
  // worlds, and nothing available here says which world this is. So the order joins the cases this
  // path already refuses for exactly this reason — prior refunds, no discount account — and a human
  // raises it with the invoice in front of them. The refusal names BOTH figures so they can.
  //
  // Orders whose posted document AGREES with the column (every order the backfill never touched,
  // including all native and pre-column ones, which short-circuit before the lookup) are unaffected.
  const postedDiscount = await resolvePostedOrderDiscount(db, {
    id: orderId,
    currency: order.currency,
    discountAmount: decimalToNumber(order.discountAmount),
    discountRestatement: order.discountRestatement,
    accountingInvoiceId: order.accountingInvoiceId,
  })
  const discountDecision = decideChargebackOrderDiscount({
    posted: postedDiscount,
    orderDiscountAmount: decimalToNumber(order.discountAmount),
  })
  if (discountDecision.action === 'MANUAL') {
    const orderRef = order.orderNumber ?? order.externalOrderNumber ?? orderId
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'chargeback_requires_manual_handling',
      tag: 'accounting',
      level: 'WARNING',
      description:
        discountDecision.reason === 'RESTATED_AFTER_POSTING'
          ? `Payment reversed on order ${orderRef}, whose order-level discount was restated after its invoice posted: the ledger document charged ${discountDecision.postedAmount} ${order.currency} and the order now carries ${discountDecision.orderAmount} ${order.currency} (${discountDecision.detail}). Auto-chargeback skipped — reversing the order's figure over-credits the difference, and reversing the posted figure under-credits it if the manual ledger adjustment for this order has already been made. Raise the credit note manually against the document as it stands.`
          : `Payment reversed on order ${orderRef}, but the order-level discount the invoice actually posted could not be established (${discountDecision.detail}) — auto-chargeback skipped; raise the credit note manually against the posted invoice.`,
      metadata: {
        reason: discountDecision.reason,
        detail: discountDecision.detail,
        currentOrderDiscount: discountDecision.orderAmount,
        postedOrderDiscount: discountDecision.postedAmount,
        documentType: discountDecision.documentType,
        externalId: discountDecision.externalId,
      },
      resolveUser: false,
    })
    return {
      raised: false,
      reason:
        discountDecision.reason === 'RESTATED_AFTER_POSTING'
          ? 'the order-level discount was restated after the invoice posted — manual chargeback required'
          : 'the posted order-level discount could not be established — manual chargeback required',
    }
  }
  // Past this point the posted document and the order agree (or nothing has posted), so the two
  // readings are interchangeable and the figure below is both.
  const mirroredDiscount = discountDecision.amount

  let discountInput: { totalBase: number } | undefined
  if (mirroredDiscount > 0) {
    // o3d-356o's question, asked only once the amount above is settled. `orderDiscountAmount` is
    // the POSTED figure, not the order's column: this decision is about the document being
    // reversed, and passing the live column here would reintroduce exactly the substitution the
    // block above exists to prevent.
    const cbSettings = await getAccountingSettings().catch(() => null)
    const postedDiscountLine = await readPostedSalesInvoiceDiscountForOrder(db.accountingEvent, orderId)
    const accountDecision = decideChargebackDiscountLine({
      orderDiscountAmount: mirroredDiscount,
      configuredDiscountAccount: cbSettings?.discountAccount,
      posted: postedDiscountLine,
    })
    if (accountDecision.action !== 'mirror-discount') {
      // BOTH non-mirror verdicts are refusals HERE, and `no-discount-line` is a refusal rather than
      // "credit the full goods" precisely because the amount question is already answered. Its two
      // ordinary causes cannot reach this point: an order with no discount fails the guard above,
      // and a Xero invoice that omitted the line resolves to 0 above and fails it too. What is left
      // is a genuine DISAGREEMENT between the two reads about one document — the QuickBooks shape,
      // where the adapter posts the discount line on amount alone while this reader requires an
      // account code, so the document carries a discount whose account nobody here can name. That is
      // the one case where crediting the full goods value would be a guess, so it goes to a human.
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'chargeback_requires_manual_handling',
        tag: 'accounting',
        level: 'WARNING',
        description: `Payment reversed on order ${order.orderNumber ?? order.externalOrderNumber ?? orderId} carrying an order-level discount, but ${accountDecision.reason} — auto-chargeback skipped; raise the credit note manually.`,
        resolveUser: false,
      })
      return { raised: false, reason: `order-level discount: ${accountDecision.reason} — manual chargeback required` }
    }
    // Convert to the NET (ex-VAT) basis the credit note posts on (lineAmountsIncludeTax
    // is false). discountAmount is stored in the order's inclusive/exclusive convention,
    // so strip VAT when the order is tax-inclusive, then to base currency.
    const fxRate = decimalToNumber(order.fxRateToBase) || 1
    const vatPct = decimalToNumber(order.taxRatePercent)
    // The posted figure uses the SAME convention as the column it replaces — the invoice payload is
    // built from `SalesOrder.discountAmount` verbatim (queueSalesInvoiceForOrder), in the order's
    // currency and its inclusive/exclusive convention — so only the number changes here, never the
    // arithmetic applied to it.
    const discountForeignNet = order.pricesIncludeVat && vatPct > 0
      ? mirroredDiscount / (1 + vatPct)
      : mirroredDiscount
    discountInput = { totalBase: discountForeignNet / fxRate }
  } else if (postedDiscount.source === 'POSTED_DOCUMENT') {
    // o3d-356o's `no-discount-line` outcome, reached now by the recovered AMOUNT rather than by the
    // live setting: the document charged the full goods value, so the credit note must reverse the
    // full goods value. Mirroring a discount line here would under-credit by it.
    //
    // The condition is read off the DOCUMENT, never off `order.discountAmount`. It is the same rule
    // the block above enforces and the r3 structural test pins: once the posted figure is resolved,
    // the live column is not evidence of anything here — an order the backfill corrected carries a
    // discount the invoice never charged, so branching on the column would log this the wrong way
    // round on exactly the orders o3d-y14 exists for.
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'chargeback_discount_line_omitted',
      tag: 'accounting',
      level: 'INFO',
      description: `Chargeback for order ${order.orderNumber ?? order.externalOrderNumber ?? orderId} omits the order-level discount line: the posted ${postedDiscount.documentType} carried no order-level discount (${postedDiscount.detail}).`,
      resolveUser: false,
    })
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
  // o3d-6oyu.18: the refund transaction refused the chargeback because a refund for this
  // order committed between the prior-refund pre-check above and the refund transaction —
  // a WooCommerce refund webhook landing in the same poll cycle, whose row was still
  // UNCOMMITTED (and so invisible) when this function read. The WC path WON the race and
  // owns the revenue reversal; raising a second credit note is exactly what must not
  // happen. Record the same manual-handling warning the pre-check raises and return a
  // clean no-op — NOT an error, which would make the poller hold paidAt and re-attempt a
  // chargeback that can now never succeed.
  if (result.conflict === 'prior-refund') {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'chargeback_requires_manual_handling',
      tag: 'accounting',
      level: 'WARNING',
      description: `Payment reversed on order ${order.orderNumber ?? order.externalOrderNumber ?? orderId} but a refund was recorded concurrently — auto-chargeback skipped (remaining balance is ambiguous); raise the credit note manually. ${result.error ?? ''}`.trim(),
      resolveUser: false,
    })
    return { raised: false, reason: 'order has prior refunds — manual chargeback required' }
  }
  // A surfaced accounting warning means the refund row was created but its
  // credit-note / reversal staging did not fully complete. Treat it as an error so
  // the payment poller logs the failure and leaves paidAt set, rather than silently
  // advancing as if the chargeback fully posted — the existing-chargeback pre-check
  // would otherwise block any further automatic attempt. The refund's
  // accountingRetryRequired flag still drives the refund-accounting retry sweep that
  // re-queues the failed credit note.
  if (result.warning) return { raised: false, error: result.warning }
  // o3d-w00 (Codex r8 #3): the posted-VAT fence refused the reversal — deliberate, non-transient, and
  // already recorded on the order by the activity log below. Say so, so the poller reconciles payment
  // truth and alerts finance on the first failure instead of holding paidAt against a poll that can
  // never succeed on its own.
  if (result.quarantine) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'chargeback_requires_manual_handling',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `Payment reversed on order ${order.orderNumber ?? order.externalOrderNumber ?? orderId} but the ` +
        `revenue unwind was refused: ${result.error ?? ''} Raise the credit note manually, or restore the ` +
        'tax mapping and re-run the payment poller.',
      resolveUser: false,
    })
    return { raised: false, error: result.error, manualResolutionRequired: true }
  }
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
      // o3d-w00 (Codex r8 #4): the retry is a route into a credit note in its own right, so it re-asks
      // both questions — will one post at all, and is the identity each line snapshotted still worth
      // the VAT the money bore — against the tax table as it stands now.
      creditNotePostingEnabled: await isAccountingSyncTypeEnabled('CREDIT_NOTE'),
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

    // o3d-2sm1: THE STATEMENT THAT CLEARS THE ACCOUNTING INVARIANT'S ONLY BOUND.
    //
    // In the binary that precedes this one, this write ran on rows whose reversals had been staged
    // and lost: the retry read the nulled deferral as "nothing was owed", reported success having
    // queued nothing, and this statement then erased the last mark that anything was outstanding —
    // taking the row outside `where: { accountingRetryRequired: true }` for good.
    //
    // It is safe HERE because `retrySalesOrderRefundAccounting` refuses both `staged-never-recorded`
    // and `undecidable` before it can return success, so every path that reaches this line has a
    // recorded sync list behind it. It is NOT safe in the predecessor, and nothing in this branch
    // makes it so — a rule in the database would have to span the release window, which is where
    // three attempts at one came apart. That is a deployment change and it is filed as o3d-2sm1.1.
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
    const session = await requirePermission('sales.create')

    // o3d-5r8: read the guards, release the allocations and delete the row under ONE
    // order-row lock. A hard delete destroys the only IMS handle on anything a posting
    // worker has put (or is about to put) in an external system, so the deletability
    // check must serialise with those workers' claims — the accounting queue row, and
    // the WMS push link the push sweep now claims before it calls the WMS. Checking in
    // one transaction and deleting in another leaves precisely the window a worker needs
    // to claim the order between the two.
    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, id)
      const so = await tx.salesOrder.findUnique({
        where: { id },
        select: {
          orderNumber: true,
          externalOrderNumber: true,
          status: true,
          shipFromWarehouseId: true,
          revenueDeferredDate: true,
          inventoryAllocatedDate: true,
          revenueDeferredBatchRef: true,
          inventoryAllocatedBatchRef: true,
          lines: { select: { productId: true, qty: true } },
          _count: { select: { refunds: true, payments: true } },
        },
      })
      if (!so) return { error: 'Order not found' }
      if (!['DRAFT', 'PENDING_PAYMENT', 'ALLOCATED'].includes(so.status)) return { error: 'Only draft, pending payment, or allocated orders can be deleted' }
      if (so._count.refunds > 0 || so._count.payments > 0) return { error: 'Cannot delete an order with refunds or payments' }

      const blocker = await findSalesOrderDeleteBlocker(tx, id, {
        revenueDeferredDate: so.revenueDeferredDate,
        inventoryAllocatedDate: so.inventoryAllocatedDate,
        // o3d-0qoo: the exact batch ids this order was staged into, so the guard matches a
        // batch by identity instead of re-deriving one from the stamps above.
        revenueDeferredBatchRef: so.revenueDeferredBatchRef,
        inventoryAllocatedBatchRef: so.inventoryAllocatedBatchRef,
      })
      if (blocker) return { error: blocker.message }

      // o3d-6zr2: the pending-shipment retirement record is written through the transaction client,
      // which cannot resolve a session, so the acting user has to be handed down from the action
      // boundary. Without it, a draft shipment (and its tracking number) retired by an operator's
      // delete was attributed to nobody.
      const released = await releaseOrderAllocationsInTx(tx, id, {
        cause: 'deleting the sales order',
        userId: session.user.id,
        // o3d-0i5y r10: the order does not survive this transaction, so a reversal journal keyed to
        // it would resolve to nothing. The teardown refuses a posted A2 debit here rather than
        // orphaning the journal or stranding the debit — see releaseOrderAllocationsInTx.
        orderIsBeingDeleted: true,
      })
      await tx.salesOrderLine.deleteMany({ where: { orderId: id } })
      await tx.salesOrder.delete({ where: { id } })
      return { so, released }
    }, { maxWait: 5000, timeout: 20000 })

    if ('error' in outcome) return { success: false, error: outcome.error }
    const { so, released } = outcome

    // Post-commit side effects: the stock sync mirrors the released reservations to the
    // storefront. Never fail the (already committed) delete on a sync error.
    try {
      const syncTargets = [...new Set(released.allocations.map((alloc) => alloc.productId))]
      if (syncTargets.length > 0) await enqueueStockSync(syncTargets, 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }
    if (released.clampedReservationCount > 0) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: id,
        action: 'negative_reserved_qty_clamped',
        tag: 'inventory',
        level: 'WARNING',
        description: `Clamped ${released.clampedReservationCount} negative reservation balance(s) while deleting sales order ${getSalesOrderReference({ id, ...so })}`,
        metadata: { orderNumber: getSalesOrderReference({ id, ...so }), clampedReservationCount: released.clampedReservationCount },
      })
    }

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
      await lockSalesOrder(tx, id)
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
      await lockSalesOrder(tx, id)
      const so = await tx.salesOrder.findUnique({
        where: { id },
        select: {
          externalOrderNumber: true,
          orderNumber: true,
          invoiceNumber: true,
          shoppingLinks: { select: { connector: true } },
        },
      })
      if (!so) throw new Error('Order not found')
      if (so.invoiceNumber) return { invoiceNumber: so.invoiceNumber, orderNumber: getSalesOrderReference({ id, ...so }) }
      // o3d-k26m.1: for a storefront that supplies its own invoice number, this column is where
      // that number is recorded — minting into it posts the order to the ledger under a number
      // the customer's invoice does not carry, and blocks the backfill that would have captured
      // the real one. Refuse rather than fill the gap. Returned as a plain refusal, not thrown:
      // the on-shipped trigger calls this for every order and a WooCommerce order having no IMS
      // number is the normal case, not a failure to log.
      if (invoiceNumberIsExternallySupplied(so.shoppingLinks.map((l) => l.connector))) {
        return { externallySupplied: true as const, orderNumber: getSalesOrderReference({ id, ...so }) }
      }
      const invNum = await nextDocumentNumber(tx, {
        key: 'invoice',
        prefix: numbering.inv_prefix,
      })
      await tx.salesOrder.update({ where: { id }, data: { invoiceNumber: invNum, invoicedAt: new Date() } })
      return { invoiceNumber: invNum, orderNumber: getSalesOrderReference({ id, ...so }) }
    })
    if ('externallySupplied' in result) {
      return {
        success: false,
        error: `Order ${result.orderNumber} takes its invoice number from the storefront (WooCommerce PDF Invoices). IMS will not generate one — the number appears once WooCommerce has created the invoice.`,
      }
    }
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
      await lockSalesOrder(tx, input.orderId)
      const so = await tx.salesOrder.findUnique({
        where: { id: input.orderId },
        select: {
          id: true,
          orderNumber: true,
          externalOrderNumber: true,
          status: true,
          refundStatus: true,
          currency: true,
          totalForeign: true,
          totalBase: true,
          fxRateToBase: true,
          paidAt: true,
          invoiceNumber: true,
        },
      })
      if (!so) return { error: 'Order not found' }
      if (so.status === 'CANCELLED' || so.refundStatus === 'FULL') {
        return { error: `Cannot add payments to ${so.refundStatus === 'FULL' ? 'fully refunded' : so.status.toLowerCase()} orders` }
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
      await registerInvoicePaymentWithLedger({
        orderId: input.orderId,
        orderReference: getSalesOrderReference(txResult.so),
        paymentId: txResult.paymentId,
        amount: input.amount,
        currency: input.currency,
        method: input.method || null,
        reference: input.reference || null,
        paidAt: txResult.paidAt,
      })
    }

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

/**
 * o3d-1vuv: a refusal raised from INSIDE a payment transaction.
 *
 * IT MUST THROW, NOT RETURN. Returning from a Prisma interactive transaction COMMITS it — so a
 * refusal that `return`s after the retirement updateMany has already run would leave those
 * registrations CANCELLED while telling the operator nothing was changed: some of a receipt's
 * ledger registrations retired, the receipt itself still there, and no record of the half-write.
 * Throwing is what makes "nothing was changed" true, and the two callers translate it back into
 * their own typed refusal at the boundary.
 */
class PaymentTransactionRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PaymentTransactionRefusal'
  }
}

/**
 * The INVOICE_PAYMENT registrations that NAME this receipt.
 *
 * o3d-1vuv: the query deliberately admits a row in ANY status that carries a document id, not just
 * the live ones. The remote call is made BEFORE the result is written back (o3d-ju8t), so a FAILED
 * registration can sit in front of a real payment in the ledger — and post evidence outranks status
 * everywhere else in this codebase, so it must here too.
 *
 * AND IT ADMITS FAILED ROWS THAT CARRY NO DOCUMENT ID. Those are the ones the previous version could
 * not see, and not seeing them was the whole defect: the splitter classifies what it is given, so a
 * status the query omits is silently classified as "no registration exists" — the permissive answer.
 * The status list therefore comes from READABLE_REGISTRATION_STATUSES, alongside the classification
 * it feeds, so the two cannot drift apart again.
 *
 * Matching is by the payload's own paymentId and never by amount: an imported paid order carries a
 * perfectly legitimate INVOICE_PAYMENT with no local Payment row behind it, and a row that names no
 * payment is nobody's to retract (Codex, PR #582 round 2).
 */
async function readPaymentRegistrations(
  client: Pick<typeof db, 'accountingSyncLog'>,
  orderId: string,
  paymentId: string,
): Promise<PaymentRegistrationRow[]> {
  const rows = await client.accountingSyncLog.findMany({
    where: {
      type: PAYMENT_REGISTRATION_TYPE,
      referenceType: 'SalesOrder',
      referenceId: orderId,
      OR: [
        { status: { in: [...READABLE_REGISTRATION_STATUSES] } },
        { externalTransactionId: { not: null } },
      ],
    },
    // o3d-anu8: settlementBasis, because a CANCELLED row carrying a document id is written by TWO
    // things — a VERIFIED reversal (buildVerifiedReversalData, Xero said DELETED) and an operator
    // asserting the document exists on a cancelled sale. This column is the only difference between
    // them, and `registrationLedgerStanding` draws opposite conclusions from the two.
    select: { id: true, connector: true, status: true, externalTransactionId: true, settlementBasis: true, payload: true },
  })
  return rows
    .filter((row) => payloadPaymentId(row.payload) === paymentId)
    .map(({ id, connector, status, externalTransactionId, settlementBasis }) => (
      { id, connector, status, externalTransactionId, settlementBasis }
    ))
}

/**
 * Remove the Payment row and settle paidAt. ONE implementation, shared by the ordinary delete and by
 * the verified ledger reversal, so the two cannot disagree about when an order stops being paid.
 */
async function removePaymentAndSettlePaidAt(
  tx: Prisma.TransactionClient,
  input: {
    paymentId: string
    orderId: string
    refundId: string | null
    currency: string
    totalForeign: unknown
    paidAt: Date | null
  },
): Promise<boolean> {
  await tx.payment.delete({ where: { id: input.paymentId } })
  if (input.refundId) return false
  const remainingPayments = await tx.payment.findMany({
    where: { orderId: input.orderId, refundId: null },
    select: { amount: true, currency: true },
  })
  const totalPaid = remainingPayments.reduce((sum, p) => {
    if (p.currency !== input.currency) return sum
    return sum + Number(p.amount)
  }, 0)
  const stillFullyPaid = totalPaid >= Number(input.totalForeign) - 0.0001
  // Only a genuine paid → not-paid transition is a mismatch. An order that was never fully paid
  // (e.g. shipped on credit terms) isn't flagged just because a partial payment was removed.
  const becameUnpaid = input.paidAt !== null && !stillFullyPaid
  await tx.salesOrder.update({
    where: { id: input.orderId },
    data: { paidAt: stillFullyPaid ? undefined : null },
  })
  return becameUnpaid
}

export type DeletePaymentResult = { success: boolean; error?: string; code?: PaymentDeleteRefusalCode }

/**
 * Delete a locally-recorded receipt — and REFUSE while the accounting system still holds a payment
 * for it (o3d-1vuv).
 *
 * WHAT CHANGED, AND WHY IT IS A REFUSAL RATHER THAN A LOUDER WARNING.
 *
 * This used to succeed whatever state the INVOICE_PAYMENT registration was in: it deleted the local
 * Payment, cleared paidAt, and logged `payment_external_reversal_required` — a WARNING asking
 * somebody to reverse the payment in the connector by hand. The ledger went on showing the invoice
 * settled. PR #582 made that visible as LEDGER_UNMATCHED; visible is not resolved, and a wrong
 * figure in a real ledger is worse than a refusal.
 *
 * THE REFUSAL HAS A REMEDY, which is the part that was missing: reverseLedgerPayment below, which
 * confirms with the accounting system that the payment really is gone before removing anything here.
 *
 * THE CHECK MOVED INSIDE THE TRANSACTION, and that is not cosmetic. The registration read and the
 * retirement used to happen AFTER the Payment was already deleted, so a worker claiming the queued
 * row in that window left the receipt deleted and the payment posting — the previous code could only
 * report that afterwards. Now the retirement is compare-and-swapped in the SAME transaction as the
 * delete, so a claim in the window ABORTS the delete instead of stranding a posted payment.
 */
export async function deletePayment(paymentId: string, orderId: string): Promise<DeletePaymentResult> {
  try {
    await requirePermission('sales.refund')
    const txResult = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
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

      // A refund payment settles a CREDIT NOTE, not this invoice, and is registered by a different
      // path — so it has no INVOICE_PAYMENT registration to hold it back.
      if (!payment.refundId) {
        const registrations = await readPaymentRegistrations(tx, orderId, paymentId)
        const { retirable, ledgerHold, undecided } = splitPaymentRegistrations(registrations)
        if (ledgerHold.length > 0) {
          const refusal = describeLedgerHoldRefusal(ledgerHold, getSalesOrderReference(so))
          throw new PaymentTransactionRefusal(refusal.code, refusal.message)
        }
        // AFTER the ledger hold, because a row that names a document is the more useful thing to
        // report: it tells the operator which payment to go and look at. An undecided attempt names
        // none, and refuses on its own account — a FAILED registration is not proof that nothing was
        // posted, and this is the delete that used to go through on exactly that assumption.
        if (undecided.length > 0) {
          const refusal = describeAttemptUndecidedRefusal(undecided, getSalesOrderReference(so))
          throw new PaymentTransactionRefusal(refusal.code, refusal.message)
        }
        if (retirable.length > 0) {
          // CANCELLED rather than deleted, because that is the retirement the processor already
          // understands — it re-reads the live status after claiming and treats CANCELLED as an
          // intentional no-op — and it leaves the audit trail intact.
          const retired = await tx.accountingSyncLog.updateMany({
            where: { id: { in: retirable.map((row) => row.id) }, status: { in: [...RETIRABLE_REGISTRATION_STATUSES] } },
            data: { status: 'CANCELLED', errorMessage: 'Retired: the local payment it registered was deleted.' },
          })
          // A row that did NOT transition was claimed by a worker between the read and this write, so
          // it may be posting right now. Abort — the whole transaction rolls back and the receipt
          // stays. This is the window the old post-transaction retirement could only report on.
          if (retired.count !== retirable.length) {
            // THROWN, so the rows that DID transition roll back with it. Returning here would commit
            // a partial retirement under a message that says nothing was changed.
            throw new PaymentTransactionRefusal(REGISTRATION_IN_FLIGHT_REFUSAL.code, REGISTRATION_IN_FLIGHT_REFUSAL.message)
          }
        }
      }

      const becameUnpaid = await removePaymentAndSettlePaidAt(tx, {
        paymentId,
        orderId,
        refundId: payment.refundId,
        currency: so.currency,
        totalForeign: so.totalForeign,
        paidAt: so.paidAt,
      })
      return { so, becameUnpaid }
    }, STOCK_TX_OPTIONS)
    if ('error' in txResult) return { success: false, error: txResult.error }
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
    // A refusal is a decision, not a fault: it must not be logged as an ERROR and must keep its code.
    if (e instanceof PaymentTransactionRefusal) {
      return { success: false, error: e.message, code: e.code as PaymentDeleteRefusalCode }
    }
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

export type ReverseLedgerPaymentResult =
  | { success: true }
  | { success: false; error: string; code: LedgerReversalRefusalCode }
  | FreshAuthFailureResult

/**
 * o3d-1vuv — THE REVERSAL PATH the warning used to stand in for.
 *
 * WHAT THE OPERATOR DOES, AND WHAT THIS ASSERTS ON THEIR BEHALF: nothing. They reverse the payment
 * in the accounting system — where the authority over that ledger lives, and where the reversal may
 * need a date, an unallocation or a bank-rec decision IMS has no business making — and then ask IMS
 * to let the local receipt go. IMS does NOT take their word for it. It ASKS XERO whether that
 * payment is really gone, and refuses BY NAME when the answer is anything but DELETED.
 *
 * WHY VERIFICATION IS NOT OPTIONAL HERE, unlike the operator assertions elsewhere in this codebase.
 * settlementStatus reads a PENDING/PROCESSING/SYNCED registration as "the ledger holds a payment"
 * and CANCELLED as holding nothing. Retiring the row on an unchecked claim would turn a real
 * LEDGER_UNMATCHED discrepancy into a plain, undiscrepant UNPAID — it would delete the ALARM rather
 * than the cause, and a mistaken claim would then never be contradicted by anything. An assertion is
 * only acceptable where the fact cannot be computed, and this one can: the row already carries the
 * Xero PaymentID, and one GET settles it.
 *
 * WHAT IS DELIBERATELY NOT BUILT HERE. IMS does not perform the reversal itself (the issue's option
 * 2). That is a WRITE to the ledger and belongs with the connector's own posting machinery in
 * lib/connectors/xero/sync-processor.ts and lib/domain/accounting/payment-reversal.ts — both of
 * which branch o3d-batch-payidx is rewriting — so building it here would collide with that work
 * rather than complement it. This is the read-only half, which needs none of it and is complete on
 * its own: the operator can always finish the job, and IMS never destroys local state on an
 * unchecked claim.
 *
 * `assertedPaymentReference` — THE UNDECIDED ATTEMPT'S WAY OUT (Codex round 2, finding 3).
 *
 * A FAILED registration naming no document refuses the delete, and round 1 offered the operator two
 * branches: retry it, or "if a payment IS there, reverse it and delete this receipt". The second
 * branch was a circle. Reversing a payment in Xero changes nothing about a row that names no
 * document, so the delete refused again, with the same words, and there was nowhere else to go.
 *
 * The missing fact is small and the operator is holding it: WHICH payment. So they may name it, and
 * naming it settles nothing on its own — IMS asks Xero about that payment AND about the invoice it
 * claims to be on, and requires FIVE things of the answers before any local row is touched: the
 * payment is on THIS order's ledger invoice; that invoice is denominated in THIS receipt's currency,
 * so the figures on either side are quantities of the same money; it is for THIS receipt's amount,
 * exactly; it is DELETED; and no payment for that same amount is STILL STANDING on the invoice. A
 * mistyped reference, a payment from another invoice, an invoice in another currency, a payment that
 * is still standing, a second payment of the same value: each refused by its own name. The operator
 * supplies the question; the ledger still supplies the answer. Exactly the division
 * `recoverRefundSyncPark` draws in app/actions/sync-exceptions.ts, and the opposite of accepting
 * "I reversed it".
 */
export async function reverseLedgerPayment(
  paymentId: string,
  orderId: string,
  assertedPaymentReference?: string,
): Promise<ReverseLedgerPaymentResult> {
  try {
    // FRESH permission, unlike deletePayment's plain one. Deleting a receipt the ledger does not hold
    // is an ordinary correction; retiring a registration for a document that DID post is a statement
    // about a ledger, so it takes a session re-verified in the last 15 minutes.
    const session = await requireFreshPermission('sales.refund')

    const asserted = normalizeAssertedPaymentReference(assertedPaymentReference)

    const payment = await db.payment.findUnique({
      where: { id: paymentId },
      // `currency` because `amount` is denominated in it: an amount without its unit cannot be
      // compared with anything the ledger says, and comparing it anyway is Codex round 5's finding.
      select: { orderId: true, refundId: true, amount: true, currency: true },
    })
    if (!payment || payment.orderId !== orderId) {
      return { success: false, code: 'payment_missing', error: 'That receipt no longer exists on this order, so nothing was changed.' }
    }
    if (payment.refundId) {
      return { success: false, code: NO_LEDGER_HOLD_REFUSAL.code, error: NO_LEDGER_HOLD_REFUSAL.message }
    }
    const orderForReference = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, externalOrderNumber: true, accountingInvoiceId: true },
    })
    if (!orderForReference) {
      return { success: false, code: 'payment_missing', error: 'That order no longer exists, so nothing was changed.' }
    }

    const registrations = await readPaymentRegistrations(db, orderId, paymentId)
    const { retirable, ledgerHold, undecided } = splitPaymentRegistrations(registrations)
    // BEFORE the empty-hold check, and that order is the point. An undecided attempt puts nothing in
    // `ledgerHold`, so checking emptiness first would answer "the accounting system does not hold a
    // payment for this receipt" — a confident statement of exactly the fact nobody knows — and send
    // the operator back to the ordinary delete, which now refuses. Two contradictory answers to one
    // question is worse than either of them.
    //
    // What CAN resolve it is a payment reference the operator read off the invoice. Without one there
    // is still nothing to look up, so the refusal stands exactly as before.
    const assertedUndecided: PaymentRegistrationRow[] = []
    if (undecided.length > 0) {
      if (!asserted) {
        return { success: false, code: UNDECIDED_ATTEMPT_REVERSAL_REFUSAL.code, error: UNDECIDED_ATTEMPT_REVERSAL_REFUSAL.message }
      }
      // ONE reference cannot speak for two attempts, and guessing which it belongs to would retire a
      // row on evidence about a different one.
      if (undecided.length > 1) {
        return { success: false, code: UNDECIDED_ATTEMPTS_AMBIGUOUS_REFUSAL.code, error: UNDECIDED_ATTEMPTS_AMBIGUOUS_REFUSAL.message }
      }
      assertedUndecided.push(...undecided)
    }
    if (ledgerHold.length === 0 && assertedUndecided.length === 0) {
      return { success: false, code: NO_LEDGER_HOLD_REFUSAL.code, error: NO_LEDGER_HOLD_REFUSAL.message }
    }
    const unsupported = [...ledgerHold, ...assertedUndecided].find((row) => !(VERIFIABLE_REVERSAL_CONNECTORS as readonly string[]).includes(row.connector))
    if (unsupported) {
      const refusal = refuseUnverifiableConnector(unsupported.connector)
      return { success: false, code: refusal.code, error: refusal.message }
    }
    // A claimed registration with no document id yet: IMS asked the ledger to take this payment and
    // has not learned what happened. There is nothing to look up, so there is nothing to confirm.
    if (ledgerHold.some((row) => !hasPostEvidence(row))) {
      return { success: false, code: UNVERIFIABLE_IN_FLIGHT_REFUSAL.code, error: UNVERIFIABLE_IN_FLIGHT_REFUSAL.message }
    }

    // ASK THE LEDGER. Outside any transaction — a network call inside one holds row locks for the
    // duration of somebody else's outage.
    for (const row of ledgerHold) {
      const externalId = (row.externalTransactionId ?? '').trim()
      const response = await xeroGet<{ Payments?: Array<{ PaymentID?: string; Status?: string }> }>(
        `Payments/${encodeURIComponent(externalId)}`,
      )
      if (!response.ok) {
        const refusal = refuseLedgerLookupFailure(externalId, response.error)
        return { success: false, code: refusal.code, error: refusal.message }
      }
      const ledgerStatus = response.data?.Payments?.[0]?.Status
      if (!isReversedInLedger(ledgerStatus)) {
        const refusal = refuseLedgerStillHolds(externalId, ledgerStatus ?? 'unknown')
        return { success: false, code: refusal.code, error: refusal.message }
      }
    }

    // AND ASK ABOUT THE PAYMENT THE OPERATOR NAMED. Same GET, a heavier burden of proof: the rows
    // above were checked against a document id IMS WROTE DOWN ITSELF when the ledger returned it,
    // and this one is checked against a reference a human typed. So the answer has to establish that
    // the payment is the right one before it can establish that it is gone — anything less and the
    // remedy becomes a way to delete a receipt by naming any deleted payment in the tenant.
    const assertedReference = assertedUndecided.length > 0 ? asserted : null
    if (assertedReference) {
      const orderReference = getSalesOrderReference(orderForReference)
      // WITHOUT A LEDGER INVOICE THERE IS NOTHING TO ATTRIBUTE THE PAYMENT TO. Refused rather than
      // waved through: "it is deleted" is not evidence about THIS receipt unless it was on THIS
      // document, and an unposted invoice cannot have carried it.
      if (!orderForReference.accountingInvoiceId) {
        const refusal = refuseAssertedPaymentUnattributable(orderReference)
        return { success: false, code: refusal.code, error: refusal.message }
      }
      const ledgerInvoiceId = orderForReference.accountingInvoiceId
      const response = await xeroGet<{
        Payments?: Array<{ PaymentID?: string; Status?: string; Amount?: number; Invoice?: { InvoiceID?: string; CurrencyCode?: string } }>
      }>(`Payments/${encodeURIComponent(assertedReference)}`)
      if (!response.ok) {
        const refusal = refuseLedgerLookupFailure(assertedReference, response.error)
        return { success: false, code: refusal.code, error: refusal.message }
      }
      const found = response.data?.Payments?.[0]
      if (!found) {
        const refusal = refuseLedgerLookupFailure(assertedReference, 'the accounting system returned no payment with that reference')
        return { success: false, code: refusal.code, error: refusal.message }
      }
      // FACT ONE: it is on this order's invoice.
      const invoiceId = found.Invoice?.InvoiceID ?? null
      if (!sameLedgerIdentifier(invoiceId, orderForReference.accountingInvoiceId)) {
        const refusal = refuseAssertedPaymentNotOnInvoice(assertedReference, orderReference, invoiceId)
        return { success: false, code: refusal.code, error: refusal.message }
      }

      // WHAT IMS ITSELF HOLDS, read before the ledger is troubled a second time. Both are facts about
      // the local receipt, both can be unreadable, and neither is a question for Xero — so a receipt
      // IMS cannot state the currency or the amount of refuses here, with the invoice never asked.
      const receiptCurrency = canonicalCurrencyCode(payment.currency)
      if (receiptCurrency === null) {
        const refusal = refuseLedgerLookupFailure(assertedReference, 'IMS cannot read this receipt\'s own currency, so no ledger amount can be matched to it')
        return { success: false, code: refusal.code, error: refusal.message }
      }
      const receiptAmount = canonicalLedgerAmount(payment.amount)
      if (receiptAmount === null) {
        const refusal = refuseLedgerLookupFailure(assertedReference, 'IMS cannot read this receipt\'s own amount as a plain decimal, so no payment can be matched to it')
        return { success: false, code: refusal.code, error: refusal.message }
      }

      // THE INVOICE ITSELF, read once and used for the two facts that need it: WHAT UNIT this money is
      // in, and WHAT IS STILL STANDING on the document. Read BEFORE any number is compared — round 4
      // compared amounts first and asked the invoice afterwards, which meant the only comparison on the
      // path ran before anything had established that the two sides were even denominated alike.
      //
      // ONE EXTRA REQUEST, on the asserted path only. The rows IMS wrote document ids for never come
      // through here: their id was recorded by the processor from Xero's own response, so there is
      // nothing to disambiguate. This is the price of accepting an id a human typed.
      const invoiceResponse = await xeroGet<{
        Invoices?: Array<{ InvoiceID?: string; CurrencyCode?: string; Payments?: Array<{ PaymentID?: string; Amount?: number }> }>
      }>(`Invoices/${encodeURIComponent(ledgerInvoiceId)}`)
      if (!invoiceResponse.ok) {
        const refusal = refuseLedgerLookupFailure(ledgerInvoiceId, invoiceResponse.error)
        return { success: false, code: refusal.code, error: refusal.message }
      }
      const ledgerInvoice = invoiceResponse.data?.Invoices?.[0]
      const standingPayments = ledgerInvoice?.Payments
      // An invoice with nothing on it answers with an EMPTY LIST; a response with no list at all is a
      // question unanswered, and is refused rather than read as "nothing is standing there".
      if (!ledgerInvoice || !Array.isArray(standingPayments)) {
        const refusal = refuseLedgerLookupFailure(
          ledgerInvoiceId,
          'the accounting system did not list the payments standing on that invoice, so IMS cannot tell whether one for this receipt\'s amount is still on it',
        )
        return { success: false, code: refusal.code, error: refusal.message }
      }

      // FACT TWO: EVERY AMOUNT BELOW IS IN THE SAME UNIT AS THIS RECEIPT.
      //
      // Codex round 5's second finding, and the branch's own flag from round 4: comparing two decimal
      // strings says nothing about whether they are the same MONEY. 100 GBP and 100 EUR are the same
      // number. A Xero payment carries no currency of its own — it is denominated in ITS INVOICE'S
      // currency, which is why the invoice is the thing asked — and `payments.amount` is denominated
      // in `payments.currency`. When those two disagree, the exact comparison below is comparing
      // quantities of different things, and the standing-payment fact after it is doing the same.
      //
      // Refused rather than converted. IMS has an FX rate and could turn one into the other, but a
      // converted amount is an ESTIMATE, and an estimate is exactly what an exact comparison was
      // introduced to eliminate. A receipt whose currency does not match its invoice is a defect in
      // one of the two records, and the remedy is to correct it, not to reconcile around it.
      const invoiceCurrency = canonicalCurrencyCode(ledgerInvoice.CurrencyCode)
      if (invoiceCurrency === null) {
        const refusal = refuseLedgerLookupFailure(
          ledgerInvoiceId,
          'the accounting system did not say what currency that invoice is in, so IMS cannot tell whether the payment on it is in this receipt\'s currency',
        )
        return { success: false, code: refusal.code, error: refusal.message }
      }
      if (invoiceCurrency !== receiptCurrency) {
        const refusal = refuseAssertedPaymentCurrencyMismatch(assertedReference, orderReference, invoiceCurrency, receiptCurrency)
        return { success: false, code: refusal.code, error: refusal.message }
      }
      // AND THE PAYMENT'S OWN ACCOUNT OF ITS INVOICE, where the response gives one. It is the same
      // document, so it can only agree; a ledger that contradicts itself about the denomination of
      // this money is not a basis for deleting a receipt either. Absent, it is simply not asked — a
      // nested object that omits the field states nothing, and treating silence as disagreement would
      // make the whole remedy unreachable.
      const paymentInvoiceCurrency = canonicalCurrencyCode(found.Invoice?.CurrencyCode)
      if (paymentInvoiceCurrency !== null && paymentInvoiceCurrency !== receiptCurrency) {
        const refusal = refuseAssertedPaymentCurrencyMismatch(assertedReference, orderReference, paymentInvoiceCurrency, receiptCurrency)
        return { success: false, code: refusal.code, error: refusal.message }
      }

      // FACT THREE: it is for this receipt's amount — EXACTLY, and not within a tolerance.
      //
      // A tolerance was Codex round 3's second finding and it deserved it: `|ledger - receipt| <= 0.005`
      // admits a payment that is not even the same value, on the one path whose output deletes a
      // receipt. Both sides are reduced to canonical decimal text instead, so `100`, `100.00` and the
      // stored `Decimal(18, 4)` compare equal while `100.005` does not, and an amount neither side can
      // state as a plain decimal is refused rather than coerced into a comparison.
      //
      // AND THE AMOUNT IS A FILTER, NOT AN IDENTIFIER. Equality here only rules candidates OUT; FACT
      // FIVE is what stops a DIFFERENT payment of the same value from standing in for this receipt's.
      const ledgerAmount = canonicalLedgerAmount(found.Amount)
      if (ledgerAmount === null) {
        const refusal = refuseLedgerLookupFailure(assertedReference, 'the accounting system reported no amount for that payment, so it cannot be matched to this receipt')
        return { success: false, code: refusal.code, error: refusal.message }
      }
      if (ledgerAmount !== receiptAmount) {
        const refusal = refuseAssertedPaymentAmountMismatch(assertedReference, ledgerAmount, receiptAmount)
        return { success: false, code: refusal.code, error: refusal.message }
      }
      // FACT FOUR: it really is gone — the same test the checkable rows face, and the reason this is
      // a verification rather than an acceptance of "I have reversed it".
      if (!isReversedInLedger(found.Status)) {
        const refusal = refuseLedgerStillHolds(assertedReference, found.Status ?? 'unknown')
        return { success: false, code: refusal.code, error: refusal.message }
      }

      // FACT FIVE: NOTHING THIS PAYMENT COULD BE CONFUSED WITH IS STILL STANDING ON THE INVOICE.
      //
      // Facts one to four are all satisfied by ANY deleted payment of this value on this invoice —
      // including one that has nothing to do with this receipt. The case that costs money is exactly
      // one shape: this receipt's own payment is STILL on the invoice, the operator names a different
      // deleted payment of the same value, and IMS retires the registration and deletes the receipt
      // while the ledger goes on showing the invoice settled. Nothing local is then left to contradict
      // it, which is the state o3d-1vuv exists to make unreachable.
      //
      // That shape is visible from the invoice, so the invoice was asked. Any standing payment for this
      // receipt's amount refuses — IMS cannot tell which of the two the reference describes, and the
      // amount is the only thing it had to tell them apart with. Those amounts are in the invoice's
      // currency, which FACT TWO has already required to be this receipt's, so the comparison is
      // between two quantities of the same money.
      for (const standing of standingPayments) {
        const standingId = typeof standing?.PaymentID === 'string' ? standing.PaymentID : ''
        // The named payment itself, still listed as standing on the invoice. It contradicts the
        // DELETED status read moments ago, and the contradiction is resolved in the ledger's favour:
        // reported by the same name as any other payment the ledger still holds.
        if (sameLedgerIdentifier(standingId, assertedReference)) {
          const refusal = refuseLedgerStillHolds(assertedReference, 'still listed on that invoice')
          return { success: false, code: refusal.code, error: refusal.message }
        }
        const standingAmount = canonicalLedgerAmount(standing?.Amount)
        if (standingAmount === null) {
          const refusal = refuseLedgerLookupFailure(
            ledgerInvoiceId,
            `a payment still on that invoice${standingId ? ` (${standingId})` : ''} carries no readable amount, so IMS cannot rule out that it is the one this receipt created`,
          )
          return { success: false, code: refusal.code, error: refusal.message }
        }
        if (standingAmount === receiptAmount) {
          const refusal = refuseAssertedPaymentStillOnInvoice(assertedReference, orderReference, standingId, receiptAmount)
          return { success: false, code: refusal.code, error: refusal.message }
        }
      }
    }

    const now = new Date()
    const note = ledgerReversalNote(ledgerHold.map((row) => row.externalTransactionId ?? ''), now)

    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      const so = await tx.salesOrder.findUnique({
        where: { id: orderId },
        select: { id: true, orderNumber: true, externalOrderNumber: true, currency: true, totalForeign: true, status: true, paidAt: true },
      })
      if (!so) throw new PaymentTransactionRefusal('payment_missing', 'Order not found')
      const stillRecorded = await tx.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } })
      if (!stillRecorded || stillRecorded.orderId !== orderId) {
        throw new PaymentTransactionRefusal('payment_missing', 'That receipt no longer exists on this order, so nothing was changed.')
      }

      // THE FENCE'S OTHER HALF: a registration that APPEARED since the check. The per-row
      // compare-and-swap below can only fence rows this call already knows about, and the Xero GETs
      // above take as long as Xero takes — long enough for the processor to claim a queued sibling,
      // post it and record a failure with no document id. Deleting the receipt on top of that is the
      // same defect as before, arrived at through a race instead of a misclassification. Re-read
      // under the order lock and abandon if the answer has changed shape.
      //
      // "ACCOUNTED FOR" IS NOT "NONE". The asserted row is itself undecided and is expected to be
      // here; what must not have appeared is an undecided attempt this call never checked with the
      // ledger. Comparing by ID rather than by count, because a row that vanished and a row that
      // arrived can leave the count unchanged.
      const accountedFor = new Set(assertedUndecided.map((row) => row.id))
      const freshUndecided = splitPaymentRegistrations(await readPaymentRegistrations(tx, orderId, paymentId)).undecided
      if (freshUndecided.some((row) => !accountedFor.has(row.id))) {
        throw new PaymentTransactionRefusal(HOLD_MOVED_REFUSAL.code, HOLD_MOVED_REFUSAL.message)
      }

      // THE FENCE. Each row is compare-and-swapped on the EXACT status and document id that was
      // checked against the ledger. A row that has since been retried, re-posted or resolved carries
      // a different one, and a conclusion drawn about the payment that was there must not land on a
      // payment that is there now.
      for (const row of ledgerHold) {
        const moved = await tx.accountingSyncLog.updateMany({
          where: {
            id: row.id,
            // The domain type carries `status` as a plain string so the decision module stays free of
            // generated Prisma enums; it can only ever hold a value read off this same column.
            status: row.status as Prisma.AccountingSyncLogWhereInput['status'],
            externalTransactionId: row.externalTransactionId,
          },
          data: buildVerifiedReversalData(note),
        })
        // THROWN, so any row retired earlier in this loop rolls back with it. A `return` would commit
        // a partial retirement while reporting that nothing changed.
        if (moved.count !== 1) throw new PaymentTransactionRefusal(HOLD_MOVED_REFUSAL.code, HOLD_MOVED_REFUSAL.message)
      }
      // THE ASSERTED ROW, fenced the same way and on the ABSENCE of a document id as well as on the
      // status. A retry that posted while Xero was being asked writes an id onto this row, and that
      // id is a payment nobody has checked — the compare-and-swap misses, the whole thing rolls back,
      // and the operator is told to look again rather than told the ledger is clear.
      for (const row of assertedUndecided) {
        const reference = assertedReference as string
        const decided = await tx.accountingSyncLog.updateMany({
          where: {
            id: row.id,
            status: row.status as Prisma.AccountingSyncLogWhereInput['status'],
            externalTransactionId: null,
          },
          data: buildAssertedReversalData(
            reference,
            assertedReversalNote(reference, orderForReference.accountingInvoiceId ?? '', now),
          ),
        })
        if (decided.count !== 1) throw new PaymentTransactionRefusal(HOLD_MOVED_REFUSAL.code, HOLD_MOVED_REFUSAL.message)
      }
      if (retirable.length > 0) {
        const retired = await tx.accountingSyncLog.updateMany({
          where: { id: { in: retirable.map((row) => row.id) }, status: { in: [...RETIRABLE_REGISTRATION_STATUSES] } },
          data: { status: 'CANCELLED', errorMessage: 'Retired: the local payment it registered was deleted.' },
        })
        if (retired.count !== retirable.length) {
          // A queued sibling registration was claimed while this was being recorded. Reported as
          // hold_moved rather than as a delete refusal: from here the remedy is the same — reload and
          // look again — and the rows already retired roll back with the throw.
          throw new PaymentTransactionRefusal('hold_moved', REGISTRATION_IN_FLIGHT_REFUSAL.message)
        }
      }

      const becameUnpaid = await removePaymentAndSettlePaidAt(tx, {
        paymentId,
        orderId,
        refundId: null,
        currency: so.currency,
        totalForeign: so.totalForeign,
        paidAt: so.paidAt,
      })
      return { so, becameUnpaid }
    }, STOCK_TX_OPTIONS)

    revalidatePath(`/sales/${orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'payment_ledger_reversal_confirmed',
      tag: 'accounting',
      // WARNING, not INFO: a payment that reached a real ledger has been undone, and the row that
      // proved it is now CANCELLED. It belongs in the level-filtered accounting views.
      level: 'WARNING',
      description:
        `Deleted the receipt on ${getSalesOrderReference(outcome.so)} after confirming with the accounting `
        + `system that its payment was reversed there (${[...ledgerHold.map((row) => row.externalTransactionId), ...(assertedReference ? [`${assertedReference} — identified by the operator`] : [])].join(', ')})`,
      metadata: {
        orderNumber: getSalesOrderReference(outcome.so),
        paymentId,
        // Both ends: which rows were retired, and the document ids the ledger was asked about. The
        // ids stay on the rows too — a CANCELLED row that still names a document is a complete
        // account of a payment that existed and was undone.
        accountingSyncLogIds: [...ledgerHold.map((row) => row.id), ...assertedUndecided.map((row) => row.id)],
        externalTransactionIds: ledgerHold.map((row) => row.externalTransactionId),
        priorStatuses: [...ledgerHold.map((row) => row.status), ...assertedUndecided.map((row) => row.status)],
        // WHOSE FACT IT WAS. A reference IMS read back off its own registration and one a human typed
        // are different kinds of evidence, and an audit trail that cannot tell them apart cannot
        // answer "who said this payment was the right one" a year later.
        assertedPaymentReference: assertedReference,
        assertedUndecidedLogIds: assertedUndecided.map((row) => row.id),
        ledgerInvoiceId: assertedReference ? orderForReference.accountingInvoiceId : undefined,
        verifiedAt: now.toISOString(),
        userId: session.user.id,
      },
    })
    if (isPaymentStatusMismatch(outcome.so.status, outcome.becameUnpaid)) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'payment_status_mismatch',
        tag: 'sales',
        level: 'WARNING',
        description: `Order ${getSalesOrderReference(outcome.so)} is ${outcome.so.status} but is no longer fully paid after reversing a payment. Review whether the status should be reverted.`,
        metadata: { orderNumber: getSalesOrderReference(outcome.so), status: outcome.so.status, paymentId },
      })
    }
    return { success: true }
  } catch (error) {
    if (error instanceof PaymentTransactionRefusal) {
      return { success: false, error: error.message, code: error.code as LedgerReversalRefusalCode }
    }
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * Release a hold placed by an EU right-of-withdrawal request (o3d-e1yb).
 *
 * Deliberately an OPERATOR action. A rejected withdrawal returns the
 * storefront order to a ready status, and letting that release the hold by
 * itself would put goods back on the pick line off a customer-facing status
 * change — so `withdrawalHoldAt` blocks both the inbound status sync and the
 * WMS release pass until a person clears it here.
 *
 * Clearing the marker is all this does. The order stays ON_HOLD and the
 * ordinary release path (moving it back to Processing) then applies, which
 * keeps this action reversible and keeps one code path for re-pushing.
 *
 * o3d-rbyg r4 (Codex r3 finding 1) — `expected.generation` IS NOT OPTIONAL, AND IT IS THE CALLER'S.
 *
 * The conditional update below was already generation-guarded, and the guard was already the right
 * mechanism. It was simply being satisfied by a value this function had fetched microseconds
 * earlier: `where: { withdrawalHoldGeneration: so.withdrawalHoldGeneration }` compares the current
 * generation against itself, which closes the window between THIS read and THIS write and no other.
 * The window that matters is longer — the page was drawn, an operator read it and decided, and (in
 * the exception inbox's despatch remedy) a warehouse round trip happened in between. A customer who
 * files a NEW withdrawal request inside that window had it cleared by a decision taken before it
 * existed, silently, with an audit line saying a hold was released.
 *
 * So the caller states WHICH request it decided about, and a mismatch is refused BY NAME. Both
 * checks stay: the explicit comparison is what produces a message an operator can act on, and the
 * conditional update is what makes the write itself atomic against a submission landing between
 * them.
 */
export async function releaseWithdrawalHold(
  id: string,
  expected: { generation: number },
  note?: string,
) {
  const session = await requirePermission('sales.process')

  const so = await db.salesOrder.findUnique({
    where: { id },
    select: {
      id: true, orderNumber: true, status: true,
      withdrawalHoldAt: true, withdrawalHoldGeneration: true,
    },
  })
  if (!so) return { success: false, error: 'Order not found' }
  if (!so.withdrawalHoldAt) return { success: false, error: 'This order is not under a withdrawal hold' }

  // Conditional on the GENERATION observed, not the timestamp (o3d-6x66).
  // A repair or redelivery run deliberately retains the original
  // `withdrawalHoldAt`, so comparing that cannot tell a new customer request
  // from the same hold — and a stale release would clear a hold the customer
  // has only just asked for. The generation advances per new submission.
  if (!Number.isInteger(expected.generation)) {
    return { success: false, error: 'The withdrawal request this release was for could not be identified — reload and try again' }
  }
  if (so.withdrawalHoldGeneration !== expected.generation) {
    return {
      success: false,
      error:
        `A NEWER withdrawal request has been filed against this order since this page was drawn `
        + `(request ${expected.generation} → ${so.withdrawalHoldGeneration}). The hold was NOT released, `
        + 'because releasing it would clear a request nobody has looked at. Reload and read the current request first.',
    }
  }

  const cleared = await db.salesOrder.updateMany({
    where: { id, withdrawalHoldGeneration: expected.generation, withdrawalHoldAt: { not: null } },
    data: { withdrawalHoldAt: null },
  })
  if (cleared.count === 0) {
    return { success: false, error: 'The withdrawal hold changed while you were looking at it — reload and try again' }
  }

  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: id,
    action: 'withdrawal_hold_released',
    tag: 'sales',
    level: 'INFO',
    description:
      `Withdrawal hold released by ${session.user.email ?? session.user.id}`
      + `${note ? `: ${note}` : ''}. The order remains ON HOLD — move it back to Processing to re-push it to the warehouse.`,
    metadata: { heldSince: so.withdrawalHoldAt, generation: expected.generation, note: note ?? null },
  })

  revalidatePath(`/sales/${id}`)
  revalidatePath('/sales')
  return { success: true }
}
