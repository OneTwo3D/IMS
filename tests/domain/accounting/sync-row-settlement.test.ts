import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SETTLEABLE_ACCOUNTING_SYNC_STATUSES,
  buildSettlementData,
  buildSettlementWhere,
  buildStrandedSyncRowWhere,
  describeLostSettlementCas,
  describeStrandedSyncRow,
  isSettleableAccountingSyncStatus,
  refuseSettlement,
  settlementMirrorExternalId,
  settlementMirrorStatus,
} from '@/lib/domain/accounting/sync-row-settlement'
import { findSalesOrderDeleteBlocker } from '@/lib/domain/sales/order-delete-guard'
import { planFollowUpEnqueue } from '@/lib/domain/accounting/followup-idempotency'

// o3d-nf9i + o3d-osl8. The settlement decision, tested without a database — the same way
// connector-orphans.ts and followup-idempotency.ts are tested, and for the same reason: the
// rule about which rows a human may settle, and what settling them does, is the part that
// must not drift.

// ---------------------------------------------------------------------------
// The settleable set
// ---------------------------------------------------------------------------

test('only FAILED and PROCESSING are settleable (o3d-nf9i / o3d-osl8)', () => {
  assert.deepEqual([...SETTLEABLE_ACCOUNTING_SYNC_STATUSES], ['FAILED', 'PROCESSING'])
  assert.equal(isSettleableAccountingSyncStatus('FAILED'), true, 'o3d-nf9i: ambiguous, may have posted')
  assert.equal(isSettleableAccountingSyncStatus('PROCESSING'), true, 'o3d-osl8: a claim taken and never resolved')
  assert.equal(isSettleableAccountingSyncStatus('PENDING'), false, 'the ordinary sweeps own PENDING')
  assert.equal(isSettleableAccountingSyncStatus('SYNCED'), false)
  assert.equal(isSettleableAccountingSyncStatus('CANCELLED'), false)
})

test('PENDING is refused, and says the sweeps own it — nothing was sent, so nothing is ambiguous', () => {
  const refusal = refuseSettlement({ status: 'PENDING', externalTransactionId: null }, { outcome: 'NOT_POSTED' })
  assert.equal(refusal?.code, 'pending_not_settleable')
  assert.match(refusal!.message, /nothing has been sent/i)
})

test('an already-terminal row is refused for both outcomes — a recorded outcome is not re-writable', () => {
  for (const status of ['SYNCED', 'CANCELLED']) {
    const posted = refuseSettlement({ status, externalTransactionId: null }, { outcome: 'POSTED', externalTransactionId: 'INV-1' })
    assert.equal(posted?.code, 'already_terminal', status)
    const notPosted = refuseSettlement({ status, externalTransactionId: null }, { outcome: 'NOT_POSTED' })
    assert.equal(notPosted?.code, 'already_terminal', status)
  }
})

test('POSTED without an external id is refused — a post nothing can be reconciled against', () => {
  const refusal = refuseSettlement(
    { status: 'FAILED', externalTransactionId: null },
    { outcome: 'POSTED', externalTransactionId: '   ' },
  )
  assert.equal(refusal?.code, 'missing_external_id')
})

test('NOT_POSTED against a row that already carries an external id is refused as a contradiction', () => {
  // The id IS post evidence, and tests/sales-order-delete-guard.test.ts pins that a CANCELLED
  // row carrying one STILL blocks the delete — so it would not even achieve what was wanted.
  const refusal = refuseSettlement({ status: 'FAILED', externalTransactionId: 'INV-777' }, { outcome: 'NOT_POSTED' })
  assert.equal(refusal?.code, 'contradicts_post_evidence')
  assert.match(refusal!.message, /INV-777/)
})

test('POSTED re-asserting the SAME external id is idempotent; a DIFFERENT one is refused', () => {
  const same = refuseSettlement(
    { status: 'FAILED', externalTransactionId: 'INV-5' },
    { outcome: 'POSTED', externalTransactionId: ' INV-5 ' },
  )
  assert.equal(same, null, 'a retried click must not become a refusal')
  const different = refuseSettlement(
    { status: 'FAILED', externalTransactionId: 'INV-5' },
    { outcome: 'POSTED', externalTransactionId: 'INV-6' },
  )
  assert.equal(different?.code, 'external_id_conflict')
})

