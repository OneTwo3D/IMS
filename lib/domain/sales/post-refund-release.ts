/**
 * o3d-67y: IMMEDIATE, operator-visible post-refund reservation release.
 *
 * A refund reduces an allocated order's outstanding demand, so the refunded units' stock reservation must be
 * released. That release runs AFTER the refund transaction commits (it cannot be folded into it), which makes
 * it inherently best-effort. autoAllocateOrder swallows its own failures into `{ success: false }`; if the
 * caller discards that result and only logs a thrown error, a failed release strands the reservation on
 * `stockLevel.reservedQty`.
 *
 * This helper centralises the immediate attempt: it inspects BOTH a throw and a `success: false` return, and on
 * a genuine failure records a WARNING naming the order so the stranded reservation is surfaced (the
 * stock-position drift report quantifies it) and can be released by re-running allocation. The WARNING write is
 * itself guarded — the refund is already committed, so a logging failure must never bubble out and be
 * mis-handled as a refund failure by the caller's outer catch.
 *
 * DURABILITY does NOT come from this helper: logActivity swallows write failures, so `warned` only means "we
 * attempted the WARNING", not "a durable recovery record exists". The durable guarantee is the backstop row
 * enqueued INSIDE the refund transaction (scheduleRefundReservationReleaseOutbox), drained by the
 * refund-reservation-release cron, which re-runs this same release idempotently if the immediate attempt was
 * bypassed or lost. This helper is the timeliness path; the outbox is the correctness path.
 */

export type ReallocationResult = {
  success: boolean
  error?: string
  // Set by autoAllocateOrder ONLY when its transaction threw and rolled back (reservations NOT mutated). A
  // plain success:false — a refuseIfShipmentsExist no-op or a committed backorder/shortage — is NOT a
  // stranding: the reservation state is consistent, so it must not raise a stale-reservation warning.
  failed?: boolean
}

export type PostRefundReleaseDeps = {
  /** Re-run allocation for the order, netting the refunded qty and re-reserving only remaining demand. */
  allocate: (orderId: string) => Promise<ReallocationResult>
  /** Record an operator-facing activity-log entry. */
  log: (params: {
    entityType: 'SALES_ORDER'
    entityId: string
    action: string
    tag: string
    level: 'WARNING'
    description: string
    metadata: object
    resolveUser: false
  }) => Promise<unknown>
  /** Optional diagnostic sink (defaults to console.error). */
  onError?: (message: string, detail: unknown) => void
}

export type PostRefundReleaseInput = {
  orderId: string
  refundId?: string
  status: string
}

export type PostRefundReleaseOutcome = {
  /** true when the release ran and reported success. */
  released: boolean
  /** true when a resolvable WARNING was recorded because the release did not complete. */
  warned: boolean
}

// Only an already-allocated, not-yet-shipped order holds reservations a refund should release. A DRAFT /
// PENDING_PAYMENT order must never be promoted to ALLOCATED by a refund, so it is a no-op here.
const RELEASE_ELIGIBLE_STATUSES = new Set(['PROCESSING', 'ALLOCATED'])

export async function releaseReservationsAfterRefund(
  input: PostRefundReleaseInput,
  deps: PostRefundReleaseDeps,
): Promise<PostRefundReleaseOutcome> {
  if (!RELEASE_ELIGIBLE_STATUSES.has(input.status)) {
    return { released: false, warned: false }
  }

  const onError = deps.onError ?? ((message, detail) => console.error(message, detail))

  let releaseError: string | null = null
  let released = false
  try {
    const result = await deps.allocate(input.orderId)
    // Warn ONLY on a genuine transaction failure (result.failed) — NOT on a plain success:false, which is a
    // committed backorder/shortage or an expected refuseIfShipmentsExist no-op (reservations are consistent).
    if (result.failed) releaseError = result.error ?? 'reservation release transaction rolled back'
    released = result.success === true
  } catch (error) {
    // autoAllocateOrder catches its own throws, so a throw here is a module-load / injection failure — the
    // release definitely did not run.
    releaseError = String(error)
  }

  if (!releaseError) {
    return { released, warned: false }
  }

  onError('[refund] post-refund reservation release failed', { orderId: input.orderId, releaseError })
  try {
    await deps.log({
      entityType: 'SALES_ORDER',
      entityId: input.orderId,
      action: 'refund_reservation_release_failed',
      tag: 'sales',
      level: 'WARNING',
      description: `Refund committed, but the post-refund stock reservation release did not complete for order ${input.orderId} — it may still hold reservations for refunded units. Re-run allocation on this order to release them. (${releaseError})`,
      metadata: { orderId: input.orderId, refundId: input.refundId, error: releaseError },
      resolveUser: false,
    })
  } catch (logError) {
    onError('[refund] failed to record reservation-release warning', logError)
  }
  return { released: false, warned: true }
}
