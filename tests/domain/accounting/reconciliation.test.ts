import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DAILY_BATCH_SPLIT_BRIDGE_AMBIGUOUS,
  MAX_RECONCILIATION_FINDINGS_PER_RUN,
  MAX_VOID_MIRROR_CONTRADICTIONS,
  collectAccountingReconciliationRows,
  evaluateAccountingReconciliationRows,
  listAccountingReconciliationRuns,
  persistAccountingReconciliationReport,
  reconciliationLookbackDate,
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
        // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
        // that means to model an OPERATOR-ASSERTED row has to say so.
        settlementBasis: null,
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
        // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
        // that means to model an OPERATOR-ASSERTED row has to say so.
        settlementBasis: null,
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
        // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
        // that means to model an OPERATOR-ASSERTED row has to say so.
        settlementBasis: null,
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
        // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
        // that means to model an OPERATOR-ASSERTED row has to say so.
        settlementBasis: null,
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
    // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
    // that means to model an OPERATOR-ASSERTED row has to say so.
    settlementBasis: null,
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
      // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
      // that means to model an OPERATOR-ASSERTED row has to say so.
      settlementBasis: null,
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
      // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
      // that means to model an OPERATOR-ASSERTED row has to say so.
      settlementBasis: null,
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
    // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
    // that means to model an OPERATOR-ASSERTED row has to say so.
    settlementBasis: null,
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
    // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
    // that means to model an OPERATOR-ASSERTED row has to say so.
    settlementBasis: null,
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
    accountingEventLog: {
      async findMany(args: unknown) {
        calls.accountingEventLog = args
        return []
      },
    },
    // o3d-11rf r4: required by the client type, so every double has to answer it. See the
    // contradiction-query tests below for what this statement is asserted to be.
    async $queryRaw() { return [] },
  }

  await collectAccountingReconciliationRows(client)

  assert.ok(calls.salesOrder)
  assert.ok(calls.shipment)
  assert.ok(calls.salesOrderRefund)
  assert.ok(calls.accountingSyncLog)
  assert.ok(calls.accountingEvent)
  assert.ok(calls.accountingEventLog)
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
    // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
    // that means to model an OPERATOR-ASSERTED row has to say so.
    settlementBasis: null,
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
    // o3d-anu8: NULL is the connector's own writeback. Stated rather than defaulted so a fixture
    // that means to model an OPERATOR-ASSERTED row has to say so.
    settlementBasis: null,
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

// ---------------------------------------------------------------------------------------------
// o3d-cvj9 r7 (Codex r7, HIGH) — THE OPERATOR SURFACE FOR AN IDENTIFIER THAT MOVED ON A GUESS.
//
// The mirror answers a pair it cannot order, in the direction that converges, and says so. Round 6
// then named the gap: the saying-so lived in an audit row's metadata and NOTHING LISTED IT. These
// cover the listing — the read that finds the entries, and the finding that makes one checkable.
// ---------------------------------------------------------------------------------------------

test('o3d-cvj9 r7: the report reads the handovers made on an assumed order, bounded by its lookback', async () => {
  const calls: Record<string, unknown> = {}
  const client = {
    salesOrder: { async findMany() { return [] } },
    shipment: { async findMany() { return [] } },
    salesOrderRefund: { async findMany() { return [] } },
    accountingSyncLog: { async findMany() { return [] } },
    accountingEvent: { async findMany() { return [] } },
    accountingEventLog: {
      async findMany(args: unknown) {
        calls.accountingEventLog = args
        return []
      },
    },
    async $queryRaw() { return [] },
  }

  const toDate = new Date('2026-08-20T00:00:00.000Z')
  const rows = await collectAccountingReconciliationRows(client, { lookbackDays: 30, toDate })

  const call = calls.accountingEventLog as { where: { action?: string; createdAt?: { gte?: Date } }; take?: number }
  assert.ok(call, 'the dataset is read at all — without this the finding can never fire in production')
  assert.equal(
    call.where.action,
    'superseded_by_assumed_order',
    'selected on the ASSUMED action alone, so a handover the stamps settled is never listed for review',
  )
  assert.deepEqual(
    call.where.createdAt,
    { gte: reconciliationLookbackDate(30, toDate) },
    'bounded by the report window like every other dataset; an unbounded read re-reports for ever and stops being read',
  )
  assert.equal(rows.revisionClaimLogs?.length, 0, 'and the dataset reaches the evaluator, empty or not')
})

