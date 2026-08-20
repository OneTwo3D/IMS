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
import { addMoney, currencyMinorUnits, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { Prisma, TaxCategory } from '@/app/generated/prisma/client'
import {
  UNRECONCILED_TAX_PAYLOAD_KEY, buildUnreconciledTaxMarker,
} from '@/lib/domain/accounting/document-tax-reconciliation'
import { getSettingValue } from '@/lib/settings-store'
import { notify } from '@/lib/notifications'
import { parsePositiveIntegerEnv } from '@/lib/env'
import { findWcStatusMapping, isWcStatus } from './status-mapping'
import {
  parseWcSyncOrderStatuses,
  resolveWcPullStatuses,
  WC_NO_STATUSES_SELECTED_MESSAGE,
  WC_SYNC_ORDER_STATUSES_SETTING_KEY,
  type WcOrderPullRoute,
} from '../order-status-filter'

// ---------------------------------------------------------------------------
// Import a single WC order into IMS
// ---------------------------------------------------------------------------

export type ImportWcOrderOptions = {
  skipAccounting?: boolean
  useWcDateAsCreatedAt?: boolean
  pendingFxRetryLogId?: string
  /**
   * May this import CREATE an order IMS has never seen? (o3d-tj6v r4)
   *
   * `undefined` — the default — means yes, and is what every PULL route passes: those already
   * asked WooCommerce for `?status=<selection>`, so a row that came back is admitted by
   * construction, and re-judging it here would drop the reconcile sweep's `completed` backstop.
   *
   * `false` is passed by the routes that receive an order WITHOUT having asked for a status —
   * the order webhook and the withdrawal recovery sweep. It is enforced at the one point that
   * knows the answer to "does IMS already hold this order?", which is the `findFirst` below.
   * See the note there for why the check cannot live anywhere else.
   */
  admitCreate?: boolean
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
}

/**
 * Order-level foreign-currency aggregates — subtotal (net of VAT/discount), tax,
 * and grand total — computed entirely in Decimal so the AR-control / FX-revaluation
 * amounts don't accumulate float drift across many lines (scjz.62). Callers convert
 * to base currency at the single /fxRate boundary (divideRoundedNumber).
 *
 * o3d-cyn: THERE IS NO VAT TO EXTRACT HERE, on either WooCommerce price convention.
 * `unitPriceForeign` comes from `line_items[].subtotal / quantity` and `discountAmount`
 * from `subtotal - total`, and WC REST reports BOTH ex-tax whatever `prices_include_tax`
 * says — the tax lives in `subtotal_tax` / `total_tax`, which is where `taxForeign` comes
 * from. This used to divide by (1 + rate) for a tax-inclusive store, netting an amount
 * that was already net: an order of net 100 + 20 VAT = 120 gross stored a subtotal of
 * 83.33, so `subtotal + shipping + tax` no longer reconciled to `totalForeign` (the order
 * total straight off Woo). Dropping the branch makes the identity hold on both
 * conventions. Same reasoning as `isWooCommerceOrder()` in lib/sales-currency.ts, which
 * already exempts WC orders from every gross-price derivation for this reason.
 */
export function computeWcOrderForeignTotals(input: {
  lines: WcForeignTotalsLine[]
  shippingTaxForeign: Array<string | number | null | undefined>
  orderTotal: string | number | null | undefined
}): { subtotalForeign: Decimal; taxForeign: Decimal; totalForeign: Decimal } {
  const subtotalForeign = input.lines.reduce((sum, line) => {
    const net = toDecimal(line.qty).mul(toDecimal(line.unitPriceForeign)).sub(toDecimal(line.discountAmount))
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
 * BOTH WooCommerce price conventions, since o3d-cyn. This used to return undefined for a tax-INCLUSIVE
 * store, because the invoice was CONSTRUCTED at the net total there — WC REST line amounts are always
 * ex-tax, and the importer sent them flagged tax-inclusive, so Xero read net 100 as gross and the whole
 * invoice landed at 100 for an order that grossed 120. A gross payment would have exceeded that invoice
 * and Xero would have rejected it, so inclusive orders were left on the (wrong-but-consistent) net
 * fallback. The construction now sends every component ex-tax with `lineAmountsIncludeTax: false` on
 * both conventions, so the invoice totals to `wcOrder.total` either way and the gate has nothing left to
 * protect: an inclusive order settles to PAID like an exclusive one.
 *
 * Returns undefined (→ registers no payment) when the order isn't paid, when it carries no usable
 * total, and — o3d-cyn round 2 — WHEN THE DOCUMENT WILL NOT TOTAL TO THAT ORDER.
 *
 * That last one is the whole point of the second argument. The gross is the right payment only for a
 * document built at the gross; send it against a document Xero will total differently and Xero either
 * refuses it or, worse, accepts it as a PART payment and leaves a balance nobody is looking at — while
 * IMS compares the amount it sent against the order total, finds them equal, and reports SETTLED. The
 * caller establishes whether the document reconciles (see `reconcileWcDocumentTax`), and an order that
 * does not reconcile registers NOTHING.
 *
 * SINCE ROUND 3 THAT DOCUMENT ALSO DOES NOT POST (`refuseUnreconciledDocument`), so this guard is the
 * second of two rather than the only one — and it stays, because it is the one that holds if a
 * document ever reaches the ledger by another route. The verdict an operator sees is then
 * NOT_APPLICABLE naming the DOCUMENT sync ("a payment cannot be attached until it has posted"), with
 * the failed sync row and an ERROR activity naming the tax disagreement — rather than SETTLED, which
 * is a lie nobody is shown.
 *
 * The argument is REQUIRED and has no default on purpose. A default would make the guard opt-in, and
 * the callers who forget it are exactly the ones whose documents are wrong.
 */
export function resolveWcInvoicePaymentAmount(
  wcOrder: Pick<WcFullOrder, 'date_paid_gmt' | 'total'>,
  document: { totalsToTheOrder: boolean },
): number | undefined {
  if (!document.totalsToTheOrder) return undefined
  if (!wcOrder.date_paid_gmt || !wcOrder.total) return undefined
  const gross = Number(wcOrder.total)
  return Number.isFinite(gross) && gross > 0 ? gross : undefined
}

/**
 * o3d-cyn: the TAX CONVENTION the WooCommerce → accounting document is built in, plus the two
 * money legs that are not line items (shipping and the residual order-level discount).
 *
 * ONE CONVENTION FOR BOTH WOOCOMMERCE PRICE MODES, and it is the EXCLUSIVE one, because every
 * amount the importer has is already ex-tax:
 *
 *  • line items  — `unitAmount` is `line_items[].subtotal / quantity`, `discountAmount` is
 *    `subtotal - total`. WC REST reports both ex-tax whatever `prices_include_tax` says.
 *  • coupons     — `coupon_lines[].discount` is ex-tax too (`discount_tax` is separate), which is
 *    why Woo's allocation of a coupon into the lines is basis-consistent (o3d-y14).
 *  • shipping    — `shipping_lines[].total` is ex-tax; the tax is `total_tax`.
 *
 * WHAT THIS REPLACES. The document used to be flagged `Inclusive` whenever the STORE displayed
 * prices inclusive of tax, while still carrying those ex-tax amounts — so Xero read a net 100 line
 * as a gross one and extracted the VAT back out of it, posting the invoice at 100 for an order that
 * grossed 120. Shipping was singled out and multiplied by (1 + rate) to compensate, which made the
 * document internally inconsistent as well as wrong: net-treated-as-gross lines beside a genuinely
 * grossed shipping line. Both halves go; nothing is grossed up and nothing is flagged inclusive.
 *
 * Worked, at 20% VAT, on a tax-INCLUSIVE store — net 100 of goods, a net 10 coupon, net 10 shipping,
 * `wcOrder.total` 120.00:
 *   before → lines 100 − 10 = 90 read as GROSS, shipping 10 × 1.2 = 12 read as GROSS, invoice 102.00
 *   after  → lines 100 − 10 = 90 net, shipping 10 net, Xero adds 20% → 100 × 1.2 = 120.00 = the order
 * The same numbers on a tax-EXCLUSIVE store were already handled this way and are unchanged.
 *
 * Xero derives the tax from each line's `taxType` rather than from Woo's `total_tax`. The two agree
 * to the penny in the ordinary case; where they do not, the invoice total can differ from
 * `wcOrder.total` by rounding, and the gross payment (`resolveWcInvoicePaymentAmount`) is then
 * refused BY XERO with an amount-exceeds-outstanding error on the INVOICE_PAYMENT follow-up — a
 * visible, retryable sync row naming the invoice, not a wrong figure in the ledger. That exposure is
 * identical to the one the tax-exclusive path has always carried.
 */
export function resolveWcAccountingAmountConvention(input: {
  /**
   * The STORE's price-display convention (`wcOrder.prices_include_tax`). Taken and deliberately
   * NOT read: reading it here is precisely what the defect was, and the parameter stays so that a
   * caller cannot reach this decision without the flag in hand and so that the tests can pin the
   * inclusive answer to `Exclusive`. It describes how Woo shows prices to a shopper, never what
   * the REST payload's amounts mean.
   */
  pricesIncludeVat: boolean
  shippingForeign: DecimalInput
  orderLevelDiscountForeign?: DecimalInput
}): { lineAmountsIncludeTax: false; shippingAmount: number | undefined; discountAmount: number | undefined } {
  const shipping = toDecimal(input.shippingForeign)
  const discount = toDecimal(input.orderLevelDiscountForeign ?? 0)
  return {
    lineAmountsIncludeTax: false,
    shippingAmount: shipping.gt(0) ? roundDecimalNumber(shipping, 4) : undefined,
    discountAmount: discount.gt(0) ? roundDecimalNumber(discount, 2) : undefined,
  }
}

// ---------------------------------------------------------------------------
// SHIPPING NEED NOT CARRY THE GOODS' TAX RATE (o3d-cyn round 2)
// ---------------------------------------------------------------------------
//
// The document sends shipping on `accountingTaxType` — the ORDER DEFAULT, derived from the goods.
// A store that charges a different rate on delivery (zero-rated postage beside standard-rated goods,
// or the reverse) therefore posts a shipping line Xero taxes at the WRONG rate, and the invoice no
// longer totals to `wcOrder.total`:
//
//   goods net 100 @ 20% = 20 VAT, shipping net 10 @ 0% = 0 VAT, wcOrder.total = 130.00
//   sent on the goods' rate, Xero computes 20% on the shipping too → invoice 132.00
//
// AND NOTHING SAID SO. The gross payment registered is `wcOrder.total` = 130.00, which Xero accepts
// as a PART payment against its 132.00 invoice; the invoice stays AUTHORISED with 2.00 outstanding
// for ever. IMS meanwhile compares the 130.00 it sent against the 130.00 order total —
// `ledgerSalesInvoiceTotalForeign` returns the order total, correctly, because that is what a
// correctly-built document totals to — and prints SETTLED. The one figure neither system compares
// against is the one the ledger actually holds.
//
// Three changes, and they are layers rather than alternatives:
//
//  1. RESOLVE THE SHIPPING RATE FROM THE SHIPPING LINE'S OWN TAX, so the ordinary mixed-rate order
//     posts a document that does total to the order and settles.
//  2. CHECK THE DOCUMENT AGAINST WOO'S OWN PER-COMPONENT TAX BEFORE CLAIMING THE PAYMENT SETTLES IT.
//     When the tax the document will produce disagrees with the tax Woo reports, no payment is
//     registered at all.
//  3. AND DO NOT POST THAT DOCUMENT (round 3). Rounds 1 and 2 still sent the invoice — shipping on
//     the order default, "there is no better guess" — and withheld only the payment. That withholds
//     the recoverable half: a payment can be registered later, while an AUTHORISED receivable at the
//     wrong total is on the VAT return and takes a credit note to undo. The document is STAMPED at
//     import and REFUSED at the poster (`refuseUnreconciledDocument`), which leaves a failed sync row
//     naming the fault and the remedy instead of a wrong figure in the ledger.
//
// THE CASE THAT FORCED (3) is a shipping line WooCommerce taxed at a BLEND of rates. (1) is chosen by
// arithmetic — a rate is accepted only if it reproduces the tax Woo charged — which answers a blend
// correctly whenever the blend SUMS to a rate IMS holds, and cannot answer one that does not. There
// is no tax type to send, so there is no document to post.

/** A tax rate as `resolveWcTaxRateById` reports it, reduced to what these decisions depend on. */
export type WcResolvedRateForDocument = {
  accountingTaxType: string | null
  taxRateValue: number
  source?: 'mapped' | 'default'
}

export type WcShippingTaxResolution = {
  /** The accounting tax type to send on the shipping line. */
  taxType: string | null
  /** The rate that tax type will apply, as a fraction. */
  rateValue: number
  /** False when no rate we hold reproduces the tax Woo actually charged on shipping. */
  resolved: boolean
  /** Named when unresolved, for the operator-facing warning. */
  reason?: string
  /**
   * How many WooCommerce tax rates actually CONTRIBUTED tax to the shipping line. More than one and
   * the line is taxed at a BLEND, which no single tax type can reproduce unless the blend happens to
   * sum to a rate we hold — see `resolveWcShippingTaxRate`.
   */
  contributingRateCount?: number
}

/**
 * ONE POSTED MINOR UNIT EITHER WAY, IN THE ORDER'S OWN CURRENCY.
 *
 * A rate is judged by whether it REPRODUCES the tax Woo charged, not by comparing rate fractions —
 * `1.67 / 8.33` is not `0.20` and never will be, while `8.33 × 0.20` lands within a penny of the
 * `1.67` Woo's own rounding produced. The allowance therefore has to be the smallest amount either
 * system can POST, and that is a property of the currency, not a constant.
 *
 * o3d-cyn r4 — THE CONSTANT WAS `0.011`, WHICH IS A PENNY AND ONLY A PENNY. A WooCommerce store can
 * run any currency, and this is the same minor-unit family the coupon-allocation tolerance was fixed
 * for (o3d-5tf, `couponAllocationTolerance`):
 *
 *   • 3-DECIMAL (KWD, BHD, JOD, OMR, TND): `0.011` is ELEVEN whole minor units. A shipping line whose
 *     tax is out by ten fils — a mis-mapped 4.99% where the shop charged 5% — reproduced and
 *     reconciled, so the invoice POSTED at a total that does not match the order. That is the branch's
 *     own rule broken in the currency it was least likely to be noticed in: a document IMS had the
 *     evidence to know was wrong went to the ledger, the payment for the order total part-settled it,
 *     and the receivable stays open for ever.
 *   • 0-DECIMAL (JPY, KRW, ISK, CLP, VND): `0.011` is a hundredth of the smallest coin. Woo's own
 *     whole-yen rounding of a rate applied to a net moves the figure by up to half a yen, so an
 *     ENTIRELY CORRECT document failed to reproduce, the shipping rate came back unresolved, and the
 *     order was stamped and refused. Legitimate work blocked, on arithmetic that cannot be satisfied.
 *
 * `10^-minorUnits × 1.1` is one posted minor unit plus a tenth for binary-float slack: exactly
 * `0.011` for a 2-decimal currency (so nothing about GBP/EUR/USD moves), `0.0011` for a 3-decimal one
 * and `1.1` for a 0-decimal one.
 */
function componentTaxTolerance(currency: string): Decimal {
  return toDecimal(10).pow(-currencyMinorUnits(currency)).mul(11).div(10)
}

function reproducesTax(netForeign: Decimal, rateValue: number, reportedTax: Decimal, currency: string): boolean {
  return netForeign.mul(toDecimal(rateValue)).sub(reportedTax).abs().lte(componentTaxTolerance(currency))
}

/**
 * Which tax type the SHIPPING line should carry.
 *
 * The answer is chosen by arithmetic, not by trust: a candidate rate is accepted only if applying it
 * to the shipping net reproduces the tax WooCommerce actually charged on shipping. That makes the
 * choice self-verifying, and it is why a rate id Woo names but IMS has not mapped cannot quietly
 * substitute the goods rate.
 *
 * Order of preference:
 *  1. a MAPPED rate the shipping line itself names, which reproduces Woo's shipping tax;
 *  2. the ORDER DEFAULT, if it reproduces Woo's shipping tax — this is the ordinary single-rate
 *     order, and it is what was always sent, so nothing about that case moves;
 *  3. nothing. `resolved` is false, and since o3d-cyn round 3 that is not a warning attached to a
 *     document that posts anyway — the document is stamped and the poster refuses it (see
 *     `refuseUnreconciledDocument`). The order default is still reported as the type it WOULD have
 *     carried, because that is what the operator needs to see to recognise the mis-mapping.
 *
 * A BLENDED SHIPPING LINE IS THE CASE WITH NO RIGHT ANSWER, and it is why (3) had to stop posting.
 * WooCommerce taxes one shipping line at as many rates as apply to it — `shipping_lines[].taxes` is
 * a LIST — so a line can carry, say, 15% + 5%. An accounting document has ONE `shippingTaxType`, so
 * unless the blend SUMS to a rate IMS holds (and then the arithmetic above finds it, and the
 * document is right), there is nothing to send that reproduces the charge. Guessing the order
 * default there posts a receivable at a total nobody will reconcile against. The blend is COUNTED
 * rather than inferred from the failure, so the operator is told which of the two situations they
 * are in: a rate IMS has not mapped (map it) or a genuine blend (the document cannot express it).
 */
export function resolveWcShippingTaxRate(input: {
  shippingLines: Array<{
    total_tax?: string | number | null
    taxes?: Array<{ id: number; total?: string | number | null }> | null
  }>
  shippingNetForeign: DecimalInput
  /** Every WooCommerce rate id already resolved for this order. */
  rateById: ReadonlyMap<number, WcResolvedRateForDocument>
  orderDefault: WcResolvedRateForDocument
  /**
   * The ORDER currency (o3d-cyn r4). It sets the minor unit every comparison below is measured in —
   * "reproduces the tax Woo charged" means "to within one amount either system can post", and that
   * amount is a yen in JPY and a fils in KWD, not a penny everywhere.
   */
  currency: string
}): WcShippingTaxResolution {
  const net = toDecimal(input.shippingNetForeign)
  const money = currencyMinorUnits(input.currency)
  // No shipping line is put on the document at all below zero, so no tax type is used and there is
  // nothing here that can be wrong.
  if (!net.gt(0)) {
    return { taxType: input.orderDefault.accountingTaxType, rateValue: 0, resolved: true, contributingRateCount: 0 }
  }

  const reportedTax = input.shippingLines.reduce<Decimal>(
    (sum, line) => addMoney(sum, toDecimal(line.total_tax ?? 0)),
    toDecimal(0),
  )

  const named = new Map<number, WcResolvedRateForDocument>()
  // Rates that actually MOVED money on this line. A rate id listed at 0.00 is not part of a blend —
  // zero-rated postage alongside a standard rate is one rate charging, and the arithmetic below
  // resolves it exactly as it always did.
  const contributing = new Set<number>()
  for (const line of input.shippingLines) {
    for (const tax of line.taxes ?? []) {
      if (!toDecimal(tax.total ?? 0).eq(0)) contributing.add(tax.id)
      const rate = input.rateById.get(tax.id)
      // `source: 'default'` means Woo named a rate id IMS has no mapping for, so its tax type is a
      // substitution rather than a translation — exactly what the per-line path refuses to trust.
      if (rate && rate.source === 'mapped') named.set(tax.id, rate)
    }
  }
  const matching = [...named.values()].filter((rate) => reproducesTax(net, rate.taxRateValue, reportedTax, input.currency))
  const distinctTypes = new Set(matching.map((rate) => rate.accountingTaxType))
  if (distinctTypes.size === 1) {
    const chosen = matching[0]
    return {
      taxType: chosen.accountingTaxType,
      rateValue: chosen.taxRateValue,
      resolved: true,
      contributingRateCount: contributing.size,
    }
  }
  if (distinctTypes.size > 1) {
    return {
      taxType: input.orderDefault.accountingTaxType,
      rateValue: input.orderDefault.taxRateValue,
      resolved: false,
      contributingRateCount: contributing.size,
      reason:
        `WooCommerce charged ${reportedTax.toFixed(money)} of tax on ${net.toFixed(money)} of shipping and IMS holds `
        + `${distinctTypes.size} different accounting tax types that would produce it, so the shipping line `
        + `cannot be given one.`,
    }
  }
  if (reproducesTax(net, input.orderDefault.taxRateValue, reportedTax, input.currency)) {
    return {
      taxType: input.orderDefault.accountingTaxType,
      rateValue: input.orderDefault.taxRateValue,
      resolved: true,
      contributingRateCount: contributing.size,
    }
  }
  return {
    taxType: input.orderDefault.accountingTaxType,
    rateValue: input.orderDefault.taxRateValue,
    resolved: false,
    contributingRateCount: contributing.size,
    // Two different faults, and the operator's next move differs: a rate to map, versus a charge no
    // single tax type can express. Counting the contributors is what tells them apart — inferring
    // "unmapped rate" from the failure would send someone hunting for a mapping that would not help.
    reason:
      contributing.size > 1
        ? `WooCommerce applied ${contributing.size} tax rates to this shipping line, together charging `
          + `${reportedTax.toFixed(money)} on ${net.toFixed(money)} of shipping. An accounting document carries ONE tax `
          + `type on shipping, and no single rate IMS holds reproduces that blend — not the order's default of `
          + `${(input.orderDefault.taxRateValue * 100).toFixed(2)}% either. There is no tax type that can be sent `
          + `for it.`
        : `WooCommerce charged ${reportedTax.toFixed(money)} of tax on ${net.toFixed(money)} of shipping, which is neither `
          + `the order's default rate of ${(input.orderDefault.taxRateValue * 100).toFixed(2)}% nor any WooCommerce `
          + `shipping rate mapped in IMS.`,
  }
}

/** One component of the document whose tax WooCommerce also reports, so the two can be compared. */
export type WcDocumentTaxComponent = {
  label: string
  /** The NET amount the document carries, in order currency. */
  netForeign: DecimalInput
  /** The rate the accounting tax type sent for it will apply, as a fraction. */
  rateValue: number
  /** The tax WooCommerce itself charged on this component. */
  reportedTaxForeign: DecimalInput
}

export type WcDocumentTaxReconciliation = {
  reconciles: boolean
  /** Every component whose modelled tax disagrees with Woo's, worst first. */
  disagreements: Array<{ label: string; modelledTax: number; reportedTax: number; difference: number }>
}

/**
 * Will the document produce the tax WooCommerce charged?
 *
 * PER COMPONENT, against Woo's own figure for that component, rather than against a single order
 * total — because a total can agree while two components are wrong in opposite directions, and
 * because naming the component is what makes the resulting warning actionable.
 *
 * The ORDER-LEVEL RESIDUAL DISCOUNT is deliberately NOT a component here. It is coupon money Woo did
 * not allocate to any line (o3d-y14), so Woo reports no tax figure for it and there is nothing to
 * compare against; inventing one would make this check assert its own guess. Its exposure is
 * unchanged by this function and is the same one o3d-y14 records.
 */
export function reconcileWcDocumentTax(
  components: WcDocumentTaxComponent[],
  /**
   * The ORDER currency (o3d-cyn r4). Both the rounding and the tolerance are money, and money is only
   * defined once you know which. Rounding every figure to 2dp and allowing a penny either way was
   * right for GBP and wrong in both directions elsewhere: in a 3-decimal currency it rounded a real
   * ten-fils error away to `0.01` and then waved it through as "within a penny", so a document IMS
   * knew would not total to its order POSTED; in a 0-decimal one it demanded agreement a hundred
   * times finer than the smallest coin, so correct documents were refused.
   */
  currency: string,
): WcDocumentTaxReconciliation {
  const money = currencyMinorUnits(currency)
  // One posted minor unit either way, in this currency — see `componentTaxTolerance`. Compared as a
  // Decimal against Decimal-rounded money, so the threshold is not itself a float approximation.
  const tolerance = componentTaxTolerance(currency)
  const disagreements = components
    .map((component) => {
      const net = toDecimal(component.netForeign)
      const reported = toDecimal(component.reportedTaxForeign)
      const modelled = net.mul(toDecimal(component.rateValue))
      return {
        label: component.label,
        modelledTax: roundDecimalNumber(modelled, money),
        reportedTax: roundDecimalNumber(reported, money),
        difference: roundDecimalNumber(modelled.sub(reported), money),
      }
    })
    .filter((d) => toDecimal(d.difference).abs().gt(tolerance))
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
  return { reconciles: disagreements.length === 0, disagreements }
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
  await releaseHeldWcSalesInvoice(orderId, { externalOrderId: String(wcOrder.id), externalOrderNumber: wcOrder.number }, usableInvoiceNumber)
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
 * ENQUEUE FIRST, MARK THE ROW SECOND. A crash between the two leaves the row PENDING, so the
 * release sweep does it again — and the enqueue carries a deterministic idempotency key on
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
 * work has to come from, rather than from a return value the callee does not give.
 *
 * AND A FAILURE HAS SOMEWHERE TO GO (Codex round 4). "It stays PENDING and the next redelivery or
 * poll retries it" was not true: this function is only ever reached from an import of the order,
 * and the storefront event that would cause one — WooCommerce writing the number — is the very
 * event that has just been consumed. The failure that is left is therefore permanent by
 * construction, which is precisely the shape of retry that never fires. The row still stays PENDING
 * and now says WHY on its own errorMessage, and {@link retryHeldWcSalesInvoiceReleases} — driven by
 * the reconcile cron, not by an order event — is what comes back for it.
 */
type HeldReleaseOrderRef = {
  externalOrderId: string
  externalOrderNumber: string
}

/**
 * What happened to the invoice that was held back. The import path ignores it; the sweep counts it.
 *
 * `not-queued` is the one that matters: the hold is still PENDING, still owed an invoice, and the
 * only thing that will try again is the sweep.
 */
export type HeldSalesInvoiceReleaseOutcome = 'no-hold' | 'released' | 'unreadable' | 'not-queued'

/** Keep the hold PENDING, but stop it claiming to be waiting for a number that has already arrived. */
async function noteHeldReleaseFailure(rowId: string, message: string): Promise<void> {
  await db.shoppingSyncLog.update({
    where: { id: rowId },
    data: { errorMessage: message, syncedAt: null },
  }).catch((error) => {
    console.error(`[wc-import] could not record why the held sales invoice ${rowId} was not released:`, error)
  })
}

async function releaseHeldWcSalesInvoice(
  orderId: string,
  wcOrder: HeldReleaseOrderRef,
  invoiceNumber: string,
  options?: { logFailure?: boolean },
): Promise<HeldSalesInvoiceReleaseOutcome> {
  const logFailure = options?.logFailure ?? true
  let row: { id: string; payload: Prisma.JsonValue | null } | null = null
  try {
    row = await db.shoppingSyncLog.findFirst({
      where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }),
      orderBy: { createdAt: 'desc' },
      select: { id: true, payload: true },
    })
  } catch (error) {
    console.error(`[wc-import] could not look for a held sales invoice for ${orderId}:`, error)
    return 'no-hold'
  }
  if (!row) return 'no-hold'

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
        `WooCommerce order ${wcOrder.externalOrderNumber} has its invoice number (${invoiceNumber}) but the held accounting `
        + 'payload could not be read, so the sales invoice was NOT queued. Queue it from the order.',
      metadata: { connector: 'woocommerce', externalOrderId: wcOrder.externalOrderId, invoiceNumber },
      resolveUser: false,
    }).catch(() => {})
    return 'unreadable'
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
    // Left PENDING on purpose — the release sweep retries it (see retryHeldWcSalesInvoiceReleases).
    await noteHeldReleaseFailure(
      row.id,
      `WooCommerce numbered this invoice ${invoiceNumber}, but queueing the held sales invoice failed `
      + `(${error instanceof Error ? error.name : typeof error}). It stays queued for release and is retried by the `
      + 'WooCommerce reconcile sweep.',
    )
    if (logFailure) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'sales_invoice_release_failed',
        tag: 'accounting',
        level: 'WARNING',
        description:
          `WooCommerce order ${wcOrder.externalOrderNumber} has its invoice number (${invoiceNumber}) but queueing the held `
          + 'sales invoice failed; it stays queued for release and is retried by the WooCommerce reconcile sweep.',
        metadata: {
          connector: 'woocommerce',
          externalOrderId: wcOrder.externalOrderId,
          invoiceNumber,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        resolveUser: false,
      }).catch(() => {})
    }
    return 'not-queued'
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
    return 'not-queued'
  }
  if (!queued) {
    // Left PENDING on purpose, exactly as the throwing case is: the sweep tries again, and the
    // deterministic key means a later success adds one row, not two.
    await noteHeldReleaseFailure(
      row.id,
      `WooCommerce numbered this invoice ${invoiceNumber}, but queueing the held sales invoice produced no `
      + 'accounting sync row, so NOTHING will post. The usual cause is that the accounting connector is '
      + 'disconnected, its sync is switched off, or Sales Invoices are set to off. Retried by the WooCommerce '
      + 'reconcile sweep.',
    )
    if (logFailure) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'sales_invoice_release_not_queued',
        tag: 'accounting',
        level: 'WARNING',
        description:
          `WooCommerce order ${wcOrder.externalOrderNumber} has its invoice number (${invoiceNumber}), but queueing the held `
          + 'sales invoice produced no accounting sync row, so NOTHING will post. The usual cause is that the '
          + 'accounting connector is disconnected, its sync is switched off, or Sales Invoices are set to off; the '
          + 'other is that the sales order was deleted. The order stays queued for release and is retried by the '
          + 'WooCommerce reconcile sweep.',
        metadata: { connector: 'woocommerce', externalOrderId: wcOrder.externalOrderId, invoiceNumber, idempotencyKey },
        resolveUser: false,
      }).catch(() => {})
    }
    return 'not-queued'
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
      `WooCommerce order ${wcOrder.externalOrderNumber} is now numbered ${invoiceNumber}; the sales invoice held back for it `
      + 'has been queued.',
    metadata: {
      connector: 'woocommerce',
      externalOrderId: wcOrder.externalOrderId,
      externalOrderNumber: wcOrder.externalOrderNumber,
      invoiceNumber,
    },
    resolveUser: false,
  }).catch(() => {})
  return 'released'
}

