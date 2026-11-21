/**
 * REFUND -> CREDIT-NOTE PARITY WITH THE NOVEMBER 2026 STOREFRONT PLUGIN FIXES (o3d-k26m.17), behind `wc_refund_credit_note_parity_enabled` (default off).
 *
 * The reference behaviour is the storefront's: o3d-ioss-xero 0.2.4 (`O3D_IOSS_Hooks::decide`, credit-note branch; `O3D_IOSS_Order_Facts::refund_breakdown` /
 * `shipping_fold`) and o3d-store-credit-refund 1.1.9. Everything here is PURE: the refund sync (lib/connectors/woocommerce/sync/refund-sync.ts) reads the facts
 * and acts on the verdicts, and the credit-note settlement plan (lib/domain/accounting/credit-note-allocation.ts) reads the columns the writer stores.
 *
 *   1. THE EAS FEE GAP. EAS re-prices a refund and leaves the landed-cost (wclc) fee out of the refund AMOUNT while the fee ITEMS stay on the refund
 *      (166122 / refund 166128: items 20.86, amount 17.86). Owner ruling 2026-11-18: a fee item on a refund means the fee IS refunded. On the exact signature
 *      only (items less marked fees equal the amount to the cent, goods refunded too, every item a credit, every marked fee with a total of its own and a link
 *      to the fee it refunds, shipping as charged) the credit note credits the ITEM total, and the refund records the gap so the fee's separate repayment is
 *      applied to that credit note.
 *   2. THE FEE REPAYMENT. The fee money then comes back as a second refund that refunds no goods and no fee (EAS books it as VAT on zero-total goods: 166130,
 *      amount 3.00). If an earlier refund on the order carried a marked fee it is HELD, never a second credit note.
 *   3. THE SHIPPING FOLD. EAS also folds the fees into the refund's SHIPPING line while the fee items stay (177725: shipping 19.06 against 14.06 charged; lines
 *      102.18 against 96.23 paid). Recognised exactly (the shipping excess equals the marked fees in net AND in VAT, and the lines less those fees equal the
 *      amount): shipping is restored to what was charged and the amount is expected. Anything close but not exact is held; the inflated total is never credited.
 *   6. STORE CREDIT. A refund issued as store credit (o3d-store-credit-refund: `_o3d_scr_attempt` on the refund, not paid through the gateway) gets a credit note
 *      numbered SC-<refund id> that is never allocated; and none at all until the store credit is live (the plugin's own hold, `_o3d_scr_xero_held`, or the
 *      order's unfinished-attempt record `_o3d_scr_incomplete` naming it).
 */
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { withLedgerCheck } from '@/lib/domain/accounting/hand-post-instruction'

/** The system switch (lib/domain/settings/system-switches.ts). ON only for the exact string `true`. */
export const REFUND_CN_PARITY_SETTING_KEY = 'wc_refund_credit_note_parity_enabled'

export async function isRefundCnParityEnabled(client: { setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> } }): Promise<boolean> {
  const row = await client.setting.findUnique({ where: { key: REFUND_CN_PARITY_SETTING_KEY }, select: { value: true } })
  return row?.value === 'true'
}

/** The credit-note number of a store-credit refund: its own series, as o3d-store-credit-refund 1.1.9 numbers Xeroom's. */
export const STORE_CREDIT_CREDIT_NOTE_PREFIX = 'SC-'
export function storeCreditCreditNoteNumber(externalRefundId: number): string {
  return `${STORE_CREDIT_CREDIT_NOTE_PREFIX}${externalRefundId}`
}

/** What the refund sync hands the refund writer under the switch (persisted on SalesOrderRefund: storeCreditRefund, easFeeGapForeign, storefrontAmountForeign). */
export type RefundParityFactsInput = { storeCreditRefund?: boolean; easFeeGapForeign?: number; storefrontAmountForeign?: number }

/** Item meta the wclc plugin stamps on every landed-cost fee it adds. */
export const WCLC_FEE_MARKER_META = '_wclc_fee'
/** o3d-store-credit-refund: the attempt id on its own refund, its Xero hold on the refund, and the order's record of an unfinished attempt. */
export const STORE_CREDIT_ATTEMPT_META = '_o3d_scr_attempt'
export const STORE_CREDIT_XERO_HELD_META = '_o3d_scr_xero_held'
export const STORE_CREDIT_INCOMPLETE_META = '_o3d_scr_incomplete'

type Meta = { key?: string; value?: unknown }

