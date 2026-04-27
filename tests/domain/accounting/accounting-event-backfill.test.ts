import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  runAccountingEventBackfill,
  type AccountingEventBackfillReport,
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
    findMany(): Promise<EventRow[]>
    create(args: { data: EventRow }): Promise<{ id: string }>
  }
  accountingEventLog: {
    create(args: unknown): Promise<{ id: string }>
  }
}

type MockBackfillClient = MockTransactionClient & {
  salesOrder: { findMany(): Promise<unknown[]> }
  shipment: { findMany(): Promise<unknown[]> }
  salesOrderRefund: { findMany(): Promise<unknown[]> }
  accountingSyncLog: { findMany(): Promise<SyncLog[]> }
  $transaction<T>(fn: (tx: MockTransactionClient) => Promise<T>): Promise<T>
}

function makeClient(input: {
  syncLogs: SyncLog[]
  events?: EventRow[]
  eventCreateError?: unknown
  logCreateError?: unknown
}) {
  const events: EventRow[] = [...(input.events ?? [])]
  const createdEvents: unknown[] = []
  const createdLogs: unknown[] = []

  const client: MockBackfillClient = {
    salesOrder: {
      async findMany() {
        return []
      },
    },
    shipment: {
      async findMany() {
        return []
      },
    },
    salesOrderRefund: {
      async findMany() {
        return []
      },
    },
    accountingSyncLog: {
      async findMany() {
        return input.syncLogs
      },
    },
    accountingEvent: {
      async findMany() {
        return events
      },
      async create(args: { data: EventRow }) {
        if (input.eventCreateError) throw input.eventCreateError
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
    createdEvents,
    createdLogs,
    client,
  }
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

  const report = await runAccountingEventBackfill({ client: client as never })

  assert.equal(report.dryRun, true)
  assert.equal(report.summary.candidates, 1)
  assert.equal(report.summary.wouldCreate, 1)
  assert.equal(createdEvents.length, 0)
  const result = resultBySyncLog(report, 'sync-a1')
  assert.equal(result.action, 'would_create')
  assert.equal(result.reason, 'dry_run')
  assert.equal(result.idempotencyKey, 'accounting-sync:xero:daily_batch_revenue_deferral:daily-batch:a1:2026-04-26')
})

test('accounting event backfill creates missing journal and document events', async () => {
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [syncedJournalLog(), syncedDocumentLog()],
  })

  const report = await runAccountingEventBackfill({ client: client as never, dryRun: false })

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

  const report = await runAccountingEventBackfill({ client: client as never, dryRun: false })

  assert.equal(createdEvents.length, 0)
  assert.equal(createdLogs.length, 0)
  const result = resultBySyncLog(report, 'sync-missing-external')
  assert.equal(result.action, 'skipped')
  assert.equal(result.reason, 'posted_sync_log_missing_external_transaction_id')
  assert.equal(result.idempotencyKey, 'accounting-sync:xero:daily_batch_revenue_deferral:daily-batch:a1:2026-04-26')
})

test('accounting event backfill only treats idempotency key conflicts as already mirrored', async () => {
  const idempotencySetup = makeClient({
    syncLogs: [syncedJournalLog()],
    eventCreateError: uniqueError(['idempotencyKey']),
  })

  const idempotencyReport = await runAccountingEventBackfill({
    client: idempotencySetup.client as never,
    dryRun: false,
  })

  assert.equal(resultBySyncLog(idempotencyReport, 'sync-a1').reason, 'accounting_event_already_exists')

  const externalIdSetup = makeClient({
    syncLogs: [syncedJournalLog()],
    eventCreateError: uniqueError(['externalSystem', 'externalId']),
  })

  await assert.rejects(
    () => runAccountingEventBackfill({ client: externalIdSetup.client as never, dryRun: false }),
    /Unique constraint failed/,
  )
})

test('accounting event backfill rolls back the event when audit logging fails', async () => {
  const { client, createdEvents, createdLogs } = makeClient({
    syncLogs: [syncedJournalLog()],
    logCreateError: new Error('audit log failed'),
  })

  await assert.rejects(
    () => runAccountingEventBackfill({ client: client as never, dryRun: false }),
    /audit log failed/,
  )

  assert.equal(createdEvents.length, 0)
  assert.equal(createdLogs.length, 0)
})

test('accounting event backfill reruns are idempotent through reconciliation candidates', async () => {
  const setup = makeClient({ syncLogs: [syncedJournalLog()] })

  const first = await runAccountingEventBackfill({ client: setup.client as never, dryRun: false })
  const second = await runAccountingEventBackfill({ client: setup.client as never, dryRun: false })

  assert.equal(first.summary.created, 1)
  assert.equal(second.summary.candidates, 0)
  assert.equal(setup.createdEvents.length, 1)
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

  const report = await runAccountingEventBackfill({ client: client as never, dryRun: false })

  assert.equal(createdEvents.length, 0)
  const result = resultBySyncLog(report, 'sync-bad')
  assert.equal(result.action, 'skipped')
  assert.match(result.reason, /payload_validation_failed/)
})
