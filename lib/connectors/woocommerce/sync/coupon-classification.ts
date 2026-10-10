/**
 * WHICH KIND of coupon is a WooCommerce coupon line (store credit is a PAYMENT, not a discount).
 *
 * WooCommerce reports every redeemed coupon in `coupon_lines[]` with one amount, and the importer used
 * to add them all together and call the sum a discount. That is right for a cart / percentage /
 * product coupon, because Woo has already taken the money OFF the line totals. It is wrong for Smart
 * Coupons STORE CREDIT (`discount_type = smart_coupon`): Woo subtracts it from `order.total` WITHOUT
 * reducing any line, so it is a means of payment that settles part of a full-value invoice. Folding it
 * into the discount understates the goods value (what the warehouse sees for picking, customs and IOSS) and
 * the revenue and VAT of the invoice.
 *
 * WHAT THE TYPE IS READ FROM, and why not from the coupon. Smart Coupons CONSUMES a store-credit
 * coupon, so most of the ones used on past orders no longer exist as posts; the type is therefore read
 * from what Woo wrote onto the ORDER ITEM at redemption:
 *
 *   - `coupon_info`  (WooCommerce 8.7+): a JSON string `[id, code, discount_type, amount]`;
 *   - `coupon_data`  (legacy): an object carrying `discount_type`;
 *   - the ORDER meta `smart_coupons_contribution`: a `{coupon_code: amount}` map that Smart Coupons
 *     writes whenever a store-credit coupon is applied. This is the signal the production
 *     legacy WooCommerce-to-warehouse sync plugin identifies store credit by (it never reads `discount_type`), so it is
 *     honoured too, and a disagreement between the two is a conflict rather than a guess.
 *
 * AN UNRECOGNISED OR ABSENT TYPE IS NEVER GUESSED. It is classified UNKNOWN. UNKNOWN money that Woo
 * allocated into the lines is harmless (it is already in the line discounts and is carried exactly as
 * before); UNKNOWN money that is NOT in the lines could be either a discount or a payment, and the
 * importer refuses the order for it rather than choosing (see `planWcOrderCoupons`).
 *
 * Pure: no database, no clock, no I/O. Money is exact Decimal.
 */

