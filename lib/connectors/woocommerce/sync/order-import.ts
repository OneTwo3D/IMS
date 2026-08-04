/**
 * WooCommerce → IMS order import.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import type { WcFullOrder, SyncResult } from './types'
import {
  mapWcAddress, upsertCustomer, mapWcLineItems, mapWcOrderDiscount,
  mapWcFeeLines, mapWcShipping, resolveWcTaxRateById, getFxRateToGbp, isMissingFxRateError,
  readWcCustomerVat, resolveWcOrderLevelDiscount,
} from './field-mapping'
import { syncRefundsForOrder } from './refund-sync'
import { refundDispositionForStatus } from '@/lib/domain/sales/refund-disposition'
import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { isFulfilmentStatus, recordShortfallOnDirectCreate } from '@/lib/fulfillment/pre-fulfilment-reallocation'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { resolveLineTaxRateBatch } from '@/lib/tax/resolve-rate'
import { addMoney, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { Prisma, TaxCategory } from '@/app/generated/prisma/client'
import { getSettingValue } from '@/lib/settings-store'
import { notify } from '@/lib/notifications'
import { parsePositiveIntegerEnv } from '@/lib/env'

// ---------------------------------------------------------------------------
// Import a single WC order into IMS
// ---------------------------------------------------------------------------

export type ImportWcOrderOptions = {
  skipAccounting?: boolean
  useWcDateAsCreatedAt?: boolean
  pendingFxRetryLogId?: string
}

const WEBHOOK_PRIMARY_FRESH_MS = 24 * 60 * 60 * 1000
const DEFAULT_PENDING_FX_NOTIFY_THRESHOLD = 5
const TAX_RATE_EPSILON = 0.000001
const MISSING_FX_RATE_QUEUE_REASON = 'missing_fx_rate'

export type WcTaxRateFallbackLine = {
  sku: string
  productCategory: TaxCategory
  externalTaxRateId: number | null
  taxRateValue: number
  expectedTaxRateValue: number | null
  warning: string | null
}

// Pending FX retries intentionally persist the full WooCommerce order snapshot.
// Replaying the same payload avoids a second connector fetch that could import a
// later order shape under the original idempotency key. These rows should remain
// short-lived operational retry state: successful replay deletes the queue row,
// and failed rows are bounded by the normal shoppingSyncLog retention policy.
export type PendingFxOrderPayload = {
  reason: typeof MISSING_FX_RATE_QUEUE_REASON
  connector: 'woocommerce'
  externalOrderId: string
  externalOrderNumber: string
  currency: string
  asOf: string | null
  order: WcFullOrder
}

export function shouldBlockWcTaxRateFallback(lines: WcTaxRateFallbackLine[]): boolean {
  return lines.some((line) => {
    if (line.expectedTaxRateValue != null) {
      return Math.abs(line.taxRateValue - line.expectedTaxRateValue) > TAX_RATE_EPSILON
    }
    return line.taxRateValue > TAX_RATE_EPSILON
  })
}

function roundDecimalNumber(value: DecimalInput, precision: number): number {
  return roundQuantity(value, precision).toNumber()
}

function divideRoundedNumber(value: DecimalInput, divisor: DecimalInput, precision: number): number {
  return roundDecimalNumber(toDecimal(value).div(toDecimal(divisor)), precision)
}

/**
 * Parse a WooCommerce money string (e.g. "12.34") into an exact Decimal. WC sends
 * monetary fields as strings; an empty/missing/invalid value means zero (mirroring
 * the prior `parseFloat(x) || 0`). Parsing via Decimal — and accumulating with
 * addMoney — avoids the float drift that `parseFloat` + native `+` accrued across
 * many tax/line rows before the /fxRate + round-4 boundary (scjz.62).
 */
export function parseWcMoney(value: string | number | null | undefined): Decimal {
  if (value == null || value === '') return toDecimal(0)
  try {
    return toDecimal(value)
  } catch {
    return toDecimal(0)
  }
}

export type WcForeignTotalsLine = {
  qty: DecimalInput
  unitPriceForeign: DecimalInput
  discountAmount: DecimalInput
  taxForeign: DecimalInput
  taxRateValue: DecimalInput
}

/**
 * Order-level foreign-currency aggregates — subtotal (net of VAT/discount), tax,
 * and grand total — computed entirely in Decimal so the AR-control / FX-revaluation
 * amounts don't accumulate float drift across many lines (scjz.62). Callers convert
 * to base currency at the single /fxRate boundary (divideRoundedNumber).
 */
export function computeWcOrderForeignTotals(input: {
  lines: WcForeignTotalsLine[]
  shippingTaxForeign: Array<string | number | null | undefined>
  orderTotal: string | number | null | undefined
  pricesIncludeVat: boolean
}): { subtotalForeign: Decimal; taxForeign: Decimal; totalForeign: Decimal } {
  const subtotalForeign = input.lines.reduce((sum, line) => {
    const gross = toDecimal(line.qty).mul(toDecimal(line.unitPriceForeign)).sub(toDecimal(line.discountAmount))
    const net = input.pricesIncludeVat
      ? gross.div(toDecimal(1).add(toDecimal(line.taxRateValue)))
      : gross
    return addMoney(sum, net)
  }, toDecimal(0))
  const shippingTaxForeign = input.shippingTaxForeign.reduce<Decimal>(
    (sum, value) => addMoney(sum, parseWcMoney(value as string | number | null | undefined)),
    toDecimal(0),
  )
  const lineTaxForeign = input.lines.reduce<Decimal>(
    (sum, line) => addMoney(sum, toDecimal(line.taxForeign)),
    toDecimal(0),
  )
  return {
    subtotalForeign,
    taxForeign: addMoney(lineTaxForeign, shippingTaxForeign),
    totalForeign: parseWcMoney(input.orderTotal),
  }
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002'
}

function getPendingFxNotifyThreshold(env: Record<string, string | undefined> = process.env): number {
  return parsePositiveIntegerEnv(env.WC_PENDING_FX_ORDER_NOTIFY_THRESHOLD, DEFAULT_PENDING_FX_NOTIFY_THRESHOLD)
}

