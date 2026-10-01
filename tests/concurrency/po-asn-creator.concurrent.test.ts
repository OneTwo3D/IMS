import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { assertScratchDatabaseBeforeAnyWrite } from './scratch-database-guard'
import * as fixtures from './po-landed-fixtures'
import type { SeededAsn, SeededLine, SeededPo } from './po-landed-fixtures'
import { randomUUID } from 'node:crypto'

/**
 * o3d-papk (6a follow-up) — THE REAL PURCHASE-ORDER ASN CREATOR over a real PostgreSQL, against a FAKE warehouse.
 *
 * NO NETWORK. Mintsoft is LIVE: the connector-fetch boundary and global fetch throw, the connector registry is a
 * fake whose `createAsn` RECORDS the quantity it is told to expect per line (the wire quantity, which is what a
 * live warehouse would be asked for) and answers with a NEW ASN, and duplicate recovery sees an empty tenant.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const
const CONNECTOR = 'mintsoft' // wms-connector-boundary-ok: o3d-papk: a test fixture value, not a core flow branch

const LIVE_WMS = 'o3d-papk creator test: a WMS call was attempted. Mintsoft is LIVE; nothing here may reach it.'
globalThis.fetch = (async () => { throw new Error(LIVE_WMS) }) as typeof fetch

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async () => { throw new Error(LIVE_WMS) },
    DEFAULT_CONNECTOR_FETCH_TIMEOUT_MS: 30_000,
    DEFAULT_CONNECTOR_FETCH_MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
    isAllAddressesLookup: () => false,
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
    requireApiFreshAdmin: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
    logActivityInTransaction: async () => {},
    logActivityPersisted: async () => true,
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async () => true,
    getIntegrationPluginState: async () => ({ enabled: true }),
  },
})
mock.module('@/lib/public-app-url', { namedExports: { getPublicAppUrl: async () => 'https://ims.example.invalid' } })
mock.module('@/lib/jobs/wms/process-mintsoft-booked-in-event', {
  namedExports: {
    replayMintsoftBookedInEventsForAsn: async () => {},
    enqueueMintsoftBookedInRecheckForAsn: async () => {},
  },
})

const { loadEnv, enableStockReceiptPosting, uid, seedPo, addAsn, receive, bookIn, snapshotOf } = fixtures

/** What the fake warehouse was told, per createAsn call: the wire quantity of each line. */
type WireCall = { lines: Array<{ sourceLineId: string; quantity: number }> }
const wireCalls: WireCall[] = []
let nextCreateAsnFailure: Error | null = null
/** Runs inside the fake `fetchMintsoftAsnsForDuplicateRecovery`: AFTER the reservation committed, BEFORE the revalidation. */
let duplicateRecoveryHook: (() => Promise<void>) | null = null
/** Runs inside the fake `createAsn`: AFTER the claim, BEFORE the finalize. */
let createAsnHook: (() => Promise<void>) | null = null
/** When set, the next `createAsn` answers with THIS external id (to collide with a row IMS already holds). */
let nextExternalAsnId: string | null = null

const APP_NAME = `o3d-papk-creator-${process.pid}`

let rawUrl = ''

let modulesReady: Promise<{
  createMintsoftPurchaseOrderAsn: typeof import('@/app/actions/mintsoft-sync').createMintsoftPurchaseOrderAsn
}> | null = null

