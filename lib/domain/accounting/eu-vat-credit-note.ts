/**
 * THE EU IOSS / VOEC / DDP TREATMENT OF A SALES CREDIT NOTE PAYLOAD. Pure: no database, no clock, no WooCommerce types. The credit-note half of lib/domain/accounting/eu-vat-treatment.ts, and it reuses that file's
 * constants, its untaxed-total arithmetic and the same marker key, so an invoice and the credit note that reverses it are judged by one set of rules.
 *
 * THE RULE. A credit note on a scheme order takes the regime and the VAT account from the order's write-once stamp (eu-vat-regime-stamp.ts) and never decides them again: the exchange rate on the day chose the
 * regime, and a later rate could choose the other. A scheme order that carries no stamp REFUSES (`noStampRefusal`); nothing is guessed from the rates it was sold on.
 *
 * WHAT IT BUILDS, for a scheme-stamped order:
 *   goods, shipping and the order discount   each on the scheme's zero-rated posting type, at net, accounts unchanged. The type is the one SNAPSHOTTED on the refund line (`SalesOrderRefundLine.postingTaxType`), never the
 *                                            rate's own code, which would make Xero add VAT.
 *   a refunded landed-cost fee               on the fee account (232) on NONE, net, noTaxKind `fee-no-tax`. ONLY the fees this refund touches are present: the payload is built from the refund's own lines.
 *   ONE VAT line                             the refund's own tax total, on the stamped account (821 IOSS/VOEC, 232 DDP), on NONE, noTaxKind `eu-vat-recovery`. A refund with no tax carries no VAT line.
 *   NEVER                                    a store-credit line (none exists in a refund's lines; the poster's store-credit guard refuses the whole credit note on a store-credit order).
 * THE INVARIANT. Every line is on a zero-rated type or on NONE, so Xero adds no tax and the document totals the sum of its lines. That sum must equal the refund's amount EXACTLY, to the minor unit. No rounding line: the
 * refund's amount is the source's own figure, and a difference means a figure is wrong, so it refuses.
 *
 * WOOCOMMERCE RATE 182. The EAS compliance plugin re-prices a refund on its own orders, books the refund's VAT under its own tax rate (182) whatever rate the order charged, and leaves fee lines out. While the Sales Invoices switch is on, such a refund on a
 * scheme-stamped order is recorded and its VAT is booked as the credit note's ONE VAT line on the order's STAMPED account (`eas182RefundFigures`): the tax is the sum across ALL rate ids, confirmed against the refund's own stated gross and held to the order's collected VAT
 * not already refunded. The first N such credit notes (the owner's ruling) are queued as a refused, settle-by-hand row for a person to check (`refund182HeldRefusal`); after that they post. A refund whose figures fail either check refuses. `easRefundRefusal` remains the wording
 * for a rate-182 refund whose tax figure cannot be read at all.
 */
