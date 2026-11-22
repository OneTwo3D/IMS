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
 *      numbered SC-<refund id> that is never allocated; and none at all until the store credit is POSITIVELY live: a PUBLISHED coupon carrying the same
 *      `_o3d_scr_attempt`. The absence of the plugin's markers proves nothing (its discard and coupon-gone paths clear `_o3d_scr_incomplete` and leave the
 *      refund; with Xeroom off it never writes `_o3d_scr_xero_held`), so a refund with no live coupon is QUARANTINED for a person.
 */
import { Prisma } from '@/app/generated/prisma/client'
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

/** Rounded to the cent half away from zero, as PHP's round() rounds each item for WooCommerce and the plugins. */
function cents(value: DecimalInput | null | undefined): number {
  let d
  try { d = toDecimal(value ?? 0) } catch { return NaN }
  if (!d.isFinite()) return NaN
  return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).times(100).toNumber()
}

const money = (minor: number) => (minor / 100).toFixed(2)

/** A payment-gateway fee line ("Stripe fee"): the storefront's Xero plugin never puts it on a credit note, so it is left out of the comparison (`is_gateway_fee`). */
export function isGatewayFeeName(name: string | null | undefined): boolean {
  return (name ?? '').trim().toLowerCase() === 'stripe fee'
}

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
  /** Everything the refund itemises (gateway fees excepted), as a positive figure, in minor units. */
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
  /** Gateway fee items, left out of every figure above. */
  gatewayFees: number
  /** Some item is a charge rather than a credit. */
  positive: boolean
  /** A marked fee carries no total of its own. */
  emptyFee: boolean
  /** Every marked fee names the fee it refunds. */
  feesLinked: boolean
  unreadable: boolean
}

