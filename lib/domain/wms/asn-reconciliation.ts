import type { TransferLineLandedQty } from '@/lib/domain/inventory/transfer-landed-quantity'
import type { WmsAsnLineRef } from '@/lib/connectors/wms/types'
import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  takeFromSnapshotEntries,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'
import { addMoney, toDecimal } from '@/lib/domain/math/decimal'

export const WMS_RECEIPT_QTY_EPSILON = 0.0001

/**
 * The parent transfer statuses under which a `wms_asn_line_maps` row may still be
 * used to bring units into stock (6oyu.19, Codex round-7 HIGH-1).
 *
 * WHY THIS IS SHARED. The WMS webhook book-in has always checked this — an ASN
 * callback for a transfer that is not IN_TRANSIT or RECEIVED is refused. The WMS
 * stock-sync ALIGNMENT path never did, and nothing closes a transfer's ASN when its
 * dispatch is cancelled: `cancelDispatchedTransfer` restores the FULL line quantity
 * and its cost layers to the SOURCE and leaves the ASN open. A later automatic
 * align-up could then use that cancelled line, add stock at the DESTINATION and
 * create a second replacement layer linked to the same source layer, so one
 * subsequent landed-cost revaluation propagated into both live layers and posted
 * the inventory reclassification twice. That is the same double-count this branch
 * exists to close, reached from a route the branch did not touch — it predates the
 * branch (see o3d-1mga for production prevalence).
 *
 * DRAFT is excluded as well as CANCELLED: nothing has been dispatched, so there is
 * no cost-layer snapshot to slice and no units to bring to rest.
 */
export const WMS_RECEIPT_USABLE_TRANSFER_STATUSES = ['IN_TRANSIT', 'RECEIVED'] as const

export function isTransferUsableForWmsReceipt(status: string): boolean {
  return (WMS_RECEIPT_USABLE_TRANSFER_STATUSES as ReadonlyArray<string>).includes(status)
}

export type BookedInDryRunWarningCode =
  | 'remote_regression'
  | 'missing_local_line'
  | 'unsupported_source_type'
  | 'cost_layer_snapshot_missing'
  | 'received_over_expected'
  // o3d-btiw — the two ways a REMOTE quantity can be UNKNOWN rather than zero. Both are
  // approval-blocked in booked-in-service.ts: acknowledging a warning cannot supply a number the
  // warehouse never served, and the alternative — reading unknown as 0 — applies nothing while
  // reporting success, or reads as a regression against earlier state.
  | 'remote_quantity_unreadable'
  | 'missing_remote_line'
  // o3d-papk: the parent order (purchase order) is CANCELLED or CLOSED, so it expects nothing more. A callback that
  // would bring units in against it is held for review instead: stock, a cost layer and a journal against an order the
  // business has called off is a different problem from a late receipt, and approval cannot make it receivable.
  | 'parent_not_receivable'

/**
 * A remote quantity IMS could not use, and why. o3d-btiw.
 *
 * The presence of one of these on a line is what makes "IMS does not know how much was booked in"
 * expressible at all. Before it, an unread or absent remote quantity became `0`, which is a
 * MEASUREMENT — and a measurement of nothing arriving is exactly what a silent no-op looks like from
 * the outside.
 */
export type BookedInRemoteQuantityRefusal = {
  code: 'remote_quantity_unreadable' | 'missing_remote_line'
  detail: string
}

/**
 * THE ONE PLACE THAT TURNS A REMOTE ASN LINE INTO THE QUANTITY THE BOOKED-IN PATH ACTS ON — or into
 * a refusal. o3d-btiw.
 *
 * Kept here, pure and exported, for two reasons: the booked-in service holds row locks when it runs
 * and must do no I/O or thinking of its own at that point, and this is the decision the whole issue
 * is about, so it is drivable by a unit test over a recorded live body without a database.
 *
 * THERE IS NO `?? 0` IN IT. A missing remote line and an unreadable remote quantity are returned as
 * refusals; the caller raises an approval-blocked review warning and changes nothing.
 */
