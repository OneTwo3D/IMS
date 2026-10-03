import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'

/**
 * Shared DB-tier fixtures for the o3d-nrl4 PR B in-transit residue arms. NOT a test file: imported by
 * tests/concurrency/*.concurrent.test.ts AFTER their own `./scratch-database-setup` import and module
 * mocks, and it reaches the application only through dynamic `import()`, so nothing opens the pool first.
 *
 * EVERY ROW IS UNIQUE PER CALL (the tier shares one `ims_ci` database with every other file and every
 * earlier run): a `randomUUID()` of 20 hex characters inside every code, sku, reference and name, never
 * truncated away. Nothing here names a database role.
 */

export function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  return process.env.DATABASE_URL
}

export const INVENTORY_ACCOUNT = '630'
export const TRANSIT_ACCOUNT = '631'

/** Switch the accounting connector on so the enqueue reaches its INSERT instead of answering `not-configured`. */
export async function setJournalPosting(enabled: boolean): Promise<void> {
  const { db } = await import('@/lib/db')
  for (const [key, value] of [
    ['plugin_xero_enabled', enabled ? 'true' : 'false'],
    ['xero_sync_enabled', enabled ? 'true' : 'false'],
    ['xero_sync_stock_receipt', 'submitted'],
    ['xero_inventory_account', INVENTORY_ACCOUNT],
    ['xero_transit_account', TRANSIT_ACCOUNT],
  ] as Array<[string, string]>) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
}

export type WorldOptions = {
  /** Units on the goods line (and on its one cost layer at the start). */
  lineQty?: number
  /** Base unit cost of the goods line. */
  unitCost?: number
  /** The linked freight order's one cost line, BY_VALUE. */
  freightAmount?: number
  /** Units dispatched from the layer on the transfer (the layer's remaining is lineQty - transferQty). */
  transferQty?: number
  transferStatus?: 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED'
  /** `stock_transfer_lines.qtyReceived` (a manual partial receipt). */
  qtyReceived?: number
  /** Units a WMS alignment credited on `wms_asn_line_maps.qtyAccountedViaSnapshot` (qtyReceived untouched). */
  alignmentCredit?: number
  /**
   * Units already LANDED at the destination, each as a linked destination layer (a partial receipt or an
   * alignment leaves the transfer IN_TRANSIT with this much of it layered at W2).
   */
  landedLayerQty?: number
}

export type World = {
  tag: string
  supplierId: string
  productId: string
  w1: string
  w2: string
  goodsId: string
  goodsLineId: string
  layerId: string
  freightId: string
  freightCostLineId: string
  transferId: string
  transferLineId: string
  destLayerId: string | null
  unitCost: number
  freightAmount: number
  lineQty: number
  transferQty: number
}

export function uid(): string {
  return randomUUID().replace(/-/g, '').slice(0, 20)
}

/**
 * ONE goods order (lineQty @ unitCost) whose single cost layer sits at W1; `transferQty` of it is on ONE
 * transfer W1 -> W2 (IN_TRANSIT unless told otherwise), the snapshot naming the layer; ONE freight order
 * carrying `freightAmount` BY_VALUE is linked and NOT yet applied, so the revaluation takes the layer from
 * `unitCost` to `unitCost + freightAmount / lineQty`.
 */
