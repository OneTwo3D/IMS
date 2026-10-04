import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import * as realAccountingNs from '@/lib/accounting'
import * as realTransitNs from '@/lib/domain/accounting/transit-subledger-movement'
import * as realLockOrderNs from '@/lib/domain/wms/transfer-asn-lock-order'
import * as realCostLayersNs from '@/lib/cost-layers'
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
    // `requireRole` is here because o3d-8f0p6 r4 found its absence made an arm VACUOUS: the writer
    // action's own catch turned the missing mock into a silent `{ success: false }` and the arm passed
    // having remapped nothing. Arm 11 asserts the writer ACCEPTED the remap for the same reason.
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
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
      return realAccountingNs.queueAccountingSyncTx(...args)
    },
  },
})

/**
 * THE SECOND SEAM, fired ONCE from inside the alignment transaction AFTER the journal has been
 * enqueued and the transit row written (r2 arms 8 and 10).
 *
 * WHY HERE AND NOT AT THE ENQUEUE. Round 1's hook fired at the enqueue, so it only ever exercised a
 * writer racing the code read — which the deleted re-read could see. The window Codex round 2 named is
 * the one AFTER every account read, while the transaction walks on through the remaining allocations,
 * the stock-level updates and the ASN updates. A hook at the last accounting write is inside that
 * window, which is exactly why it is the one worth having.
 */
let afterTransitWriteHook: (() => Promise<void>) | null = null
mock.module('@/lib/domain/accounting/transit-subledger-movement', {
  namedExports: {
    ...realTransitNs,
    recordTransitSubledgerMovement: async (
      ...args: Parameters<typeof realTransitNs.recordTransitSubledgerMovement>
    ) => {
      const result = await realTransitNs.recordTransitSubledgerMovement(...args)
      if (afterTransitWriteHook) {
        const hook = afterTransitWriteHook
        afterTransitWriteHook = null
        await hook()
      }
      return result
    },
  },
})

/**
 * ARM 13'S SEAM — A BARRIER BETWEEN THE PARENT LOCK AND THE CHILD LOCKS (r3).
 *
 * WHY IT HAS TO BE THERE AND NOWHERE ELSE. The deadlock round 3 found needs one transaction holding
 * the PARENT while it still wants the CHILDREN, and the other holding a CHILD while it wants the
 * PARENT. `lockPurchaseOrdersWithCostRows` closes that window deliberately — it takes all three in one
 * call — so the only way to OBSERVE the window is to park the alignment inside it. Any later barrier
 * (the enqueue, the transit write) is after the alignment already holds both, where no cycle can form
 * and the arm would pass whatever the edit path did.
 *
 * THE LOCK STATEMENTS ARE REAL. The wrapper takes the parent with the REAL `lockPurchaseOrders`,
 * awaits the barrier, and then calls the REAL combined helper for the children (its parent
 * re-acquisition is a no-op, the row is already held by this transaction). So at the barrier PostgreSQL
 * genuinely holds the parent row and genuinely does not hold the cost rows — the state is not
 * simulated, only its timing is controlled.
 */
let pauseAfterParentLock: (() => Promise<void>) | null = null
/**
 * ARM 15'S SEAM — THE WINDOW BETWEEN DISCOVERY AND THE FIRST LOCK (r6).
 *
 * `applyMintsoftAlignmentForProduct` discovers its candidates (stock-sync.ts:1458) and then takes its
 * first lock, `lockStockTransfers` (:1477). Wrapping that call and pausing BEFORE delegating parks the
 * transaction in the only window where a freight order can be linked without any lock covering it — which
 * is precisely the window Codex round 6 named. For a purchase-order-only fixture the call locks nothing,
 * but it is still made, so the barrier still fires.
 */
let pauseBeforeFirstLock: (() => Promise<void>) | null = null
mock.module('@/lib/domain/wms/transfer-asn-lock-order', {
  namedExports: {
    ...realLockOrderNs,
    lockStockTransfers: async (
      ...args: Parameters<typeof realLockOrderNs.lockStockTransfers>
    ) => {
      if (pauseBeforeFirstLock) {
        const hook = pauseBeforeFirstLock
        pauseBeforeFirstLock = null
        await hook()
      }
      return realLockOrderNs.lockStockTransfers(...args)
    },
    lockPurchaseOrdersWithCostRows: async (
      tx: Parameters<typeof realLockOrderNs.lockPurchaseOrdersWithCostRows>[0],
      ids: Parameters<typeof realLockOrderNs.lockPurchaseOrdersWithCostRows>[1],
    ) => {
      if (pauseAfterParentLock) {
        const hook = pauseAfterParentLock
        pauseAfterParentLock = null
        await realLockOrderNs.lockPurchaseOrders(tx, ids)
        await hook()
      }
      return realLockOrderNs.lockPurchaseOrdersWithCostRows(tx, ids)
    },
  },
})

/**
 * ARM 14'S SEAM — A BARRIER BETWEEN THE RECEIPT'S PARENT LOCK AND ITS FIRST STOCK LOCK (r5).
 *
 * `receiveStock`'s sequence is `purchase_orders` → `cost_layers` → `stock_levels` →
 * `purchase_order_lines`, and `createCostLayer` sits between the parent lock and the stock upsert. So
 * wrapping it parks the receipt holding the parent and NOT yet the stock row — the one window in which
 * the supplier return's stock-before-parent order can close a cycle. Any earlier barrier and the
 * receipt holds nothing; any later one and it already holds the stock row, where the return simply
 * queues and the arm would pass whatever order the return used.
 *
 * The layer really is created before the pause: the wrapper delegates first, so the state at the
 * barrier is production's own.
 */
