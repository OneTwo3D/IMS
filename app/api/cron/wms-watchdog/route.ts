import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWmsWatchdog } from '@/lib/domain/wms/watchdog-sweep'

export async function GET(request: Request) {
  const authFailure = await verifyCron(request)
  if (authFailure) return authFailure

  // Headroom above the hourly cadence (Codex r7): a FAILED run consumes a
  // slot too, and max=1 would 429 the retry (scheduler or operator) for up to
  // an hour while breaches sit unclaimed — plus rolling-window boundary jitter
  // can deny an ordinary on-schedule run.
  const rateLimited = await enforceCronRateLimit('wms-watchdog', { request, max: 3 })
  if (rateLimited) return rateLimited

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await runWmsWatchdog()
  // FAILED = breaches exist that no one was alerted to (undeliverable
  // notifications) — surface as 500 so scheduler monitoring goes red.
  return NextResponse.json(result, { status: result.status === 'FAILED' ? 500 : 200 })
}
