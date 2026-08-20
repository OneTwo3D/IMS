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
import { decideStoredInvoiceNumberUpdate, resolveWcAccountingInvoiceNumber } from './invoice-number'
import {
  buildHeldSalesInvoicePayload,
  buildReleasedSalesInvoicePayload,
  heldSalesInvoiceQueueWhere,
  isHeldSalesInvoicePayload,
  releasedSalesInvoiceQueueWhere,
} from './held-sales-invoice'
import { syncRefundsForOrder } from './refund-sync'
import { refundDispositionForStatus } from '@/lib/domain/sales/refund-disposition'
import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { directCreateMarker, isFulfilmentStatus, resolveDirectCreateMarker } from '@/lib/fulfillment/pre-fulfilment-reallocation'
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

  // o3d-k26m.1: capture WooCommerce's invoice number the first time it appears. An order can
  // legitimately be imported before WooCommerce PDF Invoices has numbered its invoice, and a later
  // webhook redelivery — or the modified_after order poll, which sees the order again precisely
  // because writing that meta touches it — is the earliest moment IMS can learn the number.
  //
  // o3d-k26m.6/.7: and the two halves the capture used to be missing. It now RELEASES the invoice
  // that was held back for want of a number, so the advertised recovery actually produces an
  // invoice; and it may CORRECT a number captured before anything posted, instead of freezing the
  // first value WooCommerce ever reported. Both deliberately outside the transaction above: the
  // enqueue takes the order's row lock itself, and neither should be able to roll back the address
  // and payment updates that have nothing to do with them.
  const resolvedInvoiceNumber = resolveWcAccountingInvoiceNumber(wcOrder)
  if (!resolvedInvoiceNumber.ok) return

  // This runs for EVERY redelivery and for every order the poll re-reads, and the overwhelmingly
  // common case is "the number is already recorded and has not moved". One indexed read settles
  // that, so the steady state costs a row lookup rather than a locked transaction plus a queue scan.
  let so: { invoiceNumber: string | null; accountingInvoiceId: string | null } | null
  try {
    so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { invoiceNumber: true, accountingInvoiceId: true },
    })
  } catch (error) {
    console.error(`[wc-import] could not read the invoice number state for ${orderId}:`, error)
    return
  }
  if (!so) return

  let usableInvoiceNumber = so.invoiceNumber?.trim() || null
  if (usableInvoiceNumber !== resolvedInvoiceNumber.invoiceNumber) {
    const applied = await applyResolvedWcInvoiceNumber(orderId, wcOrder, resolvedInvoiceNumber.invoiceNumber)
    if (!applied.usable) return
    usableInvoiceNumber = applied.invoiceNumber
  }
  if (!usableInvoiceNumber) return

  // An order with a ledger document has nothing held: the hold exists precisely because nothing was
  // ever queued. Skipping here also refuses, structurally, to release an invoice for an order that
  // has already been invoiced.
  if (so.accountingInvoiceId) return
  await releaseHeldWcSalesInvoice(orderId, wcOrder, usableInvoiceNumber)
}

/**
 * Record WooCommerce's invoice number on the order — capturing it, leaving it, or correcting it.
 *
 * The rule is `decideStoredInvoiceNumberUpdate`; this is its wiring plus the two facts it needs
 * that only the database has. Taken under the order's row lock so the decision cannot be made
 * against a state that a concurrent accounting enqueue is in the middle of changing — that enqueue
 * takes the same lock (o3d-3zgy), so "nothing has committed to the stored number" stays true for
 * as long as it takes to act on it.
 *
 * Returns the number that is now on the order and whether it is safe to post under, so the caller
 * releases a held invoice under the CORRECTED number and never under a refused one.
 */
