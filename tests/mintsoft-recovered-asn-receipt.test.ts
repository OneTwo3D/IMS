import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import * as realMintsoftNs from '@/lib/connectors/mintsoft'
import { normalizeMintsoftAsnListRowForRecovery } from '@/lib/connectors/mintsoft/api/client'
import * as realConnectorFetchNs from '@/lib/security/connector-fetch'
import { loadTransferLineLandedQty, requireLandedQty } from '@/lib/domain/inventory/transfer-landed-quantity'

/**
 * o3d-bhvu ROUND 8, CODEX HIGH — A RECOVERED ASN THAT MINTSOFT HAS ALREADY BOOKED IN.
 *
 * `findRecoverableMintsoftAsn` finds the ASN a lost create left at the warehouse, and both creators
 * ADOPT it rather than creating a second. 198 of the tenant's 220 live ASNs are COMPLETE, so the ASN
 * being found in a BOOKED-IN state is the COMMON case, not the exotic one.
 *
 * WHAT WENT WRONG. `normalizeMintsoftAsnListRowForRecovery` set `status: null` — the list row's status
 * was never read — and the creators' `normalizeMintsoftAsnStatus(null)` collapsed that to `OPEN`. So a
 * COMPLETE ASN was recorded as an ASN still to arrive, and the only reconciliation the creators then ran
 * was `replayMintsoftBookedInEventsForAsn`, which re-drives receipt event rows that ALREADY EXIST. A
 * callback that was never delivered leaves no row, so nothing was replayed: IMS reported "Recovered
 * Mintsoft ASN 6117", the job SUCCEEDED, and the goods on the warehouse's shelves were in no IMS stock
 * figure and no cost layer until somebody noticed and pressed Re-check.
 *
 * WHY THIS FILE HAS A STORE AND A CREDIT RE-READ, not a set of call assertions. `status: null` is
 * UNKNOWN, and the defect is unknown being spent as the one value that means no stock is owed — so a
 * test that only asserted "the recheck was called" would pass on a fix that called it and then dropped
 * the result. Every case below re-reads the LANDED QUANTITY afterwards, through the production loader,
 * over the store as the action left it. The recheck stub models what the real
 * `processMintsoftBookedInEvent` does to those rows (it applies the delta over
 * `lastProcessedReceivedQty`); that the real one does it is
 * tests/wms-booked-in-recheck.test.ts's job, not this file's.
 *
 * NO NETWORK: the connector namespace and the connector-fetch boundary are both stubbed, and the
 * suite-wide trap (tests/no-outbound-network.cjs) refuses anything that gets past them. Mintsoft is LIVE.
 */

type AsnMapRow = {
  id: string
  connector: string
  externalAsnId: string
  sourceType: string
  sourceId: string
  warehouseId: string
  status: string
  closedAt: Date | null
  sloAlertedAt: Date | null
  eta: Date | null
  lastCallbackAt: Date | null
  createdAt: Date
  updatedAt: Date
}

type AsnLineRow = {
  id: string
  asnMapId: string
  externalAsnLineId: string
  sourceType: string
  sourceLineId: string
  productId: string
  sku: string
  expectedQty: Prisma.Decimal
  qtyAccountedViaSnapshot: Prisma.Decimal
  qtyAccountedViaReceipt: Prisma.Decimal
  lastProcessedReceivedQty: Prisma.Decimal
  note: string | null
}

type RecheckResult = {
  processed: number
  duplicates: number
  pending: number
  requiresReview: number
  failed: number
  created: boolean
}

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

const TRANSFER_ID = 'trf-1'
const ASN_MAP_ID = 'asn-1'
const PENDING_EXTERNAL_ID = `pending:transfer:${TRANSFER_ID}:1700000000000`
/** The ASN a create whose response IMS lost left at the warehouse. */
const REMOTE_ASN_ID = '6117'
const EXTERNAL_WAREHOUSE_ID = '301'

let asnMaps: AsnMapRow[] = []
let asnLines: AsnLineRow[] = []
let nextId = 0
const createAsnCalls: Array<{ lines: Array<{ sourceLineId: string; quantity: number }> }> = []
/** The raw `GET /api/ASN/List` rows duplicate recovery sees, normalized by the REAL list normalizer. */
let recoveryRows: Array<Record<string, unknown>> = []
let recoveryListings = 0
const recheckCalls: Array<{ externalAsnId: string; reason: string | undefined }> = []
const replayCalls: string[] = []
let recheckResult: RecheckResult = { processed: 1, duplicates: 0, pending: 0, requiresReview: 0, failed: 0, created: true }
let recheckThrows: Error | null = null
/** Does the stubbed recheck model the receipt actually landing? Set false to model a reconcile that did not. */
let recheckCredits = true
/** `stock_transfer_lines.qtyReceived`, which is where a WMS receipt actually lands (booked-in-service). */
let transferQtyReceived = '0'
/** How many statuses the interpretation under test was asked about, so a green run cannot examine nothing. */
let statusesExamined = 0

function seedTransfer() {
  nextId = 0
  createAsnCalls.length = 0
  recoveryListings = 0
  recheckCalls.length = 0
  replayCalls.length = 0
  recoveryRows = []
  recheckResult = { processed: 1, duplicates: 0, pending: 0, requiresReview: 0, failed: 0, created: true }
  recheckThrows = null
  recheckCredits = true
  transferQtyReceived = '0'
  asnMaps = [{
    id: ASN_MAP_ID,
    connector: 'mintsoft',
    externalAsnId: PENDING_EXTERNAL_ID,
    sourceType: 'STOCK_TRANSFER',
    sourceId: TRANSFER_ID,
    warehouseId: 'wh-1',
    status: 'CREATE_PENDING',
    closedAt: null,
    sloAlertedAt: null,
    eta: null,
    lastCallbackAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }]
  asnLines = [{
    id: 'al-tl-1',
    asnMapId: ASN_MAP_ID,
    externalAsnLineId: 'pending:tl-1',
    sourceType: 'STOCK_TRANSFER_LINE',
    sourceLineId: 'tl-1',
    productId: 'p-1',
    sku: 'SKU-1',
    expectedQty: decimal('10'),
    qtyAccountedViaSnapshot: decimal('0'),
    qtyAccountedViaReceipt: decimal('0'),
    lastProcessedReceivedQty: decimal('0'),
    note: null,
  }]
}

