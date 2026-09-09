import { StockMovementType, StockTransferStatus } from '@/app/generated/prisma/client'

/**
 * Central classification of every StockMovementType against customer COGS.
 *
 * WHY THIS EXISTS (6oyu.7 / accounting audit C12): retrospective landed-cost
 * revaluation derives `consumedQty` from the cost LAYER (receivedQty -
 * remainingQty in calculateLayerAdjustmentDeltas) and then subtracts a
 * hand-maintained list of "not customer COGS" quantities. Every entry in that
 * list was added reactively, one incident at a time (audit-jz9i PRODUCTION_OUT,
 * scjz.14 PURCHASE_REVERSAL, scjz.10 supplier-returns-INCLUDED). Any movement
 * type that consumes layers but was never traced silently posts spurious COGS on
 * the next revaluation — a latent corruption that grows with each new type.
 *
 * This registry makes the classification total and compile-time enforced: adding
 * a value to the StockMovementType enum without classifying it here is a type
 * error, and movement-cogs-relevance.test.ts fails if an entry is missing or
 * self-inconsistent. It is the single source of truth the revaluation exclusion
 * queries derive from, so the queries can no longer drift from the intent.
 */

/**
 * How a movement type's consumption of a cost layer relates to customer COGS.
 *  - CUSTOMER_COGS: the consumption IS a sale. A later revaluation delta on
 *    those units belongs in the COGS account.
 *  - NOT_CUSTOMER_COGS: consumes layers, but the units were not sold. A
 *    revaluation delta on them does NOT belong in COGS.
 *  - NEVER_CONSUMES: inbound (or dead) — cannot reduce remainingQty, so it can
 *    never appear in consumedQty.
 */
export type CogsRelevance = 'CUSTOMER_COGS' | 'NOT_CUSTOMER_COGS' | 'NEVER_CONSUMES'

/**
 * What retrospective landed-cost revaluation does with these units TODAY.
 *  - INCLUDE_IN_COGS: counted in netConsumedQty; delta posts to COGS. Only ever
 *    valid for units that genuinely ARE a sale.
 *  - EXCLUDE: subtracted from netConsumedQty by a dedicated exclusion query.
 *  - NOT_APPLICABLE: never consumes layers, so revaluation never sees it.
 *  - ACCEPTED_TRADEOFF: NOT customer COGS, but counted in COGS anyway by an
 *    explicit decision — the delta has nowhere better to go and excluding it
 *    would strand value. Deliberately distinct from INCLUDE_IN_COGS so the
 *    divergence is visible rather than looking like a misclassification, and
 *    distinct from KNOWN_GAP so it is not mistaken for unfinished work.
 *  - KNOWN_GAP: SHOULD be excluded (or redirected) but currently is not.
 *
 * ACCEPTED_TRADEOFF and KNOWN_GAP MUST both name their bd issue — enforced.
 */
export type RevaluationTreatment =
  | 'INCLUDE_IN_COGS'
  | 'EXCLUDE'
  | 'NOT_APPLICABLE'
  | 'ACCEPTED_TRADEOFF'
  | 'KNOWN_GAP'

/**
 * Where an EXCLUDE'd quantity is actually read from. Explicit because assuming
 * "exclusions come from cogs_entries" is exactly what hid 6oyu.19 for so long:
 * TRANSFER_OUT consumes layers and writes none, so a cogsEntry query could never
 * see it. A cogsEntry-less type is excludable ONLY via a non-cogsEntry source.
 */
export type ExclusionSource = 'COGS_ENTRY' | 'TRANSFER_SNAPSHOT'

export type MovementCogsClassification = {
  relevance: CogsRelevance
  treatment: RevaluationTreatment
  /**
   * Whether this movement type writes cogs_entries when it consumes layers.
   * Load-bearing: it determines which exclusionSource is even possible.
   */
  writesCogsEntries: boolean
  /** Required for EXCLUDE, and meaningless for anything else. */
  exclusionSource?: ExclusionSource
  /** Decision reference, or the bd issue for a KNOWN_GAP. */
  note: string
}

/**
 * Total classification. `Record<StockMovementType, ...>` is deliberate: a new
 * enum value fails to compile until it is classified here.
 */