export function resolveRemoteBookedInQuantity(remoteLine: WmsAsnLineRef | null | undefined): {
  bookedIntoStockQty: number | null
  arrivedAtWarehouseQty: number | null
  basis: string | null
  refusal: BookedInRemoteQuantityRefusal | null
} {
  if (!remoteLine) {
    return {
      bookedIntoStockQty: null,
      arrivedAtWarehouseQty: null,
      basis: null,
      refusal: {
        code: 'missing_remote_line',
        detail: 'the WMS returned no item for this ASN line, so how much of it has been booked in is unknown',
      },
    }
  }
  const receipt = remoteLine.receipt
  if (receipt.kind !== 'reported') {
    return {
      bookedIntoStockQty: null,
      // The arrived quantity survives the refusal (see WmsAsnLineReceipt): when the booked one cannot
      // be read, this is the only thing the warehouse said, and it belongs in front of the reviewer.
      arrivedAtWarehouseQty: receipt.arrivedAtWarehouseQty,
      basis: null,
      refusal: { code: 'remote_quantity_unreadable', detail: receipt.detail },
    }
  }
  return {
    bookedIntoStockQty: receipt.bookedIntoStockQty,
    arrivedAtWarehouseQty: receipt.arrivedAtWarehouseQty,
    basis: receipt.basis,
    refusal: null,
  }
}

export type BookedInDryRunLineInput = {
  asnLineMapId: string
  externalAsnLineId: string
  sourceType: string
  sourceLineId: string
  productId: string
  sku: string
  expectedQty: number
  currentRemoteReceivedQty: number
  /** The manual receipts on this line not yet reconciled against any ASN (see `ManualReceiptPool`). */
  manualReceiptPool: ManualReceiptPool
  qtyAccountedViaSnapshot?: number
  qtyAccountedViaReceipt?: number
  lastProcessedReceivedQty?: number
  localLineExists?: boolean
  /**
   * o3d-papk. False when the line's parent order is in a status that expects nothing more (a CANCELLED or CLOSED
   * purchase order). Absent means "not known to be unusable" (a transfer line, whose status is enforced where it is
   * locked). Raises `parent_not_receivable` for a line that has something to apply.
   */
  parentReceivable?: boolean
  costLayerSnapshot?: unknown
  /**
   * o3d-btiw. Set when the WMS served no usable booked quantity for this line. When it is set,
   * `currentRemoteReceivedQty` is IGNORED and replaced by the quantity already processed, so the
   * arithmetic below cannot act on a number nobody measured — and the refusal's code becomes an
   * approval-blocked warning.
   */
  remoteQuantityRefusal?: BookedInRemoteQuantityRefusal | null
  /**
   * `QuantityReceieved` — arrived at the warehouse but not necessarily booked into its stock. Carried
   * so the gap between arriving and being booked in is a number a reviewer can read rather than a
   * fact only the WMS holds. Never used in the arithmetic.
   */
  remoteArrivedQty?: number | null
  /** The remote field `currentRemoteReceivedQty` was read from, for the audit trail. */
  remoteQuantityBasis?: string | null
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
  /** The manual-receipt pool this line was reconciled against (renamed from the raw `localReceivedQty`, o3d-papk). */
  manualReceiptPoolQty: number
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
  /** o3d-btiw — see `BookedInDryRunLineInput`. `null` when the WMS's quantity was usable. */
  remoteQuantityRefusal: BookedInRemoteQuantityRefusal | null
  remoteArrivedQty: number | null
  remoteQuantityBasis: string | null
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
  /** What this book-in adds to the line's `qtyReceived`: the delta less the units a manual receipt already covered. */
  qtyReceived: number
  /** Units of the delta that a MANUAL receipt on the line had already booked (and journalled): no stock is added for them. */
  reconciledManualQty: number
  coveredBySnapshotQty: number
  stockQtyToAdd: number
  /** The delta this book-in accounts for: what `qtyAccountedViaReceipt` and `lastProcessedReceivedQty` rise by. */
  newlyProcessedQty: number
}

declare const MANUAL_RECEIPT_POOL_BRAND: unique symbol