test('o3d-cvj9 r7: a claim that moved on an assumed order is reported for review, with both rows named', () => {
  const rows = cleanRows()
  rows.revisionClaimLogs = [{
    id: 'log-1',
    accountingEventId: 'event-holder',
    action: 'superseded_by_assumed_order',
    metadata: {
      connector: 'xero',
      externalId: 'INV-9',
      orderingBasis: 'create_precedes_untimed_write',
      supersededByEventId: 'event-revision',
      syncType: 'SALES_INVOICE_UPDATE',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
    },
    createdAt: new Date('2026-08-19T10:06:00.000Z'),
  }]

  const findings = evaluateAccountingReconciliationRows(rows)
    .filter((finding) => finding.code === 'document_claim_moved_on_assumed_order')

  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'warning', 'unverified is not the same as broken — the critical next door is')
  assert.equal(findings[0].accountingEventId, 'event-revision', 'keyed to the row that now holds the document id')
  assert.deepEqual(findings[0].details, {
    connector: 'xero',
    externalId: 'INV-9',
    orderingBasis: 'create_precedes_untimed_write',
    releasedByEventId: 'event-holder',
    holdingEventId: 'event-revision',
    syncType: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    movedAt: '2026-08-19T10:06:00.000Z',
  })
})

test('o3d-cvj9 r7: an entry whose metadata lost the taker is still traced to a document, not dropped', () => {
  // A finding an operator cannot act on is the failure this whole surface exists to avoid, so a
  // malformed entry degrades to "here is the row that released the id" rather than to silence.
  const rows = cleanRows()
  rows.revisionClaimLogs = [{
    id: 'log-1',
    accountingEventId: 'event-holder',
    action: 'superseded_by_assumed_order',
    metadata: { connector: 'xero', externalId: 'INV-9' },
    createdAt: new Date('2026-08-19T10:06:00.000Z'),
  }]

  const findings = evaluateAccountingReconciliationRows(rows)
    .filter((finding) => finding.code === 'document_claim_moved_on_assumed_order')

  assert.equal(findings.length, 1)
  assert.equal(findings[0].accountingEventId, 'event-holder')
  assert.match(findings[0].message, /INV-9/)
})

test('o3d-cvj9 r7: fixtures that never read the dataset report neither a finding nor a row cap', () => {
  // `revisionClaimLogs` is optional, and absent must stay distinguishable from empty: reading it as
  // zero would make a dataset that was never queried look like one that returned nothing.
  const rows = cleanRows()
  assert.equal(rows.revisionClaimLogs, undefined)
  assert.deepEqual(
    evaluateAccountingReconciliationRows(rows)
      .filter((finding) => finding.code === 'document_claim_moved_on_assumed_order'
        || (finding.details as { dataset?: string })?.dataset === 'revisionClaimLogs'),
    [],
  )
})

// --- o3d-ecow: the legacy rows o3d-0qoo deliberately left alone ---

/**
 * The pre-migration Xero shape: the batch ref column is empty (those rows carry no persisted ref and
 * never will), so the source key can only be DERIVED from the stage stamp and comes out bare — while
 * the sync log and the mirrored event both carry the live `-<8 hex>` digest, because
 * accounting-event-mirror copies the referenceId verbatim. Nothing else is wrong with these rows: the
 * stamps agree with the batch date, and no midnight is crossed.
 */
function legacyDigestRows(): AccountingReconciliationRows {
  const rows = persistedRefRows()
  rows.salesOrders[0] = {
    ...rows.salesOrders[0],
    revenueDeferredBatchRef: null,
    inventoryAllocatedBatchRef: null,
  }
  rows.shipments[0] = { ...rows.shipments[0], shipmentJournalBatchRef: null }
  return rows
}

