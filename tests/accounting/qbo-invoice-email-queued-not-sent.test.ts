import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// Codex MEDIUM — SETTLING THE SYNC ROW DOES NOT STOP THE EMAILS ALREADY QUEUED.
//
// o3d-qn21 corrected the QuickBooks escalation so that a no-identifier operation is described as a
// REPLAY rather than a deduplicated re-post, and for three of the four operations that is the whole
// story: the effect has already happened by the time an operator reads the record, so "check it, then
// settle the row" leaves nothing outstanding.
//
// `INVOICE_EMAIL` IS NOT ONE OF THOSE THREE. It succeeds by writing a PENDING row into the email
// outbox; a separate cron delivers it later. Every sweep therefore leaves another queued copy behind,
// and settling the sync row stops the SWEEP while cancelling NONE of the copies already queued. An
// operator told to "check what was sent" would look at a mail log, see one delivery, settle the row,
// and the rest would arrive afterwards — the settlement reading as the end of the incident when it is
// not.
//
// This file pins the PREMISE (success means queued, one row per call, nothing sent) and then pins that
// the operator-facing wording names the exact row shape that premise produces, so the query it tells
// somebody to run actually selects the rows the replay created.
// ---------------------------------------------------------------------------

type OutboxRow = Record<string, unknown>

const state = {
  outbox: [] as OutboxRow[],
  sends: 0,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async () => ({
          id: 'order-1',
          orderNumber: 'SO-1',
          externalOrderNumber: null,
          invoiceNumber: 'INV-1',
          customerEmail: 'customer@example.test',
          invoicePdfPath: '/invoices/INV-1.pdf',
        }),
      },
      emailOutbox: {
        create: async ({ data }: { data: OutboxRow }) => {
          state.outbox.push(data)
          return { id: `outbox-${state.outbox.length}`, ...data }
        },
      },
    },
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

// Round 7: the OTHER writer of this row shape is an authenticated server action, so it is driven
// here rather than described.
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'op-1' } }) } })
mock.module('@/lib/auth', { namedExports: { auth: async () => ({ user: { id: 'op-1' } }) } })

// The real sender, so that "nothing was sent" is an observation rather than an assumption.
mock.module('@/lib/mailer', {
  namedExports: {
    sendEmail: async () => {
      state.sends += 1
      return { success: true }
    },
  },
})

test('Codex MEDIUM: an INVOICE_EMAIL success QUEUES a pending row — it does not send anything', async () => {
  state.outbox = []
  state.sends = 0

  const { sendAccountingInvoiceEmailInternal } = await import('@/lib/accounting-email')
  const result = await sendAccountingInvoiceEmailInternal('order-1')

  assert.equal(result.success, true)
  assert.equal(state.sends, 0, 'success is not a delivery: nothing reached the mailer')
  assert.equal(state.outbox.length, 1, 'it is a row in the outbox, waiting for the outbox cron')
  const row = state.outbox[0]
  assert.equal(row.kind, 'ACCOUNTING_INVOICE')
  assert.equal(row.referenceType, 'SalesOrder')
  assert.equal(row.referenceId, 'order-1')
  assert.ok(!('status' in row), 'no status is written, so the row lands on the model default: PENDING')
  assert.ok(!('sentAt' in row), 'and nothing is stamped sent, because nothing has been')
})

test('Codex MEDIUM: every replay adds ANOTHER pending copy — settling the row cancels none of them', async () => {
  // THE CONTROL FOR THE WORDING. Three sweeps of the unfenced replay leave three PENDING rows. There
  // is nothing in this path that supersedes, dedupes or cancels an earlier one, so the count is also
  // the number of emails a customer receives if an operator settles the sync row and stops there.
  state.outbox = []
  state.sends = 0

  const { sendAccountingInvoiceEmailInternal } = await import('@/lib/accounting-email')
  await sendAccountingInvoiceEmailInternal('order-1')
  await sendAccountingInvoiceEmailInternal('order-1')
  await sendAccountingInvoiceEmailInternal('order-1')

  assert.equal(state.outbox.length, 3, 'one queued copy per sweep, all of them still pending')
  assert.equal(state.sends, 0, 'and none of them delivered yet — which is exactly why they can still be cancelled')
  assert.deepEqual(
    [...new Set(state.outbox.map((row) => `${String(row.referenceType)}:${String(row.referenceId)}`))],
    ['SalesOrder:order-1'],
    'and they all hang off the one order, so one query finds the whole set',
  )
})

