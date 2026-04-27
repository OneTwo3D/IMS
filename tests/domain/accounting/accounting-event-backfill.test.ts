import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  runAccountingEventBackfill,
  type AccountingEventBackfillReport,
  type RunAccountingEventBackfillOptions,
} from '@/lib/domain/accounting/accounting-event-backfill'

type SyncLog = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  payload: unknown
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
}

type MockTransactionClient = {
  accountingEvent: {
    findMany(args?: unknown): Promise<EventRow[]>
    create(args: { data: EventRow }): Promise<{ id: string }>
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

function makeClient(input: {
  syncLogs: SyncLog[]
  events?: EventRow[]
  eventCreateError?: unknown | ((args: { data: EventRow }) => unknown)
  logCreateError?: unknown
  throwOnSourceRead?: boolean
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
        return events
      },
      async create(args: { data: EventRow }) {
        if (typeof input.eventCreateError === 'function') {
          const error = input.eventCreateError(args)
          if (error) throw error
        } else if (input.eventCreateError) {
          throw input.eventCreateError
        }
        createdEvents.push(args)
        const event = { ...args.data, id: `event-${createdEvents.length}` }
        events.push(event)
        return { id: event.id }
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
      const eventRowsSnapshot = [...events]
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
  }
}

function resultBySyncLog(report: AccountingEventBackfillReport, syncLogId: string) {
  const result = report.results.find((entry) => entry.syncLogId === syncLogId)
  assert.ok(result)
  return result
}

function uniqueError(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
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
  assert.equal((calls.accountingSyncLogFindMany[0] as { take: number }).take, 2)
  assert.equal(calls.salesOrderFindMany.length, 0)
  assert.equal(calls.shipmentFindMany.length, 0)
  assert.equal(calls.salesOrderRefundFindMany.length, 0)
})

test('accounting event backfill pages deterministically until it fills the limit', async () => {
  const mirrored = syncedJournalLog({
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
  })
  const missing = syncedJournalLog({
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
  })
  const { calls, client } = makeClient({
    syncLogs: [missing, mirrored],
    events: [mirroredEventForLog(mirrored)],
    throwOnSourceRead: true,
  })

  const report = await runTestBackfill({ client: client as never, limit: 1 })

  assert.deepEqual(report.results.map((result) => result.syncLogId), ['sync-b'])
  assert.equal(report.summary.candidates, 1)
  assert.equal(calls.accountingSyncLogFindMany.length, 2)
  assert.deepEqual(calls.accountingSyncLogFindMany.map((args) => (args as { take: number }).take), [1, 1])
  assert.deepEqual((calls.accountingSyncLogFindMany[1] as { cursor: { id: string }; skip: number }).cursor, { id: 'sync-a' })
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