async function applyResolvedWcInvoiceNumber(
  orderId: string,
  wcOrder: WcFullOrder,
  incomingInvoiceNumber: string,
): Promise<{ usable: true; invoiceNumber: string } | { usable: false }> {
  const outcome = await db.$transaction(async (tx) => {
    await lockSalesOrder(tx, orderId)
    const so = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { invoiceNumber: true, accountingInvoiceId: true },
    })
    if (!so) return null
    // Any connector, and every state except CANCELLED: a CANCELLED row is a deliberately abandoned
    // posting that commits to nothing, while a FAILED one is NOT proof that nothing reached the
    // ledger — a lost response looks exactly like a failure.
    const salesInvoiceSyncRowCount = await tx.accountingSyncLog.count({
      where: {
        referenceType: 'SalesOrder',
        referenceId: orderId,
        type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] },
        status: { not: 'CANCELLED' },
      },
    })
    const decision = decideStoredInvoiceNumberUpdate({
      storedInvoiceNumber: so.invoiceNumber,
      incomingInvoiceNumber,
      accountingInvoiceId: so.accountingInvoiceId,
      salesInvoiceSyncRowCount,
    })

    if (decision.action === 'capture' || decision.action === 'correct') {
      // Compare-and-swap on the value we decided against, not a blind write.
      const from = decision.action === 'correct' ? decision.from : null
      const written = await tx.salesOrder.updateMany({
        where: { id: orderId, invoiceNumber: from },
        data: { invoiceNumber: decision.to },
      })
      if (written.count !== 1) return { decision, applied: false }
    }
    return { decision, applied: true }
  })

  if (!outcome) return { usable: false }
  const { decision, applied } = outcome

  if (decision.action === 'refuse-correction') {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'sales_invoice_number_correction_refused',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `WooCommerce order ${wcOrder.number} now reports invoice number ${decision.to}, but IMS keeps `
        + `${decision.from}: ${decision.reason}`,
      metadata: {
        connector: 'woocommerce',
        externalOrderId: String(wcOrder.id),
        externalOrderNumber: wcOrder.number,
        storedInvoiceNumber: decision.from,
        storefrontInvoiceNumber: decision.to,
      },
      resolveUser: false,
    }).catch(() => {})
    // The STORED number stays the truth for posting; a held invoice still releases under it.
    return { usable: true, invoiceNumber: decision.from }
  }

  if (decision.action === 'refuse-capture') {
    // o3d-k26m.5: the empty-column case that is NOT an innocent backfill. Every WooCommerce order
    // invoiced before o3d-k26m.1 has an empty column and a live Xero document numbered `INWC-…`;
    // writing WooCommerce's number in would make the next SALES_INVOICE_UPDATE try to renumber that
    // document onto the number xeroom is using.
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'sales_invoice_number_capture_refused',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `WooCommerce order ${wcOrder.number} reports invoice number ${decision.to}, but IMS will not record it: `
        + decision.reason,
      metadata: {
        connector: 'woocommerce',
        externalOrderId: String(wcOrder.id),
        externalOrderNumber: wcOrder.number,
        storefrontInvoiceNumber: decision.to,
      },
      resolveUser: false,
    }).catch(() => {})
    return { usable: false }
  }

  if (decision.action === 'correct' && applied) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'sales_invoice_number_corrected',
      tag: 'accounting',
      level: 'INFO',
      description:
        `WooCommerce order ${wcOrder.number} changed its invoice number from ${decision.from} to ${decision.to}. `
        + 'Nothing had been posted or queued under the old one, so IMS took the new number.',
      metadata: {
        connector: 'woocommerce',
        externalOrderId: String(wcOrder.id),
        externalOrderNumber: wcOrder.number,
        previousInvoiceNumber: decision.from,
        invoiceNumber: decision.to,
      },
      resolveUser: false,
    }).catch(() => {})
  }

  if (!applied) {
    // The compare-and-swap lost to a concurrent writer. Nothing is known about what is on the
    // order now, so do not release anything under a number we did not write.
    return { usable: false }
  }
  return { usable: true, invoiceNumber: decision.action === 'unchanged' ? decision.stored : decision.to }
}

/**
 * Park the sales-invoice payload for an order WooCommerce has not numbered yet (o3d-k26m.6).
 *
 * One row per order, replaced rather than appended: a re-import before the number arrives rebuilds
 * the payload from the newer WooCommerce snapshot, and the invoice that eventually posts should be
 * the one built from what the storefront says NOW, not from the first snapshot ever seen.
 */
