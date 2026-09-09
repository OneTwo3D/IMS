import { Prisma } from '@/app/generated/prisma/client'

/**
 * THE FAMILIES `shopping_sync_logs` HOLDS FOR A WOOCOMMERCE SALES ORDER, AND THE ONE PLACE THEY ARE
 * NAMED (o3d-272i).
 *
 * WHAT WENT WRONG. `shopping_sync_logs` is one table carrying several unrelated kinds of row, and
 * for a long while the only way to ask "is this row an unresolved WooCommerce refund park?" was to
 * hand-write five clauses — connector, direction, entityType, an actionable status, a non-null
 * entityId. o3d-xnwu r8 established that those five clauses do not say what they were being read to
 * say: the held sales invoice (o3d-k26m.6) writes every one of them. It added `recordKind`, gave the
 * refund park a positive definition in `activeRefundParkWhere` and the hold one in
 * `heldSalesInvoiceQueueWhere` — and left EIGHT hand-written copies of the old five-clause predicate
 * behind, none of which carried the new column.
 *
 * THAT IS THE DEFECT THIS MODULE EXISTS TO REMOVE, and it is not "the copies disagree". It is that
 * the rule had no home, so a reader who needed it had nowhere to get it and wrote it out again. A
 * ninth copy would have cost nothing to write and nothing to notice.
 *
 * TWO RULES LIVE HERE, AND THEY ARE DIFFERENT QUESTIONS.
 *
 *   • "IS THIS ROW AN ACTIONABLE REFUND PARK?" — {@link activeRefundParkWhere} in
 *     lib/domain/sales/refund-park-recovery.ts. Refund-specific: one family, and the readers of it
 *     are the ones that offer refund remedies (the recovery inbox, the cross-order guard, the park
 *     upsert, the coupon-correction evidence read).
 *
 *   • "IS THIS AN UNRESOLVED WOOCOMMERCE ROW THAT NAMES THIS ORDER?" — {@link
 *     unresolvedWcOrderRowWhere}, below. The UNION of the two entityId-bearing families, and the
 *     right question for the three readers that protect an order rather than describe a refund: the
 *     delete guard, the store-rebind guard and the retention exemption. For each of them the wider
 *     set is the correct one — a held invoice should also block a delete, should also block a
 *     rebind, and should also survive retention — and what was wrong was only that they said
 *     "refund" about both.
 *
 * WHY THE UNION IS ENUMERATED RATHER THAN LEFT OPEN. The old predicate admitted the held sales
 * invoice by ACCIDENT: it asked for a shape, and a second family grew into that shape. An
 * enumeration cannot do that. A third family added to this table has to be added to
 * {@link UNRESOLVED_WC_ORDER_ROW_FAMILIES} — and, because the descriptions below are a
 * `Record` over exactly that union, adding it does not compile until somebody has said what an
 * operator should be told about it. That is the property being bought, and it is worth more than
 * the four edits that motivated the module.
 *
 * WHAT AN UNSTAMPED ROW NOW DOES, STATED OUTRIGHT. `recordKind` is nullable and was added by
 * migration 20260822120000, whose two backfill statements stamp EVERY pre-existing
 * woocommerce/FROM_CONNECTOR/SalesOrder row that carries an entityId — as a hold if its payload has
 * the hold's whole shape, and as a park otherwise — and whose cutover gate (verify.sql check 2)
 * refuses to start the new build while any actionable entityId-bearing row is left NULL. So after
 * that migration there are no unstamped rows, and every predicate here can require the stamp. A row
 * that somehow carries NULL is NOT admitted by this predicate: it does not block a delete, does not
 * block a rebind, and is not exempt from retention. That is a deliberate consequence of asking the
 * row what it is instead of inferring it, and it is the same consequence `activeRefundParkWhere`
 * has already accepted since r8.
 *
 * Pure module. No database handle, no connector client — `Prisma.sql` is a template builder, not a
 * connection — so every rule here is unit-testable, and the SQL renderer can be compared against the
 * Prisma one row for row.
 */

/**
 * WHAT A REFUND PARK ROW SAYS IT IS — the value `upsertRefundPark` stamps into `recordKind`, and
 * nothing else writes (o3d-xnwu r8).
 *
 * `entityType` says what the row is ABOUT (a sales order). This says what the row IS. They are
 * different questions, and the predicate that could only ask the first one is why a held sales
 * invoice was listed in the refund recovery inbox.
 */
export const WC_REFUND_PARK_RECORD_KIND = 'WC_REFUND_PARK'

/**
 * WHAT A HELD SALES INVOICE SAYS IT IS (o3d-xnwu r8).
 *
 * A hold shares connector, direction, `SalesOrder`, PENDING and a non-null `entityId` with a refund
 * park, so until r8 the two families were indistinguishable to any predicate built out of this
 * table's other scalars. THIS SIDE IS THE ONE THAT WRITES — `holdWcSalesInvoiceForMissingNumber`
 * updates whatever its queue predicate finds — which is why the stamp matters more here than
 * anywhere else.
 */