test('o3d-ecow: a LEGACY Xero row and the event it mirrored are one journal, not two findings', () => {
  // Every healthy legacy Xero daily batch was reported TWICE: `source_*_without_event` going forward,
  // because the derived `A1-<date>` never equalled the mirrored `A1-<date>-<digest>`, and
  // `event_without_source` coming back, for the same reason from the other side. o3d-0qoo fixed the
  // rows staged after its migration and said in as many words that it was leaving these alone.
  const findings = evaluateAccountingReconciliationRows(legacyDigestRows())
  const codes = findings.map((finding) => finding.code)

  for (const code of DAILY_BATCH_SOURCE_CODES) {
    assert.ok(!codes.includes(code), `${code} must not fire for a legacy row whose event carries a digest`)
  }
  assert.ok(!codes.includes('event_without_source'),
    'and the same journal must not come back as an orphan event in the reverse direction')
  assert.deepEqual(findings, [])
})

test('o3d-ecow: the bridge matches the batch the row NAMES, not any batch with a digest on it', () => {
  // The bridge strips a digest; it must not strip the date with it. A legacy row stamped on the 24th
  // whose only mirrored event belongs to the 23rd is a real gap, and both directions must still say so
  // — otherwise the fix has replaced double-reporting with under-reporting, which is worse.
  const rows = legacyDigestRows()
  const wrongDay = 'A1-2026-04-23-abcd1234'
  rows.accountingEvents = rows.accountingEvents.map((event) => (
    event.type === 'DAILY_BATCH_REVENUE_DEFERRAL' ? { ...event, sourceEntityId: wrongDay } : event
  ))
  rows.syncLogs = rows.syncLogs.map((log) => (
    log.type === 'DAILY_BATCH_REVENUE_DEFERRAL' ? { ...log, referenceId: wrongDay } : log
  ))

  const findings = evaluateAccountingReconciliationRows(rows)
  const codes = findings.map((finding) => finding.code)

  assert.ok(codes.includes('source_order_revenue_deferral_without_event'),
    'the row stamped on the 24th still has no mirrored event')
  const orphan = findings.find((finding) => finding.code === 'event_without_source')
  assert.ok(orphan, 'and the event on the 23rd still has no source')
  assert.equal((orphan!.details as { sourceEntityId: string }).sourceEntityId, wrongDay)
  assert.equal(codes.filter((code) => DAILY_BATCH_SOURCE_CODES.includes(code)).length, 1,
    'A2 and Group B are untouched and stay clean')
})

test('o3d-ecow: a PERSISTED ref is matched exactly — the digest is not stripped to meet it', () => {
  // The split o3d-0qoo drew, and the reason the bridge is carried per key rather than switched on for
  // the whole module. A persisted ref IS the referenceId the batch wrote; a digest-suffixed event
  // beside a bare persisted ref is a different journal, and bridging it would vouch for the wrong one.
  const rows = persistedRefRows()
  rows.salesOrders[0] = { ...rows.salesOrders[0], revenueDeferredBatchRef: 'A1-2026-04-24' }

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.ok(codes.includes('source_order_revenue_deferral_without_event'),
    'the persisted ref names a journal that was never mirrored')
  assert.ok(codes.includes('event_without_source'),
    'and the digest-suffixed event it sits beside is not that journal')
})

// --- o3d-ecow round 2: a same-day SPLIT is the one thing a bare key cannot resolve ---

const A1_SPLIT_REF = 'A1-2026-04-24-99999999'

/**
 * The legacy shape, on a day whose A1 batch was SPLIT into two journals.
 *
 * Both journals posted and both mirrored, so the sync-log direction (which matches exactly) is
 * clean. What is NOT clean is the bridge: strip the digest off either event and you get the same
 * `A1-2026-04-24` the legacy row derives, so each journal answers for the other.
 */
function splitLegacyDigestRows(): AccountingReconciliationRows {
  const rows = legacyDigestRows()
  const a1Event = rows.accountingEvents.find((event) => event.type === 'DAILY_BATCH_REVENUE_DEFERRAL')!
  const a1Log = rows.syncLogs.find((log) => log.type === 'DAILY_BATCH_REVENUE_DEFERRAL')!
  rows.accountingEvents = [
    ...rows.accountingEvents,
    { ...a1Event, id: 'event-a1-split', sourceEntityId: A1_SPLIT_REF, externalId: 'journal-a1-split' },
  ]
  rows.syncLogs = [
    ...rows.syncLogs,
    { ...a1Log, id: 'sync-a1-split', referenceId: A1_SPLIT_REF, externalTransactionId: 'journal-a1-split' },
  ]
  return rows
}

