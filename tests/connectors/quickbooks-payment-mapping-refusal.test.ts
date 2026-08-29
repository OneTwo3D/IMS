import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'
// The REAL recovery note. The refusal message under test is composed out of it, and on this
// connector it is the sentence that says NOTHING will come back for the row — a mock would replace
// the thing being asserted.
import { followUpObligationRecoveryNote } from '@/lib/domain/accounting/back-reference'

/**
 * o3d-batch-ret ROUND 6 (Codex HIGH), THE QUICKBOOKS HALF — AND IT IS THE WORSE HALF.
 *
 * `enqueueSalesInvoiceFollowUps` seeded `paymentOutcome` with `FOLLOW_UPS_ENQUEUED` and narrowed it
 * only where the enqueue was actually reached. A payload asking for a payment whose method has no
 * mapped bank account therefore queued NOTHING and reported `enqueued: true`, the receipt fence was
 * handed no prerequisite, and it released the obligation generation.
 *
 * ON XERO THAT COSTS A LAP OF THE SWEEP. HERE IT COSTS THE MONEY. This connector's registry entry
 * declares `consumer: 'none'`: nothing re-reads a retained marker, so the marker is not a deferral,
 * it is the only EVIDENCE the payment is owed — and the exception inbox is built on it. Clearing it
 * over a payment that was never queued ends the trail, and no later correction of the mapping can
 * find the row again.
 *
 * BEHAVIOURAL, FOR THE REASON CODEX GAVE IN ROUND 6. The structural ordering judge this replaces
 * could be satisfied by a shape whose RUNTIME called the fence first. Here the real
 * `processPendingQuickBooksSync` runs, the real `registerDeferredOrderReceipts` takes the fenced
 * pass, and the observable is whether `releaseFollowUpObligation` was reached with a generation it
 * could clear. A fence invoked before the verdict existed would carry a hoisted `undefined`
 * prerequisite and release — which is exactly what the retention assertions catch.
 */

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description?: string; metadata?: Record<string, unknown> }> = []
/** Every sync row whose follow-up obligation was actually DISCHARGED. */
const released: string[] = []
/** The generations the connector's claim minted, so the fenced release can be modelled honestly. */
const claimed: Array<{ syncLogId: string; generation: Date }> = []

/**
 * The payment account map the connector reads — MUTABLE, so "nothing configured", "configured but
 * not for this method" and "configured correctly" are three states of ONE fixture.
 */
let paymentMap: Record<string, string> | null = null

/**
 * The order under test: GBP 120, paid by card, and NO receipt of its own.
 *
 * No receipt is deliberate and load-bearing. The deferred-receipt re-drive then takes its
 * `no-receipts` path, where the ONLY thing that can hold the obligation open is the enqueue verdict
 * this test is about. With a receipt present, retention would be ambiguous between the two.
 */
const order = {
  id: 'order-1',
  orderNumber: 'SO-1',
  externalOrderNumber: null as string | null,
  accountingInvoiceId: null as string | null,
  currency: 'GBP',
  totalForeign: 120,
  taxForeign: 0,
  pricesIncludeVat: false,
  shoppingLinks: [] as Array<{ connector: string }>,
  customer: { accountingContactId: null, accountingContactProvenance: null },
}

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

