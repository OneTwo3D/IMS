import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

// ---------------------------------------------------------------------------
// o3d-anu8, CROSS-PORTED — THE QUICKBOOKS SIDE OF TWO READERS THE XERO SIDE STOPPED TRUSTING.
//
// `buildSettlementData` writes SYNCED on an OPERATOR'S ASSERTION, with settlementBasis =
// 'OPERATOR_ASSERTION' and no remote call behind it. Two QuickBooks readers still treated such a row
// as though the connector had written it back after the ledger answered:
//
//   1. `hasExistingSyncLog` counted rows. An asserted SYNCED INVOICE_PAYMENT therefore occupied the
//      follow-up slot, `planFollowUpEnqueue` skipped, and the invoice was NEVER settled in the
//      ledger — silently, permanently, because a skip logs nothing.
//   2. the INVOICE_PAYMENT post ran no capacity guard at all, so a sibling registration that is
//      SYNCED only because somebody typed a document id could not even be looked at, let alone
//      refused. Its `amount` is what IMS INTENDED to send; subtracting it from the invoice total
//      produces a confident remainder measured from nothing, and the error runs in the direction
//      that lets a second payment out.
//
// EVERY TEST HERE DRIVES THE QUICKBOOKS CODE. The Xero equivalents pass either way, which is exactly
// how both of these survived the change that fixed them on the other connector.
// ---------------------------------------------------------------------------

const ASSERTED = 'OPERATOR_ASSERTION'

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }> = []
/** Every QuickBooks money call this run made. Empty is the assertion for a refusal. */
const qboPosts: Array<{ path: string; body: unknown }> = []
let salesOrder: Record<string, unknown> | null = null

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

const dbStub = {
  accountingSyncLog,
  salesOrder: {
    findUnique: async () => salesOrder,
  },
  // The per-scope advisory lock the money-moving enqueue takes, and the attempt-stamping custody
  // repair the processor runs before it claims anything. Neither is what these tests are about; both
  // have to answer or the run dies before reaching the decision.
  $executeRaw: async () => 0,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbStub),
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    logActivityPersisted: async (entry: { action: string; level?: string; description: string }) => {
      activity.push(entry)
      return true
    },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})
mock.module('@/lib/connectors/quickbooks/api', {
  namedExports: {
    qboPost: async (path: string, body: unknown) => { qboPosts.push({ path, body }); return { ok: true, data: {} } },
    qboPostIdempotent: async (path: string, body: unknown) => {
      qboPosts.push({ path, body })
      return { ok: true, data: { Payment: { Id: 'QBPAY-1' } } }
    },
    qboUploadAttachment: async () => ({ ok: true }),
    resolveAccountRef: async () => ({ value: 'qbo-bank-1' }),
  },
})
mock.module('@/lib/connectors/accounting-settlement-probe', {
  namedExports: {
    // Answered CLEAR throughout: these tests are about the guards BEFORE the fence, and a fence that
    // refused would stop every case before the guard under test was reached.
    ledgerClearsFollowUpRevival: async () => ({ clear: true }),
    postMoneyUnderLedgerFence: async (_params: unknown, run: () => Promise<unknown>) => run(),
    probeLedgerSettlement: async () => ({ ok: true, records: [] }),
    settlementProbeKey: () => 'probe-key',
  },
})

function reset(rows: Parameters<typeof createSyncLogStore>[0]) {
  store = createSyncLogStore(rows)
  activity.length = 0
  qboPosts.length = 0
  salesOrder = null
}

const PAYMENT_PAYLOAD = {
  accountingInvoiceId: 'QBINV-1',
  bankAccountId: 'bank-1',
  amount: 40,
  paymentDate: '2026-08-01',
  customerRef: 'QBCUST-1',
}

