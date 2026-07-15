import { StockMovementType } from '@/app/generated/prisma/client'

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
 *  - INCLUDE_IN_COGS: counted in netConsumedQty; delta posts to COGS.
 *  - EXCLUDE: subtracted from netConsumedQty by a dedicated exclusion query.
 *  - NOT_APPLICABLE: never consumes layers, so revaluation never sees it.
 *  - KNOWN_GAP: SHOULD be excluded (or redirected) but currently is not. Each
 *    KNOWN_GAP MUST name the bd issue tracking the fix — the test enforces it.
 */
export type RevaluationTreatment = 'INCLUDE_IN_COGS' | 'EXCLUDE' | 'NOT_APPLICABLE' | 'KNOWN_GAP'

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
    treatment: 'KNOWN_GAP',
    writesCogsEntries: true,
    note: 'onetwo3d-ims-6oyu.20 — generic reason-coded adjustments post DR reason.accountCode / CR inventory, never COGS, but their units still land in netConsumedQty so the revaluation delta is misclassified into COGS. Magnitude is right, account is wrong; awaiting a finance decision (exclude and route to the reason account, vs document as intentional per the scjz.10 precedent). NOTE: supplier returns are ALSO type=ADJUSTMENT (referenceType=PurchaseReturn) and are deliberately INCLUDED per scjz.10 — any fix must key on referenceType, not type alone.',
  },
  TRANSFER_OUT: {
    relevance: 'NOT_CUSTOMER_COGS',
    treatment: 'EXCLUDE',
    writesCogsEntries: false,
    exclusionSource: 'TRANSFER_SNAPSHOT',
    note: 'onetwo3d-ims-6oyu.19 — stock moved warehouse, it was not sold. Excluded via getTransferConsumedQtyForCostLayer, which reads stock_transfer_lines.costLayerSnapshot NOT cogs_entries: transfer dispatch writes none, so the cogsEntry-based exclusions were structurally blind to it (that is why this survived every earlier audit). The delta reaches the destination layer via propagateLandedCostToOutputs, so counting it here too double-posted it.',
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
