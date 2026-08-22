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

// --- o3d-bjc.9: quarantined links must be visible in the inbox --------------

type StuckDispatchLink = import('../lib/domain/wms/exception-inbox.ts').StuckDispatchLink

function stuckLink(partial: Partial<StuckDispatchLink> & { orderId: string }): StuckDispatchLink {
  return {
    connector: 'mintsoft',
    externalOrderNumber: `WMS-${partial.orderId}`,
    dispatchFailureCount: 0,
    dispatchLastError: null,
    dispatchDeadLetteredAt: null,
    dispatchUnresolvedCount: 0,
    dispatchUnresolvedError: null,
    dispatchUnresolvedAt: null,
    order: { orderNumber: `SO-${partial.orderId}`, status: 'PROCESSING' },
    ...partial,
  }
}

test('[o3d-rbyg r2] a stuck row carries the order status the page picks its remedy from', () => {
  // Finding 3's remedy differs by lifecycle state: a live order can have its despatch recorded, a
  // CANCELLED one (an approved withdrawal) cannot — IMS refuses a shipment against it — so the page
  // must be able to tell them apart from the row alone. It could not: the row did not carry status.
  const [live, cancelled] = inbox.mergeStuckDispatchRows([
    stuckLink({ orderId: 'live', dispatchDeadLetteredAt: new Date('2026-08-02T00:00:00Z'), order: { orderNumber: 'SO-live', status: 'ON_HOLD' } }),
    stuckLink({ orderId: 'gone', dispatchDeadLetteredAt: new Date('2026-08-01T00:00:00Z'), order: { orderNumber: 'SO-gone', status: 'CANCELLED' } }),
  ], 10)

  assert.equal(live.orderStatus, 'ON_HOLD')
  assert.equal(cancelled.orderStatus, 'CANCELLED')
  // The merge itself claims nothing about withdrawals — the loader screens for that, against the
  // same local evidence the dispatch fence reads.
  assert.equal(live.withdrawalStanding, false)
})

test('[o3d-bjc.9] a NEW quarantine is not buried under a full page of older dead letters', () => {
  // The failure this pins: ordering by dispatchDeadLetteredAt first puts every
  // dead letter ahead of every unresolved-only row (nulls last), so a full page
  // of dead letters hides the quarantine on the page its own alert links to.
  const older = Array.from({ length: 50 }, (_, i) => stuckLink({
    orderId: `dl-${i}`,
    dispatchFailureCount: 5,
    dispatchLastError: 'apply failed',
    dispatchDeadLetteredAt: new Date(`2026-07-0${1 + (i % 9)}T00:00:00Z`),
  }))
  const fresh = stuckLink({
    orderId: 'q-1',
    dispatchUnresolvedCount: 5,
    dispatchUnresolvedError: 'no parts visible',
    dispatchUnresolvedAt: new Date('2026-07-25T12:00:00Z'),
  })

  const rows = inbox.mergeStuckDispatchRows([...older, fresh], 50)
  assert.equal(rows.length, 50)
  assert.equal(rows[0]?.orderId, 'q-1', 'the newest exception leads, whichever kind it is')
  assert.equal(rows[0]?.kind, 'unresolved')
  assert.equal(rows[0]?.failureCount, 5, 'the UNRESOLVED streak is what counts for a quarantine')
  assert.equal(rows[0]?.reason, 'no parts visible')
})

test('[o3d-bjc.9] a link carrying BOTH markers is reported as the dead-letter', () => {
  const rows = inbox.mergeStuckDispatchRows([stuckLink({
    orderId: 'both',
    dispatchFailureCount: 5,
    dispatchLastError: 'apply failed',
    dispatchDeadLetteredAt: new Date('2026-07-20T00:00:00Z'),
    dispatchUnresolvedCount: 5,
    dispatchUnresolvedError: 'no parts visible',
    dispatchUnresolvedAt: new Date('2026-07-19T00:00:00Z'),
  })], 50)
  assert.equal(rows[0]?.kind, 'dead-letter')
  assert.equal(rows[0]?.reason, 'apply failed', 'the stronger statement wins — an ERROR, not just unreadable')
})