test('a settleable row with a well-formed assertion is not refused', () => {
  assert.equal(
    refuseSettlement({ status: 'PROCESSING', externalTransactionId: null }, { outcome: 'POSTED', externalTransactionId: 'INV-9' }),
    null,
  )
  assert.equal(
    refuseSettlement({ status: 'FAILED', externalTransactionId: null }, { outcome: 'NOT_POSTED', reason: 'nothing in Xero' }),
    null,
  )
})

// ---------------------------------------------------------------------------
// The CAS fence
// ---------------------------------------------------------------------------

test('the CAS where re-asserts the status the operator was SHOWN', () => {
  // Same shape as markSyncLogForFollowUpRetry's `where: { id, retryCount }` (audit-dzm9): the
  // loser of a race matches nothing and writes nothing.
  assert.deepEqual(buildSettlementWhere('log-1', 'FAILED'), { id: 'log-1', status: 'FAILED' })
  assert.deepEqual(buildSettlementWhere('log-2', 'PROCESSING'), { id: 'log-2', status: 'PROCESSING' })
})

test('a lost CAS is described by the PERSISTED status, never the stale one', () => {
  const message = describeLostSettlementCas('SYNCED')
  assert.match(message, /now SYNCED/)
  assert.match(message, /Nothing was changed/)
  assert.doesNotMatch(message, /FAILED/, 'the stale status must not appear — that is the bug this guards')
  assert.match(describeLostSettlementCas(null), /no longer exists/)
})

// ---------------------------------------------------------------------------
// The data patch
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-14T10:00:00.000Z')

test('the POSTED patch sets SYNCED and records the external id', () => {
  const data = buildSettlementData({ outcome: 'POSTED', externalTransactionId: ' INV-42 ' }, NOW)
  assert.equal(data.status, 'SYNCED')
  assert.equal(data.externalTransactionId, 'INV-42', 'trimmed — a pasted id carries whitespace')
  assert.equal(data.syncedAt, NOW)
  assert.equal(data.errorMessage, null, 'matches the processors own success write')
  assert.equal(data.processingStartedAt, null, 'the claim is released')
})

test('the NOT_POSTED patch sets CANCELLED and NEVER touches the external id', () => {
  const data = buildSettlementData({ outcome: 'NOT_POSTED', reason: 'no document in Xero' }, NOW)
  assert.equal(data.status, 'CANCELLED')
  // Absent, not null. tests/sales-order-delete-guard.test.ts pins that CANCELLED + an external
  // id still BLOCKS the delete, so writing one would defeat the whole point; and CLEARING one
  // would destroy real post evidence, which is why refuseSettlement rejects that case instead.
  assert.equal('externalTransactionId' in data, false)
  assert.equal(data.syncedAt, undefined, 'nothing was synced')
  assert.match(String(data.errorMessage), /Settled by operator/)
  assert.match(String(data.errorMessage), /no document in Xero/)
  assert.equal(data.processingStartedAt, null)
})

test('the mirror status and external id follow the outcome', () => {
  assert.equal(settlementMirrorStatus('POSTED'), 'POSTED')
  assert.equal(settlementMirrorStatus('NOT_POSTED'), 'VOID')
  assert.equal(settlementMirrorExternalId({ outcome: 'POSTED', externalTransactionId: ' INV-3 ' }), 'INV-3')
  assert.equal(settlementMirrorExternalId({ outcome: 'NOT_POSTED' }), null)
})

// ---------------------------------------------------------------------------
// o3d-osl8 item 1 — the stranded read model
// ---------------------------------------------------------------------------

test('the stranded where is NOT scoped to the active connector — that is the whole point', () => {
  assert.deepEqual(buildStrandedSyncRowWhere('xero'), {
    status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
    connector: { not: 'xero' },
  })
  // No connector enabled: nothing will process ANY unresolved row, so all of them are stranded.
  assert.deepEqual(buildStrandedSyncRowWhere(null), { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } })
})

