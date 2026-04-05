import { NextResponse } from 'next/server'
import { fetchAllFxRates } from '@/app/actions/currencies'

// Called daily by cron: curl http://localhost:3000/api/cron/fx-rates
export async function GET() {
  const result = await fetchAllFxRates()
  return NextResponse.json(result)
}
