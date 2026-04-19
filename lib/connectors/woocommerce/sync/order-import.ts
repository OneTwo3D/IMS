/**
 * WooCommerce → IMS order import.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import type { WcFullOrder, SyncResult } from './types'
import {
  mapWcAddress, upsertCustomer, mapWcLineItems, mapWcOrderDiscount,
  mapWcShipping, resolveWcTaxRateById, getFxRateToGbp,
} from './field-mapping'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { resolveLineTaxRateBatch } from '@/lib/tax/resolve-rate'
import type { TaxCategory } from '@/app/generated/prisma/client'
import { getSettingValue } from '@/lib/settings-store'

// ---------------------------------------------------------------------------
// Import a single WC order into IMS
// ---------------------------------------------------------------------------

export type ImportWcOrderOptions = { skipAccounting?: boolean; useWcDateAsCreatedAt?: boolean }

const WEBHOOK_PRIMARY_FRESH_MS = 24 * 60 * 60 * 1000

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
    if (existing) return { success: true, orderId: existing.id }

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
    const fxRate = await getFxRateToGbp(currency)

    // Primary (order-level) tax rate — looked up from the WC tax_lines
    // summary; this is the "default" rate stored on the order and used for
    // shipping / discount VAT.
    const primaryWcRateId =
      wcOrder.tax_lines?.[0]?.rate_id ??
      wcOrder.line_items?.[0]?.taxes?.[0]?.id ??
      null
    const {
      taxRateId: orderDefaultTaxRateId,
      taxRateName,
      taxRateValue,
      accountingTaxType,
    } = await resolveWcTaxRateById(primaryWcRateId)
    const pricesIncludeVat = wcOrder.prices_include_tax

    // Line items (each one may carry its own externalTaxRateId)
    const mappedLines = await mapWcLineItems(wcOrder.line_items, fxRate)

    // --- Per-line tax resolution --------------------------------------
    // 1. Where WC sent a per-line tax rate id, trust it (WC computed it
    //    server-side including shipping-country logic).
    // 2. Otherwise, fall back to the IMS resolver on (productCategory,
    //    shippingCountry, SALES).
    const distinctWcRateIds = Array.from(
      new Set(mappedLines.map((l) => l.externalTaxRateId).filter((x): x is number => typeof x === 'number')),
    )
    const wcResolvedById = new Map<
      number,
      { taxRateId: string | null; taxRateName: string | null; taxRateValue: number; accountingTaxType: string | null }
    >()
    for (const id of distinctWcRateIds) {
      wcResolvedById.set(id, await resolveWcTaxRateById(id))
    }

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
        productCategory: (l.productId && productCategoryById.get(l.productId)) || ('STANDARD' as TaxCategory),
        hasWc: l.externalTaxRateId != null,
      }))
      .filter((l) => !l.hasWc)
    const resolverMap = await resolveLineTaxRateBatch(
      needsResolver.map((l) => ({ id: l.id, productCategory: l.productCategory })),
      { destinationCountry: destCountry, usedFor: 'SALES', orderDefault: orderDefaultCtx },
    )

    const lineTaxResolved = mappedLines.map((l, idx) => {
      if (l.externalTaxRateId != null) {
        const wc = wcResolvedById.get(l.externalTaxRateId)
        if (wc) return wc
      }
      return (
        resolverMap.get(String(idx)) ?? {
          taxRateId: orderDefaultTaxRateId,
          taxRateName: taxRateName,
          taxRateValue: taxRateValue,
          accountingTaxType: accountingTaxType,
        }
      )
    })

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

    // Tax totals from WC (more accurate than recalculating)
    const taxForeign = parseFloat(wcOrder.total_tax) || 0
    const totalForeign = parseFloat(wcOrder.total) || 0

    // GBP conversions
    const subtotalBase = Math.round((subtotalForeign / fxRate) * 10000) / 10000
    const shippingBase = Math.round((shippingForeign / fxRate) * 10000) / 10000
    const taxBase = Math.round((taxForeign / fxRate) * 10000) / 10000
    const totalBase = Math.round((totalForeign / fxRate) * 10000) / 10000

    // Line data for Prisma
    const lineData = mappedLines.map((l, idx) => {
      const resolved = lineTaxResolved[idx]
      const rate = resolved.taxRateValue
      const netForeign = pricesIncludeVat
        ? (l.qty * l.unitPriceForeign - l.discountAmount) / (1 + rate)
        : l.qty * l.unitPriceForeign - l.discountAmount
      const unitPriceBase = Math.round((l.unitPriceForeign / fxRate) * 1000000) / 1000000
      const totalLineForeign = Math.round(netForeign * 10000) / 10000
      const totalLineGbp = Math.round((totalLineForeign / fxRate) * 10000) / 10000
      const taxLineForeign = l.taxForeign
      const taxLineGbp = Math.round((taxLineForeign / fxRate) * 10000) / 10000

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
          externalOrderId: wcOrder.id,
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
          pricesIncludeVat: !!pricesIncludeVat && taxRateValue > 0,
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
      if (concurrent) return { success: true, orderId: concurrent.id }
      throw error
    }

    // Auto-allocate stock (skip for terminal statuses)
    const TERMINAL_STATUSES = ['CANCELLED', 'REFUNDED']
    if (!TERMINAL_STATUSES.includes(imsStatus)) {
      const { autoAllocateOrder } = await import('@/app/actions/allocation')
      await autoAllocateOrder(so.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
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
      const fxRateNum = Number(fxRate) || 1
      // WC stores shipping_total already NET; line prices may be gross when
      // the WC store is configured with prices_include_tax. Send everything
      // to Xero as tax-inclusive when WC was inclusive so gross line prices
      // are interpreted correctly — shipping is converted to gross first to
      // stay consistent with the LineAmountTypes flag.
      const vatMultiplier = 1 + (taxRateValue || 0)
      const shippingNetGbp = shippingForeign > 0 ? shippingForeign / fxRateNum : 0
      const shippingSendForeign = pricesIncludeVat ? shippingNetGbp * vatMultiplier * fxRateNum : shippingForeign
      // WC coupon discounts in `discount_total` are NET when prices_include_tax
      // is false, and GROSS when true — mapWcOrderDiscount stores the raw
      // value so pass it through in the same inclusive/exclusive mode.
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
          reference: orderNumber,
          lines: lineData.map((l, idx) => ({
            itemCode: l.sku ?? undefined,
            description: l.description ?? l.sku ?? 'Item',
            quantity: l.qty,
            unitAmount: l.unitPriceForeign,
            accountCode: settings.salesAccount,
            taxType: lineTaxResolved[idx]?.accountingTaxType ?? accountingTaxType ?? undefined,
          })),
          shippingAmount: shippingSendForeign > 0 ? Math.round(shippingSendForeign * 10000) / 10000 : undefined,
          shippingDescription: 'Shipping',
          shippingAccountCode: settings.shippingAccount || undefined,
          shippingTaxType: accountingTaxType ?? undefined,
          discountAmount: orderDiscount.discountAmount > 0 ? Math.round(orderDiscount.discountAmount * 100) / 100 : undefined,
          discountAccountCode: settings.discountAccount || undefined,
          discountTaxType: accountingTaxType ?? undefined,
          lineAmountsIncludeTax: pricesIncludeVat,
          _postingMode: 'submitted',
          _registerPayment: !!wcOrder.date_paid_gmt,
          _paymentMethod: wcOrder.payment_method || undefined,
          _paymentDate: wcOrder.date_paid_gmt || undefined,
        },
      })
    } catch { /* Accounting queue errors should never block import */ }

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
  const [statusesSetting, lastSyncSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: 'wc_sync_order_statuses' } }),
    db.setting.findUnique({ where: { key: cursorKey } }),
  ])

  let statuses: string[]
  try { statuses = statusesSetting?.value ? JSON.parse(statusesSetting.value) : ['processing'] }
  catch { statuses = ['processing'] }

  const lastSync = lastSyncSetting?.value || null

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
        if (importResult.orderId) result.synced++
        else result.skipped++
      } else {
        result.errors.push(`Order #${order.number}: ${importResult.error}`)
      }
    }

    page++
  }

  // Update last sync timestamp
  await db.setting.upsert({
    where: { key: cursorKey },
    create: { key: cursorKey, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

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
