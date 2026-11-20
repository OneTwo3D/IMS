/**
 * THE MONEY OF A MANUAL SALES ORDER, AS ONE PURE FUNCTION (extracted from createSalesOrder, so updateSalesOrder prices an edited draft by exactly the same arithmetic).
 *
 * Given the table FX rate, the header's default VAT rate, the pricing basis and the lines (each with the rate it already resolved to), this derives every stored figure: each line's net, tax and base
 * amounts, the shipping (+ fees) net and tax, the order discount (capped at the lines' subtotal) with its tax, and the header's subtotal / tax / grand totals in both currencies. It reads no database, no
 * clock and no setting: resolving the FX rate and each line's tax rate stays with the caller (prepareSalesOrderWrite in app/actions/sales.ts), which is why the result can be pinned byte-for-byte by
 * tests/domain/sales/sales-order-write-model.test.ts against rows the pre-extraction createSalesOrder wrote.
 *
 * Storage convention:
 *   All *Foreign / *Base totals on SalesOrder are NET of tax (subtotal, shipping, discount). `taxForeign` holds the total VAT, `totalForeign` is the grand total (net + tax). Line rows also store NET totals.
 *   When pricesIncludeVat is true, unitPriceForeign remains the gross user-entered price so the UI can display gross values, but every aggregate field is net. The Xero payload reconstructs gross from
 *   stored net when lineAmountsIncludeTax is true.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { expectedSalesOrderLineTaxForeign } from '@/lib/domain/sales/sales-order-tax-validation'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { allocateOrderDiscountBase } from '@/lib/sales-currency'
import { buildDiscountTaxSplit, type DiscountTaxSplitEntry } from '@/lib/domain/sales/discount-tax-split'

function roundDecimalNumber(value: DecimalInput, precision: number): number {
  return roundQuantity(value, precision).toNumber()
}

function divideRoundedNumber(value: DecimalInput, divisor: DecimalInput, precision: number): number {
  return roundDecimalNumber(toDecimal(value).div(toDecimal(divisor)), precision)
}

export type WriteModelLineInput = {
  productId: string
  sku: string
  description: string
  qty: number
  unitPriceForeign: number
  /** A caller-supplied tax assertion (import / API boundaries); it is validated before the builder runs and only read here to pick the persisted tax. */
  taxForeign?: number | null
  discountStr?: string
  discountAmount?: number
}

export type WriteModelInput = {
  /** Foreign units per one base unit (1 for the base currency). */
  fxRate: number
  /** The header's default VAT rate; it taxes shipping, fees and the order discount (the per-line resolver only applies to lines). */
  vatRate: number
  pricesIncludeVat: boolean
  /** Each line with the rate it resolved to (manual override, resolver, or the order default). */
  lines: { input: WriteModelLineInput; rate: number; taxRateId: string | null; /** Only read when apportionDiscountTax is on: the code the line posts under, for the discount's per-rate split. */ accountingTaxType?: string | null; reverseCharge?: boolean }[]
  /** Gross when pricesIncludeVat. */
  shippingForeign?: number
  fees?: { description: string; amount: number }[]
  /** Gross when pricesIncludeVat. */
  orderDiscountForeign?: number
  /**
   * Tax the order discount at the LINES' rates instead of the header rate. The discount is apportioned across the lines by the same allocator the order analytics use
   * (allocateOrderDiscountBase: weighted by each line's net, or gross on a VAT-inclusive order, last line takes the rounding), each share taxed at its own line's rate, and the cap
   * is the lines' own gross. Off (the default) it is taxed at the header rate, which is what an already-posted document carries. Only the write of a NEW order or an EDIT reads this;
   * a stored order is never re-priced by it.
   */
  apportionDiscountTax?: boolean
}

export type WriteModelLine = {
  productId: string
  sku: string
  description: string
  qty: number
  unitPriceForeign: number
  unitPriceBase: number
  discountStr: string | null
  discountAmount: number
  taxForeign: number
  taxBase: number
  totalForeign: number
  totalBase: number
  taxRateId: string | null
}

export type WriteModelTotals = {
  subtotalForeign: number
  shippingForeign: number
  taxForeign: number
  totalForeign: number
  subtotalBase: number
  shippingBase: number
  taxBase: number
  totalBase: number
  /** The order discount as entered (gross when pricesIncludeVat), capped at the lines' subtotal. */
  discountAmount: number
}

