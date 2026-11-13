/**
 * THE EU IOSS / VOEC / DDP TREATMENT OF A SALES INVOICE PAYLOAD. Pure: no database, no clock, no WooCommerce types.
 *
 * `applyEuVatTreatment` turns the order's regime stamp (eu-vat-regime.ts, eu-vat-regime-stamp.ts) into the Xero lines the storefront plugin (o3d-ioss-xero) posts today:
 *
 *   SCHEME  (an IOSS, VOEC or DDP order)
 *     goods, shipping and the order discount   on the scheme's zero-rated posting type, accounts unchanged (the charged rate is NOT sent: Xero would add VAT)
 *     landed-cost fees (marked `_wclc_fee`)    on the fee account (232) on NONE, net amount, noTaxKind `fee-no-tax`
 *     ONE VAT line                             the whole collected VAT, on the stamped account (821 for IOSS/VOEC, 232 for DDP), on NONE, noTaxKind `eu-vat-recovery`
 *   B2B     (an EU-27 business sale WooCommerce charged no VAT on)
 *     goods, shipping and the order discount   on ZERORATEDOUTPUT (parity with the storefront mu-plugin)
 *   EVERY ORDER
 *     a marked landed-cost fee is re-coded to the fee account on NONE; a fee that carries VAT outside the scheme cannot be (the VAT would leave the document), so it refuses.
 *
 * THE INVARIANT. On the scheme and B2B routes every line is on a zero-rated type or on NONE, so Xero adds no tax and the document's total is exactly the sum of its lines. That total must equal the
 * order's total to the minor unit. A difference within a few minor units is rounding and posts to the rounding account (860 "Rounding", owner ruling Q7) as one line named `rounding-difference`; any other
 * difference, a missing account, an unreadable figure, or a second line on the VAT account refuses. A refusal returns the reason; the importer never queues the invoice: it parks the original payload as a held invoice
 * with the reason, and a re-import after the cause is fixed retries the treatment and releases it. Nothing here sends a tax amount: no line carries one.
 *
 * Every line that is re-typed also loses its rate binding (`taxRateId`, `shippingTaxRateId`, `discountTaxRateId` and their bases): the binding says "this code was read from that rate", which is no longer true.
 */
