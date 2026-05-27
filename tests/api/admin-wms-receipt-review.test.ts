import assert from 'node:assert/strict'
import test from 'node:test'

import { NextRequest } from 'next/server'

import { createAdminWmsReceiptReviewHandlers } from '../../app/api/admin/wms/receipt-events/[id]/review/route.ts'
import { MINTSOFT_WEBHOOK_PROCESSING_STATUS } from '../../lib/domain/wms/booked-in-service.ts'
import { ADMIN_MUTATION_HEADER, ADMIN_MUTATION_HEADER_VALUE } from '../../lib/security/admin-mutation.ts'

type MockEvent = {
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

function makeEvent(overrides: Partial<MockEvent> = {}): MockEvent {
  return {
    id: 'event-1',
    connector: 'mintsoft',
    externalEventId: 'webhook-1',
    externalAsnId: 'asn-1',
    processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview,
    processedAt: null,
    lastError: 'Mintsoft booked-in review required: received_over_expected',
    reviewDetails: {
      externalAsnId: 'asn-1',
      warnings: ['received_over_expected'],
      lines: [
        {
          asnLineMapId: 'line-map-1',
          externalAsnLineId: 'remote-line-1',
          sku: 'SKU-1',
          warnings: ['received_over_expected'],
        },
      ],
    },
    reviewedAt: null,
    reviewedBy: null,
    receivedAt: new Date('2026-05-27T10:00:00.000Z'),
    ...overrides,
  }
}

function makeClient(initialEvent: MockEvent | null) {
  const calls = {
    findUnique: 0,
    updateMany: 0,
  }
  let event = initialEvent

  return {
    calls,
    get event() {
      return event
    },
    client: {
      wmsInboundReceiptEvent: {
        async findUnique() {
          calls.findUnique += 1
          return event
        },
        async updateMany(args: unknown) {
          calls.updateMany += 1
          const typedArgs = args as {
            where?: { id?: string; processingStatus?: string; processedAt?: null }
            data?: {
              processingStatus?: string
              nextRetryAt?: Date | null
              lastError?: string | null
              reviewedAt?: Date | null
              reviewedBy?: string | null
            }
          }
          const processedAtMatches = typedArgs.where?.processedAt === undefined
            || typedArgs.where.processedAt === event?.processedAt
          const processingStatusMatches = typedArgs.where?.processingStatus === undefined
            || typedArgs.where.processingStatus === event?.processingStatus
          if (
            event
            && typedArgs.where?.id === event.id
            && processingStatusMatches
            && processedAtMatches
          ) {
            event = {
              ...event,
              processingStatus: Object.prototype.hasOwnProperty.call(typedArgs.data ?? {}, 'processingStatus')
                ? typedArgs.data?.processingStatus ?? event.processingStatus
                : event.processingStatus,
              lastError: Object.prototype.hasOwnProperty.call(typedArgs.data ?? {}, 'lastError')
                ? typedArgs.data?.lastError ?? null
                : event.lastError,
              reviewedAt: Object.prototype.hasOwnProperty.call(typedArgs.data ?? {}, 'reviewedAt')
                ? typedArgs.data?.reviewedAt ?? null
                : event.reviewedAt,
              reviewedBy: Object.prototype.hasOwnProperty.call(typedArgs.data ?? {}, 'reviewedBy')
                ? typedArgs.data?.reviewedBy ?? null
                : event.reviewedBy,
            }
            return { count: 1 }
          }
          return { count: 0 }
        },
      },
    },
  }
}

function adminPostRequest(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      [ADMIN_MUTATION_HEADER]: ADMIN_MUTATION_HEADER_VALUE,
    },
  })
}

test('admin WMS receipt review GET returns auth response before querying event', async () => {
  const { client, calls } = makeClient(makeEvent())
  const handlers = createAdminWmsReceiptReviewHandlers({
    client,
    authorizeRead: async () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
  })

  const response = await handlers.GET(
    new NextRequest('http://localhost/api/admin/wms/receipt-events/event-1/review'),
    { params: Promise.resolve({ id: 'event-1' }) },
  )

  assert.equal(response.status, 401)
  assert.equal(calls.findUnique, 0)
})

