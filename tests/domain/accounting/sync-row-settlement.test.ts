import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SETTLEABLE_ACCOUNTING_SYNC_STATUSES,
  buildSettlementData,
  buildSettlementWhere,
  buildStrandedSyncRowWhere,
  describeLostSettlementCas,
  describeSettlementUniqueConflict,
  describeStrandedSyncRow,
  findMirrorOwnershipConflict,
  isSettleableAccountingSyncStatus,
  isSettleableAccountingSyncType,
  refuseSettlement,
  settlementMirrorExternalId,
  settlementMirrorStatus,
} from '@/lib/domain/accounting/sync-row-settlement'
import { mirroredAccountingEventIdempotencyKeys } from '@/lib/domain/accounting/accounting-event-mirror'
import { findSalesOrderDeleteBlocker } from '@/lib/domain/sales/order-delete-guard'
import { planFollowUpEnqueue } from '@/lib/domain/accounting/followup-idempotency'

// o3d-nf9i + o3d-osl8. The settlement decision, tested without a database — the same way
// connector-orphans.ts and followup-idempotency.ts are tested, and for the same reason: the
// rule about which rows a human may settle, and what settling them does, is the part that
// must not drift.

// ---------------------------------------------------------------------------
// The settleable set
// ---------------------------------------------------------------------------

/** A settleable row by default: FAILED, a per-document type, no post evidence. */
function view(overrides: Partial<Parameters<typeof refuseSettlement>[0]> = {}) {
  return { status: 'FAILED', type: 'SALES_INVOICE', externalTransactionId: null, ...overrides }
}

test('FAILED is the ONLY settleable status — PROCESSING is deliberately excluded (o3d-osl8)', () => {
  assert.deepEqual([...SETTLEABLE_ACCOUNTING_SYNC_STATUSES], ['FAILED'])
  assert.equal(isSettleableAccountingSyncStatus('FAILED'), true, 'o3d-nf9i: ambiguous, may have posted, but TERMINAL')
  assert.equal(
    isSettleableAccountingSyncStatus('PROCESSING'),
    false,
    'a CAS on PROCESSING fences the ROW, not the CLAIM: it cannot prove the remote call finished',
  )
  assert.equal(isSettleableAccountingSyncStatus('PENDING'), false, 'the ordinary sweeps own PENDING')
  assert.equal(isSettleableAccountingSyncStatus('SYNCED'), false)
  assert.equal(isSettleableAccountingSyncStatus('CANCELLED'), false)
})

test('PROCESSING is refused with the REASON — an in-flight claim nothing can prove either way', () => {
  const refusal = refuseSettlement(view({ status: 'PROCESSING' }), { outcome: 'NOT_POSTED' })
  assert.equal(refusal?.code, 'processing_claim_unprovable')
  assert.match(refusal!.message, /STILL BE IN FLIGHT/)
  assert.match(refusal!.message, /generation/, 'says what is missing, not just that it is refused')
  assert.match(refusal!.message, /o3d-osl8/, 'and where the fix is tracked')
})

test('PENDING is refused, and says the sweeps own it — nothing was sent, so nothing is ambiguous', () => {
  const refusal = refuseSettlement(view({ status: 'PENDING' }), { outcome: 'NOT_POSTED' })
  assert.equal(refusal?.code, 'pending_not_settleable')
  assert.match(refusal!.message, /nothing has been sent/i)
})

test('an already-terminal row is refused for both outcomes — a recorded outcome is not re-writable', () => {
  for (const status of ['SYNCED', 'CANCELLED']) {
    const posted = refuseSettlement(view({ status }), { outcome: 'POSTED', externalTransactionId: 'INV-1' })
    assert.equal(posted?.code, 'already_terminal', status)
    const notPosted = refuseSettlement(view({ status }), { outcome: 'NOT_POSTED' })
    assert.equal(notPosted?.code, 'already_terminal', status)
  }
})

