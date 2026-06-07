/**
 * WooCommerce → IMS order import.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import type { WcFullOrder, SyncResult } from './types'
import {
  mapWcAddress, upsertCustomer, mapWcLineItems, mapWcOrderDiscount,
  mapWcFeeLines, mapWcShipping, resolveWcTaxRateById, getFxRateToGbp,
} from './field-mapping'
import { syncRefundsForOrder } from './refund-sync'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { resolveLineTaxRateBatch } from '@/lib/tax/resolve-rate'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { TaxCategory } from '@/app/generated/prisma/client'
import { getSettingValue } from '@/lib/settings-store'

// ---------------------------------------------------------------------------
// Import a single WC order into IMS
// ---------------------------------------------------------------------------

export type ImportWcOrderOptions = { skipAccounting?: boolean; useWcDateAsCreatedAt?: boolean }

const WEBHOOK_PRIMARY_FRESH_MS = 24 * 60 * 60 * 1000

export type WcTaxRateFallbackLine = {
  sku: string
  productCategory: TaxCategory
  externalTaxRateId: number | null
  taxRateValue: number
  warning: string | null
}

export function shouldBlockWcTaxRateFallback(lines: WcTaxRateFallbackLine[]): boolean {
  return lines.some((line) => line.taxRateValue > 0)
}

function roundDecimalNumber(value: DecimalInput, precision: number): number {
  return roundQuantity(value, precision).toNumber()
}

function divideRoundedNumber(value: DecimalInput, divisor: DecimalInput, precision: number): number {
  return roundDecimalNumber(toDecimal(value).div(toDecimal(divisor)), precision)
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002'
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
      },
    })
    await tx.salesOrder.update({
      where: { id: orderId },
      data: {
        externalOrderNumber: wcOrder.number,
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
      { taxRateId: string | null; taxRateName: string | null; taxRateValue: number; accountingTaxType: string | null; source?: 'mapped' | 'default' }
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

    const taxFallbackLines: WcTaxRateFallbackLine[] = []
    const lineTaxResolved = mappedLines.map((l, idx) => {
      if (l.forceNoTax) {
        return {
          taxRateId: null,
          taxRateName: null,
          taxRateValue: 0,
          accountingTaxType: null,
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
        matched: 'fallback' as const,
        warning: `No configured sales rate for ${destCountry ? destCountry.toUpperCase() : 'unknown country'} / ${l.taxCategoryFallback ?? 'STANDARD'}. Using order default.`,
      }
      if (resolved.matched === 'fallback') {
        taxFallbackLines.push({
          sku: l.sku,
          productCategory: (l.productId && productCategoryById.get(l.productId)) || l.taxCategoryFallback || ('STANDARD' as TaxCategory),
          externalTaxRateId: l.externalTaxRateId ?? null,
          taxRateValue: resolved.taxRateValue,
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

    // Calculate totals from WC data (per-line rates for net extraction)
    const subtotalForeign = mappedLines.reduce((s, l, idx) => {
      const rate = lineTaxResolved[idx].taxRateValue
      const lineNet = pricesIncludeVat
        ? (l.qty * l.unitPriceForeign - l.discountAmount) / (1 + rate)
        : l.qty * l.unitPriceForeign - l.discountAmount
      return s + lineNet
    }, 0)

    // Order-level discount (from coupons — separate from line discounts)
    const orderDiscount = mapWcOrderDiscount(wcOrder.coupon_lines)

    // Shipping
    const shipping = mapWcShipping(wcOrder)
    const shippingForeign = shipping.shippingForeign

    const shippingTaxForeign = wcOrder.shipping_lines.reduce(
      (sum, line) => sum + (parseFloat(line.total_tax) || 0),
      0,
    )
    const taxForeign = mappedLines.reduce((sum, line) => sum + line.taxForeign, 0) + shippingTaxForeign
    const totalForeign = parseFloat(wcOrder.total) || 0

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
          status: imsStatus,
          shipFromWarehouseId: wcDefaultWarehouseId,
          currency,
          fxRateToBase: fxRate,
          customerId,
          customerName,
          customerEmail: wcOrder.billing.email || null,
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
          discountStr: orderDiscount.discountStr,
          discountAmount: orderDiscount.discountAmount,
          notes: wcOrder.customer_note || null,
          paidAt: wcOrder.date_paid_gmt ? new Date(wcOrder.date_paid_gmt) : null,
          shoppingLinks: {
            create: {
              connector: 'woocommerce',
              externalOrderId: String(wcOrder.id),
              externalOrderNumber: wcOrder.number,
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
    const TERMINAL_STATUSES = ['CANCELLED', 'REFUNDED']
    if (!TERMINAL_STATUSES.includes(imsStatus)) {
      const { autoAllocateOrder } = await import('@/app/actions/allocation')
      const allocation = await autoAllocateOrder(so.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
      if (!allocation.success && allocation.error !== 'No stock available for allocation') {
        throw new Error(`WooCommerce order imported but auto-allocation failed: ${allocation.error ?? 'Unknown error'}`)
      }
    }

    // Queue accounting sales invoice — only for PROCESSING orders and when
    // accounting is not explicitly skipped (e.g. initial import).
    const shouldInvoice = imsStatus === 'PROCESSING' && !options.skipAccounting
    if (!shouldInvoice) {
      // Log sync but skip accounting
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
      // WooCommerce coupon discounts are imported exactly as stored on the
      // order so the accounting connector sees the original order-currency
      // discount amount without a base-currency round-trip.
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
            taxType: lineTaxResolved[idx]?.accountingTaxType ?? accountingTaxType ?? undefined,
            discountAmount: l.discountAmount > 0 ? roundDecimalNumber(l.discountAmount, 4) : undefined,
          })),
          shippingAmount: shippingSendForeign.gt(0) ? roundDecimalNumber(shippingSendForeign, 4) : undefined,
          shippingDescription: 'Shipping',
          shippingAccountCode: settings.shippingAccount || undefined,
          shippingTaxType: accountingTaxType ?? undefined,
          discountAmount: orderDiscount.discountAmount > 0 ? roundDecimalNumber(orderDiscount.discountAmount, 2) : undefined,
          discountAccountCode: settings.discountAccount || undefined,
          discountTaxType: accountingTaxType ?? undefined,
          lineAmountsIncludeTax: pricesIncludeVat,
          _postingMode: 'submitted',
          _registerPayment: !!wcOrder.date_paid_gmt,
          _paymentMethod: wcOrder.payment_method || undefined,
          _paymentDate: wcOrder.date_paid_gmt || undefined,
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

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'imported',
      tag: 'sync',
      level: 'INFO',
      description: `Imported WC order #${wcOrder.number} (${currency} ${totalForeign.toFixed(2)})`,
      metadata: { externalOrderId: wcOrder.id, wcNumber: wcOrder.number, currency, total: totalForeign },
      resolveUser: false,
    })

    return { success: true, orderId: so.id }
  } catch (e) {
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
    return { success: false, error: String(e) }
  }
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
      const importResult = await importWcOrder(order)
      if (importResult.success) {
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
