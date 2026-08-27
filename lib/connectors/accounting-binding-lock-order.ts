/**
 * ONE CANONICAL ORDER FOR ACQUIRING THE ROWS OF AN ACCOUNTING BINDING (o3d-2w2j).
 *
 * A binding is not one row. It is a PIN in `settings` naming the organisation this instance is bound
 * to, the TOKEN row in `accounting_tokens`, and — for Xero — a release WITNESS, a second `settings`
 * row that corroborates the token row's release receipt. Several writers take more than one of them
 * inside a single transaction, which means each of them is taking locks in an order, whether or not
 * anybody chose one.
 *
 * THE DEFECT THAT NAMED THIS FILE. `disconnect()` took the TOKEN row first and the pin second, which
 * is the exact reverse of every writer that establishes a binding. A disconnect running concurrently
 * with a consent then holds what the other needs next, and Postgres resolves that the only way it can
 * — by killing one of them as a deadlock victim. Nothing about the pin/receipt/witness logic depended
 * on the order; the hazard is pure LIVENESS. But the auth path is what an operator reaches for when
 * they are already mid-incident, so it is the last place in the system that should be able to wedge.
 *
 * WHY A HELPER RATHER THAN A COMMENT. The first fix reordered the statements and wrote down the rule
 * beside them. That works exactly as long as every future writer reads the comment — and this rule has
 * already been broken twice by writers who did not know it existed (the disconnect above, and the
 * QuickBooks disconnect that took its token row before its realm pin). A comment cannot be called; a
 * function can, and a function that RETURNS the statements in order cannot be called and then ignored.
 *
 * THE ORDER IS THE PIN WRITERS', AND IT IS NOT ARBITRARY. `settings.key` is a PRIMARY KEY, so of two
 * concurrent consents the second INSERT of the pin blocks and then fails — that P2002 is the ARBITER
 * that decides which consent wins, and it can only arbitrate if it happens before either transaction
 * has touched anything else. So the pin is first because the binding's correctness already required it
 * to be first; the other writers align with the arbiter rather than the arbiter with them.
 *
 * WHAT THIS DOES NOT DO. It orders the rows of ONE binding. It says nothing about the wholesale
 * table wipes (`resetDatabase`), which take whole tables rather than named rows — those have their own
 * argument and their own test — and nothing about the contact/supplier/product clears that follow a
 * disconnect, which every writer already performs in the same relative order after the binding rows.
 */

/**
 * The rows of one accounting binding, in the ONLY order any writer may acquire them.
 *
 * Exported so a test can read the order from here rather than restate it, and so the array itself is
 * the single place the rule is written down.
 */
export const ACCOUNTING_BINDING_ROW_ORDER = ['pin', 'token', 'witness'] as const

export type AccountingBindingRow = (typeof ACCOUNTING_BINDING_ROW_ORDER)[number]

/**
 * Put a writer's statements into the canonical order.
 *
 * Takes them KEYED BY ROW rather than as a list, which is the whole point: a caller cannot express an
 * order at all, so it cannot express the wrong one. A writer that touches only some of the rows omits
 * the rest and gets back what it supplied, still ordered.
 *
 * The values are opaque — a lazy `PrismaPromise` for an interactive-free `$transaction([...])`, a
 * thunk for an interactive one, a raw-SQL statement for a script. Ordering happens before any of them
 * runs, so nothing here depends on what they are.
 */
export function orderedAccountingBindingWrites<T>(
  writes: Partial<Record<AccountingBindingRow, T>>,
): T[] {
  const ordered: T[] = []
  for (const row of ACCOUNTING_BINDING_ROW_ORDER) {
    const write = writes[row]
    if (write !== undefined) ordered.push(write)
  }
  return ordered
}

/**
 * Run a writer's steps in the canonical order, awaiting each before the next.
 *
 * For an INTERACTIVE transaction, where the statements are not a list of lazy promises but a sequence
 * of awaited calls with reads and branches between them. Sequential by construction — a `Promise.all`
 * here would put the acquisitions back in the hands of the scheduler, which is the same defect with
 * no order at all rather than the wrong one.
 */
export async function runOrderedAccountingBindingWrites(
  steps: Partial<Record<AccountingBindingRow, () => Promise<unknown>>>,
): Promise<void> {
  for (const step of orderedAccountingBindingWrites(steps)) {
    await step()
  }
}
