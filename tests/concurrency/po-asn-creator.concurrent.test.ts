import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { assertScratchDatabaseBeforeAnyWrite } from './scratch-database-guard'
import * as fixtures from './po-landed-fixtures'
import type { SeededAsn, SeededLine, SeededPo } from './po-landed-fixtures'

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

const { loadEnv, enableStockReceiptPosting, uid, seedPo, receive, bookIn, snapshotOf } = fixtures

/** What the fake warehouse was told, per createAsn call: the wire quantity of each line. */
type WireCall = { lines: Array<{ sourceLineId: string; quantity: number }> }
const wireCalls: WireCall[] = []
let nextCreateAsnFailure: Error | null = null

let modulesReady: Promise<{
  createMintsoftPurchaseOrderAsn: typeof import('@/app/actions/mintsoft-sync').createMintsoftPurchaseOrderAsn
}> | null = null

/** Guard FIRST, then the application modules: nothing opens the pool before the guard. */
function loadModules() {
  modulesReady ??= (async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    await assertScratchDatabaseBeforeAnyWrite()

    const realMintsoft = await import('@/lib/connectors/mintsoft')
    mock.module('@/lib/connectors/mintsoft', {
      namedExports: {
        ...(realMintsoft as unknown as Record<string, unknown>),
        getMintsoftSettings: async () => ({ mintsoft_webhook_secret: '' }),
        fetchMintsoftAsns: async () => { throw new Error(LIVE_WMS) },
        // Duplicate recovery sees an EMPTY tenant, so the creator goes on to create.
        fetchMintsoftAsnsForDuplicateRecovery: async () => [],
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
            if (nextCreateAsnFailure) {
              const failure = nextCreateAsnFailure
              nextCreateAsnFailure = null
              throw failure
            }
            wireCalls.push({ lines: request.lines.map((line) => ({ sourceLineId: line.sourceLineId, quantity: line.quantity })) })
            return {
              externalAsnId: `${uid()}-created-asn`,
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
