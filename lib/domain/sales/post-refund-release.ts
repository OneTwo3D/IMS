/**
 * o3d-67y: IMMEDIATE, operator-visible post-refund reservation release.
 *
 * A refund reduces an allocated order's outstanding demand, so the refunded units' stock reservation must be
 * released. That release runs AFTER the refund transaction commits (it cannot be folded into it), which makes
 * it inherently best-effort. autoAllocateOrder swallows its own failures into `{ success: false }`; if the
 * caller discards that result and only logs a thrown error, a failed release strands the reservation on
 * `stockLevel.reservedQty`.
 *
 * This helper centralises the immediate attempt: it inspects a throw, a rolled-back transaction, a shipment
 * refuse, a committed release, and a pre-transaction bail (no eligible warehouse), and records a WARNING for
 * every case where the reservation was NOT reconciled so it is operator-visible. The WARNING write is itself
 * guarded — the refund is already committed, so a logging failure must never bubble out and be mis-handled as a
 * refund failure by the caller's outer catch.
 *
 * DURABILITY does NOT come from this helper: logActivity swallows write failures, so `warned` only means "we
 * attempted the WARNING", not "a durable recovery record exists". The durable guarantee is the backstop row
 * enqueued INSIDE the refund transaction (scheduleRefundReservationReleaseOutbox), drained by the
 * refund-reservation-release cron, which re-runs this same release if the immediate attempt did not reconcile.
 * `reconciled` tells the caller whether to resolve that backstop row (release done / deliberately deferred) or
 * leave it PENDING for the drain (failure / bail). This helper is the timeliness path; the outbox is the
 * correctness path.
 */

export type ReallocationResult = {
  success: boolean
  error?: string
  // Set by autoAllocateOrder ONLY when its transaction threw and rolled back (reservations NOT mutated).
  failed?: boolean
  // Set when refuseIfShipmentsExist declined because a shipment exists. The reservation was left untouched;
  // whether the refunded units are truly stranded depends on shipment reconciliation (tracked in o3d-339).
  refused?: boolean
  // Set true ONLY when the allocation transaction actually COMMITTED (reservedQty reconciled). A pre-transaction
  // bail (no eligible warehouse) leaves it false — that is NOT a completed release.
  committed?: boolean
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
  /**
   * Whether the order holds stock reservations a refund should release — derived from persisted
   * OrderAllocation rows under the refund's order lock, NOT from lifecycle status (an ON_HOLD or PICKING order
   * can still hold allocations). False for an order that was never allocated, so the release is a no-op.
   */
  eligible: boolean
}

export type PostRefundReleaseOutcome = {
  /** true when the release ran and reported success (the refunded units' reservation was reconciled). */
  released: boolean
  /** true when a WARNING was recorded because the release did not complete or was deferred. */
  warned: boolean
  /** true when allocation refused because a shipment exists — deferred to shipment reconciliation (o3d-339). */
  refused: boolean
  /**
   * true when the reservation is in a consistent state and the durable backstop can be resolved: the release
   * committed (incl. a committed backorder) OR was deliberately refused. False on a failure or a pre-transaction
   * bail, so the caller leaves the backstop PENDING for the drain to retry.
   */
  reconciled: boolean
}

export async function releaseReservationsAfterRefund(
  input: PostRefundReleaseInput,
  deps: PostRefundReleaseDeps,
): Promise<PostRefundReleaseOutcome> {
  if (!input.eligible) {
    return { released: false, warned: false, refused: false, reconciled: false }
  }

  const onError = deps.onError ?? ((message, detail) => console.error(message, detail))

  let releaseError: string | null = null
  let released = false
  let refused = false
  let committed = false
  try {
    const result = await deps.allocate(input.orderId)
    if (result.failed) releaseError = result.error ?? 'reservation release transaction rolled back'
    refused = result.refused === true
    committed = result.committed === true
    released = result.success === true
  } catch (error) {
    // autoAllocateOrder catches its own throws, so a throw here is a module-load / injection failure — the
    // release definitely did not run.
    releaseError = String(error)
  }

  // A genuine transaction failure (or a throw) — the reservation is stale. Surface it and leave the backstop
  // PENDING (reconciled:false) so the drain retries.
  if (releaseError) {
    await safeLog(deps, onError, {
      action: 'refund_reservation_release_failed',
      description: `Refund committed, but the post-refund stock reservation release did not complete for order ${input.orderId} — it may still hold reservations for refunded units. Re-run allocation on this order to release them. (${releaseError})`,
      metadata: { orderId: input.orderId, refundId: input.refundId, error: releaseError },
    })
    return { released: false, warned: true, refused: false, reconciled: false }
  }

  // A refuse means an existing shipment holds the units, so the conservative release declines rather than
  // re-pick stock. Safe for a fully-shipped order (its reservation is already consumed) but can leave a PENDING
  // shipment's reservation covering now-refunded units — surface it (not silent) and let shipment reconciliation
  // (o3d-339) net the refund. The reservation state is consistent, so the backstop can be resolved.
  if (refused) {
    await safeLog(deps, onError, {
      action: 'refund_reservation_release_deferred',
      description: `Refund committed on order ${input.orderId}, but stock reservation release was deferred because a shipment already exists — if that shipment is still pending, verify it nets the refunded units so they are not dispatched.`,
      metadata: { orderId: input.orderId, refundId: input.refundId, reason: 'existing_shipment' },
    })
    return { released: false, warned: true, refused: true, reconciled: true }
  }

  // The allocation transaction committed (a full release or a committed backorder) — reservedQty is reconciled.
  if (committed) {
    return { released, warned: false, refused: false, reconciled: true }
  }

  // Neither committed, refused, nor failed: a pre-transaction bail (e.g. no eligible warehouse). The release did
  // NOT run and reservedQty is untouched — surface it and leave the backstop PENDING so the drain retries once a
  // warehouse is eligible again (and dead-letters visibly if it never is).
  await safeLog(deps, onError, {
    action: 'refund_reservation_release_failed',
    description: `Refund committed on order ${input.orderId}, but the post-refund stock reservation release could not run (no eligible warehouse / allocation bailed before committing). The refunded units may still be reserved; it will retry automatically.`,
    metadata: { orderId: input.orderId, refundId: input.refundId, reason: 'allocation_not_committed' },
  })
  return { released: false, warned: true, refused: false, reconciled: false }
}

async function safeLog(
  deps: PostRefundReleaseDeps,
  onError: (message: string, detail: unknown) => void,
  params: { action: string; description: string; metadata: object },
): Promise<void> {
  try {
    await deps.log({
      entityType: 'SALES_ORDER',
      entityId: (params.metadata as { orderId: string }).orderId,
      action: params.action,
      tag: 'sales',
      level: 'WARNING',
      description: params.description,
      metadata: params.metadata,
      resolveUser: false,
    })
  } catch (logError) {
    onError('[refund] failed to record reservation-release warning', logError)
  }
}