/**
 * THE THING THAT ACTUALLY RETRIES A FAILED RELEASE (o3d-k26m.6, Codex round 4).
 *
 * Round 3 made the release CONFIRM the sync row exists before closing the hold, which was right and
 * is what turned a silent no-op into a visible one. What it left was a hold sitting PENDING with
 * "the next redelivery or poll retries it" written next to it — AND NOTHING SCHEDULING EITHER.
 * `releaseHeldWcSalesInvoice` is reached only from an import of that order, and an import happens
 * only when WooCommerce touches the order again. The number arriving IS that touch, and it has
 * already been spent by the time the release runs. So the commonest failure — the accounting
 * connector disconnected, its sync off, or sales-invoice posting off — leaves an order numbered,
 * PROCESSING and permanently un-invoiced, which is the exact defect the hold exists to end.
 *
 * A RETRY WITH NO DRIVER IS NOT A RETRY. This is the driver: the WooCommerce reconcile cron, which
 * runs on a timer rather than on an order event, so it comes back whether or not the storefront
 * ever mentions the order again. (It is gated on the WooCommerce plugin and `wc_sync_enabled`, the
 * same gate the import itself is behind — with those off there is no importer to owe an invoice.)
 *
 * IT ASKS THE ORDER, NOT THE ROW. A hold is releasable when the SalesOrder has a number and no
 * ledger document; both facts live on the order, and reading them is what tells a hold that is
 * legitimately WAITING (no number yet — the ordinary state, and not a failure) apart from one that
 * is STUCK.
 *
 * TERMINAL HOLDS ARE CLOSED RATHER THAN RE-SCANNED. A hold whose order was deleted, or whose order
 * has since been invoiced by another route, can never be released; left PENDING it would sit at the
 * head of an oldest-first scan forever and, once enough of them accumulate, starve every newer hold
 * behind them — the starvation the pending-FX queue documents one function below. So each is
 * settled with a reason: FAILED when the order is gone, SYNCED when the invoice exists.
 *
 * FAILURES ARE COUNTED, NOT RE-WARNED. The per-order WARNING is the import path's, where it is news.
 * Repeating it every few minutes for every stuck hold for the duration of a connector outage would
 * bury the log, so the sweep records the reason on each row and raises ONE warning naming the total.
 */
