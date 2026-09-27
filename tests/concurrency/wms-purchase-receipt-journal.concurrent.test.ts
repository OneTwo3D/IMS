import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import * as realAccountingNs from '@/lib/accounting'
import { liveMintsoftBookedInAsnRef } from '@/tests/helpers/live-mintsoft-asn-ref'

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * o3d-8f0p6 — A PURCHASE-ORDER-BACKED WMS BOOK-IN MUST POST THE SAME INVENTORY
 * VALUE THE MANUAL RECEIPT POSTS, IN THE SAME TRANSACTION AS THE STOCK.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT. There are exactly two writers of a PURCHASE_RECEIPT stock movement.
 * The MANUAL receipt (app/actions/purchase-orders.ts) credits stock, lays FIFO cost
 * layers AND, in the same transaction, queues a STOCK_RECEIPT journal
 * (DR Inventory / CR Stock in Transit) plus the transit-clearing subledger row for
 * −value. The WMS webhook BOOK-IN (lib/domain/wms/booked-in-service.ts) did
 * NEITHER: `grep -n 'queueAccountingSync|STOCK_RECEIPT|recordTransitSubledger'` over
 * that file returned nothing. So one physical event produced two different sets of
 * books depending on which route the goods arrived by.
 *
 * WHY NOTHING ELSE COVERS IT — SETTLED BEFORE THIS TEST WAS WRITTEN, because the
 * answer decides the fix and the wrong answer double-posts. Nothing downstream
 * derives a receipt journal from `stock_movements`:
 *
 *   · `lib/connectors/xero/daily-sync.ts` does not read `stock_movements` at all.
 *     Its DAILY_BATCH_INVENTORY_RECONCILIATION posts Inventory ↔ ROUNDING
 *     DIFFERENCE and only for an `action === 'sweep'` gap —
 *     `lib/domain/accounting/account-gl-reconciliation.ts:102` returns null
 *     otherwise, and a receipt-sized gap is `flag` (limit £1, same file :40).
 *     A material gap is surfaced, NEVER posted.
 *   · `lib/domain/accounting/transit-gl-reconciliation.ts` aggregates
 *     `transit_subledger_movements`, i.e. rows written AT POST TIME. A posting that
 *     never happened is absent from both sides, so that window ties out exactly and
 *     does not even detect the omission — the same trap already written down at
 *     `lib/domain/inventory/movement-cogs-relevance.ts:291-295`.
 *   · the invariant collectors report and never remediate; no cron route reads
 *     `stockMovement` at all; `back-reference-sweep` only repairs rows that ALREADY
 *     posted (`externalTransactionId: { not: null }`).
 *
 * So the journal has to be queued AT THE SOURCE, which is what these arms measure.
 *
 * WHY THIS FILE NEEDS A REAL PostgreSQL. The claim is not "a function was called";
 * it is "the journal and the stock are one unit of work". Arm 5 makes the enqueue
 * throw and then asserts the STOCK is gone — a statement only a real transaction
 * can make, and the exact statement a test double with no rollback would fake.
 *
 * WHAT WOULD STILL PASS EACH ARM is written above the arm, so a green run is not
 * mistaken for more than it establishes.
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
 * THE ONE SEAM IN THIS FILE, and it is OFF unless an arm switches it on (arm 5).
 *
 * `queueAccountingSyncTx` is otherwise THE REAL ONE: every other arm's journal is
 * written by production code through production settings, so no arm can pass on a
 * fixture's generosity. Arm 5 needs the enqueue to FAIL in order to ask what happens
 * to the stock, and there is no other way to make a correct enqueue fail.
 */
