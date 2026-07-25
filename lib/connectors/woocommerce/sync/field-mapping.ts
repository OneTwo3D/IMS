/**
 * WooCommerce → IMS field mapping helpers.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { roundQuantity, type DecimalInput } from '@/lib/domain/math/decimal'
import type { TaxCategory } from '@/app/generated/prisma/client'
import type { WcAddress, WcFullOrder, WcLineItem, WcCouponLine, WcFeeLine } from './types'

function roundDecimalNumber(value: DecimalInput, precision: number): number {
  return roundQuantity(value, precision).toNumber()
}

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

// The EU/UK VAT plugins each store the customer-entered VAT number under their own
// order-meta key; check the common ones (mirrors the legacy plugin's _read_wc_vat).
const WC_VAT_META_KEYS = new Set([
  '_billing_vat', '_vat_number', 'billing_vat_number', '_billing_eu_vat_number',
  'vat_number', '_vat_id', '_billing_vat_number',
])

function normaliseVat(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed || null
}

/**
 * Read a customer-entered VAT / IOSS number from a WC order: the common EU/UK VAT
 * plugin meta keys first, then billing-level fields some blocks-checkouts expose.
 * Returns a trimmed value or null. Sent on to the WMS for customs declarations.
 */
export function readWcCustomerVat(order: WcFullOrder): string | null {
  for (const meta of order.meta_data ?? []) {
    if (WC_VAT_META_KEYS.has(meta.key)) {
      const value = normaliseVat(meta.value)
      if (value) return value
    }
  }
  const billing = order.billing as Record<string, unknown> | undefined
  for (const key of ['vat_number', 'vat_id', 'company_vat']) {
    const value = normaliseVat(billing?.[key])
    if (value) return value
  }
  return null
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
      unitPriceForeign: roundDecimalNumber(unitPrice, 6),
      discountAmount: roundDecimalNumber(lineDiscount, 4),
      discountStr: lineDiscount > 0 ? lineDiscount.toFixed(2) : null,
      taxForeign: roundDecimalNumber(tax, 4),
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
        unitPriceForeign: roundDecimalNumber(total, 6),
        discountAmount: 0,
        discountStr: null,
        taxForeign: roundDecimalNumber(tax, 4),
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
    discountAmount: roundDecimalNumber(totalDiscount, 4),
  }
}

// Coupon money below this is allocation rounding (Woo splitting a coupon across lines), not a
// real order-level discount. Half a penny, so it can never round up to a posted 0.01.
const COUPON_ALLOCATION_TOLERANCE = 0.005

/**
 * Split a WooCommerce coupon total into the part already carried by the line items and the
 * residual that belongs in IMS's order-level `discountAmount` slot (o3d-y14).
 *
 * Woo allocates cart-coupon money INTO the lines: `line_items[].total` is already
 * `subtotal` minus that line's share of every coupon, and mapWcLineItems turns that difference
 * into a per-line `discountAmount`. IMS's ORDER-LEVEL slot means the opposite — a discount that
 * is NOT in the lines (a native order's `orderDiscountForeign`, which is deducted from the order
 * total). Populating both with the same coupon made every downstream consumer deduct it twice:
 * the Xero builder applies the per-line figure as a `DiscountRate` AND appends the order-level
 * figure as a negative line, so a £90 order posted as £80.
 *
 * Both inputs are net of tax on the same basis — Woo keeps `coupon_lines[].discount_tax` and
 * `line_items[].subtotal_tax`/`total_tax` separate from the amounts compared here.
 *
 * The residual is normally exactly zero. A non-zero one means a coupon shape we do not model, so
 * it is returned as `unallocated` for the caller to log rather than silently dropped — dropping
 * it would overstate the invoice by money the customer was never charged.
 */
export function resolveWcOrderLevelDiscount(input: {
  couponTotalForeign: DecimalInput
  lineDiscountTotalForeign: DecimalInput
}): { orderLevelDiscount: number; unallocated: number } {
  const couponTotal = roundDecimalNumber(input.couponTotalForeign, 4)
  const lineDiscountTotal = roundDecimalNumber(input.lineDiscountTotalForeign, 4)
  const residual = roundDecimalNumber(couponTotal - lineDiscountTotal, 4)
  // Clamped at zero: per-line markdowns can legitimately exceed the coupon (a sale price plus a
  // coupon), and a negative order-level discount would post as a POSITIVE invoice line.
  if (residual <= COUPON_ALLOCATION_TOLERANCE) return { orderLevelDiscount: 0, unallocated: 0 }
  return { orderLevelDiscount: residual, unallocated: residual }
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
    shippingForeign: roundDecimalNumber(totalShipping, 4),
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
  // Carry the IMS rate's reverse-charge flag so the accounting payload can swap
  // mapped reverse-charge lines to the RC tax code (audit-H1b) — a mapped WC
  // rate pointing at an RC IMS TaxRate must post on the reverse-charge boxes,
  // not the standard code, exactly as the resolver-derived path does.
  reverseCharge: boolean
  source: 'mapped' | 'default'
}

