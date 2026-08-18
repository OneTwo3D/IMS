/**
 * WooCommerce → IMS refund sync.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { isExternalRefundIdUniqueConflict } from '@/lib/domain/sales/refund-idempotency'
import { REFUND_TOTAL_EPSILON } from '@/lib/domain/sales/o2c-guards'
import { REFUND_PARK_MANUAL_RESOLUTION_HINT } from '@/lib/domain/sales/refund-manual-resolution'
import { FULL_REFUND_RATIO } from '@/lib/domain/sales/refund-thresholds'
import type { WcRefund, WcRefundLineItem } from './types'
import type { createRefund as createRefundAction } from '@/app/actions/sales'

type CreateRefundAction = typeof createRefundAction

export type WcRefundSyncDependencies = {
  db?: Pick<typeof db, 'salesOrder' | 'salesOrderRefund' | 'warehouse' | 'shoppingSyncLog' | '$transaction'>
  createRefund?: CreateRefundAction
  logActivity?: typeof logActivity
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
      connector: 'woocommerce',
      direction: 'FROM_CONNECTOR',
      entityType: 'SalesOrder',
      externalId,
      entityId: soId,
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
  // entityType, actionable status, externalId, and entityId NOT NULL) so this can never pick up an
  // order-import failure log (same connector/type but no entityId) that happens to share an externalId.
  const parkWhere: Prisma.ShoppingSyncLogWhereInput = {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    externalId: input.externalId,
    entityId: { not: null },
    status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
  }
  const data = {
    connector: 'woocommerce' as const,
    direction: 'FROM_CONNECTOR' as const,
    status: input.status,
    entityType: 'SalesOrder',
    entityId: input.soId,
    externalId: input.externalId,
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

export async function syncWcRefund(
  externalOrderId: number,
  wcRefund: WcRefund,
  dependencies: WcRefundSyncDependencies = {},
): Promise<{ success: boolean; error?: string }> {
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
        fxRateToBase: true,
        totalBase: true,
        // o3d-w00: taxBase is what makes the gross->net conversion basis CHECKABLE — the header rate is
        // only trusted when it reproduces the order's own VAT (resolveMonetaryRefundVatRate).
        taxBase: true,
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
            id: true, productId: true, externalLineItemId: true, description: true, qty: true, totalBase: true,
            taxBase: true,
            taxForeign: true,
            taxRate: { select: { rate: true, reverseCharge: true } },
          },
        },
      },
    })
    if (!so) return { success: false, error: `IMS order not found for WC order ${externalOrderId}` }

    // Check if already processed. externalRefundId is GLOBALLY unique, so a matching refund may belong to
    // ANOTHER order — o3d-7yf: verify ownership. Same order => idempotent success; different order => fail
    // closed rather than silently reporting "handled" and leaving THIS order without its refund.
    const existing = await client.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id }, select: { orderId: true } })
    if (existing) {
      if (existing.orderId === so.id) {
        // Already synced. A prior delivery may have committed the refund but then failed a post-commit step
        // and written a FAILED park — every later delivery lands here, so resolve that lingering park now
        // rather than leaving it actionable forever (inbox / deletion+rebind guard / retention exemption).
        await resolveActionableParks(client, so.id, String(wcRefund.id))
        return { success: true }
      }
      return { success: false, error: `WooCommerce refund ${wcRefund.id} already exists on a different order (${existing.orderId}); refusing to apply it here.` }
    }

    // o3d-iup: a refund we deliberately PARKED (a monetary-only refund the order can't tax uniformly)
    // creates no SalesOrderRefund, so without this guard the sweep would re-import and re-refuse it every
    // run. o3d-7yf: check EVERY actionable park (the index keeps at most one per externalId), scoped by
    // order. A park for refund X on a DIFFERENT order fails closed (never apply X to two orders). This
    // order's QUARANTINED park is "handled" (awaiting operator resolution — not retryable); a PENDING/FAILED
    // park is this order's own retryable state, so fall through and let the sync re-attempt it.
    const parked = await client.shoppingSyncLog.findFirst({
      where: {
        connector: 'woocommerce',
        direction: 'FROM_CONNECTOR',
        entityType: 'SalesOrder',
        externalId: String(wcRefund.id),
        entityId: { not: null },
        status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
      },
      select: { entityId: true, status: true },
    })
    if (parked && parked.entityId !== so.id) {
      return { success: false, error: `WooCommerce refund ${wcRefund.id} is already parked for a different order (${parked.entityId}); refusing to process it for this order.` }
    }
    if (parked && parked.status === 'QUARANTINED') {
      return { success: true } // this order's quarantined park — handled, not retryable
    }

    const fxRate = toDecimal(so.fxRateToBase).gt(0) ? toDecimal(so.fxRateToBase) : toDecimal(1)
    const refundAmountForeign = parseDecimalAbs(wcRefund.amount)

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
    }[] = []

    if (wcRefund.line_items.length > 0 && hasQtyRefund) {
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
        })
      }
    }

    for (const shippingLine of wcRefund.shipping_lines ?? []) {
      const shippingRefundTotal = parseDecimalAbs(shippingLine.total)
      if (shippingRefundTotal.lte(0.000001)) continue
      mappedGrossForeign = mappedGrossForeign.add(shippingRefundTotal).add(parseDecimalAbs(shippingLine.total_tax))
      refundLines.push({
        productId: null,
        description: shippingLine.method_title || 'Shipping refund',
        qty: 0,
        totalForeign: roundDecimalNumber(shippingRefundTotal, 4),
        totalBase: divideRoundedNumber(shippingRefundTotal, fxRate, 4),
        lineKind: 'shipping',
      })
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
      const basis = resolveMonetaryRefundVatRate(so)
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
        return { success: false, error }
      }
      const netForeign = toDecimal(refundAmountForeign).div(toDecimal(1).add(basis.vatRate))
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

    const mappedGrossRounded = roundDecimalNumber(mappedGrossForeign, 4)
    if (refundLines.length > 0 && toDecimal(mappedGrossRounded).sub(refundAmountForeign).abs().gt(0.01)) {
      const error = `WooCommerce refund ${wcRefund.id} amount mismatch: mapped ${toDecimal(mappedGrossRounded).toFixed(2)} but refund total is ${refundAmountForeign.toDecimalPlaces(2).toFixed(2)}`
      await upsertRefundPark(client, {
        soId: so.id,
        externalId: String(wcRefund.id),
        status: 'PENDING',
        errorMessage: error,
        payload: wcRefund,
      })
      return {
        success: false,
        error,
      }
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
        { internalBypassToken: INTERNAL_ACTION_BYPASS, externalRefundId: wcRefund.id },
      )
    } catch (error) {
      if (!isExternalRefundIdUniqueConflict(error)) throw error
      // o3d-7yf: the unique violation may be a CROSS-ORDER race — the refund that won the externalRefundId
      // could belong to another order. Verify ownership before recording a SYNCED dedup log for THIS order;
      // otherwise the loser is falsely marked synced while its refund lives on a different order.
      const winner = await client.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id }, select: { orderId: true } })
      if (winner && winner.orderId !== so.id) {
        return { success: false, error: `WooCommerce refund ${wcRefund.id} was concurrently created on a different order (${winner.orderId}); refusing to mark it synced here.` }
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
      return { success: true }
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
          description: `WooCommerce refund ${wcRefund.id} on order #${so.externalOrderNumber} was not recorded — the order was already charged back by the payment poller, and a second credit note would double-reverse it. Reconcile the Woo refund manually.${returnedNote} ${result.error ?? ''}`.trim(),
          metadata: {
            externalRefundId: wcRefund.id,
            parentOrderId: externalOrderId,
            refundedUnits,
          },
          resolveUser: false,
        })
      }
      return { success: true }
    }

    if (!result.success) {
      // o3d-iup: a deliberate refusal (result.quarantine) is PARKED, not a transient failure — record it
      // as QUARANTINED so the sweep dedup skips it (no per-sweep re-refusal loop) and FAILED dashboards
      // don't treat it as retryable. The refusal message already tells the operator to resolve it in IMS
      // and not to issue another Woo refund.
      const quarantined = result.quarantine === true
      await upsertRefundPark(client, {
        soId: so.id,
        externalId: String(wcRefund.id),
        status: quarantined ? 'QUARANTINED' : 'FAILED',
        errorMessage: result.error ?? 'refund sync failed',
        // Codex r2 #2: keep the WooCommerce refund for EVERY park, not just the basis refusal. The
        // Record-manually path reconciles the credit note it raises against the GROSS amount in this
        // payload; a park without it has no figure to check against, so the completion path it advertises
        // cannot run. This is the non-uniform-tax refusal — the commonest quarantine there is.
        payload: wcRefund,
      })
      return { success: false, error: result.error }
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

    await writeActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'refund_synced',
      tag: 'sync',
      level: 'INFO',
      description: `Synced WC refund for order #${so.externalOrderNumber} — ${refundAmountForeign.toFixed(2)} ${hasQtyRefund ? '(with restock)' : '(monetary only)'}`,
      metadata: { externalRefundId: wcRefund.id, amount: refundAmountForeign, hasRestock: hasQtyRefund },
      resolveUser: false,
    })

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * Check for new refunds on synced orders and process them.
 */
