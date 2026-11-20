import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'

/**
 * STOCK IN TRANSIT, VALUED PER TRANSFER (ACC-M12), AGAINST A REAL DATABASE (committing, with its own cleanup).
 *
 * The invariant every case asserts, on every day of the transfer's life:
 *
 *     inventory snapshot on-hand value (backfilled for the day)  +  in-transit line (backfilled for the day)  =  Inventory GL balance
 *
 * where the GL balance is modelled the way the ledger works: a transfer posts nothing, so the GL holds the purchase value from
 * the day the stock was bought, plus any landed-cost revaluation capitalised for units in transit on the day it was capitalised.
 * Without the in-transit line the snapshot is short of the GL by the dispatched value on every day between dispatch and receipt.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/in-transit-transfer-value.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const transit = await import('../../lib/domain/inventory/transfer-in-transit-value')
  const snapshot = await import('../../lib/domain/inventory/inventory-snapshot')
  const landed = await import('../../lib/domain/purchasing/landed-cost-service')
  return { db, transit, snapshot, landed }
}
type Ctx = Awaited<ReturnType<typeof load>>

const D = (v: string | number) => new Prisma.Decimal(v)

/** Midday UTC `daysAgo` days back: well inside one London business day in both GMT and BST. */
function noon(daysAgo: number): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 12, 0, 0))
}
function dayLabel(daysAgo: number): string {
  return noon(daysAgo).toISOString().slice(0, 10)
}

type Seed = Awaited<ReturnType<typeof seed>>

