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
  // `decideRequestedInvoicePayment` call back BELOW the two mapping checks (the
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

/**
 * o3d-batch-ret ROUND 8 (Codex HIGH) — AND ROUND 7'S RESOLVER READ "UNKNOWN" AS "NOTHING OWED".
 *
 * The fix above put the money question first. What it returned was `number | undefined`, and this
 * connector read it as `if (amount === undefined || !(amount > 0)) return FOLLOW_UPS_ENQUEUED` —
 * so a declaration that could not be parsed, an absent `lines`, a `lines` that is not an array, a
 * line with no readable quantity and a derived total that overflowed ALL produced the one value
 * that settles. The row was marked SYNCED, the fence was handed no prerequisite and cleared the
 * obligation generation, and on THIS connector the registry declares `consumer: 'none'` — nothing
 * re-reads a cleared marker, so a payment that was really taken is gone with no record that it was
 * ever owed.
 *
 * ABSENCE IS NOT A NEGATIVE ANSWER. The module-private resolver answers `none | amount | invalid`,
 * `decideRequestedInvoicePayment` settles only `none`, and the `invalid` handler is typed to return
 * a REFUSED outcome — so this connector cannot settle an unreadable payload even by accident.
 */
test('[o3d-batch-ret r8] a payment amount that cannot be READ is refused on every route, and the obligation is NOT discharged', async () => {
  // ROUTE: the real `processPendingQuickBooksSync` over a PENDING SALES_INVOICE whose payload asks
  // for a payment, with the mapping CORRECTLY CONFIGURED — so nothing here can be mistaken for the
  // mapping refusal, and the only thing standing between the row and a settlement is the amount
  // being unreadable. `released` is populated only by a `releaseFollowUpObligation` call carrying
  // the generation this pass claimed.
  //
  // MUTATION THAT KILLS IT: in lib/domain/accounting/followup-enqueue-outcome.ts, make
  // `unreadableAmount()` return `NOTHING_OWED` — i.e. restore round 7's `undefined`, which both
  // connectors read as "nothing to move". Every arm below then queues no payment, refuses nothing,
  // and DISCHARGES the obligation: `released` becomes ['entry-invoice'] and the refusal assertions
  // fail naming the shape.
  //
  // EVERY ROUTE INTO `invalid` IS WALKED, because they are five different branches of the resolver
  // and a fix that only guarded the one Codex named would pass a single-shape test.
  for (const { what, money, detail } of [
    {
      what: 'no `lines` key at all — the shape round 7 turned from a TypeError into an empty array',
      money: {},
      detail: /declares no `_paymentAmount` and its `lines` is absent rather than an array/,
    },
    {
      what: 'a `lines` that is not an array',
      money: { lines: { quantity: 1, unitAmount: 120 } },
      detail: /its `lines` is an object rather than an array/,
    },
    {
      what: 'a declared `_paymentAmount` that is not a number',
      money: { _paymentAmount: 'one hundred and twenty', lines: [{ quantity: 1, unitAmount: 120 }] },
      detail: /`_paymentAmount` is the string "one hundred and twenty", which is not a finite amount/,
    },
    {
      what: 'a line whose quantity cannot be read',
      money: { lines: [{ unitAmount: 120 }] },
      detail: /`lines\[0\]\.quantity` is absent, which is not a finite number/,
    },
    {
      what: 'a derived total that is not finite',
      money: { lines: [{ quantity: 1e308, unitAmount: 10 }] },
      detail: /the amount derived from the payload lines is not a finite number/,
    },
  ]) {
    reset({ card: 'QBO-BANK-1' })
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
      `PRECONDITION (${what}): the invoice really did post — otherwise nothing below is about the enqueue`,
    )
    assert.deepEqual(
      followUpTypes(), ['INVOICE_PDF'],
      `no INVOICE_PAYMENT row is created (${what}) — the amount to put on it is not known`,
    )

    const refusal = paymentRefusals()
    assert.equal(refusal.length, 1, `the operator is told once, and told why (${what})`)
    assert.equal(
      refusal[0].metadata?.reason, 'payment_payload_unreadable',
      `and it is NOT reported as the mapping refusal (${what}) — the mapping here is correct, and `
        + 'sending an operator to a bank-account screen over a corrupt payload is a false remedy',
    )
    assert.match(String(refusal[0].description), detail, `the sentence names what could not be read (${what})`)
    assert.match(
      String(refusal[0].description), /AN UNREADABLE AMOUNT IS NOT A ZERO/,
      `and says which fact this is (${what})`,
    )
    assert.match(
      String(refusal[0].description), /no further attempt at this row can repair it/,
      `and does not promise a retry that cannot help (${what}) — the payload is at rest`,
    )
    assert.match(String(refusal[0].description), /ESCALATE/, `the remedy is escalation, not a setting (${what})`)

    assert.deepEqual(
      released, [],
      `THE FINDING (${what}): the row must go on saying it owes follow-ups. Nothing on this connector `
        + 're-reads a cleared marker, so settling an unknown amount loses the payment permanently',
    )
    assert.equal(
      claimed.length, 1,
      `PRECONDITION (${what}): a generation WAS claimed, so "released is empty" is a withheld release `
        + 'rather than a pass that never had anything to release',
    )
    assert.equal(
      store.get('entry-invoice')?.status, 'PENDING',
      `and the posted parent is failed for retry (${what}) — which is the VISIBLE state this refusal `
        + 'buys: five passes later it comes to rest FAILED and still marked, in the exception inbox, '
        + 'instead of SYNCED and settled with nobody the wiser',
    )
  }
})