import { addMoney, currencyMinorUnits, roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

import type { WcCouponLine, WcFullOrder, WcMeta } from './types'

/** The discount types that are GENUINE discounts: Woo has already reduced the line totals by them. */
export const WC_GENUINE_DISCOUNT_TYPES: ReadonlySet<string> = new Set([
  'fixed_cart',
  'percent',
  'fixed_product',
  'percent_product',
  'acfw_bogo',
])

/** The Smart Coupons type that is STORE CREDIT: a payment, not a discount. */
export const WC_STORE_CREDIT_DISCOUNT_TYPE = 'smart_coupon'

/** Order meta key Smart Coupons writes: `{coupon_code: amount_redeemed}` for each credit coupon applied. */
export const WC_STORE_CREDIT_CONTRIBUTION_META_KEY = 'smart_coupons_contribution'

export type WcCouponKind = 'STORE_CREDIT' | 'DISCOUNT' | 'UNKNOWN'

export type ClassifiedWcCoupon = {
  code: string
  kind: WcCouponKind
  /** The `discount_type` found, or null when none could be read. */
  discountType: string | null
  /** Ex-tax amount (`coupon_lines[].discount`). */
  net: Decimal
  /** Tax portion (`coupon_lines[].discount_tax`). */
  tax: Decimal
  /** Why the line is UNKNOWN; null otherwise. */
  unknownReason: string | null
  /**
   * TRUE when one source calls the coupon store credit and another does not (or could not be read). Such a
   * coupon is refused whatever the allocation residual: credit that was also applied to the lines would
   * otherwise import as a discount.
   */
  creditConflict: boolean
}

export type ClassifiedWcCoupons = {
  lines: ClassifiedWcCoupon[]
  /** Every code, in order, as the importer stores them for display. */
  codes: string | null
  /** Ex-tax total of the STORE_CREDIT lines. */
  creditNet: Decimal
  /** GROSS (`discount + discount_tax`) total of the STORE_CREDIT lines: what settles the invoice. */
  creditGross: Decimal
  /** Ex-tax total of every non-credit line (DISCOUNT and UNKNOWN): the money that should be in the lines. */
  genuineNet: Decimal
  unknown: ClassifiedWcCoupon[]
  /**
   * Credit signals that match NO coupon line and so would be silently dropped: a non-zero (or unreadable)
   * `smart_coupons_contribution` entry whose coupon line is absent, and a non-zero (or unreadable) wallet /
   * gift-card order meta value. Any of them is refused, on import and (as a review hold) on update.
   */
  signalProblems: Array<{ code: string; why: string }>
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/**
 * THE ONE INVARIANT (Codex rounds 1-6 all found instances of breaking it):
 *
 *   ANY evidence of store credit that is not a clean, fully parsed, fully reconciled credit is REFUSED on
 *   import and puts the order in REVIEW on update. "Clean" is the only positive path: a whitelist of exact
 *   shapes. Everything else - missing, malformed, unreadable, conflicting, orphaned, or merely suspicious -
 *   falls through to a PROBLEM.
 *
 * EVIDENCE is any of: the order's `smart_coupons_contribution` key present in ANY value shape; a coupon line
 * whose type (`coupon_info`, `coupon_data`), code or meta says smart_coupon / store credit / gift card / wallet;
 * a wallet / gift-card order meta key (list below); a coupon line amount that cannot be read; a missing
 * `discount_type`; sources that disagree.
 *
 * THE CLEAN SHAPES (nothing else is positive):
 *   - credit line: every readable source says `smart_coupon` (item `coupon_info` and/or `coupon_data`, or, when
 *     the item carries no type at all, the contribution map lists its code), no source disagrees or is
 *     unreadable, and both `discount` and `discount_tax` are present, finite and non-negative.
 *   - contribution record: a NON-EMPTY `{code: amount}` map, every amount finite and non-negative, every code
 *     matched (case / whitespace normalised) by a coupon line.
 *   - genuine discount line: every readable source names the same known genuine type, none says anything
 *     credit-like, the code / meta contain no credit words, the amount is readable.
 *   - wallet / gift-card meta: absent, or a readable zero.
 *   - a coupon line of an unrecognised type string with no credit evidence keeps its allocation-based handling
 *     (carried as a discount when Woo put it on the lines; refused when it did not).
 */

type TypeRead = { present: boolean; type: string | null; unreadable: boolean }

function readCouponInfoType(meta: WcMeta[] | undefined): TypeRead {
  const entries = (meta ?? []).filter((m) => m.key === 'coupon_info')
  if (entries.length === 0) return { present: false, type: null, unreadable: false }
  const types = entries.map((entry) => {
    const parsed = parseJsonMaybe(entry.value)
    return Array.isArray(parsed) && typeof parsed[2] === 'string' && parsed[2].trim() ? parsed[2].trim() : null
  })
  const first = types[0]
  const consistent = first !== null && types.every((t) => t === first)
  return { present: true, type: consistent ? first : null, unreadable: !consistent }
}

function readCouponDataType(meta: WcMeta[] | undefined): TypeRead {
  const entries = (meta ?? []).filter((m) => m.key === 'coupon_data')
  if (entries.length === 0) return { present: false, type: null, unreadable: false }
  const types = entries.map((entry) => {
    const parsed = parseJsonMaybe(entry.value)
    const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).discount_type
      : undefined
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null
  })
  const first = types[0]
  const consistent = first !== null && types.every((t) => t === first)
  return { present: true, type: consistent ? first : null, unreadable: !consistent }
}

/** Matching key for a coupon code: WooCommerce lower-cases codes, so case and surrounding whitespace never distinguish two. */
export function normaliseWcCouponCode(code: unknown): string {
  return String(code ?? '').trim().toLowerCase()
}

/** A finite, non-negative money amount, or null. Strict: junk, NaN, infinities and negatives are all null. */
function parseStrictMoney(value: unknown): Decimal | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    return toDecimal(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
    return toDecimal(trimmed)
  }
  return null
}

