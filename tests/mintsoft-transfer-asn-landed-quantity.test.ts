import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import * as realMintsoftNs from '@/lib/connectors/mintsoft'
import {
  loadTransferLineLandedQty,
  loadTransferLineOutstandingQty,
  requireLandedQty,
  requireOutstandingQty,
} from '@/lib/domain/inventory/transfer-landed-quantity'
import { buildBookedInDryRun } from '@/lib/domain/wms/asn-reconciliation'

/**
 * o3d-zzgp — THE ONE WITH REAL CONSEQUENCES, AND THE RETRY THAT UNDOES IT.
 *
 * `createMintsoftTransferAsn` sized each ASN line as `qty − qtyReceived` and handed that
 * number to a LIVE WMS as the quantity to expect. The WMS stock-sync alignment
 * (`applyMintsoftAlignmentForProduct`) brings transfer units into IMS stock and lays their
 * cost layers by incrementing `wms_asn_line_maps.qtyAccountedViaSnapshot`; it never writes
 * `stock_transfer_lines.qtyReceived`. So the sizing ignored every unit that route had
 * already landed — and, because it never writes `qtyReceived`, those ASN line-map rows are
 * the ONLY record that the units arrived at all.
 *
 * IT IS REACHABLE, AND THE ROUTE IS EXERCISED BELOW RATHER THAN ASSERTED IN PROSE:
 *  1. a create whose push to Mintsoft fails leaves its `wms_asn_maps` row at CREATE_PENDING
 *     with `closedAt` NULL (the action's catch block demotes CREATE_IN_FLIGHT back to
 *     CREATE_PENDING and deletes nothing);
 *  2. `getAlignmentCandidateLines` selects ASN lines on `asn.closedAt IS NULL` and does NOT
 *     filter on the ASN's status, so that row's lines are alignment candidates;
 *  3. the alignment credits `qtyAccountedViaSnapshot` and the units arrive;
 *  4. the operator retries the create.
 *
 * WHY THIS FILE HAS A STORE AND NOT A SET OF STUBS (Codex round-1 HIGH-1). Round 1's
 * version asserted that the retry DELETED the emptied reservation and stopped there. The
 * deletion is the defect: it cascades to the line maps that hold the alignment credit, so
 * the next read of the landed quantity answers zero and the whole line looks outstanding
 * again. A test that asserts a mutation happened, and never re-reads the quantity the
 * mutation was supposed to protect, pins the bug as correct behaviour.
 *
 * So the fake below is a small STORE with the real cascade (`wms_asn_line_maps.asnMapId`
 * is `onDelete: Cascade` in prisma/schema.prisma), and every case re-reads the landed and
 * outstanding quantities AFTERWARDS — through the production loaders, over the store as
 * the action left it. `test('the rig can see a cascade …')` proves the store really does
 * cascade, so a green run cannot be the fake being generous.
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

type TransferLineSeed = {
  id: string
  sku: string
  productId: string
  qty: string
  qtyReceived: string
  /** The pending reservation's row for this line: expectation and credit. */
  pending?: { expectedQty: string; snapshot?: string; receipt?: string; lastProcessed?: string }
}

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

const TRANSFER_ID = 'trf-1'
const ASN_MAP_ID = 'asn-1'
const PENDING_EXTERNAL_ID = `pending:transfer:${TRANSFER_ID}:1700000000000`

let asnMaps: AsnMapRow[] = []
let asnLines: AsnLineRow[] = []
let transferLines: TransferLineSeed[] = []
let nextId = 0
const createAsnCalls: Array<{ lines: Array<{ sourceLineId: string; sku: string; quantity: number }> }> = []
const landedLookups: Array<Record<string, unknown>> = []

