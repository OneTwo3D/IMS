import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import { Client } from 'pg'

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * o3d-gles — A PURCHASE-ORDER-BACKED WMS BOOK-IN MUST CARRY THE EVIDENCE THE
 * REPORTING GUARD ASKS FOR, AND THE GUARD MUST STILL REFUSE EVERYTHING ELSE.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT. `processBookedInEvent` wrote its PURCHASE_RECEIPT stock movement with
 * `referenceType: 'WmsAsnMap'` / `referenceId` = the ASN map id. The deferred
 * constraint trigger `stock_movements_reporting_evidence_guard` accepts a
 * PURCHASE_RECEIPT only when the movement names the PURCHASE ORDER that vouches for
 * the units — that is the id it joins through `cost_layers.poLineId` ->
 * `purchase_order_lines.poId`. So EVERY purchase-backed book-in with units to credit
 * died at COMMIT with SQLSTATE 23514 and no stock moved. Pre-existing since 259e702f
 * (PR #581); masked until o3d-btiw, because the unread live ASN-item quantity made
 * `stockQtyToAdd` always 0 and the insert was never reached.
 *
 * WHY THIS FILE NEEDS A REAL PostgreSQL, not a fake transaction. The guard is
 * DEFERRABLE INITIALLY DEFERRED: the INSERT succeeds and the refusal arrives at
 * COMMIT. A test double with no commit semantics would show the insert succeeding
 * and call that a pass — the exact "fixture masking" shape this codebase keeps
 * producing. Every arm below therefore COMMITS (or fails trying), and the success
 * arm reads its evidence back on a SEPARATE connection after the commit.
 *
 * WHAT MAKES THE REFUSAL ARMS NON-VACUOUS. `assertGuardIsInstalledAndDeferred`
 * reads pg_catalog and asserts the trigger exists, is ENABLED for ordinary writes,
 * and is deferrable+initially-deferred. If a change ever drops or disables the
 * guard, those arms would otherwise pass by refusing nothing; they now fail first,
 * at the precondition, naming what they found.
 *
 * WHAT MAKES THE SUCCESS ARM NON-VACUOUS. It does not merely assert "no error".
 * It re-runs the guard's OWN evidence subquery against the committed rows and
 * asserts it finds a matching cost layer, so a future change that made the guard
 * accept anything would not make this arm pass for the wrong reason — the
 * "guard accepts everything" mutation still turns arm 3 and 4 and 5 red.
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

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
  return process.env.DATABASE_URL
}

const UNIT_COST = 7
const GUARD_TRIGGER = 'stock_movements_reporting_evidence_guard'
const GUARD_SQLSTATE = '23514'

function uniqueTag(label: string): string {
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  return `GLES${label}${process.pid}${uid}`.replace(/[^A-Z0-9]/g, '').slice(0, 28)
}

/**
 * PRECONDITION, NOT DECORATION. Read from pg_catalog so the numbers are the
 * server's, not this test's: `tgenabled = 'O'` is "fires for ordinary origin
 * writes"; `tgdeferrable`/`tginitdeferred` are what make the refusal land at COMMIT.
 * Every arm calls this, and it prints what it found.
 */
async function assertGuardIsInstalledAndDeferred(client: Client, arm: string) {
  const { rows } = await client.query<{
    tgname: string
    tgenabled: string
    tgdeferrable: boolean
    tginitdeferred: boolean
    relname: string
  }>(
    `SELECT t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred, c.relname
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) t.tgrelid
      WHERE t.tgname OPERATOR(pg_catalog.=) $1`,
    [GUARD_TRIGGER],
  )
  console.log(`[${arm}] guard precondition: examined ${rows.length} pg_trigger row(s) named ${GUARD_TRIGGER}: ${JSON.stringify(rows)}`)
  assert.equal(rows.length, 1, `exactly one ${GUARD_TRIGGER} trigger must exist — found ${rows.length}. A refusal arm proves nothing without it.`)
  const row = rows[0]!
  assert.equal(row.relname, 'stock_movements')
  assert.equal(row.tgenabled, 'O', `${GUARD_TRIGGER} must be ENABLED for ordinary writes, found tgenabled=${row.tgenabled}`)
  assert.equal(row.tgdeferrable, true, `${GUARD_TRIGGER} must be DEFERRABLE, or the failure would not arrive at COMMIT`)
  assert.equal(row.tginitdeferred, true, `${GUARD_TRIGGER} must be INITIALLY DEFERRED`)
}