import { currencyMinorUnits, roundMoney, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { droppedExtraMapping } from './sales-document-tax-types'
import { withLedgerCheck } from './hand-post-instruction'
import type { EuVatRegimeDecision, EuVatRegimeInput } from './eu-vat-regime'
import type { StampedRegime } from './eu-vat-regime-stamp'

/** Xero's built-in zero-rated sales code, on which the storefront mu-plugin posts a VAT-exempt EU business sale. */
export const B2B_ZERO_RATE_TAX_TYPE = 'ZERORATEDOUTPUT'
/** Xero's "No VAT". */
const NO_TAX = 'NONE'
/** The payload key that says what the treatment did (or why it did not). Underscore-prefixed: the senders never read it. */
export const EU_VAT_TREATMENT_PAYLOAD_KEY = '_euVatTreatment'
/** A difference between the document and the order of at most this many minor units per priced component (at least 1, at most 10 in all) is rounding. */
export const ROUNDING_MINOR_UNITS_PER_COMPONENT = 1
export const ROUNDING_MINOR_UNITS_CAP = 10

export type EuVatTreatmentRoute =
  | { kind: 'none' }
  | { kind: 'b2b_zero_rate' }
  | {
      kind: 'scheme'
      regime: 'IOSS' | 'VOEC' | 'DDP'
      /** The stamped account of the one VAT line. */
      vatAccount: string
      /** The collected VAT in the order currency. */
      vatAmount: string
      /** The zero-rated posting type of the goods, shipping and discount lines. */
      schemePostingTaxType: string
      /** The line text, for example "IOSS VAT collected — DE 19%". */
      vatDescription: string
    }

/** What each payload line is. `marked-fee`: a fee carrying the landed-cost marker. `untaxed-fee`: a fee WooCommerce charged no tax on and named no rate for. Everything else is `goods`. */
export type TreatedLineKind = 'goods' | 'marked-fee' | 'untaxed-fee'

export type EuVatTreatmentPlan = {
  route: EuVatTreatmentRoute
  /** One entry per payload line, in order. */
  lineKinds: readonly TreatedLineKind[]
  /** The account a marked landed-cost fee posts to (232), or null when not configured. */
  feeAccount: string | null
  /** The account a rounding difference posts to (860), or null when not configured. */
  roundingAccount: string | null
  /** WooCommerce's order total, the figure the document must equal. */
  orderTotal: string
  /** The tax WooCommerce charged on each payload line, aligned with `lines`: a fee carrying tax cannot move to NONE outside the scheme. */
  lineTax: readonly string[]
  /**
   * Why the scheme's zero-rated posting type cannot be relied on (unknown, not ACTIVE, not for revenue, not exactly 0%, or the stored Xero list cannot prove it), or null when the stored list proves it.
   * REQUIRED, never defaulted: the total check below assumes the scheme type adds no tax, which only a zero-rated type guarantees. Ignored outside the scheme route.
   */
  schemePostingTypeProblem: string | null
}

/** The part of a stored Xero tax-rate row the scheme posting type is judged on. */
export type StoredXeroTypeRow = { taxType: string; status: string; effectiveRate: string | null; displayTaxRate: string | null; canApply: { revenue: boolean | null } }

/**
 * Whether `taxType` is a known, ACTIVE, revenue, exactly 0% Xero type in the stored list: null when it is, else the reason it is not. Pure. (The same facts the preflight and the drift check judge a declared
 * scheme type on; the effective rate is the one Xero reports, falling back to the displayed rate as the preflight does.)
 */
export function schemePostingTypeProblem(rows: readonly StoredXeroTypeRow[], taxType: string): string | null {
  const code = taxType.trim()
  if (code === '') return 'the scheme posting type is blank'
  const row = rows.find((r) => r.taxType === code)
  if (row === undefined) return `the scheme posting type ${code} is not in the stored Xero tax-rate list`
  if (row.status !== 'ACTIVE') return `the scheme posting type ${code} is ${row.status} in Xero, not ACTIVE`
  if (row.canApply.revenue !== true) return `the scheme posting type ${code} cannot be applied to revenue in Xero`
  const text = row.effectiveRate ?? row.displayTaxRate
  const rate = text === null ? null : dec(text)
  if (rate === null) return `the rate of the scheme posting type ${code} is not stated in Xero, so it cannot be shown to be zero`
  if (!rate.isZero()) return `the scheme posting type ${code} is ${rate.toString()}% in Xero, not zero-rated; posting on it would add tax to the invoice`
  return null
}

export type TreatableLine = {
  description?: string
  quantity: number
  unitAmount: number
  accountCode: string
  taxType?: string
  noTaxKind?: string
  discountAmount?: number
  [key: string]: unknown
}

export type TreatablePayload = {
  currency: string
  lines: TreatableLine[]
  shippingAmount?: number
  shippingAccountCode?: string
  shippingTaxType?: string
  discountAmount?: number
  discountAccountCode?: string
  discountTaxType?: string
  lineAmountsIncludeTax?: boolean
  [key: string]: unknown
}

export type EuVatTreatmentResult<P extends TreatablePayload> =
  | { ok: true; payload: P; applied: { route: EuVatTreatmentRoute['kind']; regime: string | null; feesRecoded: number; roundingAdjustment: string | null } }
  | { ok: false; reason: string }

const BINDING_KEYS = {
  line: ['taxRateId', 'taxRateBasis'],
  shipping: ['shippingTaxRateId', 'shippingTaxRateBasis'],
  discount: ['discountTaxRateId', 'discountTaxRateBasis'],
} as const

function withoutKeys<T extends Record<string, unknown>>(value: T, keys: readonly string[]): T {
  const copy: Record<string, unknown> = { ...value }
  for (const key of keys) delete copy[key]
  return copy as T
}

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
const isBlank = (value: string | null | undefined): boolean => (value ?? '').trim() === ''
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

function dec(value: unknown): Decimal | null {
  if (typeof value === 'number') return Number.isFinite(value) ? toDecimal(value) : null
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return toDecimal(value.trim())
  return null
}

/** The amount Xero books for one line: quantity x unit amount less the per-line discount (sent to 2 places), to the currency's minor unit. */
function lineAmount(line: TreatableLine, currency: string): Decimal | null {
  const quantity = dec(line.quantity)
  const unit = dec(line.unitAmount)
  if (quantity === null || unit === null) return null
  const discount = line.discountAmount !== undefined && line.discountAmount > 0 ? toDecimal(line.discountAmount).toDecimalPlaces(2, 4) : toDecimal(0)
  return roundMoney(quantity.times(unit).minus(discount), currency)
}

/** What a payload's lines, shipping and discount sum to when no line carries tax, to the currency's minor unit; null when a figure cannot be read. */
export function predictedUntaxedTotal(payload: TreatablePayload): Decimal | null {
  let total = toDecimal(0)
  for (const line of payload.lines) {
    const amount = lineAmount(line, payload.currency)
    if (amount === null) return null
    total = total.plus(amount)
  }
  if (isPositive(payload.shippingAmount) && !isBlank(payload.shippingAccountCode)) total = total.plus(roundMoney(payload.shippingAmount, payload.currency))
  if (isPositive(payload.discountAmount) && !isBlank(payload.discountAccountCode)) total = total.minus(roundMoney(payload.discountAmount, payload.currency))
  return total
}

export function applyEuVatTreatment<P extends TreatablePayload>(payload: P, plan: EuVatTreatmentPlan): EuVatTreatmentResult<P> {
  if (plan.lineKinds.length !== payload.lines.length || plan.lineTax.length !== payload.lines.length) {
    return refuse('the invoice lines and the order lines do not line up, so the EU VAT treatment cannot be applied')
  }
  if (payload.lineAmountsIncludeTax === true) {
    return refuse('the invoice is built tax-inclusive, which the EU VAT treatment does not support; every component must be tax-exclusive')
  }
  const route = plan.route
  const marked = plan.lineKinds.map((kind, index) => (kind === 'marked-fee' ? index : -1)).filter((index) => index >= 0)

  // 1. Marked landed-cost fees, on every order: the fee account, on NONE, naming why. A fee that carries tax cannot leave the tax types outside the scheme.
  if (marked.length > 0) {
    if (isBlank(plan.feeAccount)) return refuse('a landed-cost fee is on the order but the "EU landed-cost fees" account is not configured, so the fee cannot be posted')
    if (route.kind !== 'scheme') {
      for (const index of marked) {
        const tax = dec(plan.lineTax[index])
        if (tax === null) return refuse(`the tax on the fee "${payload.lines[index]?.description ?? `line ${index + 1}`}" cannot be read`)
        if (tax.abs().gt(0)) {
          return refuse(`the fee "${payload.lines[index]?.description ?? `line ${index + 1}`}" carries VAT on an order that is not on the IOSS/VOEC/DDP scheme, so it cannot be posted on No VAT`)
        }
      }
    }
  }

  const lines: TreatableLine[] = payload.lines.map((line, index) => {
    const kind = plan.lineKinds[index]!
    if (kind === 'marked-fee') {
      return { ...withoutKeys(line, BINDING_KEYS.line), accountCode: plan.feeAccount!.trim(), taxType: NO_TAX, noTaxKind: 'fee-no-tax', euFeeMarked: true }
    }
    if (kind === 'untaxed-fee') return line
    if (route.kind === 'scheme') return { ...withoutKeys(line, BINDING_KEYS.line), taxType: route.schemePostingTaxType }
    if (route.kind === 'b2b_zero_rate') return { ...withoutKeys(line, BINDING_KEYS.line), taxType: B2B_ZERO_RATE_TAX_TYPE }
    return line
  })

  let next: P = { ...payload, lines }
  const shippingEmitted = isPositive(payload.shippingAmount) && !isBlank(payload.shippingAccountCode)
  const discountEmitted = isPositive(payload.discountAmount) && !isBlank(payload.discountAccountCode)
  const retype = route.kind === 'scheme' ? route.schemePostingTaxType : route.kind === 'b2b_zero_rate' ? B2B_ZERO_RATE_TAX_TYPE : null
  if (retype !== null) {
    if (shippingEmitted) next = { ...withoutKeys(next, BINDING_KEYS.shipping), shippingTaxType: retype }
    if (discountEmitted) next = { ...withoutKeys(next, BINDING_KEYS.discount), discountTaxType: retype }
  }

  if (route.kind === 'none') {
    return { ok: true, payload: next, applied: { route: 'none', regime: null, feesRecoded: marked.length, roundingAdjustment: null } }
  }

  // A positive shipping or order-discount amount with no account code is never sent by the connector. The document's total would then miss that money, and a small amount could be taken for rounding below, so it refuses BEFORE any rounding allowance applies.
  const dropped = droppedExtraMapping(next)
  if (dropped !== null) return refuse(`the order has a positive ${dropped} amount but no ${dropped} account is set in the accounting settings, so the invoice would leave it out and not total the order`)

  // 2. The scheme's one VAT line.
  const currency = payload.currency
  if (route.kind === 'scheme') {
    // The total check below assumes the scheme type adds no tax. Only a type the stored Xero list shows to be ACTIVE and exactly 0% makes that true.
    if (plan.schemePostingTypeProblem !== null) return refuse(plan.schemePostingTypeProblem)
    if (isBlank(route.vatAccount)) return refuse('the stamp names no account for the VAT line')
    const vat = dec(route.vatAmount)
    if (vat === null) return refuse('the collected VAT cannot be read')
    const vatLine: TreatableLine = {
      description: route.vatDescription,
      quantity: 1,
      unitAmount: roundMoney(vat, currency).toNumber(),
      accountCode: route.vatAccount.trim(),
      taxType: NO_TAX,
      noTaxKind: 'eu-vat-recovery',
    }
    // Exactly one line on the VAT account. For DDP the fee account is the same account (232), so the fee lines sit beside the VAT line: the account holds VAT plus fees, and only the VAT line is the VAT line.
    const onVatAccount = next.lines.filter((line) => line.accountCode.trim() === vatLine.accountCode && line.noTaxKind !== 'fee-no-tax')
    if (onVatAccount.length > 0) return refuse(`a line other than the VAT line is already posted to the VAT account ${vatLine.accountCode}`)
    next = { ...next, lines: [...next.lines, vatLine] }
  }

  // 3. The invariant: the document totals the order, exactly, after at most a rounding line.
  const orderTotal = dec(plan.orderTotal)
  if (orderTotal === null) return refuse('the order total cannot be read, so the invoice cannot be checked against it')
  const predicted = predictedUntaxedTotal(next)
  if (predicted === null) return refuse('a line amount cannot be read, so the invoice cannot be checked against the order total')
  const difference = roundMoney(orderTotal, currency).minus(predicted)
  let roundingAdjustment: string | null = null
  if (!difference.isZero()) {
    const minor = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(currency)))
    const components = next.lines.length + (shippingEmitted ? 1 : 0) + (discountEmitted ? 1 : 0)
    const allowed = minor.times(Math.min(ROUNDING_MINOR_UNITS_CAP, Math.max(1, components * ROUNDING_MINOR_UNITS_PER_COMPONENT)))
    if (difference.abs().gt(allowed)) {
      return refuse(
        `the invoice would total ${predicted.toFixed(currencyMinorUnits(currency))} ${currency} but the order total is ${orderTotal.toFixed(currencyMinorUnits(currency))} `
        + `(difference ${difference.toFixed(currencyMinorUnits(currency))}), more than rounding explains`,
      )
    }
    if (isBlank(plan.roundingAccount)) return refuse(`the invoice differs from the order total by ${difference.toFixed(currencyMinorUnits(currency))} (rounding) but no rounding account is configured`)
    next = {
      ...next,
      lines: [
        ...next.lines,
        { description: 'Rounding adjustment', quantity: 1, unitAmount: difference.toNumber(), accountCode: plan.roundingAccount!.trim(), taxType: NO_TAX, noTaxKind: 'rounding-difference' },
      ],
    }
    roundingAdjustment = difference.toFixed(currencyMinorUnits(currency))
  }
  // Re-checked on the finished document, so the rounding line cannot be what makes a wrong one balance by accident.
  const finished = predictedUntaxedTotal(next)
  if (finished === null || !finished.eq(roundMoney(orderTotal, currency))) return refuse('the finished invoice does not total the order total')

  return {
    ok: true,
    payload: next,
    applied: { route: route.kind, regime: route.kind === 'scheme' ? route.regime : null, feesRecoded: marked.length, roundingAdjustment },
  }
}

