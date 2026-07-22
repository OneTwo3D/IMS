import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { processRefundReservationReleaseOutbox } from '@/lib/domain/sales/refund-reservation-release-outbox'

// o3d-67y: durable backstop for post-refund stock-reservation release. Unconditional
// (no accounting/WMS connector dependency) — re-running allocation is a pure internal
// stock operation, so this drain must run on every store regardless of which
// integrations are enabled. Idempotent: a job whose reservation was already released
// by the immediate post-refund attempt is a harmless no-op; a job left behind by a
// post-commit throw or a crash recovers here.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('refund-reservation-release', {
    request,
    max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX,
  })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await processRefundReservationReleaseOutbox()
  return NextResponse.json(result)
}
