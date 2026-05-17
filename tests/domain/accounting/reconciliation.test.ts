import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectAccountingReconciliationRows,
  evaluateAccountingReconciliationRows,
  listAccountingReconciliationRuns,
  persistAccountingReconciliationReport,
  updateAccountingReconciliationFindingStatus,
  type AccountingReconciliationReport,
  type AccountingReconciliationRows,
} from '@/lib/domain/accounting/reconciliation'

const A1_DATE = new Date('2026-04-24T10:00:00.000Z')
const A2_DATE = new Date('2026-04-24T11:00:00.000Z')
const B_DATE = new Date('2026-04-25T10:00:00.000Z')

function cleanRows(): AccountingReconciliationRows {
  return {
    salesOrders: [{
      id: 'order-1',
      orderNumber: 'SO-1',
      externalOrderNumber: null,
      status: 'SHIPPED',
      revenueDeferredDate: A1_DATE,
      inventoryAllocatedDate: A2_DATE,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      shipmentJournalDate: B_DATE,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-1',
      accountingCreditNoteId: 'credit-note-1',
      totalBase: '10',
      accountingRetrySyncs: null,
    }],
    syncLogs: [
      {
        id: 'sync-a1',
        connector: 'xero',
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'A1-2026-04-24',
        externalTransactionId: 'journal-a1',
        payload: { date: '2026-04-24' },
      },
      {
        id: 'sync-a2',
        connector: 'xero',
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'A2-2026-04-24',
        externalTransactionId: 'journal-a2',
        payload: { date: '2026-04-24' },
      },
      {
        id: 'sync-b',
        connector: 'xero',
        type: 'DAILY_BATCH_GROUP_B',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'B-2026-04-25',
        externalTransactionId: 'journal-b',
        payload: { date: '2026-04-25' },
      },
      {
        id: 'sync-refund-cogs',
        connector: 'xero',
        type: 'COGS_REVERSAL',
        status: 'SYNCED',
        referenceType: 'SalesOrderRefund',
        referenceId: 'refund-1',
        externalTransactionId: 'journal-refund-cogs',
        payload: { _idempotencyKey: 'sales-order-refund:refund-1:cogs-reversal' },
      },
    ],
    accountingEvents: [
      {
        id: 'event-a1',
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        sourceEntityType: 'DailyBatch',
        sourceEntityId: 'A1-2026-04-24',
        businessDate: A1_DATE,
        status: 'POSTED',
        idempotencyKey: 'event-a1-key',
        externalSystem: 'xero',
        externalId: 'journal-a1',
      },
      {
        id: 'event-a2',
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        sourceEntityType: 'DailyBatch',
        sourceEntityId: 'A2-2026-04-24',
        businessDate: A2_DATE,
        status: 'POSTED',
        idempotencyKey: 'event-a2-key',
        externalSystem: 'xero',
        externalId: 'journal-a2',
      },
      {
        id: 'event-b',
        type: 'DAILY_BATCH_GROUP_B',
        sourceEntityType: 'DailyBatch',
        sourceEntityId: 'B-2026-04-25',
        businessDate: B_DATE,
        status: 'POSTED',
        idempotencyKey: 'event-b-key',
        externalSystem: 'xero',
        externalId: 'journal-b',
      },
      {
        id: 'event-refund-cogs',
        type: 'COGS_REVERSAL',
        sourceEntityType: 'SalesOrderRefund',
        sourceEntityId: 'refund-1',
        businessDate: B_DATE,
        status: 'POSTED',
        idempotencyKey: 'event-refund-cogs-key',
        externalSystem: 'xero',
        externalId: 'journal-refund-cogs',
      },
    ],
  }
}

