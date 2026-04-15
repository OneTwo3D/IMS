import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { processPendingEmailOutbox } from '@/lib/email-outbox'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'

export async function GET(request: Request) {
  const err = verifyCron(request)
  if (err) return err
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const result = await processPendingEmailOutbox()
  return NextResponse.json(result)
}
