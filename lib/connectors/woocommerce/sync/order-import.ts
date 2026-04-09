/**
 * WooCommerce → IMS order import.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import type { WcFullOrder, SyncResult } from './types'
import {
  mapWcAddress, upsertCustomer, mapWcLineItems, mapWcOrderDiscount,
  mapWcShipping, resolveWcTaxRate, extractWcTracking, getFxRateToGbp,
} from './field-mapping'

// ---------------------------------------------------------------------------
// Import a single WC order into IMS
// ---------------------------------------------------------------------------

export async function importWcOrder(wcOrder: WcFullOrder): Promise<{ success: boolean; orderId?: string; error?: string }> {
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

    // Tax
    const primaryTaxClass = wcOrder.line_items[0]?.tax_class ?? 'standard'
    const { taxRateName, taxRateValue, xeroTaxType } = await resolveWcTaxRate(primaryTaxClass)
    const pricesIncludeVat = wcOrder.prices_include_tax

    // Line items
    const mappedLines = await mapWcLineItems(wcOrder.line_items, fxRate)

    // Calculate totals from WC data
    const subtotalForeign = mappedLines.reduce((s, l) => {
      const lineNet = pricesIncludeVat
        ? (l.qty * l.unitPriceForeign - l.discountAmount) / (1 + taxRateValue)
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
    const lineData = mappedLines.map((l) => {
      const netForeign = pricesIncludeVat
        ? (l.qty * l.unitPriceForeign - l.discountAmount) / (1 + taxRateValue)
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
        taxForeign: taxLineForeign,
        taxGbp: taxLineGbp,
        totalForeign: totalLineForeign,
        totalGbp: totalLineGbp,
      }
    })

    // Read order number prefix setting
    const prefixSetting = await db.setting.findUnique({ where: { key: 'order_number_prefix' } })
    const prefix = prefixSetting?.value ?? ''
    const orderNumber = `${prefix}${wcOrder.number}`

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
        status: imsStatus,
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

    // Auto-allocate stock
    const { autoAllocateOrder } = await import('@/app/actions/allocation')
    await autoAllocateOrder(so.id)

    // Queue Xero sales invoice (AUTHORISED — WC orders are pre-paid)
    try {
      const { queueXeroSync, getXeroSettings } = await import('@/app/actions/xero-sync')
      const xeroSettings = await getXeroSettings()
      const fxRateNum = Number(fxRate) || 1
      const discountGbp = Math.round((orderDiscount.discountAmount / fxRateNum) * 100) / 100
      await queueXeroSync({
        type: 'SALES_INVOICE',
        referenceType: 'SalesOrder',
        referenceId: so.id,
        payload: {
          invoiceNumber: `WC-${wcOrder.number}`,
          contactName: customerName,
          contactEmail: wcOrder.billing.email || undefined,
          date: new Date().toISOString().slice(0, 10),
          currency,
          reference: orderNumber,
          lines: lineData.map(l => ({
            itemCode: l.sku ?? undefined,
            description: l.description ?? l.sku ?? 'Item',
            quantity: l.qty,
            unitAmount: Math.round((l.unitPriceForeign / fxRateNum) * 10000) / 10000,
            accountCode: xeroSettings.xero_sales_account,
            taxType: xeroTaxType ?? undefined,
          })),
          shippingAmount: shippingForeign > 0 ? Math.round((shippingForeign / fxRateNum) * 10000) / 10000 : undefined,
          shippingDescription: 'Shipping',
          shippingAccountCode: xeroSettings.xero_shipping_account || undefined,
          discountAmount: discountGbp > 0 ? discountGbp : undefined,
          discountAccountCode: xeroSettings.xero_discount_account || undefined,
          _postingMode: 'submitted',
          _registerPayment: !!wcOrder.date_paid_gmt,
          _paymentMethod: wcOrder.payment_method || undefined,
          _paymentDate: wcOrder.date_paid_gmt || undefined,
        },
      })
    } catch { /* Xero queue errors should never block import */ }

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

  // Read settings
  const [statusesSetting, lastSyncSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: 'wc_sync_order_statuses' } }),
    db.setting.findUnique({ where: { key: 'last_wc_order_sync_at' } }),
  ])

  let statuses: string[]
  try { statuses = statusesSetting?.value ? JSON.parse(statusesSetting.value) : ['processing'] }
  catch { statuses = ['processing'] }

  const lastSync = lastSyncSetting?.value || null

  // First-time import: fetch all statuses to get the full order history
  if (!lastSync) {
    statuses = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed']
  }

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