/**
 * HOW MANY OF THE UNITS A BOOK-IN IS ABOUT TO ACCOUNT FOR A MANUAL RECEIPT ON THE SAME LINE MAY ALREADY HAVE
 * BOOKED (o3d-papk, o3d-67kw3). BRANDED ON PURPOSE: the old input was the line's raw `qtyReceived`, read by
 * three callers each in its own way, and the raw figure is the defect — it counts receipts made BEFORE this
 * ASN was sized, and receipts the line's OTHER ASNs already booked. A caller can no longer hand one in: only
 * `resolveManualReceiptPool` builds a pool.
 *
 *   pool = max(0, qtyReceived - Σ lastProcessedReceivedQty over EVERY ASN row of the line (closed included)
 *                  - this row's manualQtyBaseline)
 *
 * `qtyReceived - Σ lastProcessed` is an exact identity for "manual receipts not yet reconciled against any ASN":
 * the only writers of `qtyReceived` are the manual receipt (+x), the PO book-in and the transfer book-in
 * (+delta - manual, while `lastProcessed` rises by delta), and every one holds the parent order's row lock.
 * The baseline removes the ones that pre-date this ASN row: it is that same figure, read under the parent lock
 * when the row was created or resized.
 */
export type ManualReceiptPool = {
  readonly [MANUAL_RECEIPT_POOL_BRAND]: 'manual-receipt-pool'
  readonly qty: number
  readonly lineQtyReceived: number
  readonly lineReconciledAcrossAsns: number
  readonly rowManualQtyBaseline: number
}

/** THE ONLY constructor of `ManualReceiptPool`. */
export function resolveManualReceiptPool(input: {
  /** `qtyReceived` of the PO / transfer line. */
  lineQtyReceived: number
  /** Σ `lastProcessedReceivedQty` over EVERY ASN row of that line, closed rows included. */
  lineReconciledAcrossAsns: number
  /** `manualQtyBaseline` of the ASN row being reconciled. */
  rowManualQtyBaseline: number
}): ManualReceiptPool {
  const lineQtyReceived = Math.max(0, Number.isFinite(input.lineQtyReceived) ? input.lineQtyReceived : 0)
  const lineReconciledAcrossAsns = Math.max(0, Number.isFinite(input.lineReconciledAcrossAsns) ? input.lineReconciledAcrossAsns : 0)
  const rowManualQtyBaseline = Math.max(0, Number.isFinite(input.rowManualQtyBaseline) ? input.rowManualQtyBaseline : 0)
  const qty = Math.max(0, lineQtyReceived - lineReconciledAcrossAsns - rowManualQtyBaseline)
  return { qty, lineQtyReceived, lineReconciledAcrossAsns, rowManualQtyBaseline } as ManualReceiptPool
}

/**
 * THE BOOK-IN ARITHMETIC. The invariant (property-tested): a book-in changes the line's LANDED quantity
 * (`qtyReceived + Σ unabsorbed snapshot`) by EXACTLY `stockQtyToAdd`, and accounts for exactly `delta`.
 *
 *   delta     = current - lastProcessed                       (clamped as ever)
 *   covered   = min(delta, unabsorbed snapshot credit)        FIRST: a credit is a unit the alignment already put in stock
 *   manual    = min(delta - covered, manual receipt pool)     only then: a manual receipt that covers what is left
 *   qtyReceived += delta - manual        stockToAdd = delta - covered - manual
 *
 * The old order took the manual term first. With a manual receipt on the line the snapshot cover then shrank
 * while qtyReceived rose by less than the credit it absorbed, and the line's landed quantity FELL (Codex H1).
 */
export function reconcileBookedInQuantities(input: {
  expectedQty: number
  currentReceivedQty: number
  manualReceiptPool: ManualReceiptPool
  lastProcessedReceivedQty: number
  qtyAccountedViaSnapshot?: number
  qtyAccountedViaReceipt?: number
}): ReconciledBookedInQuantities {
  const expectedQty = Math.max(0, input.expectedQty)
  const currentReceivedQty = Math.min(expectedQty, Math.max(0, input.currentReceivedQty))
  const lastProcessedReceivedQty = Math.min(expectedQty, Math.max(0, input.lastProcessedReceivedQty))
  const qtyAccountedViaSnapshot = Math.min(expectedQty, Math.max(0, input.qtyAccountedViaSnapshot ?? 0))
  const qtyAccountedViaReceipt = Math.min(expectedQty, Math.max(0, input.qtyAccountedViaReceipt ?? 0))
  const delta = Math.max(0, currentReceivedQty - lastProcessedReceivedQty)
  const unabsorbedFromSnapshot = Math.max(0, qtyAccountedViaSnapshot - qtyAccountedViaReceipt)
  const coveredBySnapshotQty = Math.min(delta, unabsorbedFromSnapshot)
  const reconciledManualQty = Math.min(delta - coveredBySnapshotQty, input.manualReceiptPool.qty)
  const qtyReceived = delta - reconciledManualQty
  const stockQtyToAdd = delta - coveredBySnapshotQty - reconciledManualQty

  return {
    currentReceivedQty,
    qtyReceived,
    reconciledManualQty,
    coveredBySnapshotQty,
    stockQtyToAdd,
    newlyProcessedQty: delta,
  }
}

