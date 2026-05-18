import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  takeFromSnapshotEntries,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'

export type ReconciledBookedInQuantities = {
  currentReceivedQty: number
  qtyReceived: number
  reconciledManualQty: number
  coveredBySnapshotQty: number
  stockQtyToAdd: number
  newlyProcessedQty: number
}

export function reconcileBookedInQuantities(input: {
  expectedQty: number
  currentReceivedQty: number
  localReceivedQty: number
  lastProcessedReceivedQty: number
  qtyAccountedViaSnapshot?: number
  qtyAccountedViaReceipt?: number
}): ReconciledBookedInQuantities {
  const expectedQty = Math.max(0, input.expectedQty)
  const currentReceivedQty = Math.min(expectedQty, Math.max(0, input.currentReceivedQty))
  const localReceivedQty = Math.min(currentReceivedQty, Math.max(0, input.localReceivedQty))
  const lastProcessedReceivedQty = Math.min(expectedQty, Math.max(0, input.lastProcessedReceivedQty))
  const qtyAccountedViaSnapshot = Math.min(expectedQty, Math.max(0, input.qtyAccountedViaSnapshot ?? 0))
  const qtyAccountedViaReceipt = Math.min(expectedQty, Math.max(0, input.qtyAccountedViaReceipt ?? 0))
  const alreadyAccountedViaAsn = Math.max(lastProcessedReceivedQty, localReceivedQty)
  const reconciledManualQty = Math.max(0, alreadyAccountedViaAsn - lastProcessedReceivedQty)
  const qtyReceived = Math.max(0, currentReceivedQty - alreadyAccountedViaAsn)
  const unabsorbedFromSnapshot = Math.max(0, qtyAccountedViaSnapshot - qtyAccountedViaReceipt)
  const coveredBySnapshotQty = Math.min(qtyReceived, unabsorbedFromSnapshot)
  const stockQtyToAdd = Math.max(0, qtyReceived - coveredBySnapshotQty)
  const newlyProcessedQty = qtyReceived + reconciledManualQty

  return {
    currentReceivedQty,
    qtyReceived,
    reconciledManualQty,
    coveredBySnapshotQty,
    stockQtyToAdd,
    newlyProcessedQty,
  }
}

export function sliceTransferSnapshotForReceipt(input: {
  snapshot: unknown
  alreadyReceivedQty: number
  qtyReceived: number
}): CostLayerSnapshotEntry[] {
  const snapshot = parseCostLayerSnapshot(input.snapshot)
  if (snapshot.length === 0) return []

  const alreadyReceivedQty = Math.max(0, input.alreadyReceivedQty)
  const qtyReceived = Math.max(0, input.qtyReceived)
  if (qtyReceived <= 0) return []

  const { taken: consumedBeforeThisReceipt } = takeFromSnapshotEntries(snapshot, alreadyReceivedQty)
  const remaining = reduceSnapshotByCostLayer(
    snapshot,
    consumedBeforeThisReceipt.map((entry) => ({
      costLayerId: entry.costLayerId,
      qty: entry.qty,
    })),
  )

  return takeFromSnapshotEntries(remaining, qtyReceived).taken
}