/** `O3D_IOSS_Order_Facts::refund_breakdown`. Each item is rounded to the cent before it is added; gateway fees are left out. */
export function parityRefundBreakdown(items: readonly ParityRefundItem[]): ParityBreakdown {
  let signed = 0
  let fee = 0
  let feeNet = 0
  let feeTax = 0
  let goods = 0
  let otherFees = 0
  let markedFees = 0
  let gatewayFees = 0
  let positive = false
  let emptyFee = false
  let feesLinked = true
  let unreadable = false
  for (const item of items) {
    if (item.type === 'fee' && isGatewayFeeName(item.name)) { gatewayFees += 1; continue }
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
  return { grossMinor: -signed, feeGrossMinor: -fee, feeNetMinor: -feeNet, feeTaxMinor: -feeTax, goods, otherFees, markedFees, gatewayFees, positive, emptyFee, feesLinked, unreadable }
}

/**
 * One refunded shipping line with money on it (net or VAT: a tax-only line counts), and what its OWN original order shipping line charged, found through
 * `_refunded_item_id`. `charged` null: the line names no original, or the original could not be read; such a refund is never folded and never credited on the
 * fee-gap allowance.
 */
export type ParityShippingLine = { total: DecimalInput | null | undefined; tax: DecimalInput | null | undefined; name?: string; charged: { net: DecimalInput; tax: DecimalInput } | null }

export type AmountGapVerdict =
  /** No landed-cost fee on the refund: the sync's ordinary amount-mismatch handling applies. */
  | { kind: 'not-recognised' }
  /** The EAS fee gap, exactly: credit the item total; `feeGapMinor` is the fee left out of the amount. */
  | { kind: 'fee-gap'; creditedGrossMinor: number; feeGapMinor: number }
  /** The EAS shipping fold, exactly: each listed refund shipping line (by index) is restored to what its original charged, and the lines then total the amount. */
  | { kind: 'fold'; restore: Array<{ index: number; net: string; tax: string }>; excessNet: string; excessTax: string }
  /** A landed-cost fee is on the refund and its lines and amount disagree, but not in either exact shape: held for a person, never credited at the inflated total. */
  | { kind: 'hold'; message: string }

/**
 * Said on every parity hold and quarantine, and how the Sync exceptions page recognises one (`isRefundParityHold`): "Record manually" raises a credit note,
 * which here would credit the fee a second time, credit an inflated total, or raise a non-SC credit note for store credit that was never issued.
 */
export const PARITY_NO_MANUAL_RECORD = ' Do not use "Record manually" on this row: the credit note it raises is wrong here (it would credit the landed-cost fee a second time, credit an inflated total, or raise an ordinary credit note for store credit). This refund is settled in Xero, with the accountant, and this row is closed with "Settled outside IMS", naming the Xero credit note it was settled with.'

/** #1127 R1 L9: the sentence the first parity holds were written with; still recognised, so a park written before the rewording stays a parity hold. */
const PARITY_NO_MANUAL_RECORD_LEGACY = 'Do not use "Record manually" on this row: the credit note it raises is wrong here (it would credit the landed-cost fee a second time, credit an inflated total, or raise an ordinary credit note for store credit). This refund is settled in Xero, with the accountant, and the row stays on Sync exceptions as the record of it.'

/** Whether a refund park was written by one of the parity holds (its message carries PARITY_NO_MANUAL_RECORD). */
export function isRefundParityHold(errorMessage: string | null | undefined): boolean {
  return typeof errorMessage === 'string' && (errorMessage.includes(PARITY_NO_MANUAL_RECORD.trim()) || errorMessage.includes(PARITY_NO_MANUAL_RECORD_LEGACY))
}

const HOLD_TAIL = (refundId: number | string) => ` Nothing was recorded and nothing was sent to Xero. The money has ALREADY been returned in the storefront (refund ${refundId}) - do NOT issue another storefront refund.${PARITY_NO_MANUAL_RECORD}`

/**
 * THE AMOUNT GAP between what a storefront refund itemises and what it paid (`O3D_IOSS_Hooks::decide`, the fee-gap and fold arms; `shipping_fold`,
 * `shipping_as_charged`). Called only when the two differ.
 */
export function decideAmountGap(input: { refundId: number | string; amount: DecimalInput; breakdown: ParityBreakdown; refundShipping: readonly ParityShippingLine[] }): AmountGapVerdict {
  const b = input.breakdown
  if (b.markedFees === 0) return { kind: 'not-recognised' }
  const amountMinor = cents(input.amount)
  const paid = Math.abs(amountMinor)
  const linesLessFees = b.grossMinor - b.feeGrossMinor
  const hold = (why: string, extra = ''): AmountGapVerdict => ({
    kind: 'hold',
    message: withLedgerCheck(`WooCommerce refund ${input.refundId} cannot be credited automatically: its lines total ${money(b.grossMinor)}, of which ${money(b.feeGrossMinor)} is landed-cost fees, but ${Number.isFinite(paid) ? money(paid) : 'an unreadable amount'} was paid back, and ${why}. `
      + `${extra}Establish from the storefront what was refunded and settle its credit note in Xero by hand, with the accountant: if EAS left the fees out of the amount, at ${money(b.grossMinor)} with the fees included; if EAS also put them on the shipping line, with shipping set back to what was charged, totalling ${Number.isFinite(paid) ? money(paid) : 'the amount'}.`
      + HOLD_TAIL(input.refundId)),
  })
  if (b.unreadable || !Number.isFinite(amountMinor)) return hold('a figure on it cannot be read')

  const describe = () => input.refundShipping.map((line) => `"${line.name ?? 'Shipping'}" refunded ${money(Math.abs(cents(line.total)))} + ${money(Math.abs(cents(line.tax)))} VAT, charged ${line.charged ? `${money(Math.abs(cents(line.charged.net)))} + ${money(Math.abs(cents(line.charged.tax)))} VAT` : 'unknown (no link to its order line)'}`).join('; ')
  const allMapped = input.refundShipping.every((line) => line.charged !== null)

  // THE FOLD, recognised first and exactly (`shipping_fold`): every refund shipping line names its original; the excess of those above what was charged equals
  // the marked fees in net AND VAT, to the cent; and the lines less those fees equal what was paid.
  if (allMapped && b.feeNetMinor > 0 && !b.positive) {
    let excessNet = 0
    let excessTax = 0
    const restore: Array<{ index: number; net: string; tax: string }> = []
    input.refundShipping.forEach((line, index) => {
      const rNet = Math.abs(cents(line.total))
      const rTax = Math.abs(cents(line.tax))
      const oNet = Math.abs(cents(line.charged!.net))
      const oTax = Math.abs(cents(line.charged!.tax))
      if (rNet > oNet) {
        excessNet += rNet - oNet
        excessTax += rTax - oTax
        restore.push({ index, net: money(oNet), tax: money(oTax) })
      }
    })
    if (restore.length > 0 && excessNet === b.feeNetMinor && excessTax === b.feeTaxMinor && linesLessFees === paid) {
      if (b.gatewayFees > 0) return hold('a payment-gateway fee is on it as well, which the storefront\'s credit note leaves out and IMS cannot reconcile automatically')
      return { kind: 'fold', restore, excessNet: money(excessNet), excessTax: money(excessTax) }
    }
  }

  // Lines less fees equal to the amount is ALSO what a folded refund looks like, so the fee-gap allowance is only safe when every shipping line is exactly what its
  // own original charged.
  const asCharged = input.refundShipping.every((line) => line.charged !== null
    && Math.abs(cents(line.total)) === Math.abs(cents(line.charged.net)) && Math.abs(cents(line.tax)) === Math.abs(cents(line.charged.tax)))
  const feeGapShape = b.feeGrossMinor > 0 && b.grossMinor > paid && linesLessFees === paid
  if (feeGapShape && !asCharged) return hold(`its shipping is not what was charged (${describe()})`)
  if (!feeGapShape) {
    return hold(linesLessFees > paid
      ? `the lines less the fees (${money(linesLessFees)}) are more than was paid, so this is not EAS leaving the fees out of the amount`
      : `the lines less the fees (${money(linesLessFees)}) are not what was paid${input.refundShipping.length > 0 ? ` (shipping: ${describe()})` : ''}`)
  }
  // Only the exact signature: something paid out, goods refunded as well, every item a credit, every fee with a total and a link of its own.
  const failed: string[] = []
  if (paid <= 0) failed.push('it paid nothing back')
  if (b.goods === 0) failed.push('it refunds no goods')
  if (b.positive) failed.push('an item on it is a charge, not a credit')
  if (b.emptyFee) failed.push('a landed-cost fee on it has no amount of its own')
  if (!b.feesLinked) failed.push('a landed-cost fee on it does not name the order fee it refunds')
  if (b.gatewayFees > 0) failed.push('a payment-gateway fee is on it as well')
  if (failed.length > 0) return hold(`it is not the exact EAS fee-gap shape: ${failed.join('; ')}`)
  return { kind: 'fee-gap', creditedGrossMinor: b.grossMinor, feeGapMinor: b.feeGrossMinor }
}

/**
 * The landed-cost fee an EARLIER refund credited beyond what it paid (the gap still owed), from its own breakdown, as the plugin judges the order's other refunds:
 * a refund whose fees were folded into shipping, or whose lines did not exceed what it paid, paid its fee back within its amount (owed 0).
 */
export function earlierFeeOwedMinor(input: { breakdown: ParityBreakdown; amount: DecimalInput; folded: boolean }): number {
  if (input.breakdown.feeGrossMinor <= 0 || input.folded) return 0
  return input.breakdown.grossMinor <= Math.abs(cents(input.amount)) ? 0 : input.breakdown.feeGrossMinor
}

/** An earlier refund on the same order (in WooCommerce, recorded in IMS, or parked), as the fee-repayment check reads it. */
export type EarlierRefundFacts = {
  /** How the operator finds it: "WooCommerce refund 166128 (credit note CN-00042)". */
  label: string
  /** It carries a landed-cost fee item. */
  carriedMarkedFee: boolean
  /** The fee it credited beyond what it paid, in minor units (0: none, or paid within its amount). */
  owedMinor: number
}

/**
 * THE FEE REPAYMENT (`decide`, the "refunds no goods" arm): a storefront refund that pays money out but refunds no goods and no fee, on an order where an earlier
 * refund carried a marked fee, is held with an instruction; a refund of any other shape, or on an order with no such earlier refund, is not this (null).
 */
export function feeRepaymentHold(input: { refundId: number | string; amount: DecimalInput; currency: string; breakdown: ParityBreakdown; earlier: readonly EarlierRefundFacts[] }): string | null {
  const b = input.breakdown
  const paid = Math.abs(cents(input.amount))
  if (!Number.isFinite(paid) || paid <= 0 || b.goods !== 0 || b.otherFees !== 0 || b.markedFees !== 0 || b.feeGrossMinor > 0) return null
  const feeCarriers = input.earlier.filter((refund) => refund.carriedMarkedFee || refund.owedMinor > 0)
  if (feeCarriers.length === 0) return null
  const owed = feeCarriers.filter((refund) => refund.owedMinor > 0)
  const owedMinor = owed.reduce((sum, refund) => sum + refund.owedMinor, 0)
  const tail = HOLD_TAIL(input.refundId)
  if (owedMinor > 0 && owedMinor === paid) {
    return withLedgerCheck(`WooCommerce refund ${input.refundId} refunds no goods and pays ${money(paid)} ${input.currency}, the landed-cost fee that ${owed.map((refund) => refund.label).join(' and ')} credits beyond what it paid. `
      + `It is the fee's repayment, not a new credit: apply this payment (${money(paid)} ${input.currency}) to that refund's credit note in Xero.${tail}`)
  }
  if (owedMinor > 0) {
    return withLedgerCheck(`WooCommerce refund ${input.refundId} pays ${money(paid)} ${input.currency} but refunds no goods, on an order where ${owed.map((refund) => refund.label).join(' and ')} credits ${money(owedMinor)} ${input.currency} of landed-cost fees beyond what it paid; `
      + `check by hand what it repays before crediting it.${tail}`)
  }
  return withLedgerCheck(`WooCommerce refund ${input.refundId} pays ${money(paid)} ${input.currency} but refunds no goods, and the landed-cost fee on this order was already refunded within ${feeCarriers.map((refund) => refund.label).join(' and ')}; `
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

/** The coupon meta the plugin writes naming the refund the credit was issued for (class-o3d-scr-credit.php ORIGIN_REFUND). */
export const STORE_CREDIT_ORIGIN_REFUND_META = '_o3d_origin_refund_id'

/** A WooCommerce coupon as the store-credit check reads it (REST v3 /coupons: `status` is the post status, `publish` when spendable). */
export type StoreCreditCoupon = { id: number; code?: string; status?: string; meta_data?: readonly Meta[] | null }

/** How long a store-credit refund may wait for its credit to go live before it is QUARANTINED for a person (from the refund's own creation time). */
export const STORE_CREDIT_WAIT_LIMIT_MS = 24 * 60 * 60 * 1000

export type StoreCreditVerdict =
  | { kind: 'live'; couponId: number }
  /** Not live yet but still in progress: parked PENDING and retried. */
  | { kind: 'wait'; message: string }
  /** No live credit can be shown: QUARANTINED for a person. */
  | { kind: 'quarantine'; message: string }

/**
 * IS THE STORE CREDIT FOR THIS REFUND LIVE? Only a PUBLISHED coupon carrying this refund's attempt id (and, where it names one, this refund) says so. In progress
 * (the plugin's Xero hold on the refund, the order's unfinished record naming the attempt, a draft coupon while that record stands, or the coupons could not be
 * read) it waits, up to STORE_CREDIT_WAIT_LIMIT_MS from the refund's creation; anything else, and any wait past that limit, is QUARANTINED. `coupons` null: the
 * coupon list could not be read. `orderMeta` null: the order could not be read.
 */
export function storeCreditVerdict(input: {
  refundId: number
  attempt: string
  refundMeta: readonly Meta[] | null | undefined
  orderMeta: readonly Meta[] | null
  coupons: readonly StoreCreditCoupon[] | null
  refundCreatedAt: Date | null
  now: Date
}): StoreCreditVerdict {
  const mine = (input.coupons ?? []).filter((coupon) => {
    if (String(metaValue(coupon.meta_data, STORE_CREDIT_ATTEMPT_META) ?? '').trim() !== input.attempt) return false
    const origin = metaValue(coupon.meta_data, STORE_CREDIT_ORIGIN_REFUND_META)
    return origin === undefined || origin === null || origin === '' || Number(origin) === input.refundId
  })
  const live = mine.find((coupon) => coupon.status === 'publish')
  if (live) return { kind: 'live', couponId: live.id }

  const held = metaValue(input.refundMeta, STORE_CREDIT_XERO_HELD_META)
  const heldText = typeof held === 'string' || typeof held === 'number' ? String(held).trim() : ''
  const incomplete = input.orderMeta === null ? undefined : metaValue(input.orderMeta, STORE_CREDIT_INCOMPLETE_META)
  const record = incomplete !== null && typeof incomplete === 'object' ? incomplete as Record<string, unknown> : null
  const named = record !== null && (String(record.attempt ?? '').trim() === input.attempt || Number(record.refund_id) === input.refundId)
  const intro = `WooCommerce refund ${input.refundId} was issued as store credit (attempt ${input.attempt})`
  const waiting = named
    ? `the order still records the store-credit attempt as unfinished (stage ${String(record?.stage ?? 'unknown')})`
    : heldText !== '' ? `the refund is still held for Xero by the store-credit plugin (${heldText})`
      : input.coupons === null ? 'IMS could not read the store\'s coupons to confirm the credit is live'
        : input.orderMeta === null ? 'IMS could not read the WooCommerce order to confirm the credit is live'
          : null
  const draft = mine.find((coupon) => coupon.status === 'draft' || coupon.status === 'pending')
  const age = input.refundCreatedAt === null ? Infinity : input.now.getTime() - input.refundCreatedAt.getTime()
  if (waiting !== null && age <= STORE_CREDIT_WAIT_LIMIT_MS) {
    return { kind: 'wait', message: `${intro}, and ${waiting}, so the store credit is not confirmed live yet. No credit note is raised until a published coupon for this attempt exists: the refund is retried on every sweep, and held for a person if it is still not live ${STORE_CREDIT_WAIT_LIMIT_MS / 3_600_000} hours after the refund.` }
  }
  const found = mine.length === 0
    ? 'no coupon for this attempt exists in the store (it was never issued, was discarded, or was deleted)'
    : `its coupon${mine.length > 1 ? 's are' : ' is'} not published (${mine.map((coupon) => `coupon ${coupon.id}${coupon.code ? ` "${coupon.code}"` : ''}: ${coupon.status ?? 'unknown'}`).join('; ')})`
  return {
    kind: 'quarantine',
    message: withLedgerCheck(`${intro}, but IMS cannot confirm the credit was ever issued: ${waiting !== null ? `${waiting}, for more than ${STORE_CREDIT_WAIT_LIMIT_MS / 3_600_000} hours, and ` : ''}${found}${draft && waiting === null ? ' while the order no longer records the attempt as unfinished' : ''}. `
      + 'No credit note was raised: a store-credit refund gets one only when its credit is live. Check the order\'s notes and its coupons in WooCommerce. If the customer does hold the credit (a published coupon for this attempt), use Retry on this row in Sync exceptions and IMS records it. '
      + 'If they do not, the customer was refunded nothing yet the refund stands: decide with the accountant how it is to be put right before doing anything in WooCommerce - do not discard, re-issue or cancel credit on the strength of this message.'
      + HOLD_TAIL(input.refundId).replace(' The money has ALREADY been returned in the storefront', ' The refund already exists in the storefront').replace(' - do NOT issue another storefront refund.', '.')),
  }
}

/**
 * o3d-pnc8p L4: a store-credit refund WooCommerce reports with no readable creation time. The coupon search is bounded by that time (coupons created after it) and so
 * is the wait; without it the search read every coupon since 1970 and the refund was quarantined at once under a message that blamed the coupons. Said as it is.
 */
export function storeCreditUndatedVerdict(refundId: number, attempt: string): StoreCreditVerdict {
  return {
    kind: 'quarantine',
    message: withLedgerCheck(`WooCommerce refund ${refundId} was issued as store credit (attempt ${attempt}), but WooCommerce reports no creation time for it (date_created_gmt), so IMS cannot find the coupon issued for it or tell how long it has waited. `
      + 'No credit note was raised. Check the order\'s coupons in WooCommerce: if the customer holds the credit (a published coupon for this attempt), settle the credit note in Xero with the accountant.'
      + HOLD_TAIL(refundId).replace(' The money has ALREADY been returned in the storefront', ' The refund already exists in the storefront').replace(' - do NOT issue another storefront refund.', '.')),
  }
}

/**
 * o3d-pnc8p (IOSS cases 3 and 4): A VAT-ONLY REFUND, held. The refund's lines carry no net, it pays money back, and no earlier refund carried a landed-cost fee it
 * could repay. Whether its credit note is ZERO (the invoice is already ex-VAT in Xero: 159049, a 29.67 "refund VAT" against a 141.30 zero-rated invoice) or reverses
 * the VAT out of 821 on No VAT (an IOSS order whose VAT was taken twice: 162199, 39.71 "VAT paid double") depends on how the invoice was booked, which the refund
 * does not say. Crediting the amount as an ordinary refund would be wrong in both.
 */
export function vatOnlyRefundHold(input: { refundId: number | string; amount: DecimalInput; currency: string }): string {
  const paid = Math.abs(cents(input.amount))
  return withLedgerCheck(`WooCommerce refund ${input.refundId} pays ${Number.isFinite(paid) ? money(paid) : 'an unreadable amount'} ${input.currency} back but its lines carry no net amount: it refunds VAT only, and no earlier refund on the order carried a landed-cost fee it could repay. `
    + 'What its credit note must do depends on how the invoice is booked in Xero: if the invoice is already ex-VAT (zero-rated), there is nothing to reverse and the right credit note is zero; if it is an IOSS order whose VAT was taken twice, the credit note reverses that VAT out of the IOSS VAT account (821) on No VAT. '
    + 'Settle it in Xero with the accountant.'
    + HOLD_TAIL(input.refundId))
}

/**
 * o3d-pnc8p: a parity hold an operator ACKNOWLEDGED AS SETTLED OUTSIDE IMS. The park is resolved with a note beginning with this prefix (who, why, and the hold it
 * closed); nothing is created in IMS or sent to Xero, and the refund sync treats that WooCommerce refund as handled for good.
 */
export const SETTLED_OUTSIDE_IMS_NOTE_PREFIX = 'Settled outside IMS by operator:'

export function settledOutsideImsNote(input: { by: string; reason: string; hold: string | null; creditNoteNumber?: string | null }): string {
  return `${SETTLED_OUTSIDE_IMS_NOTE_PREFIX} ${input.by}: ${input.reason.trim()}${input.creditNoteNumber ? ` (settled with Xero credit note ${input.creditNoteNumber})` : ''}. Nothing was created in IMS or sent to Xero. The hold it closed: ${input.hold ?? '(none recorded)'}`
}

/**
 * o3d-pnc8p (IOSS session case 8, o3d-ioss-xero 0.2.6 `_o3d_ioss_fee_open`): an OPEN FEE REPAYMENT is a record of its own, NOT the refund's or the park's status:
 * a refund whose credit note credits a landed-cost fee EAS left out of the refund amount stays open until an operator states that the fee's repayment was applied to
 * that credit note in Xero. Acknowledging a later refund (its repayment park, as settled outside IMS) does not clear it; only "repayment applied" does.
 */
export function isFeeRepaymentOpen(refund: { easFeeGapForeign: DecimalInput | null | undefined; feeRepaymentAppliedAt: Date | null | undefined; deletedAt?: Date | null }): boolean {
  if (refund.deletedAt) return false
  if (refund.feeRepaymentAppliedAt) return false
  const gap = cents(refund.easFeeGapForeign ?? 0)
  return Number.isFinite(gap) && Math.abs(gap) > 0
}

/** What the open repayment asks of the operator, as the plugin's attention screen words it. */
export function feeRepaymentInstruction(input: { externalRefundId: number | null; creditNoteNumber: string | null; gapForeign: DecimalInput; storefrontAmountForeign: DecimalInput | null; currency: string }): string {
  const gap = money(Math.abs(cents(input.gapForeign)))
  const paid = input.storefrontAmountForeign == null ? null : money(Math.abs(cents(input.storefrontAmountForeign)))
  return withLedgerCheck(`refund ${input.externalRefundId ?? '(IMS)'}: credit note ${input.creditNoteNumber ?? '(not numbered yet)'} credits the landed-cost fee ${gap} ${input.currency} that EAS left out of the refund amount${paid ? ` ${paid}` : ''} - apply the fee repayment to it in Xero`)
}

/** #1127 R2 MED-6: the sentence vatOnlyRefundHold writes, by which the VAT-only hold is recognised (the one hold "Settled outside IMS" may close with no credit note). */
const VAT_ONLY_HOLD_MARK = 'but its lines carry no net amount: it refunds VAT only'
export function isVatOnlyRefundHold(errorMessage: string | null | undefined): boolean {
  return typeof errorMessage === 'string' && errorMessage.includes(VAT_ONLY_HOLD_MARK) && isRefundParityHold(errorMessage)
}