test('o3d-ecow r2: one same-day split journal no longer vouches for another', () => {
  // THE DEFECT. The bridge takes the digest off, and the digest is the ONLY thing separating two
  // journals of the same group and date. So a legacy row whose own journal was never mirrored was
  // satisfied by the OTHER split's event (forward), and a duplicate or orphaned split journal was
  // satisfied by the other split's source rows (reverse) — each direction silently answered by a
  // journal it was not asking about. Round 1 shipped that as a clean pass.
  const findings = evaluateAccountingReconciliationRows(splitLegacyDigestRows())

  assert.equal(findings.length, 1, `expected exactly one finding, got ${JSON.stringify(findings.map((f) => f.code))}`)
  const [finding] = findings
  assert.equal(finding.code, DAILY_BATCH_SPLIT_BRIDGE_AMBIGUOUS)
  assert.equal(finding.severity, 'warning')
  const details = finding.details as { sourceEntityId: string; candidateSourceEntityIds: string[] }
  assert.equal(details.sourceEntityId, 'A1-2026-04-24', 'reported against the bare key that cannot decide')
  assert.deepEqual([...details.candidateSourceEntityIds].sort(), [A1_REF, A1_SPLIT_REF].sort(),
    'and it names every journal the key matches, so a human can check them in the ledger')
  assert.match(finding.message, /cannot be established/i)
})

test('o3d-ecow r2: the ambiguity is reported ONCE, not once per staged row', () => {
  // A split day can carry thousands of staged orders. A finding each would say the same
  // unresolvable thing thousands of times and push the rest of the report past the per-run cap.
  const rows = splitLegacyDigestRows()
  rows.salesOrders = [
    rows.salesOrders[0],
    { ...rows.salesOrders[0], id: 'order-2', orderNumber: 'SO-2', inventoryAllocatedDate: null },
    { ...rows.salesOrders[0], id: 'order-3', orderNumber: 'SO-3', inventoryAllocatedDate: null },
  ]

  const findings = evaluateAccountingReconciliationRows(rows)
  assert.equal(findings.filter((f) => f.code === DAILY_BATCH_SPLIT_BRIDGE_AMBIGUOUS).length, 1)
  assert.equal(findings.length, 1, 'and nothing else fires: A2 and Group B are unsplit and still match')
})

test('o3d-ecow r2: an UNSPLIT legacy day still bridges silently — round 1 is not undone', () => {
  // The whole point of the bridge is that a healthy legacy Xero batch stopped double-reporting. One
  // journal for the key means the bare match names exactly that journal, and nothing is ambiguous.
  assert.deepEqual(evaluateAccountingReconciliationRows(legacyDigestRows()), [])
})

test('o3d-ecow r2: a split day with PERSISTED refs is matched exactly and never goes near the bridge', () => {
  // Persisted identity is the case o3d-0qoo built for: the row names its own journal, so a split is
  // not ambiguous at all — and the journal nothing points at is a plain orphan, reported as one.
  const rows = persistedRefRows()
  const a1Event = rows.accountingEvents.find((event) => event.type === 'DAILY_BATCH_REVENUE_DEFERRAL')!
  const a1Log = rows.syncLogs.find((log) => log.type === 'DAILY_BATCH_REVENUE_DEFERRAL')!
  rows.accountingEvents = [
    ...rows.accountingEvents,
    { ...a1Event, id: 'event-a1-split', sourceEntityId: A1_SPLIT_REF, externalId: 'journal-a1-split' },
  ]
  rows.syncLogs = [
    ...rows.syncLogs,
    { ...a1Log, id: 'sync-a1-split', referenceId: A1_SPLIT_REF, externalTransactionId: 'journal-a1-split' },
  ]

  const findings = evaluateAccountingReconciliationRows(rows)
  const codes = findings.map((finding) => finding.code)
  assert.ok(!codes.includes(DAILY_BATCH_SPLIT_BRIDGE_AMBIGUOUS), 'nothing was bridged, so nothing is ambiguous')
  const orphan = findings.find((finding) => finding.code === 'event_without_source')
  assert.ok(orphan, 'the second journal has no source state of its own and is reported')
  assert.equal((orphan!.details as { sourceEntityId: string }).sourceEntityId, A1_SPLIT_REF)
})

