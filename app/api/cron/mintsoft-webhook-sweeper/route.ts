import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIVE_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { enqueueMintsoftBookedInRecheckForAsn, sweepUnprocessedMintsoftBookedInEvents } from '@/lib/jobs/wms/process-mintsoft-booked-in-event'
import { runPostMaintenanceBookedInRecheck } from '@/lib/domain/wms/post-maintenance-recheck'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('mintsoft-webhook-sweeper', { request, max: CRON_RATE_LIMIT_FIVE_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (!(await isIntegrationPluginEnabled('mintsoft'))) {
    return NextResponse.json({ skipped: true, reason: 'Mintsoft plugin disabled' })
  }

  // o3d-hl8l r4: drain the post-maintenance re-check BEFORE the ordinary sweep. A callback refused
  // by the maintenance fence left no row, so the sweep below — which drains rows that exist — cannot
  // reach it; this recreates the trigger for every open ASN (both purchase-order and stock-transfer)
  // and the sweep then processes what it created. Hosted here rather than on the watchdog because
  // this job is `defaultEnabled: true` and runs every five minutes, so the recovery holds on an
  // installation that has configured nothing.
  const recheck = await runPostMaintenanceBookedInRecheck('mintsoft', {
    recheckAsn: (externalAsnId, options) => enqueueMintsoftBookedInRecheckForAsn(externalAsnId, options),
  })

  const result = await sweepUnprocessedMintsoftBookedInEvents()
  return NextResponse.json({ ...result, postMaintenanceRecheck: recheck })
}