export async function retryHeldWcSalesInvoiceReleases(options?: {
  /** How many holds to attempt to release per run. */
  limit?: number
  /** How many held rows to look at. Terminal rows are closed, so this is not a moving cap. */
  scanLimit?: number
}): Promise<{
  scanned: number
  released: number
  stillWaiting: number
  stillStuck: number
  closed: number
  scanCapReached: boolean
}> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 250)
  const scanLimit = Math.min(Math.max(options?.scanLimit ?? 500, limit), 2000)
  const result = { scanned: 0, released: 0, stillWaiting: 0, stillStuck: 0, closed: 0, scanCapReached: false }

  let rows: Array<{ id: string; entityId: string | null; payload: Prisma.JsonValue | null }>
  try {
    rows = await db.shoppingSyncLog.findMany({
      where: heldSalesInvoiceQueueWhere(),
      orderBy: { createdAt: 'asc' },
      take: scanLimit,
      select: { id: true, entityId: true, payload: true },
    })
  } catch (error) {
    console.error('[wc-held-release] could not read the held sales-invoice queue:', error)
    return result
  }
  result.scanned = rows.length
  result.scanCapReached = rows.length >= scanLimit
  if (rows.length === 0) return result

  const orderIds = [...new Set(rows.map((row) => row.entityId).filter((id): id is string => !!id))]
  let orders: Array<{ id: string; invoiceNumber: string | null; accountingInvoiceId: string | null }>
  try {
    orders = await db.salesOrder.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, invoiceNumber: true, accountingInvoiceId: true },
    })
  } catch (error) {
    console.error('[wc-held-release] could not read the orders behind the held sales invoices:', error)
    return result
  }
  const byId = new Map(orders.map((order) => [order.id, order]))

  const stuck: string[] = []
  for (const row of rows) {
    const order = row.entityId ? byId.get(row.entityId) : undefined
    if (!order) {
      // The order is gone (hard-deleted, or the row never named one). Nothing can ever release it.
      await db.shoppingSyncLog.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          errorMessage:
            'The sales order this invoice was held for cannot be found, so it can never be released. Nothing was posted.',
          syncedAt: new Date(),
        },
      }).catch(() => {})
      result.closed++
      continue
    }
    if (order.accountingInvoiceId) {
      // Already invoiced by another route. Releasing now would post a SECOND document under the
      // same number, which is the very hazard the ownership fence exists for.
      await db.shoppingSyncLog.update({
        where: { id: row.id },
        data: {
          status: 'SYNCED',
          errorMessage:
            `Superseded: this order already carries ledger document ${order.accountingInvoiceId}, so the held sales `
            + 'invoice was not released.',
          syncedAt: new Date(),
        },
      }).catch(() => {})
      result.closed++
      continue
    }
    const invoiceNumber = order.invoiceNumber?.trim() || null
    if (!invoiceNumber) {
      // The ordinary state: WooCommerce has not numbered it yet. Not a failure, nothing to do.
      result.stillWaiting++
      continue
    }
    if (result.released + result.stillStuck >= limit) break

    // The release re-selects the order's newest hold rather than taking this row's id. That is the
    // same row by construction — the importer REPLACES an order's hold instead of appending a second
    // one — and going through the one release path is what keeps the swept and the imported case
    // byte-for-byte identical, including the confirmation that the sync row really exists.
    const payload = isHeldSalesInvoicePayload(row.payload) ? row.payload : null
    const outcome = await releaseHeldWcSalesInvoice(
      order.id,
      {
        externalOrderId: payload?.externalOrderId ?? '',
        externalOrderNumber: payload?.externalOrderNumber ?? payload?.orderNumber ?? order.id,
      },
      invoiceNumber,
      { logFailure: false },
    )
    if (outcome === 'released') result.released++
    else if (outcome === 'unreadable') result.closed++
    else if (outcome === 'not-queued') {
      result.stillStuck++
      stuck.push(payload?.externalOrderNumber ?? order.id)
    }
  }

  if (stuck.length > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'sales_invoice_release_still_stuck',
      tag: 'accounting',
      level: 'WARNING',
      description:
        `${stuck.length} WooCommerce order(s) are numbered and still waiting for their held sales invoice to be `
        + `queued (${stuck.slice(0, 10).join(', ')}${stuck.length > 10 ? ', …' : ''}). The usual cause is that the `
        + 'accounting connector is disconnected, its sync is switched off, or Sales Invoices are set to off. The '
        + 'sweep retries them on every run; each order says why on its own queue row.',
      metadata: { connector: 'woocommerce', stuck: stuck.length },
      resolveUser: false,
    }).catch(() => {})
  }

  return result
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

