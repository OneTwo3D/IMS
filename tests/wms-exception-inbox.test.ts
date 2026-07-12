import assert from 'node:assert/strict'
import test from 'node:test'
import * as inboxNs from '../lib/domain/wms/exception-inbox.ts'

const inbox = 'default' in inboxNs
  ? inboxNs.default as typeof import('../lib/domain/wms/exception-inbox.ts')
  : inboxNs

test('buildDeadReceiptEventReplayWhere only matches a still-dead unprocessed row', () => {
  assert.deepEqual(inbox.buildDeadReceiptEventReplayWhere('evt-1'), {
    id: 'evt-1',
    processingStatus: 'DEAD',
    processedAt: null,
  })
})

test('buildDeadReceiptEventReplayData restarts the retry ladder without touching payload/idempotency fields', () => {
  const data = inbox.buildDeadReceiptEventReplayData()
  assert.deepEqual(data, {
    processingStatus: 'PENDING',
    processingAttempts: 0,
    nextRetryAt: null,
    deadLetteredAt: null,
    lastError: null,
  })
  // The replay must NOT rewrite the original event: no payload, externalEventId,
  // or connector keys may appear in the update data.
  for (const forbidden of ['payload', 'externalEventId', 'connector', 'externalAsnId']) {
    assert.equal(forbidden in data, false, `${forbidden} must not be reset by a replay`)
  }
})

test('parseDispatchErrorPayload extracts order references from the sweep log payload', () => {
  assert.deepEqual(
    inbox.parseDispatchErrorPayload({ orderId: 'so-1', externalOrderNumber: 'MS-42' }),
    { orderId: 'so-1', externalOrderNumber: 'MS-42' },
  )
})

test('parseDispatchErrorPayload is defensive against malformed payloads', () => {
  const empty = { orderId: null, externalOrderNumber: null }
  assert.deepEqual(inbox.parseDispatchErrorPayload(null), empty)
  assert.deepEqual(inbox.parseDispatchErrorPayload(undefined), empty)
  assert.deepEqual(inbox.parseDispatchErrorPayload('a string'), empty)
  assert.deepEqual(inbox.parseDispatchErrorPayload(['array']), empty)
  assert.deepEqual(inbox.parseDispatchErrorPayload({ orderId: 42, externalOrderNumber: {} }), empty)
  assert.deepEqual(
    inbox.parseDispatchErrorPayload({ orderId: 'so-2' }),
    { orderId: 'so-2', externalOrderNumber: null },
  )
})
