import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { fetchAllFxRatesInternal } from '@/app/actions/currencies'

export async function GET(request: Request) {
  const err = verifyCron(request)
  if (err) return err
  const result = await fetchAllFxRatesInternal()
  return NextResponse.json(result)
}