/** One live-shaped `GET /api/ASN/List` row for the ASN the lost create left behind. */
function remoteRow(status: { name?: string | null; id?: number | null }): Record<string, unknown> {
  return {
    ID: Number(REMOTE_ASN_ID),
    POReference: 'TRF-1',
    WarehouseId: Number(EXTERNAL_WAREHOUSE_ID),
    ...(status.name === undefined ? {} : { ASNStatus: status.name === null ? null : { Name: status.name } }),
    ...(status.id === undefined ? {} : { ASNStatusId: status.id }),
    LastUpdated: '2026-02-01T00:00:00Z',
    Items: [{
      ID: 'ri-1',
      SourceLineId: 'tl-1',
      ProductId: 263881,
      SKU: 'SKU-1',
      QuantityExpected: 10,
    }],
  }
}

function transferRow() {
  return {
    id: TRANSFER_ID,
    reference: 'TRF-1',
    status: 'IN_TRANSIT',
    toWarehouseId: 'wh-1',
    toWarehouse: { code: 'DEST' },
    lines: [{ id: 'tl-1', productId: 'p-1', sku: 'SKU-1', qty: decimal('10'), qtyReceived: decimal(transferQtyReceived) }],
  }
}

function linesOf(asnMapId: string) {
  return asnLines.filter((row) => row.asnMapId === asnMapId).sort((left, right) => left.id.localeCompare(right.id))
}

function deleteAsnMapById(id: string): number {
  const before = asnMaps.length
  asnMaps = asnMaps.filter((row) => row.id !== id)
  asnLines = asnLines.filter((row) => row.asnMapId !== id)
  return before - asnMaps.length
}

function isZero(value: Prisma.Decimal): boolean {
  return value.equals(0)
}

