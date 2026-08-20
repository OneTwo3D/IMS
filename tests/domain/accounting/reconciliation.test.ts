import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  MAX_RECONCILIATION_FINDINGS_PER_RUN,
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
      refundStatus: 'NONE',
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
  let failNextCreateMany = false
  let failNextUpdate = false
  type TestPersistenceClient = {
    $transaction<T>(fn: (tx: TestPersistenceClient) => Promise<T>): Promise<T>
    accountingReconciliationRun: {
      create(args: unknown): Promise<Record<string, unknown>>
      findMany(args: unknown): Promise<Array<Record<string, unknown>>>
    }
    accountingReconciliationFinding: {
      createMany(args: unknown): Promise<{ count: number }>
      findUnique(args: unknown): Promise<Record<string, unknown> | null>
      update(args: unknown): Promise<Record<string, unknown>>
    }
    failNextCreateMany(): void
    failNextUpdate(): void
  }
  const client: TestPersistenceClient = {
    async $transaction<T>(fn: (tx: TestPersistenceClient) => Promise<T>) {
      const runSnapshot = runs.map((entry) => ({ ...entry }))
      const findingSnapshot = findings.map((entry) => ({ ...entry }))
      try {
        return await fn(client)
      } catch (error) {
        runs.splice(0, runs.length, ...runSnapshot)
        findings.splice(0, findings.length, ...findingSnapshot)
        throw error
      }
    },
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
        const findingTake = include?.findings && typeof include.findings === 'object' && 'take' in include.findings
          ? (include.findings as { take?: number }).take
          : undefined
        return [...runs].reverse().map((run) => ({
          ...run,
          ...(include?.findings ? { findings: findings.filter((finding) => finding.runId === run.id).slice(0, findingTake) } : {}),
          ...(include?._count ? { _count: { findings: findings.filter((finding) => finding.runId === run.id).length } } : {}),
        }))
      },
    },
    accountingReconciliationFinding: {
      async createMany(args: unknown) {
        if (failNextCreateMany) {
          failNextCreateMany = false
          throw new Error('createMany failed')
        }
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
      async findUnique(args: unknown) {
        const { where } = args as { where: { id: string } }
        return findings.find((entry) => entry.id === where.id) ?? null
      },
      async update(args: unknown) {
        if (failNextUpdate) {
          failNextUpdate = false
          throw new Error('update failed')
        }
        const { where, data } = args as { where: { id: string }; data: { status: string } }
        const finding = findings.find((entry) => entry.id === where.id)
        if (!finding) throw new Error('Finding not found')
        Object.assign(finding, data)
        return finding
      },
    },
    failNextCreateMany() {
      failNextCreateMany = true
    },
    failNextUpdate() {
      failNextUpdate = true
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

test('includeFindings run listing caps finding rows per run and keeps total count', async () => {
  const { client } = persistenceClient()
  const report: AccountingReconciliationReport = {
    checkedAt: '2026-05-17T12:00:00.000Z',
    fromDate: '2026-02-16T12:00:00.000Z',
    toDate: '2026-05-17T12:00:00.000Z',
    summary: {
      total: MAX_RECONCILIATION_FINDINGS_PER_RUN + 1,
      warning: MAX_RECONCILIATION_FINDINGS_PER_RUN + 1,
      critical: 0,
    },
    findings: Array.from({ length: MAX_RECONCILIATION_FINDINGS_PER_RUN + 1 }, (_, index) => ({
      severity: 'warning' as const,
      code: 'reconciliation_row_cap_reached',
      message: `Row cap reached ${index}`,
      details: { dataset: 'salesOrders', index },
    })),
  }
  await persistAccountingReconciliationReport(report, client as never)

  const runs = await listAccountingReconciliationRuns(client as never, { limit: 10, includeFindings: true })

  assert.equal(runs[0].findings?.length, MAX_RECONCILIATION_FINDINGS_PER_RUN)
  assert.deepEqual(runs[0]._count, { findings: MAX_RECONCILIATION_FINDINGS_PER_RUN + 1 })
})

test('persisting reconciliation runs rolls back the run when finding writes fail', async () => {
  const { client, runs, findings } = persistenceClient()
  client.failNextCreateMany()

  await assert.rejects(
    () => persistAccountingReconciliationReport({
      checkedAt: '2026-05-17T12:00:00.000Z',
      fromDate: '2026-02-16T12:00:00.000Z',
      toDate: '2026-05-17T12:00:00.000Z',
      summary: { total: 1, warning: 1, critical: 0 },
      findings: [{
        severity: 'warning',
        code: 'old_sync_log_without_mirrored_event',
        syncLogId: 'sync-1',
        message: 'Missing mirrored event',
        details: { connector: 'xero' },
      }],
    }, client as never),
    /createMany failed/,
  )

  assert.equal(runs.length, 0)
  assert.equal(findings.length, 0)
})

test('each persisted reconciliation report creates a distinct audit run', async () => {
  const { client, runs } = persistenceClient()
  const report: AccountingReconciliationReport = {
    checkedAt: '2026-05-17T12:00:00.000Z',
    fromDate: '2026-02-16T12:00:00.000Z',
    toDate: '2026-05-17T12:00:00.000Z',
    summary: { total: 0, warning: 0, critical: 0 },
    findings: [],
  }

  await persistAccountingReconciliationReport(report, client as never)
  await persistAccountingReconciliationReport(report, client as never)

  assert.deepEqual(runs.map((run) => run.id), ['run-1', 'run-2'])
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

  const { finding: updated, priorStatus } = await updateAccountingReconciliationFindingStatus(
    'finding-1',
    'accepted',
    'admin-1',
    client as never,
  )

  assert.equal(priorStatus, 'OPEN')
  assert.equal(updated.status, 'ACCEPTED')
  assert.ok(updated.statusUpdatedAt)
  assert.equal(updated.statusUpdatedBy, 'admin-1')
  assert.equal(findings[0].status, 'ACCEPTED')
  await assert.rejects(
    () => updateAccountingReconciliationFindingStatus('finding-1', 'IGNORED', 'admin-1', client as never),
    /Invalid accounting reconciliation finding status/,
  )
})

test('reconciliation finding status update rolls back when the update fails after prior read', async () => {
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
  client.failNextUpdate()

  await assert.rejects(
    () => updateAccountingReconciliationFindingStatus('finding-1', 'RESOLVED', 'admin-1', client as never),
    /update failed/,
  )

  assert.equal(findings[0].status, 'OPEN')
  assert.equal(findings[0].statusUpdatedBy, undefined)
})

test('reconciliation status guard migration uses online check constraints', () => {
  const sql = readFileSync(
    'prisma/migrations/20260517153500_accounting_reconciliation_status_guards/migration.sql',
    'utf8',
  )

  assert.match(sql, /"accounting_reconciliation_runs_status_check"[\s\S]+CHECK \("status" IN \('COMPLETED', 'FAILED', 'PARTIAL'\)\) NOT VALID/)
  assert.match(sql, /"accounting_reconciliation_findings_status_check"[\s\S]+CHECK \("status" IN \('OPEN', 'RESOLVED', 'ACCEPTED'\)\) NOT VALID/)
  assert.match(sql, /VALIDATE CONSTRAINT "accounting_reconciliation_runs_status_check"/)
  assert.match(sql, /VALIDATE CONSTRAINT "accounting_reconciliation_findings_status_check"/)
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

test('shipment COGS revaluation sync logs count as source state for mirrored events', () => {
  const rows = cleanRows()
  rows.syncLogs.push({
    id: 'sync-shipment-cogs-revaluation',
    connector: 'xero',
    type: 'COGS_REVERSAL',
    status: 'SYNCED',
    referenceType: 'Shipment',
    referenceId: 'shipment-1',
    externalTransactionId: 'journal-shipment-cogs-revaluation',
    payload: { _idempotencyKey: 'shipment-cogs-revalue:shipment-1:layer-1:20:27.5' },
  })
  rows.accountingEvents.push({
    id: 'event-shipment-cogs-revaluation',
    type: 'COGS_REVERSAL',
    sourceEntityType: 'Shipment',
    sourceEntityId: 'shipment-1',
    businessDate: B_DATE,
    status: 'POSTED',
    idempotencyKey: 'event-shipment-cogs-revaluation-key',
    externalSystem: 'xero',
    externalId: 'journal-shipment-cogs-revaluation',
  })

  const findings = evaluateAccountingReconciliationRows(rows)

  assert.equal(findings.some((finding) => (
    finding.code === 'event_without_source' &&
    finding.accountingEventId === 'event-shipment-cogs-revaluation'
  )), false)
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
    refundStatus: 'FULL',
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
    refundStatus: 'FULL',
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
    rows.salesOrders = [{ ...rows.salesOrders[0], status: 'REFUNDED', refundStatus: 'FULL' }]
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
    rows.salesOrders = [{ ...rows.salesOrders[0], status: 'REFUNDED', refundStatus: 'FULL' }]
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
        refundStatus?: { not?: string }
        updatedAt?: { gte?: unknown }
      }>
    }
    take: number
  }
  const salesOrderWhere = salesOrderCall.where
  assert.ok(salesOrderWhere.OR[0].revenueDeferredDate?.gte instanceof Date)
  assert.ok(salesOrderWhere.OR[1].inventoryAllocatedDate?.gte instanceof Date)
  assert.deepEqual(salesOrderWhere.OR[2].status, {
    in: ['CANCELLED', 'COMPLETED', 'DELIVERED'],
  })
  assert.ok(salesOrderWhere.OR[2].updatedAt?.gte instanceof Date)
  // Refunded orders may sit in a non-terminal lifecycle status now — scanned via refundStatus.
  assert.deepEqual(salesOrderWhere.OR[3].refundStatus, { not: 'NONE' })
  assert.ok(salesOrderWhere.OR[3].updatedAt?.gte instanceof Date)
  assert.equal(salesOrderCall.take, 10000)
  const shipmentWhere = (calls.shipment as { where: { shipmentJournalDate: { gte?: unknown } } }).where
  assert.ok(shipmentWhere.shipmentJournalDate.gte instanceof Date)
  assert.equal((calls.shipment as { take: number }).take, 10000)
  assert.equal((calls.salesOrderRefund as { take: number }).take, 10000)
  assert.equal((calls.accountingSyncLog as { take: number }).take, 10000)
  assert.equal((calls.accountingEvent as { take: number }).take, 10000)
})

// --- o3d-0qoo: persisted daily-batch referenceIds ---

const A1_REF = 'A1-2026-04-24-abcd1234'
const A2_REF = 'A2-2026-04-24-0badf00d'
const B_REF = 'B-2026-04-25-beefcafe'

const DAILY_BATCH_SOURCE_CODES = [
  'source_order_revenue_deferral_without_event',
  'source_order_inventory_allocation_without_event',
  'source_shipment_without_event',
]

/**
 * cleanRows() in the live Xero shape: every daily-batch referenceId (and therefore
 * every mirrored sourceEntityId, which accounting-event-mirror copies verbatim)
 * carries the `-<8 hex>` digest suffix. `midnightCrossing` additionally moves the
 * stage stamps past UTC midnight into the day after the batch date.
 */
function persistedRefRows(options: { midnightCrossing?: boolean } = {}): AccountingReconciliationRows {
  const rows = cleanRows()
  const a1Stamp = options.midnightCrossing ? new Date('2026-04-25T00:00:03.000Z') : A1_DATE
  const a2Stamp = options.midnightCrossing ? new Date('2026-04-25T00:00:07.000Z') : A2_DATE
  const bStamp = options.midnightCrossing ? new Date('2026-04-26T00:00:04.000Z') : B_DATE
  rows.salesOrders[0] = {
    ...rows.salesOrders[0],
    revenueDeferredDate: a1Stamp,
    revenueDeferredBatchRef: A1_REF,
    inventoryAllocatedDate: a2Stamp,
    inventoryAllocatedBatchRef: A2_REF,
  }
  rows.shipments[0] = {
    ...rows.shipments[0],
    shipmentJournalDate: bStamp,
    shipmentJournalBatchRef: B_REF,
  }
  rows.syncLogs = rows.syncLogs.map((log) => (
    log.type === 'DAILY_BATCH_REVENUE_DEFERRAL'
      ? { ...log, referenceId: A1_REF }
      : log.type === 'DAILY_BATCH_INVENTORY_ALLOC'
        ? { ...log, referenceId: A2_REF }
        : log.type === 'DAILY_BATCH_GROUP_B'
          ? { ...log, referenceId: B_REF }
          : log
  ))
  rows.accountingEvents = rows.accountingEvents.map((event) => (
    event.type === 'DAILY_BATCH_REVENUE_DEFERRAL'
      ? { ...event, sourceEntityId: A1_REF }
      : event.type === 'DAILY_BATCH_INVENTORY_ALLOC'
        ? { ...event, sourceEntityId: A2_REF }
        : event.type === 'DAILY_BATCH_GROUP_B'
          ? { ...event, sourceEntityId: B_REF }
          : event
  ))
  return rows
}

test('o3d-0qoo: persisted batch refs match the event a midnight-crossing batch mirrored', () => {
  const codes = evaluateAccountingReconciliationRows(persistedRefRows({ midnightCrossing: true }))
    .map((finding) => finding.code)
  for (const code of [...DAILY_BATCH_SOURCE_CODES, 'event_without_source']) {
    assert.ok(!codes.includes(code), `${code} must not fire when the persisted ref names the mirrored event`)
  }
})

test('o3d-0qoo: legacy rows without a persisted ref still derive the source key from the stamp', () => {
  const rows = cleanRows()
  // Pre-migration shape: stamps only. Bare QuickBooks-style references on both
  // sides, so the derived key still ties the source to its event exactly as before.
  rows.salesOrders[0] = {
    ...rows.salesOrders[0],
    revenueDeferredBatchRef: null,
    inventoryAllocatedBatchRef: null,
  }
  rows.shipments[0] = { ...rows.shipments[0], shipmentJournalBatchRef: null }

  assert.deepEqual(evaluateAccountingReconciliationRows(rows), [])
})

test('o3d-0qoo: a Xero digest ref no longer double-mismatches in both directions', () => {
  // Before the persisted ref existed this module derived a bare `A1-<date>` and
  // compared it to the mirrored `A1-<date>-<digest>` with no digest stripping, so a
  // single healthy Xero batch reported BOTH a source_*_without_event and an
  // event_without_source — with the stamps and the batch date in perfect agreement.
  const findings = evaluateAccountingReconciliationRows(persistedRefRows())
  const codes = findings.map((finding) => finding.code)
  for (const code of DAILY_BATCH_SOURCE_CODES) {
    assert.ok(!codes.includes(code), `${code} must not fire for a digest-shaped persisted ref`)
  }
  assert.ok(!codes.includes('event_without_source'),
    'the same journal must not be reported as an orphan event in the reverse direction')
  assert.deepEqual(findings, [])
})

test('o3d-0qoo: a persisted batch ref with no mirrored event still reports the missing event', () => {
  const rows = persistedRefRows()
  rows.accountingEvents = rows.accountingEvents.filter((event) => event.type !== 'DAILY_BATCH_REVENUE_DEFERRAL')

  const finding = evaluateAccountingReconciliationRows(rows)
    .find((entry) => entry.code === 'source_order_revenue_deferral_without_event')

  assert.ok(finding, 'expected the missing-event finding to still be reported')
  assert.equal(finding!.orderId, 'order-1')
  // Reported against the reference the batch actually wrote, not a derived guess.
  assert.equal((finding!.details as { sourceEntityId: string }).sourceEntityId, A1_REF)
})

// o3d-cvj9: a *_INVOICE_UPDATE posts a REVISION of a document that already exists and the
// connector hands back the id it gave the create, so a create plus its revisions legitimately
// share one external reference. Before the mirrored revision could reach POSTED at all, the
// update sync log never got an externalTransactionId, so this was never observable; it is now.
function invoiceSyncLog(id: string, type: string, referenceId: string, externalTransactionId: string) {
  return {
    id,
    connector: 'xero',
    type,
    status: 'SYNCED',
    referenceType: 'SalesOrder',
    referenceId,
    externalTransactionId,
    payload: { date: '2026-04-25' },
  }
}

function duplicateReferenceFindings(rows: AccountingReconciliationRows, reference: string) {
  return evaluateAccountingReconciliationRows(rows).filter((finding) => (
    finding.code === 'duplicate_external_reference' &&
    (finding.details as { externalReference?: string }).externalReference === reference
  ))
}

test('a sales invoice and its update sharing one external id are not a duplicate reference', () => {
  const rows = cleanRows()
  rows.syncLogs.push(
    invoiceSyncLog('sync-invoice', 'SALES_INVOICE', 'order-1', 'INV-9'),
    invoiceSyncLog('sync-invoice-update', 'SALES_INVOICE_UPDATE', 'order-1', 'INV-9'),
  )

  assert.deepEqual(duplicateReferenceFindings(rows, 'xero|INV-9'), [])
})

test('one external id claimed by two sales orders is still a duplicate reference', () => {
  const rows = cleanRows()
  rows.syncLogs.push(
    invoiceSyncLog('sync-invoice-update-1', 'SALES_INVOICE_UPDATE', 'order-1', 'INV-9'),
    invoiceSyncLog('sync-invoice-update-2', 'SALES_INVOICE_UPDATE', 'order-2', 'INV-9'),
  )

  const findings = duplicateReferenceFindings(rows, 'xero|INV-9')
  assert.equal(findings.length, 1, 'a reference spanning two source documents must stay critical')
  assert.equal(findings[0].severity, 'critical')
  assert.deepEqual(
    (findings[0].details as { syncLogIds: string[] }).syncLogIds,
    ['sync-invoice-update-1', 'sync-invoice-update-2'],
  )
})

test('one document posted by two create sync logs is still a duplicate reference', () => {
  const rows = cleanRows()
  rows.syncLogs.push(
    invoiceSyncLog('sync-invoice-1', 'SALES_INVOICE', 'order-1', 'INV-9'),
    invoiceSyncLog('sync-invoice-2', 'SALES_INVOICE', 'order-1', 'INV-9'),
    invoiceSyncLog('sync-invoice-update', 'SALES_INVOICE_UPDATE', 'order-1', 'INV-9'),
  )

  const findings = duplicateReferenceFindings(rows, 'xero|INV-9')
  assert.equal(findings.length, 1, 'two creates for one document is the double post the check exists for')
  assert.deepEqual(
    (findings[0].details as { syncLogIds: string[] }).syncLogIds,
    ['sync-invoice-1', 'sync-invoice-2', 'sync-invoice-update'],
  )
})

// o3d-cvj9 r2: the exemption above rests on `referenceType`/`referenceId`, which name the SOURCE
// ROW a sync log was raised from — not the ledger document it posted. Those are not the same thing,
// so a source key alone waved through pairings the mirror itself refuses: a sales invoice and a
// purchase bill are different documents in Xero however their source rows happen to be keyed, and
// `resolveDocumentRevisionExternalIdClaim` will not let one take the other's id. Reconciliation now
// exempts exactly what the mirror permits — one document-revision FAMILY — and no more.

function familySyncLog(id: string, type: string, referenceType: string, referenceId: string, externalTransactionId: string) {
  return {
    id,
    connector: 'xero',
    type,
    status: 'SYNCED',
    referenceType,
    referenceId,
    externalTransactionId,
    payload: { date: '2026-04-25' },
  }
}

test('o3d-cvj9 r2: a purchase-bill revision may not share a sales invoice reference, however the source rows are keyed', () => {
  const rows = cleanRows()
  rows.syncLogs.push(
    familySyncLog('sync-sales-invoice', 'SALES_INVOICE', 'SalesOrder', 'order-1', 'INV-9'),
    familySyncLog('sync-bill-update', 'PURCHASE_INVOICE_UPDATE', 'SalesOrder', 'order-1', 'INV-9'),
  )

  const findings = duplicateReferenceFindings(rows, 'xero|INV-9')
  assert.equal(findings.length, 1, 'a bill revision is not a revision of a sales invoice')
  assert.equal(findings[0].severity, 'critical')
  assert.deepEqual(
    (findings[0].details as { syncLogIds: string[] }).syncLogIds,
    ['sync-sales-invoice', 'sync-bill-update'],
  )
})

test('o3d-cvj9 r2: two revisions of DIFFERENT families sharing one reference are a duplicate, create or no create', () => {
  // No create row at all, so the `creates <= 1` half cannot see this one either.
  const rows = cleanRows()
  rows.syncLogs.push(
    familySyncLog('sync-invoice-update', 'SALES_INVOICE_UPDATE', 'SalesOrder', 'order-1', 'INV-9'),
    familySyncLog('sync-bill-update', 'PURCHASE_INVOICE_UPDATE', 'SalesOrder', 'order-1', 'INV-9'),
  )

  const findings = duplicateReferenceFindings(rows, 'xero|INV-9')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'critical')
})