function normalizeQty(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value as number)
}

function uniqueWarnings(lines: BookedInDryRunLine[]): BookedInDryRunWarningCode[] {
  // Keep aggregate warning order stable; UI styling handles severity.
  return Array.from(new Set(lines.flatMap((line) => line.warnings))).sort()
}

export function buildBookedInDryRun(input: {
  externalAsnId: string
  generatedAt: Date
  lines: BookedInDryRunLineInput[]
}): BookedInDryRun {
  const lines = input.lines.map<BookedInDryRunLine>((line) => {
    const expectedQty = normalizeQty(line.expectedQty)
    const remoteQuantityRefusal = line.remoteQuantityRefusal ?? null
    const qtyAccountedViaSnapshot = normalizeQty(line.qtyAccountedViaSnapshot)
    const qtyAccountedViaReceipt = normalizeQty(line.qtyAccountedViaReceipt)
    const lastProcessedReceivedQty = normalizeQty(line.lastProcessedReceivedQty)
    // o3d-btiw — AN UNKNOWN REMOTE QUANTITY IS NOT ZERO, AND IT IS NOT A DECREASE EITHER. When the
    // WMS served nothing usable, the line's remote quantity is pinned to what has ALREADY been
    // accounted for, so the delta is exactly nothing and `remote_regression` cannot fire and say the
    // warehouse went backwards. Nothing is applied because the refusal is an approval-blocked review
    // warning, not because a fabricated 0 happened to produce no delta. The rule lives HERE, in the
    // pure function, as well as at the caller, so a caller that forgets cannot reintroduce the 0.
    const currentRemoteReceivedQty = remoteQuantityRefusal
      ? lastProcessedReceivedQty
      : normalizeQty(line.currentRemoteReceivedQty)
    const reconciled = reconcileBookedInQuantities({
      expectedQty,
      currentReceivedQty: currentRemoteReceivedQty,
      manualReceiptPool: line.manualReceiptPool,
      lastProcessedReceivedQty,
      qtyAccountedViaSnapshot,
      qtyAccountedViaReceipt,
    })
    const warnings: BookedInDryRunWarningCode[] = []

    if (remoteQuantityRefusal) {
      // o3d-btiw. `received_over_expected` and `remote_regression` are both CLAIMS ABOUT THE REMOTE
      // QUANTITY, and there isn't one. Emitting either would put a false statement about the
      // warehouse in front of a reviewer — `remote_regression` renders as "Mintsoft quantity
      // decreased", which is precisely what the unread live shape produced on the delta path before
      // this fix. The refusal itself is the warning, and it says what is actually wrong.
      warnings.push(remoteQuantityRefusal.code)
    } else {
      // Conservative policy: every over-receipt requires review because it can affect stock valuation,
      // supplier billing, and accounting variance. It remains approval-allowed after acknowledgement.
      if (currentRemoteReceivedQty > expectedQty + WMS_RECEIPT_QTY_EPSILON) {
        warnings.push('received_over_expected')
      }
      if (currentRemoteReceivedQty + WMS_RECEIPT_QTY_EPSILON < Math.max(lastProcessedReceivedQty, qtyAccountedViaSnapshot)) {
        warnings.push('remote_regression')
      }
    }
    if (line.sourceType !== 'PURCHASE_ORDER_LINE' && line.sourceType !== 'STOCK_TRANSFER_LINE') {
      warnings.push('unsupported_source_type')
    }
    if (line.localLineExists !== true) {
      warnings.push('missing_local_line')
    }
    if (
      line.sourceType === 'STOCK_TRANSFER_LINE'
      && reconciled.stockQtyToAdd > WMS_RECEIPT_QTY_EPSILON
      && parseCostLayerSnapshot(line.costLayerSnapshot).length === 0
    ) {
      warnings.push('cost_layer_snapshot_missing')
    }

    if (line.parentReceivable === false && reconciled.newlyProcessedQty > WMS_RECEIPT_QTY_EPSILON) {
      warnings.push('parent_not_receivable')
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
      manualReceiptPoolQty: line.manualReceiptPool.qty,
      qtyAccountedViaSnapshot,
      qtyAccountedViaReceipt,
      lastProcessedReceivedQty,
      qtyReceived: reconciled.qtyReceived,
      reconciledManualQty: reconciled.reconciledManualQty,
      coveredBySnapshotQty: reconciled.coveredBySnapshotQty,
      stockQtyToAdd: reconciled.stockQtyToAdd,
      newlyProcessedQty: reconciled.newlyProcessedQty,
      wouldCreateReceipt: reconciled.qtyReceived > WMS_RECEIPT_QTY_EPSILON,
      wouldCreateCostLayer: reconciled.stockQtyToAdd > WMS_RECEIPT_QTY_EPSILON,
      remoteQuantityRefusal,
      remoteArrivedQty: line.remoteArrivedQty ?? null,
      remoteQuantityBasis: line.remoteQuantityBasis ?? null,
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

/**
 * The unconsumed slice of a dispatch snapshot for the next `qtyReceived` units.
 *
 * `alreadyLanded` IS THE OFFSET, and it is deliberately not a number (6oyu.19,
 * Codex round-6 HIGH-1). Four paths call this — manual receipt, dispatch
 * cancellation, WMS webhook book-in and WMS stock-sync alignment — and each used to
 * compute the offset itself from whichever column it happened to have to hand:
 * `stock_transfer_lines.qtyReceived` for the three in app/actions/transfers.ts,
 * `wms_asn_line_maps.qtyAccountedViaSnapshot` for the alignment, and a max of the
 * two for the webhook. Any two of those disagreeing re-lays cost layers that are
 * already down, which is the double-count this branch exists to close.
 *
 * `TransferLineLandedQty` can only be produced by
 * lib/domain/inventory/transfer-landed-quantity.ts, so the offset now has exactly
 * one definition and a call site cannot supply its own.
 */
export function sliceTransferSnapshotForReceipt(input: {
  snapshot: unknown
  alreadyLanded: TransferLineLandedQty
  qtyReceived: number
}): CostLayerSnapshotEntry[] {
  const snapshot = parseCostLayerSnapshot(input.snapshot)
  if (snapshot.length === 0) return []

  const alreadyReceivedQty = Math.max(0, input.alreadyLanded.qtyNumber)
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

/**
 * HOW MANY UNITS OF A DISPATCH SNAPSHOT ARE STILL COSTABLE — the total positive
 * quantity `sliceTransferSnapshotForReceipt` could still return for this line, if
 * asked for an unbounded amount (6oyu.19, Codex round-8 HIGH-1).
 *
 * WHY AN ALLOCATOR NEEDS THIS. A transfer line's outstanding quantity (`line.qty`
 * less everything landed) and its snapshot's remaining costable quantity are
 * different numbers, and the second can be the smaller: a source warehouse that
 * dispatched legacy or otherwise uncosted stock produces a snapshot that under-
 * records the units it shipped. An allocator that caps only by the outstanding
 * quantity will happily plan to book ten units against six costable ones. The stock
 * increment is for ten and the layers are for six.
 *
 * Same offset rule as the slicer, and the same branded `TransferLineLandedQty`, so
 * the cap and the slice provably walk past the same units.
 */
export function remainingCostableSnapshotQty(input: {
  snapshot: unknown
  alreadyLanded: TransferLineLandedQty
}): number {
  const snapshot = parseCostLayerSnapshot(input.snapshot)
  if (snapshot.length === 0) return 0

  const alreadyReceivedQty = Math.max(0, input.alreadyLanded.qtyNumber)
  const { taken: consumedBeforeThisReceipt } = takeFromSnapshotEntries(snapshot, alreadyReceivedQty)
  const remaining = reduceSnapshotByCostLayer(
    snapshot,
    consumedBeforeThisReceipt.map((entry) => ({
      costLayerId: entry.costLayerId,
      qty: entry.qty,
    })),
  )

  return remaining.reduce((sum, entry) => {
    const qty = toDecimal(entry.qty)
    return qty.gt(0) ? addMoney(sum, qty) : sum
  }, toDecimal(0)).toNumber()
}