test('Codex MEDIUM (round 3): the escalation names the queued copies and the fact that IMS cannot cancel them', async () => {
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')

  const description = describeUnpersistedQboPost(
    {
      entry: { id: 'log-1', type: 'INVOICE_EMAIL', referenceType: 'SalesOrder', referenceId: 'order-1' },
      postedExternalId: null,
    },
    new Error('write conflict'),
  )

  // The correction: the replay QUEUES, and the settlement the reader is about to perform does not
  // reach back into what is queued.
  assert.match(description, /IS QUEUED TO THE CUSTOMER/)
  assert.match(description, /PENDING/)
  assert.doesNotMatch(
    description,
    /IS SENT TO THE CUSTOMER, once per sweep/,
    'the old wording described a finished send, which left the operator nothing to do but reconcile',
  )
  // Round 3 replaced this sentence rather than keeping it: "settling cancels nothing that is already
  // queued" still implied a settlement the operator could go and perform, and they cannot.
  assert.doesNotMatch(description, /SETTLING THE ROW CANCELS NOTHING THAT IS ALREADY QUEUED/)
  // ROUND 7: the settlement is not named as a step at all — not as available, and not as
  // unavailable-for-now. Naming it either way is what made three rounds of wording wrong; the
  // reader is told to escalate the row instead.
  assert.doesNotMatch(description, /settle sync row log-1/)
  assert.doesNotMatch(description, /refuses EVERY QuickBooks row/)
  // ROUND 7 (Codex HIGH): the conjunction round 5 added was the PRECONDITION of a remedy that could
  // always be raced — the toggle admits, it does not quiesce. The remedy is gone with it, and the
  // record says to leave the connector off and escalate. See
  // tests/accounting/qbo-disable-is-not-quiescence.ts, which drives the race.
  assert.doesNotMatch(description, /THE PER-ROW REMEDY DOES EXIST/)
  assert.doesNotMatch(description, /STRANDED SYNC ROWS/)
  assert.match(description, /THEN LEAVE IT OFF, BECAUSE TURNING IT OFF IS NOT A FENCE/)
  assert.match(description, /ESCALATE sync row log-1/)

  // ROUND 3 (Codex HIGH). The instruction this test used to pin — "keep at most the one copy the
  // customer should receive, and cancel the rest", then settle — WAS NOT PERFORMABLE. The outbox has
  // no cancelled state and no operator control removes an unsent row, and the settlement action
  // refuses every QuickBooks row. A remedy has to be a thing an operator can do, so the message now
  // names the impossibility instead of instructing past it.
  assert.doesNotMatch(description, /cancel the rest/, 'there is no operation that cancels a queued copy')
  assert.match(description, /IMS CANNOT CANCEL A QUEUED COPY/)

  // ROUND 7 (Codex MEDIUM): NOT "every copy WILL be delivered", and NOT a count to give a customer.
  // The outbox terminalises a row FAILED for a suppressed recipient, a permanent send failure or
  // five exhausted attempts; the rows carry no sync-log id; and the authenticated
  // accounting-invoice action writes the identical shape. See the two tests at the end of this file.
  assert.doesNotMatch(description, /every copy already queued WILL be delivered/)
  assert.doesNotMatch(description, /how many copies are on their way/)

  // What survives is the part that IS runnable: the query still has to select the rows the first two
  // tests produced, because inspecting them is the whole of what can be done.
  for (const fragment of ['kind ACCOUNTING_INVOICE', 'referenceType SalesOrder', 'referenceId = the order id']) {
    assert.ok(
      description.includes(fragment),
      `the query the operator is told to run must name ${fragment}, which is what queueEmail actually writes`,
    )
  }
  // ROUND 8 split this in two: what comes back is a NON-QUIESCENT SNAPSHOT (the replay may still
  // be adding to it), and IMS cannot narrow what it does contain.
  assert.match(description, /WHAT COMES BACK IS A NON-QUIESCENT SNAPSHOT/)
  assert.match(description, /AND IMS CANNOT NARROW IT/)

  // tests/accounting/qbo-remedy-is-performable.test.ts walks every step of this message against the
  // shipped code — the outbox enum, the settlement action, and the sync toggle it does name.
})

test('Codex MEDIUM: the outbox caveat stays on the email operation only', async () => {
  // THE OTHER SIDE OF THE SPLIT. An attachment upload, a stored PDF and a WooCommerce note have all
  // already happened when the record is written; telling those readers to go and cancel pending
  // outbox rows would send them looking for rows that do not exist.
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')

  for (const type of ['BILL_ATTACHMENT', 'INVOICE_PDF', 'WC_INVOICE_NOTE'] as const) {
    const description = describeUnpersistedQboPost(
      {
        entry: { id: 'log-1', type, referenceType: 'SalesOrder', referenceId: 'order-1' },
        postedExternalId: null,
      },
      new Error('write conflict'),
    )
    assert.match(description, /NO REQUEST ID PROTECTS IT/, `${type} keeps the o3d-qn21 replay warning`)
    assert.doesNotMatch(description, /email-outbox row/, `${type} has no queued copies to cancel`)
  }
})

