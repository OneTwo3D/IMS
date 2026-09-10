/**
 * THE one way to recreate FIFO cost layers from a stock-transfer dispatch snapshot.
 *
 * WHY THIS EXISTS (6oyu.19, Codex round-2 HIGH-1). Four paths land transferred units
 * back into a warehouse and rebuild layers from the frozen dispatch snapshot:
 *
 *   1. manual receipt              app/actions/transfers.ts  (applyTransferLineReceipt)
 *   2. dispatch cancellation       app/actions/transfers.ts  (cancelDispatchedTransfer)
 *   3. WMS webhook receipt         lib/domain/wms/booked-in-service.ts
 *   4. WMS stock-sync alignment    the active WMS connector's sync/stock-sync.ts
 *
 * All four wrote the same three lines by hand, and two of them wrote only two of
 * the three. The registry entry that lets retrospective landed-cost revaluation
 * subtract transferred units from COGS (MOVEMENT_COGS_RELEVANCE.TRANSFER_OUT /
 * STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION) is sound ONLY if the units end up in a
 * layer that propagateLandedCostToOutputs can reach. Paths 3 and 4 called
 * copyCostLayerSourceLinesProportionally and IGNORED its result: that helper returns
 * 0 for an ordinary PO-derived source layer, which has no sourceLines of its own, so
 * those destination layers had NO costLayerSourceLine at all. The snapshot query
 * removed the units from COGS while getDependentOutputSourceLines could not find
 * anywhere to put the delta — the freight debit stayed stranded in transit.
 *
 * So the link is a POSTCONDITION of this function, asserted before it returns, not
 * something four call sites have to remember. `assertLayerIsReachableByPropagation`
 * fails loudly rather than leaving a silently unreachable layer behind, and the
 * source census in tests/domain/inventory/transfer-cost-layer-recreation.test.ts
 * fails if a fifth path ever open-codes the sequence again.
 *
 * THE SECOND POSTCONDITION IS QUANTITY (Codex round-4 HIGH, o3d-eiuo). All four
 * callers increment stock and then call this, in one transaction, so anything this
 * function declines to lay down is not a reportable gap — it is stock on hand with
 * no FIFO layer behind it. The layers created cover the slice's whole positive
 * quantity or the function throws, taking the caller's stock increment down with it.
 * A skip can only ever be a visible failure, not a trade.
 *
 * A NEGATIVE-COST SNAPSHOT ENTRY IS REFUSED, NOT LAYERED (Codex round-5 HIGH,
 * o3d-gd2f). This is the third decision on the same input, and the first that the
 * rest of the system can actually represent.
 *
 *  - The input IS reachable, so refusing is not a claim that it cannot happen.
 *    `recalculateLandedCosts` distributes freight cost lines with no positivity
 *    filter — its own comment names "a zero/credit cost line" — so
 *    `grossUnitCostBase = unitCostBase + landedPerUnit` can go negative with nothing
 *    flooring it, and it is written straight onto the layer.
 *    `updateSnapshotsForCostLayerChange` then patches
 *    `stock_transfer_lines.costLayerSnapshot` IN PLACE, so a credit note landing
 *    while units are in transit rewrites a positive dispatch snapshot negative and
 *    the receipt reads it.
 *  - But NOTHING DOWNSTREAM CAN CARRY THE SIGN. Round 4 created the layer at the
 *    negative cost to conserve basis as well as quantity. That conserves the layer
 *    and corrupts the ledger, more quietly than the skip did:
 *      · `buildStockMovementValueFieldsFromTotal`
 *        (lib/domain/inventory/stock-movement-value.ts:75) applies `.abs()` to the
 *        requested total, and all four callers hand it the matching negative
 *        snapshot total. A −£4 layer therefore books a +£4 TRANSFER_IN movement,
 *        which looks entirely ordinary.
 *      · A later FIFO consumption of that layer goes through the same builder via
 *        `buildStockMovementValueFieldsFromConsumed`, so the movement value is
 *        positive while the shipment's own COGS stays negative.
 *      · Both connector journal paths emit the COGS pair only when the batch total
 *        is greater than zero (lib/connectors/xero/daily-sync.ts:1970,
 *        lib/connectors/quickbooks/daily-sync.ts:1197), so a credit-derived COGS is
 *        mis-stated or dropped entirely rather than posted.
 *    Supporting a negative basis means making the movement, FIFO, COGS and both
 *    connector-journal paths agree on sign. That is a large change to money code and
 *    is not this branch's subject; it is filed as o3d-gd2f with these findings.
 *  - So the helper REFUSES. It commits nothing, so it cannot leave unlayered stock
 *    (the round-4 defect), cannot book a wrong movement and cannot suppress a
 *    journal line. It fails where an operator can see it, and the action is real:
 *    the credit note that drove the basis negative is the thing to correct.
 *  - The refusal ABORTS THE ENCLOSING TRANSACTION before it throws, so a caller
 *    cannot catch it and go on to commit the stock increment. See
 *    `abortEnclosingTransactionSoTheRefusalCannotBeSwallowed`.
 *  - The case has never occurred in development. Read-only census, 2026-09-10:
 *    cost_layers."unitCostBase" < 0 → 0, freight_cost_lines."amountBase" < 0 → 0,
 *    stock_transfer_lines with any snapshot entry below zero → 0. Production is
 *    UNMEASURED, which is the whole of o3d-e65p; that census is what says whether
 *    this refusal will ever fire on a real receipt.
 *
 * WHAT THIS FUNCTION DOES NOT DO (6oyu.19 split, o3d-nrl4). It does not settle a
 * landed-cost revaluation that happened while these units were IN TRANSIT. That
 * revaluation has no layer to journal against, and IMS currently posts nothing for
 * it — the delta stays in the transit clearing account. An earlier revision of this
 * branch persisted a `PendingTransferLandedCostReclass` and discharged it here; that
 * settlement machinery was withdrawn on Codex round-2 review (four HIGH findings,
 * including per-transfer rather than per-revaluation obligations and settlement on a
 * disabled connector) and is tracked as o3d-nrl4 on branch
 * `o3d-6oyu19-deferred-transit-reclass-withdrawn` (commit 89a124f5). This function
 * is the natural settlement point when that work returns; it deliberately does not
 * pretend to be one today.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { createCostLayer, copyCostLayerSourceLinesProportionally } from '@/lib/cost-layers'
import { isClientInsideTransaction, openSavepointDepth } from '@/lib/db/savepoint'
import type { CostLayerSnapshotEntry } from '@/lib/cost-layer-snapshots'
import { addMoney, multiplyMoney, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

type TxClient = Prisma.TransactionClient

export type TransferLayerRecreationTarget = {
  productId: string
  /** Destination for a receipt; the SOURCE warehouse for a dispatch cancellation. */
  warehouseId: string
  /**
   * The transfer line whose dispatch snapshot this slice was drawn from. Diagnostic
   * context: it is what names the offending line if the reachability postcondition
   * ever fires, and an unreachable layer is otherwise almost impossible to trace
   * back to the receipt that created it.
   */
  transferLineId: string
  /** Stamped on created layers by the WMS alignment path; null everywhere else. */
  adjustmentMovementId?: string | null
  /** Human context for diagnostics ("transfer TR-1 receipt"). */
  contextLabel: string
}