function metaValue(meta: readonly Meta[] | null | undefined, key: string): unknown {
  return (meta ?? []).find((entry) => entry?.key === key)?.value
}

/** Rounded to the cent, as WooCommerce and the plugins present each item. */
function cents(value: DecimalInput | null | undefined): number {
  const n = toDecimal(value ?? 0).toNumber()
  return Number.isFinite(n) ? Math.round(n * 100) : NaN
}

const money = (minor: number) => (minor / 100).toFixed(2)

/** One refund item as the breakdown reads it: its type, its total and tax as WooCommerce reports them (credits negative), and for a fee what it is. */
export type ParityRefundItem = {
  type: 'line' | 'shipping' | 'fee'
  total: DecimalInput | null | undefined
  tax: DecimalInput | null | undefined
  name?: string
  /** A fee carrying the wclc marker, on the refund item itself or on the order fee line it refunds. */
  marked?: boolean
  /** The item names the order item it refunds (`_refunded_item_id`). */
  linked?: boolean
}

export type ParityBreakdown = {
  /** Everything the refund itemises, as a positive figure, in minor units. */
  grossMinor: number
  /** Its marked fees, gross, net and VAT, positive, in minor units. */
  feeGrossMinor: number
  feeNetMinor: number
  feeTaxMinor: number
  /** Non-fee items with a total of their own. */
  goods: number
  /** Unmarked fees with a total of their own. */
  otherFees: number
  /** Marked fee items. */
  markedFees: number
  /** Some item is a charge rather than a credit. */
  positive: boolean
  /** A marked fee carries no total of its own. */
  emptyFee: boolean
  /** Every marked fee names the fee it refunds. */
  feesLinked: boolean
  unreadable: boolean
}

/** `O3D_IOSS_Order_Facts::refund_breakdown`. Each item is rounded to the cent before it is added. */
export function parityRefundBreakdown(items: readonly ParityRefundItem[]): ParityBreakdown {
  let signed = 0
  let fee = 0
  let feeNet = 0
  let feeTax = 0
  let goods = 0
  let otherFees = 0
  let markedFees = 0
  let positive = false
  let emptyFee = false
  let feesLinked = true
  let unreadable = false
  for (const item of items) {
    const total = cents(item.total)
    const tax = cents(item.tax)
    if (!Number.isFinite(total) || !Number.isFinite(tax)) { unreadable = true; continue }
    if (total > 0 || tax > 0) positive = true
    signed += total + tax
    if (item.type === 'fee' && item.marked === true) {
      markedFees += 1
      fee += total + tax
      feeNet += total
      feeTax += tax
      if (total === 0) emptyFee = true
      if (item.linked !== true) feesLinked = false
    } else if (total !== 0) {
      if (item.type === 'fee') otherFees += 1
      else goods += 1
    }
  }
  return { grossMinor: -signed, feeGrossMinor: -fee, feeNetMinor: -feeNet, feeTaxMinor: -feeTax, goods, otherFees, markedFees, positive, emptyFee, feesLinked, unreadable }
}

/** What the order charged for shipping, net and VAT, in the order currency. Null when IMS cannot say (the figures are not stored). */
export type ChargedShipping = { net: DecimalInput; tax: DecimalInput } | null

export type AmountGapVerdict =
  /** Not one of the shapes this module recognises: the sync's ordinary amount-mismatch handling applies. */
  | { kind: 'not-recognised' }
  /** The EAS fee gap, exactly: credit the item total; `feeGapMinor` is the fee left out of the amount. */
  | { kind: 'fee-gap'; creditedGrossMinor: number; feeGapMinor: number }
  /** The EAS shipping fold, exactly: restore shipping to what was charged (`shippingNet` / `shippingTax`), and the lines then total the amount. */
  | { kind: 'fold'; shippingNet: string; shippingTax: string; excessNet: string; excessTax: string }
  /** Close to a fee gap or a fold but not exact: held for a person, never credited at the inflated total. */
  | { kind: 'hold'; message: string }

/**
 * THE AMOUNT GAP between what a storefront refund itemises and what it paid (`O3D_IOSS_Hooks::decide`, the fee-gap and fold arms). Called only when the two
 * differ. `refundShipping` is the refund's shipping lines with a total (net and tax, credits negative); `charged` is what the order charged for shipping.
 * IMS stores the order's shipping as one figure, so a refund with more than one shipping line is compared against that one figure: it never folds, and
 * a fee-gap shape on it is held unless its shipping lines together equal the charge exactly.
 */