/** Guard FIRST, then the application modules: nothing opens the pool before the guard. */
function loadModules() {
  modulesReady ??= (async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    await assertScratchDatabaseBeforeAnyWrite()
    // The application pool carries a recognisable application_name so the lock-order arms can tell its backends
    // from the raw sessions they open themselves.
    const exported = process.env.DATABASE_URL!
    const pooled = new URL(exported)
    pooled.searchParams.set('application_name', APP_NAME)
    process.env.DATABASE_URL = pooled.toString()
    rawUrl = exported

    const realMintsoft = await import('@/lib/connectors/mintsoft')
    mock.module('@/lib/connectors/mintsoft', {
      namedExports: {
        ...(realMintsoft as unknown as Record<string, unknown>),
        getMintsoftSettings: async () => ({ mintsoft_webhook_secret: '' }),
        fetchMintsoftAsns: async () => { throw new Error(LIVE_WMS) },
        // Duplicate recovery sees an EMPTY tenant, so the creator goes on to create.
        fetchMintsoftAsnsForDuplicateRecovery: async () => {
          const hook = duplicateRecoveryHook
          duplicateRecoveryHook = null
          if (hook) await hook()
          return []
        },
      },
    })
    const realRegistry = await import('@/lib/connectors/wms/registry')
    mock.module('@/lib/connectors/wms/registry', {
      namedExports: {
        ...(realRegistry as unknown as Record<string, unknown>),
        isWmsConnectorConfigured: async () => true,
        getWmsConnector: () => ({
          id: CONNECTOR,
          name: 'test',
          createAsn: async (request: { lines: Array<{ sourceLineId: string; quantity: number }> }) => {
            const hook = createAsnHook
            createAsnHook = null
            if (hook) await hook()
            if (nextCreateAsnFailure) {
              const failure = nextCreateAsnFailure
              nextCreateAsnFailure = null
              throw failure
            }
            wireCalls.push({ lines: request.lines.map((line) => ({ sourceLineId: line.sourceLineId, quantity: line.quantity })) })
            const forcedId = nextExternalAsnId
            nextExternalAsnId = null
            return {
              externalAsnId: forcedId ?? `${uid()}-created-asn`,
              status: 'NEW',
              lines: request.lines.map((line, index) => ({ externalLineId: `${index + 1}`, sourceLineId: line.sourceLineId, raw: null })),
              raw: null,
            }
          },
        }),
      },
    })
    const actions = await import('@/app/actions/mintsoft-sync')
    return { createMintsoftPurchaseOrderAsn: actions.createMintsoftPurchaseOrderAsn }
  })()
  return modulesReady
}

test.before(async () => {
  if (!RUN) return
  loadEnv()
  // The pool's application_name is set in `loadModules`, so it must run before anything opens `@/lib/db`.
  await loadModules()
  await enableStockReceiptPosting()
})

/** Make a seeded PO creatable: a Mintsoft connection and binding on its warehouse, and a product link per line. */
async function makeCreatable(po: SeededPo): Promise<void> {
  const { db } = await import('@/lib/db')
  const connection = await db.wmsConnection.create({ data: { connector: CONNECTOR, label: po.tag, active: true }, select: { id: true } })
  await db.externalWmsBinding.create({
    data: {
      connectionId: connection.id,
      warehouseId: po.warehouseId,
      connector: CONNECTOR,
      externalWarehouseId: `wh-${po.tag}`,
      active: true,
      stockSyncMode: 'ALIGN_TO_WMS',
      alignmentConfirmedAt: new Date(),
    },
    select: { id: true },
  })
  for (const line of po.lines) {
    await db.wmsProductLink.create({ data: { productId: line.productId, connector: CONNECTOR, externalProductId: `ext-${uid()}` } })
  }
}