export const MOVEMENT_COGS_RELEVANCE: Record<StockMovementType, MovementCogsClassification> = {
  SALE_DISPATCH: {
    relevance: 'CUSTOMER_COGS',
    treatment: 'INCLUDE_IN_COGS',
    writesCogsEntries: true,
    note: 'The sale itself. audit-3aph: the shipment path owns its own revaluation, so landed-cost-service subtracts shipmentRefresh.cogsRevaluationDelta rather than double-posting.',
  },
  PRODUCTION_OUT: {
    relevance: 'NOT_CUSTOMER_COGS',
    treatment: 'EXCLUDE',
    writesCogsEntries: true,
    exclusionSource: 'COGS_ENTRY',
    note: 'audit-jz9i: component cost is capitalised INTO the produced output layer; the delta reaches it via propagateLandedCostToOutputs (audit-e7h8), not COGS.',
  },
  PURCHASE_REVERSAL: {
    relevance: 'NOT_CUSTOMER_COGS',
    treatment: 'EXCLUDE',
    writesCogsEntries: true,
    exclusionSource: 'COGS_ENTRY',
    note: 'scjz.14: PO-cancellation reversals were reversed out, not sold. They write cogs_entries only to satisfy the outbound-evidence guard.',
  },
  ADJUSTMENT: {
    relevance: 'NOT_CUSTOMER_COGS',
    treatment: 'ACCEPTED_TRADEOFF',
    writesCogsEntries: true,
    note: 'ACCEPTED TRADE-OFF (onetwo3d-ims-6oyu.20, decided 2026-07-15) — the ONLY entry where relevance and treatment disagree, deliberately. A reason-coded adjustment posts DR reason.accountCode / CR inventory, so its late landed-cost delta lands in COGS rather than the reason account: magnitude right, account imprecise. Accepted for two reasons. (1) Not implementable: StockMovement persists no reasonId/accountCode — applyStockAdjustment resolves the reason only to build the journal and stores note="<reason.name>[: <note>]" as free text — so the reason account is unrecoverable at revaluation time, and historical rows never stored it at all. (2) Excluding without routing would be WORSE: the delta would drain nothing from transit, stranding a permanent balance and understating expense, trading a reclass for a completeness error. Including keeps transit draining fully and the P&L total correct, consistent with the scjz.10 decision to let supplier returns ride the same COGS-adjustment journal. Revisit only if reason attribution is persisted on the movement. NOTE: supplier returns are ALSO type=ADJUSTMENT (referenceType=PurchaseReturn) and are likewise INCLUDED per scjz.10.',
  },
  TRANSFER_OUT: {
    relevance: 'NOT_CUSTOMER_COGS',
    treatment: 'EXCLUDE',
    writesCogsEntries: false,
    exclusionSource: 'TRANSFER_SNAPSHOT',
    note: 'onetwo3d-ims-6oyu.19 — stock moved warehouse, it was not sold. Excluded via getTransferConsumedQtyForCostLayer, which reads stock_transfer_lines.costLayerSnapshot NOT cogs_entries: transfer dispatch writes none, so the cogsEntry-based exclusions were structurally blind to it (that is why this survived every earlier audit). The delta reaches the destination (or, after a cancelled dispatch, the replacement) layer via propagateLandedCostToOutputs, so counting it here too double-posted it. WHICH transfer rows that query may read is STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION below — not a status list spelled out in the SQL. Excluding is only HALF the answer: for a transfer still IN_TRANSIT no such layer exists yet, so the exclusion must be paired with a persisted pending reclass that the eventual receipt/cancellation settles (see OUTSTANDING_AWAITING_DESTINATION_LAYER).',
  },
  KIT_ASSEMBLY_OUT: {
    relevance: 'NEVER_CONSUMES',
    treatment: 'NOT_APPLICABLE',
    writesCogsEntries: false,
    note: 'DEAD: enum value with no producer anywhere in the codebase — kit stock is derived from components rather than moved, so nothing consumes layers under this type today. If it ever gains a producer it becomes an outbound that DOES consume layers: reclassify it NOT_CUSTOMER_COGS and give it an exclusion path before shipping, or revaluation will post spurious COGS for assembled units.',
  },
  KIT_ASSEMBLY_IN: {
    relevance: 'NEVER_CONSUMES',
    treatment: 'NOT_APPLICABLE',
    writesCogsEntries: false,
    note: 'Inbound. Enum value with no producer anywhere in the codebase.',
  },
  PURCHASE_RECEIPT: {
    relevance: 'NEVER_CONSUMES',
    treatment: 'NOT_APPLICABLE',
    writesCogsEntries: false,
    note: 'Inbound — creates the layer that revaluation later adjusts.',
  },
  WMS_RECEIPT_RECONCILIATION: {
    relevance: 'NEVER_CONSUMES',
    treatment: 'NOT_APPLICABLE',
    writesCogsEntries: false,
    note: 'Inbound — always written against toWarehouseId (booked-in-service; WMS stock-sync alignment credits).',
  },
  RETURN_INBOUND: {
    relevance: 'NEVER_CONSUMES',
    treatment: 'NOT_APPLICABLE',
    writesCogsEntries: false,
    note: 'Inbound. Customer returns are handled on the revaluation side by updateSnapshotsForCostLayerChange rewriting the refund-line snapshots (the returnedQty input), not by a movement-type exclusion.',
  },
  TRANSFER_IN: {
    relevance: 'NEVER_CONSUMES',
    treatment: 'NOT_APPLICABLE',
    writesCogsEntries: false,
    note: 'Inbound — creates the destination layer, linked back to the source via costLayerSourceLine.',
  },
  PRODUCTION_IN: {
    relevance: 'NEVER_CONSUMES',
    treatment: 'NOT_APPLICABLE',
    writesCogsEntries: false,
    note: 'Inbound — the produced output layer.',
  },
  OPENING_STOCK: {
    relevance: 'NEVER_CONSUMES',
    treatment: 'NOT_APPLICABLE',
    writesCogsEntries: false,
    note: 'Inbound — opening balance layer.',
  },
}

