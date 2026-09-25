/**
 * Shared FIFO cost layer helpers.
 *
 * These are used by stock adjustments, transfers, manufacturing, and any
 * other path that needs to consume or create cost layers atomically.
 * All functions accept a Prisma TransactionClient so they can participate
 * in the caller's transaction.
 */

import type { Prisma, StockMovementType } from '@/app/generated/prisma/client'
import { getAccountingSettings, isAccountingSyncTypeEnabled, isDailyBatchPostingEnabled, queueAccountingSyncTx } from '@/lib/accounting'
import { parseCostLayerSnapshot, serializeCostLayerSnapshot, sumCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { isClientInsideTransaction, openSavepointDepth } from '@/lib/db/savepoint'
import { TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION } from '@/lib/domain/inventory/movement-cogs-relevance'
import { getInventoryConstraintMessage } from '@/lib/domain/inventory/prisma-errors'
import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'
import {
  addMoney,
  multiplyMoney,
  roundQuantity,
  subtractMoney,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

type TxClient = Prisma.TransactionClient
type ShipmentCogsRevaluationSyncOptions = {
  accountingSettings?: {
    inventoryAccount?: string | null
    cogsAccount?: string | null
  }
  queueAccountingSync?: typeof queueAccountingSyncTx
  /**
   * Whether the COGS_REVERSAL posting type is actually enabled (injectable for
   * tests). Determines whether this revaluation will reach the ledger — used by
   * the caller to decide whether the landed-cost COGS journal must still cover
   * this delta (audit-3aph).
   */
  isReversalPostingEnabled?: () => Promise<boolean>
  /**
   * Whether the daily batch will post un-journaled shipments' COGS (injectable
   * for tests). When false, the batch won't carry an un-journaled shipment's
   * revaluation, so the caller must keep that delta in the COGS journal
   * (audit-gbzh).
   */
  isDailyBatchPostingEnabled?: () => Promise<boolean>
  /**
   * Per-recalc-run nonce (audit-g4la style). The revaluation idempotency key
   * otherwise encodes only (shipment, layer, oldCogs, newCogs), so correcting a
   * landed cost A→B→A→B regenerates the first key and the later identical
   * correction is silently deduped against the earlier one (or a post-failure
   * retry whose cogsBatchAmount advanced re-posts). Stamping the run nonce into
   * the key makes each recalc run post a distinct COGS_REVERSAL while a retry
   * WITHIN a run (same nonce) still dedups correctly (cogs-audit scjz.33).
   */
  recalcRunId?: string
  /**
   * o3d-c08y: what drove this revaluation, so a refusal can name the thing to correct (the credit
   * freight cost line, or the production order). Optional: a refusal without it still names the
   * shipment, the layer and both COGS figures.
   */
  revaluationContext?: ShipmentRevaluationContext
  /**
   * o3d-c08y: writes the ERROR activity entry for a refusal. It MUST commit independently of `tx`,
   * because the refusal aborts `tx` and everything written through it is rolled back. Injectable for
   * tests; the default is `logActivityPersisted`, which uses its own connection.
   */
  logRefusal?: (refusal: JournaledShipmentRevaluationRefusal) => Promise<boolean>
}

/** o3d-c08y: the operation that revalued a cost layer, as far as the caller knows it. */
export type ShipmentRevaluationContext = {
  source: 'landed_cost_recalc' | 'direct_landed_cost_recalc' | 'landed_cost_output_propagation' | 'manufacturing_recompute'
  /**
   * o3d-c08y r2: WHAT THE OPERATOR WAS DOING, which decides what the remedy can sensibly ask of them.
   * Round 1 always said "save again", which is wrong for a CANCELLATION (there is no save to repeat,
   * and the cancelled PO's own cost lines are excluded from the figures the refusal quotes) and wrong
   * for a production-order recompute (manufacturing rejects negative cost lines, so the credit is on a
   * component's purchase order, not here). Defaults to a save when the caller does not say.
   */
  operation?: 'save' | 'cancel_freight_po' | 'recompute_production_order'
  primaryPoId?: string
  primaryPoReference?: string
  freightPoId?: string
  productionOrderId?: string
  /** Negative (credit) cost lines that contributed to this revaluation — the thing to correct. */
  creditCostLines?: Array<{
    freightCostLineId: string
    purchaseOrderId: string
    purchaseOrderReference: string | null
    amountBase: string
  }>
}

/** o3d-c08y: one already-journaled shipment a revaluation would have driven below zero. */
export type RefusedJournaledShipment = {
  shipmentId: string
  oldCogsBase: string
  newCogsBase: string
}

export type JournaledShipmentRevaluationRefusal = {
  costLayerId: string
  shipments: RefusedJournaledShipment[]
  context: ShipmentRevaluationContext | null
  message: string
}

/**
 * o3d-c08y: A REVALUATION THAT WOULD TAKE AN ALREADY-JOURNALED SHIPMENT'S COGS BELOW ZERO IS REFUSED.
 *
 * Thrown by `refreshShipmentCogsForCostLayerChange` after it has aborted the enclosing transaction,
 * so the whole revaluation — the layer's new cost, the rewritten snapshots, and anything else the
 * caller wrote in the same transaction — is rolled back. Nothing reaches the ledger or the COGS
 * subledger, so the two cannot disagree. `loggedToActivity` says whether the ERROR entry, written
 * on its own connection, was persisted.
 */
export class JournaledShipmentRevaluationRefusedError extends Error {
  override readonly name = 'JournaledShipmentRevaluationRefusedError'
  readonly costLayerId: string
  readonly shipments: RefusedJournaledShipment[]
  readonly context: ShipmentRevaluationContext | null
  readonly loggedToActivity: boolean

  constructor(refusal: JournaledShipmentRevaluationRefusal, loggedToActivity: boolean) {
    super(refusal.message)
    this.costLayerId = refusal.costLayerId
    this.shipments = refusal.shipments
    this.context = refusal.context
    this.loggedToActivity = loggedToActivity
  }
}

/**
 * o3d-c08y r2 — THROWN AT ENTRY when the client handed to
 * `refreshShipmentCogsForCostLayerChange` is one whose refusal could not actually refuse.
 *
 * The refusal works by poisoning the enclosing transaction, so a caller that catches it still cannot
 * commit the layer cost and snapshots it wrote just before calling. That mechanism has exactly three
 * ways to be inert, and all three are properties of the CLIENT rather than of where the call site sits
 * in the source — which is why they are asked of the client and of Postgres, not of a source scanner:
 *
 *  1. NO RAW ACCESS. Without `$executeRaw`/`$executeRawUnsafe` there is nothing to abort with, and the
 *     previous code SKIPPED the abort in that case and threw anyway — a refusal reducible to a skip.
 *  2. NOT IN A TRANSACTION. On an autocommit client the caller's `costLayer.update` has already
 *     committed, so the abort poisons a transaction consisting of itself and a caught refusal leaves a
 *     negative layer standing with the shipment snapshot rewritten to match.
 *  3. UNDER AN OPEN SAVEPOINT. `ROLLBACK TO SAVEPOINT` clears the aborted state, so a `withSavepoint`
 *     anywhere between the call and the transaction would let a caller undo the abort and carry on.
 *
 * Checked UNCONDITIONALLY, before anything is read or written, and not only on the refusal path: a
 * call site that cannot be refused effectively is a defect whether or not this particular revaluation
 * happens to go negative, and finding out only on the rare negative input is finding out in
 * production. Same reasoning, and the same two runtime probes, as the transfer re-layering refusal
 * (`assertHelperCanRefuseEffectively`, transfer-cost-layer-recreation.ts, Codex round-6 HIGH-2) —
 * which this one's comments claimed to mirror before it actually did.
 *
 * Every real call site — three in landed-cost-service and one in the manufacturing recompute — is
 * handed its `tx` by a `db.$transaction`, on all five entry paths (the two PO-cost actions, the
 * freight-PO create, the freight-PO cancellation and the production-order recompute), with no
 * `withSavepoint` between. So nothing in the application today is refused by this; what it stops is a
 * NEW call site that would be, and a refusal that would have been reducible to a skip.
 */
export class JournaledShipmentRevaluationContextError extends Error {
  override readonly name = 'JournaledShipmentRevaluationContextError'
  readonly reason: 'no_raw_access' | 'not_in_transaction' | 'open_savepoint'

  constructor(reason: 'no_raw_access' | 'not_in_transaction' | 'open_savepoint', message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * Clients already shown to be inside a transaction. A Prisma transaction client cannot leave its
 * transaction and the base client never enters one, so a `true` answer is stable for the life of the
 * object — and this function is called once per revalued cost layer, which is many times per recalc.
 * Only the positive answer is cached: the other two outcomes throw. Held weakly, so a short-lived
 * transaction client is not kept alive by this set.
 */
const CLIENTS_KNOWN_INSIDE_TRANSACTION = new WeakSet<object>()

async function assertRevaluationRefusalCanRefuseEffectively(tx: TxClient, costLayerId: string): Promise<void> {
  const where = `cost layer ${costLayerId}`
  const depth = openSavepointDepth(tx)
  if (depth > 0) {
    throw new JournaledShipmentRevaluationContextError(
      'open_savepoint',
      `refreshShipmentCogsForCostLayerChange: refusing to run for ${where} because ${depth} savepoint`
      + `${depth === 1 ? ' is' : 's are'} open on this client. Rolling back to a savepoint CLEARS the aborted-`
      + 'transaction state a journaled-shipment refusal uses to stop its caller committing the revaluation it '
      + 'has already written, so the refusal would be reducible to a skip. Call this directly on the '
      + 'transaction client (o3d-c08y).',
    )
  }
  if (CLIENTS_KNOWN_INSIDE_TRANSACTION.has(tx)) return

  if (typeof (tx as { $executeRaw?: unknown }).$executeRaw !== 'function') {
    throw new JournaledShipmentRevaluationContextError(
      'no_raw_access',
      `refreshShipmentCogsForCostLayerChange: refusing to run for ${where} because the client exposes no `
      + '$executeRaw, so a journaled-shipment refusal could not abort the enclosing transaction and a caller '
      + 'that caught it could commit a negative cost layer with the shipment snapshots rewritten to match '
      + '(o3d-c08y).',
    )
  }
  const inTransaction = await isClientInsideTransaction(tx)
  if (inTransaction === true) {
    CLIENTS_KNOWN_INSIDE_TRANSACTION.add(tx)
    return
  }
  if (inTransaction === null) {
    throw new JournaledShipmentRevaluationContextError(
      'no_raw_access',
      `refreshShipmentCogsForCostLayerChange: refusing to run for ${where} because the client exposes no raw `
      + 'escape hatch to probe with, so it cannot be shown to be inside a transaction and a refusal could not '
      + 'be shown to abort anything (o3d-c08y).',
    )
  }
  throw new JournaledShipmentRevaluationContextError(
    'not_in_transaction',
    `refreshShipmentCogsForCostLayerChange: refusing to run for ${where} because the client is NOT inside a `
    + 'transaction (Postgres 25P01 on a probe SAVEPOINT). Every caller has already written the layer\'s new '
    + 'cost before calling, and on an autocommit client that write is already committed: a refusal would have '
    + 'nothing to abort and a caller that caught it would leave a negative cost basis standing. Call this '
    + 'inside db.$transaction (o3d-c08y).',
  )
}

export function buildShipmentCogsRevaluationSyncPayload(input: {
  shipmentId: string
  costLayerId: string
  inventoryAccount: string
  cogsAccount: string
  oldCogsBase: DecimalInput
  newCogsBase: DecimalInput
}): Record<string, unknown> | null {
  const oldCogs = roundQuantity(input.oldCogsBase, 2)
  const newCogs = roundQuantity(input.newCogsBase, 2)
  // o3d-c08y: EACH LEG BELOW IS GATED ON ITS OWN SIDE BEING POSITIVE, so a negative side used to be
  // DROPPED: a shipment revalued from 4.00 to -6.00 posted only the 4.00 reversal, and 6.00 posted
  // nowhere. A negative basis cannot be represented here (o3d-gd2f), and
  // `refreshShipmentCogsForCostLayerChange` refuses the revaluation before it gets this far; this
  // throw is the backstop that keeps the leg-drop from ever being silent again.
  if (oldCogs.lt(0) || newCogs.lt(0)) {
    throw new Error(
      `buildShipmentCogsRevaluationSyncPayload: shipment ${input.shipmentId} would be revalued from `
      + `${oldCogs.toFixed(2)} to ${newCogs.toFixed(2)} for cost layer ${input.costLayerId}. A negative shipment COGS `
      + 'cannot be posted (o3d-gd2f), and building this journal would drop the negative leg silently (o3d-c08y).',
    )
  }
  if (oldCogs.sub(newCogs).abs().lt(0.01)) return null

  // Use a 4-line reverse + repost journal rather than a 2-line delta so the
  // accounting audit trail shows both the old and recomputed shipment COGS.
  // When one side rounds to 0 (e.g. a 0.00 shipment revalued up, or a shipment
  // revalued down to 0.00) its reverse/post legs would be zero-amount, which the
  // accounting-event normalizer rejects (a line must carry exactly one positive
  // debit or credit). Drop the zero side's legs so we emit a balanced 2-line
  // delta instead of a journal that throws (cogs-audit scjz.35).
  const lines: Array<Record<string, unknown>> = []
  if (oldCogs.gt(0)) {
    lines.push(
      { accountCode: input.inventoryAccount, description: `Reverse old shipment COGS ${input.shipmentId}`, debit: oldCogs.toNumber() },
      { accountCode: input.cogsAccount, description: `Reverse old shipment COGS ${input.shipmentId}`, credit: oldCogs.toNumber() },
    )
  }
  if (newCogs.gt(0)) {
    lines.push(
      { accountCode: input.cogsAccount, description: `Post revalued shipment COGS ${input.shipmentId}`, debit: newCogs.toNumber() },
      { accountCode: input.inventoryAccount, description: `Post revalued shipment COGS ${input.shipmentId}`, credit: newCogs.toNumber() },
    )
  }

  return {
    date: new Date().toISOString().slice(0, 10),
    reference: `Shipment COGS revaluation: ${input.shipmentId}`,
    narration: `Reverse and repost shipment COGS after cost-layer revaluation for shipment ${input.shipmentId}`,
    lines,
    sourceCostLayerId: input.costLayerId,
    oldCogsBase: oldCogs.toNumber(),
    newCogsBase: newCogs.toNumber(),
  }
}

async function queueShipmentCogsRevaluationSync(
  tx: TxClient,
  input: {
    shipmentId: string
    costLayerId: string
    oldCogsBase: DecimalInput
    newCogsBase: DecimalInput
  },
  options: ShipmentCogsRevaluationSyncOptions = {},
): Promise<boolean> {
  const settings = options.accountingSettings ?? await getAccountingSettings().catch(() => null)
  if (!settings?.inventoryAccount || !settings.cogsAccount) return false
  const payload = buildShipmentCogsRevaluationSyncPayload({
    ...input,
    inventoryAccount: settings.inventoryAccount,
    cogsAccount: settings.cogsAccount,
  })
  if (!payload) return false
  // audit-3aph: only treat this revaluation as posted (so the caller drops it
  // from the COGS journal) when COGS_REVERSAL posting is actually enabled —
  // otherwise the delta must remain in the COGS journal or it would post NOWHERE.
  const isEnabled = options.isReversalPostingEnabled ?? (() => isAccountingSyncTypeEnabled('COGS_REVERSAL'))
  if (!(await isEnabled())) return false

  // o3d-zpa7: THE PRECONDITION THAT MAKES THE UNLOCKED ENQUEUE SAFE, checked rather than argued.
  //
  // This is the one order-scoped enqueue that cannot hoist `lockSalesOrder` (see the reason string
  // below), so o3d-3zgy left it acknowledged and open: a hard delete of the sales order concurrent
  // with this write would orphan an AccountingSyncLog row against a reference nothing resolves.
  //
  // It turns out no lock is needed, because THE ORDER CANNOT BE HARD-DELETED AT ALL. The chain, each
  // link a where-clause in a different file:
  //
  //   this enqueue runs only for a shipment with shipmentJournalDate set (the caller's branch)
  //     -> shipmentJournalDate is written only by daily-batch Group B, whose selection requires
  //        `order.revenueDeferredDate != null` (xero/daily-sync.ts, quickbooks/daily-sync.ts)
  //     -> revenueDeferredDate is stamped only by Group A1, whose selection requires
  //        `accountingInvoiceId != null`
  //     -> deleteSalesOrder refuses UNCONDITIONALLY on a non-null accountingInvoiceId
  //        (order-delete-guard.ts, blocker 0), and that field is never set back to null.
  //
  // Blocker 0 is read off the ORDER ROW, so unlike every other delete blocker it does not depend on an
  // AccountingSyncLog row surviving retention. The race is therefore unreachable, not merely narrow.
  //
  // Asserting the LAST link makes the argument load-bearing instead of a comment: if a future change to
  // A1/Group B ever lets an un-invoiced order reach this point, the enqueue REFUSES rather than
  // silently writing an unprotected row. Refusing is safe and loses no money — returning false is the
  // established "this revaluation did not post here" signal (audit-3aph), and the caller then keeps the
  // delta in its own retrospective COGS journal instead of dropping it.
  //
  // The read takes NO lock, so it cannot invert lockSalesOrder-then-lockStockLevels: it is a plain
  // SELECT, and what it reads is monotonic (accountingInvoiceId is only ever set, never cleared), so
  // there is nothing for a concurrent writer to invalidate.
  const deleteProtection = await tx.shipment.findUnique({
    where: { id: input.shipmentId },
    select: { order: { select: { id: true, accountingInvoiceId: true } } },
  })
  if (!deleteProtection?.order?.accountingInvoiceId) {
    console.warn(
      `queueShipmentCogsRevaluationSync: refusing to enqueue COGS_REVERSAL for shipment ${input.shipmentId} — `
      + `its sales order ${deleteProtection?.order?.id ?? '(missing)'} carries no accountingInvoiceId, so it is NOT `
      + 'protected from a hard delete and this enqueue cannot take the order lock (o3d-zpa7). The revaluation '
      + 'delta stays in the caller\'s COGS journal.',
    )
    return false
  }

  const revaluationIdempotencyKey = `shipment-cogs-revalue:${input.shipmentId}:${input.costLayerId}:${payload.oldCogsBase}:${payload.newCogsBase}${options.recalcRunId ? `:${options.recalcRunId}` : ''}`
  await (options.queueAccountingSync ?? queueAccountingSyncTx)(tx, {
    type: 'COGS_REVERSAL',
    referenceType: 'Shipment',
    referenceId: input.shipmentId,
    idempotencyKey: revaluationIdempotencyKey,
    payload,
    // o3d-3zgy: this runs inside a purchasing/manufacturing landed-cost transaction
    // (propagateLandedCostToOutputs -> refreshShipmentCogsForCostLayerChange), which discovers the
    // affected shipments — and therefore their sales orders — by querying costLayerSnapshot
    // MID-transaction, after cost-layer and stock rows are already locked. Taking the sales-order lock
    // at that point inverts the lockSalesOrder-then-lockStockLevels ordering allocation-service
    // establishes and can deadlock against the allocation path, trading a rare race for a routine hang.
    // o3d-zpa7: what makes the unlocked write safe anyway is asserted immediately above — the order is
    // provably undeletable — so this acknowledgement now records WHY no lock is taken, not an open gap.
    unlockedOrderScopeReason:
      'landed-cost revaluation discovers affected shipments mid-transaction, after stock locks; the order is '
      + 'provably undeletable (accountingInvoiceId asserted above) so no lock is needed (o3d-zpa7)',
  })
  // khdw: record the net COGS-account movement of this revaluation (reverse old +
  // repost new → net debit = newCogs − oldCogs, both 2dp) in the COGS subledger
  // ledger, keyed identically to the sync so it dedupes across retries.
  await recordCogsSubledgerMovement(tx, {
    sourceType: 'SHIPMENT_REVALUATION',
    sourceRef: input.shipmentId,
    idempotencyKey: revaluationIdempotencyKey,
    baseDelta: toDecimal(payload.newCogsBase as number).sub(payload.oldCogsBase as number),
    journalDate: payload.date as string,
  })
  return true
}

/**
 * Ensure the (product, warehouse) stock_levels row exists and take a FOR UPDATE
 * row lock on it. This serializes concurrent stock-quantity/cost-layer mutations
 * for the same product+warehouse: a caller must hold this lock before reading
 * average cost or candidate layers so a concurrent consume between the read and
 * the layer write cannot leave the new layer costed against stale state
 * (cogs-audit scjz.3). Mirrors the lock applyStockAdjustment already takes.
 *
 * Uses $queryRaw (not $executeRaw) because Prisma's executeRaw path does not
 * reliably hold SELECT ... FOR UPDATE locks (enforced by row-lock-queryraw test).
 */
export async function lockStockLevelRow(
  tx: TxClient,
  productId: string,
  warehouseId: string,
): Promise<{ quantity: Decimal; reservedQty: Decimal }> {
  await tx.stockLevel.upsert({
    where: { productId_warehouseId: { productId, warehouseId } },
    create: { productId, warehouseId, quantity: 0 },
    update: {},
  })
  // Return the locked on-hand and reserved quantities so callers can run a
  // pre-flight availability check against the live, locked row (scjz.3 / ig58)
  // instead of relying on the DB non-negative CHECK to abort with an opaque
  // constraint error.
  const rows = await tx.$queryRaw<Array<{ quantity: unknown; reservedQty: unknown }>>`
    SELECT "quantity", "reservedQty"
    FROM stock_levels
    WHERE "productId" = ${productId}
      AND "warehouseId" = ${warehouseId}
    FOR UPDATE
  `
  const row = rows[0]
  return {
    quantity: toDecimal((row?.quantity ?? 0) as DecimalInput),
    reservedQty: toDecimal((row?.reservedQty ?? 0) as DecimalInput),
  }
}

function minDecimal(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b
}

function isPositiveDecimalInput(value: DecimalInput): boolean {
  try {
    return toDecimal(value).gt(0)
  } catch {
    return false
  }
}

function isFiniteDecimalInput(value: DecimalInput): boolean {
  try {
    toDecimal(value)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Consumption (negative adjustments, dispatches, transfers out)
// ---------------------------------------------------------------------------

export type ConsumedLayer = {
  costLayerId: string
  qty: Decimal
  unitCostBase: Decimal
}

export function cogsEntryDataFromConsumed(
  movementId: string,
  consumed: ConsumedLayer,
): Omit<Prisma.CogsEntryCreateManyInput, 'id' | 'createdAt'> {
  return {
    costLayerId: consumed.costLayerId,
    movementId,
    qty: roundQuantity(consumed.qty, 6).toFixed(6),
    unitCostBase: roundQuantity(consumed.unitCostBase, 6).toFixed(6),
    totalCostBase: roundQuantity(multiplyMoney(consumed.qty, consumed.unitCostBase), 6).toFixed(6),
  }
}

export type CostLayerSourceLineInput = {
  sourceProductId: string
  sourceCostLayerId?: string | null
  qty: DecimalInput
  unitCostBase: DecimalInput
  totalCostBase?: DecimalInput
}

type LockedFifoCostLayerRow = {
  id: string
  remainingQty: DecimalInput
  unitCostBase: DecimalInput
}

/**
 * Consume FIFO layers oldest-first for the given product + warehouse.
 * Decrements `remainingQty` on each layer consumed.
 *
 * Concurrency: this takes a SELECT FOR UPDATE row lock on every currently
 * available FIFO candidate layer for the product/warehouse pair. Concurrent
 * consumers for the same pair serialize on those locks. That preserves strict
 * FIFO cost accountability, but hot SKUs may wait under load rather than skip
 * older locked layers.
 *
 * The transaction-local lock timeout fails the caller instead of letting a
 * stuck transaction block all FIFO consumers for this pair indefinitely.
 *
 * Returns the consumed entries (for snapshot/provenance) and total cost.
 * If layers are exhausted before `qty` is fully consumed, the shortfall
 * is returned in `remainingQty` — the caller decides whether to throw
 * or tolerate (e.g. adjustments tolerate, dispatches throw).
 */
export async function consumeFifoLayers(
  tx: TxClient,
  productId: string,
  warehouseId: string,
  qty: number,
): Promise<{ consumed: ConsumedLayer[]; totalCost: Decimal; remainingQty: Decimal }> {
  let remaining = toDecimal(qty)
  let totalCost = toDecimal(0)
  const consumed: ConsumedLayer[] = []

  await tx.$executeRaw`SET LOCAL lock_timeout = '30s'`

  // Select and lock in one statement. A pre-lock Prisma findMany can materialize
  // a stale FIFO snapshot under concurrency; FOR UPDATE makes the oldest
  // candidate rows wait and re-check before this transaction can consume them.
  const layers = await tx.$queryRaw<LockedFifoCostLayerRow[]>`
    SELECT id, "remainingQty", "unitCostBase"
    FROM "cost_layers"
    WHERE "productId" = ${productId}
      AND "warehouseId" = ${warehouseId}
      AND "remainingQty" > 0
    ORDER BY "receivedAt" ASC, id ASC
    FOR UPDATE
  `

  for (const layer of layers) {
    if (remaining.lte(0)) break
    const layerRemaining = toDecimal(layer.remainingQty)
    const take = minDecimal(remaining, layerRemaining)
    if (take.lte(0)) continue
    const takeNumber = take.toNumber()
    await tx.costLayer.update({
      where: { id: layer.id },
      data: { remainingQty: { decrement: takeNumber } },
    })
    const unitCost = toDecimal(layer.unitCostBase)
    totalCost = addMoney(totalCost, multiplyMoney(take, unitCost))
    consumed.push({ costLayerId: layer.id, qty: take, unitCostBase: unitCost })
    remaining = subtractMoney(remaining, take)
  }

  return { consumed, totalCost, remainingQty: remaining }
}

/**
 * Largest FIFO shortfall tolerated before treating the consume as insufficient.
 * Set to the engine scale (6dp) so only float→Decimal conversion noise on the
 * requested qty is absorbed, not a materially under-covered consumption.
 */
const FIFO_SHORTFALL_TOLERANCE = toDecimal('0.000001')

/**
 * Consume FIFO layers and throw if layers are exhausted before qty is met.
 * Use this for dispatches and manufacturing where a shortfall is a hard error.
 */
export async function consumeFifoLayersStrict(
  tx: TxClient,
  productId: string,
  warehouseId: string,
  qty: number,
): Promise<{ consumed: ConsumedLayer[]; totalCost: Decimal }> {
  let result
  try {
    result = await consumeFifoLayers(tx, productId, warehouseId, qty)
  } catch (error) {
    const message = getInventoryConstraintMessage(error)
    if (message) throw new Error(message)
    throw error
  }
  // Tolerance is the engine scale (6dp), not 1e-4: the old 0.0001 band silently
  // absorbed a real shortfall up to a ten-thousandth of a unit — large for
  // fractional-unit products — and buildStockMovementValueFieldsFromConsumed then
  // divides the consumed value by the FULL rowQty, understating unit cost while
  // claiming the qty fully moved. Only sub-µ float→Decimal noise is tolerated now.
  if (result.remainingQty.gt(FIFO_SHORTFALL_TOLERANCE)) {
    throw new Error(
      `Insufficient FIFO layers for product ${productId} in warehouse ${warehouseId}: ` +
      `needed ${qty}, only ${subtractMoney(qty, result.remainingQty).toString()} available in cost layers`,
    )
  }
  // audit-snxr: the sub-µ tolerance above lets a tiny positive consume slip
  // through with NOTHING consumed when there are no cost layers at all (stock /
  // cost-layer desync). Callers build cogs_entries only when consumed is
  // non-empty, so a zero-evidence outbound movement would be written and then
  // rejected by the deferred reporting-evidence guard at COMMIT (a confusing
  // P2028). A positive consumption with no FIFO provenance is a hard error here —
  // fail clearly before the movement is written rather than booking uncosted stock.
  // Ordered BEFORE the absorption flag below: this path absorbs nothing, so
  // flagging it would both misdescribe the event and be rolled back by the throw.
  if (qty > 0 && result.consumed.length === 0) {
    throw new Error(
      `No FIFO cost layers to consume for product ${productId} in warehouse ${warehouseId}: ` +
      `cannot record a costed outbound movement of ${qty} (stock/cost-layer desync — repair the cost layers).`,
    )
  }
  // Surface a non-zero shortfall that was absorbed within tolerance as a
  // reconciliation exception — it indicates the consumed value was spread over a
  // marginally larger rowQty than the layers covered, understating unit cost.
  // A console.warn alone lands only in server logs and is invisible to finance
  // (6oyu.8): also raise a finance-visible activity-log WARNING in the SAME
  // transaction as the movement (mirrors accounting-fx.ts's fx_rate_fallback_used
  // reconciliation flag) so the absorption is an auditable reconciliation event,
  // not just a log line. Numeric behaviour is unchanged — this is visibility only.
  if (result.remainingQty.gt(0)) {
    // toFixed(), not toString(): Decimal renders sub-µ values in exponential
    // notation ("5e-7"), which reads as noise in a finance-facing audit record.
    const shortfallQty = result.remainingQty.toFixed()
    console.warn(
      `consumeFifoLayersStrict absorbed a sub-tolerance FIFO shortfall for product ${productId} ` +
      `in warehouse ${warehouseId}: requested ${qty}, ${shortfallQty} uncovered by cost layers.`,
    )
    await tx.activityLog.create({
      data: {
        entityType: 'PRODUCT',
        entityId: productId,
        action: 'fifo_shortfall_absorbed',
        tag: 'accounting',
        level: 'WARNING',
        description:
          `Absorbed a sub-tolerance FIFO shortfall for product ${productId} in warehouse ${warehouseId}: ` +
          `requested ${qty}, ${shortfallQty} uncovered by cost layers — the consumed value was spread over the ` +
          `full quantity, understating unit cost. Review the product's cost layers for a stock/cost-layer desync.`,
        metadata: {
          productId,
          warehouseId,
          requestedQty: qty,
          shortfallQty,
          toleranceQty: FIFO_SHORTFALL_TOLERANCE.toFixed(),
        },
      },
    })
  }
  return { consumed: result.consumed, totalCost: result.totalCost }
}

// ---------------------------------------------------------------------------
// Creation (positive adjustments, receipts, transfers in)
// ---------------------------------------------------------------------------

/**
 * Compute weighted average unit cost from existing FIFO layers.
 * Returns 0 if no layers exist (new product / empty warehouse).
 */
export async function getAverageUnitCost(
  tx: TxClient,
  productId: string,
  warehouseId: string,
): Promise<number> {
  const layers = await tx.costLayer.findMany({
    where: { productId, warehouseId, remainingQty: { gt: 0 } },
    select: { remainingQty: true, unitCostBase: true },
  })
  let totalQty = toDecimal(0)
  let totalValue = toDecimal(0)
  for (const l of layers) {
    const qty = toDecimal(l.remainingQty)
    totalQty = addMoney(totalQty, qty)
    totalValue = addMoney(totalValue, multiplyMoney(qty, l.unitCostBase))
  }
  return totalQty.gt(0) ? totalValue.div(totalQty).toNumber() : 0
}

export async function getHistoricalAverageUnitCost(
  tx: TxClient,
  productId: string,
): Promise<number> {
  const layers = await tx.costLayer.findMany({
    where: { productId },
    select: { receivedQty: true, unitCostBase: true },
  })
  let totalQty = toDecimal(0)
  let totalValue = toDecimal(0)
  for (const layer of layers) {
    const qty = toDecimal(layer.receivedQty)
    if (qty.lte(0)) continue
    totalQty = addMoney(totalQty, qty)
    totalValue = addMoney(totalValue, multiplyMoney(qty, layer.unitCostBase))
  }
  return totalQty.gt(0) ? totalValue.div(totalQty).toNumber() : 0
}

/**
 * Create a new cost layer. Used for positive adjustments (at average cost),
 * transfer receipts (at source layer cost), and production output.
 */
export async function createCostLayer(
  tx: TxClient,
  data: {
    productId: string
    warehouseId: string
    qty: DecimalInput
    unitCostBase: DecimalInput
    poLineId?: string
    adjustmentMovementId?: string
    productionOrderId?: string
    isOpeningStock?: boolean
    receivedAt?: Date
  },
): Promise<string> {
  const layer = await tx.costLayer.create({
    data: {
      productId: data.productId,
      warehouseId: data.warehouseId,
      receivedQty: roundQuantity(data.qty, 6).toFixed(6),
      remainingQty: roundQuantity(data.qty, 6).toFixed(6),
      unitCostBase: roundQuantity(data.unitCostBase, 6).toNumber(),
      poLineId: data.poLineId ?? null,
      adjustmentMovementId: data.adjustmentMovementId ?? null,
      productionOrderId: data.productionOrderId ?? null,
      isOpeningStock: data.isOpeningStock ?? false,
      ...(data.receivedAt ? { receivedAt: data.receivedAt } : {}),
    },
    select: { id: true },
  })
  return layer.id
}

/**
 * Reason codes for a cost-layer unitCostBase revaluation, recorded in the
 * cost_layer_revaluations event log (cogs-audit scjz.43/.48).
 */
export type CostLayerRevaluationReason =
  | 'landed_cost_recalc'
  | 'landed_cost_output_propagation'
  | 'manufacturing_recompute'
  | 'fx_rebase'
  | 'adjustment_edit'

/**
 * Append a cost-layer revaluation event (the basis valid before/after the change,
 * with its effective timestamp) so as-of/historical valuation can reconstruct the
 * cost basis at a point in time. No-op deltas (old == new at 6dp) are skipped so
 * the log only carries real basis changes. Pass the recalc/edit timestamp as
 * effectiveAt so events order correctly against an as-of date.
 */
export async function recordCostLayerRevaluation(
  tx: TxClient,
  input: {
    costLayerId: string
    oldUnitCostBase: DecimalInput
    newUnitCostBase: DecimalInput
    effectiveAt: Date
    reason: CostLayerRevaluationReason
  },
): Promise<boolean> {
  const oldUnit = roundQuantity(input.oldUnitCostBase, 6)
  const newUnit = roundQuantity(input.newUnitCostBase, 6)
  if (oldUnit.eq(newUnit)) return false
  // Coalesce repeated revaluations of the same layer within one run (identical
  // effectiveAt) — e.g. a diamond BOM cascade reaching an output layer twice, or
  // two revalued components feeding the same output — into a single net
  // old→final event. This keeps the original "old" cost and advances "new", so
  // as-of replay can order events by effectiveAt alone, with no ambiguous
  // intra-run sequence (blq0). Safe without locking: all events in a run share
  // one transaction, which is serial.
  const existing = await tx.costLayerRevaluation.findFirst({
    where: { costLayerId: input.costLayerId, effectiveAt: input.effectiveAt },
    select: { id: true, oldUnitCostBase: true },
  })
  if (existing) {
    // Net change across the run = original old → latest new. If they now match
    // (e.g. 5→6→5), the run was a no-op for this layer; drop the event.
    if (roundQuantity(existing.oldUnitCostBase, 6).eq(newUnit)) {
      await tx.costLayerRevaluation.delete({ where: { id: existing.id } })
    } else {
      await tx.costLayerRevaluation.update({
        where: { id: existing.id },
        data: { newUnitCostBase: newUnit.toFixed(6) },
      })
    }
    return true
  }
  await tx.costLayerRevaluation.create({
    data: {
      costLayerId: input.costLayerId,
      oldUnitCostBase: oldUnit.toFixed(6),
      newUnitCostBase: newUnit.toFixed(6),
      effectiveAt: input.effectiveAt,
      reason: input.reason,
    },
  })
  return true
}

/**
 * Set a cost layer's unitCostBase to an absolute value AND log the revaluation in
 * one step, so the cost_layer_revaluations event log stays complete. Reads the
 * prior cost first. Returns the old unit cost (as a Decimal) for callers that need
 * the delta. Use this instead of a bare costLayer.update whenever a layer is
 * REVALUED (its cost changes after creation) — not for qty-only changes.
 */
export async function updateCostLayerUnitCost(
  tx: TxClient,
  costLayerId: string,
  newUnitCostBase: DecimalInput,
  options: { effectiveAt: Date; reason: CostLayerRevaluationReason },
): Promise<Decimal> {
  const existing = await tx.costLayer.findUnique({
    where: { id: costLayerId },
    select: { unitCostBase: true },
  })
  const oldUnit = toDecimal(existing?.unitCostBase ?? 0)
  const newUnit = roundQuantity(newUnitCostBase, 6)
  await tx.costLayer.update({
    where: { id: costLayerId },
    data: { unitCostBase: newUnit.toFixed(6) },
  })
  await recordCostLayerRevaluation(tx, {
    costLayerId,
    oldUnitCostBase: oldUnit,
    newUnitCostBase: newUnit,
    effectiveAt: options.effectiveAt,
    reason: options.reason,
  })
  return oldUnit
}

export async function addCostLayerSourceLines(
  tx: TxClient,
  costLayerId: string,
  lines: CostLayerSourceLineInput[],
): Promise<number> {
  const validLines = lines
    .filter((line) => (
      line.sourceProductId &&
      isPositiveDecimalInput(line.qty) &&
      line.unitCostBase != null &&
      isFiniteDecimalInput(line.unitCostBase)
    ))
    .map((line) => ({
      costLayerId,
      sourceProductId: line.sourceProductId,
      sourceCostLayerId: line.sourceCostLayerId ?? null,
      qty: roundQuantity(line.qty, 4).toNumber(),
      unitCostBase: roundQuantity(line.unitCostBase, 6).toNumber(),
      totalCostBase: roundQuantity(line.totalCostBase ?? multiplyMoney(line.qty, line.unitCostBase), 6).toNumber(),
    }))

  if (validLines.length === 0) return 0
  const result = await tx.costLayerSourceLine.createMany({
    data: validLines,
  })
  return result.count
}

export async function copyCostLayerSourceLinesProportionally(
  tx: TxClient,
  fromCostLayerId: string,
  toCostLayerId: string,
  copiedQty: DecimalInput,
): Promise<number> {
  const copiedQtyDecimal = toDecimal(copiedQty)
  if (copiedQtyDecimal.lte(0)) return 0

  const sourceLayer = await tx.costLayer.findUnique({
    where: { id: fromCostLayerId },
    select: {
      receivedQty: true,
      sourceLines: {
        select: {
          sourceProductId: true,
          sourceCostLayerId: true,
          qty: true,
          unitCostBase: true,
          totalCostBase: true,
        },
      },
    },
  })
  if (!sourceLayer || sourceLayer.sourceLines.length === 0) return 0

  const sourceReceivedQty = toDecimal(sourceLayer.receivedQty)
  if (sourceReceivedQty.lte(0)) return 0

  const rawRatio = copiedQtyDecimal.div(sourceReceivedQty)
  // Every caller copies a SLICE drawn from the source layer (a refund/transfer/
  // sync portion of what was consumed from it), so copiedQty must never exceed
  // the source receivedQty. Capping the ratio at 1 silently understated the
  // copied source cost (cost-value leak); throw instead so the upstream anomaly
  // surfaces. A sub-µ band above 1 is rounding slack — clamp it to 1.
  if (rawRatio.gt('1.000001')) {
    throw new Error(
      `copyCostLayerSourceLinesProportionally: copiedQty exceeds source receivedQty for ${fromCostLayerId} -> ${toCostLayerId} ` +
      `(copiedQty=${copiedQtyDecimal.toString()}, sourceReceivedQty=${sourceReceivedQty.toString()}); ` +
      `this would leak source cost into the target layer.`,
    )
  }
  const ratio = rawRatio.gt(1) ? toDecimal(1) : rawRatio
  if (ratio.lte(0)) return 0

  return addCostLayerSourceLines(
    tx,
    toCostLayerId,
    sourceLayer.sourceLines.map((line) => ({
      sourceProductId: line.sourceProductId,
      sourceCostLayerId: line.sourceCostLayerId,
      qty: multiplyMoney(line.qty, ratio).toNumber(),
      unitCostBase: toDecimal(line.unitCostBase).toNumber(),
      totalCostBase: multiplyMoney(line.totalCostBase, ratio).toNumber(),
    })),
  )
}

// ---------------------------------------------------------------------------
// Snapshot correction (retrospective landed cost adjustments)
// ---------------------------------------------------------------------------

/**
 * When a cost layer's unitCostBase changes (e.g. landed cost arrives late),
 * all frozen costLayerSnapshot JSON entries referencing that layer must be
 * updated to reflect the new cost. Otherwise future refund reversals and
 * accounting reads will use the stale pre-adjustment cost.
 *
 * Updates snapshots on: ShipmentLine, OrderAllocation, SalesOrderRefundLine,
 * StockTransferLine — every model that carries a costLayerSnapshot.
 */
export async function updateSnapshotsForCostLayerChange(
  tx: TxClient,
  costLayerId: string,
  newUnitCostBase: DecimalInput,
): Promise<number> {
  const newUnitCost = toDecimal(newUnitCostBase)
  const serializedUnitCostBase = roundQuantity(newUnitCost, 6).toFixed(6)
  // PostgreSQL jsonb_set can't easily iterate arrays. Use a raw UPDATE
  // that rewrites the unitCostBase for every matching array element.
  // The query: for each row whose costLayerSnapshot contains an entry
  // with the given costLayerId, update that entry's unitCostBase.
  //
  // We use a CTE approach: load matching rows, rewrite the JSON array
  // in application code, and update back. This is simpler and safer
  // than raw jsonb manipulation for nested array-of-objects.

  let updated = 0

  const tables = [
    { model: 'shipment_lines' },
    { model: 'order_allocations' },
    { model: 'sales_order_refund_lines' },
    { model: 'stock_transfer_lines' },
  ] as const
  const containsCostLayer = JSON.stringify([{ costLayerId }])

  for (const table of tables) {
    // Find rows whose snapshot JSON mentions this cost layer id. FOR UPDATE locks
    // each matching row for the rest of the transaction so a concurrent
    // revaluation of another layer that shares the same snapshot row cannot
    // read-modify-write the JSON array in parallel and clobber this change — the
    // second locker blocks, then re-reads the committed array (cogs-audit scjz.7).
    // Stays on $queryRawUnsafe (a row-returning query) so the lock is held;
    // $executeRaw would not (enforced by the row-lock-queryraw gate).
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; costLayerSnapshot: unknown }>>(
      `SELECT id, "costLayerSnapshot" FROM "${table.model}" WHERE "costLayerSnapshot" @> $1::jsonb FOR UPDATE`,
      containsCostLayer,
    )

    for (const row of rows) {
      if (!Array.isArray(row.costLayerSnapshot)) continue
      let changed = false
      const changedEntries: Array<{
        previousUnitCostBase: unknown
        newUnitCostBase: string
        qty: unknown
      }> = []
      const patched = (row.costLayerSnapshot as Array<Record<string, unknown>>).map((entry) => {
        if (entry.costLayerId === costLayerId && !snapshotUnitCostMatches(entry.unitCostBase, newUnitCost, costLayerId)) {
          changed = true
          changedEntries.push({
            previousUnitCostBase: entry.unitCostBase,
            newUnitCostBase: serializedUnitCostBase,
            qty: entry.qty,
          })
          return serializeCostLayerSnapshot([{
            ...entry,
            costLayerId,
            qty: entry.qty as DecimalInput,
            unitCostBase: serializedUnitCostBase,
          }])[0]
        }
        return entry
      })
      if (changed) {
        await tx.$executeRawUnsafe(
          `UPDATE "${table.model}" SET "costLayerSnapshot" = $1::jsonb WHERE id = $2`,
          JSON.stringify(patched),
          row.id,
        )
        await recordCostLayerSnapshotRevaluation(tx, {
          tableName: table.model,
          rowId: row.id,
          costLayerId,
          previousSnapshotEntryCount: row.costLayerSnapshot.length,
          patchedSnapshotEntryCount: patched.length,
          changedEntries,
        })
        updated++
      }
    }
  }

  return updated
}

async function recordCostLayerSnapshotRevaluation(
  tx: TxClient,
  params: {
    tableName: string
    rowId: string
    costLayerId: string
    previousSnapshotEntryCount: number
    patchedSnapshotEntryCount: number
    changedEntries: Array<{
      previousUnitCostBase: unknown
      newUnitCostBase: string
      qty: unknown
    }>
  },
): Promise<void> {
  const client = tx as TxClient & {
    activityLog?: {
      create(args: {
        data: {
          entityType: 'SYSTEM'
          entityId: string
          action: string
          tag: string
          level: 'INFO'
          description: string
          metadata: Record<string, unknown>
        }
      }): Promise<unknown>
    }
  }
  if (!client.activityLog) return

  await client.activityLog.create({
    data: {
      entityType: 'SYSTEM',
      entityId: params.rowId,
      action: 'cost_layer_snapshot_revalued',
      tag: 'inventory',
      level: 'INFO',
      description: `Revalued ${params.tableName} cost-layer snapshot ${params.rowId} for cost layer ${params.costLayerId}`,
      metadata: {
        tableName: params.tableName,
        rowId: params.rowId,
        costLayerId: params.costLayerId,
        changedEntryCount: params.changedEntries.length,
        previousSnapshotEntryCount: params.previousSnapshotEntryCount,
        patchedSnapshotEntryCount: params.patchedSnapshotEntryCount,
        changedEntries: params.changedEntries,
      },
    },
  })
}

function snapshotUnitCostMatches(value: unknown, expected: Decimal, costLayerId: string): boolean {
  if (value == null || value === '') {
    warnMalformedSnapshotUnitCost(costLayerId, value)
    return false
  }

  try {
    return toDecimal(value as DecimalInput).eq(expected)
  } catch {
    warnMalformedSnapshotUnitCost(costLayerId, value)
    return false
  }
}

function warnMalformedSnapshotUnitCost(costLayerId: string, value: unknown): void {
  console.warn(
    `Malformed costLayerSnapshot unitCostBase for costLayerId=${costLayerId}; ` +
    `rewriting value=${formatSnapshotWarningValue(value)}`,
  )
}

function formatSnapshotWarningValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Sum physically returned quantity for a cost layer by reading refund-line
 * snapshots on refunds that actually returned stock to a warehouse.
 */
export async function getReturnedQtyForCostLayer(
  tx: TxClient,
  costLayerId: string,
): Promise<Decimal> {
  const containsCostLayer = JSON.stringify([{ costLayerId }])
  const rows = await tx.$queryRawUnsafe<Array<{ costLayerSnapshot: unknown }>>(
    `SELECT srl."costLayerSnapshot"
       FROM "sales_order_refund_lines" srl
       INNER JOIN "sales_order_refunds" sr ON sr.id = srl."refundId"
      WHERE sr."returnWarehouseId" IS NOT NULL
        AND srl."costLayerSnapshot" @> $1::jsonb`,
    containsCostLayer,
  )

  let returnedQty = toDecimal(0)
  for (const row of rows) {
    for (const entry of parseCostLayerSnapshot(row.costLayerSnapshot)) {
      if (entry.costLayerId === costLayerId) {
        returnedQty = addMoney(returnedQty, entry.qty)
      }
    }
  }

  return returnedQty
}

/**
 * Sum stock consumed by warehouse transfers (TRANSFER_OUT) for a cost layer.
 *
 * Sourced from stock_transfer_lines.costLayerSnapshot rather than cogs_entries:
 * transfer dispatch consumes source layers but writes NO cogs_entries (it freezes
 * a costLayerSnapshot on the line instead), so the cogsEntry-based exclusions are
 * structurally blind to it. That blindness is why 6oyu.19 went unnoticed while
 * every other exclusion was found.
 *
 * Transferred units are not customer COGS — the stock moved warehouse, it was not
 * sold — and their revaluation delta already reaches the destination layer via
 * propagateLandedCostToOutputs (transfer receipt links the destination layer back
 * to the source with a costLayerSourceLine). Counting them in netConsumedQty as
 * well double-posted the delta and stranded a permanent balance in transit.
 *
 * Status filter: bound from STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION, the total
 * per-status classification of whether the dispatch-time consumption of the source
 * layer is still OUTSTANDING. It is passed as a parameter rather than spelled out
 * here so the SQL and the classification cannot drift apart, and so a new
 * StockTransferStatus fails to compile until it is classified.
 *
 * The list is NOT derivable from STOCK_TRANSFER_TRANSITIONS: that map states
 * IN_TRANSIT -> RECEIVED as the only transition out of IN_TRANSIT, but
 * cancelDispatchedTransfer deliberately performs IN_TRANSIT -> CANCELLED outside
 * the machine and does NOT un-consume the original layers (it creates replacement
 * layers linked back by costLayerSourceLine). An earlier version of this query
 * hard-coded ('IN_TRANSIT', 'RECEIVED') on the strength of that map and so
 * re-opened 6oyu.19 for every cancelled dispatch: spurious COGS on the original
 * layer plus the propagated uplift on the replacement layer.
 */
export async function getTransferConsumedQtyForCostLayer(
  tx: TxClient,
  costLayerId: string,
): Promise<Decimal> {
  const containsCostLayer = JSON.stringify([{ costLayerId }])
  const rows = await tx.$queryRawUnsafe<Array<{ costLayerSnapshot: unknown }>>(
    `SELECT stl."costLayerSnapshot"
       FROM "stock_transfer_lines" stl
       INNER JOIN "stock_transfers" st ON st.id = stl."transferId"
      WHERE st.status = ANY($2::"StockTransferStatus"[])
        AND stl."costLayerSnapshot" @> $1::jsonb`,
    containsCostLayer,
    TRANSFER_STATUSES_WITH_OUTSTANDING_SOURCE_CONSUMPTION,
  )

  let transferredQty = toDecimal(0)
  for (const row of rows) {
    for (const entry of parseCostLayerSnapshot(row.costLayerSnapshot)) {
      if (entry.costLayerId === costLayerId) {
        transferredQty = addMoney(transferredQty, entry.qty)
      }
    }
  }

  return transferredQty
}

/**
 * Sum stock returned to suppliers for a cost layer. Supplier returns consume
 * FIFO layers but are not customer COGS, so landed-cost recalculation must
 * exclude them from retrospective COGS deltas.
 */
export async function getSupplierReturnedQtyForCostLayer(
  tx: TxClient,
  costLayerId: string,
): Promise<Decimal> {
  const rows = await tx.cogsEntry.findMany({
    where: {
      costLayerId,
      movement: { referenceType: 'PurchaseReturn' },
    },
    select: { qty: true },
  })
  return rows.reduce((sum, row) => addMoney(sum, row.qty), toDecimal(0))
}

/**
 * Movement types each revaluation-exclusion query below is responsible for.
 * These are kept as explicit per-query lists (rather than one merged query)
 * because the exclusions mean different things downstream (manufacturing's and
 * transfers' deltas are REDIRECTED into the output/destination layer, whereas a
 * reversal's is simply dropped) and, critically, they read from DIFFERENT
 * sources — cogs_entries vs stock_transfer_lines.costLayerSnapshot.
 *
 * Their union is asserted against MOVEMENT_COGS_RELEVANCE's derived
 * REVALUATION_EXCLUDED_MOVEMENT_TYPES in movement-cogs-relevance.test.ts, so
 * classifying a new movement type as EXCLUDE without giving it a query here is
 * a test failure rather than silent spurious COGS (6oyu.7).
 */
const MANUFACTURING_CONSUMPTION_MOVEMENT_TYPES: StockMovementType[] = ['PRODUCTION_OUT']
const REVERSAL_CONSUMPTION_MOVEMENT_TYPES: StockMovementType[] = ['PURCHASE_REVERSAL']
/** Sourced from the transfer-line snapshot, NOT cogs_entries — see 6oyu.19. */
const TRANSFER_CONSUMPTION_MOVEMENT_TYPES: StockMovementType[] = ['TRANSFER_OUT']

/** Every movement type actually subtracted by a revaluation-exclusion query. */
export const REVALUATION_EXCLUSION_QUERY_MOVEMENT_TYPES: StockMovementType[] = [
  ...MANUFACTURING_CONSUMPTION_MOVEMENT_TYPES,
  ...REVERSAL_CONSUMPTION_MOVEMENT_TYPES,
  ...TRANSFER_CONSUMPTION_MOVEMENT_TYPES,
]

/**
 * Sum stock consumed by manufacturing (PRODUCTION_OUT) for a cost layer.
 * Manufacturing consumption capitalises the component cost INTO the produced
 * output's cost layer — it is not customer COGS — so landed-cost recalculation
 * must exclude these units from the retrospective COGS delta (audit-jz9i).
 */
export async function getManufacturingConsumedQtyForCostLayer(
  tx: TxClient,
  costLayerId: string,
): Promise<Decimal> {
  const rows = await tx.cogsEntry.findMany({
    where: {
      costLayerId,
      movement: { type: { in: MANUFACTURING_CONSUMPTION_MOVEMENT_TYPES } },
    },
    select: { qty: true },
  })
  return rows.reduce((sum, row) => addMoney(sum, row.qty), toDecimal(0))
}

/**
 * Sum stock consumed by PO cancellation reversals (PURCHASE_REVERSAL) for a cost
 * layer. Cancellation reversals consume FIFO layers and write cogs_entries to
 * satisfy the outbound-evidence guard, but they are NOT customer COGS — the stock
 * was reversed out, not sold. Landed-cost recalculation must exclude these units
 * from the retrospective COGS delta, otherwise a later revaluation of a
 * partly-cancelled layer would post spurious COGS for reversed stock (cogs-audit
 * scjz.14; mirrors the audit-jz9i manufacturing exclusion).
 */
export async function getReversalConsumedQtyForCostLayer(
  tx: TxClient,
  costLayerId: string,
): Promise<Decimal> {
  const rows = await tx.cogsEntry.findMany({
    where: {
      costLayerId,
      movement: { type: { in: REVERSAL_CONSUMPTION_MOVEMENT_TYPES } },
    },
    select: { qty: true },
  })
  return rows.reduce((sum, row) => addMoney(sum, row.qty), toDecimal(0))
}

export type DependentOutputSourceLine = {
  sourceLineId: string
  outputCostLayerId: string
  qty: Decimal
}

/**
 * Find the cost-layer source lines (produced-output ← source layer) where the
 * given layer is the SOURCE — i.e. the manufactured output layers that consumed
 * this layer as a component. Used to propagate a retrospective landed-cost change
 * on a component layer into the produced output layers it fed (audit-e7h8).
 */
export async function getDependentOutputSourceLines(
  tx: TxClient,
  sourceCostLayerId: string,
): Promise<DependentOutputSourceLine[]> {
  const rows = await tx.costLayerSourceLine.findMany({
    where: { sourceCostLayerId },
    select: { id: true, costLayerId: true, qty: true },
  })
  return rows.map((row) => ({
    sourceLineId: row.id,
    outputCostLayerId: row.costLayerId,
    qty: toDecimal(row.qty),
  }))
}

export type ShipmentCogsRefreshResult = {
  /** Number of shipments whose stored COGS was recomputed. */
  shipmentsUpdated: number
  /**
   * Total COGS revaluation (newCogs − oldCogs, base currency) that the SHIPMENT
   * path now owns for this cost-layer change — i.e. the change to already-sold
   * goods' COGS that is either posted now (journaled shipments → COGS_REVERSAL)
   * or will be posted by the daily batch (un-journaled shipments → updated
   * cogsBatchAmount). Callers that ALSO compute a retrospective COGS journal must
   * subtract this so the same sold-unit delta is not posted to COGS twice
   * (audit-3aph).
   */
  cogsRevaluationDelta: Decimal
}

/**
 * Recompute stored shipment-level COGS for any shipment whose line snapshots
 * reference the changed cost layer. This keeps shipment COGS aligned with
 * retrospective landed-cost changes, including shipments already journaled.
 *
 * Returns the COGS revaluation delta the shipment path owns (see
 * ShipmentCogsRefreshResult.cogsRevaluationDelta) — callers computing their own
 * COGS journal must subtract it to avoid double-posting COGS for sold goods.
 */
export async function refreshShipmentCogsForCostLayerChange(
  tx: TxClient,
  costLayerId: string,
  options: ShipmentCogsRevaluationSyncOptions = {},
): Promise<ShipmentCogsRefreshResult> {
  // o3d-c08y r2: BEFORE anything is read or written — the refusal below only means something on a
  // client whose transaction can actually be aborted. See JournaledShipmentRevaluationContextError.
  await assertRevaluationRefusalCanRefuseEffectively(tx, costLayerId)
  const containsCostLayer = JSON.stringify([{ costLayerId }])
  const shipments = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT DISTINCT "shipmentId" AS id FROM "shipment_lines" WHERE "costLayerSnapshot" @> $1::jsonb`,
    containsCostLayer,
  )

  // o3d-c08y: A WHOLE-SET PRE-PASS, READ-ONLY. Every shipment's new COGS is computed before any of
  // them is written, so a refusal on the third shipment cannot follow two shipments' writes. (The
  // transaction abort would undo those too; "nothing this function wrote" is simply the stronger and
  // easier property to check.)
  const planned: Array<{
    id: string
    current: { cogsBatchAmount: Prisma.Decimal | null; shipmentJournalDate: Date | null } | null
    cogs: number
  }> = []
  for (const shipment of shipments) {
    const currentShipment = await tx.shipment.findUnique({
      where: { id: shipment.id },
      select: { cogsBatchAmount: true, shipmentJournalDate: true },
    })
    const lines = await tx.shipmentLine.findMany({
      where: { shipmentId: shipment.id },
      select: { costLayerSnapshot: true },
    })
    const cogsTotal = lines.reduce(
      (sum, line) => addMoney(sum, sumCostLayerSnapshot(parseCostLayerSnapshot(line.costLayerSnapshot))),
      toDecimal(0),
    )
    planned.push({ id: shipment.id, current: currentShipment, cogs: roundQuantity(cogsTotal, 2).toNumber() })
  }

  // o3d-c08y: AN ALREADY-JOURNALED SHIPMENT MAY NOT BE REVALUED BELOW ZERO. Its revaluation posts as a
  // reverse-old / post-new COGS_REVERSAL, each leg gated on its own side being positive, so the negative
  // repost used to be dropped while this function still claimed the WHOLE delta as shipment-owned — and
  // the caller subtracted it from its own COGS journal. The ledger moved by the reversal alone, the
  // rest posted nowhere, and the COGS subledger recorded the full delta. A negative basis is o3d-gd2f's
  // open decision and is not represented, so this REFUSES instead, before writing anything, and aborts
  // the enclosing transaction so the layer's new cost and the rewritten snapshots roll back with it.
  // A negative OLD side is refused too: that journal would drop the reversal leg the same way.
  //
  // An UN-journaled shipment is deliberately not refused here: nothing has been posted for it, its
  // cogsBatchAmount is what the daily batch will post, and the batch refuses a negative Group B basis
  // visibly on its own (o3d-sidy).
  //
  // THAT HANDOVER IS ONLY SOUND BECAUSE THE BATCH READS THE SNAPSHOT UNDER THE COST-LAYER LOCK
  // (o3d-c08y r2, Codex HIGH). It did not: Group B loaded the shipment window
  // first and locked afterwards, so a batch already parked on the lock resumed from its stale POSITIVE
  // copy, posted the positive COGS journal and stamped shipmentJournalDate — reproduced end to end on
  // a scratch database. Group B now probes ids, locks, and then reads the data under the lock, so an
  // un-journaled shipment this function drives negative is refused by the batch on the committed value
  // (per order, nothing stamped, in result.errors and an ERROR entry, retried next run) and a batch
  // that got there first makes the shipment JOURNALED, which brings it back to the refusal above. See
  // lib/domain/accounting/daily-batch-group-b-lock.ts and
  // tests/concurrency/daily-batch-group-b-stale-snapshot.concurrent.test.ts.
  const refused = planned.filter((plan) => plan.current?.shipmentJournalDate
    && (toDecimal(plan.cogs).lt(0) || toDecimal(plan.current.cogsBatchAmount ?? 0).lt(0)))
  if (refused.length > 0) {
    await refuseJournaledShipmentRevaluation(tx, costLayerId, refused.map((plan) => ({
      shipmentId: plan.id,
      oldCogsBase: roundQuantity(plan.current?.cogsBatchAmount ?? 0, 2).toFixed(2),
      newCogsBase: toDecimal(plan.cogs).toFixed(2),
    })), options)
  }

  let updated = 0
  let cogsRevaluationDelta = toDecimal(0)
  // Resolved lazily on the first un-journaled shipment, then reused, so a
  // settings read happens at most once per call (audit-gbzh).
  let dailyBatchPosts: boolean | null = null
  for (const { id: shipmentId, current: currentShipment, cogs } of planned) {
    const shipment = { id: shipmentId }
    // (newCogs − oldCogs) is the layer-revaluation delta for this shipment (only
    // this layer's snapshot cost changed).
    const shipmentDelta = subtractMoney(toDecimal(cogs), toDecimal(currentShipment?.cogsBatchAmount ?? 0))
    await tx.shipment.update({
      where: { id: shipment.id },
      data: { cogsBatchAmount: cogs },
    })
    if (currentShipment?.shipmentJournalDate) {
      // Already journaled → the revaluation posts NOW via COGS_REVERSAL. Only
      // count it as shipment-owned (so the caller drops it from the COGS journal)
      // if that posting is actually enabled; otherwise leave it for the journal so
      // the delta isn't lost (audit-3aph).
      const posted = await queueShipmentCogsRevaluationSync(tx, {
        shipmentId: shipment.id,
        costLayerId,
        oldCogsBase: currentShipment.cogsBatchAmount,
        newCogsBase: cogs,
      }, options)
      if (posted) cogsRevaluationDelta = addMoney(cogsRevaluationDelta, shipmentDelta)
    } else {
      // Not yet journaled → the daily batch posts the updated cogsBatchAmount
      // (new cost), so the shipment path owns this delta — but ONLY if the daily
      // batch is actually enabled; otherwise it posts nowhere, so leave the delta
      // in the COGS journal (audit-gbzh).
      if (dailyBatchPosts === null) {
        dailyBatchPosts = await (options.isDailyBatchPostingEnabled ?? isDailyBatchPostingEnabled)()
      }
      if (dailyBatchPosts) cogsRevaluationDelta = addMoney(cogsRevaluationDelta, shipmentDelta)
    }
    updated++
  }

  return { shipmentsUpdated: updated, cogsRevaluationDelta }
}

/** Raised on purpose to put the enclosing transaction into aborted state (o3d-c08y). */
const JOURNALED_REVALUATION_ABORT_SENTINEL = 'journaled_shipment_revaluation_refused'

/**
 * o3d-c08y r2 — WHAT THE OPERATOR SHOULD ACTUALLY DO, which is not the same sentence for all three
 * operations that can reach this refusal.
 *
 *  - A SAVE (a freight PO's cost lines, a goods PO's additional costs): correct the credit and save
 *    again. This was the only case round 1 wrote for.
 *  - A FREIGHT-PO CANCELLATION: there is no save to repeat. The cancellation is what drives the layer
 *    negative — it removes this PO's positive uplift while a credit on ANOTHER PO stays — and the
 *    cancelled PO's own cost lines are excluded from the recalc (`freightPO: { status: { not:
 *    'CANCELLED' } }`), so they are not among the lines named here either. Telling the operator to
 *    "save again" points at the wrong document.
 *  - A PRODUCTION-ORDER RECOMPUTE: manufacturing rejects negative cost lines outright, so the credit
 *    is never on the production order. It is on the purchase order that supplied a component, and the
 *    recompute merely carried the component layer's cost through to the finished goods.
 */
function buildRefusalRemedy(
  context: ShipmentRevaluationContext | null,
  creditLines: { count: number; named: string },
): string {
  const namedCreditLines = creditLines.named
  const correct = creditLines.count > 0
    ? `Correct the credit cost line${creditLines.count === 1 ? '' : 's'} that drove the layer negative — ${namedCreditLines}`
    : 'Correct the credit cost line (a negative freight or additional cost) that drove the layer negative'

  if (context?.operation === 'cancel_freight_po') {
    return `This CANCELLATION is refused, so the freight PO is still active. Cancelling it removes its own uplift `
      + 'from the cost layer while a credit elsewhere stays, which is what takes the shipment below zero; the '
      + 'cancelled PO\'s own cost lines are excluded from the recalculation and so are not listed here. '
      + `${correct} — on whichever purchase order still carries it — and then cancel this freight PO again.`
  }
  if (context?.operation === 'recompute_production_order' || context?.source === 'manufacturing_recompute') {
    return 'A production order cannot be recosted below zero, and manufacturing does not accept negative cost '
      + 'lines: the negative basis comes from a COMPONENT cost layer, i.e. a credit freight or additional cost on '
      + `the purchase order that supplied it${namedCreditLines ? ` (${namedCreditLines})` : ''}. Correct that credit `
      + 'on the purchase order, then recompute this production order.'
  }
  return `${correct} — and save again.`
}

/**
 * o3d-c08y: report, abort, throw — in that order, and never return.
 *
 * REPORT FIRST, on its own connection: the abort below rolls back everything written through `tx`,
 * so an entry written there would vanish with the revaluation it describes.
 *
 * ABORT SECOND: a caller that catches the error cannot then commit the layer's new cost and the
 * rewritten snapshots, because Postgres refuses every further statement in an aborted transaction and
 * turns its COMMIT into a ROLLBACK. Same mechanism as the transfer re-layering refusal
 * (transfer-cost-layer-recreation.ts), including its entry precondition (o3d-c08y r2 — see
 * JournaledShipmentRevaluationContextError), so a client that cannot be aborted is refused rather
 * than silently skipping the abort.
 */
async function refuseJournaledShipmentRevaluation(
  tx: TxClient,
  costLayerId: string,
  shipments: RefusedJournaledShipment[],
  options: ShipmentCogsRevaluationSyncOptions,
): Promise<never> {
  const context = options.revaluationContext ?? null
  const creditLines = context?.creditCostLines ?? []
  const shipmentText = shipments
    .map((shipment) => `${shipment.shipmentId} (COGS ${shipment.oldCogsBase} -> ${shipment.newCogsBase})`)
    .join(', ')
  const driver = context?.productionOrderId
    ? `production order ${context.productionOrderId}`
    : context?.primaryPoReference
      ? `purchase order ${context.primaryPoReference}${context.freightPoId ? ` (freight PO ${context.freightPoId})` : ''}`
      : 'the purchase order that owns this cost layer'
  const namedCreditLines = creditLines
    .map((line) => `line ${line.freightCostLineId} on ${line.purchaseOrderReference ?? line.purchaseOrderId} (${line.amountBase})`)
    .join('; ')
  const remedy = buildRefusalRemedy(context, { count: creditLines.length, named: namedCreditLines })
  const message = `Landed-cost revaluation REFUSED for cost layer ${costLayerId} (${driver}): it would take `
    + `already-journaled shipment${shipments.length === 1 ? '' : 's'} ${shipmentText} below zero. IMS cannot post a `
    + 'negative shipment COGS (o3d-gd2f): the revaluation journal would reverse the old COGS and drop the negative '
    + 'repost, so the difference would post nowhere. NOTHING WAS CHANGED: the cost layer, the shipment snapshots, '
    + 'the shipment COGS and the accounting sync queue are as they were, and this transaction has been aborted. '
    + `${remedy} (o3d-c08y)`
  const refusal: JournaledShipmentRevaluationRefusal = { costLayerId, shipments, context, message }

  let logged = false
  try {
    logged = await (options.logRefusal ?? defaultLogJournaledShipmentRevaluationRefusal)(refusal)
  } catch (error) {
    console.error('refuseJournaledShipmentRevaluation: the ERROR activity entry could not be written', error)
  }
  console.error(message)

  // Checked OUTSIDE the try on purpose (as the transfer refusal does): inside it, a client with no
  // $executeRaw would raise a TypeError the catch below would read as "the abort statement failed",
  // i.e. as success — a hole precisely where this must have none. The entry precondition has already
  // refused such a client; this is the second lock on the same door, because it is this line that
  // would otherwise SKIP the abort and throw a refusal a caller could swallow.
  if (typeof (tx as { $executeRaw?: unknown }).$executeRaw !== 'function') {
    throw new JournaledShipmentRevaluationContextError(
      'no_raw_access',
      `${message} ALSO: this client exposes no $executeRaw, so the enclosing transaction could not be aborted `
      + 'and a caller that caught the refusal could still commit the revaluation. Refusing without that '
      + 'guarantee (o3d-c08y).',
    )
  }
  let aborted = false
  try {
    await tx.$executeRaw`SELECT CAST(${JOURNALED_REVALUATION_ABORT_SENTINEL} AS int)`
  } catch {
    aborted = true // EXPECTED: this statement exists to fail.
  }
  if (!aborted) {
    throw new Error(
      `${message} ALSO: the deliberate abort statement SUCCEEDED, so the enclosing transaction may still be `
      + 'writable. Refusing regardless.',
    )
  }
  throw new JournaledShipmentRevaluationRefusedError(refusal, logged)
}

async function defaultLogJournaledShipmentRevaluationRefusal(
  refusal: JournaledShipmentRevaluationRefusal,
): Promise<boolean> {
  const { logActivityPersisted } = await import('@/lib/activity-log')
  return logActivityPersisted({
    entityType: 'SYSTEM',
    entityId: refusal.shipments[0]?.shipmentId ?? null,
    action: 'landed_cost_revaluation_refused_journaled_shipment',
    tag: 'accounting',
    level: 'ERROR',
    description: refusal.message,
    metadata: {
      costLayerId: refusal.costLayerId,
      shipments: refusal.shipments,
      context: refusal.context,
    },
    resolveUser: false,
  })
}

export async function refreshSalesOrderLineCogs(
  tx: TxClient,
  lineIds: string[],
): Promise<number> {
  const uniqueLineIds = [...new Set(lineIds)]
  if (uniqueLineIds.length === 0) return 0

  // Only SHIPPED shipment lines carry a COGS snapshot (it is written at dispatch).
  // Excluding PENDING/PICKING/PACKED lines keeps the mixed-snapshot detection below
  // from treating a not-yet-dispatched partial as a desync — those legitimately
  // have no snapshot yet (scjz.24).
  const shipmentLines = await tx.shipmentLine.findMany({
    where: { lineId: { in: uniqueLineIds }, shipment: { status: 'SHIPPED' } },
    select: { lineId: true, costLayerSnapshot: true },
  })

  const cogsByLineId = new Map<string, Decimal>()
  const snapshotCountByLineId = new Map<string, number>()
  const shipmentLineCountByLineId = new Map<string, number>()
  for (const shipmentLine of shipmentLines) {
    const snapshot = parseCostLayerSnapshot(shipmentLine.costLayerSnapshot)
    shipmentLineCountByLineId.set(
      shipmentLine.lineId,
      (shipmentLineCountByLineId.get(shipmentLine.lineId) ?? 0) + 1,
    )
    cogsByLineId.set(
      shipmentLine.lineId,
      addMoney(
        cogsByLineId.get(shipmentLine.lineId) ?? toDecimal(0),
        sumCostLayerSnapshot(snapshot),
      ),
    )
    if (snapshot.length > 0) {
      snapshotCountByLineId.set(
        shipmentLine.lineId,
        (snapshotCountByLineId.get(shipmentLine.lineId) ?? 0) + 1,
      )
    }
  }

  let updated = 0
  for (const lineId of uniqueLineIds) {
    const cogs = cogsByLineId.get(lineId)
    const totalShipmentLines = shipmentLineCountByLineId.get(lineId) ?? 0
    const snapshottedShipmentLines = snapshotCountByLineId.get(lineId) ?? 0
    if (totalShipmentLines > 0 && snapshottedShipmentLines === 0) {
      // Legacy shipped lines may pre-date shipment FIFO snapshots. Preserve
      // their existing COGS instead of nulling historical margin during a
      // retrospective landed-cost refresh.
      continue
    }
    if (totalShipmentLines > 0 && snapshottedShipmentLines < totalShipmentLines) {
      // Mixed snapshot presence: some shipment lines for this sales line carry a
      // FIFO snapshot and others don't (e.g. a partial's snapshot was cleared
      // between batch runs). Summing only the snapshotted subset would understate
      // COGS / overstate margin, so preserve the prior cogsBase and flag for
      // reconciliation rather than writing a partial total.
      console.warn(
        `refreshSalesOrderLineCogs: sales line ${lineId} has mixed shipment-snapshot presence ` +
        `(${snapshottedShipmentLines}/${totalShipmentLines} shipment lines snapshotted); ` +
        `preserving prior cogsBase instead of summing a partial set.`,
      )
      continue
    }
    await tx.salesOrderLine.update({
      where: { id: lineId },
      data: {
        cogsBase: cogs == null ? null : roundQuantity(cogs, 4).toNumber(),
      },
    })
    updated++
  }

  return updated
}

export async function refreshSalesOrderLineCogsForCostLayerChange(
  tx: TxClient,
  costLayerId: string,
): Promise<number> {
  const containsCostLayer = JSON.stringify([{ costLayerId }])
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT DISTINCT "lineId" AS id FROM "shipment_lines" WHERE "costLayerSnapshot" @> $1::jsonb`,
    containsCostLayer,
  )
  return refreshSalesOrderLineCogs(tx, rows.map((row) => row.id))
}