export async function seedWorld(label: string, options: WorldOptions = {}): Promise<World> {
  const { db } = await import('@/lib/db')
  const lineQty = options.lineQty ?? 100
  const unitCost = options.unitCost ?? 10
  const freightAmount = options.freightAmount ?? 200
  const transferQty = options.transferQty ?? lineQty
  const status = options.transferStatus ?? 'IN_TRANSIT'
  const qtyReceived = options.qtyReceived ?? 0
  const alignmentCredit = options.alignmentCredit ?? 0
  const landedLayerQty = options.landedLayerQty ?? 0
  const tag = `NRL4B-${label}-${uid()}`
  const now = new Date()
  const w1 = await db.warehouse.create({ data: { code: `${tag}-1`, name: `${tag} w1`, type: 'STANDARD' }, select: { id: true } })
  const w2 = await db.warehouse.create({ data: { code: `${tag}-2`, name: `${tag} w2`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `supplier ${tag}`, currency: 'GBP', active: true }, select: { id: true } })
  const product = await db.product.create({ data: { sku: tag, name: `product ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const total = lineQty * unitCost
  const goods = await db.purchaseOrder.create({
    data: {
      reference: `PO-${tag}`, type: 'GOODS', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: total, subtotalBase: total, taxForeign: 0, taxBase: 0, totalForeign: total, totalBase: total,
      destinationWarehouseId: w1.id, receivedAt: now,
      lines: {
        create: [{
          productId: product.id, description: product.id, qty: lineQty, unitCostForeign: unitCost, unitCostBase: unitCost,
          totalForeign: total, totalBase: total, landedUnitCostBase: unitCost, qtyReceived: lineQty, qtyReturned: 0, sortOrder: 0,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const layer = await db.costLayer.create({
    data: {
      productId: product.id, warehouseId: w1.id, receivedQty: lineQty, remainingQty: lineQty - transferQty, unitCostBase: unitCost,
      receivedAt: new Date(now.getTime() - 60_000), poLineId: goods.lines[0]!.id, isOpeningStock: false,
    },
    select: { id: true },
  })
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `PO-F-${tag}`, type: 'FREIGHT', supplierId: supplier.id, status: 'PO_SENT', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: freightAmount, subtotalBase: freightAmount, taxForeign: 0, taxBase: 0, totalForeign: freightAmount, totalBase: freightAmount,
      freightCostLines: { create: [{ description: 'Freight', amountForeign: freightAmount, amountBase: freightAmount, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 }] },
      asFreightFor: { create: [{ primaryPoId: goods.id, method: 'BY_VALUE', allocated: false }] },
    },
    select: { id: true, freightCostLines: { select: { id: true } } },
  })
  const transfer = await db.stockTransfer.create({
    data: {
      reference: `T-${tag}`, fromWarehouseId: w1.id, toWarehouseId: w2.id, status: status, dispatchedAt: now,
      lines: {
        create: [{
          productId: product.id, sku: tag, productName: tag, qty: `${transferQty}.0000`, qtyReceived: `${qtyReceived}.0000`,
          costLayerSnapshot: [{ costLayerId: layer.id, qty: `${transferQty}.000000`, unitCostBase: `${unitCost}.000000` }],
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const transferLineId = transfer.lines[0]!.id
  let destLayerId: string | null = null
  if (landedLayerQty > 0) {
    const dest = await db.costLayer.create({
      data: { productId: product.id, warehouseId: w2.id, receivedQty: landedLayerQty, remainingQty: landedLayerQty, unitCostBase: unitCost, receivedAt: now },
      select: { id: true },
    })
    await db.costLayerSourceLine.create({
      data: {
        costLayerId: dest.id, sourceProductId: product.id, sourceCostLayerId: layer.id,
        qty: landedLayerQty, unitCostBase: unitCost, totalCostBase: landedLayerQty * unitCost,
      },
    })
    destLayerId = dest.id
  }
  if (alignmentCredit > 0) {
    await db.wmsAsnMap.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: o3d-nrl4 PR B: a test fixture row, not a core flow branch
        externalAsnId: tag,
        sourceType: 'STOCK_TRANSFER',
        sourceId: transfer.id,
        warehouseId: w2.id,
        status: 'OPEN',
        lines: {
          create: [{
            externalAsnLineId: `${tag}-1`, sourceType: 'STOCK_TRANSFER_LINE', sourceLineId: transferLineId,
            productId: product.id, sku: tag, expectedQty: `${transferQty}.0000`,
            qtyAccountedViaSnapshot: `${alignmentCredit}.0000`, qtyAccountedViaReceipt: '0.0000',
          }],
        },
      },
    })
  }
  return {
    tag, supplierId: supplier.id, productId: product.id, w1: w1.id, w2: w2.id, goodsId: goods.id, goodsLineId: goods.lines[0]!.id,
    layerId: layer.id, freightId: freight.id, freightCostLineId: freight.freightCostLines[0]!.id,
    transferId: transfer.id, transferLineId, destLayerId, unitCost, freightAmount, lineQty, transferQty,
  }
}

/** The recalculation exactly as the three production callers run it: scope lock, then the recalculation, on `tx`. */
export async function lockAndRecalculate(tx: unknown, freightId: string, reason: 'freight_purchase_order_costs_updated' | 'freight_purchase_order_cancelled' = 'freight_purchase_order_costs_updated') {
  const { lockLandedCostRevaluationScope } = await import('@/lib/domain/wms/transfer-asn-lock-order')
  const { recalculateLandedCosts } = await import('@/lib/domain/purchasing/landed-cost-service')
  const scope = await lockLandedCostRevaluationScope(tx as never, { freightPoId: freightId })
  const result = await recalculateLandedCosts(tx as never, freightId, undefined, {
    triggeredById: null, reason, scheduleAdjustmentJournals: true,
  })
  return { scope, result }
}

/** Recalculate in its own transaction. */
export async function recalculate(world: Pick<World, 'freightId'>, reason: 'freight_purchase_order_costs_updated' | 'freight_purchase_order_cancelled' = 'freight_purchase_order_costs_updated') {
  const { db } = await import('@/lib/db')
  return db.$transaction((tx) => lockAndRecalculate(tx, world.freightId, reason), { timeout: 60_000, maxWait: 10_000 })
}

/** The post-commit journal step, exactly as the callers run it. */
export async function postJournals(result: unknown) {
  const { queueLandedCostAdjustmentJournals } = await import('@/lib/domain/purchasing/landed-cost-service')
  return queueLandedCostAdjustmentJournals(result as never)
}

export async function layerUnitCost(layerId: string): Promise<number> {
  const { db } = await import('@/lib/db')
  const row = await db.costLayer.findUniqueOrThrow({ where: { id: layerId }, select: { unitCostBase: true } })
  return Number(row.unitCostBase)
}

export async function snapshotUnitCost(transferLineId: string): Promise<number> {
  const { db } = await import('@/lib/db')
  const row = await db.stockTransferLine.findUniqueOrThrow({ where: { id: transferLineId }, select: { costLayerSnapshot: true } })
  const snapshot = row.costLayerSnapshot as Array<{ unitCostBase: string }>
  assert.equal(snapshot.length >= 1, true, 'the snapshot has an entry')
  return Number(snapshot[0]!.unitCostBase)
}

export type Journal = {
  id: string
  type: string
  key: string
  debit: Array<{ accountCode?: string; amount: number }>
  credit: Array<{ accountCode?: string; amount: number }>
}

/** The STOCK_IN_TRANSIT journals queued for the goods order, oldest first, with the lines unpacked. */
export async function reclassJournals(goodsId: string): Promise<Journal[]> {
  const { db } = await import('@/lib/db')
  const rows = await db.accountingSyncLog.findMany({
    where: { type: 'STOCK_IN_TRANSIT', referenceType: 'PurchaseOrder', referenceId: goodsId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, payload: true },
  })
  return rows.map((row) => {
    const payload = row.payload as { _idempotencyKey?: string; lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> }
    const lines = payload.lines ?? []
    return {
      id: row.id,
      type: row.type,
      key: String(payload._idempotencyKey ?? ''),
      debit: lines.filter((l) => l.debit).map((l) => ({ accountCode: l.accountCode, amount: Number(l.debit) })),
      credit: lines.filter((l) => l.credit).map((l) => ({ accountCode: l.accountCode, amount: Number(l.credit) })),
    }
  })
}

export async function reclassSubledger(goodsId: string) {
  const { db } = await import('@/lib/db')
  const rows = await db.transitSubledgerMovement.findMany({
    where: { sourceRef: goodsId, sourceType: 'LANDED_COST_RECLASS' },
    orderBy: { createdAt: 'asc' },
    select: { idempotencyKey: true, baseDelta: true },
  })
  return rows.map((row) => ({ key: row.idempotencyKey, baseDelta: Number(row.baseDelta) }))
}

/** What the transit clearing account nets to for this order, from the ledger rows alone: signed transit legs. */
export async function netTransitDelta(goodsId: string): Promise<number> {
  return (await reclassSubledger(goodsId)).reduce((sum, row) => sum + row.baseDelta, 0)
}

/** The Inventory-account delta every journal for the order posts (DR +, CR -). */
export async function netInventoryJournalDelta(goodsId: string): Promise<number> {
  let net = 0
  for (const journal of await reclassJournals(goodsId)) {
    for (const line of journal.debit) if (line.accountCode === INVENTORY_ACCOUNT) net += line.amount
    for (const line of journal.credit) if (line.accountCode === INVENTORY_ACCOUNT) net -= line.amount
  }
  return net
}

/** A second transfer OUT of `layerId` (units dispatched from a layer that is itself a transfer's destination). */
export async function addTransferOut(world: World, layerId: string, qty: number, unitCost: number, status: 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED' = 'IN_TRANSIT', fromWarehouse?: string, toWarehouse?: string) {
  const { db } = await import('@/lib/db')
  const transfer = await db.stockTransfer.create({
    data: {
      reference: `T2-${world.tag}-${uid()}`, fromWarehouseId: fromWarehouse ?? world.w2, toWarehouseId: toWarehouse ?? world.w1, status, dispatchedAt: new Date(),
      lines: {
        create: [{
          productId: world.productId, sku: world.tag, productName: world.tag, qty: `${qty}.0000`, qtyReceived: '0.0000',
          costLayerSnapshot: [{ costLayerId: layerId, qty: `${qty}.000000`, unitCostBase: `${unitCost}.000000` }],
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return { transferId: transfer.id, transferLineId: transfer.lines[0]!.id }
}

/**
 * A manufactured OUTPUT layer fed by the world's goods layer: a PRODUCTION_OUT movement and its COGS entry
 * consume `consumedQty` of the goods layer (so it is excluded from COGS as manufacturing-consumed), and the
 * output layer names the goods layer through a cost-layer source line.
 */
export async function addProductionOutput(world: World, params: { consumedQty: number; outputQty: number; outputRemaining: number }) {
  const { db } = await import('@/lib/db')
  // The outbound-evidence trigger is DEFERRED to commit: the movement and its COGS entry must land together.
  await db.$transaction(async (tx) => {
    const movement = await tx.stockMovement.create({
      data: {
        type: 'PRODUCTION_OUT', productId: world.productId, fromWarehouseId: world.w1, qty: params.consumedQty,
        referenceType: 'ProductionOrder', referenceId: `NRL4B-PROD-${uid()}`,
        unitCostBase: world.unitCost, totalValueBase: params.consumedQty * world.unitCost,
      },
      select: { id: true },
    })
    await tx.cogsEntry.create({
      data: { costLayerId: world.layerId, movementId: movement.id, qty: params.consumedQty, unitCostBase: world.unitCost, totalCostBase: params.consumedQty * world.unitCost },
    })
  })
  const output = await db.costLayer.create({
    data: { productId: world.productId, warehouseId: world.w1, receivedQty: params.outputQty, remainingQty: params.outputRemaining, unitCostBase: (params.consumedQty * world.unitCost) / params.outputQty },
    select: { id: true },
  })
  await db.costLayerSourceLine.create({
    data: {
      costLayerId: output.id, sourceProductId: world.productId, sourceCostLayerId: world.layerId,
      qty: params.consumedQty, unitCostBase: world.unitCost, totalCostBase: params.consumedQty * world.unitCost,
    },
  })
  return { outputLayerId: output.id }
}

/** The replacement layer a dispatch cancellation books at the source, linked back to the original layer. */
export async function addReplacementLayer(world: World, qty: number) {
  const { db } = await import('@/lib/db')
  const replacement = await db.costLayer.create({
    data: { productId: world.productId, warehouseId: world.w1, receivedQty: qty, remainingQty: qty, unitCostBase: world.unitCost },
    select: { id: true },
  })
  await db.costLayerSourceLine.create({
    data: { costLayerId: replacement.id, sourceProductId: world.productId, sourceCostLayerId: world.layerId, qty, unitCostBase: world.unitCost, totalCostBase: qty * world.unitCost },
  })
  return { replacementLayerId: replacement.id }
}

/** Every ledger-side row that exists for the order and its transfer (sync logs and transit subledger rows). */
export async function ledgerRowCount(world: Pick<World, 'goodsId' | 'transferId'>): Promise<{ syncLogs: number; subledger: number }> {
  const { db } = await import('@/lib/db')
  const syncLogs = await db.accountingSyncLog.count({ where: { referenceId: { in: [world.goodsId, world.transferId] } } })
  const subledger = await db.transitSubledgerMovement.count({ where: { sourceRef: { in: [world.goodsId, world.transferId] } } })
  return { syncLogs, subledger }
}

/** The number of IN_TRANSIT transfer lines naming the layer (the precondition every arm prints). */
export async function inTransitLineCount(layerId: string): Promise<number> {
  const { db } = await import('@/lib/db')
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM stock_transfer_lines stl JOIN stock_transfers st ON st.id = stl."transferId"
      WHERE st.status = 'IN_TRANSIT' AND stl."costLayerSnapshot" @> $1::jsonb`,
    JSON.stringify([{ costLayerId: layerId }]),
  )
  return Number(rows[0]!.n)
}

/** The audit run row a recalculation wrote for the goods order, newest first. */
export async function revaluationRuns(goodsId: string) {
  const { db } = await import('@/lib/db')
  return db.landedCostRevaluationRun.findMany({
    where: { primaryPoId: goodsId }, orderBy: { createdAt: 'desc' }, select: { id: true, afterJson: true, accountingJson: true },
  })
}

// ---------------------------------------------------------------------------------------------------------
// Race helpers. NOTHING orders anything by a wall-clock sleep: every ordering is a LOCK another session holds, and
// every "the path is now blocked" is read from pg_stat_activity / pg_blocking_pids with BOTH ends named (the holder's
// pid and the statement the blocked backend is running) under a polling deadline that FAILS LOUD. The 25 ms pause
// inside the poll is a poll interval, not an ordering.
// ---------------------------------------------------------------------------------------------------------

export const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 }
/** Long enough to survive a loaded box, short enough to fail rather than hang. */
export const BLOCK_WAIT_MS = 20_000

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

export type RawClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
}

