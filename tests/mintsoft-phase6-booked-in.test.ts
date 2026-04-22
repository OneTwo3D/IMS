import assert from 'node:assert/strict'
import test from 'node:test'
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
    }),
    {
      currentReceivedQty: 60,
      qtyReceived: 40,
      reconciledManualQty: 20,
    },
  )

  assert.deepEqual(
    reconcileBookedInQuantities({
      expectedQty: 100,
      currentReceivedQty: 60,
      localReceivedQty: 60,
      lastProcessedReceivedQty: 60,
    }),
    {
      currentReceivedQty: 60,
      qtyReceived: 0,
      reconciledManualQty: 0,
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