// ---------------------------------------------------------------------------
// DAILY_BATCH_* — refused on the TYPE, whatever the status
// ---------------------------------------------------------------------------

test('no DAILY_BATCH_* type is settleable — the recreate-vs-delete race', () => {
  for (const type of [
    'DAILY_BATCH_REVENUE_DEFERRAL',
    'DAILY_BATCH_INVENTORY_ALLOC',
    'DAILY_BATCH_GROUP_B',
    'DAILY_BATCH_INVENTORY_RECONCILIATION',
    'DAILY_BATCH_COGS_RECONCILIATION',
    'DAILY_BATCH_TRANSIT_RECONCILIATION',
  ]) {
    assert.equal(isSettleableAccountingSyncType(type), false, type)
  }
  for (const type of ['SALES_INVOICE', 'CREDIT_NOTE', 'INVOICE_PAYMENT', 'PURCHASE_INVOICE']) {
    assert.equal(isSettleableAccountingSyncType(type), true, type)
  }
})

test('a FAILED DailyBatch row is refused BY TYPE, and the message names the race', () => {
  // CANCELLED reads as "never posted" to the batch recreators AND as "no blocker" to the delete
  // guard, so settling one lets an order be deleted while a recreate is already building a
  // journal that still contains its value. The status is otherwise perfectly settleable, which
  // is the point: the type is what refuses it.
  const refusal = refuseSettlement(
    view({ type: 'DAILY_BATCH_REVENUE_DEFERRAL' }),
    { outcome: 'NOT_POSTED', reason: 'nothing in the ledger' },
  )
  assert.equal(refusal?.code, 'daily_batch_not_settleable')
  assert.match(refusal!.message, /DAILY_BATCH_REVENUE_DEFERRAL/)
  assert.match(refusal!.message, /delete guard/)
  assert.match(refusal!.message, /recreate/)
  // POSTED is refused too — the batch is not this operator's fact to record either way.
  assert.equal(
    refuseSettlement(view({ type: 'DAILY_BATCH_INVENTORY_ALLOC' }), { outcome: 'POSTED', externalTransactionId: 'JRN-1' })?.code,
    'daily_batch_not_settleable',
  )
})

test('POSTED without an external id is refused — a post nothing can be reconciled against', () => {
  const refusal = refuseSettlement(view(), { outcome: 'POSTED', externalTransactionId: '   ' })
  assert.equal(refusal?.code, 'missing_external_id')
})

test('NOT_POSTED against a row that already carries an external id is refused as a contradiction', () => {
  // The id IS post evidence, and tests/sales-order-delete-guard.test.ts pins that a CANCELLED
  // row carrying one STILL blocks the delete — so it would not even achieve what was wanted.
  const refusal = refuseSettlement(view({ externalTransactionId: 'INV-777' }), { outcome: 'NOT_POSTED' })
  assert.equal(refusal?.code, 'contradicts_post_evidence')
  assert.match(refusal!.message, /INV-777/)
})

test('POSTED re-asserting the SAME external id is idempotent; a DIFFERENT one is refused', () => {
  const same = refuseSettlement(
    view({ externalTransactionId: 'INV-5' }),
    { outcome: 'POSTED', externalTransactionId: ' INV-5 ' },
  )
  assert.equal(same, null, 'a retried click must not become a refusal')
  const different = refuseSettlement(
    view({ externalTransactionId: 'INV-5' }),
    { outcome: 'POSTED', externalTransactionId: 'INV-6' },
  )
  assert.equal(different?.code, 'external_id_conflict')
})

test('a settleable row with a well-formed assertion is not refused', () => {
  assert.equal(refuseSettlement(view(), { outcome: 'POSTED', externalTransactionId: 'INV-9' }), null)
  assert.equal(refuseSettlement(view(), { outcome: 'NOT_POSTED', reason: 'nothing in Xero' }), null)
})

// ---------------------------------------------------------------------------
// Mirror ownership — the mirror is SHARED between attempts
// ---------------------------------------------------------------------------

