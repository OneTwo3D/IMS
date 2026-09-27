import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import * as realAccountingNs from '@/lib/accounting'
import { liveMintsoftBookedInAsnRef } from '@/tests/helpers/live-mintsoft-asn-ref'

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-6nd55 — THE WMS STOCK-SYNC ALIGN-UP PATH IS A RECEIPT WRITER AND MUST BEHAVE LIKE ONE:
 * THE REAL COST, AND THE SAME JOURNAL, IN THE SAME TRANSACTION AS THE STOCK.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * TWO DEFECTS, ONE PATH — `applyMintsoftAlignmentForProduct`, the PURCHASE_ORDER_LINE branch.
 *
 * 1. THE COST WAS ALWAYS ZERO, and this half is a live inventory-value defect independent of any
 *    accounting. The branch read `Number(poLine.landedUnitCostBase ?? poLine.unitCostBase)`.
 *    `landedUnitCostBase` is `Decimal @db.Decimal(18, 6) @default(0)` and NOT NULL
 *    (prisma/schema.prisma:1319) and `createPurchaseOrder` never writes it, so the `??` could NEVER
 *    fall through: an ordinary purchase order aligned up at a unit cost of ZERO — a zero-cost FIFO
 *    layer and a zero-value stock movement for goods that cost real money. A wrong cost layer is
 *    wrong stock value that no journal repairs, and it would fail the switchover's `[firstload]`
 *    valuation reconciliation against Qoblex (±£1 per warehouse) as what looks like a migration
 *    error rather than a product defect.
 *
 * 2. IT POSTED NOTHING. No STOCK_RECEIPT journal and no `transit_subledger_movements` row —
 *    `grep -n 'queueAccountingSync|STOCK_RECEIPT|recordTransitSubledger'` over
 *    lib/connectors/mintsoft/sync/stock-sync.ts returned nothing at all — while the manual receipt
 *    (app/actions/purchase-orders.ts:2064-2095) and the WMS book-in (o3d-8f0p6) both post. And
 *    NOTHING PICKS IT UP LATER: the transit reconciliation aggregates rows written AT POST TIME, so
 *    a posting that never happened is absent from BOTH sides of it and that window ties out exactly
 *    — the reconciliation that should have caught this HID it (the trap recorded at
 *    lib/domain/inventory/movement-cogs-relevance.ts:291-295).
 *
 * WHY THESE ARMS NEED A REAL PostgreSQL. The claims are not "a function was called"; they are "the
 * journal, the layer and the stock are one unit of work" (arm 5) and "the whole alignment rolls back
 * when the account mapping moves under it" (arm 8). Only a real transaction can make those
 * statements, and a test double with no rollback would fake exactly them.
 *
 * WHY EVERY PURCHASE ORDER HERE IS BUILT BY THE REAL `createPurchaseOrder`. o3d-8f0p6's round-1
 * arms were all green while missing defect 1 entirely, because their fixture wrote
 * `landedUnitCostBase` by hand. A fixture that sets a cost column cannot see a defect about what
 * that column contains. No arm below writes a cost column.
 *
 * WHAT WOULD STILL PASS EACH ARM is written above the arm, so a green run is not mistaken for more
 * than it establishes.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', {
  namedExports: { recordWmsMutationEvent: async () => {} },
})
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

/**
 * THE ONLY SEAM IN THIS FILE, and both halves of it are OFF unless an arm switches one on.
 *
 * `queueAccountingSyncTx` is otherwise THE REAL ONE: every other arm's journal is written by
 * production code through production settings, so no arm can pass on a fixture's generosity.
 * Arm 5 needs the enqueue to FAIL in order to ask what happens to the stock, and there is no other
 * way to make a correct enqueue fail. Arm 8 needs a committed account remap to land in the window
 * between the service's two reads, and the enqueue is the only point inside that window a test can
 * reach.
 */
let injectEnqueueFailure = false
let remapInventoryAccountOnNextEnqueue: (() => Promise<void>) | null = null
const INJECTED_ENQUEUE_FAILURE = 'o3d-6nd55 injected STOCK_RECEIPT enqueue failure'
mock.module('@/lib/accounting', {
  namedExports: {
    ...realAccountingNs,
    queueAccountingSyncTx: async (
      ...args: Parameters<typeof realAccountingNs.queueAccountingSyncTx>
    ) => {
      if (injectEnqueueFailure && args[1]?.type === 'STOCK_RECEIPT') {
        throw new Error(INJECTED_ENQUEUE_FAILURE)
      }
      if (remapInventoryAccountOnNextEnqueue && args[1]?.type === 'STOCK_RECEIPT') {
        const hook = remapInventoryAccountOnNextEnqueue
        remapInventoryAccountOnNextEnqueue = null
        await hook()
      }
      return realAccountingNs.queueAccountingSyncTx(...args)
    },
  },
})

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
  return process.env.DATABASE_URL
}