function persistenceClient() {
  const runs: Array<Record<string, unknown>> = []
  const findings: Array<Record<string, unknown>> = []
  type TestPersistenceClient = {
    $transaction<T>(fn: (tx: TestPersistenceClient) => Promise<T>): Promise<T>
    accountingReconciliationRun: {
      create(args: unknown): Promise<Record<string, unknown>>
      findMany(args: unknown): Promise<Array<Record<string, unknown>>>
    }
    accountingReconciliationFinding: {
      createMany(args: unknown): Promise<{ count: number }>
      update(args: unknown): Promise<Record<string, unknown>>
    }
  }
  const client: TestPersistenceClient = {
    $transaction: async <T>(fn: (tx: TestPersistenceClient) => Promise<T>) => fn(client),
    accountingReconciliationRun: {
      async create(args: unknown) {
        const data = (args as { data: Record<string, unknown> }).data
        const row = {
          id: `run-${runs.length + 1}`,
          createdAt: new Date('2026-05-17T12:00:00.000Z'),
          ...data,
        }
        runs.push(row)
        return row
      },
      async findMany(args: unknown) {
        const include = (args as { include?: { findings?: unknown; _count?: unknown } }).include
        return [...runs].reverse().map((run) => ({
          ...run,
          ...(include?.findings ? { findings: findings.filter((finding) => finding.runId === run.id) } : {}),
          ...(include?._count ? { _count: { findings: findings.filter((finding) => finding.runId === run.id).length } } : {}),
        }))
      },
    },
    accountingReconciliationFinding: {
      async createMany(args: unknown) {
        const data = (args as { data: Array<Record<string, unknown>> }).data
        for (const entry of data) {
          findings.push({
            id: `finding-${findings.length + 1}`,
            createdAt: new Date('2026-05-17T12:00:00.000Z'),
            ...entry,
          })
        }
        return { count: data.length }
      },
      async update(args: unknown) {
        const { where, data } = args as { where: { id: string }; data: { status: string } }
        const finding = findings.find((entry) => entry.id === where.id)
        if (!finding) throw new Error('Finding not found')
        finding.status = data.status
        return finding
      },
    },
  }

  return { client, runs, findings }
}

test('clean reconciliation rows produce no findings', () => {
  assert.deepEqual(evaluateAccountingReconciliationRows(cleanRows()), [])
})

test('persisted reconciliation run stores summary counts and findings for later review', async () => {
  const { client, runs, findings } = persistenceClient()
  const report: AccountingReconciliationReport = {
    checkedAt: '2026-05-17T12:00:00.000Z',
    fromDate: '2026-02-16T12:00:00.000Z',
    toDate: '2026-05-17T12:00:00.000Z',
    summary: { total: 2, warning: 1, critical: 1 },
    findings: [
      {
        severity: 'critical',
        code: 'terminal_refunded_order_missing_credit_note_evidence',
        orderId: 'order-1',
        refundId: 'refund-1',
        message: 'Missing credit note',
        details: { status: 'REFUNDED' },
      },
      {
        severity: 'warning',
        code: 'old_sync_log_without_mirrored_event',
        syncLogId: 'sync-1',
        message: 'Missing mirrored event',
        details: { connector: 'xero' },
      },
    ],
  }

  const persisted = await persistAccountingReconciliationReport(report, client as never)

  assert.equal(persisted.persisted, true)
  assert.equal(persisted.runId, 'run-1')
  assert.equal(runs[0].status, 'COMPLETED')
  assert.equal(runs[0].totalCount, 2)
  assert.equal(runs[0].warningCount, 1)
  assert.equal(runs[0].criticalCount, 1)
  assert.equal(findings.length, 2)
  assert.equal(findings[0].runId, 'run-1')
  assert.equal(findings[0].entityType, 'SalesOrderRefund')
  assert.equal(findings[0].entityId, 'refund-1')
  assert.equal(findings[0].status, 'OPEN')
  assert.deepEqual(findings[0].details, { status: 'REFUNDED' })
})

test('persisted reconciliation runs can be listed with finding counts', async () => {
  const { client } = persistenceClient()
  const report: AccountingReconciliationReport = {
    checkedAt: '2026-05-17T12:00:00.000Z',
    fromDate: '2026-02-16T12:00:00.000Z',
    toDate: '2026-05-17T12:00:00.000Z',
    summary: { total: 1, warning: 1, critical: 0 },
    findings: [{
      severity: 'warning',
      code: 'reconciliation_row_cap_reached',
      message: 'Row cap reached',
      details: { dataset: 'salesOrders' },
    }],
  }
  await persistAccountingReconciliationReport(report, client as never)

  const runs = await listAccountingReconciliationRuns(client as never, { limit: 10 })

  assert.equal(runs.length, 1)
  assert.equal(runs[0].id, 'run-1')
  assert.deepEqual(runs[0]._count, { findings: 1 })
})