/** The guard's OWN evidence subquery, run as a read so the success arm can prove the evidence exists. */
async function countGuardEvidenceForMovement(client: Client, movementId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM "stock_movements" sm
       JOIN "cost_layers" cl
         ON cl."productId" = sm."productId"
        AND cl."warehouseId" = sm."toWarehouseId"
        AND ABS(cl."receivedQty" - sm.qty) <= 0.0001
      WHERE sm.id = $1
        AND sm.type = 'PURCHASE_RECEIPT'
        AND sm."referenceType" = 'PurchaseOrder'
        AND sm."referenceId" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "purchase_order_lines" pol
           WHERE pol.id = cl."poLineId"
             AND pol."poId" = sm."referenceId"
        )`,
    [movementId],
  )
  return Number(rows[0]!.n)
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

/** A PO + line + an OPEN purchase-backed ASN with nothing received locally yet. */
async function seedPurchaseBackedAsn(label: string, qty: number): Promise<SeededPurchaseAsn> {
  const { db } = await import('@/lib/db')
  const tag = uniqueTag(label)
  const total = qty * UNIT_COST
  const product = await db.product.create({
    data: { sku: tag, name: `o3d-gles ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const warehouse = await db.warehouse.create({
    // The TAIL of the tag, not the head: the head is the label and two arms in this file
    // seed two worlds whose labels share their first ten characters (BORROWA/BORROWB), which
    // collided on the unique warehouse code and failed the arm before it reached the guard.
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
          // Explicit: every receipt path reads `landedUnitCostBase ?? unitCostBase` and the
          // column defaults to 0 rather than NULL, so an unset value makes every layer a £0 one.
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
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-gles: a test fixture row, not a core flow branch
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
    productId: product.id,
    warehouseId: warehouse.id,
    poId: po.id,
    poLineId: po.lines[0]!.id,
    asnMapId: asn.id,
    asnLineMapId: asn.lines[0]!.id,
    externalAsnLineId: asn.lines[0]!.externalAsnLineId,
  }
}

/** The real webhook book-in, for the whole expected quantity. */
async function runBookedIn(seeded: SeededPurchaseAsn) {
  const { db } = await import('@/lib/db')
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const event = await db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-gles: a test fixture row, not a core flow branch
      externalEventId: `${seeded.tag}-evt-${Math.random().toString(36).slice(2, 8)}`,
      externalAsnId: seeded.tag,
      payload: { asnId: seeded.tag },
    },
    select: { id: true },
  })
  return processBookedInEvent(event.id, {
    fetchRemoteAsn: async () => ({
      externalAsnId: seeded.tag,
      status: 'RECEIVED',
      lines: [{
        externalLineId: seeded.externalAsnLineId,
        sourceLineId: seeded.poLineId,
        externalProductId: null,
        sku: seeded.tag,
        quantity: seeded.qty,
        raw: null,
      }],
      raw: null,
    }),
  })
}

/**
 * Hand-write a movement (plus optional cost layer / COGS entry) on a raw connection and
 * try to COMMIT it. Returns where the failure landed, so an arm can prove the refusal came
 * from COMMIT rather than from the INSERT — i.e. that the DEFERRED guard is what refused.
 */