function seed(lines: TransferLineSeed[], options: { withPendingReservation?: boolean } = {}) {
  transferLines = lines
  nextId = 0
  createAsnCalls.length = 0
  landedLookups.length = 0
  asnMaps = []
  asnLines = []
  if (options.withPendingReservation === false) return

  asnMaps.push({
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
  })
  for (const line of lines) {
    if (!line.pending) continue
    asnLines.push({
      id: `al-${line.id}`,
      asnMapId: ASN_MAP_ID,
      externalAsnLineId: `pending:${line.id}`,
      sourceType: 'STOCK_TRANSFER_LINE',
      sourceLineId: line.id,
      productId: line.productId,
      sku: line.sku,
      expectedQty: decimal(line.pending.expectedQty),
      qtyAccountedViaSnapshot: decimal(line.pending.snapshot ?? '0'),
      qtyAccountedViaReceipt: decimal(line.pending.receipt ?? '0'),
      lastProcessedReceivedQty: decimal(line.pending.lastProcessed ?? '0'),
      note: null,
    })
  }
}

function transferRow() {
  return {
    id: TRANSFER_ID,
    reference: 'TRF-1',
    status: 'IN_TRANSIT',
    toWarehouseId: 'wh-1',
    toWarehouse: { code: 'DEST' },
    lines: transferLines.map((line) => ({
      id: line.id,
      productId: line.productId,
      sku: line.sku,
      qty: decimal(line.qty),
      qtyReceived: decimal(line.qtyReceived),
    })),
  }
}

/** The FK cascade in prisma/schema.prisma, modelled. */
function deleteAsnMapById(id: string): number {
  const before = asnMaps.length
  asnMaps = asnMaps.filter((row) => row.id !== id)
  asnLines = asnLines.filter((row) => row.asnMapId !== id)
  return before - asnMaps.length
}

function linesOf(asnMapId: string) {
  return asnLines
    .filter((row) => row.asnMapId === asnMapId)
    .sort((left, right) => left.id.localeCompare(right.id))
}

function isZero(value: Prisma.Decimal): boolean {
  return value.equals(0)
}

const wmsAsnMapDelegate = {
  findFirst: async (args: { where: Record<string, unknown> }) => {
    const where = args.where
    const candidates = asnMaps.filter((row) => (
      row.connector === where.connector
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
    return {
      id: row.id,
      externalAsnId: row.externalAsnId,
      status: row.status,
      updatedAt: row.updatedAt,
      lines: linesOf(row.id),
    }
  },
  findUnique: async (args: { where: Record<string, unknown> }) => {
    if ('connector_externalAsnId' in args.where) {
      const key = args.where.connector_externalAsnId as { connector: string; externalAsnId: string }
      const row = asnMaps.find((candidate) => (
        candidate.connector === key.connector && candidate.externalAsnId === key.externalAsnId
      ))
      return row ? { id: row.id, externalAsnId: row.externalAsnId, status: row.status, lines: linesOf(row.id) } : null
    }
    const row = asnMaps.find((candidate) => candidate.id === args.where.id)
    return row ? { id: row.id, externalAsnId: row.externalAsnId, status: row.status, lines: linesOf(row.id) } : null
  },
  findMany: async () => asnMaps.map((row) => ({
    sourceId: row.sourceId,
    id: row.id,
    externalAsnId: row.externalAsnId,
    status: row.status,
    createdAt: row.createdAt,
    lastCallbackAt: row.lastCallbackAt,
    closedAt: row.closedAt,
    lines: linesOf(row.id).map((line) => ({
      expectedQty: line.expectedQty,
      qtyAccountedViaReceipt: line.qtyAccountedViaReceipt,
    })),
  })),
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
    const removed = deleteAsnMapById(args.where.id)
    assert.equal(removed, 1, `delete hit no ASN map ${args.where.id}`)
    return { id: args.where.id }
  },
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    const id = String(args.where.id)
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
    const created = (args.data.lines as { create: Array<Record<string, unknown>> }).create
    for (const line of created) {
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
      landedLookups.push(args.where)
      assert.equal(args.where.sourceType, 'STOCK_TRANSFER_LINE')
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
    if (typeof args.data.productId === 'string') row.productId = args.data.productId
    if (typeof args.data.sku === 'string') row.sku = args.data.sku
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
      // The zero-credit conditions the action now sends. Modelled, so a row that holds
      // credit survives this statement here exactly as it would in Postgres.
      if (args.where.qtyAccountedViaSnapshot === 0 && !isZero(row.qtyAccountedViaSnapshot)) return true
      if (args.where.qtyAccountedViaReceipt === 0 && !isZero(row.qtyAccountedViaReceipt)) return true
      if (args.where.lastProcessedReceivedQty === 0 && !isZero(row.lastProcessedReceivedQty)) return true
      return false
    })
    return { count: before - asnLines.length }
  },
}

