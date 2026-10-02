import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildNextRetryDelayMs,
  buildMintsoftWebhookReplayForAsnWhere,
  buildMintsoftWebhookRetryUpdate,
  buildMintsoftWebhookSweepWhere,
  WMS_INBOUND_EVENT_PROCESSING_STATUS,
} from '../lib/domain/wms/booked-in-service.ts'
import { resolveTransferLineLandedQty } from '../lib/domain/inventory/transfer-landed-quantity.ts'
import {
  buildBookedInDryRun,
  reconcileBookedInQuantities,
  resolveManualReceiptPool,
  sliceTransferSnapshotForReceipt,
} from '../lib/domain/wms/asn-reconciliation.ts'

/** o3d-papk: the manual-receipt pool is branded; a test builds one the way production does. */
const poolOf = (lineQtyReceived: number, lineReconciledAcrossAsns = 0) =>
  resolveManualReceiptPool({ lineQtyReceived, lineReconciledAcrossAsns, rowManualQtyBaseline: 0 })
const NO_POOL = poolOf(0)

test('reconcileBookedInQuantities only books the unaccounted delta from Mintsoft', () => {
  assert.deepEqual(
    reconcileBookedInQuantities({
      expectedQty: 100,
      currentReceivedQty: 60,
      manualReceiptPool: poolOf(20),
      lastProcessedReceivedQty: 0,
      qtyAccountedViaSnapshot: 60,
      qtyAccountedViaReceipt: 0,
    }),
    // o3d-papk: the snapshot credit covers its units FIRST (60 of them), so no manual receipt is needed to
    // explain the rest. The old order took the manual 20 first and left landed 20 short of the stock added
    // (Codex H1): qtyReceived must rise by the whole 60 here, because the 60 credited units are no longer
    // counted by the snapshot arm once `qtyAccountedViaReceipt` has absorbed them.
    {
      currentReceivedQty: 60,
      qtyReceived: 60,
      reconciledManualQty: 0,
      coveredBySnapshotQty: 60,
      stockQtyToAdd: 0,
      newlyProcessedQty: 60,
    },
  )

  assert.deepEqual(
    reconcileBookedInQuantities({
      expectedQty: 100,
      currentReceivedQty: 60,
      manualReceiptPool: poolOf(60, 60),
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
      manualReceiptPool: NO_POOL,
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
      alreadyLanded: resolveTransferLineLandedQty({ transferLineId: 'tl-1', qtyReceived: 2, wmsAsnLines: [] }),
      qtyReceived: 3,
    }),
    [
      // o3d-0i5y r9: `postedUnitCostBase` rides through every take, so a rewrite that moves units
      // between rows carries the record of what was posted for them. A transfer slice never has one.
      { costLayerId: 'layer-a', qty: '1.000000', unitCostBase: '10.000000', orderAllocationId: undefined, shipmentLineId: undefined, source: undefined, postedUnitCostBase: undefined },
      { costLayerId: 'layer-b', qty: '2.000000', unitCostBase: '12.000000', orderAllocationId: undefined, shipmentLineId: undefined, source: undefined, postedUnitCostBase: undefined },
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
        manualReceiptPool: poolOf(2, 2),
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
        manualReceiptPool: NO_POOL,
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
        manualReceiptPool: NO_POOL,
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
        manualReceiptPool: NO_POOL,
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
        manualReceiptPool: NO_POOL,
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
        manualReceiptPool: NO_POOL,
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
    manualReceiptPool: NO_POOL,
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
        manualReceiptPool: NO_POOL,
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
      processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.pendingRetry,
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
      processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.failedRetry,
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
      processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.dead,
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
        { processingStatus: WMS_INBOUND_EVENT_PROCESSING_STATUS.pending },
        {
          processingStatus: {
            in: [
              WMS_INBOUND_EVENT_PROCESSING_STATUS.pendingRetry,
              WMS_INBOUND_EVENT_PROCESSING_STATUS.failedRetry,
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

test('o3d-papk round 2: a line with something to apply against a CANCELLED/CLOSED parent raises parent_not_receivable; a settled line and a receivable parent do not', () => {
  const base = {
    asnLineMapId: 'line-map-1',
    externalAsnLineId: 'remote-line-1',
    sourceType: 'PURCHASE_ORDER_LINE',
    sourceLineId: 'po-line-1',
    productId: 'product-1',
    sku: 'SKU-1',
    expectedQty: 10,
    manualReceiptPool: NO_POOL,
    qtyAccountedViaSnapshot: 0,
    qtyAccountedViaReceipt: 0,
    lastProcessedReceivedQty: 0,
    localLineExists: true,
  }
  const run = (line: Record<string, unknown>) => buildBookedInDryRun({
    externalAsnId: 'asn-parent',
    generatedAt: new Date('2026-10-02T00:00:00.000Z'),
    lines: [{ ...base, ...line } as never],
  }).lines[0]!.warnings
  assert.deepEqual(run({ currentRemoteReceivedQty: 6, parentReceivable: false }), ['parent_not_receivable'], 'something to apply, parent not receivable')
  assert.deepEqual(run({ currentRemoteReceivedQty: 6, parentReceivable: true }), [], 'receivable parent')
  assert.deepEqual(run({ currentRemoteReceivedQty: 6 }), [], 'unspecified means not known to be unusable (a transfer line)')
  assert.deepEqual(run({ currentRemoteReceivedQty: 6, lastProcessedReceivedQty: 6, qtyAccountedViaReceipt: 6, parentReceivable: false }), [], 'a settled line (no delta) does not drag its siblings into review')
  console.log('# o3d-papk round 2: evaluated 4 dry-run lines')
})