let injectEnqueueFailure = false
const INJECTED_ENQUEUE_FAILURE = 'o3d-8f0p6 injected STOCK_RECEIPT enqueue failure'
mock.module('@/lib/accounting', {
  namedExports: {
    ...realAccountingNs,
    queueAccountingSyncTx: async (
      ...args: Parameters<typeof realAccountingNs.queueAccountingSyncTx>
    ) => {
      if (injectEnqueueFailure && args[1]?.type === 'STOCK_RECEIPT') {
        throw new Error(INJECTED_ENQUEUE_FAILURE)
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

const UNIT_COST = 7
const INVENTORY_ACCOUNT = '630'
const TRANSIT_ACCOUNT = '631'

function uniqueTag(label: string): string {
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  return `JRNL${label}${process.pid}${uid}`.replace(/[^A-Z0-9]/g, '').slice(0, 28)
}

/**
 * Switch the accounting connector on so the enqueue reaches its INSERT instead of
 * answering `not-configured` first. `plugin_xero_enabled` is the key
 * `queueAccountingSyncTx` resolves the ACTIVE connector from — getting it wrong
 * makes every assertion below hold over an enqueue that never ran, which is why
 * arm 1 asserts the row EXISTS rather than only checking its shape if present.
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

type SeededPurchaseAsn = {
  tag: string
  qty: number
  productId: string
  warehouseId: string
  poId: string
  poLineId: string
  asnMapId: string
  asnLineMapId: string
  externalAsnLineId: string
}

/**
 * A PO + line + an OPEN purchase-backed ASN with nothing received locally yet.
 *
 * `alignmentCreditedQty` pre-credits part of the line the way the WMS STOCK-SYNC ALIGNMENT does:
 * `wms_asn_line_maps.qtyAccountedViaSnapshot` plus the cost layer and stock those units already
 * have. That path never writes `purchase_order_lines.qtyReceived` (docs/mintsoft.md), so the local
 * received quantity stays 0 — which is exactly what makes `qtyReceived` differ from
 * `stockQtyToAdd` on the next book-in. It is also, itself, unjournalled: that is o3d-6nd55, filed
 * separately, and it is why this fixture writes the layer directly rather than running that path.
 */
async function seedPurchaseBackedAsn(label: string, qty: number, alignmentCreditedQty = 0): Promise<SeededPurchaseAsn> {
  const { db } = await import('@/lib/db')
  const tag = uniqueTag(label)
  const total = qty * UNIT_COST
  const product = await db.product.create({
    data: { sku: tag, name: `o3d-8f0p6 ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const warehouse = await db.warehouse.create({
    data: { code: tag.slice(-10), name: `${tag} wh`, type: 'STANDARD' },
    select: { id: true },
  })
  await db.stockLevel.create({
    data: { productId: product.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' },
    select: { productId: true },
  })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const po = await db.purchaseOrder.create({
    data: {
      reference: tag,
      supplierId: supplier.id,
      status: 'PO_SENT',
      currency: 'GBP',
      fxRateToBase: '1',
      subtotalForeign: total,
      subtotalBase: total,
      totalForeign: total,
      totalBase: total,
      destinationWarehouseId: warehouse.id,
      lines: {
        create: [{
          productId: product.id,
          qty: `${qty}.0000`,
          qtyReceived: '0.0000',
          unitCostForeign: `${UNIT_COST}.000000`,
          unitCostBase: `${UNIT_COST}.000000`,
          landedUnitCostBase: `${UNIT_COST}.000000`,
          totalForeign: total,
          totalBase: total,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-8f0p6: a test fixture row, not a core flow branch
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
          qtyAccountedViaSnapshot: `${alignmentCreditedQty}.0000`,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true, externalAsnLineId: true } } },
  })
  if (alignmentCreditedQty > 0) {
    await db.costLayer.create({
      data: {
        productId: product.id,
        warehouseId: warehouse.id,
        receivedQty: `${alignmentCreditedQty}.000000`,
        remainingQty: `${alignmentCreditedQty}.000000`,
        unitCostBase: `${UNIT_COST}.000000`,
        poLineId: po.lines[0]!.id,
        isOpeningStock: false,
      },
      select: { id: true },
    })
    await db.stockLevel.update({
      where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
      data: { quantity: `${alignmentCreditedQty}.000000` },
    })
  }
  return {
    tag,
    qty,
    productId: product.id,
    warehouseId: warehouse.id,
    poId: po.id,
    poLineId: po.lines[0]!.id,
    asnMapId: asn.id,
    asnLineMapId: asn.lines[0]!.id,
    externalAsnLineId: asn.lines[0]!.externalAsnLineId,
  }
}

type SeededTransferAsn = {
  tag: string
  qty: number
  productId: string
  destinationWarehouseId: string
  transferId: string
  transferLineId: string
  asnLineMapId: string
  externalAsnLineId: string
}

/** An IN_TRANSIT transfer with a dispatch cost-layer snapshot + a transfer-backed ASN. */
async function seedTransferBackedAsn(label: string, qty: number): Promise<SeededTransferAsn> {
  const { db } = await import('@/lib/db')
  const tag = uniqueTag(label)
  const product = await db.product.create({
    data: { sku: tag, name: `o3d-8f0p6 ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const source = await db.warehouse.create({
    data: { code: `S${tag.slice(-9)}`, name: `${tag} src`, type: 'STANDARD' },
    select: { id: true },
  })
  const destination = await db.warehouse.create({
    data: { code: `D${tag.slice(-9)}`, name: `${tag} dst`, type: 'STANDARD' },
    select: { id: true },
  })
  // The SOURCE layer the dispatch consumed: its value already sits in inventory, which is
  // the whole reason a transfer receipt posts nothing.
  const sourceLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: source.id,
      receivedQty: `${qty}.000000`,
      remainingQty: '0.000000',
      unitCostBase: `${UNIT_COST}.000000`,
      isOpeningStock: false,
    },
    select: { id: true },
  })
  await db.stockLevel.create({
    data: { productId: product.id, warehouseId: destination.id, quantity: '0', reservedQty: '0' },
    select: { productId: true },
  })
  const transfer = await db.stockTransfer.create({
    data: {
      reference: tag,
      fromWarehouseId: source.id,
      toWarehouseId: destination.id,
      status: 'IN_TRANSIT',
      dispatchedAt: new Date(),
      lines: {
        create: [{
          productId: product.id,
          sku: tag,
          productName: `o3d-8f0p6 ${label}`,
          qty: `${qty}.0000`,
          qtyReceived: '0.0000',
          costLayerSnapshot: [{
            costLayerId: sourceLayer.id,
            qty: `${qty}.000000`,
            unitCostBase: `${UNIT_COST}.000000`,
          }],
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-8f0p6: a test fixture row, not a core flow branch
      externalAsnId: tag,
      sourceType: 'STOCK_TRANSFER',
      sourceId: transfer.id,
      warehouseId: destination.id,
      status: 'OPEN',
      lines: {
        create: [{
          externalAsnLineId: `${tag}-1`,
          sourceType: 'STOCK_TRANSFER_LINE',
          sourceLineId: transfer.lines[0]!.id,
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
    productId: product.id,
    destinationWarehouseId: destination.id,
    transferId: transfer.id,
    transferLineId: transfer.lines[0]!.id,
    asnLineMapId: asn.lines[0]!.id,
    externalAsnLineId: asn.lines[0]!.externalAsnLineId,
  }
}

/** The real webhook book-in, for `bookedQty` of the seeded line. */
async function runBookedIn(
  seeded: { tag: string; qty: number; externalAsnLineId: string },
  sourceLineId: string,
  bookedQty = seeded.qty,
): Promise<{ status: string; eventId: string }> {
  const { db } = await import('@/lib/db')
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const event = await db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-8f0p6: a test fixture row, not a core flow branch
      externalEventId: `${seeded.tag}-evt-${Math.random().toString(36).slice(2, 10)}`,
      externalAsnId: seeded.tag,
      payload: { asnId: seeded.tag },
    },
    select: { id: true },
  })
  const remote = liveMintsoftBookedInAsnRef({
    externalAsnId: seeded.tag,
    externalLineId: seeded.externalAsnLineId,
    sourceLineId,
    sku: seeded.tag,
    expectedQty: seeded.qty,
    bookedQty,
  })
  const result = await processBookedInEvent(event.id, {
    fetchRemoteAsn: async () => ({ ...remote, status: 'RECEIVED', raw: null }),
  })
  return { status: result.status, eventId: event.id }
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

/** The enqueue's idempotency key, which `queueAccountingSyncTx` stores in the payload (lib/accounting.ts:637). */
function payloadIdempotencyKey(payload: unknown): string {
  const key = (payload as { _idempotencyKey?: unknown } | null)?._idempotencyKey
  assert.equal(typeof key, 'string', `sync-log payload carries no _idempotencyKey: ${JSON.stringify(payload)}`)
  return key as string
}

/** The journal lines, as the payload carries them. */
function payloadLines(payload: unknown): Array<{ accountCode?: string; debit?: number; credit?: number }> {
  const lines = (payload as { lines?: unknown } | null)?.lines
  assert.ok(Array.isArray(lines), `sync-log payload carries no lines array: ${JSON.stringify(payload)}`)
  return lines as Array<{ accountCode?: string; debit?: number; credit?: number }>
}

/**
 * ARM 1 — THE DEFECT ITSELF.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that queues the journal from OUTSIDE the
 * transaction (arm 5 is the one that refuses that), a fix that gets the transfer
 * case wrong (arm 4), and a fix that re-posts on retry (arms 2 and 3). It also
 * would not notice a journal queued for a PO the movement does not name, because it
 * reads both by `poId` — arm 1 therefore asserts the movement's OWN referenceId too.
 */
test('o3d-8f0p6: a PO-backed WMS book-in queues the STOCK_RECEIPT journal and the transit subledger row', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedPurchaseBackedAsn('A', 4)
  const expectedAmount = seeded.qty * UNIT_COST

  const { status } = await runBookedIn(seeded, seeded.poLineId)
  assert.equal(status, 'processed', 'the book-in must commit before its accounting can be measured')

  // ── the physical effects: present, and the reason the journal is owed ──────────
  const movements = await db.stockMovement.findMany({
    where: { type: 'PURCHASE_RECEIPT', productId: seeded.productId },
    select: { id: true, qty: true, referenceType: true, referenceId: true, totalValueBase: true },
  })
  console.log(`[arm1] examined ${movements.length} PURCHASE_RECEIPT movement(s): ${JSON.stringify(movements)}`)
  assert.equal(movements.length, 1, 'the book-in must have credited stock — with no movement there is nothing to account for')
  assert.equal(movements[0]!.referenceType, 'PurchaseOrder')
  assert.equal(movements[0]!.referenceId, seeded.poId)
  assert.equal(Number(movements[0]!.qty), seeded.qty)

  const layers = await db.costLayer.findMany({
    where: { productId: seeded.productId, poLineId: seeded.poLineId },
    select: { id: true, receivedQty: true, unitCostBase: true },
  })
  console.log(`[arm1] examined ${layers.length} cost layer(s): ${JSON.stringify(layers)}`)
  assert.equal(layers.length, 1, 'the FIFO layer must exist — inventory VALUE went up, which is what the GL must be told')
  assert.equal(Number(layers[0]!.receivedQty), seeded.qty)
  assert.equal(Number(layers[0]!.unitCostBase), UNIT_COST)

  const level = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  assert.equal(Number(level.quantity), seeded.qty)

  // ── the accounting: THE ASSERTION THAT WAS RED BEFORE THE FIX ─────────────────
  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm1] examined ${logs.length} STOCK_RECEIPT sync log(s) for PO ${seeded.poId}: ${JSON.stringify(logs.map((l) => ({ id: l.id, payload: l.payload })))}`)
  assert.equal(
    logs.length,
    1,
    `a PO-backed WMS book-in must queue exactly one STOCK_RECEIPT journal; found ${logs.length}. `
    + 'Qoblex posts inventory value changes to Xero today, so a book-in that credits stock and lays '
    + 'cost layers without this journal cannot replace it (o3d-8f0p6).',
  )
  assert.equal(logs[0]!.referenceType, 'PurchaseOrder')
  const lines = payloadLines(logs[0]!.payload)
  assert.equal(lines.length, 2, `the receipt journal must be the two-line DR inventory / CR transit: ${JSON.stringify(lines)}`)
  const debit = lines.find((line) => typeof line.debit === 'number')
  const credit = lines.find((line) => typeof line.credit === 'number')
  assert.ok(debit, `no debit line: ${JSON.stringify(lines)}`)
  assert.ok(credit, `no credit line: ${JSON.stringify(lines)}`)
  assert.equal(debit.accountCode, INVENTORY_ACCOUNT, 'the DEBIT must land on the inventory account')
  assert.equal(credit.accountCode, TRANSIT_ACCOUNT, 'the CREDIT must drain the stock-in-transit clearing account')
  assert.equal(debit.debit, expectedAmount, `the debit must equal the cost-layer value laid (${seeded.qty} x ${UNIT_COST})`)
  assert.equal(credit.credit, expectedAmount, 'the credit must equal the debit — the journal must balance')

  // ── the transit subledger row: independent of the journal, and separately owed ─
  const transit = await transitRowsFor(seeded.poId)
  console.log(`[arm1] examined ${transit.length} transit subledger row(s) for PO ${seeded.poId}: ${JSON.stringify(transit.map((r) => ({ ...r, baseDelta: String(r.baseDelta) })))}`)
  assert.equal(
    transit.length,
    1,
    `the book-in must record exactly one transit subledger movement; found ${transit.length}. `
    + 'Without it the DAILY_BATCH_TRANSIT_RECONCILIATION window is missing this receipt on the '
    + 'subledger side as well as the GL side, so it ties out and CANNOT detect the omission '
    + '(lib/domain/inventory/movement-cogs-relevance.ts:291-295).',
  )
  assert.equal(transit[0]!.sourceType, 'STOCK_RECEIPT')
  assert.equal(
    Number(transit[0]!.baseDelta),
    -expectedAmount,
    'transit is CREDITED by a receipt, so the signed subledger delta must be the negative receipt value',
  )
  assert.equal(
    transit[0]!.idempotencyKey,
    payloadIdempotencyKey(logs[0]!.payload),
    'the subledger row must be keyed on the journal it mirrors, or a re-staged journal records twice',
  )
})

/**
 * ARM 2 — A RETRY MUST NOT POST TWICE.
 *
 * Two retries, because they take different routes through the service:
 *   (a) a RE-DELIVERED webhook (a second event for the same ASN, same remote
 *       quantities). `reconcileBookedInQuantities` finds nothing newly booked, so
 *       no line survives the filter and there is nothing to journal.
 *   (b) the SAME event replayed with `processedAt` cleared — this one reaches the
 *       movement INSERT and is refused by the movement's own unique idempotency key,
 *       then `continue`s, so nothing is accumulated and nothing is journalled.
 *
 * WHICH OF THE TWO FENCES THIS ACTUALLY EXERCISES, stated because a mutation settled
 * it rather than an argument: making the enqueue's OWN idempotency key random left
 * every arm in this file green. So what stops a second journal on a replay is the
 * STOCK MOVEMENT's unique idempotency key — it makes `stockQtyToAdd` contribute
 * nothing, so the enqueue is never reached a second time — and NOT the deterministic
 * enqueue key, which is defence in depth. No reachable path in this service enqueues
 * twice for one receipt event, which is exactly why the key's determinism cannot be
 * shown to matter here; it is kept because a key that can collide with the manual
 * receipt's would be a real defect, not because this arm proves it does not.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that never posts at all (arm 1 refuses that),
 * a fix that journals the reconciled quantity instead of the quantity it laid layers
 * for (arm 6 is the only arm that sees that — it was added BECAUSE that mutation
 * survived arms 1-5), and any change to the enqueue key.
 */
test('o3d-8f0p6: a retried book-in does not post the STOCK_RECEIPT journal twice', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedPurchaseBackedAsn('B', 3)
  const expectedAmount = seeded.qty * UNIT_COST

  const first = await runBookedIn(seeded, seeded.poLineId)
  assert.equal(first.status, 'processed')
  const afterFirst = await stockReceiptLogsFor(seeded.poId)
  assert.equal(afterFirst.length, 1, 'PRECONDITION: the first book-in must have posted, or a "no second post" claim is vacuous')

  // (a) a re-delivered webhook for the same ASN.
  const redelivered = await runBookedIn(seeded, seeded.poLineId)
  console.log(`[arm2] re-delivered webhook returned status=${redelivered.status}`)

  // (b) the SAME event replayed: clear processedAt so the service re-enters the receipt loop.
  await db.wmsInboundReceiptEvent.update({
    where: { id: first.eventId },
    data: { processedAt: null, processingStatus: 'PENDING' },
  })
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const remote = liveMintsoftBookedInAsnRef({
    externalAsnId: seeded.tag,
    externalLineId: seeded.externalAsnLineId,
    sourceLineId: seeded.poLineId,
    sku: seeded.tag,
    expectedQty: seeded.qty,
    bookedQty: seeded.qty,
  })
  const replay = await processBookedInEvent(first.eventId, {
    fetchRemoteAsn: async () => ({ ...remote, status: 'RECEIVED', raw: null }),
  })
  console.log(`[arm2] same-event replay returned status=${replay.status}`)

  const logs = await stockReceiptLogsFor(seeded.poId)
  const transit = await transitRowsFor(seeded.poId)
  const movements = await db.stockMovement.count({ where: { type: 'PURCHASE_RECEIPT', productId: seeded.productId } })
  console.log(`[arm2] examined ${logs.length} STOCK_RECEIPT log(s), ${transit.length} transit row(s), ${movements} movement(s) after two retries`)
  assert.equal(movements, 1, 'PRECONDITION: no retry may credit stock a second time')
  assert.equal(logs.length, 1, `a retry must not queue a second STOCK_RECEIPT journal; found ${logs.length}`)
  assert.equal(transit.length, 1, `a retry must not record a second transit subledger row; found ${transit.length}`)
  assert.equal(Number(transit[0]!.baseDelta), -expectedAmount, 'and the one row must still carry the single receipt value')
})

/**
 * ARM 3 — THE GOODS WERE ALSO RECEIVED BY HAND.
 *
 * The REAL manual receipt runs first and posts its own journal; the webhook then
 * arrives for the same units. `reconcileBookedInQuantities` recognises them as
 * already received locally (`reconciledManualQty`), lays no layer and credits no
 * stock — so it must journal NOTHING, and the books must show exactly ONE receipt
 * journal for the PO, not two.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that posts on the WMS path only when the
 * whole line is new. The partial case (manual receipt of part, webhook books the
 * rest) is NOT covered here; arm 1's amount assertion is what pins the journal to
 * the value actually laid, and that is the property the partial case needs.
 */
test('o3d-8f0p6: a book-in of goods already received by hand adds no second journal', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedPurchaseBackedAsn('C', 5)
  const expectedAmount = seeded.qty * UNIT_COST

  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const manual = await receivePurchaseOrder(seeded.poId, [
    { poLineId: seeded.poLineId, qtyReceived: seeded.qty, warehouseId: seeded.warehouseId },
  ])
  assert.equal(manual.success, true, `PRECONDITION: the manual receipt must succeed: ${manual.error}`)
  const afterManual = await stockReceiptLogsFor(seeded.poId)
  const transitAfterManual = await transitRowsFor(seeded.poId)
  console.log(`[arm3] after the MANUAL receipt: ${afterManual.length} STOCK_RECEIPT log(s), ${transitAfterManual.length} transit row(s)`)
  assert.equal(afterManual.length, 1, 'PRECONDITION: the manual receipt must post its journal, or "no SECOND post" means nothing')
  assert.equal(transitAfterManual.length, 1, 'PRECONDITION: the manual receipt must record its transit row')

  const { status } = await runBookedIn(seeded, seeded.poLineId)
  console.log(`[arm3] webhook book-in over already-received goods returned status=${status}`)

  const logs = await stockReceiptLogsFor(seeded.poId)
  const transit = await transitRowsFor(seeded.poId)
  const layers = await db.costLayer.count({ where: { poLineId: seeded.poLineId } })
  console.log(`[arm3] examined ${logs.length} STOCK_RECEIPT log(s), ${transit.length} transit row(s), ${layers} cost layer(s)`)
  assert.equal(layers, 1, 'PRECONDITION: the book-in must not have laid a second cost layer for the same units')
  assert.equal(
    logs.length,
    1,
    `the units were journalled once by the manual receipt; the webhook must add nothing. Found ${logs.length} `
    + 'STOCK_RECEIPT journals, which would double the inventory value in the GL.',
  )
  assert.equal(transit.length, 1, `and exactly one transit subledger row; found ${transit.length}`)
  assert.equal(Number(transit[0]!.baseDelta), -expectedAmount, 'the single row must carry the single receipt value')
})

/**
 * ARM 4 — A TRANSFER-BACKED BOOK-IN POSTS NOTHING, AND THAT IS THE RIGHT ANSWER.
 *
 * A stock transfer moves units the business ALREADY OWNS between its own warehouses.
 * Its value never left inventory and never entered goods-in-transit (which is the
 * PURCHASE clearing account: `transit-subledger-movement.ts:20-35` lists only
 * bill/receipt/landed-cost/credit-note/cancellation sources). The manual transfer
 * receipt agrees — `app/actions/transfers.ts` contains ZERO `queueAccountingSync`
 * calls — so the WMS path posting nothing is PARITY, not a second hole.
 *
 * WHAT WOULD STILL PASS THIS ARM: any fix that scopes its enqueue to the PO branch,
 * including one that posts the wrong amount there. It is an absence check, so it
 * cannot be satisfied by a correction sitting beside a stale claim — but a rig that
 * cannot see a journal at all would also pass it, which is why arm 1 (same rig,
 * same readers) asserting PRESENCE is what makes this arm mean absence.
 */
test('o3d-8f0p6: a transfer-backed WMS book-in posts no receipt journal and no transit row', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedTransferBackedAsn('T', 6)

  const { status } = await runBookedIn(
    { tag: seeded.tag, qty: seeded.qty, externalAsnLineId: seeded.externalAsnLineId },
    seeded.transferLineId,
  )
  assert.equal(status, 'processed', 'PRECONDITION: the transfer book-in must commit, or nothing is being measured')

  const movements = await db.stockMovement.findMany({
    where: { productId: seeded.productId },
    select: { type: true, qty: true, referenceType: true, referenceId: true },
  })
  console.log(`[arm4] examined ${movements.length} movement(s): ${JSON.stringify(movements)}`)
  assert.equal(movements.length, 1, 'PRECONDITION: the transfer book-in must have credited the destination')
  assert.equal(movements[0]!.type, 'TRANSFER_IN')
  const level = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.destinationWarehouseId } },
    select: { quantity: true },
  })
  assert.equal(Number(level.quantity), seeded.qty, 'PRECONDITION: the units must actually be in the destination')

  const receiptLogs = await db.accountingSyncLog.count({
    where: { type: 'STOCK_RECEIPT', referenceId: { in: [seeded.transferId, seeded.transferLineId] } },
  })
  const transit = await transitRowsFor(seeded.transferId)
  const transitByLine = await transitRowsFor(seeded.transferLineId)
  console.log(`[arm4] examined ${receiptLogs} STOCK_RECEIPT log(s) and ${transit.length + transitByLine.length} transit row(s) for the transfer`)
  assert.equal(receiptLogs, 0, 'a warehouse-to-warehouse transfer moves no value into inventory: it must post no STOCK_RECEIPT journal')
  assert.equal(transit.length + transitByLine.length, 0, 'and it must not touch the PURCHASE goods-in-transit clearing subledger')
})

/**
 * ARM 5 — THE JOURNAL AND THE STOCK ARE ONE UNIT OF WORK.
 *
 * The defect's own lesson: a book-in that commits stock without its journal is the
 * bug; a journal without its stock is the bug in a new costume. So the enqueue is
 * made to FAIL and the STOCK is what gets asserted — if the enqueue were moved
 * outside `db.$transaction` the movement, layer and stock level would survive and
 * this arm goes red.
 *
 * WHAT WOULD STILL PASS THIS ARM: an enqueue inside the transaction but before the
 * stock writes (also atomic, so also correct for this property), and a fix that
 * swallows the enqueue error instead of letting it abort — no, that one fails here
 * too, because the movement would then survive. It does NOT establish that the
 * failure is reported usefully; it only establishes atomicity.
 */
test('o3d-8f0p6: if the STOCK_RECEIPT enqueue fails, the book-in commits no stock either', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedPurchaseBackedAsn('X', 2)

  injectEnqueueFailure = true
  let status: string
  try {
    ;({ status } = await runBookedIn(seeded, seeded.poLineId))
  } finally {
    injectEnqueueFailure = false
  }
  console.log(`[arm5] book-in with the enqueue failing returned status=${status}`)
  assert.notEqual(status, 'processed', 'a book-in whose journal could not be queued must not report success')

  const movements = await db.stockMovement.count({ where: { productId: seeded.productId } })
  const layers = await db.costLayer.count({ where: { poLineId: seeded.poLineId } })
  const level = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  const poLine = await db.purchaseOrderLine.findUniqueOrThrow({
    where: { id: seeded.poLineId },
    select: { qtyReceived: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm5] examined ${movements} movement(s), ${layers} layer(s), stock=${String(level.quantity)}, qtyReceived=${String(poLine.qtyReceived)}, ${logs.length} log(s)`)
  assert.equal(movements, 0, 'the stock movement must have rolled back with the failed enqueue — the journal is not a best-effort afterthought')
  assert.equal(layers, 0, 'the cost layer must have rolled back too')
  assert.equal(Number(level.quantity), 0, 'and the stock level must be untouched')
  assert.equal(Number(poLine.qtyReceived), 0, 'and the PO line must not record a receipt that was rolled back')
  assert.equal(logs.length, 0, 'nothing may have been queued')

  // PROVE THE RIG CAN SEE THE OTHER OUTCOME with the injection off, so a green arm is
  // not the seam being permanently stuck on.
  const control = await seedPurchaseBackedAsn('XC', 2)
  const controlResult = await runBookedIn(control, control.poLineId)
  const controlLogs = await stockReceiptLogsFor(control.poId)
  const controlMovements = await db.stockMovement.count({ where: { productId: control.productId } })
  console.log(`[arm5] control (injection off): status=${controlResult.status}, ${controlMovements} movement(s), ${controlLogs.length} log(s)`)
  assert.equal(controlResult.status, 'processed', 'control: the same seed must succeed with the injection off')
  assert.equal(controlMovements, 1, 'control: stock must commit')
  assert.equal(controlLogs.length, 1, 'control: the journal must be queued')
})

/**
 * ARM 6 — THE PARTIAL CASE, WHICH IS THE ONLY PLACE THE AMOUNT RULE CAN BE SEEN.
 *
 * ADDED BECAUSE A MUTATION SURVIVED. Replacing `receiptLine.stockQtyToAdd` with
 * `receiptLine.qtyReceived` in the accumulator left all five earlier arms green:
 * in arms 1 and 2 the two are equal, and in arm 3 the whole inner block is skipped
 * because `qtyReceived` is 0 there (the units arrive as `reconciledManualQty`). So
 * the rule the fix rests on — journal the value you LAID LAYERS FOR, not the value
 * you reconciled — was unproven, and a green suite said otherwise.
 *
 * It is visible only when a prior WMS stock-sync alignment already credited part of
 * the line: `qtyAccountedViaSnapshot` makes `coveredBySnapshotQty` positive, so
 * `stockQtyToAdd = qtyReceived − coveredBySnapshotQty` is strictly smaller.
 * Journalling `qtyReceived` would post inventory value for units whose layer was
 * laid by a previous run.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that journals the right quantity at the
 * wrong unit cost (arm 1 pins the unit cost), and a fix that gets the manual-overlap
 * case wrong (arm 3). It also does NOT establish that the alignment-credited units
 * were ever journalled by anyone — they were not; that is o3d-6nd55.
 */
test('o3d-8f0p6: the journal covers only the quantity this book-in laid layers for', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const ALIGNED = 4
  const seeded = await seedPurchaseBackedAsn('P', 10, ALIGNED)
  const newlyLaidQty = seeded.qty - ALIGNED
  const expectedAmount = newlyLaidQty * UNIT_COST

  const { status } = await runBookedIn(seeded, seeded.poLineId)
  assert.equal(status, 'processed')

  // PRECONDITION: the two quantities really do differ here, or this arm measures nothing.
  const movements = await db.stockMovement.findMany({
    where: { type: 'PURCHASE_RECEIPT', productId: seeded.productId },
    select: { qty: true, totalValueBase: true },
  })
  console.log(`[arm6] examined ${movements.length} PURCHASE_RECEIPT movement(s): ${JSON.stringify(movements)}`)
  assert.equal(movements.length, 1)
  assert.equal(
    Number(movements[0]!.qty),
    newlyLaidQty,
    `PRECONDITION: the book-in must credit only the ${newlyLaidQty} units not already covered by the `
    + `alignment snapshot, while the reconciled quantity is ${seeded.qty} — if these were equal this `
    + 'arm could not tell the two rules apart',
  )
  const layers = await db.costLayer.findMany({
    where: { poLineId: seeded.poLineId },
    orderBy: { receivedQty: 'asc' },
    select: { receivedQty: true },
  })
  console.log(`[arm6] examined ${layers.length} cost layer(s): ${JSON.stringify(layers.map((l) => String(l.receivedQty)))}`)
  assert.equal(layers.length, 2, 'PRECONDITION: the pre-existing alignment layer plus this book-in\'s layer')

  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm6] examined ${logs.length} STOCK_RECEIPT log(s): ${JSON.stringify(logs.map((l) => l.payload))}`)
  assert.equal(logs.length, 1, `exactly one journal must be queued; found ${logs.length}`)
  const lines = payloadLines(logs[0]!.payload)
  const debit = lines.find((line) => typeof line.debit === 'number')
  const credit = lines.find((line) => typeof line.credit === 'number')
  assert.ok(debit && credit)
  assert.equal(
    debit.debit,
    expectedAmount,
    `the debit must be ${newlyLaidQty} x ${UNIT_COST} = ${expectedAmount} (the value THIS book-in laid `
    + `layers for), not ${seeded.qty} x ${UNIT_COST} = ${seeded.qty * UNIT_COST} (the reconciled quantity, `
    + `whose first ${ALIGNED} units were layered by a previous alignment run)`,
  )
  assert.equal(credit.credit, expectedAmount, 'and the credit must match the debit')

  const transit = await transitRowsFor(seeded.poId)
  console.log(`[arm6] examined ${transit.length} transit row(s): ${JSON.stringify(transit.map((r) => String(r.baseDelta)))}`)
  assert.equal(transit.length, 1)
  assert.equal(Number(transit[0]!.baseDelta), -expectedAmount, 'the transit credit must drain only the value just received')
})