test('admin WMS receipt review GET exposes dry-run details without payload body', async () => {
  const { client } = makeClient(makeEvent())
  const handlers = createAdminWmsReceiptReviewHandlers({
    client,
    authorizeRead: async () => ({ user: { id: 'admin-1' } }),
  })

  const response = await handlers.GET(
    new NextRequest('http://localhost/api/admin/wms/receipt-events/event-1/review'),
    { params: Promise.resolve({ id: 'event-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(body.event.id, 'event-1')
  assert.deepEqual(body.event.reviewDetails.warnings, ['received_over_expected'])
  assert.equal('payload' in body.event, false)
})

test('admin WMS receipt review POST requires mutation header before changing state', async () => {
  const { client, calls } = makeClient(makeEvent())
  const handlers = createAdminWmsReceiptReviewHandlers({
    client,
    authorizeApprove: async () => ({ user: { id: 'admin-1' } }),
  })

  const response = await handlers.POST(
    new NextRequest('http://localhost/api/admin/wms/receipt-events/event-1/review', { method: 'POST' }),
    { params: Promise.resolve({ id: 'event-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 403)
  assert.equal(body.code, 'missing_admin_mutation_header')
  assert.equal(calls.updateMany, 0)
})

test('admin WMS receipt review POST approves review and reruns processor in approval mode', async () => {
  const reviewedAt = new Date('2026-05-27T11:00:00.000Z')
  const mock = makeClient(makeEvent())
  const processCalls: unknown[] = []
  const activityLogs: unknown[] = []
  const handlers = createAdminWmsReceiptReviewHandlers({
    client: mock.client,
    now: () => reviewedAt,
    authorizeApprove: async () => ({ user: { id: 'admin-1' } }),
    processEvent: async (eventId, options) => {
      processCalls.push({ eventId, options })
      return {
        status: 'processed',
        eventId,
        externalAsnId: 'asn-1',
        productIds: ['product-1'],
      }
    },
    log: async (entry) => {
      activityLogs.push(entry)
    },
  })

  const response = await handlers.POST(
    adminPostRequest('http://localhost/api/admin/wms/receipt-events/event-1/review'),
    { params: Promise.resolve({ id: 'event-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.result.status, 'processed')
  assert.equal(body.approved, true)
  assert.deepEqual(processCalls, [{ eventId: 'event-1', options: { approveReview: true } }])
  assert.equal(mock.event?.reviewedAt?.toISOString(), reviewedAt.toISOString())
  assert.equal(mock.event?.reviewedBy, 'admin-1')
  assert.equal(activityLogs.length, 1)
  const log = activityLogs[0] as {
    action: string
    metadata: {
      priorWarnings: string[]
      lineWarnings: Array<{ asnLineMapId: string; warnings: string[] }>
      outcome: string
      resultStatus: string
    }
  }
  assert.equal(log.action, 'mintsoft_booked_in_review_approved')
  assert.deepEqual(log.metadata.priorWarnings, ['received_over_expected'])
  assert.deepEqual(log.metadata.lineWarnings, [
    {
      asnLineMapId: 'line-map-1',
      externalAsnLineId: 'remote-line-1',
      sku: 'SKU-1',
      warnings: ['received_over_expected'],
    },
  ])
  assert.equal(log.metadata.outcome, 'approved')
  assert.equal(log.metadata.resultStatus, 'processed')
})

test('admin WMS receipt review POST rejects events not waiting for review', async () => {
  const { client, calls } = makeClient(makeEvent({
    processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.processed,
    processedAt: new Date('2026-05-27T12:00:00.000Z'),
  }))
  const handlers = createAdminWmsReceiptReviewHandlers({
    client,
    authorizeApprove: async () => ({ user: { id: 'admin-1' } }),
  })

  const response = await handlers.POST(
    adminPostRequest('http://localhost/api/admin/wms/receipt-events/event-1/review'),
    { params: Promise.resolve({ id: 'event-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 409)
  assert.equal(body.code, 'wms_receipt_event_not_reviewable')
  assert.equal(calls.updateMany, 0)
})

test('admin WMS receipt review GET returns no-store 404 for missing events', async () => {
  const { client } = makeClient(null)
  const handlers = createAdminWmsReceiptReviewHandlers({
    client,
    authorizeRead: async () => ({ user: { id: 'admin-1' } }),
  })

  const response = await handlers.GET(
    new NextRequest('http://localhost/api/admin/wms/receipt-events/missing/review'),
    { params: Promise.resolve({ id: 'missing' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 404)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(body.error, 'WMS receipt event was not found.')
})

test('admin WMS receipt review POST rejects authorized sessions without a user id', async () => {
  const { client, calls } = makeClient(makeEvent())
  const handlers = createAdminWmsReceiptReviewHandlers({
    client,
    authorizeApprove: async () => ({ user: {} }),
  })

  const response = await handlers.POST(
    adminPostRequest('http://localhost/api/admin/wms/receipt-events/event-1/review'),
    { params: Promise.resolve({ id: 'event-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 500)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(body.error, 'Internal: missing user id on authorized session')
  assert.equal(calls.updateMany, 0)
})

test('admin WMS receipt review POST uses compare-and-set so a second approval is rejected', async () => {
  const mock = makeClient(makeEvent())
  const handlers = createAdminWmsReceiptReviewHandlers({
    client: mock.client,
    authorizeApprove: async () => ({ user: { id: 'admin-1' } }),
    processEvent: async (eventId) => ({
      status: 'pending',
      eventId,
      externalAsnId: 'asn-1',
      reason: 'remote ASN unavailable',
    }),
    log: async () => {},
  })

  const first = await handlers.POST(
    adminPostRequest('http://localhost/api/admin/wms/receipt-events/event-1/review'),
    { params: Promise.resolve({ id: 'event-1' }) },
  )
  const second = await handlers.POST(
    adminPostRequest('http://localhost/api/admin/wms/receipt-events/event-1/review'),
    { params: Promise.resolve({ id: 'event-1' }) },
  )
  const secondBody = await second.json()

  assert.equal(first.status, 409)
  assert.equal(second.status, 409)
  assert.equal(secondBody.code, 'wms_receipt_event_not_reviewable')
  assert.equal(mock.event?.reviewedAt, null)
  assert.equal(mock.event?.reviewedBy, null)
})

test('admin WMS receipt review POST does not stamp reviewed fields when processing throws', async () => {
  const mock = makeClient(makeEvent())
  const handlers = createAdminWmsReceiptReviewHandlers({
    client: mock.client,
    authorizeApprove: async () => ({ user: { id: 'admin-1' } }),
    processEvent: async () => {
      throw new Error('database timeout')
    },
  })

  const response = await handlers.POST(
    adminPostRequest('http://localhost/api/admin/wms/receipt-events/event-1/review'),
    { params: Promise.resolve({ id: 'event-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 500)
  assert.equal(body.code, 'wms_receipt_review_approval_failed')
  assert.equal(mock.event?.processingStatus, MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview)
  assert.equal(mock.event?.lastError, 'database timeout')
  assert.equal(mock.event?.reviewedAt, null)
  assert.equal(mock.event?.reviewedBy, null)
})

test('admin WMS receipt review POST reports approval attempts that still require review', async () => {
  const mock = makeClient(makeEvent())
  const activityLogs: unknown[] = []
  const handlers = createAdminWmsReceiptReviewHandlers({
    client: mock.client,
    authorizeApprove: async () => ({ user: { id: 'admin-1' } }),
    processEvent: async (eventId) => ({
      status: 'requires_review',
      eventId,
      externalAsnId: 'asn-1',
      dryRun: {
        externalAsnId: 'asn-1',
        generatedAt: '2026-05-27T11:00:00.000Z',
        warnings: ['missing_local_line'],
        lines: [],
      },
    }),
    log: async (entry) => {
      activityLogs.push(entry)
    },
  })

  const response = await handlers.POST(
    adminPostRequest('http://localhost/api/admin/wms/receipt-events/event-1/review'),
    { params: Promise.resolve({ id: 'event-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 409)
  assert.equal(body.approved, false)
  assert.equal(body.result.status, 'requires_review')
  assert.equal(mock.event?.processingStatus, MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview)
  assert.equal(mock.event?.reviewedAt, null)
  assert.equal(mock.event?.reviewedBy, null)
  const log = activityLogs[0] as { action: string; metadata: { outcome: string; resultStatus: string } }
  assert.equal(log.action, 'mintsoft_booked_in_review_approval_not_processed')
  assert.equal(log.metadata.outcome, 'not_processed')
  assert.equal(log.metadata.resultStatus, 'requires_review')
})