const db: Record<string, unknown> = {
  wmsSyncJob: {
    create: async () => ({ id: 'job-1' }),
    update: async () => ({ id: 'job-1' }),
  },
  stockTransfer: {
    findUnique: async () => transferRow(),
    findMany: async () => [transferRow()],
  },
  wmsAsnMap: wmsAsnMapDelegate,
  wmsAsnLineMap: wmsAsnLineMapDelegate,
  product: {
    findMany: async (args: { where: { id: { in: string[] } } }) => args.where.id.in.map((id) => ({
      id,
      wmsProductLinks: [{ externalProductId: `ext-${id}`, id: `link-${id}` }],
    })),
  },
  externalWmsBinding: {
    findFirst: async () => ({ externalWarehouseId: '301' }),
    findMany: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
  },
  wmsSyncLog: { createMany: async () => ({ count: 1 }) },
  $queryRaw: async () => [{ id: TRANSFER_ID }],
  $transaction: async (arg: unknown) => {
    if (typeof arg !== 'function') return Promise.all(arg as unknown[])
    return (arg as (tx: unknown) => Promise<unknown>)(db)
  },
}

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
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
    logActivityPersisted: async () => true,
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async () => true,
    getIntegrationPluginState: async () => ({ enabled: true }),
  },
})
mock.module('@/lib/public-app-url', { namedExports: { getPublicAppUrl: async () => 'https://ims.example.com' } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/jobs/wms/process-mintsoft-booked-in-event', {
  namedExports: {
    replayMintsoftBookedInEventsForAsn: async () => {},
    enqueueMintsoftBookedInRecheckForAsn: async () => {},
  },
})
// The whole connector namespace, with only the network calls replaced — a hand-built
// namedExports map would silently drop one of the seventeen names this action imports.
mock.module('@/lib/connectors/mintsoft', {
  namedExports: {
    ...(realMintsoftNs as unknown as Record<string, unknown>),
    fetchMintsoftAsns: async () => [],
    getMintsoftSettings: async () => ({ mintsoft_webhook_secret: 'whsec' }),
  },
})
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: () => ({
      id: 'mintsoft',
      name: 'Mintsoft',
      createAsn: async (input: { lines: Array<{ sourceLineId: string; sku: string; quantity: number }> }) => {
        createAsnCalls.push({ lines: input.lines })
        return {
          externalAsnId: '9001',
          status: 'OPEN',
          lines: input.lines.map((line, index) => ({
            externalLineId: `remote-${index}`,
            sourceLineId: line.sourceLineId,
            raw: null,
          })),
        }
      },
    }),
    isWmsConnectorConfigured: async () => true,
  },
})

async function loadActions() {
  return import('@/app/actions/mintsoft-sync')
}

// ---------------------------------------------------------------------------
// RE-READING THE QUANTITY AFTERWARDS — through the production loaders, over the
// store as the action left it. This is the half round 1 was missing.
// ---------------------------------------------------------------------------

async function landedNow(lineId: string): Promise<number> {
  const line = transferLines.find((candidate) => candidate.id === lineId)
  assert.ok(line, `no seeded transfer line ${lineId}`)
  const landed = await loadTransferLineLandedQty(db as never, [{ id: line.id, qtyReceived: decimal(line.qtyReceived) }])
  return requireLandedQty(landed, line.id).qtyNumber
}