const dbStub = {
  accountingSyncLog,
  salesOrder: { findUnique: async () => ({ ...order, payments: [] }) },
  payment: { findUnique: async () => null, findMany: async () => [] },
  // The advisory locks the enqueue and the fence take. They must ANSWER, or the enqueue dies before
  // writing anything and every assertion below would read zero for the wrong reason.
  $executeRaw: async () => 1,
  $queryRaw: async () => [],
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const rowMark = store.rows.length
    try {
      return await fn(dbStub)
    } catch (error) {
      store.rows.length = rowMark
      throw error
    }
  },
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description?: string; metadata?: Record<string, unknown> }) => { activity.push(entry) },
    logActivityPersisted: async (entry: { action: string; level?: string; description?: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
      return true
    },
    logActivityInTransaction: async (_tx: unknown, entry: { action: string; level?: string; description?: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    redactActivityLogText: (value: string) => value,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })
mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingSyncTypeEnabled: async () => true,
    isAccountingSyncTypeEnabledFor: async () => true,
    getActiveAccountingConnectorInfo: async () => ({ id: 'quickbooks' }),
    // THE VARIABLE UNDER TEST, asked as a real question of a real map.
    getPaymentAccountMap: async () => paymentMap,
    lookupPaymentAccount: (map: Record<string, string> | null, method: string) => map?.[method] ?? null,
    queueAccountingSyncTxWithOutcome: async () => ({ queued: true, connector: 'quickbooks' }),
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})
mock.module('@/lib/domain/accounting/back-reference', {
  namedExports: {
    applyBackReference: async (_db: unknown, params: { externalId: string }) => {
      order.accountingInvoiceId = params.externalId
      return { outcome: 'applied' as const, attribution: { reason: '' } }
    },
    backReferenceHolder: () => ({}),
    findExternalDocumentIdClaim: async () => null,
    claimFollowUpObligation: async (_client: unknown, params: { syncLogId: string }) => {
      const generation = new Date(`2026-08-2${claimed.length + 1}T00:00:00.000Z`)
      claimed.push({ syncLogId: params.syncLogId, generation })
      return { claimed: true as const, generation }
    },
    isExternalDocumentIdConflict: () => false,
    // NOT faked: it is pure, and the refusal message under test is composed out of it.
    followUpObligationRecoveryNote,
    releaseFollowUpObligation: async (_client: unknown, params: { syncLogId: string; generation: Date | null }) => {
      // FENCED, so a release carrying no generation clears nothing — which is what keeps `released`
      // able to tell a discharge from a refusal.
      // THE LATEST claim for the row, not the first (o3d-batch-ret r7). A row that is refused and
      // retried is claimed once per pass, and the generation the earlier pass minted has been
      // REPLACED on the row — `nextFollowUpObligationGeneration` mints monotonically over whatever
      // it observes. Fencing against the first claim would make every second pass read `superseded`,
      // which is a fixture artefact and not the protocol.
      const mine = [...claimed].reverse().find((entry) => entry.syncLogId === params.syncLogId)
      if (params.generation === null || mine === undefined || mine.generation.getTime() !== params.generation.getTime()) {
        return 'superseded' as const
      }
      released.push(params.syncLogId)
      return 'released' as const
    },
  },
})
mock.module('@/lib/connectors/accounting-settlement-probe', {
  namedExports: {
    ledgerClearsFollowUpRevival: async () => ({ clear: true }),
    postMoneyUnderLedgerFence: async (_params: unknown, run: () => Promise<unknown>) => run(),
    probeLedgerSettlement: async () => ({ ok: true, records: [] }),
    settlementProbeKey: () => 'probe-key',
  },
})
mock.module('@/lib/connectors/quickbooks/invoices', {
  namedExports: {
    pushSalesInvoice: async () => ({ success: true, invoiceId: 'QBINV-9', invoiceNumber: 'INV-9' }),
  },
})
mock.module('@/lib/connectors/quickbooks/api', {
  namedExports: {
    qboPost: async () => ({ ok: true, data: {} }),
    qboPostIdempotent: async () => ({ ok: true, data: {} }),
    qboUploadAttachment: async () => ({ ok: true }),
    resolveAccountRef: async () => ({ value: 'qbo-bank-1' }),
  },
})

/** A PENDING SALES_INVOICE whose payload ASKS for a card payment to be registered. */
function pendingSalesInvoice() {
  return syncLogRow({
    id: 'entry-invoice',
    connector: 'quickbooks',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: {
      currency: 'GBP',
      lines: [{ quantity: 1, unitAmount: 120 }],
      _registerPayment: true,
      _paymentMethod: 'card',
      _paymentAmount: 120,
      _paymentDate: '2026-08-20',
    },
    attemptStampingCustodyAt: new Date('2026-08-20T09:00:00.000Z'),
  })
}

function reset(map: Record<string, string> | null) {
  store = createSyncLogStore([pendingSalesInvoice()])
  activity.length = 0
  released.length = 0
  claimed.length = 0
  paymentMap = map
  order.accountingInvoiceId = null
}

async function runQuickBooks() {
  return (await import('@/lib/connectors/quickbooks/sync-processor')).processPendingQuickBooksSync()
}

/** The follow-up rows the post actually created. */
function followUpTypes(): string[] {
  return store.rows.filter((row) => row.id !== 'entry-invoice').map((row) => row.type).sort()
}

function paymentRefusals(): Array<{ description?: string; metadata?: Record<string, unknown> }> {
  return activity.filter((entry) => entry.action === 'quickbooks_payment_skipped')
}

