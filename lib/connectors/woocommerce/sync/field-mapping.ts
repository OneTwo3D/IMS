/**
 * WooCommerce → IMS field mapping helpers.
 */

import { db } from '@/lib/db'
import type { WcAddress, WcFullOrder, WcLineItem, WcCouponLine } from './types'

// ---------------------------------------------------------------------------
// Address mapping
// ---------------------------------------------------------------------------

export function mapWcAddress(a: WcAddress) {
  return {
    line1: [a.address_1, a.company].filter(Boolean).join(', ') || undefined,
    line2: a.address_2 || undefined,
    city: a.city || undefined,
    county: a.state || undefined,
    postcode: a.postcode || undefined,
    country: a.country || undefined,
  }
}

// ---------------------------------------------------------------------------
// Customer mapping
// ---------------------------------------------------------------------------

export function mapWcCustomer(order: WcFullOrder) {
  const b = order.billing
  return {
    wcCustomerId: order.customer_id > 0 ? order.customer_id : null,
    firstName: b.first_name || order.shipping.first_name || '',
    lastName: b.last_name || order.shipping.last_name || '',
    email: b.email || null,
    phone: b.phone || order.shipping.phone || null,
    company: b.company || order.shipping.company || null,
  }
}

export async function upsertCustomer(order: WcFullOrder): Promise<string | null> {
  const cust = mapWcCustomer(order)
  if (!cust.firstName && !cust.lastName && !cust.email) return null

  // Try to find by WC customer ID first, then by email
  let existing = cust.wcCustomerId
    ? await db.customer.findUnique({ where: { wcCustomerId: cust.wcCustomerId } })
    : null
  if (!existing && cust.email) {
    existing = await db.customer.findFirst({ where: { email: cust.email } })
  }

  if (existing) {
    // Update if WC customer ID was missing
    if (cust.wcCustomerId && !existing.wcCustomerId) {
      await db.customer.update({ where: { id: existing.id }, data: { wcCustomerId: cust.wcCustomerId } })
    }
    return existing.id
  }

  // Create new customer
  const created = await db.customer.create({
    data: {
      wcCustomerId: cust.wcCustomerId,
      firstName: cust.firstName,
      lastName: cust.lastName,
      email: cust.email,
      phone: cust.phone,
      company: cust.company,
      billingAddress: mapWcAddress(order.billing),
      shippingAddress: mapWcAddress(order.shipping),
    },
  })
  return created.id
}

// ---------------------------------------------------------------------------
// Line item mapping
// ---------------------------------------------------------------------------

export type MappedLine = {
  productId: string | null
  sku: string
  description: string
  qty: number
  unitPriceForeign: number
  discountAmount: number
  discountStr: string | null
  wcLineItemId: number
  taxForeign: number
}

export async function mapWcLineItems(
  lineItems: WcLineItem[],
  fxRate: number,
): Promise<MappedLine[]> {
  // Build SKU→product lookup
  const skus = lineItems.map((l) => l.sku).filter(Boolean)
  const products = skus.length > 0
    ? await db.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true } })
    : []
  const skuMap = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]))

  return lineItems.map((item) => {
    const subtotal = parseFloat(item.subtotal) || 0  // before discount
    const total = parseFloat(item.total) || 0        // after discount
    const qty = item.quantity
    const unitPrice = qty > 0 ? subtotal / qty : 0
    const lineDiscount = Math.max(0, subtotal - total)
    const tax = parseFloat(item.total_tax) || 0

    return {
      productId: item.sku ? (skuMap.get(item.sku.toUpperCase()) ?? null) : null,
      sku: item.sku || `wc-${item.product_id}`,
      description: item.name,
      qty,
      unitPriceForeign: Math.round(unitPrice * 1000000) / 1000000,
      discountAmount: Math.round(lineDiscount * 10000) / 10000,
      discountStr: lineDiscount > 0 ? lineDiscount.toFixed(2) : null,
      wcLineItemId: item.id,
      taxForeign: Math.round(tax * 10000) / 10000,
    }
  })
}

