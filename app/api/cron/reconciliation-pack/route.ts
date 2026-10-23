import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'
import { runScheduledReconciliationPack } from '@/lib/ops/reconciliation-pack-schedule'
import { PACK_SCHEDULE_SLUG } from '@/lib/reconciliation-pack/schedule-constants'

export const runtime = 'nodejs'

// Called by cron with Authorization: Bearer $CRON_SECRET. OFF by default; the job re-reads its own switch (a stale scheduler entry
// cannot run it). It starts `npm run reconcile:pack` as a child (all of the command's hardening applies there) and keeps one
// activity-log record per start. Nothing in the answer but closed codes, run id, sequence and integers.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit(PACK_SCHEDULE_SLUG, { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result, responseStatus } = await runCronWithLogging({
    jobName: PACK_SCHEDULE_SLUG,
    run: async (context) => {
      const outcome = await runScheduledReconciliationPack(context.runId)
      return {
        status: outcome.status,
        outcome: outcome.record.outcome,
        code: outcome.record.code,
        exitCode: outcome.record.exitCode,
        packRunId: outcome.record.runId,
        sequence: outcome.record.sequence,
        recorded: outcome.recorded,
      }
    },
    getOutcome: (outcome) => {
      const failed = outcome.status === 'failed' || !outcome.recorded
      return {
        status: outcome.status === 'skipped' && outcome.recorded ? 'skipped' : failed ? 'failed' : 'completed',
        counts: { exitCode: outcome.exitCode, sequence: outcome.sequence, recorded: outcome.recorded ? 1 : 0 },
        // A closed code only. A record that was not written is its own code, so the outcome is still readable from the run log.
        statusReason: !outcome.recorded ? `RECORD_NOT_WRITTEN:${outcome.code}` : failed || outcome.status === 'skipped' ? outcome.code : null,
        responseStatus: failed ? 500 : 200,
      }
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit({ status: responseStatus ?? 200 }))
}