import { withLedgerCheck } from './hand-post-instruction'
import { currencyMinorUnits, roundMoney, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { EU_VAT_TREATMENT_PAYLOAD_KEY, predictedUntaxedTotal, type TreatableLine, type TreatablePayload } from './eu-vat-treatment'

export { EU_VAT_TREATMENT_PAYLOAD_KEY }

/** The WooCommerce tax rate id the EAS compliance plugin books a refund's VAT under (`eascompliance_tax_rate_id()`), whatever rate the order charged. */
export const EAS_REFUND_TAX_RATE_ID = 182

const NO_TAX = 'NONE'

/** The WooCommerce refund as far as rate 182 is concerned: each refunded item and shipping line states the tax it returned per rate id. */
export type RefundTaxCarrier = {
  line_items?: ReadonlyArray<{ taxes?: ReadonlyArray<{ id?: unknown; total?: unknown }> | null }> | null
  shipping_lines?: ReadonlyArray<{ taxes?: ReadonlyArray<{ id?: unknown; total?: unknown }> | null }> | null
  fee_lines?: ReadonlyArray<{ taxes?: ReadonlyArray<{ id?: unknown; total?: unknown }> | null }> | null
}

/** The tax (absolute, as text) a WooCommerce refund carries on rate 182, or null when it carries none. A 182 entry with an unreadable figure counts as carried (fail closed). */
export function refundTaxOnEasRate(refund: RefundTaxCarrier): string | null {
  let sum = toDecimal(0)
  let found = false
  for (const group of [refund.line_items ?? [], refund.shipping_lines ?? [], refund.fee_lines ?? []]) {
    for (const item of group) {
      for (const entry of item.taxes ?? []) {
        if (Number(entry?.id) !== EAS_REFUND_TAX_RATE_ID) continue
        const text = typeof entry.total === 'number' ? String(entry.total) : typeof entry.total === 'string' ? entry.total.trim() : ''
        if (!/^-?\d+(\.\d+)?$/.test(text)) { found = true; sum = sum.plus(1); continue }
        const amount = toDecimal(text).abs()
        if (amount.isZero()) continue
        found = true
        sum = sum.plus(amount)
      }
    }
  }
  return found ? sum.toString() : null
}

/** What the operator reads when a scheme order's WooCommerce refund carries its VAT on rate 182. */
export const easRefundRefusal = (refundId: string | number, amount: string): string =>
  withLedgerCheck(`WooCommerce refund ${refundId} was NOT recorded: its VAT (${amount}) is booked on WooCommerce tax rate 182, the rate the EAS compliance plugin uses when it re-prices a refund, on an order IMS posts under the EU IOSS/VOEC/DDP scheme. `
  + 'IMS does not post a credit note on a figure the EAS plugin re-priced (it also leaves fee lines out). Nothing was sent to Xero. Open this refund in the sync exceptions inbox and record it manually: IMS then credits the order\'s own lines at the VAT the order was charged. '
  + 'Check the credit note in Xero against the WooCommerce refund amount before it is released.')

/** The tax (absolute, as text) a WooCommerce refund states across ALL its rate ids, and whether any figure could not be read (then the sum is not a figure at all). */
export function refundStatedTax(refund: RefundTaxCarrier): { total: string; unreadable: boolean } {
  let sum = toDecimal(0)
  let unreadable = false
  for (const group of [refund.line_items ?? [], refund.shipping_lines ?? [], refund.fee_lines ?? []]) {
    for (const item of group) {
      for (const entry of item.taxes ?? []) {
        const text = typeof entry?.total === 'number' ? String(entry.total) : typeof entry?.total === 'string' ? entry.total.trim() : ''
        if (!/^-?\d+(\.\d+)?$/.test(text)) { unreadable = true; continue }
        sum = sum.plus(toDecimal(text).abs())
      }
    }
  }
  return { total: sum.toString(), unreadable }
}

/**
 * THE FIGURES OF A RATE-182 SCHEME CREDIT NOTE. Pure. The VAT is the refund's stated gross less the net of its lines (so the credit note totals the refund exactly, as every scheme credit note does), and it is:
 *   confirmed against the tax the refund itself states across all its rate ids (`statedTax`), within `toleranceMinorUnits` of a minor unit: the figure the EAS plugin re-priced is not trusted on its own, and the refund's lines' own rates are NOT consulted (the plugin books its own);
 *   held, in the AGGREGATE, to the order's collected VAT: the VAT of the earlier refunds (`priorRefundedTax`) plus this one may not exceed `orderTax` by more than ONE fixed allowance of the order's own (`orderAllowanceMinorUnits`), and nothing positive is accepted once it is all refunded. `priorRefundedTax` null means an earlier refund's VAT cannot be established, which refuses.
 */
export function eas182RefundFigures(input: { net: Decimal; statedGross: Decimal; statedTax: Decimal; orderTax: Decimal; priorRefundedTax: Decimal | null; currency: string; toleranceMinorUnits: number; /** The ONE rounding allowance for the whole order's VAT bound, in minor units (the order's own, fixed: not granted again per refund). */ orderAllowanceMinorUnits: number }): { ok: true; vatAmount: string; refundTotal: string } | { ok: false; reason: string } {
  const { currency } = input
  const gross = roundMoney(input.statedGross, currency)
  const vat = gross.minus(input.net)
  const minor = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(currency)))
  const allowance = minor.times(Math.max(1, input.toleranceMinorUnits))
  if (vat.isNegative()) return { ok: false, reason: `the refund states ${gross.toString()} ${currency} in all, which is less than the ${input.net.toString()} its lines net to` }
  if (vat.minus(input.statedTax).abs().gt(allowance)) {
    return { ok: false, reason: `the refund states ${gross.toString()} ${currency} in all, so ${vat.toString()} of tax over a net of ${input.net.toString()}, but the tax it states across its tax rates is ${roundMoney(input.statedTax, currency).toString()}; that is more than rounding explains` }
  }
  if (input.priorRefundedTax === null) return { ok: false, reason: 'the VAT of an earlier refund on this order cannot be established, so this refund\'s VAT cannot be held to what is left to refund' }
  // THE BOUND IS ON THE AGGREGATE: all the VAT credited across the order's refunds, this one included, may not exceed the order's collected VAT plus ONE fixed allowance of the order's own. The allowance is not granted again per refund, and once the collected VAT is used up no further positive VAT is accepted.
  const left = input.orderTax.minus(input.priorRefundedTax)
  const orderAllowance = minor.times(Math.max(1, input.orderAllowanceMinorUnits))
  if (vat.gt(0) && !left.gt(0)) {
    return { ok: false, reason: `the order's collected VAT (${roundMoney(input.orderTax, currency).toString()} ${currency}) has already been refunded, so this refund's VAT (${vat.toString()} ${currency}) is more than the order's collected VAT not already refunded (0 ${currency})` }
  }
  if (input.priorRefundedTax.plus(vat).gt(input.orderTax.plus(orderAllowance))) {
    return { ok: false, reason: `the refund's VAT (${vat.toString()} ${currency}) is more than the order's collected VAT not already refunded (${roundMoney(left.isNegative() ? toDecimal(0) : left, currency).toString()} ${currency} of ${roundMoney(input.orderTax, currency).toString()})` }
  }
  return { ok: true, vatAmount: vat.toString(), refundTotal: gross.toString() }
}