export type SalesOrderWriteModel = {
  lines: WriteModelLine[]
  totals: WriteModelTotals
  /** The discount's tax by line rate. Present ONLY when `apportionDiscountTax` was on and there was a discount, so the model of a header-rate order is unchanged. */
  discountTaxSplit?: DiscountTaxSplitEntry[]
}

export function buildSalesOrderWriteModel(args: WriteModelInput): SalesOrderWriteModel {
  const { fxRate, vatRate } = args
  const inclVat = args.pricesIncludeVat
  let linesSubtotalForeign = toDecimal(0) // sum of line NETs, before order discount
  let linesSubtotalBase = toDecimal(0)
  let totalTaxForeign = toDecimal(0)
  let totalTaxBase = toDecimal(0)

  const round4 = (value: DecimalInput) => roundDecimalNumber(value, 4)

  const lineData: WriteModelLine[] = args.lines.map(({ input: l, rate, taxRateId }) => {
    const lineRate = rate
    const lineInclVat = inclVat && lineRate > 0
    const discAmt = l.discountAmount ?? 0 // in gross if inclVat, else net
    const lineGross = toDecimal(l.qty).mul(l.unitPriceForeign).sub(discAmt)
    const netForeign = lineInclVat ? lineGross.div(toDecimal(1).add(lineRate)) : lineGross
    const unitPriceBase = divideRoundedNumber(l.unitPriceForeign, fxRate, 6)
    const totalForeign = round4(netForeign)
    const totalBase = divideRoundedNumber(totalForeign, fxRate, 4)
    const lineTax = expectedSalesOrderLineTaxForeign({
      sku: l.sku,
      qty: l.qty,
      unitPriceForeign: l.unitPriceForeign,
      discountAmount: discAmt,
      taxRateValue: lineRate,
      taxForeign: l.taxForeign ?? null,
    }, inclVat)
    const lineTaxForeign = round4(lineTax)
    const lineTaxBase = divideRoundedNumber(lineTaxForeign, fxRate, 4)
    linesSubtotalForeign = linesSubtotalForeign.add(totalForeign)
    linesSubtotalBase = linesSubtotalBase.add(totalBase)
    totalTaxForeign = totalTaxForeign.add(lineTaxForeign)
    totalTaxBase = totalTaxBase.add(lineTaxBase)
    return {
      productId: l.productId,
      sku: l.sku,
      description: l.description,
      qty: l.qty,
      unitPriceForeign: l.unitPriceForeign, // ORIGINAL (gross if inclVat)
      unitPriceBase,
      discountStr: l.discountStr || null,
      discountAmount: discAmt,
      taxForeign: lineTaxForeign,
      taxBase: lineTaxBase,
      totalForeign, // NET
      totalBase,
      taxRateId,
    }
  })

  // Shipping (+ fees). Input shippingForeign is gross when inclVat.
  // Shipping / fees / order discount are always taxed at the order-default
  // rate (the per-line resolver only applies to line items).
  const shippingInclVat = inclVat && vatRate > 0
  const shippingInput = args.shippingForeign ?? 0
  let feesTotalForeign = toDecimal(0)
  if (args.fees?.length) for (const f of args.fees) feesTotalForeign = feesTotalForeign.add(f.amount)
  const totalShippingInput = toDecimal(shippingInput).add(feesTotalForeign)
  const shippingNetForeign = shippingInclVat ? totalShippingInput.div(toDecimal(1).add(vatRate)) : totalShippingInput
  const shippingTaxForeign = shippingInclVat
    ? totalShippingInput.sub(shippingNetForeign)
    : (vatRate > 0 ? shippingNetForeign.mul(vatRate) : toDecimal(0))
  const shippingNetForeignR = round4(shippingNetForeign)
  const shippingTaxForeignR = round4(shippingTaxForeign)
  const shippingNetBase = divideRoundedNumber(shippingNetForeignR, fxRate, 4)
  const shippingTaxBase = divideRoundedNumber(shippingTaxForeignR, fxRate, 4)
  totalTaxForeign = totalTaxForeign.add(shippingTaxForeignR)
  totalTaxBase = totalTaxBase.add(shippingTaxBase)

  // Order-level discount — cap at line subtotal (compare in gross when inclVat).
  const rawOrderDisc = args.orderDiscountForeign ?? 0
  let orderDiscForeign: Prisma.Decimal
  let discNetForeign: Prisma.Decimal
  let discTaxForeign: Prisma.Decimal
  let discountShares: number[] | null = null
  if (args.apportionDiscountTax && lineData.length > 0) {
    // Each line's share of the discount is taxed at that line's own rate (the header rate does not apply to goods that carry another one).
    const grossCap = lineData.reduce((sum, l, i) => sum.add(inclVat ? toDecimal(l.totalForeign).mul(toDecimal(1).add(args.lines[i]!.rate)) : toDecimal(l.totalForeign)), toDecimal(0))
    orderDiscForeign = Prisma.Decimal.min(toDecimal(rawOrderDisc), grossCap)
    const shares = allocateOrderDiscountBase(
      { fxRateToBase: 1, pricesIncludeVat: inclVat, taxRatePercent: vatRate, discountAmount: orderDiscForeign.toNumber() },
      lineData.map((l, i) => ({ totalBase: l.totalForeign, totalForeign: l.totalForeign, taxRatePercent: args.lines[i]!.rate })),
    )
    discountShares = shares
    discNetForeign = shares.reduce((sum, share) => sum.add(share), toDecimal(0))
    discTaxForeign = shares.reduce((sum, share, i) => sum.add(toDecimal(share).mul(args.lines[i]!.rate)), toDecimal(0))
  } else {
    const linesGrossForCap = shippingInclVat
      ? toDecimal(linesSubtotalForeign).mul(toDecimal(1).add(vatRate))
      : toDecimal(linesSubtotalForeign)
    orderDiscForeign = Prisma.Decimal.min(toDecimal(rawOrderDisc), linesGrossForCap)
    discNetForeign = shippingInclVat ? orderDiscForeign.div(toDecimal(1).add(vatRate)) : orderDiscForeign
    discTaxForeign = shippingInclVat ? orderDiscForeign.sub(discNetForeign) : (vatRate > 0 ? discNetForeign.mul(vatRate) : toDecimal(0))
  }
  const discNetForeignR = round4(discNetForeign)
  const discTaxForeignR = round4(discTaxForeign)
  const discNetBase = divideRoundedNumber(discNetForeignR, fxRate, 4)
  const discTaxBase = divideRoundedNumber(discTaxForeignR, fxRate, 4)
  totalTaxForeign = totalTaxForeign.sub(discTaxForeignR)
  totalTaxBase = totalTaxBase.sub(discTaxBase)

  // Subtotal stored PRE-discount (sum of line nets) — matches the WC
  // importer convention so display / accounting code can handle both
  // sources uniformly.
  const subtotalForeign = round4(linesSubtotalForeign)
  const subtotalBase = round4(linesSubtotalBase)
  const totalTaxForeignRounded = round4(totalTaxForeign)
  const totalTaxBaseRounded = round4(totalTaxBase)

  // Grand total = subtotal (net, pre-discount) − net discount + net
  // shipping + total tax. Tax already nets the discount VAT above.
  const grandTotalForeign = round4(toDecimal(subtotalForeign).sub(discNetForeignR).add(shippingNetForeignR).add(totalTaxForeignRounded))
  const grandTotalBase = round4(toDecimal(subtotalBase).sub(discNetBase).add(shippingNetBase).add(totalTaxBaseRounded))

  const discountTaxSplit = discountShares && discNetForeignR > 0
    ? buildDiscountTaxSplit({
        lines: args.lines.map((l) => ({ taxRateId: l.taxRateId, accountingTaxType: l.accountingTaxType ?? null, reverseCharge: l.reverseCharge === true, rate: l.rate })),
        shares: discountShares,
        fxRate,
        totalNetForeign: discNetForeignR,
        totalTaxForeign: discTaxForeignR,
        totalNetBase: discNetBase,
        totalTaxBase: discTaxBase,
      })
    : undefined

  return {
    ...(discountTaxSplit && discountTaxSplit.length > 0 ? { discountTaxSplit } : {}),
    lines: lineData,
    totals: {
      subtotalForeign,
      shippingForeign: shippingNetForeignR,
      taxForeign: totalTaxForeignRounded,
      totalForeign: grandTotalForeign,
      subtotalBase,
      shippingBase: shippingNetBase,
      taxBase: totalTaxBaseRounded,
      totalBase: grandTotalBase,
      // Store the order discount in the same convention as WC import: the raw user-entered amount (gross when inclVat).
      discountAmount: round4(orderDiscForeign),
    },
  }
}