test('a stranded row is described with identifying detail, not counted (o3d-osl8)', () => {
  const row = describeStrandedSyncRow(
    {
      id: 'log-1',
      connector: 'quickbooks',
      type: 'INVOICE_PAYMENT',
      status: 'PROCESSING',
      referenceType: 'SalesOrder',
      referenceId: 'order-7',
      externalTransactionId: null,
      errorMessage: null,
      createdAt: new Date('2026-08-04T10:00:00.000Z'),
    },
    NOW,
  )
  assert.equal(row.connector, 'quickbooks')
  assert.equal(row.type, 'INVOICE_PAYMENT')
  assert.equal(row.referenceType, 'SalesOrder')
  assert.equal(row.referenceId, 'order-7')
  assert.equal(row.status, 'PROCESSING')
  assert.equal(row.ageDays, 10)
  assert.equal(row.settleable, true)
})

test('a stranded PENDING row is listed but NOT settleable — bulk-cancel is its remedy', () => {
  const row = describeStrandedSyncRow(
    {
      id: 'log-2',
      connector: 'xero',
      type: 'SALES_INVOICE',
      status: 'PENDING',
      referenceType: 'SalesOrder',
      referenceId: 'order-8',
      externalTransactionId: null,
      errorMessage: null,
      createdAt: NOW,
    },
    NOW,
  )
  assert.equal(row.settleable, false)
  assert.equal(row.ageDays, 0)
})

// ---------------------------------------------------------------------------
// COMPOSITION 1 — the real hard-delete guard
// ---------------------------------------------------------------------------

type WhereNode = Record<string, unknown>

