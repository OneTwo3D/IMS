import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildNextRetryDelayMs,
  buildMintsoftWebhookReplayForAsnWhere,
  buildMintsoftWebhookRetryUpdate,
  buildMintsoftWebhookSweepWhere,
  MINTSOFT_WEBHOOK_PROCESSING_STATUS,
} from '../lib/domain/wms/booked-in-service.ts'
import {
  buildBookedInDryRun,
  reconcileBookedInQuantities,
  sliceTransferSnapshotForReceipt,
} from '../lib/domain/wms/asn-reconciliation.ts'

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
      { costLayerId: 'layer-a', qty: 1, unitCostBase: '10.000000', orderAllocationId: undefined, shipmentLineId: undefined, source: undefined },
      { costLayerId: 'layer-b', qty: 2, unitCostBase: '12.000000', orderAllocationId: undefined, shipmentLineId: undefined, source: undefined },
    ],
  )
})

test('buildBookedInDryRun summarizes a safe ASN without warnings', () => {
  const dryRun = buildBookedInDryRun({
    externalAsnId: 'asn-safe',
    generatedAt: new Date('2026-05-27T10:00:00.000Z'),
    lines: [
      {
        asnLineMapId: 'line-map-1',
        externalAsnLineId: 'remote-line-1',
        sourceType: 'PURCHASE_ORDER_LINE',
        sourceLineId: 'po-line-1',
        productId: 'product-1',
        sku: 'SKU-1',
        expectedQty: 10,
        currentRemoteReceivedQty: 6,
        localReceivedQty: 2,
        qtyAccountedViaSnapshot: 0,
        qtyAccountedViaReceipt: 2,
        lastProcessedReceivedQty: 2,
        localLineExists: true,
      },
    ],
  })

  assert.deepEqual(dryRun.warnings, [])
  assert.equal(dryRun.generatedAt, '2026-05-27T10:00:00.000Z')
  assert.equal(dryRun.lines[0]?.stockQtyToAdd, 4)
  assert.equal(dryRun.lines[0]?.wouldCreateReceipt, true)
  assert.equal(dryRun.lines[0]?.wouldCreateCostLayer, true)
})

test('buildBookedInDryRun flags ambiguous ASNs before stock mutation', () => {
  const dryRun = buildBookedInDryRun({
    externalAsnId: 'asn-review',
    generatedAt: new Date('2026-05-27T10:00:00.000Z'),
    lines: [
      {
        asnLineMapId: 'line-map-1',
        externalAsnLineId: 'remote-line-1',
        sourceType: 'PURCHASE_ORDER_LINE',
        sourceLineId: 'missing-po-line',
        productId: 'product-1',
        sku: 'SKU-1',
        expectedQty: 10,
        currentRemoteReceivedQty: 12,
        localReceivedQty: 0,
        qtyAccountedViaSnapshot: 0,
        qtyAccountedViaReceipt: 0,
        lastProcessedReceivedQty: 0,
        localLineExists: false,
      },
      {
        asnLineMapId: 'line-map-2',
        externalAsnLineId: 'remote-line-2',
        sourceType: 'STOCK_TRANSFER_LINE',
        sourceLineId: 'transfer-line-1',
        productId: 'product-2',
        sku: 'SKU-2',
        expectedQty: 10,
        currentRemoteReceivedQty: 4,
        localReceivedQty: 0,
        qtyAccountedViaSnapshot: 7,
        qtyAccountedViaReceipt: 0,
        lastProcessedReceivedQty: 7,
        localLineExists: true,
        costLayerSnapshot: [],
      },
      {
        asnLineMapId: 'line-map-3',
        externalAsnLineId: 'remote-line-3',
        sourceType: 'STOCK_TRANSFER_LINE',
        sourceLineId: 'transfer-line-2',
        productId: 'product-3',
        sku: 'SKU-3',
        expectedQty: 10,
        currentRemoteReceivedQty: 5,
        localReceivedQty: 0,
        qtyAccountedViaSnapshot: 0,
        qtyAccountedViaReceipt: 0,
        lastProcessedReceivedQty: 0,
        localLineExists: true,
        costLayerSnapshot: [],
      },
      {
        asnLineMapId: 'line-map-4',
        externalAsnLineId: 'remote-line-4',
        sourceType: 'UNKNOWN',
        sourceLineId: 'unknown-line-1',
        productId: 'product-4',
        sku: 'SKU-4',
        expectedQty: 2,
        currentRemoteReceivedQty: 1,
      },
    ],
  })

  assert.deepEqual(dryRun.warnings, [
    'cost_layer_snapshot_missing',
    'missing_local_line',
    'received_over_expected',
    'remote_regression',
    'unsupported_source_type',
  ])
  assert.deepEqual(dryRun.lines[0]?.warnings, ['received_over_expected', 'missing_local_line'])
  assert.deepEqual(dryRun.lines[1]?.warnings, ['remote_regression'])
  assert.deepEqual(dryRun.lines[2]?.warnings, ['cost_layer_snapshot_missing'])
  assert.deepEqual(dryRun.lines[3]?.warnings, ['unsupported_source_type', 'missing_local_line'])
})

