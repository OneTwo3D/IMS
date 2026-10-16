/**
 * SYNTHETIC WOOCOMMERCE ORDERS FOR THE INITIAL-IMPORT REHEARSAL (scripts/rehearse-woo-import.ts).
 *
 * Nothing here was recorded from a real store: every payload is built by `buildWooOrder` in the shape
 * the WooCommerce REST v3 `/orders` endpoint documents (`WcFullOrder`), with money held in integer
 * minor units and rendered as the two-decimal strings WooCommerce sends, so each order's `total` is
 * exactly the sum of its parts. WHAT THAT CANNOT PROVE is listed in the PR that added it (real payload
 * quirks, plugin meta keys, a store whose rounding differs).
 *
 * The store the fake serves holds ALL of these orders; the import's status selection decides which of
 * them it asks for. `expectation` is the fixture's own statement of what a correct run does with it, so
 * the report can say "imported / abandoned by status / failed" without reading the importer's answer.
 */
import type { WcAddress, WcFullOrder, WcLineItem, WcTaxLine } from '../../../lib/connectors/woocommerce/sync/types.ts'

/** The SKUs the rehearsal creates in IMS before the import (everything else is ABSENT from IMS). */
export const SKU_STOCKED = 'REH-A-STOCKED'
export const SKU_UNSTOCKED = 'REH-B-UNSTOCKED'
export const SKU_PLENTY = 'REH-C-PLENTY'
export const SKU_ABSENT = 'REH-X-ABSENT-FROM-IMS'

/** WooCommerce tax-rate ids: 1 and 2 are mapped to IMS rates by the rehearsal; 99 deliberately is not. */
export const WC_RATE_STANDARD = 1
export const WC_RATE_REDUCED = 2
export const WC_RATE_UNMAPPED = 99
const RATE_PERCENT: Record<number, number> = { [WC_RATE_STANDARD]: 20, [WC_RATE_REDUCED]: 5, [WC_RATE_UNMAPPED]: 20 }
const RATE_LABEL: Record<number, string> = { [WC_RATE_STANDARD]: 'GB-VAT-1', [WC_RATE_REDUCED]: 'GB-VAT-2', [WC_RATE_UNMAPPED]: 'GB-VAT-99' }

/** The GBP value of one unit of foreign currency's inverse: 1 GBP = this many EUR. The rehearsal seeds it. */
export const FX_GBP_TO_EUR = 1.25
/** 1 GBP = this many USD. Seeded by default; the rehearsal can leave it out to model an installation with no USD rate. */
export const FX_GBP_TO_USD = 1.3

export type FixtureExpectation =
  /** In the selected statuses and expected to import cleanly. */
  | 'imports'
  /** In the selected statuses; expected to import, and expected to have at least one line IMS cannot allocate. */
  | 'imports-with-unallocatable-lines'
  /** In the selected statuses but expected to FAIL to import (reason in `note`). */
  /** In a status the owner decision abandons (completed, cancelled, refunded, failed): never fetched. */
  | 'abandoned-by-status'

export type FixtureOrder = {
  order: WcFullOrder
  expectation: FixtureExpectation
  /** Why this order is in the set; printed in the report. */
  note: string
}

type LineSpec = { sku: string; qty: number; unitMinor: number; rateId?: number; name?: string; productId?: number; taxClass?: string }
type ShippingSpec = { title: string; minor: number; rateId?: number }
type FeeSpec = { name: string; minor: number; rateId?: number }
type CouponSpec = { code: string; discountMinor: number }

export type OrderSpec = {
  id: number
  status: string
  currency?: string
  /** minutes after 2026-09-01T09:00:00Z, so `orderby=date&order=asc` is deterministic */
  createdOffsetMinutes: number
  lines: LineSpec[]
  shipping?: ShippingSpec
  fees?: FeeSpec[]
  coupons?: CouponSpec[]
  customerId?: number
  email?: string
  paid?: boolean
  pricesIncludeTax?: boolean
  /** partial refunds: minor units (positive) of each refund against this order */
  refundsMinor?: number[]
  paymentMethod?: string
  customerNote?: string
  /** a line with no tax at all (a zero-rated or exempt product) */
  noTaxOnLines?: boolean
}