async function outstandingNow(lineId: string): Promise<number> {
  const line = transferLines.find((candidate) => candidate.id === lineId)
  assert.ok(line, `no seeded transfer line ${lineId}`)
  const outstanding = await loadTransferLineOutstandingQty(db as never, [{
    id: line.id,
    qty: decimal(line.qty),
    qtyReceived: decimal(line.qtyReceived),
  }])
  return requireOutstandingQty(outstanding, line.id).qtyNumber
}

function creditedRows() {
  return asnLines.filter((row) => (
    !isZero(row.qtyAccountedViaSnapshot)
    || !isZero(row.qtyAccountedViaReceipt)
    || !isZero(row.lastProcessedReceivedQty)
  ))
}

function openMaps() {
  return asnMaps.filter((row) => row.closedAt === null)
}

// ---------------------------------------------------------------------------

test('o3d-zzgp rig: the store cascades an ASN-map delete to its line maps', async () => {
  // If this did not hold, the HIGH-1 case below could pass with the defect present:
  // the deletion would leave the credit rows standing and the re-read would be happy.
  seed([{ id: 'tl-1', sku: 'SKU-1', productId: 'p-1', qty: '10', qtyReceived: '0', pending: { expectedQty: '10', snapshot: '10' } }])
  assert.equal(asnLines.length, 1, 'precondition: the reservation has a line map')
  assert.equal(await landedNow('tl-1'), 10, 'precondition: the credit is visible to the loader')

  deleteAsnMapById(ASN_MAP_ID)

  assert.equal(asnLines.length, 0, 'the cascade must remove the line maps')
  assert.equal(await landedNow('tl-1'), 0, 'and the landed quantity must then read zero — that is the defect')
})

test('o3d-zzgp: a retried transfer ASN is sized for the units still coming, not the ones the WMS alignment already landed', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  // Six of the ten units are already in IMS stock, credited through the snapshot arm by
  // the alignment. qtyReceived is still zero, which is what misled the old sizing.
  seed([{ id: 'tl-1', sku: 'SKU-1', productId: 'p-1', qty: '10', qtyReceived: '0', pending: { expectedQty: '10', snapshot: '6' } }])

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(result.success, true, `create failed: ${result.error ?? ''}`)
  // THE WIRE VALUE FIRST. WAS 10: Mintsoft told to expect ten units, six of which were
  // on its own shelves.
  assert.equal(createAsnCalls.length, 1, 'exactly one ASN create should reach the WMS')
  assert.deepEqual(createAsnCalls[0]!.lines, [{ sourceLineId: 'tl-1', externalProductId: 'ext-p-1', sku: 'SKU-1', quantity: 4 }])
  // THEN the precondition: loaded twice, because `reserveAsn` and
  // `revalidatePendingReservation` must agree or every create is refused as
  // "Outstanding quantities changed after reservation".
  assert.ok(landedLookups.length >= 2, `landed quantity must be loaded by both the reservation and its revalidation, saw ${landedLookups.length} lookups`)
  // AND THE QUANTITY RE-READ AFTERWARDS: the six units are still recorded as landed.
  assert.equal(await landedNow('tl-1'), 6, 'the alignment credit must survive the retry')
  assert.equal(await outstandingNow('tl-1'), 4)
})

