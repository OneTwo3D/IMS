import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import * as realAccountingNs from '@/lib/accounting'
import * as realTransitNs from '@/lib/domain/accounting/transit-subledger-movement'
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

/**
 * THE AUTH MOCK MUST COVER EVERY GUARD THE ACTIONS UNDER TEST CALL (o3d-8f0p6 r4).
 *
 * `requireRole` and `requireFreshPermission` were missing, and `saveXeroSettings` —  which arm 11
 * drives — calls `requirePermission('sync')` then `requireRole('ADMIN')`. The missing export made that
 * a TypeError, the action's own catch turned it into `{ success: false }`, and the arm's `.catch()`
 * swallowed it: the remap NEVER HAPPENED and the arm passed while exercising nothing. It was the
 * mutation that should have killed it (no lock, per-PO read) staying green that exposed this, which is
 * the second time this round a green arm turned out to be measuring nothing.
 */
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
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
/**
 * THE REMAP HOOKS (o3d-8f0p6 r4). Both fire once, from INSIDE the book-in transaction.
 *
 * `onNextEnqueue` fires before the enqueue returns — used by the multi-PO arm, so the remap attempt
 * lands between the first PO's posting and the second's.
 *
 * `afterFinalAccountRead` fires from the transit-subledger write, which the service reaches AFTER its
 * post-enqueue account re-read. That is the exact window round 3 identified: the re-read has already
 * happened and holds nothing of its own, so if the mapping is not LOCKED, a remap committing here
 * still ends with a journal committed on stale codes.
 *
 * Neither hook AWAITS the remap, and that is the point rather than an optimisation: while the mapping
 * lock is held the remap cannot commit, so awaiting it from inside this transaction would deadlock
 * against ourselves. What the arms assert is precisely that it did NOT get through.
 */
let remapInventoryAccountOnNextEnqueue: (() => Promise<void>) | null = null
let remapInventoryAccountAfterFinalAccountRead: (() => Promise<void>) | null = null
/**
 * o3d-ln2df — RETIRE THE CHART AFTER THE BOOK-IN HAS READ IT, so the enqueue DECLINES for real.
 *
 * This is the production race the refusal exists for, and the ONLY seam in it is WHEN: the book-in reads
 * the active connector over the pool before its transaction opens, and the enqueue re-asks under the
 * selection lock inside it. Switching the connector off in that window makes
 * `pinnedLedgerIsServicedUnderLock` answer no, and the refusal, its reason, its posting key and its
 * inbox row are then all produced by PRODUCTION code. Nothing about the outcome is fabricated — the
 * hook only decides the moment, and it fires from the wrapper around the connector read the book-in
 * itself performs, which is the last point before the transaction opens.
 *
 * It is one-shot, and each arm restores the setting.
 */
