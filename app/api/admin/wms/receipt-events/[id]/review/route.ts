import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity-log'
import { requireApiFreshAdmin } from '@/lib/auth/server'
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
  return NextResponse.json({ error: 'WMS receipt event was not found.' }, { status: 404, headers: NO_STORE_HEADERS })
}

function notReviewableResponse(): NextResponse {
  return NextResponse.json(
    { error: 'WMS receipt event is not waiting for review.', code: 'wms_receipt_event_not_reviewable' },
    { status: 409, headers: NO_STORE_HEADERS },
  )
}

function lineWarningsFromReviewDetails(reviewDetails: unknown) {
  const record = reviewDetails && typeof reviewDetails === 'object' && !Array.isArray(reviewDetails)
    ? reviewDetails as { lines?: unknown }
    : null
  if (!Array.isArray(record?.lines)) return []

  return record.lines
    .filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === 'object' && !Array.isArray(line))
    .map((line) => ({
      asnLineMapId: typeof line.asnLineMapId === 'string' ? line.asnLineMapId : null,
      externalAsnLineId: typeof line.externalAsnLineId === 'string' ? line.externalAsnLineId : null,
      sku: typeof line.sku === 'string' ? line.sku : null,
      warnings: Array.isArray(line.warnings)
        ? line.warnings.filter((warning): warning is string => typeof warning === 'string')
        : [],
    }))
    .filter((line) => line.warnings.length > 0)
}

function approvalHttpStatus(resultStatus: string): number {
  if (resultStatus === 'processed' || resultStatus === 'duplicate') return 200
  if (resultStatus === 'requires_review' || resultStatus === 'pending') return 409
  return 500
}

export function createAdminWmsReceiptReviewHandlers(deps: AdminWmsReceiptReviewHandlerDeps = {}) {
  const client = deps.client ?? db

  return {
    GET: async function GET(
      _request: NextRequest,
      context: { params: Promise<{ id: string }> },
    ): Promise<NextResponse> {
      const authResult = await (deps.authorizeRead ?? requireApiFreshAdmin)()
      if (authResult instanceof Response) return authResult as NextResponse

      const { id } = await context.params
      const event = await client.wmsInboundReceiptEvent.findUnique({
        where: { id },
        select: eventSelect(),
      })
      if (!event) return notFoundResponse()

      return NextResponse.json({ event: serializeEvent(event) }, { headers: NO_STORE_HEADERS })
    },

    // HTTP method semantics:
    // - GET: inspect review details as an admin.
    // - POST: approve the current review and reprocess using fresh-admin auth plus mutation header.
    // Future actions such as dead-letter or annotation should use distinct methods or endpoints.
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
      const reviewedBy = authResult.user?.id
      if (!reviewedBy) {
        return NextResponse.json(
          { error: 'Internal: missing user id on authorized session' },
          { status: 500, headers: NO_STORE_HEADERS },
        )
      }
      // This updateMany is the compare-and-set approval lock: exactly one admin can move the
      // event out of REQUIRES_REVIEW and trigger reprocessing.
      const updated = await client.wmsInboundReceiptEvent.updateMany({
        where: {
          id,
          processedAt: null,
          processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview,
        },
        data: {
          processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.pending,
          nextRetryAt: null,
          lastError: 'Mintsoft booked-in review approval in progress',
        },
      })
      if (updated.count !== 1) return notReviewableResponse()

      let result: Awaited<ReturnType<typeof processMintsoftBookedInEvent>>
      try {
        result = await (deps.processEvent ?? processMintsoftBookedInEvent)(id, {
          approveReview: true,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Mintsoft booked-in review approval failed'
        await client.wmsInboundReceiptEvent.updateMany({
          where: { id, processedAt: null },
          data: {
            processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview,
            lastError: message,
            reviewedAt: null,
            reviewedBy: null,
          },
        })
        return NextResponse.json(
          { error: message, code: 'wms_receipt_review_approval_failed' },
          { status: 500, headers: NO_STORE_HEADERS },
        )
      }

      if (result.status === 'processed' || result.status === 'duplicate') {
        await client.wmsInboundReceiptEvent.updateMany({
          where: { id },
          data: {
            reviewedAt,
            reviewedBy,
          },
        })
      } else if (result.status === 'requires_review') {
        await client.wmsInboundReceiptEvent.updateMany({
          where: { id, processedAt: null },
          data: {
            processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview,
            reviewedAt: null,
            reviewedBy: null,
          },
        })
      }

      const outcome = result.status === 'processed' || result.status === 'duplicate'
        ? 'approved'
        : 'not_processed'
      await (deps.log ?? logActivity)({
        entityType: 'SYNC',
        entityId: id,
        tag: 'sync',
        action: outcome === 'approved'
          ? 'mintsoft_booked_in_review_approved'
          : 'mintsoft_booked_in_review_approval_not_processed',
        level: outcome === 'approved' ? 'INFO' : 'WARNING',
        description: outcome === 'approved'
          ? `Approved Mintsoft ASN booked-in webhook ${event.externalAsnId ?? id}`
          : `Mintsoft ASN booked-in review approval did not process ${event.externalAsnId ?? id}`,
        userId: reviewedBy,
        metadata: {
          externalAsnId: event.externalAsnId,
          priorWarnings: Array.isArray((event.reviewDetails as { warnings?: unknown })?.warnings)
            ? (event.reviewDetails as { warnings: unknown[] }).warnings
            : [],
          lineWarnings: lineWarningsFromReviewDetails(event.reviewDetails),
          outcome,
          resultStatus: result.status,
        },
        resolveUser: false,
      })

      return NextResponse.json(
        { result, approved: outcome === 'approved' },
        { status: approvalHttpStatus(result.status), headers: NO_STORE_HEADERS },
      )
    },
  }
}

const handlers = createAdminWmsReceiptReviewHandlers()

export const GET = handlers.GET
export const POST = handlers.POST