/** A dedicated connection (used only to OBSERVE pg_stat_activity). */
export async function rawSession(databaseUrl: string): Promise<RawClient> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  return client as unknown as RawClient
}

/** The pid of the backend an interactive transaction is pinned to (Prisma pins one for its whole life). */
export async function txPid(tx: unknown): Promise<number> {
  const rows = await (tx as { $queryRawUnsafe: <T>(sql: string) => Promise<T> })
    .$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid')
  const pid = Number(rows[0]?.pid)
  assert.ok(Number.isInteger(pid) && pid > 0, `pg_backend_pid() returned no usable pid: ${JSON.stringify(rows)}`)
  return pid
}

/**
 * Wait until a backend BLOCKED BY `blockedBy` is running a statement matching `waitingOn`. Both ends named; a
 * deadline that throws; and an immediate failure when the path under test has already finished (a block that can
 * no longer happen).
 */
export async function waitForBlocked(probe: RawClient, params: {
  blockedBy: number
  waitingOn: RegExp
  describe: string
  finished?: () => boolean
}): Promise<{ pid: number; query: string }> {
  const deadline = Date.now() + BLOCK_WAIT_MS
  for (;;) {
    const { rows } = await probe.query(
      `SELECT a.pid::int AS pid, coalesce(a.query, '') AS query
         FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.pid <> pg_backend_pid()
          AND a.wait_event_type = 'Lock'
          AND $1::int = ANY(pg_blocking_pids(a.pid))
        ORDER BY a.pid`,
      [params.blockedBy],
    )
    const hit = rows.find((row) => params.waitingOn.test(String(row.query)))
    if (hit) return { pid: Number(hit.pid), query: String(hit.query) }
    if (params.finished?.()) {
      throw new Error(`${params.describe}: the path under test FINISHED without ever blocking on ${params.waitingOn} behind pid ${params.blockedBy}, so no lock ordering was exercised.`)
    }
    if (Date.now() > deadline) {
      throw new Error(`${params.describe}: no backend blocked by pid ${params.blockedBy} was running a statement matching ${params.waitingOn} within ${BLOCK_WAIT_MS} ms. Rows blocked by it: ${JSON.stringify(rows)}. The path never reached that lock, so this arm proves nothing about acquisition order.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * THE IMS VALUE OF THE WORLD'S PRODUCT: every unit is on a cost layer or still on a truck.
 *   Σ remaining x unit cost over the product's cost layers
 * + Σ over IN_TRANSIT transfer lines of the product: (qty - LANDED) x the snapshot's unit cost,
 * where LANDED = qtyReceived + the unabsorbed WMS alignment credit (the one definition, re-spelled here in SQL so
 * the invariant does not borrow the code under test).
 * A transfer posts no ledger entry, so this is the figure the GL's Inventory account should track.
 */
export async function imsValue(world: Pick<World, 'productId'>): Promise<number> {
  const { db } = await import('@/lib/db')
  const layers = await db.costLayer.findMany({ where: { productId: world.productId }, select: { remainingQty: true, unitCostBase: true } })
  let value = layers.reduce((sum, layer) => sum + Number(layer.remainingQty) * Number(layer.unitCostBase), 0)
  const lines = await db.$queryRawUnsafe<Array<{ id: string; qty: string; qtyReceived: string; snapshot: Array<{ qty: string; unitCostBase: string }>; credit: string }>>(
    `SELECT stl.id, stl.qty::text AS qty, stl."qtyReceived"::text AS "qtyReceived", stl."costLayerSnapshot" AS snapshot,
            coalesce((SELECT sum(greatest(m."qtyAccountedViaSnapshot" - m."qtyAccountedViaReceipt", 0))
                        FROM wms_asn_line_maps m
                       WHERE m."sourceType" = 'STOCK_TRANSFER_LINE' AND m."sourceLineId" = stl.id), 0)::text AS credit
       FROM stock_transfer_lines stl JOIN stock_transfers st ON st.id = stl."transferId"
      WHERE st.status = 'IN_TRANSIT' AND stl."productId" = $1`,
    world.productId,
  )
  for (const line of lines) {
    const landed = Number(line.qtyReceived) + Number(line.credit)
    const inTransit = Math.max(0, Number(line.qty) - landed)
    // single-entry snapshots in these worlds: the unit cost is the entry's
    value += inTransit * Number(line.snapshot[0]!.unitCostBase)
  }
  return value
}