let pauseAfterReceiptCostLayer: (() => Promise<void>) | null = null
mock.module('@/lib/cost-layers', {
  namedExports: {
    ...realCostLayersNs,
    createCostLayer: async (
      ...args: Parameters<typeof realCostLayersNs.createCostLayer>
    ) => {
      const created = await realCostLayersNs.createCostLayer(...args)
      if (pauseAfterReceiptCostLayer) {
        const hook = pauseAfterReceiptCostLayer
        pauseAfterReceiptCostLayer = null
        await hook()
      }
      return created
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

/**
 * A LINKED FREIGHT PURCHASE ORDER with one cost line, linked to `primary` (r2 arm 9).
 *
 * `status` and `allocated` are set explicitly because the state this arm is about is precisely the one
 * cancellation leaves behind: the link row still present, the freight order CANCELLED, the link
 * unallocated. The freight order's own rows are seeded directly rather than through a cancellation
 * action — the SUBJECT here is which links the cost read counts, not how an order comes to be
 * cancelled, and driving a cancellation would also run landed-cost recalculation and write cost
 * columns this file must never write.
 */
async function seedLinkedFreightPo(
  primary: SeededAlignmentTarget,
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
    data: { primaryPoId: primary.poId, freightPoId: freightPo.id, method: 'BY_VALUE', allocated },
    select: { id: true },
  })
  return { poId: freightPo.id }
}

/**
 * A SECOND purchase order and open ASN for the SAME product in the SAME warehouse (r2 arm 11), at a
 * DIFFERENT unit cost, so one alignment plan spans two orders and the two costs are distinguishable.
 * Built by the same real creation path, so no cost column is written by hand here either.
 */
async function seedSecondOrderForSameProduct(
  first: SeededAlignmentTarget,
  qty: number,
  unitCost: number,
): Promise<{ poId: string; poLineId: string; qty: number; unitCost: number; asnLineMapId: string }> {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = uniqueTag('Q')
  const supplier = await db.supplier.create({
    data: { name: `${tag} supplier`, currency: 'GBP' },
    select: { id: true },
  })
  const created = await createPurchaseOrder({
    reference: tag,
    supplierId: supplier.id,
    currency: 'GBP',
    fxRateToBase: 1,
    destinationWarehouseId: first.warehouseId,
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: [{
      productId: first.productId,
      sku: first.tag,
      productName: `o3d-6nd55 second order`,
      qty,
      unitCostForeign: unitCost,
    }],
  })
  assert.equal(created.success, true, `PRECONDITION: the second createPurchaseOrder must succeed: ${created.error}`)
  const po = await db.purchaseOrder.findUniqueOrThrow({
    where: { reference: tag },
    select: { id: true, lines: { select: { id: true } } },
  })
  await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-6nd55: a test fixture row, not a core flow branch
      externalAsnId: tag,
      sourceType: 'PURCHASE_ORDER',
      sourceId: po.id,
      warehouseId: first.warehouseId,
      status: 'OPEN',
      lines: {
        create: [{
          externalAsnLineId: `${tag}-1`,
          sourceType: 'PURCHASE_ORDER_LINE',
          sourceLineId: po.lines[0]!.id,
          productId: first.productId,
          sku: first.tag,
          expectedQty: `${qty}.0000`,
        }],
      },
    },
    select: { lines: { select: { id: true } } },
  })
  return { poId: po.id, poLineId: po.lines[0]!.id, qty, unitCost, asnLineMapId: asn.lines[0]!.id }
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
 * WHICH OF THE THREE RECEIPT WRITERS QUEUED A JOURNAL (r2, after #713 merged).
 *
 * All three post `STOCK_RECEIPT` against `referenceType: 'PurchaseOrder'`, and their idempotency keys
 * are hashed, so the payload's NARRATION is what distinguishes them:
 *   · align-up   — "… via Mintsoft alignment against ASN …"  (stock-sync.ts)
 *   · book-in    — "… via WMS ASN …"                          (booked-in-service.ts, o3d-8f0p6)
 *   · IMS receipt— neither phrase                              (app/actions/purchase-orders.ts)
 * Asserted rather than assumed: `splitReceiptLogs` throws on a narration it cannot classify, so a
 * wording change upstream fails loudly instead of silently reclassifying a journal as the other
 * writer's and making a composition assertion vacuous.
 */
function splitReceiptLogs(logs: SyncLogRow[]): { alignUp: SyncLogRow[]; bookIn: SyncLogRow[] } {
  const alignUp: SyncLogRow[] = []
  const bookIn: SyncLogRow[] = []
  for (const log of logs) {
    const narration = String((log.payload as { narration?: unknown } | null)?.narration ?? '')
    if (narration.includes('via Mintsoft alignment against ASN')) alignUp.push(log)
    else if (narration.includes('via WMS ASN')) bookIn.push(log)
    else {
      throw new Error(
        'unclassifiable STOCK_RECEIPT narration — neither writer\'s phrase is present, so this arm '
        + `cannot tell which path posted it: ${JSON.stringify(narration)}`,
      )
    }
  }
  return { alignUp, bookIn }
}

/** The debit amount of a journal payload. */
function debitOf(payload: unknown): number {
  const debit = payloadLines(payload).find((l) => typeof l.debit === 'number')?.debit
  assert.equal(typeof debit, 'number', `payload has no debit line: ${JSON.stringify(payload)}`)
  return debit as number
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
 * AND SINCE o3d-8f0p6 MERGED (trunk c1d44e0f) THIS ARM MEASURES BOTH HALVES, which it could not when
 * it was first written: the book-in now posts its own journal, so the arm reads BOTH and asserts they
 * partition the delivery — align-up's covers the 6 units it credited, the book-in's covers the
 * remaining 4, and the two together are the full 10 units of value exactly once. Before the merge this
 * arm could only pin the quantity exclusion and had to defer the amount to #713's own arm 6; that
 * caveat is discharged.
 *
 * WHAT WOULD STILL PASS THIS ARM: it says nothing about a book-in that reports FEWER units than
 * alignment already credited — that is `resolveWmsAsnLineResidualQty`'s max(), exercised by arm 7 from
 * the other direction. It also does not distinguish which writer posted which amount by anything
 * stronger than the payload narration, which `splitReceiptLogs` refuses to guess at.
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

  // ─── AND NOW BOTH JOURNALS, since o3d-8f0p6 is on trunk ───
  const logs = await stockReceiptLogsFor(seeded.poId)
  const { alignUp: alignUpLogs, bookIn: bookInLogs } = splitReceiptLogs(logs)
  const alignUpDebits = alignUpLogs.reduce((sum, log) => sum + debitOf(log.payload), 0)
  const bookInDebits = bookInLogs.reduce((sum, log) => sum + debitOf(log.payload), 0)
  console.log(`[arm6] ${logs.length} STOCK_RECEIPT log(s): align-up ${alignUpLogs.length} totalling ${alignUpDebits}, book-in ${bookInLogs.length} totalling ${bookInDebits}; full delivery value ${TOTAL * seeded.unitCost}`)

  assert.equal(alignUpLogs.length, 1, `align-up must have posted exactly one journal; found ${alignUpLogs.length}`)
  assert.equal(
    bookInLogs.length,
    1,
    `and the book-in exactly one for the remainder; found ${bookInLogs.length}. Zero would mean the `
    + 'book-in half of the composition is not being measured at all.',
  )
  assert.equal(alignUpDebits, ALIGNED * seeded.unitCost, `align-up must journal its ${ALIGNED} units`)
  assert.equal(
    bookInDebits,
    (TOTAL - ALIGNED) * seeded.unitCost,
    `and the book-in ONLY the remaining ${TOTAL - ALIGNED} — journalling all ${TOTAL} would double-post `
    + `the ${ALIGNED} units align-up already accounted for`,
  )
  assert.equal(
    alignUpDebits + bookInDebits,
    TOTAL * seeded.unitCost,
    `the two writers together must journal the delivery EXACTLY ONCE: ${TOTAL} x ${seeded.unitCost}`,
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
  const logs = await stockReceiptLogsFor(seeded.poId)
  const { alignUp: alignUpLogs, bookIn: bookInLogs } = splitReceiptLogs(logs)
  const alignUpDebits = alignUpLogs.reduce((sum, log) => sum + debitOf(log.payload), 0)
  const bookInDebits = bookInLogs.reduce((sum, log) => sum + debitOf(log.payload), 0)
  console.log(`[arm7] stock=${String(level.quantity)} totalLayered=${totalLayered}; align-up ${alignUpLogs.length} totalling ${alignUpDebits}, book-in ${bookInLogs.length} totalling ${bookInDebits}`)

  assert.equal(Number(level.quantity), TOTAL, 'stock must reach the physical quantity and no more')
  assert.equal(totalLayered, TOTAL, 'each unit costed exactly once across both writers')
  assert.equal(
    alignUpLogs.length,
    1,
    `align-up must post exactly one journal, for the ${TOTAL - BOOKED} units the book-in did not land; `
    + `found ${alignUpLogs.length}`,
  )
  assert.equal(
    alignUpDebits,
    (TOTAL - BOOKED) * seeded.unitCost,
    `and it must cover ${TOTAL - BOOKED} units, not all ${TOTAL} — the units the book-in already landed `
    + 'are excluded by resolveWmsAsnLineResidualQty',
  )
  // The book-in's own journal, now that o3d-8f0p6 is on trunk: it went first, so it covers exactly
  // what it landed, and the two partition the delivery.
  assert.equal(bookInLogs.length, 1, `the book-in must have posted its own journal; found ${bookInLogs.length}`)
  assert.equal(bookInDebits, BOOKED * seeded.unitCost, `the book-in must cover its ${BOOKED} units`)
  assert.equal(
    alignUpDebits + bookInDebits,
    TOTAL * seeded.unitCost,
    `the two writers together must journal the delivery EXACTLY ONCE: ${TOTAL} x ${seeded.unitCost}`,
  )

  // The transit clearing account must drain by the same total, once per journal.
  const transit = await transitRowsFor(seeded.poId)
  const transitTotal = transit.reduce((sum, row) => sum + Number(row.baseDelta), 0)
  console.log(`[arm7] ${transit.length} transit row(s) totalling ${transitTotal}`)
  assert.equal(transit.length, 2, `one transit row per journal; found ${transit.length}`)
  assert.equal(
    transitTotal,
    -TOTAL * seeded.unitCost,
    'and the transit account must drain by the whole delivery value, exactly once',
  )
})

/**
 * ARM 8 — THE MAPPING LOCK MUST BLOCK A REMAP THAT COMMITS AFTER THE FINAL ACCOUNT READ.
 *
 * WHAT ROUND 1 GOT WRONG, AND WHY THIS ARM REPLACES ITS PREDECESSOR. Round 1 read the codes inside the
 * transaction and re-read them after the enqueue, refusing on a difference, and its arm fired the
 * remap AT the enqueue. Under READ COMMITTED that re-read can only see a remap that had ALREADY
 * committed; it holds nothing, so a remap committing AFTER it — while the alignment walks on through
 * the remaining allocations, the stock-level updates and the ASN updates — still ends with a journal
 * committed on stale codes. The old arm passed because it tested the one ordering the re-read could
 * see. Refusal was the wrong instrument.
 *
 * SO THIS MEASURES THE LOCK. The remap is fired from a separate pooled connection AFTER the transit
 * write — inside the undefended window — and deliberately NOT awaited, because a transaction that
 * waits for a writer it is itself blocking would deadlock. What is asserted is that the remap DID NOT
 * GET THROUGH: after a generous wait, a THIRD connection still reads the OLD code. Both facts are
 * snapshotted INSIDE the hook, because the `finally` awaits the remap and a flag read afterwards would
 * say nothing about what was true during the transaction.
 *
 * AND THE OUTCOME IS NOW SERIALISATION, NOT REFUSAL: the alignment must SUCCEED on codes that were
 * current for the whole of it, and the remap must land once the lock is released.
 *
 * WHAT WOULD STILL PASS THIS ARM: holding the lock longer than necessary; and any fix that serialises
 * by a different lock, which is also correct. It does NOT establish that two purchase orders in one
 * alignment share one mapping — that is arm 11, on a different mechanism — and it says nothing about a
 * remap that commits after this transaction does, which is a different posting, correctly on the new
 * codes.
 */
test('o3d-6nd55 r2: a remap after the final account read is blocked until the alignment commits', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedAlignmentTarget('L', 2, 11)
  const REMAPPED = '699'

  type RemapOutcome = 'pending' | 'committed' | 'failed'
  let remapSettled: RemapOutcome = 'pending'
  let remapError: string | null = null
  let observedDuringTransaction: string | null = null
  let settledDuringTransaction: RemapOutcome = 'pending'
  let remapPromise: Promise<unknown> = Promise.resolve()

  afterTransitWriteHook = async () => {
    remapPromise = db.setting
      .update({ where: { key: 'xero_inventory_account' }, data: { value: REMAPPED } })
      .then(() => { remapSettled = 'committed' })
      .catch((error: unknown) => { remapSettled = 'failed'; remapError = String(error).slice(0, 200) })
    // A generous window for a single-row update, so "it simply had not run yet" is not a plausible
    // explanation for a pass.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    // A THIRD connection, reading what is COMMITTED right now. A plain SELECT is not blocked by the
    // FOR UPDATE, so this reports the row's committed value rather than waiting for the lock.
    const row = await db.setting.findUniqueOrThrow({
      where: { key: 'xero_inventory_account' },
      select: { value: true },
    })
    observedDuringTransaction = row.value
    settledDuringTransaction = remapSettled
  }

  let applied: boolean
  try {
    ;({ applied } = await alignUp(seeded, { delta: seeded.qty, imsQty: 0 }))
    // Let the queued remap through now the lock is released, so the arm can prove it was SERIALISED
    // rather than rejected.
    await remapPromise.catch(() => {})
  } finally {
    afterTransitWriteHook = null
  }
  const afterRelease = await db.setting.findUniqueOrThrow({
    where: { key: 'xero_inventory_account' },
    select: { value: true },
  })
  await db.setting.update({ where: { key: 'xero_inventory_account' }, data: { value: INVENTORY_ACCOUNT } })

  console.log(`[arm8] applied=${String(applied)}; mid-transaction: code=${String(observedDuringTransaction)} remap=${settledDuringTransaction}${remapError ? ` (${remapError})` : ''}; after release: code=${afterRelease.value} remap=${remapSettled}`)
  assert.equal(
    observedDuringTransaction,
    INVENTORY_ACCOUNT,
    'THE POINT OF THIS ARM: while the alignment held the mapping lock, a remap fired AFTER its final '
    + `account read must not have committed — the committed code should still have been `
    + `${INVENTORY_ACCOUNT}, was ${String(observedDuringTransaction)}. A new value here is the `
    + 'stale-mapping window, reopened.',
  )
  assert.equal(
    settledDuringTransaction,
    'pending',
    'and the remap must still have been WAITING at that moment, not already finished',
  )
  // NOT VACUOUS: the remap must land once the lock is released. If it had failed for an unrelated
  // reason, "it did not commit" would be true for the wrong reason, and this is what catches that.
  assert.equal(
    remapSettled,
    'committed',
    `the remap must succeed once the alignment released the lock — serialised, not rejected${remapError ? `; it failed instead: ${remapError}` : ''}`,
  )
  assert.equal(afterRelease.value, REMAPPED, 'and its value must be the one it wrote')

  assert.equal(applied, true, 'serialising must let the alignment through, not refuse it')
  const logs = await stockReceiptLogsFor(seeded.poId)
  assert.equal(logs.length, 1, `the journal must be queued; found ${logs.length}`)
  const lines = payloadLines(logs[0]!.payload)
  assert.equal(lines.find((l) => typeof l.debit === 'number')?.accountCode, INVENTORY_ACCOUNT)
  assert.equal(lines.find((l) => typeof l.credit === 'number')?.accountCode, TRANSIT_ACCOUNT)
})