async function holdWcSalesInvoiceForMissingNumber(params: {
  salesOrderId: string
  wcOrder: WcFullOrder
  orderNumber: string
  metaKey: string
  accountingPayload: Record<string, unknown>
}): Promise<void> {
  const held = buildHeldSalesInvoicePayload({
    externalOrderId: String(params.wcOrder.id),
    externalOrderNumber: params.wcOrder.number,
    salesOrderId: params.salesOrderId,
    orderNumber: params.orderNumber,
    metaKey: params.metaKey,
    accountingPayload: params.accountingPayload,
  })
  const jsonPayload = JSON.parse(JSON.stringify(held)) as Prisma.InputJsonValue
  const data = {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR' as const,
    status: 'PENDING' as const,
    entityType: 'SalesOrder',
    entityId: params.salesOrderId,
    externalId: String(params.wcOrder.id),
    payload: jsonPayload,
    errorMessage: `Waiting for ${params.metaKey} on WooCommerce order ${params.wcOrder.number} before the sales invoice can be posted.`,
    syncedAt: null,
  }

  const existing = await db.shoppingSyncLog.findFirst({
    where: heldSalesInvoiceQueueWhere({ salesOrderId: params.salesOrderId }),
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (existing) {
    await db.shoppingSyncLog.update({ where: { id: existing.id }, data })
  } else {
    await db.shoppingSyncLog.create({ data })
  }
}

/**
 * Queue the sales invoice that was held back for want of a number (o3d-k26m.6).
 *
 * ENQUEUE FIRST, MARK THE ROW SECOND. A crash between the two leaves the row PENDING, so the next
 * redelivery or poll releases it again — and the enqueue carries a deterministic idempotency key on
 * (order, number), which is what `queueXeroSync` dedupes on, so the second release finds the sync
 * row already there and adds nothing. The other order would be worse in the way that matters: a
 * crash after marking the row SYNCED but before enqueueing strands the invoice permanently, which
 * is the exact defect being fixed.
 *
 * AND THE ENQUEUE IS VERIFIED, NOT ASSUMED (Codex round 3). `queueAccountingSync` returns void and
 * RETURNS EARLY, silently, in several ordinary states: no accounting connector is active, the
 * connector's sync is switched off, this sync type's posting mode is `off`, or the sales order was
 * hard-deleted between the import and the enqueue (o3d-hrak). None of them throws, so the catch
 * below never sees them — and round 2 then marked the row SYNCED with "the sales invoice was
 * queued", which was false. The held invoice would never post and the one row that knew it was
 * waiting had just been closed, which is the exact defect this module exists to end, reintroduced
 * one line later.
 *
 * So the release ASKS THE DATABASE whether the sync row is really there, under the same key and
 * the same status set the enqueue itself dedupes on — the answer comes from the same place the
 * work has to come from, rather than from a return value the callee does not give. If it is not
 * there the held row stays PENDING and says so, so the next redelivery or poll retries it once the
 * connector is switched on.
 */
async function releaseHeldWcSalesInvoice(
  orderId: string,
  wcOrder: WcFullOrder,
  invoiceNumber: string,
): Promise<void> {
  let row: { id: string; payload: Prisma.JsonValue | null } | null = null
  try {
    row = await db.shoppingSyncLog.findFirst({
      where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }),
      orderBy: { createdAt: 'desc' },
      select: { id: true, payload: true },
    })
  } catch (error) {
    console.error(`[wc-import] could not look for a held sales invoice for ${orderId}:`, error)
    return
  }
  if (!row) return

  if (!isHeldSalesInvoicePayload(row.payload)) {
    // Not releasable and not silently droppable: this order will never be invoiced until somebody
    // acts, so it becomes a FAILED row with a reason rather than a PENDING row nobody reads.
    await db.shoppingSyncLog.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        errorMessage: 'The held sales-invoice payload is unreadable, so the invoice cannot be released automatically — queue it from the order.',
        syncedAt: new Date(),
      },
    }).catch(() => {})
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'sales_invoice_release_failed',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `WooCommerce order ${wcOrder.number} has its invoice number (${invoiceNumber}) but the held accounting `
        + 'payload could not be read, so the sales invoice was NOT queued. Queue it from the order.',
      metadata: { connector: 'woocommerce', externalOrderId: String(wcOrder.id), invoiceNumber },
      resolveUser: false,
    }).catch(() => {})
    return
  }

  const held = row.payload
  const idempotencyKey = `wc-held-sales-invoice:${orderId}:${invoiceNumber}`
  try {
    const { queueAccountingSync } = await import('@/lib/accounting')
    await queueAccountingSync({
      type: 'SALES_INVOICE',
      referenceType: 'SalesOrder',
      referenceId: orderId,
      payload: buildReleasedSalesInvoicePayload(held, invoiceNumber),
      idempotencyKey,
    })
  } catch (error) {
    // Left PENDING on purpose — the next redelivery or poll retries it.
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'sales_invoice_release_failed',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `WooCommerce order ${wcOrder.number} has its invoice number (${invoiceNumber}) but queueing the held `
        + 'sales invoice failed; it stays queued for release and retries on the next order sync.',
      metadata: {
        connector: 'woocommerce',
        externalOrderId: String(wcOrder.id),
        invoiceNumber,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      resolveUser: false,
    }).catch(() => {})
    return
  }

  // The enqueue can no-op silently — see the note above. A row that is not there was not queued,
  // and marking the hold "released" would strand the invoice with nothing left saying so.
  let queued: { id: string } | null = null
  try {
    queued = await db.accountingSyncLog.findFirst({
      // Deliberately the enqueue's OWN dedupe predicate — see releasedSalesInvoiceQueueWhere.
      where: releasedSalesInvoiceQueueWhere({ salesOrderId: orderId, idempotencyKey }),
      select: { id: true },
    })
  } catch (error) {
    console.error(`[wc-import] could not confirm the released sales invoice for ${orderId} was queued:`, error)
    return
  }
  if (!queued) {
    // Left PENDING on purpose, exactly as the throwing case is: the next redelivery or poll tries
    // again, and the deterministic key means a later success adds one row, not two.
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'sales_invoice_release_not_queued',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `WooCommerce order ${wcOrder.number} has its invoice number (${invoiceNumber}), but queueing the held `
        + 'sales invoice produced no accounting sync row, so NOTHING will post. The usual cause is that the '
        + 'accounting connector is disconnected, its sync is switched off, or Sales Invoices are set to off; the '
        + 'other is that the sales order was deleted. The order stays queued for release and retries on the next '
        + 'order sync.',
      metadata: { connector: 'woocommerce', externalOrderId: String(wcOrder.id), invoiceNumber, idempotencyKey },
      resolveUser: false,
    }).catch(() => {})
    return
  }

  await db.shoppingSyncLog.update({
    where: { id: row.id },
    data: {
      status: 'SYNCED',
      errorMessage: `Released: WooCommerce assigned invoice number ${invoiceNumber}, and the sales invoice was queued.`,
      syncedAt: new Date(),
    },
  }).catch((error) => {
    // The invoice IS queued; only the bookkeeping failed. A repeat release deduplicates on the
    // idempotency key, so the worst case is one redundant lookup on the next sync.
    console.error(`[wc-import] released the held sales invoice for ${orderId} but could not mark the queue row:`, error)
  })

  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'sales_invoice_number_captured',
    tag: 'accounting',
    level: 'INFO',
    description:
      `WooCommerce order ${wcOrder.number} is now numbered ${invoiceNumber}; the sales invoice held back for it `
      + 'has been queued.',
    metadata: {
      connector: 'woocommerce',
      externalOrderId: String(wcOrder.id),
      externalOrderNumber: wcOrder.number,
      invoiceNumber,
    },
    resolveUser: false,
  }).catch(() => {})
}

