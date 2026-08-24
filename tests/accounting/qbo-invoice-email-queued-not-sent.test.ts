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
  assert.match(
    description,
    /WHAT YOU CANNOT DO WHILE QUICKBOOKS IS THE ACTIVE CONNECTOR: settle sync row log-1 by hand/,
    'the step the reader would otherwise trust to end it is named as unavailable, not merely as insufficient',
  )
  // Round 4: unavailable WHILE QUICKBOOKS IS ACTIVE, which is not the same as unavailable. The
  // unqualified sentence hid the only per-row remedy there is.
  assert.doesNotMatch(description, /refuses EVERY QuickBooks row/)
  // Round 5: the condition is a CONJUNCTION — not the active connector AND its sync toggle off,
  // because the manual Sync button gates on the toggle alone. See STEP 6 in
  // tests/accounting/qbo-remedy-is-performable.test.ts, which drives both halves.
  assert.match(description, /THE PER-ROW REMEDY DOES EXIST, BUT IT NEEDS BOTH OF TWO THINGS/)
  assert.match(description, /TURN quickbooks_sync_enabled OFF AS WELL/)
  assert.match(description, /STRANDED SYNC ROWS/)

  // ROUND 3 (Codex HIGH). The instruction this test used to pin — "keep at most the one copy the
  // customer should receive, and cancel the rest", then settle — WAS NOT PERFORMABLE. The outbox has
  // no cancelled state and no operator control removes an unsent row, and the settlement action
  // refuses every QuickBooks row. A remedy has to be a thing an operator can do, so the message now
  // names the impossibility instead of instructing past it.
  assert.doesNotMatch(description, /cancel the rest/, 'there is no operation that cancels a queued copy')
  assert.match(description, /IMS CANNOT CANCEL A QUEUED COPY/)
  assert.match(description, /every copy already queued WILL be delivered/)

  // What survives is the part that IS runnable: the query still has to select the rows the first two
  // tests produced, because counting them and warning the customer is the whole of what can be done.
  for (const fragment of ['kind ACCOUNTING_INVOICE', 'referenceType SalesOrder', 'referenceId = the order id']) {
    assert.ok(
      description.includes(fragment),
      `the query the operator is told to run must name ${fragment}, which is what queueEmail actually writes`,
    )
  }
  assert.match(description, /tell the customer how many copies are on their way/)

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