export type WcContribution = { code: string; amount: Decimal | null }

type ContributionRead = {
  /** Any `smart_coupons_contribution` entry exists, whatever its value. */
  present: boolean
  entries: WcContribution[]
  /** Why the record is not a clean non-empty `{code: amount}` map; empty when it is. */
  malformed: string[]
}

/** Read the contribution record without ever concluding "nothing" from a record that is present. */
function readStoreCreditContributionRecord(orderMeta: WcMeta[] | undefined): ContributionRead {
  const out = new Map<string, WcContribution>()
  const malformed: string[] = []
  const records = (orderMeta ?? []).filter((m) => m.key === WC_STORE_CREDIT_CONTRIBUTION_META_KEY)
  for (const entry of records) {
    let value: unknown = entry.value
    if (typeof value === 'string') {
      const trimmed = value.trim()
      try { value = trimmed ? JSON.parse(trimmed) : null } catch { value = undefined }
    }
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
      malformed.push('smart_coupons_contribution is present but is not a {coupon code: amount} map')
      continue
    }
    const pairs = Object.entries(value as Record<string, unknown>)
    if (pairs.length === 0) {
      malformed.push('smart_coupons_contribution is present but empty')
      continue
    }
    for (const [rawCode, rawAmount] of pairs) {
      const code = normaliseWcCouponCode(rawCode)
      if (!code) {
        malformed.push('smart_coupons_contribution has an entry with no coupon code')
        continue
      }
      out.set(code, { code, amount: parseStrictMoney(rawAmount) })
    }
  }
  return { present: records.length > 0, entries: [...out.values()], malformed }
}

/** The (normalised) codes Smart Coupons recorded as store-credit contributions on the order. */
export function readStoreCreditContributionCodes(orderMeta: WcMeta[] | undefined): Set<string> {
  return new Set(readStoreCreditContributionRecord(orderMeta).entries.map((c) => c.code))
}

/**
 * Order meta keys other store-credit / wallet / gift-card plugins record a redeemed amount under, with NO coupon
 * line (the legacy WooCommerce-to-warehouse sync plugin's default list). Such credit reduces `order.total` exactly as
 * Smart Coupons credit does, and IMS does not model it: anything but an absent key or a readable zero is refused.
 */
export const WC_UNMODELLED_CREDIT_META_KEYS: readonly string[] = [
  '_wc_store_credit_used', '_store_credit_used', '_store_credit_applied',
  '_used_wallet_amount', '_woo_wallet_used', '_partial_pay_through_wallet_amount',
  '_ywgc_applied_gift_cards_total', '_gift_card_amount', '_giftcard_amount', 'wc_gift_cards_total',
  '_smart_coupon_credit_used',
]

/** Words that mean store credit, wherever they appear on a coupon line that is not a cleanly typed genuine discount. */
const CREDIT_WORDS = /smart[_ -]?coupon|store[_ -]?credit|gift[_ -]?(?:card|cert)|giftcard|wallet/i

function parseMoney(value: unknown): Decimal | null {
  if (value === null || value === undefined || value === '') return toDecimal(0)
  try {
    const parsed = toDecimal(value as string | number)
    return parsed.isFinite() ? parsed : null
  } catch {
    return null
  }
}

type Problem = { code: string; why: string }