export type ImportWcOrderResult = {
  success: boolean
  orderId?: string
  error?: string
  /**
   * Set when nothing was imported because the order is NEW and its status is outside the
   * operator's "Import order statuses" selection. `success` is true: this is a resolved
   * decision, not a failure to retry.
   */
  skipped?: 'status_not_admitted'
}

export async function importWcOrder(wcOrder: WcFullOrder, options: ImportWcOrderOptions = {}): Promise<ImportWcOrderResult> {
  try {
    // THE SINGLE PIVOT (o3d-tj6v r4). This one read answers both "create or update?" and "is this
    // order gated?", and the two answers cannot disagree because there is only one of them.
    //
    // Round 3 asked the same question a second time, in webhooks.ts, and refused on THAT answer.
    // Between the two reads sat a settings read, a withdrawal-status read and the whole of
    // `importWcOrderGuarded` — which itself does database work and can read the live store. Two
    // deliveries for an order IMS had never seen therefore both read "not held", and the one that
    // lost the race was refused and ACKed on an answer that was already false: by the time it
    // acted, IMS DID hold the order, and round 3's whole design rests on an order IMS holds never
    // being gated.
    //
    // With the decision taken here there is nothing between the read and the act — the gate below
    // is an in-memory branch on this row. And the case the read genuinely cannot see, two creates
    // in flight at once, is settled by the DATA: `@@unique([connector, externalOrderId])` on
    // shopping_order_links lets exactly one create win, and the loser's P2002 handler turns itself
    // into the UPDATE of an order IMS now holds — which is never gated.
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

    // IMS does not hold this order, so the selection decides whether it may take it on. Placed
    // immediately after the pivot read and before any mapping work, so an excluded order costs one
    // query rather than a full import's worth of lookups.
    if (options.admitCreate === false) {
      return { success: true, skipped: 'status_not_admitted' }
    }

    // Resolve IMS status from WC status. Read through `findWcStatusMapping` so a mapping saved as
    // `wc-processing` is not invisible to a store that reports `processing` — the admission
    // boundary already compares those as one status, and this default-to-PROCESSING fallback is
    // exactly where that disagreement used to be silent (o3d-tj6v r4).
    const statusMapping = await findWcStatusMapping(wcOrder.status)
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
      // o3d-cyn r2: the SHIPPING line's own rate ids. They normally also appear in `tax_lines`, but
      // the shipping tax type is now resolved from them directly, and a rate this map does not hold
      // cannot be resolved at all.
      ...wcOrder.shipping_lines.flatMap((line) => (line.taxes ?? []).map((tax) => tax.id))
        .filter((x): x is number => typeof x === 'number'),
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
      lines: mappedLines.map((l) => ({
        qty: l.qty,
        unitPriceForeign: l.unitPriceForeign,
        discountAmount: l.discountAmount,
        taxForeign: l.taxForeign,
      })),
      shippingTaxForeign: wcOrder.shipping_lines.map((line) => line.total_tax),
      orderTotal: wcOrder.total,
    })

    // o3d-cyn r2: shipping need not carry the goods' rate, and a document that will not produce
    // Woo's own tax must not be claimed as settled by a payment for the order total.
    // The ORDER's currency, not the base one: every figure compared below is in it (o3d-cyn r4).
    const orderMoneyDigits = currencyMinorUnits(wcOrder.currency)
    const shippingTax = resolveWcShippingTaxRate({
      shippingLines: wcOrder.shipping_lines,
      shippingNetForeign: shippingForeign,
      rateById: wcResolvedById,
      orderDefault: { accountingTaxType, taxRateValue },
      currency: wcOrder.currency,
    })
    const documentTaxReconciliation = reconcileWcDocumentTax([
      ...mappedLines.map((l, idx) => ({
        label: l.sku || l.description || `line ${idx + 1}`,
        netForeign: toDecimal(l.qty).mul(toDecimal(l.unitPriceForeign)).sub(toDecimal(l.discountAmount)),
        // A reverse-charge sales line carries NO tax on the invoice — the notional VAT nets to zero,
        // which is why Woo reports none on it either. Modelling it at the mapped rate would invent a
        // disagreement on every RC order.
        rateValue: lineTaxResolved[idx]?.reverseCharge ? 0 : (lineTaxResolved[idx]?.taxRateValue ?? 0),
        reportedTaxForeign: l.taxForeign,
      })),
      {
        label: 'Shipping',
        netForeign: shippingForeign,
        rateValue: shippingTax.rateValue,
        reportedTaxForeign: wcOrder.shipping_lines.reduce<Decimal>(
          (sum, line) => addMoney(sum, toDecimal(line.total_tax ?? 0)),
          toDecimal(0),
        ),
      },
    ], wcOrder.currency)
    const documentTotalsToTheOrder = shippingTax.resolved && documentTaxReconciliation.reconciles

    // GBP conversions
    const subtotalBase = divideRoundedNumber(subtotalForeign, fxRate, 4)
    const shippingBase = divideRoundedNumber(shippingForeign, fxRate, 4)
    const taxBase = divideRoundedNumber(taxForeign, fxRate, 4)
    const totalBase = divideRoundedNumber(totalForeign, fxRate, 4)

    // Line data for Prisma.
    //
    // o3d-cyn: the line amount is NET on both WC price conventions — `unitPriceForeign` is
    // `line_items[].subtotal / quantity` and `discountAmount` is `subtotal - total`, both of which
    // WC REST reports ex-tax whatever `prices_include_tax` says (the tax is in `total_tax`, carried
    // separately as `taxForeign`). Dividing by (1 + rate) for an inclusive store netted an already-net
    // amount: a net-100 line at 20% was stored as 83.33 and the order's own lines no longer summed to
    // its subtotal.
    const lineData = mappedLines.map((l, idx) => {
      const resolved = lineTaxResolved[idx]
      const netForeign = toDecimal(l.qty).mul(l.unitPriceForeign).sub(l.discountAmount)
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
      // The constraint arbitrating a concurrent create (o3d-tj6v r4). Losing this race means IMS
      // DOES hold the order, so this payload becomes an UPDATE — and an update is never gated,
      // whatever `admitCreate` said, because the selection decides what IMS takes on and not what
      // it may keep hearing about.
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
      // o3d-cyn: EVERY component of this document is tax-EXCLUSIVE, on both WC price conventions,
      // and it is sent that way — see `resolveWcAccountingAmountConvention`.
      const { lineAmountsIncludeTax, shippingAmount, discountAmount: orderLevelDiscountAmount } =
        resolveWcAccountingAmountConvention({ pricesIncludeVat, shippingForeign, orderLevelDiscountForeign })
      // o3d-cyn r2/r3: say it out loud when the document will not total to the order, and STAMP the
      // document so it cannot post.
      //
      // ROUND 2 withheld the PAYMENT and let the invoice post anyway, on the reasoning that omitting
      // shipping would understate it. That trades a recoverable fault for an unrecoverable one: a
      // payment can be registered later, while an AUTHORISED receivable at the wrong total is already
      // on the VAT return and takes a credit note to undo. Round 3 withholds the DOCUMENT instead —
      // see `refuseUnreconciledDocument`, which refuses it at the poster before anything is sent.
      //
      // NO LONGER GATED ON THE ORDER BEING PAID. An unpaid order's document is just as wrong, it
      // posts just as immediately, and it is paid later — at which point the fault is already in the
      // ledger and nothing was ever logged about it.
      const unreconciledReason = !documentTotalsToTheOrder
        ? `The tax the accounting document would produce does not match the tax WooCommerce charged on order `
          + `${wcOrder.number}, so the invoice would not total the order's ${wcOrder.total}. `
          + (shippingTax.resolved ? '' : `${shippingTax.reason} `)
          + documentTaxReconciliation.disagreements
            // Figures at the ORDER currency's own precision (o3d-cyn r4): `toFixed(2)` printed a
            // whole-yen tax as "101.00" and a three-decimal one as "5.00", hiding the fils the
            // disagreement is actually in.
            .map((d) => `${d.label}: document ${d.modelledTax.toFixed(orderMoneyDigits)} vs WooCommerce ${d.reportedTax.toFixed(orderMoneyDigits)}`)
            .join('; ')
        : null
      if (unreconciledReason) {
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: so.id,
          action: 'wc_invoice_tax_does_not_reconcile',
          tag: 'accounting',
          level: 'ERROR',
          description:
            `${unreconciledReason} The invoice was NOT posted to the ledger and no payment was registered — `
            + `posting it would put a receivable at a total nobody reconciles against. Map the shipping tax rate `
            + `in IMS and re-import the order.`,
          metadata: {
            connector: 'woocommerce',
            externalOrderId: String(wcOrder.id),
            externalOrderNumber: wcOrder.number,
            orderTotal: wcOrder.total,
            orderPaid: !!wcOrder.date_paid_gmt,
            documentPosted: false,
            shippingTaxResolved: shippingTax.resolved,
            shippingTaxType: shippingTax.taxType,
            shippingTaxRate: shippingTax.rateValue,
            shippingContributingRateCount: shippingTax.contributingRateCount,
            disagreements: documentTaxReconciliation.disagreements,
          },
        })
      }
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
          shippingAmount,
          shippingDescription: 'Shipping',
          shippingAccountCode: settings.shippingAccount || undefined,
          // audit-H1b: shipping & discount stay off the REVERSE-CHARGE swap (NOT swapped), matching
          // the native invoice push + credit-note builder (the H1 rule — only goods lines carry the
          // reverse charge).
          //
          // o3d-cyn r2: but the RATE is shipping's own, not the goods'. `resolveWcShippingTaxRate`
          // picks the tax type that reproduces the tax Woo actually charged on shipping, falling back
          // to the order default when that is the one that does — so a single-rate order is unchanged
          // and a zero-rated-postage order stops being taxed at the goods' rate.
          shippingTaxType: shippingTax.taxType ?? accountingTaxType ?? undefined,
          // Only the residual — the coupon itself is already on the lines above as a per-line
          // discountAmount, which the connector sends as a Xero DiscountRate / QuickBooks
          // discount line. Sending both deducted it twice (o3d-y14).
          discountAmount: orderLevelDiscountAmount,
          discountAccountCode: settings.discountAccount || undefined,
          discountTaxType: accountingTaxType ?? undefined,
          lineAmountsIncludeTax,
          _postingMode: 'submitted',
          _paymentMethod: wcOrder.payment_method || undefined,
          _paymentDate: wcOrder.date_paid_gmt || undefined,
          // NOT `!!wcOrder.date_paid_gmt` alone (o3d-cyn r2): registering the net fallback against a
          // document that will not total to the order is the same wrong settlement one figure down.
          // Carried onto the HELD payload too (development's invoice-number branch below): a document
          // that does not total to the order must not register a payment whether it is queued now or
          // released later.
          _registerPayment: !!wcOrder.date_paid_gmt && documentTotalsToTheOrder,
          _paymentAmount: resolveWcInvoicePaymentAmount(wcOrder, { totalsToTheOrder: documentTotalsToTheOrder }),
          // o3d-cyn r3: the stamp that stops this document at the poster. Present ONLY when the
          // document will not total to the order — an ordinary order's payload is byte-for-byte what
          // it was. The row is still queued deliberately: a refusal that leaves a FAILED sync row
          // naming the reason is something an operator can find, where queueing nothing leaves an
          // order that simply never reaches the ledger and no record of why.
          //
          // It sits INSIDE `accountingPayload`, so it reaches the HELD path below as well as the
          // queued one (development's invoice-number branch): a document that will not total to the
          // order must carry its reason whether it is queued now or released later.
          ...(unreconciledReason
            ? { [UNRECONCILED_TAX_PAYLOAD_KEY]: buildUnreconciledTaxMarker(unreconciledReason) }
            : {}),
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