test('o3d-zzgp Codex r1 HIGH-1: a retry that finds nothing outstanding must not delete the record that the units landed', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  // All ten units were brought in by the alignment: credited on the ASN line, with
  // qtyReceived still zero. Nothing is outstanding, so no ASN may be raised.
  seed([{ id: 'tl-1', sku: 'SKU-1', productId: 'p-1', qty: '10', qtyReceived: '0', pending: { expectedQty: '10', snapshot: '10' } }])
  assert.equal(await landedNow('tl-1'), 10, 'precondition: the loader can see the credit before the call')

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(createAsnCalls.length, 0, 'nothing may be sent to the WMS')
  assert.equal(result.success, false)
  assert.match(String(result.error), /no outstanding quantity left/i)

  // THE ASSERTION THAT ROUND 1 DID NOT MAKE, and the reason its version pinned the
  // defect: re-read the quantity AFTER the action decided what to do with the row.
  // WAS: the pending map was deleted, the cascade took the line map with it, landed
  // dropped to 0 and the whole line read as outstanding again — which reopens ASN
  // creation for stock already on the shelf and re-slices the dispatch snapshot from
  // offset zero, laying a second set of cost layers.
  assert.equal(await landedNow('tl-1'), 10, 'the alignment credit is the ONLY record those units landed; it must survive')
  assert.equal(await outstandingNow('tl-1'), 0, 'and the line must therefore still read as fully landed')

  // The credit survives by RETIREMENT, not by being left reusable: the reservation is
  // closed, so it leaves the alignment-candidate population (`asn.closedAt IS NULL`)
  // and cannot be pushed, resized or credited again.
  assert.equal(openMaps().length, 0, 'the emptied reservation must not stay open')
  const retired = asnLines.find((row) => row.sourceLineId === 'tl-1')
  assert.ok(retired, 'the line map must still exist')
  assert.equal(Number(retired.qtyAccountedViaSnapshot), 10, 'its credit is untouched')
  assert.equal(Number(retired.expectedQty), 10, 'and its expectation is exactly what it was credited, so its residue is zero')
  assert.match(String(retired.note), /retired on retry/i)
})

test('o3d-zzgp Codex r1 HIGH-1: an uncredited emptied reservation is still deleted', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  // Nothing outstanding, and nothing credited on the ASN row either: the ten units were
  // received manually, so `qtyReceived` carries them and the ASN row holds no evidence.
  // There is nothing to preserve, so the row goes — the fix is not "never delete".
  seed([{ id: 'tl-1', sku: 'SKU-1', productId: 'p-1', qty: '10', qtyReceived: '10', pending: { expectedQty: '10' } }])

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(result.success, false)
  assert.match(String(result.error), /no outstanding quantity left/i)
  assert.equal(asnMaps.length, 0, 'the uncredited reservation is deleted')
  assert.equal(asnLines.length, 0)
  assert.equal(await landedNow('tl-1'), 10, 'and the landed quantity is unaffected: qtyReceived carries it')
})