const INVENTORY_ACCOUNT = '630'
const TRANSIT_ACCOUNT = '631'

function uniqueTag(label: string): string {
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  return `ALGN${label}${process.pid}${uid}`.replace(/[^A-Z0-9]/g, '').slice(0, 28)
}

/**
 * Switch the accounting connector on so the enqueue reaches its INSERT instead of answering
 * `not-configured` first. `plugin_xero_enabled` is the key `queueAccountingSyncTx` resolves the
 * ACTIVE connector from — getting it wrong would make every assertion below hold over an enqueue
 * that never ran, which is why arms 1-3 assert the row EXISTS rather than only checking its shape
 * if present.
 */
async function enableStockReceiptPosting(): Promise<void> {
  const { db } = await import('@/lib/db')
  for (const [key, value] of [
    ['plugin_xero_enabled', 'true'],
    ['xero_sync_enabled', 'true'],
    ['xero_sync_stock_receipt', 'submitted'],
    ['xero_inventory_account', INVENTORY_ACCOUNT],
    ['xero_transit_account', TRANSIT_ACCOUNT],
  ] as Array<[string, string]>) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
}

type SeededAlignmentTarget = {
  tag: string
  qty: number
  unitCost: number
  productId: string
  warehouseId: string
  poId: string
  poLineId: string
  asnLineMapId: string
  externalAsnLineId: string
  binding: Record<string, unknown>
}

/**
 * A PO-BACKED OPEN ASN AT A WMS-BOUND WAREHOUSE, WITH THE PO BUILT BY THE REAL CREATION PATH.
 *
 * `createPurchaseOrder` is called with only what an operator supplies — qty and `unitCostForeign`,
 * plus an optional freight cost line — so NO cost column is written by hand. That is the point of
 * the fixture: the action never sets `landedUnitCostBase`, and that untouched zero is defect 1.
 *
 * The status is advanced to PO_SENT afterwards because an ASN is raised against a sent order. A
 * status is not a cost, and every cost figure in every arm comes out of the action.
 */