/** A live INVOICE_PAYMENT row occupying the follow-up slot for order-1. */
function livePaymentRow(settlementBasis: string | null, overrides: Partial<Parameters<typeof syncLogRow>[0]> = {}) {
  return syncLogRow({
    id: 'live-pay',
    connector: 'quickbooks',
    type: 'INVOICE_PAYMENT',
    status: 'SYNCED',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { ...PAYMENT_PAYLOAD },
    settlementBasis,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// FINDING 1 — the live-row lookup is basis-aware, and the planner is told.
// ---------------------------------------------------------------------------

async function loadEnqueue() {
  return (await import('@/lib/connectors/quickbooks/sync-processor')).enqueueFollowUpSyncLog
}

test('[o3d-anu8] an ASSERTED live payment row makes the QuickBooks enqueue REFUSE, not skip', async () => {
  reset([livePaymentRow(ASSERTED)])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...PAYMENT_PAYLOAD })

  const refusals = activity.filter((entry) => entry.action === 'quickbooks_followup_enqueue_refused')
  assert.equal(refusals.length, 1, 'the withholding must be VISIBLE — a silent skip is the defect')
  assert.match(refusals[0].description, /OPERATOR asserted it posted/)
  assert.equal(refusals[0].level, 'WARNING')
  assert.equal(
    store.rows.filter((row) => row.id !== 'live-pay').length,
    0,
    'and nothing is queued: enqueuing could pay the invoice twice if the assertion is right',
  )
})

test('[o3d-anu8] a live payment row the CONNECTOR wrote back still skips silently', async () => {
  // The other half of the rule, and the one that stops this becoming a repeating warning: a SYNCED
  // row with no settlement basis IS the connector's writeback after QuickBooks answered.
  reset([livePaymentRow(null)])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...PAYMENT_PAYLOAD })

  assert.deepEqual(activity.filter((entry) => entry.action === 'quickbooks_followup_enqueue_refused'), [])
  assert.equal(store.rows.length, 1, 'the slot is legitimately occupied, so nothing new is created')
})

test('[o3d-anu8] the refusal is scoped to MONEY — an asserted row does not make every follow-up warn', async () => {
  // A suppressed PDF re-drive costs a document nobody received. Turning every asserted row into a
  // repeating warning would bury the ones that move money.
  reset([livePaymentRow(ASSERTED, { id: 'live-pdf', type: 'INVOICE_PDF' })])

  await (await loadEnqueue())('INVOICE_PDF', 'SalesOrder', 'order-1', { ...PAYMENT_PAYLOAD })

  assert.deepEqual(activity.filter((entry) => entry.action === 'quickbooks_followup_enqueue_refused'), [])
  assert.equal(store.rows.length, 1)
})

test('[o3d-anu8] one asserted occupant is enough — worst-first, not majority-rules', async () => {
  // Any of the occupying rows may be the only reason this work is being suppressed, so the
  // aggregation cannot be "most of them are fine".
  reset([
    livePaymentRow(null, { id: 'live-real' }),
    livePaymentRow(ASSERTED, { id: 'live-asserted' }),
  ])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...PAYMENT_PAYLOAD })

  assert.equal(activity.filter((entry) => entry.action === 'quickbooks_followup_enqueue_refused').length, 1)
})

// ---------------------------------------------------------------------------
// FINDING 2 — the post-time capacity guard runs on QuickBooks too.
// ---------------------------------------------------------------------------

async function runQuickBooks() {
  return (await import('@/lib/connectors/quickbooks/sync-processor')).processPendingQuickBooksSync()
}

/** The entry under test: a queued QuickBooks receipt of 40 against QBINV-1 for order-1. */
function queuedPaymentEntry() {
  return syncLogRow({
    id: 'entry-pay',
    connector: 'quickbooks',
    type: 'INVOICE_PAYMENT',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { ...PAYMENT_PAYLOAD },
    createdAt: new Date('2026-08-20T09:00:00.000Z'),
  })
}

/** A 100.00 order raised in IMS, so the ledger invoice total is 100.00. */
const ORDER_100 = { totalForeign: 100, taxForeign: 0, pricesIncludeVat: false, shoppingLinks: [] }