test('o3d-zzgp Codex r1 HIGH-2: the historical credit and the fresh remote expectation end up on different rows', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  // The reviewer's case: ten expected, six credited by the alignment, four still to come.
  seed([{ id: 'tl-1', sku: 'SKU-1', productId: 'p-1', qty: '10', qtyReceived: '0', pending: { expectedQty: '10', snapshot: '6' } }])

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })
  assert.equal(result.success, true, `create failed: ${result.error ?? ''}`)
  assert.equal(createAsnCalls[0]!.lines[0]!.quantity, 4, 'the four-unit ASN is what goes to the WMS')

  // WAS: the SAME row was re-pointed from expectedQty 10 to 4 while keeping its
  // six-unit credit. Two different quantities about two different populations of units,
  // on one row.
  const pushedMap = asnMaps.find((row) => row.externalAsnId === '9001')
  assert.ok(pushedMap, 'the pushed ASN must exist')
  const pushedLines = linesOf(pushedMap.id)
  assert.equal(pushedLines.length, 1)
  assert.equal(Number(pushedLines[0]!.expectedQty), 4, 'the fresh expectation')
  assert.equal(Number(pushedLines[0]!.qtyAccountedViaSnapshot), 0, 'and it carries NO historical credit')

  const credited = creditedRows()
  assert.equal(credited.length, 1, 'the six-unit credit is on exactly one row')
  assert.notEqual(credited[0]!.asnMapId, pushedMap.id, 'and it is NOT the row that was pushed')
  assert.equal(Number(credited[0]!.qtyAccountedViaSnapshot), 6)
  assert.equal(Number(credited[0]!.expectedQty), 6, 'its expectation is its credit, so its own residue is zero')

  // THE QUANTITY RE-READ AFTERWARDS: six landed, four outstanding, unchanged by the
  // retry — the split moved the credit, it did not spend or lose it.
  assert.equal(await landedNow('tl-1'), 6)
  assert.equal(await outstandingNow('tl-1'), 4)

  // AND THE CONSEQUENCE THE REVIEWER NAMED, measured with the real reconciliation:
  // Mintsoft books in the four units it was told to expect.
  const dryRun = buildBookedInDryRun({
    externalAsnId: pushedMap.externalAsnId,
    generatedAt: new Date('2026-02-01T00:00:00Z'),
    lines: pushedLines.map((line) => ({
      asnLineMapId: line.id,
      externalAsnLineId: line.externalAsnLineId,
      sourceType: line.sourceType,
      sourceLineId: line.sourceLineId,
      productId: line.productId,
      sku: line.sku,
      expectedQty: Number(line.expectedQty),
      currentRemoteReceivedQty: 4,
      localReceivedQty: 0,
      qtyAccountedViaSnapshot: Number(line.qtyAccountedViaSnapshot),
      qtyAccountedViaReceipt: Number(line.qtyAccountedViaReceipt),
      lastProcessedReceivedQty: Number(line.lastProcessedReceivedQty),
      localLineExists: true,
      costLayerSnapshot: [{ costLayerId: 'cl-1', qty: 10, unitCostBase: 5 }],
    })),
  })
  // WAS: `remote_regression`, because a remote received of 4 was compared against a raw
  // snapshot credit of 6 — which blocks approval permanently.
  assert.deepEqual(dryRun.warnings, [], `no warning may stand in the way of booking these four units in: ${JSON.stringify(dryRun.warnings)}`)
  // WAS: 0. `reconcileBookedInQuantities` clamped the six-unit credit to the new
  // four-unit expectation and treated the four FRESH units as already covered by it, so
  // they would have added no stock at all.
  assert.equal(dryRun.lines[0]!.stockQtyToAdd, 4, 'the four fresh units must add stock')
  assert.equal(dryRun.lines[0]!.wouldCreateCostLayer, true)
})

test('o3d-zzgp Codex r1 HIGH-1: a line that dropped out of the outstanding set keeps its credit too', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  // tl-1 was landed in full by the alignment, so it drops out of the outstanding set —
  // and it drops out BECAUSE of the credit the retry used to delete with it. tl-2 keeps
  // the transfer in transit.
  seed([
    { id: 'tl-1', sku: 'SKU-1', productId: 'p-1', qty: '10', qtyReceived: '0', pending: { expectedQty: '10', snapshot: '10' } },
    { id: 'tl-2', sku: 'SKU-2', productId: 'p-2', qty: '5', qtyReceived: '0', pending: { expectedQty: '5' } },
  ])

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(result.success, true, `create failed: ${result.error ?? ''}`)
  assert.deepEqual(
    createAsnCalls[0]!.lines.map((line) => ({ sourceLineId: line.sourceLineId, quantity: line.quantity })),
    [{ sourceLineId: 'tl-2', quantity: 5 }],
    'only the five units still coming go to the WMS',
  )
  // WAS: `deleteMany({ sourceLineId: { notIn: ['tl-2'] } })` removed tl-1's row and with
  // it the only record that its ten units arrived.
  assert.equal(await landedNow('tl-1'), 10, "the dropped line's credit must survive")
  assert.equal(await outstandingNow('tl-1'), 0)
  assert.equal(await landedNow('tl-2'), 0)
  assert.equal(await outstandingNow('tl-2'), 5)
})