test('[o3d-batch-ret r8] CONTROL: a DECLARED zero still settles, with no `lines` to derive from at all', async () => {
  // Without this the test above could pass on a build that refuses every payload — which is the
  // round-7 regression (a paid £0 order refused for a bank account it would never use), not its fix.
  //
  // It is also the sharpest statement of the rule: the SAME payload shape that is refused above for
  // having no `lines` SETTLES here, because a readable `_paymentAmount` is final and the derivation
  // is never reached. "No lines" is unreadable only when the amount has to be derived from them.
  //
  // ROUTE: one real `processPendingQuickBooksSync` pass, mapping deliberately absent so a refusal
  // of any kind would be loud.
  // MUTATION THAT KILLS IT: make `readableAmount()` treat a non-positive amount as `invalid` — the
  // over-correction. This fails on the refusal count and on the discharge.
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
      _paymentAmount: 0,
    },
    attemptStampingCustodyAt: new Date('2026-08-20T09:00:00.000Z'),
  })])

  await runQuickBooks()

  assert.equal(order.accountingInvoiceId, 'QBINV-9', 'PRECONDITION: the invoice really did post')
  assert.deepEqual(paymentRefusals(), [], 'an invoice that says it owes nothing is not refused')
  assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], 'and no INVOICE_PAYMENT row is created')
  assert.deepEqual(released, ['entry-invoice'], 'and the obligation IS discharged')
  assert.equal(store.get('entry-invoice')?.status, 'SYNCED', 'and the posted parent is not failed for retry')
})

/**
 * o3d-batch-ret ROUND 9 (Codex HIGH) — A PRESENT `null` IS NOT AN ABSENT FIELD, ON THIS CONNECTOR TOO.
 *
 * Round 8 gave the shared resolver an `invalid` arm for a value it cannot read, and then went on
 * using `x === undefined || x === null` to decide whether the payload USES a field at all. So the
 * shape that most needs the new arm — a key that is present holding a null, because something wrote
 * nothing into it — took the ABSENT path: `{_paymentAmount: null, lines: []}` derived a zero and
 * SETTLED, and a null `shippingAmount`/`discountAmount` was spent as a real zero.
 *
 * IT IS WORST HERE. The registry declares `consumer: 'none'` for QuickBooks: nothing re-reads a
 * cleared marker, so a payment discharged over a null is gone with no record it was ever owed.
 */