const money = (minor: number): string => (minor / 100).toFixed(2)
const roundHalfUp = (value: number): number => Math.round(value + Number.EPSILON)

function address(spec: OrderSpec, kind: 'billing' | 'shipping'): WcAddress {
  const guest = spec.customerId === undefined || spec.customerId === 0
  const base: WcAddress = {
    first_name: guest ? 'Guest' : 'Customer',
    last_name: `Order${spec.id}`,
    company: '',
    address_1: `${spec.id % 97} Fixture Street`,
    address_2: '',
    city: 'Cambridge',
    state: '',
    postcode: 'CB1 1AA',
    country: spec.currency === 'EUR' ? 'IE' : 'GB',
  }
  return kind === 'billing' ? { ...base, email: spec.email ?? `fixture+${spec.id}@example.invalid`, phone: '01223 000000' } : base
}

/** Build one WooCommerce REST v3 order whose arithmetic is exact. */
export function buildWooOrder(spec: OrderSpec): WcFullOrder {
  const created = new Date(Date.UTC(2026, 8, 1, 9, 0, 0) + spec.createdOffsetMinutes * 60_000)
  const gmt = created.toISOString().slice(0, 19)
  const currency = spec.currency ?? 'GBP'

  // Coupon money is spread over the lines in proportion to their subtotal, the way WooCommerce does it.
  const subtotals = spec.lines.map((line) => line.qty * line.unitMinor)
  const grossSubtotal = subtotals.reduce((a, b) => a + b, 0)
  const couponTotal = (spec.coupons ?? []).reduce((a, c) => a + c.discountMinor, 0)
  let allocated = 0
  const shares = subtotals.map((subtotal, index) => {
    if (couponTotal === 0) return 0
    const share = index === subtotals.length - 1 ? couponTotal - allocated : roundHalfUp((couponTotal * subtotal) / grossSubtotal)
    allocated += share
    return share
  })

  const taxTotals = new Map<number, { tax: number; shipping: number }>()
  const addTax = (rateId: number, kind: 'tax' | 'shipping', minor: number): void => {
    const entry = taxTotals.get(rateId) ?? { tax: 0, shipping: 0 }
    entry[kind] += minor
    taxTotals.set(rateId, entry)
  }

  let lineNet = 0
  let lineTax = 0
  const lineItems: WcLineItem[] = spec.lines.map((line, index) => {
    const subtotal = subtotals[index]!
    const total = subtotal - shares[index]!
    const rateId = line.rateId ?? WC_RATE_STANDARD
    const tax = spec.noTaxOnLines ? 0 : roundHalfUp((total * RATE_PERCENT[rateId]!) / 100)
    const subtotalTax = spec.noTaxOnLines ? 0 : roundHalfUp((subtotal * RATE_PERCENT[rateId]!) / 100)
    lineNet += total
    lineTax += tax
    if (!spec.noTaxOnLines) addTax(rateId, 'tax', tax)
    return {
      id: spec.id * 10 + index + 1,
      name: line.name ?? `Fixture product ${line.sku || 'without a SKU'}`,
      product_id: line.productId ?? 3000 + index,
      variation_id: 0,
      quantity: line.qty,
      tax_class: line.taxClass ?? '',
      subtotal: money(subtotal),
      subtotal_tax: money(subtotalTax),
      total: money(total),
      total_tax: money(tax),
      taxes: spec.noTaxOnLines ? [] : [{ id: rateId, total: money(tax), subtotal: money(subtotalTax) }],
      meta_data: [],
      sku: line.sku,
      price: line.unitMinor / 100,
    }
  })

  const feeLines = (spec.fees ?? []).map((fee, index) => {
    const rateId = fee.rateId ?? WC_RATE_STANDARD
    const tax = roundHalfUp((fee.minor * RATE_PERCENT[rateId]!) / 100)
    lineNet += fee.minor
    lineTax += tax
    addTax(rateId, 'tax', tax)
    return {
      id: spec.id * 10 + 7 + index,
      name: fee.name,
      tax_class: '',
      total: money(fee.minor),
      total_tax: money(tax),
      taxes: [{ id: rateId, total: money(tax) }],
    }
  })

  let shippingNet = 0
  let shippingTax = 0
  const shippingLines = spec.shipping
    ? [(() => {
        const rateId = spec.shipping!.rateId ?? WC_RATE_STANDARD
        const tax = roundHalfUp((spec.shipping!.minor * RATE_PERCENT[rateId]!) / 100)
        shippingNet = spec.shipping!.minor
        shippingTax = tax
        addTax(rateId, 'shipping', tax)
        return {
          id: spec.id * 10 + 9,
          method_title: spec.shipping!.title,
          method_id: 'flat_rate',
          total: money(spec.shipping!.minor),
          total_tax: money(tax),
          taxes: [{ id: rateId, total: money(tax) }],
        }
      })()]
    : []

  const taxLines: WcTaxLine[] = [...taxTotals.entries()].map(([rateId, parts], index) => ({
    id: spec.id * 10 + 5 + index,
    rate_code: RATE_LABEL[rateId]!,
    rate_id: rateId,
    label: rateId === WC_RATE_REDUCED ? 'Reduced rate VAT' : 'VAT',
    compound: false,
    tax_total: money(parts.tax),
    shipping_tax_total: money(parts.shipping),
  }))

  const totalMinor = lineNet + lineTax + shippingNet + shippingTax
  const paidAt = spec.paid === false ? null : new Date(created.getTime() + 2 * 60_000).toISOString().slice(0, 19)
  const modified = new Date(created.getTime() + 5 * 60_000).toISOString().slice(0, 19)
  const guest = spec.customerId === undefined || spec.customerId === 0

  return {
    id: spec.id,
    parent_id: 0,
    number: String(spec.id),
    order_key: `wc_order_fixture${spec.id}`,
    created_via: 'checkout',
    version: '9.4.2',
    status: spec.status,
    currency,
    date_created: gmt,
    date_created_gmt: gmt,
    date_modified: modified,
    date_modified_gmt: modified,
    discount_total: money(couponTotal),
    discount_tax: '0.00',
    shipping_total: money(shippingNet),
    shipping_tax: money(shippingTax),
    cart_tax: money(lineTax),
    total: money(totalMinor),
    total_tax: money(lineTax + shippingTax),
    prices_include_tax: spec.pricesIncludeTax ?? false,
    customer_id: guest ? 0 : spec.customerId!,
    customer_ip_address: '203.0.113.7',
    customer_note: spec.customerNote ?? '',
    billing: address(spec, 'billing'),
    shipping: address(spec, 'shipping'),
    payment_method: spec.paymentMethod ?? 'stripe',
    payment_method_title: spec.paymentMethod === 'cod' ? 'Cash on delivery' : 'Credit card (Stripe)',
    transaction_id: paidAt ? `ch_fixture${spec.id}` : '',
    date_paid: paidAt,
    date_paid_gmt: paidAt,
    date_completed: null,
    date_completed_gmt: null,
    cart_hash: `fixturehash${spec.id}`,
    meta_data: [],
    line_items: lineItems,
    tax_lines: taxLines,
    shipping_lines: shippingLines,
    fee_lines: feeLines,
    coupon_lines: (spec.coupons ?? []).map((coupon, index) => ({
      id: spec.id * 10 + 3 + index,
      code: coupon.code,
      discount: money(coupon.discountMinor),
      discount_tax: '0.00',
      // As WooCommerce 8.7+ reports a redeemed coupon: the item records its type. A coupon with NO recorded type is
      // refused by the import (it is not provably a discount), so a fixture without it would not be a real order.
      meta_data: [{ id: spec.id * 10 + 7 + index, key: 'coupon_info', value: JSON.stringify([spec.id * 10 + 3 + index, coupon.code, 'fixed_cart', money(coupon.discountMinor)]) }],
    })),
    refunds: (spec.refundsMinor ?? []).map((minor, index) => ({ id: spec.id * 100 + index + 1, reason: 'Fixture partial refund', total: `-${money(minor)}` })),
  }
}

