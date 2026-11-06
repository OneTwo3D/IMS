/**
 * LINKING A NEW ORDER TO A CUSTOMER MUST NOT REACH AN ERASED CUSTOMER.
 *
 * An order linked to an anonymised customer carries fresh personal data under an erased identity, and escapes the erasure that
 * already ran. Every path that creates an order against a customer id calls this INSIDE its create transaction: the customer
 * row is locked (`FOR UPDATE`, the same lock the erasure takes when it claims the row with an UPDATE) and `gdprAnonymisedAt` is
 * re-read under it. The erasure either committed first, and this refuses, or runs after this commits, and then finds the new
 * order under the customer and erases it.
 *
 * A MANUAL path REFUSES with a message the operator can act on; it does not unlink silently. (The storefront importer, which has
 * no operator to ask, creates the order unlinked and records it instead.)
 *
 * LOCK ORDER: customer first, then any order lock. The erasure claims the customer and then locks the orders, so a path that
 * took an order lock first and the customer second could deadlock with it.
 */
export const ANONYMISED_CUSTOMER_LINK_REFUSAL = 'This customer was anonymised; create or choose a new customer.'

export class CustomerAnonymisedError extends Error {
  override readonly name = 'CustomerAnonymisedError'
  constructor(message: string = ANONYMISED_CUSTOMER_LINK_REFUSAL) { super(message) }
}

type RawClient = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> }

export async function lockCustomerForOrderLink(tx: RawClient, customerId: string | null | undefined): Promise<void> {
  if (!customerId) return
  const rows = await tx.$queryRaw<Array<{ gdprAnonymisedAt: Date | null }>>`SELECT "gdprAnonymisedAt" FROM "customers" WHERE "id" = ${customerId} FOR UPDATE`
  if (rows[0]?.gdprAnonymisedAt) throw new CustomerAnonymisedError()
}