test('o3d-cvj9 r2: a type in NO revision family is its own family, never somebody else\'s revision', () => {
  // CREDIT_NOTE neither creates nor revises a revisable document, so it counts as one create and
  // would otherwise be exempted as the "create" a sales-invoice revision is allowed to follow.
  const rows = cleanRows()
  rows.syncLogs.push(
    familySyncLog('sync-credit-note', 'CREDIT_NOTE', 'SalesOrder', 'order-1', 'INV-9'),
    familySyncLog('sync-invoice-update', 'SALES_INVOICE_UPDATE', 'SalesOrder', 'order-1', 'INV-9'),
  )

  const findings = duplicateReferenceFindings(rows, 'xero|INV-9')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'critical')
})

test('o3d-cvj9 r2: a purchase bill and ITS OWN update on one PO still share a reference legitimately', () => {
  // The non-regression half: PURCHASE_INVOICE and PURCHASE_INVOICE_UPDATE are one family, and both
  // are raised against the PurchaseOrder row, so this is the ordinary edited-bill shape.
  const rows = cleanRows()
  rows.syncLogs.push(
    familySyncLog('sync-bill', 'PURCHASE_INVOICE', 'PurchaseOrder', 'po-1', 'BILL-3'),
    familySyncLog('sync-bill-update-1', 'PURCHASE_INVOICE_UPDATE', 'PurchaseOrder', 'po-1', 'BILL-3'),
    familySyncLog('sync-bill-update-2', 'PURCHASE_INVOICE_UPDATE', 'PurchaseOrder', 'po-1', 'BILL-3'),
  )

  assert.deepEqual(duplicateReferenceFindings(rows, 'xero|BILL-3'), [])
})
