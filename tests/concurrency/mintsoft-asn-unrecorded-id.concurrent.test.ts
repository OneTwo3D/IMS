import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'

import { assertScratchDatabaseBeforeAnyWrite } from './scratch-database-guard'

/**
 * o3d-0xspr — AN ASN MINTSOFT HAS, WHOSE STATUS IMS CANNOT READ, MUST NOT VANISH FROM THE FAILED JOB.
 *
 * When `createAsn` (or duplicate recovery) hands back an ASN whose status IMS cannot interpret, the creator
 * refuses BEFORE recording anything (`MintsoftAsnStatusUnreadableError`): the ASN exists at the warehouse and
 * IMS holds no row for it. The error carries that ASN's id, and the creator's catch retained the id only for
 * `MintsoftAsnCreateVerificationError`, so for this error the operator's only handle on the orphan was the
 * prose of the message. Both creators (purchase order and transfer) must retain it on the failed job's
 * summary, as they do for the verification error.
 *
 * NO NETWORK. Mintsoft is LIVE: the connector-fetch boundary and global fetch throw, the connector registry is
 * a fake whose `createAsn` returns a canned ASN, and duplicate recovery is stubbed to an empty tenant list.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const
const CONNECTOR = 'mintsoft' // wms-connector-boundary-ok: o3d-0xspr: a test fixture value, not a core flow branch
const UNIT_COST = 5

const LIVE_WMS = 'o3d-0xspr test: a WMS call was attempted. Mintsoft is LIVE; nothing here may reach it.'
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
mock.module('@/lib/fulfillment/backorder-allocator', {
  namedExports: { allocateBackordersForProducts: async () => ({}) },
})
mock.module('@/lib/fulfillment/overallocation-rebalancer', {
  namedExports: { releaseOverallocations: async () => ({}) },
})
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

/** The status the fake warehouse reports. Not one of Mintsoft's, so `interpretMintsoftWireAsnStatus` is `unknown`. */
const UNREADABLE_STATUS = 'o3d-0xspr-status-no-resolver-knows'
let createAsnCalls = 0
let nextCreatedAsnId = ''
let nextCreatedAsnLines: Array<{ externalLineId: string; sourceLineId: string; raw: null }> = []

let modulesReady: Promise<{
  createMintsoftPurchaseOrderAsn: typeof import('@/app/actions/mintsoft-sync').createMintsoftPurchaseOrderAsn
  createMintsoftTransferAsn: typeof import('@/app/actions/mintsoft-sync').createMintsoftTransferAsn
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
          createAsn: async () => {
            createAsnCalls += 1
            return {
              externalAsnId: nextCreatedAsnId,
              status: UNREADABLE_STATUS,
              lines: nextCreatedAsnLines,
              raw: null,
            }
          },
        }),
      },
    })
    const actions = await import('@/app/actions/mintsoft-sync')
    return {
      createMintsoftPurchaseOrderAsn: actions.createMintsoftPurchaseOrderAsn,
      createMintsoftTransferAsn: actions.createMintsoftTransferAsn,
    }
  })()
  return modulesReady
}

function uid(): string {
  return randomUUID().replace(/-/g, '')
}

async function seedBoundWarehouse(tag: string) {
  const { db } = await import('@/lib/db')
  const warehouse = await db.warehouse.create({
    data: { code: `${uid()}-W`, name: `${tag} wh`, type: 'STANDARD' },
    select: { id: true },
  })
  const connection = await db.wmsConnection.create({
    data: { connector: CONNECTOR, label: tag, active: true },
    select: { id: true },
  })
  await db.externalWmsBinding.create({
    data: {
      connectionId: connection.id,
      warehouseId: warehouse.id,
      connector: CONNECTOR,
      externalWarehouseId: `wh-${tag}`,
      active: true,
      stockSyncMode: 'ALIGN_TO_WMS',
      alignmentConfirmedAt: new Date(),
    },
    select: { id: true },
  })
  return warehouse
}

async function failedJobSummaryFor(source: { poId: string } | { transferId: string }) {
  const { db } = await import('@/lib/db')
  const key = 'poId' in source ? 'poId' : 'transferId'
  const jobs = await db.wmsSyncJob.findMany({
    where: {
      connector: CONNECTOR,
      type: 'ASN_CREATE',
      summary: { path: [key], equals: 'poId' in source ? source.poId : source.transferId },
    },
    select: { status: true, summary: true },
  })
  return jobs
}

