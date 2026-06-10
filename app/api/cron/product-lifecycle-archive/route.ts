import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { archiveExhaustedEolProducts } from '@/lib/domain/inventory/product-lifecycle-archive'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('product-lifecycle-archive', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await archiveExhaustedEolProducts()
  return NextResponse.json(result)
}