test('[o3d-batch-ret r6] a requested payment with NO account mapping is refused, and the obligation is NOT discharged', async () => {
  // ROUTE: the real `processPendingQuickBooksSync` over a PENDING SALES_INVOICE whose payload asks
  // for a payment, with no payment account map configured. The real receipt fence runs; `released`
  // is populated only by a `releaseFollowUpObligation` call carrying the generation this pass claimed.
  //
  // MUTATION THAT KILLS IT: in lib/connectors/quickbooks/sync-processor.ts, make
  // `decideInvoicePaymentFollowUp`'s configuration arms `return FOLLOW_UPS_ENQUEUED` instead of
  // `refuse(...)` — the shipped defect. The refusal assertions fail, and the marker is released
  // because the fence is handed no prerequisite.
  reset(null)

  await runQuickBooks()

  assert.equal(
    order.accountingInvoiceId, 'QBINV-9',
    'PRECONDITION: the invoice really did post — otherwise nothing below is about the follow-up enqueue',
  )
  assert.deepEqual(
    followUpTypes(), ['INVOICE_PDF'],
    'the PDF still goes out and the PAYMENT does not',
  )

  const refusal = paymentRefusals()
  assert.equal(refusal.length, 1, 'the operator is told once, and told why')
  assert.equal(refusal[0].metadata?.reason, 'payment_account_unmapped')
  assert.match(String(refusal[0].description), /NOTHING WAS QUEUED/)
  assert.match(String(refusal[0].description), /Payment Account Mapping/, 'the remedy is a SETTING, safe to repeat')
  assert.match(
    String(refusal[0].description), /NOTHING re-enqueues them on this connector/,
    'and what becomes of the row AT REST is THIS connector\'s registry declaration, never Xero\'s '
      + '"the next sweep picks it up"',
  )
  assert.match(String(refusal[0].description), /ESCALATE/, 'which on this connector means a human, not a sweep')
  // o3d-batch-ret r7: and the registry half is where the clause ENDS. What happens FIRST is the
  // processor's own retry of the posted parent, which the round-6 text denied — see the two-run
  // test at the foot of this file.
  assert.match(
    String(refusal[0].description), /the main QuickBooks sync processor selects it again/,
    'the nearer recovery — the retry this very refusal schedules — must be named before the registry\'s at-rest fact',
  )

  assert.deepEqual(
    released, [],
    'THE FINDING: the row must go on saying it owes follow-ups. Nothing on this connector re-reads a '
      + 'cleared marker, so releasing it here loses the payment permanently',
  )
})

test('[o3d-batch-ret r6] a map that does not name THIS method is refused too', async () => {
  // The second configuration arm. Both inherited the same success default.
  // MUTATION THAT KILLS IT: revert the `if (!stored)` arm to a bare warning.
  // ROUTE: as above, with `paymentMap` naming an unrelated method.
  reset({ bank_transfer: 'QBO-BANK-9' })

  await runQuickBooks()

  assert.equal(order.accountingInvoiceId, 'QBINV-9', 'PRECONDITION: the invoice really did post')
  assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], 'no payment row was created')
  const refusal = paymentRefusals()
  assert.equal(refusal.length, 1)
  assert.equal(refusal[0].metadata?.reason, 'payment_account_unmapped')
  assert.match(String(refusal[0].description), /no bank account is mapped for method "card" \/ currency "GBP"/)
  assert.deepEqual(released, [], 'the obligation survives this arm as well')
})

test('[o3d-batch-ret r6] with the mapping in place the payment IS enqueued and the obligation clears', async () => {
  // THE CONTROL THAT MAKES THE TWO ABOVE NON-VACUOUS: identical fixture, mapping present, and the
  // release demonstrably happens. Without it "released is empty" could be true of every run.
  //
  // It is a SEPARATE PASS rather than a second run over the same row — and round 6 justified that
  // with a claim that was WRONG (o3d-batch-ret r7, Codex MEDIUM): "on this connector nothing
  // re-drives a retained marker, so there is no later to test". There is a later, and it is this
  // connector's own processor retrying the posted parent. The two-run test at the foot of this file
  // is that later; this one stays a single pass because its job is the CONTROL — that a mapped
  // payment enqueues and discharges in one go, so the retention above is a real difference.
  // ROUTE: one real processor run with the mapping configured.
  reset({ card: 'QBO-BANK-1' })

  await runQuickBooks()

  assert.deepEqual(
    followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'],
    'the payment the refusal withheld is queued once its account is mapped',
  )
  assert.deepEqual(paymentRefusals(), [], 'and nothing is refused')
  assert.deepEqual(
    released, ['entry-invoice'],
    'a pass that queued everything it owed DOES discharge the obligation',
  )
})