async function commitFabricatedMovement(
  client: Client,
  spec: {
    type: 'PURCHASE_RECEIPT' | 'PURCHASE_REVERSAL'
    productId: string
    toWarehouseId?: string | null
    fromWarehouseId?: string | null
    qty: number
    referenceType: string
    referenceId: string
    costLayer?: { poLineId: string | null; receivedQty: number }
    cogsEntry?: { costLayerId: string }
  },
): Promise<{ insertSucceeded: boolean; committed: boolean; failedAt: 'insert' | 'commit' | null; code?: string; message?: string; severity?: string; where?: string }> {
  const movementId = `GLESM${Math.random().toString(36).slice(2, 14)}`
  let insertSucceeded = false
  await client.query('BEGIN')
  try {
    await client.query(
      `INSERT INTO "stock_movements"
         (id, type, "productId", "toWarehouseId", "fromWarehouseId", qty, note, "referenceType", "referenceId", "unitCostBase", "totalValueBase", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'o3d-gles fabricated', $7, $8, $9, $10, now())`,
      [
        movementId,
        spec.type,
        spec.productId,
        spec.toWarehouseId ?? null,
        spec.fromWarehouseId ?? null,
        spec.qty,
        spec.referenceType,
        spec.referenceId,
        UNIT_COST,
        spec.qty * UNIT_COST,
      ],
    )
    insertSucceeded = true
    if (spec.costLayer) {
      await client.query(
        `INSERT INTO "cost_layers" (id, "productId", "warehouseId", "receivedQty", "remainingQty", "unitCostBase", "poLineId", "isOpeningStock")
         VALUES ($1, $2, $3, $4, $4, $5, $6, false)`,
        [
          `GLESC${Math.random().toString(36).slice(2, 14)}`,
          spec.productId,
          spec.toWarehouseId,
          spec.costLayer.receivedQty,
          UNIT_COST,
          spec.costLayer.poLineId,
        ],
      )
    }
    if (spec.cogsEntry) {
      await client.query(
        `INSERT INTO "cogs_entries" (id, "movementId", "costLayerId", qty, "unitCostBase", "totalCostBase")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`GLESG${Math.random().toString(36).slice(2, 14)}`, movementId, spec.cogsEntry.costLayerId, spec.qty, UNIT_COST, spec.qty * UNIT_COST],
      )
    }
    await client.query('COMMIT')
    return { insertSucceeded, committed: true, failedAt: null }
  } catch (error) {
    const e = error as { code?: string; message?: string; severity?: string; where?: string }
    try { await client.query('ROLLBACK') } catch { /* the transaction is already aborted */ }
    return {
      insertSucceeded,
      committed: false,
      failedAt: insertSucceeded ? 'commit' : 'insert',
      code: e.code,
      message: e.message,
      severity: e.severity,
      where: e.where,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ARM 1 — THE FIX. A purchase-backed book-in credits stock and its movement
// carries the evidence the guard asks for. RED before the fix (status 'failed').
// ─────────────────────────────────────────────────────────────────────────────
test(
  'o3d-gles: a PURCHASE-backed WMS book-in commits, and its PURCHASE_RECEIPT carries purchase-order evidence',
  SKIP,
  async () => {
    const url = loadEnv()
    const { db } = await import('@/lib/db')
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      await assertGuardIsInstalledAndDeferred(client, 'arm1')

      const seeded = await seedPurchaseBackedAsn('OK', 5)
      const result = await runBookedIn(seeded)
      console.log(`[arm1] processBookedInEvent -> ${JSON.stringify(result)}`)
      assert.equal(
        result.status,
        'processed',
        `the book-in must COMMIT; got ${JSON.stringify(result)}`,
      )

      // Read back on a SEPARATE connection: proof the transaction committed, not merely
      // that no error was thrown inside it.
      const movements = (await client.query<{
        id: string
        type: string
        qty: string
        referenceType: string | null
        referenceId: string | null
        idempotencyKey: string | null
      }>(
        `SELECT id, type, qty::text AS qty, "referenceType", "referenceId", "idempotencyKey"
           FROM "stock_movements" WHERE "productId" = $1 AND qty > 0 ORDER BY "createdAt"`,
        [seeded.productId],
      )).rows
      console.log(`[arm1] examined ${movements.length} committed positive-qty stock_movements row(s) for the seeded product: ${JSON.stringify(movements)}`)
      assert.equal(movements.length, 1, 'exactly one positive-quantity movement must have committed')
      const movement = movements[0]!
      assert.equal(movement.type, 'PURCHASE_RECEIPT')
      // DERIVED, not typed: the expected reference is the seeded PO's own id.
      assert.equal(movement.referenceType, 'PurchaseOrder')
      assert.equal(movement.referenceId, seeded.poId, 'the movement must name the purchase order that vouches for the units')
      assert.equal(Number(movement.qty), seeded.qty)

      // THE EVIDENCE IS REALLY THERE — the guard's own subquery finds it.
      const evidenceCount = await countGuardEvidenceForMovement(client, movement.id)
      console.log(`[arm1] the guard's own evidence subquery matched ${evidenceCount} cost layer(s) for movement ${movement.id}`)
      assert.equal(evidenceCount, 1, 'the guard\'s own evidence join must find the cost layer — a pass with 0 would mean the guard was bypassed, not satisfied')

      // THE ASN LINK SURVIVES: still line-granular, in the idempotency key.
      const { wmsPurchaseReceiptMovementKey } = await import('@/lib/domain/inventory/stock-movement-idempotency')
      const events = (await client.query<{ id: string }>(
        `SELECT id FROM "wms_inbound_receipt_events" WHERE "externalAsnId" = $1`,
        [seeded.tag],
      )).rows
      assert.equal(events.length, 1, 'one receipt event was seeded')
      assert.equal(
        movement.idempotencyKey,
        wmsPurchaseReceiptMovementKey({ asnLineMapId: seeded.asnLineMapId, receiptEventId: events[0]!.id }),
        'the ASN line map id must still be carried by the idempotency key',
      )
      console.log(`[arm1] idempotencyKey carries the ASN line: ${movement.idempotencyKey}`)

      // The stock and the PO line actually moved.
      const level = await db.stockLevel.findUnique({
        where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.warehouseId } },
        select: { quantity: true },
      })
      const poLine = await db.purchaseOrderLine.findUnique({ where: { id: seeded.poLineId }, select: { qtyReceived: true } })
      console.log(`[arm1] stock_levels.quantity=${String(level?.quantity)} purchase_order_lines.qtyReceived=${String(poLine?.qtyReceived)} (expected ${seeded.qty} for both)`)
      assert.equal(Number(level?.quantity), seeded.qty)
      assert.equal(Number(poLine?.qtyReceived), seeded.qty)
    } finally {
      await client.end()
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// ARM 2 — the transfer-backed book-in is UNCHANGED. It writes TRANSFER_IN, which
// the guard does not cover, and it still keeps its WmsAsnMap reference.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'o3d-gles: the transfer-backed book-in still writes TRANSFER_IN against the ASN map',
  SKIP,
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const tag = uniqueTag('TR')
    const qty = 5
    const product = await db.product.create({
      data: { sku: tag, name: `o3d-gles transfer ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
      select: { id: true },
    })
    const source = await db.warehouse.create({ data: { code: `S${tag.slice(-9)}`, name: `${tag} src`, type: 'STANDARD' }, select: { id: true } })
    const destination = await db.warehouse.create({ data: { code: `D${tag.slice(-9)}`, name: `${tag} dst`, type: 'STANDARD' }, select: { id: true } })
    await db.stockLevel.create({ data: { productId: product.id, warehouseId: destination.id, quantity: '0', reservedQty: '0' }, select: { productId: true } })
    const sourceLayer = await db.costLayer.create({
      data: { productId: product.id, warehouseId: source.id, receivedQty: `${qty}.000000`, remainingQty: '0.000000', unitCostBase: `${UNIT_COST}.000000` },
      select: { id: true },
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
            productName: `o3d-gles transfer ${tag}`,
            qty: `${qty}.0000`,
            qtyReceived: '0.0000',
            costLayerSnapshot: [{ costLayerId: sourceLayer.id, qty: `${qty}.000000`, unitCostBase: `${UNIT_COST}.000000` }],
          }],
        },
      },
      select: { id: true, lines: { select: { id: true } } },
    })
    const asn = await db.wmsAsnMap.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: o3d-gles: a test fixture row, not a core flow branch
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
    const result = await runBookedIn({
      tag,
      qty,
      productId: product.id,
      warehouseId: destination.id,
      poId: '',
      poLineId: transfer.lines[0]!.id,
      asnMapId: asn.id,
      asnLineMapId: asn.lines[0]!.id,
      externalAsnLineId: asn.lines[0]!.externalAsnLineId,
    })
    console.log(`[arm2] processBookedInEvent -> ${JSON.stringify(result)}`)
    assert.equal(result.status, 'processed')
    const movements = await db.stockMovement.findMany({
      where: { productId: product.id, qty: { gt: 0 } },
      select: { type: true, referenceType: true, referenceId: true },
    })
    console.log(`[arm2] examined ${movements.length} positive-qty movement(s): ${JSON.stringify(movements)}`)
    assert.equal(movements.length, 1)
    assert.equal(movements[0]!.type, 'TRANSFER_IN')
    assert.equal(movements[0]!.referenceType, 'WmsAsnMap', 'a transfer has no purchase order to name; its reference is unchanged')
    assert.equal(movements[0]!.referenceId, asn.id)
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// ARM 3 — THE GUARD STILL REFUSES A FABRICATED PURCHASE_RECEIPT with no cost
// layer at all, even though it names a real purchase order.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'o3d-gles: the guard still refuses a PURCHASE_RECEIPT with no cost layer behind it',
  SKIP,
  async () => {
    const url = loadEnv()
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      await assertGuardIsInstalledAndDeferred(client, 'arm3')
      const seeded = await seedPurchaseBackedAsn('NOLAYER', 4)
      const outcome = await commitFabricatedMovement(client, {
        type: 'PURCHASE_RECEIPT',
        productId: seeded.productId,
        toWarehouseId: seeded.warehouseId,
        qty: seeded.qty,
        referenceType: 'PurchaseOrder',
        referenceId: seeded.poId,
        // deliberately NO cost layer
      })
      console.log(`[arm3] examined: insertSucceeded=${outcome.insertSucceeded} committed=${outcome.committed} failedAt=${outcome.failedAt} sqlstate=${outcome.code} severity=${outcome.severity} where=${outcome.where} message=${outcome.message}`)
      assert.equal(outcome.insertSucceeded, true, 'the INSERT itself must succeed — the guard is DEFERRED')
      assert.equal(outcome.committed, false, 'the guard must refuse a receipt with no cost-layer evidence')
      assert.equal(outcome.failedAt, 'commit', 'the refusal must arrive at COMMIT, not at the INSERT')
      assert.equal(outcome.code, GUARD_SQLSTATE)
      assert.match(String(outcome.message), /requires matching cost-layer evidence/)
      assert.match(String(outcome.where), /assert_stock_movement_reporting_evidence/)
    } finally {
      await client.end()
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// ARM 4 — THE FABRICATION THAT MATTERS MOST. A cost layer EXISTS with the right
// product, warehouse and quantity, but its PO line belongs to a DIFFERENT
// purchase order. This is "borrowed evidence", and the guard must still refuse.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'o3d-gles: the guard still refuses a PURCHASE_RECEIPT whose cost layer belongs to another purchase order',
  SKIP,
  async () => {
    const url = loadEnv()
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      await assertGuardIsInstalledAndDeferred(client, 'arm4')
      const victim = await seedPurchaseBackedAsn('BORROWA', 4)
      const other = await seedPurchaseBackedAsn('BORROWB', 4)
      assert.notEqual(victim.poId, other.poId, 'the two purchase orders must be distinct or this arm proves nothing')
      const outcome = await commitFabricatedMovement(client, {
        type: 'PURCHASE_RECEIPT',
        productId: victim.productId,
        toWarehouseId: victim.warehouseId,
        qty: victim.qty,
        referenceType: 'PurchaseOrder',
        referenceId: victim.poId,
        // A layer of the right shape, but hung off the OTHER purchase order's line.
        costLayer: { poLineId: other.poLineId, receivedQty: victim.qty },
      })
      console.log(`[arm4] examined: a cost layer for product ${victim.productId} @ ${victim.warehouseId} qty ${victim.qty} hung off PO ${other.poId}'s line while the movement names PO ${victim.poId}; insertSucceeded=${outcome.insertSucceeded} committed=${outcome.committed} failedAt=${outcome.failedAt} sqlstate=${outcome.code} message=${outcome.message}`)
      assert.equal(outcome.insertSucceeded, true)
      assert.equal(outcome.committed, false, 'a layer belonging to another purchase order is not evidence for this one')
      assert.equal(outcome.failedAt, 'commit')
      assert.equal(outcome.code, GUARD_SQLSTATE)
      assert.match(String(outcome.message), /requires matching cost-layer evidence/)
    } finally {
      await client.end()
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// ARM 5 — THE CHANGE DID NOT WIDEN THE GUARD. A PURCHASE_RECEIPT referencing a
// WmsAsnMap that DOES resolve to a purchase order, WITH a perfectly good cost
// layer, is STILL refused — because the fix moved the writer, not the rule.
// This is the arm the "make the guard accept a WmsAsnMap" mutation must turn red.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'o3d-gles: the guard still refuses a WmsAsnMap-referenced PURCHASE_RECEIPT even when the ASN resolves to a purchase order',
  SKIP,
  async () => {
    const url = loadEnv()
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      await assertGuardIsInstalledAndDeferred(client, 'arm5')
      const seeded = await seedPurchaseBackedAsn('ASNREF', 4)
      // PRECONDITION: the ASN map really does resolve to the purchase order, so the
      // refusal below is about the REFERENCE TYPE and not about a broken fixture.
      const resolved = (await client.query<{ sourceType: string; sourceId: string }>(
        `SELECT "sourceType"::text AS "sourceType", "sourceId" FROM "wms_asn_maps" WHERE id = $1`,
        [seeded.asnMapId],
      )).rows
      console.log(`[arm5] precondition: wms_asn_maps row ${seeded.asnMapId} = ${JSON.stringify(resolved)}; the seeded PO is ${seeded.poId}`)
      assert.equal(resolved.length, 1)
      assert.equal(resolved[0]!.sourceType, 'PURCHASE_ORDER')
      assert.equal(resolved[0]!.sourceId, seeded.poId, 'the ASN map must resolve to the seeded purchase order')

      const outcome = await commitFabricatedMovement(client, {
        type: 'PURCHASE_RECEIPT',
        productId: seeded.productId,
        toWarehouseId: seeded.warehouseId,
        qty: seeded.qty,
        referenceType: 'WmsAsnMap',
        referenceId: seeded.asnMapId,
        costLayer: { poLineId: seeded.poLineId, receivedQty: seeded.qty },
      })
      console.log(`[arm5] examined: insertSucceeded=${outcome.insertSucceeded} committed=${outcome.committed} failedAt=${outcome.failedAt} sqlstate=${outcome.code} message=${outcome.message}`)
      assert.equal(outcome.insertSucceeded, true)
      assert.equal(outcome.committed, false, 'the guard must not have learned to accept a WmsAsnMap reference — the fix moved the writer, not the rule')
      assert.equal(outcome.failedAt, 'commit')
      assert.equal(outcome.code, GUARD_SQLSTATE)
      assert.match(String(outcome.message), /requires matching cost-layer evidence/)
    } finally {
      await client.end()
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// ARM 6 — THE CASE THE GUARD WAS WRITTEN FOR. A fabricated PURCHASE_REVERSAL with
// no COGS evidence must still be refused: that asymmetry is what
// 20260617140000_restore_purchase_reversal_evidence_guard exists to close.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'o3d-gles: the guard still refuses a PURCHASE_REVERSAL with no COGS evidence',
  SKIP,
  async () => {
    const url = loadEnv()
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      await assertGuardIsInstalledAndDeferred(client, 'arm6')
      const seeded = await seedPurchaseBackedAsn('REVERSAL', 4)
      const outcome = await commitFabricatedMovement(client, {
        type: 'PURCHASE_REVERSAL',
        productId: seeded.productId,
        fromWarehouseId: seeded.warehouseId,
        qty: seeded.qty,
        referenceType: 'PurchaseOrder',
        referenceId: seeded.poId,
        // deliberately NO cogs_entries row
      })
      console.log(`[arm6] examined: insertSucceeded=${outcome.insertSucceeded} committed=${outcome.committed} failedAt=${outcome.failedAt} sqlstate=${outcome.code} message=${outcome.message}`)
      assert.equal(outcome.insertSucceeded, true)
      assert.equal(outcome.committed, false, 'a reversal with no COGS entry must be refused')
      assert.equal(outcome.failedAt, 'commit')
      assert.equal(outcome.code, GUARD_SQLSTATE)
      assert.match(String(outcome.message), /requires matching COGS evidence/)
    } finally {
      await client.end()
    }
  },
)
