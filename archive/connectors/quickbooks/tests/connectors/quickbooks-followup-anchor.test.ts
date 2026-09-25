import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

// ---------------------------------------------------------------------------
// o3d-hbgo, THE QUICKBOOKS HALF — A LIVE ROW ONLY OWNS THIS FOLLOW-UP WHEN IT TARGETS THE SAME
// EXTERNAL DOCUMENT.
//
// `hasExistingSyncLog` decided "this follow-up already exists" from (connector, type, referenceType,
// referenceId) alone. referenceId is an ORDER, so a SalesOrder whose invoice is deleted and re-posted
// to a NEW QuickBooks invoice kept the SYNCED INVOICE_PAYMENT row from the FIRST invoice, the payment
// for the SECOND was skipped as already-handled, and the replacement was never settled. Silently:
// `planFollowUpEnqueue` returns `skip` and a skip logs nothing. Same shape for INVOICE_PDF, which
// left the order holding the PDF of an invoice it no longer has.
//
// The Xero side gained the anchor comparison on the o3d-anu8 branch; this connector was DELIBERATELY
// left coarse there, and that is what these tests close. They drive the REAL
// `enqueueFollowUpSyncLog` from lib/connectors/quickbooks/sync-processor.ts — the Xero equivalents
// pass either way, which is exactly how this survived the change that fixed the other connector.
//
// WHAT MUST NOT HAPPEN WHILE CLOSING IT, and is asserted below as hard as the fix itself: the dedup
// must not become vacuous (a row against the SAME invoice still owns the slot), a row that records NO
// document must still suppress (unknown target reads as "possibly this one"), and o3d-anu8's
// operator-assertion refusal must survive for the document the assertion actually names.
// ---------------------------------------------------------------------------

const ASSERTED = 'OPERATOR_ASSERTION'
/** The invoice that was deleted. */
const RETIRED = 'QBINV-1'
/** The invoice it was re-posted as — what every enqueue below targets. */
const REPLACEMENT = 'QBINV-2'

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description: string }> = []

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

const dbStub = {
  accountingSyncLog,
  // The per-scope advisory lock the enqueue holds across its create. Not what these tests are
  // about, but the run dies before reaching the create without it.
  $executeRaw: async () => 0,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbStub),
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string }) => { activity.push(entry) },
    logActivityPersisted: async (entry: { action: string; level?: string; description: string }) => {
      activity.push(entry)
      return true
    },
    logActivityInTransaction: async (_tx: unknown, entry: { action: string; level?: string; description: string }) => {
      activity.push(entry)
    },
  },
})
mock.module('@/lib/connectors/accounting-settlement-probe', {
  namedExports: {
    // Answered CLEAR throughout: these tests are about the live-row lookup that runs BEFORE the
    // ledger evidence, and a probe that refused would stop every case short of the decision.
    ledgerClearsFollowUpRevival: async () => ({ clear: true }),
    postMoneyUnderLedgerFence: async (_params: unknown, run: () => Promise<unknown>) => run(),
    probeLedgerSettlement: async () => ({ ok: true, records: [] }),
    settlementProbeKey: () => 'probe-key',
  },
})

function reset(rows: Parameters<typeof createSyncLogStore>[0]) {
  store = createSyncLogStore(rows)
  activity.length = 0
}

async function loadEnqueue() {
  return (await import('@/lib/connectors/quickbooks/sync-processor')).enqueueFollowUpSyncLog
}

/** A live QuickBooks follow-up row on order-1, targeting `accountingInvoiceId`. */
function liveRow(overrides: {
  id: string
  type?: string
  accountingInvoiceId?: string | null
  settlementBasis?: string | null
}) {
  const { accountingInvoiceId = RETIRED, ...rest } = overrides
  return syncLogRow({
    connector: 'quickbooks',
    type: 'INVOICE_PAYMENT',
    status: 'SYNCED',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    // `accountingInvoiceId: null` models a row queued BEFORE the payload recorded an anchor, so the
    // key is absent from the JSON entirely rather than present and null.
    payload: accountingInvoiceId === null
      ? { bankAccountId: 'bank-1', amount: 40 }
      : { accountingInvoiceId, bankAccountId: 'bank-1', amount: 40 },
    ...rest,
  })
}

/** The follow-up payload for the REPLACEMENT invoice — what every enqueue below tries to queue. */
function replacementPayload(accountingInvoiceId = REPLACEMENT) {
  return { accountingInvoiceId, bankAccountId: 'bank-1', amount: 40, paymentDate: '2026-08-01', customerRef: 'QBCUST-1' }
}