/** Minimal evaluator for the `where` shapes order-delete-guard emits (mirrors its own suite). */
function matches(row: Record<string, unknown>, where: WhereNode): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as WhereNode[]).some((branch) => matches(row, branch))) return false
      continue
    }
    if (key === 'AND') {
      if (!(condition as WhereNode[]).every((branch) => matches(row, branch))) return false
      continue
    }
    const value = row[key]
    if (condition !== null && typeof condition === 'object') {
      for (const [operator, operand] of Object.entries(condition as Record<string, unknown>)) {
        if (operator === 'in') { if (!(operand as unknown[]).includes(value)) return false }
        else if (operator === 'startsWith') { if (typeof value !== 'string' || !value.startsWith(operand as string)) return false }
        else if (operator === 'not') {
          if (operand === null) { if (value === null || value === undefined) return false }
          else if (value === operand) return false
        } else throw new Error(`unsupported operator in test evaluator: ${operator}`)
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

/**
 * Apply the real settlement patch to a row, then hand the result to the REAL delete guard.
 * `undefined` in the patch means "column untouched", which is exactly what Prisma does.
 */
function settledRow(assertion: Parameters<typeof buildSettlementData>[0]) {
  const base = {
    id: 'log-1',
    connector: 'xero',
    type: 'SALES_INVOICE',
    status: 'FAILED',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: null as string | null,
  }
  const patch = buildSettlementData(assertion, NOW) as Record<string, unknown>
  const next = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value
  }
  return next
}

function guardTx(syncLogs: Record<string, unknown>[]) {
  return {
    wmsOrderStatusSnapshot: { findUnique: async () => null },
    shoppingSyncLog: { findFirst: async () => null },
    salesOrder: { findUnique: async () => ({ accountingInvoiceId: null, invoicedAt: null }) },
    wmsOrderPushLink: { findUnique: async () => null },
    shipment: { findMany: async () => [] },
    accountingSyncLog: {
      findFirst: async ({ where }: { where: WhereNode }) => syncLogs.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: WhereNode }) => syncLogs.filter((row) => matches(row, where)),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const STAMPS = { revenueDeferredDate: null, inventoryAllocatedDate: null }

test('composition: after POSTED the real delete guard demands a reversal, not a cancel', async () => {
  const row = settledRow({ outcome: 'POSTED', externalTransactionId: 'INV-42' })
  assert.equal(row.status, 'SYNCED')
  const blocker = await findSalesOrderDeleteBlocker(guardTx([row]), 'order-1', STAMPS)
  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /already POSTED as INV-42/)
  assert.match(blocker!.message, /explicit reversal or credit note/)
})

test('composition: after NOT_POSTED the real delete guard lets the order be deleted (o3d-osl8)', async () => {
  // This is o3d-osl8's "the order is permanently undeletable" ending. CANCELLED with NO external
  // id is not even selected by the guard — but CANCELLED *with* one still blocks, which is why
  // the NOT_POSTED patch must never write the column.
  const row = settledRow({ outcome: 'NOT_POSTED', reason: 'no document in the retired tenant' })
  assert.equal(row.status, 'CANCELLED')
  assert.equal(row.externalTransactionId, null)
  const blocker = await findSalesOrderDeleteBlocker(guardTx([row]), 'order-1', STAMPS)
  assert.equal(blocker, null)
})

// ---------------------------------------------------------------------------
// COMPOSITION 2 — the real follow-up enqueue planner
// ---------------------------------------------------------------------------

/**
 * The LOAD-BEARING side effect of the NOT_POSTED branch. enqueueFollowUpSyncLog gathers its
 * ambiguity set with `status: 'FAILED'` ONLY (xero/sync-processor.ts ~L293, quickbooks
 * ~L169), so moving a FAILED row to CANCELLED REMOVES it from that set. This models exactly
 * that read, over rows the real buildSettlementData has patched.
 */
function failedFollowUpSet(rows: Array<{ id: string; status: string; payload: unknown; effectiveToken: string }>) {
  return rows.filter((row) => row.status === 'FAILED').map(({ id, payload, effectiveToken }) => ({ id, payload, effectiveToken }))
}

test('composition: cancelling one of two FAILED money-moving rows lifts the planner refusal', () => {
  const payload = { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', amount: 40 }
  // The o3d-nf9i part-payment history: two INVOICE_PAYMENT attempts against the same invoice,
  // under DIFFERENT tokens, both FAILED. Either might have committed, so planFollowUpEnqueue
  // refuses — permanently, with no way out.
  const rows = [
    { id: 'log-new', status: 'FAILED', payload, effectiveToken: 'token-new' },
    { id: 'log-old', status: 'FAILED', payload, effectiveToken: 'token-old' },
  ]
  const identity = {
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', amount: 60 },
    liveRowExists: false,
  }

  const before = planFollowUpEnqueue({ ...identity, failedRows: failedFollowUpSet(rows) })
  assert.equal(before.action, 'refuse', 'two distinct tokens, either of which may have committed')

  // The operator verifies in the ledger that log-old never landed and settles it NOT_POSTED.
  const patch = buildSettlementData({ outcome: 'NOT_POSTED', reason: 'verified absent' }, NOW) as { status: string }
  const settled = rows.map((row) => (row.id === 'log-old' ? { ...row, status: patch.status } : row))

  const after = planFollowUpEnqueue({ ...identity, failedRows: failedFollowUpSet(settled) })
  assert.notEqual(after.action, 'refuse', 'one candidate token left, so the payment is no longer ambiguous')
  assert.equal(after.action, 'reuse')
  assert.equal(after.action === 'reuse' ? after.syncLogId : null, 'log-new')
  assert.equal(after.action === 'reuse' ? after.tokenDisposition : null, 'pinned')
})

test('composition: settling POSTED does NOT drop the row out of the ambiguity set — it closes the follow-up', () => {
  // The bd issue says terminalising "frees the partial unique index slot". True only for the
  // CANCELLED branch: both partial unique indexes have predicate
  // status IN ('PENDING','PROCESSING','SYNCED'), and SYNCED is INSIDE them. So POSTED frees
  // nothing; it makes the row LIVE again, which is what "it really did post" should mean.
  const payload = { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', amount: 40 }
  const patch = buildSettlementData({ outcome: 'POSTED', externalTransactionId: 'PAY-9' }, NOW) as { status: string }
  assert.equal(patch.status, 'SYNCED')
  const rows = [{ id: 'log-old', status: patch.status, payload, effectiveToken: 'token-old' }]
  assert.deepEqual(failedFollowUpSet(rows), [], 'a SYNCED row is not in the FAILED ambiguity set either')

  // ...and hasExistingSyncLog counts PENDING/PROCESSING/SYNCED, so the live row now exists and
  // the planner skips rather than creating a second payment.
  const plan = planFollowUpEnqueue({
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload,
    liveRowExists: true,
    failedRows: [],
  })
  assert.equal(plan.action, 'skip')
})
