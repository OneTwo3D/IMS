import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runAccountingEventBackfill,
  type AccountingEventBackfillReport,
  type RunAccountingEventBackfillOptions,
} from '@/lib/domain/accounting/accounting-event-backfill'
import { adapterUniqueViolation } from '@/tests/helpers/prisma-unique-error'

type SyncLog = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  payload: unknown
  /**
   * When the log was ENQUEUED. o3d-cvj9 r3: stamped onto the repaired event so its age is the
   * work's age, NOT an ordering key — `accounting_events.createdAt` defaults to
   * `CURRENT_TIMESTAMP`, i.e. transaction start time. Fixtures below set it against the outcome on
   * purpose, to prove the repair no longer answers from it.
   */
  createdAt: Date
}

type EventRow = {
  id: string
  type: string
  sourceEntityType: string
  sourceEntityId: string
  businessDate: Date | string
  status: string
  idempotencyKey: string
  externalSystem: string | null
  externalId: string | null
  /** When the event was mirrored. Not an ordering key — see SyncLog.createdAt. */
  createdAt?: Date
  /**
   * o3d-cvj9 r3: the external system's own revision stamp for this row's write. A historical sync
   * log never recorded the connector response, so every row the backfill writes leaves it null —
   * which is exactly why the backfill cannot order two revisions against each other.
   */
  externalRevisionAt?: Date | null
}

