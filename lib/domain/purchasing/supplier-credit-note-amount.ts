import { Prisma } from '@/app/generated/prisma/client'

/**
 * A supplier credit note's amount in the BASE currency.
 *
 * `fxRateToBase` is stored as FOREIGN units per ONE base unit (EUR 1.17 = GBP 1), so the base amount is
 * the foreign amount DIVIDED by the rate, exactly as a purchase order's lines are converted. Multiplying
 * (the previous behaviour of the credit-note action) books EUR 100 at 1.17 as 117.00 instead of 85.47.
 *
 * Decimal throughout, rounded half away from zero to 4dp: the precision of `amount_base`. A rate that is
 * not above zero is refused rather than turned into Infinity or a silent zero.
 */
export function supplierCreditNoteAmountBase(
  amountForeign: Prisma.Decimal | number | string,
  fxRateToBase: Prisma.Decimal | number | string,
): Prisma.Decimal {
  const rate = new Prisma.Decimal(fxRateToBase)
  if (!rate.gt(0)) throw new Error('The exchange rate of a supplier credit note must be greater than zero')
  return new Prisma.Decimal(amountForeign).div(rate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
}
