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
 * THE ORGANISATION BASE CURRENCY (o3d-batch-ret r11, Codex HIGH) — A FIXTURE, BECAUSE IT IS
 * CONFIGURABLE IN PRODUCTION.
 *
 * `Organisation.baseCurrency` is what `getBaseCurrencyCode()` answers, and the absent-`currency`
 * arm of the payload boundary now takes it. Held as the ROW the resolver actually reads rather than
 * as a canned currency string, so the real `resolveBaseCurrencyCode` runs — including its
 * `?? DEFAULT_BASE_CURRENCY` fallback — and so "the read threw" is a state this fixture can express
 * at all. `'throw'` is a database that will not answer, which is the unknown the refusal arm is for.
 */
let organisationRow: { baseCurrency: string } | null | 'throw' = { baseCurrency: 'GBP' }

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
  // o3d-batch-ret r11: the row `getBaseCurrencyCode()` reads. NOT stubbed at the
  // `getBaseCurrencyCode` level — the resolver's own fallback and its failure mode are part of what
  // the refusal arm is about.
  organisation: {
    findFirst: async () => {
      if (organisationRow === 'throw') throw new Error('organisation table unavailable')
      return organisationRow
    },
  },
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
    // KEYED THE WAY THE REAL ONE IS (o3d-batch-ret r11): `method:currency`, then the `method:*`
    // wildcard. A currency-blind stub would have made every assertion about WHICH account the money
    // reached vacuous — which is the whole of this round's finding.
    lookupPaymentAccount: (map: Record<string, string> | null, method: string, currency: string) =>
      map?.[`${method}:${currency}`] ?? map?.[`${method}:*`] ?? null,
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
  organisationRow = { baseCurrency: 'GBP' }
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
  reset({ 'bank_transfer:GBP': 'QBO-BANK-9' })

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
  reset({ 'card:GBP': 'QBO-BANK-1' })

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
  paymentMap = { 'card:GBP': 'QBO-BANK-1' }
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
    reset({ 'card:GBP': 'QBO-BANK-1' })
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
    reset({ 'card:GBP': 'QBO-BANK-1' })
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
    reset({ 'card:GBP': 'QBO-BANK-1' })
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

/**
 * o3d-batch-ret ROUND 10 (Codex HIGH) — THE FLAG THAT GATES THE WHOLE DECISION WAS READ BY
 * TRUTHINESS, AND IT IS THE FIFTH ROUND ON ONE AXIS.
 *
 * Rounds 6–9 each fixed the field Codex had just named: a default meaning success, a resolver
 * merging "unknown" with "nothing owed", a present `null` read as an absent key. The field that
 * decides whether ANY of that runs was never one of them. This connector opened with
 * `if (!payload._registerPayment) return FOLLOW_UPS_ENQUEUED`, so an absent key, a literal `false`,
 * a present `null`, a `0`, an `''` and an explicit `undefined` were ONE answer — nobody asked for a
 * payment, settle — and a truthy malformed value such as the string `'false'` went the other way and
 * ENTERED payment registration.
 *
 * IT IS WORST HERE, for the reason every round in this file gives: the registry declares
 * `consumer: 'none'` for QuickBooks. Nothing re-reads a cleared marker, so a payment discharged over
 * a `null` flag is gone with no record that it was ever owed.
 */
