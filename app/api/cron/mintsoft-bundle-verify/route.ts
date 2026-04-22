import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { runMintsoftBundleVerify } from '@/lib/connectors/mintsoft/sync/bundle-sync'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (!(await isIntegrationPluginEnabled('mintsoft'))) {
    return NextResponse.json({ skipped: true, reason: 'Mintsoft plugin disabled' })
  }

  const result = await runMintsoftBundleVerify({ triggeredBy: 'cron' })
  return NextResponse.json(result)
}