test('reconciliation finding status updates accept review states and reject invalid values', async () => {
  const { client, findings } = persistenceClient()
  await persistAccountingReconciliationReport({
    checkedAt: '2026-05-17T12:00:00.000Z',
    fromDate: '2026-02-16T12:00:00.000Z',
    toDate: '2026-05-17T12:00:00.000Z',
    summary: { total: 1, warning: 0, critical: 1 },
    findings: [{
      severity: 'critical',
      code: 'posted_event_without_external_id',
      accountingEventId: 'event-1',
      message: 'Posted event missing external ID',
      details: { type: 'DAILY_BATCH_GROUP_B' },
    }],
  }, client as never)

  const updated = await updateAccountingReconciliationFindingStatus('finding-1', 'accepted', client as never)

  assert.equal(updated.status, 'ACCEPTED')
  assert.equal(findings[0].status, 'ACCEPTED')
  await assert.rejects(
    () => updateAccountingReconciliationFindingStatus('finding-1', 'IGNORED', client as never),
    /Invalid accounting reconciliation finding status/,
  )
})

test('sources with accounting state report missing mirrored events', () => {
  const rows = cleanRows()
  rows.accountingEvents = []

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('source_order_revenue_deferral_without_event'))
  assert.ok(codes.includes('source_order_inventory_allocation_without_event'))
  assert.ok(codes.includes('source_shipment_without_event'))
  assert.ok(codes.includes('source_refund_without_event'))
})

test('old mirrorable sync logs report missing accounting events', () => {
  const rows = cleanRows()
  rows.accountingEvents = rows.accountingEvents.filter((event) => event.type !== 'COGS_REVERSAL')

  const finding = evaluateAccountingReconciliationRows(rows).find((entry) => (
    entry.code === 'old_sync_log_without_mirrored_event' &&
    entry.syncLogId === 'sync-refund-cogs'
  ))

  assert.ok(finding)
})

test('events report missing source state, posted external IDs, and duplicate external references', () => {
  const rows = cleanRows()
  rows.accountingEvents.push(
    {
      id: 'event-orphan',
      type: 'DAILY_BATCH_GROUP_B',
      sourceEntityType: 'DailyBatch',
      sourceEntityId: 'B-2026-04-20',
      businessDate: new Date('2026-04-20T00:00:00.000Z'),
      status: 'PENDING',
      idempotencyKey: 'event-orphan-key',
      externalSystem: 'xero',
      externalId: null,
    },
    {
      id: 'event-posted-missing-id',
      type: 'DAILY_BATCH_GROUP_B',
      sourceEntityType: 'DailyBatch',
      sourceEntityId: 'B-2026-04-25',
      businessDate: B_DATE,
      status: 'POSTED',
      idempotencyKey: 'event-posted-missing-id-key',
      externalSystem: 'xero',
      externalId: null,
    },
    {
      id: 'event-duplicate-reference',
      type: 'DAILY_BATCH_GROUP_B',
      sourceEntityType: 'DailyBatch',
      sourceEntityId: 'B-2026-04-25',
      businessDate: B_DATE,
      status: 'POSTED',
      idempotencyKey: 'event-duplicate-reference-key',
      externalSystem: 'xero',
      externalId: 'journal-b',
    },
  )

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('event_without_source'))
  assert.ok(codes.includes('posted_event_without_external_id'))
  assert.ok(codes.includes('duplicate_external_reference'))
})

test('refund retry sync payload counts as expected refund event source', () => {
  const rows = cleanRows()
  rows.syncLogs = rows.syncLogs.filter((log) => log.type !== 'COGS_REVERSAL')
  rows.refunds[0] = {
    ...rows.refunds[0],
    accountingRetrySyncs: [
      { type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: 'refund-1' },
    ],
  }
  rows.accountingEvents = rows.accountingEvents.filter((event) => event.type !== 'UNEARNED_REV_REVERSAL')

  const finding = evaluateAccountingReconciliationRows(rows).find((entry) => (
    entry.code === 'source_refund_without_event' &&
    entry.refundId === 'refund-1'
  ))

  assert.ok(finding)
})

test('cancelled terminal order with posted accounting reports missing reversal evidence', () => {
  const rows = cleanRows()
  rows.salesOrders = [{
    ...rows.salesOrders[0],
    id: 'order-cancelled',
    orderNumber: 'SO-CANCELLED',
    status: 'CANCELLED',
  }]
  rows.shipments = []
  rows.refunds = []

  const finding = evaluateAccountingReconciliationRows(rows).find((entry) => (
    entry.code === 'terminal_cancelled_order_missing_reversal_evidence' &&
    entry.orderId === 'order-cancelled'
  ))

  assert.ok(finding)
  assert.equal(finding.severity, 'critical')
})

