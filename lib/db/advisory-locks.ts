/**
 * Every PostgreSQL advisory lock key in one place — because two pairs of them
 * were the SAME number by accident, and nothing said so (o3d-4ajo).
 *
 * `pg_advisory_xact_lock(k)` and `pg_try_advisory_lock(k)` contend on the value
 * of `k` alone; nothing namespaces them by module. So two features that pick the
 * same constant serialize against each other, and the symptom is never an error
 * — it is a job that waits, or a `try` lock that reports "someone else holds it"
 * and SKIPS its run. What was wired, in two unrelated commits eleven days apart:
 *
 *   4_112_208_031  refund creation              +  the Xero daily batch
 *   4_112_208_032  the Xero payment-write lock  +  the QuickBooks daily batch
 *
 * The values are deliberately UNCHANGED. Splitting them would be a silent
 * behaviour change in the dangerous direction: each pair writes overlapping
 * accounting state, so today's accidental serialization is doing real work (see
 * each domain below). What changes is that the sharing is now DELIBERATE —
 * named, documented and asserted. A future reader cannot mistake it for a
 * collision, and a future collision cannot be introduced silently.
 *
 * Rules, enforced by tests/db/advisory-lock-keys:
 *   • every DOMAIN below has a distinct value;
 *   • no module declares a lock key of its own — it imports one from here;
 *   • sharing a domain is legitimate, and is expressed by importing the SAME
 *     constant, never by writing the same literal twice.
 *
 * Two-int locks — pg_advisory_xact_lock(namespace, id) — occupy a DIFFERENT
 * space from single-bigint locks and cannot collide with these values.
 */

/**
 * ACCOUNTING WRITE domain.
 *
 * Held by refund creation (`pg_advisory_xact_lock`, to commit) and by the Xero
 * daily accounting batch (`pg_try_advisory_lock`, whole run). They share it on
 * purpose: the batch selects orders that still need revenue deferral and stamps
 * them later in the same run, so a refund committing between that selection and
 * the stamp would leave the batch deferring revenue for an order that has just
 * been refunded. Sharing the domain means the batch cannot start mid-refund, and
 * a refund cannot commit mid-batch.
 *
 * The cost is real and accepted: while the daily batch runs, refund creation
 * waits, and a refund in flight makes the batch skip that tick. Per-order
 * revalidation inside the batch transaction is what would let these split.
 */
export const ACCOUNTING_WRITE_LOCK_KEY = 4_112_208_031

/**
 * PAYMENT WRITE domain.
 *
 * Held by the two Xero jobs that write `paidAt` — the 15-minute payment poll and
 * the daily backlog reconcile (o3d-2s8) — and by the QuickBooks daily batch,
 * which selects on `paidAt IS NOT NULL` and would otherwise read a payment state
 * another job is midway through rewriting.
 */
export const PAYMENT_WRITE_LOCK_KEY = 4_112_208_032

/** The WooCommerce sync sweep's single-runner lock. */
export const WC_SYNC_ADVISORY_LOCK_KEY = 918_273_645

/** The reallocation sweep cursor's single-runner lock. */
export const SWEEP_CURSOR_LOCK_KEY = 918_273_912

/**
 * ONE lock for the whole ProductComponent graph (o3d-t0zq).
 *
 * Deliberately coarse, and the coarseness IS the correctness argument. A component cycle is a
 * property of the graph, not of any one product, so a per-product or even per-edge lock cannot
 * serialize the writers that form one: two writers adding B->C and D->A hold DISJOINT lock
 * sets, never block each other, and together close A->B->C->D->A while each one's own cycle
 * check passed. Only a lock covering every component write makes the check-then-write
 * atomic with respect to the graph it is checking.
 *
 * Affordable precisely because component edits are rare and low-throughput — a kit or BOM
 * definition changes when a human edits it or a CSV import carries a components column, not on
 * any hot path. Held for one row's transaction, not a whole import.
 *
 * SCOPE, precisely. Taken by the writers that CREATE edges — saveProductComponents and the CSV
 * component pass — because only those can form a cycle. The delete-only writers (the editor's
 * and the CSV rename's clearComponents, and the admin reset) deliberately do NOT take it:
 * removing edges cannot create a cycle, and adding it AFTER their per-SKU lock would invert the
 * order and create a deadlock. The cost of that omission is that a concurrent delete can make
 * the walk below transiently reject a write that would have been fine — a false rejection, not
 * a false acceptance.
 */