// ---------------------------------------------------------------------------
// o3d-anu8 — A LIVE SYNC ROW IS EVIDENCE ONLY WHEN THE CONNECTOR PUT IT THERE.
//
// `syncLogHasLiveEvidence` is the reason a missing-evidence finding is NOT raised. That reading
// holds for a row the processor wrote — SYNCED means the ledger answered. It does not hold for a
// row an operator settled, where the id was typed and no call was made, and where silencing the
// finding removes the only thing that would have told anybody to go and look.
// ---------------------------------------------------------------------------

test('[o3d-anu8] an OPERATOR-ASSERTED credit-note sync row does NOT silence the missing-evidence finding', () => {
  const rows = cleanRows()
  rows.salesOrders = [{ ...rows.salesOrders[0], status: 'REFUNDED', refundStatus: 'FULL' }]
  rows.refunds = [{ ...rows.refunds[0], accountingCreditNoteId: null }]
  rows.syncLogs = rows.syncLogs.filter((log) => log.referenceType !== 'SalesOrderRefund')
  rows.accountingEvents = rows.accountingEvents.filter(
    (event) => event.sourceEntityType !== 'SalesOrderRefund' || event.type !== 'CREDIT_NOTE',
  )
  rows.syncLogs.push({
    id: 'sync-refund-credit-note-asserted',
    connector: 'xero',
    type: 'CREDIT_NOTE',
    status: 'SYNCED',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    externalTransactionId: 'credit-note-typed-in',
    settlementBasis: 'OPERATOR_ASSERTION',
    payload: { _idempotencyKey: 'sales-order-refund:refund-1:credit-note:asserted' },
  })

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.equal(codes.includes('terminal_refunded_order_missing_credit_note_evidence'), true,
    'an assertion is not evidence, and over-reporting is the safe direction for this report')
})

test('[o3d-anu8] the identical row written back by the connector still silences it', () => {
  // The fence in the other direction — otherwise the test above would pass against a version that
  // simply stopped believing SYNCED rows at all.
  const rows = cleanRows()
  rows.salesOrders = [{ ...rows.salesOrders[0], status: 'REFUNDED', refundStatus: 'FULL' }]
  rows.refunds = [{ ...rows.refunds[0], accountingCreditNoteId: null }]
  rows.syncLogs = rows.syncLogs.filter((log) => log.referenceType !== 'SalesOrderRefund')
  rows.accountingEvents = rows.accountingEvents.filter(
    (event) => event.sourceEntityType !== 'SalesOrderRefund' || event.type !== 'CREDIT_NOTE',
  )
  rows.syncLogs.push({
    id: 'sync-refund-credit-note-real',
    connector: 'xero',
    type: 'CREDIT_NOTE',
    status: 'SYNCED',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    externalTransactionId: 'credit-note-1',
    settlementBasis: null,
    payload: { _idempotencyKey: 'sales-order-refund:refund-1:credit-note:real' },
  })

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)

  assert.equal(codes.includes('terminal_refunded_order_missing_credit_note_evidence'), false)
})

// --- o3d-11rf r4: the VOID mirrors nobody can classify, ASKED FOR RATHER THAN SIFTED OUT ---

/**
 * o3d-11rf r4 (Codex r4, HIGH) — WHERE THIS RULE LIVES NOW, AND THEREFORE WHERE IT IS PROVED.
 *
 * Round 3 paired unclassified VOID mirrors against live sync rows IN THIS FILE, over the two general
 * pages the report already loads. Both are `ORDER BY <date> DESC LIMIT 10,000` — a bound imposed on a
 * broad load with the filter that decides relevance applied afterwards — so the OLDEST victims, which
 * are the only kind this warning has, were dropped before the pairing that would have named them.
 *
 * The rule is now a JOIN. That moves the whole of it into PostgreSQL, and a rule that lives in SQL
 * cannot honestly be proved by fixtures handed to a TypeScript function: a double could only show the
 * shape of a string. So the shapes that must and must not be reported — the scope tuple, the live
 * statuses, an explained void, a row that already carries a document id — are proved against a real
 * database in tests/db/reconciliation-void-mirror-contradictions.test.ts, together with the over-cap
 * case that is the point of the change.
 *
 * WHAT IS LEFT HERE IS THE TWO THINGS THAT ARE STILL THIS FILE'S: that the statement is ISSUED and is
 * the fixed one (a report that never asks cannot find anything, however right the SQL is), and that
 * what comes back is TURNED INTO FINDINGS honestly — including the truncation finding, without which
 * a short list would silently mean the same thing as a complete one.
 *
 * The evaluator deliberately does NOT re-apply the rule to what the query returns. A second filter
 * here would mask a widened predicate in the SQL — the mutation that kills nothing because an
 * adjacent guard accounted for the case — and would leave two spellings of one rule to drift apart.
 */

