import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * Xero rounds every line `UnitAmount` to 2 decimal places unless the request carries `unitdp=4`, which
 * makes it keep 4. IMS computes unit amounts to 4-6 dp (a tax-inclusive 9.99 x 3 at 20% is 8.325 net), so
 * without the parameter Xero's own total (8.33 x 3) can differ from the order by pennies and the payment
 * for the order's total is refused. Every POST/PUT that carries line items (invoices and bills, credit
 * notes and supplier credits, purchase orders) is sent with it; this is the one place that adds it.
 * Sub-resources (`Invoices/{id}/History`, `/Attachments`, ...) carry no line items and are left alone.
 */
export const XERO_UNIT_DP = 4
const XERO_LINE_ITEM_WRITE_PATH_RE = /^(?:Invoices|CreditNotes|PurchaseOrders)(?:\/[^/?]+)?(?:\?.*)?$/

export function xeroWritePath(method: 'GET' | 'POST' | 'PUT', path: string): string {
  if (method === 'GET' || !XERO_LINE_ITEM_WRITE_PATH_RE.test(path)) return path
  if (/[?&]unitdp=/i.test(path)) return path
  return `${path}${path.includes('?') ? '&' : '?'}unitdp=${XERO_UNIT_DP}`
}

/**
 * `unitdp=4` keeps four decimal places of a UnitAmount, but IMS holds unit prices to six (`subtotal / quantity`):
 * £100 over 300 units is 0.333333, which Xero keeps as 0.3333 and totals 300 x 0.3333 = 99.99, a penny short of the
 * order, so a later full payment is refused. Xero totals a line as round2(Quantity x UnitAmount at 4dp).
 *
 * A LINE'S QUANTITY IS NEVER ALTERED, WHATEVER IT CARRIES. A line with an ItemCode records a stock movement of that
 * quantity against a tracked Xero item, and even an untracked line's structured quantity is the document's record of
 * what was sold. So every line is sent as Quantity x UnitAmount (4dp), and the penny the 4dp price loses is made good by
 * ONE separate "Rounding adjustment" line per document (Quantity 1, no ItemCode, no tax) on the configured Rounding
 * account (the Xero setting `xero_rounding_difference_account`, 860 in the OneTwo3D chart: the same account the EU scheme
 * path already posts rounding to). With no Rounding account mapped the document is REFUSED rather than posted with a
 * total that differs from the order. One approach for every line, with or without an ItemCode, so the document looks the
 * same whatever the lines carry.
 */
export class XeroRoundingAccountMissingError extends Error {
  constructor(what: string, gap: string) {
    super(
      `${what} needs a rounding adjustment of ${gap}: IMS holds unit prices to six decimal places and Xero keeps four, so its line totals differ from the order's by that much. `
      + 'Map a Rounding account (Accounting settings, Xero, Rounding difference account) so the difference can be posted; nothing was sent.',
    )
    this.name = 'XeroRoundingAccountMissingError'
  }
}

type PricedLine = { quantity: number; unitAmount: number; discountAmount?: number | null }

/** The Quantity and 4dp UnitAmount a line is sent with. The quantity is the IMS quantity, untouched. */
export function xeroUnitDpFields(quantity: number, unitAmount: number): { Quantity: number; UnitAmount: number } {
  return { Quantity: quantity, UnitAmount: roundQuantity(unitAmount, XERO_UNIT_DP).toNumber() }
}

/** A line's discount as the connector sends it (DiscountAmount, whole pennies). */
const sentDiscount = (l: { discountAmount?: number | null }): Decimal =>
  l.discountAmount && l.discountAmount > 0 ? toDecimal(Math.round(l.discountAmount * 100) / 100) : toDecimal(0)

/** What the IMS lines total, less what Xero will total them to at unitdp=4 (each line rounded to 2dp, as Xero does). Zero when 4dp reproduces every line. The LINE AMOUNTS only: tax is `planXeroRoundingLine`'s business. */
export function unitDpLineGap(lines: readonly PricedLine[]): Decimal {
  let gap = toDecimal(0)
  for (const l of lines) {
    const q = toDecimal(l.quantity)
    const d = sentDiscount(l)
    const intended = roundQuantity(q.mul(toDecimal(l.unitAmount)).sub(d), 2)
    const asXeroSees = roundQuantity(q.mul(roundQuantity(l.unitAmount, XERO_UNIT_DP)).sub(d), 2)
    gap = gap.add(intended.sub(asXeroSees))
  }
  return gap
}

