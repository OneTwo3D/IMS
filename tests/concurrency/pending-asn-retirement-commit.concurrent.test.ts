import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { assertScratchDatabaseBeforeAnyWrite } from './scratch-database-guard'

/**
 * o3d-zzgp round 4 — Codex HIGH-1: A WRITE FOLLOWED BY A THROW IN THE SAME TRANSACTION
 * IS NOT A WRITE.
 *
 * Round 3's reservation transaction retired a credited pending reservation and then,
 * finding nothing outstanding or an unlinked SKU, threw the operator's refusal from inside
 * the same Prisma interactive transaction. PostgreSQL rolled the retirement back. The unit
 * fake ran the callback with no rollback, so the unit tests reported "retired, then
 * refused" — a test double faithfully answering the wrong question.
 *
 * So these cases use the one thing that has real rollback semantics: a real transaction.
 * Each drives the real `createMintsoftTransferAsn` and, AFTER it has returned, re-reads
 * the rows the refusal must not have undone.
 *
 *   A. retire, then "no outstanding quantity left"
 *   B. retire, then "not linked to a Mintsoft product"
 *   C. delete an UNCREDITED emptied reservation, then "no outstanding quantity left" —
 *      the same write-then-throw shape on the delete, which predates this issue (the
 *      original `tx.wmsAsnMap.delete` was followed by a throw in the same transaction too)
 *
 * No case reaches the WMS: every refusal happens inside the reservation transaction,
 * and the listing, the connector and the HTTP primitive all throw if called anyway.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const CONNECTOR = 'mintsoft' // wms-connector-boundary-ok: o3d-zzgp: a test fixture value, not a core flow branch
const UNIT_COST = 5

const LIVE_WMS = 'o3d-zzgp r4 test: a WMS call was attempted. Mintsoft is LIVE; nothing here may reach it.'
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

let modulesReady: Promise<{
  createMintsoftTransferAsn: typeof import('@/app/actions/mintsoft-sync').createMintsoftTransferAsn
}> | null = null

/** Guard FIRST, then the application modules — nothing opens the pool before the guard. */
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
        // o3d-bhvu: the name the creators actually call for duplicate recovery. LIVE_WMS, like the rest.
        fetchMintsoftAsnsForDuplicateRecovery: async () => { throw new Error(LIVE_WMS) },
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
          createAsn: async () => { throw new Error(LIVE_WMS) },
        }),
      },
    })
    const actions = await import('@/app/actions/mintsoft-sync')
    return { createMintsoftTransferAsn: actions.createMintsoftTransferAsn }
  })()
  return modulesReady
}

/**
 * An IN_TRANSIT transfer with ONE line and a PENDING reservation already on it — the state
 * a failed push leaves behind — with the line's received quantity and the reservation
 * row's credit set by the case.
 */