const wmsAsnMapDelegate = {
  findFirst: async (args: { where: Record<string, unknown> }) => {
    const where = args.where
    const candidates = asnMaps.filter((row) => (
      (where.connector === undefined || row.connector === where.connector)
      && row.sourceType === where.sourceType
      && row.sourceId === where.sourceId
      && (where.closedAt !== null || row.closedAt === null)
    ))
    const status = where.status as { not?: string } | string | undefined
    const matched = candidates.filter((row) => {
      if (typeof status === 'string') return row.status === status
      if (status && typeof status === 'object' && status.not) return row.status !== status.not
      return true
    }).filter((row) => {
      const externalAsnId = where.externalAsnId as { startsWith?: string } | undefined
      return externalAsnId?.startsWith ? row.externalAsnId.startsWith(externalAsnId.startsWith) : true
    })
    const row = matched[0]
    if (!row) return null
    return { id: row.id, externalAsnId: row.externalAsnId, status: row.status, updatedAt: row.updatedAt, lines: linesOf(row.id) }
  },
  findUnique: async (args: { where: Record<string, unknown> }) => {
    if ('connector_externalAsnId' in args.where) {
      const key = args.where.connector_externalAsnId as { connector: string; externalAsnId: string }
      const row = asnMaps.find((candidate) => candidate.connector === key.connector && candidate.externalAsnId === key.externalAsnId)
      return row ? { id: row.id, externalAsnId: row.externalAsnId, status: row.status, lines: linesOf(row.id) } : null
    }
    const row = asnMaps.find((candidate) => candidate.id === args.where.id)
    return row ? { id: row.id, externalAsnId: row.externalAsnId, status: row.status, lines: linesOf(row.id) } : null
  },
  findMany: async (args?: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {}
    const ids = (where.externalAsnId as { in?: string[] } | undefined)?.in
    return asnMaps
      .filter((row) => (ids ? ids.includes(row.externalAsnId) : true))
      .map((row) => ({
        sourceId: row.sourceId,
        id: row.id,
        externalAsnId: row.externalAsnId,
        status: row.status,
        createdAt: row.createdAt,
        lastCallbackAt: row.lastCallbackAt,
        closedAt: row.closedAt,
        lines: linesOf(row.id).map((line) => ({ expectedQty: line.expectedQty, qtyAccountedViaReceipt: line.qtyAccountedViaReceipt })),
      }))
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = asnMaps.find((candidate) => candidate.id === args.where.id)
    assert.ok(row, `no ASN map ${args.where.id}`)
    if ('status' in args.data) row.status = String(args.data.status)
    if ('closedAt' in args.data) row.closedAt = args.data.closedAt as Date | null
    if ('sloAlertedAt' in args.data) row.sloAlertedAt = args.data.sloAlertedAt as Date | null
    if ('eta' in args.data) row.eta = args.data.eta as Date | null
    if ('externalAsnId' in args.data) row.externalAsnId = String(args.data.externalAsnId)
    row.updatedAt = new Date()
    return { id: row.id }
  },
  updateMany: async (args: { where: Record<string, unknown>; data: { status?: string } }) => {
    let count = 0
    for (const row of asnMaps) {
      if (args.where.id && row.id !== args.where.id) continue
      if (args.where.status && row.status !== args.where.status) continue
      if (args.data.status) row.status = args.data.status
      count += 1
    }
    return { count }
  },
  delete: async (args: { where: { id: string } }) => {
    assert.equal(deleteAsnMapById(args.where.id), 1, `delete hit no ASN map ${args.where.id}`)
    return { id: args.where.id }
  },
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    const id = String(args.where.id)
    if (args.where.lines && linesOf(id).some((line) => (
      !isZero(line.qtyAccountedViaSnapshot) || !isZero(line.qtyAccountedViaReceipt) || !isZero(line.lastProcessedReceivedQty)
    ))) {
      return { count: 0 }
    }
    return { count: deleteAsnMapById(id) }
  },
  create: async (args: { data: Record<string, unknown> }) => {
    nextId += 1
    const id = `asn-new-${nextId}`
    asnMaps.push({
      id,
      connector: String(args.data.connector),
      externalAsnId: String(args.data.externalAsnId),
      sourceType: String(args.data.sourceType),
      sourceId: String(args.data.sourceId),
      warehouseId: String(args.data.warehouseId),
      status: String(args.data.status),
      closedAt: null,
      sloAlertedAt: null,
      eta: (args.data.eta as Date | null) ?? null,
      lastCallbackAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    for (const line of (args.data.lines as { create: Array<Record<string, unknown>> }).create) {
      nextId += 1
      asnLines.push({
        id: `al-new-${nextId}`,
        asnMapId: id,
        externalAsnLineId: String(line.externalAsnLineId),
        sourceType: String(line.sourceType),
        sourceLineId: String(line.sourceLineId),
        productId: String(line.productId),
        sku: String(line.sku),
        expectedQty: decimal(String(line.expectedQty)),
        qtyAccountedViaSnapshot: decimal(0),
        qtyAccountedViaReceipt: decimal(0),
        lastProcessedReceivedQty: decimal(0),
        note: null,
      })
    }
    return { id, lines: linesOf(id) }
  },
}

const wmsAsnLineMapDelegate = {
  findMany: async (args: { where: Record<string, unknown> }) => {
    if ('sourceLineId' in args.where || 'sourceType' in args.where) {
      const ids = args.where.sourceLineId as { in?: string[] } | string | undefined
      const wanted = typeof ids === 'string' ? [ids] : ids?.in ?? []
      return asnLines.filter((row) => wanted.includes(row.sourceLineId))
    }
    return asnLines.filter((row) => row.asnMapId === args.where.asnMapId)
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = asnLines.find((candidate) => candidate.id === args.where.id)
    assert.ok(row, `no ASN line ${args.where.id}`)
    if (args.data.expectedQty !== undefined) row.expectedQty = decimal(String(args.data.expectedQty))
    if (typeof args.data.externalAsnLineId === 'string') row.externalAsnLineId = args.data.externalAsnLineId
    if (typeof args.data.note === 'string') row.note = args.data.note
    return row
  },
  create: async (args: { data: Record<string, unknown> }) => {
    nextId += 1
    const row: AsnLineRow = {
      id: `al-new-${nextId}`,
      asnMapId: String(args.data.asnMapId),
      externalAsnLineId: String(args.data.externalAsnLineId),
      sourceType: String(args.data.sourceType),
      sourceLineId: String(args.data.sourceLineId),
      productId: String(args.data.productId),
      sku: String(args.data.sku),
      expectedQty: decimal(String(args.data.expectedQty)),
      qtyAccountedViaSnapshot: decimal(0),
      qtyAccountedViaReceipt: decimal(0),
      lastProcessedReceivedQty: decimal(0),
      note: null,
    }
    asnLines.push(row)
    return row
  },
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    const before = asnLines.length
    const keep = (args.where.sourceLineId as { notIn?: string[] } | undefined)?.notIn
    asnLines = asnLines.filter((row) => {
      if (row.asnMapId !== args.where.asnMapId) return true
      if (keep && keep.includes(row.sourceLineId)) return true
      if (args.where.qtyAccountedViaSnapshot === 0 && !isZero(row.qtyAccountedViaSnapshot)) return true
      if (args.where.qtyAccountedViaReceipt === 0 && !isZero(row.qtyAccountedViaReceipt)) return true
      if (args.where.lastProcessedReceivedQty === 0 && !isZero(row.lastProcessedReceivedQty)) return true
      return false
    })
    return { count: before - asnLines.length }
  },
}