/**
 * True when 4dp changes the amount of ANY single line. This, not a zero SUM of the gaps, decides whether the document total has to be predicted: gaps of +0.03 on a 20% line and
 * -0.03 on a 0% line sum to zero but leave Xero's total (tax included) a penny off. Only when no line changes at all is the prediction (and the settings and rate-list reads) skipped.
 */
export function unitDpChangesAnyLine(lines: readonly PricedLine[]): boolean {
  return lines.some((l) => !unitDpLineGap([l]).isZero())
}

/**
 * THE XERO TAX MODEL USED TO PREDICT A DOCUMENT TOTAL. `rateOf` gives the effective percentage of a Xero tax type (null: not known).
 * NONE is always 0. Everything else comes from the stored Xero tax-rate list (tax-rate-lookup.ts), never from a guess.
 */
export type XeroTaxRateOf = (taxType: string) => number | null

/** One line as Xero sees it: Quantity x UnitAmount (less DiscountAmount), the TaxType it is taxed on. */
export type XeroTotalLine = { quantity: number; unitAmount: number; taxType?: string | null; discountAmount?: number | null }

/** Why a document's total cannot be predicted or reconciled. Operator-facing; nothing was sent. */
export class XeroRoundingUnreconcilableError extends Error {
  constructor(what: string, why: string) {
    super(`${what} cannot be posted: ${why} Nothing was sent, because a document whose total differs from the order's cannot be settled by a full payment.`)
    this.name = 'XeroRoundingUnreconcilableError'
  }
}

type Predicted = { ok: true; total: Decimal } | { ok: false; why: string }

/**
 * THE TOTAL XERO WILL HOLD FOR A DOCUMENT, computed the way Xero computes it. Per line: LineAmount = round2(Quantity x UnitAmount - DiscountAmount).
 * Tax is PER LINE and rounded to 2dp, for both line-amount types: Exclusive adds round2(LineAmount x rate) to the total; Inclusive carves
 * round2(LineAmount - LineAmount / (1 + rate)) out of the LineAmount, so the total is the sum of the line amounts and no rate is needed.
 * A rate that is not known (not in the stored list, or a multi-component type this model does not carry) makes an Exclusive total unpredictable.
 */
export function predictXeroDocumentTotal(lines: readonly XeroTotalLine[], inclusive: boolean, rateOf: XeroTaxRateOf | undefined): Predicted {
  let total = toDecimal(0)
  for (const l of lines) {
    const amount = roundQuantity(toDecimal(l.quantity).mul(toDecimal(l.unitAmount)).sub(sentDiscount(l)), 2)
    total = total.add(amount)
    if (inclusive) continue
    const type = (l.taxType ?? '').trim()
    const rate = type === 'NONE' ? 0 : type === '' ? null : (rateOf?.(type) ?? null)
    if (rate === null) return { ok: false, why: `the tax rate of ${type === '' ? 'a line with no tax type' : `tax type ${type}`} is not known (it is not in the stored Xero tax-rate list, or it has several components), so the tax Xero will compute cannot be predicted.` }
    total = total.add(roundQuantity(amount.mul(toDecimal(rate)).div(100), 2))
  }
  return { ok: true, total }
}

export type XeroRoundingPlanInput = {
  /** The IMS priced lines (full-precision unit amounts), in the order they are sent. */
  lines: readonly (PricedLine & { taxType?: string | null })[]
  /** The lines sent as they are on both sides (shipping, order discount): they carry no unit-price loss and change nothing. */
  extraLines?: readonly XeroTotalLine[]
  lineAmountsIncludeTax: boolean
  rateOf?: XeroTaxRateOf
  account: string | null | undefined
  what: string
}

