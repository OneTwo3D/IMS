import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { checkDeliveryStatus } from '@/lib/trackship'

export async function GET(request: Request) {
  const cronErr = verifyCron(request)
  if (cronErr) return cronErr
  const result = await checkDeliveryStatus()
  return NextResponse.json(result)
}