async function seedAlignmentTarget(
  label: string,
  qty: number,
  unitCost: number,
  freightTotal = 0,
): Promise<SeededAlignmentTarget> {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = uniqueTag(label)
  const product = await db.product.create({
    data: { sku: tag, name: `o3d-6nd55 ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const warehouse = await db.warehouse.create({
    data: { code: tag.slice(-10), name: `${tag} wh`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })
  await db.stockLevel.create({
    data: { productId: product.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' },
    select: { productId: true },
  })
  const supplier = await db.supplier.create({
    data: { name: `${tag} supplier`, currency: 'GBP' },
    select: { id: true },
  })

  const created = await createPurchaseOrder({
    reference: tag,
    supplierId: supplier.id,
    currency: 'GBP',
    fxRateToBase: 1,
    destinationWarehouseId: warehouse.id,
    pricesIncludeVat: false,
    taxRateValue: 0,
    ...(freightTotal > 0
      ? {
        additionalCosts: [{
          description: 'Freight',
          amountForeign: freightTotal,
          vatable: false,
          distributionMethod: 'BY_VALUE' as const,
        }],
      }
      : {}),
    lines: [{
      productId: product.id,
      sku: tag,
      productName: `o3d-6nd55 ${label}`,
      qty,
      unitCostForeign: unitCost,
    }],
  })
  assert.equal(created.success, true, `PRECONDITION: createPurchaseOrder must succeed: ${created.error}`)
  const po = await db.purchaseOrder.findUniqueOrThrow({
    where: { reference: tag },
    select: { id: true, lines: { select: { id: true } } },
  })
  // An ASN is raised against a SENT order. Status only — no cost column is touched.
  await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })

  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-6nd55: a test fixture row, not a core flow branch
      externalAsnId: tag,
      sourceType: 'PURCHASE_ORDER',
      sourceId: po.id,
      warehouseId: warehouse.id,
      status: 'OPEN',
      lines: {
        create: [{
          externalAsnLineId: `${tag}-1`,
          sourceType: 'PURCHASE_ORDER_LINE',
          sourceLineId: po.lines[0]!.id,
          productId: product.id,
          sku: tag,
          expectedQty: `${qty}.0000`,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true, externalAsnLineId: true } } },
  })

  return {
    tag,
    qty,
    unitCost,
    productId: product.id,
    warehouseId: warehouse.id,
    poId: po.id,
    poLineId: po.lines[0]!.id,
    asnLineMapId: asn.lines[0]!.id,
    externalAsnLineId: asn.lines[0]!.externalAsnLineId,
    binding: {
      id: `binding-${tag}`,
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-6nd55: a test fixture value, not a core flow branch
      active: true,
      externalWarehouseId: '1',
      stockSyncMode: 'ALIGN_TO_WMS',
      syncFrequencyMinutes: 60,
      discrepancyThresholds: null,
      reportRecipients: [],
      alignmentConfirmedAt: new Date(),
      alignDownReasonId: null,
      warehouseId: warehouse.id,
      lastStockSyncAt: null,
      connection: { active: true },
      warehouse,
    },
  }
}

/** The real align-up, at the deepest seam below the live Mintsoft API (production's only caller is this file's sweep). */
async function alignUp(
  seeded: SeededAlignmentTarget,
  amounts: { delta: number; imsQty: number },
) {
  const { applyMintsoftAlignmentForProduct } =
    await import('@/lib/connectors/mintsoft/sync/stock-sync')
  return applyMintsoftAlignmentForProduct({
    binding: seeded.binding as never,
    jobId: `o3d-6nd55-${Date.now()}`,
    productId: seeded.productId,
    sku: seeded.tag,
    delta: amounts.delta,
    imsQty: amounts.imsQty,
    dryRun: false,
  })
}

/** The real webhook book-in, for the composition arms. */
async function runBookedIn(seeded: SeededAlignmentTarget, bookedQty: number): Promise<string> {
  const { db } = await import('@/lib/db')
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const event = await db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-6nd55: a test fixture row, not a core flow branch
      externalEventId: `${seeded.tag}-evt-${Math.random().toString(36).slice(2, 10)}`,
      externalAsnId: seeded.tag,
      payload: { asnId: seeded.tag },
    },
    select: { id: true },
  })
  const remote = liveMintsoftBookedInAsnRef({
    externalAsnId: seeded.tag,
    externalLineId: seeded.externalAsnLineId,
    sourceLineId: seeded.poLineId,
    sku: seeded.tag,
    expectedQty: seeded.qty,
    bookedQty,
  })
  const result = await processBookedInEvent(event.id, {
    fetchRemoteAsn: async () => ({ ...remote, status: 'RECEIVED', raw: null }),
  })
  return result.status
}

type SyncLogRow = {
  id: string
  type: string
  referenceType: string
  referenceId: string
  payload: unknown
}

async function stockReceiptLogsFor(referenceId: string): Promise<SyncLogRow[]> {
  const { db } = await import('@/lib/db')
  return db.accountingSyncLog.findMany({
    where: { type: 'STOCK_RECEIPT', referenceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, referenceType: true, referenceId: true, payload: true },
  }) as Promise<SyncLogRow[]>
}

async function transitRowsFor(sourceRef: string) {
  const { db } = await import('@/lib/db')
  return db.transitSubledgerMovement.findMany({
    where: { sourceRef },
    orderBy: { createdAt: 'asc' },
    select: { id: true, sourceType: true, sourceRef: true, baseDelta: true, idempotencyKey: true },
  })
}

/** The journal lines, as the payload carries them. */
function payloadLines(payload: unknown): Array<{ accountCode?: string; debit?: number; credit?: number }> {
  const lines = (payload as { lines?: unknown } | null)?.lines
  assert.ok(Array.isArray(lines), `sync-log payload carries no lines array: ${JSON.stringify(payload)}`)
  return lines as Array<{ accountCode?: string; debit?: number; credit?: number }>
}

/**
 * The PO line as the creation action left it — asserted by every cost arm, because if
 * `createPurchaseOrder` ever starts writing `landedUnitCostBase` these arms stop being about the
 * ordinary path and quietly become about a fixture.
 */
async function assertUntouchedLandedCost(poLineId: string, expectedGoodsUnitCost: number): Promise<void> {
  const { db } = await import('@/lib/db')
  const line = await db.purchaseOrderLine.findUniqueOrThrow({
    where: { id: poLineId },
    select: { unitCostBase: true, landedUnitCostBase: true },
  })
  console.log(`[o3d-6nd55] PO line as createPurchaseOrder left it: unitCostBase=${String(line.unitCostBase)} landedUnitCostBase=${String(line.landedUnitCostBase)}`)
  assert.equal(
    Number(line.landedUnitCostBase),
    0,
    'PRECONDITION: createPurchaseOrder must leave landedUnitCostBase at its zero default — that zero '
    + 'is the whole defect',
  )
  assert.equal(
    Number(line.unitCostBase),
    expectedGoodsUnitCost,
    'PRECONDITION: the goods cost must be positive, so a zero cost cannot be explained as a free line',
  )
}

/**
 * ARM 1 — DEFECT 1, THE ZERO-COST LAYER. The half that exists today with no accounting involved.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that gets the cost right and still posts no journal (arm 2
 * refuses that); a fix that reads `unitCostBase` alone instead of the shared gross helper (arm 3
 * refuses that, and only for a PO carrying freight); and a fix that lays the right layer OUTSIDE the
 * transaction that credits the stock (arm 5). It says nothing about a multi-line PO's freight
 * distribution — that comes from using the same helper as the manual receipt, which is a property of
 * the code and not of this arm.
 */
test('o3d-6nd55: align-up lays a cost layer at the REAL purchase cost, not the zero default', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedAlignmentTarget('C', 5, 9)
  await assertUntouchedLandedCost(seeded.poLineId, seeded.unitCost)

  const result = await alignUp(seeded, { delta: seeded.qty, imsQty: 0 })
  assert.equal(result.applied, true, `PRECONDITION: the alignment must apply: ${result.reason}`)

  const layers = await db.costLayer.findMany({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  const movements = await db.stockMovement.findMany({
    where: { type: 'WMS_RECEIPT_RECONCILIATION', productId: seeded.productId },
    select: { qty: true, unitCostBase: true, totalValueBase: true },
  })
  console.log(`[arm1] examined ${layers.length} layer(s) ${JSON.stringify(layers)} and ${movements.length} movement(s) ${JSON.stringify(movements)}`)
  assert.equal(layers.length, 1, 'PRECONDITION: align-up must have laid exactly one PO-backed layer')
  assert.equal(movements.length, 1, 'PRECONDITION: and exactly one alignment movement')
  assert.equal(
    Number(layers[0]!.unitCostBase),
    seeded.unitCost,
    'the cost layer must carry the REAL unit cost — a zero-cost layer understates inventory for ever, '
    + 'and this is what `landedUnitCostBase ?? unitCostBase` always produced',
  )
  assert.equal(
    Number(movements[0]!.unitCostBase),
    seeded.unitCost,
    'and so must the stock movement',
  )
  assert.equal(Number(movements[0]!.totalValueBase), seeded.qty * seeded.unitCost)
})

/**
 * ARM 2 — DEFECT 2, THE MISSING JOURNAL AND TRANSIT ROW, AND THE THREE CONSUMERS AGREEING.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that queues the journal from OUTSIDE the transaction (arm 5
 * refuses that); a fix that posts twice against a later book-in of the same units (arms 6 and 7); a
 * fix that posts for a genuinely free line (arm 4); and a fix that reads a stale account mapping
 * (arm 8). It also would not notice a journal queued for a PO the movement does not name, which is
 * why it asserts the log's `referenceType`/`referenceId` explicitly.
 */
test('o3d-6nd55: align-up queues the STOCK_RECEIPT journal and the transit subledger row', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedAlignmentTarget('J', 6, 7)
  await assertUntouchedLandedCost(seeded.poLineId, seeded.unitCost)
  const expectedAmount = seeded.qty * seeded.unitCost

  const result = await alignUp(seeded, { delta: seeded.qty, imsQty: 0 })
  assert.equal(result.applied, true, `PRECONDITION: the alignment must apply: ${result.reason}`)

  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm2] examined ${logs.length} STOCK_RECEIPT log(s): ${JSON.stringify(logs.map((l) => l.payload))}`)
  assert.equal(
    logs.length,
    1,
    `align-up credits PO-backed stock and lays a cost layer, so it must queue exactly one receipt `
    + `journal; found ${logs.length}. Before this fix it queued none, and the transit reconciliation `
    + 'could not see that because the missing posting is absent from both of its sides.',
  )
  assert.equal(logs[0]!.referenceType, 'PurchaseOrder')
  assert.equal(logs[0]!.referenceId, seeded.poId)

  const lines = payloadLines(logs[0]!.payload)
  const debit = lines.find((l) => typeof l.debit === 'number')
  const credit = lines.find((l) => typeof l.credit === 'number')
  assert.ok(debit && credit, `the journal must have one debit and one credit line: ${JSON.stringify(lines)}`)
  assert.equal(debit.accountCode, INVENTORY_ACCOUNT, 'the DEBIT must be the inventory account')
  assert.equal(credit.accountCode, TRANSIT_ACCOUNT, 'and the CREDIT the transit clearing account')
  assert.equal(
    debit.debit,
    expectedAmount,
    `the debit must be ${seeded.qty} x ${seeded.unitCost} = ${expectedAmount}`,
  )
  assert.equal(credit.credit, expectedAmount, 'and the credit must equal the debit')

  // THE THREE CONSUMERS MUST AGREE — one value fed the movement, the layer and the journal.
  const movement = await db.stockMovement.findFirstOrThrow({
    where: { type: 'WMS_RECEIPT_RECONCILIATION', productId: seeded.productId },
    select: { qty: true, totalValueBase: true },
  })
  const layer = await db.costLayer.findFirstOrThrow({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  assert.equal(
    Number(movement.totalValueBase),
    debit.debit,
    'the movement value and the journal debit must be the same number',
  )
  assert.equal(
    Number(layer.unitCostBase) * Number(layer.receivedQty),
    debit.debit,
    'the cost-layer value and the journal debit must be the same number',
  )

  const transit = await transitRowsFor(seeded.poId)
  console.log(`[arm2] examined ${transit.length} transit row(s): ${JSON.stringify(transit.map((r) => String(r.baseDelta)))}`)
  assert.equal(transit.length, 1, 'the transit clearing account must be drained by a subledger row')
  assert.equal(transit[0]!.sourceType, 'STOCK_RECEIPT')
  assert.equal(
    Number(transit[0]!.baseDelta),
    -expectedAmount,
    'a receipt CREDITS transit, so the signed delta is −amount',
  )
})

/**
 * ARM 3 — FREIGHT MUST REACH THE MOVEMENT, THE LAYER AND THE JOURNAL ALIKE.
 *
 * The cost the manual receipt uses is not the goods cost: it is `computeGrossUnitCostBaseByLine`,
 * goods plus this line's share of the PO's additional cost lines. A fix that read `unitCostBase`
 * alone would pass arms 1 and 2 and still understate inventory — and disagree with the manual
 * receipt about the same units, which is the asymmetry this issue is about.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that distributes freight by a different method than the
 * manual receipt would for a MULTI-line PO. This PO has one line, so every distribution method gives
 * it the whole amount; the multi-line agreement comes from calling the same function, not from here.
 */
test('o3d-6nd55: freight on the PO reaches the layer, the movement and the journal alike', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 4
  const GOODS_UNIT = 10
  const FREIGHT_TOTAL = 20
  const seeded = await seedAlignmentTarget('F', QTY, GOODS_UNIT, FREIGHT_TOTAL)
  await assertUntouchedLandedCost(seeded.poLineId, GOODS_UNIT)
  const expectedUnitCost = GOODS_UNIT + FREIGHT_TOTAL / QTY
  const expectedAmount = QTY * expectedUnitCost
  assert.notEqual(expectedUnitCost, GOODS_UNIT, 'PRECONDITION: the freight share must move the unit cost')

  const result = await alignUp(seeded, { delta: QTY, imsQty: 0 })
  assert.equal(result.applied, true, `PRECONDITION: the alignment must apply: ${result.reason}`)

  const movement = await db.stockMovement.findFirstOrThrow({
    where: { type: 'WMS_RECEIPT_RECONCILIATION', productId: seeded.productId },
    select: { unitCostBase: true, totalValueBase: true },
  })
  const layer = await db.costLayer.findFirstOrThrow({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm3] goods ${GOODS_UNIT} + freight ${FREIGHT_TOTAL}/${QTY} => expected unit ${expectedUnitCost}; movement=${JSON.stringify(movement)} layer=${JSON.stringify(layer)} logs=${logs.length}`)

  assert.equal(
    Number(layer.unitCostBase),
    expectedUnitCost,
    'the cost layer must carry the GROSS (goods + freight) unit cost, as the manual receipt does',
  )
  assert.equal(Number(movement.unitCostBase), expectedUnitCost, 'and so must the movement')
  assert.equal(logs.length, 1, `the journal must be queued; found ${logs.length}`)
  const debit = payloadLines(logs[0]!.payload).find((l) => typeof l.debit === 'number')
  assert.ok(debit)
  assert.equal(
    debit.debit,
    expectedAmount,
    `the journal debit must be the gross value ${expectedAmount}, not the goods-only ${QTY * GOODS_UNIT}`,
  )
  assert.equal(Number(movement.totalValueBase), debit.debit, 'movement value == journal debit')
  assert.equal(Number(layer.unitCostBase) * Number(layer.receivedQty), debit.debit, 'layer value == journal debit')

  const transit = await transitRowsFor(seeded.poId)
  assert.equal(transit.length, 1)
  assert.equal(Number(transit[0]!.baseDelta), -expectedAmount)
})

/**
 * ARM 4 — A GENUINELY FREE LINE CREDITS STOCK AND POSTS NOTHING.
 *
 * Zero CAN be legitimate: a free-of-charge line, a sample, a warranty replacement has
 * `unitCostForeign` 0, so the gross cost is 0 and there is no value to move into inventory. Posting
 * a zero journal would be noise the ledger would reject. This is what makes a nullable column
 * unnecessary — the legitimate case is distinguished by the GOODS cost being zero, which arms 1-3
 * assert is positive in the defect case.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that posts nothing for ANY purchase order, which is the
 * pre-fix behaviour and is what arms 2 and 3 refuse.
 */
test('o3d-6nd55: a genuinely free line aligns stock up and posts nothing', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedAlignmentTarget('Z', 3, 0)

  const result = await alignUp(seeded, { delta: seeded.qty, imsQty: 0 })
  assert.equal(result.applied, true, `PRECONDITION: the alignment must apply: ${result.reason}`)

  const movements = await db.stockMovement.count({
    where: { type: 'WMS_RECEIPT_RECONCILIATION', productId: seeded.productId },
  })
  const level = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  const transit = await transitRowsFor(seeded.poId)
  console.log(`[arm4] free line: ${movements} movement(s), stock=${String(level.quantity)}, ${logs.length} log(s), ${transit.length} transit row(s)`)
  assert.equal(movements, 1, 'PRECONDITION: the units must still be credited — free goods are still goods')
  assert.equal(Number(level.quantity), seeded.qty, 'PRECONDITION: and they must reach stock')
  assert.equal(logs.length, 0, 'a zero-value alignment must post no journal — there is no value to move')
  assert.equal(transit.length, 0, 'and nothing to drain from transit')
})

/**
 * ARM 5 — THE JOURNAL AND THE STOCK ARE ONE UNIT OF WORK.
 *
 * An alignment that credits stock and lays a layer while its journal is merely attempted is the
 * defect in a new costume: inventory value raised, ledger not told. This arm makes the enqueue throw
 * and asserts that NOTHING committed — no movement, no layer, no stock, and the ASN line's
 * `qtyAccountedViaSnapshot` untouched, so the next sweep can try again.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that is transactional but posts the wrong amount (arms 2 and
 * 3), and a fix that swallows the error and reports the alignment as NOT applied while still
 * committing nothing — which is behaviourally the same outcome for the database and is why this arm
 * asserts the rows rather than the thrown error's type.
 */
test('o3d-6nd55: if the journal enqueue fails, the alignment commits no stock either', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedAlignmentTarget('T', 5, 8)

  injectEnqueueFailure = true
  let threw: unknown = null
  let applied: boolean | null = null
  try {
    applied = (await alignUp(seeded, { delta: seeded.qty, imsQty: 0 })).applied
  } catch (error) {
    threw = error
  } finally {
    injectEnqueueFailure = false
  }
  console.log(`[arm5] enqueue failure => threw=${threw instanceof Error ? threw.message : String(threw)} applied=${String(applied)}`)
  assert.ok(
    threw !== null || applied === false,
    'a failed journal enqueue must not report a successful alignment',
  )

  const movements = await db.stockMovement.count({ where: { productId: seeded.productId } })
  const layers = await db.costLayer.count({ where: { poLineId: seeded.poLineId } })
  const level = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  const asnLine = await db.wmsAsnLineMap.findUniqueOrThrow({
    where: { id: seeded.asnLineMapId },
    select: { qtyAccountedViaSnapshot: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm5] examined ${movements} movement(s), ${layers} layer(s), stock=${String(level.quantity)}, snapshotQty=${String(asnLine.qtyAccountedViaSnapshot)}, ${logs.length} log(s)`)
  assert.equal(movements, 0, 'the movement must have rolled back with the journal')
  assert.equal(layers, 0, 'and the cost layer')
  assert.equal(Number(level.quantity), 0, 'and the stock')
  assert.equal(
    Number(asnLine.qtyAccountedViaSnapshot),
    0,
    'and the ASN line must not claim to have absorbed units it did not, or the next sweep would skip them',
  )
  assert.equal(logs.length, 0, 'and no journal may survive')
})

/**
 * ARM 6 — COMPOSITION, DIRECTION ONE: ALIGN-UP FIRST, THEN A BOOK-IN OF THE SAME ASN LINE.
 *
 * This is the arm most likely to be got wrong, because the two fixes touch different paths in
 * different transactions and a naive one would post the same units twice.
 *
 * THE MECHANISM, and why the composition holds: align-up journals `allocation.qty` and, in the SAME
 * transaction, increments `wms_asn_line_maps.qtyAccountedViaSnapshot` by it. The book-in journals
 * `stockQtyToAdd` = `qtyReceived − coveredBySnapshotQty`, and `coveredBySnapshotQty` is derived from
 * exactly that column (lib/domain/wms/asn-reconciliation.ts:203-205). So what align-up posted is
 * what the book-in excludes.
 *
 * WHAT THIS ARM MEASURES on this branch, stated exactly. It aligns 6 of 10 units, then books in all
 * 10, and asserts:
 *   · align-up's journal covers 6 units and only 6;
 *   · the book-in lays a layer for the remaining 4 and NOT for the 6 already layered;
 *   · the total layered quantity for the PO line is 10 — each unit costed EXACTLY ONCE, so no unit
 *     can be journalled twice by two writers that each journal the units they layer.
 *
 * WHAT WOULD STILL PASS THIS ARM, and this is a real limit: the book-in's OWN journal is added by
 * o3d-8f0p6, which is NOT on this branch, so this arm cannot read the book-in's journal amount. It
 * pins the quantity exclusion that makes the two amounts disjoint; the book-in's half is pinned from
 * the other side by arm 6 of tests/concurrency/wms-purchase-receipt-journal.concurrent.test.ts on
 * that branch, whose mutation swapping `stockQtyToAdd` for `qtyReceived` turns it red. The arm also
 * says nothing about a book-in that reports FEWER units than alignment already credited — that is
 * `resolveWmsAsnLineResidualQty`'s max(), exercised by arm 7 from the other direction.
 */
test('o3d-6nd55: units align-up has journalled are excluded from a later book-in', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const TOTAL = 10
  const ALIGNED = 6
  const seeded = await seedAlignmentTarget('X', TOTAL, 5)
  await assertUntouchedLandedCost(seeded.poLineId, seeded.unitCost)

  const aligned = await alignUp(seeded, { delta: ALIGNED, imsQty: 0 })
  assert.equal(aligned.applied, true, `PRECONDITION: the alignment must apply: ${aligned.reason}`)

  const logsAfterAlign = await stockReceiptLogsFor(seeded.poId)
  assert.equal(logsAfterAlign.length, 1, 'PRECONDITION: align-up must have posted exactly one journal')
  const alignDebit = payloadLines(logsAfterAlign[0]!.payload).find((l) => typeof l.debit === 'number')
  assert.ok(alignDebit)
  assert.equal(
    alignDebit.debit,
    ALIGNED * seeded.unitCost,
    `align-up must journal only the ${ALIGNED} units it credited`,
  )
  const snapshotAfterAlign = await db.wmsAsnLineMap.findUniqueOrThrow({
    where: { id: seeded.asnLineMapId },
    select: { qtyAccountedViaSnapshot: true },
  })
  assert.equal(
    Number(snapshotAfterAlign.qtyAccountedViaSnapshot),
    ALIGNED,
    'PRECONDITION: and must have recorded them on the ASN line — that column IS the exclusion the '
    + 'book-in reads, so if it were not written the composition claim would be empty',
  )

  const status = await runBookedIn(seeded, TOTAL)
  assert.equal(status, 'processed', 'PRECONDITION: the book-in must process')

  const layers = await db.costLayer.findMany({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true, adjustmentMovementId: true },
  })
  const totalLayered = layers.reduce((sum, layer) => sum + Number(layer.receivedQty), 0)
  const level = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  console.log(`[arm6] examined ${layers.length} layer(s) ${JSON.stringify(layers)}; totalLayered=${totalLayered}; stock=${String(level.quantity)}`)
  assert.equal(
    totalLayered,
    TOTAL,
    `each unit must be costed exactly once across both writers: expected ${TOTAL}, got ${totalLayered}. `
    + `A double-count would read ${TOTAL + ALIGNED}.`,
  )
  assert.equal(Number(level.quantity), TOTAL, 'and stock must be the physical quantity, not the sum of both paths')
  const bookInLayered = totalLayered - ALIGNED
  assert.equal(
    bookInLayered,
    TOTAL - ALIGNED,
    `the book-in must have layered only the ${TOTAL - ALIGNED} units alignment did not`,
  )

  const logs = await stockReceiptLogsFor(seeded.poId)
  const debits = logs
    .map((log) => payloadLines(log.payload).find((l) => typeof l.debit === 'number')?.debit ?? 0)
    .reduce((sum, value) => sum + value, 0)
  console.log(`[arm6] ${logs.length} STOCK_RECEIPT log(s) totalling ${debits} across both writers`)
  assert.ok(
    debits <= TOTAL * seeded.unitCost,
    `the two writers together must never journal more than the ${TOTAL * seeded.unitCost} of value `
    + `that actually entered inventory; they journalled ${debits}`,
  )
})

