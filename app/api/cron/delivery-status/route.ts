import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { checkDeliveryStatus } from '@/lib/trackship'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  const result = await checkDeliveryStatus()
  return NextResponse.json(result)
}
