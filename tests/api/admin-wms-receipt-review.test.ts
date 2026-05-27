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
      lines: [],
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
            data?: { reviewedAt?: Date; reviewedBy?: string | null }
          }
          if (
            event
            && typedArgs.where?.id === event.id
            && typedArgs.where.processingStatus === event.processingStatus
            && typedArgs.where.processedAt === event.processedAt
          ) {
            event = {
              ...event,
              reviewedAt: typedArgs.data?.reviewedAt ?? event.reviewedAt,
              reviewedBy: typedArgs.data?.reviewedBy ?? event.reviewedBy,
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
  assert.deepEqual(processCalls, [{ eventId: 'event-1', options: { approveReview: true } }])
  assert.equal(mock.event?.reviewedAt?.toISOString(), reviewedAt.toISOString())
  assert.equal(mock.event?.reviewedBy, 'admin-1')
  assert.equal(activityLogs.length, 1)
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