/**
 * ARM 7 — COMPOSITION, DIRECTION TWO: A BOOK-IN FIRST, THEN ALIGN-UP.
 *
 * The reverse exclusion is `resolveWmsAsnLineResidualQty`
 * (lib/domain/inventory/transfer-landed-quantity.ts:409): an ASN line's capacity is
 * `expectedQty − max(qtyAccountedViaSnapshot, lastProcessedReceivedQty)`. Units a book-in already
 * landed raised `lastProcessedReceivedQty`, so they are outside every allocation align-up can make
 * and cannot be journalled here a second time. Unlike arm 6 this direction is FULLY measurable on
 * this branch, because both the exclusion and the journal it protects live here.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that journals the right quantity but at the wrong cost (arms
 * 1 and 3), and a fix that refuses to align at all after a book-in — which would also leave one
 * journal, so the arm additionally asserts that align-up DID apply and DID credit the remainder.
 */
test('o3d-6nd55: align-up journals only the units a prior book-in did not', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const TOTAL = 10
  const BOOKED = 4
  const seeded = await seedAlignmentTarget('Y', TOTAL, 5)
  await assertUntouchedLandedCost(seeded.poLineId, seeded.unitCost)

  const status = await runBookedIn(seeded, BOOKED)
  assert.equal(status, 'processed', 'PRECONDITION: the book-in must process')
  const afterBookIn = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  assert.equal(Number(afterBookIn.quantity), BOOKED, `PRECONDITION: the book-in must have landed ${BOOKED} units`)

  // The sweep now sees Mintsoft at TOTAL and IMS at BOOKED.
  const aligned = await alignUp(seeded, { delta: TOTAL - BOOKED, imsQty: BOOKED })
  assert.equal(aligned.applied, true, `PRECONDITION: the alignment must apply: ${aligned.reason}`)

  const level = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  const layers = await db.costLayer.findMany({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true },
  })
  const totalLayered = layers.reduce((sum, layer) => sum + Number(layer.receivedQty), 0)
  const alignLogs = await stockReceiptLogsFor(seeded.poId)
  const alignDebits = alignLogs
    .map((log) => payloadLines(log.payload).find((l) => typeof l.debit === 'number')?.debit ?? 0)
  console.log(`[arm7] stock=${String(level.quantity)} totalLayered=${totalLayered} logs=${JSON.stringify(alignDebits)}`)

  assert.equal(Number(level.quantity), TOTAL, 'stock must reach the physical quantity and no more')
  assert.equal(totalLayered, TOTAL, 'each unit costed exactly once across both writers')
  assert.equal(
    alignLogs.length,
    1,
    `align-up must post exactly one journal, for the ${TOTAL - BOOKED} units the book-in did not land; `
    + `found ${alignLogs.length}`,
  )
  assert.equal(
    alignDebits[0],
    (TOTAL - BOOKED) * seeded.unitCost,
    `and it must cover ${TOTAL - BOOKED} units, not all ${TOTAL} — the units the book-in already landed `
    + 'are excluded by resolveWmsAsnLineResidualQty',
  )
  const transit = await transitRowsFor(seeded.poId)
  assert.equal(transit.length, 1)
  assert.equal(Number(transit[0]!.baseDelta), -(TOTAL - BOOKED) * seeded.unitCost)
})

