/**
 * WooCommerce → IMS refund sync.
 */

import { withLedgerCheck } from '@/lib/domain/accounting/hand-post-instruction'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { resolveBaseCurrencyCode } from '@/lib/base-currency'
import { isMissingStoredFxRateError, resolveStoredFxRateToBase } from '@/lib/currencies/stored-document-rate'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { isExternalRefundIdUniqueConflict } from '@/lib/domain/sales/refund-idempotency'
import { REFUND_TOTAL_EPSILON } from '@/lib/domain/sales/o2c-guards'
import { REFUND_PARK_MANUAL_RESOLUTION_HINT } from '@/lib/domain/sales/refund-manual-resolution'
import { FULL_REFUND_RATIO } from '@/lib/domain/sales/refund-thresholds'
import { findOpenShopRefunds, shopRefundParkMessage } from '@/lib/domain/sales/shop-refund-tasks'
import { activeRefundParkWhere, WC_REFUND_PARK_RECORD_KIND } from '@/lib/domain/sales/refund-park-recovery'
// o3d-w00 (Codex r7 #3): shared with the exception inbox's hand-recording path — see refund-line-link.
import { easRefundRefusal, refundStatedTax, refundTaxOnEasRate } from '@/lib/domain/accounting/eu-vat-credit-note'
import { matchRefundedFeeLines, refundedOrderLineId } from './refund-line-link'
export { refundedOrderLineId }
import type { WcMeta, WcRefund } from './types'
import { decideAmountGap, earlierFeeOwedMinor, PARITY_NO_MANUAL_RECORD, feeRepaymentHold, isRefundCnParityEnabled, parityRefundBreakdown, SETTLED_OUTSIDE_IMS_NOTE_PREFIX, storeCreditAttemptOf, storeCreditUndatedVerdict, storeCreditVerdict, vatOnlyRefundHold, WCLC_FEE_MARKER_META, type EarlierRefundFacts, type ParityRefundItem, type ParityShippingLine, type RefundParityFactsInput, type StoreCreditCoupon } from '@/lib/domain/sales/refund-cn-parity'
import type { createRefund as createRefundAction } from '@/app/actions/sales'

type CreateRefundAction = typeof createRefundAction

/**
 * Map the store's free-text refund reason onto a configured return reason: an ACTIVE reason whose name equals the text, ignoring case and surrounding
 * whitespace. No match (or no text, or no reason table available to the caller) is null, never a guess and never a new reason. If two active reasons
 * differ only by case (the Settings screen refuses that, but a direct write could) the first in the configured order wins.
 */
export async function resolveReturnReasonId(
  client: Partial<Pick<typeof db, 'returnReason'>>,
  text: string | null | undefined,
): Promise<string | null> {
  const name = text?.trim()
  if (!name || !client.returnReason) return null
  const match = await client.returnReason.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true },
  })
  return match?.id ?? null
}

export type WcRefundSyncDependencies = {
  // o3d-w00 (Codex r7 #5): the identity an ITEMISED refund line will be re-grossed under is priced by
  // the WRITER now, inside the refund transaction, so this sync reads no tax rates of its own — it
  // states the VAT WooCommerce reported per refunded line and lets the fence there act on it.
  // `organisation` is read only when the order's stored FX rate is unusable (to tell a base-currency order, rate 1,
  // from a foreign one that must be refused): a refund on an order with a usable rate never touches it.
  db?: Pick<typeof db, 'salesOrder' | 'salesOrderRefund' | 'warehouse' | 'shoppingSyncLog' | 'wmsOperatorTask' | '$transaction'> & Partial<Pick<typeof db, 'organisation' | 'returnReason'>>
  createRefund?: CreateRefundAction
  logActivity?: typeof logActivity
  /** o3d-k26m.17: whether `wc_refund_credit_note_parity_enabled` is on. Default: the setting, read from `db` (a `db` double without a `setting` delegate reads OFF). */
  parityEnabled?: () => Promise<boolean>
  /** o3d-k26m.17: the WooCommerce order (its meta and shipping lines), read only under the parity switch, for a store-credit refund or an amount gap. Null: it could not be read. */
  fetchWcOrder?: (externalOrderId: number) => Promise<ParityWcOrder | null>
  /** o3d-k26m.17: the store's coupons that may carry this store-credit attempt (read-only): those CREATED after `createdAfter` (o3d-pnc8p L3). Null: they could not be read. */
  fetchStoreCreditCoupons?: (input: { attempt: string; createdAfter: string }) => Promise<StoreCreditCoupon[] | null>
  /** o3d-k26m.17: every refund WooCommerce holds for the order, when the caller has already read them all (the sweep). Absent: read when the fee-repayment check needs them. */
  orderRefunds?: readonly WcRefund[]
  /** o3d-k26m.17: read the order's refunds from WooCommerce (read-only). Null: the list could not be read completely. */
  fetchOrderRefunds?: (externalOrderId: number) => Promise<WcRefund[] | null>
  /** Whether the Sales Invoices switch is on for the Xero chart (asked only for a rate-182 refund on a scheme-stamped order). Default: the accounting settings. */
  salesInvoicesSwitchOn?: () => Promise<boolean>
  /** The clock (o3d-k26m.17: the store-credit wait limit). */
  now?: () => Date
}

/** o3d-k26m.17: the parts of a WooCommerce order the parity checks read. o3d-pnc8p MED-5: its fee lines' meta, for the `_wclc_fee` marker on the ORIGINAL item (absent: not read). */
export type ParityWcOrder = { meta_data: WcMeta[]; shipping_lines: Array<{ id: number; total: string; total_tax: string }>; fee_lines?: Array<{ id: number; meta_data?: WcMeta[] }> }

/** o3d-k26m.17: the parity switch, read from the client the sync was given. A test double with no `setting` delegate reads OFF, so it never reaches a real database. */
async function readParitySwitch(dependencies: WcRefundSyncDependencies): Promise<boolean> {
  if (dependencies.parityEnabled) return dependencies.parityEnabled()
  const settingClient = dependencies.db ? (dependencies.db as { setting?: Parameters<typeof isRefundCnParityEnabled>[0]['setting'] }).setting : db.setting
  if (!settingClient) return false
  return isRefundCnParityEnabled({ setting: settingClient })
}

/** o3d-k26m.17: the WooCommerce order's own meta (the store-credit plugin's unfinished-attempt record lives there) and shipping lines, or null when it cannot be read. Read-only. */
async function fetchParityWcOrder(externalOrderId: number): Promise<ParityWcOrder | null> {
  const { data, error } = await wcFetch(`/orders/${externalOrderId}`)
  if (error || data === null || typeof data !== 'object') return null
  const meta = (data as { meta_data?: unknown }).meta_data
  const shipping = (data as { shipping_lines?: unknown }).shipping_lines
  const fees = (data as { fee_lines?: unknown }).fee_lines
  if (!Array.isArray(meta) || !Array.isArray(shipping)) return null
  return { meta_data: meta as WcMeta[], shipping_lines: shipping as ParityWcOrder['shipping_lines'], fee_lines: Array.isArray(fees) ? fees as NonNullable<ParityWcOrder['fee_lines']> : [] }
}

/** How many pages of coupons the store-credit check reads at most (100 asked for each, oldest first). Past that the credit is unconfirmed, never assumed. */
export const STORE_CREDIT_COUPON_PAGES = 5

/**
 * o3d-k26m.17: the coupons CREATED since shortly before the refund, in every status (read-only, REST v3 /coupons), OLDEST FIRST by id. The plugin creates the
 * coupon carrying its attempt id when it issues the credit, so the coupon of a refund is among the first ones created after it, however many coupons were MODIFIED
 * since (o3d-pnc8p L3: walking by modification, newest first, lost it behind 500 later edits on a catch-up). Null: a page could not be read, or there were more than
 * the cap.
 *
 * The walk ends on an EMPTY page, or once the store's own X-WP-Total is reached, never on a short page (o3d-pnc8p L2: a store that caps per_page below 100 returns
 * short pages that are not the last).
 */
export async function fetchStoreCreditCouponsFromWc(
  input: { attempt: string; createdAfter: string },
  readPage: typeof wcFetch = wcFetch,
): Promise<StoreCreditCoupon[] | null> {
  const out: StoreCreditCoupon[] = []
  for (let page = 1; page <= STORE_CREDIT_COUPON_PAGES; page++) {
    const { data, error, totalItems, totalItemsPresent } = await readPage('/coupons', { status: 'any', after: input.createdAfter, per_page: '100', page: String(page), orderby: 'id', order: 'asc' })
    if (error || !Array.isArray(data)) return null
    if (data.length === 0) return out
    out.push(...(data as StoreCreditCoupon[]))
    if (totalItemsPresent === true && out.length >= totalItems) return out
  }
  return null
}

/** o3d-k26m.17: every refund on the order from WooCommerce, or null when the walk was short. */
export async function fetchOrderRefundsFromWc(externalOrderId: number): Promise<WcRefund[] | null> {
  const { refunds, error } = await fetchAllWcRefundsForOrder(externalOrderId)
  return error === undefined ? refunds : null
}

/**
 * o3d-6oyu.18: recorded on the shoppingSyncLog row when a WooCommerce refund is
 * suppressed because the payment poller had already charged the whole order back.
 * Doubles as the dedup key — `order.updated` re-runs syncRefundsForOrder, and without
 * it every subsequent order update would re-log the same warning forever.
 */
export const WC_REFUND_SUPPRESSED_BY_CHARGEBACK =
  'WooCommerce refund suppressed: the order was already charged back by the payment poller — no duplicate credit note raised'

function roundDecimalNumber(value: DecimalInput, precision: number): number {
  return roundQuantity(value, precision).toNumber()
}

function divideRoundedNumber(value: DecimalInput, divisor: DecimalInput, precision: number): number {
  return roundDecimalNumber(toDecimal(value).div(toDecimal(divisor)), precision)
}

function parseDecimalAbs(value: string | number | null | undefined) {
  const decimal = toDecimal(value ?? 0)
  return decimal.lt(0) ? decimal.neg() : decimal
}

function undeterminableBasisMessage(cause: string): string {
  return (
    `This refund is monetary-only (not itemised) and ${cause}, so the refunded amount cannot be converted ` +
    'from gross to net and no credit note has been raised. The money has ALREADY been returned in ' +
    'WooCommerce — do NOT issue another WooCommerce refund. ' +
    REFUND_PARK_MANUAL_RESOLUTION_HINT
  )
}

/**
 * o3d-w00: the basis on which a MONETARY-ONLY WooCommerce refund is converted from the gross amount
 * the customer received to the NET amount IMS stores.
 *
 * Every refund row is stamped `totalsBasis: 'NET'` by the writer and the cumulative refund ceiling +
 * FULL/PARTIAL classification compare against the order's NET total (totalBase − taxBase). So a
 * monetary-only line MUST be genuinely net: storing a gross figure under a NET marker is precisely the
 * net-vs-gross mix that leaves a fully-refunded taxable order stuck at PARTIALLY_REFUNDED (the gross sum
 * never equals the net total, and the next refund trips the ceiling instead of completing the refund).
 *
 * The conversion basis is only knowable when the rate the credit note will RE-GROSS at is known, and
 * that rate has to be the one this order was actually taxed at. So rather than trusting the header
 * field blindly, it is CHECKED against the order's own tax: netTotal × rate must reproduce taxBase.
 * When it cannot be established, fail CLOSED (park for manual resolution) — recording an unconvertible
 * amount as if it were net silently over-credits Xero and corrupts the refund status.
 */
export type MonetaryRefundBasis =
  | { ok: true; vatRate: Decimal }
  | { ok: false; error: string }

/**
 * The order shape the basis is resolved from. `lines` and `shippingBase` are what make the tolerance
 * (below) a measured quantity rather than a guess, and what let "zero-rated" be read off the order's
 * own tax lines instead of inferred from the size of a number.
 */
export type MonetaryRefundBasisOrder = {
  totalBase: DecimalInput
  taxBase?: DecimalInput
  taxRatePercent?: DecimalInput
  shippingBase?: DecimalInput
  /**
   * Codex r3 #3: the order's own-currency VAT and shipping figures. The shipping leg's VAT is DERIVED
   * (order tax − line tax), and that identity is exact only in the currency the order was taxed in — see
   * the shipping check below. Optional so the base-currency fallback still works for an order shape that
   * predates them, but the production caller supplies them.
   */
  taxForeign?: DecimalInput
  shippingForeign?: DecimalInput
  lines?: readonly {
    // Codex r2 #1: the line's NET total, so its recorded VAT can be checked against its OWN net at the
    // order's rate. Without it a line's stored rate is an unverified claim.
    totalBase?: DecimalInput
    taxBase?: DecimalInput
    /** The line's VAT in the ORDER's currency, as WooCommerce reported it (Codex r3 #3). */
    taxForeign?: DecimalInput
    taxRate?: { rate?: DecimalInput; reverseCharge?: boolean | null } | null
  }[]
}

/** The scale SalesOrder.taxBase / SalesOrderLine.taxBase are stored at (Decimal(18,4)). */
const TAX_BASE_SCALE = 4

/**
 * Half the currency minor unit. WooCommerce rounds EVERY taxable component's VAT to the penny
 * independently (`total_tax` per line, per shipping line, per fee), so each component contributes at
 * most this much to the gap between the order's recorded VAT and netTotal × rate. This — not a round
 * number, and not a percentage of the order — is what legitimate rounding actually looks like.
 */
const MONEY_ROUNDING_HALF_UNIT = 0.005
/**
 * Half the last stored digit of a Decimal(18,4) base-currency figure: what ONE independent
 * foreign→base conversion can be off by (order-import converts at `/fxRate` then rounds to 4dp).
 */
const BASE_CONVERSION_HALF_UNIT = 0.00005
/** Two Decimal(18,4) conversions (totalBase and taxBase) sit underneath netOrderBase. */
const BASE_CONVERSION_SLACK = 0.0002
/**
 * What ONE component's VAT figure may legitimately be off by: its own half-penny of WooCommerce
 * rounding plus the two Decimal(18,4) conversions underneath it. Used to check each line — and the
 * shipping leg — against its own net at the order's rate (Codex r2 #1).
 */
const COMPONENT_ROUNDING_TOLERANCE = MONEY_ROUNDING_HALF_UNIT + BASE_CONVERSION_SLACK
/**
 * SalesOrder.taxRatePercent and TaxRate.rate are both Decimal(5,4), so two rates that differ by less
 * than half of the last stored digit are the same rate.
 */
const RATE_EPSILON = 0.00005

function minDecimal(first: Decimal, ...rest: Decimal[]): Decimal {
  return rest.reduce((smallest, value) => (value.lt(smallest) ? value : smallest), first)
}

/**
 * How many independently-rounded VAT figures the order's tax is the sum of: one per order line (WC fee
 * lines are imported as order lines too) plus one for shipping when it was charged. Defaults to 1 — the
 * TIGHTEST tolerance — when the caller does not supply lines, so an unknown order can never buy slack.
 */
function countTaxableComponents(order: MonetaryRefundBasisOrder): number {
  const lineCount = order.lines?.length ?? 0
  const shippingCount = toDecimal(order.shippingBase ?? 0).abs().gt(0) ? 1 : 0
  return Math.max(1, lineCount + shippingCount)
}