export function pendingFxQueueWhere(externalOrderId?: string): Prisma.ShoppingSyncLogWhereInput {
  return {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    status: 'PENDING',
    entityType: 'SalesOrder',
    ...(externalOrderId ? { externalId: externalOrderId } : {}),
    payload: {
      path: ['reason'],
      equals: MISSING_FX_RATE_QUEUE_REASON,
    },
  }
}

/**
 * The amount to settle the sales invoice for — the GROSS (tax-inclusive) total the customer paid, in the
 * order currency the invoice is raised in (wcOrder.total). Without this, the payment sync-processor falls
 * back to the NET line sum (+shipping −discount, no tax), so a taxed invoice is under-settled by its VAT
 * and never reaches PAID (o3d-c0n). Non-taxed orders are unaffected because net == gross.
 *
 * Returns undefined (→ leaves the net fallback in place) when:
 *  • the order isn't paid (no payment is registered anyway), or
 *  • prices are tax-INCLUSIVE — those orders have a separate pre-existing invoice-construction bug that
 *    builds the invoice at the NET total (WC REST line amounts are always net but are sent to Xero
 *    flagged tax-inclusive), so a gross payment would EXCEED the invoice and Xero would reject it. Kept
 *    on the (net-but-consistent) fallback until that construction is fixed (o3d-cyn) rather than
 *    regressing them; the invoice is correctly built at gross only for tax-exclusive orders.
 */
export function resolveWcInvoicePaymentAmount(
  wcOrder: Pick<WcFullOrder, 'date_paid_gmt' | 'total' | 'prices_include_tax'>,
): number | undefined {
  if (wcOrder.prices_include_tax) return undefined
  if (!wcOrder.date_paid_gmt || !wcOrder.total) return undefined
  const gross = Number(wcOrder.total)
  return Number.isFinite(gross) && gross > 0 ? gross : undefined
}

export function buildPendingFxOrderPayload(
  wcOrder: WcFullOrder,
  error: { currency: string; asOf?: Date },
): PendingFxOrderPayload {
  return {
    reason: MISSING_FX_RATE_QUEUE_REASON,
    connector: 'woocommerce',
    externalOrderId: String(wcOrder.id),
    externalOrderNumber: wcOrder.number,
    currency: error.currency,
    asOf: error.asOf?.toISOString() ?? null,
    order: wcOrder,
  }
}

async function loadExpectedDestinationSalesTaxRates(
  categories: TaxCategory[],
  destinationCountry: string | null,
): Promise<Map<TaxCategory, number>> {
  const result = new Map<TaxCategory, number>()
  if (!destinationCountry || categories.length === 0) return result
  const distinctCategories = Array.from(new Set(categories))
  const rows = await db.taxRate.findMany({
    where: {
      active: true,
      usedFor: { in: ['SALES', 'BOTH'] },
      countryCode: destinationCountry,
      taxCategory: { in: distinctCategories },
    },
    select: { taxCategory: true, rate: true },
  })
  for (const row of rows) {
    if (!result.has(row.taxCategory)) result.set(row.taxCategory, Number(row.rate))
  }
  return result
}

async function notifyActiveAdmins(params: Omit<Parameters<typeof notify>[0], 'userId'>): Promise<void> {
  const admins = await db.user.findMany({
    where: { role: 'ADMIN', active: true },
    select: { id: true },
  })
  await Promise.all(admins.map((admin) => notify({ ...params, userId: admin.id })))
}

async function recordPendingFxOrder(
  wcOrder: WcFullOrder,
  error: { message: string; currency: string; asOf?: Date },
  retryLogId?: string,
): Promise<void> {
  const payload = buildPendingFxOrderPayload(wcOrder, error)
  const jsonPayload = JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue
  const data = {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR' as const,
    status: 'PENDING' as const,
    entityType: 'SalesOrder',
    externalId: String(wcOrder.id),
    payload: jsonPayload,
    errorMessage: error.message,
    syncedAt: null,
  }

  if (retryLogId) {
    await db.shoppingSyncLog.update({
      where: { id: retryLogId },
      data,
    })
  } else {
    const existing = await db.shoppingSyncLog.findFirst({
      where: pendingFxQueueWhere(String(wcOrder.id)),
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (existing) {
      await db.shoppingSyncLog.update({ where: { id: existing.id }, data })
    } else {
      await db.shoppingSyncLog.create({ data })
    }
  }

  await logActivity({
    entityType: 'SYNC',
    action: 'wc_order_fx_pending',
    tag: 'sync',
    level: 'WARNING',
    description: `WooCommerce order #${wcOrder.number} is waiting for a ${error.currency} FX rate before import`,
    metadata: {
      connector: 'woocommerce',
      externalOrderId: String(wcOrder.id),
      externalOrderNumber: wcOrder.number,
      currency: error.currency,
      asOf: error.asOf?.toISOString() ?? null,
    },
    resolveUser: false,
  })

  const depth = await db.shoppingSyncLog.count({
    where: pendingFxQueueWhere(),
  })
  const threshold = getPendingFxNotifyThreshold()
  if (depth >= threshold) {
    await notifyActiveAdmins({
      type: 'warning',
      title: 'WooCommerce orders waiting for FX rates',
      message: `${depth} WooCommerce order imports are pending because IMS has no matching FX rate. The queue retries after the next FX-rate fetch.`,
      actionUrl: '/sync',
    })
  }
}

async function markPendingFxRetryLogSynced(logId: string, orderId: string): Promise<void> {
  await db.shoppingSyncLog.update({
    where: { id: logId },
    data: {
      status: 'SYNCED',
      entityId: orderId,
      errorMessage: null,
      syncedAt: new Date(),
    },
  })
}

async function markPendingFxRetryLogFailed(logId: string, error: unknown): Promise<void> {
  await db.shoppingSyncLog.update({
    where: { id: logId },
    data: {
      status: 'FAILED',
      errorMessage: String(error),
      syncedAt: new Date(),
    },
  })
}

export async function isWcOrderWebhookPrimaryActive(): Promise<boolean> {
  const [secret, lastReceived] = await Promise.all([
    getSettingValue('wc_webhook_secret'),
    db.setting.findUnique({ where: { key: 'wc_order_webhook_last_received_at' } }),
  ])

  if (!secret || !lastReceived?.value) return false
  const ts = Date.parse(lastReceived.value)
  if (!Number.isFinite(ts)) return false
  return (Date.now() - ts) <= WEBHOOK_PRIMARY_FRESH_MS
}

async function updateExistingWcOrderFromPayload(
  orderId: string,
  wcOrder: WcFullOrder,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.shoppingOrderLink.updateMany({
      where: {
        connector: 'woocommerce',
        externalOrderId: String(wcOrder.id),
      },
      data: {
        externalOrderNumber: wcOrder.number,
        metadata: {
          externalOrderKey: wcOrder.order_key,
        },
      },
    })
    await tx.salesOrder.update({
      where: { id: orderId },
      data: {
        externalOrderNumber: wcOrder.number,
        customerVatNumber: readWcCustomerVat(wcOrder),
        billingAddress: mapWcAddress(wcOrder.billing),
        shippingAddress: mapWcAddress(wcOrder.shipping),
        notes: wcOrder.customer_note || null,
        paidAt: wcOrder.date_paid_gmt ? new Date(wcOrder.date_paid_gmt) : undefined,
      },
    })
  })
}