/**
 * ARM 9 — A CANCELLED LINKED FREIGHT ORDER MUST NOT REACH THE LAYER, THE MOVEMENT OR THE JOURNAL.
 *
 * CODEX ROUND-2 HIGH-1. Round 1's cost query selected EVERY `landedCostLinks` row. Cancelling a
 * freight order leaves the link row in place, marks the freight order CANCELLED and the link
 * unallocated — so a later align-up added the cancelled freight back into its cost layer, its stock
 * movement and its STOCK_RECEIPT journal. That overstates inventory by freight the business cancelled,
 * and disagrees with what landed-cost recalculation computes for the very same units: both recalc
 * paths exclude a CANCELLED freight order (landed-cost-service.ts, audit-C3 and audit-izrf).
 *
 * THE FIXTURE IS THE STATE THE REVIEWER DESCRIBED: a live linked freight order with a cost line, a
 * SECOND cancelled one with a cost line, and both links present. So the arm distinguishes "excludes
 * cancelled freight" from "ignores linked freight altogether" — the live one must still be included.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that filters on `LandedCostLink.allocated` instead of on the
 * freight order's status. That would ALSO exclude the cancelled link here, but it would wrongly zero
 * live-but-not-yet-allocated freight, which is the ordinary state at receipt time and is exactly what
 * the live half of this arm asserts is included. It also says nothing about a freight order cancelled
 * AFTER this read, which is arm 10's lock.
 */
