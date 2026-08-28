import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-e2mz r8 — `repairXeroBackReferences` IS THE COMPONENT THAT RELEASES A SALE'S WORK.
 *
 * Rounds 5–7 closed the cancellation window one PRODUCER at a time (the fence-loss recovery), and
 * each round ended with the same flag: the sweep itself still has no cancellation check. That flag is
 * the defect. Gating producers can only cover the producers that were thought of — the ORDINARY settle
 * path reads no sales order at all, and a post that succeeds and then fails its back-reference or its
 * follow-up enqueue is left FAILED with its external id intact, which is the sweep's candidate shape
 * reached with nobody having asked about the sale.
 *
 * What the sweep does when it releases a row is not a bookkeeping tidy-up: it stamps
 * `accountingInvoiceId` + `invoicedAt` onto the order and enqueues INVOICE_PDF and INVOICE_PAYMENT.
 * So the question is asked here, under the order's row lock, immediately before the first write.
 *
 * HOW THESE FIXTURES ARE KEPT HONEST. Every cancelled-sale test has a LIVE-sale twin built from the
 * SAME row and the SAME source-document state, differing only in `SalesOrder.status`. The twin asserts
 * the release really happens — the order really is updated, the payment row really is created — which
 * is what proves the cancelled fixture reaches the state under test rather than being skipped earlier
 * by the probe. (Rounds 5 and 6 shipped fixtures that could not reach the state they were named for.)
 */

process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }> = []

/**
 * EVERY read, lock and write the sweep makes against a source document, IN ORDER.
 *
 * The whole fix is an ordering claim — "the sale is read under its row lock, before anything is
 * written" — and an assertion on the final row state cannot distinguish that from a read taken
 * anywhere else. The probe read and the gate read are told apart by their `select`, exactly as
 * Postgres would: `backReferenceIsMissing` selects the back-reference column, the gate selects
 * `status`.
 */
const journal: string[] = []

type OrderRow = { status: string; accountingInvoiceId: string | null }
let salesOrders: Map<string, OrderRow> = new Map()
/**
 * How many of the next row-LOCK attempts must fail — a lock timeout, or a deadlock lost to the very
 * cancellation the lock exists to serialise against.
 *
 * This is the ONLY faithful way to make the gate's read fail while leaving the probe intact. Making
 * the whole sales-order delegate throw looks like the same test and is not: `backReferenceIsMissing`
 * runs FIRST and unlocked, so it throws too, the sweep takes its `probeError` branch, and the row
 * never reaches the gate at all — while `result.failed` still lands on 1 and every counter assertion
 * passes. A fixture that cannot reach the state under test is worse than no fixture.
 */
let lockFailures = 0
/** How many of the next LOCKED status reads must fail, with the lock itself succeeding. */
let statusReadFailures = 0
let refunds: Map<string, { accountingCreditNoteId: string | null }> = new Map()
let bills: Map<string, { accountingInvoiceId: string | null }> = new Map()

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

function selectedKeys(select: Record<string, unknown> | undefined): string[] {
  return Object.keys(select ?? {})
}