/** What the operator reads when a rate-182 scheme credit note is one of the first N, held for a person to check. The same refused, settleable row as the hand-post cases: never sent. */
export const refund182HeldRefusal = (input: { creditNoteNumber: string; heldNumber: number; threshold: number; vatAccount: string; vatAmount: string; refundTotal: string; currency: string }): string =>
  withLedgerCheck(`NOTHING WAS SENT. Credit note ${input.creditNoteNumber} is on a refund whose VAT the EAS compliance plugin booked on WooCommerce tax rate 182, on an order sold under the EU IOSS/VOEC/DDP scheme. IMS posts such a VAT to the order's stamped VAT account (${input.vatAccount}), and the first ${input.threshold} of these credit notes are held for a person to review before any is released; this is number ${input.heldNumber}. `
  + `The credit note would total ${input.refundTotal} ${input.currency}, of which ${input.vatAmount} is VAT. This row is refused and is never sent. Check Xero for credit note ${input.creditNoteNumber} first. If it is not there, post the credit note by hand in Xero for ${input.refundTotal} ${input.currency}, with the VAT on account ${input.vatAccount} and the tax type of the order's invoice, and review it against the WooCommerce refund. Then record the outcome on this row with the settle action on /sync.`)

/** What the operator reads when a credit note is raised on a scheme order that has no stamp. */
/** What the operator reads when the invoice's zero-rated posting type cannot be established for a scheme credit note (the stamp was written before it was kept). The same refused, settleable row as the no-stamp case. */
export const noInvoicedTypeRefusal = (creditNoteNumber: string): string =>
  withLedgerCheck(`NOTHING WAS SENT. Credit note ${creditNoteNumber} is on an order sold under the EU IOSS/VOEC/DDP scheme, but IMS did not record which zero-rated Xero tax type the order's invoice was posted on, and a rate's mapping may have changed since, so it will not guess. `
  + `This row is refused and is never sent. Check Xero for credit note ${creditNoteNumber} first. If it is not there, open the order's invoice in Xero, post the credit note by hand on the same tax type that invoice used and on the stamped VAT account (821 for IOSS and VOEC, 232 for DDP). Then record the outcome on this row with the settle action on /sync.`)