const db: Record<string, unknown> = {
  wmsSyncJob: { create: async () => ({ id: 'job-1' }), update: async () => ({ id: 'job-1' }) },
  stockTransfer: { findUnique: async () => transferRow(), findMany: async () => [transferRow()] },
  wmsAsnMap: wmsAsnMapDelegate,
  wmsAsnLineMap: wmsAsnLineMapDelegate,
  product: {
    findMany: async (args: { where: { id: { in: string[] } } }) => args.where.id.in.map((id) => ({
      id,
      wmsProductLinks: [{ externalProductId: `ext-${id}`, id: `link-${id}` }],
    })),
  },
  externalWmsBinding: {
    findFirst: async () => ({ externalWarehouseId: EXTERNAL_WAREHOUSE_ID }),
    findMany: async () => [{ warehouseId: 'wh-1', externalWarehouseId: EXTERNAL_WAREHOUSE_ID }],
  },
  wmsSyncLog: { createMany: async () => ({ count: 1 }) },
  $queryRaw: async () => [{ id: TRANSFER_ID }],
  $transaction: async (arg: unknown) => {
    if (typeof arg !== 'function') return Promise.all(arg as unknown[])
    const snapshot = { asnMaps: asnMaps.map((row) => ({ ...row })), asnLines: asnLines.map((row) => ({ ...row })), nextId }
    try {
      return await (arg as (tx: unknown) => Promise<unknown>)(db)
    } catch (error) {
      asnMaps = snapshot.asnMaps
      asnLines = snapshot.asnLines
      nextId = snapshot.nextId
      throw error
    }
  },
}

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    ...(realConnectorFetchNs as unknown as Record<string, unknown>),
    connectorFetch: async (input: string | URL) => {
      throw new Error(`o3d-bhvu: an HTTP request reached the connector boundary from a unit test (${String(input)}); Mintsoft is LIVE`)
    },
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
    requireApiFreshAdmin: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }),
  },
})
const activityEntries: Array<{ action: string; level?: string; description: string }> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string }) => { activityEntries.push(entry) },
    logActivityPersisted: async () => true,
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
mock.module('@/lib/integration-plugins', {
  namedExports: { isIntegrationPluginEnabled: async () => true, getIntegrationPluginState: async () => ({ enabled: true }) },
})
mock.module('@/lib/public-app-url', { namedExports: { getPublicAppUrl: async () => 'https://ims.example.com' } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/jobs/wms/process-mintsoft-booked-in-event', {
  namedExports: {
    replayMintsoftBookedInEventsForAsn: async (externalAsnId: string) => {
      replayCalls.push(externalAsnId)
      // THE DEFECT'S OTHER HALF, modelled exactly: a callback that was never delivered left no row,
      // so there is nothing for the replay to re-drive and it credits nothing.
      return { processed: 0, duplicates: 0, pending: 0, requiresReview: 0, failed: 0 }
    },
    enqueueMintsoftBookedInRecheckForAsn: async (externalAsnId: string, options: { reason?: string } = {}) => {
      recheckCalls.push({ externalAsnId, reason: options.reason })
      if (recheckThrows) throw recheckThrows
      if (recheckCredits) {
        // What the real `processMintsoftBookedInEvent` does to these rows: it applies the delta over
        // `lastProcessedReceivedQty` and credits the receipt arm. Modelled so a fix that enqueues the
        // recheck and then ignores its result cannot pass the landed-quantity re-read below.
        for (const row of asnLines.filter((line) => asnMaps.some((map) => map.id === line.asnMapId && map.externalAsnId === externalAsnId))) {
          row.lastProcessedReceivedQty = decimal(row.expectedQty.toString())
          row.qtyAccountedViaReceipt = decimal(row.expectedQty.toString())
          // `reconcileBookedInQuantities` folds a WMS receipt into stock_transfer_lines.qtyReceived,
          // which is the column the landed-quantity definition reads.
          transferQtyReceived = row.expectedQty.toString()
        }
      }
      return recheckResult
    },
  },
})
mock.module('@/lib/connectors/mintsoft', {
  namedExports: {
    ...(realMintsoftNs as unknown as Record<string, unknown>),
    fetchMintsoftAsnsForDuplicateRecovery: async () => {
      recoveryListings += 1
      // THROUGH THE REAL LIST NORMALIZER. The status the creators act on is whatever that function
      // puts on the ref, so a test that built the ref by hand would be testing its own fixture.
      return recoveryRows.map((row) => {
        statusesExamined += 1
        return normalizeMintsoftAsnListRowForRecovery(row)
      })
    },
    fetchMintsoftAsns: async () => { throw new Error('o3d-bhvu: fetchMintsoftAsns is not the creators’ listing') },
    getMintsoftSettings: async () => ({ mintsoft_webhook_secret: 'whsec' }),
  },
})
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: () => ({
      id: 'mintsoft',
      name: 'Mintsoft',
      createAsn: async (input: { lines: Array<{ sourceLineId: string; quantity: number }> }) => {
        createAsnCalls.push({ lines: input.lines })
        return {
          externalAsnId: '9001',
          status: 'NEW',
          lines: input.lines.map((line, index) => ({ externalLineId: `remote-${index}`, sourceLineId: line.sourceLineId, raw: null })),
        }
      },
    }),
    isWmsConnectorConfigured: async () => true,
  },
})

async function loadActions() {
  return import('@/app/actions/mintsoft-sync')
}

async function landedNow(): Promise<number> {
  const landed = await loadTransferLineLandedQty(db as never, [{ id: 'tl-1', qtyReceived: decimal(transferQtyReceived) }])
  return requireLandedQty(landed, 'tl-1').qtyNumber
}

function adoptedMap(): AsnMapRow | undefined {
  return asnMaps.find((row) => row.externalAsnId === REMOTE_ASN_ID)
}

// ---------------------------------------------------------------------------

test('rig: the recovery listing really does normalize a live-shaped row into the ASN the reservation expects', async () => {
  seedTransfer()
  const normalized = normalizeMintsoftAsnListRowForRecovery(remoteRow({ name: 'COMPLETE', id: 6 }))
  assert.equal(normalized.externalAsnId, REMOTE_ASN_ID)
  assert.equal(normalized.lines.length, 1, 'the one item must read back keyed by SourceLineId')
  assert.equal(normalized.lines[0]!.sourceLineId, 'tl-1')
  const { findRecoverableMintsoftAsn } = await import('@/lib/connectors/mintsoft/api/asn-recovery')
  const recovered = findRecoverableMintsoftAsn([normalized], {
    reference: 'TRF-1',
    externalWarehouseId: EXTERNAL_WAREHOUSE_ID,
    lines: [{ sourceLineId: 'tl-1', expectedQty: 10 }],
    mapKnowledge: { kind: 'readable', mappedExternalAsnIds: new Set() },
  })
  assert.ok(recovered, 'precondition for every case below: the matcher ADOPTS this row')
  assert.equal(recovered.externalAsnId, REMOTE_ASN_ID)
})