const dbStub = {
  accountingSyncLog,
  salesOrder: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
      const keys = selectedKeys(select)
      const locked = keys.includes('status')
      journal.push(`${locked ? 'read-status' : 'probe'}:${where.id}`)
      if (locked && statusReadFailures > 0) {
        statusReadFailures -= 1
        throw new Error('sales order read unavailable')
      }
      const row = salesOrders.get(where.id)
      if (!row) return null
      return Object.fromEntries(keys.map((key) => [key, (row as unknown as Record<string, unknown>)[key]]))
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      journal.push(`order-update:${where.id}`)
      const row = salesOrders?.get(where.id)
      if (!row) throw new Error(`no sales order ${where.id}`)
      Object.assign(row, data)
      return row
    },
  },
  salesOrderRefund: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
      journal.push(`probe-refund:${where.id}`)
      const row = refunds.get(where.id)
      if (!row) return null
      return Object.fromEntries(selectedKeys(select).map((key) => [key, (row as unknown as Record<string, unknown>)[key]]))
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      journal.push(`refund-update:${where.id}`)
      const row = refunds.get(where.id)
      if (!row) throw new Error(`no refund ${where.id}`)
      Object.assign(row, data)
      return row
    },
  },
  purchaseInvoice: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
      journal.push(`probe-bill:${where.id}`)
      const row = bills.get(where.id)
      if (!row) return null
      return Object.fromEntries(selectedKeys(select).map((key) => [key, (row as unknown as Record<string, unknown>)[key]]))
    },
    findFirst: async () => null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      journal.push(`bill-update:${where.id}`)
      const row = bills.get(where.id)
      if (!row) throw new Error(`no bill ${where.id}`)
      Object.assign(row, data)
      return row
    },
  },
  supplierCreditNote: {
    findUnique: async () => null,
    update: async () => { throw new Error('unused') },
  },
  /**
   * The sweep's keyset cursor (o3d-9kek r3 finding 4), merged since this file was written. It lives
   * in ONE Setting row; an absent one means "start at the head", which is what every test here wants.
   */
  setting: {
    findUnique: async () => null,
    upsert: async () => ({}),
  },
  // lockSalesOrder issues `SELECT id FROM "sales_orders" WHERE id = $1 FOR UPDATE`.
  $queryRaw: async (query: { values?: unknown[] }) => {
    journal.push(`lock:${String(query?.values?.[0] ?? '')}`)
    if (lockFailures > 0) {
      lockFailures -= 1
      throw new Error('could not lock the sales order row')
    }
    return []
  },
  // o3d-0m56: the follow-up enqueue takes the per-scope advisory lock (`pg_advisory_xact_lock`)
  // before it writes, for money-moving types. Recorded like the row lock above so the ORDER of the
  // two stays visible; without the delegate the enqueue throws and the sweep silently produces no
  // follow-ups at all, which reads here as "the repair did not happen".
  $executeRaw: async () => {
    journal.push('scope-lock')
    return 1
  },
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbStub),
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    /**
     * The shared sweep is wired to `logActivityPersisted`, NOT `logActivity` (o3d-9kek r2 finding 3):
     * it defers an ambiguous row on the strength of having warned, and `logActivity` swallows
     * persistence errors, so awaiting it proves nothing. A double that omitted this would leave the
     * sweep calling an undefined export and every assertion here would be about a thrown run.
     */
    logActivityPersisted: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
      return true
    },
    redactActivityLogText: (value: string) => value,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
// The mirrored accounting event is a separate table with its own tests; this is about the sweep.
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    updateMirroredAccountingEventStatus: async () => {},
    voidMirroredAccountingEventsForOrder: async () => {},
  },
})
// The outbox round-trip says nothing about whether the follow-up ROW was created, which is the
// observable these tests turn on.
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: {
    scheduleXeroAccountingOutbox: async () => ({}),
    parseXeroAccountingOutboxPayload: (value: unknown) => value,
    XERO_ACCOUNTING_POST_OPERATION: 'post',
    XERO_OUTBOX_CONNECTOR: 'xero-accounting',
  },
})
// A payment account map that RESOLVES, so `_registerPayment` really reaches the INVOICE_PAYMENT
// enqueue. Without it the payment is skipped with a WARNING and the cancelled-sale tests would be
// asserting the absence of a row that was never going to be created.
mock.module('@/lib/accounting', {
  namedExports: {
    getPaymentAccountMap: async () => ({ card: 'BANK-1' }),
    lookupPaymentAccount: () => 'BANK-1',
  },
})
mock.module('@/lib/connectors/xero/auth', { namedExports: { getGrantedScopes: async () => null } })
mock.module('@/lib/connectors/woocommerce/sync/invoice-note', {
  namedExports: { pushInvoiceNoteToWc: async () => ({ success: true }) },
})
/**
 * THE DEFERRED-RECEIPT RE-DRIVE, STUBBED AS SETTLED (o3d-0bfh).
 *
 * This file is about the CANCELLATION gate, and every fixture below is a live or cancelled sale with
 * no deferred receipt in it. The real `registerDeferredOrderReceipts` was previously left to run
 * against `dbStub`, which models only the columns the cancellation gate reads — so it answered from
 * an incomplete fixture rather than from anything these tests set up. That was harmless while the
 * sweep discarded the answer, and stopped being harmless the moment it started reading it: the
 * live-sale twins began reporting an outstanding receipt that no test had asked for, which would
 * have masked the release they exist to prove.
 *
 * Stated as an explicit assumption instead. The receipt gate has its own tests
 * (tests/accounting/back-reference-sweep.test.ts, [o3d-0bfh]); this one holds it at "nothing owed"
 * so the only variable left in these fixtures is `SalesOrder.status`.
 */