export function decideAmountGap(input: {
  refundId: number | string
  amount: DecimalInput
  breakdown: ParityBreakdown
  refundShipping: ReadonlyArray<{ total: DecimalInput | null | undefined; tax: DecimalInput | null | undefined; name?: string }>
  charged: ChargedShipping
}): AmountGapVerdict {
  const b = input.breakdown
  const amountMinor = cents(input.amount)
  if (b.unreadable || !Number.isFinite(amountMinor)) return { kind: 'not-recognised' }
  const paid = Math.abs(amountMinor)
  const linesLessFees = b.grossMinor - b.feeGrossMinor

  // THE FOLD, recognised first and exactly (`shipping_fold`): the shipping excess over what was charged equals the marked fees in net AND VAT, to the cent.
  const chargedNet = input.charged === null ? NaN : Math.abs(cents(input.charged.net))
  const chargedTax = input.charged === null ? NaN : Math.abs(cents(input.charged.tax))
  const shipNet = input.refundShipping.reduce((sum, line) => sum + Math.abs(cents(line.total)), 0)
  const shipTax = input.refundShipping.reduce((sum, line) => sum + Math.abs(cents(line.tax)), 0)
  const chargeKnown = Number.isFinite(chargedNet) && Number.isFinite(chargedTax) && Number.isFinite(shipNet) && Number.isFinite(shipTax)
  if (b.feeNetMinor > 0 && chargeKnown && input.refundShipping.length === 1 && !b.positive
    && shipNet - chargedNet === b.feeNetMinor && shipTax - chargedTax === b.feeTaxMinor
    && linesLessFees === paid) {
    return { kind: 'fold', shippingNet: money(chargedNet), shippingTax: money(chargedTax), excessNet: money(b.feeNetMinor), excessTax: money(b.feeTaxMinor) }
  }

  // Lines less fees equal to the amount is ALSO what a folded refund looks like, so the fee-gap allowance is only safe when shipping is exactly what was charged.
  const feeGapShape = b.feeGrossMinor > 0 && b.grossMinor > paid && linesLessFees === paid
  if (!feeGapShape) return { kind: 'not-recognised' }
  const shippingAsCharged = input.refundShipping.length === 0 || (chargeKnown && shipNet === chargedNet && shipTax === chargedTax)
  if (!shippingAsCharged) {
    const refunded = input.refundShipping.map((line) => `"${line.name ?? 'Shipping'}" refunded ${money(Math.abs(cents(line.total)))} + ${money(Math.abs(cents(line.tax)))} VAT`).join('; ')
    const charged = chargeKnown ? `${money(chargedNet)} + ${money(chargedTax)} VAT` : 'unknown to IMS'
    return {
      kind: 'hold',
      message: withLedgerCheck(`WooCommerce refund ${input.refundId} cannot be credited automatically: its lines total ${money(b.grossMinor)} but ${money(paid)} was paid back, and its shipping is not what was charged (${refunded}; the order charged ${charged}). `
        + `If EAS put the fees on the shipping line as well as on the fee lines, record it with shipping set back to what was charged, totalling ${money(paid)}; if the fees were genuinely left out of the amount, record it at ${money(b.grossMinor)} with the fees included. `
        + `Nothing was recorded and nothing was sent to Xero. The money has ALREADY been returned in the storefront (refund ${input.refundId}) - do NOT issue another storefront refund.`),
    }
  }
  // Only the exact signature: something paid out, goods refunded as well, every item a credit, every fee with a total and a link of its own.
  if (paid > 0 && b.goods > 0 && !b.positive && !b.emptyFee && b.markedFees > 0 && b.feesLinked) {
    return { kind: 'fee-gap', creditedGrossMinor: b.grossMinor, feeGapMinor: b.feeGrossMinor }
  }
  return { kind: 'not-recognised' }
}

/** An earlier refund on the same order, as the fee-repayment check reads it. */
export type EarlierRefundFacts = {
  creditNoteNumber: string | null
  externalRefundId: number | null
  /** A line of it refunds an order fee line carrying the wclc marker. */
  carriedMarkedFee: boolean
  /** The fee gap it recorded (fee credited beyond what it paid), when it did. */
  easFeeGapForeign: DecimalInput | null
}

/**
 * THE FEE REPAYMENT (`decide`, the "refunds no goods" arm): a storefront refund that pays money out but refunds no goods and no fee, on an order where an earlier
 * refund carried a marked fee, is held with an instruction; a refund of any other shape, or on an order with no such earlier refund, is not this (null).
 */
