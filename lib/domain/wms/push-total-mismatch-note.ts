/**
 * The text the exceptions page shows above the mismatch list. Single-sourced here (a dependency-free file, so the
 * client page can import it without pulling in the Decimal/Prisma runtime) so the page and the guard
 * cannot drift apart. It states only what the flag proves: the order WAS pushed (the
 * flag is written after a successful push) and that one of the two checks found figures that disagree. It does not say which side is
 * right, and it does not tell the operator to correct anything unconditionally.
 */
export const PUSH_TOTAL_MISMATCH_OPERATOR_NOTE =
  'Advisory: these orders were pushed to the warehouse, but their totals do not add up by more than '
  + 'rounding can explain: either the order\'s own subtotal, tax, shipping and discount do not add up to '
  + 'its total, or the figures sent to the warehouse (lines, shipping, discount and VAT) do not add up '
  + 'to the order total IMS holds. Compare the order with the warehouse order before relying on either '
  + 'total; once they agree, the flag can be cleared.'

/**
 * Format a recorded mismatch (whole MINOR units of the order currency) for the exceptions page, scaled by that
 * currency's own decimal places: 200 GBP minor units is 2.00, 200 JPY is 200, 2000 KWD (3dp) is 2.000.
 */
export function formatMismatchAmount(minorUnitsAmount: number, currency: string, decimals: number): string {
  return (minorUnitsAmount / 10 ** decimals).toLocaleString('en-GB', {
    style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  })
}