/** The ASN rows of a PO line, oldest first, with the columns the arms assert on. */
async function asnRowsOf(line: SeededLine) {
  const { db } = await import('@/lib/db')
  const rows = await db.wmsAsnLineMap.findMany({
    where: { sourceType: 'PURCHASE_ORDER_LINE', sourceLineId: line.poLineId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      expectedQty: true,
      manualQtyBaseline: true,
      qtyAccountedViaSnapshot: true,
      qtyAccountedViaReceipt: true,
      lastProcessedReceivedQty: true,
      externalAsnLineId: true,
      asn: { select: { id: true, externalAsnId: true, status: true, closedAt: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    expected: Number(row.expectedQty),
    baseline: Number(row.manualQtyBaseline),
    snapshot: Number(row.qtyAccountedViaSnapshot),
    receipt: Number(row.qtyAccountedViaReceipt),
    lastProcessed: Number(row.lastProcessedReceivedQty),
    externalAsnLineId: row.externalAsnLineId,
    asnId: row.asn.id,
    externalAsnId: row.asn.externalAsnId,
    status: row.asn.status,
    closedAt: row.asn.closedAt,
  }))
}

function asSeededAsn(row: Awaited<ReturnType<typeof asnRowsOf>>[number]): SeededAsn {
  return { asnId: row.asnId, asnLineMapId: row.id, externalAsnId: row.externalAsnId, externalAsnLineId: row.externalAsnLineId }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A-D3 — o3d-67kw3: A MANUAL RECEIPT MADE BEFORE THE ASN WAS SIZED IS NOT A MANUAL RECEIPT AGAINST IT
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A-D3 o3d-67kw3: manual receipt 4, then the REAL creator sizes an ASN for the 6 outstanding, Mintsoft books 6: all 6 land (stock 10)',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const po = await seedPo('ad3', [10])
    const line = po.lines[0]!
    await makeCreatable(po)
    const manual = await receive(po, line, 4)
    assert.equal(manual.success, true, `PRECONDITION: the manual receipt of 4 must succeed: ${manual.error}`)
    assert.equal((await snapshotOf(po, line)).stock, 4, 'PRECONDITION: the manual receipt put 4 in stock')

    const before = wireCalls.length
    const created = await createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
    assert.equal(created.success, true, `PRECONDITION: the creator succeeded: ${created.error}`)
    assert.equal(wireCalls.length, before + 1, 'PRECONDITION: the fake warehouse was asked to create the ASN')
    const rows = await asnRowsOf(line)
    assert.equal(rows.length, 1, 'PRECONDITION: one ASN row for the line')
    assert.equal(rows[0]!.expected, 6, 'PRECONDITION: the ASN is sized for the 6 outstanding')
    assert.equal(rows[0]!.baseline, 4, 'PRECONDITION: the row recorded the 4 manual receipts that pre-date it (manualQtyBaseline)')

    const status = await bookIn(asSeededAsn(rows[0]!), line, 6, 6)
    assert.equal(status, 'processed', 'PRECONDITION: the book-in processed')
    const after = await snapshotOf(po, line)
    console.log(`# A-D3 o3d-67kw3: manual 4, ASN sized 6 (baseline ${rows[0]!.baseline}), Mintsoft books 6 -> stock=${after.stock} (physical 10) qtyReceived=${after.qtyReceived} poStatus=${after.poStatus}`)
    assert.equal(after.stock, 10, 'all 6 booked units land on top of the manual 4')
    assert.equal(after.qtyReceived, 10)
    assert.equal(after.poStatus, 'RECEIVED')
    console.log('# A-D3: evaluated 1 manual-then-ASN sequence through the real creator')
  },
)

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// C2 — A CREDITED PENDING RESERVATION IS RETIRED, NEVER DELETED OR RESIZED (o3d-papk, Codex H2)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** A CREATE_PENDING reservation the way a failed push leaves one: pending ids, one row per line. */
async function addPendingReservation(
  po: SeededPo,
  rows: Array<{ line: SeededLine; expectedQty: number }>,
): Promise<{ asnId: string; externalAsnId: string }> {
  const { db } = await import('@/lib/db')
  const externalAsnId = `pending:${po.poId}:${Date.now()}-${randomUUID().slice(0, 8)}`
  const asn = await db.wmsAsnMap.create({
    data: {
      connector: CONNECTOR,
      externalAsnId,
      sourceType: 'PURCHASE_ORDER',
      sourceId: po.poId,
      warehouseId: po.warehouseId,
      status: 'CREATE_PENDING',
      lines: {
        create: rows.map(({ line, expectedQty }) => ({
          externalAsnLineId: `pending:${line.poLineId}`,
          sourceType: 'PURCHASE_ORDER_LINE',
          sourceLineId: line.poLineId,
          productId: line.productId,
          sku: line.sku,
          expectedQty: `${expectedQty}.0000`,
        })),
      },
    },
    select: { id: true },
  })
  return { asnId: asn.id, externalAsnId }
}

type RawClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
}

async function rawSession(): Promise<RawClient> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: rawUrl, application_name: `${APP_NAME}-raw` })
  await client.connect()
  return client as unknown as RawClient
}

/** A line's ASN rows read from a FRESH connection, so uncommitted or rolled-back writes cannot be seen. */
async function freshRowsOf(line: SeededLine) {
  const session = await rawSession()
  try {
    const { rows } = await session.query(
      `SELECT m.id AS asn_id, m."externalAsnId" AS external_asn_id, m.status::text AS status, m."closedAt" AS closed_at,
              l.id AS line_id, l."expectedQty"::float8 AS expected, l."qtyAccountedViaSnapshot"::float8 AS snapshot,
              l."manualQtyBaseline"::float8 AS baseline, l.note AS note
         FROM wms_asn_line_maps l JOIN wms_asn_maps m ON m.id = l."asnMapId"
        WHERE l."sourceType" = 'PURCHASE_ORDER_LINE' AND l."sourceLineId" = $1
        ORDER BY l."createdAt" ASC, l.id ASC`,
      [line.poLineId],
    )
    return rows.map((row) => ({
      asnId: String(row.asn_id),
      externalAsnId: String(row.external_asn_id),
      status: String(row.status),
      closedAt: row.closed_at as Date | null,
      lineId: String(row.line_id),
      expected: Number(row.expected),
      snapshot: Number(row.snapshot),
      baseline: Number(row.baseline),
      note: row.note as string | null,
    }))
  } finally {
    await session.end()
  }
}