/** The most the adjustment can legitimately be: what 4dp can lose on each line (0.00005 per unit, with tax) plus two minor units of per-line rounding. Anything past it is not a rounding difference. */
function adjustmentCap(input: XeroRoundingPlanInput): Decimal {
  let cap = toDecimal(0)
  for (const l of input.lines) {
    const type = (l.taxType ?? '').trim()
    const rate = input.lineAmountsIncludeTax || type === 'NONE' ? 0 : (input.rateOf?.(type) ?? 0)
    cap = cap.add(toDecimal(Math.abs(l.quantity)).mul('0.00005').mul(toDecimal(1).add(toDecimal(rate).div(100)))).add('0.02')
  }
  return cap
}

/**
 * THE ROUNDING ADJUSTMENT, sized from the whole document. The IMS total and Xero's predicted total are both worked out per line, with tax (see
 * `predictXeroDocumentTotal`); the adjustment is the difference, posted on the Rounding account with tax type NONE so its own tax is zero. The document
 * is then predicted AGAIN with the adjustment line in it, and must equal the IMS total exactly: if it does not, or if the figures cannot be
 * predicted at all, or the adjustment is larger than 4dp can account for, this THROWS and nothing is posted.
 * Returns null when Xero's total already equals the IMS total (no account is needed then).
 */
export function planXeroRoundingLine(input: XeroRoundingPlanInput): Record<string, unknown> | null {
  const { lines, extraLines = [], lineAmountsIncludeTax: inclusive, rateOf, what } = input
  if (!unitDpChangesAnyLine(lines)) return null
  const toTotalLine = (l: PricedLine & { taxType?: string | null }, unit: number): XeroTotalLine => ({ quantity: l.quantity, unitAmount: unit, taxType: l.taxType, discountAmount: l.discountAmount })
  const imsSide = [...lines.map((l) => toTotalLine(l, l.unitAmount)), ...extraLines]
  const xeroSide = [...lines.map((l) => toTotalLine(l, xeroUnitDpFields(l.quantity, l.unitAmount).UnitAmount)), ...extraLines]
  const ims = predictXeroDocumentTotal(imsSide, inclusive, rateOf)
  const xero = predictXeroDocumentTotal(xeroSide, inclusive, rateOf)
  if (!ims.ok) throw new XeroRoundingUnreconcilableError(what, ims.why)
  if (!xero.ok) throw new XeroRoundingUnreconcilableError(what, xero.why)
  const adjustment = roundQuantity(ims.total.sub(xero.total), 2)
  if (adjustment.isZero()) return null
  if (adjustment.abs().gt(adjustmentCap(input))) {
    throw new XeroRoundingUnreconcilableError(what, `Xero would total it ${xero.total.toFixed(2)} against the order's ${ims.total.toFixed(2)}, a difference of ${adjustment.toFixed(2)} that four-decimal unit prices and per-line tax rounding cannot explain.`)
  }
  const account = input.account?.trim() ?? ''
  if (!account) throw new XeroRoundingAccountMissingError(what, adjustment.toFixed(2))
  const line = { Description: 'Rounding adjustment', Quantity: 1, UnitAmount: adjustment.toNumber(), AccountCode: account, TaxType: 'NONE' }
  const after = predictXeroDocumentTotal([...xeroSide, { quantity: 1, unitAmount: line.UnitAmount, taxType: 'NONE' }], inclusive, rateOf)
  if (!after.ok || !after.total.eq(ims.total)) {
    throw new XeroRoundingUnreconcilableError(what, `with a rounding adjustment of ${adjustment.toFixed(2)} Xero would still total it ${after.ok ? after.total.toFixed(2) : 'differently'} against the order's ${ims.total.toFixed(2)}.`)
  }
  return line
}

/**
 * The guard behind "a line's quantity is never altered": the first `lines.length` items of a built document are the IMS lines in order, and each keeps
 * its IMS quantity. A line that carries an ItemCode would otherwise book a different stock movement against a TRACKED Xero item
 * (IsTrackedAsInventory), which cannot be seen from the document.
 */
export function assertXeroLineQuantitiesKept(lines: readonly { quantity: number; description?: string }[], lineItems: readonly Record<string, unknown>[]): void {
  lines.forEach((line, i) => {
    if (lineItems[i]?.Quantity !== line.quantity) {
      throw new Error(`Line ${i + 1} ("${line.description ?? ''}") was built with quantity ${String(lineItems[i]?.Quantity)} instead of ${line.quantity}; a line's quantity is never altered.`)
    }
  })
}
