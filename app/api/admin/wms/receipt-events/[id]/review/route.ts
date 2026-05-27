import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity-log'
import { requireApiAdmin, requireApiFreshAdmin } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { MINTSOFT_WEBHOOK_PROCESSING_STATUS } from '@/lib/domain/wms/booked-in-service'
import { processMintsoftBookedInEvent } from '@/lib/jobs/wms/process-mintsoft-booked-in-event'
import { requireAdminMutationHeader } from '@/lib/security/admin-mutation'

export const runtime = 'nodejs'

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
} as const

type AdminWmsReceiptReviewSession = {
  user?: {
    id?: string | null
  }
}

type AdminWmsReceiptReviewEvent = {
  id: string
  connector: string
  externalEventId: string
  externalAsnId: string | null
  processingStatus: string
  processedAt: Date | null
  lastError: string | null
  reviewDetails: unknown
  reviewedAt: Date | null
  reviewedBy: string | null
  receivedAt: Date
}

type AdminWmsReceiptReviewClient = {
  wmsInboundReceiptEvent: {
    findUnique(args: unknown): Promise<AdminWmsReceiptReviewEvent | null>
    updateMany(args: unknown): Promise<{ count: number }>
  }
}

type AdminWmsReceiptReviewAuthorizer = () => Promise<Response | AdminWmsReceiptReviewSession>

export type AdminWmsReceiptReviewHandlerDeps = {
  authorizeRead?: AdminWmsReceiptReviewAuthorizer
  authorizeApprove?: AdminWmsReceiptReviewAuthorizer
  client?: AdminWmsReceiptReviewClient
  processEvent?: typeof processMintsoftBookedInEvent
  log?: typeof logActivity
  now?: () => Date
}

function serializeEvent(event: AdminWmsReceiptReviewEvent) {
  return {
    id: event.id,
    connector: event.connector,
    externalEventId: event.externalEventId,
    externalAsnId: event.externalAsnId,
    processingStatus: event.processingStatus,
    processedAt: event.processedAt?.toISOString() ?? null,
    lastError: event.lastError,
    reviewDetails: event.reviewDetails,
    reviewedAt: event.reviewedAt?.toISOString() ?? null,
    reviewedBy: event.reviewedBy,
    receivedAt: event.receivedAt.toISOString(),
  }
}

function eventSelect() {
  return {
    id: true,
    connector: true,
    externalEventId: true,
    externalAsnId: true,
    processingStatus: true,
    processedAt: true,
    lastError: true,
    reviewDetails: true,
    reviewedAt: true,
    reviewedBy: true,
    receivedAt: true,
  }
}

function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: 'WMS receipt event was not found.' }, { status: 404 })
}

function notReviewableResponse(): NextResponse {
  return NextResponse.json(
    { error: 'WMS receipt event is not waiting for review.', code: 'wms_receipt_event_not_reviewable' },
    { status: 409 },
  )
}

export function createAdminWmsReceiptReviewHandlers(deps: AdminWmsReceiptReviewHandlerDeps = {}) {
  const client = deps.client ?? db

  return {
    GET: async function GET(
      _request: NextRequest,
      context: { params: Promise<{ id: string }> },
    ): Promise<NextResponse> {
      const authResult = await (deps.authorizeRead ?? requireApiAdmin)()
      if (authResult instanceof Response) return authResult as NextResponse

      const { id } = await context.params
      const event = await client.wmsInboundReceiptEvent.findUnique({
        where: { id },
        select: eventSelect(),
      })
      if (!event) return notFoundResponse()

      return NextResponse.json({ event: serializeEvent(event) }, { headers: NO_STORE_HEADERS })
    },

    POST: async function POST(
      request: NextRequest,
      context: { params: Promise<{ id: string }> },
    ): Promise<NextResponse> {
      const authResult = await (deps.authorizeApprove ?? requireApiFreshAdmin)()
      if (authResult instanceof Response) return authResult as NextResponse
      const mutationHeaderError = requireAdminMutationHeader(request)
      if (mutationHeaderError) return mutationHeaderError as NextResponse

      const { id } = await context.params
      const event = await client.wmsInboundReceiptEvent.findUnique({
        where: { id },
        select: eventSelect(),
      })
      if (!event) return notFoundResponse()
      if (
        event.processedAt != null
        || event.processingStatus !== MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview
      ) {
        return notReviewableResponse()
      }

      const reviewedAt = deps.now?.() ?? new Date()
      const reviewedBy = authResult.user?.id ?? null
      const updated = await client.wmsInboundReceiptEvent.updateMany({
        where: {
          id,
          processedAt: null,
          processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview,
        },
        data: {
          reviewedAt,
          reviewedBy,
        },
      })
      if (updated.count !== 1) return notReviewableResponse()

      const result = await (deps.processEvent ?? processMintsoftBookedInEvent)(id, {
        approveReview: true,
      })
      await (deps.log ?? logActivity)({
        entityType: 'SYNC',
        entityId: id,
        tag: 'sync',
        action: 'mintsoft_booked_in_review_approved',
        level: 'INFO',
        description: `Approved Mintsoft ASN booked-in webhook ${event.externalAsnId ?? id}`,
        userId: reviewedBy,
        metadata: {
          externalAsnId: event.externalAsnId,
          priorWarnings: Array.isArray((event.reviewDetails as { warnings?: unknown })?.warnings)
            ? (event.reviewDetails as { warnings: unknown[] }).warnings
            : [],
          resultStatus: result.status,
        },
        resolveUser: false,
      })

      return NextResponse.json({ result }, { headers: NO_STORE_HEADERS })
    },
  }
}

const handlers = createAdminWmsReceiptReviewHandlers()

export const GET = handlers.GET
export const POST = handlers.POST
