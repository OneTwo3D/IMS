import { createHash } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity-log'
import { requireApiFreshAdmin } from '@/lib/auth/server'
import {
  IntegrationOutboxAdminError,
  replayIntegrationOutboxAdminRow,
} from '@/lib/domain/integrations/outbox-admin'
import type { IntegrationOutboxClient } from '@/lib/domain/integrations/outbox'
import { requireAdminMutationHeader } from '@/lib/security/admin-mutation'

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

export type AdminOutboxReplayHandlerDeps = {
  authorize?: AdminOutboxAuthorizer
  client?: IntegrationOutboxClient
  now?: () => Date
  log?: typeof logActivity
}

function outboxErrorResponse(error: unknown): NextResponse {
  if (error instanceof IntegrationOutboxAdminError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode })
  }
  return NextResponse.json({ error: 'Failed to replay integration outbox row.' }, { status: 500 })
}

function auditHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function createAdminOutboxReplayHandler(deps: AdminOutboxReplayHandlerDeps = {}) {
  return async function POST(
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ): Promise<NextResponse> {
    const authResult = await (deps.authorize ?? requireApiFreshAdmin)()
    if (authResult instanceof Response) return authResult as NextResponse
    const mutationHeaderError = requireAdminMutationHeader(request)
    if (mutationHeaderError) return mutationHeaderError as NextResponse

    const { id } = await context.params
    try {
      const result = await replayIntegrationOutboxAdminRow({
        client: deps.client,
        id,
        now: deps.now?.(),
      })
      await (deps.log ?? logActivity)({
        entityType: 'SYNC',
        entityId: result.row.id,
        tag: 'sync',
        action: 'integration_outbox_replay',
        description: `Replayed integration outbox row ${result.row.id}`,
        userId: authResult.user?.id ?? null,
        metadata: {
          outboxId: result.row.id,
          connector: result.row.connector,
          operation: result.row.operation,
          idempotencyKeyHash: auditHash(result.row.idempotencyKey),
          priorStatus: result.priorStatus,
          priorLastError: result.priorLastError,
          status: result.row.status,
        },
      })
      return NextResponse.json(result, { headers: NO_STORE_HEADERS })
    } catch (error) {
      return outboxErrorResponse(error)
    }
  }
}

export const POST = createAdminOutboxReplayHandler()