/** Rows this run CREATED, i.e. work that was not skipped. */
function queued(type: string) {
  return store.rows.filter((row) => row.status === 'PENDING' && row.type === type)
}

test('[o3d-hbgo] a re-invoiced order\'s QuickBooks payment is ENQUEUED, not skipped as already-done', async () => {
  // THE DEFECT. The SYNCED row settles QBINV-1, which no longer exists. Counting it as the live
  // registration left QBINV-2 unsettled for ever, and nothing said so.
  reset([liveRow({ id: 'live-pay-old' })])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', replacementPayload())

  const created = queued('INVOICE_PAYMENT')
  assert.equal(created.length, 1, 'the replacement invoice must get its own payment follow-up')
  assert.equal(
    (created[0].payload as { accountingInvoiceId?: string }).accountingInvoiceId,
    REPLACEMENT,
    'and it must target the REPLACEMENT invoice, not the retired one',
  )
})

test('[o3d-hbgo] the PDF follows the replacement invoice too', async () => {
  // The issue names this as the same shape: the order kept the PDF of the invoice it no longer has.
  reset([liveRow({ id: 'live-pdf-old', type: 'INVOICE_PDF' })])

  await (await loadEnqueue())('INVOICE_PDF', 'SalesOrder', 'order-1', replacementPayload())

  assert.equal(queued('INVOICE_PDF').length, 1)
})

test('[o3d-hbgo] a live row against the SAME invoice still owns the slot', async () => {
  // THE DEDUP MUST NOT BECOME VACUOUS. This is the concurrent-enqueue case the check exists for, and
  // the one where a second live row means a second QuickBooks payment against one invoice.
  reset([liveRow({ id: 'live-pay', accountingInvoiceId: REPLACEMENT })])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', replacementPayload())

  assert.deepEqual(queued('INVOICE_PAYMENT'), [], 'the slot is legitimately occupied; nothing new is created')
  assert.equal(store.rows.length, 1)
})

test('[o3d-hbgo] a live row that records NO document still suppresses the enqueue', async () => {
  // FAIL CLOSED. A row queued before the payload carried an anchor could have settled anything, and
  // for money "unknown target" has to read as "possibly this one" — skipping a possibly-duplicate
  // payment is recoverable where posting one is not. Deliberately STRICTER than the database index,
  // which gives unanchored rows their own COALESCE('') slot.
  reset([liveRow({ id: 'live-pay-legacy', accountingInvoiceId: null })])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', replacementPayload())

  assert.deepEqual(queued('INVOICE_PAYMENT'), [], 'an unanchored live row keeps suppressing, exactly as before')
})

test('[o3d-hbgo] an assertion about the RETIRED invoice does not refuse the replacement\'s payment', async () => {
  // `asserted` is narrowed WITH `exists`, and that is not incidental. Judged over every live row, an
  // operator's assertion about the invoice this order no longer has would refuse the enqueue for the
  // replacement — o3d-anu8's refusal firing on a document its assertion never named.
  reset([liveRow({ id: 'live-pay-old', settlementBasis: ASSERTED })])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', replacementPayload())

  assert.deepEqual(
    activity.filter((entry) => entry.action === 'quickbooks_followup_enqueue_refused'),
    [],
    'the assertion names QBINV-1; it says nothing about whether QBINV-2 has been settled',
  )
  assert.equal(queued('INVOICE_PAYMENT').length, 1)
})

test('[o3d-anu8 preserved] an assertion about THIS invoice still refuses', async () => {
  // The control that keeps the test above about WHICH DOCUMENT rather than about the refusal being
  // weakened. Identical row, one field different: the assertion now names the invoice being enqueued.
  reset([liveRow({ id: 'live-pay', accountingInvoiceId: REPLACEMENT, settlementBasis: ASSERTED })])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', replacementPayload())

  const refusals = activity.filter((entry) => entry.action === 'quickbooks_followup_enqueue_refused')
  assert.equal(refusals.length, 1, 'the withholding must stay VISIBLE — a silent skip is the o3d-anu8 defect')
  assert.match(refusals[0].description, /OPERATOR asserted it posted/)
  assert.deepEqual(queued('INVOICE_PAYMENT'), [], 'and nothing is queued: enqueuing could pay it twice')
})
