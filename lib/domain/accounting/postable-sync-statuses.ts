/**
 * The accounting sync statuses from which a remote document CAN STILL BE POSTED.
 *
 * This lives in one place because two unrelated call sites have to agree on it exactly, and the
 * moment they disagree a destructive correction becomes silently wrong:
 *
 *   - `applyWcCouponCorrection` (o3d-y14) counts rows in these statuses UNDER THE ORDER LOCK and
 *     declines to correct an order that has any. Its whole safety argument is "no worker can still
 *     post a payload built from the old amount".
 *   - `purgeExpiredData` must therefore never DELETE a row in one of these statuses. A deleted row
 *     counts as zero — while the worker that claimed it still holds the payload in memory and can
 *     still complete the remote call. The count would then be a fact about the database rather than
 *     about the world, which is precisely the distinction the lock was taken to establish.
 *
 * WHY THESE THREE:
 *   PENDING     — never claimed; the next sweep posts it.
 *   PROCESSING  — claimed; a worker holds the payload and the remote call may be in flight.
 *   FAILED      — o3d-ju8t: a failure does NOT prove nothing was posted (the remote call happens
 *                 before the result is written back), and "Retry All" re-posts it verbatim.
 *
 * SYNCED and CANCELLED are excluded because no claim can succeed against them: they are outcomes,
 * not work. Retention may expire those by age exactly as before.
 */
export const POSTABLE_ACCOUNTING_SYNC_STATUSES = ['PENDING', 'PROCESSING', 'FAILED'] as const

export type PostableAccountingSyncStatus = (typeof POSTABLE_ACCOUNTING_SYNC_STATUSES)[number]

export function isPostableAccountingSyncStatus(status: string): boolean {
  return (POSTABLE_ACCOUNTING_SYNC_STATUSES as readonly string[]).includes(status)
}
