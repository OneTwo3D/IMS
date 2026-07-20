/**
 * Permanent vs transient sales-order status-transition failures (o3d-bx9).
 *
 * A status transition can fail for two fundamentally different reasons, and callers MUST be able to tell
 * them apart:
 *
 *  - PERMANENT — a TERMINAL CONFLICT. The order has physically shipped or dispatched, so a request to
 *    cancel it can never become valid: goods do not un-ship. Re-running the identical request re-hits
 *    the identical rule, so retrying is pure churn.
 *  - TRANSIENT — everything else. Not just database errors, locks and aborted transactions, but also any
 *    UNMET PREREQUISITE: "no products have been allocated", "shipments are required", "not all shipments
 *    are shipped". Those read like business rules but describe a state that changes minutes later once
 *    allocation or picking completes, so they MUST stay retryable — acknowledging one would drop a real
 *    status change, and polling only re-imports order data, it does not retry a status sync.
 *
 * The bar for PERMANENT is therefore deliberately high: only a conflict with an irreversible physical
 * fact qualifies. Everything unrecognised stays transient.
 *
 * Both used to arrive at applySalesOrderStatusTransition's outer catch as a bare Error and were flattened
 * into an identical `{ success: false, error }`, destroying the distinction. That is why a Woo webhook
 * asking to cancel an already-shipped order returned HTTP 500 and was retried ~24 times into the
 * dead-letter queue: the inbox treats 5xx as retryable, and nothing could say "this will never succeed".
 *
 * Marking the PERMANENT ones is the safe direction: anything unrecognised stays transient, so a new
 * failure mode keeps today's retry behaviour rather than being silently acknowledged and lost.
 */

/** Thrown when a stable business rule refuses a transition. Retrying the same request cannot help. */
export class PermanentStatusTransitionError extends Error {
  readonly permanent = true as const

  constructor(message: string) {
    super(message)
    this.name = 'PermanentStatusTransitionError'
  }
}

/**
 * Is this failure a permanent business rejection?
 *
 * Deliberately conservative — it recognises only errors that explicitly declare themselves permanent, so
 * an unrecognised failure (a Prisma error, a lock timeout, a bug) is treated as TRANSIENT and keeps
 * retrying. Acknowledging a transient failure would silently drop a real status change.
 *
 * Note what is NOT accepted: a generic WorkflowTransitionError. That reports an invalid current/target
 * pair, which is timing-dependent rather than terminal — DRAFT -> SHIPPED is invalid, yet ALLOCATED ->
 * SHIPPED becomes valid once allocation completes. Only the two physical-conflict guards qualify.
 */
export function isPermanentStatusTransitionError(error: unknown): boolean {
  if (error instanceof PermanentStatusTransitionError) return true
  // Cross-realm / re-thrown copies lose `instanceof`, so fall back to the marker the class sets.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { permanent?: unknown }).permanent === true
  )
}