function classifyOne(line: WcCouponLine, contributionCodes: Set<string>, problems: Problem[]): ClassifiedWcCoupon {
  const code = (line.code ?? '').trim()
  const info = readCouponInfoType(line.meta_data)
  const data = readCouponDataType(line.meta_data)
  const inContribution = contributionCodes.has(normaliseWcCouponCode(code))
  const netStrict = parseStrictMoney(line.discount)
  const taxStrict = parseStrictMoney(line.discount_tax)
  const netLenient = parseMoney(line.discount)
  const taxLenient = parseMoney(line.discount_tax)

  const base = { code, net: netLenient ?? toDecimal(0), tax: taxLenient ?? toDecimal(0) }
  const problem = (why: string, discountType: string | null): ClassifiedWcCoupon => {
    problems.push({ code: code || '(no code)', why })
    return { ...base, kind: 'UNKNOWN', discountType, unknownReason: why, creditConflict: true }
  }

  const types = [info.type, data.type].filter((t): t is string => t !== null)
  const sawCreditType = types.includes(WC_STORE_CREDIT_DISCOUNT_TYPE)
  const sawOtherType = types.some((t) => t !== WC_STORE_CREDIT_DISCOUNT_TYPE)
  const unreadableRecord = info.unreadable || data.unreadable
  const typeLabel = types[0] ?? null
  const describeSources = `coupon_info: ${info.present ? info.type ?? 'unreadable' : 'absent'}, coupon_data: ${data.present ? data.type ?? 'unreadable' : 'absent'}, `
    + `smart_coupons_contribution: ${inContribution ? 'lists it' : 'does not list it'}`

  // 1. A type record that is present but cannot be read is never "no information".
  if (unreadableRecord) return problem(`a coupon type record for "${code}" is present but unreadable or inconsistent (${describeSources})`, typeLabel)

  const creditSignal = sawCreditType || inContribution
  // 2. Any disagreement involving a credit signal.
  if (creditSignal && sawOtherType) return problem(`the sources disagree about whether "${code}" is store credit (${describeSources})`, typeLabel)

  // 3. THE CLEAN CREDIT SHAPE.
  if (creditSignal) {
    if (netStrict === null || taxStrict === null) {
      return problem(`the store-credit amount of "${code}" is missing, unreadable or negative (discount: ${JSON.stringify(line.discount)}, discount_tax: ${JSON.stringify(line.discount_tax)})`, typeLabel)
    }
    return { code, net: netStrict, tax: taxStrict, kind: 'STORE_CREDIT', discountType: typeLabel, unknownReason: null, creditConflict: false }
  }

  // From here the line has NO credit signal from a type or the contribution record.
  // 4. A cleanly typed genuine discount.
  const distinct = new Set(types)
  if (types.length > 0 && distinct.size === 1 && WC_GENUINE_DISCOUNT_TYPES.has(types[0])) {
    if (line.discount !== undefined && line.discount !== '' && netLenient === null) return problem(`the discount amount of "${code}" cannot be read`, typeLabel)
    return { ...base, kind: 'DISCOUNT', discountType: typeLabel, unknownReason: null, creditConflict: false }
  }
  // 5. Not a cleanly typed genuine discount: credit words anywhere on the line are evidence.
  const text = `${code} ${JSON.stringify(line.meta_data ?? [])}`
  if (CREDIT_WORDS.test(text)) return problem(`the code or records of "${code}" say store credit / gift card / wallet, but its type does not (${describeSources})`, typeLabel)
  // 6. No type at all is a missing discount_type: not provably a discount.
  if (types.length === 0) return problem(`WooCommerce recorded no coupon type for "${code}" (${describeSources})`, null)
  // 7. A type IMS does not recognise, with no credit evidence: allocation-based handling.
  if (distinct.size > 1) return problem(`the coupon type records for "${code}" disagree (${describeSources})`, typeLabel)
  return { ...base, kind: 'UNKNOWN', discountType: typeLabel, unknownReason: `the coupon type "${typeLabel}" is not one IMS recognises`, creditConflict: false }
}

/**
 * Classify every coupon line of an order and collect EVERY credit-evidence problem. `orderMeta` is the ORDER's
 * `meta_data`. A non-empty `signalProblems` means the order is not cleanly assessable: refuse it on import, hold it
 * for review on update.
 */