// ---- from the stamp and the facts to the plan (pure) ----

const DESTINATION_LABEL = { IOSS: 'IOSS VAT collected', VOEC: 'VOEC VAT collected', DDP: 'DDP import VAT collected' } as const

/** The percentage text of the scheme rate when the order carries exactly one ("19", "7.5"); null otherwise. */
function schemeRatePercent(input: EuVatRegimeInput): string | null {
  const rates = new Set<string>()
  for (const fact of input.rates) {
    if (fact.mapping.state !== 'mapped') continue
    const category = (fact.mapping.reportingCategory ?? '').trim().toUpperCase()
    if (category === 'IOSS' || category === 'VOEC') rates.add(fact.mapping.rate)
  }
  if (rates.size !== 1) return null
  const pct = Number([...rates][0]!) * 100
  return Number.isFinite(pct) ? String(Number(pct.toFixed(4))) : null
}

export function lineKindsOf(mappedLines: ReadonlyArray<{ isFeeLine?: boolean; wclcFeeKind?: string | null; forceNoTax?: boolean }>): TreatedLineKind[] {
  return mappedLines.map((line) => {
    if (line.isFeeLine === true && line.wclcFeeKind != null) return 'marked-fee'
    if (line.isFeeLine === true && line.forceNoTax === true) return 'untaxed-fee'
    return 'goods'
  })
}