function contradiction(overrides: Partial<VoidMirrorContradictionFixture> = {}): VoidMirrorContradictionFixture {
  return {
    accountingEventId: 'event-void',
    connector: 'xero',
    syncType: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    idempotencyKey: 'xero:SALES_INVOICE:SalesOrder:order-1',
    syncLogIds: ['sync-live'],
    syncLogStatuses: ['PENDING'],
    ...overrides,
  }
}

type VoidMirrorContradictionFixture = {
  accountingEventId: string
  connector: string | null
  syncType: string
  referenceType: string
  referenceId: string
  idempotencyKey: string
  syncLogIds: string[]
  syncLogStatuses: string[]
}

function voidMirrorFindings(contradictions: AccountingReconciliationRows['voidMirrorContradictions']) {
  const rows = cleanRows()
  rows.voidMirrorContradictions = contradictions
  return evaluateAccountingReconciliationRows(rows)
    .filter((finding) => finding.code.startsWith('void_mirror_basis_unknown'))
}

/** The collector double, capturing the one statement the contradiction query issues. */
async function captureContradictionQuery(result: unknown[] = []) {
  const captured: { strings?: TemplateStringsArray; values?: unknown[] } = {}
  const client = {
    salesOrder: { async findMany() { return [] } },
    shipment: { async findMany() { return [] } },
    salesOrderRefund: { async findMany() { return [] } },
    accountingSyncLog: { async findMany() { return [] } },
    accountingEvent: { async findMany() { return [] } },
    accountingEventLog: { async findMany() { return [] } },
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      captured.strings = strings
      captured.values = values
      return result
    },
  }

  const rows = await collectAccountingReconciliationRows(client, {
    lookbackDays: 30,
    toDate: new Date('2026-08-20T00:00:00.000Z'),
  })

  assert.ok(captured.strings, 'the contradiction query is issued at all — a report that never asks finds nothing')
  return { rows, sql: captured.strings.join('?'), values: captured.values ?? [] }
}

test('o3d-11rf r4: the contradictions are ASKED FOR, by a statement with no date bound in it', async () => {
  // THE FINDING, STATED AS AN ASSERTION. The subjects of this warning are older than any lookback by
  // definition — a settlement made before the column existed, a row written by hand. A statement that
  // carried a date bound, or that ordered a general page and filtered afterwards, would drop exactly
  // them. So: the join is the filter, and nothing narrows it by time.
  const { sql } = await captureContradictionQuery()

  assert.match(sql, /FROM "accounting_events" e/, 'the events are one side')
  assert.match(sql, /JOIN "accounting_sync_logs" l/, 'and the live sync rows are the other')
  assert.match(sql, /e\."status" = 'VOID'/)
  assert.match(sql, /e\."voidBasis" IS NULL/, 'only the voids NO WRITER EXPLAINED')
  assert.match(sql, /l\."externalTransactionId" IS NULL OR btrim\(l\."externalTransactionId"\) = ''/,
    'and only sync rows that hold no document id — a row that has one describes a document that exists')

  assert.ok(!/businessDate|createdAt|syncedAt|fromDate/.test(sql),
    'NO date bound anywhere in the statement: the oldest victim is the one this exists to find')
})

test('o3d-11rf r4: the identity joined on is the mirror scope, all four parts of it', async () => {
  const { sql } = await captureContradictionQuery()

  // Named individually rather than by counting join clauses: dropping any one of them widens the
  // rule to name a document the operator has no reason to look at, next to one they do.
  assert.match(sql, /l\."connector"\s+= e\."externalSystem"/)
  assert.match(sql, /l\."type"::text\s+= e\."type"/)
  assert.match(sql, /l\."referenceType" = e\."sourceEntityType"/)
  assert.match(sql, /l\."referenceId"\s+= e\."sourceEntityId"/)
})