async function landedOf(line: SeededLine): Promise<number> {
  const { db } = await import('@/lib/db')
  const { loadPurchaseOrderLineLandedQty } = await import('@/lib/domain/inventory/po-line-landed-quantity')
  const row = await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.poLineId }, select: { id: true, qtyReceived: true } })
  return (await loadPurchaseOrderLineLandedQty(db, [row])).get(line.poLineId)!.qtyNumber
}

/** Seed a PO with ONE credited pending reservation: qty 10, reservation row 10, a REAL alignment of 6 credited to it. */
async function seedCreditedReservation(label: string) {
  const po = await seedPo(label, [10])
  const line = po.lines[0]!
  await makeCreatable(po)
  const reservation = await addPendingReservation(po, [{ line, expectedQty: 10 }])
  const aligned = await fixtures.alignUp(po, line, { delta: 6, imsQty: 0 })
  assert.equal(aligned.applied, true, `PRECONDITION: the alignment applied: ${JSON.stringify(aligned)}`)
  const rows = await freshRowsOf(line)
  assert.equal(rows.length, 1, 'PRECONDITION: one ASN row')
  assert.equal(rows[0]!.snapshot, 6, 'PRECONDITION: the reservation row carries the 6-unit credit (exactly one credited row)')
  assert.equal((await snapshotOf(po, line)).qtyReceived, 0, 'PRECONDITION: alignment did not write qtyReceived')
  return { po, line, reservation }
}

// ── B1 / B5 — R2: the retry sizes by LANDED, retires the credited row and replaces it ──────────────────────────
test(
  'B1 R2: a retry over a credited reservation retires it (closed, credit kept) and the wire quantity is the LANDED outstanding 4',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const { po, line } = await seedCreditedReservation('b1')
    const callsBefore = wireCalls.length

    const result = await createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
    assert.equal(result.success, true, `the retry succeeded: ${result.error}`)
    assert.equal(wireCalls.length, callsBefore + 1, 'PRECONDITION: the fake warehouse was asked to create exactly one ASN')
    const wire = wireCalls[wireCalls.length - 1]!.lines
    console.log(`# B1: wire quantity ${JSON.stringify(wire.map((l) => l.quantity))}; PO line 10, landed 6`)
    assert.deepEqual(wire.map((l) => l.quantity), [4], 'WIRE QUANTITY: the warehouse is told to expect the 4 outstanding after the 6 that landed, not 10')

    const rows = await freshRowsOf(line)
    assert.equal(rows.length, 2, 'the credited row was RETIRED and a replacement created: two rows, none deleted')
    const [retired, replacement] = rows
    assert.notEqual(retired!.closedAt, null, 'the credited row is closed')
    assert.equal(retired!.snapshot, 6, 'its credit is untouched: it is the only record the 6 units landed')
    assert.equal(retired!.expected, 6, 'its expectation shrank to what it was credited')
    assert.match(retired!.note ?? '', /purchase_order_lines\.qtyReceived/, 'the note names the purchase-order column')
    assert.equal(replacement!.closedAt, null, 'the replacement is open')
    assert.equal(replacement!.expected, 4, 'the replacement expects the 4 outstanding')
    assert.equal(replacement!.snapshot, 0, 'the replacement carries no credit')
    assert.equal(await landedOf(line), 6, 'landed is unchanged by the retry (6): the credit still counts through the retired row')
    console.log('# B1: evaluated 1 credited reservation (1 credited row), 2 rows after the retry')
  },
)

test(
  'B5 MONEY ARM: align 6, retry (retire + replace 4), Mintsoft books 4: stock 10, landed 10, PO RECEIVED',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const { po, line } = await seedCreditedReservation('b5')
    const result = await createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
    assert.equal(result.success, true, `the retry succeeded: ${result.error}`)
    const rows = await freshRowsOf(line)
    const replacement = rows.find((row) => row.closedAt === null)
    assert.ok(replacement, 'PRECONDITION: an open replacement exists')
    assert.equal(replacement.expected, 4, 'PRECONDITION: the replacement expects 4')

    const { db } = await import('@/lib/db')
    const externalLine = await db.wmsAsnLineMap.findUniqueOrThrow({ where: { id: replacement.lineId }, select: { externalAsnLineId: true } })
    const status = await bookIn(
      { asnId: replacement.asnId, asnLineMapId: replacement.lineId, externalAsnId: replacement.externalAsnId, externalAsnLineId: externalLine.externalAsnLineId },
      line, 4, 4,
    )
    assert.equal(status, 'processed', 'PRECONDITION: the book-in processed')
    const after = await snapshotOf(po, line)
    const landed = await landedOf(line)
    console.log(`# B5: stock=${after.stock} layers=${after.layerQty} journals=${after.journals} qtyReceived=${after.qtyReceived} landed=${landed} poStatus=${after.poStatus}`)
    assert.equal(after.stock, 10, 'six aligned plus four booked: 10 physical units, 10 in stock')
    assert.equal(after.layerQty, 10, 'cost layers total 10')
    assert.equal(after.layerCount, after.journals, 'one STOCK_RECEIPT journal per layer')
    assert.equal(landed, 10)
    assert.equal(after.poStatus, 'RECEIVED')
  },
)