export function classifyWcCouponLines(couponLines: WcCouponLine[], orderMeta?: WcMeta[]): ClassifiedWcCoupons {
  const problems: Problem[] = []
  const record = readStoreCreditContributionRecord(orderMeta)
  const contributionCodes = new Set(record.entries.map((c) => c.code))
  const lines = (couponLines ?? []).map((line) => classifyOne(line, contributionCodes, problems))
  const lineCodes = new Set((couponLines ?? []).map((l) => normaliseWcCouponCode(l.code)))

  for (const why of record.malformed) problems.push({ code: WC_STORE_CREDIT_CONTRIBUTION_META_KEY, why })
  for (const c of record.entries) {
    if (c.amount === null) problems.push({ code: c.code, why: 'smart_coupons_contribution lists it with an amount IMS cannot read' })
    if (!lineCodes.has(c.code)) problems.push({ code: c.code, why: 'smart_coupons_contribution lists it, but the order has no coupon line for it' })
  }
  for (const key of WC_UNMODELLED_CREDIT_META_KEYS) {
    for (const entry of (orderMeta ?? []).filter((m) => m.key === key)) {
      const readable = parseStrictMoney(entry.value === '' ? 0 : entry.value)
      if (readable !== null && readable.isZero()) continue
      problems.push({
        code: key,
        why: readable === null
          ? 'a store-credit / wallet / gift-card record with a value IMS cannot read'
          : `a store-credit / wallet / gift-card record of ${readable.toString()} that reduces the order total without a coupon line, which IMS does not model`,
      })
    }
  }

  const credit = lines.filter((l) => l.kind === 'STORE_CREDIT')
  const rest = lines.filter((l) => l.kind !== 'STORE_CREDIT')
  const zero = toDecimal(0)
  return {
    lines,
    codes: lines.length ? lines.map((l) => l.code).join(', ') : null,
    creditNet: credit.reduce((s, l) => addMoney(s, l.net), zero),
    creditGross: credit.reduce((s, l) => addMoney(s, addMoney(l.net, l.tax)), zero),
    genuineNet: rest.reduce((s, l) => addMoney(s, l.net), zero),
    unknown: lines.filter((l) => l.kind === 'UNKNOWN' && !l.creditConflict),
    signalProblems: problems,
  }
}

/**
 * Does a later delivery of an order IMS already holds put it in store-credit review? TRUE when the payload has any
 * credit-evidence problem, or shows credit the stored row does not account for (not assessed, or a different
 * amount). The stored credit itself is never changed.
 */
export function wcUpdateNeedsStoreCreditReview(
  payload: { coupon_lines?: WcCouponLine[]; meta_data?: WcMeta[] },
  stored: { storeCreditForeign: unknown; storeCreditAssessment: unknown },
): boolean {
  if (stored.storeCreditAssessment === 'REVIEW_REQUIRED') return false // already held
  const classified = classifyWcCouponLines(payload.coupon_lines ?? [], payload.meta_data)
  if (classified.signalProblems.length > 0) return true
  const credit = roundQuantity(classified.creditGross, 4)
  if (!credit.gt(0)) return false
  let storedCredit: Decimal
  try { storedCredit = toDecimal(stored.storeCreditForeign as string | number) } catch { return true }
  return !(stored.storeCreditAssessment === 'ASSESSED' && credit.eq(storedCredit))
}

export type WcCouponPlanRefusal =
  | { kind: 'UNKNOWN_COUPON_TYPE'; reason: string; coupons: Array<{ code: string; discountType: string | null; why: string }> }
  | { kind: 'CREDIT_NOT_RECONCILED'; reason: string }
  | { kind: 'CREDIT_SIGNAL_CONFLICT'; reason: string; coupons: Array<{ code: string; discountType: string | null; why: string }> }

/**
 * Operator-facing sentence for a refused order, single-sourced here so the activity log, the returned
 * import error and the docs cannot drift. It states only what is true at this point: the import was
 * stopped BEFORE any order row was written, so nothing exists in IMS, the warehouse or the ledger for it.
 */
