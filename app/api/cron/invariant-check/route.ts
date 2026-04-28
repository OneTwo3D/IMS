import { NextResponse } from 'next/server'

import { runScheduledInvariantCheck } from '@/lib/cron/invariant-check'
import { verifyCron } from '@/lib/cron-auth'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { appendCronRunId, runCronWithLogging } from '@/lib/ops/cron-run'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result } = await runCronWithLogging({
    jobName: 'invariant-check',
    run: async ({ runId }) => await runScheduledInvariantCheck({ createRunId: () => runId }) as unknown as Record<string, unknown>,
  })

  return NextResponse.json(appendCronRunId(result, runId), {
    status: result.status === 'completed' ? 200 : 500,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