let retireChartAfterConnectorRead = false
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
      if (remapInventoryAccountOnNextEnqueue && args[1]?.type === 'STOCK_RECEIPT') {
        const hook = remapInventoryAccountOnNextEnqueue
        remapInventoryAccountOnNextEnqueue = null
        await hook()
      }
      return realAccountingNs.queueAccountingSyncTx(...args)
    },
    /**
     * o3d-ln2df — THE SAME TWO SEAMS ON THE `WithOutcome` VARIANT, because that is the one the book-in
     * now takes (it needs the whole answer to tell `refused` from `not-configured`). Without this arm 5
     * would silently stop injecting anything: the real adapter calls the real boolean enqueue through
     * the module's own binding, not through the mock above, so the injection would never be reached and
     * a green arm 5 would be measuring nothing.
     */
    queueAccountingSyncTxWithOutcome: async (
      ...args: Parameters<typeof realAccountingNs.queueAccountingSyncTxWithOutcome>
    ) => {
      if (injectEnqueueFailure && args[1]?.type === 'STOCK_RECEIPT') {
        throw new Error(INJECTED_ENQUEUE_FAILURE)
      }
      if (remapInventoryAccountOnNextEnqueue && args[1]?.type === 'STOCK_RECEIPT') {
        const hook = remapInventoryAccountOnNextEnqueue
        remapInventoryAccountOnNextEnqueue = null
        await hook()
      }
      return realAccountingNs.queueAccountingSyncTxWithOutcome(...args)
    },
    getActiveAccountingConnectorId: async () => {
      const answer = await realAccountingNs.getActiveAccountingConnectorId()
      if (retireChartAfterConnectorRead) {
        retireChartAfterConnectorRead = false
        const { db } = await import('@/lib/db')
        await db.setting.upsert({
          where: { key: 'plugin_xero_enabled' },
          create: { key: 'plugin_xero_enabled', value: 'false' },
          update: { value: 'false' },
        })
      }
      return answer
    },
  },
})
mock.module('@/lib/domain/accounting/transit-subledger-movement', {
  namedExports: {
    ...realTransitNs,
    recordTransitSubledgerMovement: async (
      ...args: Parameters<typeof realTransitNs.recordTransitSubledgerMovement>
    ) => {
      if (remapInventoryAccountAfterFinalAccountRead) {
        const hook = remapInventoryAccountAfterFinalAccountRead
        remapInventoryAccountAfterFinalAccountRead = null
        await hook()
      }
      return realTransitNs.recordTransitSubledgerMovement(...args)
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

/**
 * THE SAME PO-BACKED ASN, BUT BUILT BY THE REAL CREATION PATH (o3d-8f0p6 r2).
 *
 * `createPurchaseOrder` is called with only what an operator supplies — qty and
 * `unitCostForeign` — so NO cost column is written by hand. That is the point: it never sets
 * `landedUnitCostBase`, which is `Decimal @default(0)` and NOT NULL, and that zero is what the
 * book-in used to read as the receipt cost.
 *
 * `status` is advanced afterwards because a freshly created PO is DRAFT and an ASN is raised against
 * a sent order; a status is not a cost, and every cost figure below comes out of the action.
 */
async function seedPurchaseBackedAsnViaRealCreate(
  label: string,
  qty: number,
  unitCost: number,
  freightTotal = 0,
): Promise<SeededPurchaseAsn & { unitCost: number }> {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = uniqueTag(label)
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

  const created = await createPurchaseOrder({
    reference: tag,
    supplierId: supplier.id,
    currency: 'GBP',
    fxRateToBase: 1,
    destinationWarehouseId: warehouse.id,
    pricesIncludeVat: false,
    taxRateValue: 0,
    ...(freightTotal > 0
      ? { additionalCosts: [{ description: 'Freight', amountForeign: freightTotal, vatable: false, distributionMethod: 'BY_VALUE' }] }
      : {}),
    lines: [{
      productId: product.id,
      sku: tag,
      productName: `o3d-8f0p6 ${label}`,
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
    asnMapId: asn.id,
    asnLineMapId: asn.lines[0]!.id,
    externalAsnLineId: asn.lines[0]!.externalAsnLineId,
  }
}

/**
 * ONE ASN COVERING TWO PURCHASE ORDERS (o3d-8f0p6 r4), both built by the real creation path.
 *
 * This is the shape round 3's multi-PO finding is about: `receiptLinesByPoId` groups the event's lines
 * by purchase order and posts one journal per PO, so an event can queue several journals and a remap
 * landing between them could split it across two mappings.
 */
async function seedTwoPoAsnViaRealCreate(label: string, qtyEach: number, unitCost: number) {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = uniqueTag(label)
  const warehouse = await db.warehouse.create({
    data: { code: tag.slice(-10), name: `${tag} wh`, type: 'STANDARD' },
    select: { id: true },
  })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })

  const made: Array<{ poId: string; poLineId: string; productId: string; sku: string }> = []
  for (const suffix of ['A', 'B']) {
    const sku = `${tag}${suffix}`.slice(0, 28)
    const product = await db.product.create({
      data: { sku, name: `o3d-8f0p6 ${label}${suffix}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
      select: { id: true },
    })
    await db.stockLevel.create({
      data: { productId: product.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' },
      select: { productId: true },
    })
    const created = await createPurchaseOrder({
      reference: sku,
      supplierId: supplier.id,
      currency: 'GBP',
      fxRateToBase: 1,
      destinationWarehouseId: warehouse.id,
      pricesIncludeVat: false,
      taxRateValue: 0,
      lines: [{ productId: product.id, sku, productName: `o3d-8f0p6 ${label}${suffix}`, qty: qtyEach, unitCostForeign: unitCost }],
    })
    assert.equal(created.success, true, `PRECONDITION: createPurchaseOrder must succeed: ${created.error}`)
    const po = await db.purchaseOrder.findUniqueOrThrow({
      where: { reference: sku },
      select: { id: true, lines: { select: { id: true } } },
    })
    await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
    made.push({ poId: po.id, poLineId: po.lines[0]!.id, productId: product.id, sku })
  }

  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-8f0p6: a test fixture row, not a core flow branch
      externalAsnId: tag,
      sourceType: 'PURCHASE_ORDER',
      sourceId: made[0]!.poId,
      warehouseId: warehouse.id,
      status: 'OPEN',
      lines: {
        create: made.map((entry, index) => ({
          externalAsnLineId: `${tag}-${index + 1}`,
          sourceType: 'PURCHASE_ORDER_LINE',
          sourceLineId: entry.poLineId,
          productId: entry.productId,
          sku: entry.sku,
          expectedQty: `${qtyEach}.0000`,
        })),
      },
    },
    select: { id: true, lines: { select: { id: true, externalAsnLineId: true, sourceLineId: true } } },
  })
  return {
    tag,
    qtyEach,
    unitCost,
    warehouseId: warehouse.id,
    poAId: made[0]!.poId,
    poBId: made[1]!.poId,
    lines: asn.lines.map((line) => ({
      externalAsnLineId: line.externalAsnLineId,
      sourceLineId: line.sourceLineId,
      sku: made.find((m) => m.poLineId === line.sourceLineId)!.sku,
    })),
  }
}

/** The real webhook book-in for a two-line, two-PO ASN. */
async function runBookedInMultiPo(
  multi: Awaited<ReturnType<typeof seedTwoPoAsnViaRealCreate>>,
): Promise<{ status: string; eventId: string }> {
  const { db } = await import('@/lib/db')
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const { liveMintsoftBookedInAsnRefMultiLine } = await import('@/tests/helpers/live-mintsoft-asn-ref')
  const event = await db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-8f0p6: a test fixture row, not a core flow branch
      externalEventId: `${multi.tag}-evt-${Math.random().toString(36).slice(2, 10)}`,
      externalAsnId: multi.tag,
      payload: { asnId: multi.tag },
    },
    select: { id: true },
  })
  const remote = liveMintsoftBookedInAsnRefMultiLine({
    externalAsnId: multi.tag,
    lines: multi.lines.map((line) => ({
      externalLineId: line.externalAsnLineId,
      sourceLineId: line.sourceLineId,
      sku: line.sku,
      expectedQty: multi.qtyEach,
      bookedQty: multi.qtyEach,
    })),
  })
  const result = await processBookedInEvent(event.id, {
    fetchRemoteAsn: async () => ({ ...remote, status: 'RECEIVED', raw: null }),
  })
  return { status: result.status, eventId: event.id }
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

/**
 * ARM 7 — THE ORDINARY PURCHASE ORDER, BUILT BY THE REAL CREATION PATH.
 *
 * ADDED BECAUSE SIX GREEN ARMS STILL DID NOT REACH THE DEFECT. Every arm above seeds
 * its PO line with `landedUnitCostBase` set by hand. `createPurchaseOrder` never sets
 * that column, and it is `Decimal @default(0)` and NOT NULL — so on an ordinary PO the
 * book-in's old `landedUnitCostBase ?? unitCostBase` read a non-null **zero**, laid a
 * zero-cost layer, wrote a zero-value movement and left `receiptValueBase` at zero, so
 * a positive-cost purchase order posted NO journal and NO transit row. The fixture was
 * the only reason the arms passed. This is the same shape as the earlier surviving
 * mutation: an arm whose fixture makes two values coincide cannot tell them apart.
 *
 * SO THIS ARM SETS NO COST FIELD AT ALL. The PO comes out of `createPurchaseOrder`
 * with only the inputs an operator supplies (qty and `unitCostForeign`). The only
 * column written by hand afterwards is `status`, which is not a cost and is what an
 * operator's "send to supplier" would do.
 *
 * IT ALSO PINS THE THREE-CONSUMER RULE: the movement's `totalValueBase`, the cost
 * layer's `unitCostBase` and the journal's debit must all agree, because three
 * consumers disagreeing about the cost of the same units is a worse defect than a
 * missing journal.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that reads the goods cost but ignores freight
 * (this PO has no additional cost lines — freight is covered by arm 8), and any change
 * confined to the transfer branch.
 */
test('o3d-8f0p6 r2: a PO created through the real action posts the journal for its real cost', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedPurchaseBackedAsnViaRealCreate('R', 5, 9)
  const expectedAmount = seeded.qty * seeded.unitCost

  // PRECONDITION, AND THE WHOLE POINT: the real creation path leaves landedUnitCostBase at its
  // zero default. If this ever stops being true the arm is no longer testing the ordinary path.
  const line = await db.purchaseOrderLine.findUniqueOrThrow({
    where: { id: seeded.poLineId },
    select: { unitCostBase: true, landedUnitCostBase: true },
  })
  console.log(`[arm7] PO line as createPurchaseOrder left it: unitCostBase=${String(line.unitCostBase)} landedUnitCostBase=${String(line.landedUnitCostBase)}`)
  assert.equal(
    Number(line.landedUnitCostBase),
    0,
    'PRECONDITION: createPurchaseOrder must leave landedUnitCostBase at its zero default — that zero '
    + 'is the defect this arm exists for',
  )
  assert.equal(
    Number(line.unitCostBase),
    seeded.unitCost,
    'PRECONDITION: the goods cost must be positive, so a zero journal cannot be explained as a free line',
  )

  const { status } = await runBookedIn(seeded, seeded.poLineId)
  assert.equal(status, 'processed')

  const movements = await db.stockMovement.findMany({
    where: { type: 'PURCHASE_RECEIPT', productId: seeded.productId },
    select: { qty: true, unitCostBase: true, totalValueBase: true },
  })
  console.log(`[arm7] examined ${movements.length} movement(s): ${JSON.stringify(movements)}`)
  assert.equal(movements.length, 1)
  assert.equal(
    Number(movements[0]!.unitCostBase),
    seeded.unitCost,
    'the MOVEMENT must carry the real unit cost, not the zero default',
  )
  assert.equal(Number(movements[0]!.totalValueBase), expectedAmount)

  const layers = await db.costLayer.findMany({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  console.log(`[arm7] examined ${layers.length} cost layer(s): ${JSON.stringify(layers)}`)
  assert.equal(layers.length, 1)
  assert.equal(
    Number(layers[0]!.unitCostBase),
    seeded.unitCost,
    'the COST LAYER must carry the real unit cost — a zero-cost layer understates inventory for ever',
  )

  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm7] examined ${logs.length} STOCK_RECEIPT log(s): ${JSON.stringify(logs.map((l) => l.payload))}`)
  assert.equal(
    logs.length,
    1,
    `an ordinary positive-cost purchase order must post its receipt journal; found ${logs.length}. `
    + 'This is the arm the hand-set landedUnitCostBase fixture was hiding.',
  )
  const lines = payloadLines(logs[0]!.payload)
  const debit = lines.find((l) => typeof l.debit === 'number')
  const credit = lines.find((l) => typeof l.credit === 'number')
  assert.ok(debit && credit)
  assert.equal(debit.accountCode, INVENTORY_ACCOUNT)
  assert.equal(credit.accountCode, TRANSIT_ACCOUNT)
  assert.equal(debit.debit, expectedAmount, `the debit must be ${seeded.qty} x ${seeded.unitCost}`)

  // THE THREE CONSUMERS MUST AGREE.
  assert.equal(
    Number(movements[0]!.totalValueBase),
    debit.debit,
    'the movement value and the journal debit must be the same number',
  )
  assert.equal(
    Number(layers[0]!.unitCostBase) * Number(layers[0]!.receivedQty),
    debit.debit,
    'the cost-layer value and the journal debit must be the same number',
  )

  const transit = await transitRowsFor(seeded.poId)
  console.log(`[arm7] examined ${transit.length} transit row(s): ${JSON.stringify(transit.map((r) => String(r.baseDelta)))}`)
  assert.equal(transit.length, 1)
  assert.equal(Number(transit[0]!.baseDelta), -expectedAmount)
})

/**
 * ARM 8 — FREIGHT MUST REACH THE JOURNAL, AND ALL THREE CONSUMERS TOGETHER.
 *
 * The cost the manual receipt uses is not the goods cost: it is
 * `computeGrossUnitCostBaseByLine`, i.e. goods plus this line's share of the PO's
 * additional cost lines. A fix that read `unitCostBase` alone would pass arm 7 and
 * still post the wrong amount for any PO carrying freight — and would disagree with
 * the manual receipt for the same units, which is the asymmetry o3d-8f0p6 is about.
 *
 * The PO is again built by `createPurchaseOrder`, freight included, with no cost
 * column written by hand.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that distributes freight by a different
 * method than the manual receipt would for a MULTI-line PO. This PO has one line, so
 * every distribution method gives it the whole amount; the shared helper is what makes
 * the multi-line case agree, and that is asserted by construction (same function) not
 * by this arm.
 */
test('o3d-8f0p6 r2: freight on the PO reaches the layer, the movement and the journal alike', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 4
  const GOODS_UNIT = 10
  const FREIGHT_TOTAL = 20
  const seeded = await seedPurchaseBackedAsnViaRealCreate('F', QTY, GOODS_UNIT, FREIGHT_TOTAL)
  // One line, so the whole freight amount lands on it whatever the distribution method.
  const expectedUnitCost = GOODS_UNIT + FREIGHT_TOTAL / QTY
  const expectedAmount = QTY * expectedUnitCost

  const { status } = await runBookedIn(seeded, seeded.poLineId)
  assert.equal(status, 'processed')

  const movement = await db.stockMovement.findFirstOrThrow({
    where: { type: 'PURCHASE_RECEIPT', productId: seeded.productId },
    select: { unitCostBase: true, totalValueBase: true },
  })
  const layer = await db.costLayer.findFirstOrThrow({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm8] goods ${GOODS_UNIT} + freight ${FREIGHT_TOTAL}/${QTY} => expected unit ${expectedUnitCost}; movement=${JSON.stringify(movement)} layer=${JSON.stringify(layer)} logs=${logs.length}`)

  // PRECONDITION: freight really is on the PO, so "gross == goods" cannot be true by accident.
  assert.notEqual(expectedUnitCost, GOODS_UNIT, 'PRECONDITION: the freight share must move the unit cost')

  assert.equal(Number(layer.unitCostBase), expectedUnitCost, 'the cost layer must carry the GROSS (goods + freight) unit cost, as the manual receipt does')
  assert.equal(Number(movement.unitCostBase), expectedUnitCost, 'and so must the movement')
  assert.equal(logs.length, 1, `the journal must be queued; found ${logs.length}`)
  const debit = payloadLines(logs[0]!.payload).find((l) => typeof l.debit === 'number')
  assert.ok(debit)
  assert.equal(debit.debit, expectedAmount, `the journal debit must be the gross value ${expectedAmount}, not the goods-only ${QTY * GOODS_UNIT}`)
  assert.equal(Number(movement.totalValueBase), debit.debit, 'movement value == journal debit')
  assert.equal(Number(layer.unitCostBase) * Number(layer.receivedQty), debit.debit, 'layer value == journal debit')

  const transit = await transitRowsFor(seeded.poId)
  assert.equal(transit.length, 1)
  assert.equal(Number(transit[0]!.baseDelta), -expectedAmount)
})

/**
 * ARM 9 — A FREE-OF-CHARGE LINE IS LEGITIMATELY ZERO, AND MUST POST NOTHING.
 *
 * The round-1 review asked whether zero can ever be legitimate. It can: a sample, a
 * warranty replacement or a free-of-charge line has `unitCostForeign` 0, so the gross
 * cost is 0 and there is no value to move into inventory. Posting a zero journal would
 * be noise the ledger would reject.
 *
 * This is what makes a NULL-vs-ZERO column change unnecessary: the legitimate case is
 * distinguished by the GOODS cost being zero, which arm 7 asserts is positive in the
 * defect case. Receipt time never reads `landedUnitCostBase` at all any more.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that posts nothing for ANY purchase order —
 * which is the pre-fix behaviour, and is what arms 1, 7 and 8 refuse.
 */
test('o3d-8f0p6 r2: a genuinely free line credits stock and posts no journal', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedPurchaseBackedAsnViaRealCreate('Z', 3, 0)

  const { status } = await runBookedIn(seeded, seeded.poLineId)
  assert.equal(status, 'processed')

  const movements = await db.stockMovement.count({ where: { type: 'PURCHASE_RECEIPT', productId: seeded.productId } })
  const level = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  const transit = await transitRowsFor(seeded.poId)
  console.log(`[arm9] free line: ${movements} movement(s), stock=${String(level.quantity)}, ${logs.length} log(s), ${transit.length} transit row(s)`)
  assert.equal(movements, 1, 'PRECONDITION: the units must still be received — free goods are still goods')
  assert.equal(Number(level.quantity), seeded.qty, 'PRECONDITION: and they must reach stock')
  assert.equal(logs.length, 0, 'a zero-value receipt must post no journal — there is no value to move into inventory')
  assert.equal(transit.length, 0, 'and nothing to drain from transit')
})

/**
 * ARM 10 — THE MAPPING LOCK MUST BLOCK A REMAP THAT COMMITS AFTER THE FINAL READ.
 *
 * ROUND 3'S FINDING, AND WHY r2's ANSWER WAS NOT ENOUGH. r2 read the codes inside the transaction and
 * re-read them after the enqueue, refusing on a difference. Under READ COMMITTED that re-read sees a
 * remap that had ALREADY committed — but it holds nothing, so a remap committing AFTER it, while the
 * book-in walks on through the transfer loop and the ASN updates, still ends with a journal committed
 * on stale codes. Refusal was the wrong instrument. The fix is the accounting-selection lock, extended
 * to the two mapping rows and held to COMMIT.
 *
 * SO THIS ARM MEASURES THE LOCK, NOT THE REFUSAL. The remap is fired from a separate pooled
 * connection at the one moment r2 could not defend — from the transit-subledger write, which the
 * service reaches after its post-enqueue re-read — and is deliberately NOT awaited, because a
 * transaction that waits for a writer it is itself blocking would deadlock. What is asserted is that
 * the remap DID NOT GET THROUGH: after a generous wait, a third connection still reads the OLD code.
 *
 * THE FAILURE DIRECTION IS THE SAFE ONE. If the lock were absent the remap would commit inside the
 * wait and that read would return the new code, so the arm fails. If the remap were merely slow the
 * arm would pass while proving less — which is why the wait is 2s for a single-row update, and why the
 * assertion is on the ROW's value rather than on a timer.
 *
 * WHAT WOULD STILL PASS THIS ARM: holding the lock for longer than necessary; and any fix that
 * serialises by a different lock, which is also correct. It does NOT establish that two POs in one
 * event share a mapping — that is arm 11, and it rests on a different mechanism.
 */
test('o3d-8f0p6 r4: a remap committed after the final account read is blocked until the receipt commits', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedPurchaseBackedAsnViaRealCreate('L', 2, 11)
  const REMAPPED = '699'

  type RemapOutcome = 'pending' | 'committed' | 'failed'
  let remapSettled: RemapOutcome = 'pending'
  let remapError: string | null = null
  // SNAPSHOTTED INSIDE THE HOOK, not read afterwards. The `finally` below awaits the remap, so by the
  // time any assertion runs it has long since landed; a flag read there would say nothing about what
  // was true DURING the transaction, which is the only thing this arm is about.
  let observedDuringTransaction: string | null = null
  let settledDuringTransaction: RemapOutcome = 'pending'
  let remapPromise: Promise<unknown> = Promise.resolve()

  remapInventoryAccountAfterFinalAccountRead = async () => {
    // Fired from INSIDE the book-in transaction, after its final account read. Not awaited.
    remapPromise = db.setting
      .update({ where: { key: 'xero_inventory_account' }, data: { value: REMAPPED } })
      .then(() => { remapSettled = 'committed' })
      .catch((error: unknown) => { remapSettled = 'failed'; remapError = String(error).slice(0, 200) })
    // A generous window for a single-row update, so "it simply had not run yet" is not a plausible
    // explanation for a pass.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    // A THIRD connection, reading what is COMMITTED right now. A plain SELECT is not blocked by the
    // FOR UPDATE, so this reports the row's committed value rather than waiting for the lock.
    const row = await db.setting.findUniqueOrThrow({ where: { key: 'xero_inventory_account' }, select: { value: true } })
    observedDuringTransaction = row.value
    settledDuringTransaction = remapSettled
  }

  let status: string
  try {
    ;({ status } = await runBookedIn(seeded, seeded.poLineId))
    // Let the queued remap through now that the lock is released, so the arm can prove it was
    // SERIALISED rather than rejected.
    await remapPromise.catch(() => {})
  } finally {
    remapInventoryAccountAfterFinalAccountRead = null
  }
  const afterRelease = await db.setting.findUniqueOrThrow({ where: { key: 'xero_inventory_account' }, select: { value: true } })
  await db.setting.update({ where: { key: 'xero_inventory_account' }, data: { value: INVENTORY_ACCOUNT } })

  console.log(`[arm10] status=${status}; mid-transaction: code=${String(observedDuringTransaction)} remap=${settledDuringTransaction}${remapError ? ` (${remapError})` : ''}; after release: code=${afterRelease.value} remap=${remapSettled}`)
  assert.equal(
    observedDuringTransaction,
    INVENTORY_ACCOUNT,
    `THE POINT OF THIS ARM: while the book-in held the mapping lock, a remap fired AFTER its final `
    + `account read must not have committed — the committed code should still have been `
    + `${INVENTORY_ACCOUNT}, was ${String(observedDuringTransaction)}. A new value here is round 3's `
    + 'stale-mapping window, reopened.',
  )
  assert.equal(
    settledDuringTransaction,
    'pending',
    'and the remap must still have been WAITING at that moment, not already finished',
  )
  // NOT VACUOUS: the remap must land once the lock is released. If it had failed for some unrelated
  // reason, "it did not commit" would be true for the wrong reason and this is what catches that.
  assert.equal(remapSettled, 'committed', `the remap must succeed once the receipt released the lock — serialised, not rejected${remapError ? `; it failed instead: ${remapError}` : ''}`)
  assert.equal(afterRelease.value, REMAPPED, 'and its value must be the one it wrote')

  // The receipt itself must have succeeded, on codes that were current for the whole of it.
  assert.equal(status, 'processed', 'serialising must let the receipt through, not refuse it')
  const logs = await stockReceiptLogsFor(seeded.poId)
  assert.equal(logs.length, 1, `the journal must be queued; found ${logs.length}`)
  const lines = payloadLines(logs[0]!.payload)
  assert.equal(lines.find((l) => typeof l.debit === 'number')?.accountCode, INVENTORY_ACCOUNT)
  assert.equal(lines.find((l) => typeof l.credit === 'number')?.accountCode, TRANSIT_ACCOUNT)

})

/**
 * ARM 11 — EVERY PURCHASE ORDER IN ONE EVENT POSTS ON ONE MAPPING.
 *
 * Round 3's second half: an ASN can cover SEVERAL purchase orders, and per-PO account reads could
 * straddle a remap, putting earlier POs on the old mapping and later ones on the new one inside a
 * single event. Two POs on two different account codes for one delivery is not a variance anything
 * reconciles; it is two contradictory journals.
 *
 * WHAT THIS ARM PINS, AND WHAT IT DOES NOT. It pins the MEMOISATION — one locked read per
 * transaction, reused by every PO — not the lock. With the lock present a remap cannot commit at all,
 * so the two mechanisms are not separable by observation here, and claiming this arm proves the lock
 * would be the "proof of an adjacent property" trap. The mutation that makes the read per-PO AND
 * removes the lock is what turns this red; the lock alone is measured by arm 10.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that reads per-PO but under a lock (also correct); and a fix
 * that posts nothing at all, which arms 1, 7 and 8 refuse.
 *
 * AND WHAT NEITHER ARM CAN SEPARATE, said rather than left implied: the lock the WRITER takes. What
 * blocks the remap in both arms is the READER's `FOR UPDATE` on the mapping rows, which stops any
 * UPDATE of them — cooperative or not. `saveXeroSettings` taking the same lock buys two narrower
 * things: the documented order (so a future second reader cannot invert it), and the fresh-install
 * race where the row does not exist yet and two participants would otherwise both materialise it.
 * No arm here distinguishes it, and the mutation that removes it survives.
 */
test('o3d-8f0p6 r4: two purchase orders in one ASN post on the same account mapping', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const multi = await seedTwoPoAsnViaRealCreate('N', 2, 13)
  const REMAPPED = '698'

  let remapPromise: Promise<unknown> = Promise.resolve()
  let remapOutcome: { success: boolean; error?: string } | null = null
  remapInventoryAccountOnNextEnqueue = async () => {
    // THROUGH THE REAL WRITER, not a raw row update: `saveXeroSettings` is the only code that remaps
    // these accounts in production, and it is the other half of the lock order this change documents.
    // (Arm 10 uses a RAW update deliberately, because blocking an uncooperative writer is the stronger
    // claim; this arm uses the real one so the production path is exercised at least once.)
    // Between the first PO's enqueue and the second PO's posting. Not awaited: under the lock it
    // cannot commit until the whole event does.
    const { saveXeroSettings } = await import('@/app/actions/xero-sync')
    remapPromise = saveXeroSettings({ xero_inventory_account: REMAPPED })
      .then((result) => { remapOutcome = result })
      .catch((error: unknown) => { remapOutcome = { success: false, error: String(error).slice(0, 200) } })
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  let status: string
  try {
    ;({ status } = await runBookedInMultiPo(multi))
  } finally {
    remapInventoryAccountOnNextEnqueue = null
    await remapPromise.catch(() => {})
  }
  // PRECONDITION, AND IT IS THE ONE THAT MATTERS: the remap must genuinely have gone through the real
  // writer and landed. Until this was asserted the arm passed with a remap that had failed on a
  // missing auth mock, i.e. while exercising nothing at all.
  const afterRemap = await db.setting.findUniqueOrThrow({ where: { key: 'xero_inventory_account' }, select: { value: true } })
  await db.setting.update({ where: { key: 'xero_inventory_account' }, data: { value: INVENTORY_ACCOUNT } })
  console.log(`[arm11] saveXeroSettings outcome=${JSON.stringify(remapOutcome)}; code after the event=${afterRemap.value}`)
  assert.deepEqual(remapOutcome, { success: true }, 'PRECONDITION: the real writer must have accepted the remap')
  assert.equal(afterRemap.value, REMAPPED, 'PRECONDITION: and the remap must actually have landed once the event released the lock')
  assert.equal(status, 'processed')

  const logsA = await stockReceiptLogsFor(multi.poAId)
  const logsB = await stockReceiptLogsFor(multi.poBId)
  const codesA = payloadLines(logsA[0]?.payload).map((l) => l.accountCode)
  const codesB = payloadLines(logsB[0]?.payload).map((l) => l.accountCode)
  console.log(`[arm11] PO A codes=${JSON.stringify(codesA)} PO B codes=${JSON.stringify(codesB)}`)
  assert.equal(logsA.length, 1, 'PRECONDITION: the first purchase order must have posted')
  assert.equal(logsB.length, 1, 'PRECONDITION: the second purchase order must have posted too — otherwise there is nothing to compare')
  assert.deepEqual(
    codesA,
    codesB,
    'both purchase orders in one ASN must post on the SAME account mapping; a remap attempted between '
    + 'them must not split the event across two mappings',
  )
  assert.deepEqual(codesA, [INVENTORY_ACCOUNT, TRANSIT_ACCOUNT], 'and on the mapping that was current when the event began')
})

/**
 * A LINKED FREIGHT PURCHASE ORDER with one cost line, linked to `primary` (o3d-8m8pe arms 12 and 13).
 *
 * Copied from arm 9 of tests/concurrency/mintsoft-align-up-stock-receipt-journal.concurrent.test.ts,
 * which is the proof for the SAME defect on the third receipt writer. `status` and `allocated` are set
 * explicitly because the state these arms are about is precisely the one cancellation leaves behind:
 * the link row still present, the freight order CANCELLED, the link unallocated. The freight order's
 * own rows are seeded directly rather than through a cancellation action — the SUBJECT here is which
 * links the cost read counts, not how an order comes to be cancelled, and driving a cancellation would
 * also run landed-cost recalculation and write the cost columns these arms are measuring.
 */
async function seedLinkedFreightPoFor(
  primaryPoId: string,
  label: string,
  amount: number,
  status: 'PO_SENT' | 'CANCELLED',
  allocated: boolean,
): Promise<{ poId: string }> {
  const { db } = await import('@/lib/db')
  const tag = uniqueTag(`FR${label}`)
  const supplier = await db.supplier.create({
    data: { name: `${tag} freight supplier`, currency: 'GBP' },
    select: { id: true },
  })
  const freightPo = await db.purchaseOrder.create({
    data: {
      reference: tag,
      supplierId: supplier.id,
      status,
      type: 'FREIGHT',
      currency: 'GBP',
      fxRateToBase: '1',
      subtotalForeign: amount,
      subtotalBase: amount,
      totalForeign: amount,
      totalBase: amount,
      freightCostLines: {
        create: [{
          description: `${label} freight`,
          amountForeign: `${amount}.0000`,
          amountBase: `${amount}.0000`,
          vatable: false,
          distributionMethod: 'BY_VALUE',
        }],
      },
    },
    select: { id: true },
  })
  await db.landedCostLink.create({
    data: { primaryPoId, freightPoId: freightPo.id, method: 'BY_VALUE', allocated },
    select: { id: true },
  })
  return { poId: freightPo.id }
}

/**
 * THE TWO LINKS, READ BACK, so neither arm can assert the absence of something that was never there.
 * Returns the rows it examined, and the count is printed by the caller.
 */
async function assertBothFreightLinksSeeded(primaryPoId: string, arm: string) {
  const { db } = await import('@/lib/db')
  const links = await db.landedCostLink.findMany({
    where: { primaryPoId },
    select: { freightPoId: true, allocated: true, freightPO: { select: { status: true } } },
  })
  console.log(`[${arm}] examined ${links.length} landed-cost link(s): ${JSON.stringify(links)}`)
  assert.equal(links.length, 2, 'PRECONDITION: both freight links must exist on the primary order')
  assert.equal(
    links.filter((l) => l.freightPO.status === 'CANCELLED').length,
    1,
    'PRECONDITION: exactly one of them must be CANCELLED — that is the one whose cost must vanish',
  )
  return links
}

/**
 * ARM 12 — A CANCELLED LINKED FREIGHT ORDER MUST NOT REACH THE WMS BOOK-IN'S LAYER, MOVEMENT OR JOURNAL.
 *
 * o3d-8m8pe. This file's book-in read `landedCostLinks` with NO `where`, because it COPIED the manual
 * receipt's query verbatim when o3d-8f0p6 r2 routed the book-in through the shared gross-cost helper —
 * so the defect travelled with the fix. Cancelling a freight order leaves the link row in place, marks
 * the freight order CANCELLED and the link unallocated, and BOTH landed-cost recalculation paths
 * exclude it (landed-cost-service.ts, audit-C3 and audit-izrf). The book-in therefore added freight the
 * business had cancelled back into its cost layer, its stock movement and its STOCK_RECEIPT journal:
 * inventory overstated, and a value that disagrees with what recalculation computes for the very same
 * units.
 *
 * THE FIXTURE IS THE STATE CANCELLATION LEAVES: a live linked freight order with a cost line, a SECOND
 * CANCELLED one with a much larger cost line, and both links present. So the arm distinguishes
 * "excludes cancelled freight" from "ignores linked freight altogether" — the live one must still be IN,
 * and that positive half is what stops the arm passing by valuing nothing at all.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that filters on `LandedCostLink.allocated` instead of on the
 * freight order's status. That would ALSO exclude the cancelled link here, but it would wrongly zero
 * live-but-not-yet-allocated freight, which is the ordinary state at receipt time and is exactly what
 * the live half of this arm asserts is included (the live link is seeded `allocated: false`). It also
 * says nothing about a freight order cancelled AFTER this read, which is the mapping lock's business
 * and is arms 10 and 11.
 */
test('o3d-8m8pe: a cancelled linked freight order contributes nothing to the WMS book-in cost', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 4
  const GOODS_UNIT = 10
  const LIVE_FREIGHT = 20
  const CANCELLED_FREIGHT = 400
  // No DIRECT freight on the primary: the only freight in play is linked, so nothing else can make the
  // gross cost exceed the goods cost.
  const seeded = await seedPurchaseBackedAsnViaRealCreate('CF', QTY, GOODS_UNIT)

  const liveFreight = await seedLinkedFreightPoFor(seeded.poId, 'live', LIVE_FREIGHT, 'PO_SENT', false)
  const cancelledFreight = await seedLinkedFreightPoFor(seeded.poId, 'dead', CANCELLED_FREIGHT, 'CANCELLED', false)
  await assertBothFreightLinksSeeded(seeded.poId, 'arm12')
  assert.ok(liveFreight.poId !== cancelledFreight.poId)

  const expectedUnitCost = GOODS_UNIT + LIVE_FREIGHT / QTY
  const expectedAmount = QTY * expectedUnitCost
  const wrongUnitCost = GOODS_UNIT + (LIVE_FREIGHT + CANCELLED_FREIGHT) / QTY

  const { status } = await runBookedIn(seeded, seeded.poLineId)
  assert.equal(status, 'processed', 'PRECONDITION: the book-in must have processed')

  const layer = await db.costLayer.findFirstOrThrow({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  const movement = await db.stockMovement.findFirstOrThrow({
    where: { type: 'PURCHASE_RECEIPT', productId: seeded.productId },
    select: { unitCostBase: true, totalValueBase: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  const debit = payloadLines(logs[0]?.payload ?? null).find((l) => typeof l.debit === 'number')
  console.log(`[arm12] goods ${GOODS_UNIT} + LIVE freight ${LIVE_FREIGHT}/${QTY} => expected unit ${expectedUnitCost}; including the cancelled ${CANCELLED_FREIGHT} would give ${wrongUnitCost}; layer=${JSON.stringify(layer)} movement=${JSON.stringify(movement)} debit=${String(debit?.debit)}`)

  assert.notEqual(expectedUnitCost, wrongUnitCost, 'PRECONDITION: the two answers must be distinguishable')
  assert.equal(
    Number(layer.unitCostBase),
    expectedUnitCost,
    `the cost layer must carry the LIVE freight only (${expectedUnitCost}); ${wrongUnitCost} means the `
    + 'cancelled freight order was added back in, overstating inventory',
  )
  assert.equal(Number(movement.unitCostBase), expectedUnitCost, 'and so must the movement')
  assert.equal(logs.length, 1, `the journal must be queued; found ${logs.length}`)
  assert.equal(debit?.debit, expectedAmount, `and the journal debit must be ${expectedAmount}`)
  assert.equal(Number(movement.totalValueBase), debit?.debit, 'movement value == journal debit')
  assert.equal(Number(layer.unitCostBase) * Number(layer.receivedQty), debit?.debit, 'layer value == journal debit')

  // AND THE LIVE FREIGHT REALLY IS IN: this is what separates the fix from "ignore linked freight", and
  // from a filter on `allocated` (the live link above is unallocated, as it is at receipt time).
  assert.ok(
    expectedUnitCost > GOODS_UNIT,
    'PRECONDITION: the live freight must move the unit cost above the goods cost, or this arm would '
    + 'also pass for a fix that dropped linked freight altogether',
  )
  assert.notEqual(Number(layer.unitCostBase), GOODS_UNIT, 'the live freight must be IN the layer, not merely the cancelled one out')

  const transit = await transitRowsFor(seeded.poId)
  assert.equal(transit.length, 1)
  assert.equal(Number(transit[0]!.baseDelta), -expectedAmount)
})

/**
 * ARM 13 — THE SAME, FOR THE MANUAL RECEIPT (app/actions/purchase-orders.ts).
 *
 * o3d-8m8pe. The manual receipt's `currentPo` query is the OLDEST of the three unfiltered readers and
 * the one `computeGrossUnitCostBaseByLine` was written for, so it carried the same defect: a cancelled
 * freight order's cost lines re-entered the receipt's cost layer, its stock movement and its
 * STOCK_RECEIPT journal.
 *
 * WHY THIS ARM LIVES IN THIS FILE. The fixtures the defect needs — a real purchase order with a linked
 * freight order, the accounting connector switched on, and the STOCK_RECEIPT log/transit readers — are
 * all here, and arm 3 already drives `receivePurchaseOrder` from this file for the same reason.
 *
 * WHY THE RECEIPT IS PARTIAL. A FULL receipt enters the `allReceived` branch, which tries to mark every
 * linked freight order RECEIVED and throws on a CANCELLED one
 * (`validateLinkedFreightReceiptStatus`) — i.e. the whole receipt is refused before any cost is read,
 * so the cost question could not be asked at all. That refusal is an ADJACENT defect (a cancelled
 * freight link blocks a full manual receipt outright) and is FILED, not fixed here: o3d-8m8pe's scope is
 * the cost read. A PARTIAL receipt skips that branch, and the gross unit cost the helper computes does
 * not depend on the received quantity — it is the line's own qty and totalBase — so the partial receipt
 * measures exactly the same number the full one would.
 *
 * WHAT WOULD STILL PASS THIS ARM: the same `allocated` filter arm 12 names, and a fix applied only to
 * the book-in (arm 12 is the one that catches the reverse).
 */
test('o3d-8m8pe: a cancelled linked freight order contributes nothing to the MANUAL receipt cost', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 4
  const RECEIVE_QTY = 3
  const GOODS_UNIT = 10
  const LIVE_FREIGHT = 20
  const CANCELLED_FREIGHT = 400
  const seeded = await seedPurchaseBackedAsnViaRealCreate('CM', QTY, GOODS_UNIT)

  const liveFreight = await seedLinkedFreightPoFor(seeded.poId, 'mlive', LIVE_FREIGHT, 'PO_SENT', false)
  const cancelledFreight = await seedLinkedFreightPoFor(seeded.poId, 'mdead', CANCELLED_FREIGHT, 'CANCELLED', false)
  await assertBothFreightLinksSeeded(seeded.poId, 'arm13')
  assert.ok(liveFreight.poId !== cancelledFreight.poId)

  // BY_VALUE over one line: the whole live freight amount lands on it, spread over the LINE's qty — not
  // over the received qty — so this is the same unit cost a full receipt would compute.
  const expectedUnitCost = GOODS_UNIT + LIVE_FREIGHT / QTY
  const expectedAmount = RECEIVE_QTY * expectedUnitCost
  const wrongUnitCost = GOODS_UNIT + (LIVE_FREIGHT + CANCELLED_FREIGHT) / QTY

  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const received = await receivePurchaseOrder(seeded.poId, [
    { poLineId: seeded.poLineId, qtyReceived: RECEIVE_QTY, warehouseId: seeded.warehouseId },
  ])
  assert.equal(received.success, true, `PRECONDITION: the manual receipt must succeed: ${received.error}`)
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: seeded.poId }, select: { status: true } })
  assert.equal(po.status, 'PARTIALLY_RECEIVED', 'PRECONDITION: the receipt must be the PARTIAL one this arm is about')

  const layer = await db.costLayer.findFirstOrThrow({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  const movement = await db.stockMovement.findFirstOrThrow({
    where: { type: 'PURCHASE_RECEIPT', productId: seeded.productId },
    select: { unitCostBase: true, totalValueBase: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  const debit = payloadLines(logs[0]?.payload ?? null).find((l) => typeof l.debit === 'number')
  console.log(`[arm13] goods ${GOODS_UNIT} + LIVE freight ${LIVE_FREIGHT}/${QTY} => expected unit ${expectedUnitCost}; including the cancelled ${CANCELLED_FREIGHT} would give ${wrongUnitCost}; layer=${JSON.stringify(layer)} movement=${JSON.stringify(movement)} debit=${String(debit?.debit)}`)

  assert.notEqual(expectedUnitCost, wrongUnitCost, 'PRECONDITION: the two answers must be distinguishable')
  assert.equal(
    Number(layer.unitCostBase),
    expectedUnitCost,
    `the cost layer must carry the LIVE freight only (${expectedUnitCost}); ${wrongUnitCost} means the `
    + 'cancelled freight order was added back in, overstating inventory',
  )
  assert.equal(Number(movement.unitCostBase), expectedUnitCost, 'and so must the movement')
  assert.equal(logs.length, 1, `the journal must be queued; found ${logs.length}`)
  assert.equal(debit?.debit, expectedAmount, `and the journal debit must be ${expectedAmount}`)
  assert.equal(Number(movement.totalValueBase), debit?.debit, 'movement value == journal debit')
  assert.equal(Number(layer.unitCostBase) * Number(layer.receivedQty), debit?.debit, 'layer value == journal debit')

  // AND THE LIVE FREIGHT REALLY IS IN — the positive half, without which this arm would pass for a
  // receipt that valued nothing.
  assert.ok(
    expectedUnitCost > GOODS_UNIT,
    'PRECONDITION: the live freight must move the unit cost above the goods cost, or this arm would '
    + 'also pass for a fix that dropped linked freight altogether',
  )
  assert.notEqual(Number(layer.unitCostBase), GOODS_UNIT, 'the live freight must be IN the layer, not merely the cancelled one out')

  const transit = await transitRowsFor(seeded.poId)
  assert.equal(transit.length, 1)
  assert.equal(Number(transit[0]!.baseDelta), -expectedAmount)
})

/** The exception-inbox rows for a purchase order, whatever the posting scope. */
async function refusalRowsFor(referenceId: string) {
  const { db } = await import('@/lib/db')
  return db.accountingPostingRefusal.findMany({
    where: { referenceType: 'PurchaseOrder', referenceId },
    orderBy: { firstRefusedAt: 'asc' },
    select: { id: true, type: true, kind: true, reason: true, committed: true, remedy: true, scope: true },
  })
}

/** The caller's own report of a declined posting, as the activity log carries it. */
async function notQueuedActivityFor(entityId: string) {
  const { db } = await import('@/lib/db')
  return db.activityLog.findMany({
    where: { entityType: 'PURCHASE_ORDER', entityId, action: 'stock_receipt_journal_not_queued' },
    select: { id: true, level: true, description: true },
  })
}

/**
 * ARM 14 — A DECLINED RECEIPT JOURNAL IS REPORTED, WITH WHAT IMS COMMITTED AND THE REMEDY.
 *
 * o3d-ln2df. The book-in read its enqueue's answer only to gate the transit mirror and then dropped it.
 * On a decline the book-in committed, the mirror was correctly skipped, and the facade's own
 * `recordRefusalAsOutstanding` raised an inbox row — but that row carried NO `committed` and NO `remedy`,
 * because both come from the CALLER through `reportPostingNotQueued`. The operator got a refusal with no
 * statement of what IMS did anyway and no instruction, which is what rule 3 of
 * lib/domain/accounting/enqueue-outcome.ts exists to provide. It matters more here than at most reporting
 * sites because this path CONSUMES the book-in event and nothing re-attempts the journal: stock credited,
 * cost layers laid, no journal, no transit row, nothing that will ever post them.
 *
 * HOW THE DECLINE IS PRODUCED, and it is a real one. The book-in reads the active accounting connector
 * over the pool BEFORE its transaction opens and the enqueue re-asks under the selection lock inside it.
 * The connector is switched off in that window — the production race — so
 * `pinnedLedgerIsServicedUnderLock` answers no and PRODUCTION code decides the refusal, its reason, its
 * posting key and its inbox row. Nothing about the outcome is fabricated.
 *
 * AND THE ORDINARY PATH IS IN THE SAME ARM, on a second purchase order, because a test that only looks at
 * the refusal can pass for an implementation that refuses EVERYTHING: the accepted book-in must still
 * queue its journal, still write the transit mirror, and raise NO refusal and NO report.
 *
 * WHAT WOULD STILL PASS THIS ARM: an implementation that reported from INSIDE the transaction (which
 * would leave the report standing after a rollback — not covered here, and the reason the report is
 * drained after the commit is stated at the site), and one that got the `not-configured` gate wrong in
 * the silent direction. It does NOT establish that the book-in is re-attempted later; it establishes the
 * opposite is reported.
 */
test('o3d-ln2df: a DECLINED receipt journal is reported with what the book-in committed and the remedy', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 2
  const GOODS_UNIT = 11
  const declined = await seedPurchaseBackedAsnViaRealCreate('DQ', QTY, GOODS_UNIT)

  retireChartAfterConnectorRead = true
  let status: string
  try {
    ;({ status } = await runBookedIn(declined, declined.poLineId))
  } finally {
    retireChartAfterConnectorRead = false
    await db.setting.upsert({
      where: { key: 'plugin_xero_enabled' },
      create: { key: 'plugin_xero_enabled', value: 'true' },
      update: { value: 'true' },
    })
  }

  // ── THE BOOK-IN STILL COMMITTED. A retired chart must not stop a warehouse receiving stock. ──
  assert.equal(status, 'processed', `the book-in must still commit on a declined posting; got ${status}`)
  const movements = await db.stockMovement.findMany({
    where: { type: 'PURCHASE_RECEIPT', productId: declined.productId },
    select: { id: true, totalValueBase: true },
  })
  const layers = await db.costLayer.count({ where: { poLineId: declined.poLineId } })
  const logs = await stockReceiptLogsFor(declined.poId)
  const transit = await transitRowsFor(declined.poId)
  const refusals = await refusalRowsFor(declined.poId)
  const reports = await notQueuedActivityFor(declined.poId)
  console.log(`[arm14] declined PO: status=${status} movements=${movements.length} layers=${layers} STOCK_RECEIPT logs=${logs.length} transit=${transit.length} refusals=${refusals.length} reports=${reports.length} refusalRows=${JSON.stringify(refusals)}`)

  assert.equal(movements.length, 1, 'PRECONDITION: the stock movement must be committed, or there is no committed state to report')
  assert.equal(layers, 1, 'PRECONDITION: and the cost layer with it')
  // ── AND THE PRECONDITION THAT MAKES THE REST MEAN ANYTHING: the enqueue really declined. ──
  assert.equal(logs.length, 0, `PRECONDITION: the enqueue must have DECLINED; found ${logs.length} STOCK_RECEIPT sync row(s), so nothing was refused`)
  // ── THE TRANSIT MIRROR IS STILL SKIPPED (o3d-bcz9.4): an unqueued journal must not be mirrored. ──
  assert.equal(transit.length, 0, `a journal that was not queued must not be mirrored; found ${transit.length} transit row(s)`)

  // ── THE REPORT ITSELF, which is what this issue is about. ──
  assert.equal(refusals.length, 1, `the decline must leave exactly one exception-inbox row; found ${refusals.length}`)
  const refusal = refusals[0]!
  assert.equal(refusal.type, 'STOCK_RECEIPT')
  assert.equal(refusal.kind, 'stock_receipt_journal', 'the SITE names the kind: nothing re-attempts this posting, so the row is closed by marking it handled')
  assert.ok(
    (refusal.committed ?? '').length > 0,
    'the inbox row must state WHAT IMS COMMITTED ANYWAY — a refusal with no `committed` is one an operator cannot act on',
  )
  assert.ok(
    (refusal.remedy ?? '').length > 0,
    'and WHAT A HUMAN HAS TO DO — `remedy` comes from the caller and was absent before o3d-ln2df',
  )
  // Not merely non-empty: the site's OWN sentences, not the enqueue's generic placeholder. Before the fix
  // the row carried the facade's 'the change that raised this posting is committed in IMS', which says
  // nothing about a book-in, and a generic remedy that does not mention that nothing will retry this.
  assert.match(
    refusal.committed ?? '',
    /booked in/i,
    'the `committed` must name what the BOOK-IN did (the goods booked in, the movements and layers), not the enqueue\'s generic placeholder',
  )
  assert.match(
    refusal.remedy ?? '',
    /by hand/i,
    'the `remedy` must name the hand posting',
  )
  assert.match(
    refusal.remedy ?? '',
    /Mark as handled/i,
    'and how to close the row once it is posted',
  )
  assert.equal(reports.length, 1, `and the decline must be reported in the activity log; found ${reports.length}`)
  assert.equal(reports[0]!.level, 'ERROR', 'at ERROR — a posting the ledger will never receive is not a notice')

  // ── THE ORDINARY PATH, UNCHANGED, so this arm cannot pass by refusing everything. ──
  const accepted = await seedPurchaseBackedAsnViaRealCreate('DA', QTY, GOODS_UNIT)
  const okStatus = await runBookedIn(accepted, accepted.poLineId)
  const okLogs = await stockReceiptLogsFor(accepted.poId)
  const okTransit = await transitRowsFor(accepted.poId)
  const okRefusals = await refusalRowsFor(accepted.poId)
  const okReports = await notQueuedActivityFor(accepted.poId)
  console.log(`[arm14] accepted PO: status=${okStatus.status} logs=${okLogs.length} transit=${okTransit.length} refusals=${okRefusals.length} reports=${okReports.length}`)
  assert.equal(okStatus.status, 'processed')
  assert.equal(okLogs.length, 1, 'the ordinary book-in must still queue its journal')
  assert.equal(okTransit.length, 1, 'and still write the transit subledger mirror')
  assert.equal(Number(okTransit[0]!.baseDelta), -(QTY * GOODS_UNIT), 'at the receipt value')
  assert.equal(okRefusals.length, 0, 'and raise NO refusal — otherwise the arm above would pass for an implementation that refuses everything')
  assert.equal(okReports.length, 0, 'and no not-queued report')
})