/** What the operator reads when a scheme refund has no frozen pricing (it predates the snapshot, or a line's rate could not be priced when it was created). The same refused, settleable row. */
export const noFrozenBasisRefusal = (creditNoteNumber: string): string =>
  withLedgerCheck(`NOTHING WAS SENT. Credit note ${creditNoteNumber} is on an order sold under the EU IOSS/VOEC/DDP scheme, but the refund did not record the VAT rate and amount it was priced at when it was created, and IMS will not price it again from rates that may have changed since. `
  + `This row is refused and is never sent. Check Xero for credit note ${creditNoteNumber} first. If it is not there, post the credit note by hand in Xero for the amount the customer was refunded, on the stamped VAT account (821 for IOSS and VOEC, 232 for DDP) and the tax type of the order's invoice. Then record the outcome on this row with the settle action on /sync.`)

/** What the operator reads when a refund that was created under the EU IOSS/VOEC/DDP scheme treatment cannot have that treatment applied now (the stamp is missing or is outside the scheme, or the accounting connector is no longer Xero). It is never sent as an ordinary credit note. The same refused, settleable row. */
export const persistedSchemeUntreatableRefusal = (creditNoteNumber: string): string =>
  withLedgerCheck(`NOTHING WAS SENT. Credit note ${creditNoteNumber} is on a refund that IMS recorded under the EU IOSS/VOEC/DDP scheme treatment, but the order's recorded VAT regime (or the accounting connector) no longer allows that treatment to be applied, so IMS will not send it as an ordinary credit note, which would add VAT in Xero. `
  + `This row is refused and is never sent. Check Xero for credit note ${creditNoteNumber} first. If it is not there, post the credit note by hand in Xero for the amount the customer was refunded, on the account the order's invoice used for its VAT (821 for IOSS and VOEC, 232 for DDP) and the zero-rated type of the order's scheme rate. Then record the outcome on this row with the settle action on /sync.`)

export const noStampRefusal = (creditNoteNumber: string): string =>
  withLedgerCheck(`NOTHING WAS SENT. Credit note ${creditNoteNumber} is on an order sold under the EU IOSS/VOEC/DDP scheme, but the order has no recorded VAT regime (it was imported before the Sales Invoices switch was on, or its regime could not be decided), so IMS cannot tell which account its VAT was posted to and will not guess. `
  + `This row is refused and is never sent. Check Xero for credit note ${creditNoteNumber} first. If it is not there, post the credit note by hand in Xero on the same VAT account the order's invoice used (821 for IOSS and VOEC, 232 for DDP) and the zero-rated type of the order's scheme rate. Then record the outcome on this row with the settle action on /sync.`)

/** The payload key a REFUSED credit-note row carries: the poster refuses any row holding it, before anything else, so the row can be claimed and shown on /sync and settled by hand but never sent. */
export const EU_VAT_CREDIT_NOTE_REFUSED_KEY = '_euVatCreditNoteRefused'

/**
 * The payload of a REFUSED credit-note row: a dedicated, NON-POSTABLE record. The marker and the reason, the credit note's number, currency, reference and date, the refund and order it is for, and the amount it would have been (net, in the document currency). NO lines and no tax types, so no tax-code binding can reach
 * the enqueue's retired-code guard (a tax re-key that retired a line's code would otherwise stop the row from existing and leave nothing to settle) and nothing in it could ever be posted.
 */
export function refusedCreditNotePayload(input: { creditNoteNumber: unknown; currency: unknown; reference: unknown; date: unknown; refundId: string; orderId: string; lines: unknown; reason: string }): Record<string, unknown> {
  const lines = Array.isArray(input.lines) ? (input.lines as Array<{ quantity?: unknown; unitAmount?: unknown }>) : []
  const net = lines.reduce((sum, line) => sum.plus(toDecimal(Number(line.quantity ?? 0)).times(toDecimal(Number(line.unitAmount ?? 0)))), toDecimal(0))
  return {
    creditNoteNumber: input.creditNoteNumber,
    currency: input.currency,
    reference: input.reference,
    date: input.date,
    lines: [],
    [EU_VAT_CREDIT_NOTE_REFUSED_KEY]: { reason: input.reason, refundId: input.refundId, orderId: input.orderId, netAmount: net.toString() },
  }
}

/** The refusal a REFUSED credit-note row (one carrying the key above) always answers with, or null for any other payload. The poster returns it before anything else. */
export function refusedCreditNoteError(payload: Record<string, unknown>): string | null {
  const marker = payload[EU_VAT_CREDIT_NOTE_REFUSED_KEY] as { reason?: unknown } | null | undefined
  if (marker === undefined || marker === null) return null
  return typeof marker.reason === 'string' && marker.reason !== '' ? marker.reason : 'NOTHING WAS SENT. This credit note was refused when it was built and is never sent.'
}