function movementTypesWhere(predicate: (entry: MovementCogsClassification) => boolean): StockMovementType[] {
  return (Object.keys(MOVEMENT_COGS_RELEVANCE) as StockMovementType[])
    .filter((type) => predicate(MOVEMENT_COGS_RELEVANCE[type]))
    .sort()
}

/**
 * Movement types whose consumed quantity must be subtracted from netConsumedQty
 * by the retrospective landed-cost revaluation. Derived from the registry so the
 * exclusion queries in lib/cost-layers.ts cannot drift from the classification.
 *
 * Only EXCLUDE entries appear — a KNOWN_GAP is deliberately NOT silently
 * excluded here, because closing those gaps changes GL postings and needs the
 * same Xero-sandbox validation as any other posting change (6oyu.20).
 */
export const REVALUATION_EXCLUDED_MOVEMENT_TYPES: StockMovementType[] =
  movementTypesWhere((entry) => entry.treatment === 'EXCLUDE')

/**
 * Movement types that reduce a cost layer's remainingQty but write no
 * cogs_entries. They are invisible to every cogsEntry-based audit query, which is
 * precisely how 6oyu.19 went unnoticed. Exported so tests and future audits can
 * assert on the blind spot rather than rediscover it: any member here MUST be
 * excluded from a non-cogsEntry source, never left to a cogsEntry query.
 */
export const LAYER_CONSUMING_MOVEMENT_TYPES_WITHOUT_COGS_ENTRIES: StockMovementType[] =
  movementTypesWhere((entry) => entry.relevance !== 'NEVER_CONSUMES' && !entry.writesCogsEntries)

/** Movement types excluded by reading cogs_entries. */
export const COGS_ENTRY_EXCLUDED_MOVEMENT_TYPES: StockMovementType[] =
  movementTypesWhere((entry) => entry.exclusionSource === 'COGS_ENTRY')

/** Movement types excluded by reading stock_transfer_lines.costLayerSnapshot. */
export const TRANSFER_SNAPSHOT_EXCLUDED_MOVEMENT_TYPES: StockMovementType[] =
  movementTypesWhere((entry) => entry.exclusionSource === 'TRANSFER_SNAPSHOT')

/** Movement types currently known to be mistreated by revaluation. */
export const REVALUATION_KNOWN_GAP_MOVEMENT_TYPES: StockMovementType[] =
  movementTypesWhere((entry) => entry.treatment === 'KNOWN_GAP')

/**
 * Movement types knowingly counted in COGS despite not being customer COGS.
 * Not bugs — decisions. Kept separate from KNOWN_GAP so nobody "fixes" one by
 * mistake, and from INCLUDE_IN_COGS so the divergence stays legible.
 */
