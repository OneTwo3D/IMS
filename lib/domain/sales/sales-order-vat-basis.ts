/**
 * THE VAT BASIS OF A MANUALLY RAISED SALES ORDER, decided once and read the same way at every step.
 *
 * "Prices include VAT" is a statement about the amounts the operator typed. The order keeps ONE answer for the
 * whole document: the header's default rate. Each line, though, carries its own rate (resolved from its product's tax
 * category and the destination), and a line's net is cut out of its gross price at THAT rate when the order is stored.
 *
 * An order with "No VAT" as its default rate, prices flagged as including VAT and at least one line that resolves to a
 * real rate says two different things at once: the stored amounts read the typed price as gross (the line's rate is
 * taken out of it) while the document the ledger receives is decided from the header, which says there is no VAT, so
 * the same price goes out as a NET amount and the ledger adds the VAT a second time. Neither reading can be picked for
 * the operator without guessing what they meant, so the combination is refused where the order is written, and a
 * stored order that already holds it is refused where its invoice would be built.
 */

export const INCLUSIVE_PRICES_WITHOUT_ORDER_RATE_MESSAGE =
  'Prices are marked as including VAT, but the order has no default VAT rate while at least one line carries VAT. '
  + 'The amounts cannot be read two ways: choose the order\'s default VAT rate (the VAT is then taken out of the prices '
  + 'you entered, and sent to the accounting system as inclusive), or untick "Prices include VAT" and enter net prices. '
  + 'Nothing was saved.'

export const STORED_INCLUSIVE_PRICES_WITHOUT_ORDER_RATE_MESSAGE =
  'This order is marked as having VAT-inclusive prices but has no default VAT rate, while its lines carry VAT, so '
  + 'the invoice would reach the accounting system with the VAT added a second time. It was not queued and the order '
  + 'was not moved. This draft has to be cancelled and a new order created with the order\'s default VAT rate chosen (or with net prices).'

/** True when the order's VAT basis is contradictory in the way described above. */
export function inclusivePricesWithoutOrderRate(input: {
  pricesIncludeVat: boolean
  /** The header's default rate as a fraction (0.2 = 20%); null, 0 or absent means "No VAT". */
  orderRate: number | null | undefined
  /** True when any line carries VAT: its resolved rate is above zero (new order) or its stored VAT is (stored order). */
  anyLineCarriesVat: boolean
}): boolean {
  const orderRate = Number(input.orderRate ?? 0)
  return input.pricesIncludeVat && !(orderRate > 0) && input.anyLineCarriesVat
}

/**
 * WHAT BASIS ARE THIS ORDER'S STORED AMOUNTS IN? One answer, for the invoice builder, the reconciliation, the clone and every reader of the flag.
 *
 *  manual order, prices incl. VAT   unit prices and discounts GROSS (shipping is stored net and grossed up when sent)     -> amounts include VAT
 *  manual order, prices excl. VAT   everything NET                                                                       -> net
 *  CSV import                       goes through the manual creator: one of the two above
 *  WooCommerce order                unit prices, shipping and discounts are NET whatever the store displays (order-import.ts): its
 *                                   `pricesIncludeVat` is the storefront's display setting, not the basis of the stored amounts          -> net
 *
 * `pricesIncludeVat` alone is therefore not the basis. A WooCommerce-linked order is always net; any other order follows its flag.
 */
export function storedAmountsIncludeVat(order: { pricesIncludeVat: boolean | null | undefined; shoppingLinks?: ReadonlyArray<{ connector: string }> | null }): boolean {
  if (order.shoppingLinks?.some((link) => link.connector === 'woocommerce')) return false
  return !!order.pricesIncludeVat
}