test('o3d-6nd55 r2: a cancelled linked freight order contributes nothing to the align-up cost', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 4
  const GOODS_UNIT = 10
  const LIVE_FREIGHT = 20
  const CANCELLED_FREIGHT = 400
  const seeded = await seedAlignmentTarget('K', QTY, GOODS_UNIT)
  await assertUntouchedLandedCost(seeded.poLineId, GOODS_UNIT)

  const liveFreight = await seedLinkedFreightPo(seeded, 'live', LIVE_FREIGHT, 'PO_SENT', true)
  const cancelledFreight = await seedLinkedFreightPo(seeded, 'dead', CANCELLED_FREIGHT, 'CANCELLED', false)

  // PRECONDITION: both links really exist and point at this primary, or the arm would be asserting
  // the absence of something that was never there.
  const links = await db.landedCostLink.findMany({
    where: { primaryPoId: seeded.poId },
    select: { freightPoId: true, allocated: true, freightPO: { select: { status: true } } },
  })
  console.log(`[arm9] examined ${links.length} landed-cost link(s): ${JSON.stringify(links)}`)
  assert.equal(links.length, 2, 'PRECONDITION: both freight links must exist on the primary order')
  assert.equal(
    links.filter((l) => l.freightPO.status === 'CANCELLED').length,
    1,
    'PRECONDITION: exactly one of them must be CANCELLED — that is the one whose cost must vanish',
  )
  assert.ok(liveFreight.poId !== cancelledFreight.poId)

  const expectedUnitCost = GOODS_UNIT + LIVE_FREIGHT / QTY
  const expectedAmount = QTY * expectedUnitCost
  const wrongUnitCost = GOODS_UNIT + (LIVE_FREIGHT + CANCELLED_FREIGHT) / QTY

  const result = await alignUp(seeded, { delta: QTY, imsQty: 0 })
  assert.equal(result.applied, true, `PRECONDITION: the alignment must apply: ${result.reason}`)

  const layer = await db.costLayer.findFirstOrThrow({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  const movement = await db.stockMovement.findFirstOrThrow({
    where: { type: 'WMS_RECEIPT_RECONCILIATION', productId: seeded.productId },
    select: { unitCostBase: true, totalValueBase: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  const debit = payloadLines(logs[0]?.payload ?? null).find((l) => typeof l.debit === 'number')
  console.log(`[arm9] goods ${GOODS_UNIT} + LIVE freight ${LIVE_FREIGHT}/${QTY} => expected unit ${expectedUnitCost}; including the cancelled ${CANCELLED_FREIGHT} would give ${wrongUnitCost}; layer=${JSON.stringify(layer)} movement=${JSON.stringify(movement)} debit=${String(debit?.debit)}`)

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

  // AND THE LIVE FREIGHT REALLY IS IN: this is what separates the fix from "ignore linked freight".
  assert.ok(
    expectedUnitCost > GOODS_UNIT,
    'PRECONDITION: the live freight must move the unit cost above the goods cost, or this arm would '
    + 'also pass for a fix that dropped linked freight altogether',
  )
})

/**
 * ARM 10 — A COST EDIT MUST NOT OVERTAKE THE ALIGNMENT.
 *
 * CODEX ROUND-2 HIGH-2. Round 1 read the cost rows with NO lock and cached the answer for the rest of
 * the transaction, so a landed-cost change committing while the allocation loop ran left later
 * allocations on the older cost — and the concurrent recalculation could not revalue layers the
 * alignment had not committed yet, so neither side ended up right. Round 1's own comment claimed the
 * inputs "cannot move — everything is inside the transaction", which confuses isolation from
 * UNCOMMITTED work with exclusion of COMMITTED work.
 *
 * SO THIS MEASURES THE COST-ROW LOCK, the same way arm 8 measures the mapping lock: a `freight_cost_lines`
 * UPDATE is fired from a separate pooled connection while the alignment is mid-flight and is NOT
 * awaited; a third connection then shows the committed amount is still the ORIGINAL one; and the
 * alignment's layer, movement and journal all carry the pre-edit gross cost. The edit must then land
 * once the lock is released — serialised, not rejected.
 *
 * WHY `freight_cost_lines` AND NOT `purchase_order_lines`. Both are locked (steps 2c and 2d), and the
 * freight amount is the input a landed-cost edit actually changes; `purchase_order_lines.landedUnitCostBase`
 * is what recalculation WRITES, and this path no longer reads that column at all.
 *
 * WHAT WOULD STILL PASS THIS ARM: any fix that serialises by a different lock, or one that holds the
 * lock longer than needed. It does NOT establish that two concurrent RECALCULATIONS order themselves —
 * they take no locks of their own, so they are blocked by this one rather than cooperating with it, and
 * that gap is recorded in lib/domain/wms/transfer-asn-lock-order.ts and filed separately.
 */
test('o3d-6nd55 r2: a freight-cost edit mid-alignment is blocked, and the posted cost is the one read', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 4
  const GOODS_UNIT = 10
  const FREIGHT_TOTAL = 20
  const BUMPED_FREIGHT = 200
  const seeded = await seedAlignmentTarget('E', QTY, GOODS_UNIT, FREIGHT_TOTAL)
  await assertUntouchedLandedCost(seeded.poLineId, GOODS_UNIT)

  const costLine = await db.freightCostLine.findFirstOrThrow({
    where: { poId: seeded.poId },
    select: { id: true, amountBase: true },
  })
  assert.equal(
    Number(costLine.amountBase),
    FREIGHT_TOTAL,
    'PRECONDITION: createPurchaseOrder must have written the freight cost line this arm edits',
  )

  const expectedUnitCost = GOODS_UNIT + FREIGHT_TOTAL / QTY
  const expectedAmount = QTY * expectedUnitCost
  const bumpedUnitCost = GOODS_UNIT + BUMPED_FREIGHT / QTY

  type EditOutcome = 'pending' | 'committed' | 'failed'
  let editSettled: EditOutcome = 'pending'
  let editError: string | null = null
  let observedDuringTransaction: number | null = null
  let settledDuringTransaction: EditOutcome = 'pending'
  let editPromise: Promise<unknown> = Promise.resolve()

  afterTransitWriteHook = async () => {
    editPromise = db.freightCostLine
      .update({ where: { id: costLine.id }, data: { amountBase: `${BUMPED_FREIGHT}.0000`, amountForeign: `${BUMPED_FREIGHT}.0000` } })
      .then(() => { editSettled = 'committed' })
      .catch((error: unknown) => { editSettled = 'failed'; editError = String(error).slice(0, 200) })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const row = await db.freightCostLine.findUniqueOrThrow({
      where: { id: costLine.id },
      select: { amountBase: true },
    })
    observedDuringTransaction = Number(row.amountBase)
    settledDuringTransaction = editSettled
  }

  let applied: boolean
  try {
    ;({ applied } = await alignUp(seeded, { delta: QTY, imsQty: 0 }))
    await editPromise.catch(() => {})
  } finally {
    afterTransitWriteHook = null
  }

  const layer = await db.costLayer.findFirstOrThrow({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  const movement = await db.stockMovement.findFirstOrThrow({
    where: { type: 'WMS_RECEIPT_RECONCILIATION', productId: seeded.productId },
    select: { unitCostBase: true, totalValueBase: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  const debit = payloadLines(logs[0]?.payload ?? null).find((l) => typeof l.debit === 'number')
  const afterRelease = await db.freightCostLine.findUniqueOrThrow({
    where: { id: costLine.id },
    select: { amountBase: true },
  })
  console.log(`[arm10] applied=${String(applied)}; mid-transaction: freight=${String(observedDuringTransaction)} edit=${settledDuringTransaction}${editError ? ` (${editError})` : ''}; after release: freight=${String(afterRelease.amountBase)} edit=${editSettled}; layer=${JSON.stringify(layer)} debit=${String(debit?.debit)}`)

  assert.equal(
    observedDuringTransaction,
    FREIGHT_TOTAL,
    'THE POINT OF THIS ARM: while the alignment held the cost-row locks, a freight edit fired '
    + `mid-transaction must not have committed — the committed amount should still have been `
    + `${FREIGHT_TOTAL}, was ${String(observedDuringTransaction)}. A new value here is round 1's `
    + 'unlocked cost read, reopened.',
  )
  assert.equal(
    settledDuringTransaction,
    'pending',
    'and the edit must still have been WAITING at that moment, not already finished',
  )
  // NOT VACUOUS: it must land once the lock releases, or "it did not commit" is true for the wrong reason.
  assert.equal(
    editSettled,
    'committed',
    `the edit must succeed once the alignment released the lock — serialised, not rejected${editError ? `; it failed instead: ${editError}` : ''}`,
  )
  assert.equal(Number(afterRelease.amountBase), BUMPED_FREIGHT, 'and its value must be the one it wrote')

  assert.equal(applied, true, 'serialising must let the alignment through, not refuse it')
  assert.notEqual(expectedUnitCost, bumpedUnitCost, 'PRECONDITION: the two costs must be distinguishable')
  assert.equal(
    Number(layer.unitCostBase),
    expectedUnitCost,
    `the layer must carry the cost that was READ under the lock (${expectedUnitCost}), not the edited `
    + `one (${bumpedUnitCost})`,
  )
  assert.equal(Number(movement.unitCostBase), expectedUnitCost, 'and so must the movement')
  assert.equal(debit?.debit, expectedAmount, 'and so must the journal debit')
  assert.equal(Number(movement.totalValueBase), debit?.debit, 'movement value == journal debit')
  assert.equal(Number(layer.unitCostBase) * Number(layer.receivedQty), debit?.debit, 'layer value == journal debit')
})

/**
 * ARM 11 — EVERY PURCHASE ORDER IN ONE ALIGNMENT POSTS ON ONE MAPPING, AND AT ITS OWN COST.
 *
 * The second half of Codex round-2 HIGH-3: one alignment can absorb its delta into ASN lines of
 * SEVERAL purchase orders, so per-order account reads could straddle a remap and put earlier orders on
 * the old mapping and later ones on the new one inside a single alignment. Two contradictory journals
 * for one correction is not a variance anything reconciles.
 *
 * WHAT THIS ARM PINS, AND — MEASURED, NOT ASSUMED — WHAT IT DOES NOT. It pins that the PRODUCTION
 * writer is serialised and that the two orders keep their OWN costs, which is what the per-order cost
 * cache is for.
 *
 * IT DOES NOT PIN THE MEMOISATION, and the mutation campaign is how that was found rather than
 * argued: the mutation that makes the account read PER-ALLOCATION and removes the reader's lock
 * (`M12-per-allocation-accounts-no-lock`) leaves this arm GREEN. The reason is that
 * `saveXeroSettings` is a COOPERATIVE writer — it takes the accounting-selection advisory lock — and
 * `queueAccountingSyncTx` has always taken that same advisory lock through
 * `pinnedLedgerIsServicedUnderLock` and holds it to commit. So from the FIRST enqueue onwards the
 * real writer is blocked by a lock that predates this change, whatever this path does. Claiming this
 * arm proved the memoisation would have been the proof-of-an-adjacent-property trap exactly.
 *
 * ARM 12 IS THEREFORE THE ONE THAT PINS THE MULTI-ORDER CASE, using an UNCOOPERATIVE writer that the
 * advisory lock cannot stop.
 *
 * The remap goes through the REAL `saveXeroSettings`, and the arm asserts the writer ACCEPTED it and
 * that the new value landed — because o3d-8f0p6 r4 found the equivalent arm passing VACUOUSLY when a
 * missing auth mock turned the remap into a silent failure.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that reads per-order but under a lock (also correct); one
 * that posts nothing at all, which arms 2, 3, 9 and 10 refuse; and — as measured above — a fix with no
 * mapping lock and no memoisation at all, because the enqueue's own advisory lock covers the window
 * this arm can reach.
 */
test('o3d-6nd55 r2: two purchase orders in one alignment post on the same mapping, at their own costs', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const first = await seedAlignmentTarget('P', 3, 5)
  // A SECOND purchase order and a second open ASN for the SAME product in the SAME warehouse, so one
  // alignment plan spans both. Seeded through the same real creation path.
  const second = await seedSecondOrderForSameProduct(first, 2, 8)

  const REMAPPED = '699'
  let remapAccepted: { success: boolean; error?: string } | null = null
  let remapPromise: Promise<unknown> = Promise.resolve()
  afterTransitWriteHook = async () => {
    // THROUGH THE REAL WRITER, not a raw row update: `saveXeroSettings` is the only code that remaps
    // these accounts in production, and it is the other half of the lock order this change adopts.
    // (Arms 8 and 10 use RAW updates deliberately — blocking an UNCOOPERATIVE writer is the stronger
    // claim; this arm exercises the production path at least once.)
    //
    // Fired between the first order's posting and the second's, and NOT awaited: under the lock it
    // cannot commit until the whole alignment does, so awaiting it here would deadlock the very
    // transaction it is waiting for.
    const { saveXeroSettings } = await import('@/app/actions/xero-sync')
    remapPromise = saveXeroSettings({ xero_inventory_account: REMAPPED })
      .then((result) => { remapAccepted = result })
      .catch((error: unknown) => { remapAccepted = { success: false, error: String(error).slice(0, 200) } })
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  let applied: boolean
  let reason: string
  try {
    ;({ applied, reason } = await alignUp(first, { delta: first.qty + second.qty, imsQty: 0 }))
  } finally {
    afterTransitWriteHook = null
    await remapPromise.catch(() => {})
  }
  const mappingNow = await db.setting.findUniqueOrThrow({
    where: { key: 'xero_inventory_account' },
    select: { value: true },
  })
  await db.setting.update({ where: { key: 'xero_inventory_account' }, data: { value: INVENTORY_ACCOUNT } })

  assert.equal(applied, true, `PRECONDITION: the alignment must apply across both orders: ${reason}`)
  const firstLogs = await stockReceiptLogsFor(first.poId)
  const secondLogs = await stockReceiptLogsFor(second.poId)
  const codeOf = (payload: unknown) => payloadLines(payload).find((l) => typeof l.debit === 'number')?.accountCode
  const debitOf = (payload: unknown) => payloadLines(payload).find((l) => typeof l.debit === 'number')?.debit
  console.log(`[arm11] first PO log(s)=${firstLogs.length} code=${String(codeOf(firstLogs[0]?.payload ?? null))} debit=${String(debitOf(firstLogs[0]?.payload ?? null))}; second PO log(s)=${secondLogs.length} code=${String(codeOf(secondLogs[0]?.payload ?? null))} debit=${String(debitOf(secondLogs[0]?.payload ?? null))}; remap=${JSON.stringify(remapAccepted)} mappingNow=${mappingNow.value}`)

  // PRECONDITION, and the lesson of o3d-8f0p6 r4: the writer must really have accepted the remap, or
  // this arm proves nothing about straddling one.
  assert.deepEqual(
    remapAccepted,
    { success: true },
    `PRECONDITION: the REAL saveXeroSettings must accept the remap, or nothing was remapped: ${JSON.stringify(remapAccepted)}`,
  )
  assert.equal(
    mappingNow.value,
    REMAPPED,
    'PRECONDITION: and the remap must actually have LANDED once the alignment released the lock — '
    + 'otherwise "both orders agree" would be true because nothing ever tried to change it',
  )

  assert.equal(firstLogs.length, 1, `the first order must post exactly one journal; found ${firstLogs.length}`)
  assert.equal(secondLogs.length, 1, `and the second exactly one; found ${secondLogs.length}`)
  assert.equal(
    codeOf(firstLogs[0]!.payload),
    codeOf(secondLogs[0]!.payload),
    'both orders in ONE alignment must post to the SAME inventory account — a per-order read that '
    + 'straddled the remap would give two different codes for one correction',
  )
  assert.equal(codeOf(firstLogs[0]!.payload), INVENTORY_ACCOUNT, 'and it must be the code the alignment read under its lock')
  // AND each order keeps its OWN cost — the cache is per order, not one cost for the alignment.
  assert.equal(debitOf(firstLogs[0]!.payload), first.qty * first.unitCost, 'the first order posts its own cost')
  assert.equal(debitOf(secondLogs[0]!.payload), second.qty * second.unitCost, 'the second order posts its own, different, cost')
  assert.notEqual(first.unitCost, second.unitCost, 'PRECONDITION: the two costs must differ, or the last assertion is vacuous')
})

/**
 * ARM 12 — THE MULTI-ORDER AGREEMENT, AGAINST A WRITER THE ADVISORY LOCK CANNOT STOP.
 *
 * WHY THIS EXISTS AND ARM 11 WAS NOT ENOUGH. Arm 11 remaps through the real `saveXeroSettings`, which
 * takes the accounting-selection advisory lock — the same one `queueAccountingSyncTx` has always taken
 * and held to commit. So from the first enqueue onwards arm 11's writer is blocked by a pre-existing
 * lock, and the mutation that removes BOTH this change's mapping lock and its memoisation left arm 11
 * green. That is measured, not supposed: see `M12-per-allocation-accounts-no-lock`.
 *
 * SO THIS ARM USES A RAW `settings` UPDATE, which no advisory lock can block — only the row-level
 * `FOR UPDATE` this change's `lockAccountingMappingSelection` takes over the two mapping rows. The
 * update is fired between the first order's posting and the second's and is NOT awaited. Both orders
 * must still post on the SAME inventory account.
 *
 * WHAT IT ESTABLISHES, EXACTLY: an alignment spanning two purchase orders cannot straddle an
 * uncooperative remap. Remove the lock and the second order reads the new code while the first is
 * already committed to the old one — two contradictory journals for one correction.
 *
 * WHAT WOULD STILL PASS THIS ARM: memoising WITHOUT a lock would also make the two agree — both orders
 * would use the first (stale) read — so this arm alone does not distinguish "one locked read" from
 * "one unlocked read". Arm 8 is what refuses the unlocked version, by asserting the writer could not
 * commit at all. The two together are what the pair of mechanisms needs.
 */
test('o3d-6nd55 r2: two orders in one alignment agree even against an uncooperative remap', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const first = await seedAlignmentTarget('U', 3, 5)
  const second = await seedSecondOrderForSameProduct(first, 2, 8)
  const REMAPPED = '699'

  let rawSettled: 'pending' | 'committed' | 'failed' = 'pending'
  let rawPromise: Promise<unknown> = Promise.resolve()
  afterTransitWriteHook = async () => {
    // A RAW row update — no advisory lock, so only this change's FOR UPDATE on the mapping rows can
    // stop it. Not awaited: under that lock it cannot commit until the alignment does.
    rawPromise = db.setting
      .update({ where: { key: 'xero_inventory_account' }, data: { value: REMAPPED } })
      .then(() => { rawSettled = 'committed' })
      .catch(() => { rawSettled = 'failed' })
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  let applied: boolean
  let reason: string
  try {
    ;({ applied, reason } = await alignUp(first, { delta: first.qty + second.qty, imsQty: 0 }))
  } finally {
    afterTransitWriteHook = null
    await rawPromise.catch(() => {})
  }
  const mappingNow = await db.setting.findUniqueOrThrow({
    where: { key: 'xero_inventory_account' },
    select: { value: true },
  })
  await db.setting.update({ where: { key: 'xero_inventory_account' }, data: { value: INVENTORY_ACCOUNT } })

  const firstLogs = await stockReceiptLogsFor(first.poId)
  const secondLogs = await stockReceiptLogsFor(second.poId)
  const codeOf = (payload: unknown) => payloadLines(payload).find((l) => typeof l.debit === 'number')?.accountCode
  console.log(`[arm12] applied=${String(applied)}; raw remap=${rawSettled}; mappingNow=${mappingNow.value}; first code=${String(codeOf(firstLogs[0]?.payload ?? null))} second code=${String(codeOf(secondLogs[0]?.payload ?? null))}`)

  assert.equal(applied, true, `PRECONDITION: the alignment must apply across both orders: ${reason}`)
  assert.equal(firstLogs.length, 1, `PRECONDITION: the first order must have posted; found ${firstLogs.length}`)
  assert.equal(secondLogs.length, 1, `PRECONDITION: the second must have posted too, or there is nothing to compare; found ${secondLogs.length}`)
  // NOT VACUOUS: the remap must really have landed in the end, or "they agree" is true because nothing
  // ever tried to change the mapping.
  assert.equal(rawSettled, 'committed', 'PRECONDITION: the remap must land once the lock releases — serialised, not rejected')
  assert.equal(mappingNow.value, REMAPPED, 'PRECONDITION: and its value must be the one it wrote')

  assert.equal(
    codeOf(firstLogs[0]!.payload),
    codeOf(secondLogs[0]!.payload),
    'both orders in ONE alignment must post to the SAME inventory account; different codes here are one '
    + 'correction split across two mappings, which nothing reconciles',
  )
  assert.equal(
    codeOf(firstLogs[0]!.payload),
    INVENTORY_ACCOUNT,
    'and it must be the code that was current when the alignment took its lock, not the remapped one',
  )
})

/**
 * ARM 13 — A FREIGHT-COST EDIT AND A PO-BACKED ALIGNMENT MUST NOT DEADLOCK (r3, Codex round-3 HIGH).
 *
 * THE DEFECT. Round 2 gave alignment `purchase_orders` → `purchase_order_lines` →
 * `freight_cost_lines`, taking that sub-order from the two invoicing transactions that already used
 * it. Round 3 found `updateFreightPoCosts` doing the REVERSE: it deleted the freight order's cost
 * lines and only then updated the freight order itself. Hold a cost line while alignment holds the
 * parent and each waits for the other; PostgreSQL aborts one transaction, failing either the
 * operator's edit or that SKU's alignment. Two more writers had the same signature — the supplier
 * return and the fx rebase — and all three now take `lockPurchaseOrdersWithCostRows` first. The census
 * of every writer of those three tables is in lib/domain/wms/transfer-asn-lock-order.ts, because the
 * lesson is that a lock order is a property of EVERY participant and two examples were not enough.
 *
 * WHY THIS IS DETERMINISTIC AND NOT A RACE THAT USUALLY PASSES. The alignment is parked, by the
 * barrier above, at the one instant where it holds the parent and not the cost rows. The edit is then
 * started and given time to reach whichever lock it reaches first. Only then is the barrier released.
 * Under the OLD order that is a guaranteed cycle, not a likely one; under the new order the edit is
 * simply queued behind the parent and the whole thing serialises.
 *
 * WHAT IS ASSERTED: both operations SUCCEED, neither raises SQLSTATE 40P01 (`deadlock detected`), and
 * the edit's new freight amount really landed — so "no deadlock" cannot be satisfied by an edit that
 * quietly did nothing.
 *
 * WHAT WOULD STILL PASS THIS ARM: any ordering in which the two never contend at all — which is why
 * the arm asserts the edit's value landed AND that the alignment posted, so both really ran against
 * the same freight order. It does not establish anything about the supplier-return or fx-rebase
 * writers; those are covered by the census and, for the fx rebase, by the acquisition-order assertion
 * in tests/domain/purchasing/purchase-order-fx.test.ts.
 */
test('o3d-6nd55 r3: a freight-cost edit interleaved with a PO-backed alignment does not deadlock', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
  await enableStockReceiptPosting()

  const QTY = 4
  const GOODS_UNIT = 10
  const FREIGHT_TOTAL = 20
  const EDITED_FREIGHT = 44
  const seeded = await seedAlignmentTarget('D', QTY, GOODS_UNIT)
  // A LINKED freight order, so the alignment locks it as one of its parents and the edit targets it.
  const freight = await seedLinkedFreightPo(seeded, 'live', FREIGHT_TOTAL, 'PO_SENT', true)
  await db.purchaseOrder.update({ where: { id: freight.poId }, data: { type: 'FREIGHT' } })

  let barrierReleased: () => void = () => {}
  const barrier = new Promise<void>((resolve) => { barrierReleased = resolve })
  let alignmentParked: () => void = () => {}
  const parked = new Promise<void>((resolve) => { alignmentParked = resolve })

  pauseAfterParentLock = async () => {
    alignmentParked()
    await barrier
  }

  let alignError: unknown = null
  let alignApplied: boolean | null = null
  const aligning = alignUp(seeded, { delta: QTY, imsQty: 0 }).then(
    (result) => { alignApplied = result.applied },
    (error) => { alignError = error },
  )

  // The alignment now holds the freight order's PARENT row and none of its cost rows.
  await parked

  let editResult: { success: boolean; error?: string } | null = null as { success: boolean; error?: string } | null
  let editError: unknown = null
  const editing = updateFreightPoCosts(freight.poId, [{
    description: 'edited freight',
    amountForeign: EDITED_FREIGHT,
    vatable: false,
    distributionMethod: 'BY_VALUE',
  }]).then(
    (result) => { editResult = result },
    (error) => { editError = error },
  )

  // Long enough for the edit to reach its first lock — the parent under the fix, the cost-line delete
  // without it. Under the old order the cycle exists from here on.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  barrierReleased()

  await aligning
  await editing
  pauseAfterParentLock = null

  const messages = [alignError, editError, editResult?.error]
    .map((value) => (value instanceof Error ? value.message : String(value ?? '')))
    .join(' | ')
  console.log(`[arm13] alignApplied=${String(alignApplied)} editResult=${JSON.stringify(editResult)} errors=${messages.slice(0, 400)}`)

  assert.ok(
    !/deadlock detected|40P01/i.test(messages),
    `neither side may deadlock — PostgreSQL aborting one of them loses either the operator's freight `
    + `edit or this SKU's alignment. Errors were: ${messages}`,
  )
  assert.equal(alignError, null, `the alignment must not fail: ${messages}`)
  assert.equal(alignApplied, true, 'and it must actually have applied, or it contended over nothing')
  assert.equal(editError, null, `the freight edit must not fail: ${messages}`)
  assert.equal(editResult?.success, true, `the freight edit must succeed: ${JSON.stringify(editResult)}`)

  // NOT VACUOUS: the edit's value must really have landed, so "no deadlock" cannot be satisfied by an
  // edit that did nothing, and both sides must really have touched this freight order.
  const costLines = await db.freightCostLine.findMany({
    where: { poId: freight.poId },
    select: { amountForeign: true, amountBase: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm13] freight cost line(s) after the edit: ${JSON.stringify(costLines)}; alignment journals: ${logs.length}`)
  assert.equal(costLines.length, 1, `the edit must have replaced the cost line; found ${costLines.length}`)
  assert.equal(
    Number(costLines[0]!.amountForeign),
    EDITED_FREIGHT,
    'and its new amount must be committed — otherwise the edit was a no-op and contended over nothing',
  )
  assert.equal(logs.length, 1, 'and the alignment must have posted its receipt journal')
})

/**
 * ARM 14 — A SUPPLIER RETURN AND A RECEIPT OF THE SAME PURCHASE ORDER MUST NOT DEADLOCK
 * (r5, Codex round-4 HIGH).
 *
 * THE DEFECT, AND IT IS THE CENSUS'S OWN FIX ONE RESOURCE OVER. Round 3 put the parent lock into
 * `createPurchaseReturn` to close a child/parent inversion — and put it BELOW the return's stock-level
 * locks, so the return then held a stock row and wanted the parent while `receiveStock` held the parent
 * and wanted that stock row. Round 3's census had framed the question as "who touches the three PO
 * tables", and `stock_levels` was outside the frame.
 *
 * OLDER THAN THIS BRANCH, WHICH IS WHY THE SHAPE MATTERS MORE THAN THE BLAME: the return's closing
 * parent UPDATE always gave it the stock→parent order. Round 3 made the acquisition explicit and
 * earlier, widening the window rather than opening it. It is still this branch's to fix, because this
 * branch is what makes the opposite order load-bearing — alignment holds the parent precisely so it can
 * trust the cost rows it reads.
 *
 * THE FIX IS THE PARENT ONLY, above the first stock lock. Not the combined cost-row helper: this path
 * touches no freight cost lines, and taking `purchase_order_lines` up there would break the audit-18s1
 * agreement that the return and the receipt take {stock_levels, purchase_order_lines} in the SAME
 * order. The gate is the parent; the line locks stay where audit-18s1 put them.
 *
 * WHY THIS IS DETERMINISTIC. The receipt is parked, by the barrier above, holding the parent and not yet
 * the stock row. The return is then started and given time to reach its first lock. Under the pre-r5
 * order that is a guaranteed cycle; with the parent taken first the return simply queues on the parent
 * and the two serialise.
 *
 * WHAT IS ASSERTED: both operations succeed, neither raises SQLSTATE 40P01, and BOTH effects landed —
 * the received quantity rose AND the returned quantity rose — so "no deadlock" cannot be satisfied by
 * an operation that quietly did nothing.
 *
 * WHAT WOULD STILL PASS THIS ARM: it says nothing about the {cost_layers, stock_levels} pair, where
 * `receiveStock` takes layers before stock and the return takes them the other way round. That one is
 * reachable only ACROSS purchase orders sharing a product, predates this branch on both sides, and
 * closing it means reordering `receiveStock` — recorded in the census and filed as o3d-chs1h rather
 * than folded in.
 */
test('o3d-6nd55 r5: a supplier return interleaved with a receipt of the same PO does not deadlock', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { receivePurchaseOrder, returnPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const seeded = await seedAlignmentTarget('R5', 10, 5)

  // Something to return: a first receipt, run to completion with no barrier.
  const firstReceipt = await receivePurchaseOrder(seeded.poId, [
    { poLineId: seeded.poLineId, qtyReceived: 6, warehouseId: seeded.warehouseId },
  ])
  assert.equal(firstReceipt.success, true, `PRECONDITION: the seeding receipt must succeed: ${firstReceipt.error}`)
  const beforeLine = await db.purchaseOrderLine.findUniqueOrThrow({
    where: { id: seeded.poLineId },
    select: { qtyReceived: true, qtyReturned: true },
  })
  assert.equal(Number(beforeLine.qtyReceived), 6, 'PRECONDITION: 6 units must be on the line to return from')

  let barrierReleased: () => void = () => {}
  const barrier = new Promise<void>((resolve) => { barrierReleased = resolve })
  let receiptParked: () => void = () => {}
  const parked = new Promise<void>((resolve) => { receiptParked = resolve })

  pauseAfterReceiptCostLayer = async () => {
    receiptParked()
    await barrier
  }

  // The receipt holds the PARENT and has not yet touched the stock row.
  let receiptResult: { success: boolean; error?: string } | null = null as { success: boolean; error?: string } | null
  let receiptError: unknown = null
  const receiving = receivePurchaseOrder(seeded.poId, [
    { poLineId: seeded.poLineId, qtyReceived: 2, warehouseId: seeded.warehouseId },
  ]).then(
    (result) => { receiptResult = result },
    (error) => { receiptError = error },
  )
  await parked

  let returnResult: { success: boolean; error?: string } | null = null as { success: boolean; error?: string } | null
  let returnError: unknown = null
  const returning = returnPurchaseOrder(
    seeded.poId,
    [{ poLineId: seeded.poLineId, qtyReturned: 3, warehouseId: seeded.warehouseId }],
    'damaged in transit',
  ).then(
    (result) => { returnResult = result },
    (error) => { returnError = error },
  )

  // Long enough for the return to reach its first lock — the parent under the fix, a stock row without
  // it. Under the pre-r5 order the cycle exists from here on.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  barrierReleased()

  await receiving
  await returning
  pauseAfterReceiptCostLayer = null

  const messages = [receiptError, returnError, receiptResult?.error, returnResult?.error]
    .map((value) => (value instanceof Error ? value.message : String(value ?? '')))
    .join(' | ')
  console.log(`[arm14] receipt=${JSON.stringify(receiptResult)} return=${JSON.stringify(returnResult)} errors=${messages.slice(0, 400)}`)

  assert.ok(
    !/deadlock detected|40P01/i.test(messages),
    'neither side may deadlock — PostgreSQL aborting one of them loses either the operator\'s return or '
    + `their receipt. Errors were: ${messages}`,
  )
  assert.equal(receiptError, null, `the receipt must not throw: ${messages}`)
  assert.equal(returnError, null, `the return must not throw: ${messages}`)
  assert.equal(receiptResult?.success, true, `the receipt must succeed: ${JSON.stringify(receiptResult)}`)
  assert.equal(returnResult?.success, true, `the return must succeed: ${JSON.stringify(returnResult)}`)

  // NOT VACUOUS: both effects must be committed, or "no deadlock" is true of a pair that did nothing.
  const afterLine = await db.purchaseOrderLine.findUniqueOrThrow({
    where: { id: seeded.poLineId },
    select: { qtyReceived: true, qtyReturned: true },
  })
  console.log(`[arm14] line after: qtyReceived=${String(afterLine.qtyReceived)} qtyReturned=${String(afterLine.qtyReturned)}`)
  assert.equal(Number(afterLine.qtyReceived), 8, 'the second receipt must have landed its 2 units (6 + 2)')
  assert.equal(Number(afterLine.qtyReturned), 3, 'and the return its 3')
})

/**
 * ARM 15 — A FREIGHT ORDER LINKED AFTER DISCOVERY MUST NOT VALUE THE RECEIPT (r6, Codex round-6 HIGH).
 *
 * THE HOLE. Alignment discovers the linked freight orders BEFORE it takes any lock, and locks that set.
 * The re-read under the locks then checked only the PRIMARY order and the ASN rows against what was
 * locked — so a freight order linked in the window between discovery and the parent lock contributed its
 * cost lines to the valuation while neither its parent row nor its cost rows were held. An fx rebase of
 * that freight order could then commit while the alignment posted, leaving the cost layer and the
 * STOCK_RECEIPT journal at a cost that had already changed. Same family as rounds 3-5, one resource
 * further out.
 *
 * THE FIX IS THE REFUSAL THAT ALREADY EXISTED, APPLIED TO THE FREIGHT SET. The re-read now compares every
 * contributing freight order against the locked set and refuses the candidate as `raced` if any is
 * missing, which the terminal guard turns into a one-sweep deferral. Refusal rather than lock-on-demand:
 * acquiring a parent discovered at that point takes a lock after others are held, which is the inversion
 * rounds 3-5 were about.
 *
 * WHAT THIS ARM DOES. It parks the alignment in that exact window, commits a freight order + cost line +
 * link from another connection, releases, and asserts the alignment REFUSED and wrote nothing. Then it
 * runs a SECOND sweep, which discovers the freight order up front, locks it, applies — and values the
 * layer INCLUDING that freight. So the arm pins both halves: the unlocked valuation does not happen, and
 * the deferral is a deferral rather than a permanent block.
 *
 * WHAT WOULD STILL PASS THIS ARM: a fix that refuses ALL alignments (the second sweep is what refuses
 * that), and a fix that refuses for some reason other than the freight set — which is why the refusal
 * reason is asserted to name the freight order. It says nothing about a link committed AFTER the lock;
 * arm 16 is what establishes that cannot happen.
 */
test('o3d-6nd55 r6: a freight order linked after discovery refuses the alignment, and the next sweep applies', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 4
  const GOODS_UNIT = 10
  const LATE_FREIGHT = 20
  const seeded = await seedAlignmentTarget('L6', QTY, GOODS_UNIT)
  await assertUntouchedLandedCost(seeded.poLineId, GOODS_UNIT)

  // PRECONDITION: nothing is linked when discovery runs.
  assert.equal(
    await db.landedCostLink.count({ where: { primaryPoId: seeded.poId } }),
    0,
    'PRECONDITION: the order must start with no freight link, or the window is not the one under test',
  )

  let linkCommitted = false
  pauseBeforeFirstLock = async () => {
    // Committed from the POOL, so it is visible to the alignment's later reads and is genuinely not
    // covered by any lock the alignment holds — it holds none yet.
    await seedLinkedFreightPo(seeded, 'late', LATE_FREIGHT, 'PO_SENT', false)
    linkCommitted = true
  }

  let firstApplied: boolean | null = null
  let firstReason = ''
  let firstError: unknown = null
  try {
    const result = await alignUp(seeded, { delta: QTY, imsQty: 0 })
    firstApplied = result.applied
    firstReason = result.reason
  } catch (error) {
    firstError = error
  } finally {
    pauseBeforeFirstLock = null
  }

  const movementsAfterFirst = await db.stockMovement.count({ where: { productId: seeded.productId } })
  const layersAfterFirst = await db.costLayer.count({ where: { poLineId: seeded.poLineId } })
  const logsAfterFirst = await stockReceiptLogsFor(seeded.poId)
  const levelAfterFirst = await db.stockLevel.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
    select: { quantity: true },
  })
  const asnAfterFirst = await db.wmsAsnLineMap.findUniqueOrThrow({
    where: { id: seeded.asnLineMapId },
    select: { qtyAccountedViaSnapshot: true },
  })
  console.log(`[arm15] linkCommitted=${String(linkCommitted)} firstApplied=${String(firstApplied)} reason=${firstReason.slice(0, 220)} error=${String(firstError).slice(0, 160)}`)
  console.log(`[arm15] after the refusal: ${movementsAfterFirst} movement(s), ${layersAfterFirst} layer(s), ${logsAfterFirst.length} log(s), stock=${String(levelAfterFirst.quantity)}, snapshotQty=${String(asnAfterFirst.qtyAccountedViaSnapshot)}`)

  assert.equal(linkCommitted, true, 'PRECONDITION: the freight link must have been committed inside the window')
  assert.equal(firstError, null, `the alignment must refuse cleanly, not throw: ${String(firstError)}`)
  assert.equal(
    firstApplied,
    false,
    'the alignment must REFUSE: a freight order contributing to the cost was linked after the locks were '
    + 'taken, so nothing here holds it or its cost rows',
  )
  assert.match(
    firstReason,
    /freight order contributing to its cost/i,
    `and the reason must name the freight order, or this refusal is indistinguishable from any other: ${firstReason}`,
  )
  assert.equal(movementsAfterFirst, 0, 'no movement may be written')
  assert.equal(layersAfterFirst, 0, 'and no cost layer — that is the unlocked valuation this closes')
  assert.equal(logsAfterFirst.length, 0, 'and no receipt journal')
  assert.equal(Number(levelAfterFirst.quantity), 0, 'and no stock')
  assert.equal(Number(asnAfterFirst.qtyAccountedViaSnapshot), 0, 'and the ASN line must not claim to have absorbed anything')

  // ─── THE SECOND SWEEP: the deferral is a deferral, and the eventual cost includes the freight ───
  const expectedUnitCost = GOODS_UNIT + LATE_FREIGHT / QTY
  const second = await alignUp(seeded, { delta: QTY, imsQty: 0 })
  assert.equal(second.applied, true, `the next sweep must apply — one sweep of deferral, not a block: ${second.reason}`)
  const layer = await db.costLayer.findFirstOrThrow({
    where: { poLineId: seeded.poLineId },
    select: { receivedQty: true, unitCostBase: true },
  })
  const logs = await stockReceiptLogsFor(seeded.poId)
  console.log(`[arm15] second sweep: layer=${JSON.stringify(layer)} expectedUnit=${expectedUnitCost} logs=${logs.length}`)
  assert.equal(
    Number(layer.unitCostBase),
    expectedUnitCost,
    `and it must value the layer INCLUDING the freight that was linked (${expectedUnitCost}), now that it `
    + 'holds that order and its cost rows',
  )
  assert.equal(logs.length, 1, 'and post exactly one journal')
  assert.equal(debitOf(logs[0]!.payload), QTY * expectedUnitCost, 'for the gross value')
})

/**
 * ARM 16 — A FREIGHT LINK CANNOT BE COMMITTED WHILE AN ALIGNMENT HOLDS THE PRIMARY.
 *
 * WHY THIS ARM EXISTS. Arm 15 closes the window BEFORE the lock. The claim that there is no window AFTER
 * it rests on a fact about PostgreSQL: inserting a `landed_cost_links` row requires a `FOR KEY SHARE`
 * lock on the referenced primary order, and `FOR UPDATE` — which the alignment holds — conflicts with it.
 * `createFreightPo` takes no explicit lock on the primary at all, so if that conflict did not exist a new
 * contributor could appear between the re-read and the cost read and the coverage argument would be
 * false.
 *
 * READING IT OFF THE MANUAL IS NOT MEASURING IT, so this measures it: a link insert is fired from a
 * separate pooled connection while the alignment holds everything, and is NOT awaited. A third read then
 * shows it has not committed. It must then land once the alignment commits — serialised, not rejected,
 * so "it did not commit" cannot be true for some unrelated reason.
 *
 * WHAT WOULD STILL PASS THIS ARM: any mechanism that blocks the insert, including a lock the alignment
 * takes for a different reason. It establishes that the window is closed, not which statement closes it.
 */
test('o3d-6nd55 r6: a freight link cannot be committed while an alignment holds the primary', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const seeded = await seedAlignmentTarget('K6', 2, 7)

  let insertSettled: 'pending' | 'committed' | 'failed' = 'pending'
  let insertError: string | null = null
  let observedCountDuringTransaction: number | null = null
  let settledDuringTransaction: 'pending' | 'committed' | 'failed' = 'pending'
  let insertPromise: Promise<unknown> = Promise.resolve()

  afterTransitWriteHook = async () => {
    // A freight order can be created freely — it references nothing the alignment holds. The LINK is the
    // row that needs a key-share lock on the primary.
    const freightPo = await db.purchaseOrder.create({
      data: {
        reference: uniqueTag('FRK6'),
        supplierId: (await db.supplier.create({ data: { name: uniqueTag('SK6'), currency: 'GBP' }, select: { id: true } })).id,
        status: 'PO_SENT',
        type: 'FREIGHT',
        currency: 'GBP',
        fxRateToBase: '1',
        subtotalForeign: 9,
        subtotalBase: 9,
        totalForeign: 9,
        totalBase: 9,
      },
      select: { id: true },
    })
    insertPromise = db.landedCostLink
      .create({ data: { primaryPoId: seeded.poId, freightPoId: freightPo.id, method: 'BY_VALUE', allocated: false } })
      .then(() => { insertSettled = 'committed' })
      .catch((error: unknown) => { insertSettled = 'failed'; insertError = String(error).slice(0, 200) })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    observedCountDuringTransaction = await db.landedCostLink.count({ where: { primaryPoId: seeded.poId } })
    settledDuringTransaction = insertSettled
  }

  let applied: boolean
  try {
    ;({ applied } = await alignUp(seeded, { delta: seeded.qty, imsQty: 0 }))
    await insertPromise.catch(() => {})
  } finally {
    afterTransitWriteHook = null
  }
  const afterRelease = await db.landedCostLink.count({ where: { primaryPoId: seeded.poId } })
  console.log(`[arm16] applied=${String(applied)}; mid-transaction: links=${String(observedCountDuringTransaction)} insert=${settledDuringTransaction}${insertError ? ` (${insertError})` : ''}; after release: links=${afterRelease} insert=${insertSettled}`)

  assert.equal(
    observedCountDuringTransaction,
    0,
    'THE POINT OF THIS ARM: while the alignment held the primary order FOR UPDATE, a new freight LINK must '
    + `not have committed — the link count should still have been 0, was ${String(observedCountDuringTransaction)}. `
    + 'A committed link here means a contributor can appear after the locked re-read and the coverage '
    + 'argument in transfer-asn-lock-order.ts is false.',
  )
  assert.equal(settledDuringTransaction, 'pending', 'and the insert must still have been WAITING at that moment')
  // NOT VACUOUS: it must land once the lock releases, or "it did not commit" is true for the wrong reason.
  assert.equal(
    insertSettled,
    'committed',
    `the link must commit once the alignment released the primary — serialised, not rejected${insertError ? `; it failed instead: ${insertError}` : ''}`,
  )
  assert.equal(afterRelease, 1, 'and the link must exist afterwards')
  assert.equal(applied, true, 'and the alignment itself must have succeeded')
})

/**
 * ARM 14 — THE LANDED-COST ZERO FLOOR AT THE WMS ALIGN-UP (o3d-gj68).
 *
 * Align-up is the third writer of a PO-derived cost layer and reaches the ONE allocation through
 * `computeLandedCostForPendingLines`. A credit cost line larger than a line's goods cost must lay a ZERO
 * layer and a zero-value movement, queue NO STOCK_RECEIPT, and write ONE durable WARNING after the commit.
 * The credit is written DIRECTLY on the goods PO (`createPurchaseOrder` filters credits out).
 */
test('o3d-gj68: a credit larger than the goods cost lays a ZERO layer at the WMS align-up and warns once', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  await enableStockReceiptPosting()
  const QTY = 2
  const GOODS_UNIT = 5
  const seeded = await seedAlignmentTarget('LF', QTY, GOODS_UNIT)
  await db.freightCostLine.create({
    data: { poId: seeded.poId, description: 'direct credit', amountForeign: '-13.0000', amountBase: '-13.0000', vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 },
  })
  // 5 + (-13 / 2) = -1.5 per unit: floored to 0, so 1.5 x 2 = 3.00 could not be absorbed.

  const result = await alignUp(seeded, { delta: QTY, imsQty: 0 })
  assert.equal(result.applied, true, `PRECONDITION: the alignment must apply (a negative layer would have thrown): ${result.reason}`)

  const layer = await db.costLayer.findFirstOrThrow({ where: { poLineId: seeded.poLineId }, select: { unitCostBase: true } })
  const movement = await db.stockMovement.findFirstOrThrow({ where: { type: 'WMS_RECEIPT_RECONCILIATION', productId: seeded.productId }, select: { unitCostBase: true, totalValueBase: true } })
  const logs = await stockReceiptLogsFor(seeded.poId)
  const activity = await db.activityLog.findMany({ where: { entityType: 'PURCHASE_ORDER', entityId: seeded.poId, action: 'landed_cost_credit_floored' }, select: { level: true, description: true } })
  console.log(`[arm14] unfloored unit cost would be ${GOODS_UNIT + -13 / QTY}; layer=${layer.unitCostBase}, movement=${movement.unitCostBase}/${movement.totalValueBase}, STOCK_RECEIPT rows=${logs.length}, floor activity=${activity.length}`)
  assert.equal(layer.unitCostBase.toString(), '0')
  assert.equal(Number(movement.totalValueBase), 0)
  assert.equal(logs.length, 0, 'nothing of value entered stock, so no STOCK_RECEIPT is queued')
  assert.equal(activity.length, 1, 'exactly one durable WARNING')
  assert.match(activity[0]!.description, /Mintsoft alignment/)
  assert.match(activity[0]!.description, /could not absorb 3\.00 of it into stock/)
})
