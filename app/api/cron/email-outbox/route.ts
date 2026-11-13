import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { processPendingEmailOutbox } from '@/lib/email-outbox'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { reconcileErasedEmailOutbox } from '@/lib/domain/erasure/reconcile-email-outbox'
import { reconcileErasedFreeText } from '@/lib/domain/erasure/reconcile-free-text'
import { reconcileRawPayloads } from '@/lib/domain/erasure/raw-payloads'
import { reconcileDerivedCopies } from '@/lib/domain/erasure/derived-copies'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { cronResultResponse } from '@/lib/ops/cron-response'

export async function GET(request: Request) {
  const err = await verifyCron(request)
  if (err) return err
  const rateLimitErr = await enforceCronRateLimit('email-outbox', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await processPendingEmailOutbox()
  // Finish any erasure the drain raced with. A failure in one reconcile must not hide the drain's result or stop the next reconcile, but it must not be
  // SWALLOWED either: a reconcile that throws, or that leaves rows behind, is an erasure that is not finished, so it is logged (identity-free) and the
  // cron answers with a failure status that the cron health check sees.
  const incomplete: string[] = []
  const attempt = async <T,>(name: string, run: () => Promise<T>, left?: (r: T) => number): Promise<T | null> => {
    try {
      const r = await run()
      if (left && left(r) > 0) incomplete.push(`${name}:remaining`)
      return r
    } catch {
      incomplete.push(`${name}:error`)
      return null
    }
  }
  // Addresses on rows of erased orders are replaced, unsent ones cancelled.
  const erasure = await attempt('email-outbox', () => reconcileErasedEmailOutbox())
  // The guarded free text of erased orders (a row inserted while an erasure was uncommitted).
  await attempt('free-text', () => reconcileErasedFreeText())
  // The raw storefront payload copies of erased orders.
  await attempt('raw-payloads', () => reconcileRawPayloads(db), (r) => r.remaining)
  // The derived accounting copies and notification text of erased orders (looks at every erased subject of the window, whatever the age of the rows).
  await attempt('derived-copies', () => reconcileDerivedCopies(db), (r) => r.remaining)
  if (incomplete.length > 0) {
    await logActivity({
      entityType: 'SYSTEM', tag: 'erasure', action: 'erasure_reconcile_incomplete', level: 'ERROR',
      description: 'An erasure reconcile pass did not finish (see metadata for which); personal data may remain on rows of an erased order',
      metadata: { incomplete }, resolveUser: false,
    }).catch(() => undefined)
    return cronResultResponse({ ...result, erasureReconcileIncomplete: incomplete }, { outcomeClass: 'failed' })
  }
  return cronResultResponse(erasure && erasure.addressesErased > 0 ? { ...result, erasureReconciled: erasure } : result)
}