export const REVALUATION_ACCEPTED_TRADEOFF_MOVEMENT_TYPES: StockMovementType[] =
  movementTypesWhere((entry) => entry.treatment === 'ACCEPTED_TRADEOFF')

// ---------------------------------------------------------------------------
// TRANSFER_SNAPSHOT exclusion — which transfer rows the snapshot query may read
// ---------------------------------------------------------------------------

/**
 * What a stock transfer in a given status has done to its SOURCE cost layers.
 *
 * TRANSFER_OUT is excluded from retrospective COGS by reading
 * stock_transfer_lines.costLayerSnapshot (see getTransferConsumedQtyForCostLayer).
 * That query is only correct if it reads exactly the transfers whose dispatch-time
 * consumption of the source layer is STILL OUTSTANDING — the source layer's
 * remainingQty is still reduced and the units were not sold.
 *
 * "Outstanding" is deliberately split in two, because the ONE contract the earlier
 * single OUTSTANDING value stated — "safe to exclude, because the delta reaches the
 * units through a replacement/destination layer" — is true for two of its three
 * members and FALSE for IN_TRANSIT (Codex r2 HIGH-2). A revaluation that lands mid
 * transit subtracted the whole snapshot from COGS, found no dependent output to
 * propagate into, and queued no journal at all: the freight debit stayed in transit
 * and inventory was understated indefinitely. The transit-vs-GL reconciliation
 * sweep (6oyu.4) cannot surface that, because a MISSING posting writes neither a
 * transit_subledger_movements row nor a GL line — it is absent from both sides of
 * the comparison, so the window ties out exactly.
 *
 *  - NOT_DISPATCHED: never left the source warehouse, so no layer was consumed and
 *    no snapshot was written. Subtracting one would under-post COGS.
 *  - OUTSTANDING_PROPAGATABLE: the source layer was consumed at dispatch and a
 *    replacement/destination layer EXISTS, linked back by a costLayerSourceLine.
 *    Subtract it: propagateLandedCostToOutputs carries the delta to that layer and
 *    journals it there, in the same recalc.
 *  - OUTSTANDING_AWAITING_DESTINATION_LAYER: consumed at dispatch, but NO layer
 *    holds the units yet. Still subtract it — the units were not sold, so posting
 *    COGS would be wrong (that is 6oyu.19) — but the delta then has nowhere to go
 *    in THIS recalc, so it must be PERSISTED as a pending reclass
 *    (recordPendingTransferLandedCostReclass) and settled by the receipt or
 *    dispatch-cancellation that finally creates the layer
 *    (recreateTransferCostLayersFromSnapshotSlice). Excluding without deferring is
 *    the stranded-transit bug; deferring without excluding is the 6oyu.19 bug.
 *  - RESTORED_ON_SOURCE_LAYER: a path that un-consumes the ORIGINAL source layer
 *    (raising its remainingQty back) would remove those units from consumedQty
 *    already, so subtracting the snapshot too would under-post COGS. No path does
 *    this today — the value exists so that adding one is a decision recorded here
 *    rather than a silent double-subtraction.
 */
export type TransferSourceLayerConsumption =
  | 'NOT_DISPATCHED'
  | 'OUTSTANDING_PROPAGATABLE'
  | 'OUTSTANDING_AWAITING_DESTINATION_LAYER'
  | 'RESTORED_ON_SOURCE_LAYER'

export type TransferStatusCostConsumption = {
  consumption: TransferSourceLayerConsumption
  note: string
}

/**
 * Total classification. `Record<StockTransferStatus, ...>` is deliberate: adding a
 * value to the Prisma StockTransferStatus enum without classifying it here is a
 * type error, so a new transfer state cannot silently fall out of (or into) the
 * revaluation exclusion.
 *
 * Do NOT derive this from STOCK_TRANSFER_TRANSITIONS. That map models the plain
 * cancel path only and states IN_TRANSIT -> RECEIVED as the sole transition out of
 * IN_TRANSIT, yet cancelDispatchedTransfer (app/actions/transfers.ts) deliberately
 * performs IN_TRANSIT -> CANCELLED outside the machine. Trusting the map is exactly
 * how the CANCELLED case was missed.
 */
