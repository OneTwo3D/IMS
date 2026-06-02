import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import {
  getStockPositionFilterOptionPage,
  STOCK_POSITION_FILTER_OPTION_MAX_LIMIT,
  STOCK_POSITION_FILTER_QUERY_MAX_LENGTH,
  type StockPositionFilterOptionType,
} from '@/lib/domain/inventory/stock-position-reports'
import { checkRateLimit } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import { stockPositionApiAccessDenied } from '@/lib/security/stock-position-access'

const OPTION_TYPES = new Set<StockPositionFilterOptionType>(['warehouse', 'category', 'supplier'])
const RATE_LIMIT_MAX = 120
const RATE_LIMIT_WINDOW_MS = 60_000

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

function query(value: string | null): string | undefined {
  const normalized = value?.trim().slice(0, STOCK_POSITION_FILTER_QUERY_MAX_LENGTH)
  return normalized || undefined
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  const denied = stockPositionApiAccessDenied(session)
  if (denied) return denied
  const clientIp = getClientIp(req.headers) ?? 'unknown'
  const rateLimit = await checkRateLimit(
    `stock-position-filter-options:${session.user.id}:${clientIp}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  )
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many stock-position filter option requests' },
      {
        status: 429,
        headers: {
          'Cache-Control': 'private, no-store',
          'Retry-After': String(rateLimit.retryAfterSec),
        },
      },
    )
  }

  const type = optionType(req.nextUrl.searchParams.get('type'))
  if (!type) {
    return NextResponse.json({ error: 'Unknown stock-position filter option type' }, { status: 400 })
  }

  const result = await getStockPositionFilterOptionPage({
    type,
    query: query(req.nextUrl.searchParams.get('q')),
    selectedId: req.nextUrl.searchParams.get('selectedId') ?? undefined,
    limit: limit(req.nextUrl.searchParams.get('limit')),
  })

  return NextResponse.json(result, {
    headers: {
      'Cache-Control': 'private, max-age=10',
      Vary: 'Cookie',
    },
  })
}