mock.module('@/lib/domain/accounting/invoice-payment-enqueue', {
  namedExports: {
    registerDeferredOrderReceipts: async (
      _orderId: string,
      _posted: unknown,
      obligation: { syncLogId: string; generation: Date | null } | null,
    ) => {
      // o3d-0bfh r15: AND IT CLEARS THE GENERATION IT WAS HANDED. The production re-drive takes the
      // sales-order lock, re-reads the receipts, and releases the obligation IN THAT SAME
      // TRANSACTION — so by the time the sweep writes its settlement stamp the marker column is
      // already null. A stub that answered "settled" without doing so would leave the sweep fencing
      // its stamp on a generation nothing holds any more, and every live-sale twin below would
      // report a deferral that production never produces.
      if (obligation?.generation) {
        await store.delegate.updateMany({
          where: { id: obligation.syncLogId, backReferenceFollowUpsPendingAt: obligation.generation },
          data: { backReferenceFollowUpsPendingAt: null },
        } as never)
      }
      return {
        settled: true,
        reason: 'no-receipts',
        release: obligation?.generation ? 'released' : 'not-held',
      }
    },
  },
})

async function loadSweep() {
  return (await import('@/lib/connectors/xero/sync-processor')).repairXeroBackReferences
}

const INVOICE_PAYLOAD = {
  invoiceNumber: 'INV-1',
  currency: 'GBP',
  _registerPayment: true,
  _paymentMethod: 'card',
  _paymentAmount: 120,
  _paymentDate: '2026-08-20',
}

/** The candidate shape: SALES_INVOICE on a sales order, naming a document, in the sweep's status set. */
const SALES_CANDIDATE = {
  id: 'log-1',
  type: 'SALES_INVOICE',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  externalTransactionId: 'XERO-INV-1',
  attemptRevision: 4,
  payload: INVOICE_PAYLOAD,
}

function reset(rows: Parameters<typeof createSyncLogStore>[0], order: OrderRow) {
  store = createSyncLogStore(rows)
  activity.length = 0
  journal.length = 0
  lockFailures = 0
  statusReadFailures = 0
  salesOrders = new Map([['order-1', { ...order }]])
  refunds = new Map([['refund-1', { accountingCreditNoteId: null }]])
  bills = new Map([['bill-1', { accountingInvoiceId: null }]])
}

/** Follow-up rows the sweep created — the PDF, the email, the note and the PAYMENT. */
function followUpRows(): Array<{ type: string; referenceId: string }> {
  return store.rows.filter((row) => row.id !== 'log-1').map((row) => ({ type: row.type, referenceId: row.referenceId }))
}

// ---------------------------------------------------------------------------
// THE MISSING-BACK-REFERENCE PATH — the sweep's original job.
// ---------------------------------------------------------------------------

test('o3d-e2mz r8: the sweep RETIRES a candidate whose SALE is cancelled instead of releasing its work', async () => {
  reset([syncLogRow({ ...SALES_CANDIDATE, status: 'SYNCED' })], { status: 'CANCELLED', accountingInvoiceId: null })

  const result = await (await loadSweep())()

  assert.deepEqual(
    salesOrders?.get('order-1'),
    { status: 'CANCELLED', accountingInvoiceId: null },
    'the Xero id is NOT stamped onto the cancelled order',
  )
  assert.deepEqual(followUpRows(), [], 'and none of the cancelled sale\'s follow-ups are enqueued — PDF, email, note, PAYMENT')

  const row = store.get('log-1')
  assert.equal(row?.status, 'CANCELLED', 'the row is retired out of the sweep\'s candidate shape')
  assert.equal(row?.externalTransactionId, 'XERO-INV-1', 'the document that exists is still named on it — the delete guard reads it whatever the status')
  assert.equal(row?.syncedAt, null)
  assert.equal(row?.attemptRevision, 5, 'a writer that retires a row advances the fence, so a concurrent sweep cannot settle it')

  assert.deepEqual(result, {
    scanned: 1, checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0,
    followUpsDiscarded: 0, skippedUnverified: 0, retiredCancelledSale: 1, followUpsUnsettled: 0, settlementDeferred: 0,
  })
  const escalation = activity.find((entry) => entry.action === 'xero_backreference_repair_cancelled_sale')
  assert.equal(escalation?.level, 'ERROR')
  assert.match(escalation?.description ?? '', /the sale is CANCELLED/)
  assert.match(escalation?.description ?? '', /PAYMENT/)
  assert.equal(escalation?.metadata?.externalId, 'XERO-INV-1')
})

