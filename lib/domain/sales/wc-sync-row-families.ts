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
 * THAT SENTENCE IS ABOUT NON-MEMBERSHIP, AND NON-MEMBERSHIP HAS TO BE STATED TWICE (o3d-272i r3).
 * "Not admitted" is what a POSITIVE reader sees; "not exempt from retention" is what a NEGATING one
 * sees, and in SQL those are different claims because `recordKind` is nullable. Saying the first
 * does not give you the second: `NOT (UNKNOWN)` is UNKNOWN, so a `WHERE NOT (predicate)` sweep skips
 * the unstamped row instead of taking it. {@link unresolvedWcOrderRowSql} is therefore rendered
 * TOTAL — see its own note — so that both halves of that sentence are true of the same fragment.
 * {@link unresolvedWcOrderRowWhere}, the Prisma spelling, CANNOT be made total from inside the
 * object it returns, and must not be negated; that is stated on it and enforced by
 * scripts/check-wc-sync-row-predicates.mjs.
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
 * THE REFUND PARK'S OWN LITERAL VALUES, ONCE — and the object THREE renderers read (o3d-272i r2).
 *
 * The union below ({@link UNRESOLVED_WC_ORDER_ROW}) has two renderers because one of its readers
 * deletes with raw SQL. This one has three, and the third is the reason this object exists at all:
 * THE DATABASE IS A READER OF THIS RULE, and it reads it as DDL.
 *
 * `shopping_sync_logs_active_refund_park_uq` — the partial UNIQUE index migration 20260721150000
 * built to make the park dedup race-proof — restates the pre-`recordKind` five-clause shape in its
 * WHERE predicate. o3d-272i swept the TypeScript AST and removed eight hand-written copies of that
 * shape; no AST sweep could see this one, because it is not TypeScript. So it survived, and being
 * an INDEX it OVERRIDES every application-side fix: however correctly the code now tells a held
 * sales invoice from a refund park, an index that does not know the difference REJECTS the
 * collision, and the held invoice is the row that loses.
 *
 * That is the same defect, third instance. The first was `foreignPark` in refund-service throwing
 * on a held invoice whose external order id collided with a refund id; the second was the park
 * resolvers settling such a hold to SYNCED. Both were fixed by asking `recordKind`. The index could
 * not ask it, because nothing had told the index the column existed.
 *
 * WHAT THE THREE RENDERERS ARE. {@link activeRefundParkWhere} in
 * lib/domain/sales/refund-park-recovery.ts (the Prisma `where` five readers narrow), the DDL
 * predicate {@link activeRefundParkIndexPredicateSql} below, and — transitively — the migration
 * file itself, which CONTAINS that rendered text verbatim and is held to it by
 * tests/prisma/refund-park-unique-index-record-kind-migration.test.ts.
 */
export const ACTIVE_REFUND_PARK_ROW = {
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR',
  entityType: 'SalesOrder',
  recordKind: WC_REFUND_PARK_RECORD_KIND,
  statuses: RECOVERABLE_REFUND_PARK_STATUSES,
} as const

/** The partial UNIQUE index that enforces one actionable park per (connector, externalId). */
export const ACTIVE_REFUND_PARK_INDEX_NAME = 'shopping_sync_logs_active_refund_park_uq'

/** The columns that index is keyed on. A park is unique per refund id within a connector. */
export const ACTIVE_REFUND_PARK_INDEX_COLUMNS = 'connector, "externalId"'

/** A SQL string literal. Single quotes are doubled; nothing here is ever caller-supplied. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * THE INDEX'S WHERE PREDICATE, RENDERED FROM {@link ACTIVE_REFUND_PARK_ROW} — the text migration
 * 20260909090000 carries, character for character.
 *
 * WHY A RENDERER AND NOT A HAND-WRITTEN PREDICATE IN THE .sql. A migration cannot call TypeScript:
 * Prisma applies a static, checksummed file, so the DDL genuinely cannot be GENERATED at deploy
 * time from this object. What it can be is CHECKED against it, and that is the whole difference
 * between a ninth copy and a tenth. The migration test asserts the file contains exactly this
 * string, so changing a literal here without writing the migration that follows it turns the suite
 * red — and so does editing the .sql on its own.
 *
 * TWO CLAUSES ARE THE INDEX'S AND NOT THE PREDICATE'S, and they are stated here rather than left
 * implicit. `"externalId" IS NOT NULL` is about the KEY: a row with no external id has no refund to
 * be unique per, and Postgres would index it under a NULL key that collides with nothing anyway.
 * `"entityId" IS NOT NULL` is in {@link activeRefundParkWhere} too, as `entityId: { not: null }`,
 * and is written out longhand because SQL has no other spelling of it. So the set this index
 * covers is exactly `activeRefundParkWhere()` narrowed by a non-null externalId — which is what
 * tests/concurrency/refund-park-index-family-scope.concurrent.test.ts executes both sides of.
 *
 * The enum columns take unquoted literals (`direction`, `status`): Postgres resolves an
 * unknown-typed literal against the column's type, exactly as the predecessor index did.
 */