test('[o3d-anu8] a QuickBooks payment is REFUSED when a sibling registration was only ASSERTED', async () => {
  reset([
    queuedPaymentEntry(),
    // 60 asserted + 40 queued = 100 exactly. Without the basis this is arithmetic that fits, on a
    // figure nothing ever sent.
    livePaymentRow(ASSERTED, { id: 'sibling', payload: { ...PAYMENT_PAYLOAD, amount: 60 } }),
  ])
  salesOrder = ORDER_100

  const result = await runQuickBooks()

  assert.deepEqual(qboPosts, [], 'NOTHING may reach QuickBooks — this is the whole point of the guard')
  assert.equal(result.skipped >= 1, true, 'the entry is handled, not failed into a retry loop')
  assert.equal(store.get('entry-pay')?.status, 'CANCELLED',
    'retired, and CANCELLED is provably honest here because the guard runs before the remote call')
  const refusal = activity.find((entry) => entry.action === 'invoice_payment_refused_unknown_ledger_state')
  assert.ok(refusal, 'filed as unknown-ledger-state, not as an over-settlement figure IMS cannot state')
  assert.equal((refusal.metadata as { refusal?: string }).refusal, 'ASSERTED_REGISTRATION')
  assert.match(refusal.description, /OPERATOR'S ASSERTION/)
})

test('[o3d-anu8] the same sibling written back by the CONNECTOR lets the payment through', async () => {
  // The control that makes the test above about the BASIS rather than about the presence of a
  // sibling: identical rows, identical arithmetic, one column different.
  reset([
    queuedPaymentEntry(),
    livePaymentRow(null, { id: 'sibling', payload: { ...PAYMENT_PAYLOAD, amount: 60 } }),
  ])
  salesOrder = ORDER_100

  await runQuickBooks()

  assert.equal(qboPosts.length, 1, 'a measurable 60 + 40 against a 100 invoice fits, and posts')
  assert.equal(qboPosts[0].path, 'payment')
})

test('[o3d-cjt8] the ported guard also refuses a QuickBooks payment that would OVER-SETTLE', async () => {
  // The guard is adopted whole rather than as an asserted-only variant, and this is what that buys:
  // QuickBooks had no over-settlement arithmetic anywhere before this port.
  reset([
    queuedPaymentEntry(),
    livePaymentRow(null, { id: 'sibling', payload: { ...PAYMENT_PAYLOAD, amount: 80 } }),
  ])
  salesOrder = ORDER_100

  await runQuickBooks()

  assert.deepEqual(qboPosts, [], '80 already registered leaves 20; a 40 receipt does not fit')
  assert.equal(store.get('entry-pay')?.status, 'CANCELLED')
  const refusal = activity.find((entry) => entry.action === 'invoice_payment_refused_over_settlement')
  assert.ok(refusal)
  assert.equal((refusal.metadata as { refusal?: string }).refusal, 'WOULD_OVERPAY')
})

test('[o3d-cjt8] an unreadable order fails CLOSED on QuickBooks — no post, and it stays retryable', async () => {
  // "Cannot measure" must never read as "go ahead", and it is NOT the same outcome as a refusal: a
  // missing read is transient, so the row keeps its retries rather than being retired.
  reset([queuedPaymentEntry()])
  salesOrder = null

  await runQuickBooks()

  assert.deepEqual(qboPosts, [])
  assert.notEqual(store.get('entry-pay')?.status, 'CANCELLED', 'unmeasurable is not a terminal verdict')
  assert.match(String(store.get('entry-pay')?.errorMessage), /not found before posting an invoice payment/)
})

test('[o3d-cjt8] a clean invoice with no siblings still posts — the guard is a gate, not a wall', async () => {
  reset([queuedPaymentEntry()])
  salesOrder = ORDER_100

  await runQuickBooks()

  assert.equal(qboPosts.length, 1)
  assert.equal(qboPosts[0].path, 'payment')
})

// ---------------------------------------------------------------------------
// CODEX ROUND 2, HIGH — A PROVEN PRE-CALL FAILURE MUST NOT TERMINALLY REFUSE THE NEXT PAYMENT.
//
// The ported guard reads every FAILED sibling with a syntactically complete payload as
// possibly-posted, and refuses AMBIGUOUS_FAILED_REGISTRATION for ever. That rule was written against
// Xero, which validates the payload and then goes almost straight to the fence.
//
// QuickBooks fails EARLIER. Its INVOICE_PAYMENT case resolves a customer reference and a bank
// account from the database AFTER the payload validation and BEFORE the capacity guard, so
// `Missing customer reference for INVOICE_PAYMENT` is a FAILED row whose payload is complete and
// whose attempt provably never left the process. Every later receipt on that invoice was then
// refused terminally — a perfectly good payment, permanently.
//
// THIS IS NOT A QUICKBOOKS BUG. It is a gap in the SHARED guard that only became visible on a
// connector that fails earlier, so the fix is in the guard: it now selects the attempt-provenance
// pair and excludes FAILED rows that are canonically proven never attempted
// (`attemptProvenNeverMade`). Xero gains the same exclusion for its own post-guard, pre-send
// failures.
//
// These drive the REAL processPendingQuickBooksSync, and the FAILED sibling in the first test is
// produced BY that connector rather than hand-written, so the row shape under test is the one
// QuickBooks actually creates.
// ---------------------------------------------------------------------------

/** An order whose customer has no QuickBooks contact id — the pre-call failure QuickBooks detects. */
const ORDER_100_NO_CUSTOMER = { ...ORDER_100, customer: null }
/** The same order, with a contact the connector will accept. */
const ORDER_100_WITH_CUSTOMER = {
  ...ORDER_100,
  customer: { accountingContactId: 'QBCUST-1', accountingContactProvenance: null },
}

/** A queued receipt with NO customerRef in its payload, so the connector must resolve one. */
function receiptNeedingCustomerLookup(id: string, amount: number) {
  const { customerRef: _dropped, ...withoutCustomerRef } = PAYMENT_PAYLOAD
  return syncLogRow({
    id,
    connector: 'quickbooks',
    type: 'INVOICE_PAYMENT',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { ...withoutCustomerRef, amount },
    createdAt: new Date('2026-08-20T08:00:00.000Z'),
  })
}

test('[o3d-anu8 r2] a receipt QuickBooks refused PRE-CALL does not block the next one on that invoice', async () => {
  // PHASE 1 — let the connector itself produce the FAILED row. Five passes exhaust the retry budget,
  // and the row lands FAILED with a COMPLETE payload (accountingInvoiceId, bankAccountId, amount all
  // present, so the body test cannot clear it) and NO remoteAttemptedAt — while every claim stamped
  // attempt-stamping custody onto it, which is what makes that silence evidence.
  reset([receiptNeedingCustomerLookup('receipt-a', 40)])
  salesOrder = ORDER_100_NO_CUSTOMER

  for (let pass = 0; pass < 5; pass += 1) await runQuickBooks()

  const failed = store.get('receipt-a')
  assert.equal(failed?.status, 'FAILED', 'the connector really does terminalise it')
  assert.match(String(failed?.errorMessage), /Missing customer reference/)
  // `length`, not `deepEqual(qboPosts, [])`: node:assert's deep-equality against a literal `[]`
  // narrows the array to `never[]` for the rest of the test, and phase 2 below reads qboPosts[0].
  assert.equal(qboPosts.length, 0, 'and it never sent anything — that is the whole point')
  assert.equal(failed?.remoteAttemptedAt, null, 'no attempt was ever stamped')
  assert.ok(
    failed?.attemptStampingCustodyAt instanceof Date,
    'and custody was asserted by the production claim, so the missing stamp is a PROOF, not a silence',
  )

  // PHASE 2 — the operator fixes the contact and records the receipt again. Before this fix the
  // guard read receipt-a as "might have posted" and refused this row terminally.
  store.rows.push(queuedPaymentEntry())
  salesOrder = ORDER_100_WITH_CUSTOMER

  await runQuickBooks()

  assert.equal(qboPosts.length, 1, 'the replacement receipt posts')
  assert.equal(qboPosts[0].path, 'payment')
  assert.notEqual(
    store.get('entry-pay')?.status,
    'CANCELLED',
    'it must not be retired as an unresolvable ambiguity',
  )
})

test('[o3d-anu8 r2] a FAILED sibling that DID reach the remote call still refuses — the exclusion is narrow', async () => {
  // The control that makes the test above about PROVENANCE rather than about pre-call failures being
  // waved through. Identical row, one column different: `remoteAttemptedAt` is set, which
  // `authoriseMoneyPost` does as its FIRST act before any send. A stamped row may hold a payment
  // whose response was lost, so the invoice's balance is genuinely unknowable.
  reset([
    queuedPaymentEntry(),
    syncLogRow({
      id: 'receipt-a',
      connector: 'quickbooks',
      type: 'INVOICE_PAYMENT',
      status: 'FAILED',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      payload: { ...PAYMENT_PAYLOAD },
      remoteAttemptedAt: new Date('2026-08-20T08:30:00.000Z'),
      attemptStampingCustodyAt: new Date('2026-08-20T08:00:00.000Z'),
    }),
  ])
  salesOrder = ORDER_100_WITH_CUSTOMER

  await runQuickBooks()

  assert.deepEqual(qboPosts, [], 'a row that made a call may have settled the invoice; nothing may be sent')
  assert.equal(store.get('entry-pay')?.status, 'CANCELLED')
  const refusal = activity.find((entry) => entry.action === 'invoice_payment_refused_unknown_ledger_state')
  assert.ok(refusal)
  assert.equal((refusal.metadata as { refusal?: string }).refusal, 'AMBIGUOUS_FAILED_REGISTRATION')
})

test('[o3d-anu8 r2] a FAILED sibling OUTSIDE stamping custody still refuses — absence is not proof', async () => {
  // The direction the fix must not get backwards. Custody NULL means a binary that does not stamp
  // has handled this row (a deploy window, an overlap, a rollback), so its empty `remoteAttemptedAt`
  // says nothing at all. Only a POSITIVE record that the row is pre-call may exclude it; everything
  // undetermined keeps failing closed.
  reset([
    queuedPaymentEntry(),
    syncLogRow({
      id: 'receipt-a',
      connector: 'quickbooks',
      type: 'INVOICE_PAYMENT',
      status: 'FAILED',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      payload: { ...PAYMENT_PAYLOAD },
      remoteAttemptedAt: null,
      attemptStampingCustodyAt: null,
    }),
  ])
  salesOrder = ORDER_100_WITH_CUSTOMER

  await runQuickBooks()

  assert.deepEqual(qboPosts, [])
  assert.equal(store.get('entry-pay')?.status, 'CANCELLED')
})
