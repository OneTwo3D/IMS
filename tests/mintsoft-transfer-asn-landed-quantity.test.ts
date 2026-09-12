import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import * as realMintsoftNs from '@/lib/connectors/mintsoft'

/**
 * o3d-zzgp — THE ONE WITH REAL CONSEQUENCES.
 *
 * `createMintsoftTransferAsn` sized each ASN line as `qty − qtyReceived` and handed
 * that number to a LIVE WMS as the quantity to expect. The WMS stock-sync alignment
 * (`applyMintsoftAlignmentForProduct`) brings transfer units into IMS stock and lays
 * their cost layers by incrementing `wms_asn_line_maps.qtyAccountedViaSnapshot`; it
 * never writes `stock_transfer_lines.qtyReceived`. So the sizing ignored every unit
 * that route had already landed.
 *
 * IT IS REACHABLE, AND THE ROUTE IS EXERCISED BELOW RATHER THAN ASSERTED IN PROSE:
 *  1. a create whose push to Mintsoft fails leaves its `wms_asn_maps` row at
 *     CREATE_PENDING with `closedAt` NULL (the action's catch block demotes
 *     CREATE_IN_FLIGHT back to CREATE_PENDING and deletes nothing);
 *  2. `getAlignmentCandidateLines` selects ASN lines on `asn.closedAt IS NULL` and does
 *     NOT filter on the ASN's status, so that row's lines are alignment candidates;
 *  3. the alignment credits `qtyAccountedViaSnapshot` and the units arrive;
 *  4. the operator retries the create. The pending row is re-used and RE-SIZED — and
 *     the old arithmetic re-sized it to the full line quantity.
 *
 * So each case here starts from a CREATE_PENDING reservation with alignment credit on
 * its line, and asserts the quantity that reaches `connector.createAsn` — the wire
 * value, not an intermediate.
 */

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
}

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

let transferLineQty = '10'
let transferLineQtyReceived = '0'
let snapshotCredit = '0'
let receiptCredit = '0'
let asnLineRows: AsnLineRow[] = []
let asnMapStatus = 'CREATE_PENDING'
let asnMapDeleted = false
const createAsnCalls: Array<{ lines: Array<{ sourceLineId: string; sku: string; quantity: number }> }> = []
const landedLookups: Array<Record<string, unknown>> = []

const TRANSFER_ID = 'trf-1'
const LINE_ID = 'tl-1'
const ASN_MAP_ID = 'asn-1'
const PENDING_EXTERNAL_ID = `pending:transfer:${TRANSFER_ID}:1700000000000`

function reset(options: { qty?: string; qtyReceived?: string; snapshot?: string; receipt?: string } = {}) {
  transferLineQty = options.qty ?? '10'
  transferLineQtyReceived = options.qtyReceived ?? '0'
  snapshotCredit = options.snapshot ?? '0'
  receiptCredit = options.receipt ?? '0'
  asnMapStatus = 'CREATE_PENDING'
  asnMapDeleted = false
  createAsnCalls.length = 0
  landedLookups.length = 0
  asnLineRows = [{
    id: 'al-1',
    asnMapId: ASN_MAP_ID,
    externalAsnLineId: `pending:${LINE_ID}`,
    sourceType: 'STOCK_TRANSFER_LINE',
    sourceLineId: LINE_ID,
    productId: 'p-1',
    sku: 'SKU-1',
    expectedQty: decimal('10'),
    qtyAccountedViaSnapshot: decimal(snapshotCredit),
    qtyAccountedViaReceipt: decimal(receiptCredit),
  }]
}

function transferRow() {
  return {
    id: TRANSFER_ID,
    reference: 'TRF-1',
    status: 'IN_TRANSIT',
    toWarehouseId: 'wh-1',
    toWarehouse: { code: 'DEST' },
    lines: [{
      id: LINE_ID,
      productId: 'p-1',
      sku: 'SKU-1',
      qty: decimal(transferLineQty),
      qtyReceived: decimal(transferLineQtyReceived),
    }],
  }
}