export function activeRefundParkIndexPredicateSql(): string {
  return [
    `connector = ${sqlLiteral(ACTIVE_REFUND_PARK_ROW.connector)}`,
    `direction = ${sqlLiteral(ACTIVE_REFUND_PARK_ROW.direction)}`,
    `"entityType" = ${sqlLiteral(ACTIVE_REFUND_PARK_ROW.entityType)}`,
    // THE CLAUSE THE LIVE INDEX HAS NEVER CARRIED, and the whole of this migration. Without it
    // every actionable woocommerce/FROM_CONNECTOR/SalesOrder row with both ids is treated as a
    // refund park, so a held sales invoice whose external ORDER id equals some refund's id is
    // refused entry to a table it has every right to be in.
    `"recordKind" = ${sqlLiteral(ACTIVE_REFUND_PARK_ROW.recordKind)}`,
    `status IN (${ACTIVE_REFUND_PARK_ROW.statuses.map(sqlLiteral).join(', ')})`,
    '"externalId" IS NOT NULL',
    '"entityId" IS NOT NULL',
  ].join('\n  AND ')
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
 *
 * NARROW IT. DO NOT NEGATE IT (o3d-272i r3). `{ NOT: unresolvedWcOrderRowWhere() }` does NOT mean
 * "every row this predicate does not admit": Prisma compiles it to a SQL negation of the whole
 * conjunction, and `recordKind` is nullable, so an UNSTAMPED row answers UNKNOWN to the positive
 * form and UNKNOWN to the negation too — it appears in neither result. This is not a guess about
 * Prisma's semantics; tests/concurrency/refund-park-index-family-scope.concurrent.test.ts executes
 * both forms against a real database over the probe matrix and asserts exactly that.
 *
 * AND IT CANNOT BE FIXED FROM INSIDE THIS OBJECT, which is why the rule is a prohibition rather
 * than a repair. The Prisma `where` language has no `COALESCE`, and whatever this function returns,
 * `NOT` wraps it — so there is no value it could return that survives being negated. The SQL
 * renderer {@link unresolvedWcOrderRowSql} IS total and is the one to use when a complement is what
 * you want; scripts/check-wc-sync-row-predicates.mjs fails the build on a `NOT:` over any of the
 * family predicates so that this stays a decision somebody makes rather than one they inherit.
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
 * 20260822120000.
 *
 * AND THE FRAGMENT IS TOTAL — `COALESCE(( ... ), FALSE)` — WHICH IS THE WHOLE OF o3d-272i r3
 * (Codex MEDIUM).
 *
 * `recordKind` is nullable, so `"recordKind" = ANY(...)` answers UNKNOWN for an unstamped row
 * rather than FALSE. READ POSITIVELY THAT IS THE RIGHT ANSWER AND ALWAYS WAS: `WHERE (predicate)`
 * keeps only the rows the predicate says TRUE about, so an unstamped row is not admitted, exactly
 * as the module docstring promises. READ NEGATIVELY IT IS THE WRONG ONE: `WHERE NOT (predicate)`
 * evaluates `NOT UNKNOWN`, which is UNKNOWN, so the unstamped row is not in the complement either.
 * It falls out of BOTH halves of a partition that is supposed to cover every row of the table — and
 * the negating reader is lib/data-retention.ts, where "not in the complement" means EXEMPT FROM
 * RETENTION. The row this module says is not a member of either family was inheriting the families'
 * protection from deletion.
 *
 * WHY THE TOTALITY LIVES HERE AND NOT AT THE CALL SITE. `AND (...) IS NOT TRUE` in
 * lib/data-retention.ts would correct that one DELETE and leave the trap loaded for the next reader
 * who writes `NOT (...)` — which is the shape everybody writes, and which would be wrong again with
 * nothing in the tree to say so. The defect this module exists to remove is a rule that means two
 * things depending on who is reading it; a predicate that is correct read one way and wrong read
 * the other IS that defect, in the artifact built to end it. So the FRAGMENT is two-valued: it
 * evaluates to TRUE or FALSE for every row of this table and never to NULL, and `NOT (fragment)` is
 * therefore its exact complement for any caller who writes one, today or later.
 *
 * THE WHOLE CONJUNCTION IS WRAPPED, NOT THE ONE NULLABLE COMPARISON. `recordKind` is the only
 * nullable column this predicate compares by equality today — `entityId` is asked with
 * `IS NOT NULL`, which is already two-valued, and connector/direction/entityType/status are NOT
 * NULL in the schema — so `COALESCE("recordKind" = ANY(...), FALSE)` would also be total. Today.
 * Wrapping the conjunction makes the totality a property of THIS FRAGMENT rather than a standing
 * bet on the nullability of four other columns, so making one of them nullable later cannot quietly
 * reopen this.
 *
 * AND IT IS NOT CONDITIONAL ON THE BACKFILL HAVING RUN. Migration 20260822120000 stamps every
 * actionable entityId-bearing row, and its cutover gate (verify.sql check 2) refuses to start the
 * new build while any is left NULL — so a NULL `recordKind` should not exist in a migrated database
 * at all. THAT IS WHY THIS IS LOW RISK, AND IT IS NOT A REASON TO SKIP IT: a predicate whose
 * correctness depends on a backfill having run is coupled to a migration that is already history,
 * and the coupling is invisible at every site that reads the predicate. The totality is stated here
 * so that no reader of this rule has to know what ran in August.
 */
export function unresolvedWcOrderRowSql(): Prisma.Sql {
  return Prisma.sql`COALESCE((
        "shopping_sync_logs".connector = ${UNRESOLVED_WC_ORDER_ROW.connector}
    AND "shopping_sync_logs".direction = ${UNRESOLVED_WC_ORDER_ROW.direction}::"ShoppingSyncDirection"
    AND "shopping_sync_logs"."entityType" = ${UNRESOLVED_WC_ORDER_ROW.entityType}
    AND "shopping_sync_logs"."entityId" IS NOT NULL
    AND "shopping_sync_logs"."recordKind" = ANY(${[...UNRESOLVED_WC_ORDER_ROW.recordKinds]}::text[])
    AND "shopping_sync_logs".status = ANY(${[...UNRESOLVED_WC_ORDER_ROW.statuses]}::"ShoppingSyncStatus"[])
  ), FALSE)`
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
