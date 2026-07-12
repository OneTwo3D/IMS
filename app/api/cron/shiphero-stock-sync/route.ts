import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIVE_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { runDueShipheroStockSyncs } from '@/lib/connectors/shiphero/sync/stock-sync'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('shiphero-stock-sync', { request, max: CRON_RATE_LIMIT_FIVE_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (!(await isIntegrationPluginEnabled('shiphero'))) {
    return NextResponse.json({ skipped: true, reason: 'ShipHero plugin disabled' })
  }

  const result = await runDueShipheroStockSyncs()
  return NextResponse.json(result)
}
