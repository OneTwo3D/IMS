import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import {
  getStockPositionFilterOptionPage,
  STOCK_POSITION_FILTER_OPTION_MAX_LIMIT,
  type StockPositionFilterOptionType,
} from '@/lib/domain/inventory/stock-position-reports'
import { stockPositionApiAccessDenied } from '@/lib/security/stock-position-access'

const OPTION_TYPES = new Set<StockPositionFilterOptionType>(['warehouse', 'category', 'supplier'])

function optionType(value: string | null): StockPositionFilterOptionType | null {
  return value && OPTION_TYPES.has(value as StockPositionFilterOptionType)
    ? value as StockPositionFilterOptionType
    : null
}

function limit(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return Math.min(parsed, STOCK_POSITION_FILTER_OPTION_MAX_LIMIT)
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  const denied = stockPositionApiAccessDenied(session)
  if (denied) return denied

  const type = optionType(req.nextUrl.searchParams.get('type'))
  if (!type) {
    return NextResponse.json({ error: 'Unknown stock-position filter option type' }, { status: 400 })
  }

  const result = await getStockPositionFilterOptionPage({
    type,
    query: req.nextUrl.searchParams.get('q') ?? undefined,
    selectedId: req.nextUrl.searchParams.get('selectedId') ?? undefined,
    limit: limit(req.nextUrl.searchParams.get('limit')),
  })

  return NextResponse.json(result, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