/**
 * The route the stamp and the order's facts give. Pure. A stamped order's regime and account are taken as stamped; the decision from the current facts supplies the VAT amount and the zero-rated
 * type, and must agree that the order is on (or off) the scheme.
 */
export function routeFor(
  stamp: StampedRegime,
  decision: EuVatRegimeDecision,
  input: EuVatRegimeInput,
): { ok: true; route: EuVatTreatmentRoute } | { ok: false; reason: string } {
  if (decision.kind === 'REFUSE') return { ok: false, reason: `the order's EU VAT regime cannot be established: ${decision.reason}` }
  if (stamp.regime === null) {
    if (decision.kind === 'SCHEME') return { ok: false, reason: 'the order was decided to be outside the IOSS/VOEC/DDP scheme, but its tax now identifies a scheme rate; it is not posted until a person looks' }
    return { ok: true, route: decision.vatExemptB2b ? { kind: 'b2b_zero_rate' } : { kind: 'none' } }
  }
  if (decision.kind !== 'SCHEME') return { ok: false, reason: `the order was stamped ${stamp.regime} but its tax no longer identifies a scheme rate; it is not posted until a person looks` }
  if (stamp.vatAccount === null || stamp.vatAccount.trim() === '') return { ok: false, reason: `the order's ${stamp.regime} stamp names no VAT account` }
  // The stamp is written once and never re-derived, so a fresh decision that differs from it (the goods value or the mode changed since) is not posted through the old stamp: it needs a person.
  if (decision.regime !== stamp.regime || decision.vatAccount.trim() !== stamp.vatAccount.trim()) {
    return {
      ok: false,
      reason: `the order was stamped ${stamp.regime} on account ${stamp.vatAccount}, but its facts now decide ${decision.regime} on account ${decision.vatAccount.trim()}; the stamp is never re-derived, so it is not posted until a person looks`,
    }
  }
  // The posting type is part of what the stamp recorded: a credit note reverses THAT type, so an invoice must not be posted on another one because a rate's Xero mapping moved after the stamp. A stamp that recorded none (written before it was kept) is not held to it.
  if (stamp.schemePostingTaxType != null && stamp.schemePostingTaxType.trim() !== decision.schemePostingTaxType.trim()) {
    return {
      ok: false,
      reason: withLedgerCheck(`the order was stamped on the zero-rated type ${stamp.schemePostingTaxType}, but the rate's Xero mapping now says ${decision.schemePostingTaxType}; it changed since the order was stamped, so the invoice is not posted on a type that a credit note would not reverse. Restore the rate's scheme posting type to ${stamp.schemePostingTaxType} (Settings > Tax Rates) and re-import the order, or post the invoice by hand in Xero`),
    }
  }
  const percent = schemeRatePercent(input)
  return {
    ok: true,
    route: {
      kind: 'scheme',
      regime: stamp.regime,
      vatAccount: stamp.vatAccount,
      vatAmount: decision.vatAmount,
      schemePostingTaxType: decision.schemePostingTaxType,
      vatDescription: `${DESTINATION_LABEL[stamp.regime]} — ${decision.basis.destination}${percent === null ? '' : ` ${percent}%`}`,
    },
  }
}