export const STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION: Record<StockTransferStatus, TransferStatusCostConsumption> = {
  DRAFT: {
    consumption: 'NOT_DISPATCHED',
    note: 'Dispatch is what consumes source layers and writes the costLayerSnapshot; a draft has done neither.',
  },
  IN_TRANSIT: {
    consumption: 'OUTSTANDING_AWAITING_DESTINATION_LAYER',
    note: 'Dispatched: consumeFifoLayersStrict reduced the source layer and froze the snapshot on the line. NO layer holds these units — the destination layer is not created until receipt, and the replacement layer not until a dispatch cancellation — so propagateLandedCostToOutputs has nothing to find and this recalc can journal nothing. The delta is instead persisted as a pending reclass and settled atomically by whichever of those two paths creates the layer.',
  },
  RECEIVED: {
    consumption: 'OUTSTANDING_PROPAGATABLE',
    note: 'The source layer stays consumed; receiveTransfer creates the destination layer and links it back with a costLayerSourceLine, so propagateLandedCostToOutputs carries the delta there.',
  },
  CANCELLED: {
    consumption: 'OUTSTANDING_PROPAGATABLE',
    note: 'Covers cancelDispatchedTransfer (IN_TRANSIT -> CANCELLED, audit-C5), which explicitly does NOT un-consume the original layers — it creates equivalent REPLACEMENT layers at the source and links each back to the original with a costLayerSourceLine (app/actions/transfers.ts). So the consumption is still outstanding and the delta still reaches the units through propagation, exactly as for RECEIVED. A DRAFT -> CANCELLED transfer was never dispatched and therefore carries no snapshot, so it contributes nothing to the containment query.',
  },
}

/**
 * Is this consumption state still OUTSTANDING against the source layer — i.e. must
 * its dispatch-time snapshot be subtracted from netConsumedQty?
 *
 * A total `Record` rather than an `includes()` on a literal array, so a new
 * TransferSourceLayerConsumption value cannot compile until someone decides whether
 * it is excluded from COGS. The same reason the registry above is a Record.
 */
const CONSUMPTION_IS_OUTSTANDING: Record<TransferSourceLayerConsumption, boolean> = {
  NOT_DISPATCHED: false,
  OUTSTANDING_PROPAGATABLE: true,
  OUTSTANDING_AWAITING_DESTINATION_LAYER: true,
  RESTORED_ON_SOURCE_LAYER: false,
}

/**
 * Does this consumption state require the revaluation delta to be DEFERRED, because
 * no layer exists for propagateLandedCostToOutputs to carry it to?
 *
 * Total for the same reason: a new state that is outstanding but has no destination
 * layer must not default to the permissive answer (`false` = "somebody downstream
 * handles it"), which is precisely how the delta got stranded in transit.
 */
const CONSUMPTION_DEFERS_RECLASS: Record<TransferSourceLayerConsumption, boolean> = {
  NOT_DISPATCHED: false,
  OUTSTANDING_PROPAGATABLE: false,
  OUTSTANDING_AWAITING_DESTINATION_LAYER: true,
  RESTORED_ON_SOURCE_LAYER: false,
}

function transferStatusesWhere(
  predicate: (consumption: TransferSourceLayerConsumption) => boolean,
): StockTransferStatus[] {
  return (Object.keys(STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION) as StockTransferStatus[])
    .filter((status) => predicate(STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION[status].consumption))
    .sort()
}

/**
 * Transfer statuses whose dispatch-time costLayerSnapshot must be subtracted from
 * netConsumedQty. The single definition behind getTransferConsumedQtyForCostLayer's
 * SQL predicate — never re-spell this list at a call site.
 */
export const TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION: StockTransferStatus[] =
  transferStatusesWhere((consumption) => CONSUMPTION_IS_OUTSTANDING[consumption])

/**
 * Transfer statuses whose excluded consumption has NO layer to propagate into, so a
 * revaluation landing now must persist a pending reclass instead of journaling.
 * The single definition behind getInTransitTransferConsumptionForCostLayer's SQL
 * predicate — and a strict subset of the list above, asserted in the tests.
 */
export const TRANSFER_STATUSES_AWAITING_DESTINATION_LAYER: StockTransferStatus[] =
  transferStatusesWhere((consumption) => CONSUMPTION_DEFERS_RECLASS[consumption])