test('o3d-e2mz r8: the SAME candidate on a LIVE sale is still repaired — the sweep\'s own job is untouched', async () => {
  // THE COUNTER-GUARD, and the proof the fixture above reaches the state under test: identical row,
  // identical order state, only `status` differs — and here the release demonstrably happens.
  reset([syncLogRow({ ...SALES_CANDIDATE, status: 'SYNCED' })], { status: 'PROCESSING', accountingInvoiceId: null })

  const result = await (await loadSweep())()

  assert.equal(salesOrders?.get('order-1')?.accountingInvoiceId, 'XERO-INV-1', 'a live sale still gets its back-reference')
  assert.deepEqual(
    followUpRows().map((row) => row.type).sort(),
    ['INVOICE_PAYMENT', 'INVOICE_PDF'],
    'and its follow-ups — including the PAYMENT the cancelled case must never reach',
  )
  assert.equal(store.get('log-1')?.status, 'SYNCED', 'a SYNCED row stays SYNCED')
  assert.deepEqual(result, {
    scanned: 1, checked: 1, repaired: 1, failed: 0, skippedAmbiguous: 0,
    followUpsDiscarded: 0, skippedUnverified: 0, retiredCancelledSale: 0, followUpsUnsettled: 0, settlementDeferred: 0,
  })
})

test('o3d-e2mz r8: the sale is read UNDER ITS ROW LOCK, after the probe and before any write', async () => {
  // WHY the retirement can be trusted. A status read taken anywhere else is one a cancellation can
  // overtake, however close to the write it sits: `cancelSalesOrderFulfillmentState` opens with
  // `lockSalesOrder` on this same row, so only a read behind that lock serialises against it.
  reset([syncLogRow({ ...SALES_CANDIDATE, status: 'SYNCED' })], { status: 'PROCESSING', accountingInvoiceId: null })

  await (await loadSweep())()

  assert.deepEqual(
    journal,
    // The trailing entries are other mechanisms' own steps, merged since this test was written, and
    // they are listed rather than filtered out so that a NEW step appearing before the lock fails
    // here rather than being absorbed:
    //   • `scope-lock` — o3d-0m56's per-scope advisory lock, taken by the follow-up enqueue. AFTER
    //     the back-reference write, which is the point: it guards the follow-up rows, not the sale.
    //   • the trailing probe — the shared sweep's own post-write verification (o3d-9kek).
    // What this pins is the PREFIX: nothing is written before the lock and the status read behind it.
    ['probe:order-1', 'lock:order-1', 'read-status:order-1', 'order-update:order-1', 'scope-lock', 'probe:order-1'],
    'probe, then LOCK, then the status read, and only then the first write',
  )
})