test('o3d-bhvu r8: a recovered ASN Mintsoft has already booked in is reconciled, not recorded as still to arrive', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  seedTransfer()
  recoveryRows = [remoteRow({ name: 'COMPLETE', id: 6 })]
  const examinedBefore = statusesExamined

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  // PRECONDITIONS, so a green run cannot be "recovery never happened".
  assert.equal(recoveryListings, 1, 'duplicate recovery listed once')
  assert.equal(statusesExamined - examinedBefore, 1, 'and exactly one remote status was put through the normalizer')
  assert.equal(createAsnCalls.length, 0, 'nothing may be pushed: the ASN is already at the warehouse')
  const map = adoptedMap()
  assert.ok(map, `the ASN must be adopted, saw ${asnMaps.map((row) => row.externalAsnId).join(', ')}`)

  // THE FINDING, in one line so the before/after is one diff. WAS:
  //   { status: 'OPEN', recheckesEnqueued: 0, landedQty: 0, success: true }
  assert.deepEqual(
    { status: map.status, rechecksEnqueued: recheckCalls.length, landedQty: await landedNow(), success: result.success },
    { status: 'BOOKED_IN', rechecksEnqueued: 1, landedQty: 10, success: true },
    'a recovered ASN Mintsoft has booked in must end with its receipt accounted for',
  )
  assert.equal(map.status, 'BOOKED_IN', 'the ASN Mintsoft booked in must not be recorded as OPEN')
  assert.deepEqual(recheckCalls.map((call) => call.externalAsnId), [REMOTE_ASN_ID], 'a booked-in recheck must be enqueued for it')
  assert.equal(await landedNow(), 10, 'and the goods on the shelf must end up in an IMS receipt figure')
  assert.equal(result.success, true, `recovery should succeed once reconciled: ${result.error ?? ''}`)
})

test('o3d-bhvu r8: a recovered ASN that is still awaiting delivery is left OPEN and no recheck is invented', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  seedTransfer()
  recoveryRows = [remoteRow({ name: 'AWAITINGDELIVERY', id: 3 })]

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(result.success, true, `recovery should succeed: ${result.error ?? ''}`)
  const map = adoptedMap()
  assert.ok(map, 'the ASN must be adopted')
  assert.equal(map.status, 'OPEN', 'an ASN still on its way is OPEN')
  assert.equal(recheckCalls.length, 0, 'and no receipt is owed, so nothing is reconciled')
  assert.equal(await landedNow(), 0, 'nothing has landed')
  assert.deepEqual(replayCalls, [REMOTE_ASN_ID], 'the lost-callback replay still runs, as it did before')
})

test('o3d-bhvu r8: a booked-in recovery whose reconciliation cannot complete fails visibly', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  seedTransfer()
  recoveryRows = [remoteRow({ name: 'COMPLETE', id: 6 })]
  // The recheck ran and reconciled nothing: no receipt row, no delta, no stock.
  recheckCredits = false
  recheckResult = { processed: 0, duplicates: 0, pending: 0, requiresReview: 0, failed: 0, created: false }

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(recheckCalls.length, 1, 'precondition: the recheck was attempted')
  assert.equal(await landedNow(), 0, 'precondition: nothing was reconciled')
  assert.equal(result.success, false, 'a recovery whose receipt is unaccounted for must NOT report success')
  assert.match(String(result.error), new RegExp(REMOTE_ASN_ID), 'and the error must name the ASN')
  // `closedAt` means the receipt is ACCOUNTED FOR: it removes the ASN from the alignment candidates, the
  // overdue watchdog and the post-maintenance sweep. Closing it on the warehouse's status alone would shut
  // the only populations left that could catch this.
  const unreconciled = adoptedMap()
  assert.ok(unreconciled, 'the ASN is still mapped, so no duplicate can go out')
  assert.equal(unreconciled.closedAt, null, 'and it must stay in every open-ASN population until its receipt is applied')
})

test('o3d-bhvu r8: a booked-in recovery whose reconciliation is left pending says so instead of claiming success silently', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  seedTransfer()
  recoveryRows = [remoteRow({ name: 'COMPLETE', id: 6 })]
  recheckCredits = false
  recheckResult = { processed: 0, duplicates: 0, pending: 1, requiresReview: 0, failed: 0, created: true }

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(recheckCalls.length, 1, 'precondition: the recheck was attempted')
  // A pending event row IS a visible obligation — the sweeper retries it and the inbox shows it — so this
  // is allowed to succeed, but it may not be silent about it.
  assert.ok(result.success === false || /pending|retry|sweeper/i.test(String(result.message ?? '')),
    `a pending reconciliation must be surfaced, saw success=${result.success} message=${String(result.message ?? '')}`)
})

test('o3d-bhvu r8: a booked-in recovery whose recheck THROWS fails closed', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  seedTransfer()
  recoveryRows = [remoteRow({ name: 'COMPLETE', id: 6 })]
  recheckThrows = new Error('receipt event store is down')

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(recheckCalls.length, 1, 'precondition: the recheck was attempted')
  assert.equal(await landedNow(), 0, 'precondition: nothing was reconciled')
  assert.equal(result.success, false, 'a recheck that threw leaves no pending row, so it cannot be a warning')
})

test('o3d-bhvu r8: an unreadable remote status is UNKNOWN, and unknown is not OPEN', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  for (const status of [
    { name: undefined, id: undefined },
    { name: null, id: undefined },
    { name: 'SOME-STATUS-MINTSOFT-ADDED-LATER', id: undefined },
    { name: undefined, id: 99 },
  ] as const) {
    seedTransfer()
    recoveryRows = [remoteRow(status)]

    const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

    assert.equal(createAsnCalls.length, 0, `${JSON.stringify(status)}: a second ASN must never be created`)
    assert.equal(result.success, false, `${JSON.stringify(status)}: an unreadable status must refuse, not default to OPEN`)
    assert.equal(
      asnMaps.filter((row) => row.status === 'OPEN').length,
      0,
      `${JSON.stringify(status)}: nothing may be recorded as OPEN on an unreadable status`,
    )
  }
})