// ── B3 — R1: a credited reservation that has nothing outstanding any more is RETIRED, and the retirement COMMITS ─
test(
  'B3 R1: a credited reservation with nothing outstanding is retired and the refusal is returned: the retirement is visible from a FRESH connection',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const { po, line } = await seedCreditedReservation('b3')
    const manual = await receive(po, line, 4)
    assert.equal(manual.success, true, `PRECONDITION: the manual 4 is accepted (6 landed): ${manual.error}`)
    assert.equal(await landedOf(line), 10, 'PRECONDITION: landed is 10: nothing is outstanding')
    // The manual receipt moved the order to RECEIVED, and the creator refuses a RECEIVED order before it reads any
    // reservation. The path under test is reached by an order that is STILL OPEN while everything has landed: one
    // the alignment completed before it advanced order statuses (C3), which production data will contain. Put the
    // order back into that state.
    const { db } = await import('@/lib/db')
    await db.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'PARTIALLY_RECEIVED', receivedAt: null } })
    assert.equal((await snapshotOf(po, line)).poStatus, 'PARTIALLY_RECEIVED', 'PRECONDITION: the order is still open')
    const callsBefore = wireCalls.length

    const result = await createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
    assert.equal(wireCalls.length, callsBefore, 'PRECONDITION: no ASN was pushed')
    assert.equal(result.success, false, 'the creator refuses: nothing outstanding')
    assert.match(result.error ?? '', /no outstanding quantity/, 'PRECONDITION: it is the nothing-outstanding refusal, reached after the disposal')

    const rows = await freshRowsOf(line)
    console.log(`# B3: ${rows.length} row(s) after the refusal; closedAt=${String(rows[0]?.closedAt)} snapshot=${rows[0]?.snapshot}`)
    assert.equal(rows.length, 1, 'the credited row was not deleted')
    assert.notEqual(rows[0]!.closedAt, null, 'RETIRED, visible from a fresh connection: the refusal was returned, so the retirement committed (a throw would have rolled it back)')
    assert.equal(rows[0]!.snapshot, 6, 'the credit is intact')
    assert.equal(await landedOf(line), 10, 'landed is intact')
  },
)

// ── B2 — R3: the discard after a mismatch RETIRES under the locks (Codex H2's exact sequence) ──────────────────
test(
  'B2 R3: reserve at qtyReceived 0, then an alignment of 6 and a manual 4 commit, the revalidation mismatches and discards: credit and landed survive',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const po = await seedPo('b2', [10])
    const line = po.lines[0]!
    await makeCreatable(po)
    const reservation = await addPendingReservation(po, [{ line, expectedQty: 10 }])
    const callsBefore = wireCalls.length
    let injected = false
    duplicateRecoveryHook = async () => {
      // The window the tenant-wide ASN list fetch opens: AFTER the reservation committed, BEFORE the revalidation.
      const aligned = await fixtures.alignUp(po, line, { delta: 6, imsQty: 0 })
      assert.equal(aligned.applied, true, `PRECONDITION: alignment applied inside the window: ${JSON.stringify(aligned)}`)
      const manual = await receive(po, line, 4)
      assert.equal(manual.success, true, `PRECONDITION: the manual 4 committed inside the window: ${manual.error}`)
      injected = true
    }

    const result = await createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
    assert.equal(injected, true, 'PRECONDITION: the interleaving was injected (the window was reached)')
    assert.equal(wireCalls.length, callsBefore, 'PRECONDITION: nothing was pushed: the revalidation refused')
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /Outstanding quantities changed/)

    const rows = await freshRowsOf(line)
    const original = rows.find((row) => row.asnId === reservation.asnId)
    console.log(`# B2: reservation row after the discard: ${original ? `closedAt=${String(original.closedAt)} snapshot=${original.snapshot}` : 'GONE'}; landed ${await landedOf(line)}`)
    assert.ok(original, 'the credited reservation was NOT deleted (the unlocked autocommit delete cascaded the credit away)')
    assert.notEqual(original.closedAt, null, 'it was retired')
    assert.equal(original.snapshot, 6, 'its credit survived')
    assert.equal(await landedOf(line), 10, 'landed is 10: it did not fall to 4 while stock stays at 10')
    const after = await snapshotOf(po, line)
    assert.equal(after.stock, 10)
    assert.equal(after.poStatus, 'RECEIVED')
  },
)

