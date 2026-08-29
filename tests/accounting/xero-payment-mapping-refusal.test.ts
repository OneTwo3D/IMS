import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-batch-ret ROUND 6 (Codex HIGH) — A REQUESTED PAYMENT THAT COULD NOT BE QUEUED WAS REPORTED AS
 * ENQUEUED, AND THE FENCE CLEARED THE OBLIGATION OVER IT.
 *
 * `enqueueSalesInvoiceFollowUps` initialised `paymentOutcome` to `FOLLOW_UPS_ENQUEUED` and narrowed
 * it only on the arm that actually reached `enqueueFollowUpSyncLog`. The two configuration arms —
 * no payment account map at all, and no account mapped for this method/currency — wrote a WARNING
 * and fell out. So a payload carrying `_registerPayment` could queue NOTHING while the aggregate
 * verdict said `enqueued: true`, `obligationReleasePrerequisite` handed the receipt fence no
 * prerequisite, and the fence released the generation. The row ends SYNCED, linked and marker-null:
 * indistinguishable from one that completed, and no longer a candidate for anything.
 *
 * THIS IS A BEHAVIOURAL INSTRUMENT, NOT A STRUCTURAL ONE. The round-5 guard for the same invariant
 * (`enqueue-verdict-precedes-receipt-fence.test.ts`) judged the connectors by parsing them, and
 * Codex's round-6 MEDIUM is that such a judge has to model scope and hoisting to be sound — it can
 * be satisfied by a shape whose RUNTIME calls the fence first. So the claim is made the only way it
 * cannot be faked: drive the real `repairXeroBackReferences` over a real fixture, with the real
 * `registerDeferredOrderReceipts` and the real claim/release protocol, and read the MARKER COLUMN.
 * A fence that ran before the verdict existed would receive a hoisted `undefined` prerequisite and
 * clear the marker, which is exactly what these assertions catch.
 *
 * THE MARKER IS THE OBSERVABLE, because it is the only thing that distinguishes a row whose payment
 * is still owed from one whose follow-ups all ran: both are SYNCED and both carry the external id.
 */

process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }> = []

/**
 * The payment account map the connector reads — MUTABLE, because the second half of the finding is
 * that repairing it must let the retained generation enqueue and clear LATER. `null` is the
 * "nothing configured at all" arm; an object missing the order's method is the "no account for this
 * method/currency" arm.
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

type OrderRow = { id: string; status: string; accountingInvoiceId: string | null }
let salesOrders: Map<string, OrderRow> = new Map()

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

function selectedKeys(select: Record<string, unknown> | undefined): string[] {
  return Object.keys(select ?? {})
}

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
  salesOrder: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
      const row = salesOrders.get(where.id)
      if (!row) return null
      const projected: Record<string, unknown> = {}
      for (const key of selectedKeys(select)) {
        // The deferred-receipt re-drive selects the order's RECEIPTS as a nested relation. This
        // order has none — which is what puts the re-drive on its `no-receipts` path, the one that
        // discharges through the fence and therefore has to consult the caller's prerequisite.
        projected[key] = key === 'payments' ? [] : (row as unknown as Record<string, unknown>)[key]
      }
      return projected
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = salesOrders.get(where.id)
      if (!row) throw new Error(`no sales order ${where.id}`)
      Object.assign(row, data)
      return row
    },
  },
  // The fenced pass re-reads the receipts under the sales-order lock rather than re-using the
  // snapshot above, so it needs its own answer — still none.
  payment: { findMany: async () => [] },
  salesOrderRefund: { findUnique: async () => null, update: async () => { throw new Error('unused') } },
  purchaseInvoice: { findUnique: async () => null, findFirst: async () => null, update: async () => { throw new Error('unused') } },
  supplierCreditNote: { findUnique: async () => null, update: async () => { throw new Error('unused') } },
  // The sweep's keyset cursor lives in one Setting row; absent means "start at the head", which is
  // what makes the SECOND run below re-read the row the first one deliberately left unsettled.
  setting: { findUnique: async () => null, upsert: async () => ({}) },
  $queryRaw: async () => [],
  $executeRaw: async () => 1,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbStub),
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    logActivityPersisted: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
      return true
    },
    logActivityInTransaction: async (_tx: unknown, entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
    redactActivityLogText: (value: string) => value,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    updateMirroredAccountingEventStatus: async () => {},
    voidMirroredAccountingEventsForOrder: async () => {},
  },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: {
    scheduleXeroAccountingOutbox: async () => ({}),
    parseXeroAccountingOutboxPayload: (value: unknown) => value,
    XERO_ACCOUNTING_POST_OPERATION: 'post',
    XERO_OUTBOX_CONNECTOR: 'xero-accounting',
  },
})
/**
 * THE VARIABLE UNDER TEST. `lookupPaymentAccount` is the REAL question asked of a real map rather
 * than a canned answer, so "no map at all" and "a map that does not name this method" are two
 * different states of one fixture instead of two different stubs.
 */
mock.module('@/lib/accounting', {
  namedExports: {
    getPaymentAccountMap: async () => paymentMap,
    // KEYED THE WAY THE REAL ONE IS (o3d-batch-ret r11): `method:currency`, then the `method:*`
    // wildcard. A currency-blind stub would have made every assertion about WHICH account the money
    // reached vacuous — which is the whole of this round's finding.
    lookupPaymentAccount: (map: Record<string, string> | null, method: string, currency: string) =>
      map?.[`${method}:${currency}`] ?? map?.[`${method}:*`] ?? null,
    isAccountingSyncTypeEnabled: async () => true,
    // The re-drive asks whether the PINNED connector posts payments at all. `false` would end the
    // call before the fence, so the fixture must say yes or it would prove nothing.
    isAccountingSyncTypeEnabledFor: async () => true,
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }),
    queueAccountingSyncTxWithOutcome: async () => ({ queued: true, connector: 'xero' }),
  },
})
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })
mock.module('@/lib/connectors/xero/auth', { namedExports: { getGrantedScopes: async () => null } })
mock.module('@/lib/connectors/woocommerce/sync/invoice-note', {
  namedExports: { pushInvoiceNoteToWc: async () => ({ success: true }) },
})
// NOTHING about the receipt fence is stubbed. `registerDeferredOrderReceipts`,
// `dischargeDeferredReceiptObligation`, `claimFollowUpObligation` and `releaseFollowUpObligation`
// all run for real — a stub of any of them would put the answer under test into the fixture.

async function loadSweep() {
  return (await import('@/lib/connectors/xero/sync-processor')).repairXeroBackReferences
}

/** An invoice posted for an order that PAID BY CARD — so a payment really is requested. */
const INVOICE_PAYLOAD = {
  invoiceNumber: 'INV-1',
  currency: 'GBP',
  _registerPayment: true,
  _paymentMethod: 'card',
  _paymentAmount: 120,
  _paymentDate: '2026-08-20',
}