test('o3d-bhvu r8: every one of Mintsoft’s 13 ASN statuses is classified, and the booked-in ones are not the open ones', async () => {
  const { MINTSOFT_ASN_STATUSES, interpretMintsoftWireAsnStatus } = await import('@/lib/connectors/mintsoft/api/asn-status')
  // The 13 statuses GET /api/ASN/Statuses served live on 2026-09-24 (recorded on bd o3d-vcw8).
  const live: Array<[number, string]> = [
    [1, 'NEW'], [2, 'AWAITNGAPPROVAL'], [3, 'AWAITINGDELIVERY'], [4, 'BOOKEDIN'], [5, 'DISCREPANCY'],
    [6, 'COMPLETE'], [7, 'PARTIALLYBOOKED'], [8, 'BOOKEDIN-PARTIAL'], [9, 'DELIVERED'], [10, 'SHIPPED'],
    [11, 'AWAITINGDELIVERY_LATE'], [12, 'AWAITINGPUTAWAY'], [13, 'ROBOTPUTAWAY'],
  ]
  assert.equal(MINTSOFT_ASN_STATUSES.length, live.length, 'the table holds exactly the statuses Mintsoft serves')
  let examined = 0
  for (const [id, name] of live) {
    const fact = MINTSOFT_ASN_STATUSES.find((candidate) => candidate.id === id)
    assert.ok(fact, `status ${id} ${name} must be in the table`)
    assert.equal(fact.name, name, `status ${id} must be named as Mintsoft names it`)
    const state = interpretMintsoftWireAsnStatus(name)
    assert.equal(state.kind, 'known', `${name} must be classified`)
    examined += 1
  }
  assert.equal(examined, 13, 'all thirteen statuses were examined, not a subset')

  // THE DISCRIMINATION ITSELF: these two sets must not be the same set, or the classification is a no-op.
  const owesReceipt = live.filter(([, name]) => {
    const state = interpretMintsoftWireAsnStatus(name)
    return state.kind === 'known' && state.receiptMayHaveHappened
  }).map(([, name]) => name)
  const owesNothing = live.filter(([, name]) => {
    const state = interpretMintsoftWireAsnStatus(name)
    return state.kind === 'known' && !state.receiptMayHaveHappened
  }).map(([, name]) => name)
  assert.ok(owesReceipt.length > 0, `some statuses owe a receipt, saw ${owesReceipt.join(', ')}`)
  assert.ok(owesNothing.length > 0, `and some owe none, saw ${owesNothing.join(', ')}`)
  assert.equal(owesReceipt.length + owesNothing.length, 13)
  for (const name of ['COMPLETE', 'BOOKEDIN', 'PARTIALLYBOOKED', 'BOOKEDIN-PARTIAL', 'DISCREPANCY']) {
    assert.ok(owesReceipt.includes(name), `${name} owes a receipt reconciliation`)
  }
  for (const name of ['NEW', 'AWAITINGDELIVERY', 'SHIPPED']) {
    assert.ok(owesNothing.includes(name), `${name} owes none`)
  }
  assert.equal(interpretMintsoftWireAsnStatus(null).kind, 'unknown', 'no status is unknown, not open')
  assert.equal(interpretMintsoftWireAsnStatus('NOT-A-STATUS').kind, 'unknown', 'and so is one nobody wired up')
})

test('o3d-bhvu r8: the post-create read-back reads the status too, from the live ASNStatus OBJECT', async () => {
  // THE SAME COLLAPSE ON THE CREATE PATH. `ASN_STATUS_KEYS` looked for `status`/`Status`/`asnStatus`/
  // `AsnStatus` STRINGS; live Mintsoft serves `ASNStatus` as an OBJECT with a `Name`, plus a numeric
  // `ASNStatusId` (ASN 6114, read live 2026-09-24, recorded on bd o3d-btiw). So every ASN read back by id
  // arrived with `status: null` as well.
  const { normalizeMintsoftAsnFetchByIdResult } = await import('@/lib/connectors/mintsoft/api/client')
  const body: Record<string, unknown> = {
    ID: 6114,
    POReference: 'POQ461',
    WarehouseId: 6,
    ASNStatusId: 3,
    ASNStatus: { Name: 'AWAITINGDELIVERY', Colour: 'blue', TextColour: null, ID: 3 },
    Items: [{
      ID: 57449, ASNId: 6114, ProductId: 504073, SKU: '93736554251',
      QuantityExpected: 20, QuantityReceieved: 0, QuantityBooked: 0, OnOrder: 20,
      SourceLineId: 'cm1abcdefghijklmnop',
    }],
  }

  const fromObject = normalizeMintsoftAsnFetchByIdResult('6114', { status: 200, data: body })
  assert.ok(fromObject, 'the live body must normalize')
  assert.equal(fromObject.status, 'AWAITINGDELIVERY', 'the status comes out of the ASNStatus object, not a string key')

  const { ASNStatus: _dropped, ...withoutObject } = body
  const fromId = normalizeMintsoftAsnFetchByIdResult('6114', { status: 200, data: withoutObject })
  assert.ok(fromId, 'and a body carrying only ASNStatusId must still normalize')
  assert.equal(fromId.status, 'AWAITINGDELIVERY', 'ASNStatusId 3 resolves through the live status table')

  const { ASNStatusId: _alsoDropped, ...withNeither } = withoutObject
  const fromNothing = normalizeMintsoftAsnFetchByIdResult('6114', { status: 200, data: withNeither })
  assert.ok(fromNothing)
  assert.equal(fromNothing.status, null, 'and a body carrying neither reads as unknown, which the creators refuse')
})

test('rig non-vacuity: the fake recheck is what credits the receipt, and without it the landed quantity stays zero', async () => {
  // If this were not so, the booked-in case above could pass on a fix that never reconciled anything.
  seedTransfer()
  assert.equal(await landedNow(), 0, 'nothing credited to begin with')
  const { enqueueMintsoftBookedInRecheckForAsn } = await import('@/lib/jobs/wms/process-mintsoft-booked-in-event')
  asnMaps[0]!.externalAsnId = REMOTE_ASN_ID
  await enqueueMintsoftBookedInRecheckForAsn(REMOTE_ASN_ID, { reason: 'rig' })
  assert.equal(await landedNow(), 10, 'the stub credits the receipt the way the real processor does')

  seedTransfer()
  asnMaps[0]!.externalAsnId = REMOTE_ASN_ID
  recheckCredits = false
  await enqueueMintsoftBookedInRecheckForAsn(REMOTE_ASN_ID, { reason: 'rig' })
  assert.equal(await landedNow(), 0, 'and with crediting off it does not, so the assertion can fail')
})

