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
  // Set when refuseIfShipmentsExist declined because a shipment exists. The reservation was left untouched;
  // whether the refunded units are truly stranded depends on shipment reconciliation (tracked in o3d-339).
  refused?: boolean
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
  /** true when the release ran and reported success (the refunded units' reservation was reconciled). */
  released: boolean
  /** true when a WARNING was recorded because the release did not complete or was deferred. */
  warned: boolean
  /** true when allocation refused because a shipment exists — deferred to shipment reconciliation (o3d-339). */
  refused: boolean
}

// Any allocated, not-yet-shipped order holds reservations a refund should release. PICKING/PACKING keep their
// allocations until dispatch, so they are eligible too (o3d-67y, Codex review r2). A DRAFT / PENDING_PAYMENT
// (or ON_HOLD, SHIPPED, COMPLETED, DELIVERED, CANCELLED) order must never be promoted/reallocated by a refund.
const RELEASE_ELIGIBLE_STATUSES = new Set(['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'])

export async function releaseReservationsAfterRefund(
  input: PostRefundReleaseInput,
  deps: PostRefundReleaseDeps,
): Promise<PostRefundReleaseOutcome> {
  if (!RELEASE_ELIGIBLE_STATUSES.has(input.status)) {
    return { released: false, warned: false, refused: false }
  }

  const onError = deps.onError ?? ((message, detail) => console.error(message, detail))

  let releaseError: string | null = null
  let released = false
  let refused = false
  try {
    const result = await deps.allocate(input.orderId)
    // Warn ONLY on a genuine transaction failure (result.failed) — NOT on a plain success:false, which is a
    // committed backorder/shortage (reservations are consistent). A refuse is surfaced separately below.
    if (result.failed) releaseError = result.error ?? 'reservation release transaction rolled back'
    refused = result.refused === true
    released = result.success === true
  } catch (error) {
    // autoAllocateOrder catches its own throws, so a throw here is a module-load / injection failure — the
    // release definitely did not run.
    releaseError = String(error)
  }

  // A refuse means an existing shipment holds the units, so the conservative release declines rather than
  // re-pick stock. That is safe for a fully-shipped order (its reservation is already consumed) but can leave
  // a PENDING shipment's reservation covering now-refunded units — surface it (not silent) and let shipment
  // reconciliation (o3d-339) net the refund. Not a `released` and not a retryable failure.
  if (refused && !releaseError) {
    try {
      await deps.log({
        entityType: 'SALES_ORDER',
        entityId: input.orderId,
        action: 'refund_reservation_release_deferred',
        tag: 'sales',
        level: 'WARNING',
        description: `Refund committed on order ${input.orderId}, but stock reservation release was deferred because a shipment already exists — if that shipment is still pending, verify it nets the refunded units so they are not dispatched.`,
        metadata: { orderId: input.orderId, refundId: input.refundId, reason: 'existing_shipment' },
        resolveUser: false,
      })
    } catch (logError) {
      onError('[refund] failed to record reservation-release deferral warning', logError)
    }
    return { released: false, warned: true, refused: true }
  }

  if (!releaseError) {
    return { released, warned: false, refused: false }
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
  return { released: false, warned: true, refused: false }
}