export function describeWcCouponRefusal(orderNumber: string, refusal: WcCouponPlanRefusal): string {
  const lead = `WooCommerce order ${orderNumber} was NOT imported: `
  const tail = ' No order was created in IMS, so nothing was sent to the warehouse or the ledger for it. '
    + 'Check the coupon on the order in WooCommerce, then re-import the order.'
  if (refusal.kind === 'CREDIT_NOT_RECONCILED') return `${lead}${refusal.reason}${tail}`
  const which = refusal.coupons
    .map((c) => `${c.code || '(no code)'} [${c.discountType ?? 'no type'}: ${c.why}]`)
    .join('; ')
  return `${lead}${refusal.reason} Coupon(s): ${which}.${tail}`
}

export type WcCouponPlan = {
  /** Coupon codes for display (`SalesOrder.discountStr`). */
  discountStr: string | null
  /** Ex-tax total of the non-credit coupons: what Woo should have put into the line discounts. */
  genuineCouponNet: Decimal
  /** The residual of the non-credit coupons that is NOT in the lines (the order-level discount slot). */
  orderLevelDiscount: number
  unallocated: number
  /** Store credit, GROSS, in the order currency: a payment against the invoice. Zero when none. */
  storeCreditForeign: Decimal
  storeCreditCodes: string[]
  refusal: WcCouponPlanRefusal | null
}

/**
 * Decide what each coupon on the order IS and what happens to its money:
 *
 *   - STORE_CREDIT  -> `storeCreditForeign` (gross). Never in the discount.
 *   - DISCOUNT      -> the genuine coupon total; only the part Woo did NOT put on the lines is an
 *                      order-level discount (today's o3d-y14 allocation logic, unchanged).
 *   - UNKNOWN       -> counted with the genuine coupons while it is allocated into the lines, but a
 *                      non-zero unallocated residual with an UNKNOWN coupon in play REFUSES the order:
 *                      the residual could be a discount or a payment and IMS does not choose.
 *
 * `resolveResidual` is `resolveWcOrderLevelDiscount`, injected so this module stays free of the db.
 */
export function planWcOrderCoupons(input: {
  couponLines: WcCouponLine[]
  orderMeta: WcMeta[] | undefined
  lineDiscountTotalForeign: Decimal
  currency: string
  resolveResidual: (args: { couponTotalForeign: Decimal; lineDiscountTotalForeign: Decimal; currency: string }) => {
    orderLevelDiscount: number
    unallocated: number
  }
}): WcCouponPlan {
  const classified = classifyWcCouponLines(input.couponLines, input.orderMeta)
  const { orderLevelDiscount, unallocated } = input.resolveResidual({
    couponTotalForeign: classified.genuineNet,
    lineDiscountTotalForeign: input.lineDiscountTotalForeign,
    currency: input.currency,
  })
  const storeCredit = roundQuantity(classified.creditGross, 4)
  const plan: WcCouponPlan = {
    discountStr: classified.codes,
    genuineCouponNet: classified.genuineNet,
    orderLevelDiscount,
    unallocated,
    storeCreditForeign: storeCredit,
    storeCreditCodes: classified.lines.filter((l) => l.kind === 'STORE_CREDIT').map((l) => l.code),
    refusal: null,
  }

  const asList = (lines: ClassifiedWcCoupon[]) =>
    lines.map((l) => ({ code: l.code, discountType: l.discountType, why: l.unknownReason ?? '' }))

  // A credit signal that matches no coupon line would be silently dropped (the order would import with a total
  // lower than its goods value and no credit recorded): refused outright.
  if (classified.signalProblems.length > 0) {
    plan.refusal = {
      kind: 'CREDIT_SIGNAL_CONFLICT',
      reason: 'WooCommerce records store credit for this order that no coupon line accounts for, so IMS cannot tell what was paid and will not guess.',
      coupons: classified.signalProblems.map((p) => ({ code: p.code, discountType: null, why: p.why })),
    }
    return plan
  }

  // The residual that is not in the lines, with an UNKNOWN coupon in play, is the ambiguous case.
  if (classified.unknown.length > 0 && unallocated > 0) {
    plan.refusal = {
      kind: 'UNKNOWN_COUPON_TYPE',
      reason:
        'a coupon of unrecognised type left money that is not on any line item, and IMS cannot tell whether '
        + 'that is a discount or a payment, so it will not choose.',
      coupons: asList(classified.unknown),
    }
  }
  return plan
}