async function seedPendingReservation(label: string, input: {
  lineQty: number
  qtyReceived: number
  reservedQty: number
  snapshotCredit: number
  linkProduct: boolean
}) {
  const { db } = await import('@/lib/db')
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  const tag = `ZZR4-${label}-${process.pid}-${uid}`

  const product = await db.product.create({
    data: { sku: tag, name: `zzgp r4 ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  if (input.linkProduct) {
    await db.wmsProductLink.create({
      data: { productId: product.id, connector: CONNECTOR, externalProductId: `ext-${tag}` },
      select: { id: true },
    })
  }
  const source = await db.warehouse.create({
    data: { code: `Z4${uid}S`, name: `${tag} source`, type: 'STANDARD' },
    select: { id: true },
  })
  const destination = await db.warehouse.create({
    data: { code: `Z4${uid}D`, name: `${tag} dest`, type: 'STANDARD' },
    select: { id: true },
  })
  const sourceLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: source.id,
      receivedQty: `${input.lineQty}.000000`,
      remainingQty: '0.000000',
      unitCostBase: UNIT_COST,
    },
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
          productName: `zzgp r4 ${label}`,
          qty: `${input.lineQty}.0000`,
          qtyReceived: `${input.qtyReceived}.0000`,
          costLayerSnapshot: [{ costLayerId: sourceLayer.id, qty: `${input.lineQty}.000000`, unitCostBase: `${UNIT_COST}.000000` }],
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const transferLineId = transfer.lines[0]!.id
  const connection = await db.wmsConnection.create({
    data: { connector: CONNECTOR, label: tag, active: true },
    select: { id: true },
  })
  await db.externalWmsBinding.create({
    data: {
      connectionId: connection.id,
      warehouseId: destination.id,
      connector: CONNECTOR,
      externalWarehouseId: `wh-${tag}`,
      active: true,
      stockSyncMode: 'ALIGN_TO_WMS',
      alignmentConfirmedAt: new Date(),
    },
    select: { id: true },
  })
  const reservation = await db.wmsAsnMap.create({
    data: {
      connector: CONNECTOR,
      externalAsnId: `pending:transfer:${transfer.id}:1700000000000-${uid.toLowerCase()}`,
      sourceType: 'STOCK_TRANSFER',
      sourceId: transfer.id,
      warehouseId: destination.id,
      status: 'CREATE_PENDING',
      lines: {
        create: [{
          externalAsnLineId: `pending:${transferLineId}`,
          sourceType: 'STOCK_TRANSFER_LINE',
          sourceLineId: transferLineId,
          productId: product.id,
          sku: tag,
          expectedQty: `${input.reservedQty}.0000`,
          qtyAccountedViaSnapshot: `${input.snapshotCredit}.0000`,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })

  return { db, transfer, transferLineId, asnMapId: reservation.id, asnLineMapId: reservation.lines[0]!.id }
}

async function reread(seeded: Awaited<ReturnType<typeof seedPendingReservation>>) {
  const { loadTransferLineLandedQty, requireLandedQty } = await import('@/lib/domain/inventory/transfer-landed-quantity')
  const header = await seeded.db.wmsAsnMap.findUnique({
    where: { id: seeded.asnMapId },
    select: { closedAt: true, status: true },
  })
  const line = await seeded.db.wmsAsnLineMap.findUnique({
    where: { id: seeded.asnLineMapId },
    select: { expectedQty: true, qtyAccountedViaSnapshot: true, note: true },
  })
  const transferLine = await seeded.db.stockTransferLine.findUniqueOrThrow({
    where: { id: seeded.transferLineId },
    select: { id: true, qtyReceived: true },
  })
  const landed = requireLandedQty(await loadTransferLineLandedQty(seeded.db, [transferLine]), transferLine.id)
  const openReservations = await seeded.db.wmsAsnMap.count({
    where: { sourceType: 'STOCK_TRANSFER', sourceId: seeded.transfer.id, closedAt: null },
  })
  return { header, line, landed: landed.qtyNumber, openReservations }
}

test(
  'A — a retirement followed by "nothing outstanding" is COMMITTED, not rolled back (Codex r4 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const { createMintsoftTransferAsn } = await loadModules()
    // Reserved ten; the alignment has since credited six on the reservation and four were
    // received manually. Nothing is outstanding, and the reservation holds credit — so it
    // must be RETIRED, and the operator told there is nothing to place.
    const seeded = await seedPendingReservation('none-left', {
      lineQty: 10, qtyReceived: 4, reservedQty: 10, snapshotCredit: 6, linkProduct: true,
    })
    const before = await reread(seeded)
    assert.equal(before.header?.closedAt, null, 'precondition: the reservation starts open')
    assert.equal(before.landed, 10, 'precondition: four received plus six credited')

    const result = await createMintsoftTransferAsn(seeded.transfer.id, { autoCallback: false })
    const after = await reread(seeded)
    const diagnosis = JSON.stringify({ result, after })
    console.log(`[zzgp-r4 A] ${diagnosis}`)

    assert.equal(result.success, false)
    assert.match(String(result.error), /no outstanding quantity left/i)
    // THE RETIREMENT, re-read after the action returned. WAS (01742b27): closedAt null,
    // expectedQty 10, note null — the refusal thrown inside the transaction undid it.
    assert.ok(after.header, `the credited reservation must still exist: ${diagnosis}`)
    assert.notEqual(after.header.closedAt, null, `closedAt must survive the refusal: ${diagnosis}`)
    assert.equal(Number(after.line?.expectedQty), 6, `expectedQty must be shrunk to the credit and stay shrunk: ${diagnosis}`)
    assert.match(String(after.line?.note), /retired on retry/i, `the note must survive the refusal: ${diagnosis}`)
    assert.equal(after.openReservations, 0, 'and nothing is left open for the alignment to credit again')
    assert.equal(Number(after.line?.qtyAccountedViaSnapshot), 6, 'the credit itself is untouched')
    assert.equal(after.landed, 10)
  },
)

test(
  'B — a retirement followed by "not linked to a Mintsoft product" is COMMITTED (Codex r4 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const { createMintsoftTransferAsn } = await loadModules()
    // Six credited of ten reserved, four still to come — but the product has no WMS link,
    // so the fresh reservation is refused AFTER the credited one has been retired.
    const seeded = await seedPendingReservation('unlinked', {
      lineQty: 10, qtyReceived: 0, reservedQty: 10, snapshotCredit: 6, linkProduct: false,
    })

    const result = await createMintsoftTransferAsn(seeded.transfer.id, { autoCallback: false })
    const after = await reread(seeded)
    const diagnosis = JSON.stringify({ result, after })
    console.log(`[zzgp-r4 B] ${diagnosis}`)

    assert.equal(result.success, false)
    assert.match(String(result.error), /not linked to a Mintsoft product/i)
    assert.notEqual(after.header?.closedAt ?? null, null, `closedAt must survive the refusal: ${diagnosis}`)
    assert.equal(Number(after.line?.expectedQty), 6, `expectedQty must stay shrunk to the credit: ${diagnosis}`)
    assert.match(String(after.line?.note), /retired on retry/i, `the note must survive: ${diagnosis}`)
    assert.equal(after.openReservations, 0, 'no replacement was created, and the retired one is closed')
    assert.equal(after.landed, 6)
  },
)

test(
  'C — deleting an uncredited emptied reservation, then refusing, is COMMITTED (Codex r4 HIGH-1 audit)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const { createMintsoftTransferAsn } = await loadModules()
    // All ten received manually; the reservation holds no credit, so it holds no evidence
    // and is deleted — then the operator is told there is nothing to place.
    const seeded = await seedPendingReservation('uncredited', {
      lineQty: 10, qtyReceived: 10, reservedQty: 10, snapshotCredit: 0, linkProduct: true,
    })

    const result = await createMintsoftTransferAsn(seeded.transfer.id, { autoCallback: false })
    const after = await reread(seeded)
    const diagnosis = JSON.stringify({ result, after })
    console.log(`[zzgp-r4 C] ${diagnosis}`)

    assert.equal(result.success, false)
    assert.match(String(result.error), /no outstanding quantity left/i)
    // WAS (01742b27 and before): the header was still there — the delete rolled back.
    assert.equal(after.header, null, `the uncredited reservation must actually be gone: ${diagnosis}`)
    assert.equal(after.line, null)
    assert.equal(after.landed, 10, 'and nothing it held was evidence: qtyReceived carries the ten')
  },
)