test('o3d-e2mz r8: a LOCK the sweep cannot take DEFERS the repair — nothing released, and the settled row is not retracted', async () => {
  // Fail closed means refusing to RELEASE work. It is not permission to RETRACT one: retiring here
  // would demote every settled row a transient lock timeout happens to touch, and no self-service
  // action releases a CANCELLED row (o3d-psvi). The row keeps its status and the next sweep asks
  // again, having released nothing in between — which is why this gate needs no retry of its own,
  // unlike the fence-loss recovery, which gets exactly one pass at a document it has already posted.
  //
  // The SALE IS LIVE in this fixture on purpose: the deferral must be caused by the failed lock, not
  // by a cancelled order that would have been retired anyway.
  reset([syncLogRow({ ...SALES_CANDIDATE, status: 'SYNCED' })], { status: 'PROCESSING', accountingInvoiceId: null })
  lockFailures = 1

  const result = await (await loadSweep())()

  const row = store.get('log-1')
  assert.equal(row?.status, 'SYNCED', 'the row is left exactly as it stands')
  assert.equal(row?.attemptRevision, 4, 'and its fence is not advanced by a pass that decided nothing')
  assert.equal(row?.externalTransactionId, 'XERO-INV-1')
  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, null, 'nothing is written onto the order')
  assert.deepEqual(followUpRows(), [], 'and nothing is released while the sale cannot be proved live')
  assert.deepEqual(result, {
    scanned: 1, checked: 0, repaired: 0, failed: 1, skippedAmbiguous: 0,
    followUpsDiscarded: 0, skippedUnverified: 0, retiredCancelledSale: 0, followUpsUnsettled: 0, settlementDeferred: 0,
  })
  const deferral = activity.find((entry) => entry.action === 'xero_backreference_repair_sale_unreadable')
  assert.equal(deferral?.level, 'WARNING')
  assert.match(deferral?.description ?? '', /could not be read/)
  assert.match(
    deferral?.description ?? '',
    /could not lock the sales order row/,
    'and it names WHY: a lock timeout and a broken read need different responses',
  )
  assert.match(String(deferral?.metadata?.error ?? ''), /could not lock the sales order row/)
  assert.deepEqual(
    journal,
    ['probe:order-1', 'lock:order-1'],
    'the probe succeeded and it is the LOCKED read that failed — otherwise the row never reaches the gate at all',
  )
})

test('o3d-e2mz r8: a locked status read that fails defers in the same way, and never releases on the guess', async () => {
  // The other half of "unreadable": the lock is taken and the read behind it fails. The sweep must
  // not fall back to a read-free release — an unproven sale releases nothing.
  reset([syncLogRow({ ...SALES_CANDIDATE, status: 'SYNCED' })], { status: 'PROCESSING', accountingInvoiceId: null })
  statusReadFailures = 1

  const result = await (await loadSweep())()

  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, null)
  assert.deepEqual(followUpRows(), [])
  assert.equal(store.get('log-1')?.status, 'SYNCED')
  assert.deepEqual(result, {
    scanned: 1, checked: 0, repaired: 0, failed: 1, skippedAmbiguous: 0,
    followUpsDiscarded: 0, skippedUnverified: 0, retiredCancelledSale: 0, followUpsUnsettled: 0, settlementDeferred: 0,
  })
  assert.deepEqual(journal, ['probe:order-1', 'lock:order-1', 'read-status:order-1'])
})

test('o3d-e2mz r8: a DELETED sales order is treated as cancelled, not as licence to carry on', async () => {
  // The order is gone: nothing downstream could resolve the reference. Releasing its follow-ups would
  // enqueue a PAYMENT against a sale that does not exist.
  //
  // The row is FAILED, not SYNCED, and that is what makes the fixture REACHABLE: a missing order makes
  // `backReferenceIsMissing` false, and a SYNCED row with nothing missing is skipped before the gate.
  // FAILED is the follow-ups-only shape, which is precisely the one that would enqueue the payment.
  reset([syncLogRow({ ...SALES_CANDIDATE, status: 'FAILED' })], { status: 'PROCESSING', accountingInvoiceId: null })
  salesOrders.delete('order-1')

  const result = await (await loadSweep())()

  assert.deepEqual(journal, ['probe:order-1', 'lock:order-1', 'read-status:order-1'], 'the gate really ran')
  assert.deepEqual(followUpRows(), [])
  assert.equal(store.get('log-1')?.status, 'CANCELLED')
  assert.deepEqual(result, {
    scanned: 1, checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0,
    followUpsDiscarded: 0, skippedUnverified: 0, retiredCancelledSale: 1, followUpsUnsettled: 0, settlementDeferred: 0,
  })
})

// ---------------------------------------------------------------------------
// THE FOLLOW-UPS-ONLY PATH — a FAILED row whose back-reference is ALREADY applied.
//
// This is the shape the ordinary settle path produces without ever reading a sale: the invoice posted,
// the back-reference was written, and the follow-up enqueue then failed, so `markSyncLogForFollowUpRetry`
// left the row FAILED with its external id. The sweep applies nothing here — it exists purely to
// enqueue the follow-ups, which is exactly the cancelled sale's work.
// ---------------------------------------------------------------------------

