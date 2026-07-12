import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { runWmsDispatchSweep } from '@/lib/domain/wms/dispatch-sweep'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('mintsoft-dispatch-sync', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (!(await isIntegrationPluginEnabled('mintsoft'))) {
    return NextResponse.json({ skipped: true, reason: 'Mintsoft plugin disabled' })
  }

  // The dispatch poll is Mintsoft's path (ShipHero ingests despatch via webhooks); the
  // sweep itself is connector-agnostic and resolves the active WMS.
  return NextResponse.json(await runWmsDispatchSweep('cron'))
}