export function feeRepaymentHold(input: { refundId: number | string; amount: DecimalInput; currency: string; breakdown: ParityBreakdown; earlier: readonly EarlierRefundFacts[] }): string | null {
  const b = input.breakdown
  const paid = Math.abs(cents(input.amount))
  if (!Number.isFinite(paid) || paid <= 0 || b.goods !== 0 || b.otherFees !== 0 || b.markedFees !== 0 || b.feeGrossMinor > 0) return null
  const feeCarriers = input.earlier.filter((refund) => refund.carriedMarkedFee || toDecimal(refund.easFeeGapForeign ?? 0).gt(0))
  if (feeCarriers.length === 0) return null
  const owedMinor = feeCarriers.reduce((sum, refund) => sum + Math.abs(cents(refund.easFeeGapForeign ?? 0)), 0)
  const gapCarriers = feeCarriers.filter((refund) => toDecimal(refund.easFeeGapForeign ?? 0).gt(0))
  const name = (refund: EarlierRefundFacts) => `credit note ${refund.creditNoteNumber ?? '(no number)'}${refund.externalRefundId != null ? ` (WooCommerce refund ${refund.externalRefundId})` : ''}`
  const tail = ` Nothing was recorded and nothing was sent to Xero. The money has ALREADY been returned in the storefront (refund ${input.refundId}) - do NOT issue another storefront refund.`
  if (owedMinor > 0 && owedMinor === paid) {
    return withLedgerCheck(`WooCommerce refund ${input.refundId} refunds no goods and pays ${money(paid)} ${input.currency}, the landed-cost fee ${gapCarriers.map(name).join(' and ')} already credits beyond what it paid. `
      + `It is the fee's repayment, not a new credit: apply this payment (${money(paid)} ${input.currency}) to that credit note in Xero, then dismiss this refund here.${tail}`)
  }
  if (owedMinor > 0) {
    return withLedgerCheck(`WooCommerce refund ${input.refundId} pays ${money(paid)} ${input.currency} but refunds no goods, on an order whose landed-cost fee ${gapCarriers.map(name).join(' and ')} credits (${money(owedMinor)} ${input.currency} of it not yet paid back); `
      + `check by hand what it repays before crediting it.${tail}`)
  }
  return withLedgerCheck(`WooCommerce refund ${input.refundId} pays ${money(paid)} ${input.currency} but refunds no goods, and the landed-cost fee on this order was already refunded within ${feeCarriers.map(name).join(' and ')}; `
    + `this looks like a second payment of the fee - check by hand before crediting it.${tail}`)
}

/** The attempt id of a refund issued as store credit by o3d-store-credit-refund (`is_store_credit_refund`), or null. */
export function storeCreditAttemptOf(refund: { meta_data?: readonly Meta[] | null; refunded_payment?: boolean | null }): string | null {
  const attempt = metaValue(refund.meta_data, STORE_CREDIT_ATTEMPT_META)
  if (typeof attempt !== 'string' && typeof attempt !== 'number') return null
  const text = String(attempt).trim()
  if (text === '') return null
  if (refund.refunded_payment === true) return null
  return text
}

/**
 * Why a store-credit refund's credit note must wait, or null when the store credit is live. The plugin's Xero hold on the refund (`1` held, `sending` part-sent),
 * or the order's unfinished-attempt record naming this attempt or this refund. `orderMeta` null means the order could not be read: the caller retries.
 */
export function storeCreditHoldReason(input: { refundId: number; attempt: string; refundMeta: readonly Meta[] | null | undefined; orderMeta: readonly Meta[] }): string | null {
  const held = metaValue(input.refundMeta, STORE_CREDIT_XERO_HELD_META)
  const heldText = typeof held === 'string' || typeof held === 'number' ? String(held).trim() : ''
  const incomplete = metaValue(input.orderMeta, STORE_CREDIT_INCOMPLETE_META)
  const record = incomplete !== null && typeof incomplete === 'object' ? incomplete as Record<string, unknown> : null
  const names = record !== null && (String(record.attempt ?? '').trim() === input.attempt || Number(record.refund_id) === input.refundId)
  if (heldText !== '' || names) {
    const why = names ? `the order still records the store-credit attempt as unfinished (stage ${String(record?.stage ?? 'unknown')})` : `the refund is still held for Xero by the store-credit plugin (${heldText})`
    return `WooCommerce refund ${input.refundId} was issued as store credit, and ${why}, so the store credit is not live yet. `
      + 'No credit note is raised until it is: the refund is retried on the next sweep and recorded once the coupon is published. If the attempt failed, finish or cancel it from the order in WooCommerce.'
  }
  return null
}