// ---------------------------------------------------------------------------
// ROUND 7 (Codex MEDIUM): THE COUNT THE RECORD PRESCRIBED COULD NOT BE MADE FROM THIS DATA.
//
// The record told an operator to query the outbox by kind/reference and report that number to the
// customer as copies on their way. Two shipped facts make that impossible, and both are exercised
// below rather than asserted about:
//
//   1. THE SAME SHAPE HAS ANOTHER, LEGITIMATE WRITER. `sendAccountingInvoiceEmail` in
//      app/actions/email.ts is an authenticated operator action behind `sales.process`, and it
//      calls the very function the replay calls. Its rows are in the same result set.
//   2. NO ROW CARRIES ITS ORIGIN. The model has no column naming the sync log, attempt or incident
//      that queued it, so nothing can attribute a copy to this incident — and a row can already be
//      SENT, or FAILED and never delivered at all.
//
// Durable provenance is filed as o3d-il7a.
//
// REVERT EVIDENCE (each verified by making that one change and re-running this file):
//   * restoring "every one of which the outbox sender will deliver" to the INVOICE_EMAIL `effect`
//     fails "the record does not promise the queued rows are delivered".
//   * restoring "tell the customer how many copies are on their way" to the `check` fails the same
//     test.
//   * deleting the "no outbox row records the sync attempt that queued it" clause fails "the record
//     says why the query cannot be narrowed".
// ---------------------------------------------------------------------------

test('ROUND 7: the manual send writes the identical row shape, so the query cannot separate them', async () => {
  state.outbox = []
  state.sends = 0

  // The replay's write, through the path the sync processor takes.
  const { sendAccountingInvoiceEmailInternal } = await import('@/lib/accounting-email')
  await sendAccountingInvoiceEmailInternal('order-1')
  const replayed = { ...state.outbox[0] }

  // The operator's own send, through the SHIPPED authenticated action.
  const { sendAccountingInvoiceEmail } = await import('@/app/actions/email')
  const manualResult = await sendAccountingInvoiceEmail('order-1')
  assert.equal(manualResult.success, true, 'the operator action is reachable and writes a row')
  assert.equal(state.outbox.length, 2)
  const manual = { ...state.outbox[1] }

  assert.deepEqual(
    { kind: replayed.kind, referenceType: replayed.referenceType, referenceId: replayed.referenceId },
    { kind: manual.kind, referenceType: manual.referenceType, referenceId: manual.referenceId },
    'the query the record names selects both, and nothing on the row tells them apart',
  )
  for (const row of [replayed, manual]) {
    for (const provenance of ['syncLogId', 'sourceSyncLogId', 'accountingSyncLogId', 'attempt', 'attemptRevision']) {
      assert.ok(!(provenance in row), `no outbox row carries ${provenance}, so attribution is impossible`)
    }
  }
})

test('ROUND 7: the record does not promise the queued rows are delivered, and does not ask for a count', async () => {
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  const description = describeUnpersistedQboPost(
    { entry: { id: 'log-1', type: 'INVOICE_EMAIL', referenceType: 'SalesOrder', referenceId: 'order-1' }, postedExternalId: null },
    new Error('write conflict'),
  )

  assert.doesNotMatch(description, /will deliver/)
  assert.doesNotMatch(description, /WILL be delivered/)
  assert.doesNotMatch(description, /how many copies/)
  assert.doesNotMatch(description, /tell the customer/)

  // The three reasons the rows are only candidates, each of which is a shipped fact.
  assert.match(description, /the authenticated accounting-invoice email action writes the identical shape/)
  assert.match(description, /a SENT row has already gone/)
  // ROUND 8 (Codex HIGH): the FAILED half of this sentence was itself an absolute the data cannot
  // carry — see tests/accounting/outbox-failed-is-not-non-delivery.test.ts, which drives the
  // shipped sender stamping FAILED on a copy the mail server accepted.
  assert.doesNotMatch(description, /a FAILED row never went at all/)
  assert.match(description, /A FAILED ROW IS NOT PROOF THAT NOTHING WENT/)
  assert.match(description, /o3d-il7a/, 'and the work that would make an exact answer possible')
})

test('ROUND 7: the record says why the query cannot be narrowed', async () => {
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  const description = describeUnpersistedQboPost(
    { entry: { id: 'log-1', type: 'INVOICE_EMAIL', referenceType: 'SalesOrder', referenceId: 'order-1' }, postedExternalId: null },
    new Error('write conflict'),
  )
  assert.match(description, /no outbox row records the sync attempt that queued it/)
})

test('ROUND 7: the outbox really does terminalise a row FAILED for a suppressed recipient', async () => {
  // ROUND 8: this is the one FAILED path the record still calls conclusive, and it is conclusive
  // because it runs BEFORE the send. The other FAILED paths are read from the same file below.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const sender = await readFile(path.join(process.cwd(), 'lib/email-outbox.ts'), 'utf8')
  assert.match(sender, /emailSuppression\.findUnique/, 'the suppression lookup')
  assert.match(sender, /status: 'FAILED',\s*\n\s*lastError: `Suppressed recipient/, 'which terminalises the row FAILED')
  assert.match(sender, /const permanentFailure = !!sendResult\.permanent \|\| attempts >= EMAIL_MAX_ATTEMPTS/)
  assert.match(sender, /status: permanentFailure \? 'FAILED' : 'PENDING'/)
})