test('[o3d-batch-ret r9] a PRESENT null is refused on every field that had a default, and the obligation is NOT discharged', async () => {
  // ROUTE: the real `processPendingQuickBooksSync` over a PENDING SALES_INVOICE asking for a
  // payment, with the mapping CORRECTLY CONFIGURED (`card: QBO-BANK-1`) — so nothing below can be
  // the mapping refusal. `released` is populated only by a real `releaseFollowUpObligation` call
  // carrying the generation this pass claimed.
  //
  // MUTATION THAT KILLS IT: in lib/domain/accounting/followup-enqueue-outcome.ts, restore the
  // round-8 presence tests — `if (declared !== null && declared !== undefined)` for
  // `_paymentAmount`, and `payload.shippingAmount === null || payload.shippingAmount === undefined
  // ? 0 : ...` for the two adjustments. The first arm then derives a zero, refuses nothing and
  // RELEASES; the other two spend the null as a zero and enqueue an INVOICE_PAYMENT for the derived
  // 120, releasing as well. Every arm fails on `followUpTypes`, on the refusal count and on
  // `released`.
  //
  // ALL THREE FIELDS ARE WALKED because the shortcut was written out three times.
  for (const { what, money, detail } of [
    {
      what: 'a DECLARED `_paymentAmount` holding null, with an empty `lines` to derive a zero from',
      money: { _paymentAmount: null, lines: [] },
      detail: /`_paymentAmount` is null, which is not a finite amount/,
    },
    {
      what: 'a present `_paymentAmount` holding an explicit `undefined` — present, and not absent',
      money: { _paymentAmount: undefined, lines: [] },
      detail: /`_paymentAmount` is present and holds `undefined`, which is not a finite amount/,
    },
    {
      what: 'a present `shippingAmount` holding null, over lines that DO derive',
      money: { lines: [{ quantity: 1, unitAmount: 120 }], shippingAmount: null },
      detail: /`shippingAmount` is null, which is not a finite number/,
    },
    {
      what: 'a present `discountAmount` holding null, over lines that DO derive',
      money: { lines: [{ quantity: 1, unitAmount: 120 }], discountAmount: null },
      detail: /`discountAmount` is null, which is not a finite number/,
    },
  ]) {
    reset({ card: 'QBO-BANK-1' })
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
      `PRECONDITION (${what}): the invoice really did post — otherwise nothing below is about the enqueue`,
    )
    assert.deepEqual(
      followUpTypes(), ['INVOICE_PDF'],
      `no INVOICE_PAYMENT row is created (${what}) — an amount derived AROUND an unreadable field is `
        + 'not the amount the payload states',
    )

    const refusal = paymentRefusals()
    assert.equal(refusal.length, 1, `the operator is told once, and told why (${what})`)
    assert.equal(
      refusal[0].metadata?.reason, 'payment_payload_unreadable',
      `and it is the CORRUPT-PAYLOAD refusal (${what}), not the mapping one — the mapping is correct here`,
    )
    assert.match(String(refusal[0].description), detail, `the sentence names the field and what it holds (${what})`)
    assert.match(
      String(refusal[0].description), /AN UNREADABLE AMOUNT IS NOT A ZERO/,
      `and says which fact this is (${what})`,
    )

    assert.deepEqual(
      released, [],
      `THE FINDING (${what}): the row must go on saying it owes follow-ups. Nothing on this connector `
        + 're-reads a cleared marker, so settling over a null loses the payment permanently',
    )
    assert.equal(
      claimed.length, 1,
      `PRECONDITION (${what}): a generation WAS claimed, so "released is empty" is a WITHHELD release `
        + 'rather than a pass that never had anything to release',
    )
    assert.equal(
      store.get('entry-invoice')?.status, 'PENDING',
      `and the posted parent is failed for retry (${what}) — the visible state this refusal buys`,
    )
  }
})

test('[o3d-batch-ret r9] CONTROL: ABSENT and READABLE-ZERO fields still take their old paths', async () => {
  // Without this, the test above passes on a build that refuses every payload carrying an optional
  // field at all — which would refuse ordinary invoices (no shipping leg, no discount) and is a
  // worse failure than the one being fixed.
  //
  // THREE ARMS: an ABSENT adjustment is still a real zero and the derivation still runs over it; a
  // PRESENT but READABLE zero is not refused for being present; and a DECLARED readable zero is
  // still FINAL and still settles, even with lines beside it that would have derived 120.
  //
  // ROUTE: one real `processPendingQuickBooksSync` pass per arm, mapping configured.
  // MUTATIONS THAT KILL IT: make `optionalAdjustment` return a `detail` when the key is absent —
  // arms 1 and 2 then refuse; or make `readableAmount` answer `invalid` for a non-positive amount —
  // arm 3 then refuses instead of settling.
  for (const { what, money, expected, amount } of [
    {
      what: 'no `shippingAmount` or `discountAmount` key at all',
      money: { lines: [{ quantity: 2, unitAmount: 60 }] },
      expected: ['INVOICE_PAYMENT', 'INVOICE_PDF'],
      amount: 120,
    },
    {
      what: 'both adjustments present and readably zero',
      money: { lines: [{ quantity: 2, unitAmount: 60 }], shippingAmount: 0, discountAmount: 0 },
      expected: ['INVOICE_PAYMENT', 'INVOICE_PDF'],
      amount: 120,
    },
    {
      what: 'a declared readable ZERO `_paymentAmount`, with lines that would have derived 120',
      money: { _paymentAmount: 0, lines: [{ quantity: 2, unitAmount: 60 }] },
      expected: ['INVOICE_PDF'],
      amount: null,
    },
  ]) {
    reset({ card: 'QBO-BANK-1' })
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

    assert.equal(order.accountingInvoiceId, 'QBINV-9', `PRECONDITION (${what}): the invoice really did post`)
    assert.deepEqual(paymentRefusals(), [], `a payload every field of which CAN be read is not refused (${what})`)
    assert.deepEqual(followUpTypes(), expected, `and the follow-ups are the ones the amount calls for (${what})`)
    if (amount !== null) {
      const payment = store.rows.find((row) => row.type === 'INVOICE_PAYMENT')
      assert.equal(
        (payment?.payload as { amount?: unknown } | undefined)?.amount, amount,
        `the derivation really ran and the absent adjustment really was a ZERO (${what}) — a refusal `
          + 'would have queued nothing, and a wrong default would put a different number on the row',
      )
    }
    assert.deepEqual(released, ['entry-invoice'], `and the obligation IS discharged (${what})`)
    assert.equal(store.get('entry-invoice')?.status, 'SYNCED', `and the posted parent is not failed for retry (${what})`)
  }
})