export type CreditNoteLineKind = 'goods' | 'marked-fee'

export type EuVatCreditNotePlan = {
  /** From the order's stamp: never decided again. */
  regime: 'IOSS' | 'VOEC' | 'DDP'
  vatAccount: string
  /** One entry per payload line, in order. */
  lineKinds: readonly CreditNoteLineKind[]
  /** The posting type snapshotted on each refund line, aligned with the payload's lines. */
  linePostingTypes: ReadonlyArray<string | null>
  /** The account a refunded landed-cost fee posts to (232), or null when not configured. */
  feeAccount: string | null
  /** The refund's own tax total, in the document currency (zero or more). */
  vatAmount: string
  /** The amount the document must total, exactly. */
  refundTotal: string
  /** The line text, for example "IOSS VAT refunded — DE". */
  vatDescription: string
  /** Why the posting type cannot be relied on (unknown, not ACTIVE, not revenue, not exactly 0%, or the stored Xero list cannot prove it), or null. REQUIRED, never defaulted. */
  schemePostingTypeProblem: string | null
}

export type EuVatCreditNoteResult<P extends TreatablePayload> =
  | { ok: true; payload: P; applied: { regime: string; schemePostingTaxType: string; feesRecoded: number; vatLine: boolean } }
  | { ok: false; reason: string }

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
const isBlank = (value: string | null | undefined): boolean => (value ?? '').trim() === ''

function dec(value: unknown): Decimal | null {
  if (typeof value === 'number') return Number.isFinite(value) ? toDecimal(value) : null
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return toDecimal(value.trim())
  return null
}

const BINDING_KEYS = ['taxRateId', 'taxRateBasis'] as const

function withoutBinding<T extends Record<string, unknown>>(value: T): T {
  const copy: Record<string, unknown> = { ...value }
  for (const key of BINDING_KEYS) delete copy[key]
  return copy as T
}

export function applyEuVatCreditNoteTreatment<P extends TreatablePayload>(payload: P, plan: EuVatCreditNotePlan): EuVatCreditNoteResult<P> {
  if (plan.lineKinds.length !== payload.lines.length || plan.linePostingTypes.length !== payload.lines.length) {
    return refuse('the credit note lines and the refund lines do not line up, so the EU VAT treatment cannot be applied')
  }
  if (payload.lines.length === 0) return refuse('the credit note has no lines')
  if (payload.lineAmountsIncludeTax === true) return refuse('the credit note is built tax-inclusive, which the EU VAT treatment does not support; every line must be tax-exclusive')
  if (isBlank(plan.vatAccount)) return refuse('the order\'s stamp names no account for the VAT line')
  if (plan.schemePostingTypeProblem !== null) return refuse(plan.schemePostingTypeProblem)

  // The refund lines were snapshotted together, so they name ONE posting type. A line with none, or two types, is a refund IMS cannot post on a decided type.
  const types = new Set(plan.linePostingTypes.map((type) => (type ?? '').trim()))
  if (types.has('')) return refuse('a refund line has no scheme posting type snapshot (the refund predates the order\'s regime stamp, or the order\'s rates name none), so IMS cannot book it on the scheme\'s zero-rated type')
  if (types.size !== 1) return refuse(`the refund lines name more than one scheme posting type (${[...types].join(', ')})`)
  const schemePostingTaxType = [...types][0]!

  const marked = plan.lineKinds.filter((kind) => kind === 'marked-fee').length
  if (marked > 0 && isBlank(plan.feeAccount)) return refuse('a landed-cost fee is on the refund but the "EU landed-cost fees" account is not configured, so the fee cannot be posted')

  const lines: TreatableLine[] = payload.lines.map((line, index) => {
    if (plan.lineKinds[index] === 'marked-fee') {
      return { ...withoutBinding(line), accountCode: plan.feeAccount!.trim(), taxType: NO_TAX, noTaxKind: 'fee-no-tax', euFeeMarked: true }
    }
    return { ...withoutBinding(line), taxType: schemePostingTaxType }
  })

  const vat = dec(plan.vatAmount)
  if (vat === null) return refuse('the refund\'s tax cannot be read')
  if (vat.isNegative()) return refuse('the refund\'s tax is negative, so it cannot be reversed on the VAT account')
  const currency = payload.currency
  let next: P = { ...payload, lines }
  const vatLine = !vat.isZero()
  if (vatLine) {
    const line: TreatableLine = {
      description: plan.vatDescription,
      quantity: 1,
      unitAmount: roundMoney(vat, currency).toNumber(),
      accountCode: plan.vatAccount.trim(),
      taxType: NO_TAX,
      noTaxKind: 'eu-vat-recovery',
    }
    // Exactly one line on the VAT account that is not a fee (for DDP the fee account IS the VAT account, so fee lines sit beside it).
    const onVatAccount = next.lines.filter((existing) => existing.accountCode.trim() === line.accountCode && existing.noTaxKind !== 'fee-no-tax')
    if (onVatAccount.length > 0) return refuse(`a line other than the VAT line is already posted to the VAT account ${line.accountCode}`)
    next = { ...next, lines: [...next.lines, line] }
  }

  const refundTotal = dec(plan.refundTotal)
  if (refundTotal === null) return refuse('the refund amount cannot be read, so the credit note cannot be checked against it')
  const predicted = predictedUntaxedTotal(next)
  if (predicted === null) return refuse('a line amount cannot be read, so the credit note cannot be checked against the refund')
  const target = roundMoney(refundTotal, currency)
  if (!predicted.eq(target)) {
    return refuse(`the credit note would total ${predicted.toString()} ${currency} but the refund is ${target.toString()} (difference ${target.minus(predicted).toString()}); a credit note on this scheme must total the refund exactly, so it is not sent`)
  }

  return { ok: true, payload: next, applied: { regime: plan.regime, schemePostingTaxType, feesRecoded: marked, vatLine } }
}