export function resolveMonetaryRefundVatRate(order: MonetaryRefundBasisOrder): MonetaryRefundBasis {
  const taxBase = toDecimal(order.taxBase ?? 0)
  const netOrderBase = toDecimal(order.totalBase).sub(taxBase)
  const rate = order.taxRatePercent == null ? null : toDecimal(order.taxRatePercent)
  const lines = order.lines ?? []
  const shippingBase = toDecimal(order.shippingBase ?? 0)

  // ---------------------------------------------------------------------------------------------
  // Zero-rated. Codex r1 #1: this used to be `abs(taxBase) <= 0.02` — an absolute epsilon on a MONEY
  // value, which swallowed genuinely taxable orders whose VAT happens to be small (£0.10 net + £0.02
  // VAT was "zero-rated", so its £0.12 gross refund was stored gross under totalsBasis='NET' — the
  // very bug this function exists to stop). Zero-rating is a property of the RATE, not of the
  // magnitude of the tax figure, so it is read off signals that SAY so and must all agree:
  //   - the order's recorded VAT is exactly zero at the scale it is stored at (not "small"), AND
  //   - every order line agrees: no VAT recorded on it, and its own rate is zero or reverse-charged
  //     (an explicit flag: under RC the seller charges no VAT, so gross IS net regardless of the
  //     rate's face value), AND
  //   - there IS a line saying so, or the header rate itself says no tax. An order with no lines
  //     satisfies "every line agrees" vacuously, and a vacuous truth must never establish a basis.
  //
  // Codex r2 #4: this used to ALSO require the header rate to say no tax *unless* EVERY line was
  // reverse-charged, which falsely refused a partially reverse-charged order — one RC line at a 20%
  // face rate plus one genuinely zero-rated line records zero VAT everywhere and every line explicitly
  // says why, yet the all-or-nothing RC test rejected it and the order was then measured against a 20%
  // header it never charged. Per-line evidence is the whole point; whether the OTHER lines happen to be
  // RC or zero-rated does not change that this order charged no VAT, so gross IS net.
  //
  // Shipping needs no separate signal here: the order's VAT is the sum of the line VAT and the shipping
  // VAT, so zero recorded order VAT with zero line VAT means the shipping leg carried none either.
  //
  // Anything else — including one penny of real VAT — falls through to the rate checks below, and is
  // REFUSED if the order does not demonstrably carry that rate. Refusing is the fail-closed answer the
  // whole fix is built on.
  // ---------------------------------------------------------------------------------------------
  const recordedTaxIsZero = roundQuantity(taxBase, TAX_BASE_SCALE).isZero()
  const linesSayNoTax = lines.every((line) =>
    roundQuantity(toDecimal(line.taxBase ?? 0), TAX_BASE_SCALE).isZero() &&
    (toDecimal(line.taxRate?.rate ?? 0).lte(0) || line.taxRate?.reverseCharge === true))
  const headerSaysNoTax = rate == null || !rate.isFinite() || rate.lte(0)
  if (recordedTaxIsZero && linesSayNoTax && (headerSaysNoTax || lines.length > 0)) {
    return { ok: true, vatRate: toDecimal(0) }
  }

  // NOTE: SalesOrder.taxRatePercent is Decimal(5,4) holding a FRACTION (0.2000 = 20%), not a
  // percentage — it is consumed as `1 + rate` everywhere else (sales-currency, order-import) and only
  // multiplied by 100 for DISPLAY. Treating it as a percentage here divided the rate by a further 100,
  // making the "net" figure 12.00/1.002 instead of 12.00/1.20 — i.e. still gross.
  if (rate == null || !rate.isFinite() || rate.lte(0)) {
    return {
      ok: false,
      error: undeterminableBasisMessage(
        'the order carries VAT but has no recorded tax rate',
      ),
    }
  }
  if (netOrderBase.lte(0)) {
    return {
      ok: false,
      error: undeterminableBasisMessage('the order has a non-positive net total'),
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Codex r2 #1: SHIPPING is a taxed component like any other, and on this order shape it is the one
  // that can carry ALL of the VAT — so the rate may not be inferred from the line tax alone.
  //
  // `taxRatePercent` is the order's DEFAULT rate: order-import picks the "standard"-named (or highest)
  // rate among the order's WooCommerce tax lines, which on a zero-rated-goods order with standard-rated
  // postage is 20% even though every goods line is 0%. The aggregate reconciliation below cannot tell
  // that apart from a genuinely 20% order: £0.05 of zero-rated goods + £10 shipping + £2 shipping VAT
  // gives netOrderBase £10.05, implied VAT £2.01 against £2.00 recorded — a £0.01 gap that fits the
  // two-component tolerance. The refund would then be divided by 1.20 while the credit note re-grosses
  // the unlinked SALE line under the GOODS lines' identity (0%), so £12.05 returned to the customer
  // books as ~£10.04 of credit. Money out, silently, on an order that "reconciled".
  //
  // So numeric proximity may no longer establish uniformity. The rate has to be corroborated by what
  // the order SAYS it was taxed at, component by component:
  //   1. every order line (WC fee lines are imported as order lines too) carries an EXPLICIT rate equal
  //      to the header rate and is not reverse-charged. This is also the rate the credit note will
  //      re-gross the unlinked line at, so the conversion and the posting agree by construction;
  //   2. each line's own recorded VAT matches its own net at that rate — a line whose stored rate and
  //      stored VAT disagree is not evidence of anything;
  //   3. the VAT that is NOT on the lines belongs to the shipping leg, and it matches the shipping
  //      charge at that same rate. Standard-rated shipping on zero-rated goods fails (1); zero-rated
  //      shipping on standard-rated goods fails (3). Both are mixed orders, not rounding differences.
  // ---------------------------------------------------------------------------------------------
  if (lines.length === 0) {
    return {
      ok: false,
      error: undeterminableBasisMessage(
        'the order records VAT but has no lines to establish which rate it was actually taxed at',
      ),
    }
  }
  const reverseChargedLine = lines.some((line) => line.taxRate?.reverseCharge === true)
  if (reverseChargedLine) {
    return {
      ok: false,
      error: undeterminableBasisMessage(
        'it mixes reverse-charged supplies (on which no VAT is charged) with VAT-bearing ones, so one ' +
        'rate cannot convert an amount that is not attributed to either',
      ),
    }
  }
  const ratelessLine = lines.findIndex((line) => line.taxRate == null || line.taxRate.rate == null)
  if (ratelessLine >= 0) {
    return {
      ok: false,
      error: undeterminableBasisMessage(
        `order line ${ratelessLine + 1} has no recorded VAT rate, so the order is not demonstrably ` +
        'taxed at a single rate',
      ),
    }
  }
  const mismatchedRate = lines.findIndex((line) => toDecimal(line.taxRate?.rate ?? 0).sub(rate).abs().gt(RATE_EPSILON))
  if (mismatchedRate >= 0) {
    return {
      ok: false,
      error: undeterminableBasisMessage(
        `its recorded tax rate (${rate.toString()}) is not the rate its goods were taxed at (order ` +
        `line ${mismatchedRate + 1} is ${toDecimal(lines[mismatchedRate].taxRate?.rate ?? 0).toString()}) — ` +
        'a monetary amount could belong to either, and the credit note would re-gross it at the line rate',
      ),
    }
  }
  const mismatchedLineTax = lines.findIndex((line) =>
    toDecimal(line.totalBase ?? 0).mul(rate).sub(toDecimal(line.taxBase ?? 0)).abs().gt(COMPONENT_ROUNDING_TOLERANCE))
  if (mismatchedLineTax >= 0) {
    const line = lines[mismatchedLineTax]
    return {
      ok: false,
      error: undeterminableBasisMessage(
        `order line ${mismatchedLineTax + 1} records ${toDecimal(line.taxBase ?? 0).toFixed(4)} of VAT on a net ` +
        `of ${toDecimal(line.totalBase ?? 0).toFixed(4)}, which is not ${rate.toString()} of it`,
      ),
    }
  }
  // ---------------------------------------------------------------------------------------------
  // Whatever VAT is not on a line is the shipping leg's: order tax = line tax + shipping tax, by
  // construction in order-import (computeWcOrderForeignTotals).
  //
  // Codex r3 #3: that identity holds EXACTLY only in the order's OWN currency. order-import converts the
  // AGGREGATE foreign tax once into SalesOrder.taxBase and each line's tax INDEPENDENTLY into
  // SalesOrderLine.taxBase, both rounded to Decimal(18,4) — so `taxBase − Σ line.taxBase` carries one
  // conversion residue per line PLUS one for the aggregate, and none of that is shipping VAT. On a
  // 105-line EUR order at fx 1.6 the residue reaches 0.0053, past the single component's 0.0052, and a
  // legitimate order with NO shipping at all was refused for "its shipping is not taxed at that rate" —
  // where the "shipping tax" was pure FX rounding.
  //
  // So derive it where WooCommerce actually computed it: in the order currency, from the stored
  // taxForeign figures, which sum exactly. Only genuine per-penny rounding of the shipping tax line
  // remains, which is what MONEY_ROUNDING_HALF_UNIT measures. The base-currency derivation stays as a
  // fallback for an order shape that carries no foreign figures, and there the residue is admitted
  // EXPLICITLY — one half-unit per independently converted figure — instead of being charged against a
  // single component's tolerance.
  // ---------------------------------------------------------------------------------------------
  const lineForeignTaxes = lines.map((line) => line.taxForeign)
  const derivableInForeign = order.taxForeign != null &&
    order.shippingForeign != null &&
    lineForeignTaxes.every((taxForeign) => taxForeign != null)
  const shippingTax = derivableInForeign
    ? toDecimal(order.taxForeign).sub(lines.reduce((sum, line) => sum.add(toDecimal(line.taxForeign ?? 0)), toDecimal(0)))
    : taxBase.sub(lines.reduce((sum, line) => sum.add(toDecimal(line.taxBase ?? 0)), toDecimal(0)))
  const shippingNet = derivableInForeign ? toDecimal(order.shippingForeign) : shippingBase
  const impliedShippingTax = shippingNet.mul(rate)
  const shippingTolerance = derivableInForeign
    ? toDecimal(COMPONENT_ROUNDING_TOLERANCE)
    : toDecimal(MONEY_ROUNDING_HALF_UNIT)
        // The aggregate taxBase, every line's taxBase, and shippingBase are each rounded independently.
        .add(toDecimal(BASE_CONVERSION_HALF_UNIT).mul(lines.length + 2))
  if (impliedShippingTax.sub(shippingTax).abs().gt(shippingTolerance)) {
    return {
      ok: false,
      error: undeterminableBasisMessage(
        `its shipping is not taxed at that rate (${shippingTax.toFixed(4)} of VAT on a shipping charge ` +
        `of ${shippingNet.toFixed(4)}, where ${rate.toString()} implies ${impliedShippingTax.toFixed(4)})`,
      ),
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The header rate must also reproduce the order's OWN total tax, otherwise re-grossing the stored net
  // would not return the amount the customer actually received — this is the arithmetic the conversion
  // itself rests on (gross = net x (1 + rate)), and it is what catches money in the order that is in
  // neither the lines nor shipping (an order-level discount WooCommerce allocated outside them).
  //
  // Codex r1 #2: the tolerance used to be `0.02 + 0.2% of net`, which on a £10,000 net order accepted
  // ±£20.02 — wide enough to admit a header of 19.8% or 20.2% against £2,000 of recorded VAT, i.e. the
  // exact mis-scaling this guard exists to catch. It is now the MINIMUM of three DERIVED bounds:
  //
  //   1. Rounding exposure — 0.005 per independently-rounded VAT component, + 0.0002 for the two
  //      Decimal(18,4) conversions under netOrderBase. This is the largest gap plain per-penny
  //      rounding can produce, and it grows with the NUMBER of rounded figures, not with order value.
  //   2. The cumulative-refund ceiling — an accepted rate converts a full gross refund to
  //      net + δ/(1+rate); `refundWouldExceedOrderTotal` allows only REFUND_TOTAL_EPSILON (£0.011) of
  //      slack over the net order total, so δ may never exceed 0.011 × (1 + rate).
  //   3. The FULL classification — `isFullRefundAmount` needs ≥ 99.9% of the net total, so on the
  //      short side δ may never exceed (1 − FULL_REFUND_RATIO) × net × (1 + rate). This binds below
  //      about £11 of net, where the fixed £0.011 is the looser of the two.
  //
  // (2) and (3) are the hard cap: no basis this function accepts can, by itself, push a full monetary
  // refund over the ceiling or leave it short of FULL. Where genuine per-line rounding is larger than
  // that cap (≈3+ taxable components all rounding maximally the same way) NO single header rate can
  // convert the refund safely, so it is refused and quarantined rather than accepted on a basis the
  // downstream thresholds cannot carry.
  //
  // Worked, on a 13-component order (12 lines + shipping) at 20%:
  //   accepted   — the largest discrepancy admitted is £0.0132 (bound 2), i.e. a recorded rate within
  //                ±0.0132/net of the truth; on £250 net that is 19.9947%…20.0053%.
  //   rejected   — anything larger. On Codex's £10,000 net / £2,000 VAT order the old tolerance was
  //                £20.02 and admitted 19.8% and 20.2%; the new one is £0.0132, so the smallest
  //                mis-scaling now rejected is a rate off by 0.00000132 (19.999868%), and a ×100 or
  //                ÷100 mis-scale (δ ≈ 19.8 × net, or 0.99 × taxBase) is rejected on any order down to
  //                a penny of value.
  // ---------------------------------------------------------------------------------------------
  const grossMultiplier = toDecimal(1).add(rate)
  const roundingExposure = toDecimal(MONEY_ROUNDING_HALF_UNIT)
    .mul(countTaxableComponents(order))
    .add(BASE_CONVERSION_SLACK)
  const overRefundCap = toDecimal(REFUND_TOTAL_EPSILON).mul(grossMultiplier)
  const fullClassificationCap = toDecimal(1).sub(toDecimal(FULL_REFUND_RATIO)).mul(netOrderBase).mul(grossMultiplier)
  const tolerance = minDecimal(roundingExposure, overRefundCap, fullClassificationCap)

  const impliedTax = netOrderBase.mul(rate)
  if (impliedTax.sub(taxBase).abs().gt(tolerance)) {
    return {
      ok: false,
      error: undeterminableBasisMessage(
        `the order's recorded tax rate (${rate.toString()}) does not reconcile with its VAT ` +
        `(${taxBase.toFixed(2)} on a net total of ${netOrderBase.toFixed(2)}, which implies ` +
        `${impliedTax.toFixed(4)} — outside the ${tolerance.toFixed(4)} this order's rounding allows)`,
      ),
    }
  }

  return { ok: true, vatRate: rate }
}

// o3d-7yf: when a refund finally lands (a successful retry or a verified same-order dedup), RESOLVE this
// order's lingering actionable park instead of only appending a separate SYNCED log. The partial unique
// index excludes SYNCED rows, so a fresh SYNCED log never collides with — nor clears — the old PENDING/
// FAILED park; left alone it keeps counting in the exception inbox, blocks deletion/rebind, and evades
// retention forever. Scoped to THIS order + refund. QUARANTINED is left untouched: it is an operator-gated
// refusal that never reaches a successful auto-sync (the preflight returns it as handled first).
async function resolveActionableParks(
  client: Pick<typeof db, 'shoppingSyncLog'>,
  soId: string,
  externalId: string,
): Promise<void> {
  await client.shoppingSyncLog.updateMany({
    where: {
      // o3d-272i: the shared park predicate, not a copy of the pre-recordKind shape. This is an
      // UPDATE, and without `recordKind` it selected a held sales invoice (o3d-k26m.6) whose
      // externalId happened to equal this refund's id on this order — settling to SYNCED a hold that
      // nothing then posts, which is exactly the collision r8 added the column to end, running in
      // the direction that writes.
      ...activeRefundParkWhere(),
      externalId,
      entityId: soId,
      // QUARANTINED is left untouched (see above), so the status set is narrowed rather than taken
      // from the shared predicate.
      status: { in: ['PENDING', 'FAILED'] },
    },
    data: { status: 'SYNCED', syncedAt: new Date(), errorMessage: null },
  })
}

// o3d-7yf: record a refund park deduplicated by externalId. Repeated deliveries of the same unresolved
// WooCommerce refund (an amount mismatch re-imported every sweep, a still-failing retry) must keep ONE
// current row, not append a fresh one each time — unbounded copies would grow the table and crowd real
// QUARANTINED refunds out of the 50-row exception inbox. Updates the existing actionable park in place.
async function upsertRefundPark(
  client: Pick<typeof db, '$transaction'>,
  input: { soId: string; externalId: string; status: 'PENDING' | 'FAILED' | 'QUARANTINED'; errorMessage: string; payload?: unknown },
): Promise<void> {
  // Match the partial unique index shopping_sync_logs_active_refund_park_uq EXACTLY (connector, direction,
  // entityType, recordKind, actionable status, externalId, and entityId NOT NULL) so this can never pick up
  // an order-import failure log (same connector/type but no entityId) that happens to share an externalId.
  // o3d-272i r2: "EXACTLY" was aspirational until 20260909090000 — the index had no recordKind clause, so it
  // ALSO covered the held sales invoice, and refused a park whose refund id equalled some order id.
  // o3d-xnwu r7: the shape is stated ONCE, in activeRefundParkWhere, because the exception inbox and
  // the cross-order guard below have to mean exactly this by "an actionable park" and three
  // hand-written copies could not be relied on to.
  const parkWhere: Prisma.ShoppingSyncLogWhereInput = {
    ...activeRefundParkWhere(),
    externalId: input.externalId,
  }
  const data = {
    connector: 'woocommerce' as const,
    direction: 'FROM_CONNECTOR' as const,
    status: input.status,
    entityType: 'SalesOrder',
    entityId: input.soId,
    externalId: input.externalId,
    // o3d-xnwu r8: the row SAYS what it is. Everything that means "an actionable refund park" asks
    // for this value by name, so it is written on the create AND on the update — a park that lost
    // its stamp would be a park the recovery inbox cannot see.
    recordKind: WC_REFUND_PARK_RECORD_KIND,
    errorMessage: input.errorMessage,
    syncedAt: new Date(),
    ...(input.payload !== undefined ? { payload: input.payload as never } : {}),
  }
  // o3d-7yf finding 2: create/update the park under the SAME order row lock deleteSalesOrder takes
  // (lockSalesOrder = SELECT ... FOR UPDATE). A refund sweep could otherwise read the order, deletion
  // observe no park, and the sweep then insert an actionable park after the check/delete — orphaning it.
  // Under the lock we re-verify the order still exists; if it was deleted, we do NOT write an orphaned
  // park (the refund is for a gone order — surfaced by the caller's earlier resolve failing next time).
  await client.$transaction(async (tx) => {
    // o3d-ee9: take the per-refund advisory lock FIRST (before the order row lock — matching
    // createSalesOrderRefund's order so the two can't deadlock). This serializes the park write against a
    // concurrent refund CREATE for the same refund id on ANY order, closing the window where a refund could
    // commit on order A while a stale actionable park is written for order B.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wc_refund:${input.externalId}`}))`
    // Under that lock, re-read whether the refund has now LANDED (on any order). If a SalesOrderRefund exists
    // for this external id, a park (which asserts the refund is unresolved) would be contradictory — skip it.
    // soft-delete exception (identity check): includes a soft-deleted refund on purpose, so a redelivered external refund is recognised and never re-created (the row still holds the unique external id).
    const landed = await tx.salesOrderRefund.findFirst({ where: { externalRefundId: Number(input.externalId) }, select: { id: true } })
    if (landed) return

    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "sales_orders" WHERE id = ${input.soId} FOR UPDATE`
    if (rows.length === 0) return

    // The order row lock SERIALIZES every park write for this refund's order, so the findFirst reliably
    // sees an already-committed park and no two deliveries can race the create. (The partial unique index
    // shopping_sync_logs_active_refund_park_uq stays as a DB backstop.)
    const existing = await tx.shoppingSyncLog.findFirst({ where: parkWhere, orderBy: { createdAt: 'desc' }, select: { id: true, entityId: true } })
    if (existing) {
      if (existing.entityId !== input.soId) {
        // The index is keyed by (connector, externalId), so an actionable park for this refund id on a
        // DIFFERENT order is a genuine anomaly (a WC refund id maps to one order). Fail CLOSED — never
        // move A's durable refund evidence onto B's row, which would let A be deleted and mis-block B.
        throw new Error(`WooCommerce refund ${input.externalId} is already parked for a different order (${existing.entityId}); refusing to move it.`)
      }
      await tx.shoppingSyncLog.update({ where: { id: existing.id }, data })
    } else {
      await tx.shoppingSyncLog.create({ data })
    }
  })
}

/**
 * WHAT ONE REFUND'S SYNC ACTUALLY DID — o3d-xnwu round 4 (Codex HIGH), and the THIRD time this
 * branch has fixed the same defect one layer further in.
 *
 *   first   a DISCARDED RETURN VALUE made `syncWcRefund` a call that could not fail;
 *   then    a RESULT TYPE THAT COULD NOT SAY IT FAILED — the read was short, or the fetched refunds
 *           never applied, and neither fact had anywhere to travel;
 *   now     a BOOLEAN THAT CONFLATES "applied" WITH "handled".
 *
 * `success: true` was returned by five different endings, and only three of them put the refund in
 * IMS. The other two say "there is nothing more for this delivery to do", which is not the same
 * sentence at all:
 *
 *   - a QUARANTINED park on THIS order. The refund is deliberately not applied and will not be
 *     retried by a sweep; it is waiting for an operator. Nothing is in IMS.
 *   - a refund suppressed because the payment poller charged the whole order back first. A second
 *     credit note would double-reverse it, so none is raised. Nothing is in IMS.
 *
 * The sweep counted both as applied, so `synced + failed === fetched` reconciled ARITHMETICALLY
 * while misclassifying: the webhook's held-refusal branch concluded "every refund the store holds is
 * now in IMS" for an order whose refunds were sitting in an operator's inbox. The coverage shortfall
 * it then re-asked was answered from demand IMS does not hold — and answered PERMANENTLY, which
 * acknowledges the delivery and advances the cursor over it.
 *
 * So the boolean is gone and the endings name themselves. The distinction the callers need is not
 * success/failure at all, it is APPLICATION: `refundIsInIms` is the only question the coverage
 * arithmetic may ask, and it is true for exactly two of these.
 */
export type WcRefundOutcome =
  /** A SalesOrderRefund was created by THIS call. */
  | 'applied'
  /** A SalesOrderRefund for this refund already exists on THIS order — an earlier delivery applied it. */
  | 'already-applied'
  /**
   * Handled, deliberately NOT applied, and STILL CAPABLE OF BEING APPLIED: a QUARANTINED park on this
   * order, waiting for an operator. Nothing is owed by this delivery and nothing is in IMS — but the
   * day the operator records it, this refund becomes demand IMS holds. Holding a delivery for it
   * therefore buys something.
   */
  | 'handled-unapplied-resolvable'
  /**
   * Handled, deliberately NOT applied, and IT NEVER WILL BE: the payment poller charged the whole
   * order back first, so no credit note is raised and none ever will be for this refund. There is no
   * resolution that turns this into demand IMS holds — not an operator's, not a redelivery's.
   */
  | 'handled-unapplied-terminal'
  /** Did not apply, and a later delivery may succeed — a missing IMS order, a FAILED park to retry, a throw. */
  | 'retryable-failure'
  /**
   * Did not apply, was PARKED QUARANTINED by this call, and needs a human. A failure the caller must
   * report — and, like the resolvable park it becomes on the next sweep, one an operator can still
   * turn into an applied refund.
   */
  | 'quarantined-refusal'
  /**
   * Did not apply, and it is a PARK BELONGING TO ANOTHER ORDER that is in the way — but an operator
   * CAN clear it (o3d-xnwu r6). o3d-54p built the recovery: the exception inbox's "Wrong order"
   * action asks WooCommerce whether this refund is on the named order RIGHT NOW and, if it is, moves
   * the park onto that order as PENDING, which is the one actionable status this sync does not skip.
   * So the moment they do, this refund is retryable HERE. It is a failure the caller reports, and it
   * is NOT terminal: `refundMayStillReachIms` says so.
   */
  | 'cross-order-park-resolvable'
  /**
   * Did not apply and never will: a SalesOrderRefund for this WooCommerce refund ALREADY EXISTS on a
   * different order. That is a created record, not a park — nothing moves it, and a WC refund id maps
   * to one order — so no redelivery and no operator action inside IMS makes it demand this order
   * holds. Reserved for exactly that case (o3d-xnwu r6); the foreign PARK, which used to share this
   * outcome, has a resolvable one of its own above.
   */
  | 'permanent-failure'

export type WcRefundSyncResult = { outcome: WcRefundOutcome; error?: string }

/**
 * IS THIS REFUND IN IMS? The ONE predicate the coverage arithmetic is allowed to ask.
 *
 * Deliberately not "did the call succeed", and deliberately NOT widened by the split below: the
 * coverage check nets ordered demand against refunds IMS HOLDS, and it holds exactly the two
 * outcomes that put a SalesOrderRefund on the order. A terminally-suppressed refund is not one of
 * them and must never be counted as one — see `refundMayStillReachIms` for the separate question a
 * caller deciding whether to WAIT has to ask instead.
 */
export function refundIsInIms(outcome: WcRefundOutcome): boolean {
  return outcome === 'applied' || outcome === 'already-applied'
}

/** Whether this ending is a failure the caller should report. No failure kind is in IMS. */
export function refundOutcomeFailed(outcome: WcRefundOutcome): boolean {
  return outcome === 'retryable-failure'
    || outcome === 'quarantined-refusal'
    // A foreign park applies nothing and the caller must hear about it, exactly as before. What
    // changed in r6 is only whether it can EVER clear — a different question, asked by
    // `refundMayStillReachIms`.
    || outcome === 'cross-order-park-resolvable'
    || outcome === 'permanent-failure'
}

/**
 * COULD THIS REFUND STILL REACH IMS? — the settlement question, and it is NOT the coverage question.
 *
 * o3d-xnwu round 5 (Codex HIGH): `handled-unapplied` COVERED TWO ENDINGS THAT NEED OPPOSITE
 * TREATMENT. Round 4 was right that neither is applied and right that the coverage arithmetic must
 * not count either — and then the caller used "not applied" as its reason to HOLD the delivery,
 * which is only correct for one of them:
 *
 *   a QUARANTINED park is operator-resolvable. It may yet become a SalesOrderRefund, so a delivery
 *   held for it is a delivery waiting for something that can actually arrive.
 *
 *   a CHARGEBACK-SUPPRESSED refund never applies. Nothing an operator does in IMS raises the credit
 *   note — the whole order was already reversed — so holding the delivery means HTTP 500 for ever
 *   and a cursor that never advances, which is the endless-retry behaviour o3d-bx9 removed and this
 *   branch exists to keep removed.
 *
 * The same cut runs through the FAILURES, which is why this predicate is defined over the whole
 * union rather than over the two handled endings: a refund that ALREADY EXISTS as a SalesOrderRefund
 * on a different order is exactly as unreachable as a suppressed one, and holding for it
 * dead-letters every delivery of the order.
 *
 * o3d-xnwu ROUND 6 (Codex HIGH): AND THE CUT RAN ONE STEP TOO FAR. `permanent-failure` was produced
 * by TWO refusals, and only one of them is unrecoverable. The other is a refund PARKED for a
 * different order — and o3d-54p (merged, PR #640) built the recovery for exactly that: the "Wrong
 * order" action asks WooCommerce whether the refund is on the named order right now and, if so,
 * moves the park there as PENDING, after which the refund is retryable on its true owner. Calling
 * that terminal buries a refund the product has a documented operator path for, in the same way
 * round 5's `handled-unapplied` buried a quarantined park. It has its own resolvable outcome now,
 * and TERMINAL means what it says: a chargeback suppression, or a SalesOrderRefund that already
 * exists elsewhere.
 *
 * A refund that is already in IMS answers FALSE: there is nothing left to wait for. Callers ask this
 * only about refunds `refundIsInIms` already rejected, and the false keeps the two questions from
 * being confusable.
 *
 * UNRECOGNISED STAYS TRANSIENT. An outcome this switch does not know is treated as still reachable —
 * the same direction every unrecognised condition on this branch takes — because concluding "settled"
 * from ignorance is what buries a real shortfall, and concluding "wait" merely costs a redelivery.
 */
export function refundMayStillReachIms(outcome: WcRefundOutcome): boolean {
  switch (outcome) {
    case 'applied':
    case 'already-applied':
      return false
    case 'handled-unapplied-terminal':
    case 'permanent-failure':
      return false
    case 'handled-unapplied-resolvable':
    case 'quarantined-refusal':
    case 'cross-order-park-resolvable':
    case 'retryable-failure':
      return true
    default:
      return true
  }
}

/**
 * o3d-k26m.17: the refund's items as the parity breakdown reads them. A fee is MARKED when the refund item carries the wclc marker or the order fee line it is
 * matched to does (`matchedFees`, aligned with the refund's fee lines that carry money; null = not matched, every fee then judged on its own meta only).
 */
export function parityItemsOf(
  wcRefund: WcRefund,
  orderLines: ReadonlyArray<{ id: string; wclcFeeKind?: string | null }>,
  matchedFees: ReadonlyArray<string | null> | null,
  /**
   * o3d-pnc8p MED-5: the WooCommerce order, when read. A fee is MARKED, as the plugin's `is_marked_fee` judges it, also when the ORIGINAL order fee item the refund
   * item names (`_refunded_item_id`) carries `_wclc_fee`: an IMS line imported before migration 20261029200000 has no wclcFeeKind (it was never backfilled), and a
   * refund item need not carry the marker itself.
   */
  wcOrder: ParityWcOrder | null = null,
): ParityRefundItem[] {
  const metaTrue = (meta: readonly WcMeta[] | undefined, key: string) => {
    const value = (meta ?? []).find((m) => m.key === key)?.value
    return value !== undefined && value !== null && value !== '' && value !== '0' && value !== false && value !== 0
  }
  const markedOrderLine = new Set(orderLines.filter((line) => line.wclcFeeKind != null).map((line) => line.id))
  const markedWcFee = new Set((wcOrder?.fee_lines ?? []).filter((fee) => metaTrue(fee.meta_data, WCLC_FEE_MARKER_META)).map((fee) => Number(fee.id)))
  const items: ParityRefundItem[] = []
  for (const line of wcRefund.line_items) items.push({ type: 'line', total: line.total, tax: line.total_tax })
  for (const line of wcRefund.shipping_lines ?? []) items.push({ type: 'shipping', total: line.total, tax: line.total_tax })
  const feeLines = (wcRefund.fee_lines ?? []).filter((fee) => parseDecimalAbs(fee.total).gt(0.000001) || parseDecimalAbs(fee.total_tax).gt(0.000001))
  feeLines.forEach((fee, index) => {
    const matched = matchedFees?.[index] ?? null
    const original = Number((fee.meta_data ?? []).find((m) => m.key === '_refunded_item_id')?.value)
    items.push({
      type: 'fee',
      total: fee.total,
      tax: fee.total_tax,
      name: fee.name,
      marked: metaTrue(fee.meta_data, WCLC_FEE_MARKER_META) || (matched !== null && markedOrderLine.has(matched)) || (original > 0 && markedWcFee.has(original)),
      linked: original > 0,
    })
  })
  return items
}

/** o3d-pnc8p MED-5: whether a fee item is linked to an order fee but not marked on its own or by its IMS line, so only the WooCommerce order's own item can say. */
export function needsOrderFeeMarkers(items: readonly ParityRefundItem[]): boolean {
  return items.some((item) => item.type === 'fee' && item.marked !== true && item.linked === true)
}

/**
 * o3d-pnc8p L1: was `other` made BEFORE `self` in the store? By `date_created_gmt`, then by id (order and refund ids share one ascending sequence); by id alone when
 * either date cannot be read. A refund made later is never one this refund repays.
 */
export function isEarlierRefund(other: Pick<WcRefund, 'id' | 'date_created_gmt'>, self: Pick<WcRefund, 'id' | 'date_created_gmt'>): boolean {
  const gmt = (value: string | undefined) => (value ? Date.parse(`${value.replace(/Z$/, '')}Z`) : NaN)
  const a = gmt(other.date_created_gmt)
  const b = gmt(self.date_created_gmt)
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a < b
  return other.id < self.id
}

/** o3d-k26m.17: the refund's shipping lines that carry money, net or VAT (a tax-only line counts), in the refund's order. */
function parityShippingSourceLines(wcRefund: WcRefund) {
  return (wcRefund.shipping_lines ?? []).filter((line) => parseDecimalAbs(line.total).gt(0.000001) || parseDecimalAbs(line.total_tax).gt(0.000001))
}

/** o3d-k26m.17: each refunded shipping line with what its own original order line charged (`_refunded_item_id` into the WooCommerce order); null where it cannot be mapped. */
function parityShippingOf(wcRefund: WcRefund, wcOrder: ParityWcOrder | null): ParityShippingLine[] {
  return parityShippingSourceLines(wcRefund).map((line) => {
    const originalId = Number((line.meta_data ?? []).find((m) => m.key === '_refunded_item_id')?.value)
    const original = Number.isFinite(originalId) && originalId > 0 ? wcOrder?.shipping_lines.find((orderLine) => Number(orderLine.id) === originalId) : undefined
    return { total: line.total, tax: line.total_tax, name: line.method_title, charged: original ? { net: original.total, tax: original.total_tax } : null }
  })
}

export async function syncWcRefund(
  externalOrderId: number,
  wcRefund: WcRefund,
  dependencies: WcRefundSyncDependencies = {},
): Promise<WcRefundSyncResult> {
  const client = dependencies.db ?? db
  const writeActivity = dependencies.logActivity ?? logActivity
  try {
    // Find the IMS order
    const so = await client.salesOrder.findFirst({
      where: {
        shoppingLinks: {
          some: {
            connector: 'woocommerce',
            externalOrderId: String(externalOrderId),
          },
        },
      },
      select: {
        id: true,
        externalOrderNumber: true,
        // Set when an operator edited the order's lines in IMS: a refund line naming a storefront line the edit removed can no longer be linked (see the quarantine below).
        editedInImsAt: true,
        fxRateToBase: true,
        // o3d-q0x56.8: the ORDER's currency, read only to tell a base-currency order (rate 1 by definition) from a
        // foreign one whose stored rate is missing. The shipping identity is still resolved by the writer, not here.
        currency: true,
        // o3d-w00 (Codex r7 #5): currency and taxRateName are NOT read here any more. r6 resolved and
        // priced the shipping identity in this function; the writer does it now, from its own locked
        // read, so reading them here would only be a second, staler copy of the same two columns.
        totalBase: true,
        // o3d-w00: taxBase is what makes the gross->net conversion basis CHECKABLE — the header rate is
        // only trusted when it reproduces the order's own VAT (resolveMonetaryRefundVatRate).
        taxBase: true,
        // IOSS credit notes: the write-once regime stamp, read only to tell a scheme order (never to decide a regime).
        euVatRegime: true,
        taxRatePercent: true,
        // o3d-w00 (Codex r1 #2): shippingBase and the per-line tax fields size the reconciliation
        // tolerance to this order's ACTUAL rounding exposure (one penny-rounded VAT figure per line plus
        // one for shipping) instead of to a percentage of its value, and let "zero-rated" be read off the
        // lines' own rates / reverse-charge flags instead of inferred from a small tax figure.
        shippingBase: true,
        // o3d-w00 (Codex r3 #3): the ORDER-CURRENCY tax/shipping figures. The shipping leg's VAT is
        // derived (order tax − line tax) and that identity is exact only before the per-figure
        // foreign→base conversions; deriving it in base currency charged accumulated FX rounding to the
        // shipping component's tolerance and refused legitimate multi-currency orders.
        taxForeign: true,
        shippingForeign: true,
        lines: {
          select: {
            id: true, productId: true, externalLineItemId: true, description: true, qty: true, totalBase: true, totalForeign: true,
            taxBase: true,
            taxForeign: true,
            taxRate: { select: { rate: true, reverseCharge: true } },
            // o3d-k26m.17: which fee lines carry the wclc landed-cost marker (the EAS fee gap and fold are judged on marked fees only).
            wclcFeeKind: true,
          },
        },
      },
    })
    // RETRYABLE: the order may simply not have been imported yet, and the next delivery re-resolves it.
    if (!so) return { outcome: 'retryable-failure', error: `IMS order not found for WC order ${externalOrderId}` }

    // Check if already processed. externalRefundId is GLOBALLY unique, so a matching refund may belong to
    // ANOTHER order — o3d-7yf: verify ownership. Same order => idempotent success; different order => fail
    // closed rather than silently reporting "handled" and leaving THIS order without its refund.
    // soft-delete exception (identity check): includes a soft-deleted refund on purpose, so a redelivered external refund is recognised and never re-created (the row still holds the unique external id).
    const existing = await client.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id }, select: { orderId: true } })
    if (existing) {
      if (existing.orderId === so.id) {
        // Already synced. A prior delivery may have committed the refund but then failed a post-commit step
        // and written a FAILED park — every later delivery lands here, so resolve that lingering park now
        // rather than leaving it actionable forever (inbox / deletion+rebind guard / retention exemption).
        await resolveActionableParks(client, so.id, String(wcRefund.id))
        return { outcome: 'already-applied' }
      }
      // PERMANENT: a WC refund id maps to one order, so this can never become applicable here.
      return { outcome: 'permanent-failure', error: `WooCommerce refund ${wcRefund.id} already exists on a different order (${existing.orderId}); refusing to apply it here.` }
    }

    // o3d-pnc8p: A PARITY HOLD AN OPERATOR ACKNOWLEDGED AS SETTLED OUTSIDE IMS (in Xero, with the accountant). Its park is resolved, so the active-park guard
    // below no longer sees it, and the refund is still in WooCommerce: without this every sweep would hold it again, or raise the credit note the hold exists to
    // prevent. Terminal: nothing in IMS will ever apply it.
    const settledOutside = await client.shoppingSyncLog.findFirst({
      where: { recordKind: WC_REFUND_PARK_RECORD_KIND, entityId: so.id, externalId: String(wcRefund.id), status: 'SYNCED', errorMessage: { startsWith: SETTLED_OUTSIDE_IMS_NOTE_PREFIX } },
      select: { errorMessage: true },
    })
    if (typeof settledOutside?.errorMessage === 'string' && settledOutside.errorMessage.startsWith(SETTLED_OUTSIDE_IMS_NOTE_PREFIX)) {
      return { outcome: 'handled-unapplied-terminal', error: `WooCommerce refund ${wcRefund.id} was acknowledged as settled outside IMS; nothing is recorded for it.` }
    }

    // o3d-iup: a refund we deliberately PARKED (a monetary-only refund the order can't tax uniformly)
    // creates no SalesOrderRefund, so without this guard the sweep would re-import and re-refuse it every
    // run. o3d-7yf: check EVERY actionable park (the index keeps at most one per externalId), scoped by
    // order. A park for refund X on a DIFFERENT order fails closed (never apply X to two orders). This
    // order's QUARANTINED park is "handled" (awaiting operator resolution — not retryable); a PENDING/FAILED
    // park is this order's own retryable state, so fall through and let the sync re-attempt it.
    const parked = await client.shoppingSyncLog.findFirst({
      // o3d-xnwu r7: the SAME predicate the exception inbox lists by. It has to be — this guard holds
      // the delivery until an operator recovers the park it found, and a park this can see but the
      // inbox cannot is a hold with no way out.
      where: {
        ...activeRefundParkWhere(),
        externalId: String(wcRefund.id),
      },
      select: { entityId: true, status: true },
    })
    if (parked && parked.entityId !== so.id) {
      // RESOLVABLE, NOT TERMINAL (o3d-xnwu r6, Codex HIGH). Failing closed here is the right
      // AUTOMATIC behaviour and is unchanged — silently moving or resolving another order's park
      // would destroy that order's durable refund evidence. What was wrong was the CLASSIFICATION:
      // this shared `permanent-failure` with the case below it, so a caller deciding whether to wait
      // concluded nothing could ever change it and settled the delivery over a refund the product has
      // a documented operator path for.
      //
      // That path is o3d-54p (merged, PR #640): the exception inbox's "Wrong order" recovery asks
      // WooCommerce which refunds the named order actually has, right now, and — only if this refund
      // is one of them — MOVES the park onto it as PENDING (REASSIGNED_REFUND_PARK_STATUS), the one
      // actionable status the guard above does not treat as handled. The next sweep of THIS order
      // then falls straight through to the refund. A quarantined park on this same order is already
      // classified resolvable for precisely this reason; a foreign park is no less clearable, it
      // simply needs a different operator act.
      //
      // The genuinely unrecoverable cross-order case is the one above: a SalesOrderRefund that
      // already EXISTS on another order. There is no park to move there, and that is what
      // `permanent-failure` is now reserved for.
      return {
        outcome: 'cross-order-park-resolvable',
        error: `WooCommerce refund ${wcRefund.id} is already parked for a different order (${parked.entityId}); `
          + 'refusing to process it for this order. If that park is stale, an operator can clear it with the '
          + '"Wrong order" recovery on the sync exceptions page, after which this refund becomes retryable here.',
      }
    }
    // HANDLED, NOTHING IS IN IMS, AND AN OPERATOR CAN STILL CHANGE THAT (o3d-xnwu r4/r5). This used
    // to be `success: true`, which the sweep
    // counted as applied — so an order whose refunds were all sitting in the exception inbox looked,
    // to the coverage arithmetic, exactly like an order whose refunds were all recorded. It is not
    // retryable either: a sweep will refuse it identically every run until an operator resolves the
    // park, and reporting it as a failure would retry the refund webhook against a condition only a
    // human can clear. (The ORDER webhook does still hold its delivery over this row — but only
    // while a completion refusal is being held on it, where the alternative is burying a dispatch
    // IMS genuinely cannot cover. That scoping is the caller's, and deliberate.)
    if (parked && parked.status === 'QUARANTINED') {
      // RESOLVABLE, and that half of the name is load-bearing (r5). The park is what an operator
      // clears; the moment they do, this refund becomes demand IMS holds. A caller deciding whether
      // to wait for this order's refunds must wait for THIS one — which is the opposite of what it
      // must do for the chargeback suppression further down, and the reason one outcome could not
      // carry both.
      return { outcome: 'handled-unapplied-resolvable', error: `WooCommerce refund ${wcRefund.id} is quarantined for this order and awaits manual resolution` }
    }

    // IS AN IMS REFUND STILL WAITING FOR ITS WOOCOMMERCE REFUND? (the "Refund in WooCommerce" task, lib/domain/sales/shop-refund-tasks.ts)
    // IMS wrote no refund to WooCommerce for a refund recorded in IMS; a person makes it there later, under a NEW storefront refund id, and this import
    // dedups on that id alone. But IMS writes no marker to WooCommerce either, so it cannot tell that refund from a separate one that began in
    // WooCommerce with the same amount: it NEVER links on its own and never raises a credit note for it. On an order with an open task the storefront
    // refund is parked QUARANTINED, with the figures, and a person chooses on the parked row: confirm it settles a named IMS refund (a link, no
    // second credit note), or record it as a separate refund (the usual route). An order with no open task is imported exactly as before.
    // The cheap unlocked read decides whether this applies at all; the decision is made again under the per-refund lock the writer and the park
    // write also take, so a delivery that lost a race to a confirmation answers "already in IMS" instead of parking a refund that was just settled.
    const wcAmount = parseDecimalAbs(wcRefund.amount)
    if ((await findOpenShopRefunds(client, so.id)).length > 0) {
      type Decision = { kind: 'landed-here' } | { kind: 'park'; message: string } | { kind: 'none' }
      const decision = await client.$transaction(async (tx): Promise<Decision> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wc_refund:${wcRefund.id}`}))`
        // soft-delete exception (identity check): includes a soft-deleted refund on purpose, so a redelivered external refund is recognised and never re-created (the row still holds the unique external id).
        const landed = await tx.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id }, select: { orderId: true } })
        if (landed) return landed.orderId === so.id ? { kind: 'landed-here' } : { kind: 'none' }
        const open = await findOpenShopRefunds(tx, so.id)
        if (open.length === 0) return { kind: 'none' }
        return { kind: 'park', message: shopRefundParkMessage({ wcRefundId: wcRefund.id, orderCurrency: so.currency, amountForeign: wcAmount, open }) }
      })
      if (decision.kind === 'landed-here') return { outcome: 'already-applied' }
      if (decision.kind === 'park') {
        await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: 'QUARANTINED', errorMessage: decision.message, payload: wcRefund })
        await writeActivity({
          entityType: 'SALES_ORDER',
          entityId: so.id,
          action: 'refund_sync_awaits_ims_refund_confirmation',
          tag: 'sync',
          level: 'WARNING',
          description: decision.message,
          metadata: { externalRefundId: wcRefund.id },
          resolveUser: false,
        })
        return { outcome: 'quarantined-refusal', error: decision.message }
      }
      // 'none': under the lock no task is open any more (a person resolved it): the import below runs as it always did.
    }

    // o3d-q0x56.8 - THE ORDER'S BOOKED RATE, OR THE REFUND IS PARKED WITH A NAMED REASON. A foreign order whose stored
    // rate is not a positive number used to convert every refund line at 1; and a refusal that merely returned would
    // have dropped the refund (the webhook is acknowledged, and nothing would hold it). So the refusal goes through
    // the same mechanism as the other deliberate, non-transient refusals just below (`resolveMonetaryRefundVatRate`):
    // a QUARANTINED park (`upsertRefundPark`, a `shopping_sync_logs` row) that the sweep skips and the sync-exceptions
    // inbox lists with this message, reported as `quarantined-refusal` (operator-resolvable, so a caller holds its
    // delivery). The operator corrects the order's exchange rate and records the refund from the inbox. No table
    // rate is looked up: the refund reverses what was booked.
    let fxRate: Decimal
    try {
      fxRate = await resolveStoredFxRateToBase({
        currency: so.currency,
        baseCurrency: () => resolveBaseCurrencyCode({ organisation: (client as { organisation?: typeof db.organisation }).organisation ?? db.organisation }),
        storedRate: so.fxRateToBase,
        document: `Order ${so.externalOrderNumber ?? so.id}`,
      })
    } catch (error) {
      if (!isMissingStoredFxRateError(error)) throw error
      const message = `WooCommerce refund ${wcRefund.id} was NOT recorded: ${error.message}`
      await upsertRefundPark(client, {
        soId: so.id,
        externalId: String(wcRefund.id),
        status: 'QUARANTINED',
        errorMessage: message,
        payload: wcRefund,
      })
      await writeActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'refund_sync_missing_order_fx_rate',
        tag: 'sync',
        level: 'ERROR',
        description: message,
        metadata: { externalRefundId: wcRefund.id, currency: error.currency, baseCurrency: error.baseCurrency },
        resolveUser: false,
      })
      return { outcome: 'quarantined-refusal', error: message }
    }
    const refundAmountForeign = parseDecimalAbs(wcRefund.amount)

    // o3d-k26m.17 - REFUND -> CREDIT-NOTE PARITY (switch `wc_refund_credit_note_parity_enabled`, default off; lib/domain/sales/refund-cn-parity.ts). Off, nothing below
    // reads anything new and every refund is handled exactly as before.
    const parityOn = await readParitySwitch(dependencies)
    const parityFacts: RefundParityFactsInput = {}
    // STORE CREDIT (o3d-store-credit-refund 1.1.9): no credit note until the store credit is POSITIVELY live: a published coupon carrying this refund's attempt id.
    // While it is in progress the refund is parked PENDING (retried by every sweep; a WARNING the first time); with no live coupon, or still waiting past the limit,
    // it is QUARANTINED for a person. Once live, its credit note is numbered SC-<refund id> and never allocated (the liability true-up nets it off 813).
    const storeCreditAttempt = parityOn ? storeCreditAttemptOf(wcRefund) : null
    let parityWcOrder: ParityWcOrder | null | undefined
    const readParityWcOrder = async () => (parityWcOrder === undefined ? (parityWcOrder = await (dependencies.fetchWcOrder ?? fetchParityWcOrder)(externalOrderId)) : parityWcOrder)
    if (storeCreditAttempt !== null) {
      const createdAt = Date.parse(wcRefund.date_created_gmt ? `${wcRefund.date_created_gmt.replace(/Z$/, '')}Z` : '')
      const refundCreatedAt = Number.isFinite(createdAt) ? new Date(createdAt) : null
      // o3d-pnc8p L4: a refund with no readable creation time cannot bound the coupon search (it read every coupon since 1970) or the wait: said so, held for a person.
      const createdAfter = refundCreatedAt === null ? null : new Date(refundCreatedAt.getTime() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '')
      const [order, coupons] = createdAfter === null ? [null, null] : await Promise.all([
        readParityWcOrder(),
        (dependencies.fetchStoreCreditCoupons ?? fetchStoreCreditCouponsFromWc)({ attempt: storeCreditAttempt, createdAfter }),
      ])
      const verdict = createdAfter === null ? storeCreditUndatedVerdict(wcRefund.id, storeCreditAttempt) : storeCreditVerdict({
        refundId: wcRefund.id, attempt: storeCreditAttempt, refundMeta: wcRefund.meta_data, orderMeta: order?.meta_data ?? null, coupons,
        refundCreatedAt, now: (dependencies.now ?? (() => new Date()))(),
      })
      if (verdict.kind !== 'live') {
        const quarantine = verdict.kind === 'quarantine'
        await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: quarantine ? 'QUARANTINED' : 'PENDING', errorMessage: verdict.message, payload: wcRefund })
        // Said once: when this refund was not parked before (a wait), and whenever it is quarantined (that happens once, the sweep skips it afterwards).
        if (quarantine || !parked) {
          await writeActivity({
            entityType: 'SALES_ORDER',
            entityId: so.id,
            action: quarantine ? 'refund_sync_store_credit_unconfirmed' : 'refund_sync_store_credit_waiting',
            tag: 'sync',
            level: 'WARNING',
            description: verdict.message,
            metadata: { externalRefundId: wcRefund.id, attempt: storeCreditAttempt },
            resolveUser: false,
          })
        }
        return quarantine ? { outcome: 'quarantined-refusal', error: verdict.message } : { outcome: 'retryable-failure', error: verdict.message }
      }
      parityFacts.storeCreditRefund = true
    }

    // IOSS CREDIT NOTES (behind the Sales Invoices switch): a refund on a scheme-stamped order whose tax the EAS compliance plugin booked on WooCommerce rate 182 IS recorded: its tax is the sum across ALL the refund's rate ids,
    // handed to the writer, and the credit note books it on the stamped VAT account (the first N held for a person: lib/domain/sales/refund-182-hold.ts). A 182 figure that cannot be read is still refused and parked.
    // The check is made only for a refund that carries 182 tax on an order stamped on a scheme, and the switch is asked only then, so every other refund is read exactly as before.
    const easTax = so.euVatRegime != null ? refundTaxOnEasRate(wcRefund) : null
    let eas182StatedTaxForeign: number | undefined
    if (easTax !== null) {
      const salesInvoicesOn = dependencies.salesInvoicesSwitchOn
        ?? (async () => (await import('@/lib/accounting')).isAccountingSyncTypeEnabledFor('xero', 'SALES_INVOICE'))
      if (await salesInvoicesOn()) {
        const stated = refundStatedTax(wcRefund)
        if (!stated.unreadable) eas182StatedTaxForeign = toDecimal(stated.total).toNumber()
        else {
          const message = easRefundRefusal(wcRefund.id, easTax)
          await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: 'QUARANTINED', errorMessage: message, payload: wcRefund })
          await writeActivity({
            entityType: 'SALES_ORDER',
            entityId: so.id,
            action: 'refund_sync_eas_rate_182_refused',
            tag: 'sync',
            level: 'WARNING',
            description: message,
            metadata: { externalRefundId: wcRefund.id },
            resolveUser: false,
          })
          return { outcome: 'quarantined-refusal', error: message }
        }
      }
    }

    // Determine if restock is needed
    // Restock if any refund line item has qty != 0
    const hasQtyRefund = wcRefund.line_items.some((l) => Math.abs(l.quantity) > 0)

    // Reconciliation is done on a GROSS (tax-inclusive) basis because
    // wcRefund.amount is the gross amount refunded, whereas WooCommerce reports
    // line/shipping `total` ex-tax with `total_tax` separate. We accumulate the
    // gross of every line we map and compare that to wcRefund.amount. The refund
    // LINES we store stay net (matching the order lines); createRefund grosses
    // them back up via the order's tax rate.
    let mappedGrossForeign = toDecimal(0)

    // Map refund lines
    const refundLines: {
      lineId?: string
      productId: string | null
      description: string
      qty: number
      totalForeign?: number
      totalBase: number
      lineKind?: 'sale' | 'shipping'
      /**
       * o3d-w00 (Codex r7 #1): the VAT WooCommerce STATES it returned on this line. Carried into the
       * writer, whose posted-VAT fence checks the identity the credit note will be re-grossed under
       * against it — see RefundRequestLine.chargedTaxForeign.
       */
      chargedTaxForeign?: number
    }[] = []

    if (wcRefund.line_items.length > 0 && hasQtyRefund) {
      // AN ORDER EDITED IN IMS (owner-ruled desync): its edit keeps the storefront line id of every line it continues and drops that of a line it removed. A refund returning QUANTITY of a line that is not on the order any more
      // (the storefront still has it) has no stock source or cost to reverse here: written unlinked it would be booked as non-quantity revenue, with no stock return and no COGS reversal, while the refund reads as applied.
      // It is QUARANTINED instead, and nothing is recorded or sent; an operator records it by hand against what was actually returned.
      if (so.editedInImsAt != null) {
        const unlinked = wcRefund.line_items.filter((rl) => Math.abs(rl.quantity) > 0 && !so.lines.some((l) => l.externalLineItemId === refundedOrderLineId(rl)))
        if (unlinked.length > 0) {
          const names = unlinked.map((rl) => `"${rl.name || `item ${refundedOrderLineId(rl)}`}" x${Math.abs(rl.quantity)}`).join(', ')
          const error = withLedgerCheck(`WooCommerce refund ${wcRefund.id} returns ${names}, a line this order no longer has because it was edited in IMS after confirmation, so IMS cannot link it to an order line and the refund was NOT recorded: no stock was returned, no cost was reversed and nothing was sent to Xero. The money has ALREADY been returned in the storefront (refund ${wcRefund.id}) - do NOT issue another storefront refund. ${REFUND_PARK_MANUAL_RESOLUTION_HINT}`)
          await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: 'QUARANTINED', errorMessage: error, payload: wcRefund })
          await writeActivity({
            entityType: 'SALES_ORDER',
            entityId: so.id,
            action: 'refund_sync_line_removed_by_edit',
            tag: 'sync',
            level: 'WARNING',
            description: error,
            metadata: { externalRefundId: wcRefund.id },
            resolveUser: false,
          })
          return { outcome: 'quarantined-refusal', error }
        }
      }
      // Line-item refund with quantities
      for (const rl of wcRefund.line_items) {
        const qty = Math.abs(rl.quantity)
        if (qty === 0) continue

        // Match on the ORDER line the refund refers to — NOT rl.id.
        //
        // WooCommerce mints a NEW order-item id for every refund line, so rl.id is the
        // refund line's own id and never equals externalLineItemId (set from the ORDER
        // line's id on import, field-mapping.ts:209). Measured against a live store:
        // order line 92771 -> refund line 92774, with meta _refunded_item_id = "92771".
        // The previous `l.externalLineItemId === rl.id` could therefore never match, so
        // every Woo-side refund lost its line link, createRefund rejected it for having
        // no shipped stock source, and the refund vanished with no error recorded —
        // syncRefundsForOrder only returns a count, so nothing surfaced the failure.
        const imsLine = so.lines.find((l) => l.externalLineItemId === refundedOrderLineId(rl))
        const refundTotal = parseDecimalAbs(rl.total)
        const refundGbp = divideRoundedNumber(refundTotal, fxRate, 4)
        mappedGrossForeign = mappedGrossForeign.add(refundTotal).add(parseDecimalAbs(rl.total_tax))

        refundLines.push({
          lineId: imsLine?.id,
          productId: imsLine?.productId ?? null,
          description: rl.name || imsLine?.description || 'Refund item',
          qty,
          totalForeign: roundDecimalNumber(refundTotal, 4),
          totalBase: refundGbp,
          lineKind: 'sale',
          // o3d-w00 (Codex r7 #1): the VAT WooCommerce STATES it returned on this line, against the net
          // above. The writer's posted-VAT fence checks the identity this line's credit will be
          // re-grossed under against it. Restating a stated figure needs no tax-code mapping of its own,
          // and it is the only record of what this money bore when the line matched no IMS order line.
          chargedTaxForeign: roundDecimalNumber(parseDecimalAbs(rl.total_tax), 4),
        })
      }
    }

    // ---------------------------------------------------------------------------------------------
    // o3d-w00 (Codex r6 #1): an ITEMISED shipping refund is the route a storefront shipping refund
    // actually arrives by, and nothing used to check what its credit note would be re-grossed at.
    //
    // Unlike a monetary-only refund the amount is already NET here, so no gross->net conversion draws
    // attention to the rate — and the divergence lands entirely on the credit note's TOTAL. The line is
    // unlinked, so createSalesOrderRefund posts it under the ORDER-DEFAULT VAT identity (the ACTIVE
    // TaxRate named SalesOrder.taxRateName) and the connector grosses the stored net up by whatever
    // that code is worth. On an order with zero-rated postage and a 20% default, GBP 10.00 of returned
    // postage becomes a GBP 12.00 credit note — against a GBP 10.00 storefront refund that reconciled
    // to the penny, with `success: true` reported.
    //
    // Codex r7 #5: the check that catches it no longer lives here. r6 resolved the posting identity in
    // THIS function — outside the refund transaction, from its own read of the tax table — which made
    // it a pre-flight guarding one caller rather than a fence on the operation. It is now the writer's
    // (createSalesOrderRefund), inside the transaction that holds the order lock, so it covers every
    // route into a credit note and cannot disagree with the identity actually snapshotted. All this
    // route owes it is the fact only WooCommerce has: the VAT it states it returned on this line.
    // ---------------------------------------------------------------------------------------------
    const refundedShippingLines = (wcRefund.shipping_lines ?? [])
      .filter((shippingLine) => parseDecimalAbs(shippingLine.total).gt(0.000001))
    for (const shippingLine of refundedShippingLines) {
      const shippingRefundTotal = parseDecimalAbs(shippingLine.total)
      const shippingRefundTax = parseDecimalAbs(shippingLine.total_tax)
      mappedGrossForeign = mappedGrossForeign.add(shippingRefundTotal).add(shippingRefundTax)
      refundLines.push({
        productId: null,
        description: shippingLine.method_title || 'Shipping refund',
        qty: 0,
        totalForeign: roundDecimalNumber(shippingRefundTotal, 4),
        totalBase: divideRoundedNumber(shippingRefundTotal, fxRate, 4),
        lineKind: 'shipping',
        // The VAT WooCommerce actually returned on this shipping line — a STATED figure, not the
        // order-level residue IMS would otherwise have to derive, so none of the residue's refusals
        // (order-level discount, partial line read, negative remainder) apply to it.
        chargedTaxForeign: roundDecimalNumber(shippingRefundTax, 4),
      })
    }

    // ---------------------------------------------------------------------------------------------
    // o3d-k26m.14: REFUNDED FEE LINES. A refund that returns a fee (a landed-cost or handling fee) states it in `fee_lines`, which
    // used to be ignored, so the mapped gross missed the fee and the refund parked PENDING for ever. Each is linked to the ORIGINAL
    // order fee line (by name, only when exactly one fee has it; see matchRefundedFeeLines) and, below, capped per fee across ALL the order's refunds under the writer's order lock (enforcePerTargetBalances) and carried with its net and the tax WooCommerce states it returned, like a
    // goods line, so a marked (wclc) fee reaches the credit-note builder as a marked fee. A fee that cannot be matched is NEVER
    // dropped: the refund is QUARANTINED with a message naming it, for an operator to record by hand.
    // ---------------------------------------------------------------------------------------------
    // A ZERO-QUANTITY GOODS AMOUNT (a line_items entry that returns money but no units) is not mapped above. With no fee line the monetary-only fallback below records the whole refund; WITH a fee line the refund has a mapped line, the fallback is skipped,
    // and the mapped gross would hold only the fee, so it could never reconcile and would retry for ever with the customer already refunded. IMS does not split that mix: it is QUARANTINED for an operator to record by hand.
    const hasFeeLine = (wcRefund.fee_lines ?? []).some((feeLine) => parseDecimalAbs(feeLine.total).gt(0.000001) || parseDecimalAbs(feeLine.total_tax).gt(0.000001))
    const hasAmountOnlyGoods = wcRefund.line_items.some((l) => Math.abs(l.quantity) === 0 && (parseDecimalAbs(l.total).gt(0.000001) || parseDecimalAbs(l.total_tax).gt(0.000001)))
    if (hasFeeLine && hasAmountOnlyGoods) {
      const error = withLedgerCheck(`WooCommerce refund ${wcRefund.id} mixes an amount-only goods refund (money returned on a line with no quantity) with a fee refund, which IMS cannot split automatically, so the refund was NOT recorded and nothing was sent to Xero. The money has ALREADY been returned in the storefront (refund ${wcRefund.id}) - do NOT issue another storefront refund. ${REFUND_PARK_MANUAL_RESOLUTION_HINT}`)
      await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: 'QUARANTINED', errorMessage: error, payload: wcRefund })
      await writeActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'refund_sync_amount_only_goods_with_fee',
        tag: 'sync',
        level: 'WARNING',
        description: error,
        metadata: { externalRefundId: wcRefund.id },
        resolveUser: false,
      })
      return { outcome: 'quarantined-refusal', error }
    }

    const refundedFeeLines = (wcRefund.fee_lines ?? [])
      .filter((feeLine) => parseDecimalAbs(feeLine.total).gt(0.000001) || parseDecimalAbs(feeLine.total_tax).gt(0.000001))
    if (refundedFeeLines.length > 0) {
      const matched = matchRefundedFeeLines(refundedFeeLines, so.lines)
      const unmatched = refundedFeeLines.filter((_, index) => matched[index] === null)
      // EVERY mapped fee line that adds to the gross must reach the refund write, whose line filter keeps a line only if it has a quantity or a positive base net. A fee with tax but no net (or a net that rounds to zero in base) would be counted in
      // the gross and then dropped, leaving the credit note short by its tax, so it is quarantined like an unmatched fee. (Net with no tax is kept by the filter, so it is not a problem.)
      const unwritable = refundedFeeLines.filter((feeLine, index) => matched[index] !== null && !(divideRoundedNumber(parseDecimalAbs(feeLine.total), fxRate, 4) > 0))
      if (unmatched.length > 0 || unwritable.length > 0) {
        const describe = (feeLine: (typeof refundedFeeLines)[number]) => `"${feeLine.name ?? '(unnamed)'}" (${parseDecimalAbs(feeLine.total).toFixed(2)} net, ${parseDecimalAbs(feeLine.total_tax).toFixed(2)} tax)`
        const parts: string[] = []
        if (unmatched.length > 0) parts.push(`refunds fee ${unmatched.map(describe).join(', ')} that IMS cannot match to exactly one fee line on the original order (it matches by name, and only when no other fee on the order has that name)`)
        if (unwritable.length > 0) parts.push(`refunds fee ${unwritable.map(describe).join(', ')}: a fee refund carrying tax but no net cannot be recorded automatically`)
        const error = withLedgerCheck(`WooCommerce refund ${wcRefund.id} ${parts.join(' and ')}, so the refund was NOT recorded and nothing was sent to Xero. Record the refund manually from the order, crediting that fee line.`)
        await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: 'QUARANTINED', errorMessage: error, payload: wcRefund })
        await writeActivity({
          entityType: 'SALES_ORDER',
          entityId: so.id,
          action: 'refund_sync_fee_line_unmatched',
          tag: 'sync',
          level: 'WARNING',
          description: error,
          metadata: { externalRefundId: wcRefund.id },
          resolveUser: false,
        })
        return { outcome: 'quarantined-refusal', error }
      }
      for (const [index, feeLine] of refundedFeeLines.entries()) {
        const feeNet = parseDecimalAbs(feeLine.total)
        const feeTax = parseDecimalAbs(feeLine.total_tax)
        mappedGrossForeign = mappedGrossForeign.add(feeNet).add(feeTax)
        refundLines.push({
          lineId: matched[index]!,
          productId: null,
          description: feeLine.name || 'Fee refund',
          qty: 0,
          totalForeign: roundDecimalNumber(feeNet, 4),
          totalBase: divideRoundedNumber(feeNet, fxRate, 4),
          lineKind: 'sale',
          chargedTaxForeign: roundDecimalNumber(feeTax, 4),
        })
      }
    }

    // o3d-k26m.17 - THE FEE REPAYMENT (rule 2): a refund that refunds no goods and no fee but pays money out is how EAS records a landed-cost fee being paid
    // back (166130: VAT on zero-total goods). On an order where an earlier refund carried a marked fee it is HELD (QUARANTINED, with the instruction to apply the
    // payment to that refund's credit note), never a second credit note crediting the fee and its VAT again.
    // "Earlier" is judged from the ORDER'S OWN REFUNDS IN WOOCOMMERCE, as the plugin judges from $order->get_refunds(): a sweep (newest first in the store) or a
    // fee refund still parked would otherwise let the repayment be credited before IMS has recorded the fee refund. IMS's own refunds (a deleted one's credit
    // note may still stand) and its active parks on the order are counted too, read under the order's row lock.
    if (parityOn && refundLines.length === 0 && refundedFeeLines.length === 0) {
      const breakdown = parityRefundBreakdown(parityItemsOf(wcRefund, so.lines, null))
      if (feeRepaymentHold({ refundId: wcRefund.id, amount: refundAmountForeign, currency: so.currency, breakdown, earlier: [{ label: '', carriedMarkedFee: true, owedMinor: 0 }] }) !== null) {
        const storeRefunds = dependencies.orderRefunds ?? await (dependencies.fetchOrderRefunds ?? fetchOrderRefundsFromWc)(externalOrderId)
        if (storeRefunds === null) {
          const message = `WooCommerce refund ${wcRefund.id} refunds no goods and no fee, and IMS could not read this order's other refunds in WooCommerce to tell whether it repays a landed-cost fee an earlier refund already credits, so it was not recorded yet. It is retried on the next sweep.`
          await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: 'PENDING', errorMessage: message, payload: wcRefund })
          return { outcome: 'retryable-failure', error: message }
        }
        const markedFeeLineIds = new Set(so.lines.filter((line) => line.wclcFeeKind != null).map((line) => line.id))
        // o3d-pnc8p L6: the WooCommerce order is read only when an earlier refund needs it (its marked fees' shipping, or a fee only the order item marks).
        const factsOf = async (other: WcRefund, label: string): Promise<EarlierRefundFacts> => {
          const fees = (other.fee_lines ?? []).filter((fee) => parseDecimalAbs(fee.total).gt(0.000001) || parseDecimalAbs(fee.total_tax).gt(0.000001))
          const matched = fees.length > 0 ? matchRefundedFeeLines(fees, so.lines) : []
          let items = parityItemsOf(other, so.lines, matched)
          if (needsOrderFeeMarkers(items)) items = parityItemsOf(other, so.lines, matched, await readParityWcOrder())
          const otherBreakdown = parityRefundBreakdown(items)
          const verdict = otherBreakdown.markedFees > 0
            ? decideAmountGap({ refundId: other.id, amount: other.amount, breakdown: otherBreakdown, refundShipping: parityShippingOf(other, await readParityWcOrder()) })
            : { kind: 'not-recognised' as const }
          return { label, carriedMarkedFee: otherBreakdown.markedFees > 0, owedMinor: earlierFeeOwedMinor({ breakdown: otherBreakdown, amount: other.amount, folded: verdict.kind === 'fold' }) }
        }
        const { imsRefunds, parks } = await client.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "sales_orders" WHERE id = ${so.id} FOR UPDATE`
          return {
            // soft-delete exception (identity check): a deleted refund's credit note may still stand in Xero, so a fee it credited still counts here.
            imsRefunds: await tx.salesOrderRefund.findMany({
              where: { orderId: so.id },
              select: { creditNoteNumber: true, externalRefundId: true, easFeeGapForeign: true, lines: { select: { salesOrderLineId: true } } },
            }),
            parks: await tx.shoppingSyncLog.findMany({ where: { ...activeRefundParkWhere(), entityId: so.id }, select: { externalId: true, payload: true } }),
          }
        })
        const cnOf = new Map(imsRefunds.filter((refund) => refund.externalRefundId != null).map((refund) => [refund.externalRefundId!, refund.creditNoteNumber]))
        const seen = new Set<number>([wcRefund.id])
        const earlier: EarlierRefundFacts[] = []
        const labelOf = (id: number) => `WooCommerce refund ${id}${cnOf.get(id) ? ` (credit note ${cnOf.get(id)})` : ''}`
        // o3d-pnc8p L1: only refunds made BEFORE this one count as earlier. On a catch-up the store's list (and IMS) also holds refunds made after it, and a later
        // fee refund is not one this refund can repay.
        for (const other of storeRefunds) {
          if (seen.has(other.id)) continue
          seen.add(other.id)
          if (!isEarlierRefund(other, wcRefund)) continue
          earlier.push(await factsOf(other, labelOf(other.id)))
        }
        for (const park of parks) {
          const payload = park.payload as WcRefund | null
          const id = Number(park.externalId)
          if (!payload || typeof payload !== 'object' || !Array.isArray(payload.line_items) || seen.has(id)) continue
          seen.add(id)
          if (!isEarlierRefund({ id, date_created_gmt: payload.date_created_gmt }, wcRefund)) continue
          earlier.push(await factsOf(payload, `${labelOf(id)}, parked on Sync exceptions`))
        }
        for (const refund of imsRefunds) {
          if (refund.externalRefundId != null && seen.has(refund.externalRefundId)) continue
          if (refund.externalRefundId != null && refund.externalRefundId > wcRefund.id) continue
          earlier.push({
            label: refund.externalRefundId != null ? labelOf(refund.externalRefundId) : `credit note ${refund.creditNoteNumber ?? '(no number)'}`,
            carriedMarkedFee: (refund.lines ?? []).some((line) => line.salesOrderLineId != null && markedFeeLineIds.has(line.salesOrderLineId)),
            owedMinor: Math.round(Math.abs(Number(refund.easFeeGapForeign ?? 0)) * 100),
          })
        }
        const hold = feeRepaymentHold({ refundId: wcRefund.id, amount: refundAmountForeign, currency: so.currency, breakdown, earlier })
        if (hold !== null) {
          await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: 'QUARANTINED', errorMessage: hold, payload: wcRefund })
          await writeActivity({
            entityType: 'SALES_ORDER',
            entityId: so.id,
            action: 'refund_sync_fee_repayment_held',
            tag: 'sync',
            level: 'WARNING',
            description: hold,
            metadata: { externalRefundId: wcRefund.id },
            resolveUser: false,
          })
          return { outcome: 'quarantined-refusal', error: hold }
        }
        // o3d-pnc8p (IOSS cases 3 and 4): A VAT-ONLY REFUND. Lines with nothing on them but money paid back, and no fee on the order to repay. What it credits depends
        // on how the invoice was booked, which IMS cannot see from the refund: on an invoice Xero already holds ex-VAT (159049: 141.30 zero-rated, a 29.67 "refund
        // VAT") the right credit note is ZERO, nothing to reverse; on an IOSS order whose VAT was taken twice (162199: 39.71 "VAT paid double") it reverses the VAT
        // out of 821 on No VAT. Crediting it as an ordinary amount (the monetary fallback below) would do neither, so it is HELD for a person.
        if ((wcRefund.line_items.length > 0 || (wcRefund.shipping_lines ?? []).length > 0)) {
          const message = vatOnlyRefundHold({ refundId: wcRefund.id, amount: refundAmountForeign, currency: so.currency })
          await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: 'QUARANTINED', errorMessage: message, payload: wcRefund })
          await writeActivity({
            entityType: 'SALES_ORDER',
            entityId: so.id,
            action: 'refund_sync_vat_only_refund_held',
            tag: 'sync',
            level: 'WARNING',
            description: message,
            metadata: { externalRefundId: wcRefund.id },
            resolveUser: false,
          })
          return { outcome: 'quarantined-refusal', error: message }
        }
      }
    }

    if (refundLines.length === 0) {
      // Monetary-only refund (no line items / shipping to break down): the money returned to the customer
      // is GROSS (tax-inclusive), but every refund line is stored NET (o3d-w00) — the credit note grosses
      // it back up via the snapshotted tax type. So convert the gross refund to net using the order's VAT
      // rate here; a non-taxable order (rate 0) leaves it unchanged. The gross accumulator below stays
      // GROSS, because the amount-mismatch reconciliation checks against wcRefund.amount which is gross.
      //
      // o3d-w00: the rate comes from resolveMonetaryRefundVatRate, which treats taxRatePercent as the
      // FRACTION it is and refuses to guess when the conversion basis cannot be established. Failing
      // closed here is deliberate: a refund stored on an undetermined basis would still be stamped
      // totalsBasis='NET', so a gross figure would enter the net ceiling / FULL-vs-PARTIAL comparison
      // and both over-credit Xero and strand the order at PARTIALLY_REFUNDED.
      // RATE 182 (the EAS plugin re-priced this refund under its own rate): the order's header VAT rate is NOT what the plugin charged, so a net derived from it would not reconcile with the VAT the refund states and the writer's rate-182 check would refuse the refund on every retry.
      // The net is the refund's stated gross less the VAT it states across all its rate ids; the writer then validates it (stated tax within tolerance, aggregate order bound).
      const eas182Net = eas182StatedTaxForeign === undefined ? null : refundAmountForeign.sub(toDecimal(eas182StatedTaxForeign))
      const basis = eas182Net !== null ? ({ ok: true, vatRate: toDecimal(0) } as const) : resolveMonetaryRefundVatRate(so)
      if (!basis.ok) {
        const error =
          `WooCommerce refund ${wcRefund.id} (${refundAmountForeign.toDecimalPlaces(2).toFixed(2)} gross): ` +
          basis.error
        // A deliberate, non-transient refusal — QUARANTINED so the sweep dedup skips it and the
        // exception inbox surfaces it for an operator, exactly like the non-uniform-tax refusal.
        await upsertRefundPark(client, {
          soId: so.id,
          externalId: String(wcRefund.id),
          status: 'QUARANTINED',
          errorMessage: error,
          payload: wcRefund,
        })
        // QUARANTINED: this call recorded the park, and only an operator resolving it can change the
        // answer. Reported as a failure once, by the delivery that decided it — and, r5, named as the
        // OPERATOR-RESOLVABLE kind, because "only an operator can change it" is precisely the state a
        // caller is right to hold a delivery for. `permanent-failure` is now reserved for the refunds
        // no resolution reaches at all.
        return { outcome: 'quarantined-refusal', error }
      }
      const netForeign = eas182Net !== null ? eas182Net : toDecimal(refundAmountForeign).div(toDecimal(1).add(basis.vatRate))
      refundLines.push({
        productId: null,
        description: wcRefund.reason || 'WooCommerce refund',
        qty: 0,
        totalForeign: roundDecimalNumber(netForeign, 4),
        totalBase: divideRoundedNumber(netForeign, fxRate, 4),
        lineKind: 'sale',
      })
      mappedGrossForeign = refundAmountForeign
    }

    let mappedGrossRounded = roundDecimalNumber(mappedGrossForeign, 4)
    // o3d-k26m.17 - THE EAS AMOUNT GAP (rules 1 and 3), judged only when the lines and the amount disagree and the switch is on:
    //   the FEE GAP (exact signature): the credit note credits the ITEM total, the refund records the fee left out of the amount, and the order is flagged so
    //     the fee's separate repayment is applied to this credit note (166122 / 166128);
    //   the SHIPPING FOLD (exact): shipping is restored to what the order charged and the lines then total the amount (177725);
    //   close to either but not exact: QUARANTINED for a person, never credited at the inflated total.
    let parityStatedGross: number | null = null
    let parityNote: { action: string; level: 'INFO' | 'WARNING'; description: (creditNote: string) => string } | null = null
    if (parityOn && refundLines.length > 0 && toDecimal(mappedGrossRounded).sub(refundAmountForeign).abs().gt(0.01)) {
      const matchedFees = refundedFeeLines.length > 0 ? matchRefundedFeeLines(refundedFeeLines, so.lines) : []
      // o3d-pnc8p MED-5: a fee neither the refund item nor its IMS line marks is judged by the ORIGINAL order item's `_wclc_fee`, as the plugin judges it.
      let gapItems = parityItemsOf(wcRefund, so.lines, matchedFees)
      if (needsOrderFeeMarkers(gapItems)) gapItems = parityItemsOf(wcRefund, so.lines, matchedFees, await readParityWcOrder())
      const breakdown = parityRefundBreakdown(gapItems)
      // Each refunded shipping line is compared with its OWN original order line (read from WooCommerce through `_refunded_item_id`), tax-only lines included.
      const wcShipping = parityShippingSourceLines(wcRefund)
      let verdict = breakdown.markedFees > 0
        ? decideAmountGap({ refundId: wcRefund.id, amount: refundAmountForeign, breakdown, refundShipping: parityShippingOf(wcRefund, await readParityWcOrder()) })
        : decideAmountGap({ refundId: wcRefund.id, amount: refundAmountForeign, breakdown, refundShipping: [] })
      // A tax-only shipping line is not one IMS records as a line, so the lines it writes could not total what the verdict expects: held, never guessed.
      const taxOnlyShipping = wcShipping.filter((line) => !parseDecimalAbs(line.total).gt(0.000001))
      if ((verdict.kind === 'fee-gap' || verdict.kind === 'fold') && taxOnlyShipping.length > 0) {
        verdict = { kind: 'hold', message: withLedgerCheck(`WooCommerce refund ${wcRefund.id} cannot be credited automatically: it refunds landed-cost fees EAS left out of (or folded into) the amount, and also a shipping line that carries VAT but no net (${taxOnlyShipping.map((line) => `"${line.method_title || 'Shipping'}" ${parseDecimalAbs(line.total_tax).toFixed(2)} VAT`).join('; ')}), which IMS does not record as a line. Settle its credit note in Xero by hand, with the accountant. Nothing was recorded and nothing was sent to Xero. The money has ALREADY been returned in the storefront (refund ${wcRefund.id}) - do NOT issue another storefront refund.${PARITY_NO_MANUAL_RECORD}`) }
      }
      if (verdict.kind === 'hold') {
        await upsertRefundPark(client, { soId: so.id, externalId: String(wcRefund.id), status: 'QUARANTINED', errorMessage: verdict.message, payload: wcRefund })
        await writeActivity({
          entityType: 'SALES_ORDER',
          entityId: so.id,
          action: 'refund_sync_eas_amount_gap_held',
          tag: 'sync',
          level: 'WARNING',
          description: verdict.message,
          metadata: { externalRefundId: wcRefund.id },
          resolveUser: false,
        })
        return { outcome: 'quarantined-refusal', error: verdict.message }
      }
      if (verdict.kind === 'fee-gap') {
        const credited = verdict.creditedGrossMinor / 100
        const gap = verdict.feeGapMinor / 100
        parityStatedGross = credited
        parityFacts.easFeeGapForeign = gap
        parityFacts.storefrontAmountForeign = refundAmountForeign.toNumber()
        mappedGrossRounded = refundAmountForeign.toNumber()
        // Written once the refund exists, so it can name its credit note.
        parityNote = {
          action: 'refund_sync_eas_fee_gap_credited',
          level: 'WARNING',
          description: (creditNote: string) => withLedgerCheck(`WooCommerce refund ${wcRefund.id} was recorded at its items, ${credited.toFixed(2)} ${so.currency}: EAS left the ${gap.toFixed(2)} ${so.currency} landed-cost fee out of the refund amount (${refundAmountForeign.toFixed(2)} ${so.currency} was paid back) while the fee stayed on the refund, so credit note ${creditNote} credits the goods, the fee and their VAT. `
            + `The fee is repaid to the customer separately (a later storefront refund of ${gap.toFixed(2)} ${so.currency} that refunds no goods, which IMS holds on Sync exceptions, or a payment made outside WooCommerce). When it is, apply that payment to credit note ${creditNote} in Xero; until then ${gap.toFixed(2)} ${so.currency} stays open on it.`),
        }
      } else if (verdict.kind === 'fold') {
        // The refund's shipping lines that carry net are, in order, the shipping lines written above; each restored one is set back to what its original charged.
        const writtenShipping = refundLines.filter((line) => line.lineKind === 'shipping')
        const restored: string[] = []
        for (const restore of verdict.restore) {
          const written = writtenShipping[refundedShippingLines.indexOf(wcShipping[restore.index]!)]
          if (!written) continue
          written.totalForeign = roundDecimalNumber(restore.net, 4)
          written.totalBase = divideRoundedNumber(restore.net, fxRate, 4)
          written.chargedTaxForeign = roundDecimalNumber(restore.tax, 4)
          restored.push(`"${written.description}" ${restore.net} + ${restore.tax} VAT`)
        }
        if (eas182StatedTaxForeign !== undefined) eas182StatedTaxForeign = toDecimal(eas182StatedTaxForeign).sub(toDecimal(verdict.excessTax)).toNumber()
        mappedGrossRounded = refundAmountForeign.toNumber()
        parityNote = {
          action: 'refund_sync_eas_shipping_fold_restored',
          level: 'INFO',
          description: () => `WooCommerce refund ${wcRefund.id}: EAS put the refunded fees (${verdict.excessNet} + ${verdict.excessTax} VAT) on the refund's shipping line as well as on the fee lines; the shipping was restored to what was charged (${restored.join('; ')}) and the credit note totals the ${refundAmountForeign.toFixed(2)} paid back.`,
        }
      }
    }
    if (refundLines.length > 0 && toDecimal(mappedGrossRounded).sub(refundAmountForeign).abs().gt(0.01)) {
      const error = `WooCommerce refund ${wcRefund.id} amount mismatch: mapped ${toDecimal(mappedGrossRounded).toFixed(2)} but refund total is ${refundAmountForeign.toDecimalPlaces(2).toFixed(2)}`
      await upsertRefundPark(client, {
        soId: so.id,
        externalId: String(wcRefund.id),
        status: 'PENDING',
        errorMessage: error,
        payload: wcRefund,
      })
      // RETRYABLE: the park is PENDING, which the sweep deliberately re-attempts — a corrected or
      // completed WooCommerce refund can still reconcile.
      return { outcome: 'retryable-failure', error }
    }

    // Find return warehouse (default return warehouse)
    let returnWarehouseId: string | undefined
    if (hasQtyRefund) {
      const returnWh = await client.warehouse.findFirst({
        where: { defaultReturnWarehouse: true, active: true },
        select: { id: true },
      })
      returnWarehouseId = returnWh?.id
    }

    // The store's refund reason text maps onto a configured return reason only when it matches an ACTIVE reason's name (ignoring case); anything else stays unmapped. Reasons are never created here.
    const returnReasonId = await resolveReturnReasonId(client, wcRefund.reason)

    // Use the createRefund action
    const createRefund = dependencies.createRefund
      ?? (await import('@/app/actions/sales')).createRefund
    let result: Awaited<ReturnType<CreateRefundAction>>
    try {
      result = await createRefund(
        so.id,
        refundLines.filter((l) => l.qty > 0 || l.totalBase > 0),
        wcRefund.reason || 'WooCommerce refund',
        returnWarehouseId,
        { internalBypassToken: INTERNAL_ACTION_BYPASS, externalRefundId: wcRefund.id, ...(typeof wcRefund.refunded_payment === 'boolean' ? { refundedViaGateway: wcRefund.refunded_payment } : {}), ...(returnReasonId ? { returnReasonId } : {}), statedGrossForeign: parityStatedGross ?? refundAmountForeign.toNumber(), ...(eas182StatedTaxForeign !== undefined ? { eas182StatedTaxForeign } : {}), ...(refundedFeeLines.length > 0 ? { enforcePerTargetBalances: true } : {}), ...(parityOn && Object.keys(parityFacts).length > 0 ? { refundParity: parityFacts } : {}) },
      )
    } catch (error) {
      if (!isExternalRefundIdUniqueConflict(error)) throw error
      // o3d-7yf: the unique violation may be a CROSS-ORDER race — the refund that won the externalRefundId
      // could belong to another order. Verify ownership before recording a SYNCED dedup log for THIS order;
      // otherwise the loser is falsely marked synced while its refund lives on a different order.
      // soft-delete exception (identity check): includes a soft-deleted refund on purpose, so a redelivered external refund is recognised and never re-created (the row still holds the unique external id).
      const winner = await client.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id }, select: { orderId: true } })
      if (winner && winner.orderId !== so.id) {
        return { outcome: 'permanent-failure', error: `WooCommerce refund ${wcRefund.id} was concurrently created on a different order (${winner.orderId}); refusing to mark it synced here.` }
      }
      await client.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'SYNCED',
          entityType: 'SalesOrder',
          entityId: so.id,
          externalId: String(wcRefund.id),
          errorMessage: 'Duplicate WooCommerce refund delivery deduped by external refund id',
          syncedAt: new Date(),
        },
      })
      // The verified same-order refund exists — resolve any lingering actionable park for it too.
      await resolveActionableParks(client, so.id, String(wcRefund.id))
      await writeActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'refund_sync_deduped',
        tag: 'sync',
        level: 'INFO',
        description: `WC refund ${wcRefund.id} already synced; duplicate delivery was deduped`,
        metadata: { externalRefundId: wcRefund.id, parentOrderId: externalOrderId },
        resolveUser: false,
      })
      // The refund IS in IMS — the winner of the race is this same order's row, verified above.
      return { outcome: 'already-applied' }
    }

    // o3d-6oyu.18: the refund transaction refused this credit note because a payment-poller
    // CHARGEBACK for the same order committed first — the other half of the concurrent
    // double-reversal race (a Xero payment removal and this WC refund inside one poll cycle).
    // A chargeback unwinds the WHOLE remaining order, so posting this refund's credit note on
    // top would double-reverse it. Treat it as handled, NOT as a failure: a FAILED row would
    // dead-letter into the exceptions inbox and be retried forever against a condition that can
    // never clear. The reversal itself is not lost — the poller already raised the credit note
    // and alerted admins; this WARNING records that the Woo-side refund needs reconciling.
    if (result.conflict === 'prior-chargeback') {
      const alreadyRecorded = await client.shoppingSyncLog.findFirst({
        where: {
          entityType: 'SalesOrder',
          externalId: String(wcRefund.id),
          errorMessage: WC_REFUND_SUPPRESSED_BY_CHARGEBACK,
        },
        select: { id: true },
      })
      // o3d-1sc3: suppressing the duplicate CREDIT NOTE is right; suppressing the STOCK
      // RETURN is not. A chargeback performs no restock because it assumes the customer kept
      // the goods — but a Woo refund carrying QUANTITY lines is at least evidence that units
      // were refunded, and the chargeback path will never account for them. Marking the whole
      // delivery SYNCED at WARNING therefore buried a possible inventory gap behind a note
      // about a credit note.
      //
      // What this does NOT do, deliberately: assert that goods physically came back, or raise
      // a WmsReturnsInbox row. WooCommerce's refund line carries a refunded QUANTITY and no
      // received/restocked signal, so quantity alone cannot prove a physical return — and the
      // returns inbox is currently scoped to a single WMS connector — its loader, its status
      // action and its restock action all filter on that one connector — so a row written here
      // would be invisible and unresolvable. Claiming an actionable record that no screen shows
      // would be worse than the WARNING it replaced. Generalising that inbox is o3d-92rl;
      // establishing what actually proves a physical return on the WooCommerce side is o3d-etbf.
      const refundedUnits = refundLines
        .filter((line) => line.lineKind === 'sale' && line.qty > 0)
        .reduce((sum, line) => sum + line.qty, 0)

      if (!alreadyRecorded) {
        await client.shoppingSyncLog.create({
          data: {
            direction: 'FROM_CONNECTOR',
            status: 'SYNCED',
            entityType: 'SalesOrder',
            entityId: so.id,
            externalId: String(wcRefund.id),
            errorMessage: WC_REFUND_SUPPRESSED_BY_CHARGEBACK,
            syncedAt: new Date(),
          },
        })
        const returnedNote = refundedUnits > 0
          ? ` This refund covered ${refundedUnits} unit(s): the chargeback path performs no restock, so if those units came back they are NOT on hand in IMS. Verify and adjust stock manually.`
          : ''
        await writeActivity({
          entityType: 'SALES_ORDER',
          entityId: so.id,
          action: 'refund_sync_suppressed_by_chargeback',
          tag: 'sync',
          // A quantity-bearing refund may owe an inventory movement nothing else will make,
          // so it needs action rather than a note. A monetary-only suppression owes nothing.
          level: refundedUnits > 0 ? 'ERROR' : 'WARNING',
          description: withLedgerCheck(`WooCommerce refund ${wcRefund.id} on order #${so.externalOrderNumber} was not recorded — the order was already charged back by the payment poller, and a second credit note would double-reverse it. Reconcile the Woo refund manually.${returnedNote} ${result.error ?? ''}`).trim(),
          metadata: {
            externalRefundId: wcRefund.id,
            parentOrderId: externalOrderId,
            refundedUnits,
          },
          resolveUser: false,
        })
      }
      // HANDLED, NOTHING IS IN IMS, AND NOTHING EVER PUTS IT THERE (o3d-xnwu r4/r5). No credit note
      // is raised and no restock is made, so counting this as applied told the coverage arithmetic
      // that demand it does not hold had been recorded. It is not a failure either: the condition
      // can never clear by retrying — the activity record above is what asks a human to reconcile
      // it, IN WOOCOMMERCE AND THE LEDGER, not in IMS.
      //
      // TERMINAL, and r5 is what that word is for. r4 gave this the same outcome as a quarantined
      // park, so the caller that (correctly) holds a delivery for a park held it for this too —
      // for ever, because no resolution exists: the whole order was already reversed by the payment
      // poller, and a second credit note is precisely what must not be raised. HTTP 500 on every
      // redelivery with a cursor that never advances is the endless retry o3d-bx9 removed.
      return { outcome: 'handled-unapplied-terminal', error: WC_REFUND_SUPPRESSED_BY_CHARGEBACK }
    }

    if (!result.success) {
      // o3d-iup: a deliberate refusal (result.quarantine) is PARKED, not a transient failure — record it
      // as QUARANTINED so the sweep dedup skips it (no per-sweep re-refusal loop) and FAILED dashboards
      // don't treat it as retryable. The refusal message already tells the operator to resolve it in IMS
      // and not to issue another Woo refund.
      const quarantined = result.quarantine === true
      // o3d-w00 (Codex r7 #3): a refusal stops the RESTOCK as well as the credit note, and the two are
      // not equally visible — the money is on the storefront and reconciles; the units are simply not on
      // hand. Say so on the park itself, where the operator resolving it will read it, rather than
      // leaving it to be inferred from the fact that the refund was itemised.
      const refusedUnits = refundLines
        .filter((line) => line.lineKind !== 'shipping' && line.qty > 0)
        .reduce((sum, line) => sum + line.qty, 0)
      const unitsNote = refusedUnits > 0
        ? ` This refund also returned ${refusedUnits} unit(s), which are NOT back on hand in IMS — ` +
          'recording it manually restocks them.'
        : ''
      await upsertRefundPark(client, {
        soId: so.id,
        externalId: String(wcRefund.id),
        status: quarantined ? 'QUARANTINED' : 'FAILED',
        errorMessage: `${result.error ?? 'refund sync failed'}${unitsNote}`,
        // Codex r2 #2: keep the WooCommerce refund for EVERY park, not just the basis refusal. The
        // Record-manually path reconciles the credit note it raises against the GROSS amount in this
        // payload; a park without it has no figure to check against, so the completion path it advertises
        // cannot run. This is the non-uniform-tax refusal — the commonest quarantine there is.
        payload: wcRefund,
      })
      // A quarantine is a refusal only an operator can clear; a FAILED park is this order's own
      // retryable state and a later delivery may well apply it.
      //
      // r5: the quarantine this call has just recorded is the SAME STATE the early return above
      // reports on every later sweep, so it must answer the settlement question the same way —
      // operator-resolvable, hold. It stays a reported FAILURE (`refundOutcomeFailed`), which is
      // what the refund webhook has always done with it; what it stops being is a `permanent-failure`
      // lumped in with a refund WooCommerce holds on another order, whose only thing in common was
      // the word permanent.
      return {
        outcome: quarantined ? 'quarantined-refusal' : 'retryable-failure',
        error: `${result.error ?? 'refund sync failed'}${unitsNote}`,
      }
    }

    await client.shoppingSyncLog.create({
      data: {
        direction: 'FROM_CONNECTOR',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: so.id,
        externalId: String(wcRefund.id),
        syncedAt: new Date(),
      },
    })
    // A same-order PENDING/FAILED park intentionally fell through to this retry — now that it landed, clear it.
    await resolveActionableParks(client, so.id, String(wcRefund.id))

    if (parityNote !== null) {
      await writeActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: parityNote.action,
        tag: 'sync',
        level: parityNote.level,
        description: parityNote.description((result as { creditNoteNumber?: string | null }).creditNoteNumber ?? 'this refund\'s credit note'),
        metadata: { externalRefundId: wcRefund.id, ...(parityFacts.easFeeGapForeign != null ? { easFeeGapForeign: parityFacts.easFeeGapForeign, storefrontAmountForeign: parityFacts.storefrontAmountForeign } : {}) },
        resolveUser: false,
      })
    }
    await writeActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'refund_synced',
      tag: 'sync',
      level: 'INFO',
      description: `Synced WC refund for order #${so.externalOrderNumber} — ${refundAmountForeign.toFixed(2)} ${hasQtyRefund ? '(with returned quantity; only shipped units are restocked)' : '(monetary only)'}`,
      metadata: { externalRefundId: wcRefund.id, amount: refundAmountForeign, hasQtyRefund },
      resolveUser: false,
    })

    return { outcome: 'applied' }
  } catch (e) {
    // A throw says nothing about whether it can recur, so it stays RETRYABLE — the transient
    // reading, which is the direction every unrecognised condition on this branch takes.
    return { outcome: 'retryable-failure', error: String(e) }
  }
}

