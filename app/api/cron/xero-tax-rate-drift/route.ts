import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { isAccountingConnectorConnected } from '@/lib/accounting'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'

/**
 * Daily/hourly IMS↔Xero TaxRate drift detection (0jls5). Compares each active IMS
 * TaxRate against the live Xero rate and logs a WARNING on divergence so the
 * operator notices before the next invoice posts. Alert-only — no writeback.
 * CRON_SECRET-protected and rate-limited (default hourly) like the other crons.
 */
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('xero-tax-rate-drift', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result } = await runCronWithLogging({
    jobName: 'xero-tax-rate-drift',
    run: async () => {
      if (!(await isIntegrationPluginEnabled('xero'))) {
        return { skipped: true, reason: 'Xero plugin disabled' }
      }
      if (!(await isAccountingConnectorConnected('xero'))) {
        return { skipped: true, reason: 'Xero not connected' }
      }
      const { runXeroTaxRateDriftSweep } = await import('@/lib/connectors/xero/tax-rate-drift-sweeper')
      const sweep = await runXeroTaxRateDriftSweep()
      return { checked: sweep.checked, drifted: sweep.drifted }
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