test('two ATTEMPTS at one document really do share a mirror key — the reason ownership matters', () => {
  // Not a model of the key builder: the REAL one. `_idempotencyKey` in the payload wins over the
  // sync-log id, so a FAILED attempt and its live replacement address the SAME AccountingEvent.
  const identity = {
    connector: 'xero',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { _idempotencyKey: 'doc-1', date: '2026-08-01' },
  }
  const oldKeys = mirroredAccountingEventIdempotencyKeys({ ...identity, syncLogId: 'log-old' })
  const newKeys = mirroredAccountingEventIdempotencyKeys({ ...identity, syncLogId: 'log-new' })
  assert.ok(oldKeys.length > 0)
  assert.deepEqual(oldKeys, newKeys, 'different rows, one mirrored event')

  // So settling the old FAILED row must leave the live replacement's event alone.
  const conflict = findMirrorOwnershipConflict(oldKeys, [
    { id: 'log-new', status: 'SYNCED', externalTransactionId: 'INV-9', mirrorKeys: newKeys },
  ])
  assert.equal(conflict?.syncLogId, 'log-new')
  assert.equal(conflict?.posted, true)

  // And it is not only the payload key. Without `_idempotencyKey` the PRIMARY key falls back to
  // the per-row sync-log id — but updateMirroredAccountingEventStatus then falls back AGAIN to
  // the syncLogId-less `<connector>:<type>:<ref>:<date>` form, which every attempt on that date
  // shares. Checking only the primary key would miss this entirely, so both forms are returned.
  const bare = { ...identity, payload: { date: '2026-08-01' } }
  const bareOld = mirroredAccountingEventIdempotencyKeys({ ...bare, syncLogId: 'log-old' })
  const bareNew = mirroredAccountingEventIdempotencyKeys({ ...bare, syncLogId: 'log-new' })
  assert.equal(bareOld.length, 2, 'primary (per-row) + legacy (shared)')
  assert.notEqual(bareOld[0], bareNew[0], 'the primary keys differ...')
  assert.equal(bareOld[1], bareNew[1], '...but the legacy fallback is shared')
  const legacyConflict = findMirrorOwnershipConflict(bareOld, [
    { id: 'log-new', status: 'PROCESSING', externalTransactionId: null, mirrorKeys: bareNew },
  ])
  assert.equal(legacyConflict?.syncLogId, 'log-new')
  assert.equal(legacyConflict?.sharedKey, bareOld[1])
  assert.equal(legacyConflict?.posted, false)
})

test('a live or posted sibling sharing the mirror key owns it; a dead one does not', () => {
  const mine = ['accounting-sync:xero:SALES_INVOICE:doc-1']
  const sibling = (over: Partial<Parameters<typeof findMirrorOwnershipConflict>[1][number]>) => ({
    id: 'log-new',
    status: 'PENDING',
    externalTransactionId: null,
    mirrorKeys: mine,
    ...over,
  })

  for (const status of ['PENDING', 'PROCESSING', 'SYNCED']) {
    const conflict = findMirrorOwnershipConflict(mine, [sibling({ status })])
    assert.equal(conflict?.syncLogId, 'log-new', status)
    assert.equal(conflict?.sharedKey, mine[0])
  }
  // FAILED with post evidence still owns it: the document exists (o3d-ju8t).
  const posted = findMirrorOwnershipConflict(mine, [sibling({ status: 'FAILED', externalTransactionId: 'INV-9' })])
  assert.equal(posted?.posted, true)
  // FAILED with nothing to show for itself owns nothing.
  assert.equal(findMirrorOwnershipConflict(mine, [sibling({ status: 'FAILED' })]), null)
  assert.equal(findMirrorOwnershipConflict(mine, [sibling({ status: 'CANCELLED' })]), null)
  // A live sibling on a DIFFERENT mirror is not a conflict.
  assert.equal(findMirrorOwnershipConflict(mine, [sibling({ mirrorKeys: ['other-key'] })]), null)
  // Nothing mirrored at all cannot conflict with anything.
  assert.equal(findMirrorOwnershipConflict([], [sibling({})]), null)
})