/**
 * The page size this walk ASKS FOR. WooCommerce pages `/orders/{id}/refunds` at TEN unless asked
 * otherwise, and 100 is the most core will serve.
 *
 * It is a REQUEST, NOT A GRANT. A store is free to answer with fewer — a `rest_post_per_page`
 * filter, a security plugin shedding load, a proxy trimming a response — and it does so with its
 * own page size and no error at all. Nothing here may therefore be inferred from this number; see
 * `fetchAllWcRefundsForOrder`.
 */
const WC_REFUND_PAGE_SIZE = 100

/**
 * A hard ceiling on one order's walk, because the walk no longer ends on a length (below) and a
 * store that ignores `page` would otherwise be asked forever. Hitting it is reported as an
 * INCOMPLETE read rather than passed off as the end of the collection.
 *
 * Fifty pages is 5,000 refunds at the size asked for, and still 500 against a store that caps
 * `per_page` at the WooCommerce default of ten — comfortably past any real order, and cheap,
 * because an order with no refunds costs exactly one request either way.
 */
const WC_REFUND_MAX_PAGES = 50

async function logIncompleteRefundRead(
  externalOrderId: number,
  failedPage: number,
  readSoFar: number,
  detail: string,
): Promise<void> {
  try {
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_refund_read_incomplete',
      tag: 'sync',
      level: 'WARNING',
      description: `Reading refunds for WooCommerce order ${externalOrderId} stopped at page ${failedPage} `
        + `after ${readSoFar} refund(s): ${detail}. Refunds beyond that point are not in IMS yet, so the `
        + 'order may show a smaller refunded amount than the store does, and a 3PL dispatch for it can be '
        + 'refused as uncovered until the next sweep reads them. The sweep re-reads the order from the '
        + 'first page each time, so this clears itself once the store responds.',
      metadata: { externalOrderId, failedPage, readSoFar, error: detail },
      resolveUser: false,
    })
  } catch {
    // Telemetry must never turn a partial read into a thrown sweep.
  }
}