/**
 * ARM 8 — THE ACCOUNT MAPPING MUST NOT MOVE UNDER THE POSTING.
 *
 * Copied deliberately from o3d-8f0p6's round-1 HIGH 2 rather than reinvented: codes read over the
 * POOL before the transaction opened, with nothing rechecking them, mean an operator remapping the
 * inventory or transit account in that window gets a committed journal on the OLD codes while every
 * later reconciliation uses the NEW ones. The enqueue's own fence does not cover it —
 * `pinnedLedgerIsServicedUnderLock` locks the `plugin_*` rows only.
 *
 * This arm commits a remap from a SEPARATE pooled connection while the alignment is mid-flight, so
 * the post-enqueue re-read sees it, and asserts the WHOLE alignment refused: no journal AND no stock.
 *
 * WHAT WOULD STILL PASS THIS ARM: binding by a lock instead of a refusal (also correct, and
 * stronger); and a fix that refuses on ANY enqueue, which arms 2, 3, 6 and 7 refuse. It establishes
 * nothing about a remap that commits after this transaction does — that is a different posting,
 * correctly on the new codes.
 */
test('o3d-6nd55: an account remap mid-alignment refuses the whole alignment', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedAlignmentTarget('M', 2, 11)

  remapInventoryAccountOnNextEnqueue = async () => {
    await db.setting.update({ where: { key: 'xero_inventory_account' }, data: { value: '699' } })
  }
  let threw: unknown = null
  let applied: boolean | null = null
  try {
    applied = (await alignUp(seeded, { delta: seeded.qty, imsQty: 0 })).applied
  } catch (error) {
    threw = error
  } finally {
    remapInventoryAccountOnNextEnqueue = null
    await db.setting.update({ where: { key: 'xero_inventory_account' }, data: { value: INVENTORY_ACCOUNT } })
  }
  const message = threw instanceof Error ? threw.message : String(threw)
  console.log(`[arm8] alignment with the mapping remapped mid-flight => threw=${message} applied=${String(applied)}`)
  assert.notEqual(applied, true, 'an alignment whose account mapping moved must not report success')
  assert.match(
    message,
    /mapping changed/i,
    'and it must say WHY, or an operator cannot tell this from any other failure',
  )

  const movements = await db.stockMovement.count({ where: { productId: seeded.productId } })
  const layers = await db.costLayer.count({ where: { poLineId: seeded.poLineId } })
  const logs = await stockReceiptLogsFor(seeded.poId)
  const level = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  console.log(`[arm8] examined ${movements} movement(s), ${layers} layer(s), ${logs.length} log(s), stock=${String(level.quantity)}`)
  assert.equal(movements, 0, 'the stock movement must have rolled back with the refused journal')
  assert.equal(layers, 0, 'and the cost layer')
  assert.equal(Number(level.quantity), 0, 'and the stock level')
  assert.equal(logs.length, 0, 'and no journal may survive on the stale codes')
})