const wmsAsnMapDelegate = {
  findFirst: async (args: { where: Record<string, unknown> }) => {
    const status = args.where.status as { not?: string } | string | undefined
    if (typeof status === 'object' && status?.not === 'CREATE_PENDING') return null // reusable open ASN
    if (status === 'CREATE_IN_FLIGHT') return null
    if (status === 'CREATE_PENDING') {
      if (asnMapDeleted) return null
      return {
        id: ASN_MAP_ID,
        lines: asnLineRows.map((row) => ({
          id: row.id,
          sourceLineId: row.sourceLineId,
          productId: row.productId,
          sku: row.sku,
          expectedQty: row.expectedQty,
        })),
      }
    }
    return null
  },
  findUnique: async (args: { where: Record<string, unknown> }) => {
    if ('connector_externalAsnId' in args.where) return null // no conflicting remote id
    if (asnMapDeleted) return null
    return {
      id: ASN_MAP_ID,
      lines: asnLineRows.map((row) => ({
        id: row.id,
        sourceLineId: row.sourceLineId,
        productId: row.productId,
        sku: row.sku,
        expectedQty: row.expectedQty,
      })),
    }
  },
  update: async () => ({ id: ASN_MAP_ID }),
  updateMany: async (args: { where: { status?: string }; data: { status?: string } }) => {
    if (args.where.status && args.where.status !== asnMapStatus) return { count: 0 }
    if (args.data.status) asnMapStatus = args.data.status
    return { count: 1 }
  },
  delete: async () => { asnMapDeleted = true; return { id: ASN_MAP_ID } },
  findMany: async () => (asnMapDeleted ? [] : [{
    sourceId: TRANSFER_ID,
    id: ASN_MAP_ID,
    externalAsnId: PENDING_EXTERNAL_ID,
    status: asnMapStatus,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastCallbackAt: null,
    closedAt: null,
    lines: asnLineRows.map((row) => ({ expectedQty: row.expectedQty, qtyAccountedViaReceipt: row.qtyAccountedViaReceipt })),
  }]),
  deleteMany: async () => { asnMapDeleted = true; return { count: 1 } },
  create: async () => { throw new Error('the pending reservation must be re-used, not re-created') },
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
  wmsAsnLineMap: {
    findMany: async (args: { where: Record<string, unknown> }) => {
      landedLookups.push(args.where)
      assert.equal(args.where.sourceType, 'STOCK_TRANSFER_LINE')
      const ids = (args.where.sourceLineId as { in?: string[] } | string | undefined)
      const wanted = typeof ids === 'string' ? [ids] : ids?.in ?? []
      return asnLineRows
        .filter((row) => wanted.includes(row.sourceLineId))
        .map((row) => ({
          sourceLineId: row.sourceLineId,
          qtyAccountedViaSnapshot: row.qtyAccountedViaSnapshot,
          qtyAccountedViaReceipt: row.qtyAccountedViaReceipt,
        }))
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = asnLineRows.find((candidate) => candidate.id === args.where.id)
      assert.ok(row, `no ASN line ${args.where.id}`)
      if (args.data.expectedQty !== undefined) row.expectedQty = decimal(String(args.data.expectedQty))
      if (typeof args.data.externalAsnLineId === 'string') row.externalAsnLineId = args.data.externalAsnLineId
      return row
    },
    create: async () => { throw new Error('the existing pending ASN line must be updated, not duplicated') },
    deleteMany: async (args: { where: { sourceLineId?: { notIn?: string[] } } }) => {
      const keep = args.where.sourceLineId?.notIn
      if (!keep) { const n = asnLineRows.length; asnLineRows = []; return { count: n } }
      const before = asnLineRows.length
      asnLineRows = asnLineRows.filter((row) => keep.includes(row.sourceLineId))
      return { count: before - asnLineRows.length }
    },
  },
  product: {
    findMany: async () => [{ id: 'p-1', wmsProductLinks: [{ externalProductId: '501' }] }],
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

test('o3d-zzgp: a retried transfer ASN is sized for the units still coming, not the ones the WMS alignment already landed', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  // Six of the ten units are already in IMS stock, credited through the snapshot arm
  // by the alignment. qtyReceived is still zero, which is what misled the old sizing.
  reset({ qty: '10', qtyReceived: '0', snapshot: '6', receipt: '0' })

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  assert.equal(result.success, true, `create failed: ${result.error ?? ''}`)
  // THE WIRE VALUE FIRST. WAS 10: Mintsoft told to expect ten units, six of which were
  // on its own shelves.
  assert.equal(createAsnCalls.length, 1, 'exactly one ASN create should reach the WMS')
  assert.deepEqual(createAsnCalls[0]!.lines, [{ sourceLineId: LINE_ID, externalProductId: '501', sku: 'SKU-1', quantity: 4 }])
  // THEN the precondition: loaded twice, because `reserveAsn` and
  // `revalidatePendingReservation` must agree or every create is refused as
  // "Outstanding quantities changed after reservation".
  assert.ok(landedLookups.length >= 2, `landed quantity must be loaded by both the reservation and its revalidation, saw ${landedLookups.length} lookups`)
})

test('o3d-zzgp: a transfer the WMS alignment landed in full cannot raise an ASN at all', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  reset({ qty: '10', qtyReceived: '0', snapshot: '10', receipt: '0' })

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  // WAS: success, with a ten-unit ASN pushed to a live WMS for stock that had arrived.
  assert.equal(createAsnCalls.length, 0, 'nothing may be sent to the WMS')
  assert.equal(result.success, false)
  assert.match(String(result.error), /no outstanding quantity left/i)
  assert.equal(asnMapDeleted, true, 'the emptied pending reservation is cleared')
  assert.ok(landedLookups.length >= 1, 'the landed quantity must have been consulted')
})