test('o3d-e2mz r8: a FAILED row whose back-reference is already applied is retired too, so its PAYMENT is never enqueued', async () => {
  reset([syncLogRow({ ...SALES_CANDIDATE, status: 'FAILED' })], { status: 'CANCELLED', accountingInvoiceId: 'XERO-INV-1' })

  const result = await (await loadSweep())()

  assert.deepEqual(followUpRows(), [], 'the follow-ups-only pass releases nothing for a cancelled sale')
  assert.equal(store.get('log-1')?.status, 'CANCELLED')
  assert.equal(store.get('log-1')?.attemptRevision, 5)
  assert.deepEqual(result, {
    scanned: 1, checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0,
    followUpsDiscarded: 0, skippedUnverified: 0, retiredCancelledSale: 1, followUpsUnsettled: 0, settlementDeferred: 0,
  })
})

test('o3d-e2mz r8: the same FAILED row on a LIVE sale still gets its outstanding follow-ups', async () => {
  // The twin that proves the fixture above is reachable: with the order live, this row takes the
  // follow-ups-only branch and really does create the PAYMENT.
  reset([syncLogRow({ ...SALES_CANDIDATE, status: 'FAILED' })], { status: 'PROCESSING', accountingInvoiceId: 'XERO-INV-1' })

  const result = await (await loadSweep())()

  assert.deepEqual(followUpRows().map((row) => row.type).sort(), ['INVOICE_PAYMENT', 'INVOICE_PDF'])
  assert.equal(store.get('log-1')?.status, 'SYNCED', 'and the reconciled row is settled')
  assert.deepEqual(result, {
    scanned: 1, checked: 1, repaired: 0, failed: 0, skippedAmbiguous: 0,
    followUpsDiscarded: 0, skippedUnverified: 0, retiredCancelledSale: 0, followUpsUnsettled: 0, settlementDeferred: 0,
  })
  assert.ok(activity.some((entry) => entry.action === 'xero_backreference_followups_recovered'))
})

// ---------------------------------------------------------------------------
// WHAT THE GATE MUST NOT TOUCH. Only a row whose reference IS a sales order belongs to a sale that a
// cancellation speaks for.
// ---------------------------------------------------------------------------

test('o3d-e2mz r8: a supplier bill is repaired without any order lock — no sale is involved', async () => {
  reset([syncLogRow({
    id: 'log-1',
    type: 'PURCHASE_INVOICE',
    referenceType: 'PurchaseInvoice',
    referenceId: 'bill-1',
    externalTransactionId: 'XERO-BILL-1',
    status: 'SYNCED',
    attemptRevision: 4,
  })], { status: 'CANCELLED', accountingInvoiceId: null })

  const result = await (await loadSweep())()

  assert.equal(bills.get('bill-1')?.accountingInvoiceId, 'XERO-BILL-1')
  assert.equal(result.repaired, 1)
  assert.equal(result.retiredCancelledSale, 0)
  assert.deepEqual(journal.filter((entry) => entry.startsWith('lock:')), [], 'no sales-order lock is taken for a bill')
})

test('o3d-e2mz r8: a refund CREDIT NOTE is repaired even though its order is cancelled — the cancellation is WHY it exists', async () => {
  // Gating this one would strand the very document the cancellation produced. Crediting a cancelled
  // sale is right; invoicing it is wrong, and only the invoice side is gated.
  reset([syncLogRow({
    id: 'log-1',
    type: 'CREDIT_NOTE',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    externalTransactionId: 'XERO-CN-1',
    status: 'SYNCED',
    attemptRevision: 4,
  })], { status: 'CANCELLED', accountingInvoiceId: null })

  const result = await (await loadSweep())()

  assert.equal(refunds.get('refund-1')?.accountingCreditNoteId, 'XERO-CN-1', 'the credit note still gets its back-reference')
  assert.equal(result.repaired, 1)
  assert.equal(result.retiredCancelledSale, 0)
  assert.deepEqual(journal.filter((entry) => entry.startsWith('lock:')), [], 'and no sales-order lock is taken for it')
})