/**
 * EVERY refund on the order, not the first page of them (o3d-okbd).
 *
 * `/orders/{id}/refunds` takes the collection parameters and defaults `per_page` to 10,
 * newest first. The sweep asked for the path with no parameters at all, so on an order with
 * more than ten refunds it read the ten most recent and returned as though that were the lot —
 * silently, because a short page and a capped page look identical from the caller's side.
 *
 * Ten is not a hypothetical ceiling. A partial refund per line item reaches it on an ordinary
 * multi-line order, and WooCommerce writes one refund per "Refund" press, not one per order.
 *
 * WHY IT MATTERS BEYOND THE MISSING ROWS. `findExternalFulfillmentShortfall` nets refunded
 * quantity out of the demand a 3PL dispatch has to cover, reading the refund lines IMS holds.
 * Refunds that never arrived are demand that is never netted, so the coverage check refuses a
 * dispatch that is in fact complete — and the refusal is permanent, since redelivery re-reads
 * the same truncated page. The truncation therefore does not merely lose refund history; it
 * blocks fulfilment on the orders that have the most of it.
 *
 * WHAT ENDS THE WALK, and why neither of the two things that used to is allowed to any more.
 *
 * `x-wp-totalpages` CANNOT end it. `wcFetch` parses it as `parseInt(header ?? '1')`, so a store
 * that never sends the header is INDISTINGUISHABLE from one reporting a single page: both arrive
 * as `totalPages: 1`. Ending on that number takes "the store said nothing" for "the store said
 * there is no more", which is the original one-page defect moved a layer out.
 *
 * A SHORT PAGE CANNOT END IT EITHER. `per_page=100` is a request, not a grant. A store capping
 * below it answers with its own page size and no error, so EVERY page is short and the walk stops
 * after the first one — the exact truncation this function exists to remove, reinstated. Measuring
 * against the size the store granted on page one does not save it: a granted size is not a promise
 * and nothing makes it stable across requests (a proxy trims one response, a plugin sheds load
 * mid-walk, a host lowers a filter between two calls), and a hundred then forty is indistinguishable
 * from the end of a collection.
 *
 * So an ending is not inferred from a length at all:
 *
 *   • AN EMPTY PAGE ENDS THE WALK. Whatever the store served before it, a page with nothing on it
 *     lies past the end of the collection, so everything the collection holds is already banked.
 *     That is the only unconditional proof of an ending available to a client.
 *   • A NON-EMPTY PAGE OF ANY LENGTH ADVANCES. Only the next request can tell a trimmed page from
 *     a last one.
 *
 * The cost is ONE EXTRA REQUEST per order whose refunds do not fill their last page. An order with
 * no refunds still costs one (the first page is the empty one); an order inside a single page costs
 * two, which is what it cost before, because page one could never end the walk on its own length
 * either. Paid deliberately: an under-read here REFUSES a dispatch (see above), and the alternative
 * is refusing it on every sweep forever.
 *
 * AND WHAT THE STORE SAYS IT HOLDS IS CHECKED AGAINST WHAT IT SERVED. `x-wp-total` can never END
 * the walk — a store omitting it arrives as 0, and a header cannot prove a body — but banking FEWER
 * rows than the store claims is proof of the opposite and is reported as incomplete. It is the one
 * thing that catches a page trimmed BETWEEN two others, where no length rule can help: those rows
 * are simply never served and the walk still terminates cleanly on a later empty page. The SMALLEST
 * total stated anywhere in the walk is used, so a refund CREATED mid-walk raises the claim on a
 * later page without turning a complete read into a permanent refusal.
 *
 * AND NONE OF THAT IS ABOUT THE COLLECTION — only about the pages cut out of it. `?page=N` asks for
 * rows by POSITION in whatever is there when you ask, so a refund DELETED behind the cursor shifts
 * every later row down one and the row that was going to open the next page is served to nobody.
 * Every page is full, the walk ends on an empty one, and the stated-total guard BALANCES EXACTLY,
 * because the list still carries the id of the deleted row — it is one too long by precisely the
 * amount it is one too short. Two deletions cancel twice. No arithmetic over a single walk recovers
 * the difference.
 *
 * What a single walk CAN see is the same motion running the other way. WooCommerce lists refunds
 * newest first, so a refund CREATED mid-walk takes offset 0 and pushes a row already read onto the
 * next page: A REPEATED ID INSIDE ONE WALK. Offsets do not overlap, so a repeat happens only when
 * the list moved, and it is reported as incomplete rather than banked twice.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO IS READ TWICE. The dismissal path in
 * `app/actions/sync-exceptions.ts` runs its walk twice and requires the answers to agree, because
 * its output AUTHORISES writing a refund off and a short list is indistinguishable from proof that
 * a refund is absent. This walk's output only ever WITHHOLDS: a refund that does not arrive is
 * demand `findExternalFulfillmentShortfall` never nets, so the coverage check REFUSES a dispatch —
 * and no list, however short, can approve one. A refusal is retried by the next sweep from page one.
 *
 * AN INCOMPLETE READ — a failed page, a moved list, a short-of-stated-total walk, the page ceiling
 * — returns what was read so far TOGETHER WITH THE ERROR, which is the same leniency the
 * single-page version had for a failed fetch: syncing nine of ten refunds beats syncing none. It is
 * LOGGED here rather than at the call site, because this is the only frame that can see the shape
 * of the read.
 *
 * But logging it is not the same as ACTING on it, and the log alone was the round-4 gap:
 * `syncRefundsForOrder` dropped the error and returned a bare count, so the webhook acknowledged
 * its delivery and the order-import sweep ADVANCED ITS CURSOR over an order whose refunds it had
 * only partly read. `error` therefore travels all the way out — see `RefundSweepResult` — so a
 * caller can retry the delivery or hold the cursor instead of treating a partial list as the lot.
 */