/**
 * Resolve the direct-create marker THIS import just wrote: answer the coverage question under
 * the order lock, record a shortfall if the demand is genuinely uncovered, and clear the marker.
 *
 * CALLED ONLY BY THE PATH THAT CREATED THE MARKER, and only after that path's own
 * `autoAllocateOrder` has finished. That ordering is the correctness argument: before the
 * allocation runs the order has no allocation rows at all, so anything that answered the
 * coverage question in that window would read "short", record a shortfall for an order about to
 * be covered, and clear the marker so the true answer could never be written. The redelivery
 * path used to do exactly that (Codex review r4); marker recovery now belongs to
 * `sweepUnresolvedDirectCreateMarkers`, which waits out the import's grace window first.
 *
 * IT ALSO CORRECTS A PREMATURE VERDICT. If this import was delayed past the marker sweep's grace
 * window, the sweep may already have answered the coverage question — against an order that had
 * not been allocated yet — and cleared the marker. Finding no marker is therefore not a reason to
 * stop: `resolveDirectCreateMarker` re-asks the question with the allocation now in place and
 * withdraws the record if it has been superseded. Both sides answer under this same row lock, so
 * they cannot interleave, and this one runs strictly after the allocation, which makes it the
 * later and better-informed of the two (Codex review r5).
 *
 * It is also why the hot webhook path pays nothing: an import that wrote no marker never calls
 * this, and a redelivery never calls it at all — cheaper than the lock-free pre-check this
 * replaces, which still cost one indexed query on every import of every order.
 *
 * NON-FATAL BY DESIGN. The order and its allocation are already committed by the time this runs,
 * so failing the import undoes nothing — it only produces a retry that returns from the
 * already-imported branch without repairing anything. The MARKER is what makes that safe: it is
 * written atomically with the order, so if this never succeeds the marker still stands as a
 * visible WARNING that coverage was never verified, and the sweep picks it up.
 *
 * A longer budget than Prisma's 5s default, matching the transition path: the coverage check
 * loads the fulfilment product graph and a KIT-heavy order can genuinely take longer.
 */