test(
  'o3d-0xspr: the PURCHASE-ORDER creator retains the id of an ASN whose status it cannot read',
  SKIP,
  async () => {
    const { createMintsoftPurchaseOrderAsn } = await loadModules()
    const { db } = await import('@/lib/db')
    const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
    const tag = `${uid()}-0xspr-po`
    const warehouse = await seedBoundWarehouse(tag)
    const product = await db.product.create({
      data: { sku: tag, name: 'o3d-0xspr po', type: 'SIMPLE', countryOfOrigin: 'CN' },
      select: { id: true },
    })
    await db.wmsProductLink.create({ data: { productId: product.id, connector: CONNECTOR, externalProductId: `ext-${tag}` } })
    const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
    const created = await createPurchaseOrder({
      reference: tag,
      supplierId: supplier.id,
      currency: 'GBP',
      fxRateToBase: 1,
      destinationWarehouseId: warehouse.id,
      pricesIncludeVat: false,
      taxRateValue: 0,
      lines: [{ productId: product.id, sku: tag, productName: 'o3d-0xspr po', qty: 10, unitCostForeign: UNIT_COST }],
    })
    assert.equal(created.success, true, `PRECONDITION: createPurchaseOrder: ${created.error}`)
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: tag }, select: { id: true, lines: { select: { id: true } } } })
    await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })

    nextCreatedAsnId = `${uid()}-orphan-po`
    nextCreatedAsnLines = [{ externalLineId: '1', sourceLineId: po.lines[0]!.id, raw: null }]
    const before = createAsnCalls
    const result = await createMintsoftPurchaseOrderAsn(po.id, { autoCallback: false })

    assert.equal(createAsnCalls, before + 1, 'PRECONDITION: the fake warehouse was asked to create the ASN, so the unreadable status came from it')
    assert.equal(result.success, false, 'the creator refuses an ASN whose status it cannot read')
    assert.match(result.error ?? '', /status cannot be interpreted/, 'PRECONDITION: it is the unreadable-status refusal, not another failure')
    const jobs = await failedJobSummaryFor({ poId: po.id })
    assert.equal(jobs.length, 1, 'one failed job for this order')
    const summary = jobs[0]!.summary as Record<string, unknown>
    console.log(`# o3d-0xspr PO: evaluated ${jobs.length} failed job; summary.unrecordedExternalAsnId=${String(summary.unrecordedExternalAsnId)}`)
    assert.equal(jobs[0]!.status, 'FAILED')
    assert.equal(summary.unrecordedExternalAsnId, nextCreatedAsnId, 'the orphan ASN id is retained on the failed job')
  },
)

test(
  'o3d-0xspr: the TRANSFER creator retains the id of an ASN whose status it cannot read',
  SKIP,
  async () => {
    const { createMintsoftTransferAsn } = await loadModules()
    const { db } = await import('@/lib/db')
    const tag = `${uid()}-0xspr-tr`
    const destination = await seedBoundWarehouse(tag)
    const source = await db.warehouse.create({ data: { code: `${uid()}-S`, name: `${tag} src`, type: 'STANDARD' }, select: { id: true } })
    const product = await db.product.create({
      data: { sku: tag, name: 'o3d-0xspr tr', type: 'SIMPLE', countryOfOrigin: 'CN' },
      select: { id: true },
    })
    await db.wmsProductLink.create({ data: { productId: product.id, connector: CONNECTOR, externalProductId: `ext-${tag}` } })
    const sourceLayer = await db.costLayer.create({
      data: { productId: product.id, warehouseId: source.id, receivedQty: '10.000000', remainingQty: '0.000000', unitCostBase: UNIT_COST },
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
            productName: 'o3d-0xspr tr',
            qty: '10.0000',
            qtyReceived: '0.0000',
            costLayerSnapshot: [{ costLayerId: sourceLayer.id, qty: '10.000000', unitCostBase: `${UNIT_COST}.000000` }],
          }],
        },
      },
      select: { id: true, lines: { select: { id: true } } },
    })

    nextCreatedAsnId = `${uid()}-orphan-tr`
    nextCreatedAsnLines = [{ externalLineId: '1', sourceLineId: transfer.lines[0]!.id, raw: null }]
    const before = createAsnCalls
    const result = await createMintsoftTransferAsn(transfer.id, { autoCallback: false })

    assert.equal(createAsnCalls, before + 1, 'PRECONDITION: the fake warehouse was asked to create the ASN')
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /status cannot be interpreted/, 'PRECONDITION: it is the unreadable-status refusal')
    const jobs = await failedJobSummaryFor({ transferId: transfer.id })
    assert.equal(jobs.length, 1, 'one failed job for this transfer')
    const summary = jobs[0]!.summary as Record<string, unknown>
    console.log(`# o3d-0xspr transfer: evaluated ${jobs.length} failed job; summary.unrecordedExternalAsnId=${String(summary.unrecordedExternalAsnId)}`)
    assert.equal(summary.unrecordedExternalAsnId, nextCreatedAsnId, 'the orphan ASN id is retained on the failed job')
  },
)