/** The sweep's candidate shape: SYNCED, naming a document, on an order that is not linked yet. */
const SALES_CANDIDATE = {
  id: 'log-1',
  connector: 'xero',
  type: 'SALES_INVOICE',
  status: 'SYNCED',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  externalTransactionId: 'XERO-INV-1',
  attemptRevision: 4,
  payload: INVOICE_PAYLOAD,
}

function reset(map: Record<string, string> | null) {
  organisationRow = { baseCurrency: 'GBP' }
  store = createSyncLogStore([syncLogRow(SALES_CANDIDATE)])
  activity.length = 0
  paymentMap = map
  salesOrders = new Map([['order-1', { id: 'order-1', status: 'PROCESSING', accountingInvoiceId: null }]])
}

/** The follow-up rows the sweep actually created. */
function followUpTypes(): string[] {
  return store.rows.filter((row) => row.id !== 'log-1').map((row) => row.type).sort()
}

/** The obligation marker as it stands on the parent row — the whole observable. */
function marker(): Date | null {
  return store.get('log-1')?.backReferenceFollowUpsPendingAt ?? null
}

function paymentRefusals(): Array<{ description: string; metadata?: Record<string, unknown> }> {
  return activity.filter((entry) => entry.action === 'xero_payment_skipped')
}

test('[o3d-batch-ret r6] a requested payment with NO account mapping is refused, and the obligation marker SURVIVES', async () => {
  // ROUTE: the real `repairXeroBackReferences` over a SYNCED SALES_INVOICE whose payload asks for a
  // payment, with the payment account map empty. The real receipt fence runs and the real
  // `releaseFollowUpObligation` is the only thing that can clear the marker column read below.
  //
  // MUTATION THAT KILLS IT: in lib/connectors/xero/sync-processor.ts, make
  // `decideInvoicePaymentFollowUp`'s two configuration arms `return FOLLOW_UPS_ENQUEUED` instead of
  // `refuse(...)` — i.e. restore the shipped defect. The refusal assertions fail, and so does the
  // marker assertion, because the fence is then handed no prerequisite and releases the generation.
  reset(null)

  await (await loadSweep())()

  assert.equal(
    salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
    'PRECONDITION: the repair really ran and linked the order — otherwise nothing below is about the enqueue',
  )
  assert.deepEqual(
    followUpTypes(), ['INVOICE_PDF'],
    'the PDF still goes out — a refused payment is no reason to withhold separate work — and the PAYMENT does not',
  )

  const refusal = paymentRefusals()
  assert.equal(refusal.length, 1, 'the operator is told once, and told why')
  assert.equal(refusal[0].metadata?.reason, 'payment_account_unmapped', 'and the machine key names the refusal')
  assert.match(refusal[0].description, /NOTHING WAS QUEUED/)
  assert.match(refusal[0].description, /Payment Account Mapping/, 'the remedy is a SETTING, which is safe to repeat')
  assert.match(
    refusal[0].description, /a later sweep re-reads the marker/,
    'and what happens next is read off the connector registry, not promised here',
  )

  assert.notEqual(
    marker(), null,
    'THE FINDING: the row must still say it owes follow-ups. A cleared marker here is a payment that '
      + 'was requested, never queued, and can never be recovered — on a row that looks reconciled',
  )
  assert.equal(store.get('log-1')?.backReferenceCheckedAt, null, 'and it is left in the sweep candidate set')
})

test('[o3d-batch-ret r6] the same row with a map that does not name THIS method is refused too', async () => {
  // The second configuration arm, which the first test cannot reach: a map exists, and
  // `lookupPaymentAccount` finds nothing for card/GBP. Both arms inherited the same success default.
  //
  // MUTATION THAT KILLS IT: change the `if (!stored)` arm back to a bare `logActivity` warning.
  // ROUTE: as above, with `paymentMap` holding an unrelated method.
  reset({ 'bank_transfer:GBP': 'BANK-9' })

  await (await loadSweep())()

  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1', 'PRECONDITION: the repair ran')
  assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], 'no payment row was created')
  const refusal = paymentRefusals()
  assert.equal(refusal.length, 1)
  assert.equal(refusal[0].metadata?.reason, 'payment_account_unmapped')
  assert.match(refusal[0].description, /no bank account is mapped for method "card" \/ currency "GBP"/)
  assert.notEqual(marker(), null, 'the marker survives this arm as well')
})

test('[o3d-batch-ret r6] repairing the mapping lets the RETAINED generation enqueue and clear on a later run', async () => {
  // THE OTHER HALF OF THE FINDING, and the reason refusing is a deferral rather than a stall: the
  // marker is retained, the row stays a candidate, and the Xero sweep — which the registry declares
  // as this connector's consumer — picks it up once the setting is fixed.
  //
  // MUTATION THAT KILLS IT: make the refusal permanent (e.g. have the sweep stamp
  // `backReferenceCheckedAt` on a refusal), or leave the marker cleared on run 1 — run 2 then finds
  // no candidate and no INVOICE_PAYMENT is ever created.
  // ROUTE: two real sweep runs over one store, with `paymentMap` repaired between them.
  reset(null)

  await (await loadSweep())()
  const deferred = marker()
  assert.notEqual(deferred, null, 'PRECONDITION: run 1 refused and retained the generation')
  assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], 'PRECONDITION: run 1 queued no payment')

  // The operator adds the mapping the refusal named.
  paymentMap = { 'card:GBP': 'BANK-1' }
  activity.length = 0

  await (await loadSweep())()

  assert.deepEqual(
    followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'],
    'the payment the first run refused is enqueued by the run after the mapping exists — and the PDF '
      + 'is not duplicated, because a live row already owns that scope',
  )
  assert.deepEqual(paymentRefusals(), [], 'and nothing is refused the second time')
  assert.equal(
    marker(), null,
    'only NOW is the obligation discharged: the marker is retained until the work it stands for is queued',
  )
})

