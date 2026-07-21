/**
 * o3d-67y: durable, operator-visible post-refund reservation release.
 *
 * A refund reduces an allocated order's outstanding demand, so the refunded units' stock reservation must be
 * released. That release runs AFTER the refund transaction commits (it cannot be folded into it), which makes
 * it inherently best-effort. autoAllocateOrder swallows its own failures into `{ success: false }`; if the
 * caller discards that result and only logs a thrown error, a failed release silently strands the reservation
 * on `stockLevel.reservedQty` with no operator-visible signal.
 *
 * This helper centralises the failure handling: it inspects BOTH a throw and a `success: false` return, and on
 * either records a resolvable WARNING naming the order so the stranded reservation is surfaced (the
 * stock-position drift report quantifies it) and can be released by re-running allocation. The WARNING write is
 * itself guarded — the refund is already committed, so a logging failure must never bubble out and be
 * mis-handled as a refund failure by the caller's outer catch.
 */

export type ReallocationResult = { success: boolean; error?: string }

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
  try {
    const result = await deps.allocate(input.orderId)
    if (!result.success) releaseError = result.error ?? 'reallocation returned success:false'
  } catch (error) {
    releaseError = String(error)
  }

  if (!releaseError) {
    return { released: true, warned: false }
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
