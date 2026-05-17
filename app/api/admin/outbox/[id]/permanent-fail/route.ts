import { createHash } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity-log'
import { requireApiAdmin } from '@/lib/auth/server'
import {
  IntegrationOutboxAdminError,
  permanentlyFailIntegrationOutboxAdminRow,
} from '@/lib/domain/integrations/outbox-admin'
import type { IntegrationOutboxClient } from '@/lib/domain/integrations/outbox'
import { requireAdminMutationHeader } from '@/lib/security/admin-mutation'

export const runtime = 'nodejs'

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
} as const
const MAX_ADMIN_REASON_LENGTH = 1000

type AdminOutboxSession = {
  user?: {
    id?: string | null
  }
}

type AdminOutboxAuthorizer = () => Promise<Response | AdminOutboxSession>

export type AdminOutboxPermanentFailHandlerDeps = {
  authorize?: AdminOutboxAuthorizer
  client?: IntegrationOutboxClient
  now?: () => Date
  log?: typeof logActivity
}

function outboxErrorResponse(error: unknown): NextResponse {
  if (error instanceof IntegrationOutboxAdminError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode })
  }
  return NextResponse.json({ error: 'Failed to mark integration outbox row as permanently failed.' }, { status: 500 })
}

async function reasonFromRequest(request: Request): Promise<string | null> {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  return typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_ADMIN_REASON_LENGTH) : null
}

function auditHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function createAdminOutboxPermanentFailHandler(deps: AdminOutboxPermanentFailHandlerDeps = {}) {
  return async function POST(
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ): Promise<NextResponse> {
    const authResult = await (deps.authorize ?? requireApiAdmin)()
    if (authResult instanceof Response) return authResult as NextResponse
    const mutationHeaderError = requireAdminMutationHeader(request)
    if (mutationHeaderError) return mutationHeaderError as NextResponse

    const { id } = await context.params
    try {
      const reason = await reasonFromRequest(request)
      const result = await permanentlyFailIntegrationOutboxAdminRow({
        client: deps.client,
        id,
        now: deps.now?.(),
      })
      await (deps.log ?? logActivity)({
        entityType: 'SYNC',
        entityId: result.row.id,
        tag: 'sync',
        action: 'integration_outbox_permanent_fail',
        description: `Marked integration outbox row ${result.row.id} as permanently failed`,
        userId: authResult.user?.id ?? null,
        metadata: {
          outboxId: result.row.id,
          connector: result.row.connector,
          operation: result.row.operation,
          idempotencyKeyHash: auditHash(result.row.idempotencyKey),
          priorStatus: result.priorStatus,
          priorLastError: result.priorLastError,
          status: result.row.status,
          reason,
        },
      })
      return NextResponse.json(result, { headers: NO_STORE_HEADERS })
    } catch (error) {
      return outboxErrorResponse(error)
    }
  }
}

export const POST = createAdminOutboxPermanentFailHandler()