/**
 * The refund's own tax total and the amount the credit note must total, from the refund's figures. Pure.
 *   `statedGross` present (a WooCommerce refund): the amount the source says it returned. The tax is that less the net of the lines, and it must be within `tolerance` of the tax the lines' own rates give (`pricedTax`):
 *       a refund whose stated amount is far from its lines' own tax is not posted on either figure.
 *   absent (a manual refund): the total is the refund's own recorded line totals with their tax, rounded once (`rawGross`), and the tax is that less the net the lines are sent at.
 * `net` is what the credit note's lines sum to (predictedUntaxedTotal of the payload before the treatment).
 */
export function refundTaxAndTotal(input: { net: Decimal; pricedTax: Decimal; /** The refund's recorded, UNROUNDED line totals with their tax. */ rawGross: Decimal; statedGross: Decimal | null; currency: string; toleranceMinorUnits: number }): { ok: true; vatAmount: string; refundTotal: string } | { ok: false; reason: string } {
  const { net, pricedTax, currency } = input
  if (input.statedGross === null) {
    // The target is the refund's own recorded total (unrounded lines plus their tax), rounded ONCE: rounding each line first and adding the tax on top can come to a cent more than the refund (0.03 at 20%: a 0.025 net line is sent as 0.03, and 0.01 of tax on top would make 0.04).
    const total = roundMoney(input.rawGross, currency)
    const vat = total.minus(net)
    if (vat.isNegative()) return { ok: false, reason: `the refund's recorded total (${total.toString()} ${currency}) is less than the ${net.toString()} its lines are sent at` }
    return { ok: true, vatAmount: vat.toString(), refundTotal: total.toString() }
  }
  const gross = roundMoney(input.statedGross, currency)
  const vat = gross.minus(net)
  const minor = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(currency)))
  if (vat.isNegative()) return { ok: false, reason: `the refund states ${gross.toString()} ${currency} in all, which is less than the ${net.toString()} its lines net to` }
  if (vat.minus(pricedTax).abs().gt(minor.times(Math.max(1, input.toleranceMinorUnits)))) {
    return { ok: false, reason: `the refund states ${gross.toString()} ${currency} in all, so ${vat.toString()} of tax over a net of ${net.toString()}, but its lines' own rates give ${roundMoney(pricedTax, currency).toString()}; that is more than rounding explains` }
  }
  return { ok: true, vatAmount: vat.toString(), refundTotal: gross.toString() }
}
