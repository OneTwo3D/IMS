/**
 * Shared FIFO cost layer helpers.
 *
 * These are used by stock adjustments, transfers, manufacturing, and any
 * other path that needs to consume or create cost layers atomically.
 * All functions accept a Prisma TransactionClient so they can participate
 * in the caller's transaction.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings, isAccountingSyncTypeEnabled, isDailyBatchPostingEnabled, queueAccountingSyncTx } from '@/lib/accounting'
import { parseCostLayerSnapshot, serializeCostLayerSnapshot, sumCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { getInventoryConstraintMessage } from '@/lib/domain/inventory/prisma-errors'
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
  if (oldCogs.sub(newCogs).abs().lt(0.01)) return null

  return {
    date: new Date().toISOString().slice(0, 10),
    reference: `Shipment COGS revaluation: ${input.shipmentId}`,
    narration: `Reverse and repost shipment COGS after cost-layer revaluation for shipment ${input.shipmentId}`,
    // Use a 4-line reverse + repost journal rather than a 2-line delta so the
    // accounting audit trail shows both the old and recomputed shipment COGS.
    lines: [
      { accountCode: input.inventoryAccount, description: `Reverse old shipment COGS ${input.shipmentId}`, debit: oldCogs.toNumber() },
      { accountCode: input.cogsAccount, description: `Reverse old shipment COGS ${input.shipmentId}`, credit: oldCogs.toNumber() },
      { accountCode: input.cogsAccount, description: `Post revalued shipment COGS ${input.shipmentId}`, debit: newCogs.toNumber() },
      { accountCode: input.inventoryAccount, description: `Post revalued shipment COGS ${input.shipmentId}`, credit: newCogs.toNumber() },
    ],
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

  await (options.queueAccountingSync ?? queueAccountingSyncTx)(tx, {
    type: 'COGS_REVERSAL',
    referenceType: 'Shipment',
    referenceId: input.shipmentId,
    idempotencyKey: `shipment-cogs-revalue:${input.shipmentId}:${input.costLayerId}:${payload.oldCogsBase}:${payload.newCogsBase}`,
    payload,
  })
  return true
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
  if (result.remainingQty.gt(0.0001)) {
    throw new Error(
      `Insufficient FIFO layers for product ${productId} in warehouse ${warehouseId}: ` +
      `needed ${qty}, only ${subtractMoney(qty, result.remainingQty).toString()} available in cost layers`,
    )
  }
  // audit-snxr: the sub-0.0001 tolerance above lets a tiny positive consume slip
  // through with NOTHING consumed when there are no cost layers at all (stock /
  // cost-layer desync). Callers build cogs_entries only when consumed is
  // non-empty, so a zero-evidence outbound movement would be written and then
  // rejected by the deferred reporting-evidence guard at COMMIT (a confusing
  // P2028). A positive consumption with no FIFO provenance is a hard error here —
  // fail clearly before the movement is written rather than booking uncosted stock.
  if (qty > 0 && result.consumed.length === 0) {
    throw new Error(
      `No FIFO cost layers to consume for product ${productId} in warehouse ${warehouseId}: ` +
      `cannot record a costed outbound movement of ${qty} (stock/cost-layer desync — repair the cost layers).`,
    )
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
  const ratio = rawRatio.gt(1) ? toDecimal(1) : rawRatio
  if (ratio.lte(0)) return 0
  if (rawRatio.gt('1.000001')) {
    console.warn(
      `copyCostLayerSourceLinesProportionally capped ratio at 1 for ${fromCostLayerId} -> ${toCostLayerId} ` +
      `(copiedQty=${copiedQtyDecimal.toString()}, sourceReceivedQty=${sourceReceivedQty.toString()})`,
    )
  }

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
    // Find rows whose snapshot JSON mentions this cost layer id
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; costLayerSnapshot: unknown }>>(
      `SELECT id, "costLayerSnapshot" FROM "${table.model}" WHERE "costLayerSnapshot" @> $1::jsonb`,
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
      movement: { type: 'PRODUCTION_OUT' },
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
  const containsCostLayer = JSON.stringify([{ costLayerId }])
  const shipments = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT DISTINCT "shipmentId" AS id FROM "shipment_lines" WHERE "costLayerSnapshot" @> $1::jsonb`,
    containsCostLayer,
  )

  let updated = 0
  let cogsRevaluationDelta = toDecimal(0)
  // Resolved lazily on the first un-journaled shipment, then reused, so a
  // settings read happens at most once per call (audit-gbzh).
  let dailyBatchPosts: boolean | null = null
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
    const cogs = roundQuantity(cogsTotal, 2).toNumber()
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

export async function refreshSalesOrderLineCogs(
  tx: TxClient,
  lineIds: string[],
): Promise<number> {
  const uniqueLineIds = [...new Set(lineIds)]
  if (uniqueLineIds.length === 0) return 0

  const shipmentLines = await tx.shipmentLine.findMany({
    where: { lineId: { in: uniqueLineIds } },
    select: { lineId: true, costLayerSnapshot: true },
  })

  const cogsByLineId = new Map<string, Decimal>()
  const hasSnapshotByLineId = new Map<string, boolean>()
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
      hasSnapshotByLineId.set(shipmentLine.lineId, true)
    }
  }

  let updated = 0
  for (const lineId of uniqueLineIds) {
    const cogs = cogsByLineId.get(lineId)
    const hasShipmentLines = (shipmentLineCountByLineId.get(lineId) ?? 0) > 0
    if (hasShipmentLines && !hasSnapshotByLineId.get(lineId)) {
      // Legacy shipped lines may pre-date shipment FIFO snapshots. Preserve
      // their existing COGS instead of nulling historical margin during a
      // retrospective landed-cost refresh.
      continue
    }
    await tx.salesOrderLine.update({
      where: { id: lineId },
      data: {
        cogsBase: cogs == null || !hasSnapshotByLineId.get(lineId)
          ? null
          : roundQuantity(cogs, 4).toNumber(),
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