/**
 * `resolveWcPullStatuses` with the settings read for you — the single entry
 * point every pull route uses, so the initial import and the sweeps cannot
 * drift apart again (see lib/connectors/woocommerce/order-status-filter.ts).
 *
 * Returns `[]` when the operator has selected no statuses. Callers must treat
 * that as "import nothing": passing an empty list to WooCommerce as `status=`
 * asks for EVERY status.
 */
export async function getWcPullStatuses(route: WcOrderPullRoute): Promise<string[]> {
  const { getWithdrawalStatuses } = await import('./withdrawal')
  const [setting, withdrawal] = await Promise.all([
    db.setting.findUnique({ where: { key: WC_SYNC_ORDER_STATUSES_SETTING_KEY } }),
    getWithdrawalStatuses(),
  ])
  return resolveWcPullStatuses(route, parseWcSyncOrderStatuses(setting?.value), withdrawal)
}

/**
 * WHERE THE PULL CURSORS LIVE, and what makes one valid (o3d-tj6v r4).
 *
 * `last_wc_order_sync_at` / `last_wc_order_reconcile_at` become `?modified_after=` on the next
 * sweep, so an order older than the cursor is simply never fetched again. That is fine while the
 * order was never wanted — and it was the hole under round 3's acknowledged admission refusals.
 *
 * A refusal correctly does not advance the cursor, but the cursor is advanced by everything ELSE:
 * the very next admitted delivery calls `advanceWcOrderSyncCursor()` and stamps it at `now`. The
 * refused order's `date_modified` is now BEHIND the cursor. While its status stays excluded that
 * is exactly right. The moment the operator TICKS that status, though, nothing brings it back:
 * WooCommerce fires no webhook for a setting IMS changed, and the sweep will not reach back past
 * its cursor. The order the operator has just asked for is invisible for good.
 *
 * Two settings close that, and both are facts rather than checks:
 *
 *   `<cursorKey>_statuses`             the resolved status list the cursor was last advanced
 *                                      under. Compared against the current one, it says whether
 *                                      the selection has WIDENED — i.e. whether anything that was
 *                                      previously refused could now be wanted.
 *   `wc_order_admission_refused_since` the earliest modification time of anything the admission
 *                                      boundary has ever turned away. It says how far back a
 *                                      widening has to reach, so a widening costs one bounded
 *                                      re-fetch instead of the whole order history.
 *
 * Both are needed. The fingerprint alone would re-fetch on every widening even when nothing was
 * ever refused; the watermark alone would re-fetch on every run for as long as any status stays
 * excluded.
 */
