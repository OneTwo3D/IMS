import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { runMintsoftBundleVerify } from '@/lib/connectors/mintsoft/sync/bundle-sync'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('mintsoft-bundle-verify', { request })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (!(await isIntegrationPluginEnabled('mintsoft'))) {
    return NextResponse.json({ skipped: true, reason: 'Mintsoft plugin disabled' })
  }

  const result = await runMintsoftBundleVerify({ triggeredBy: 'cron' })
  return NextResponse.json(result)
}