test('[o3d-batch-ret r10] a `_registerPayment` that cannot be READ is refused durably, in BOTH directions', async () => {
  // ROUTE: the real `processPendingQuickBooksSync` over a PENDING SALES_INVOICE, with the mapping
  // CORRECTLY CONFIGURED (`card: QBO-BANK-1`) and a readable amount — so nothing below can be the
  // mapping refusal or the round-8 amount refusal, and the ONLY thing standing between this row and
  // a settlement is the request flag. `released` is populated only by a real
  // `releaseFollowUpObligation` call carrying the generation this pass claimed.
  //
  // MUTATION THAT KILLS IT: in lib/domain/accounting/followup-enqueue-outcome.ts, replace the body
  // of `payloadPaymentRequested` with `return { value: Boolean(payload._registerPayment) }` — the
  // shipped truthiness test. The four FALSY arms then settle (`released` becomes ['entry-invoice'],
  // the refusal count drops to 0 and the parent goes SYNCED) and the two TRUTHY-MALFORMED arms
  // create an INVOICE_PAYMENT row, so `followUpTypes` fails naming the shape.
  //
  // BOTH DIRECTIONS ARE WALKED because truthiness fails both ways and a guard written only against
  // `null` would pass a test that only drove falsy values.
  const flags: Array<{ what: string; flag: Record<string, unknown>; detail: RegExp }> = [
    { what: 'a present null — something wrote nothing into it', flag: { _registerPayment: null }, detail: /`_registerPayment` is null, which is neither `true` nor `false`/ },
    { what: 'a present 0', flag: { _registerPayment: 0 }, detail: /`_registerPayment` is 0, which is neither `true` nor `false`/ },
    { what: 'a present empty string', flag: { _registerPayment: '' }, detail: /`_registerPayment` is the string "", which is neither `true` nor `false`/ },
    { what: 'a key present holding an explicit `undefined` — present, and not absent', flag: { _registerPayment: undefined }, detail: /`_registerPayment` is present and holds `undefined`, which is neither `true` nor `false`/ },
    { what: 'the MALFORMED TRUTHY string "false", which truthiness let INTO payment registration', flag: { _registerPayment: 'false' }, detail: /`_registerPayment` is the string "false", which is neither `true` nor `false`/ },
    { what: 'a present 1 — the other truthy malformed value', flag: { _registerPayment: 1 }, detail: /`_registerPayment` is 1, which is neither `true` nor `false`/ },
  ]
  for (const { what, flag, detail } of flags) {
    reset({ 'card:GBP': 'QBO-BANK-1' })
    store = createSyncLogStore([syncLogRow({
      id: 'entry-invoice',
      connector: 'quickbooks',
      type: 'SALES_INVOICE',
      status: 'PENDING',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      payload: {
        currency: 'GBP',
        _paymentMethod: 'card',
        _paymentAmount: 120,
        _paymentDate: '2026-08-20',
        ...flag,
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
      `no INVOICE_PAYMENT row is created (${what}) — an unreadable request is not a YES either, and `
        + 'registering a receipt on the strength of a corrupt byte settles an invoice nobody asked to settle',
    )

    const refusal = paymentRefusals()
    assert.equal(refusal.length, 1, `the operator is told once, and told why (${what})`)
    assert.equal(
      refusal[0].metadata?.reason, 'payment_payload_unreadable',
      `and it is the CORRUPT-PAYLOAD refusal (${what}), not the mapping one — the mapping is correct here`,
    )
    assert.match(String(refusal[0].description), detail, `the sentence names the field and what it holds (${what})`)
    assert.match(
      String(refusal[0].description), /AN UNREADABLE REQUEST IS NOT A "NO"/,
      `and says which of the three facts this is (${what})`,
    )
    assert.doesNotMatch(
      String(refusal[0].description), /the invoice asked for a payment to be registered/,
      `and does NOT assert the thing it is refusing over (${what}): whether the invoice asked is the `
        + 'very fact that could not be read, so round 8\'s opening clause would be a lie here',
    )
    assert.match(String(refusal[0].description), /ESCALATE/, `the remedy is escalation, not a setting (${what})`)

    assert.deepEqual(
      released, [],
      `THE FINDING (${what}): the row must go on saying it owes follow-ups. Nothing on this connector `
        + 're-reads a cleared marker, so settling over an unreadable flag loses the payment permanently',
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

test('[o3d-batch-ret r10] CONTROL: ABSENT and literal `false` still settle, and literal `true` still resolves the amount', async () => {
  // Without this the test above passes on a build that refuses EVERY payload — which would refuse
  // every invoice IMS raises itself (the ordinary sales path composes payloads with no
  // `_registerPayment` key at all) and is a worse failure than the one being fixed.
  //
  // THREE ARMS, WHICH ARE THE THREE READABLE ANSWERS: absent means the payload does not use the
  // mechanism; a literal `false` is that same statement made explicitly (the WooCommerce importer
  // persists `!!date_paid_gmt && documentTotalsToTheOrder`, so an unpaid order really does write
  // one); and a literal `true` must still reach the amount resolution and queue the payment.
  //
  // ROUTE: one real `processPendingQuickBooksSync` pass per arm, mapping configured so an enqueue
  // is possible and a refusal would be loud.
  // MUTATIONS THAT KILL IT: make `payloadPaymentRequested` refuse on an ABSENT key — arm 1 refuses;
  // drop the `value === false` arm so only `true` is readable — arm 2 refuses; make it answer
  // `{ value: false }` for a literal `true` — arm 3 queues no INVOICE_PAYMENT.
  const readable: Array<{ what: string; flag: Record<string, unknown>; expected: string[]; amount: number | null }> = [
    { what: 'no `_registerPayment` key at all', flag: {}, expected: ['INVOICE_PDF'], amount: null },
    { what: 'a literal `false`', flag: { _registerPayment: false }, expected: ['INVOICE_PDF'], amount: null },
    { what: 'a literal `true`', flag: { _registerPayment: true }, expected: ['INVOICE_PAYMENT', 'INVOICE_PDF'], amount: 120 },
  ]
  for (const { what, flag, expected, amount } of readable) {
    reset({ 'card:GBP': 'QBO-BANK-1' })
    store = createSyncLogStore([syncLogRow({
      id: 'entry-invoice',
      connector: 'quickbooks',
      type: 'SALES_INVOICE',
      status: 'PENDING',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      payload: {
        currency: 'GBP',
        _paymentMethod: 'card',
        _paymentAmount: 120,
        _paymentDate: '2026-08-20',
        ...flag,
      },
      attemptStampingCustodyAt: new Date('2026-08-20T09:00:00.000Z'),
    })])

    await runQuickBooks()

    assert.equal(order.accountingInvoiceId, 'QBINV-9', `PRECONDITION (${what}): the invoice really did post`)
    assert.deepEqual(paymentRefusals(), [], `a flag that CAN be read is not refused (${what})`)
    assert.deepEqual(followUpTypes(), expected, `and the follow-ups are the ones the flag calls for (${what})`)
    if (amount !== null) {
      const payment = store.rows.find((row) => row.type === 'INVOICE_PAYMENT')
      assert.equal(
        (payment?.payload as { amount?: unknown } | undefined)?.amount, amount,
        `a literal true still resolves the amount exactly as before (${what}) — the classifier gates `
          + 'the decision, it does not change what a readable request does with it',
      )
    }
    assert.deepEqual(released, ['entry-invoice'], `and the obligation IS discharged (${what})`)
    assert.equal(store.get('entry-invoice')?.status, 'SYNCED', `and the posted parent is not failed for retry (${what})`)
  }
})

/**
 * o3d-batch-ret ROUND 10 — AND THE THREE FIELDS BESIDE THE FLAG, WHICH NOBODY HAD LOOKED AT.
 *
 * Codex asked for the BOUNDARY rather than the field, and the enumeration found three more reads
 * with the same shape: `payload._paymentMethod as string || ''`, `payload.currency as string ||
 * 'GBP'` and `(payload._paymentDate as string)?.slice(0, 10) || <today>`. Each conflated an absent
 * key with a present value nothing could read, and two of them are worse than a lost obligation:
 *
 *   • a present unreadable `currency` became `GBP`, and `lookupPaymentAccount` keys the BANK ACCOUNT
 *     on it — so the money is registered into the sterling account and written onto the row as
 *     sterling, which is a wrong settlement rather than a missing one;
 *   • a present non-string `_paymentDate` did not default at all, it raised
 *     `TypeError: .slice is not a function` out of an invoice that had ALREADY POSTED.
 */
test('[o3d-batch-ret r10] every OTHER field this path reads is refused when present and unreadable', async () => {
  // ROUTE: the real `processPendingQuickBooksSync`, mapping CORRECTLY CONFIGURED and
  // `_paymentAmount: 120` readable — so the amount and the mapping are both fine and the only thing
  // refusing is the field under test.
  //
  //
  // MUTATION THAT KILLS IT: in lib/domain/accounting/followup-enqueue-outcome.ts, give the three
  // field classifiers the semantics the connectors used to have inline — `payloadPaymentMethod`
  // returning `{ value: payload._paymentMethod as string || '' }`, `payloadPaymentCurrency`
  // returning `{ value: payload.currency as string || BASE_PAYMENT_CURRENCY }` and
  // `payloadPaymentDate` returning `{ value: (payload._paymentDate as string)?.slice(0, 10) || new
  // Date().toISOString().slice(0, 10) }`. The null-currency, empty-currency and null-date arms then
  // queue an INVOICE_PAYMENT against the sterling account, the `'20/08/2026'` arm queues one dated
  // "20/08/2026", the null-method arms fall through to the MAPPING refusal instead of the payload
  // one, and the numeric-date arm throws. Every arm fails on `followUpTypes`, on the refusal count
  // or on the reason code.
  //
  // NOT "restore the reads in the connector" — verified, and it kills nothing. The classifier
  // refuses before `onAmount` is ever entered, so a connector-side read of an unreadable field is
  // unreachable code. That the reads must not come back is a SOURCE fact, and
  // followup-enqueue-resolver-door.test.ts is what asserts it.
  const fields: Array<{ what: string; field: Record<string, unknown>; detail: RegExp }> = [
    { what: 'a present `_paymentMethod` holding null', field: { _paymentMethod: null }, detail: /`_paymentMethod` is null, which is not a payment-method string/ },
    { what: 'a `_paymentMethod` that is not a string at all', field: { _paymentMethod: 7 }, detail: /`_paymentMethod` is 7, which is not a payment-method string/ },
    { what: 'a present `currency` holding null — the arm that used to settle into the STERLING account', field: { currency: null }, detail: /`currency` is null, which is not a currency code/ },
    { what: 'a present `currency` holding an empty string', field: { currency: '' }, detail: /`currency` is the string "", which is not a currency code/ },
    { what: 'a present `_paymentDate` holding null', field: { _paymentDate: null }, detail: /`_paymentDate` is null, which is not a date string/ },
    { what: 'a `_paymentDate` that is a NUMBER — the arm that used to throw a TypeError after the post', field: { _paymentDate: 20260820 }, detail: /`_paymentDate` is 20260820, which is not a date string/ },
    { what: 'a `_paymentDate` string that is not a ledger date', field: { _paymentDate: '20/08/2026' }, detail: /`_paymentDate` is the string "20\/08\/2026", whose first ten characters are not a YYYY-MM-DD date/ },
  ]
  for (const { what, field, detail } of fields) {
    reset({ 'card:GBP': 'QBO-BANK-1' })
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
        _paymentAmount: 120,
        _paymentDate: '2026-08-20',
        ...field,
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
      `no INVOICE_PAYMENT row is created (${what}) — a payment registered against a value the payload `
        + 'does not state is a WRONG settlement, which is worse than a withheld one',
    )

    const refusal = paymentRefusals()
    assert.equal(refusal.length, 1, `the operator is told once, and told why (${what})`)
    assert.equal(
      refusal[0].metadata?.reason, 'payment_payload_unreadable',
      `and it is the CORRUPT-PAYLOAD refusal (${what}), not the mapping one`,
    )
    assert.match(String(refusal[0].description), detail, `the sentence names the field and what it holds (${what})`)
    assert.match(
      String(refusal[0].description), /AN UNREADABLE FIELD IS NOT ITS DEFAULT/,
      `and says which of the three facts this is (${what}) — the amount read perfectly well here`,
    )

    assert.deepEqual(released, [], `THE FINDING (${what}): the obligation is NOT discharged`)
    assert.equal(
      claimed.length, 1,
      `PRECONDITION (${what}): a generation WAS claimed, so "released is empty" is a WITHHELD release`,
    )
    assert.equal(store.get('entry-invoice')?.status, 'PENDING', `and the posted parent is failed for retry (${what})`)
  }
})

test('[o3d-batch-ret r10] CONTROL: an ABSENT method, currency or date still takes its documented default', async () => {
  // Without this, the test above passes on a build that refuses every payload that omits an optional
  // field — and the WooCommerce importer writes `wcOrder.payment_method || undefined` and
  // `wcOrder.date_paid_gmt || undefined`, which JSON DROPS, so absence is the ordinary case and
  // refusing it would refuse real orders.
  //
  // EACH ARM PROVES THE DEFAULT WAS TAKEN, not merely that nothing refused:
  //   • an absent `_paymentMethod` resolves to `''`, so the row reaches the MAPPING refusal naming an
  //     empty method — readable, and a different refusal from the payload one;
  //   • an absent `_paymentDate` is registered as today, read off the queued row.
  //
  // `currency` USED TO BE THE THIRD ARM HERE and is not any more (o3d-batch-ret r12): it no longer
  // HAS a default to take, because the value it would have taken — the IMS base currency — is only
  // equal to the currency the ledger denominated the document in on bindings whose connect-time
  // guard could read the remote base, and nothing records which those are. Its absence arm is now a
  // refusal, walked by the two r12 tests at the foot of this file. It is called out rather than
  // silently dropped so that a reader of this table does not conclude the field was forgotten.
  //
  // MUTATION THAT KILLS IT: make `payloadPaymentMethod` or `payloadPaymentDate` answer
  // `unreadableField(...)` for an ABSENT key — each arm then produces a
  // `payment_payload_unreadable` refusal instead of the outcome asserted here.
  const today = new Date().toISOString().slice(0, 10)
  const absences: Array<{ what: string; drop: string; expected: string[]; assertRow: Record<string, string> | null }> = [
    {
      what: 'no `_paymentMethod` key at all',
      drop: '_paymentMethod',
      expected: ['INVOICE_PDF'],
      assertRow: null,
    },
    {
      what: 'no `_paymentDate` key at all',
      drop: '_paymentDate',
      expected: ['INVOICE_PAYMENT', 'INVOICE_PDF'],
      assertRow: { paymentDate: today },
    },
  ]
  for (const { what, drop, expected, assertRow } of absences) {
    reset({ 'card:GBP': 'QBO-BANK-1' })
    const payload: Record<string, unknown> = {
      currency: 'GBP',
      _registerPayment: true,
      _paymentMethod: 'card',
      _paymentAmount: 120,
      _paymentDate: '2026-08-20',
    }
    delete payload[drop]
    assert.ok(!Object.hasOwn(payload, drop), `PRECONDITION (${what}): the key really is absent, not merely undefined`)
    store = createSyncLogStore([syncLogRow({
      id: 'entry-invoice',
      connector: 'quickbooks',
      type: 'SALES_INVOICE',
      status: 'PENDING',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      payload,
      attemptStampingCustodyAt: new Date('2026-08-20T09:00:00.000Z'),
    })])

    await runQuickBooks()

    assert.equal(order.accountingInvoiceId, 'QBINV-9', `PRECONDITION (${what}): the invoice really did post`)
    assert.deepEqual(followUpTypes(), expected, `the follow-ups are the ones the default calls for (${what})`)
    const refusal = paymentRefusals()
    for (const entry of refusal) {
      assert.notEqual(
        entry.metadata?.reason, 'payment_payload_unreadable',
        `an ABSENT key is never the corrupt-payload refusal (${what}) — absence is a legitimate `
          + 'instruction to take the default, which is the whole distinction rounds 9 and 10 rest on',
      )
    }
    if (assertRow === null) {
      assert.equal(refusal.length, 1, `the absent method reaches the MAPPING refusal instead (${what})`)
      assert.equal(refusal[0].metadata?.reason, 'payment_account_unmapped', `and it is that one (${what})`)
      assert.match(
        String(refusal[0].description), /no bank account is mapped for method "" \/ currency "GBP"/,
        `naming the empty method it really resolved to (${what})`,
      )
    } else {
      assert.deepEqual(refusal, [], `nothing is refused (${what})`)
      const row = (store.rows.find((r) => r.type === 'INVOICE_PAYMENT')?.payload ?? {}) as Record<string, unknown>
      for (const [key, value] of Object.entries(assertRow)) {
        assert.equal(row[key], value, `the default really was written onto the queued row (${what})`)
      }
      assert.deepEqual(released, ['entry-invoice'], `and the obligation IS discharged (${what})`)
    }
  }
})

/**
 * o3d-batch-ret ROUND 12 (Codex HIGH), THE QUICKBOOKS HALF — THE EQUALITY ROUND 11 SPENT WAS
 * ASSERTED, NOT ESTABLISHED.
 *
 * Round 11 replaced the absent-`currency` `GBP` literal with the IMS base currency and called the
 * default ESTABLISHED, on this warrant: the document is denominated by the ledger in the ledger's
 * own base currency, and `connectQuickBooks` refuses to bind a ledger whose base currency is not
 * `getBaseCurrencyCode()`, so the two are the same value.
 *
 * THE GUARD REFUSES ONLY WHAT IT CAN READ. Its clause is a truthy-only comparison, and the reader
 * beside it answers `null` for a base currency it could not obtain — a non-OK response, a body with
 * no organisation in it, a base-currency field that is not a currency string. On that path there is
 * nothing to compare, the guard does not fire, and the binding is stored anyway. A transient failure
 * at the moment an operator clicks Connect is enough to bind a USD ledger to a EUR installation, and
 * NOTHING RECORDS which bindings were verified and which were not.
 *
 * SO THE DEFAULT IS WITHDRAWN. An absent `currency` on a payload that asks for a payment refuses,
 * under the `base-currency` fact — the same arm an unresolvable base currency already took. It costs
 * nothing today: the only writer of `_registerPayment` is the WooCommerce order importer, and it
 * writes `currency` unconditionally on the same payload literal.
 *
 * ALL THREE BASES ARE WALKED, AND THE GBP ONE IS THE POINT. A fix written as "refuse when the base
 * currency is not sterling" would pass a EUR-only table and leave the actual defect — an unverified
 * binding — untouched on the installation where it is hardest to see.
 */
test('[o3d-batch-ret r12] an ABSENT currency REFUSES whatever the IMS base currency is, because neither says what the LEDGER posted in', async () => {
  // ROUTE: the real `processPendingQuickBooksSync` over a PENDING SALES_INVOICE whose payload has NO `currency` key, with the
  // real `resolveBaseCurrencyCode` reading the `organisationRow` fixture and the real
  // `lookupPaymentAccount` keyed on `method:currency`. The observable is that no INVOICE_PAYMENT row
  // is queued at all and the operator gets the base-currency clause.
  //
  // MUTATION THAT KILLS IT (1): in `payloadPaymentCurrency`, restore round 10's literal —
  // `if (!declaresField(payload, 'currency')) return { value: 'GBP' }`. Every arm then queues a
  // payment into the sterling account instead of refusing, and all three `followUpTypes` assertions
  // fail.
  //
  // MUTATION THAT KILLS IT (2), the one the GBP arm exists for: restore round 11 exactly — resolve
  // `getBaseCurrencyCode()` in the fold and return it from the absent arm. Arms 1 and 2 then queue a
  // payment (EUR into QBO-BANK-EUR, GBP into QBO-BANK-GBP) and arm 3 raises the MAPPING refusal
  // rather than this one. Arm 2 is the one a "only a non-GBP base is dangerous" fix leaves alive.
  const cases: Array<{ what: string; base: string; map: Record<string, string> }> = [
    {
      what: 'a EUR-base installation with BOTH currencies mapped — where round 11 settled in EUR',
      base: 'EUR',
      map: { 'card:EUR': 'QBO-BANK-EUR', 'card:GBP': 'QBO-BANK-GBP' },
    },
    {
      what: 'a GBP-base installation with both mapped — where round 11 settled in GBP, and where a '
        + 'fix conditioned on a non-sterling base would still settle',
      base: 'GBP',
      map: { 'card:EUR': 'QBO-BANK-EUR', 'card:GBP': 'QBO-BANK-GBP' },
    },
    {
      what: 'a EUR-base installation with ONLY the sterling account mapped — where round 11 refused, '
        + 'but under the MAPPING reason, which tells an operator to add a mapping that would not help',
      base: 'EUR',
      map: { 'card:GBP': 'QBO-BANK-GBP' },
    },
  ]
  for (const { what, base, map } of cases) {
    reset(map)
    organisationRow = { baseCurrency: base }
    const payload: Record<string, unknown> = {
      _registerPayment: true,
      _paymentMethod: 'card',
      _paymentAmount: 120,
      _paymentDate: '2026-08-20',
    }
    assert.ok(
      !Object.hasOwn(payload, 'currency'),
      `PRECONDITION (${what}): the payload really states NO currency — the arm under test is absence, `
        + 'not a present unreadable value, which round 10 already refuses',
    )
    store = createSyncLogStore([syncLogRow({
      id: 'entry-invoice',
      connector: 'quickbooks',
      type: 'SALES_INVOICE',
      status: 'PENDING',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      payload,
      attemptStampingCustodyAt: new Date('2026-08-20T09:00:00.000Z'),
    })])

    await runQuickBooks()

    assert.equal(
      order.accountingInvoiceId, 'QBINV-9',
      `PRECONDITION (${what}): the invoice really did post — the DOCUMENT is there, and nothing `
        + 'below is about the payment unless the invoice it settles exists',
    )

    assert.deepEqual(
      followUpTypes(), ['INVOICE_PDF'],
      `no INVOICE_PAYMENT row is created (${what}) — a bank account chosen by a currency nobody `
        + 'verified is a wrong settlement, not a missing one',
    )
    const refusals = paymentRefusals()
    assert.equal(refusals.length, 1, `the operator is told once (${what})`)
    assert.equal(
      refusals[0].metadata?.reason, 'payment_payload_unreadable',
      `and it is the unreadable refusal (${what}) — NOT the mapping one, which would send an `
        + 'operator to add a bank account mapping that cannot fix an unverified binding',
    )
    assert.match(
      String(refusals[0].description), /AN UNVERIFIED LEDGER BASE CURRENCY IS NOT THE IMS ONE/,
      `and it is the BASE-CURRENCY clause (${what})`,
    )
    assert.match(
      String(refusals[0].description), /never read back from the ledger/,
      `naming what was not established (${what}) — the LEDGER's base currency, not the IMS one`,
    )
    assert.doesNotMatch(
      String(refusals[0].description), /AN UNREADABLE FIELD IS NOT ITS DEFAULT/,
      `the field clause must NOT be borrowed for it (${what}) — omitting \`currency\` is the ordinary `
        + 'case, and that clause blames the payload',
    )
    assert.equal(
      refusals[0].metadata?.currency, null,
      `and the log names NO currency (${what}): there is no currency to name, and printing the IMS `
        + 'base here would put the unverified value back into the record it was removed from',
    )
    assert.deepEqual(released, [], `THE FINDING (${what}): the obligation survives`)
    assert.equal(
      claimed.length, 1,
      `PRECONDITION (${what}): a generation WAS claimed, so an empty \`released\` is a WITHHELD release`,
    )
  }
})

/**
 * o3d-batch-ret ROUND 12 — AND THE REFUSAL IS INDEPENDENT OF THE IMS BASE CURRENCY, WHICH IS THE
 * WHOLE CLAIM.
 *
 * Round 11's refusal arm fired when `getBaseCurrencyCode()` would not RESOLVE — a read that threw, a
 * blank `baseCurrency`. Round 12 removed the read entirely, so the interesting property is no longer
 * "an unresolvable base refuses" but "the answer does not depend on that value at all". The three
 * refusing arms below put the organisation row into three states that round 11 distinguished
 * sharply — unreadable, EUR, blank — and require the operator to receive THE SAME SENTENCE from all
 * three. Byte-for-byte equality is the assertion: a build that leaked the IMS base into the message,
 * or that branched on it, cannot produce three identical strings.
 *
 * THE FOURTH ARM IS WHAT KEEPS THE OTHER THREE HONEST. A payload that names its own currency must
 * settle normally even while the organisation read is broken. Without it, "refuse the absent arm"
 * could have been implemented as "refuse every payment", which on this driver would stall the whole
 * candidate set over a transient database error.
 */
test('[o3d-batch-ret r12] the absent-currency refusal does not consult the IMS base currency — same sentence from three organisation rows, and a stated currency still settles', async () => {
  // ROUTE: as above, with the `organisation.findFirst` fixture set to throw, to a EUR row, and to a
  // row holding a blank `baseCurrency`. BOTH bank accounts are mapped throughout, so a build that
  // took a base currency would SETTLE rather than refuse and be caught by the refusal count.
  //
  // MUTATION THAT KILLS IT: restore round 11's `resolveBasePaymentCurrency` and inject it into
  // `payloadPaymentCurrency`'s absent arm. Arm 2 (a readable EUR row) then queues a payment into
  // QBO-BANK-EUR — its refusal-count assertion fails — and arms 1 and 3 refuse with the
  // organisation-read detail, so the three descriptions are no longer equal either. Arm 4 is
  // untouched by that mutation, which is what makes it the control rather than a fourth case.
  const cases: Array<{ what: string; row: { baseCurrency: string } | null | 'throw'; currency?: string }> = [
    { what: 'the organisation row cannot be read at all', row: 'throw' },
    { what: 'the organisation row reads perfectly and says EUR', row: { baseCurrency: 'EUR' } },
    { what: 'the organisation row holds a blank base currency', row: { baseCurrency: '   ' } },
    { what: 'CONTROL: the same broken read, but the payload NAMES its own currency', row: 'throw', currency: 'GBP' },
  ]
  const sentences: string[] = []
  for (const { what, row, currency } of cases) {
    reset({ 'card:EUR': 'QBO-BANK-EUR', 'card:GBP': 'QBO-BANK-GBP' })
    organisationRow = row
    const payload: Record<string, unknown> = {
      _registerPayment: true,
      _paymentMethod: 'card',
      _paymentAmount: 120,
      _paymentDate: '2026-08-20',
      ...(currency === undefined ? {} : { currency }),
    }
    store = createSyncLogStore([syncLogRow({
      id: 'entry-invoice',
      connector: 'quickbooks',
      type: 'SALES_INVOICE',
      status: 'PENDING',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      payload,
      attemptStampingCustodyAt: new Date('2026-08-20T09:00:00.000Z'),
    })])

    await runQuickBooks()

    assert.equal(
      order.accountingInvoiceId, 'QBINV-9',
      `PRECONDITION (${what}): the invoice really did post — the DOCUMENT is there, and nothing `
        + 'below is about the payment unless the invoice it settles exists',
    )

    if (currency !== undefined) {
      assert.deepEqual(
        paymentRefusals(), [],
        `THE CONTROL (${what}): a payload that states its currency asks nothing about the ledger's `
          + 'base, so a broken organisation read must not touch it',
      )
      assert.deepEqual(followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'], `and the payment IS queued (${what})`)
      const queued = (store.rows.find((r) => r.type === 'INVOICE_PAYMENT')?.payload ?? {}) as Record<string, unknown>
      assert.equal(queued.currency, 'GBP', `in the currency the payload named (${what})`)
      assert.equal(queued.bankAccountId, 'QBO-BANK-GBP', `and in that currency's account (${what})`)
    assert.deepEqual(released, ['entry-invoice'], `and the obligation IS discharged (${what})`)
      continue
    }

    assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], `no INVOICE_PAYMENT row is created (${what})`)
    const refusals = paymentRefusals()
    assert.equal(
      refusals.length, 1,
      `the operator is told once (${what}) — and a build that took a base currency here would have `
        + 'SETTLED instead, because both accounts are mapped',
    )
    assert.equal(refusals[0].metadata?.reason, 'payment_payload_unreadable', `under the unreadable reason (${what})`)
    sentences.push(String(refusals[0].description))
    assert.deepEqual(released, [], `THE FINDING (${what}): the obligation survives`)
  }

  assert.equal(sentences.length, 3, 'PRECONDITION: all three refusing arms really produced a sentence')
  assert.equal(
    new Set(sentences).size, 1,
    'THE CLAIM: the operator receives the SAME sentence whether the IMS base currency reads as EUR, '
      + 'reads as blank, or will not read at all. Three different sentences would mean the decision '
      + `still depends on a value that says nothing about the ledger — got ${JSON.stringify([...new Set(sentences)])}`,
  )
})