/**
 * The ORDER line item a refund line refers to.
 *
 * WooCommerce records it as the `_refunded_item_id` meta on the refund line; the line's
 * own `id` is a fresh order-item id and matches nothing on our side. Falls back to
 * rl.id so a store (or a stub) that does not emit the meta still behaves as before
 * rather than losing the link entirely.
 */
export function refundedOrderLineId(rl: WcRefundLineItem): number {
  const meta = (rl.meta_data ?? []).find((m) => m.key === '_refunded_item_id')
  const id = Number(meta?.value)
  return Number.isFinite(id) && id > 0 ? id : rl.id
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
 */
export type RefundSweepResult = { synced: number; complete: boolean; error?: string }

export async function syncRefundsForOrder(externalOrderId: number): Promise<RefundSweepResult> {
  // Every page of refunds on the order, not just the first (o3d-okbd).
  const { refunds, error } = await fetchAllWcRefundsForOrder(externalOrderId)
  let synced = 0

  for (const refund of refunds) {
    // o3d-7yf: BOTH the already-synced check and the parked-refund skip live in syncWcRefund now, scoped to
    // the resolved IMS order id. An externalId-only pre-skip HERE (the sweep has only the WC order id) would
    // repeat the cross-order leak — a refund/park owned by another order would wrongly skip this one.
    // syncWcRefund is idempotent for an already-synced or parked refund, so it is the single scoped authority.
    const result = await syncWcRefund(externalOrderId, refund)
    if (result.success) synced++
  }

  // The refunds that WERE read are still synced — that is the deliberate leniency above. What
  // changes is that the caller is told the list was short, instead of inferring completeness from
  // a number that cannot carry it.
  return { synced, complete: error === undefined, error }
}