// ── B4 — R4: the finalize conflict branch RETIRES a credited reservation ───────────────────────────────────────
test(
  'B4 R4: the warehouse answers with an id IMS already holds while an alignment credits the reservation: the reservation is retired, not deleted',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const po = await seedPo('b4', [10])
    const line = po.lines[0]!
    await makeCreatable(po)
    const existing = await addAsn(po, line, { expectedQty: 1, closed: true })
    nextExternalAsnId = existing.externalAsnId
    let aligned = false
    createAsnHook = async () => {
      const result = await fixtures.alignUp(po, line, { delta: 6, imsQty: 0 })
      assert.equal(result.applied, true, `PRECONDITION: the alignment credited the in-flight reservation: ${JSON.stringify(result)}`)
      aligned = true
    }

    const result = await createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
    assert.equal(aligned, true, 'PRECONDITION: the credit landed between the claim and the finalize (the window was reached)')
    assert.equal(result.success, true, `the creator reports the existing ASN: ${result.error}`)
    assert.match(result.message ?? '', /already exists/, 'PRECONDITION: it took the conflict branch')

    const rows = await freshRowsOf(line)
    const reservationRow = rows.find((row) => row.externalAsnId.startsWith('pending:'))
    console.log(`# B4: reservation row ${reservationRow ? `closedAt=${String(reservationRow.closedAt)} snapshot=${reservationRow.snapshot}` : 'GONE'}`)
    assert.ok(reservationRow, 'the credited reservation was NOT deleted by the conflict branch')
    assert.notEqual(reservationRow.closedAt, null, 'it was retired')
    assert.equal(reservationRow.snapshot, 6, 'its credit survived')
    assert.equal(await landedOf(line), 6, 'landed is intact')
  },
)

// ── B8 — the claim refuses a retired row ───────────────────────────────────────────────────────────────────────
test(
  'B8: a reservation retired between the reserve and the claim is NOT claimed and nothing is pushed',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const po = await seedPo('b8', [10])
    const line = po.lines[0]!
    await makeCreatable(po)
    const reservation = await addPendingReservation(po, [{ line, expectedQty: 10 }])
    const callsBefore = wireCalls.length
    duplicateRecoveryHook = async () => {
      // What a concurrent retirement leaves behind: closedAt set, status still CREATE_PENDING.
      const { db } = await import('@/lib/db')
      await db.wmsAsnMap.update({ where: { id: reservation.asnId }, data: { closedAt: new Date() } })
    }

    const result = await createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
    console.log(`# B8: pushed ${wireCalls.length - callsBefore} ASN(s); result.success=${result.success}`)
    assert.equal(wireCalls.length, callsBefore, 'a retired reservation must not be pushed to the warehouse')
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /already in progress/, 'the claim refused')
    const rows = await freshRowsOf(line)
    assert.equal(rows[0]!.closedAt !== null && rows[0]!.status === 'CREATE_PENDING', true, 'it is still retired: nothing reopened it')
  },
)

// ── B6 — lock order: the disposal and the finalize take the purchase order BEFORE the ASN header ───────────────
type Blocked = { pid: number; query: string }

async function waitForAppBackendBlockedBy(probe: RawClient, blockerPid: number, budgetMs = 15000): Promise<Blocked> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const { rows } = await probe.query(
      `SELECT a.pid::int AS pid, coalesce(a.query, '') AS query
         FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.application_name = $1
          AND a.wait_event_type = 'Lock' AND pg_blocking_pids(a.pid) @> ARRAY[$2::int]`,
      [APP_NAME, blockerPid],
    )
    if (rows.length > 0) return { pid: Number(rows[0]!.pid), query: String(rows[0]!.query) }
    if (Date.now() > deadline) throw new Error('no application backend was observed blocked by the held header lock: the path never reached it')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Is the purchase_orders row lockable RIGHT NOW by someone else? NOWAIT: a held row answers 55P03 at once. */
async function purchaseOrderRowIsLockable(probe: RawClient, poId: string): Promise<boolean> {
  await probe.query('BEGIN')
  try {
    await probe.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE NOWAIT', [poId])
    return true
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') return false
    throw error
  } finally {
    await probe.query('ROLLBACK')
  }
}