export const HELD_SALES_INVOICE_RECORD_KIND = 'WC_HELD_SALES_INVOICE'

/**
 * The park statuses an operator may recover, and — the same set, for the same reason — the statuses
 * in which any of these families counts as UNRESOLVED.
 *
 * These are precisely the ACTIONABLE statuses: the set carried by the partial unique index
 * `shopping_sync_logs_active_refund_park_uq`, by REFUND_PARK_WHERE in the exception inbox, by the
 * order delete guard, and by the retention exemption. A row in any of them is blocking something; a
 * row outside them is already resolved and is not those readers' business.
 *
 * QUARANTINED is included deliberately. It is the o3d-iup "monetary-only refund on a non-uniformly
 * taxed order" refusal — but the tax profile it was refused against is the profile of the order the
 * park is sitting on, which is exactly what is in question there. A quarantine computed against the
 * WRONG order carries no information about the right one.
 *
 * Re-exported from lib/domain/sales/refund-park-recovery.ts, which is where it used to live and
 * where most callers still import it from. ONE array: a second spelling of these three strings is
 * the defect this module exists to remove, not a convenience.
 */
export const RECOVERABLE_REFUND_PARK_STATUSES = ['PENDING', 'FAILED', 'QUARANTINED'] as const

export type RecoverableRefundParkStatus = (typeof RECOVERABLE_REFUND_PARK_STATUSES)[number]

export function isRecoverableRefundParkStatus(status: string): status is RecoverableRefundParkStatus {
  return (RECOVERABLE_REFUND_PARK_STATUSES as readonly string[]).includes(status)
}

/**
 * The families a `shopping_sync_logs` row can belong to while it NAMES AN IMS SALES ORDER and is
 * still unresolved — i.e. exactly the rows an order-protecting reader must not step over.
 *
 * The other WooCommerce families this table carries are absent BY CONSTRUCTION, not by omission:
 * `pendingFxQueueWhere` and `wcAdmissionRefusalQueueWhere` both describe rows written BEFORE an IMS
 * order exists, so they carry no `entityId` and nothing here can reach them.
 */
export const UNRESOLVED_WC_ORDER_ROW_FAMILIES = [
  WC_REFUND_PARK_RECORD_KIND,
  HELD_SALES_INVOICE_RECORD_KIND,
] as const

export type UnresolvedWcOrderRowFamily = (typeof UNRESOLVED_WC_ORDER_ROW_FAMILIES)[number]

export function isUnresolvedWcOrderRowFamily(value: unknown): value is UnresolvedWcOrderRowFamily {
  return typeof value === 'string' && (UNRESOLVED_WC_ORDER_ROW_FAMILIES as readonly string[]).includes(value)
}

/**
 * THE LITERAL VALUES, ONCE. Both renderers below read this object and nothing else, so the Prisma
 * spelling and the SQL spelling cannot disagree about WHAT the rule is — only, at worst, about how
 * to write it, which is what tests/domain/sales/wc-sync-row-families.test.ts executes both against
 * the same rows to rule out.
 */
export const UNRESOLVED_WC_ORDER_ROW = {
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR',
  entityType: 'SalesOrder',
  recordKinds: UNRESOLVED_WC_ORDER_ROW_FAMILIES,
  statuses: RECOVERABLE_REFUND_PARK_STATUSES,
} as const

/**
 * THE PREDICATE: an unresolved WooCommerce row that names an IMS sales order.
 *
 * Every clause is written by IMS and nothing is decided by ABSENCE — the same shape rule
 * `activeRefundParkWhere` states at length. Callers narrow it by spreading and adding `entityId`
 * (one order) or `recordKind` (one family); they must not RE-STATE any clause it already carries,
 * and scripts/check-wc-sync-row-predicates.mjs makes a re-statement a build failure.
 */
export function unresolvedWcOrderRowWhere(): {
  connector: string
  direction: 'FROM_CONNECTOR'
  entityType: string
  entityId: { not: null }
  recordKind: { in: UnresolvedWcOrderRowFamily[] }
  status: { in: RecoverableRefundParkStatus[] }
} {
  return {
    connector: UNRESOLVED_WC_ORDER_ROW.connector,
    direction: UNRESOLVED_WC_ORDER_ROW.direction,
    entityType: UNRESOLVED_WC_ORDER_ROW.entityType,
    // A row in either family is evidence ABOUT AN IMS ORDER, so it always names one. This is also
    // what separates both from the families that have NO entityId (a failed import, a pending-FX
    // queue row, an admission refusal).
    entityId: { not: null },
    recordKind: { in: [...UNRESOLVED_WC_ORDER_ROW.recordKinds] },
    status: { in: [...UNRESOLVED_WC_ORDER_ROW.statuses] },
  }
}