/**
 * The order's tax rate when the line does not name one we can resolve.
 *
 * TWO CALLERS, AND THEY MEAN OPPOSITE THINGS (o3d-6ec) — which is why this used to fail
 * silently: it could not tell them apart, so the honest case and the dangerous one produced
 * the same wordless answer.
 *
 *   - `unmappedWcRateId === null`: the order names NO tax rate. WooCommerce is the authority
 *     on that, so there is no tax and 0% is simply CORRECT. Nothing to report.
 *   - `unmappedWcRateId` set: WooCommerce charged tax at a rate we cannot map. We do not know
 *     the tax. Whatever we return is a SUBSTITUTION, and it must say so out loud.
 *
 * Compare getFxRateToGbp below, which faces the identical question — "we cannot resolve a
 * rate WooCommerce actually applied" — and answers it by logging ERROR and throwing, parking
 * the order rather than guessing. Tax silently guessing 0% was never a considered decision;
 * it was the absence of one.
 *
 * This still substitutes rather than throwing, deliberately: parking orders is a change to
 * live intake, and o3d-6ec records that the choice between substituting and refusing needs a
 * finance opinion (an order whose VAT we cannot account for may be worth rejecting outright).
 * Making it LOUD is the part that needs no opinion — a wrong number nobody can see is strictly
 * worse than a wrong number on the exceptions dashboard.
 */
async function fallbackDefaultTaxRate(unmappedWcRateId: number | null = null): Promise<ResolvedTaxRate> {
  const defaultRate = await db.taxRate.findFirst({
    where: { isDefault: true, active: true },
    select: { id: true, name: true, rate: true, accountingTaxType: true, reverseCharge: true },
  })

  if (defaultRate) {
    if (unmappedWcRateId !== null) {
      await logActivity({
        entityType: 'SYNC',
        action: 'wc_tax_rate_unmapped',
        tag: 'sync',
        level: 'WARNING',
        description:
          `WooCommerce tax rate ${unmappedWcRateId} is not mapped to an IMS tax rate; substituted the ` +
          `default "${defaultRate.name}" (${Number(defaultRate.rate) * 100}%). If WooCommerce charged a ` +
          `different rate, this order's VAT is wrong. Map it in the WooCommerce connector's tax settings.`,
        metadata: {
          externalTaxRateId: unmappedWcRateId,
          substitutedTaxRate: defaultRate.name,
          substitutedRate: Number(defaultRate.rate),
        },
        resolveUser: false,
      })
    }
    return {
      taxRateId: defaultRate.id,
      taxRateName: defaultRate.name,
      taxRateValue: Number(defaultRate.rate),
      accountingTaxType: defaultRate.accountingTaxType,
      reverseCharge: defaultRate.reverseCharge,
      source: 'default',
    }
  }

  // No usable default. Returning 0% here is the worst answer available — plausible, and wrong
  // whenever WooCommerce actually charged tax. ERROR (not WARNING) when a real rate went
  // unmapped, because the order carries VAT we have just recorded as zero.
  if (unmappedWcRateId !== null) {
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_tax_rate_unresolvable',
      tag: 'sync',
      level: 'ERROR',
      description:
        `WooCommerce tax rate ${unmappedWcRateId} is not mapped AND no tax rate is both default and ` +
        `active, so this line was recorded at 0% VAT with no tax type — it will post to the ledger ` +
        `with no TaxType. Map the rate, and set a default onto a live rate.`,
      metadata: { externalTaxRateId: unmappedWcRateId },
      resolveUser: false,
    })
  }

  return { taxRateId: null, taxRateName: null, taxRateValue: 0, accountingTaxType: null, reverseCharge: false, source: 'default' }
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
    include: { taxRate: { select: { id: true, name: true, rate: true, accountingTaxType: true, reverseCharge: true } } },
  })
  // Pass the id: WooCommerce named a rate and we could not resolve it, which is the case that
  // must be reported. Calling this bare — as it used to — is what made the substitution silent.
  if (!mapping) return fallbackDefaultTaxRate(wcRateId)
  return {
    taxRateId: mapping.taxRate.id,
    taxRateName: mapping.taxRate.name,
    taxRateValue: Number(mapping.taxRate.rate),
    accountingTaxType: mapping.taxRate.accountingTaxType,
    reverseCharge: mapping.taxRate.reverseCharge,
    source: 'mapped',
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

export class MissingFxRateError extends Error {
  constructor(
    message: string,
    readonly currency: string,
    readonly asOf: Date | undefined,
  ) {
    super(message)
    this.name = 'MissingFxRateError'
  }
}

export function isMissingFxRateError(error: unknown): error is MissingFxRateError {
  return error instanceof MissingFxRateError
}

export async function getFxRateToGbp(currency: string, asOf?: Date): Promise<number> {
  const normalizedCurrency = currency.trim().toUpperCase()
  if (normalizedCurrency === 'GBP') return 1

  // Get date-bounded FX rate: stored as 1 GBP = X foreign.
  // Never silently fall back to 1:1 for foreign currencies; that corrupts
  // revenue, COGS, and accounting sync downstream.
  const rate = await db.fxRate.findFirst({
    where: {
      fromCurrency: 'GBP',
      toCurrency: normalizedCurrency,
      ...(asOf ? { fetchedAt: { lte: asOf } } : {}),
    },
    orderBy: { fetchedAt: 'desc' },
    select: { rate: true },
  })
  if (!rate) {
    const message = `Missing GBP FX rate for ${normalizedCurrency}${asOf ? ` on or before ${asOf.toISOString().slice(0, 10)}` : ''}`
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_order_fx_missing',
      tag: 'sync',
      level: 'ERROR',
      description: message,
      metadata: { currency: normalizedCurrency, asOf: asOf?.toISOString() ?? null },
      resolveUser: false,
    })
    throw new MissingFxRateError(message, normalizedCurrency, asOf)
  }
  // fxRateToBase in the SalesOrder means: foreign / fxRate = GBP
  // So if 1 GBP = 1.15 EUR, fxRateToBase = 1.15
  return Number(rate.rate)
}
