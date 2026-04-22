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