/** How many extra ordinary PROCESSING orders there are, so the walk has to read more than one page (100 per page). */
export const BULK_PROCESSING_ORDERS = 112
export const BULK_FIRST_ID = 7000

function named(): FixtureOrder[] {
  const o = (spec: OrderSpec, expectation: FixtureExpectation, note: string): FixtureOrder => ({ order: buildWooOrder(spec), expectation, note })
  return [
    o({ id: 5001, status: 'processing', createdOffsetMinutes: 1, customerId: 77, lines: [{ sku: SKU_STOCKED, qty: 2, unitMinor: 1000 }, { sku: SKU_PLENTY, qty: 1, unitMinor: 2500 }], shipping: { title: 'Flat rate', minor: 499 } }, 'imports', 'Ordinary paid order for a registered customer, standard-rate lines and taxed shipping.'),
    o({ id: 5002, status: 'pending', createdOffsetMinutes: 2, lines: [{ sku: SKU_STOCKED, qty: 1, unitMinor: 1000 }], paid: false, paymentMethod: 'bacs' }, 'imports', 'Guest order (customer_id 0), pending payment, no payment date.'),
    o({ id: 5003, status: 'on-hold', createdOffsetMinutes: 3, customerId: 78, lines: [{ sku: SKU_UNSTOCKED, qty: 3, unitMinor: 1500 }], paid: false, paymentMethod: 'cod' }, 'imports-with-unallocatable-lines', 'On-hold order for a SKU IMS holds but has no stock of: imports, cannot be allocated (OD-4 backorder).'),
    o({ id: 5004, status: 'processing', createdOffsetMinutes: 4, customerId: 79, lines: [{ sku: SKU_STOCKED, qty: 1, unitMinor: 2000 }, { sku: SKU_PLENTY, qty: 2, unitMinor: 1500 }], coupons: [{ code: 'SAVE10', discountMinor: 500 }], shipping: { title: 'Flat rate', minor: 499 } }, 'imports', 'Cart coupon spread across two lines (subtotal minus total on each line).'),
    o({ id: 5005, status: 'processing', createdOffsetMinutes: 5, customerId: 80, lines: [{ sku: SKU_PLENTY, qty: 2, unitMinor: 2500 }], refundsMinor: [1000], shipping: { title: 'Flat rate', minor: 499 } }, 'imports', 'Partial refund already issued (refunds[] carries it; the order total is unchanged on the WooCommerce side).'),
    o({ id: 5006, status: 'processing', createdOffsetMinutes: 6, customerId: 81, lines: [{ sku: SKU_PLENTY, qty: 1, unitMinor: 3000 }, { sku: SKU_STOCKED, qty: 1, unitMinor: 1200, rateId: WC_RATE_REDUCED, taxClass: 'reduced-rate' }], fees: [{ name: 'Gift wrap', minor: 300 }], shipping: { title: 'Express', minor: 799 } }, 'imports', 'Two tax rates on one order (standard and reduced) plus a fee line.'),
    o({ id: 5007, status: 'processing', currency: 'EUR', createdOffsetMinutes: 7, customerId: 82, lines: [{ sku: SKU_PLENTY, qty: 2, unitMinor: 2400 }], shipping: { title: 'International', minor: 1200 } }, 'imports', 'Euro order: totals are converted at the GBP rate IMS holds for the order date.'),
    o({ id: 5008, status: 'processing', createdOffsetMinutes: 8, customerId: 83, lines: [{ sku: SKU_ABSENT, qty: 1, unitMinor: 4000 }, { sku: SKU_PLENTY, qty: 1, unitMinor: 1000 }] }, 'imports-with-unallocatable-lines', 'One line is for a SKU that does not exist in IMS: the order imports, that line carries no product and cannot be allocated.'),
    o({ id: 5009, status: 'processing', createdOffsetMinutes: 9, customerId: 84, lines: [{ sku: '', qty: 1, unitMinor: 900, name: 'Custom engraving' }, { sku: SKU_PLENTY, qty: 1, unitMinor: 1000 }] }, 'imports-with-unallocatable-lines', 'A WooCommerce line with no SKU at all (custom product): imports as wc-<product id>, no product link.'),
    o({ id: 5010, status: 'processing', currency: 'USD', createdOffsetMinutes: 10, customerId: 85, lines: [{ sku: SKU_PLENTY, qty: 1, unitMinor: 1300 }], shipping: { title: 'International', minor: 900 } }, 'imports', 'A US-dollar order. IMS holds a GBP-to-USD rate for it in a normal run; with the rate left out (a dedicated arm) the import cannot convert it, queues it for retry after the next FX-rate refresh, and the pass still ends COMPLETE.'),
    o({ id: 5011, status: 'processing', createdOffsetMinutes: 11, customerId: 86, pricesIncludeTax: true, lines: [{ sku: SKU_PLENTY, qty: 3, unitMinor: 1667 }], shipping: { title: 'Flat rate', minor: 499 } }, 'imports', 'Store that enters prices inclusive of tax (prices_include_tax true).'),
    o({ id: 5012, status: 'processing', createdOffsetMinutes: 12, customerId: 87, lines: [{ sku: SKU_STOCKED, qty: 50, unitMinor: 1000 }] }, 'imports-with-unallocatable-lines', 'Bigger than the stock IMS holds for the SKU: imports, cannot be fully allocated.'),
    o({ id: 5013, status: 'processing', createdOffsetMinutes: 13, lines: [{ sku: SKU_PLENTY, qty: 1, unitMinor: 1000 }], noTaxOnLines: true, customerNote: 'Zero-rated export, no VAT lines' }, 'imports', 'Guest order with no tax lines at all.'),
    o({ id: 5014, status: 'processing', createdOffsetMinutes: 14, customerId: 88, lines: [{ sku: SKU_PLENTY, qty: 1, unitMinor: 1000, rateId: WC_RATE_UNMAPPED }], shipping: { title: 'Flat rate', minor: 499, rateId: WC_RATE_UNMAPPED } }, 'imports', 'Taxed at a WooCommerce rate id IMS has no mapping for: imports, and IMS resolves the rate itself from the product category and destination.'),
    o({ id: 5015, status: 'pending', createdOffsetMinutes: 15, lines: [{ sku: SKU_UNSTOCKED, qty: 2, unitMinor: 1500 }], paid: false, paymentMethod: 'bacs' }, 'imports-with-unallocatable-lines', 'Pending-payment guest order for the SKU IMS holds but has no stock of.'),
    // Statuses the owner decision abandons: present in the store, never asked for.
    o({ id: 5101, status: 'completed', createdOffsetMinutes: -60, customerId: 77, lines: [{ sku: SKU_PLENTY, qty: 1, unitMinor: 1000 }] }, 'abandoned-by-status', 'Completed before the cut-over: not imported by design.'),
    o({ id: 5102, status: 'cancelled', createdOffsetMinutes: -50, customerId: 77, lines: [{ sku: SKU_PLENTY, qty: 1, unitMinor: 1000 }], paid: false }, 'abandoned-by-status', 'Cancelled: not imported by design.'),
    o({ id: 5103, status: 'refunded', createdOffsetMinutes: -40, customerId: 78, lines: [{ sku: SKU_PLENTY, qty: 2, unitMinor: 1000 }], refundsMinor: [2400] }, 'abandoned-by-status', 'Fully refunded: not imported by design.'),
    o({ id: 5104, status: 'failed', createdOffsetMinutes: -30, lines: [{ sku: SKU_PLENTY, qty: 1, unitMinor: 1000 }], paid: false }, 'abandoned-by-status', 'Failed payment: not imported by design.'),
  ]
}

function bulk(): FixtureOrder[] {
  return Array.from({ length: BULK_PROCESSING_ORDERS }, (_, index) => ({
    order: buildWooOrder({
      id: BULK_FIRST_ID + index,
      status: 'processing',
      createdOffsetMinutes: 100 + index,
      customerId: 1000 + (index % 40),
      lines: [{ sku: SKU_PLENTY, qty: 1, unitMinor: 1000 + (index % 7) * 100 }],
      shipping: index % 3 === 0 ? { title: 'Flat rate', minor: 499 } : undefined,
    }),
    expectation: 'imports' as const,
    note: 'Bulk ordinary order so the walk must read more than one page.',
  }))
}

/** The whole store, in creation order. */
export function wooFixtureOrders(): FixtureOrder[] {
  return [...named(), ...bulk()].sort((a, b) => a.order.date_created_gmt.localeCompare(b.order.date_created_gmt) || a.order.id - b.order.id)
}
