import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWmsWatchdog } from '@/lib/domain/wms/watchdog-sweep'

export async function GET(request: Request) {
  const authFailure = await verifyCron(request)
  if (authFailure) return authFailure

  const rateLimited = await enforceCronRateLimit('wms-watchdog', { request })
  if (rateLimited) return rateLimited

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await runWmsWatchdog()
  // FAILED = breaches exist that no one was alerted to (undeliverable
  // notifications) — surface as 500 so scheduler monitoring goes red.
  return NextResponse.json(result, { status: result.status === 'FAILED' ? 500 : 200 })
}