/** Take (and keep) the row lock of the PO's open ASN header on `holder`'s transaction. Returns its backend pid. */
async function holdHeaderLock(holder: RawClient, poId: string): Promise<number> {
  await holder.query('BEGIN')
  const { rows } = await holder.query(
    `SELECT id FROM wms_asn_maps WHERE "sourceType" = 'PURCHASE_ORDER' AND "sourceId" = $1 AND "closedAt" IS NULL FOR UPDATE`,
    [poId],
  )
  assert.ok(rows.length >= 1, 'PRECONDITION: an open ASN header exists to hold')
  const pid = await holder.query('SELECT pg_backend_pid()::int AS pid')
  return Number(pid.rows[0]!.pid)
}

test(
  'B6 finalize: with the ASN header held by someone else, finalize blocks AT THE HEADER while already HOLDING purchase_orders (2b before 3)',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const po = await seedPo('b6f', [10])
    await makeCreatable(po)
    const holder = await rawSession()
    const probe = await rawSession()
    let holderPid = 0
    createAsnHook = async () => { holderPid = await holdHeaderLock(holder, po.poId) }
    try {
      const running = createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
      // Wait for the hook to have taken the header, then for the finalize to queue behind it.
      for (let i = 0; i < 750 && holderPid === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.notEqual(holderPid, 0, 'PRECONDITION: the header lock was taken inside the push window')
      const blocked = await waitForAppBackendBlockedBy(probe, holderPid)
      const lockable = await purchaseOrderRowIsLockable(probe, po.poId)
      console.log(`# B6 finalize: backend ${blocked.pid} blocked on the header; purchase_orders row lockable by others: ${lockable}`)
      assert.equal(lockable, false, 'finalize must already HOLD purchase_orders while it waits for the header (order 2b -> 3); lockable means it queued at the header first')
      await holder.query('COMMIT')
      const result = await running
      assert.equal(result.success, true, `finalize completed once the header was released: ${result.error}`)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      await holder.end()
      await probe.end()
    }
  },
)

test(
  'B6 discard: with the ASN header held by someone else, the disposal blocks AT THE HEADER while already HOLDING purchase_orders (2b before 3)',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const po = await seedPo('b6d', [10])
    const line = po.lines[0]!
    await makeCreatable(po)
    await addPendingReservation(po, [{ line, expectedQty: 10 }])
    const holder = await rawSession()
    const probe = await rawSession()
    let holderPid = 0
    duplicateRecoveryHook = async () => {
      const manual = await receive(po, line, 1) // moves the outstanding so the revalidation mismatches and DISCARDS
      assert.equal(manual.success, true, `PRECONDITION: the manual 1 committed: ${manual.error}`)
      holderPid = await holdHeaderLock(holder, po.poId)
    }
    try {
      const running = createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
      for (let i = 0; i < 750 && holderPid === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.notEqual(holderPid, 0, 'PRECONDITION: the header lock was taken inside the window')
      const blocked = await waitForAppBackendBlockedBy(probe, holderPid)
      const lockable = await purchaseOrderRowIsLockable(probe, po.poId)
      console.log(`# B6 discard: backend ${blocked.pid} blocked on the header; purchase_orders row lockable by others: ${lockable}`)
      assert.equal(lockable, false, 'the disposal must already HOLD purchase_orders while it waits for the header (order 2b -> 3)')
      await holder.query('COMMIT')
      const result = await running
      assert.equal(result.success, false)
      assert.match(result.error ?? '', /Outstanding quantities changed/)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      await holder.end()
      await probe.end()
    }
  },
)

// ── B7 — soak: retry x alignment and retry x book-in, repeated ─────────────────────────────────────────────────
const SOAK_ROUNDS = Number(process.env.PAPK_SOAK_ROUNDS ?? '20')