type MockTransactionClient = {
  accountingEvent: {
    findMany(args?: unknown): Promise<EventRow[]>
    create(args: { data: EventRow }): Promise<{ id: string }>
    findUnique(args: unknown): Promise<EventRow | null>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  accountingEventLog: {
    create(args: unknown): Promise<{ id: string }>
  }
}

type MockBackfillClient = MockTransactionClient & {
  salesOrder: { findMany(args?: unknown): Promise<unknown[]> }
  shipment: { findMany(args?: unknown): Promise<unknown[]> }
  salesOrderRefund: { findMany(args?: unknown): Promise<unknown[]> }
  accountingSyncLog: { findMany(args?: unknown): Promise<SyncLog[]> }
  $transaction<T>(fn: (tx: MockTransactionClient) => Promise<T>): Promise<T>
}

type MockFindManyArgs = {
  cursor?: { id: string }
  skip?: number
  take?: number
  orderBy?: { id?: 'asc' | 'desc' }
  where?: {
    type?: { in?: string[] }
    OR?: Array<{
      status?: { in?: string[] }
      createdAt?: { gte?: Date }
    }>
  }
}

type MockAccountingEventFindManyArgs = {
  where?: {
    OR?: Array<Partial<Pick<EventRow, 'externalSystem' | 'type' | 'sourceEntityType' | 'sourceEntityId'>>>
  }
}

function makeClient(input: {
  syncLogs: SyncLog[]
  events?: EventRow[]
  eventCreateError?: unknown | ((args: { data: EventRow }) => unknown)
  logCreateError?: unknown
  throwOnSourceRead?: boolean
  /**
   * o3d-cvj9 r3: run after the candidate scan has read the existing events and before any repair
   * transaction opens — i.e. the window in which a LIVE worker can mirror a document revision the
   * scan did not see. It is the only way to reach the repair's collision handler with a revision
   * holding the id, because the scan itself cannot tell two edits of one document apart (it matches
   * on type + source entity) and would classify the sync log as already mirrored.
   */
  afterExistingEventScan?: (events: EventRow[]) => void
}) {
  const events: EventRow[] = [...(input.events ?? [])]
  const createdEvents: unknown[] = []
  const createdLogs: unknown[] = []
  const calls = {
    salesOrderFindMany: [] as unknown[],
    shipmentFindMany: [] as unknown[],
    salesOrderRefundFindMany: [] as unknown[],
    accountingSyncLogFindMany: [] as unknown[],
    accountingEventFindMany: [] as unknown[],
  }

  function sourceRead(name: keyof Pick<typeof calls, 'salesOrderFindMany' | 'shipmentFindMany' | 'salesOrderRefundFindMany'>, args: unknown) {
    calls[name].push(args)
    if (input.throwOnSourceRead) throw new Error('full reconciliation source rows should not be read')
    return []
  }

  function syncLogMatchesWhere(log: SyncLog, where: MockFindManyArgs['where']): boolean {
    const types = where?.type?.in
    if (types && !types.includes(log.type)) return false
    const statusBranches = where?.OR?.flatMap((branch) => branch.status?.in ?? [])
    return !statusBranches?.length || statusBranches.includes(log.status)
  }

  function pageSyncLogs(args: MockFindManyArgs): SyncLog[] {
    const ordered = [...input.syncLogs]
      .filter((log) => syncLogMatchesWhere(log, args.where))
      .sort((left, right) => {
        const comparison = left.id.localeCompare(right.id)
        return args.orderBy?.id === 'desc' ? -comparison : comparison
      })
    const cursorIndex = args.cursor ? ordered.findIndex((log) => log.id === args.cursor?.id) : -1
    const start = cursorIndex >= 0 ? cursorIndex + (args.skip ?? 0) : 0
    return ordered.slice(start, args.take ? start + args.take : undefined)
  }

  function findAccountingEvents(args: MockAccountingEventFindManyArgs): EventRow[] {
    const clauses = args.where?.OR
    if (!clauses?.length) return events

    return events.filter((event) => clauses.some((clause) => (
      Object.entries(clause).every(([key, value]) => (event as Record<string, unknown>)[key] === value)
    )))
  }

  const client: MockBackfillClient = {
    salesOrder: {
      async findMany(args?: unknown) {
        return sourceRead('salesOrderFindMany', args)
      },
    },
    shipment: {
      async findMany(args?: unknown) {
        return sourceRead('shipmentFindMany', args)
      },
    },
    salesOrderRefund: {
      async findMany(args?: unknown) {
        return sourceRead('salesOrderRefundFindMany', args)
      },
    },
    accountingSyncLog: {
      async findMany(args?: unknown) {
        calls.accountingSyncLogFindMany.push(args)
        return pageSyncLogs((args ?? {}) as MockFindManyArgs)
      },
    },
    accountingEvent: {
      async findMany(args?: unknown) {
        calls.accountingEventFindMany.push(args)
        const scanned = findAccountingEvents((args ?? {}) as MockAccountingEventFindManyArgs)
        // Snapshot first, THEN let the concurrent writer in: the scan must see the world as it was.
        input.afterExistingEventScan?.(events)
        return scanned
      },
      async create(args: { data: EventRow }) {
        if (typeof input.eventCreateError === 'function') {
          const error = input.eventCreateError(args)
          if (error) throw error
        } else if (input.eventCreateError) {
          throw input.eventCreateError
        }
        // o3d-cvj9 r2: ENFORCE `@@unique([externalSystem, externalId])` rather than only ever
        // simulating it through an injected error. The revision repair's whole shape is "the insert
        // is rejected, the claim is resolved, the insert is retried", and an injected error either
        // fires on both attempts or on neither.
        const claimed = args.data.externalId !== null && args.data.externalId !== undefined
          && events.some((row) => row.externalSystem === args.data.externalSystem && row.externalId === args.data.externalId)
        if (claimed) throw uniqueError(['externalSystem', 'externalId'])
        createdEvents.push(args)
        // `createdAt` is whatever the caller wrote — the backfill stamps it from the sync log
        // (o3d-cvj9 r2) precisely so a backfilled row is comparable with a live-mirrored one.
        const event = { ...args.data, id: `event-${createdEvents.length}` }
        events.push(event)
        return { id: event.id }
      },
      async findUnique(args: unknown) {
        const where = (args as { where?: { externalSystem_externalId?: { externalSystem: string; externalId: string } } }).where
        const key = where?.externalSystem_externalId
        if (!key) return null
        return events.find((row) => row.externalSystem === key.externalSystem && row.externalId === key.externalId) ?? null
      },
      async updateMany(args: unknown) {
        const { where, data } = args as {
          where: { id?: string; externalSystem?: string; externalId?: string }
          data: Record<string, unknown>
        }
        const matched = events.filter((row) => (where.id === undefined || row.id === where.id)
          && (where.externalSystem === undefined || row.externalSystem === where.externalSystem)
          && (where.externalId === undefined || row.externalId === where.externalId))
        for (const row of matched) Object.assign(row, data)
        return { count: matched.length }
      },
    },
    accountingEventLog: {
      async create(args: unknown) {
        if (input.logCreateError) throw input.logCreateError
        createdLogs.push(args)
        return { id: `log-${createdLogs.length}` }
      },
    },
    async $transaction<T>(fn: (tx: MockTransactionClient) => Promise<T>) {
      // Copies, not references: the revision repair MUTATES an existing row (it releases the
      // holder's claim), and a shallow array snapshot would leave that mutation in place after a
      // rollback — i.e. it would hide exactly the atomicity failure worth catching.
      const eventRowsSnapshot = events.map((row) => ({ ...row }))
      const createdEventCount = createdEvents.length
      const createdLogCount = createdLogs.length
      try {
        return await fn(client)
      } catch (error) {
        events.splice(0, events.length, ...eventRowsSnapshot)
        createdEvents.length = createdEventCount
        createdLogs.length = createdLogCount
        throw error
      }
    },
  }

  return {
    calls,
    createdEvents,
    createdLogs,
    client,
  }
}

function runTestBackfill(options: RunAccountingEventBackfillOptions) {
  return runAccountingEventBackfill({ baseCurrency: 'GBP', ...options })
}

function syncedJournalLog(overrides: Partial<SyncLog> = {}): SyncLog {
  return {
    id: 'sync-a1',
    connector: 'xero',
    type: 'DAILY_BATCH_REVENUE_DEFERRAL',
    status: 'SYNCED',
    referenceType: 'DailyBatch',
    referenceId: 'A1-2026-04-26',
    externalTransactionId: 'journal-a1',
    createdAt: new Date('2026-04-26T09:00:00.000Z'),
    payload: {
      date: '2026-04-26',
      _idempotencyKey: 'daily-batch:a1:2026-04-26',
      lines: [
        { accountCode: '400', description: 'Daily revenue deferral', debit: 12.34 },
        { accountCode: '210', description: 'Daily revenue deferral', credit: 12.34 },
      ],
    },
    ...overrides,
  }
}

function syncedDocumentLog(overrides: Partial<SyncLog> = {}): SyncLog {
  return {
    id: 'sync-credit-note',
    connector: 'quickbooks',
    type: 'CREDIT_NOTE',
    status: 'SYNCED',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    externalTransactionId: 'credit-note-1',
    createdAt: new Date('2026-04-26T09:00:00.000Z'),
    payload: {
      date: '2026-04-26',
      currency: 'GBP',
      _idempotencyKey: 'sales-order-refund:refund-1:credit-note',
      creditNoteNumber: 'CN-1',
      contactName: 'Customer One',
      lines: [{ description: 'Refund line', quantity: 1, unitAmount: 10, accountCode: '400' }],
    },
    ...overrides,
  }
}

function mirroredEventForLog(log: SyncLog): EventRow {
  return {
    id: `event-${log.id}`,
    type: log.type,
    sourceEntityType: log.referenceType,
    sourceEntityId: log.referenceId,
    businessDate: '2026-04-26',
    status: log.status === 'SYNCED' ? 'POSTED' : log.status,
    idempotencyKey: `event-key-${log.id}`,
    externalSystem: log.connector,
    externalId: log.externalTransactionId,
    createdAt: log.createdAt,
  }
}

function resultBySyncLog(report: AccountingEventBackfillReport, syncLogId: string) {
  const result = report.results.find((entry) => entry.syncLogId === syncLogId)
  assert.ok(result)
  return result
}

// o3d-5od: the REAL @prisma/adapter-pg shape (no meta.target, quoted columns).
function uniqueError(columns: string[]) {
  return adapterUniqueViolation(columns, {
    modelName: 'AccountingEvent',
    constraintName: `accounting_events_${columns.join('_')}_key`,
  })
}

test('accounting event backfill defaults to dry-run output', async () => {
  const { client, createdEvents } = makeClient({ syncLogs: [syncedJournalLog()] })

  const report = await runTestBackfill({ client: client as never })

  assert.equal(report.dryRun, true)
  assert.equal(report.summary.candidates, 1)
  assert.equal(report.summary.wouldCreate, 1)
  assert.equal(createdEvents.length, 0)
  const result = resultBySyncLog(report, 'sync-a1')
  assert.equal(result.action, 'would_create')
  assert.equal(result.reason, 'dry_run')
  assert.equal(result.idempotencyKey, 'accounting-sync:xero:daily_batch_revenue_deferral:daily-batch:a1:2026-04-26')
})

test('accounting event backfill requires explicit base currency with client overrides', async () => {
  const { client } = makeClient({ syncLogs: [syncedJournalLog()] })

  await assert.rejects(
    () => runAccountingEventBackfill({ client: client as never }),
    /baseCurrency is required/,
  )
})

test('accounting event backfill creates missing journal and document events', async () => {
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [syncedJournalLog(), syncedDocumentLog()],
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  assert.equal(report.summary.created, 2)
  assert.equal(createdEvents.length, 2)
  assert.equal(createdLogs.length, 2)
  assert.deepEqual(report.results.map((result) => result.action), ['created', 'created'])
  assert.deepEqual(createdEvents.map((entry) => (entry as { data: { type: string } }).data.type), [
    'DAILY_BATCH_REVENUE_DEFERRAL',
    'CREDIT_NOTE',
  ])
})

test('accounting event backfill skips posted sync logs without external transaction ids', async () => {
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [
      syncedJournalLog({
        id: 'sync-missing-external',
        externalTransactionId: null,
      }),
    ],
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  assert.equal(createdEvents.length, 0)
  assert.equal(createdLogs.length, 0)
  const result = resultBySyncLog(report, 'sync-missing-external')
  assert.equal(result.action, 'skipped')
  assert.equal(result.reason, 'posted_sync_log_missing_external_transaction_id')
  assert.equal(result.idempotencyKey, 'accounting-sync:xero:daily_batch_revenue_deferral:daily-batch:a1:2026-04-26')
})

test('accounting event backfill creates failed sync logs without external transaction ids', async () => {
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [
      syncedJournalLog({
        id: 'sync-failed-missing-external',
        status: 'FAILED',
        externalTransactionId: null,
      }),
    ],
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  assert.equal(createdEvents.length, 1)
  assert.equal(createdLogs.length, 1)
  const result = resultBySyncLog(report, 'sync-failed-missing-external')
  assert.equal(result.action, 'created')
  assert.equal(result.reason, 'created_missing_mirror')
  assert.equal((createdEvents[0] as { data: EventRow }).data.status, 'FAILED')
  assert.equal((createdEvents[0] as { data: EventRow }).data.externalId, null)
})

test('accounting event backfill only treats idempotency key conflicts as already mirrored', async () => {
  const idempotencySetup = makeClient({
    syncLogs: [syncedJournalLog()],
    eventCreateError: uniqueError(['idempotencyKey']),
  })

  const idempotencyReport = await runTestBackfill({
    client: idempotencySetup.client as never,
    dryRun: false,
  })

  assert.equal(resultBySyncLog(idempotencyReport, 'sync-a1').reason, 'accounting_event_already_exists')

  const externalIdSetup = makeClient({
    syncLogs: [syncedJournalLog()],
    eventCreateError: uniqueError(['externalSystem', 'externalId']),
  })

  const externalIdReport = await runTestBackfill({ client: externalIdSetup.client as never, dryRun: false })

  const result = resultBySyncLog(externalIdReport, 'sync-a1')
  assert.equal(result.action, 'skipped')
  assert.match(result.reason, /db_error: Unique constraint failed/)
})

test('accounting event backfill rolls back the event when audit logging fails', async () => {
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [syncedJournalLog()],
    logCreateError: new Error('audit log failed'),
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  assert.equal(createdEvents.length, 0)
  assert.equal(createdLogs.length, 0)
  const result = resultBySyncLog(report, 'sync-a1')
  assert.equal(result.action, 'skipped')
  assert.equal(result.reason, 'db_error: audit log failed')
})

test('accounting event backfill reruns are idempotent through reconciliation candidates', async () => {
  const setup = makeClient({ syncLogs: [syncedJournalLog()] })

  const first = await runTestBackfill({ client: setup.client as never, dryRun: false })
  const second = await runTestBackfill({ client: setup.client as never, dryRun: false })

  assert.equal(first.summary.created, 1)
  assert.equal(second.summary.candidates, 0)
  assert.equal(setup.createdEvents.length, 1)
})

test('accounting event backfill continues after a per-row database error', async () => {
  const setup = makeClient({
    syncLogs: [
      syncedJournalLog({
        id: 'sync-a',
        externalTransactionId: 'journal-a',
        payload: {
          date: '2026-04-26',
          _idempotencyKey: 'daily-batch:a:2026-04-26',
          lines: [
            { accountCode: '400', description: 'Daily revenue deferral', debit: 12.34 },
            { accountCode: '210', description: 'Daily revenue deferral', credit: 12.34 },
          ],
        },
      }),
      syncedJournalLog({
        id: 'sync-b',
        referenceId: 'B1-2026-04-26',
        externalTransactionId: 'journal-b',
        payload: {
          date: '2026-04-26',
          _idempotencyKey: 'daily-batch:b:2026-04-26',
          lines: [
            { accountCode: '400', description: 'Daily revenue deferral', debit: 12.34 },
            { accountCode: '210', description: 'Daily revenue deferral', credit: 12.34 },
          ],
        },
      }),
    ],
    eventCreateError: (args: { data: EventRow }) => (
      args.data.sourceEntityId === 'A1-2026-04-26' ? new Error('temporary write failure') : null
    ),
  })

  const report = await runTestBackfill({ client: setup.client as never, dryRun: false })

  assert.equal(report.summary.created, 1)
  assert.equal(report.summary.skipped, 1)
  assert.equal(resultBySyncLog(report, 'sync-a').reason, 'db_error: temporary write failure')
  assert.equal(resultBySyncLog(report, 'sync-b').action, 'created')
})

test('accounting event backfill applies limit after stable candidate ordering', async () => {
  const logs = [
    syncedJournalLog({ id: 'sync-c', externalTransactionId: 'journal-c', payload: {
      date: '2026-04-26',
      _idempotencyKey: 'daily-batch:c:2026-04-26',
      lines: [
        { accountCode: '400', description: 'Daily revenue deferral', debit: 12.34 },
        { accountCode: '210', description: 'Daily revenue deferral', credit: 12.34 },
      ],
    } }),
    syncedJournalLog({ id: 'sync-a', externalTransactionId: 'journal-a', payload: {
      date: '2026-04-26',
      _idempotencyKey: 'daily-batch:a:2026-04-26',
      lines: [
        { accountCode: '400', description: 'Daily revenue deferral', debit: 12.34 },
        { accountCode: '210', description: 'Daily revenue deferral', credit: 12.34 },
      ],
    } }),
    syncedJournalLog({ id: 'sync-b', externalTransactionId: 'journal-b', payload: {
      date: '2026-04-26',
      _idempotencyKey: 'daily-batch:b:2026-04-26',
      lines: [
        { accountCode: '400', description: 'Daily revenue deferral', debit: 12.34 },
        { accountCode: '210', description: 'Daily revenue deferral', credit: 12.34 },
      ],
    } }),
  ]
  const { calls, client } = makeClient({ syncLogs: logs, throwOnSourceRead: true })

  const report = await runTestBackfill({ client: client as never, limit: 2 })

  assert.deepEqual(report.results.map((result) => result.syncLogId), ['sync-a', 'sync-b'])
  assert.equal(report.summary.candidates, 2)
  assert.equal(report.summary.wouldCreate, 2)
  assert.deepEqual(report.candidateSummary, {
    scope: 'accounting_event_backfill_candidates',
    total: 2,
    warning: 2,
    critical: 0,
    issues: [{ code: 'old_sync_log_without_mirrored_event', severity: 'warning', count: 2 }],
  })
  assert.equal((calls.accountingSyncLogFindMany[0] as { take: number }).take, 100)
  assert.equal(calls.salesOrderFindMany.length, 0)
  assert.equal(calls.shipmentFindMany.length, 0)
  assert.equal(calls.salesOrderRefundFindMany.length, 0)
})

test('accounting event backfill only suppresses candidates with matching mirrored events', async () => {
  const sourceLog = syncedJournalLog({
    id: 'sync-source',
    externalTransactionId: 'journal-source',
  })
  const wrongConnectorEvent = {
    ...mirroredEventForLog(sourceLog),
    id: 'event-wrong-connector',
    externalSystem: 'quickbooks',
  }
  const { client } = makeClient({
    syncLogs: [sourceLog],
    events: [wrongConnectorEvent],
  })

  const report = await runTestBackfill({ client: client as never })

  assert.deepEqual(report.results.map((result) => result.syncLogId), ['sync-source'])
  assert.equal(report.summary.candidates, 1)
  assert.equal(report.candidateSummary.total, 1)
})

test('accounting event backfill matches legacy blank connector sync logs connector-agnostically', async () => {
  const sourceLog = syncedJournalLog({
    id: 'sync-blank-connector',
    connector: '',
    externalTransactionId: 'journal-source',
  })
  const mirroredEvent = {
    ...mirroredEventForLog(sourceLog),
    id: 'event-real-connector',
    externalSystem: 'xero',
  }
  const { calls, client } = makeClient({
    syncLogs: [sourceLog],
    events: [mirroredEvent],
  })

  const report = await runTestBackfill({ client: client as never })

  assert.equal(report.summary.candidates, 0)
  assert.deepEqual(report.results, [])
  assert.deepEqual(
    (calls.accountingEventFindMany[0] as MockAccountingEventFindManyArgs).where?.OR?.[0],
    {
      type: 'DAILY_BATCH_REVENUE_DEFERRAL',
      sourceEntityType: 'DailyBatch',
      sourceEntityId: 'A1-2026-04-26',
    },
  )
})

test('accounting event backfill pages deterministically until it fills the limit', async () => {
  const mirroredLogs = Array.from({ length: 100 }, (_, index) => {
    const suffix = index.toString().padStart(3, '0')
    return syncedJournalLog({
      id: `sync-${suffix}`,
      referenceId: `A1-${suffix}-2026-04-26`,
      externalTransactionId: `journal-${suffix}`,
      payload: {
        date: '2026-04-26',
        _idempotencyKey: `daily-batch:${suffix}:2026-04-26`,
        lines: [
          { accountCode: '400', description: 'Daily revenue deferral', debit: 12.34 },
          { accountCode: '210', description: 'Daily revenue deferral', credit: 12.34 },
        ],
      },
    })
  })
  const missing = syncedJournalLog({
    id: 'sync-100',
    referenceId: 'A1-100-2026-04-26',
    externalTransactionId: 'journal-100',
    payload: {
      date: '2026-04-26',
      _idempotencyKey: 'daily-batch:100:2026-04-26',
      lines: [
        { accountCode: '400', description: 'Daily revenue deferral', debit: 12.34 },
        { accountCode: '210', description: 'Daily revenue deferral', credit: 12.34 },
      ],
    },
  })
  const { calls, client } = makeClient({
    syncLogs: [missing, ...mirroredLogs],
    events: mirroredLogs.map(mirroredEventForLog),
    throwOnSourceRead: true,
  })

  const report = await runTestBackfill({ client: client as never, limit: 1 })

  assert.deepEqual(report.results.map((result) => result.syncLogId), ['sync-100'])
  assert.equal(report.summary.candidates, 1)
  assert.equal(calls.accountingSyncLogFindMany.length, 2)
  assert.deepEqual(calls.accountingSyncLogFindMany.map((args) => (args as { take: number }).take), [100, 100])
  assert.deepEqual((calls.accountingSyncLogFindMany[1] as { cursor: { id: string }; skip: number }).cursor, { id: 'sync-099' })
  assert.equal((calls.accountingSyncLogFindMany[1] as { skip: number }).skip, 1)
})

test('accounting event backfill skips unsupported payloads with a reason', async () => {
  const { client, createdEvents } = makeClient({
    syncLogs: [
      syncedJournalLog({
        id: 'sync-bad',
        payload: {
          date: '2026-04-26',
          lines: [{ accountCode: '400', description: 'Unbalanced', debit: 10 }],
        },
      }),
    ],
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  assert.equal(createdEvents.length, 0)
  const result = resultBySyncLog(report, 'sync-bad')
  assert.equal(result.action, 'skipped')
  assert.match(result.reason, /payload_validation_failed/)
})

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r2: every `*_INVOICE_UPDATE` that posted while the mirror could not hand over an
// external id has a SYNCED sync log carrying the document id and NO mirrored event. The backfill
// is the administrative repair for exactly that shape — and it could not perform it: its create
// hit the same `@@unique([externalSystem, externalId])` the mirror hit, and the outer handler
// recorded the P2002 as an opaque `db_error:` string. The one historical gap the backfill exists
// to close was the one it could not close.
// ---------------------------------------------------------------------------------------------

const INVOICE_CREATED_AT = new Date('2026-04-25T09:00:00.000Z')
const REVISION_QUEUED_AT = new Date('2026-04-25T10:00:00.000Z')

function syncedInvoiceUpdateLog(overrides: Partial<SyncLog> = {}): SyncLog {
  return {
    id: 'sync-invoice-update',
    connector: 'xero',
    type: 'SALES_INVOICE_UPDATE',
    status: 'SYNCED',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    externalTransactionId: 'INV-9',
    createdAt: REVISION_QUEUED_AT,
    payload: {
      date: '2026-04-25',
      currency: 'GBP',
      _idempotencyKey: 'sales-invoice-update:so-1:inv-9',
      invoiceNumber: 'INV-1001',
      contactName: 'Customer One',
      lines: [{ description: 'Widget', quantity: 1, unitAmount: 120, accountCode: '200' }],
    },
    ...overrides,
  }
}

/** The original post, already mirrored and holding the Xero invoice id. */
function postedInvoiceEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 'event-invoice',
    type: 'SALES_INVOICE',
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'so-1',
    businessDate: '2026-04-25',
    status: 'POSTED',
    idempotencyKey: 'accounting-sync:xero:sales_invoice:sales-invoice:so-1',
    externalSystem: 'xero',
    externalId: 'INV-9',
    createdAt: INVOICE_CREATED_AT,
    ...overrides,
  }
}

function createdEventData(createdEvents: unknown[], index = 0): EventRow {
  return (createdEvents[index] as { data: EventRow }).data
}

function logsByAction(createdLogs: unknown[], action: string) {
  return createdLogs
    .map((entry) => (entry as { data: { action: string; metadata?: Record<string, unknown> } }).data)
    .filter((entry) => entry.action === action)
}

test('o3d-cvj9 r2: a historical invoice revision is backfilled by taking the id from the create it revises', async () => {
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [syncedInvoiceUpdateLog()],
    events: [postedInvoiceEvent()],
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  const result = resultBySyncLog(report, 'sync-invoice-update')
  assert.equal(result.action, 'created')
  assert.equal(result.reason, 'created_missing_mirror_after_superseding_prior_revision')
  // The revision now names the document...
  assert.equal(createdEventData(createdEvents).externalId, 'INV-9')
  assert.equal(createdEventData(createdEvents).status, 'POSTED')
  // ...and the create it revises released the claim, audited exactly as the live mirror audits it.
  const superseded = logsByAction(createdLogs, 'superseded_by_revision')
  assert.equal(superseded.length, 1)
  assert.equal((superseded[0].metadata as { referenceId?: string }).referenceId, 'so-1')
})

test('o3d-cvj9 r3: SEVERAL unmirrored revisions of one document are all repaired, and none takes the id', async () => {
  // Two historical edits of one invoice, neither mirrored. "The create precedes its revisions" is
  // true of BOTH of them, so it says nothing about which is the latest — and nothing else in a
  // historical sync log does either. r2 ordered them by enqueue time, which is transaction start
  // time; this fixture sets that time against the outcome, so a repair still reading it would hand
  // the id to `sync-b-earlier-edit` and fail here.
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [
      syncedInvoiceUpdateLog({
        id: 'sync-a-later-edit',
        createdAt: new Date('2026-04-25T11:00:00.000Z'),
        payload: { ...(syncedInvoiceUpdateLog().payload as Record<string, unknown>), _idempotencyKey: 'sales-invoice-update:so-1:inv-9:b' },
      }),
      syncedInvoiceUpdateLog({ id: 'sync-b-earlier-edit', createdAt: REVISION_QUEUED_AT }),
    ],
    events: [postedInvoiceEvent()],
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  // BOTH are repaired — the whole point of the backfill is that neither stays invisible...
  for (const syncLogId of ['sync-a-later-edit', 'sync-b-earlier-edit']) {
    const result = resultBySyncLog(report, syncLogId)
    assert.equal(result.action, 'created', `${syncLogId} must not be stranded`)
    assert.equal(result.reason, 'created_missing_mirror_unclaimed_revision_order_unverified')
  }
  assert.equal(createdEvents.length, 2)
  // ...and neither claims the document, so the create keeps the id it already holds.
  assert.deepEqual(createdEvents.map((_, index) => createdEventData(createdEvents, index).externalId), [null, null])
  assert.deepEqual(createdEvents.map((_, index) => createdEventData(createdEvents, index).status), ['SUPERSEDED', 'SUPERSEDED'])
  assert.equal(logsByAction(createdLogs, 'superseded_by_revision').length, 0, 'nothing was superseded, so nothing may say so')
  assert.equal(logsByAction(createdLogs, 'revision_superseded_by_newer').length, 0, 'no row was shown to be newer')
  const unverified = logsByAction(createdLogs, 'revision_claim_order_unverified')
  assert.equal(unverified.length, 2)
  assert.deepEqual(
    unverified.map((entry) => (entry.metadata as { externalIdHeldByEventId?: string | null }).externalIdHeldByEventId),
    ['event-invoice', 'event-invoice'],
    'the audit names the row that kept the claim',
  )
  assert.deepEqual(
    unverified.map((entry) => (entry.metadata as { orderingBasis?: string }).orderingBasis),
    ['unestablished', 'unestablished'],
  )
})

test('o3d-cvj9 r3: a SINGLE unmirrored revision still takes the id from the create it revises', async () => {
  // The pairing that IS ordered, and the one the repair exists for: a document cannot be revised
  // before it exists. No stamp anywhere, and the handover still happens.
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [syncedInvoiceUpdateLog({ id: 'sync-only-edit' })],
    events: [postedInvoiceEvent({ externalRevisionAt: null })],
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  assert.equal(resultBySyncLog(report, 'sync-only-edit').reason, 'created_missing_mirror_after_superseding_prior_revision')
  assert.equal(createdEventData(createdEvents).externalId, 'INV-9')
  assert.equal(logsByAction(createdLogs, 'revision_claim_order_unverified').length, 0)
})

test('o3d-cvj9 r2: the backfill refuses an external id claimed by a DIFFERENT source document, and says so', async () => {
  const { client, createdEvents } = makeClient({
    syncLogs: [syncedInvoiceUpdateLog()],
    events: [postedInvoiceEvent({ id: 'event-other-order', sourceEntityId: 'so-2' })],
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  const result = resultBySyncLog(report, 'sync-invoice-update')
  assert.equal(result.action, 'skipped')
  assert.equal(result.reason, 'external_reference_claimed_elsewhere: different_source_document')
  assert.equal(createdEvents.length, 0, 'a refused claim writes nothing')
})

test('o3d-cvj9 r3: a revision contending with an already-mirrored REVISION is repaired unclaimed, not stranded', async () => {
  // The collision handler's case: a LIVE worker mirrors another edit of this invoice between the
  // candidate scan and the repair, so the id is held by a REVISION with no external revision stamp
  // (no historical row has one). Nothing orders the two. r2 refused, which left the sync log SYNCED
  // with no mirrored event at all — invisible to reconciliation, and re-skipped by every later run.
  // The repair now happens; only the CLAIM is withheld.
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [syncedInvoiceUpdateLog({ id: 'sync-second-edit' })],
    events: [postedInvoiceEvent()],
    afterExistingEventScan: (events) => {
      const create = events.find((row) => row.id === 'event-invoice')
      if (!create || events.some((row) => row.id === 'event-earlier-edit')) return
      create.externalId = null
      create.status = 'SUPERSEDED'
      events.push(postedInvoiceEvent({
        id: 'event-earlier-edit',
        type: 'SALES_INVOICE_UPDATE',
        idempotencyKey: 'accounting-sync:xero:sales_invoice_update:sales-invoice-update:so-1:inv-9:a',
        externalRevisionAt: null,
      }))
    },
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  const result = resultBySyncLog(report, 'sync-second-edit')
  assert.equal(result.action, 'created', 'the row this repair exists to rescue must not be skipped')
  assert.equal(result.reason, 'created_missing_mirror_unclaimed_revision_order_unverified')
  assert.equal(createdEvents.length, 1)
  assert.equal(createdEventData(createdEvents).externalId, null, 'an unordered pair claims nothing')
  assert.equal(createdEventData(createdEvents).status, 'SUPERSEDED')
  const unverified = logsByAction(createdLogs, 'revision_claim_order_unverified')
  assert.equal(unverified.length, 1)
  assert.equal((unverified[0].metadata as { externalIdHeldByEventId?: string }).externalIdHeldByEventId, 'event-earlier-edit')
  assert.equal(logsByAction(createdLogs, 'revision_superseded_by_newer').length, 0, 'nothing established that the holder is newer')
})

test('o3d-cvj9 r3: a genuine cross-document collision is still SKIPPED with its own reason', async () => {
  // The refusals that are not about ordering must keep refusing: a second document claiming one
  // Xero invoice is the double post the unique index exists to catch, and repairing it would write
  // a row asserting the collision was benign.
  const { client, createdEvents } = makeClient({
    syncLogs: [syncedInvoiceUpdateLog({ id: 'sync-collision' })],
    events: [postedInvoiceEvent({ id: 'event-credit-note', type: 'CREDIT_NOTE' })],
  })

  const report = await runTestBackfill({ client: client as never, dryRun: false })

  const result = resultBySyncLog(report, 'sync-collision')
  assert.equal(result.action, 'skipped')
  assert.equal(result.reason, 'external_reference_claimed_elsewhere: unrelated_event_type')
  assert.equal(createdEvents.length, 0, 'a refused claim writes nothing')
})
