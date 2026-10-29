/**
 * WooCommerce → IMS field mapping helpers.
 */

import { db } from '@/lib/db'
import { getFxRateToBase as getFxRateToBaseFromTable, isMissingFxRateError, MissingFxRateError } from '@/lib/currencies/fx-lookup'
import { logActivity } from '@/lib/activity-log'
import { currencyMinorUnits, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { TaxCategory } from '@/app/generated/prisma/client'
import type { WcAddress, WcFullOrder, WcLineItem, WcCouponLine, WcFeeLine, WcMeta } from './types'
import { classifyWcCouponLines } from './coupon-classification'
import { knownWcTaxClassCategory } from './tax-class-category'

function roundDecimalNumber(value: DecimalInput, precision: number): number {
  return roundQuantity(value, precision).toNumber()
}

// ---------------------------------------------------------------------------
// Address mapping
// ---------------------------------------------------------------------------

/** A WooCommerce address string, trimmed; anything that is not a string becomes ''. */
function wcText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function mapWcAddress(a: WcAddress) {
  return {
    // `line1` keeps its historical composite (street + company) because documents and the
    // order screens already render it. The fields below it are the SEPARATE parts the
    // warehouse push needs: the recipient's name, company, plain street line and contact
    // details. `address1` is always present (possibly '') on an address stored by this
    // mapper, which is how readers tell this shape from a legacy row that has only `line1`.
    firstName: wcText(a.first_name) || undefined,
    lastName: wcText(a.last_name) || undefined,
    company: wcText(a.company) || undefined,
    address1: wcText(a.address_1),
    phone: wcText(a.phone) || undefined,
    email: wcText(a.email) || undefined,
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
  /**
   * Which wclc fee a fee line is, read from the line's own `_wclc_fee_kind` item meta (only when the `_wclc_fee`
   * marker is set). Mirrored, never derived: `duty_flat` is the EUR 3 per HS code "EU Import Duty", `uhf` the EUR 2
   * "EU Customs Fee", `duty_fee` the non-taxable over-EUR-150 "Import Duty" line. Null for any other line.
   * Informational on the mapped line: it changes no amount and no tax.
   */
  wclcFeeKind?: WclcFeeKind | null
  /** True on every line `mapWcFeeLines` produces (and on nothing else): scopes fee-only decisions such as the explicit no-tax accounting code. */
  isFeeLine?: boolean
}

export const WCLC_FEE_KINDS = ['duty_flat', 'uhf', 'duty_fee'] as const
export type WclcFeeKind = (typeof WCLC_FEE_KINDS)[number]

/** Truthiness of a WooCommerce meta value as the plugin writes it ('1', 1, true, 'yes'); anything else is not a marker. */
function wcMetaFlag(value: unknown): boolean {
  if (value === true || value === 1) return true
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
}

/** The wclc fee kind of a fee line, or null when it is not a marked wclc fee (or names a kind this build does not know). */
export function readWclcFeeKind(feeLine: Pick<WcFeeLine, 'meta_data'>): WclcFeeKind | null {
  const meta = feeLine.meta_data ?? []
  const marker = meta.find((m) => m.key === '_wclc_fee')
  if (!marker || !wcMetaFlag(marker.value)) return null
  const kind = meta.find((m) => m.key === '_wclc_fee_kind')?.value
  return typeof kind === 'string' && (WCLC_FEE_KINDS as readonly string[]).includes(kind.trim()) ? (kind.trim() as WclcFeeKind) : null
}

export type WclcOrderComponents = {
  dutyComponent: string | null
  taxComponent: string | null
  /** Present only when above zero, as wclc writes it. */
  handlingComponent: string | null
}

function wclcComponentAmount(meta: WcMeta[], key: string): string | null {
  const entry = meta.find((m) => m.key === key)
  if (!entry) return null
  const raw = typeof entry.value === 'number' ? String(entry.value) : typeof entry.value === 'string' ? entry.value.trim() : ''
  // A plain non-negative decimal only; anything else (empty, junk, negative) is "not carried", never a guess.
  return /^\d+(\.\d+)?$/.test(raw) ? raw : null
}

/**
 * The order-level split wclc records when it charges duty: `_wclc_duty_component`, `_wclc_tax_component` (import VAT
 * only) and `_wclc_handling_component` (the Union handling fee NET inside the over-EUR-150 duty line). Mirrored as
 * reported. The handling component is absent unless it is above zero, so a stored zero is read as absent.
 */
export function readWclcOrderComponents(order: Pick<WcFullOrder, 'meta_data'>): WclcOrderComponents {
  const meta = order.meta_data ?? []
  const handling = wclcComponentAmount(meta, '_wclc_handling_component')
  return {
    dutyComponent: wclcComponentAmount(meta, '_wclc_duty_component'),
    taxComponent: wclcComponentAmount(meta, '_wclc_tax_component'),
    handlingComponent: handling !== null && parseFloat(handling) > 0 ? handling : null,
  }
}

function mapWcTaxClassToCategory(taxClass: string | null | undefined): TaxCategory {
  // An unknown class falls back to STANDARD on import (the table is shared with the R13 VAT set identity, which reports it instead).
  return knownWcTaxClassCategory(taxClass) ?? 'STANDARD'
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
        wclcFeeKind: readWclcFeeKind(feeLine),
        isFeeLine: true,
      }
    })
  return mapped.filter((line): line is MappedLine => line !== null)
}

