import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  RESOLVED_INBOUND_EVENT_STATUS,
  UNRESOLVED_INBOUND_EVENT_STATUSES,
  compactableInboundEventWhere,
} from '@/lib/domain/wms/inbound-event-retention'

// q66in.7.4: WmsWebhookEvent, WmsInboundReceiptEvent and their dead-letter rows, plus WmsSyncLog,
// were reachable by NO retention pass at all — the tables only ever grew. They are now covered, but
// on terms that refuse to destroy unresolved work.

type ManyArgs = { where: Record<string, unknown>; data?: Record<string, unknown> }

const capture: {
  settingRows: Array<{ key: string; value: string }>
  receiptUpdate?: ManyArgs
  webhookUpdate?: ManyArgs
  jobDelete?: ManyArgs
  bindingQuery?: ManyArgs
  dryRunQueries: ManyArgs[]
  pendingAlignmentWarehouses: Array<{ connector: string; warehouseId: string }>
  /** Keyed `connector:warehouseId` — the dry-run job id that scope's confirmation would read. */
  dryRunEvidence: Map<string, string>
  receiptCount: number
  webhookCount: number
  jobCount: number
} = {
  settingRows: [],
  dryRunQueries: [],
  pendingAlignmentWarehouses: [],
  dryRunEvidence: new Map(),
  receiptCount: 0,
  webhookCount: 0,
  jobCount: 0,
}

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findMany: async () => capture.settingRows },
      shoppingSyncLog: noopDelegate(),
      accountingSyncLog: noopDelegate(),
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      shoppingWebhookEvent: noopDelegate(),
      wmsInboundReceiptEvent: {
        deleteMany: async () => {
          throw new Error('inbound WMS event rows must be COMPACTED, never deleted (idempotency key)')
        },
        updateMany: async (args: ManyArgs) => {
          capture.receiptUpdate = args
          return { count: capture.receiptCount }
        },
      },
      wmsWebhookEvent: {
        deleteMany: async () => {
          throw new Error('inbound WMS event rows must be COMPACTED, never deleted (idempotency key)')
        },
        updateMany: async (args: ManyArgs) => {
          capture.webhookUpdate = args
          return { count: capture.webhookCount }
        },
      },
      wmsSyncJob: {
        // Backed by the evidence map rather than stubbed: retention must protect the row the
        // confirm action would actually FIND, so a double that answered the same thing for every
        // scope could not tell a correct exemption from one that names the wrong job.
        findFirst: async (args: ManyArgs) => {
          capture.dryRunQueries.push(args)
          const where = args.where as { connector?: string; warehouseId?: string }
          const id = capture.dryRunEvidence.get(`${where.connector}:${where.warehouseId}`)
          return id ? { id } : null
        },
        deleteMany: async (args: ManyArgs) => {
          capture.jobDelete = args
          return { count: capture.jobCount }
        },
      },
      externalWmsBinding: {
        findMany: async (args: ManyArgs) => {
          capture.bindingQuery = args
          return capture.pendingAlignmentWarehouses
        },
      },
    },
  },
})

async function loadPurge() {
  return (await import('@/lib/data-retention')).purgeExpiredData
}

function reset() {
  capture.receiptUpdate = undefined
  capture.webhookUpdate = undefined
  capture.jobDelete = undefined
  capture.bindingQuery = undefined
  capture.dryRunQueries = []
  capture.pendingAlignmentWarehouses = []
  capture.dryRunEvidence = new Map()
  capture.receiptCount = 0
  capture.webhookCount = 0
  capture.jobCount = 0
}

