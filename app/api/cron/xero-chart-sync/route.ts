import { NextResponse } from 'next/server'

import { isAccountingConnectorConnected } from '@/lib/accounting'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit, type CronRateLimitChecker } from '@/lib/cron-rate-limit'
import { syncChartOfAccounts } from '@/lib/connectors/xero/accounts'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import {
  appendCronRunId,
  cronRunResponseInit,
  runCronWithLogging,
  type CronRunLogWriter,
} from '@/lib/ops/cron-run'

export const runtime = 'nodejs'

type ChartSync = typeof syncChartOfAccounts
type ChartSyncCronResult =
  | { skipped: true; reason: string }
  | { skipped?: false; synced: number; errors: string[] }

/**
 * Daily, READ-ONLY refresh of the Xero chart of accounts into the local account list. One GET against Xero
 * (Accounts), no write to Xero. A clean run stores the whole chart and advances the read-sync last-success
 * stamp in the same transaction; a failed or empty read leaves both the chart and the stamp as they were.
 * Runs ahead of the balance-snapshot pull, which matches its configured account codes against the stored chart.
 */
export async function handleXeroChartSyncCron(
  request: Request,
  options: {
    now?: () => Date
    createRunId?: () => string
    writeLog?: CronRunLogWriter
    getMaintenanceResponse?: typeof getMaintenanceModeResponse
    isPluginEnabled?: typeof isIntegrationPluginEnabled
    isConnected?: typeof isAccountingConnectorConnected
    syncChart?: ChartSync
    checkCronRateLimit?: CronRateLimitChecker
  } = {},
) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('xero-chart-sync', { request, checker: options.checkCronRateLimit })
  if (rateLimitErr) return rateLimitErr

  const getMaintenanceResponse = options.getMaintenanceResponse ?? getMaintenanceModeResponse
  const maintenance = await getMaintenanceResponse('cron')
  if (maintenance) return maintenance

  const pluginEnabled = options.isPluginEnabled ?? isIntegrationPluginEnabled
  const connected = options.isConnected ?? isAccountingConnectorConnected
  const syncChart = options.syncChart ?? syncChartOfAccounts
  const { runId, result, responseStatus } = await runCronWithLogging<ChartSyncCronResult>({
    jobName: 'xero-chart-sync',
    now: options.now,
    createRunId: options.createRunId,
    writeLog: options.writeLog,
    run: async () => {
      if (!(await pluginEnabled('xero'))) return { skipped: true, reason: 'Xero plugin disabled' }
      if (!(await connected('xero'))) return { skipped: true, reason: 'Xero not connected' }
      return syncChart({ recordScheduledSuccess: true })
    },
    getOutcome: (outcome) => {
      if ('skipped' in outcome && outcome.skipped === true) {
        return { status: 'skipped', counts: {} as Record<string, number>, statusReason: outcome.reason, responseStatus: 200 }
      }
      const failed = 'errors' in outcome && outcome.errors.length > 0
      return {
        status: failed ? 'failed' : 'completed',
        counts: { synced: 'synced' in outcome ? outcome.synced : 0, errors: 'errors' in outcome ? outcome.errors.length : 0 },
        statusReason: failed && 'errors' in outcome ? outcome.errors.join('; ') : null,
        responseStatus: failed ? 500 : 200,
      }
    },
  })

  return NextResponse.json(
    appendCronRunId(result as Record<string, unknown>, runId),
    cronRunResponseInit({ status: responseStatus ?? 200 }),
  )
}

export async function GET(request: Request) {
  return handleXeroChartSyncCron(request)
}