/**
 * The reconciliation that PROVES a store-credit order's credit really is unallocated: the lines, tax
 * and shipping, less any genuine order-level discount, less the credit, must equal what WooCommerce
 * says the order totalled. If it does not, the credit also reduced the lines (Smart Coupons' "apply
 * before tax" mode) or the order carries another amount IMS has not modelled, and counting the credit
 * as a payment would take it out TWICE. Only evaluated when there is credit.
 */
export function checkWcStoreCreditReconciles(input: {
  subtotalForeign: Decimal
  taxForeign: Decimal
  shippingForeign: Decimal
  orderLevelDiscountForeign: Decimal
  storeCreditForeign: Decimal
  orderTotalForeign: Decimal
  currency: string
}): { ok: true } | { ok: false; difference: Decimal; tolerance: Decimal } {
  const expected = input.subtotalForeign
    .add(input.taxForeign)
    .add(input.shippingForeign)
    .sub(input.orderLevelDiscountForeign)
    .sub(input.storeCreditForeign)
  const difference = roundQuantity(expected.sub(input.orderTotalForeign), 4)
  // EXACT, to well below one minor unit. The tolerance is a QUARTER of a minor unit and strict, which only
  // absorbs the four-decimal storage of the figures: every figure here is a sum of amounts WooCommerce itself
  // rounded to the currency's minor unit, so honest data reconciles to the digit. Any allowance of a whole
  // minor unit could not be told apart from a credit of one or two minor units that is ALSO already in the
  // line totals (it would be subtracted twice and land inside the allowance), which sends the warehouse a
  // reduced goods value. An order that is genuinely a minor unit out is refused for an operator to look at.
  const tolerance = toDecimal(10).pow(-currencyMinorUnits(input.currency)).div(4)
  return difference.abs().lt(tolerance) ? { ok: true } : { ok: false, difference, tolerance }
}

/**
 * The amounts WooCommerce itself reports for the order, summed from its OWN line fields (line totals, fee
 * totals, shipping totals and their tax), not from IMS's reconstruction. IMS rebuilds a line as
 * `quantity x unit price` where the unit price is `subtotal / quantity` rounded to six decimals, so a
 * high-quantity line carries a rounding error that is IMS's, not WooCommerce's. The store-credit
 * reconciliation is a statement about WooCommerce's arithmetic, so it uses WooCommerce's figures.
 */
export function wcReportedOrderAmounts(order: Pick<WcFullOrder, 'line_items' | 'fee_lines' | 'shipping_lines'>): {
  goodsNet: Decimal
  tax: Decimal
  shipping: Decimal
} {
  const zero = toDecimal(0)
  const money = (v: unknown): Decimal => parseMoney(v) ?? zero
  let goodsNet = zero
  let tax = zero
  let shipping = zero
  for (const l of order.line_items ?? []) {
    goodsNet = addMoney(goodsNet, money(l.total))
    tax = addMoney(tax, money(l.total_tax))
  }
  for (const f of order.fee_lines ?? []) {
    goodsNet = addMoney(goodsNet, money(f.total))
    tax = addMoney(tax, money(f.total_tax))
  }
  for (const sh of order.shipping_lines ?? []) {
    shipping = addMoney(shipping, money(sh.total))
    tax = addMoney(tax, money(sh.total_tax))
  }
  return { goodsNet, tax, shipping }
}