test('resolved inbound WMS events are COMPACTED — payload cleared, idempotency row kept', async () => {
  const purgeExpiredData = await loadPurge()
  reset()
  capture.settingRows = [
    { key: 'retention_wms_events_months', value: '3' },
    { key: 'retention_wms_sync_jobs_months', value: '0' },
  ]
  capture.receiptCount = 4
  capture.webhookCount = 3

  const result = await purgeExpiredData()

  assert.equal(result.wmsInboundEventsCompacted, 7)

  for (const [label, args] of [
    ['receipt events', capture.receiptUpdate],
    ['webhook events', capture.webhookUpdate],
  ] as const) {
    if (!args) throw new Error(`${label}: updateMany was not called`)
    // The SPECIFIC state, not "some filter exists": only a PROCESSED row may be compacted.
    assert.equal(args.where.processingStatus, RESOLVED_INBOUND_EVENT_STATUS, label)
    assert.equal(args.where.processingStatus, 'PROCESSED', label)
    assert.ok((args.where.processedAt as { lt?: Date })?.lt instanceof Date, `${label}: bounded by a processedAt cutoff`)
    // Already-compacted rows are permanently out of the pass.
    assert.deepEqual((args.where.NOT as { payload?: { equals?: unknown } })?.payload?.equals, {}, label)
    // Clears the payload; leaves the row, its status and its (connector, externalEventId) key.
    assert.deepEqual(args.data?.payload, {}, label)
    assert.equal(args.data?.lastError, null, label)
    assert.equal(args.data?.processingStatus, undefined, `${label}: status is preserved, not rewritten`)
    assert.equal(args.data?.processedAt, undefined, `${label}: resolution timestamp is preserved`)
  }

  // Receipt events carry a second bulky column — the dry-run review image — and it goes too.
  assert.ok('reviewDetails' in (capture.receiptUpdate?.data ?? {}), 'reviewDetails is cleared on receipt events')
  assert.equal('reviewDetails' in (capture.webhookUpdate?.data ?? {}), false, 'the generic webhook table has no such column')
})

test('NO unresolved inbound WMS event is eligible for compaction — a dead letter is evidence, not an old row', async () => {
  // The predicate is asserted against the WHOLE status vocabulary rather than the two cases someone
  // happened to think of: DEAD (effect never applied, replayable from the exception inbox),
  // REQUIRES_REVIEW (an operator decision is outstanding), and the three ladder states.
  const where = compactableInboundEventWhere(new Date('2026-01-01T00:00:00Z'))

  // Asserted as a SCALAR equality, not merely "does not equal DEAD". Widening the predicate to
  // `{ in: [...] }` is the realistic way an unresolved state gets swept in later, and a
  // not-equal check against an object silently passes it.
  assert.equal(typeof where.processingStatus, 'string', 'the predicate must name ONE state, not a set')
  assert.equal(where.processingStatus, RESOLVED_INBOUND_EVENT_STATUS)
  assert.equal(where.processingStatus, 'PROCESSED')

  assert.equal(UNRESOLVED_INBOUND_EVENT_STATUSES.length, 5)
  for (const status of UNRESOLVED_INBOUND_EVENT_STATUSES) {
    assert.notEqual(
      where.processingStatus,
      status,
      `${status} rows must never match the compaction predicate — compacting one turns a recoverable failure into an unrecoverable one while leaving a row that still looks replayable`,
    )
  }
  assert.ok(UNRESOLVED_INBOUND_EVENT_STATUSES.includes('DEAD'))
  assert.ok(UNRESOLVED_INBOUND_EVENT_STATUSES.includes('REQUIRES_REVIEW'))
})

test('WMS sync runs are deleted only when FINISHED, which cascades their per-SKU log lines', async () => {
  const purgeExpiredData = await loadPurge()
  reset()
  capture.settingRows = [
    { key: 'retention_wms_events_months', value: '0' },
    { key: 'retention_wms_sync_jobs_months', value: '12' },
  ]
  capture.jobCount = 12

  const result = await purgeExpiredData()

  assert.equal(result.wmsSyncJobsDeleted, 12)
  const args = capture.jobDelete
  if (!args) throw new Error('wmsSyncJob.deleteMany was not called')
  assert.ok((args.where.startedAt as { lt?: Date })?.lt instanceof Date, 'bounded by a startedAt cutoff')
  // A run that has not finished is either in flight or STUCK; an old timestamp on a stuck run is a
  // reason to keep it, not a licence to delete it.
  assert.deepEqual(args.where.finishedAt, { not: null })
  assert.deepEqual(args.where.status, { in: ['SUCCEEDED', 'FAILED', 'PARTIAL'] })
  assert.equal((args.where.status as { in: string[] }).in.includes('RUNNING'), false)
  assert.equal((args.where.status as { in: string[] }).in.includes('PENDING'), false)
  // With no unconfirmed alignment binding there is nothing extra to protect.
  assert.equal(args.where.NOT, undefined)
})