export const COMPONENT_GRAPH_WRITE_LOCK_KEY = 918_274_101

/**
 * ACCOUNTING CONNECTOR SELECTION domain (o3d-osl8 round 5, finding 2).
 *
 * Serializes "which accounting connector is active" against every reader that
 * DECIDES something from it and then writes. Today that is exactly two writers:
 * the plugin-state save (saveIntegrationPluginState / saveOnboardingPluginState)
 * and the orphan cancel (cancelOrphanedAccountingSyncRows).
 *
 * WHY IT IS NOT ENOUGH ON ITS OWN, and why the cancel also re-checks the
 * selection inside its transaction: the lock only binds writers that take it. A
 * settings write that reaches the plugin rows by some other path would not, and
 * the failure mode there is not a slow query — it is a cancel that marks the
 * NEWLY active connector's PENDING queue CANCELLED, which no later read can
 * restore. Lock to serialize; re-read and abort to be safe if serialization
 * fails.
 *
 * Deliberately its OWN domain rather than sharing ACCOUNTING_WRITE_LOCK_KEY: a
 * connector switch has no overlap with refund posting or the daily batch, and
 * folding it in would make an admin toggling a plugin wait behind (or block) an
 * accounting batch for no correctness gain.
 */
export const ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY = 918_274_233

/**
 * Every single-bigint domain above, for the uniqueness test. A new lock MUST be
 * declared here — the test fails on any module that writes its own key literal.
 */
export const SINGLE_KEY_ADVISORY_LOCKS = {
  ACCOUNTING_WRITE_LOCK_KEY,
  PAYMENT_WRITE_LOCK_KEY,
  WC_SYNC_ADVISORY_LOCK_KEY,
  SWEEP_CURSOR_LOCK_KEY,
  COMPONENT_GRAPH_WRITE_LOCK_KEY,
  ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY,
} as const

/**
 * Caller-facing aliases. The name describes WHO takes it, the domain describes
 * WHAT is protected; keeping both makes each call site read naturally while the
 * sharing stays visible here rather than hidden in two identical literals.
 */
export const REFUND_ACCOUNTING_LOCK_KEY = ACCOUNTING_WRITE_LOCK_KEY
export const XERO_DAILY_BATCH_LOCK_KEY = ACCOUNTING_WRITE_LOCK_KEY
export const QBO_DAILY_BATCH_LOCK_KEY = PAYMENT_WRITE_LOCK_KEY

/**
 * TWO-INT namespaces — pg_advisory_xact_lock(namespace, id).
 *
 * A different keyspace from the single-bigint keys above, so these cannot
 * collide with those. They can collide with EACH OTHER, though, and the failure
 * would look identical: two features silently serializing on an id that means
 * different things to each. Registered and asserted for the same reason.
 */

/** Per-SKU WooCommerce product write serialization. */
export const WC_PRODUCT_WRITE_LOCK_NAMESPACE = 918_273_646

/** Per-connector WMS dispatch sweep (o3d-bjc.9): one sweep at a time. */
export const DISPATCH_SWEEP_LOCK_NAMESPACE = 0x77_6d_73_64 // 'wmsd'

/** Per-refund dedup of the reservation-release warning. */
export const REFUND_RELEASE_WARNING_LOCK_NAMESPACE = 411_220_867


export const TWO_INT_ADVISORY_LOCK_NAMESPACES = {
  WC_PRODUCT_WRITE_LOCK_NAMESPACE,
  DISPATCH_SWEEP_LOCK_NAMESPACE,
  REFUND_RELEASE_WARNING_LOCK_NAMESPACE,
} as const