test('[o3d-batch-ret r6] CONTROL: a mapped payment clears in ONE run, so the retention above is a real difference', async () => {
  // Without this the tests above could be passing because the fixture never clears the marker at
  // all. Same row, same fixture, mapping present from the start.
  // ROUTE: one real sweep run with the mapping already configured.
  reset({ 'card:GBP': 'BANK-1' })

  await (await loadSweep())()

  assert.deepEqual(followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'])
  assert.deepEqual(paymentRefusals(), [])
  assert.equal(marker(), null, 'a pass that queued everything it owed DOES clear the generation')
})

/**
 * AND THE OTHER AXIS OF THE SAME FOLD (o3d-batch-ret r6).
 *
 * `combineFollowUpEnqueueOutcomes` exists because a refusal on EITHER half means the row still owes
 * work. The round-5 structural judge asserted that by reading the connector's source for a
 * prerequisite composed over the aggregate NAME; this asserts it by making the OTHER half refuse and
 * reading the marker. A FAILED INVOICE_PDF row left at attempt revision 0 is the enqueue's
 * `unprobed_unfenced_reuse`: nothing can establish whether that row's effect already happened, and
 * the PDF creates no ledger document to probe. The payment, fully mapped here, enqueues normally.
 */
test('[o3d-batch-ret r6] a refused PDF beside an ENQUEUED payment also keeps the marker', async () => {
  // MUTATION THAT KILLS IT: compose `obligationReleasePrerequisite` over `paymentOutcome` alone
  // instead of the aggregate `enqueueOutcome` — the payment succeeded, so the fence would release
  // while the PDF is still owed.
  // ROUTE: the real sweep, with the payment mapping present and an unfenced FAILED PDF row in scope.
  reset({ 'card:GBP': 'BANK-1' })
  store = createSyncLogStore([
    syncLogRow(SALES_CANDIDATE),
    syncLogRow({
      id: 'pdf-failed',
      connector: 'xero',
      type: 'INVOICE_PDF',
      status: 'FAILED',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      // Revision 0 is the legacy population the attempt fence cannot reason about: the row reached
      // FAILED by RUNNING, so reviving it could repeat an effect nothing can take back.
      attemptRevision: 0,
      payload: { accountingInvoiceId: 'XERO-INV-1', referenceId: 'order-1' },
    }),
  ])

  await (await loadSweep())()

  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1', 'PRECONDITION: the repair ran')
  const refused = activity.filter((entry) => entry.action === 'xero_followup_enqueue_refused')
  assert.equal(refused.length, 1, 'PRECONDITION: the PDF enqueue really did refuse')
  assert.equal(refused[0].metadata?.reason, 'unprobed_unfenced_reuse')
  assert.equal(refused[0].metadata?.type, 'INVOICE_PDF', 'and it is the PDF half that refused, not the payment')
  assert.deepEqual(paymentRefusals(), [], 'PRECONDITION: the payment half was mapped and did NOT refuse')
  assert.ok(
    store.rows.some((row) => row.type === 'INVOICE_PAYMENT'),
    'PRECONDITION: the payment really was enqueued, so this is a mixed verdict rather than two refusals',
  )

  assert.notEqual(marker(), null, 'a refusal on EITHER half keeps the obligation open')
})

/**
 * o3d-batch-ret ROUND 7 (Codex MEDIUM) — THE ROUND-6 FIX REFUSED A PAYMENT THAT WAS NEVER OWED.
 *
 * `decideInvoicePaymentFollowUp` asked its two CONFIGURATION questions before it asked the MONEY
 * question. The explicit `!(amount > 0)` verdict — "nobody is owed anything, and that is a success"
 * — therefore sat downstream of a mapping check the no-payment case never needed.
 *
 * AND THE PRODUCER REACHES IT. lib/connectors/woocommerce/sync/order-import.ts sets
 * `_registerPayment: !!wcOrder.date_paid_gmt && documentTotalsToTheOrder` while
 * `resolveWcInvoicePaymentAmount` returns `undefined` below `gross > 0`. A £0 order marked paid —
 * a fully-discounted order, a free sample, a 100% coupon — therefore asks for a payment worth
 * nothing. Unmapped, it was refused for a bank account it would never have used, and its obligation
 * marker was retained indefinitely for work that does not exist.
 *
 * BOTH INPUT CLASSES ARE WALKED, because they reach the verdict by different routes: the WC shape
 * DECLARES no `_paymentAmount` at all and the amount is derived from zero-value lines, and an
 * explicit `_paymentAmount: 0` short-circuits the derivation. A reordering that only moved one of
 * them would pass a single-shape test.
 */
test('[o3d-batch-ret r7] a paid ZERO-TOTAL invoice SETTLES with no mapping configured — it is owed nothing', async () => {
  // ROUTE: the real `repairXeroBackReferences` over a SYNCED SALES_INVOICE whose payload asks for a
  // payment, with the payment account map EMPTY — the exact configuration the two refusal arms fire
  // on, so the only thing that can keep this quiet is the amount being asked about first.
  //
  // MUTATION THAT KILLS IT: in lib/connectors/xero/sync-processor.ts, move the
  // `decideRequestedInvoicePayment` call back BELOW the two mapping checks (the
  // round-6 ordering). `xero_payment_skipped` is written and the marker is retained, for a payment
  // nobody was owed.
  for (const { what, money } of [
    { what: 'the WooCommerce shape: `_registerPayment` with NO `_paymentAmount`, over zero-value lines', money: { lines: [{ quantity: 1, unitAmount: 0 }] } },
    { what: 'an explicitly declared zero amount', money: { _paymentAmount: 0, lines: [{ quantity: 1, unitAmount: 0 }] } },
  ]) {
    reset(null)
    store = createSyncLogStore([syncLogRow({
      ...SALES_CANDIDATE,
      payload: {
        invoiceNumber: 'INV-1',
        currency: 'GBP',
        _registerPayment: true,
        _paymentMethod: 'card',
        _paymentDate: '2026-08-20',
        ...money,
      },
    })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran — otherwise nothing below is about the enqueue`,
    )
    assert.deepEqual(
      paymentRefusals(), [],
      `THE FINDING (${what}): an invoice that owes no payment must not be refused for a mapping it `
        + 'never needed. A refusal here is an operator sent to configure a bank account for £0',
    )
    assert.deepEqual(
      followUpTypes(), ['INVOICE_PDF'],
      `and no INVOICE_PAYMENT row is created either (${what}) — "nothing is owed" is not "queue it anyway"`,
    )
    assert.equal(
      marker(), null,
      `and the obligation is DISCHARGED (${what}): retaining it would leave the row for ever in the `
        + 'sweep candidate set and in the exception inbox, owing work that does not exist',
    )
  }
})

test('[o3d-batch-ret r7] CONTROL: the same fixture with a POSITIVE amount and no mapping is still refused', async () => {
  // Without this, the test above could pass on a build that never refuses anything at all — which
  // is the round-6 defect, not its fix. Same row, same empty map, one number changed.
  // ROUTE: one real sweep run; `_paymentAmount` omitted so the amount is derived from the lines,
  // exactly as in the zero arm above.
  reset(null)
  store = createSyncLogStore([syncLogRow({
    ...SALES_CANDIDATE,
    payload: {
      invoiceNumber: 'INV-1',
      currency: 'GBP',
      _registerPayment: true,
      _paymentMethod: 'card',
      _paymentDate: '2026-08-20',
      lines: [{ quantity: 1, unitAmount: 120 }],
    },
  })])

  await (await loadSweep())()

  assert.equal(paymentRefusals().length, 1, 'money that IS owed and cannot be queued is still refused')
  assert.notEqual(marker(), null, 'and its obligation is still retained')
})

/**
 * o3d-batch-ret ROUND 8 (Codex HIGH) — AND ROUND 7'S RESOLVER READ "UNKNOWN" AS "NOTHING OWED".
 *
 * The round-7 fix asked the money question first and answered it with `number | undefined`. Both
 * connectors then wrote `if (amount === undefined || !(amount > 0)) return FOLLOW_UPS_ENQUEUED`, so
 * a `_paymentAmount` that could not be parsed, an absent `lines`, a `lines` that is not an array, a
 * line with no readable quantity, and a derived total that overflowed all produced the ONE value
 * that settles. The marker was cleared, the sweep stopped selecting the row, and a payment that was
 * really requested was reported as work that never existed.
 *
 * ABSENCE IS NOT A NEGATIVE ANSWER. The module-private resolver answers `none | amount | invalid`,
 * `decideRequestedInvoicePayment` settles only `none`, and the `invalid` handler is typed to return
 * a REFUSED outcome, so neither connector can settle a payload whose amount it could not read.
 */
test('[o3d-batch-ret r8] a payment amount that cannot be READ is refused on every route, and the marker SURVIVES', async () => {
  // ROUTE: the real `repairXeroBackReferences` over a SYNCED SALES_INVOICE whose payload asks for a
  // payment, with the mapping CORRECTLY CONFIGURED — so no arm below can be mistaken for the mapping
  // refusal, and the only thing between the row and a settlement is the amount being unreadable. The
  // real receipt fence runs and the real `releaseFollowUpObligation` is the only thing that can clear
  // the marker column read below.
  //
  // MUTATION THAT KILLS IT: in lib/domain/accounting/followup-enqueue-outcome.ts, make
  // `unreadableAmount()` return `NOTHING_OWED` — round 7's `undefined`, which this connector read as
  // "nothing to move". Every arm below then refuses nothing and the marker is CLEARED.
  //
  // EVERY ROUTE INTO `invalid` IS WALKED: they are five different branches of the resolver, and a
  // guard added for only the one Codex named would pass a single-shape test.
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
      what: 'a line whose unit amount cannot be read',
      money: { lines: [{ quantity: 1, unitAmount: null }] },
      detail: /`lines\[0\]\.unitAmount` is null, which is not a finite number/,
    },
    {
      what: 'a derived total that is not finite',
      money: { lines: [{ quantity: 1e308, unitAmount: 10 }] },
      detail: /the amount derived from the payload lines is not a finite number/,
    },
  ]) {
    reset({ 'card:GBP': 'BANK-1' })
    store = createSyncLogStore([syncLogRow({
      ...SALES_CANDIDATE,
      payload: {
        invoiceNumber: 'INV-1',
        currency: 'GBP',
        _registerPayment: true,
        _paymentMethod: 'card',
        _paymentDate: '2026-08-20',
        ...money,
      },
    })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran — otherwise nothing below is about the enqueue`,
    )
    assert.deepEqual(
      followUpTypes(), ['INVOICE_PDF'],
      `no INVOICE_PAYMENT row is created (${what}) — the amount to put on it is not known`,
    )

    const refusal = paymentRefusals()
    assert.equal(refusal.length, 1, `the operator is told once, and told why (${what})`)
    assert.equal(
      refusal[0].metadata?.reason, 'payment_payload_unreadable',
      `and it is NOT reported as the mapping refusal (${what}) — the mapping here is correct, and a `
        + 'bank-account screen is no remedy for a corrupt payload',
    )
    assert.match(refusal[0].description, detail, `the sentence names what could not be read (${what})`)
    assert.match(
      refusal[0].description, /AN UNREADABLE AMOUNT IS NOT A ZERO/,
      `and says which fact this is (${what})`,
    )
    assert.match(
      refusal[0].description, /a later sweep re-reads the marker and re-enqueues them idempotently/,
      `the recovery half is still the REGISTRY's declared fact for this connector (${what}), never a `
        + 'sentence written in the processor — this call site has two drivers',
    )
    assert.match(
      refusal[0].description, /that re-read changes nothing until the payload itself is rebuilt/,
      `and the producer says the part the registry cannot (${what}): the sweep will come back and `
        + 'refuse again, so the re-read is not the remedy',
    )
    assert.match(refusal[0].description, /ESCALATE/, `the remedy is escalation, not a setting (${what})`)

    assert.notEqual(
      marker(), null,
      `THE FINDING (${what}): the row must still say it owes follow-ups. A cleared marker here is a `
        + 'payment that was requested, never queued, and looks reconciled',
    )
    assert.equal(
      store.get('log-1')?.backReferenceCheckedAt, null,
      `and it is left in the sweep candidate set (${what})`,
    )
  }
})

test('[o3d-batch-ret r8] CONTROL: a DECLARED zero still settles, with no `lines` to derive from at all', async () => {
  // Without this the test above could pass on a build that refuses every payload — the round-7
  // regression (a paid £0 order refused for a bank account it would never use), not its fix.
  //
  // And it is the sharpest statement of the rule: the SAME shape refused above for carrying no
  // `lines` SETTLES here, because a readable `_paymentAmount` is final and the derivation is never
  // reached. "No lines" is unreadable only when the amount has to be derived from them.
  //
  // ROUTE: one real sweep run, mapping deliberately absent so a refusal of any kind would be loud.
  // MUTATION THAT KILLS IT: make `readableAmount()` answer `invalid` for a non-positive amount —
  // the over-correction. This fails on the refusal count and on the marker.
  reset(null)
  store = createSyncLogStore([syncLogRow({
    ...SALES_CANDIDATE,
    payload: {
      invoiceNumber: 'INV-1',
      currency: 'GBP',
      _registerPayment: true,
      _paymentMethod: 'card',
      _paymentDate: '2026-08-20',
      _paymentAmount: 0,
    },
  })])

  await (await loadSweep())()

  assert.equal(salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1', 'PRECONDITION: the repair ran')
  assert.deepEqual(paymentRefusals(), [], 'an invoice that says it owes nothing is not refused')
  assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], 'and no INVOICE_PAYMENT row is created')
  assert.equal(marker(), null, 'and the obligation IS discharged')
})

/**
 * o3d-batch-ret ROUND 9 (Codex HIGH) — A PRESENT `null` IS NOT AN ABSENT FIELD.
 *
 * Round 8 gave the resolver an `invalid` arm for a value it cannot read. It then went on asking
 * `x === undefined || x === null` to decide whether the payload USES a field at all, so the one
 * shape that most obviously needs the new arm — a key that is there holding a null, because
 * something wrote nothing into it — took the ABSENT path instead:
 *
 *   • `{_paymentAmount: null, lines: []}` fell through to the derivation, derived a zero, and
 *     SETTLED. A declaration nobody could read was answered "no payment was owed".
 *   • a null `shippingAmount` or `discountAmount` was spent as a REAL zero, so the amount the
 *     customer is recorded as having paid silently moved by whatever the null was hiding.
 *
 * `Object.hasOwn` is the only thing that separates the two facts, and every optional monetary field
 * now asks it before it looks at the value. Absence still selects the other path — that is what
 * makes an ordinary invoice with no shipping leg readable — and presence must be READ or REFUSED.
 */
test('[o3d-batch-ret r9] a PRESENT null is refused on every field that had a default, and the marker SURVIVES', async () => {
  // ROUTE: the real `repairXeroBackReferences` over a SYNCED SALES_INVOICE asking for a payment,
  // with the mapping CORRECTLY CONFIGURED (`card: BANK-1`) — so nothing below can be the mapping
  // refusal, and the only thing between this row and a settlement is the null being a value the
  // resolver refuses to guess at. The real receipt fence runs; `releaseFollowUpObligation` is the
  // only thing that can clear the marker read at the foot of each arm.
  //
  // MUTATION THAT KILLS IT: in lib/domain/accounting/followup-enqueue-outcome.ts, put the round-8
  // presence tests back — `if (declared !== null && declared !== undefined)` for `_paymentAmount`,
  // and `payload.shippingAmount === null || payload.shippingAmount === undefined ? 0 : ...` for the
  // two adjustments. The first arm then derives a zero and CLEARS the marker with no refusal at
  // all; the other two spend the null as a zero, enqueue an INVOICE_PAYMENT for the derived 120 and
  // clear the marker as well. Every arm fails on `followUpTypes`, on the refusal count and on the
  // marker.
  //
  // ALL THREE FIELDS ARE WALKED because the shortcut was written out three times, and a fix applied
  // only to the field Codex named in its probe would pass a one-shape test.
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
    reset({ 'card:GBP': 'BANK-1' })
    store = createSyncLogStore([syncLogRow({
      ...SALES_CANDIDATE,
      payload: {
        invoiceNumber: 'INV-1',
        currency: 'GBP',
        _registerPayment: true,
        _paymentMethod: 'card',
        _paymentDate: '2026-08-20',
        ...money,
      },
    })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran — otherwise nothing below is about the enqueue`,
    )
    assert.deepEqual(
      followUpTypes(), ['INVOICE_PDF'],
      `no INVOICE_PAYMENT row is created (${what}) — an amount derived AROUND an unreadable field is `
        + 'not the amount the payload states, and queueing it would register the wrong money',
    )

    const refusal = paymentRefusals()
    assert.equal(refusal.length, 1, `the operator is told once, and told why (${what})`)
    assert.equal(
      refusal[0].metadata?.reason, 'payment_payload_unreadable',
      `and it is the CORRUPT-PAYLOAD refusal (${what}), not the mapping one — the mapping is correct here`,
    )
    assert.match(refusal[0].description, detail, `the sentence names the field and what it holds (${what})`)
    assert.match(
      refusal[0].description, /AN UNREADABLE AMOUNT IS NOT A ZERO/,
      `and says which fact this is (${what}) — the exact conflation the null took advantage of`,
    )

    assert.notEqual(
      marker(), null,
      `THE FINDING (${what}): the row must still say it owes follow-ups. A cleared marker here is a `
        + 'payment that was requested, never queued, and looks reconciled',
    )
    assert.equal(
      store.get('log-1')?.backReferenceCheckedAt, null,
      `and it is left in the sweep candidate set (${what})`,
    )
  }
})

test('[o3d-batch-ret r9] CONTROL: ABSENT and READABLE-ZERO fields still take their old paths', async () => {
  // Without this, the test above passes on a build that refuses every payload carrying an optional
  // field at all — which would refuse ordinary invoices (no shipping leg, no discount) and is a
  // worse failure than the one being fixed.
  //
  // THREE ARMS, BECAUSE THREE DIFFERENT THINGS MUST STILL BE TRUE:
  //   1. an ABSENT adjustment is a real zero and the derivation still happens over it;
  //   2. a PRESENT but READABLE zero is not refused for being present — presence is not the defect,
  //      unreadable presence is;
  //   3. a DECLARED readable zero is still FINAL and still settles, even with lines beside it that
  //      would have derived 120.
  //
  // ROUTE: one real sweep run per arm, mapping configured, so an enqueue is possible and a refusal
  // would be loud.
  // MUTATIONS THAT KILL IT: make `optionalAdjustment` return a `detail` when the key is absent (the
  // over-correction) — arms 1 and 2 then refuse; or make `readableAmount` answer `invalid` for a
  // non-positive amount — arm 3 then refuses instead of settling.
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
    reset({ 'card:GBP': 'BANK-1' })
    store = createSyncLogStore([syncLogRow({
      ...SALES_CANDIDATE,
      payload: {
        invoiceNumber: 'INV-1',
        currency: 'GBP',
        _registerPayment: true,
        _paymentMethod: 'card',
        _paymentDate: '2026-08-20',
        ...money,
      },
    })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran`,
    )
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
    assert.equal(marker(), null, `and the obligation IS discharged (${what})`)
  }
})

/**
 * o3d-batch-ret ROUND 10 (Codex HIGH) — THE FLAG THAT GATES THE WHOLE DECISION WAS READ BY
 * TRUTHINESS, AND IT IS THE FIFTH ROUND ON ONE AXIS. THE XERO HALF.
 *
 * Rounds 6–9 each fixed the field Codex had just named: a default meaning success, a resolver
 * merging "unknown" with "nothing owed", a present `null` read as an absent key. The field that
 * decides whether ANY of that runs was never one of them. This connector opened with
 * `if (!payload._registerPayment) return FOLLOW_UPS_ENQUEUED`, so an absent key, a literal `false`,
 * a present `null`, a `0`, an `''` and an explicit `undefined` were ONE answer — nobody asked for a
 * payment, settle — and a truthy malformed value such as the string `'false'` went the other way and
 * ENTERED payment registration.
 *
 * THE TRUTHY DIRECTION IS THE ONE THAT IS WORSE HERE. Xero declares `consumer: 'sweep'`, so a
 * cleared marker costs a lap of a sweep that does come back; but a payment REGISTERED because a
 * corrupt byte was truthy puts real money against a real invoice in the ledger, and no request id
 * deduplicates it afterwards.
 */
test('[o3d-batch-ret r10] a `_registerPayment` that cannot be READ is refused durably, in BOTH directions', async () => {
  // ROUTE: the real `repairXeroBackReferences` over a SYNCED SALES_INVOICE, with the mapping
  // CORRECTLY CONFIGURED (`card: BANK-1`) and a readable amount — so nothing below can be the
  // mapping refusal or the round-8 amount refusal, and the ONLY thing standing between this row and
  // a settlement is the request flag. The real receipt fence runs and the real
  // `releaseFollowUpObligation` is the only thing that can clear the marker column read below.
  //
  // MUTATION THAT KILLS IT: in lib/domain/accounting/followup-enqueue-outcome.ts, replace the body
  // of `payloadPaymentRequested` with `return { value: Boolean(payload._registerPayment) }` — the
  // shipped truthiness test. The four FALSY arms then settle (the marker is cleared and the refusal
  // count drops to 0) and the two TRUTHY-MALFORMED arms create an INVOICE_PAYMENT row, so
  // `followUpTypes` fails naming the shape.
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
    reset({ 'card:GBP': 'BANK-1' })
    store = createSyncLogStore([syncLogRow({
      ...SALES_CANDIDATE,
      payload: {
        invoiceNumber: 'INV-1',
        currency: 'GBP',
        _paymentMethod: 'card',
        _paymentAmount: 120,
        _paymentDate: '2026-08-20',
        ...flag,
      },
    })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran — otherwise nothing below is about the enqueue`,
    )
    assert.deepEqual(
      followUpTypes(), ['INVOICE_PDF'],
      `no INVOICE_PAYMENT row is created (${what}) — an unreadable request is not a YES either, and a `
        + 'receipt registered on the strength of a corrupt byte is real money against a real invoice',
    )

    const refusal = paymentRefusals()
    assert.equal(refusal.length, 1, `the operator is told once, and told why (${what})`)
    assert.equal(
      refusal[0].metadata?.reason, 'payment_payload_unreadable',
      `and it is the CORRUPT-PAYLOAD refusal (${what}), not the mapping one — the mapping is correct here`,
    )
    assert.match(refusal[0].description, detail, `the sentence names the field and what it holds (${what})`)
    assert.match(
      refusal[0].description, /AN UNREADABLE REQUEST IS NOT A "NO"/,
      `and says which of the three facts this is (${what})`,
    )
    assert.doesNotMatch(
      refusal[0].description, /the invoice asked for a payment to be registered/,
      `and does NOT assert the thing it is refusing over (${what}): whether the invoice asked is the `
        + 'very fact that could not be read, so round 8\'s opening clause would be a lie here',
    )
    assert.match(refusal[0].description, /ESCALATE/, `the remedy is escalation, not a setting (${what})`)

    assert.notEqual(
      marker(), null,
      `THE FINDING (${what}): the row must still say it owes follow-ups, or the sweep that is this `
        + "connector's whole recovery story stops selecting it",
    )
    assert.equal(
      store.get('log-1')?.backReferenceCheckedAt, null,
      `and it is left in the sweep candidate set (${what})`,
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
  // ROUTE: one real sweep run per arm, mapping configured so an enqueue is possible.
  // MUTATIONS THAT KILL IT: make `payloadPaymentRequested` refuse on an ABSENT key — arm 1 refuses;
  // drop the `value === false` arm so only `true` is readable — arm 2 refuses; make it answer
  // `{ value: false }` for a literal `true` — arm 3 queues no INVOICE_PAYMENT.
  const readable: Array<{ what: string; flag: Record<string, unknown>; expected: string[]; amount: number | null }> = [
    { what: 'no `_registerPayment` key at all', flag: {}, expected: ['INVOICE_PDF'], amount: null },
    { what: 'a literal `false`', flag: { _registerPayment: false }, expected: ['INVOICE_PDF'], amount: null },
    { what: 'a literal `true`', flag: { _registerPayment: true }, expected: ['INVOICE_PAYMENT', 'INVOICE_PDF'], amount: 120 },
  ]
  for (const { what, flag, expected, amount } of readable) {
    reset({ 'card:GBP': 'BANK-1' })
    store = createSyncLogStore([syncLogRow({
      ...SALES_CANDIDATE,
      payload: {
        invoiceNumber: 'INV-1',
        currency: 'GBP',
        _paymentMethod: 'card',
        _paymentAmount: 120,
        _paymentDate: '2026-08-20',
        ...flag,
      },
    })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran`,
    )
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
    assert.equal(marker(), null, `and the obligation IS discharged (${what})`)
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
 *     `TypeError: .slice is not a function` — and on THIS driver that throw is inside the sweep,
 *     which is meant to be the recovery path for rows nothing else re-drives.
 */
test('[o3d-batch-ret r10] every OTHER field this path reads is refused when present and unreadable', async () => {
  // ROUTE: the real `repairXeroBackReferences`, mapping CORRECTLY CONFIGURED and `_paymentAmount:
  // 120` readable — so the amount and the mapping are both fine and the only thing refusing is the
  // field under test.
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
    { what: 'a `_paymentDate` that is a NUMBER — the arm that used to throw a TypeError inside the sweep', field: { _paymentDate: 20260820 }, detail: /`_paymentDate` is 20260820, which is not a date string/ },
    { what: 'a `_paymentDate` string that is not a ledger date', field: { _paymentDate: '20/08/2026' }, detail: /`_paymentDate` is the string "20\/08\/2026", whose first ten characters are not a YYYY-MM-DD date/ },
  ]
  for (const { what, field, detail } of fields) {
    reset({ 'card:GBP': 'BANK-1' })
    store = createSyncLogStore([syncLogRow({
      ...SALES_CANDIDATE,
      payload: {
        invoiceNumber: 'INV-1',
        currency: 'GBP',
        _registerPayment: true,
        _paymentMethod: 'card',
        _paymentAmount: 120,
        _paymentDate: '2026-08-20',
        ...field,
      },
    })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran — otherwise nothing below is about the enqueue`,
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
    assert.match(refusal[0].description, detail, `the sentence names the field and what it holds (${what})`)
    assert.match(
      refusal[0].description, /AN UNREADABLE FIELD IS NOT ITS DEFAULT/,
      `and says which of the three facts this is (${what}) — the amount read perfectly well here`,
    )

    assert.notEqual(marker(), null, `THE FINDING (${what}): the obligation marker SURVIVES`)
    assert.equal(
      store.get('log-1')?.backReferenceCheckedAt, null,
      `and it is left in the sweep candidate set (${what})`,
    )
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
  //   • an absent `currency` is registered as the ORGANISATION base currency, read off the queued
  //     row — GBP here because that is what the `organisationRow` fixture holds, and o3d-batch-ret
  //     r11 is the round that made that provenance real rather than a literal;
  //   • an absent `_paymentDate` is registered as today, read off the queued row.
  //
  // MUTATION THAT KILLS IT: make `payloadPaymentMethod`, `payloadPaymentCurrency` or
  // `payloadPaymentDate` answer `unreadableField(...)` for an ABSENT key — each arm then produces a
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
      what: 'no `currency` key at all',
      drop: 'currency',
      expected: ['INVOICE_PAYMENT', 'INVOICE_PDF'],
      assertRow: { currency: 'GBP' },
    },
    {
      what: 'no `_paymentDate` key at all',
      drop: '_paymentDate',
      expected: ['INVOICE_PAYMENT', 'INVOICE_PDF'],
      assertRow: { paymentDate: today },
    },
  ]
  for (const { what, drop, expected, assertRow } of absences) {
    reset({ 'card:GBP': 'BANK-1' })
    const payload: Record<string, unknown> = {
      invoiceNumber: 'INV-1',
      currency: 'GBP',
      _registerPayment: true,
      _paymentMethod: 'card',
      _paymentAmount: 120,
      _paymentDate: '2026-08-20',
    }
    delete payload[drop]
    assert.ok(!Object.hasOwn(payload, drop), `PRECONDITION (${what}): the key really is absent, not merely undefined`)
    store = createSyncLogStore([syncLogRow({ ...SALES_CANDIDATE, payload })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran`,
    )
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
        refusal[0].description, /no bank account is mapped for method "" \/ currency "GBP"/,
        `naming the empty method it really resolved to (${what})`,
      )
    } else {
      assert.deepEqual(refusal, [], `nothing is refused (${what})`)
      const row = (store.rows.find((r) => r.type === 'INVOICE_PAYMENT')?.payload ?? {}) as Record<string, unknown>
      for (const [key, value] of Object.entries(assertRow)) {
        assert.equal(row[key], value, `the default really was written onto the queued row (${what})`)
      }
      assert.equal(marker(), null, `and the obligation IS discharged (${what})`)
    }
  }
})

/**
 * o3d-batch-ret ROUND 11 (Codex HIGH), THE XERO HALF — THE DEFAULT NOBODY HAD QUESTIONED, ON THE
 * INSTALLATION IT IS WRONG FOR.
 *
 * Round 10 closed the two PRESENT holes in `currency` — a persisted `null` and a persisted `''` had
 * both become `GBP` — and kept the ABSENT arm's `GBP` literal, because absence really is the
 * ordinary case. But `Organisation.baseCurrency` is CONFIGURABLE, and on a EUR-base installation
 * the two halves of one settlement then disagreed:
 *
 *   • THE DOCUMENT posts in the base currency. An absent `currency` reaches `pushSalesInvoice` as
 *     `undefined`, `CurrencyCode: data.currency` is dropped from the body by JSON, and Xero
 *     denominates the invoice in the organisation's own base currency — which `connectXero`
 *     refuses to bind unless it equals `getBaseCurrencyCode()`.
 *   • THE PAYMENT called the same absence sterling. `lookupPaymentAccount` keys the BANK ACCOUNT on
 *     that currency, so either a real `card:EUR` mapping was missed and the payment refused, or a
 *     `card:GBP` mapping was found and the money settled into the STERLING account with `GBP`
 *     stamped on the INVOICE_PAYMENT row — against a EUR invoice.
 *
 * BOTH BASES ARE WALKED, and that is the point of the table rather than a second test: the fix has
 * to move the EUR installation without moving the GBP one, and a build that simply refused every
 * absent currency would pass a EUR-only test.
 */
test('[o3d-batch-ret r11] an ABSENT currency settles in the ORGANISATION base currency — EUR on a EUR-base install, GBP on a GBP-base one', async () => {
  // ROUTE: the real `repairXeroBackReferences` over a SYNCED SALES_INVOICE whose payload has NO
  // `currency` key, with the real `resolveBaseCurrencyCode` reading the `organisationRow` fixture
  // and the real `lookupPaymentAccount` keyed on `method:currency`. The observable is the queued
  // INVOICE_PAYMENT row's own `currency` and `bankAccountId` — the account the money lands in.
  //
  // MUTATION THAT KILLS IT: in lib/domain/accounting/followup-enqueue-outcome.ts, restore the
  // shipped literal — `const BASE_PAYMENT_CURRENCY = 'GBP'` and, in `payloadPaymentCurrency`,
  // `if (!declaresField(payload, 'currency')) return { value: BASE_PAYMENT_CURRENCY }`. Arm 1 then
  // queues the payment as GBP into BANK-GBP (both assertions fail), and arm 3 queues one into the
  // sterling account instead of refusing. Arm 2 — the GBP install — is unmoved by that mutation,
  // which is exactly why it is here.
  const cases: Array<{
    what: string
    base: string
    map: Record<string, string>
    queued: { currency: string; bankAccountId: string } | null
    refusal: RegExp | null
  }> = [
    {
      what: 'a EUR-base organisation with BOTH currencies mapped — the wrong-settlement half of the finding',
      base: 'EUR',
      map: { 'card:EUR': 'BANK-EUR', 'card:GBP': 'BANK-GBP' },
      queued: { currency: 'EUR', bankAccountId: 'BANK-EUR' },
      refusal: null,
    },
    {
      what: 'THE ORDINARY CASE: a GBP-base organisation, unchanged',
      base: 'GBP',
      map: { 'card:EUR': 'BANK-EUR', 'card:GBP': 'BANK-GBP' },
      queued: { currency: 'GBP', bankAccountId: 'BANK-GBP' },
      refusal: null,
    },
    {
      what: 'a EUR-base organisation with ONLY the sterling account mapped — the missed-mapping half',
      base: 'EUR',
      map: { 'card:GBP': 'BANK-GBP' },
      queued: null,
      refusal: /no bank account is mapped for method "card" \/ currency "EUR"/,
    },
  ]
  for (const { what, base, map, queued, refusal } of cases) {
    reset(map)
    organisationRow = { baseCurrency: base }
    const payload: Record<string, unknown> = {
      invoiceNumber: 'INV-1',
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
    store = createSyncLogStore([syncLogRow({ ...SALES_CANDIDATE, payload })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran — the document is the half that took the base `
        + 'currency implicitly, and nothing below is about the payment unless it exists',
    )

    if (queued === null) {
      assert.deepEqual(followUpTypes(), ['INVOICE_PDF'], `no payment row was created (${what})`)
      const refusals = paymentRefusals()
      assert.equal(refusals.length, 1, `the operator is told once (${what})`)
      assert.equal(
        refusals[0].metadata?.reason, 'payment_account_unmapped',
        `and it is the MAPPING refusal (${what}) — the payload is not at fault`,
      )
      assert.match(
        refusals[0].description, refusal!,
        `THE FINDING (${what}): the refusal names the currency the DOCUMENT is in. Under the shipped `
          + 'literal this row found the sterling account instead and settled a EUR invoice into it',
      )
      assert.equal(
        refusals[0].metadata?.currency, base,
        `and the activity metadata records that currency too (${what})`,
      )
      assert.notEqual(marker(), null, `the obligation marker survives (${what})`)
      continue
    }

    assert.deepEqual(
      paymentRefusals(), [],
      `nothing is refused (${what}) — the account for the base currency is mapped`,
    )
    assert.deepEqual(
      followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'],
      `the payment IS queued (${what})`,
    )
    const row = (store.rows.find((r) => r.type === 'INVOICE_PAYMENT')?.payload ?? {}) as Record<string, unknown>
    assert.equal(
      row.currency, queued.currency,
      `THE FINDING (${what}): the currency stamped on the INVOICE_PAYMENT row is the organisation's, `
        + 'not a literal',
    )
    assert.equal(
      row.bankAccountId, queued.bankAccountId,
      `and the money lands in THAT currency's bank account (${what}) — this is the assertion the `
        + 'sterling literal fails, and it can only fail while both accounts are mapped',
    )
    assert.equal(marker(), null, `and the obligation IS discharged (${what})`)
  }
})

/**
 * o3d-batch-ret ROUND 11 — AND AN UNRESOLVABLE BASE CURRENCY IS AN UNKNOWN, WHICH IS THE ONE THING
 * SIX ROUNDS HAVE AGREED MUST NOT BE SPENT AS A DEFAULT.
 *
 * `resolveBaseCurrencyCode` answers `org?.baseCurrency ?? DEFAULT_BASE_CURRENCY`, and THAT fallback
 * is established rather than assumed: the connect-time guards compare the ledger's base currency
 * against the same expression, so an installation with no organisation row cannot have a non-GBP
 * ledger bound to it and the two halves still agree. What is genuinely unknown is a read that THREW
 * — the row could not be consulted at all — or a `baseCurrency` holding no currency code. Guessing
 * sterling there is the round-10 defect one layer down: it picks a bank account by a currency
 * nobody stated.
 *
 * THE THIRD ARM IS WHAT KEEPS THE FIRST TWO HONEST. The base currency is consulted ONLY where it is
 * used, so a payload that names its own currency must settle normally even while the organisation
 * read is broken. Without it, "refuse when the read fails" could have been implemented as "refuse
 * every payment when the read fails", which on this driver would stall the sweep for every row in
 * the candidate set over a transient database error.
 */
test('[o3d-batch-ret r11] an UNRESOLVABLE base currency refuses the absent-currency payment, and only that one', async () => {
  // ROUTE: the real `repairXeroBackReferences` with the `organisation.findFirst` fixture set to
  // throw, or to a row holding a blank `baseCurrency`. The real `resolveBasePaymentCurrency` in
  // lib/domain/accounting/followup-enqueue-outcome.ts is what turns that into the refusal.
  //
  // MUTATION THAT KILLS IT: make `resolveBasePaymentCurrency` fall back instead of refusing —
  // `catch { return { value: 'GBP' } }` and drop the blank-string check. Arms 1 and 2 then queue an
  // INVOICE_PAYMENT into the sterling account rather than refusing, failing on `followUpTypes` and
  // on the refusal count. Arm 3 is unaffected by that mutation and is the control.
  const cases: Array<{ what: string; row: { baseCurrency: string } | null | 'throw'; currency?: string; detail: RegExp | null }> = [
    {
      what: 'the organisation row cannot be read at all',
      row: 'throw',
      detail: /reading the organisation base currency failed: organisation table unavailable/,
    },
    {
      what: 'the organisation row holds a blank base currency',
      row: { baseCurrency: '   ' },
      detail: /`Organisation.baseCurrency` is the string "   ", which is not a currency code/,
    },
    {
      what: 'CONTROL: the same broken read, but the payload NAMES its own currency',
      row: 'throw',
      currency: 'GBP',
      detail: null,
    },
  ]
  for (const { what, row, currency, detail } of cases) {
    reset({ 'card:GBP': 'BANK-GBP' })
    organisationRow = row
    const payload: Record<string, unknown> = {
      invoiceNumber: 'INV-1',
      _registerPayment: true,
      _paymentMethod: 'card',
      _paymentAmount: 120,
      _paymentDate: '2026-08-20',
      ...(currency === undefined ? {} : { currency }),
    }
    store = createSyncLogStore([syncLogRow({ ...SALES_CANDIDATE, payload })])

    await (await loadSweep())()

    assert.equal(
      salesOrders.get('order-1')?.accountingInvoiceId, 'XERO-INV-1',
      `PRECONDITION (${what}): the repair really ran`,
    )

    if (detail === null) {
      assert.deepEqual(
        paymentRefusals(), [],
        `THE CONTROL (${what}): a payload that states its currency does not consult the base one at `
          + 'all, so a broken organisation read must not touch it',
      )
      assert.deepEqual(followUpTypes(), ['INVOICE_PAYMENT', 'INVOICE_PDF'], `and the payment IS queued (${what})`)
      const queued = (store.rows.find((r) => r.type === 'INVOICE_PAYMENT')?.payload ?? {}) as Record<string, unknown>
      assert.equal(queued.currency, 'GBP', `in the currency the payload named (${what})`)
      assert.equal(marker(), null, `and the obligation IS discharged (${what})`)
      continue
    }

    assert.deepEqual(
      followUpTypes(), ['INVOICE_PDF'],
      `no INVOICE_PAYMENT row is created (${what}) — a bank account chosen by a currency nobody `
        + 'stated is a wrong settlement, not a missing one',
    )
    const refusals = paymentRefusals()
    assert.equal(refusals.length, 1, `the operator is told once (${what})`)
    assert.equal(
      refusals[0].metadata?.reason, 'payment_payload_unreadable',
      `and it is the unreadable refusal (${what})`,
    )
    assert.match(refusals[0].description, detail, `naming what could not be resolved (${what})`)
    assert.match(
      refusals[0].description, /AN UNRESOLVED BASE CURRENCY IS NOT STERLING/,
      `and it is the BASE-CURRENCY clause (${what}), not the corrupt-field one — the payload is `
        + 'entirely well-formed here, and telling an operator to look at it would be false',
    )
    assert.doesNotMatch(
      refusals[0].description, /AN UNREADABLE FIELD IS NOT ITS DEFAULT/,
      `the field clause must NOT be borrowed for it (${what}) — omitting \`currency\` is the ordinary `
        + 'case, and that clause blames the payload',
    )
    assert.notEqual(marker(), null, `THE FINDING (${what}): the obligation marker SURVIVES`)
    assert.equal(
      store.get('log-1')?.backReferenceCheckedAt, null,
      `and it is left in the sweep candidate set (${what})`,
    )
  }
})
