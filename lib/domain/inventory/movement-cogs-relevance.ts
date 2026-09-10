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
    note: 'onetwo3d-ims-6oyu.19 — stock moved warehouse, it was not sold. Excluded via getTransferConsumedQtyForCostLayer, which reads stock_transfer_lines.costLayerSnapshot NOT cogs_entries: transfer dispatch writes none, so the cogsEntry-based exclusions were structurally blind to it (that is why this survived every earlier audit). The delta reaches the destination (or, after a cancelled dispatch, the replacement) layer via propagateLandedCostToOutputs, so counting it here too double-posted it. WHICH transfer rows that query may read is STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION below — not a status list spelled out in the SQL. Excluding is only HALF the answer: for the portion of a transfer still in transit no such layer exists yet, so the delta reaches nothing and the recalc posts no journal at all — the freight debit stays in transit. That gap is NOT closed here; the status is classified OUTSTANDING_DESTINATION_LAYER_NOT_ASSURED below (a transfer can be IN_TRANSIT with part of it already landed and fully layered) and the residue is tracked as o3d-nrl4.',
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
 * members and NOT ASSURED for IN_TRANSIT (Codex r2 HIGH-2). The split exists so the
 * registry stops CLAIMING a completion path that IN_TRANSIT may not have. It does
 * not, on its own, create one: see the contract on
 * OUTSTANDING_DESTINATION_LAYER_NOT_ASSURED, which states plainly what is and is not
 * guaranteed today.
 *
 *  - NOT_DISPATCHED: never left the source warehouse, so no layer was consumed and
 *    no snapshot was written. Subtracting one would under-post COGS.
 *  - OUTSTANDING_PROPAGATABLE: the source layer was consumed at dispatch and a
 *    replacement/destination layer EXISTS for the WHOLE dispatched quantity, linked
 *    back by a costLayerSourceLine. Subtract it: propagateLandedCostToOutputs carries
 *    the delta to that layer and journals it there, in the same recalc.
 *  - OUTSTANDING_DESTINATION_LAYER_NOT_ASSURED: consumed at dispatch, and whether a
 *    layer holds the units is NOT determined by the status — see its own contract
 *    below. Excluded from COGS like the others.
 *  - RESTORED_ON_SOURCE_LAYER: a path that un-consumes the ORIGINAL source layer
 *    (raising its remainingQty back) would remove those units from consumedQty
 *    already, so subtracting the snapshot too would under-post COGS. No path does
 *    this today — the value exists so that adding one is a decision recorded here
 *    rather than a silent double-subtraction.
 *
 * THE CONTRACT OF `OUTSTANDING_DESTINATION_LAYER_NOT_ASSURED`, EXACTLY (o3d-nrl4).
 *
 * It guarantees ONE thing: these units are kept OUT of retrospective customer COGS,
 * because they were moved between warehouses and not sold. Posting COGS for them is
 * 6oyu.19, and that is what this classification prevents.
 *
 * It guarantees NOTHING about where the revaluation delta goes, and — the point of
 * the r4 rename — it does not know. STATUS CANNOT ANSWER "DOES A DESTINATION LAYER
 * EXIST", because two different routes reach IN_TRANSIT with different answers:
 *
 *   - Nothing has landed. No layer holds the units; propagation reaches nothing.
 *   - Part of the line HAS landed and is fully layered and linked. A manual receipt
 *     of less than the line quantity, a WMS webhook book-in (booked-in-service flips
 *     the transfer to RECEIVED only once EVERY line is fully received), and a WMS
 *     stock-sync alignment (which never writes stockTransfer.status at all) each
 *     create destination layers, linked back by a costLayerSourceLine, and leave the
 *     transfer IN_TRANSIT.
 *
 * So for a partly-landed transfer the delta DOES reach the landed units by ordinary
 * propagation, and reaches nothing for the rest. The gap is real but it is a
 * LINE-LEVEL quantity (qty less qtyReceived), not a property of the status, and
 * nothing here should be read as saying otherwise. An earlier revision exported a
 * status-level `TRANSFER_STATUSES_WITH_NO_COMPLETION_PATH` asserting the opposite;
 * it was removed rather than corrected, because the question it answered cannot be
 * answered at this grain.
 *
 * For the portion still in transit: the source layer's remainingQty is zero so
 * inventoryDelta is zero, and IMS persists no obligation to post the delta later, so
 * the recalc queues no journal for those units — the freight debit stays in the
 * transit clearing account and inventory stays understated until, and unless,
 * something else moves it. Nothing does. This is the behaviour of
 * `origin/development` today and this classification does not change it; it only
 * stops the registry from asserting otherwise.
 *
 * It is also NOT self-reporting. The earlier note here claimed the stranded balance
 * was visible because 6oyu.4's STOCK_IN_TRANSIT sweep would flag it. It is not: that
 * sweep compares recorded transit movements against GL movements, and a MISSING
 * posting writes neither a transit_subledger_movements row nor a GL line. It is
 * absent from BOTH sides, so the window ties out exactly. A reconciliation between
 * two ledgers can only find a posting that landed in one of them.
 *
 * Closing it needs an obligation persisted at revaluation time and discharged by the
 * receipt or dispatch cancellation that finally creates the layer. That work was
 * written, reviewed and WITHDRAWN from this branch — four HIGH findings, including
 * obligations keyed per transfer rather than per revaluation, settlement that erases
 * itself when the accounting connector is disabled, and an unlocked read of the
 * transfer row that a concurrent receipt can race. It is tracked as o3d-nrl4, and
 * the withdrawn implementation is preserved on branch
 * `o3d-6oyu19-deferred-transit-reclass-withdrawn` (commit 89a124f5). Do not
 * re-derive it; start from there.
 */
