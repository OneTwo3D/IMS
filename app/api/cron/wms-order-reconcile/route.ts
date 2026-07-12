import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWmsOrderReconcileSweep } from '@/lib/domain/wms/order-reconcile-sweep'

export async function GET(request: Request) {
  const authFailure = await verifyCron(request)
  if (authFailure) return authFailure

  const rateLimited = await enforceCronRateLimit('wms-order-reconcile', { request })
  if (rateLimited) return rateLimited

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await runWmsOrderReconcileSweep('cron')
  return NextResponse.json(result)
}