// ---------------------------------------------------------------------------
// o3d-bhvu ROUND 9, CODEX HIGH — ONE INTERPRETER SERVED TWO VOCABULARIES.
//
// Round 8 put the 13 statuses `GET /api/ASN/Statuses` serves into a table and refused anything outside
// it. But the same function also consulted a SECOND table of IMS's OWN `WmsAsnStatus` names, so a remote
// `ASNStatus.Name` that happens to spell an IMS name — `OPEN` above all — was accepted as KNOWN, recorded
// as OPEN and skipped the receipt recheck, with an `ASNStatusId` nobody recognises sitting right beside it.
// A remote value borrowed the local meaning. These tests enumerate IMS's vocabulary from the Prisma enum
// rather than naming `OPEN` alone, so a sixth IMS status is covered the day it is added.
// ---------------------------------------------------------------------------

async function imsOnlyStatusNames(): Promise<string[]> {
  const { WmsAsnStatus } = await import('@/app/generated/prisma/enums')
  const { MINTSOFT_ASN_STATUSES } = await import('@/lib/connectors/mintsoft/api/asn-status')
  const wire = new Set<string>(MINTSOFT_ASN_STATUSES.map((fact) => fact.name))
  assert.equal(wire.size, 13, 'precondition: the live table is the 13 statuses Mintsoft published')
  const imsOnly = Object.values(WmsAsnStatus).filter((name) => !wire.has(name))
  assert.ok(imsOnly.length >= 5, `precondition: IMS has status names of its own, saw ${imsOnly.join(', ')}`)
  return imsOnly
}

test('o3d-bhvu r9: not one of IMS’s own status names is resolvable as a status Mintsoft served', async () => {
  const { interpretMintsoftWireAsnStatus } = await import('@/lib/connectors/mintsoft/api/asn-status')
  const imsOnly = await imsOnlyStatusNames()
  const accepted: Array<{ name: string; state: unknown }> = []
  for (const name of imsOnly) {
    const state = interpretMintsoftWireAsnStatus(name)
    if (state.kind !== 'unknown') accepted.push({ name, state })
  }
  console.log(`# r9: examined ${imsOnly.length} IMS-only names (${imsOnly.join(', ')}); ${accepted.length} resolved as remote`)
  assert.deepEqual(accepted, [], 'an IMS-only name must never resolve against Mintsoft’s table')
})

test('o3d-bhvu r9: a recovered ASN whose remote status is an IMS-only name refuses, for EVERY such name', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  const imsOnly = await imsOnlyStatusNames()
  const observed: Array<Record<string, unknown>> = []
  for (const name of imsOnly) {
    seedTransfer()
    recoveryRows = [remoteRow({ name, id: 99 })]
    const examinedBefore = statusesExamined
    const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })
    assert.equal(statusesExamined - examinedBefore, 1, `${name}: precondition — the remote row really was read`)
    assert.equal(createAsnCalls.length, 0, `${name}: a second ASN must never be created`)
    observed.push({
      name,
      success: result.success,
      recorded: adoptedMap()?.status ?? null,
      rechecks: recheckCalls.length,
      landed: await landedNow(),
    })
  }
  console.log(`# r9 e2e: examined ${observed.length} IMS-only names: ${JSON.stringify(observed)}`)
  assert.deepEqual(
    observed,
    imsOnly.map((name) => ({ name, success: false, recorded: null, rechecks: 0, landed: 0 })),
    'an IMS-only name arriving from Mintsoft is an UNREADABLE remote status: refuse, record nothing',
  )
})

test('o3d-bhvu r9: Name and ASNStatusId disagreeing is unknown, not a precedence contest', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  const cases = [
    { label: 'both in the table, naming different statuses', row: { name: 'COMPLETE', id: 3 }, refuses: true },
    { label: 'name in the table, id outside it', row: { name: 'AWAITINGDELIVERY', id: 99 }, refuses: true },
    { label: 'name outside the table, id inside it', row: { name: 'MINTSOFT-ADDED-THIS', id: 6 }, refuses: true },
    { label: 'control: both present and agreeing', row: { name: 'COMPLETE', id: 6 }, refuses: false },
  ] as const
  const observed: Array<Record<string, unknown>> = []
  for (const entry of cases) {
    seedTransfer()
    recoveryRows = [remoteRow(entry.row)]
    const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })
    observed.push({ label: entry.label, refused: result.success === false, recorded: adoptedMap()?.status ?? null })
  }
  console.log(`# r9 disagreement: examined ${observed.length} cases: ${JSON.stringify(observed)}`)
  assert.deepEqual(
    observed,
    cases.map((entry) => ({
      label: entry.label,
      refused: entry.refuses,
      recorded: entry.refuses ? null : 'BOOKED_IN',
    })),
    'every signal present must resolve, and all of them must name the same status — otherwise unknown',
  )
})

