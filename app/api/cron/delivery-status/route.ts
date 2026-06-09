import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { checkDeliveryStatus } from '@/lib/trackship'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('delivery-status', { request, max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  const result = await checkDeliveryStatus()
  return NextResponse.json(result)
}
