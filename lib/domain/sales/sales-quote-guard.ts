/**
 * THE LOCKED QUOTE GUARD (o3d-ngmt.16). A quote is an offer, not an order: it takes no payment, is not paid, refunded, invoiced, allocated or shipped until it
 * has been converted. Every action that moves money or stock for an order calls this AFTER it has locked the order row, so the flag is read under the same
 * lock the conversion takes (a quote converted a moment ago is an order, one still a quote is refused).
 * Actions that are harmless on a quote (notes, addresses, edit, clone, delete, cancel, convert, the withdrawal hold) deliberately do not call it.
 */
export class QuoteRefusedError extends Error {
  override readonly name = 'QuoteRefusedError'
}

export const QUOTE_ACTION_REFUSAL = (what: string): string => `This is a quote, not an order, so ${what}. Convert it to an order first.`

type QuoteReader = { salesOrder: { findUnique: (args: { where: { id: string }; select: { isQuote: true } }) => Promise<{ isQuote: boolean } | null> } }

export async function assertNotQuoteUnderLock(tx: unknown, orderId: string, what: string): Promise<void> {
  const row = await (tx as QuoteReader).salesOrder.findUnique({ where: { id: orderId }, select: { isQuote: true } })
  if (row?.isQuote) throw new QuoteRefusedError(QUOTE_ACTION_REFUSAL(what))
}
