import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildNextRetryDelayMs,
  buildMintsoftWebhookReplayForAsnWhere,
  buildMintsoftWebhookRetryUpdate,
  buildMintsoftWebhookSweepWhere,
  MINTSOFT_WEBHOOK_PROCESSING_STATUS,
} from '../lib/connectors/mintsoft/sync/booked-in-handler.ts'
import {
  reconcileBookedInQuantities,
  sliceTransferSnapshotForReceipt,
} from '../lib/connectors/mintsoft/sync/booked-in-helpers.ts'

test('reconcileBookedInQuantities only books the unaccounted delta from Mintsoft', () => {
  assert.deepEqual(
    reconcileBookedInQuantities({
      expectedQty: 100,
      currentReceivedQty: 60,
      localReceivedQty: 20,
      lastProcessedReceivedQty: 0,
      qtyAccountedViaSnapshot: 60,
      qtyAccountedViaReceipt: 0,
    }),
    {
      currentReceivedQty: 60,
      qtyReceived: 40,
      reconciledManualQty: 20,
      coveredBySnapshotQty: 40,
      stockQtyToAdd: 0,
      newlyProcessedQty: 60,
    },
  )

  assert.deepEqual(
    reconcileBookedInQuantities({
      expectedQty: 100,
      currentReceivedQty: 60,
      localReceivedQty: 60,
      lastProcessedReceivedQty: 60,
      qtyAccountedViaSnapshot: 60,
      qtyAccountedViaReceipt: 60,
    }),
    {
      currentReceivedQty: 60,
      qtyReceived: 0,
      reconciledManualQty: 0,
      coveredBySnapshotQty: 0,
      stockQtyToAdd: 0,
      newlyProcessedQty: 0,
    },
  )

  assert.deepEqual(
    reconcileBookedInQuantities({
      expectedQty: 100,
      currentReceivedQty: 60,
      localReceivedQty: 0,
      lastProcessedReceivedQty: 0,
      qtyAccountedViaSnapshot: 30,
      qtyAccountedViaReceipt: 0,
    }),
    {
      currentReceivedQty: 60,
      qtyReceived: 60,
      reconciledManualQty: 0,
      coveredBySnapshotQty: 30,
      stockQtyToAdd: 30,
      newlyProcessedQty: 60,
    },
  )
})

test('sliceTransferSnapshotForReceipt takes the next cost-layer slice after prior receipts', () => {
  assert.deepEqual(
    sliceTransferSnapshotForReceipt({
      snapshot: [
        { costLayerId: 'layer-a', qty: 3, unitCostBase: 10 },
        { costLayerId: 'layer-b', qty: 4, unitCostBase: 12 },
      ],
      alreadyReceivedQty: 2,
      qtyReceived: 3,
    }),
    [
      { costLayerId: 'layer-a', qty: 1, unitCostBase: 10, orderAllocationId: undefined, shipmentLineId: undefined, source: undefined },
      { costLayerId: 'layer-b', qty: 2, unitCostBase: 12, orderAllocationId: undefined, shipmentLineId: undefined, source: undefined },
    ],
  )
})

test('buildMintsoftWebhookRetryUpdate schedules pending retry state in typed columns', () => {
  const now = new Date('2026-05-14T10:00:00.000Z')

  assert.deepEqual(
    buildMintsoftWebhookRetryUpdate('pending', 'ASN not mapped yet', 0, now, () => 0.5),
    {
      processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.pendingRetry,
      processingAttempts: 1,
      nextRetryAt: new Date('2026-05-14T10:01:00.000Z'),
      deadLetteredAt: null,
      lastError: 'ASN not mapped yet',
    },
  )
})

test('buildNextRetryDelayMs applies bounded jitter without retrying faster than the base delay', () => {
  assert.equal(buildNextRetryDelayMs('pending', 1, () => 0), 60_000)
  assert.equal(buildNextRetryDelayMs('pending', 1, () => 0.5), 60_000)
  assert.equal(buildNextRetryDelayMs('pending', 1, () => 1), 72_000)

  assert.equal(buildNextRetryDelayMs('failed', 2, () => 0), 480_000)
  assert.equal(buildNextRetryDelayMs('failed', 2, () => 0.5), 600_000)
  assert.equal(buildNextRetryDelayMs('failed', 2, () => 1), 720_000)
})

test('buildMintsoftWebhookRetryUpdate schedules failed retry state with failed backoff', () => {
  const now = new Date('2026-05-14T10:00:00.000Z')

  assert.deepEqual(
    buildMintsoftWebhookRetryUpdate('failed', 'remote API failed', 1, now, () => 0.5),
    {
      processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.failedRetry,
      processingAttempts: 2,
      nextRetryAt: new Date('2026-05-14T10:10:00.000Z'),
      deadLetteredAt: null,
      lastError: 'remote API failed',
    },
  )
})

test('buildMintsoftWebhookRetryUpdate dead-letters after max attempts', () => {
  const now = new Date('2026-05-14T10:00:00.000Z')

  assert.deepEqual(
    buildMintsoftWebhookRetryUpdate('pending', 'ASN never finalized', 11, now),
    {
      processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.dead,
      processingAttempts: 12,
      nextRetryAt: null,
      deadLetteredAt: now,
      lastError: 'ASN never finalized',
    },
  )
})

test('buildMintsoftWebhookSweepWhere selects only pending or due retry events', () => {
  const now = new Date('2026-05-14T10:00:00.000Z')

  assert.deepEqual(
    buildMintsoftWebhookSweepWhere(now),
    {
      connector: 'mintsoft',
      processedAt: null,
      OR: [
        { processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.pending },
        {
          processingStatus: {
            in: [
              MINTSOFT_WEBHOOK_PROCESSING_STATUS.pendingRetry,
              MINTSOFT_WEBHOOK_PROCESSING_STATUS.failedRetry,
            ],
          },
          nextRetryAt: { lte: now },
        },
      ],
    },
  )
})

test('buildMintsoftWebhookReplayForAsnWhere includes dead-lettered unprocessed events', () => {
  assert.deepEqual(
    buildMintsoftWebhookReplayForAsnWhere('asn-123'),
    {
      connector: 'mintsoft',
      externalAsnId: 'asn-123',
      processedAt: null,
    },
  )
})