export async function fetchAllWcRefundsForOrder(
  externalOrderId: number,
): Promise<{ refunds: WcRefund[]; error?: string }> {
  const refunds: WcRefund[] = []
  // Every id banked so far, so a REPEATED one is caught. A repeat is not a WooCommerce quirk: it is
  // the signature of a collection that shifted under a positional read.
  const seen = new Set<number>()
  // The SMALLEST refund count the store stated anywhere in this walk, or null if it never stated
  // one — a store that omits `x-wp-total` arrives here as 0, which is not a claim about anything.
  let statedTotal: number | null = null

  for (let page = 1; page <= WC_REFUND_MAX_PAGES; page += 1) {
    const { data, totalItems, error } = await wcFetch(`/orders/${externalOrderId}/refunds`, {
      per_page: String(WC_REFUND_PAGE_SIZE),
      page: String(page),
    })
    if (error || !data || !Array.isArray(data)) {
      const detail = error
        ?? (data ? 'WooCommerce returned a non-list refund page' : 'WooCommerce returned no refund data')
      await logIncompleteRefundRead(externalOrderId, page, refunds.length, detail)
      return { refunds, error: detail }
    }
    if (Number.isFinite(totalItems) && totalItems > 0) {
      statedTotal = statedTotal === null ? totalItems : Math.min(statedTotal, totalItems)
    }

    for (const entry of data as WcRefund[]) {
      const id = entry?.id
      // An entry with no readable id cannot prove motion either way, so it is banked as before and
      // left to `syncWcRefund` — which is where an unusable refund payload is already handled.
      if (typeof id === 'number' && Number.isSafeInteger(id)) {
        if (seen.has(id)) {
          const detail = `WooCommerce served refund ${id} twice, on different pages, so its refund list `
            + 'moved between two requests of this read'
          await logIncompleteRefundRead(externalOrderId, page, refunds.length, detail)
          return { refunds, error: detail }
        }
        seen.add(id)
      }
      refunds.push(entry)
    }

    // THE ONLY PROOF OF AN ENDING. Checked after banking, so the empty page itself contributes
    // nothing, and before advancing, so an order with no refunds costs exactly one request.
    if (data.length === 0) {
      if (statedTotal !== null && refunds.length < statedTotal) {
        const detail = `WooCommerce says that order has ${statedTotal} refunds but served only `
          + `${refunds.length} of them`
        await logIncompleteRefundRead(externalOrderId, page, refunds.length, detail)
        return { refunds, error: detail }
      }
      return { refunds }
    }
  }

  const detail = `the refund list did not end within ${WC_REFUND_MAX_PAGES} pages`
  await logIncompleteRefundRead(externalOrderId, WC_REFUND_MAX_PAGES, refunds.length, detail)
  return { refunds, error: detail }
}