test('buildBookedInDryRun treats missing localLineExists as unsafe', () => {
  const dryRun = buildBookedInDryRun({
    externalAsnId: 'asn-missing-local-flag',
    generatedAt: new Date('2026-05-27T10:00:00.000Z'),
    lines: [
      {
        asnLineMapId: 'line-map-1',
        externalAsnLineId: 'remote-line-1',
        sourceType: 'PURCHASE_ORDER_LINE',
        sourceLineId: 'po-line-1',
        productId: 'product-1',
        sku: 'SKU-1',
        expectedQty: 10,
        currentRemoteReceivedQty: 5,
      },
    ],
  })

  assert.deepEqual(dryRun.warnings, ['missing_local_line'])
  assert.deepEqual(dryRun.lines[0]?.warnings, ['missing_local_line'])
})

test('buildBookedInDryRun only flags over-receipts outside the quantity tolerance', () => {
  const line = {
    asnLineMapId: 'line-map-1',
    externalAsnLineId: 'remote-line-1',
    sourceType: 'PURCHASE_ORDER_LINE',
    sourceLineId: 'po-line-1',
    productId: 'product-1',
    sku: 'SKU-1',
    expectedQty: 10,
    localReceivedQty: 0,
    qtyAccountedViaSnapshot: 0,
    qtyAccountedViaReceipt: 0,
    lastProcessedReceivedQty: 0,
    localLineExists: true,
  }

  const atExpected = buildBookedInDryRun({
    externalAsnId: 'asn-at-expected',
    generatedAt: new Date('2026-05-27T10:00:00.000Z'),
    lines: [{ ...line, currentRemoteReceivedQty: 10 }],
  })
  const withinTolerance = buildBookedInDryRun({
    externalAsnId: 'asn-within-tolerance',
    generatedAt: new Date('2026-05-27T10:00:00.000Z'),
    lines: [{ ...line, currentRemoteReceivedQty: 10.0001 }],
  })
  const outsideTolerance = buildBookedInDryRun({
    externalAsnId: 'asn-outside-tolerance',
    generatedAt: new Date('2026-05-27T10:00:00.000Z'),
    lines: [{ ...line, currentRemoteReceivedQty: 10.0002 }],
  })

  assert.deepEqual(atExpected.warnings, [])
  assert.deepEqual(withinTolerance.warnings, [])
  assert.deepEqual(outsideTolerance.warnings, ['received_over_expected'])
})

test('buildBookedInDryRun handles empty ASN line lists', () => {
  const dryRun = buildBookedInDryRun({
    externalAsnId: 'asn-empty',
    generatedAt: new Date('2026-05-27T10:00:00.000Z'),
    lines: [],
  })

  assert.deepEqual(dryRun.lines, [])
  assert.deepEqual(dryRun.warnings, [])
})

test('buildBookedInDryRun preserves multiple warning codes on one line', () => {
  const dryRun = buildBookedInDryRun({
    externalAsnId: 'asn-many-warnings',
    generatedAt: new Date('2026-05-27T10:00:00.000Z'),
    lines: [
      {
        asnLineMapId: 'line-map-1',
        externalAsnLineId: 'remote-line-1',
        sourceType: 'UNKNOWN',
        sourceLineId: 'unknown-line-1',
        productId: 'product-1',
        sku: 'SKU-1',
        expectedQty: 10,
        currentRemoteReceivedQty: 12,
        qtyAccountedViaSnapshot: 8,
        lastProcessedReceivedQty: 8,
      },
    ],
  })

  assert.deepEqual(dryRun.lines[0]?.warnings, [
    'received_over_expected',
    'unsupported_source_type',
    'missing_local_line',
  ])
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