test('o3d-11rf r4: the bound is applied AFTER the grouping, and it is the stated one', async () => {
  const { sql, values } = await captureContradictionQuery()

  // THE SHAPE OF THE DEFECT, PINNED. `LIMIT` before the filter is the bug; `LIMIT` after the grouped
  // join is the fix. Both positions are asserted FOUND before they are compared — an unmatched
  // indexOf returns -1, which is less than every real index and would make this pass for the exact
  // reason it exists to catch.
  const groupBy = sql.indexOf('GROUP BY')
  const limit = sql.indexOf('LIMIT')
  const where = sql.indexOf('WHERE')
  assert.notEqual(where, -1, 'the statement filters')
  assert.notEqual(groupBy, -1, 'and groups the pairs onto their event')
  assert.notEqual(limit, -1, 'and is bounded')
  assert.ok(where < groupBy && groupBy < limit,
    'filter, then group, then bound — a bound reached before the filter is the defect this replaced')

  // AND THE PAGE IS ORDERED BEFORE IT IS BOUNDED. Asserted on the STATEMENT, not on the rows that
  // come back, and that is a repair rather than a preference: deleting this `ORDER BY` killed no
  // database test, because the grouped plan happens to emit its rows in group-key order and would
  // have gone on doing so until a row count or a version changed the plan. The rows can only ever
  // show what one planner did once; what has to be true is that the statement ASKS. Without it the
  // bound takes whatever the plan reached first, and an operator working a truncated list across
  // runs would be handed a different 500 each time and never reach the end of it.
  //
  // MATCHED AGAINST THE OUTER SELECT BY NAME, not by looking for the first `ORDER BY` in the
  // statement. The first one is inside `array_agg(... ORDER BY ...)`, which sits before the GROUP BY
  // — so an index comparison against it was red whatever the query did, and the mutation that was
  // supposed to prove this assertion was killed by a test that could not pass either way.
  assert.match(sql, /FROM contradiction\s+ORDER BY "accountingEventId"\s+LIMIT/,
    'the page taken off the grouped set is ordered by event id and only then bounded — the same 500 every run')

  assert.equal(values.at(-1), MAX_VOID_MIRROR_CONTRADICTIONS,
    'the bound is a parameter, and it is the one the truncation finding names')
  assert.deepEqual(values[0], ['PENDING', 'PROCESSING'],
    'and the live statuses are parameters too, so the constant is the single spelling of that set')
})

test('o3d-11rf r4: the bound is DERIVED from what the run view shows, not a number someone picked', () => {
  // A MUTATION SURVIVOR, REPAIRED. Widening this constant to 1,000 killed nothing: the over-cap test
  // sizes its fixture from the constant, so the constant moved and the fixture moved with it. That
  // test proves the BEHAVIOUR at the bound and cannot also prove the bound, because the argument for
  // the bound is a RELATIONSHIP rather than a magnitude — past the number of findings a run will
  // render, one more contradiction is a row written and never read, and the exact count in the
  // truncation finding is the better thing to hand the operator. So the relationship is the assertion.
  assert.equal(MAX_VOID_MIRROR_CONTRADICTIONS, MAX_RECONCILIATION_FINDINGS_PER_RUN,
    'the bound is the number of findings the run view will display at all; a literal here has to argue with this')
})

test('o3d-11rf r4: the total comes from the same statement, and zero rows means zero', async () => {
  const empty = await captureContradictionQuery([])
  assert.deepEqual(empty.rows.voidMirrorContradictions, { rows: [], total: 0 },
    'no rows is not "unknown": the window count only exists where a row does')

  const one = await captureContradictionQuery([{ ...contradiction(), totalContradictions: 7 }])
  assert.equal(one.rows.voidMirrorContradictions?.total, 7, 'the count is carried off the row')
  assert.equal(one.rows.voidMirrorContradictions?.rows.length, 1)
  assert.ok(!('totalContradictions' in (one.rows.voidMirrorContradictions?.rows[0] ?? {})),
    'and stripped from the row, so a per-row count cannot be mistaken for this document’s sync rows')
})