// ---------------------------------------------------------------------------
// The POSTED branch's partial-unique-index collision
// ---------------------------------------------------------------------------

test('a P2002 is translated into an operator instruction, and nothing else is', () => {
  const message = describeSettlementUniqueConflict({
    code: 'P2002',
    meta: { target: ['idempotencyKey'] },
  })
  assert.match(String(message), /Another LIVE sync row/)
  assert.match(String(message), /idempotencyKey/, 'names the constraint it collided on')
  assert.match(String(message), /Nothing was changed/)
  assert.match(String(message), /Resolve that live row first/)
  assert.match(String(message), /will\s+not cancel it for you/, 'IMS must not silently retire a live attempt')
  // Anything that is not a unique violation is not this failure and must be rethrown by callers.
  assert.equal(describeSettlementUniqueConflict(new Error('boom')), null)
  assert.equal(describeSettlementUniqueConflict({ code: 'P2025' }), null)
})

// ---------------------------------------------------------------------------
// The CAS fence
// ---------------------------------------------------------------------------

test('the CAS where re-asserts the status the operator was SHOWN', () => {
  // Same shape as markSyncLogForFollowUpRetry's `where: { id, retryCount }` (audit-dzm9): the
  // loser of a race matches nothing and writes nothing.
  assert.deepEqual(buildSettlementWhere('log-1', 'FAILED'), { id: 'log-1', status: 'FAILED' })
  // FAILED is the only status the signature accepts — SettleableAccountingSyncStatus is a
  // one-member union, so a PROCESSING fence does not type-check, let alone run.
  assert.deepEqual(buildSettlementWhere('log-2', 'FAILED'), { id: 'log-2', status: 'FAILED' })
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

function stranded(over: Partial<Parameters<typeof describeStrandedSyncRow>[0]> = {}) {
  return describeStrandedSyncRow(
    {
      id: 'log-1',
      connector: 'quickbooks',
      type: 'INVOICE_PAYMENT',
      status: 'FAILED',
      referenceType: 'SalesOrder',
      referenceId: 'order-7',
      externalTransactionId: null,
      errorMessage: null,
      createdAt: new Date('2026-08-04T10:00:00.000Z'),
      ...over,
    },
    NOW,
  )
}

test('a stranded row is described with identifying detail, not counted (o3d-osl8)', () => {
  const row = stranded()
  assert.equal(row.connector, 'quickbooks')
  assert.equal(row.type, 'INVOICE_PAYMENT')
  assert.equal(row.referenceType, 'SalesOrder')
  assert.equal(row.referenceId, 'order-7')
  assert.equal(row.status, 'FAILED')
  assert.equal(row.ageDays, 10)
  assert.equal(row.settleable, true)
  assert.equal(row.notSettleableReason, null)
})

test('a stranded PROCESSING row is still LISTED — visible is item 1, settleable is not', () => {
  // o3d-osl8 item 1 is about VISIBILITY, and it ships in full: the row a connector switch left
  // claimed forever appears here with its age and its reference. What it does NOT get is a
  // settlement control, because a CAS on PROCESSING cannot prove the claim is not in flight.
  const row = stranded({ status: 'PROCESSING' })
  assert.equal(row.status, 'PROCESSING', 'listed, not filtered out')
  assert.equal(row.ageDays, 10)
  assert.equal(row.settleable, false)
  assert.match(String(row.notSettleableReason), /STILL BE IN FLIGHT/)
})

test('a stranded PENDING row is listed but NOT settleable — bulk-cancel is its remedy', () => {
  const row = stranded({ status: 'PENDING', createdAt: NOW })
  assert.equal(row.settleable, false)
  assert.match(String(row.notSettleableReason), /nothing has been sent/i)
  assert.equal(row.ageDays, 0)
})

test('a stranded DAILY_BATCH row is listed but NOT settleable, and says why', () => {
  const row = stranded({ status: 'FAILED', type: 'DAILY_BATCH_GROUP_B', referenceType: 'DailyBatch', referenceId: 'B-2026-08-04' })
  assert.equal(row.settleable, false, 'a settleable STATUS is not enough — the type refuses it')
  assert.match(String(row.notSettleableReason), /DAILY BATCH/)
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

/**
 * THE ORDER IS STAGED INTO BOTH DAILY BATCHES. Deliberately non-null.
 *
 * With null stamps the guard's `daily_batch_staged` branch `continue`s before it reads anything,
 * so a test using them proves the accounting-row branch and NOTHING about batches — which is how
 * the earlier version of this suite passed while DAILY_BATCH_* was still settleable. Real dates
 * mean the guard actually derives `A1-2026-08-01` / `A2-2026-08-02` and queries for them, so any
 * settled batch row that fell out of LIVE_ACCOUNTING_SYNC_STATUSES would show up here as an
 * order that became deletable.
 */
const STAMPS = {
  revenueDeferredDate: new Date('2026-08-01T00:00:00.000Z'),
  inventoryAllocatedDate: new Date('2026-08-02T00:00:00.000Z'),
}

/** The A2 batch row this order is inside, as the daily sync would have written it. */
function batchRow(status: string) {
  return {
    id: 'log-batch',
    connector: 'xero',
    type: 'DAILY_BATCH_INVENTORY_ALLOC',
    status,
    referenceType: 'DailyBatch',
    referenceId: 'A2-2026-08-02-1a2b3c4d',
    externalTransactionId: null as string | null,
  }
}

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
  //
  // The order IS staged into both daily batches (STAMPS above), so the guard genuinely runs its
  // batch lookups here; it finds no live batch row because none was ever created for this order.
  const row = settledRow({ outcome: 'NOT_POSTED', reason: 'no document in the retired tenant' })
  assert.equal(row.status, 'CANCELLED')
  assert.equal(row.externalTransactionId, null)
  const blocker = await findSalesOrderDeleteBlocker(guardTx([row]), 'order-1', STAMPS)
  assert.equal(blocker, null)
})

test('composition: a live DAILY BATCH row blocks the delete — and settling it would NOT be visible to the guard', async () => {
  // Why DAILY_BATCH_* is refused. A FAILED batch row blocks the delete (FAILED is inside
  // LIVE_ACCOUNTING_SYNC_STATUSES). Apply the NOT_POSTED patch to it and the SAME guard, over
  // the SAME order, returns null: CANCELLED is outside that set, so the batch stops blocking.
  // Nothing tells the batch recreator that, and it reads the very same absence as "not posted
  // yet" — so it can rebuild a journal containing an order this now permits deleting.
  const settled = settledRow({ outcome: 'NOT_POSTED', reason: 'not in the ledger' })

  const blocked = await findSalesOrderDeleteBlocker(guardTx([settled, batchRow('FAILED')]), 'order-1', STAMPS)
  assert.equal(blocked?.code, 'daily_batch_staged')
  assert.match(blocked!.message, /A2 inventory allocation/)

  const patch = buildSettlementData({ outcome: 'NOT_POSTED' }, NOW) as { status: string }
  const afterSettlingTheBatch = await findSalesOrderDeleteBlocker(
    guardTx([settled, batchRow(patch.status)]),
    'order-1',
    STAMPS,
  )
  assert.equal(
    afterSettlingTheBatch,
    null,
    'settling a batch row would hand back a deletable order while a recreate can still post its value',
  )

  // Which is why the settlement action never lets that happen: the refusal is on the TYPE.
  assert.equal(
    refuseSettlement({ status: 'FAILED', type: 'DAILY_BATCH_INVENTORY_ALLOC', externalTransactionId: null }, { outcome: 'NOT_POSTED' })?.code,
    'daily_batch_not_settleable',
  )
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