test('refunded terminal order with posted shipment reports missing credit-note and reversal evidence', () => {
  const rows = cleanRows()
  rows.salesOrders = [{
    ...rows.salesOrders[0],
    status: 'REFUNDED',
  }]
  rows.refunds = [{
    ...rows.refunds[0],
    accountingCreditNoteId: null,
    accountingRetrySyncs: null,
  }]
  rows.syncLogs = rows.syncLogs.filter((log) => log.referenceType !== 'SalesOrderRefund')
  rows.accountingEvents = rows.accountingEvents.filter((event) => event.sourceEntityType !== 'SalesOrderRefund')

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('terminal_refunded_order_missing_credit_note_evidence'))
  assert.ok(codes.includes('terminal_refunded_order_missing_reversal_evidence'))
})

test('zero-value refund on a posted-shipment order does not require reversal evidence', () => {
  const rows = cleanRows()
  rows.salesOrders = [{
    ...rows.salesOrders[0],
    status: 'REFUNDED',
  }]
  rows.refunds = [{
    ...rows.refunds[0],
    accountingRetrySyncs: null,
    totalBase: '0',
  }]
  rows.syncLogs = rows.syncLogs.filter((log) => log.type !== 'COGS_REVERSAL')
  rows.accountingEvents = rows.accountingEvents.filter((event) => event.type !== 'COGS_REVERSAL')

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.equal(codes.includes('terminal_refunded_order_missing_reversal_evidence'), false)
})

test('live sync status membership gates terminal credit-note evidence', () => {
  for (const status of ['PENDING', 'PROCESSING', 'SYNCED']) {
    const rows = cleanRows()
    rows.salesOrders = [{ ...rows.salesOrders[0], status: 'REFUNDED' }]
    rows.refunds = [{ ...rows.refunds[0], accountingCreditNoteId: null }]
    rows.syncLogs = rows.syncLogs.filter((log) => log.referenceType !== 'SalesOrderRefund')
    rows.accountingEvents = rows.accountingEvents.filter((event) => event.sourceEntityType !== 'SalesOrderRefund' || event.type !== 'CREDIT_NOTE')
    rows.syncLogs.push({
      id: `sync-refund-credit-note-${status}`,
      connector: 'xero',
      type: 'CREDIT_NOTE',
      status,
      referenceType: 'SalesOrderRefund',
      referenceId: 'refund-1',
      externalTransactionId: status === 'SYNCED' ? 'credit-note-1' : null,
      payload: { _idempotencyKey: `sales-order-refund:refund-1:credit-note:${status}` },
    })

    const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

    assert.equal(codes.includes('terminal_refunded_order_missing_credit_note_evidence'), false)
  }

  for (const status of ['FAILED', 'REJECTED']) {
    const rows = cleanRows()
    rows.salesOrders = [{ ...rows.salesOrders[0], status: 'REFUNDED' }]
    rows.refunds = [{ ...rows.refunds[0], accountingCreditNoteId: null }]
    rows.syncLogs = rows.syncLogs.filter((log) => log.referenceType !== 'SalesOrderRefund')
    rows.accountingEvents = rows.accountingEvents.filter((event) => event.sourceEntityType !== 'SalesOrderRefund' || event.type !== 'CREDIT_NOTE')
    rows.syncLogs.push({
      id: `sync-refund-credit-note-${status}`,
      connector: 'xero',
      type: 'CREDIT_NOTE',
      status,
      referenceType: 'SalesOrderRefund',
      referenceId: 'refund-1',
      externalTransactionId: null,
      payload: { _idempotencyKey: `sales-order-refund:refund-1:credit-note:${status}` },
    })

    const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

    assert.equal(codes.includes('terminal_refunded_order_missing_credit_note_evidence'), true)
  }
})

test('cancelled terminal order with reversal evidence stays clean', () => {
  const rows = cleanRows()
  rows.salesOrders = [{
    ...rows.salesOrders[0],
    id: 'order-cancelled',
    orderNumber: 'SO-CANCELLED',
    status: 'CANCELLED',
  }]
  rows.shipments = []
  rows.refunds = [{
    ...rows.refunds[0],
    orderId: 'order-cancelled',
  }]
  rows.syncLogs = rows.syncLogs.filter((log) => log.referenceType !== 'SalesOrderRefund')
  rows.syncLogs.push({
    id: 'sync-cancelled-reversal',
    connector: 'xero',
    type: 'COGS_REVERSAL',
    status: 'SYNCED',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    externalTransactionId: 'cancelled-reversal-1',
    payload: { _idempotencyKey: 'sales-order-refund:refund-1:cogs-reversal' },
  })

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.equal(codes.includes('terminal_cancelled_order_missing_reversal_evidence'), false)
})