test('o3d-11rf r4: a contradiction is reported with both sides named', () => {
  const findings = voidMirrorFindings({ rows: [contradiction()], total: 1 })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'void_mirror_basis_unknown_with_live_sync_row')
  assert.equal(findings[0].severity, 'warning', 'unclassifiable is not the same as known-broken')
  assert.equal(findings[0].accountingEventId, 'event-void', 'keyed to the row that must be repaired')
  assert.deepEqual(findings[0].details, {
    connector: 'xero',
    syncType: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    syncLogIds: ['sync-live'],
    syncLogStatuses: ['PENDING'],
    idempotencyKey: 'xero:SALES_INVOICE:SalesOrder:order-1',
  }, 'so the judgement can be made without opening the audit tables')
})

test('o3d-11rf r4: one finding per VOID mirror, naming every row whose work it blocks', () => {
  const findings = voidMirrorFindings({
    rows: [contradiction({ syncLogIds: ['sync-live', 'sync-live-2'], syncLogStatuses: ['PENDING', 'PROCESSING'] })],
    total: 1,
  })

  assert.equal(findings.length, 1, 'one per mirror, not one per sync row')
  assert.match(findings[0].message, /2 live sync row\(s\)/, 'and the count in the message is of those rows')
  assert.deepEqual((findings[0].details as { syncLogIds: string[] }).syncLogIds, ['sync-live', 'sync-live-2'])
  assert.deepEqual((findings[0].details as { syncLogStatuses: string[] }).syncLogStatuses, ['PENDING', 'PROCESSING'])
})

test('o3d-11rf r4: a truncated list SAYS SO, with the exact number that did not fit', () => {
  // A silently short list is the original defect one level up: the operator reads three findings and
  // has no way to know there are nine hundred. The count is exact because it was taken by the same
  // statement over the same snapshot as the page.
  const rows = [contradiction({ accountingEventId: 'event-a' }), contradiction({ accountingEventId: 'event-b' })]
  const findings = voidMirrorFindings({ rows, total: 917 })

  assert.equal(findings.length, 3, 'the two that fit, plus the fact that they are not all of them')
  const truncated = findings.find((f) => f.code === 'void_mirror_basis_unknown_contradictions_truncated')
  assert.ok(truncated, 'the truncation is a finding of its own, not a note inside another one')
  assert.equal(truncated.severity, 'warning')
  assert.deepEqual(truncated.details, { reported: 2, total: 917, limit: MAX_VOID_MIRROR_CONTRADICTIONS })
  assert.match(truncated.message, /917/, 'the number is in the message, where an operator reads it')
})

test('o3d-11rf r4: a COMPLETE list carries no truncation finding — that is what makes it readable', () => {
  // The fence in the other direction. Without it the truncation finding could be emitted always, and
  // "the list is complete" would stop meaning anything.
  const rows = [contradiction({ accountingEventId: 'event-a' }), contradiction({ accountingEventId: 'event-b' })]
  const codes = voidMirrorFindings({ rows, total: 2 }).map((f) => f.code)
  assert.deepEqual(codes, [
    'void_mirror_basis_unknown_with_live_sync_row',
    'void_mirror_basis_unknown_with_live_sync_row',
  ])

  assert.deepEqual(voidMirrorFindings({ rows: [], total: 0 }), [], 'and nothing to report reports nothing')
})

test('o3d-11rf r4: a dataset that was NOT READ reports nothing, rather than a clean bill', () => {
  // `voidMirrorContradictions` absent means the collector never asked — a pure-evaluator fixture, or
  // a caller that could not. Reporting zero contradictions there would be vouching for a check that
  // never ran. It must also NOT fall back to pairing the general pages: that fallback is the defect.
  const rows = cleanRows()
  rows.accountingEvents = [{
    id: 'event-void',
    type: 'SALES_INVOICE',
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'order-1',
    businessDate: A1_DATE,
    status: 'VOID',
    idempotencyKey: 'xero:SALES_INVOICE:SalesOrder:order-1',
    externalSystem: 'xero',
    externalId: null,
    voidBasis: null,
  }]
  rows.syncLogs = [{
    id: 'sync-live',
    connector: 'xero',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: null,
    payload: null,
    settlementBasis: null,
  }]
  assert.equal(rows.voidMirrorContradictions, undefined)

  const codes = evaluateAccountingReconciliationRows(rows).map((finding) => finding.code)
  assert.equal(codes.includes('void_mirror_basis_unknown_with_live_sync_row'), false,
    'the in-memory pairing over the capped pages is gone, and nothing may quietly reinstate it')
})