test('o3d-zzgp: a partial WMS receipt absorbed into qtyReceived is not double-deducted', async () => {
  const { createMintsoftTransferAsn } = await loadActions()
  // The webhook book-in folded three units into qtyReceived AND recorded them on
  // qtyAccountedViaReceipt. The snapshot arm's contribution is max(0, 3 − 3) = 0, so
  // landed is 3 and not 6 — a plain sum of the two columns would under-size the ASN.
  reset({ qty: '10', qtyReceived: '3', snapshot: '3', receipt: '3' })

  const result = await createMintsoftTransferAsn(TRANSFER_ID, { autoCallback: false })

  // NOTE, HONESTLY: 10 − 3 = 7 either way, so this case passes against the pre-fix code
  // too. It is a guard against the fix double-deducting an absorbed WMS receipt — the
  // failure mode of a naive `qtyReceived + qtyAccountedViaSnapshot` — not a witness for
  // the defect.
  assert.equal(result.success, true, `create failed: ${result.error ?? ''}`)
  assert.equal(createAsnCalls.length, 1)
  assert.equal(createAsnCalls[0]!.lines[0]!.quantity, 7)
  assert.ok(landedLookups.length >= 1, 'the landed quantity must have been consulted')
})

test('o3d-zzgp: the transfer ASN state gate stops offering a create for an alignment-landed transfer', async () => {
  const { getMintsoftTransferAsnStates } = await loadActions()
  reset({ qty: '10', qtyReceived: '0', snapshot: '10', receipt: '0' })
  asnMapDeleted = true // no existing ASN row, so only the outstanding gate can block

  const states = await getMintsoftTransferAsnStates([TRANSFER_ID])

  // WAS: canCreate true, offering an ASN for stock that had already arrived.
  assert.equal(states[TRANSFER_ID]!.canCreate, false)
  assert.match(String(states[TRANSFER_ID]!.blockedReason), /no outstanding quantity left/i)
  assert.ok(landedLookups.length >= 1, 'the gate must consult the landed quantity')
})