export type TransferLayerRecreationResult = {
  createdLayers: Array<{
    costLayerId: string
    sourceCostLayerId: string
    qty: string
    unitCostBase: string
    /** True when the direct fallback link had to be written (source had no sourceLines). */
    linkedDirectly: boolean
  }>
  /**
   * QUANTITY ACTUALLY PLACED INTO LAYERS, to 6dp. Equal to the slice's own positive
   * quantity by the postcondition asserted below — the point being that a caller
   * that has already committed a stock increment can measure its layers against THIS
   * rather than against the slice it passed in.
   *
   * The manual receipt path's £0 balancing layer (cogs-audit scjz.5) is computed from
   * this figure. It used to re-sum `snapshotSlice`, which counted any entry this
   * helper declined as covered — the balancing step could not see the gap it existed
   * to close.
   */
  recreatedQty: string
}

export type TransferCostLayerRecreationDeps = {
  createCostLayer: typeof createCostLayer
  copyCostLayerSourceLinesProportionally: typeof copyCostLayerSourceLinesProportionally
}

const defaultDeps: TransferCostLayerRecreationDeps = {
  createCostLayer,
  copyCostLayerSourceLinesProportionally,
}

/**
 * Thrown when a dispatch-snapshot entry carries a NEGATIVE unit cost (Codex round-5
 * HIGH; o3d-gd2f). Exported so a caller CAN recognise it — for a message, a retry
 * decision, an alert — but recognising it is all a caller may do with it: by the time
 * this reaches anyone the enclosing transaction has already been aborted, so there is
 * no half-state left to choose between.
 */