export type TransferSourceLayerConsumption =
  | 'NOT_DISPATCHED'
  | 'OUTSTANDING_PROPAGATABLE'
  | 'OUTSTANDING_DESTINATION_LAYER_NOT_ASSURED'
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
    consumption: 'OUTSTANDING_DESTINATION_LAYER_NOT_ASSURED',
    note: 'Dispatched: consumeFifoLayersStrict reduced the source layer and froze the snapshot on the line. Whether a destination layer holds these units is NOT decided by this status and MUST NOT be inferred from it — a partial manual receipt, a WMS webhook book-in short of the full line, and a WMS stock-sync alignment all create linked destination layers and leave the transfer IN_TRANSIT, while a transfer that has landed nothing has none. The exclusion from COGS is right either way (the units moved warehouse, they were not sold). For whatever portion HAS landed the delta reaches it by ordinary propagation; for the portion still in transit a landed-cost revaluation has nowhere to send its delta and queues no journal, leaving it in the transit clearing account indefinitely. That residue is a line-level quantity (qty less qtyReceived), not a property of this status — open, o3d-nrl4.',
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
 *
 * Note that OUTSTANDING_DESTINATION_LAYER_NOT_ASSURED answers `true` here for the
 * narrow reason stated in its contract — the units were not sold — and NOT because
 * anything downstream is known to complete the posting.
 */
const CONSUMPTION_IS_OUTSTANDING: Record<TransferSourceLayerConsumption, boolean> = {
  NOT_DISPATCHED: false,
  OUTSTANDING_PROPAGATABLE: true,
  OUTSTANDING_DESTINATION_LAYER_NOT_ASSURED: true,
  RESTORED_ON_SOURCE_LAYER: false,
}

/**
 * THERE IS DELIBERATELY NO STATUS-LEVEL "HAS NO COMPLETION PATH" MAP HERE (Codex
 * round-4 MEDIUM).
 *
 * An earlier revision exported `CONSUMPTION_HAS_NO_COMPLETION_PATH` and
 * `TRANSFER_STATUSES_WITH_NO_COMPLETION_PATH`, both answering `true` for IN_TRANSIT
 * on the premise that a transfer in transit has no destination layer. It does not
 * hold: a partial manual receipt, a WMS webhook book-in short of the full line, and
 * a WMS stock-sync alignment each create linked destination layers WITHOUT changing
 * the status, so units under an IN_TRANSIT transfer may be fully layered and
 * propagatable. The SQL was unaffected only by luck — both outstanding categories
 * map to `true` in CONSUMPTION_IS_OUTSTANDING — so the lists were a trap set for the
 * next reader rather than a live defect.
 *
 * They were removed rather than corrected because the question cannot be answered at
 * this grain at all. What is left uncovered is the portion of a line that has not
 * landed (qty less qtyReceived), which is where o3d-nrl4 has to measure it. Do not
 * reintroduce a status keyed version.
 */

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
