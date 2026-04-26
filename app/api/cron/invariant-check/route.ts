import { NextResponse } from 'next/server'

import { runScheduledInvariantCheck } from '@/lib/cron/invariant-check'
import { verifyCron } from '@/lib/cron-auth'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await runScheduledInvariantCheck()
  return NextResponse.json(result, {
    status: result.status === 'completed' ? 200 : 500,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