/**
 * What one order's refund sweep did, and WHETHER IT SAW THE WHOLE LIST.
 *
 * `synced` alone cannot answer the second question: a count is the same number whether the walk
 * read every refund or gave up on page two, which is how a partial read used to pass for a
 * complete one at every call site. `complete: false` means refunds on this order are still
 * unread — the caller must NOT treat the sweep as having settled the order (acknowledge a webhook
 * delivery, advance an import cursor, or conclude a refund is absent from the store).
 *
 * AND `complete` DOES NOT ANSWER A THIRD QUESTION, WHICH IS THE ONE THAT MATTERS TO A CALLER
 * DECIDING WHETHER THE ORDER IS SETTLED (o3d-xnwu r3, Codex HIGH). It is a fact about the READ, and
 * only about the read. A walk can visit every page successfully and still FAIL TO APPLY some or all
 * of what it fetched — `syncWcRefund` refuses an IMS order it cannot resolve, a refund WooCommerce
 * has already attached to a different order, and anything its own body throws — and every one of
 * those left this type saying nothing at all.
 *
 * The webhook then read the silence two different ways, both wrong: `complete && synced === 0` as
 * proof the STORE HOLDS NO REFUNDS for the order, and `complete && synced > 0` as proof EVERY
 * REFUND IS NOW IN IMS. Neither follows from a read that succeeded. So the counts the type carries
 * are the ones those sentences actually need:
 *
 *   fetched    how many refunds the walk READ. `fetched === 0` with `complete` is the only thing
 *              that means "the store holds none".
 *   unapplied  how many of those refunds are NOT in IMS afterwards. `unapplied === 0` with
 *              `complete` is the only thing that means "every refund the store holds is now in IMS".
 *
 * AND THEY ARE AGGREGATED ON APPLICATION, NOT ON SUCCESS (o3d-xnwu r4, Codex HIGH). Round 3 counted
 * a per-refund `success` boolean, and that boolean ALSO meant "handled without applying": a
 * same-order quarantined park and a chargeback-suppressed refund both returned it. The counts
 * therefore reconciled arithmetically and still misclassified — `synced + failed === fetched` held
 * while `synced` included refunds sitting in an operator's inbox, so the branch concluded every
 * fetched refund was in IMS when some were merely HANDLED. `refundIsInIms` is now the only test
 * either counter applies, and it is true for exactly the two outcomes that put a SalesOrderRefund on
 * this order.
 *
 * AND "NOT IN IMS" IS NOT THE SAME QUESTION AS "STILL WORTH WAITING FOR" (o3d-xnwu r5, Codex HIGH).
 * Round 4's caller read `unapplied > 0` as "the demand this order carries is still unknown" and held
 * the delivery on it. That is right for a refund an operator can still record and WRONG for one that
 * can never be recorded at all — a chargeback-suppressed refund, or one that already exists as a
 * SalesOrderRefund on another order. Held on those, the delivery returns 500 for ever and the cursor
 * never advances:
 * the endless retry o3d-bx9 removed, reintroduced by the fix for the opposite hole. So the walk also
 * counts how many of the unapplied refunds CAN still arrive:
 *
 *   outstanding  refunds read, not in IMS, and still reachable (`refundMayStillReachIms`) — a
 *                quarantined park, a park sitting on the WRONG order that o3d-54p's "Wrong order"
 *                recovery can move (r6), a retryable failure. `outstanding === 0` with `complete` is
 *                the only thing that means "no further waiting can change what this order carries".
 *
 * `unapplied - outstanding` is therefore the terminally-unappliable count, and a caller that settles
 * over one owes an operator a record of it — it is real refunded money that IMS deliberately does
 * not hold.
 *
 * SCALARS, NOT A LIST OF FAILURES WITH A FLAG. The decisions above are arithmetic over the whole
 * fetched set; a list invites a caller to look at one element and decide from it, which is how a
 * partial answer becomes a settled one. `synced` is kept because it is what an operator-facing
 * summary reports, but no caller may derive completeness from it: `fetched - unapplied` is the same
 * number and says which half of it is meant.
 */