/**
 * THE SAME PREDICATE, IN SQL — for `lib/data-retention.ts`, whose reader is a bulk
 * `DELETE ... WHERE NOT (...)` and cannot use a Prisma `where` at all.
 *
 * WHY THIS EXISTS RATHER THAN A HAND-WRITTEN COPY BESIDE THE SHARED ONE. That was the state
 * o3d-272i found: a shared TypeScript predicate would have consolidated three of the four readers
 * and left the fourth — the one that DELETES — spelling the rule out by hand next to a helper it
 * could not call. Two spellings that must agree and no mechanism holding them together is the
 * original defect with better ergonomics.
 *
 * WHAT HOLDS THE TWO SPELLINGS TOGETHER. Two things, and it takes both. (1) They read the SAME
 * literals, from {@link UNRESOLVED_WC_ORDER_ROW} — neither renderer contains a string of its own.
 * (2) tests/domain/sales/wc-sync-row-families.test.ts runs both against one seeded table, over rows
 * that differ in every clause this predicate has, and asserts the two return the identical id set;
 * changing the spelling of either one on its own turns it red.
 *
 * COLUMNS ARE QUALIFIED WITH THE TABLE NAME, which is a fixed literal here rather than a parameter:
 * the fragment is used inside a `DELETE FROM "shopping_sync_logs"` whose correlated subquery brings
 * `activity_logs` into scope, so an unqualified `status` would be ambiguous to a reader even where
 * it is unambiguous to Postgres. There is no identifier interpolation and therefore no injection
 * surface.
 *
 * The status array is cast to the enum and the recordKind array to text, matching the columns:
 * `status` is `"ShoppingSyncStatus"`, `recordKind` is a nullable TEXT added by migration
 * 20260822120000. A NULL `recordKind` fails `= ANY(...)` (it evaluates to UNKNOWN, not TRUE), which
 * is the intended answer — see the module docstring on unstamped rows.
 */
export function unresolvedWcOrderRowSql(): Prisma.Sql {
  return Prisma.sql`
        "shopping_sync_logs".connector = ${UNRESOLVED_WC_ORDER_ROW.connector}
    AND "shopping_sync_logs".direction = ${UNRESOLVED_WC_ORDER_ROW.direction}::"ShoppingSyncDirection"
    AND "shopping_sync_logs"."entityType" = ${UNRESOLVED_WC_ORDER_ROW.entityType}
    AND "shopping_sync_logs"."entityId" IS NOT NULL
    AND "shopping_sync_logs"."recordKind" = ANY(${[...UNRESOLVED_WC_ORDER_ROW.recordKinds]}::text[])
    AND "shopping_sync_logs".status = ANY(${[...UNRESOLVED_WC_ORDER_ROW.statuses]}::"ShoppingSyncStatus"[])
  `
}

/**
 * WHAT AN OPERATOR IS TOLD ABOUT A ROW OF EACH FAMILY.
 *
 * This is the second half of o3d-272i, and the half that is not about queries at all. The delete
 * guard told an operator "this order has an unresolved WooCommerce refund parked for review" and
 * sent them to the refund recovery inbox — about an INVOICE WAITING FOR A NUMBER, which that inbox
 * does not list and never will. The predicate was defensible; the sentence was false, and a false
 * sentence with a correct remedy attached is worse than a blocked delete with no explanation.
 *
 * A `Record` over the family union, not a `switch` with a default: adding a family to
 * {@link UNRESOLVED_WC_ORDER_ROW_FAMILIES} fails to compile until its description is written, so
 * the next family cannot inherit a refund's wording the way the hold did.
 */
export type UnresolvedWcOrderRowDescription = {
  /** The `SalesOrderDeleteBlocker` code this family raises. */
  deleteBlockerCode: 'parked_refund' | 'held_sales_invoice'
  /** What the delete guard tells an operator, remedy included. */
  deleteMessage: string
  /** How the store-rebind refusal counts these rows, e.g. "3 unresolved refund(s) parked for review". */
  countNoun: string
}

export const UNRESOLVED_WC_ORDER_ROW_DESCRIPTIONS: Record<UnresolvedWcOrderRowFamily, UnresolvedWcOrderRowDescription> = {
  [WC_REFUND_PARK_RECORD_KIND]: {
    deleteBlockerCode: 'parked_refund',
    deleteMessage: 'This order has an unresolved WooCommerce refund parked for review; resolve it in the '
      + 'sync exceptions inbox before deleting the order.',
    countNoun: 'unresolved refund(s) parked for review',
  },
  [HELD_SALES_INVOICE_RECORD_KIND]: {
    deleteBlockerCode: 'held_sales_invoice',
    deleteMessage: 'This order has a WooCommerce sales invoice held until the store issues its invoice '
      + 'number, and deleting the order would strand it — the invoice would never be posted and '
      + 'nothing would be left to say so. Cancel the order instead, or wait for the number to arrive '
      + 'and the hold to release.',
    countNoun: 'sales invoice(s) held for a missing invoice number',
  },
}