export class NegativeCostSnapshotEntryError extends Error {
  override readonly name = 'NegativeCostSnapshotEntryError'
  readonly transferLineId: string
  readonly contextLabel: string
  /** The offending entries, in slice order, so the message and the metadata agree. */
  readonly entries: Array<{ index: number; sourceCostLayerId: string; qty: string; unitCostBase: string }>

  constructor(params: {
    message: string
    transferLineId: string
    contextLabel: string
    entries: Array<{ index: number; sourceCostLayerId: string; qty: string; unitCostBase: string }>
  }) {
    super(params.message)
    this.transferLineId = params.transferLineId
    this.contextLabel = params.contextLabel
    this.entries = params.entries
  }
}

/**
 * The text the abort statement fails on. A CONSTANT, never anything caller-supplied:
 * it is interpolated as a bound parameter below, but a numeric value would CAST
 * successfully and the statement would quietly not abort anything.
 */
const TRANSACTION_ABORT_SENTINEL = 'transfer_cost_layer_recreation_refused'

/**
 * ABORT THE ENCLOSING TRANSACTION, so that refusing cannot be turned into skipping.
 *
 * WHY A THROW IS NOT ENOUGH. Every caller increments stock BEFORE calling this
 * function, in the same interactive transaction. A plain `throw` is catchable, and a
 * caller that catches it and continues commits that increment with no cost layer
 * behind it — the exact defect (unlayered stock, on-hand above the sum of FIFO layer
 * quantities, reported by nobody) that o3d-eiuo was raised for. Measured against a
 * real Postgres, 2026-09-10: an ordinary throw swallowed inside `db.$transaction`
 * COMMITS the increment.
 *
 * WHAT THIS DOES INSTEAD. It runs a statement that is guaranteed to fail — casting a
 * non-numeric constant to `int` raises `invalid_input_syntax` — which puts Postgres
 * into aborted-transaction state. Every subsequent statement on that transaction then
 * fails with 25P02 and the COMMIT degrades to a ROLLBACK, so a caller that swallows
 * the refusal cannot commit anything at all. Same measurement: 0 rows committed.
 *
 * ONE THING IT DOES NOT DO, measured 2026-09-10 and easy to assume otherwise:
 * `db.$transaction` still RESOLVES. Postgres turns the COMMIT into a ROLLBACK and
 * Prisma does not raise, so a caller that swallowed the refusal is handed its own
 * return value and believes it succeeded. The DATA is safe — nothing committed — but
 * the caller is not told, which is a further reason no call site should catch this.
 * Pinned by tests/concurrency/transfer-cost-layer-recreation-context.concurrent.test.ts.
 *
 * THE PARAMETER IS BOUND, NOT INTERPOLATED. `$executeRaw` is a tagged template, so
 * the sentinel travels as a query parameter; the error text names it, which is what
 * makes a swallowed refusal legible in the logs rather than an anonymous 25P02.
 *
 * IT ONLY MEANS ANYTHING INSIDE A TRANSACTION, WHICH IS NOW CHECKED. On an
 * autocommit connection each statement is its own transaction, so this abort has
 * nothing to abort: the caller's stock increment committed the moment it ran, and a
 * caught refusal leaves stock on hand with no cost layers — the exact harm. The
 * entry precondition `assertHelperCanRefuseEffectively` establishes the transaction
 * from the CLIENT, by asking Postgres, before anything is created.
 *
 * NOR DOES IT SURVIVE A SAVEPOINT. `ROLLBACK TO SAVEPOINT` clears the aborted state,
 * so a caller that wrapped this call in `withSavepoint` would undo the abort and be
 * free to continue. The same entry precondition refuses when this module's savepoint
 * helper has one open on the client. Both halves are now runtime facts read from the
 * client, replacing a source scanner that recognised only the bare identifier
 * `withSavepoint` and passed anything else (Codex round-6 HIGH-2).
 */