test('o3d-bhvu r9: BOTH connector ASN readers resolve Mintsoft’s vocabulary only — the list scan and the by-id read-back', async () => {
  // A GUARD FIXED IN ONE READER AND LEFT WRONG IN ANOTHER is what Codex has caught on every round of this
  // branch, so this walks both readers over the SAME cases rather than trusting that they share a helper.
  const { normalizeMintsoftAsnFetchByIdResult } = await import('@/lib/connectors/mintsoft/api/client')
  const { MINTSOFT_ASN_STATUS_UNREADABLE_MARKER, MINTSOFT_ASN_STATUSES, interpretMintsoftWireAsnStatus }
    = await import('@/lib/connectors/mintsoft/api/asn-status')
  const imsOnly = await imsOnlyStatusNames()

  const byIdStatus = (row: Record<string, unknown>): string | null => {
    const normalized = normalizeMintsoftAsnFetchByIdResult(REMOTE_ASN_ID, { status: 200, data: row })
    assert.ok(normalized, 'precondition: the by-id body must normalize at all')
    return normalized.status
  }
  const byListStatus = (row: Record<string, unknown>): string | null =>
    normalizeMintsoftAsnListRowForRecovery(row).status

  let readerPairsExamined = 0
  for (const name of [...imsOnly, 'SOMETHING-MINTSOFT-ADDED-LATER']) {
    for (const [label, read] of [['list scan', byListStatus], ['by-id read-back', byIdStatus]] as const) {
      const status = read(remoteRow({ name, id: 99 }))
      assert.ok(status, `${label}/${name}: the reader must say WHY, not flatten to null`)
      assert.ok(
        status.startsWith(MINTSOFT_ASN_STATUS_UNREADABLE_MARKER),
        `${label}/${name}: a name outside Mintsoft’s table must come back marked unresolvable, saw ${status}`,
      )
      assert.equal(
        interpretMintsoftWireAsnStatus(status).kind,
        'unknown',
        `${label}/${name}: and the marked string must interpret as unknown`,
      )
      readerPairsExamined += 1
    }
  }
  // AND THE CONTROL, in the same loop shape: a real Mintsoft status still reads through both readers.
  for (const [label, read] of [['list scan', byListStatus], ['by-id read-back', byIdStatus]] as const) {
    const status = read(remoteRow({ name: 'COMPLETE', id: 6 }))
    assert.equal(status, 'COMPLETE', `${label}: a status Mintsoft really serves must still read`)
    assert.equal(interpretMintsoftWireAsnStatus(status).kind, 'known', `${label}: and interpret`)
    readerPairsExamined += 1
  }
  console.log(`# r9 readers: examined ${readerPairsExamined} reader/status pairs across 2 readers`)
  assert.equal(readerPairsExamined, (imsOnly.length + 1) * 2 + 2, 'both readers were walked over every case')

  // THE MARKER CANNOT COLLIDE WITH A STATUS NAME. Universal, not existential.
  for (const fact of MINTSOFT_ASN_STATUSES) {
    assert.ok(
      !fact.name.startsWith(MINTSOFT_ASN_STATUS_UNREADABLE_MARKER) && !MINTSOFT_ASN_STATUS_UNREADABLE_MARKER.startsWith(fact.name),
      `${fact.name} must not be confusable with the unresolvable marker`,
    )
  }
})

test('o3d-bhvu r9: the refusal tells the operator WHICH of Mintsoft’s status fields disagreed', async () => {
  // A refusal that says only "cannot be interpreted" sends the operator to Mintsoft with nothing to look
  // at, and the whole point of a disagreement is that the wire shape is not what we think.
  const { createMintsoftTransferAsn } = await loadActions()
  seedTransfer()
  recoveryRows = [remoteRow({ name: 'COMPLETE', id: 3 })]

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(result.success, false, 'precondition: a disagreement refuses')
  const error = String(result.error)
  assert.match(error, /DISAGREE/, `the refusal must say the fields disagree, saw: ${error}`)
  assert.match(error, /COMPLETE/, 'and name what the name field said')
  assert.match(error, /AWAITINGDELIVERY/, 'and what the id field said')
  assert.equal(
    error.includes('MINTSOFT_ASN_STATUS_UNREADABLE'),
    false,
    'the marker is plumbing and must not reach the operator’s message',
  )
})

test('o3d-bhvu r9: readMintsoftAsnWireStatus distinguishes absent, unreadable and resolved, and every signal counts', async () => {
  const { readMintsoftAsnWireStatus } = await import('@/lib/connectors/mintsoft/api/asn-status')
  const cases: Array<[string, Record<string, unknown>, 'absent' | 'unreadable' | 'resolved']> = [
    ['nothing at all', { ID: 1 }, 'absent'],
    ['a null status object', { ASNStatus: null }, 'absent'],
    ['a blank status string', { Status: '   ' }, 'absent'],
    ['the live three-signal shape', { ASNStatus: { Name: 'AWAITINGDELIVERY', ID: 3 }, ASNStatusId: 3 }, 'resolved'],
    ['an id alone', { ASNStatusId: 6 }, 'resolved'],
    ['a name alone', { ASNStatus: { Name: 'COMPLETE' } }, 'resolved'],
    ['a lower-case name', { ASNStatus: { Name: 'complete' } }, 'resolved'],
    ['an unlisted id alone', { ASNStatusId: 99 }, 'unreadable'],
    ['an unlisted id beside a listed name', { ASNStatus: { Name: 'COMPLETE' }, ASNStatusId: 99 }, 'unreadable'],
    ['a NESTED id that disagrees with the name', { ASNStatus: { Name: 'COMPLETE', ID: 3 } }, 'unreadable'],
    ['a nested id that disagrees with ASNStatusId', { ASNStatus: { Name: 'COMPLETE', ID: 6 }, ASNStatusId: 3 }, 'unreadable'],
    ['an IMS name', { ASNStatus: { Name: 'OPEN' } }, 'unreadable'],
    ['a non-integer id', { ASNStatusId: 3.5 }, 'absent'],
  ]
  let examined = 0
  for (const [label, row, expected] of cases) {
    assert.equal(readMintsoftAsnWireStatus(row).kind, expected, `${label}: expected ${expected}`)
    examined += 1
  }
  assert.equal(readMintsoftAsnWireStatus(null).kind, 'absent', 'no row at all is absent')
  console.log(`# r9 reading: examined ${examined} raw-row shapes`)
  assert.equal(examined, cases.length)
  assert.equal(new Set(cases.map(([, , kind]) => kind)).size, 3, 'all three readings are exercised, not one')
})
