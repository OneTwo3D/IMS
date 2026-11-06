import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { processPendingEmailOutbox } from '@/lib/email-outbox'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { reconcileErasedEmailOutbox } from '@/lib/domain/erasure/reconcile-email-outbox'
import { reconcileErasedFreeText } from '@/lib/domain/erasure/reconcile-free-text'

export async function GET(request: Request) {
  const err = await verifyCron(request)
  if (err) return err
  const rateLimitErr = await enforceCronRateLimit('email-outbox', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await processPendingEmailOutbox()
  // Finish any erasure the drain raced with: addresses on rows of erased orders are replaced, unsent ones cancelled.
  // A failure here must not hide the drain's result.
  const erasure = await reconcileErasedEmailOutbox().catch(() => null)
  // And the guarded free text of erased orders (a row inserted while an erasure was uncommitted).
  await reconcileErasedFreeText().catch(() => null)
  return NextResponse.json(erasure && erasure.addressesErased > 0 ? { ...result, erasureReconciled: erasure } : result)
}