// ---------------------------------------------------------------------------
// Order-level discount (from WC coupon_lines)
// ---------------------------------------------------------------------------

export function mapWcOrderDiscount(couponLines: WcCouponLine[]): {
  discountStr: string | null
  discountAmount: number
} {
  if (!couponLines.length) return { discountStr: null, discountAmount: 0 }

  const totalDiscount = couponLines.reduce((s, c) => s + (parseFloat(c.discount) || 0), 0)
  const codes = couponLines.map((c) => c.code).join(', ')

  return {
    discountStr: codes,
    discountAmount: Math.round(totalDiscount * 10000) / 10000,
  }
}

// ---------------------------------------------------------------------------
// Shipping mapping
// ---------------------------------------------------------------------------

export function mapWcShipping(order: WcFullOrder): {
  shippingService: string | null
  shippingForeign: number
} {
  const totalShipping = parseFloat(order.shipping_total) || 0
  const shippingTax = parseFloat(order.shipping_tax) || 0
  const methodTitle = order.shipping_lines[0]?.method_title ?? null

  return {
    shippingService: methodTitle,
    shippingForeign: Math.round((totalShipping + shippingTax) * 10000) / 10000,
  }
}

// ---------------------------------------------------------------------------
// Tax mapping
// ---------------------------------------------------------------------------

export async function resolveWcTaxRate(
  taxClass: string,
): Promise<{ taxRateId: string | null; taxRateName: string | null; taxRateValue: number }> {
  const wcClass = taxClass || 'standard'
  const mapping = await db.wcTaxMapping.findUnique({
    where: { wcTaxClass: wcClass },
    include: { taxRate: { select: { id: true, name: true, rate: true } } },
  })
  if (!mapping) {
    // Fallback: use default tax rate
    const defaultRate = await db.taxRate.findFirst({
      where: { isDefault: true, active: true },
      select: { id: true, name: true, rate: true },
    })
    if (defaultRate) {
      return { taxRateId: defaultRate.id, taxRateName: defaultRate.name, taxRateValue: Number(defaultRate.rate) }
    }
    return { taxRateId: null, taxRateName: null, taxRateValue: 0 }
  }
  return {
    taxRateId: mapping.taxRate.id,
    taxRateName: mapping.taxRate.name,
    taxRateValue: Number(mapping.taxRate.rate),
  }
}

// ---------------------------------------------------------------------------
// Tracking extraction from WC order meta
// ---------------------------------------------------------------------------

export function extractWcTracking(order: WcFullOrder): { carrier: string; trackingNumber: string }[] {
  const trackingMeta = order.meta_data.find((m) => m.key === '_wc_shipment_tracking_items')
  if (!trackingMeta?.value || !Array.isArray(trackingMeta.value)) return []

  return (trackingMeta.value as { tracking_provider?: string; custom_tracking_provider?: string; tracking_number?: string }[])
    .filter((t) => t.tracking_number)
    .map((t) => ({
      carrier: t.tracking_provider || t.custom_tracking_provider || '',
      trackingNumber: t.tracking_number!,
    }))
}

// ---------------------------------------------------------------------------
// FX rate lookup
// ---------------------------------------------------------------------------

export async function getFxRateToGbp(currency: string): Promise<number> {
  if (currency === 'GBP') return 1

  // Get latest FX rate: stored as 1 GBP = X foreign
  const rate = await db.fxRate.findFirst({
    where: { fromCurrency: 'GBP', toCurrency: currency },
    orderBy: { fetchedAt: 'desc' },
    select: { rate: true },
  })
  // fxRateToGbp in the SalesOrder means: foreign / fxRate = GBP
  // So if 1 GBP = 1.15 EUR, fxRateToGbp = 1.15
  return rate ? Number(rate.rate) : 1
}
