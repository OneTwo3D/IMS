import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  takeFromSnapshotEntries,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'

const QTY_EPSILON = 0.0001

export type BookedInDryRunWarningCode =
  | 'remote_regression'
  | 'missing_local_line'
  | 'unsupported_source_type'
  | 'cost_layer_snapshot_missing'
  | 'received_over_expected'

export type BookedInDryRunLineInput = {
  asnLineMapId: string
  externalAsnLineId: string
  sourceType: string
  sourceLineId: string
  productId: string
  sku: string
  expectedQty: number
  currentRemoteReceivedQty: number
  localReceivedQty?: number
  qtyAccountedViaSnapshot?: number
  qtyAccountedViaReceipt?: number
  lastProcessedReceivedQty?: number
  localLineExists?: boolean
  costLayerSnapshot?: unknown
}

export type BookedInDryRunLine = {
  asnLineMapId: string
  externalAsnLineId: string
  sourceType: string
  sourceLineId: string
  productId: string
  sku: string
  expectedQty: number
  currentRemoteReceivedQty: number
  localReceivedQty: number
  qtyAccountedViaSnapshot: number
  qtyAccountedViaReceipt: number
  lastProcessedReceivedQty: number
  qtyReceived: number
  reconciledManualQty: number
  coveredBySnapshotQty: number
  stockQtyToAdd: number
  newlyProcessedQty: number
  wouldCreateReceipt: boolean
  wouldCreateCostLayer: boolean
  warnings: BookedInDryRunWarningCode[]
}

export type BookedInDryRun = {
  externalAsnId: string
  generatedAt: string
  lines: BookedInDryRunLine[]
  warnings: BookedInDryRunWarningCode[]
}

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

function normalizeQty(value: number | undefined): number {
  return Math.max(0, Number.isFinite(value) ? value ?? 0 : 0)
}

function uniqueWarnings(lines: BookedInDryRunLine[]): BookedInDryRunWarningCode[] {
  return Array.from(new Set(lines.flatMap((line) => line.warnings))).sort()
}

export function buildBookedInDryRun(input: {
  externalAsnId: string
  generatedAt: Date
  lines: BookedInDryRunLineInput[]
}): BookedInDryRun {
  const lines = input.lines.map<BookedInDryRunLine>((line) => {
    const expectedQty = normalizeQty(line.expectedQty)
    const currentRemoteReceivedQty = normalizeQty(line.currentRemoteReceivedQty)
    const localReceivedQty = normalizeQty(line.localReceivedQty)
    const qtyAccountedViaSnapshot = normalizeQty(line.qtyAccountedViaSnapshot)
    const qtyAccountedViaReceipt = normalizeQty(line.qtyAccountedViaReceipt)
    const lastProcessedReceivedQty = normalizeQty(line.lastProcessedReceivedQty)
    const reconciled = reconcileBookedInQuantities({
      expectedQty,
      currentReceivedQty: currentRemoteReceivedQty,
      localReceivedQty,
      lastProcessedReceivedQty,
      qtyAccountedViaSnapshot,
      qtyAccountedViaReceipt,
    })
    const warnings: BookedInDryRunWarningCode[] = []

    if (currentRemoteReceivedQty > expectedQty + QTY_EPSILON) {
      warnings.push('received_over_expected')
    }
    if (currentRemoteReceivedQty + QTY_EPSILON < Math.max(lastProcessedReceivedQty, qtyAccountedViaSnapshot)) {
      warnings.push('remote_regression')
    }
    if (line.sourceType !== 'PURCHASE_ORDER_LINE' && line.sourceType !== 'STOCK_TRANSFER_LINE') {
      warnings.push('unsupported_source_type')
    }
    if (line.localLineExists === false) {
      warnings.push('missing_local_line')
    }
    if (
      line.sourceType === 'STOCK_TRANSFER_LINE'
      && reconciled.stockQtyToAdd > QTY_EPSILON
      && parseCostLayerSnapshot(line.costLayerSnapshot).length === 0
    ) {
      warnings.push('cost_layer_snapshot_missing')
    }

    return {
      asnLineMapId: line.asnLineMapId,
      externalAsnLineId: line.externalAsnLineId,
      sourceType: line.sourceType,
      sourceLineId: line.sourceLineId,
      productId: line.productId,
      sku: line.sku,
      expectedQty,
      currentRemoteReceivedQty,
      localReceivedQty,
      qtyAccountedViaSnapshot,
      qtyAccountedViaReceipt,
      lastProcessedReceivedQty,
      qtyReceived: reconciled.qtyReceived,
      reconciledManualQty: reconciled.reconciledManualQty,
      coveredBySnapshotQty: reconciled.coveredBySnapshotQty,
      stockQtyToAdd: reconciled.stockQtyToAdd,
      newlyProcessedQty: reconciled.newlyProcessedQty,
      wouldCreateReceipt: reconciled.qtyReceived > QTY_EPSILON,
      wouldCreateCostLayer: reconciled.stockQtyToAdd > QTY_EPSILON,
      warnings,
    }
  })

  return {
    externalAsnId: input.externalAsnId,
    generatedAt: input.generatedAt.toISOString(),
    lines,
    warnings: uniqueWarnings(lines),
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