/**
 * o3d-batch-ret ROUND 7 (Codex MEDIUM), FINDING 1 — THE ROUND-6 FIX REFUSED A PAYMENT NEVER OWED.
 *
 * `decideInvoicePaymentFollowUp` asked its two CONFIGURATION questions before it asked the MONEY
 * question, so the explicit `!(amount > 0)` verdict sat downstream of a mapping check the
 * no-payment case never needed. lib/connectors/woocommerce/sync/order-import.ts sets
 * `_registerPayment: !!wcOrder.date_paid_gmt && documentTotalsToTheOrder` while
 * `resolveWcInvoicePaymentAmount` returns `undefined` below `gross > 0`, so a £0 order marked paid
 * asks for a payment worth nothing.
 *
 * AND IT IS WORSE ON THIS CONNECTOR THAN ON XERO. A refusal here does not merely retain a marker:
 * `requireFollowUpsEnqueued` throws, `markSyncLogForFollowUpRetry` puts the POSTED parent back to
 * PENDING, and five passes later it comes to rest FAILED — a posted invoice recorded as a failed
 * sync, over a payment that was never owed.
 */
test('[o3d-batch-ret r7] a paid ZERO-TOTAL invoice SETTLES with no mapping configured — it is owed nothing', async () => {
  // ROUTE: the real `processPendingQuickBooksSync` over a PENDING SALES_INVOICE that asks for a
  // payment, with `paymentMap` null — the exact configuration the refusal arms fire on.
  //
  // MUTATION THAT KILLS IT: in lib/connectors/quickbooks/sync-processor.ts, move the
  // `requestedInvoicePaymentAmount` / `!(amount > 0)` pair back BELOW the two mapping checks (the
  // round-6 ordering). `quickbooks_payment_skipped` is written, the obligation is retained, and the
  // posted parent is failed for retry.
  //
  // BOTH INPUT CLASSES are walked: the WooCommerce shape declares NO `_paymentAmount` and the
  // amount is derived from zero-value lines, while an explicit `_paymentAmount: 0` short-circuits
  // that derivation. A reordering that moved only one of them would pass a single-shape test.
  for (const { what, money } of [
    { what: 'the WooCommerce shape: `_registerPayment` with NO `_paymentAmount`', money: { lines: [{ quantity: 1, unitAmount: 0 }] } },
    { what: 'an explicitly declared zero amount', money: { _paymentAmount: 0, lines: [{ quantity: 1, unitAmount: 0 }] } },
  ]) {
    reset(null)
    store = createSyncLogStore([syncLogRow({
      id: 'entry-invoice',
      connector: 'quickbooks',
      type: 'SALES_INVOICE',
      status: 'PENDING',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      payload: {
        currency: 'GBP',
        _registerPayment: true,
        _paymentMethod: 'card',
        _paymentDate: '2026-08-20',
        ...money,
      },
      attemptStampingCustodyAt: new Date('2026-08-20T09:00:00.000Z'),
    })])

    await runQuickBooks()

    assert.equal(
      order.accountingInvoiceId, 'QBINV-9',
      `PRECONDITION (${what}): the invoice really did post`,
    )
    assert.deepEqual(
      paymentRefusals(), [],
      `THE FINDING (${what}): an invoice owing no payment must not be refused for a mapping it never needed`,
    )
    assert.deepEqual(
      followUpTypes(), ['INVOICE_PDF'],
      `and no INVOICE_PAYMENT row is created either (${what})`,
    )
    assert.deepEqual(
      released, ['entry-invoice'],
      `and the obligation is DISCHARGED (${what}) — retaining it strands the row in an inbox that `
        + 'declares nothing will ever re-drive it, over work that does not exist',
    )
    assert.equal(
      store.get('entry-invoice')?.status, 'SYNCED',
      `and the POSTED parent is not failed for retry (${what}) — on this connector the refusal costs `
        + 'the row its SYNCED status, five retries, and finally FAILED',
    )
  }
})