test('o3d-zzgp: a partial WMS receipt absorbed into qtyReceived is not double-deducted', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  // The webhook book-in folded three units into qtyReceived AND recorded them on
  // qtyAccountedViaReceipt. The snapshot arm's contribution is max(0, 3 − 3) = 0, so
  // landed is 3 and not 6 — a plain sum of the two columns would under-size the ASN.
  seed([{ id: 'tl-1', sku: 'SKU-1', productId: 'p-1', qty: '10', qtyReceived: '3', pending: { expectedQty: '10', snapshot: '3', receipt: '3' } }])

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  // NOTE, HONESTLY: 10 − 3 = 7 either way, so the SIZING here passes against the pre-fix
  // arithmetic too. It is a guard against the fix double-deducting an absorbed WMS
  // receipt — the failure mode of a naive `qtyReceived + qtyAccountedViaSnapshot`.
  assert.equal(result.success, true, `create failed: ${result.error ?? ''}`)
  assert.equal(createAsnCalls.length, 1)
  assert.equal(createAsnCalls[0]!.lines[0]!.quantity, 7)
  // The row IS credited (receipt 3), so it is retired rather than resized, and the
  // landed quantity is the same three units afterwards — not six, and not zero.
  assert.equal(await landedNow('tl-1'), 3)
  assert.equal(await outstandingNow('tl-1'), 7)
})

test('o3d-zzgp: an uncredited pending reservation is still re-used in place, not replaced', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  // No credit anywhere on the reservation: there is nothing to preserve and nothing to
  // mis-scope, so the retry resizes the row it already has. This is what keeps a retry
  // loop from leaving one closed reservation per attempt — the o3d-bhvu outage means
  // every attempt currently fails after the reservation is made.
  seed([{ id: 'tl-1', sku: 'SKU-1', productId: 'p-1', qty: '10', qtyReceived: '2', pending: { expectedQty: '10' } }])

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(result.success, true, `create failed: ${result.error ?? ''}`)
  assert.equal(createAsnCalls[0]!.lines[0]!.quantity, 8)
  assert.equal(asnMaps.length, 1, 'the same reservation was re-used')
  assert.equal(asnMaps[0]!.id, ASN_MAP_ID)
  assert.equal(asnMaps[0]!.externalAsnId, '9001', 'and it became the real ASN')
  assert.equal(Number(asnLines[0]!.expectedQty), 8)
})

test('o3d-zzgp: the transfer ASN state gate stops offering a create for an alignment-landed transfer', async () => {
  const { getMintsoftTransferAsnStates } = await loadActions()
  seed(
    [{ id: 'tl-1', sku: 'SKU-1', productId: 'p-1', qty: '10', qtyReceived: '0' }],
    { withPendingReservation: false },
  )
  // The credit lives on a CLOSED ASN, which is what a retired reservation looks like:
  // the gate must still see those units as landed.
  asnMaps.push({
    id: 'asn-retired',
    connector: 'mintsoft',
    externalAsnId: `${PENDING_EXTERNAL_ID}-retired`,
    sourceType: 'STOCK_TRANSFER',
    sourceId: TRANSFER_ID,
    warehouseId: 'wh-1',
    status: 'CREATE_PENDING',
    closedAt: new Date('2026-01-02T00:00:00Z'),
    sloAlertedAt: null,
    eta: null,
    lastCallbackAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  })
  asnLines.push({
    id: 'al-retired',
    asnMapId: 'asn-retired',
    externalAsnLineId: 'pending:tl-1',
    sourceType: 'STOCK_TRANSFER_LINE',
    sourceLineId: 'tl-1',
    productId: 'p-1',
    sku: 'SKU-1',
    expectedQty: decimal('10'),
    qtyAccountedViaSnapshot: decimal('10'),
    qtyAccountedViaReceipt: decimal('0'),
    lastProcessedReceivedQty: decimal('0'),
    note: 'retired on retry',
  })

  const states = await getMintsoftTransferAsnStates([TRANSFER_ID])

  // WAS: canCreate true, offering an ASN for stock that had already arrived.
  assert.equal(states[TRANSFER_ID]!.canCreate, false)
  assert.match(String(states[TRANSFER_ID]!.blockedReason), /no outstanding quantity left/i)
  assert.ok(landedLookups.length >= 1, 'the gate must consult the landed quantity')
})