test(
  `B7 soak: the retry racing an alignment, ${SOAK_ROUNDS} rounds: no deadlock, the credit is preserved, landed never exceeds the line`,
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    let deadlocks = 0
    const creatorOutcomes = { success: 0, refused: 0 }
    const alignmentOutcomes = { applied: 0, deferred: 0 }
    const creatorErrors: Record<string, number> = {}
    for (let round = 0; round < SOAK_ROUNDS; round += 1) {
      const po = await seedPo(`b7a${round}`, [10])
      const line = po.lines[0]!
      await makeCreatable(po)
      await addPendingReservation(po, [{ line, expectedQty: 10 }])
      // Vary which side starts first: an even round starts both at once, an odd round lets the alignment get a
      // random head start (so the retry sometimes finds a CREDITED reservation to retire and sometimes reserves first
      // and is overtaken inside its ASN-list window, Codex H2's sequence).
      const headStartMs = round % 2 === 0 ? 0 : 5 + Math.floor(Math.random() * 60)
      const [creator, aligned] = await Promise.allSettled([
        (async () => {
          if (headStartMs > 0) await new Promise((resolve) => setTimeout(resolve, headStartMs))
          return createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false })
        })(),
        fixtures.alignUp(po, line, { delta: 6, imsQty: 0 }),
      ])
      for (const settled of [creator, aligned]) {
        const text = settled.status === 'rejected' ? String(settled.reason) : JSON.stringify(settled.value)
        if (/deadlock|40P01/i.test(text)) deadlocks += 1
      }
      assert.equal(aligned.status, 'fulfilled', `round ${round}: the alignment did not throw: ${aligned.status === 'rejected' ? String(aligned.reason) : ''}`)
      assert.equal(creator.status, 'fulfilled', `round ${round}: the creator did not throw: ${creator.status === 'rejected' ? String(creator.reason) : ''}`)
      if (creator.status === 'fulfilled') {
        creatorOutcomes[creator.value.success ? 'success' : 'refused'] += 1
        if (!creator.value.success) {
          const key = (creator.value.error ?? '').slice(0, 60)
          creatorErrors[key] = (creatorErrors[key] ?? 0) + 1
        }
      }
      // The alignment may legitimately defer ('raced': the creator added an ASN row between its discovery and its
      // locks, and the next sweep re-measures). Either way the books must agree: what it applied is in stock, is
      // credited exactly once, and is what has landed.
      const applied = aligned.status === 'fulfilled' && aligned.value.applied
      alignmentOutcomes[applied ? 'applied' : 'deferred'] += 1
      const expectedLanded = applied ? 6 : 0
      const after = await snapshotOf(po, line)
      const rows = await freshRowsOf(line)
      const creditSum = rows.reduce((sum, row) => sum + row.snapshot, 0)
      const landed = await landedOf(line)
      assert.equal(after.stock, expectedLanded, `round ${round}: stock is exactly what the alignment applied`)
      assert.equal(creditSum, expectedLanded, `round ${round}: the credit survived the retry exactly once (${creditSum})`)
      assert.ok(landed <= 10, `round ${round}: landed ${landed} never exceeds the line`)
      assert.equal(landed, expectedLanded, `round ${round}: landed is what landed`)
    }
    console.log(`# B7 soak (retry x alignment): ${SOAK_ROUNDS} rounds, ${deadlocks} deadlock(s); creator outcomes ${JSON.stringify(creatorOutcomes)}; creator refusals ${JSON.stringify(creatorErrors)}; alignment outcomes ${JSON.stringify(alignmentOutcomes)}`)
    assert.ok(alignmentOutcomes.applied > 0, 'PRECONDITION: the alignment applied in at least one round, so the credit invariants were exercised')
    assert.equal(deadlocks, 0, 'no 40P01 in any round')
  },
)

test(
  `B7 soak: the retry racing a book-in on the same order, ${SOAK_ROUNDS} rounds: no deadlock, stock exact`,
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    let deadlocks = 0
    for (let round = 0; round < SOAK_ROUNDS; round += 1) {
      const po = await seedPo(`b7b${round}`, [10, 5])
      const [l1, l2] = [po.lines[0]!, po.lines[1]!]
      await makeCreatable(po)
      const asn = await addAsn(po, l1, { expectedQty: 10, status: 'OPEN' })
      await addPendingReservation(po, [{ line: l2, expectedQty: 5 }])
      const [creator, booked] = await Promise.allSettled([
        createMintsoftPurchaseOrderAsn(po.poId, { autoCallback: false }),
        bookIn(asn, l1, 10, 10),
      ])
      for (const settled of [creator, booked]) {
        const text = settled.status === 'rejected' ? String(settled.reason) : JSON.stringify(settled.value)
        if (/deadlock|40P01/i.test(text)) deadlocks += 1
      }
      assert.equal(booked.status, 'fulfilled', `round ${round}: the book-in did not throw: ${booked.status === 'rejected' ? String(booked.reason) : ''}`)
      assert.equal(creator.status, 'fulfilled', `round ${round}: the creator did not throw: ${creator.status === 'rejected' ? String(creator.reason) : ''}`)
      assert.equal((await snapshotOf(po, l1)).stock, 10, `round ${round}: the book-in landed exactly 10`)
      assert.equal(await landedOf(l1), 10, `round ${round}: landed 10`)
    }
    console.log(`# B7 soak (retry x book-in): ${SOAK_ROUNDS} rounds, ${deadlocks} deadlock(s)`)
    assert.equal(deadlocks, 0, 'no 40P01 in any round')
  },
)