export const WC_ORDER_ADMISSION_REFUSED_SINCE_KEY = 'wc_order_admission_refused_since'

function wcCursorStatusesKey(cursorKey: string): string {
  return `${cursorKey}_statuses`
}

function parseStoredStatusList(raw: string | null | undefined): string[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) return null
    return parsed as string[]
  } catch {
    return null
  }
}

/**
 * Record that the admission boundary turned an order away, at the order's own modification time.
 *
 * MONOTONIC MINIMUM, and never cleared. A refusal that has been swept past under a wider selection
 * is not proof that no OTHER excluded status still has orders behind it — those orders will not be
 * refused a second time, because nothing redelivers them. Keeping the oldest refusal we have ever
 * seen means the next widening reaches back far enough for them too, and it is still bounded by the
 * first refusal rather than by the store's whole history.
 *
 * Never throws: this is recovery bookkeeping attached to an acknowledged skip, and turning that
 * skip into a retried failure would be a worse outcome than a missed watermark.
 */
export async function noteWcOrderAdmissionRefusal(modifiedAtIso: string | null | undefined): Promise<void> {
  try {
    const parsed = modifiedAtIso ? Date.parse(`${modifiedAtIso}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(modifiedAtIso) ? '' : 'Z'}`) : NaN
    // An unreadable or absent timestamp falls back to NOW, which is the newest the refusal can
    // possibly be — never to "the beginning of time", which would make one malformed payload
    // rewind the whole store on the next widening.
    const refusedAt = new Date(Number.isFinite(parsed) ? parsed : Date.now())
    const existing = await db.setting.findUnique({ where: { key: WC_ORDER_ADMISSION_REFUSED_SINCE_KEY } })
    const existingMs = existing?.value ? Date.parse(existing.value) : NaN
    if (Number.isFinite(existingMs) && existingMs <= refusedAt.getTime()) return
    await db.setting.upsert({
      where: { key: WC_ORDER_ADMISSION_REFUSED_SINCE_KEY },
      create: { key: WC_ORDER_ADMISSION_REFUSED_SINCE_KEY, value: refusedAt.toISOString() },
      update: { value: refusedAt.toISOString() },
    })
  } catch (e) {
    console.error('o3d-tj6v r4: failed to record an admission-refusal watermark', e)
  }
}

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

  // Read settings. The status list — the operator's `wc_sync_order_statuses`
  // selection, plus `completed` on the reconcile sweeps and the withdrawal
  // statuses in every live mode — is resolved by the shared filter module so
  // the initial import cannot drift away from it (see order-status-filter.ts).
  const { getWithdrawalStatuses } = await import('./withdrawal')
  const cursorStatusesKey = wcCursorStatusesKey(cursorKey)
  const [lastSyncSetting, cursorStatusesSetting, refusedSinceSetting, existingOrder, statuses, wdraw] = await Promise.all([
    db.setting.findUnique({ where: { key: cursorKey } }),
    db.setting.findUnique({ where: { key: cursorStatusesKey } }),
    db.setting.findUnique({ where: { key: WC_ORDER_ADMISSION_REFUSED_SINCE_KEY } }),
    db.salesOrder.findFirst({ select: { id: true } }),
    getWcPullStatuses(mode),
    getWithdrawalStatuses(),
  ])

  // No statuses selected is a real instruction, not an unset setting: fetch
  // nothing. Passing an empty list through to `status=` would ask WooCommerce
  // for EVERY status, which is the opposite of what was configured.
  if (statuses.length === 0) {
    return { synced: 0, skipped: 0, errors: [WC_NO_STATUSES_SELECTED_MESSAGE] }
  }

  // After a transaction reset or on a fresh install, there is nothing local to
  // reconcile against. Ignore any stale cursor and force a full import.
  let lastSync = existingOrder ? (lastSyncSetting?.value || null) : null

  // A WIDENED selection re-opens the window (o3d-tj6v r4). Anything the admission boundary turned
  // away is behind this cursor — a refusal does not advance it, but the next admitted delivery
  // does — and WooCommerce fires nothing when IMS's own setting changes. So when a status that was
  // not in the list the cursor was earned under is in it now, rewind to the earliest refusal we
  // have ever recorded. Bounded by that watermark rather than reaching back to the whole history,
  // and taken only on the run after the selection actually changed.
  const cursorStatuses = parseStoredStatusList(cursorStatusesSetting?.value)
  const widened = cursorStatuses !== null && statuses.some((status) => !cursorStatuses.includes(status))
  const refusedSinceMs = refusedSinceSetting?.value ? Date.parse(refusedSinceSetting.value) : NaN
  if (lastSync && widened && Number.isFinite(refusedSinceMs) && refusedSinceMs < Date.parse(lastSync)) {
    lastSync = refusedSinceSetting!.value
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_order_sync_cursor_rewound',
      tag: 'sync',
      level: 'INFO',
      description: `The "Import order statuses" selection widened to ${statuses.join(', ')}, so the ${mode} sweep `
        + `re-reads WooCommerce from ${lastSync} — the earliest order the previous selection turned away. `
        + 'Orders that were skipped while their status was unselected are imported by this run.',
      metadata: { mode, cursorKey, previousStatuses: cursorStatuses, statuses, rewoundTo: lastSync },
      resolveUser: false,
    })
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
      // Normalised on both sides (o3d-tj6v r4). `getWithdrawalStatuses` already returns normalised
      // slugs, so a store reporting `wc-withdrawn` compared raw would miss the backstop that stops
      // a withdrawn order carrying on to the warehouse.
      const isWithdrawal = isWcStatus(order.status, wdraw.submitted) || isWcStatus(order.status, wdraw.approved)

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
    const now = new Date().toISOString()
    const fingerprint = JSON.stringify([...statuses].sort())
    await db.$transaction([
      db.setting.upsert({
        where: { key: cursorKey },
        create: { key: cursorKey, value: now },
        update: { value: now },
      }),
      // Written WITH the cursor, in one transaction: a cursor and the selection it was earned
      // under are one fact, and a cursor advanced without its fingerprint would make the next
      // widening undetectable.
      db.setting.upsert({
        where: { key: cursorStatusesKey },
        create: { key: cursorStatusesKey, value: fingerprint },
        update: { value: fingerprint },
      }),
    ])
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