async function abortEnclosingTransactionSoTheRefusalCannotBeSwallowed(tx: TxClient): Promise<void> {
  // Checked OUTSIDE the try on purpose. Inside it, a `tx` with no `$executeRaw` would
  // raise a TypeError that the catch below would read as "the abort statement failed",
  // i.e. as success — a hole precisely where this function must have none.
  if (typeof tx.$executeRaw !== 'function') {
    throw new Error(
      'recreateTransferCostLayersFromSnapshotSlice: refusing a negative-cost snapshot entry, but the ' +
      'transaction client exposes no $executeRaw, so the enclosing transaction cannot be aborted and a ' +
      'caller could still commit its stock increment. Refusing without that guarantee (6oyu.19 / o3d-gd2f).',
    )
  }
  let aborted = false
  try {
    await tx.$executeRaw`SELECT CAST(${TRANSACTION_ABORT_SENTINEL} AS int)`
  } catch {
    // EXPECTED, and the entire point of the statement.
    aborted = true
  }
  if (!aborted) {
    throw new Error(
      'recreateTransferCostLayersFromSnapshotSlice: refusing a negative-cost snapshot entry, but the ' +
      'deliberate abort statement SUCCEEDED, so the enclosing transaction is still writable and a caller ' +
      'could commit its stock increment. Refusing without that guarantee (6oyu.19 / o3d-gd2f).',
    )
  }
}

/**
 * Thrown at ENTRY when this helper cannot guarantee that refusing will actually stop
 * the caller committing (Codex round-6 HIGH-2). See
 * `assertHelperCanRefuseEffectively`.
 */
export class TransferCostLayerRecreationContextError extends Error {
  override readonly name = 'TransferCostLayerRecreationContextError'
  readonly reason: 'no_raw_access' | 'not_in_transaction' | 'open_savepoint'

