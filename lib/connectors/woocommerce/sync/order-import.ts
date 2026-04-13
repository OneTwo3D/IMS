/**
 * WooCommerce → IMS order import.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import type { WcFullOrder, SyncResult } from './types'
import {
  mapWcAddress, upsertCustomer, mapWcLineItems, mapWcOrderDiscount,
  mapWcShipping, resolveWcTaxRateById, extractWcTracking, getFxRateToGbp,
} from './field-mapping'
import { resolveLineTaxRateBatch } from '@/lib/tax/resolve-rate'
import type { TaxCategory } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// Import a single WC order into IMS
// ---------------------------------------------------------------------------

export type ImportWcOrderOptions = { skipAccounting?: boolean; useWcDateAsCreatedAt?: boolean }

export async function importWcOrder(wcOrder: WcFullOrder, options: ImportWcOrderOptions = {}): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    // Skip if already imported
    const existing = await db.salesOrder.findUnique({ where: { wcOrderId: wcOrder.id } })
    if (existing) return { success: true, orderId: existing.id }

    // Resolve IMS status from WC status
    const statusMapping = await db.wcStatusMapping.findUnique({ where: { wcStatus: wcOrder.status } })
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

    // Line items (each one may carry its own wcTaxRateId)
    const mappedLines = await mapWcLineItems(wcOrder.line_items, fxRate)

    // --- Per-line tax resolution --------------------------------------
    // 1. Where WC sent a per-line tax rate id, trust it (WC computed it
    //    server-side including shipping-country logic).
    // 2. Otherwise, fall back to the IMS resolver on (productCategory,
    //    shippingCountry, SALES).
    const distinctWcRateIds = Array.from(
      new Set(mappedLines.map((l) => l.wcTaxRateId).filter((x): x is number => typeof x === 'number')),
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
        hasWc: l.wcTaxRateId != null,
      }))
      .filter((l) => !l.hasWc)
    const resolverMap = await resolveLineTaxRateBatch(
      needsResolver.map((l) => ({ id: l.id, productCategory: l.productCategory })),
      { destinationCountry: destCountry, usedFor: 'SALES', orderDefault: orderDefaultCtx },
    )

    const lineTaxResolved = mappedLines.map((l, idx) => {
      if (l.wcTaxRateId != null) {
        const wc = wcResolvedById.get(l.wcTaxRateId)
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
    const shippingForeign = parseFloat(wcOrder.shipping_total) || 0 // net shipping (excl tax)

    // Tax totals from WC (more accurate than recalculating)
    const taxForeign = parseFloat(wcOrder.total_tax) || 0
    const totalForeign = parseFloat(wcOrder.total) || 0

    // GBP conversions
    const subtotalGbp = Math.round((subtotalForeign / fxRate) * 10000) / 10000
    const shippingGbp = Math.round((shippingForeign / fxRate) * 10000) / 10000
    const taxGbp = Math.round((taxForeign / fxRate) * 10000) / 10000
    const totalGbp = Math.round((totalForeign / fxRate) * 10000) / 10000

    // Line data for Prisma
    const lineData = mappedLines.map((l, idx) => {
      const resolved = lineTaxResolved[idx]
      const rate = resolved.taxRateValue
      const netForeign = pricesIncludeVat
        ? (l.qty * l.unitPriceForeign - l.discountAmount) / (1 + rate)
        : l.qty * l.unitPriceForeign - l.discountAmount
      const unitPriceGbp = Math.round((l.unitPriceForeign / fxRate) * 1000000) / 1000000
      const totalLineForeign = Math.round(netForeign * 10000) / 10000
      const totalLineGbp = Math.round((totalLineForeign / fxRate) * 10000) / 10000
      const taxLineForeign = l.taxForeign
      const taxLineGbp = Math.round((taxLineForeign / fxRate) * 10000) / 10000

      return {
        productId: l.productId,
        wcLineItemId: l.wcLineItemId,
        sku: l.sku,
        description: l.description,
        qty: l.qty,
        unitPriceForeign: l.unitPriceForeign,
        unitPriceGbp,
        discountStr: l.discountStr,
        discountAmount: l.discountAmount,
        taxRateId: resolved.taxRateId,
        taxForeign: taxLineForeign,
        taxGbp: taxLineGbp,
        totalForeign: totalLineForeign,
        totalGbp: totalLineGbp,
      }
    })

    // Read unified numbering settings via the shopping connector registry
    // (Settings → Company → Numbering → Shopping Connectors → WooCommerce)
    const { getShoppingConnectorPrefixes } = await import('@/lib/connectors/shopping-registry')
    const { orderPrefix: wcOrderPrefix, invPrefix: wcInvPrefix } =
      await getShoppingConnectorPrefixes('woocommerce')
    const orderNumber = `${wcOrderPrefix}${wcOrder.number}`

    // Find the default WC warehouse — prefer isDefault + syncToWoocommerce,
    // fall back to any syncToWoocommerce warehouse.
    const wcWarehouses = await db.warehouse.findMany({
      where: { active: true, syncToWoocommerce: true },
      select: { id: true, isDefault: true },
      orderBy: { isDefault: 'desc' },
    })
    const wcDefaultWarehouseId = wcWarehouses[0]?.id ?? null

    // Create the sales order
    const so = await db.salesOrder.create({
      data: {
        wcOrderId: wcOrder.id,
        wcOrderNumber: wcOrder.number,
        orderNumber,
        paymentMethod: wcOrder.payment_method || null,
        paymentMethodTitle: wcOrder.payment_method_title || null,
        wcCreatedAt: new Date(wcOrder.date_created_gmt || wcOrder.date_created),
        wcUpdatedAt: new Date(wcOrder.date_modified_gmt || wcOrder.date_modified),
        ...(options.useWcDateAsCreatedAt ? { createdAt: new Date(wcOrder.date_created_gmt || wcOrder.date_created) } : {}),
        status: imsStatus,
        shipFromWarehouseId: wcDefaultWarehouseId,
        currency,
        fxRateToGbp: fxRate,
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
        subtotalGbp,
        shippingGbp,
        taxGbp,
        totalGbp,
        discountStr: orderDiscount.discountStr,
        discountAmount: orderDiscount.discountAmount,
        notes: wcOrder.customer_note || null,
        paidAt: wcOrder.date_paid_gmt ? new Date(wcOrder.date_paid_gmt) : null,
        lines: { create: lineData },
      },
    })

    // Auto-allocate stock (skip for terminal statuses)
    const TERMINAL_STATUSES = ['CANCELLED', 'REFUNDED']
    if (!TERMINAL_STATUSES.includes(imsStatus)) {
      const { autoAllocateOrder } = await import('@/app/actions/allocation')
      await autoAllocateOrder(so.id)
    }

    // Queue accounting sales invoice — only for PROCESSING orders and when
    // accounting is not explicitly skipped (e.g. initial import).
    const shouldInvoice = imsStatus === 'PROCESSING' && !options.skipAccounting
    if (!shouldInvoice) {
      // Log sync but skip accounting
      await db.wcSyncLog.create({
        data: {
          direction: 'FROM_WC',
          entityType: 'ORDER',
          entityId: so.id,
          wcId: wcOrder.id,
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
      const shippingSendGbp = pricesIncludeVat ? shippingNetGbp * vatMultiplier : shippingNetGbp
      // WC coupon discounts in `discount_total` are NET when prices_include_tax
      // is false, and GROSS when true — mapWcOrderDiscount stores the raw
      // value so pass it through in the same inclusive/exclusive mode.
      const discountGbpRaw = orderDiscount.discountAmount / fxRateNum
      const discountGbp = Math.round(discountGbpRaw * 100) / 100
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
            unitAmount: Math.round((l.unitPriceForeign / fxRateNum) * 10000) / 10000,
            accountCode: settings.salesAccount,
            taxType: lineTaxResolved[idx]?.accountingTaxType ?? accountingTaxType ?? undefined,
          })),
          shippingAmount: shippingSendGbp > 0 ? Math.round(shippingSendGbp * 10000) / 10000 : undefined,
          shippingDescription: 'Shipping',
          shippingAccountCode: settings.shippingAccount || undefined,
          shippingTaxType: accountingTaxType ?? undefined,
          discountAmount: discountGbp > 0 ? discountGbp : undefined,
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
    await db.wcSyncLog.create({
      data: {
        direction: 'FROM_WC',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: so.id,
        wcId: wcOrder.id,
        syncedAt: new Date(),
      },
    })

    logActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'imported',
      tag: 'sync',
      level: 'INFO',
      description: `Imported WC order #${wcOrder.number} (${currency} ${totalForeign.toFixed(2)})`,
      metadata: { wcOrderId: wcOrder.id, wcNumber: wcOrder.number, currency, total: totalForeign },
    })

    return { success: true, orderId: so.id }
  } catch (e) {
    await db.wcSyncLog.create({
      data: {
        direction: 'FROM_WC',
        status: 'FAILED',
        entityType: 'SalesOrder',
        wcId: wcOrder.id,
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

export async function syncNewWcOrders(): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: [] }

  // Guard: initial import must be completed before ongoing sync runs
  const initialImportSetting = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (initialImportSetting?.value !== 'true') {
    return { synced: 0, skipped: 0, errors: ['Initial order import has not been completed yet. Run the initial import first.'] }
  }

  // Read settings
  const [statusesSetting, lastSyncSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: 'wc_sync_order_statuses' } }),
    db.setting.findUnique({ where: { key: 'last_wc_order_sync_at' } }),
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
    where: { key: 'last_wc_order_sync_at' },
    create: { key: 'last_wc_order_sync_at', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  if (result.synced > 0) {
    logActivity({
      entityType: 'SYNC',
      action: 'order_sync',
      tag: 'sync',
      level: 'INFO',
      description: `WC order sync: ${result.synced} imported, ${result.skipped} skipped, ${result.errors.length} errors`,
    })
  }

  return result
}