export type RefundSweepResult = {
  /** Refunds that ARE in IMS after this walk — applied now or applied by an earlier delivery. */
  synced: number
  /** Refunds this walk actually read from the store. See the type header. */
  fetched: number
  /**
   * Refunds that were read and are NOT in IMS afterwards — failures of every kind AND refunds that
   * were handled without being applied. The COVERAGE question. See the type header.
   */
  unapplied: number
  /**
   * The subset of `unapplied` that could still reach IMS — a quarantined park an operator may record,
   * a park on the wrong order an operator may move back (r6), a retryable failure a later delivery
   * may apply. The SETTLEMENT question, and the only one a caller may use to decide whether holding
   * the delivery achieves anything. Always `<= unapplied`.
   */
  outstanding: number
  complete: boolean
  error?: string
}

/**
 * Check for new refunds on synced orders and process them.
 */
export async function syncRefundsForOrder(externalOrderId: number): Promise<RefundSweepResult> {
  // Every page of refunds on the order, not just the first (o3d-okbd).
  const { refunds, error } = await fetchAllWcRefundsForOrder(externalOrderId)
  let synced = 0
  let unapplied = 0
  let outstanding = 0

  // o3d-k26m.17: OLDEST FIRST. The store pages refunds newest first, so a catch-up or a backfill met the fee's repayment (a later refund) before the refund that
  // carried the fee. Each refund is also handed the whole list when it was read completely, so the fee-repayment check judges from the store's own refunds.
  // Only under the parity switch: off, the walk is the store's own order, exactly as before (it decides credit-note numbering, posting order and which refund
  // meets a cumulative ceiling first).
  const parityOn = await readParitySwitch({})
  const gmt = (value: string | undefined) => Date.parse(value ? `${value.replace(/Z$/, '')}Z` : '') || 0
  const ordered = parityOn ? [...refunds].sort((a, b) => gmt(a.date_created_gmt) - gmt(b.date_created_gmt) || a.id - b.id) : refunds
  for (const refund of ordered) {
    // o3d-7yf: BOTH the already-synced check and the parked-refund skip live in syncWcRefund now, scoped to
    // the resolved IMS order id. An externalId-only pre-skip HERE (the sweep has only the WC order id) would
    // repeat the cross-order leak — a refund/park owned by another order would wrongly skip this one.
    // syncWcRefund is idempotent for an already-synced or parked refund, so it is the single scoped authority.
    const result = parityOn ? await syncWcRefund(externalOrderId, refund, error === undefined ? { orderRefunds: refunds } : {}) : await syncWcRefund(externalOrderId, refund)
    // COUNTED ON APPLICATION, NOT INFERRED FROM SUCCESS (o3d-xnwu r4). `syncWcRefund` never throws —
    // its body ends in a catch that returns a retryable failure — so every refund read lands in
    // exactly one of these two and `synced + unapplied === fetched` holds for every walk. What
    // decides which is `refundIsInIms`, NOT whether the call reported a failure: a quarantined park
    // and a chargeback suppression are both handled endings that apply nothing, and counting them as
    // applied is what let a caller conclude the store's refunds were all in IMS when they were not.
    if (refundIsInIms(result.outcome)) {
      synced++
      continue
    }
    unapplied++
    // AND SEPARATELY: can it still get there? (o3d-xnwu r5.) Two questions, two counters, one
    // predicate each — `refundIsInIms` decides the coverage half and is not widened, and
    // `refundMayStillReachIms` decides the settlement half. Deriving the second from the first is
    // exactly the conflation r4 removed one layer down, arriving one layer up.
    if (refundMayStillReachIms(result.outcome)) outstanding++
  }

  // The refunds that WERE read are still applied — that is the deliberate leniency above. What
  // changes is that the caller is told the list was short, and told how much of it is not in IMS,
  // instead of inferring either from a number that cannot carry them.
  return { synced, fetched: refunds.length, unapplied, outstanding, complete: error === undefined, error }
}