  constructor(reason: 'no_raw_access' | 'not_in_transaction' | 'open_savepoint', message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * THE ENTRY PRECONDITION: this helper may only run where its refusal can actually
 * refuse (Codex round-6 HIGH-2).
 *
 * The negative-cost refusal works by poisoning the enclosing transaction, so that a
 * caller which catches the throw still cannot commit the stock increment it made
 * just before calling. That mechanism has exactly two ways to be inert, and both are
 * properties of the CLIENT rather than of where the call site sits in the source:
 *
 *  1. NOT IN A TRANSACTION. On an autocommit connection the caller's stock increment
 *     is already committed and the abort statement poisons a transaction that
 *     consists of itself. A caught refusal then commits stock with no cost layers —
 *     the precise harm. This was previously "checked" by a source scanner looking
 *     backwards from the call site for a `$transaction(` token; it found none for
 *     the call inside `applyTransferLineReceipt`, because that function is handed
 *     its `tx` by a caller, and ACCEPTED it. A scanner cannot answer an
 *     interprocedural question, so the question is asked of Postgres instead.
 *  2. UNDER AN OPEN SAVEPOINT. `ROLLBACK TO SAVEPOINT` clears the aborted state, so
 *     a `withSavepoint` between the call and the transaction would let a caller undo
 *     the abort and carry on. The scanner matched only the bare identifier
 *     `withSavepoint` — `savepoints.withSavepoint`, an import alias, or any helper
 *     that wrapped it passed. `openSavepointDepth` reads the savepoint module's own
 *     runtime state on this client, so every one of those is seen, including one
 *     opened several frames up the stack.
 *
 * Checked BEFORE anything is created, and unconditionally rather than only on the
 * refusal path: a call site that cannot be refused effectively is a defect whether
 * or not this particular snapshot happens to be negative, and finding out only on
 * the rare negative input would be finding out in production.
 */
async function assertHelperCanRefuseEffectively(tx: TxClient, target: TransferLayerRecreationTarget): Promise<void> {
  const where = `transfer line ${target.transferLineId} (${target.contextLabel})`
  const depth = openSavepointDepth(tx)
  if (depth > 0) {
    throw new TransferCostLayerRecreationContextError(
      'open_savepoint',
      `recreateTransferCostLayersFromSnapshotSlice: refusing to run for ${where} because ${depth} savepoint` +
      `${depth === 1 ? ' is' : 's are'} open on this client. Rolling back to a savepoint CLEARS the ` +
      `aborted-transaction state this helper uses to stop a caller committing its stock increment after a ` +
      `negative-cost refusal, so the refusal would be reducible to a skip. Call it directly on the ` +
      `transaction client (6oyu.19 / o3d-gd2f).`,
    )
  }

  const inTransaction = await isClientInsideTransaction(tx)
  if (inTransaction === true) return
  if (inTransaction === null) {
    throw new TransferCostLayerRecreationContextError(
      'no_raw_access',
      `recreateTransferCostLayersFromSnapshotSlice: refusing to run for ${where} because the client exposes ` +
      `no raw escape hatch, so it cannot be shown to be inside a transaction and a negative-cost refusal ` +
      `could not abort anything. The caller increments stock before calling, so running without that ` +
      `guarantee risks committing stock with no cost layers behind it (6oyu.19 / o3d-eiuo).`,
    )
  }
  throw new TransferCostLayerRecreationContextError(
    'not_in_transaction',
    `recreateTransferCostLayersFromSnapshotSlice: refusing to run for ${where} because the client is NOT ` +
    `inside a transaction (Postgres 25P01 on a probe SAVEPOINT). Every caller increments stock immediately ` +
    `before calling, and on an autocommit connection that increment is already committed: a negative-cost ` +
    `refusal would have nothing to abort and a caller that caught it would leave stock on hand with no ` +
    `FIFO layer behind it. Call this inside db.$transaction (6oyu.19 / o3d-eiuo).`,
  )
}

/**
 * The postcondition the whole registry contract rests on: a layer built from a
 * transfer snapshot must be REACHABLE by propagateLandedCostToOutputs, which walks
 * costLayerSourceLine.sourceCostLayerId.
 *
 * "Reachable" is satisfied two ways, which is why this checks for ANY source line
 * rather than for a link naming the snapshot entry's own layer:
 *  - the proportional copy succeeded, so the new layer carries the source layer's
 *    OWN provenance (pointing at its ancestors — the layers a landed-cost recalc
 *    actually revalues), or
 *  - the copy returned 0 (an ordinary PO-derived source layer has no sourceLines),
 *    so a direct link naming the source layer was written instead.
 * Zero source lines means neither happened and the layer is unreachable — the exact
 * state that stranded the freight debit in transit.
 */
async function assertLayerIsReachableByPropagation(
  tx: TxClient,
  params: { costLayerId: string; sourceCostLayerId: string; transferLineId: string; contextLabel: string },
): Promise<void> {
  const links = await tx.costLayerSourceLine.count({ where: { costLayerId: params.costLayerId } })
  if (links > 0) return
  throw new Error(
    `recreateTransferCostLayersFromSnapshotSlice: cost layer ${params.costLayerId} was created from ` +
    `source layer ${params.sourceCostLayerId} (transfer line ${params.transferLineId}, ` +
    `${params.contextLabel}) with no costLayerSourceLine, so a retrospective landed-cost revaluation ` +
    `of the source could never reach it. Refusing to leave an unreachable layer behind (6oyu.19).`,
  )
}

/**
 * Recreate the FIFO layers for one slice of a dispatch snapshot, guaranteeing the
 * half of the registry contract that IS guaranteed today: every created layer is
 * reachable by propagateLandedCostToOutputs, so a landed-cost revaluation of the
 * source layer carries its delta onto these units — and that the layers created
 * cover the slice's whole quantity, so the caller's already-committed stock
 * increment is never left standing above Σ layer qty.
 *
 * `snapshotSlice` must come from sliceTransferSnapshotForReceipt — it is the
 * unconsumed portion of the dispatch snapshot for the quantity now landing.
 *
 * THROWS `TransferCostLayerRecreationContextError`, before reading or writing
 * anything, if the client it is handed is not inside a transaction or has one of
 * this codebase's savepoints open on it — the two ways the refusal below could be
 * turned back into a skip (Codex round-6 HIGH-2).
 *
 * THROWS `NegativeCostSnapshotEntryError`, having created nothing and having aborted
 * the enclosing transaction, if any entry that would become a layer carries a
 * negative unit cost. See the module comment for why that is refused rather than
 * skipped (round 3) or capitalised (round 4), and o3d-gd2f for what has to change
 * before it can be accepted.
 */
export async function recreateTransferCostLayersFromSnapshotSlice(
  tx: TxClient,
  target: TransferLayerRecreationTarget,
  snapshotSlice: CostLayerSnapshotEntry[],
  deps: TransferCostLayerRecreationDeps = defaultDeps,
): Promise<TransferLayerRecreationResult> {
  const result: TransferLayerRecreationResult = {
    createdLayers: [],
    recreatedQty: toDecimal(0).toFixed(6),
  }

  // FIRST, before anything is read or written: this helper's refusal is only a
  // refusal inside a transaction with no savepoint over it. See the function's
  // comment (Codex round-6 HIGH-2).
  await assertHelperCanRefuseEffectively(tx, target)

  // THE NEGATIVE-COST REFUSAL (Codex round-5 HIGH; o3d-gd2f). A WHOLE-SLICE PRE-PASS,
  // deliberately not a per-entry check inside the loop below: a slice whose third
  // entry is negative must not first write two layers and two source lines. The
  // transaction would roll those back anyway, but "nothing was attempted" is a
  // stronger and much easier property to assert than "everything was undone".
  //
  // Scoped to entries that would actually BECOME a layer. An entry with qty <= 0 is
  // dropped by parseCostLayerSnapshot and skipped in the loop below, so it lays down
  // no units and no wrong movement value; refusing on one would block a receipt over
  // a row that changes nothing.
  const negativeCostEntries = snapshotSlice
    .map((entry, index) => ({ entry, index, qty: toDecimal(entry.qty), unitCostBase: toDecimal(entry.unitCostBase) }))
    .filter((candidate) => candidate.qty.gt(0) && candidate.unitCostBase.lt(0))
  if (negativeCostEntries.length > 0) {
    const entries = negativeCostEntries.map((candidate) => ({
      index: candidate.index,
      sourceCostLayerId: candidate.entry.costLayerId,
      qty: candidate.qty.toFixed(6),
      unitCostBase: candidate.unitCostBase.toFixed(6),
    }))
    // Abort FIRST, throw second: the caller must not be able to catch this and go on
    // to commit the stock increment it has already made. See the function's comment.
    await abortEnclosingTransactionSoTheRefusalCannotBeSwallowed(tx)
    throw new NegativeCostSnapshotEntryError({
      transferLineId: target.transferLineId,
      contextLabel: target.contextLabel,
      entries,
      message:
        `recreateTransferCostLayersFromSnapshotSlice: REFUSING the dispatch snapshot for transfer line ` +
        `${target.transferLineId} (${target.contextLabel}, product ${target.productId}, warehouse ` +
        `${target.warehouseId}) because ${entries.length === 1 ? 'an entry carries' : `${entries.length} entries carry`} ` +
        `a NEGATIVE unit cost: ` +
        entries
          .map((offender) => `entry #${offender.index} from source layer ${offender.sourceCostLayerId} — ` +
            `${offender.qty} units at ${offender.unitCostBase}/unit`)
          .join('; ') +
        `. A negative basis cannot be represented downstream: buildStockMovementValueFieldsFromTotal ` +
        `absolutises the movement total, so the layer would book a POSITIVE TRANSFER_IN, and the Xero and ` +
        `QuickBooks daily syncs emit a COGS journal pair only when the batch total is above zero, so the ` +
        `credit would be mis-stated or dropped. Nothing has been created and this transaction has been ` +
        `aborted. The thing to correct is the credit freight line that drove this layer's cost negative ` +
        `(6oyu.19 / o3d-gd2f; production prevalence is o3d-e65p).`,
    })
  }

  // Computed from the INPUT, before anything is created, and deliberately not
  // accumulated alongside the layers: the postcondition below compares two figures
  // derived from different things, so a future edit that reintroduces a skip cannot
  // also quietly shrink the target it is measured against.
  const requestedQty = snapshotSlice.reduce((sum, entry) => {
    const entryQty = toDecimal(entry.qty)
    return entryQty.gt(0) ? addMoney(sum, entryQty) : sum
  }, toDecimal(0))

  for (const entry of snapshotSlice) {
    const entryQty = toDecimal(entry.qty)
    const unitCostBase = toDecimal(entry.unitCostBase)
    // parseCostLayerSnapshot already drops non-positive quantities. Such an entry
    // carries NO quantity, so passing over it leaves nothing unlayered and cannot
    // open the gap this function's postcondition is about.
    if (entryQty.lte(0)) continue
    // Negative unit costs were refused above, before anything was created.
    const newLayerId = await deps.createCostLayer(tx, {
      productId: target.productId,
      warehouseId: target.warehouseId,
      qty: entryQty,
      unitCostBase,
      ...(target.adjustmentMovementId ? { adjustmentMovementId: target.adjustmentMovementId } : {}),
    })

    const copied = await deps.copyCostLayerSourceLinesProportionally(tx, entry.costLayerId, newLayerId, entryQty)
    if (copied === 0) {
      // The source layer carries no provenance of its own (the ordinary case: a
      // PO-derived layer). Without this the new layer is invisible to
      // getDependentOutputSourceLines and the revaluation delta is stranded.
      await tx.costLayerSourceLine.create({
        data: {
          costLayerId: newLayerId,
          sourceProductId: target.productId,
          sourceCostLayerId: entry.costLayerId,
          qty: entryQty.toFixed(6),
          unitCostBase: unitCostBase.toFixed(6),
          totalCostBase: roundQuantity(multiplyMoney(entryQty, unitCostBase), 6).toFixed(6),
        },
      })
    }
    await assertLayerIsReachableByPropagation(tx, {
      costLayerId: newLayerId,
      sourceCostLayerId: entry.costLayerId,
      transferLineId: target.transferLineId,
      contextLabel: target.contextLabel,
    })

    result.createdLayers.push({
      costLayerId: newLayerId,
      sourceCostLayerId: entry.costLayerId,
      qty: entryQty.toFixed(6),
      unitCostBase: unitCostBase.toFixed(6),
      linkedDirectly: copied === 0,
    })
  }

  // THE QUANTITY POSTCONDITION (Codex round-4 HIGH; o3d-eiuo).
  //
  // Every caller increments stock and THEN calls this function, inside the same
  // transaction. So an entry this function declines to lay down is not a bookkeeping
  // gap that someone can report — it is stock on the shelf with no cost layer behind
  // it, invisible to the caller (which had no reason to inspect a count) and to the
  // manual receipt path's balancing layer (which measured the slice, not the layers).
  //
  // The guarantee is therefore made here, where it cannot be ignored: the layers this
  // function creates cover the slice's whole positive quantity, or it throws and the
  // caller's stock increment rolls back with it. A skip cannot be reintroduced as a
  // silent trade-off again — only as a visible failure.
  //
  // Measured by RE-READING the persisted layers, not by summing the loop's own record
  // of what it meant to create. A tally assembled by the same statements it is meant
  // to police cannot fail: it would agree with the input no matter what reached the
  // database. This re-read fails on a layer that was skipped, one that was never
  // written, and one written short.
  const persistedLayers = result.createdLayers.length === 0
    ? []
    : await tx.costLayer.findMany({
      where: { id: { in: result.createdLayers.map((layer) => layer.costLayerId) } },
      select: { receivedQty: true },
    })
  const recreatedQty = persistedLayers.reduce((sum, layer) => addMoney(sum, layer.receivedQty), toDecimal(0))
  if (!roundQuantity(recreatedQty, 6).equals(roundQuantity(requestedQty, 6))) {
    throw new Error(
      `recreateTransferCostLayersFromSnapshotSlice: snapshot slice for transfer line ` +
      `${target.transferLineId} (${target.contextLabel}) carried ${requestedQty.toFixed(6)} units but only ` +
      `${recreatedQty.toFixed(6)} were placed into cost layers. The caller has already incremented stock, so ` +
      `returning would leave ${roundQuantity(requestedQty.sub(recreatedQty), 6).toFixed(6)} units on hand with ` +
      `no FIFO layer behind them (6oyu.19 / o3d-eiuo).`,
    )
  }
  result.recreatedQty = roundQuantity(recreatedQty, 6).toFixed(6)

  return result
}