test('the ONE dry run a pending ALIGN_TO_WMS confirmation depends on is NOT deleted', async () => {
  const purgeExpiredData = await loadPurge()
  reset()
  capture.settingRows = [
    { key: 'retention_wms_events_months', value: '0' },
    { key: 'retention_wms_sync_jobs_months', value: '12' },
  ]
  capture.pendingAlignmentWarehouses = [
    { connector: 'mintsoft', warehouseId: 'wh-1' },
    { connector: 'mintsoft', warehouseId: 'wh-2' },
    { connector: 'mintsoft', warehouseId: 'wh-1' },
  ]
  capture.dryRunEvidence = new Map([
    ['mintsoft:wh-1', 'job-dry-1'],
    ['mintsoft:wh-2', 'job-dry-2'],
  ])
  capture.jobCount = 3

  await purgeExpiredData()

  // The binding query names the exact unresolved condition: alignment mode armed, never confirmed.
  assert.deepEqual(capture.bindingQuery?.where, { stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: null })

  const args = capture.jobDelete
  if (!args) throw new Error('wmsSyncJob.deleteMany was not called')
  // THE ROW, NOT THE WAREHOUSE (Codex r10 #3). A warehouse-wide NOT pinned every scheduled stock
  // sync and every per-SKU log line it wrote, for as long as the binding stayed unconfirmed.
  assert.deepEqual(args.where.id, { notIn: ['job-dry-1', 'job-dry-2'] })
  assert.equal(args.where.NOT, undefined, 'no warehouse-wide exclusion survives')
  assert.equal(
    JSON.stringify(args.where).includes('wh-1'),
    false,
    'the predicate must not key on the warehouse at all — that is what made the exemption unbounded',
  )

  // Resolved through the SAME query confirmMintsoftAlignmentMode uses, once per distinct scope.
  assert.equal(capture.dryRunQueries.length, 2, 'two bindings on one warehouse resolve one job, once')
  const dryRun = capture.dryRunQueries[0]
  assert.equal(dryRun.where.connector, 'mintsoft')
  assert.equal(dryRun.where.type, 'STOCK_SYNC')
  assert.deepEqual(dryRun.where.status, { in: ['SUCCEEDED', 'PARTIAL'] })
  assert.deepEqual(dryRun.where.finishedAt, { not: null })
  assert.deepEqual(dryRun.where.AND, [{ summary: { path: ['dryRun'], equals: true } }])
})

test('an unconfirmed binding with NO dry run protects nothing', async () => {
  const purgeExpiredData = await loadPurge()
  reset()
  capture.settingRows = [
    { key: 'retention_wms_events_months', value: '0' },
    { key: 'retention_wms_sync_jobs_months', value: '12' },
  ]
  capture.pendingAlignmentWarehouses = [{ connector: 'mintsoft', warehouseId: 'wh-1' }]
  capture.dryRunEvidence = new Map()
  capture.jobCount = 5

  await purgeExpiredData()

  const args = capture.jobDelete
  if (!args) throw new Error('wmsSyncJob.deleteMany was not called')
  // There is no decision pending on a row that does not exist, and the operator must run a fresh
  // dry run either way — so the ordinary age rule applies and nothing is pinned.
  assert.equal(args.where.id, undefined)
  assert.equal(args.where.NOT, undefined)
})

test('a 0-month setting disables each WMS retention pass independently', async () => {
  const purgeExpiredData = await loadPurge()
  reset()
  capture.settingRows = [
    { key: 'retention_wms_events_months', value: '0' },
    { key: 'retention_wms_sync_jobs_months', value: '0' },
  ]
  capture.receiptCount = 99
  capture.webhookCount = 99
  capture.jobCount = 99

  const result = await purgeExpiredData()

  assert.equal(result.wmsInboundEventsCompacted, 0)
  assert.equal(result.wmsSyncJobsDeleted, 0)
  assert.equal(capture.receiptUpdate, undefined)
  assert.equal(capture.webhookUpdate, undefined)
  assert.equal(capture.jobDelete, undefined)
})