export async function importWcOrder(wcOrder: WcFullOrder, options: ImportWcOrderOptions = {}): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    // Skip if already imported
    const existing = await db.salesOrder.findFirst({
      where: {
        shoppingLinks: {
          some: {
            connector: 'woocommerce',
            externalOrderId: String(wcOrder.id),
          },
        },
      },
    })
    if (existing) {
      await updateExistingWcOrderFromPayload(existing.id, wcOrder)
      if (options.pendingFxRetryLogId) await markPendingFxRetryLogSynced(options.pendingFxRetryLogId, existing.id)
      return { success: true, orderId: existing.id }
    }

    // Resolve IMS status from WC status
    const statusMapping = await db.shoppingStatusMapping.findUnique({
      where: {
        connector_externalStatus: {
          connector: 'woocommerce',
          externalStatus: wcOrder.status,
        },
      },
    })
    const imsStatus = statusMapping?.imsStatus ?? 'PROCESSING'
    // Refund state is orthogonal to the lifecycle status: never store
    // REFUNDED/PARTIALLY_REFUNDED as `status`. A refunded-at-import order keeps a base
    // lifecycle status plus a refundStatus; the allocation/invoice gates below still
    // key off the mapped imsStatus, and the refund records sync separately.
    const importRefundDisposition = refundDispositionForStatus(imsStatus)
    const lifecycleStatus = importRefundDisposition === 'NONE' ? imsStatus : 'PROCESSING'

    // Customer
    const customerId = await upsertCustomer(wcOrder)
    const customerName = [wcOrder.billing.first_name, wcOrder.billing.last_name].filter(Boolean).join(' ')
      || [wcOrder.shipping.first_name, wcOrder.shipping.last_name].filter(Boolean).join(' ')
      || 'WooCommerce Customer'

    // Currency & FX
    const currency = wcOrder.currency || 'GBP'
    const orderedAt = wcOrder.date_created_gmt
      ? new Date(`${wcOrder.date_created_gmt.replace(/Z$/, '')}Z`)
      : (wcOrder.date_created ? new Date(wcOrder.date_created) : undefined)
    const fxRate = await getFxRateToGbp(currency, orderedAt)

    const pricesIncludeVat = wcOrder.prices_include_tax

    // Line items (each one may carry its own externalTaxRateId)
    const mappedLines = [
      ...(await mapWcLineItems(wcOrder.line_items, fxRate)),
      ...mapWcFeeLines(wcOrder.fee_lines),
    ]

    // --- Per-line tax resolution --------------------------------------
    // 1. Where WC sent a per-line tax rate id, trust it (WC computed it
    //    server-side including shipping-country logic).
    // 2. Otherwise, fall back to the IMS resolver on (productCategory,
    //    shippingCountry, SALES).
    const distinctWcRateIds = Array.from(new Set([
      ...mappedLines.map((l) => l.externalTaxRateId).filter((x): x is number => typeof x === 'number'),
      ...wcOrder.tax_lines.map((line) => line.rate_id).filter((x): x is number => typeof x === 'number'),
    ]))
    const wcResolvedById = new Map<
      number,
      { taxRateId: string | null; taxRateName: string | null; taxRateValue: number; accountingTaxType: string | null; reverseCharge: boolean; source?: 'mapped' | 'default' }
    >()
    for (const id of distinctWcRateIds) {
      wcResolvedById.set(id, await resolveWcTaxRateById(id))
    }

    const orderLevelRates = wcOrder.tax_lines
      .map((line) => wcResolvedById.get(line.rate_id))
      .filter((rate): rate is NonNullable<typeof rate> => rate != null)
    const resolvedOrderDefault =
      orderLevelRates.find((rate) => /standard/i.test(rate.taxRateName ?? ''))
      ?? [...orderLevelRates].sort((a, b) => b.taxRateValue - a.taxRateValue)[0]
      ?? [...wcResolvedById.values()].sort((a, b) => b.taxRateValue - a.taxRateValue)[0]
      ?? await resolveWcTaxRateById(null)
    const {
      taxRateId: orderDefaultTaxRateId,
      taxRateName,
      taxRateValue,
      accountingTaxType,
    } = resolvedOrderDefault

    // Load product categories for lines that need the resolver fallback.
    const productIds = Array.from(
      new Set(mappedLines.map((l) => l.productId).filter((x): x is string => typeof x === 'string')),
    )
    const productRows = productIds.length
      ? await db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, taxCategory: true },
        })
      : []
    const productCategoryById = new Map<string, TaxCategory>(
      productRows.map((p) => [p.id, p.taxCategory]),
    )

    const destCountry = wcOrder.shipping?.country
      ? wcOrder.shipping.country.toLowerCase()
      : wcOrder.billing?.country
      ? wcOrder.billing.country.toLowerCase()
      : null

    const orderDefaultCtx = {
      id: orderDefaultTaxRateId,
      name: taxRateName,
      rate: taxRateValue,
      accountingTaxType,
    }
    const needsResolver = mappedLines
      .map((l, idx) => ({
        id: String(idx),
        productCategory: (l.productId && productCategoryById.get(l.productId)) || l.taxCategoryFallback || ('STANDARD' as TaxCategory),
        hasMappedWc: l.externalTaxRateId != null && wcResolvedById.get(l.externalTaxRateId)?.source === 'mapped',
      }))
      .filter((l) => !l.hasMappedWc)
    const resolverMap = await resolveLineTaxRateBatch(
      needsResolver.map((l) => ({ id: l.id, productCategory: l.productCategory })),
      { destinationCountry: destCountry, usedFor: 'SALES', orderDefault: orderDefaultCtx },
    )
    const expectedDestinationRates = await loadExpectedDestinationSalesTaxRates(
      needsResolver.map((line) => line.productCategory),
      destCountry,
    )

    const taxFallbackLines: WcTaxRateFallbackLine[] = []
    const lineTaxResolved = mappedLines.map((l, idx) => {
      if (l.forceNoTax) {
        return {
          taxRateId: null,
          taxRateName: null,
          taxRateValue: 0,
          accountingTaxType: null,
          // Tax-exempt lines are never reverse-charged — keeps the union uniform
          // so the accounting-payload swap reads a real flag, not an absent one.
          reverseCharge: false,
        }
      }
      if (l.externalTaxRateId != null) {
        const wc = wcResolvedById.get(l.externalTaxRateId)
        if (wc?.source === 'mapped') return wc
      }
      const resolved = resolverMap.get(String(idx)) ?? {
        taxRateId: orderDefaultTaxRateId,
        taxRateName,
        taxRateValue,
        accountingTaxType,
        isCompound: false,
        reverseCharge: false,
        reportingCategory: null,
        components: [],
        matched: 'fallback' as const,
        warning: `No configured sales rate for ${destCountry ? destCountry.toUpperCase() : 'unknown country'} / ${l.taxCategoryFallback ?? 'STANDARD'}. Using order default.`,
      }
      if (resolved.matched === 'fallback') {
        taxFallbackLines.push({
          sku: l.sku,
          productCategory: (l.productId && productCategoryById.get(l.productId)) || l.taxCategoryFallback || ('STANDARD' as TaxCategory),
          externalTaxRateId: l.externalTaxRateId ?? null,
          taxRateValue: resolved.taxRateValue,
          expectedTaxRateValue: expectedDestinationRates.get((l.productId && productCategoryById.get(l.productId)) || l.taxCategoryFallback || ('STANDARD' as TaxCategory)) ?? null,
          warning: resolved.warning,
        })
      }
      return resolved
    })
    if (shouldBlockWcTaxRateFallback(taxFallbackLines)) {
      const description = `Blocked WooCommerce order ${wcOrder.number} import because ${taxFallbackLines.length} line(s) would use the order default tax rate.`
      await logActivity({
        entityType: 'SYNC',
        entityId: null,
        action: 'tax_rate_fallback_blocked',
        tag: 'sync',
        level: 'ERROR',
        description,
        metadata: {
          connector: 'woocommerce',
          externalOrderId: String(wcOrder.id),
          externalOrderNumber: wcOrder.number,
          destCountry,
          lines: taxFallbackLines,
        },
      })
      return { success: false, error: description }
    }

    // Coupons. Woo allocates cart-coupon money INTO the lines (each line's `total` is already its
    // `subtotal` minus that line's share), and mapWcLineItems turns that difference into a per-line
    // discountAmount. IMS's ORDER-LEVEL discountAmount slot means the opposite — a discount that is
    // NOT in the lines — so it must carry only the residual, normally zero. Storing the coupon in
    // both places made every consumer deduct it twice (o3d-y14): the Xero/QuickBooks builders send
    // the per-line figure as a DiscountRate AND append the order-level figure as a negative line.
    const orderDiscount = mapWcOrderDiscount(wcOrder.coupon_lines)
    const lineDiscountTotalForeign = mappedLines.reduce(
      (sum, line) => addMoney(sum, toDecimal(line.discountAmount)),
      toDecimal(0),
    )
    const { orderLevelDiscount: orderLevelDiscountForeign, unallocated: unallocatedCouponForeign } =
      resolveWcOrderLevelDiscount({
        couponTotalForeign: orderDiscount.discountAmount,
        lineDiscountTotalForeign,
      })
    if (unallocatedCouponForeign > 0) {
      // A coupon shape we do not model. The residual is kept (dropping it would overstate the
      // invoice by money the customer was never charged) but it is worth knowing about, because
      // it is the one case where the order-level leg is still live on a WC order.
      await logActivity({
        entityType: 'SYNC',
        entityId: null,
        action: 'wc_coupon_not_allocated_to_lines',
        tag: 'sync',
        level: 'WARNING',
        description: `WooCommerce order ${wcOrder.number}: ${unallocatedCouponForeign} of coupon ${orderDiscount.discountStr ?? ''} was not allocated to any line; kept as an order-level discount.`,
        metadata: {
          connector: 'woocommerce',
          externalOrderId: String(wcOrder.id),
          externalOrderNumber: wcOrder.number,
          couponTotalForeign: orderDiscount.discountAmount,
          lineDiscountTotalForeign: roundDecimalNumber(lineDiscountTotalForeign, 4),
          unallocatedForeign: unallocatedCouponForeign,
        },
      })
    }

    // Shipping
    const shipping = mapWcShipping(wcOrder)
    const shippingForeign = shipping.shippingForeign

    // Foreign-currency aggregates in exact Decimal (scjz.62): no parseFloat + native
    // `+` accumulation, so the AR-control / FX-revaluation amounts can't drift across
    // many tax/line rows. Stored as Decimal @db.Decimal(18,4); base conversions happen
    // at the single /fxRate boundary below.
    const { subtotalForeign, taxForeign, totalForeign } = computeWcOrderForeignTotals({
      lines: mappedLines.map((l, idx) => ({
        qty: l.qty,
        unitPriceForeign: l.unitPriceForeign,
        discountAmount: l.discountAmount,
        taxForeign: l.taxForeign,
        taxRateValue: lineTaxResolved[idx].taxRateValue,
      })),
      shippingTaxForeign: wcOrder.shipping_lines.map((line) => line.total_tax),
      orderTotal: wcOrder.total,
      pricesIncludeVat,
    })

    // GBP conversions
    const subtotalBase = divideRoundedNumber(subtotalForeign, fxRate, 4)
    const shippingBase = divideRoundedNumber(shippingForeign, fxRate, 4)
    const taxBase = divideRoundedNumber(taxForeign, fxRate, 4)
    const totalBase = divideRoundedNumber(totalForeign, fxRate, 4)

    // Line data for Prisma
    const lineData = mappedLines.map((l, idx) => {
      const resolved = lineTaxResolved[idx]
      const rate = resolved.taxRateValue
      const grossForeign = toDecimal(l.qty).mul(l.unitPriceForeign).sub(l.discountAmount)
      const netForeign = pricesIncludeVat
        ? grossForeign.div(toDecimal(1).add(rate))
        : grossForeign
      const unitPriceBase = divideRoundedNumber(l.unitPriceForeign, fxRate, 6)
      const totalLineForeign = roundDecimalNumber(netForeign, 4)
      const totalLineGbp = divideRoundedNumber(totalLineForeign, fxRate, 4)
      const taxLineForeign = l.taxForeign
      const taxLineGbp = divideRoundedNumber(taxLineForeign, fxRate, 4)

      return {
        productId: l.productId,
        externalLineItemId: l.externalLineItemId,
        sku: l.sku,
        description: l.description,
        qty: l.qty,
        unitPriceForeign: l.unitPriceForeign,
        unitPriceBase,
        discountStr: l.discountStr,
        discountAmount: l.discountAmount,
        taxRateId: resolved.taxRateId,
        taxForeign: taxLineForeign,
        taxBase: taxLineGbp,
        totalForeign: totalLineForeign,
        totalBase: totalLineGbp,
      }
    })

    // Read unified numbering settings via the shopping connector registry
    // (Settings → Company → Numbering → Shopping Connectors → WooCommerce)
    const { getShoppingConnectorPrefixes } = await import('@/lib/connectors/shopping-registry')
    const { orderPrefix: wcOrderPrefix, invPrefix: wcInvPrefix } =
      await getShoppingConnectorPrefixes('woocommerce')
    const orderNumber = `${wcOrderPrefix}${wcOrder.number}`

    // Find the default WC warehouse — prefer isDefault + syncToStore,
    // fall back to any syncToStore warehouse.
    const wcWarehouses = await db.warehouse.findMany({
      where: { active: true, syncToStore: true },
      select: { id: true, isDefault: true },
      orderBy: { isDefault: 'desc' },
    })
    const wcDefaultWarehouseId = wcWarehouses[0]?.id ?? null

    // Create the sales order
    let so
    try {
      so = await db.salesOrder.create({
        data: {
          externalOrderNumber: wcOrder.number,
          orderNumber,
          paymentMethod: wcOrder.payment_method || null,
          paymentMethodTitle: wcOrder.payment_method_title || null,
          externalCreatedAt: new Date(wcOrder.date_created_gmt || wcOrder.date_created),
          externalUpdatedAt: new Date(wcOrder.date_modified_gmt || wcOrder.date_modified),
          ...(options.useWcDateAsCreatedAt ? { createdAt: new Date(wcOrder.date_created_gmt || wcOrder.date_created) } : {}),
          status: lifecycleStatus,
          refundStatus: importRefundDisposition,
          shipFromWarehouseId: wcDefaultWarehouseId,
          currency,
          fxRateToBase: fxRate,
          customerId,
          customerName,
          customerEmail: wcOrder.billing.email || null,
          customerVatNumber: readWcCustomerVat(wcOrder),
          billingAddress: mapWcAddress(wcOrder.billing),
          shippingAddress: mapWcAddress(wcOrder.shipping),
          subtotalForeign,
          shippingService: shipping.shippingService,
          shippingForeign,
          taxRateName,
          taxRatePercent: taxRateValue > 0 ? taxRateValue : null,
          taxForeign,
          pricesIncludeVat: !!pricesIncludeVat,
          totalForeign,
          subtotalBase,
          shippingBase,
          taxBase,
          totalBase,
          // Coupon CODES are kept for display; the money lives on the lines (o3d-y14).
          discountStr: orderDiscount.discountStr,
          discountAmount: orderLevelDiscountForeign,
          notes: wcOrder.customer_note || null,
          paidAt: wcOrder.date_paid_gmt ? new Date(wcOrder.date_paid_gmt) : null,
          shoppingLinks: {
            create: {
              connector: 'woocommerce',
              externalOrderId: String(wcOrder.id),
              externalOrderNumber: wcOrder.number,
              metadata: {
                externalOrderKey: wcOrder.order_key,
              },
            },
          },
          lines: { create: lineData },
        },
      })
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
      const concurrent = await db.salesOrder.findFirst({
        where: {
          shoppingLinks: {
            some: {
              connector: 'woocommerce',
              externalOrderId: String(wcOrder.id),
            },
          },
        },
      })
      if (concurrent) {
        await updateExistingWcOrderFromPayload(concurrent.id, wcOrder)
        if (options.pendingFxRetryLogId) await markPendingFxRetryLogSynced(options.pendingFxRetryLogId, concurrent.id)
        return { success: true, orderId: concurrent.id }
      }
      throw error
    }

    if (taxFallbackLines.length > 0) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'tax_rate_fallback',
        tag: 'sales',
        level: 'WARNING',
        description: `WooCommerce order ${wcOrder.number} used order default tax rate on ${taxFallbackLines.length} zero-rated line(s).`,
        metadata: {
          connector: 'woocommerce',
          externalOrderId: String(wcOrder.id),
          externalOrderNumber: wcOrder.number,
          destCountry,
          lines: taxFallbackLines,
        },
      })
    }

    // Auto-allocate stock (skip for terminal statuses)
    const TERMINAL_STATUSES = ['CANCELLED']
    if (!TERMINAL_STATUSES.includes(imsStatus)) {
      const { autoAllocateOrder } = await import('@/app/actions/allocation')
      const allocation = await autoAllocateOrder(so.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
      if (!allocation.success && allocation.error !== 'No stock available for allocation') {
        throw new Error(`WooCommerce order imported but auto-allocation failed: ${allocation.error ?? 'Unknown error'}`)
      }
    }

    // o3d-z82a: the status written above is operator-configured via ShoppingStatusMapping, and
    // the mapping UI offers PICKING and PACKING. An order CREATED in fulfilment never
    // transitions, so o3d-c9mi's authoritative shortfall record — which hangs off the status
    // transition — never sees it. Yet it is in exactly the state that record exists for:
    // outside the reallocation sweep's set (PROCESSING + ALLOCATED), with nothing to revisit
    // it, and the allocation above can legitimately leave it short ('No stock available' is
    // tolerated three lines up, and partial coverage returns success).
    //
    // No allocation attempt here — the importer already made one. What was missing is the
    // record. Written under the order lock and in one transaction so it carries the same
    // guarantee as the transition-side record rather than being best-effort.
    if (isFulfilmentStatus(lifecycleStatus)) {
      await db.$transaction(async (tx) => {
        await lockSalesOrder(tx, so.id)
        await recordShortfallOnDirectCreate({ tx, orderId: so.id, createdStatus: lifecycleStatus })
      })
    }

    // Queue accounting sales invoice — only for PROCESSING orders and when
    // accounting is not explicitly skipped (e.g. initial import).
    const shouldInvoice = imsStatus === 'PROCESSING' && !options.skipAccounting
    if (!shouldInvoice) {
      // Log sync but skip accounting
      if (options.pendingFxRetryLogId) {
        await db.shoppingSyncLog.update({
          where: { id: options.pendingFxRetryLogId },
          data: {
            entityId: so.id,
            status: 'SYNCED',
            errorMessage: `Imported as ${imsStatus}${options.skipAccounting ? ' (initial import)' : ''} — skipped accounting sync`,
            syncedAt: new Date(),
          },
        })
      } else {
        await db.shoppingSyncLog.create({
          data: {
            direction: 'FROM_CONNECTOR',
            entityType: 'ORDER',
            entityId: so.id,
            externalId: String(wcOrder.id),
            status: 'SYNCED',
            errorMessage: `Imported as ${imsStatus}${options.skipAccounting ? ' (initial import)' : ''} — skipped accounting sync`,
          },
        })
      }
      return { success: true, orderId: so.id }
    }
    try {
      const { queueAccountingSync, getAccountingSettings } = await import('@/lib/accounting')
      const settings = await getAccountingSettings()
      // WC stores shipping_total already NET; line prices may be gross when
      // the WC store is configured with prices_include_tax. Send everything
      // to Xero as tax-inclusive when WC was inclusive so gross line prices
      // are interpreted correctly — shipping is converted to gross first to
      // stay consistent with the LineAmountTypes flag.
      const vatMultiplier = toDecimal(1).add(taxRateValue || 0)
      const shippingSendForeign = pricesIncludeVat ? toDecimal(shippingForeign).mul(vatMultiplier) : toDecimal(shippingForeign)
      // WooCommerce discounts are imported exactly as stored on the order so the accounting
      // connector sees the original order-currency amounts without a base-currency round-trip.
      // Coupons ride on the per-line discountAmount below (that is where Woo puts them); the
      // order-level leg carries only what Woo left unallocated — see o3d-y14.
      await queueAccountingSync({
        type: 'SALES_INVOICE',
        referenceType: 'SalesOrder',
        referenceId: so.id,
        payload: {
          invoiceNumber: `${wcInvPrefix}${wcOrder.number}`,
          contactName: customerName,
          contactEmail: wcOrder.billing.email || undefined,
          date: new Date(wcOrder.date_created_gmt || wcOrder.date_created).toISOString().slice(0, 10),
          currency,
          // Stamp IMS's FX rate so Xero doesn't apply its own daily rate on
          // imported WC orders — keeping WC, IMS, and Xero numerically aligned.
          currencyRateToBase: Number(fxRate) || undefined,
          reference: orderNumber,
          lines: lineData.map((l, idx) => ({
            itemCode: l.productId ? (l.sku || undefined) : undefined,
            description: l.description ?? l.sku ?? 'Item',
            quantity: l.qty,
            unitAmount: l.unitPriceForeign,
            accountCode: settings.salesAccount,
            // audit-H1b: swap reverse-charge LINE items to the RC tax code, same
            // as the native invoice push (resolveSalesLineTaxType), so a WC
            // reverse-charge order's goods lines post on the RC VAT boxes — not
            // the standard code. Every resolution path (resolver-derived, mapped
            // WC rate, forceNoTax) now carries a real reverseCharge flag.
            taxType: resolveSalesLineTaxType({
              baseTaxType: lineTaxResolved[idx]?.accountingTaxType ?? accountingTaxType,
              reverseCharge: lineTaxResolved[idx]?.reverseCharge,
              reverseChargeSalesTaxType: settings.reverseChargeSalesTaxType,
            }),
            discountAmount: l.discountAmount > 0 ? roundDecimalNumber(l.discountAmount, 4) : undefined,
          })),
          shippingAmount: shippingSendForeign.gt(0) ? roundDecimalNumber(shippingSendForeign, 4) : undefined,
          shippingDescription: 'Shipping',
          shippingAccountCode: settings.shippingAccount || undefined,
          // audit-H1b: shipping & discount stay on the base tax type (NOT swapped),
          // matching the native invoice push + credit-note builder (the H1 rule —
          // only goods lines carry the reverse charge).
          shippingTaxType: accountingTaxType ?? undefined,
          // Only the residual — the coupon itself is already on the lines above as a per-line
          // discountAmount, which the connector sends as a Xero DiscountRate / QuickBooks
          // discount line. Sending both deducted it twice (o3d-y14).
          discountAmount: orderLevelDiscountForeign > 0 ? roundDecimalNumber(orderLevelDiscountForeign, 2) : undefined,
          discountAccountCode: settings.discountAccount || undefined,
          discountTaxType: accountingTaxType ?? undefined,
          lineAmountsIncludeTax: pricesIncludeVat,
          _postingMode: 'submitted',
          _registerPayment: !!wcOrder.date_paid_gmt,
          _paymentMethod: wcOrder.payment_method || undefined,
          _paymentDate: wcOrder.date_paid_gmt || undefined,
          _paymentAmount: resolveWcInvoicePaymentAmount(wcOrder),
        },
      })
    } catch (accountingError) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'sales_invoice_accounting_queue_failed',
        tag: 'accounting',
        level: 'WARNING',
        description: `Failed to queue WooCommerce sales invoice for order ${orderNumber}`,
        metadata: {
          connector: 'woocommerce',
          externalOrderId: String(wcOrder.id),
          orderNumber,
          errorName: accountingError instanceof Error ? accountingError.name : typeof accountingError,
        },
      })
    }

    // Log sync
    if (options.pendingFxRetryLogId) {
      await markPendingFxRetryLogSynced(options.pendingFxRetryLogId, so.id)
    } else {
      await db.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'SYNCED',
          entityType: 'SalesOrder',
          entityId: so.id,
          externalId: String(wcOrder.id),
          syncedAt: new Date(),
        },
      })
    }

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'imported',
      tag: 'sync',
      level: 'INFO',
      description: `Imported WC order #${wcOrder.number} (${currency} ${totalForeign.toFixed(2)})`,
      metadata: { externalOrderId: wcOrder.id, wcNumber: wcOrder.number, currency, total: totalForeign.toNumber() },
      resolveUser: false,
    })

    return { success: true, orderId: so.id }
  } catch (e) {
    if (isMissingFxRateError(e)) {
      await recordPendingFxOrder(wcOrder, {
        message: e.message,
        currency: e.currency,
        asOf: e.asOf,
      }, options.pendingFxRetryLogId)
      return { success: false, error: `${e.message}; queued for retry after the next FX-rate refresh` }
    }
    if (options.pendingFxRetryLogId) {
      await markPendingFxRetryLogFailed(options.pendingFxRetryLogId, e)
    } else {
      await db.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'FAILED',
          entityType: 'SalesOrder',
          externalId: String(wcOrder.id),
          errorMessage: String(e),
          syncedAt: new Date(),
        },
      })
    }
    return { success: false, error: String(e) }
  }
}