/** A product with 10 units @ 10 on a cost layer in warehouse A (bought day 8 in the modelled GL: it holds 100 from then on; the purchase movement itself is not needed, nothing reads it). */
async function seed(db: Ctx['db']) {
  const suffix = randomUUID().slice(0, 8)
  const product = await db.product.create({ data: { sku: `TRN-${suffix}`, name: `transit ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const from = await db.warehouse.create({ data: { name: `tr-from ${suffix}`, code: `TRF${suffix}` }, select: { id: true } })
  const to = await db.warehouse.create({ data: { name: `tr-to ${suffix}`, code: `TRT${suffix}` }, select: { id: true } })
  const layer = await db.costLayer.create({
    data: { productId: product.id, warehouseId: from.id, receivedQty: D(10), remainingQty: D(0), unitCostBase: D(10), receivedAt: noon(8) },
    select: { id: true },
  })
  const transfer = await db.stockTransfer.create({
    data: {
      reference: `TRN-${suffix}`, fromWarehouseId: from.id, toWarehouseId: to.id, status: 'IN_TRANSIT', dispatchedAt: noon(6),
      lines: { create: [{ productId: product.id, sku: `TRN-${suffix}`, qty: D(10), costLayerSnapshot: [{ costLayerId: layer.id, qty: 10, unitCostBase: 10 }] as never }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  // Dispatch on day 6: the units leave A (stock level and layer already 0 in the final state).
  await db.stockMovement.create({
    data: {
      type: 'TRANSFER_OUT', productId: product.id, fromWarehouseId: from.id, qty: D(10), unitCostBase: D(10), totalValueBase: D(100),
      referenceType: 'StockTransfer', referenceId: transfer.id, createdAt: noon(6),
    },
  })
  return { suffix, productId: product.id, fromId: from.id, toId: to.id, layerId: layer.id, transferId: transfer.id, lineId: transfer.lines[0].id }
}

/** Land `qty` units at B (stock level, layer) and book the receipt movement. `value` is what the movement carries. */
async function land(db: Ctx['db'], s: Seed, args: { qty: number; unit: number; at: Date; movement: 'manual' | 'wms-webhook' | 'wms-alignment' | 'none'; asnMapId?: string; asnLineMapId?: string }) {
  const value = D(args.qty).mul(D(args.unit))
  await db.stockLevel.upsert({
    where: { productId_warehouseId: { productId: s.productId, warehouseId: s.toId } },
    create: { productId: s.productId, warehouseId: s.toId, quantity: D(args.qty) },
    update: { quantity: { increment: args.qty } },
  })
  await db.costLayer.create({
    data: { productId: s.productId, warehouseId: s.toId, receivedQty: D(args.qty), remainingQty: D(args.qty), unitCostBase: D(args.unit), receivedAt: args.at },
  })
  const base = { productId: s.productId, toWarehouseId: s.toId, qty: D(args.qty), unitCostBase: D(args.unit), totalValueBase: value, createdAt: args.at }
  if (args.movement === 'manual') {
    await db.stockMovement.create({ data: { ...base, type: 'TRANSFER_IN', referenceType: 'StockTransfer', referenceId: s.transferId } })
  } else if (args.movement === 'wms-webhook') {
    await db.stockMovement.create({ data: { ...base, type: 'TRANSFER_IN', referenceType: 'WmsAsnMap', referenceId: args.asnMapId!, idempotencyKey: `TRANSFER_IN:wmsAsnLine:${args.asnLineMapId}:receipt:${randomUUID()}` } })
  } else if (args.movement === 'wms-alignment') {
    await db.stockMovement.create({ data: { ...base, type: 'WMS_RECEIPT_RECONCILIATION', referenceType: 'WmsAsnLineMap', referenceId: args.asnLineMapId! } })
  }
}

async function seedAsn(db: Ctx['db'], s: Seed) {
  const asn = await db.wmsAsnMap.create({
    data: { connector: 'mintsoft', externalAsnId: `ASN-${s.suffix}`, sourceType: 'STOCK_TRANSFER', sourceId: s.transferId, warehouseId: s.toId, status: 'OPEN' as never },
    select: { id: true },
  })
  const line = await db.wmsAsnLineMap.create({
    data: { asnMapId: asn.id, externalAsnLineId: `L-${s.suffix}`, sourceType: 'STOCK_TRANSFER_LINE', sourceLineId: s.lineId, productId: s.productId, sku: `TRN-${s.suffix}`, expectedQty: D(10) },
    select: { id: true },
  })
  return { asnMapId: asn.id, asnLineMapId: line.id }
}

async function cleanup(db: Ctx['db'], s: Seed) {
  // The run rows go too: the despatch-date floor reads the LATEST inventory_snapshot_runs row, so one left behind for today
  // would move every later despatch test in this database.
  const labels = Array.from({ length: 9 }, (_, daysAgo) => new Date(`${dayLabel(daysAgo)}T00:00:00.000Z`))
  await db.inventorySnapshotRun.deleteMany({ where: { snapshotDate: { in: labels } } })
  await db.inventoryReservationSnapshotRun.deleteMany({ where: { snapshotDate: { in: labels } } })
  await db.inventoryReservationSnapshot.deleteMany({ where: { snapshotDate: { in: labels }, productId: s.productId } })
  await db.inventoryTransitSnapshot.deleteMany({ where: { transferId: s.transferId } })
  await db.stockTransferTransitRevaluation.deleteMany({ where: { transferLineId: s.lineId } })
  await db.wmsAsnLineMap.deleteMany({ where: { productId: s.productId } })
  await db.wmsAsnMap.deleteMany({ where: { sourceId: s.transferId } })
  await db.stockMovement.deleteMany({ where: { productId: s.productId } })
  await db.inventorySnapshot.deleteMany({ where: { productId: s.productId } })
  await db.costLayerRevaluation.deleteMany({ where: { costLayer: { productId: s.productId } } })
  await db.costLayer.deleteMany({ where: { productId: s.productId } })
  await db.stockLevel.deleteMany({ where: { productId: s.productId } })
  await db.stockTransferLine.deleteMany({ where: { transferId: s.transferId } })
  await db.stockTransfer.deleteMany({ where: { id: s.transferId } })
  await db.product.deleteMany({ where: { id: s.productId } })
  await db.warehouse.deleteMany({ where: { id: { in: [s.fromId, s.toId] } } })
}

/** Close the transfer as the receipt paths do. */
async function close(db: Ctx['db'], s: Seed, at: Date) {
  await db.stockTransfer.update({ where: { id: s.transferId }, data: { status: 'RECEIVED', completedAt: at } })
  await db.stockTransferLine.update({ where: { id: s.lineId }, data: { qtyReceived: D(10) } })
}

/** In-transit value of this one transfer at the end of the business day `daysAgo` back, from the ledger. */
async function inTransitAtEndOfDay(ctx: Ctx, s: Seed, daysAgo: number): Promise<number> {
  const label = new Date(`${dayLabel(daysAgo)}T00:00:00.000Z`)
  const rows = await ctx.transit.loadInTransitTransferValues(ctx.db, ctx.snapshot.startOfNextBusinessDay(label))
  assert.ok(rows, 'the real client can measure stock in transit')
  return rows.filter((row) => row.transferId === s.transferId).reduce((sum, row) => sum + row.valueBase.toNumber(), 0)
}

/**
 * The snapshot tie-out for one day: backfill the days into inventory_snapshots + inventory_transit_snapshots (the movement
 * replay, exactly as production backfills), read this product's on-hand value plus this transfer's in-transit line, and compare
 * with the GL balance the test models for that day.
 */
async function assertSnapshotTiesToGl(ctx: Ctx, s: Seed, fromDaysAgo: number, expectedGlByDaysAgo: Record<number, number>) {
  await ctx.snapshot.backfillInventorySnapshots({ client: ctx.db as never, fromDate: dayLabel(fromDaysAgo), toDate: dayLabel(0) })
  for (const [key, expectedGl] of Object.entries(expectedGlByDaysAgo)) {
    const daysAgo = Number(key)
    const date = new Date(`${dayLabel(daysAgo)}T00:00:00.000Z`)
    const onHand = (await ctx.db.inventorySnapshot.findMany({ where: { snapshotDate: date, productId: s.productId }, select: { valueBase: true } }))
      .reduce((sum, row) => sum + Number(row.valueBase), 0)
    const inTransit = (await ctx.db.inventoryTransitSnapshot.findMany({ where: { snapshotDate: date, transferId: s.transferId }, select: { valueBase: true } }))
      .reduce((sum, row) => sum + Number(row.valueBase), 0)
    const run = await ctx.db.inventorySnapshotRun.findUnique({ where: { snapshotDate: date }, select: { inTransitCovered: true } })
    assert.equal(run?.inTransitCovered, true, `day -${daysAgo}: the run says the in-transit line was measured`)
    assert.equal(Math.round((onHand + inTransit) * 100) / 100, expectedGl, `day -${daysAgo}: on-hand ${onHand} + in transit ${inTransit} must equal the GL ${expectedGl}`)
  }
}

test('manual transfer dispatched and received across snapshot days: the in-transit line carries the gap, then clears', { skip }, async () => {
  const ctx = await load()
  const s = await seed(ctx.db)
  try {
    await land(ctx.db, s, { qty: 10, unit: 10, at: noon(3), movement: 'manual' })
    await close(ctx.db, s, noon(3))

    // Dispatched on day 6, received on day 3: in transit at the end of days 6, 5 and 4, and not on day 7 (before dispatch) or day 3.
    assert.equal(await inTransitAtEndOfDay(ctx, s, 7), 0)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 6), 100)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 4), 100)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 3), 0, 'received on day 3: cleared that day, not stranded')
    // Today's live stock is in B (10 @ 10); the GL has held 100 since the purchase.
    await assertSnapshotTiesToGl(ctx, s, 8, { 8: 100, 7: 100, 6: 100, 5: 100, 4: 100, 3: 100, 0: 100 })
  } finally {
    await cleanup(ctx.db, s)
  }
})

test('WMS (Mintsoft) booked-in receipt, written under the ASN map and not the transfer, clears the transfer', { skip }, async () => {
  const ctx = await load()
  const s = await seed(ctx.db)
  try {
    const asn = await seedAsn(ctx.db, s)
    // 6 units booked in by the webhook on day 4 while the transfer is still IN_TRANSIT, the other 4 on day 2, which completes it.
    await land(ctx.db, s, { qty: 6, unit: 10, at: noon(4), movement: 'wms-webhook', ...asn })
    await land(ctx.db, s, { qty: 4, unit: 10, at: noon(2), movement: 'wms-webhook', ...asn })
    await close(ctx.db, s, noon(2))

    assert.equal(await inTransitAtEndOfDay(ctx, s, 5), 100)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 4), 40, 'the webhook receipt is under the ASN map, not the transfer: the netting #1027 tried left all 100 here')
    assert.equal(await inTransitAtEndOfDay(ctx, s, 3), 40)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 2), 0)
    await assertSnapshotTiesToGl(ctx, s, 8, { 8: 100, 6: 100, 5: 100, 4: 100, 3: 100, 2: 100, 0: 100 })
  } finally {
    await cleanup(ctx.db, s)
  }
})

test('WMS stock-sync alignment credit (WMS_RECEIPT_RECONCILIATION under the ASN line map) clears a transfer still marked IN_TRANSIT', { skip }, async () => {
  const ctx = await load()
  const s = await seed(ctx.db)
  try {
    const asn = await seedAsn(ctx.db, s)
    // The alignment brings the units in and never closes the transfer or touches qtyReceived: status stays IN_TRANSIT.
    await land(ctx.db, s, { qty: 10, unit: 10, at: noon(2), movement: 'wms-alignment', ...asn })
    // A zero-qty audit marker for the same line (the webhook's "already accounted for by a snapshot") adds nothing.
    await ctx.db.stockMovement.create({
      data: { type: 'WMS_RECEIPT_RECONCILIATION', productId: s.productId, toWarehouseId: s.toId, qty: D(0), unitCostBase: D(0), totalValueBase: D(0), referenceType: 'WmsAsnLineMap', referenceId: asn.asnLineMapId, createdAt: noon(1) },
    })

    assert.equal(await inTransitAtEndOfDay(ctx, s, 5), 100)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 3), 100, 'before the alignment')
    assert.equal(await inTransitAtEndOfDay(ctx, s, 2), 0)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 0), 0)
    await assertSnapshotTiesToGl(ctx, s, 8, { 8: 100, 5: 100, 3: 100, 2: 100, 0: 100 })
  } finally {
    await cleanup(ctx.db, s)
  }
})

test('partial receipt: only the unreceived share stays in transit, day by day', { skip }, async () => {
  const ctx = await load()
  const s = await seed(ctx.db)
  try {
    // 4 units land on day 4 (manual partial receipt), the remaining 6 on day 2 (booked in by the WMS).
    await land(ctx.db, s, { qty: 4, unit: 10, at: noon(4), movement: 'manual' })
    const asn = await seedAsn(ctx.db, s)
    await land(ctx.db, s, { qty: 6, unit: 10, at: noon(2), movement: 'wms-webhook', ...asn })
    await close(ctx.db, s, noon(2))

    assert.equal(await inTransitAtEndOfDay(ctx, s, 5), 100)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 4), 60)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 3), 60)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 2), 0)
    await assertSnapshotTiesToGl(ctx, s, 8, { 8: 100, 5: 100, 4: 100, 3: 100, 2: 100, 0: 100 })
  } finally {
    await cleanup(ctx.db, s)
  }
})

test('landed-cost revaluation of stock in transit: capitalised once, carried by the receipt, no drift afterwards', { skip }, async () => {
  const ctx = await load()
  const s = await seed(ctx.db)
  try {
    // Day 4: +£1 a unit lands on the layer these 10 units came from, while they are in transit. The GL takes DR Inventory 10 now
    // (capitaliseInTransitResidue); the dispatch snapshot is rewritten to 11, so the day-2 receipt is valued at 110.
    await ctx.db.costLayer.update({ where: { id: s.layerId }, data: { unitCostBase: D(11) } })
    await ctx.db.stockTransferLine.update({ where: { id: s.lineId }, data: { costLayerSnapshot: [{ costLayerId: s.layerId, qty: 10, unitCostBase: 11 }] as never } })
    const residue = await ctx.db.$transaction(async (tx) => ctx.landed.capitaliseInTransitResidue(tx, ctx.landed.defaultLandedCostServiceDeps, s.layerId, D(1), D(10)))
    assert.equal(residue.delta.toString(), '10', 'the residue the GL takes')
    assert.equal(residue.entries.length, 1)
    // Stamp the mirror row onto day 4 (it was written "now") so the as-of days below are meaningful.
    const mirrored = await ctx.db.stockTransferTransitRevaluation.updateMany({ where: { transferLineId: s.lineId }, data: { effectiveAt: noon(4) } })
    assert.equal(mirrored.count, 1, 'the revaluation is mirrored durably, once, against the transfer line')

    await land(ctx.db, s, { qty: 10, unit: 11, at: noon(2), movement: 'manual' })
    await close(ctx.db, s, noon(2))

    assert.equal(await inTransitAtEndOfDay(ctx, s, 5), 100, 'before the revaluation')
    assert.equal(await inTransitAtEndOfDay(ctx, s, 4), 110, 'after it: the GL holds 110 for these units')
    assert.equal(await inTransitAtEndOfDay(ctx, s, 3), 110)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 2), 0, 'received at the revalued cost: nets to nothing, no residue left to drift')
    await assertSnapshotTiesToGl(ctx, s, 8, { 8: 100, 5: 100, 4: 110, 3: 110, 2: 110, 0: 110 })
  } finally {
    await cleanup(ctx.db, s)
  }
})

test('a dispatch cancelled back to the source is not left in transit', { skip }, async () => {
  const ctx = await load()
  const s = await seed(ctx.db)
  try {
    // Cancel on day 3: TRANSFER_IN at the SOURCE under the transfer, valued from the snapshot.
    await ctx.db.stockMovement.create({
      data: { type: 'TRANSFER_IN', productId: s.productId, toWarehouseId: s.fromId, qty: D(10), unitCostBase: D(10), totalValueBase: D(100), referenceType: 'StockTransfer', referenceId: s.transferId, createdAt: noon(3) },
    })
    await ctx.db.stockTransfer.update({ where: { id: s.transferId }, data: { status: 'CANCELLED', completedAt: noon(3) } })
    assert.equal(await inTransitAtEndOfDay(ctx, s, 4), 100)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 3), 0)
  } finally {
    await cleanup(ctx.db, s)
  }
})

test('a closed transfer whose legs do not sum to zero is not parked in transit', { skip }, async () => {
  const ctx = await load()
  const s = await seed(ctx.db)
  try {
    // A short snapshot priced part of the receipt at zero: 10 units dispatched at 100, 10 received at 90. That 10 is a real
    // receipt-valuation variance for the reconciliation to show, not stock in transit.
    await land(ctx.db, s, { qty: 10, unit: 9, at: noon(3), movement: 'manual' })
    await close(ctx.db, s, noon(3))
    assert.equal(await inTransitAtEndOfDay(ctx, s, 4), 100)
    assert.equal(await inTransitAtEndOfDay(ctx, s, 3), 0)
  } finally {
    await cleanup(ctx.db, s)
  }
})

test('the daily snapshot writes the in-transit line for a transfer in transit now, and marks the run as covering it', { skip }, async () => {
  const ctx = await load()
  const s = await seed(ctx.db)
  try {
    await ctx.db.stockLevel.upsert({
      where: { productId_warehouseId: { productId: s.productId, warehouseId: s.fromId } },
      create: { productId: s.productId, warehouseId: s.fromId, quantity: D(0) },
      update: {},
    })
    const label = dayLabel(1)
    const result = await ctx.snapshot.writeDailyInventorySnapshot({ snapshotDate: label })
    assert.ok((result.inTransitTransfersWritten ?? 0) >= 1)
    const date = new Date(`${label}T00:00:00.000Z`)
    const rows = await ctx.db.inventoryTransitSnapshot.findMany({ where: { snapshotDate: date, transferId: s.transferId } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].valueBase.toString(), '100')
    assert.equal(rows[0].valueReplayReliable, true)
    const run = await ctx.db.inventorySnapshotRun.findUnique({ where: { snapshotDate: date }, select: { inTransitCovered: true } })
    assert.equal(run?.inTransitCovered, true)

    // Re-running the date once the transfer has landed replaces the day's line: it drops out rather than going stale.
    await land(ctx.db, s, { qty: 10, unit: 10, at: new Date(), movement: 'manual' })
    await close(ctx.db, s, new Date())
    await ctx.snapshot.writeDailyInventorySnapshot({ snapshotDate: label })
    assert.equal(await ctx.db.inventoryTransitSnapshot.count({ where: { snapshotDate: date, transferId: s.transferId } }), 0)
  } finally {
    await ctx.db.inventorySnapshot.deleteMany({ where: { snapshotDate: new Date(`${dayLabel(1)}T00:00:00.000Z`), productId: s.productId } })
    await cleanup(ctx.db, s)
  }
})
