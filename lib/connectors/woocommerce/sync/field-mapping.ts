/**
 * WooCommerce → IMS field mapping helpers.
 */

import { db } from '@/lib/db'
import type { TaxCategory } from '@/app/generated/prisma/client'
import type { WcAddress, WcFullOrder, WcLineItem, WcCouponLine, WcFeeLine } from './types'

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
    externalCustomerId: order.customer_id > 0 ? order.customer_id : null,
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
  let existing = cust.externalCustomerId
    ? await db.customer.findFirst({
        where: {
          shoppingLinks: {
            some: {
              connector: 'woocommerce',
              externalCustomerId: String(cust.externalCustomerId),
            },
          },
        },
      })
    : null
  if (!existing && cust.email) {
    existing = await db.customer.findFirst({ where: { email: cust.email } })
  }

  if (existing) {
    if (cust.externalCustomerId) {
      const existingLink = await db.shoppingCustomerLink.findFirst({
        where: { connector: 'woocommerce', customerId: existing.id },
        select: { id: true },
      })
      if (!existingLink) {
        await db.shoppingCustomerLink.create({
          data: {
            connector: 'woocommerce',
            customerId: existing.id,
            externalCustomerId: String(cust.externalCustomerId),
          },
        })
      }
    }
    return existing.id
  }

  // Create new customer
  const created = await db.customer.create({
    data: {
      firstName: cust.firstName,
      lastName: cust.lastName,
      email: cust.email,
      phone: cust.phone,
      company: cust.company,
      billingAddress: mapWcAddress(order.billing),
      shippingAddress: mapWcAddress(order.shipping),
      ...(cust.externalCustomerId
        ? {
            shoppingLinks: {
              create: {
                connector: 'woocommerce',
                externalCustomerId: String(cust.externalCustomerId),
              },
            },
          }
        : {}),
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
  taxForeign: number
  forceNoTax?: boolean
  /**
   * WC's own tax rate id for this line (from `line_items[].taxes[0].id`).
   * Null when the WC payload doesn't include a per-line tax entry — in that
   * case the IMS resolver is used as a fallback.
   */
  externalTaxRateId: number | null
  externalLineItemId: number | null
  taxCategoryFallback?: TaxCategory
}

function mapWcTaxClassToCategory(taxClass: string | null | undefined): TaxCategory {
  const normalized = (taxClass ?? '').trim().toLowerCase()
  if (!normalized) return 'STANDARD'
  if (normalized === 'zero-rate' || normalized === 'zero') return 'ZERO'
  if (normalized === 'reduced-rate' || normalized === 'reduced') return 'REDUCED'
  if (normalized === 'second-reduced-rate' || normalized === 'second-reduced') return 'SECOND_REDUCED'
  if (normalized === 'exempt' || normalized === 'exemption') return 'EXEMPT'
  return 'STANDARD'
}

export async function mapWcLineItems(
  lineItems: WcLineItem[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _fxRate: number,
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
    const externalTaxRateId = item.taxes?.[0]?.id ?? null

    return {
      productId: item.sku ? (skuMap.get(item.sku.toUpperCase()) ?? null) : null,
      sku: item.sku || `wc-${item.product_id}`,
      description: item.name,
      qty,
      unitPriceForeign: Math.round(unitPrice * 1000000) / 1000000,
      discountAmount: Math.round(lineDiscount * 10000) / 10000,
      discountStr: lineDiscount > 0 ? lineDiscount.toFixed(2) : null,
      taxForeign: Math.round(tax * 10000) / 10000,
      externalTaxRateId: typeof externalTaxRateId === 'number' && externalTaxRateId > 0 ? externalTaxRateId : null,
      externalLineItemId: item.id,
    }
  })
}

export function mapWcFeeLines(feeLines: WcFeeLine[]): MappedLine[] {
  const mapped: Array<MappedLine | null> = feeLines
    .map((feeLine) => {
      const total = parseFloat(feeLine.total) || 0
      const tax = parseFloat(feeLine.total_tax) || 0
      const externalTaxRateId = feeLine.taxes?.[0]?.id ?? null
      if (Math.abs(total) <= 0.000001 && Math.abs(tax) <= 0.000001) return null

      return {
        productId: null,
        sku: '',
        description: feeLine.name || 'Fee',
        qty: 1,
        unitPriceForeign: Math.round(total * 1000000) / 1000000,
        discountAmount: 0,
        discountStr: null,
        taxForeign: Math.round(tax * 10000) / 10000,
        forceNoTax: tax <= 0.000001 && !externalTaxRateId,
        externalTaxRateId: typeof externalTaxRateId === 'number' && externalTaxRateId > 0 ? externalTaxRateId : null,
        externalLineItemId: null,
        taxCategoryFallback: mapWcTaxClassToCategory(feeLine.tax_class),
      }
    })
  return mapped.filter((line): line is MappedLine => line !== null)
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
  const methodTitle = order.shipping_lines[0]?.method_title ?? null

  return {
    shippingService: methodTitle,
    shippingForeign: Math.round(totalShipping * 10000) / 10000,
  }
}

// ---------------------------------------------------------------------------
// Tax mapping
// ---------------------------------------------------------------------------

type ResolvedTaxRate = {
  taxRateId: string | null
  taxRateName: string | null
  taxRateValue: number
  accountingTaxType: string | null
}

async function fallbackDefaultTaxRate(): Promise<ResolvedTaxRate> {
  const defaultRate = await db.taxRate.findFirst({
    where: { isDefault: true, active: true },
    select: { id: true, name: true, rate: true, accountingTaxType: true },
  })
  if (defaultRate) {
    return {
      taxRateId: defaultRate.id,
      taxRateName: defaultRate.name,
      taxRateValue: Number(defaultRate.rate),
      accountingTaxType: defaultRate.accountingTaxType,
    }
  }
  return { taxRateId: null, taxRateName: null, taxRateValue: 0, accountingTaxType: null }
}

export async function resolveWcTaxRateById(wcRateId: number | null | undefined): Promise<ResolvedTaxRate> {
  if (!wcRateId || !Number.isFinite(wcRateId) || wcRateId <= 0) {
    return fallbackDefaultTaxRate()
  }
  const mapping = await db.shoppingTaxRateMapping.findUnique({
    where: {
      connector_externalTaxRateId: {
        connector: 'woocommerce',
        externalTaxRateId: String(wcRateId),
      },
    },
    include: { taxRate: { select: { id: true, name: true, rate: true, accountingTaxType: true } } },
  })
  if (!mapping) return fallbackDefaultTaxRate()
  return {
    taxRateId: mapping.taxRate.id,
    taxRateName: mapping.taxRate.name,
    taxRateValue: Number(mapping.taxRate.rate),
    accountingTaxType: mapping.taxRate.accountingTaxType,
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
  // fxRateToBase in the SalesOrder means: foreign / fxRate = GBP
  // So if 1 GBP = 1.15 EUR, fxRateToBase = 1.15
  return rate ? Number(rate.rate) : 1
}