/**
 * o3d-batch-ret ROUND 7 (Codex MEDIUM), FINDING 2 — THE REFUSAL DESCRIBED A RECOVERY THAT IS NOT
 * THIS CALL SITE'S.
 *
 * Round 6 filled the shared producer's `recovery` argument from the REGISTRY at both connectors. On
 * QuickBooks that note says `consumer: 'none'` — nothing re-enqueues the work, READ AND ESCALATE —
 * which is true of a RETAINED MARKER ON A ROW AT REST and false of this refusal. A refusal from
 * `decideInvoicePaymentFollowUp` is thrown by `requireFollowUpsEnqueued` and turned by
 * `markSyncLogForFollowUpRetry` into a PENDING posted parent, which the very next processor pass
 * selects and resumes at the follow-ups through the idempotency short-circuit. The operator was
 * being told to escalate a row that was actively retrying.
 *
 * The round-6 test asserted the asymmetry from the same wrong premise — it used a separate pass
 * with the mapping already present, explaining that "on this connector nothing re-drives a retained
 * marker, so there is no later to test". There is: it is the processor's own retry.
 */
test('[o3d-batch-ret r7] the refusal describes what the SECOND processor pass actually does, and that pass does it', async () => {
  // ROUTE: TWO real `processPendingQuickBooksSync` runs over ONE store, with the mapping corrected
  // between them — the sequence the message now describes. Nothing about the retry is simulated:
  // the row's PENDING/retryCount/externalTransactionId state after run 1 is the real transition, and
  // run 2 selects it by the processor's own query.
  //
  // MUTATION THAT KILLS IT: in lib/connectors/quickbooks/sync-processor.ts, pass
  // `followUpObligationRecoveryNote(QBO_FOLLOW_UP_RECOVERY)` as `recovery` again (the round-6 text).
  // The message assertions fail — the operator is told nothing re-enqueues the payment, while the
  // second half of this test watches the processor do exactly that.
  reset(null)

  await runQuickBooks()

  const refusal = paymentRefusals()
  assert.equal(refusal.length, 1, 'PRECONDITION: run 1 refused')
  const message = String(refusal[0].description)

  // WHAT THE MESSAGE CLAIMS.
  assert.match(
    message, /the main QuickBooks sync processor selects it again/,
    'the recovery clause must name the driver that actually re-attempts this row',
  )
  assert.match(message, /5 attempts in all/, 'and its bound, read from the connector rather than restated')
  assert.match(
    message, /idempotency short-circuit/,
    'and why the retry is safe: the external id sends it back to the follow-ups, not to a second post',
  )
  assert.match(
    message, /Once those 5 attempts are spent the row comes to rest FAILED and still marked/,
    'and the registry half is where the clause ENDS rather than what it says about the retry',
  )
  assert.match(
    message, /NOTHING re-enqueues them on this connector/,
    'that registry half is still this connector\'s declared fact, unchanged and not restated',
  )
  assert.match(message, /ESCALATE/, 'which after the retries are spent means a human')
  assert.doesNotMatch(
    message, /register the (receipt|payment) in \w+ by hand/i,
    'and it still authorises no hand-made payment — the remedy is a SETTING',
  )

  // WHAT THE ROW ACTUALLY IS, which is what makes that claim checkable rather than prose.
  const afterFirst = store.get('entry-invoice')
  assert.equal(afterFirst?.status, 'PENDING', 'the posted parent went back on the queue, not to rest')
  assert.equal(afterFirst?.retryCount, 1, 'having consumed one of the attempts the message names')
  assert.equal(
    afterFirst?.externalTransactionId, 'QBINV-9',
    'keeping the external id the short-circuit reads — without it the retry would post a second invoice',
  )
  // The obligation itself: this fixture models the claim/release protocol rather than the column
  // (see the module mock above), so the observable is that a generation WAS taken and NOT released.
  assert.equal(claimed.length, 1, 'the refusing pass claimed the obligation')
  assert.deepEqual(released, [], 'and discharged nothing — the marker is still the row\'s record of the debt')

  // THE OPERATOR DOES THE ONE THING THE MESSAGE ASKS FOR: a setting.
  paymentMap = { card: 'QBO-BANK-1' }
  activity.length = 0

  await runQuickBooks()

  assert.deepEqual(
    followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'],
    'THE FINDING: the second pass queues the payment by itself. The PDF is not duplicated — a live '
      + 'row already owns that scope — so this is the short-circuit resuming, not a re-post',
  )
  assert.deepEqual(paymentRefusals(), [], 'and nothing is refused the second time')
  assert.deepEqual(
    released, ['entry-invoice'],
    'and only NOW is the obligation discharged, by the pass that queued the work it stood for',
  )
  assert.equal(store.get('entry-invoice')?.status, 'SYNCED', 'the posted parent is settled again')
})