async function resolveDirectCreateShortfall(orderId: string): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      await resolveDirectCreateMarker({ tx, orderId })
    }, { maxWait: 5_000, timeout: 20_000 })
  } catch (error) {
    console.error(`[wc-import] could not verify fulfilment coverage for ${orderId}:`, error)
  }
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
      // o3d-z82a: deliberately NO marker resolution here. A redelivery can arrive while the
      // import that created the order is still between its create transaction and its
      // allocation, and resolving then answers the coverage question against an order that has
      // no allocations YET — recording a shortfall that was about to be covered and discharging
      // the marker permanently (Codex review r4). An unresolved marker is recovered by
      // sweepUnresolvedDirectCreateMarkers instead, which waits out the import's grace window.
      // It also keeps this, the hot path, free of the feature entirely.
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
        // o3d-5tf: the allocation tolerance is half a MINOR UNIT of this order's currency, not a
        // hard-coded half-penny — a WooCommerce store can run a 0- or 3-decimal currency.
        currency,
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
    // NB: only the ORDER prefix is read here. The accounting invoice prefix
    // (`woocommerce_inv_prefix`) no longer participates in the invoice number — o3d-k26m.1.
    const { orderPrefix: wcOrderPrefix } =
      await getShoppingConnectorPrefixes('woocommerce')
    const orderNumber = `${wcOrderPrefix}${wcOrder.number}`

    // o3d-k26m.1: the accounting invoice number is WooCommerce's, not ours. Resolved here —
    // before the order row is written — so the SAME value is persisted on the SalesOrder and
    // sent to the accounting connector, and so a later re-queue from the IMS side cannot post a
    // second, differently-numbered document for the same order. `wcInvPrefix` is deliberately
    // NOT applied to it; see lib/connectors/woocommerce/sync/invoice-number.ts.
    const invoiceNumberResolution = resolveWcAccountingInvoiceNumber(wcOrder)

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
      so = await db.$transaction(async (tx) => {
        const created = await tx.salesOrder.create({
        data: {
          externalOrderNumber: wcOrder.number,
          orderNumber,
          // o3d-k26m.1: persist WooCommerce's own invoice number so IMS shows, prints and posts
          // the same document number the customer's PDF already carries. Left null when the PDF
          // plugin has not numbered the invoice yet — a null here is the honest record that no
          // number exists, and `generateInvoiceNumber` must not be used to fill it for a
          // WooCommerce order.
          ...(invoiceNumberResolution.ok ? { invoiceNumber: invoiceNumberResolution.invoiceNumber } : {}),
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

        // o3d-z82a: the marker is written in the SAME transaction as the order, so it cannot be
        // lost. It carries the CREATION status as durable provenance — the retry path used to
        // infer that from the order's current status, which is unsound in both directions: an
        // order created PROCESSING and later moved to PICKING by a transition (which has its
        // own recorder) would get a false "created directly at PICKING", and a genuinely
        // direct-created order that reached SHIPPED first would be skipped and lose its record
        // permanently (Codex review).
        if (isFulfilmentStatus(lifecycleStatus)) {
          await tx.activityLog.create({ data: directCreateMarker(created.id, lifecycleStatus) })
        }
        return created
      }, { maxWait: 5_000, timeout: 20_000 })
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
    // tolerated by the allocation block above, and partial coverage returns success when every
    // uncovered line is backorderEligible -- which requires a shortage AND oversellAllowed, not
    // either one).
    //
    // No allocation attempt here — the importer already made one. What was missing is the
    // record. Resolves the marker written with the order above, under the order lock and in one
    // transaction, so the record and the clearing of the marker can never disagree.
    //
    // The guarantee is deliberately WEAKER than the transition path's, and the difference is
    // worth naming. There, the record is atomic with the crossing: if it cannot be written, the
    // crossing does not happen. Here the order is already committed by the time this runs, so
    // failing the import undoes nothing — this is non-fatal, and what carries the obligation
    // forward is the MARKER, which was written atomically with the order and survives as a
    // visible WARNING until the sweep resolves it.
    //
    // Guarded by the SAME condition that wrote the marker, so an import that wrote none does no
    // work at all rather than querying to discover that. It runs AFTER the allocation above:
    // resolving before it would read an order that has no allocation rows yet.
    if (isFulfilmentStatus(lifecycleStatus)) {
      await resolveDirectCreateShortfall(so.id)
    }

    // Queue accounting sales invoice — only for PROCESSING orders, when accounting is not
    // explicitly skipped (e.g. initial import), and when WooCommerce has actually numbered the
    // invoice.
    const finishWithoutAccounting = async (reason: string) => {
      if (options.pendingFxRetryLogId) {
        await db.shoppingSyncLog.update({
          where: { id: options.pendingFxRetryLogId },
          data: { entityId: so.id, status: 'SYNCED', errorMessage: reason, syncedAt: new Date() },
        })
      } else {
        await db.shoppingSyncLog.create({
          data: {
            direction: 'FROM_CONNECTOR',
            entityType: 'ORDER',
            entityId: so.id,
            externalId: String(wcOrder.id),
            status: 'SYNCED',
            errorMessage: reason,
          },
        })
      }
      return { success: true as const, orderId: so.id }
    }

    if (imsStatus !== 'PROCESSING' || options.skipAccounting) {
      return await finishWithoutAccounting(
        `Imported as ${imsStatus}${options.skipAccounting ? ' (initial import)' : ''} — skipped accounting sync`,
      )
    }

    // o3d-k26m.1: NO INVOICE NUMBER MEANS NO POST. The alternative — post now under a number of
    // our own and correct it later — is not available: the sales-invoice create is an upsert on
    // InvoiceNumber, so the correction would post a SECOND document rather than replace the
    // first. Holding the order back is recoverable (the number arrives, an operator re-queues);
    // a wrongly-numbered document in a live ledger is not.
    //
    // o3d-k26m.6: BUT THE PAYLOAD IS PARKED, NOT DISCARDED. "Holding back is recoverable" is only
    // true if something recovers, and the first cut of this refusal recovered nothing: the
    // redelivery captured the number onto the order and no invoice was ever queued for it, so the
    // remedy the warning advertised ran to completion and produced nothing. The payload the import
    // would have sent is stored against the order and enqueued verbatim — plus the number — the
    // moment WooCommerce assigns one. See ./held-sales-invoice.ts for why it is parked rather than
    // rebuilt later.
    const heldReason = invoiceNumberResolution.ok
      ? null
      : `Accounting sales invoice HELD — ${invoiceNumberResolution.reason}`

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
      // Built ONCE, with no invoice number in it, so the held path and the posting path can never
      // differ in anything but the number (o3d-k26m.6).
      const accountingPayload: Record<string, unknown> = {
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
      }

      if (invoiceNumberResolution.ok) {
        await queueAccountingSync({
          type: 'SALES_INVOICE',
          referenceType: 'SalesOrder',
          referenceId: so.id,
          payload: { invoiceNumber: invoiceNumberResolution.invoiceNumber, ...accountingPayload },
        })
      } else {
        await holdWcSalesInvoiceForMissingNumber({
          salesOrderId: so.id,
          wcOrder,
          orderNumber,
          metaKey: invoiceNumberResolution.metaKey,
          accountingPayload,
        })
      }
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

    // o3d-k26m.1/.6: the order imported, nothing was posted, and the reason lands on the sync row.
    // Logged out here, after the try/catch, so that a failure to PARK the payload still leaves the
    // operator-facing warning and still refuses to post — the refusal is the safety, the parking is
    // only the convenience.
    if (heldReason) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'sales_invoice_number_unavailable',
        tag: 'accounting',
        level: 'WARNING',
        description:
          `${heldReason} The invoice is queued for release: IMS posts it automatically as soon as WooCommerce PDF `
          + `Invoices numbers order ${wcOrder.number} and the next order sync sees it. Nothing to do unless it stays here.`,
        metadata: {
          connector: 'woocommerce',
          externalOrderId: String(wcOrder.id),
          externalOrderNumber: wcOrder.number,
          orderNumber,
          metaKey: invoiceNumberResolution.ok ? null : invoiceNumberResolution.metaKey,
        },
      })
      return await finishWithoutAccounting(heldReason)
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
          // The cursor below only advances on a clean run, and a refund list read only in part is
          // not clean: advancing past this order is what makes the missing refunds permanent, since
          // nothing here is re-driven by anything else. Recorded as an error so the cursor is HELD
          // and the next run re-reads this order from the first page (o3d-ecbj r5).
          const refundSweep = await syncRefundsForOrder(order.id)
          if (!refundSweep.complete) {
            result.errors.push(
              `syncRefundsForOrder #${order.id}: incomplete refund read — ${refundSweep.error ?? 'unknown error'}`,
            )
          }
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
