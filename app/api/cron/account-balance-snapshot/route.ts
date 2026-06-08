import { NextResponse } from 'next/server'

import { syncXeroAccountBalanceSnapshots } from '@/lib/connectors/xero/account-balances'
import { verifyCron } from '@/lib/cron-auth'
import { balanceDateString } from '@/lib/domain/accounting/account-balance-snapshots'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import {
  appendCronRunId,
  cronRunResponseInit,
  runCronWithLogging,
  type CronRunLogWriter,
} from '@/lib/ops/cron-run'

export const runtime = 'nodejs'

type AccountBalanceSnapshotSync = typeof syncXeroAccountBalanceSnapshots
type AccountBalanceSnapshotCronResult = Awaited<ReturnType<AccountBalanceSnapshotSync>> & {
  balanceDate: string
}

export function previousAccountBalanceSnapshotDate(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  date.setUTCDate(date.getUTCDate() - 1)
  return balanceDateString(date)
}

function accountBalanceSnapshotCounts(result: AccountBalanceSnapshotCronResult): Record<string, number> {
  return {
    fetched: result.fetched,
    persisted: result.persisted,
    skipped: result.skipped,
    errors: result.errors.length,
  }
}

export async function handleAccountBalanceSnapshotCron(
  request: Request,
  options: {
    now?: () => Date
    createRunId?: () => string
    writeLog?: CronRunLogWriter
    getMaintenanceResponse?: typeof getMaintenanceModeResponse
    syncSnapshots?: AccountBalanceSnapshotSync
  } = {},
) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr

  const getMaintenanceResponse = options.getMaintenanceResponse ?? getMaintenanceModeResponse
  const maintenance = await getMaintenanceResponse('cron')
  if (maintenance) return maintenance

  const now = options.now ?? (() => new Date())
  const syncSnapshots = options.syncSnapshots ?? syncXeroAccountBalanceSnapshots
  const { runId, result, responseStatus } = await runCronWithLogging({
    jobName: 'account-balance-snapshot',
    now,
    createRunId: options.createRunId,
    writeLog: options.writeLog,
    run: async ({ runId }) => {
      const balanceDate = previousAccountBalanceSnapshotDate(now())
      return {
        balanceDate,
        ...await syncSnapshots({ balanceDate, syncRunId: runId }),
      }
    },
    getOutcome: (result) => ({
      status: result.errors.length > 0 ? 'failed' : 'completed',
      counts: accountBalanceSnapshotCounts(result),
      statusReason: result.errors.length > 0 ? result.errors.join('; ') : null,
      responseStatus: result.errors.length > 0 ? 500 : 200,
    }),
  })

  return NextResponse.json(
    appendCronRunId(result, runId),
    cronRunResponseInit({ status: responseStatus ?? 200 }),
  )
}

export async function GET(request: Request) {
  return handleAccountBalanceSnapshotCron(request)
}