// ---------------------------------------------------------------------------
// Order-level discount (from WC coupon_lines)
// ---------------------------------------------------------------------------

export function mapWcOrderDiscount(couponLines: WcCouponLine[], orderMeta?: WcMeta[]): {
  discountStr: string | null
  discountAmount: number
} {
  if (!couponLines.length) return { discountStr: null, discountAmount: 0 }

  // GENUINE coupons only. Store credit (Smart Coupons `smart_coupon`) is a PAYMENT, not a discount, so it
  // is never part of the sum this returns; an unrecognised type stays in it (its money is carried only
  // while Woo put it on the lines, and `planWcOrderCoupons` refuses the order otherwise).
  const classified = classifyWcCouponLines(couponLines, orderMeta)
  return {
    discountStr: classified.codes,
    discountAmount: roundDecimalNumber(classified.genuineNet, 4),
  }
}

/**
 * Coupon money strictly below HALF ONE MINOR UNIT of the order currency is allocation rounding (Woo
 * splitting a coupon across lines), not a real order-level discount.
 *
 * o3d-5tf, two defects in the previous hard-coded `0.005`:
 *
 *   1. The constant assumed a 2-decimal currency. A WooCommerce store can run a 0-decimal currency
 *      (JPY, KRW) where 0.005 is a meaningless sliver, or a 3-decimal one (KWD, BHD) where it
 *      silently swallowed FIVE whole minor units of real customer discount.
 *   2. The comparison was `residual <= tolerance`, and the comment claimed a residual at the
 *      threshold "can never round up to a posted 0.01" — wrong at exactly the boundary, since
 *      ordinary HALF_UP money rounding turns 0.005 into a posted 0.01. Discarding it understated
 *      the discount by a posted minor unit. The comparison is now STRICT, so a residual that would
 *      round up to a posted minor unit is always retained.
 */
function couponAllocationTolerance(currency: string): Decimal {
  return toDecimal(10).pow(-currencyMinorUnits(currency)).div(2)
}

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
  /** The ORDER currency, which sets the minor unit the tolerance is measured in (o3d-5tf). */
  currency: string
}): { orderLevelDiscount: number; unallocated: number } {
  const couponTotal = roundQuantity(input.couponTotalForeign, 4)
  const lineDiscountTotal = roundQuantity(input.lineDiscountTotalForeign, 4)
  const residual = roundQuantity(couponTotal.sub(lineDiscountTotal), 4)
  // Clamped at zero: per-line markdowns can legitimately exceed the coupon (a sale price plus a
  // coupon), and a negative order-level discount would post as a POSITIVE invoice line. STRICT `<`
  // so a residual at exactly half a minor unit — which HALF_UP rounding posts as a whole one — is
  // kept rather than discarded.
  if (residual.lt(couponAllocationTolerance(input.currency))) return { orderLevelDiscount: 0, unallocated: 0 }
  return { orderLevelDiscount: residual.toNumber(), unallocated: residual.toNumber() }
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

// The error class and its predicate live with the one central lookup (lib/currencies/fx-lookup.ts); re-exported so the
// connector's importers and `instanceof` checks keep working against a single class.
export { MissingFxRateError, isMissingFxRateError }

/**
 * The base-currency rate for a WooCommerce order: 1 base = X foreign, so `base = foreign / rate`.
 *
 * `asOf` is REQUIRED: the order's own date for an import, `new Date()` where "now" is meant. (It used to be optional,
 * and an omitted one meant "the latest row ever", which is no bound at all.) The base currency is the organisation's,
 * not a literal GBP. Never silently falls back to 1:1 for a foreign currency; that corrupts revenue, COGS, and
 * accounting sync downstream. A missing rate is logged and refuses with MissingFxRateError, as it always did.
 */
export async function getFxRateToBase(currency: string, asOf: Date): Promise<number> {
  const normalizedCurrency = currency.trim().toUpperCase()
  try {
    const rate = await getFxRateToBaseFromTable(db, { currency: normalizedCurrency, asOf })
    return rate.rate.toNumber()
  } catch (error) {
    if (!isMissingFxRateError(error)) throw error
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_order_fx_missing',
      tag: 'sync',
      level: 'ERROR',
      description: error.message,
      metadata: { currency: normalizedCurrency, asOf: error.asOf?.toISOString() ?? null, reason: error.reason },
      resolveUser: false,
    })
    throw error
  }
}

/** The historic name; the lookup is no longer GBP-specific. */
export const getFxRateToGbp = getFxRateToBase
