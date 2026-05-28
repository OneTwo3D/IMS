import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import {
  inventorySnapshotCounts,
  inventorySnapshotStatusReason,
  previousUtcDate,
  writeDailyInventorySnapshot,
} from '@/lib/domain/inventory/inventory-snapshot'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import {
  appendCronRunId,
  cronRunResponseInit,
  runCronWithLogging,
  type CronRunLogWriter,
} from '@/lib/ops/cron-run'

export const runtime = 'nodejs'

type InventorySnapshotCronResult = Awaited<ReturnType<typeof writeDailyInventorySnapshot>>
type InventorySnapshotCronPayload = InventorySnapshotCronResult & Record<string, unknown>

export async function handleInventorySnapshotCron(
  request: Request,
  options: {
    now?: () => Date
    createRunId?: () => string
    writeLog?: CronRunLogWriter
    getMaintenanceResponse?: typeof getMaintenanceModeResponse
    writeSnapshot?: typeof writeDailyInventorySnapshot
  } = {},
) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr

  const getMaintenanceResponse = options.getMaintenanceResponse ?? getMaintenanceModeResponse
  const maintenance = await getMaintenanceResponse('cron')
  if (maintenance) return maintenance

  const now = options.now ?? (() => new Date())
  const writeSnapshot = options.writeSnapshot ?? writeDailyInventorySnapshot
  const { runId, result } = await runCronWithLogging({
    jobName: 'inventory-snapshot',
    now,
    createRunId: options.createRunId,
    writeLog: options.writeLog,
    run: async () => {
      const snapshotResult = await writeSnapshot({
        snapshotDate: previousUtcDate(now()),
      })
      return snapshotResult as InventorySnapshotCronPayload
    },
    getOutcome: (result) => ({
      status: 'completed',
      counts: inventorySnapshotCounts(result),
      statusReason: inventorySnapshotStatusReason(result),
    }),
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}

export async function GET(request: Request) {
  return handleInventorySnapshotCron(request)
}
