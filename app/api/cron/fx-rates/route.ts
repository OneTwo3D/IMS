import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { fetchAllFxRatesInternal } from '@/app/actions/currencies'

export async function GET(request: Request) {
  const err = verifyCron(request)
  if (err) return err
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  const result = await fetchAllFxRatesInternal()
  return NextResponse.json(result)
}