test('refund sync evidence on a cancelled order still reports missing mirrored event', () => {
  const rows = cleanRows()
  rows.salesOrders = [{
    ...rows.salesOrders[0],
    id: 'order-cancelled',
    orderNumber: 'SO-CANCELLED',
    status: 'CANCELLED',
  }]
  rows.refunds = [{
    ...rows.refunds[0],
    orderId: 'order-cancelled',
    accountingRetrySyncs: [
      { type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: 'refund-1' },
    ],
  }]
  rows.accountingEvents = rows.accountingEvents.filter((event) => event.sourceEntityType !== 'SalesOrderRefund')

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.equal(codes.includes('source_refund_without_event'), true)
})

test('refunded terminal order with credit-note and reversal evidence stays clean', () => {
  const rows = cleanRows()
  rows.salesOrders = [{
    ...rows.salesOrders[0],
    status: 'PARTIALLY_REFUNDED',
  }]
  rows.syncLogs.push({
    id: 'sync-refund-credit-note',
    connector: 'xero',
    type: 'CREDIT_NOTE',
    status: 'SYNCED',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    externalTransactionId: 'credit-note-1',
    payload: { _idempotencyKey: 'sales-order-refund:refund-1:credit-note' },
  })

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.equal(codes.includes('terminal_refunded_order_missing_credit_note_evidence'), false)
  assert.equal(codes.includes('terminal_refunded_order_missing_reversal_evidence'), false)
})

test('row cap exhaustion emits an incomplete-report warning', () => {
  const rows = cleanRows()
  rows.salesOrders = Array.from({ length: 10_000 }, (_, index) => ({
    ...rows.salesOrders[0],
    id: `order-${index}`,
    orderNumber: `SO-${index}`,
    revenueDeferredDate: null,
    inventoryAllocatedDate: null,
  }))
  rows.shipments = []
  rows.refunds = []
  rows.syncLogs = []
  rows.accountingEvents = []

  const finding = evaluateAccountingReconciliationRows(rows).find((entry) => (
    entry.code === 'reconciliation_row_cap_reached'
  ))

  assert.ok(finding)
  assert.equal((finding.details as { dataset?: unknown }).dataset, 'salesOrders')
})

test('accounting reconciliation row collection selects required datasets', async () => {
  const calls: Record<string, unknown> = {}
  const client = {
    salesOrder: {
      async findMany(args: unknown) {
        calls.salesOrder = args
        return []
      },
    },
    shipment: {
      async findMany(args: unknown) {
        calls.shipment = args
        return []
      },
    },
    salesOrderRefund: {
      async findMany(args: unknown) {
        calls.salesOrderRefund = args
        return []
      },
    },
    accountingSyncLog: {
      async findMany(args: unknown) {
        calls.accountingSyncLog = args
        return []
      },
    },
    accountingEvent: {
      async findMany(args: unknown) {
        calls.accountingEvent = args
        return []
      },
    },
  }

  await collectAccountingReconciliationRows(client)

  assert.ok(calls.salesOrder)
  assert.ok(calls.shipment)
  assert.ok(calls.salesOrderRefund)
  assert.ok(calls.accountingSyncLog)
  assert.ok(calls.accountingEvent)
  const salesOrderCall = calls.salesOrder as {
    where: {
      OR: Array<{
        revenueDeferredDate?: { gte?: unknown }
        inventoryAllocatedDate?: { gte?: unknown }
        status?: { in?: string[] }
        updatedAt?: { gte?: unknown }
      }>
    }
    take: number
  }
  const salesOrderWhere = salesOrderCall.where
  assert.ok(salesOrderWhere.OR[0].revenueDeferredDate?.gte instanceof Date)
  assert.ok(salesOrderWhere.OR[1].inventoryAllocatedDate?.gte instanceof Date)
  assert.deepEqual(salesOrderWhere.OR[2].status, {
    in: ['REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'COMPLETED', 'DELIVERED'],
  })
  assert.ok(salesOrderWhere.OR[2].updatedAt?.gte instanceof Date)
  assert.equal(salesOrderCall.take, 10000)
  const shipmentWhere = (calls.shipment as { where: { shipmentJournalDate: { gte?: unknown } } }).where
  assert.ok(shipmentWhere.shipmentJournalDate.gte instanceof Date)
  assert.equal((calls.shipment as { take: number }).take, 10000)
  assert.equal((calls.salesOrderRefund as { take: number }).take, 10000)
  assert.equal((calls.accountingSyncLog as { take: number }).take, 10000)
  assert.equal((calls.accountingEvent as { take: number }).take, 10000)
})