export function isQueuedWcOrderPayload(payload: unknown): payload is PendingFxOrderPayload {
  return typeof payload === 'object'
    && payload !== null
    && (payload as { reason?: unknown }).reason === MISSING_FX_RATE_QUEUE_REASON
    && (payload as { connector?: unknown }).connector === 'woocommerce'
    && typeof (payload as { externalOrderId?: unknown }).externalOrderId === 'string'
    && typeof (payload as { externalOrderNumber?: unknown }).externalOrderNumber === 'string'
    && typeof (payload as { currency?: unknown }).currency === 'string'
    && (
      (payload as { asOf?: unknown }).asOf === null
      || typeof (payload as { asOf?: unknown }).asOf === 'string'
    )
    && typeof (payload as { order?: { id?: unknown } }).order?.id === 'number'
}

export async function retryPendingWcOrdersWaitingForFx(limit = 50): Promise<{ attempted: number; imported: number; stillPending: number; failed: number }> {
  const rows = await db.shoppingSyncLog.findMany({
    where: pendingFxQueueWhere(),
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 250),
    select: { id: true, payload: true },
  })

  const result = { attempted: rows.length, imported: 0, stillPending: 0, failed: 0 }
  for (const row of rows) {
    if (!isQueuedWcOrderPayload(row.payload)) {
      await markPendingFxRetryLogFailed(row.id, 'Pending FX queue payload is missing the WooCommerce order snapshot')
      result.failed++
      continue
    }
    // Guarded (o3d-d82p): an order can be withdrawn while it sits in this
    // queue waiting for an FX rate. The webhook records the suppression and
    // acknowledges, and this retry would then import the STALE processing
    // snapshot with no marker, leaving it warehouse-eligible until the next
    // reconciliation — not a millisecond window.
    const queuedOrder = row.payload.order
    const { importWcOrderGuarded } = await import('./withdrawal')
    const guarded = await importWcOrderGuarded(
      queuedOrder,
      () => importWcOrder(queuedOrder, { pendingFxRetryLogId: row.id }),
    )
    if (guarded.outcome === 'skipped-withdrawal') {
      // TERMINAL, not pending. This queue selects the oldest fixed prefix, so a
      // row whose order is withdrawn would sit at the head forever and, once
      // `limit` of them accumulate, every FX refresh would retry only those and
      // never reach newer orders whose rates are now available — stranding
      // unrelated paid orders unimported.
      await markPendingFxRetryLogFailed(
        row.id,
        'The customer withdrew this order while it waited for an FX rate, so it was not imported',
      )
      result.failed++
      continue
    }
    if (guarded.outcome === 'unresolved') {
      // Genuinely transient (WooCommerce unreachable): stays pending.
      result.stillPending++
      continue
    }
    const importResult = guarded.result
    if (importResult.success && guarded.compensationFailed) {
      // importWcOrder already marked this queue row SYNCED, so there is no
      // pending row left to carry the retry. Count it as failed and say why —
      // the tombstone survives, so the next webhook or poll finishes the job.
      result.failed++
      console.error(
        `[wc-fx-retry] order ${queuedOrder.id} imported, but applying the customer's withdrawal FAILED — the order is live and withdrawn`,
      )
    } else if (importResult.success) {
      result.imported++
    } else if (importResult.error?.includes('queued for retry after the next FX-rate refresh')) {
      result.stillPending++
    } else {
      result.failed++
    }
  }
  if (result.attempted > 0) {
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_order_fx_pending_retry',
      tag: 'sync',
      level: result.failed > 0 ? 'WARNING' : 'INFO',
      description: `Retried ${result.attempted} WooCommerce order(s) waiting for FX rates: ${result.imported} imported, ${result.stillPending} still pending, ${result.failed} failed`,
      metadata: result,
      resolveUser: false,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// Sync all new/updated WC orders
// ---------------------------------------------------------------------------

export async function syncNewWcOrders(
  opts: { mode?: 'poll' | 'reconcile' | 'manual_reconcile' } = {},
): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: [] }
  const mode = opts.mode ?? 'poll'
  const cursorKey = mode === 'poll' ? 'last_wc_order_sync_at' : 'last_wc_order_reconcile_at'

  // Guard: initial import must be completed before ongoing sync runs
  const initialImportSetting = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (initialImportSetting?.value !== 'true') {
    return { synced: 0, skipped: 0, errors: ['Initial order import has not been completed yet. Run the initial import first.'] }
  }

  // Read settings
  const [statusesSetting, lastSyncSetting, existingOrder] = await Promise.all([
    db.setting.findUnique({ where: { key: 'wc_sync_order_statuses' } }),
    db.setting.findUnique({ where: { key: cursorKey } }),
    db.salesOrder.findFirst({ select: { id: true } }),
  ])

  let statuses: string[]
  try { statuses = statusesSetting?.value ? JSON.parse(statusesSetting.value) : ['processing'] }
  catch { statuses = ['processing'] }
  if (mode !== 'poll' && !statuses.includes('completed')) {
    statuses = [...statuses, 'completed']
  }
  // o3d-e1yb [wdraw]: ALWAYS include the withdrawal statuses, in every mode.
  // This is the only backstop for a withdrawal whose webhook never arrived,
  // and a withdrawal that is never seen means an order the customer asked to
  // stop carries on to the warehouse. They are deliberately not left to the
  // operator-configured `wc_sync_order_statuses`.
  const { getWithdrawalStatuses } = await import('./withdrawal')
  const wdraw = await getWithdrawalStatuses()
  for (const s of [wdraw.submitted, wdraw.approved]) {
    if (s && !statuses.includes(s)) statuses = [...statuses, s]
  }

  // After a transaction reset or on a fresh install, there is nothing local to
  // reconcile against. Ignore any stale cursor and force a full import.
  const lastSync = existingOrder ? (lastSyncSetting?.value || null) : null

  // Fetch orders page by page
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const params: Record<string, string> = {
      status: statuses.join(','),
      per_page: '100',
      page: String(page),
      orderby: 'date',
      order: 'asc',
    }
    if (lastSync) params.modified_after = lastSync

    const { data, totalPages: tp, error } = await wcFetch('/orders', params)
    if (error) { result.errors.push(error); break }

    totalPages = tp
    const orders = data as WcFullOrder[]

    for (const order of orders) {
      const isWithdrawal = order.status === wdraw.submitted || order.status === wdraw.approved

      // o3d-e1yb: a withdrawal-status order that IMS has never seen must not be
      // imported first. importWcOrder would create it with the ordinary mapping
      // — PROCESSING — which auto-allocates stock and can queue its accounting
      // invoice, and only then would the withdrawal be applied. A failure in
      // between leaves a customer-withdrawn, paid order eligible for the WMS
      // sweep. Surface it instead; there is nothing to hold that we did not
      // just create.
      // Shared with both webhook topics, so the rule cannot drift between
      // ingestion paths.
      const { importWcOrderGuarded } = await import('./withdrawal')
      const guarded = await importWcOrderGuarded(order, () => importWcOrder(order))
      if (guarded.outcome === 'skipped-withdrawal') {
        result.skipped++
        continue
      }
      if (guarded.outcome === 'unresolved') {
        // NOT a skip. A skip is a resolved decision and lets this run advance
        // its modified-after cursor, which would leave the order behind the
        // cursor and possibly never handled — and this poll is the backstop
        // for exactly the withdrawal whose webhook went missing.
        result.errors.push(
          `WooCommerce order #${order.number}: a withdrawal suppression could not be resolved; left for the next run`,
        )
        continue
      }
      const importResult = guarded.result
      if (guarded.compensationFailed) {
        result.errors.push(
          `WooCommerce order #${order.number}: imported, but applying the customer's withdrawal FAILED — the order is live and withdrawn`,
        )
      }
      if (guarded.suppressionHandled) {
        // A withdrawal transition was just applied; do not sync this stale
        // ordinary status over it — that classifies as rejected-held and
        // invites an operator to release a live withdrawal.
        if (importResult.orderId) result.synced++
        else result.skipped++
        continue
      }
      if (importResult.success) {
        // The backstop for a withdrawal whose webhook never arrived.
        // importWcOrder does NOT change an existing order's lifecycle status,
        // so on its own it can never apply one.
        //
        // Scoped to the withdrawal slugs ONLY. Calling this for ordinary
        // statuses would apply the mapped status through the full transition
        // bypass, dragging an order IMS had deliberately advanced to
        // ALLOCATED/PICKING/PACKING back to PROCESSING — the webhook path
        // suppresses status echoes for exactly that reason, and this path has
        // no equivalent.
        if (isWithdrawal) {
          try {
            const { syncWcOrderStatus } = await import('./order-status')
            const statusResult = await syncWcOrderStatus(order)
            if (!statusResult.success && statusResult.error) {
              result.errors.push(`syncWcOrderStatus #${order.id}: ${statusResult.error}`)
            }
          } catch (e) {
            result.errors.push(`syncWcOrderStatus #${order.id}: ${String(e)}`)
          }
        }
        if (mode !== 'poll') {
          await syncRefundsForOrder(order.id)
        }
        if (importResult.orderId) result.synced++
        else result.skipped++
      } else {
        result.errors.push(`Order #${order.number}: ${importResult.error}`)
      }
    }

    page++
  }

  // Only advance the cursor after a fully clean run. Advancing after a fetch
  // or import error can permanently skip remote changes older than now.
  if (result.errors.length === 0) {
    await db.setting.upsert({
      where: { key: cursorKey },
      create: { key: cursorKey, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
  }

  if (result.synced > 0) {
    await logActivity({
      entityType: 'SYNC',
      action: 'order_sync',
      tag: 'sync',
      level: 'INFO',
      description: `WC order ${mode === 'poll' ? 'poll' : 'reconciliation'}: ${result.synced} imported, ${result.skipped} skipped, ${result.errors.length} errors`,
      resolveUser: false,
    })
  }

  return result
}
