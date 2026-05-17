import { NextRequest, NextResponse } from 'next/server'

import { requireApiAdmin } from '@/lib/auth/server'
import {
  IntegrationOutboxAdminError,
  listIntegrationOutboxAdminRows,
  type ListIntegrationOutboxAdminOptions,
} from '@/lib/domain/integrations/outbox-admin'
import type { IntegrationOutboxClient } from '@/lib/domain/integrations/outbox'

export const runtime = 'nodejs'

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
} as const

type AdminOutboxSession = {
  user?: {
    id?: string | null
  }
}

type AdminOutboxAuthorizer = () => Promise<Response | AdminOutboxSession>

export type AdminOutboxListHandlerDeps = {
  authorize?: AdminOutboxAuthorizer
  client?: IntegrationOutboxClient
  now?: () => Date
}

function booleanParam(value: string | null): boolean {
  return value === 'true' || value === '1'
}

function integerParam(value: string | null, label: string): number | undefined {
  if (value == null || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new IntegrationOutboxAdminError(`${label} must be a finite number`, 400, `invalid_${label}`)
  }
  return Math.floor(parsed)
}

function dateParam(value: string | null, label: string): Date | undefined {
  if (value == null || value.trim() === '') return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new IntegrationOutboxAdminError(`${label} must be an ISO date`, 400, `invalid_${label}`)
  }
  return parsed
}

function listOptionsFromRequest(request: Request, deps: AdminOutboxListHandlerDeps): ListIntegrationOutboxAdminOptions {
  const params = new URL(request.url).searchParams
  const olderThanMs = integerParam(params.get('olderThanMs'), 'olderThanMs')
  const olderThanMinutes = integerParam(params.get('olderThanMinutes'), 'olderThanMinutes')
  const olderThanHours = integerParam(params.get('olderThanHours'), 'olderThanHours')
  return {
    client: deps.client,
    connector: params.get('connector')?.trim() || undefined,
    operation: params.get('operation')?.trim() || undefined,
    status: params.get('status')?.trim() || undefined,
    createdFrom: dateParam(params.get('createdFrom') ?? params.get('createdAfter'), 'createdFrom'),
    createdTo: dateParam(params.get('createdTo') ?? params.get('createdBefore'), 'createdTo'),
    olderThanMs: olderThanMs
      ?? (olderThanMinutes === undefined ? undefined : olderThanMinutes * 60 * 1000)
      ?? (olderThanHours === undefined ? undefined : olderThanHours * 60 * 60 * 1000),
    oldestPending: booleanParam(params.get('oldestPending')),
    permanentFailed: booleanParam(params.get('permanentFailed')),
    cursor: params.get('cursor')?.trim() || undefined,
    limit: integerParam(params.get('limit'), 'limit'),
    now: deps.now?.(),
  }
}

function outboxErrorResponse(error: unknown): NextResponse {
  if (error instanceof IntegrationOutboxAdminError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode })
  }
  return NextResponse.json({ error: 'Failed to read integration outbox rows.' }, { status: 500 })
}

export function createAdminOutboxListHandler(deps: AdminOutboxListHandlerDeps = {}) {
  return async function GET(request: NextRequest): Promise<NextResponse> {
    const authResult = await (deps.authorize ?? requireApiAdmin)()
    if (authResult instanceof Response) return authResult as NextResponse

    try {
      const result = await listIntegrationOutboxAdminRows(listOptionsFromRequest(request, deps))
      return NextResponse.json(result, { headers: NO_STORE_HEADERS })
    } catch (error) {
      return outboxErrorResponse(error)
    }
  }
}

export const GET = createAdminOutboxListHandler()
