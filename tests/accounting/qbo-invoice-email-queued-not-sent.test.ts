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
// outbox; a separate cron delivers it later. So more of the effect is still coming when the operator
// reads the record, and settling the sync row stops the SWEEP while reaching none of what is queued.
// An operator told to "check what was sent" would look at a mail log, see one delivery, settle the
// row, and another copy would arrive afterwards — the settlement reading as the end of the incident
// when it is not.
//
// ROUND 16 (Codex MEDIUM) NARROWED THE PREMISE, AND THE FILE SAYS SO RATHER THAN CARRYING THE OLD
// ONE. It used to pin "one row per call", and o3d-alnk's `email_outbox_undelivered_reference_uq`
// makes that false: a call made while an undelivered copy already exists writes NOTHING and
// `queueEmail` answers `already_queued`. What is true is narrower and is what the tests below pin —
// success means QUEUED-OR-ALREADY-QUEUED, never SENT; at most one UNDELIVERED copy exists at a time;
// and the index's predicate ends at delivery, so a sweep landing after the drain queues another one.
// The operator-facing wording is then pinned against the row shape that premise really produces, so
// the query it tells somebody to run selects the rows the replay actually created.
// ---------------------------------------------------------------------------

type OutboxRow = Record<string, unknown>

const state = {
  outbox: [] as OutboxRow[],
  sends: 0,
}

// ---------------------------------------------------------------------------
// ROUND 16 (Codex MEDIUM): THE DOUBLE USED TO ACCEPT WHAT THE DATABASE REFUSES.
//
// `emailOutbox.create` here blindly appended every row, so this file "proved" three simultaneous
// PENDING copies — a state that can no longer exist. o3d-alnk's `email_outbox_undelivered_reference_uq`
// is a PARTIAL UNIQUE INDEX on (kind, referenceType, referenceId) WHERE status IN
// ('PENDING','PROCESSING') AND referenceType IS NOT NULL AND referenceId IS NOT NULL, and `queueEmail`
// catches the P2002 it raises and answers `already_queued`. A double that accepts what the real table
// refuses cannot prove anything about production, so it models the index instead.
//
// MODELLED EXACTLY AS THE INDEX IS WRITTEN, including the two halves that are easy to drop:
//   * the PREDICATE is the undelivered statuses only — a SENT or FAILED row does not occupy the slot;
//   * the model default is PENDING, so a row that writes no `status` (which is what `queueEmail`
//     does) is UNDELIVERED and does occupy it;
//   * a NULL referenceType or referenceId is outside the index entirely and never collides.
// ---------------------------------------------------------------------------

const UNDELIVERED_UNIQUE_INDEX = 'email_outbox_undelivered_reference_uq'
const UNDELIVERED_STATUSES = new Set(['PENDING', 'PROCESSING'])

/** The index's key for a row, or null when the row falls outside its partial predicate. */
function undeliveredSlot(row: OutboxRow): string | null {
  const status = typeof row.status === 'string' ? row.status : 'PENDING'
  if (!UNDELIVERED_STATUSES.has(status)) return null
  if (row.referenceType == null || row.referenceId == null) return null
  return [row.kind, row.referenceType, row.referenceId].map(String).join('\u0000')
}

/** The P2002 the pg driver adapter raises for that index — the shape `isUndeliveredEmailCollision` reads. */
function undeliveredReferenceCollision(): Error {
  const error = new Error(
    `duplicate key value violates unique constraint "${UNDELIVERED_UNIQUE_INDEX}"`,
  ) as Error & { code: string; meta: unknown }
  error.code = 'P2002'
  error.meta = {
    modelName: 'EmailOutbox',
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23505',
        kind: 'UniqueConstraintViolation',
        constraint: { index: UNDELIVERED_UNIQUE_INDEX },
      },
    },
  }
  return error
}

/** What the outbox drain does to a row, so a test can reach the post-delivery window on purpose. */
function deliver(row: OutboxRow): void {
  row.status = 'SENT'
  row.sentAt = new Date()
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
          const slot = undeliveredSlot(data)
          if (slot !== null && state.outbox.some((row) => undeliveredSlot(row) === slot)) {
            throw undeliveredReferenceCollision()
          }
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

test('ROUND 16: the double refuses the second undelivered row exactly as the shipped index does', async () => {
  // THE DOUBLE IS ONLY WORTH ANYTHING IF ITS REFUSAL IS THE ONE PRODUCTION CLASSIFIES. Both halves
  // are checked against the shipped code rather than assumed: the index name, and the fact that
  // `queueEmail`'s own predicate reads this error as its collision. Without this, the fake could
  // refuse for a reason `queueEmail` would rethrow, and every test below would be proving the wrong
  // control flow.
  const { EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX, isUndeliveredEmailCollision } =
    await import('@/lib/email-outbox')
  assert.equal(UNDELIVERED_UNIQUE_INDEX, EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX)
  assert.equal(isUndeliveredEmailCollision(undeliveredReferenceCollision()), true)

  // And the predicate really is partial: a SENT row frees the slot, a null reference never took one.
  assert.equal(undeliveredSlot({ kind: 'ACCOUNTING_INVOICE', referenceType: 'SalesOrder', referenceId: 'o' }) !== null, true)
  assert.equal(undeliveredSlot({ kind: 'ACCOUNTING_INVOICE', referenceType: 'SalesOrder', referenceId: 'o', status: 'SENT' }), null)
  assert.equal(undeliveredSlot({ kind: 'ACCOUNTING_INVOICE', referenceType: null, referenceId: null }), null)
})

test('ROUND 16: a replay while the first copy is UNDELIVERED adds nothing — the copies come after delivery', async () => {
  // WHAT THIS TEST USED TO SAY: three sweeps, three simultaneous PENDING rows, and that count was
  // also the number of emails the customer would receive. THE DOUBLE MADE THAT UP. The shipped table
  // refuses calls two and three with P2002 and `queueEmail` answers `already_queued`, so the premise
  // — and the operator guidance built on it — was stale while this file stayed green. It is the
  // defect class this branch exists for, so the conclusion is restated rather than the count patched.
  //
  // THE CONCLUSION CHANGED. Copies do NOT pile up undelivered; a sweep that lands while one is still
  // PENDING or PROCESSING queues nothing at all. What survives is the hazard the verdict rests on:
  // the predicate ENDS AT DELIVERY, so the first sweep after the drain has sent a copy queues
  // another one, and nothing bounds how often that repeats.
  state.outbox = []
  state.sends = 0

  const { sendAccountingInvoiceEmailInternal } = await import('@/lib/accounting-email')
  const first = await sendAccountingInvoiceEmailInternal('order-1')
  const second = await sendAccountingInvoiceEmailInternal('order-1')
  const third = await sendAccountingInvoiceEmailInternal('order-1')

  assert.deepEqual(
    [first.success, second.success, third.success],
    [true, true, true],
    'all three sweeps still report SUCCESS — the refusal is invisible to the caller, which is why '
    + 'nothing upstream can be built on it',
  )
  assert.equal(state.outbox.length, 1, 'and only ONE row exists: the index refused the other two')
  assert.equal(state.sends, 0, 'still nothing reached the mailer')

  // THE PRECONDITION WAS REACHED, not assumed: the surviving row is the undelivered one, so the two
  // refusals were the index doing its job rather than the fake never being called.
  assert.equal(undeliveredSlot(state.outbox[0]) !== null, true, 'the surviving row occupies the index slot')

  // NOW THE DRAIN RUNS. The slot is freed by DELIVERY, and the very next sweep queues another copy —
  // this is the window the partial predicate leaves open, and the whole reason xero/accounting.post
  // is unsafe-to-replay.
  deliver(state.outbox[0])
  const afterDelivery = await sendAccountingInvoiceEmailInternal('order-1')
  assert.equal(afterDelivery.success, true)
  assert.equal(state.outbox.length, 2, 'a sweep after delivery queues a SECOND copy — the customer is emailed twice')

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

  // ROUND 16: THE DRAIN RUNS BETWEEN THEM, AND IT HAS TO. Both writes are the identical shape, so
  // `email_outbox_undelivered_reference_uq` refuses the second while the first is still undelivered
  // — this test would otherwise be asserting about a row the database never accepted. Delivering the
  // first is also the realistic case: the finding is that the two are indistinguishable in a query
  // an operator runs AFTER the fact, and by then a queued copy has long since been sent.
  deliver(state.outbox[0])

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
  // ROUND 9: this branch is still real and still runs before the send — what changed is that the
  // record no longer calls it CONCLUSIVE, because it runs before THIS retry's send and reads
  // nothing about the attempts before it. See
  // tests/accounting/outbox-failed-is-not-non-delivery.test.ts, which drives a delivered copy into
  // this very branch. The other FAILED paths are read from the same file below.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const sender = await readFile(path.join(process.cwd(), 'lib/email-outbox.ts'), 'utf8')
  assert.match(sender, /emailSuppression\.findUnique/, 'the suppression lookup')
  assert.match(sender, /status: 'FAILED',\s*\n\s*lastError: `Suppressed recipient/, 'which terminalises the row FAILED')
  // o3d-alnk r7 moved the READ of the sender's answer above the branch — every field of
  // `sendResult` is now taken once and used from a local, so a caller-supplied sender cannot
  // answer differently on the second read. The claim this guard makes is unchanged, so BOTH
  // halves are asserted: where the permanence flag comes FROM, and what it decides. Asserting
  // only the second would let the derivation be quietly dropped.
  // r22 moved the coercion INTO the single reading: `smtp.send` freezes a snapshot of the four
  // fields, so `sendResult` is this module's own object and `reportedPermanent` is a plain read of
  // it. Both halves are still asserted — where the flag comes FROM, and where it was normalised —
  // because asserting only the local would let the derivation be quietly dropped.
  assert.match(sender, /const reportedPermanent = sendResult\.permanent/, "the sender's own permanence flag")
  assert.match(
    sender,
    /permanent: answer\.permanent === true,/,
    "the permanence flag is no longer normalised inside the wrapper that takes the sender's one reading",
  )
  assert.match(sender, /const permanentFailure = reportedPermanent \|\| attempts >= EMAIL_MAX_ATTEMPTS/)
  assert.match(sender, /status: permanentFailure \? 'FAILED' : 'PENDING'/)
})

// ---------------------------------------------------------------------------
// ROUND 18 (Codex MEDIUM) — THE CADENCE IN THAT SENTENCE IS READ OUT OF THE REPO.
//
// Round 16 replaced one false count ("one more PENDING row per sweep") with another: "the outbox
// cron empties PENDING in minutes" and "each sweep finds nothing undelivered and queues one more".
// Both were ASSERTED FROM MEMORY, and both are wrong the alarming way round — the accounting sweep
// is the five-minute job and the outbox drain is the HOURLY one, so most sweeps queue nothing and
// a further copy is paced by the DRAIN.
//
// A premise asserted rather than grepped is the defect this test exists to stop repeating, so the
// two cadences are READ OUT OF THE FILES THAT CONFIGURE THEM and the sentence is checked against
// what they say. Change either schedule and this fails rather than drifting: an unmapped cron
// expression is a loud failure, because a new cadence means the sentence has to be read again.
// ---------------------------------------------------------------------------

/** The cron expressions this sentence has words for. An unmapped one must fail, not be guessed. */
const SWEEP_CADENCE_WORDS: Record<string, string> = {
  '*/5 * * * *': 'every five minutes',
  '*/15 * * * *': 'every fifteen minutes',
  '0 * * * *': 'hourly',
}

/** The same, for the documented cadence column of the outbox drain. */
const DRAIN_CADENCE_WORDS: Record<string, string> = {
  Hourly: 'hourly',
  'Every 5 min': 'every five minutes',
  'Every 15 min': 'every fifteen minutes',
}

test('r18: the sentence\'s cadences match the cron config and the cron doc, and are not recalled', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

  // (1) THE SWEEP. `accounting-sync` is the job that drains the pending accounting queue and so is
  // the job that re-runs this operation.
  const cronJobs = readFileSync(`${repoRoot}lib/cron-jobs/xero.ts`, 'utf8')
  const sweep = /slug: 'accounting-sync',[\s\S]*?defaultSchedule: '([^']+)'/.exec(cronJobs)
  assert.ok(sweep, 'lib/cron-jobs/xero.ts no longer declares an accounting-sync defaultSchedule — the walk found nothing to read')
  const sweepWords = SWEEP_CADENCE_WORDS[sweep[1]]
  assert.ok(sweepWords, `accounting-sync now runs on '${sweep[1]}', which this sentence has no words for — re-read it`)

  // (2) THE DRAIN. The email outbox is called by the operator's cron daemon and has no registry
  // entry, so the repo's only statement of its cadence is the cron table in the settings doc.
  const settingsDoc = readFileSync(`${repoRoot}help-docs/settings.md`, 'utf8')
  const drain = /^\|\s*`\/api\/cron\/email-outbox`\s*\|[^|]*\|\s*([^|]+?)\s*\|/m.exec(settingsDoc)
  assert.ok(drain, 'help-docs/settings.md no longer carries a cron-table row for /api/cron/email-outbox')
  const drainWords = DRAIN_CADENCE_WORDS[drain[1]]
  assert.ok(drainWords, `the outbox drain is now documented as '${drain[1]}', which this sentence has no words for — re-read it`)

  // (3) THE SENTENCE, against those two readings.
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  const description = describeUnpersistedQboPost(
    { entry: { id: 'log-1', type: 'INVOICE_EMAIL', referenceType: 'SalesOrder', referenceId: 'order-1' }, postedExternalId: null },
    new Error('write conflict'),
  )
  assert.match(
    description,
    new RegExp(`this sweep is scheduled ${sweepWords} and the outbox drain is scheduled ${drainWords}`),
    `the record's cadences do not match the repo's: sweep ${sweep[1]}, drain ${drain[1]}`,
  )

  // AND NO OTHER CADENCE IS NAMED ANYWHERE IN THE RECORD (round 33). The match above is EXISTENTIAL:
  // it finds the corrected sentence and says nothing about a second cadence sentence sitting beside
  // it, which is the whole-file weakness round 33's HIGH was about. This arm is UNIVERSAL over the
  // rendered record — every cadence this walk has words for, other than the two it resolved, must be
  // absent — so a stale "the drain runs every five minutes" added elsewhere in the record fails here
  // instead of being excused by the corrected sentence.
  const namedCadences = new Set([sweepWords, drainWords])
  for (const words of new Set([...Object.values(SWEEP_CADENCE_WORDS), ...Object.values(DRAIN_CADENCE_WORDS)])) {
    if (namedCadences.has(words)) continue
    assert.doesNotMatch(
      description,
      new RegExp(words),
      `the record names the cadence "${words}", which is neither the sweep's (${sweepWords}) nor the `
      + `drain's (${drainWords}) — one of the two statements in it is stale and a reader cannot tell which`,
    )
  }

  // And the two round-16 claims are gone rather than merely joined by a correction.
  assert.doesNotMatch(description, /empties PENDING in minutes/)
  assert.doesNotMatch(description, /each sweep finds nothing undelivered and queues one more/)
  assert.doesNotMatch(description, /on every sweep that runs once the copy before it has been delivered/)

  // THE VERDICT IS UNCHANGED AND MUST STAY: what makes this unsafe to replay is repetition after
  // the row is settled, not the rate at which it repeats.
  assert.match(description, /ANOTHER COPY OF THE INVOICE EMAIL IS QUEUED TO THE CUSTOMER/)
  assert.match(description, /the refusal lifts only when a drain settles that row to SENT or FAILED/)
})

// ---------------------------------------------------------------------------
// ROUND 20 (Codex MEDIUM) — THE SAME RATIONALE, IN THE OTHER TWO FILES THAT STATE IT.
//
// The round-18 test above walks ONE sentence, in `unrecorded-posted-document.ts`. Round 19 found the
// SAME false premise still standing in `lib/domain/integrations/outbox-registry.ts` and in
// `tests/concurrency/outbox-stale-park.concurrent.test.ts`: both said the email drain empties PENDING
// inside the reclaim window, so worker A's copy is "typically already SENT" when B replays. It is the
// other way round — the reclaim window is FIFTEEN MINUTES (`INTEGRATION_OUTBOX_DRAIN_LEASES_MS`
// `.xeroAccountingEntry`, the `staleLockMs` the Xero drain passes) and the drain is HOURLY — so B's
// replay
// usually meets a copy that is still PENDING, and the partial unique index refuses it. The verdict
// (unsafe-to-replay) is unchanged; the operational story was wrong.
//
// The reason the round-18 test exists is that a premise asserted from memory drifts. This MEDIUM is
// that drift happening in files the test did not walk, so the walk is widened to reach them, and it
// ASSERTS IT REACHED THEM: a renamed file or a rewritten paragraph fails here rather than passing by
// finding nothing.
//
// It also resolves the CITATIONS. Round 19's LOW was a comment citing `help-docs/settings.md:338`
// for a row at 336 — a line number falsified by any edit above it. Those citations are now greppable
// anchors, and this test resolves every one of them in the file it names.
// ---------------------------------------------------------------------------

/** Milliseconds this rationale has words for. An unmapped window must fail, not be guessed. */
const RECLAIM_WINDOW_WORDS: Record<string, string> = {
  '600000': 'TEN MINUTES',
  '900000': 'FIFTEEN MINUTES',
  '1200000': 'TWENTY MINUTES',
  '1500000': 'TWENTY-FIVE MINUTES',
  '3600000': 'ONE HOUR',
}

/** The documented drain cadence, as milliseconds, so the two can be compared as durations. */
const DRAIN_CADENCE_MS: Record<string, number> = {
  Hourly: 3_600_000,
  'Every 5 min': 300_000,
  'Every 15 min': 900_000,
  Daily: 86_400_000,
}

/**
 * A citation the cadence comment makes: the file that makes it, the file it names, and the string
 * that must exist there. No line numbers — that is the point.
 */
const CITATIONS: Array<{ citedIn: string; citation: string; resolvesIn: string; anchor: string }> = [
  {
    citedIn: 'lib/domain/accounting/unrecorded-posted-document.ts',
    citation: 'lib/cron-jobs/xero.ts, the `slug: \'accounting-sync\'` entry',
    resolvesIn: 'lib/cron-jobs/xero.ts',
    anchor: "slug: 'accounting-sync',",
  },
  {
    citedIn: 'lib/domain/accounting/unrecorded-posted-document.ts',
    citation: 'help-docs/settings.md lists its `/api/cron/accounting-sync` cron-table row as "Every 5 min"',
    resolvesIn: 'help-docs/settings.md',
    anchor: '| `/api/cron/accounting-sync` | Drain pending accounting sync queue | Every 5 min |',
  },
  {
    citedIn: 'lib/domain/accounting/unrecorded-posted-document.ts',
    citation: 'the `/api/cron/email-outbox` cron-table row — the only cadence for it in the repo',
    resolvesIn: 'help-docs/settings.md',
    anchor: '| `/api/cron/email-outbox` | Send queued emails | Hourly |',
  },
  {
    citedIn: 'lib/domain/integrations/outbox-registry.ts',
    citation: '`xeroAccountingEntry` in\n    //      lib/domain/integrations/outbox-leases.ts',
    resolvesIn: 'lib/domain/integrations/outbox-leases.ts',
    anchor: 'xeroAccountingEntry:',
  },
  {
    citedIn: 'tests/concurrency/outbox-stale-park.concurrent.test.ts',
    citation: '`xeroAccountingEntry` in lib/domain/integrations/outbox-leases.ts',
    resolvesIn: 'lib/domain/integrations/outbox-leases.ts',
    anchor: 'xeroAccountingEntry:',
  },
]

// ---------------------------------------------------------------------------
// ROUND 33 (Codex HIGH) — THE CADENCE GUARD WAS WHOLE-FILE, WHICH IS THE DEFECT IT EXISTS TO CATCH.
//
// Section (4) below used to be a loop of `text.includes(...)` over each file ENTIRE. So it passed
// while `outbox-registry.ts` said, in the INVOICE_EMAIL counterexample paragraph, that worker B
// reclaims after fifteen minutes and that "Both are delivered" — because the SAME FILE, forty lines
// further down, established the drain condition the first paragraph had dropped.
// (ROUND 33 ALSO DECIDED THE TWO PARAGRAPHS DISAGREED ABOUT THE NUMBER AND "CORRECTED" THE WRONG ONE
// — see round 34 below: fifteen was right.)
// A whole-file `includes` cannot tell "the file states
// the corrected claim" from "the file states the corrected claim SOMEWHERE, next to the stale one":
// the stale claim and its own correction both live in the file, and every assertion was satisfied by
// the correction while a reader met the staleness first. That is the third round in a row this exact
// shape has got through, so the guard is converted rather than patched.
//
// SO THE UNIT OF CHECKING IS THE PARAGRAPH, NOT THE FILE — the same treatment round 31 gave the
// four-site residue claims in tests/email-outbox-claim-fence.test.ts. Each site is one comment
// PARAGRAPH, located by an anchor that must match EXACTLY ONE paragraph and whose block must be a
// substantial one, and at that site:
//   * A SENTENCE THERE STATES THE CORRECTED CLAIM — the duplicate needs the timing to CROSS A DRAIN
//     — and every sentence that says "crosses a drain" is a sentence about the duplicate, so the
//     qualifier cannot be stranded in a paragraph away from the claim it qualifies;
//   * NO SENTENCE THERE ASSERTS AN UNCONDITIONAL SECOND DELIVERY. "Both are delivered", with no
//     drain condition in the same sentence, is refused AT THAT SITE rather than excused by a
//     correction elsewhere in the file;
//   * NO SENTENCE THERE NAMES ANY DURATION WITHOUT NAMING THE SOURCE THAT DURATION RESOLVES FROM, in
//     either case (round 34; until then the exception was the WORD "lease", and that is what let the
//     dead-letter gate in — and round 35, which removed the last value exemption and made the
//     durations themselves be FOUND rather than enumerated).
//
// AND THE CLAIM IS MADE ONLY AT THOSE SITES. A file-wide sweep requires every paragraph of these two
// files that names ANY duration AT ALL (round 35: found by shape, not drawn from a list) to be one of
// the located sites, or to name the source that duration resolves from, so a window claim that drifts
// into an unwatched paragraph fails here instead of being a fourth round of the same finding.
//
// ---------------------------------------------------------------------------
// ROUND 34 (Codex HIGH 1) — THE GUARD ROUND 33 ADDED WAS ENFORCING A NUMBER NOTHING PRODUCES.
//
// Round 33 sourced `reclaimMs` from `ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS` and rewrote both copies of
// the prose to TWENTY MINUTES to match. That constant's own contract says its exclusive consumer is
// `permanentlyFailIntegrationOutboxAdminRow` — an admin DEAD-LETTERING a row by hand. It reclaims
// nothing. The window worker B waits is the `staleLockMs` handed to `claimIntegrationOutboxWork`, and
// for `xero/accounting.post` that is `CLAIM_STALE_MS` =
// `INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry` = 900_000 ms = FIFTEEN MINUTES. So the
// pre-round-33 statement was CORRECT, and for one round this guard REQUIRED the false number and would
// have REJECTED the true one. A guard enforcing a wrong value is worse than no guard.
//
// TWO WINDOWS DESCRIBED IN IDENTICAL ENGLISH IS THE ROOT CAUSE, AND IT HAS NOW DONE THIS THREE TIMES
// ON THIS BRANCH. `lib/email-outbox.ts` has its own fifteen minutes (`EMAIL_CLAIM_STALE_MS`, and
// correct); the leases map has fifteen; the dead-letter gate has twenty. All three read as "a row goes
// stale after N minutes". So the rule this round installs is not about any number: EVERY duration the
// prose asserts must name the constant it comes from IN THE PROSE, and this guard resolves that
// constant rather than trusting the number beside it. See `assertDurationsAreSourced`.
//
// WHAT THIS DOES NOT ESTABLISH, stated because that is what this round is about. (i) Double-quoted
// spans are removed before sentences are examined, because quoting is how these files DISOWN a claim
// ("This used to say …"); an overclaim written inside double quotes would pass. (ii) The sweep is
// over DURATIONS only (round 35: every duration, by shape), not over delivery claims, so a paragraph
// outside the three sites that asserts an unconditional second delivery while naming no window at all
// is not reached — the stale-park test's own "Round 3 asserted that … and both are delivered"
// paragraph is exactly that shape, and it is past-tense disowning rather than asserting. (iii) It is
// a check on WORDING. That the wording is TRUE of the code is what sections (1)-(3) above establish,
// out of the constants.

/** Every PARAGRAPH of comment prose in a file: a run of comment lines, split on blank comment lines. */
function commentParagraphs(source: string): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  const flush = () => {
    const prose = current.join(' ').replace(/\s+/g, ' ').trim()
    if (prose.length > 0) paragraphs.push(prose)
    current = []
  }
  for (const line of source.split('\n')) {
    const comment = /^\s*(?:\/\/+|\/\*\*?|\*\/|\*)\s?(.*)$/.exec(line)
    if (!comment) {
      flush()
      continue
    }
    const text = comment[1].replace(/\*\/\s*$/, '').trim()
    if (text.length === 0) {
      flush()
      continue
    }
    current.push(text)
  }
  flush()
  return paragraphs
}

/** Sentences of a paragraph, with double-quoted spans removed — see (i) above for why. */
function windowSentences(prose: string): string[] {
  return prose
    .replace(/"[^"]*"/g, ' ')
    .split(/(?<=\.)\s+(?=[A-Z"`([])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

// ---------------------------------------------------------------------------
// ROUND 35 (Codex HIGH 1) — THE RULE ROUND 34 WROTE DID NOT ENFORCE ITSELF.
//
// Round 34 installed the rule "EVERY duration a sentence names must name the constant it resolves
// from" and then implemented it as a loop over the durations round 34 had ALREADY LISTED — and
// skipped the `900_000` numeral outright, which is the very window the rule exists to police. So the
// guard claimed "every duration" and enforced "the ones I enumerated, minus one": an unsourced
// `900_000 ms`, an unsourced `960_000 ms` and the words "sixteen minutes" all walked through it. That
// is the same shape this branch has spent a dozen rounds removing from its other guards, reproduced
// inside the rule written to stop it, one round after writing it.
//
// SO DURATIONS ARE FOUND BY SHAPE AND NOT BY LIST. `durationsNamedIn` matches a NUMERAL with a unit
// (`900_000 ms`, `1_200_000 ms`, `24 hours`, `15 min`) and a SPELLED-OUT quantity with a unit
// ("fifteen minutes", "sixteen minutes", "five-minute", "an hour", "twenty-five minutes"), resolves
// each to milliseconds, and the caller then requires the SAME SENTENCE to name a source that resolves
// to that same number. No value is exempt: a number nothing in this build produces fails for having
// no source at all, and a number this build does produce fails unless the sentence says which
// constant — or which documented cron row — it came from.
//
// THE TWO EXEMPTIONS ARE KEYED ON GRAMMAR AND NEVER ON A VALUE. (i) An article plus the SINGULAR
// "second" ("a second row", "the second claimant", "emailed a second time") is the English ORDINAL,
// not one thousand milliseconds: "second" is the only unit noun in this vocabulary that is also an
// ordinal, the prose uses it that way about fifteen times, and nothing in these two files states a
// duration in seconds. (ii) An article plus a PLURAL unit ("the minutes the comments claim") is a
// noun phrase, not a quantity. "one second", "two seconds", "an hour", "a day" and "the hour" all
// remain durations, and every numeral form is checked whatever its value.

/** Unit nouns a duration may be written in, and what ONE of each is in milliseconds. */
const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
}

/** Spelled-out quantities, the articles included: "an hour" and "the hour" both state a duration. */
const DURATION_QUANTITY: Record<string, number> = {
  a: 1, an: 1, the: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}

const DURATION_UNITS = Object.keys(DURATION_UNIT_MS).sort((a, b) => b.length - a.length).join('|')
const DURATION_QUANTITIES = [
  // The hyphenated compounds first, so "twenty-five minutes" is read as 25 and not as 20.
  ...['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'].flatMap((tens) =>
    ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
      .map((ones) => `${tens}[- ]${ones}`)),
  ...Object.keys(DURATION_QUANTITY).sort((a, b) => b.length - a.length),
].join('|')

/** `900_000 ms`, `24 hours`, `15 min`, `24-hour`. */
const NUMERAL_DURATION = new RegExp(String.raw`\b(\d[\d_,]*)[- ]?(${DURATION_UNITS})\b`, 'gi')
/** "fifteen minutes", "an hour", "five-minute", "twenty-five minutes". */
const SPELLED_DURATION = new RegExp(String.raw`\b(${DURATION_QUANTITIES})[- ](${DURATION_UNITS})\b`, 'gi')
/** The ordinal, which is not a duration — an exemption on the SHAPE, never on a value. */
const ORDINAL_SECOND = /^(?:a|an|the)[- ]second$/i
/**
 * An article with a PLURAL unit is a noun phrase and not a quantity: "the minutes the comments
 * claim", "the days this took". The second and last shape exemption, and like the first it is keyed
 * on grammar rather than on any number — "an hour", "a day" and "the hour" are all still durations.
 */
const ARTICLE_PLUS_PLURAL = /^(?:a|an|the)[- ](?:milliseconds|secs|seconds|mins|minutes|hrs|hours|days)$/i

/** EVERY DURATION A SENTENCE NAMES, found by shape. Nothing here is a list of expected values. */
function durationsNamedIn(sentence: string): Array<{ text: string; ms: number }> {
  const found: Array<{ text: string; ms: number }> = []
  for (const match of sentence.matchAll(NUMERAL_DURATION)) {
    const scale = DURATION_UNIT_MS[match[2].toLowerCase()]
    found.push({ text: match[0], ms: Number(match[1].replace(/[_,]/g, '')) * scale })
  }
  for (const match of sentence.matchAll(SPELLED_DURATION)) {
    if (ORDINAL_SECOND.test(match[0]) || ARTICLE_PLUS_PLURAL.test(match[0])) continue
    let quantity = 0
    for (const word of match[1].toLowerCase().split(/[- ]/)) quantity += DURATION_QUANTITY[word] ?? 0
    found.push({ text: match[0], ms: quantity * DURATION_UNIT_MS[match[2].toLowerCase()] })
  }
  return found
}

/** A sentence that says a second copy of the email goes out. */
const ASSERTS_A_SECOND_DELIVERY =
  /both are delivered|both were delivered|both get delivered|delivered twice|emailed twice|emailed a second time|a second (?:copy|email) (?:is|was) delivered/i
/** …and the condition the corrected claim puts on it. */
const DRAIN_CONDITION = /crosses a drain|once a drain|after a drain|when the timing|outside the predicate/i
/** The corrected claim itself, as both copies state it. */
const CROSSES_A_DRAIN = /crosses a drain/i
/** A sentence that is about the duplicate, whatever words it uses. */
const ABOUT_THE_DUPLICATE = /duplicate|second (?:row|copy|email|time)|emailed a second|invoice twice/i
/**
 * ROUND 34 (Codex HIGH 1) — THE EXCEPTION USED TO BE A WORD, AND THAT IS WHY THE WRONG NUMBER GOT IN.
 *
 * Until this round a sentence was allowed to name a duration other than the resolved reclaim window
 * if the sentence mentioned the word "lease". That let round 33 do the damage it did: it re-sourced
 * `reclaimMs` from `ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS` — whose own contract says its ONE consumer
 * is `permanentlyFailIntegrationOutboxAdminRow`, an admin dead-lettering a row by hand — and then
 * made this guard enforce that twenty-minute number across both copies of the rationale. The window
 * a reclaim actually waits is the `staleLockMs` the Xero drain passes to `claimIntegrationOutboxWork`,
 * which is `INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry`: FIFTEEN minutes. The original
 * fifteen-minute statement was right, the "correction" was wrong, and a guard enforcing a wrong value
 * is worse than no guard — it REQUIRED the false sentence and REJECTED the true one.
 *
 * Both windows are stated in identical English ("a PROCESSING row goes stale after N minutes"), which
 * is the third time on this branch that two windows so described have produced a wrong edit. So the
 * rule is no longer about a word: EVERY duration a sentence names must name, in that same sentence,
 * the constant (or documented row) it comes from — and that source must really RESOLVE to the
 * duration named, because the resolved value is what supplies the words. A number with no named
 * source is refused, and a number with the wrong named source is refused too.
 */
const DEAD_LETTER_GATE = /dead-letter|dead-lettering|DEAD-LETTER/i

/**
 * The PARAGRAPHS that state this rationale. Two copies of it, three paragraphs: the counterexample
 * that tells the duplication story, and — in each file — the paragraph that derives the window from
 * the constants. The story paragraph is the one round 33 found stale; it is a site precisely because
 * it makes the claim, and a paragraph that makes the claim has to carry the bound on it.
 */
const WINDOW_CLAIM_SITES = [
  {
    name: 'outbox-registry.ts, the INVOICE_EMAIL counterexample paragraph',
    file: 'lib/domain/integrations/outbox-registry.ts',
    anchor: 'INVOICE_EMAIL is the counterexample that decides the entry',
    derivesTheWindow: false,
  },
  {
    name: 'outbox-registry.ts, the cadence derivation (database fact 1)',
    file: 'lib/domain/integrations/outbox-registry.ts',
    anchor: 'THE CADENCES IN THIS PARAGRAPH WERE THE WRONG WAY ROUND',
    derivesTheWindow: true,
  },
  {
    name: 'outbox-stale-park.concurrent.test.ts, the cadence derivation',
    file: 'tests/concurrency/outbox-stale-park.concurrent.test.ts',
    anchor: 'Those come apart at the only moment that matters',
    derivesTheWindow: true,
  },
] as const

/** The one paragraph of `source` carrying `anchor`. Exactly one, and a substantial one. */
function locateWindowSite(
  source: string,
  site: { name: string; anchor: string },
): { prose: string; sentences: string[] } {
  const matching = commentParagraphs(source).filter((prose) => prose.includes(site.anchor))
  assert.equal(
    matching.length,
    1,
    `${site.name}: its anchor (${site.anchor}) matched ${matching.length} comment paragraphs, not 1 — the `
    + 'paragraph was rewritten, split or deleted, so nothing below checked the claim it is supposed to make',
  )
  assert.ok(
    matching[0].length > 400,
    `${site.name}: its paragraph is only ${matching[0].length} characters, which is not the rationale this `
    + 'guard reads — a stub would satisfy the absence checks below by holding no prose at all',
  )
  const sentences = windowSentences(matching[0])
  assert.ok(
    sentences.length > 2,
    `${site.name}: only ${sentences.length} sentence(s) were parsed out of it`,
  )
  return { prose: matching[0], sentences }
}

test('r22: the reclaim window is the RESOLVED constant, and BOTH copies of the rationale say so', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const read = (relative: string) => readFileSync(`${repoRoot}${relative}`, 'utf8')

  // (1) THE RECLAIM WINDOW, TAKEN FROM THE CONSTANT THE WORKER ACTUALLY PASSES (round 34, Codex HIGH 1).
  //
  // ROUNDS 21 AND 33 BOTH TOOK IT FROM `ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS`, AND THAT IS THE DEFECT
  // THIS ROUND REMOVES. That constant's own contract says its one consumer is
  // `permanentlyFailIntegrationOutboxAdminRow`: how old a PROCESSING lock must be before an ADMIN may
  // DEAD-LETTER the row under it. It reclaims nothing. What re-takes a PROCESSING
  // `xero/accounting.post` row is `claimIntegrationOutboxWork`, and the `staleLockMs` it is given for
  // that operation is `CLAIM_STALE_MS` in lib/connectors/xero/sync-processor.ts — which is
  // `INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry`, 900_000 ms, FIFTEEN MINUTES. So the
  // ORIGINAL fifteen-minute statement in both copies of the rationale was CORRECT, round 33's
  // twenty-minute "correction" was not, and this guard spent a round requiring the false number and
  // rejecting the true one.
  //
  // The window is therefore taken from the lease map, and the coupling to the worker is asserted out
  // of the worker's own source below — because "which value reaches that parameter" is the fact the
  // prose asserts, and importing a constant cannot establish it: a future edit that gives the Xero
  // drain a `staleLockMs` of its own would leave this number right and both copies of the prose wrong.
  const { ADMIN_OUTBOX_POST_LEASE_MARGIN_MS, ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS } =
    await import('@/lib/domain/integrations/outbox-admin')
  const { INTEGRATION_OUTBOX_DRAIN_LEASES_MS, INTEGRATION_OUTBOX_MAX_LEASE_MS } =
    await import('@/lib/domain/integrations/outbox-leases')

  const reclaimMs: number = INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry

  // THE WORKER REALLY PASSES IT. One declaration of `CLAIM_STALE_MS`, sourced from the lease map, and
  // one `claimIntegrationOutboxWork` call that hands it over as `staleLockMs`.
  const worker = read('lib/connectors/xero/sync-processor.ts')
  assert.equal(
    [...worker.matchAll(/^const CLAIM_STALE_MS = INTEGRATION_OUTBOX_DRAIN_LEASES_MS\.xeroAccountingEntry$/gm)].length,
    1,
    'lib/connectors/xero/sync-processor.ts no longer declares exactly one `CLAIM_STALE_MS` sourced from '
    + '`INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry`, so the window both copies of the '
    + 'rationale state is no longer derived from the constant the drain passes — which is exactly how '
    + 'rounds 21 and 33 came to state the DEAD-LETTER GATE instead',
  )
  const claimCalls = [...worker.matchAll(/await claimIntegrationOutboxWork\(\{([\s\S]*?)\n  \}\)/g)]
  assert.equal(
    claimCalls.length,
    1,
    `lib/connectors/xero/sync-processor.ts makes ${claimCalls.length} claimIntegrationOutboxWork calls, `
    + 'not 1, so the lease this rationale rests on is no longer the only one this worker takes',
  )
  assert.match(
    claimCalls[0][1],
    /staleLockMs: CLAIM_STALE_MS,/,
    'the Xero drain no longer passes `CLAIM_STALE_MS` as its `staleLockMs`, so the reclaim window both '
    + 'copies of the rationale state is not the one a reclaim waits',
  )
  assert.match(
    claimCalls[0][1],
    /operation: XERO_ACCOUNTING_POST_OPERATION,/,
    'that claim is no longer scoped to `xero/accounting.post`, which is the operation the rationale is about',
  )

  // AND THE DEAD-LETTER GATE IS STILL A DIFFERENT, LONGER WINDOW. Kept — its derivation is a real
  // check, it was simply never the reclaim window. Both copies of the prose now name it as the other
  // window on purpose, so that it cannot be substituted for this one a fourth time.
  const deadLetterMs = ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS
  assert.equal(
    deadLetterMs,
    INTEGRATION_OUTBOX_MAX_LEASE_MS + ADMIN_OUTBOX_POST_LEASE_MARGIN_MS,
    'the dead-letter gate is no longer the maximum lease plus the post-lease margin — re-read both copies '
    + 'of the rationale, which name it as a number',
  )
  assert.ok(
    deadLetterMs > reclaimMs,
    `the dead-letter gate (${deadLetterMs}ms) is no longer LONGER than the reclaim window (${reclaimMs}ms), `
    + 'so an admin can bury a row whose worker is still inside its lease (o3d-zdvn) — and both copies of '
    + 'the prose say the gate is the longer of the two',
  )
  assert.notEqual(
    reclaimMs,
    deadLetterMs,
    'the reclaim window and the dead-letter gate are now the SAME number, so nothing here can tell round '
    + "33's mistake from the truth any more, and both copies of the prose describe two windows that are one",
  )

  // AND THE MAXIMUM REALLY IS THE MAXIMUM OF THE DECLARED MAP — read out of the source, not recalled,
  // so the constant cannot quietly stop being derived from the leases it is supposed to cover.
  const leases = read('lib/domain/integrations/outbox-leases.ts')
  const leaseLiterals = [...leases.matchAll(/^\s{2}(\w+):\s*([\d_]+),$/gm)].map((m) => ({
    name: m[1],
    ms: Number(m[2].replace(/_/g, '')),
  }))
  assert.ok(
    leaseLiterals.length >= 2,
    `the walk found ${leaseLiterals.length} lease literals in outbox-leases.ts — it read nothing, so nothing below is proven`,
  )
  assert.equal(
    INTEGRATION_OUTBOX_MAX_LEASE_MS,
    Math.max(...leaseLiterals.map((lease) => lease.ms)),
    'INTEGRATION_OUTBOX_MAX_LEASE_MS is no longer the maximum of the declared lease map',
  )

  const reclaimWords = RECLAIM_WINDOW_WORDS[String(reclaimMs)]
  assert.ok(
    reclaimWords,
    `the reclaim window is now ${reclaimMs}ms, which this rationale has no words for — re-read both copies of it`,
  )

  // (2) THE DRAIN CADENCE, out of the cron table — the repo's only statement of it.
  const drainRow = /^\|\s*`\/api\/cron\/email-outbox`\s*\|[^|]*\|\s*([^|]+?)\s*\|/m.exec(read('help-docs/settings.md'))
  assert.ok(drainRow, 'help-docs/settings.md no longer carries a cron-table row for /api/cron/email-outbox')
  const drainMs = DRAIN_CADENCE_MS[drainRow[1]]
  assert.ok(drainMs, `the drain is now documented as '${drainRow[1]}', which this rationale has no words for`)

  // (3) THE ORDERING THE RATIONALE RESTS ON. Everything below is prose about this one inequality.
  assert.ok(
    reclaimMs < drainMs,
    `the rationale says the reclaim window (${reclaimMs}ms) is INSIDE the drain interval (${drainMs}ms); it is not, so both copies are wrong again`,
  )

  // (4) BOTH COPIES, CHECKED AGAINST THAT READING — SITE BY SITE, NOT WHOLE-FILE (round 33 HIGH).
  //
  // See the block above WINDOW_CLAIM_SITES for why this is a walk over paragraphs: the whole-file
  // version of this loop passed over a paragraph that asserted an unconditional second delivery
  // because a later paragraph in the same file named the drain condition.
  const groupOf = (ms: number) => String(ms).replace(/\B(?=(\d{3})+(?!\d))/g, '_')
  const grouped = groupOf(reclaimMs)
  // THE RECONCILE CADENCE, out of the same cron table. The WooCommerce entry's prose states it as a
  // duration ("once a day", "up to 24 hours"), and round 35's sweep finds durations by shape, so this
  // one now has to RESOLVE as well — an unsourced day in that paragraph was invisible to round 34's
  // enumeration, which had no entry for 86_400_000 at all.
  const reconcileRow =
    /^\|\s*`\/api\/cron\/wc-reconcile`\s*\|[^|]*\|\s*([^|]+?)\s*\|/m.exec(read('help-docs/settings.md'))
  assert.ok(
    reconcileRow,
    'help-docs/settings.md no longer carries a cron-table row for /api/cron/wc-reconcile',
  )
  const reconcileMs = DRAIN_CADENCE_MS[reconcileRow[1]]
  assert.ok(
    reconcileMs,
    `the reconcile is now documented as '${reconcileRow[1]}', which this rationale has no words for`,
  )

  // EVERY SOURCE A DURATION IN THIS PROSE MAY RESOLVE FROM (round 34, HIGH 1; made the only list in
  // round 35, HIGH 1).
  //
  // The ms come from the constants and the cron table, never from this list, so the pairing cannot
  // drift: change a constant and the number it supplies changes with it. THIS IS A LIST OF SOURCES AND
  // NOT OF EXPECTED DURATIONS — round 34's sweep looked for the durations IT had enumerated, which is
  // why an unsourced `960_000 ms` or "sixteen minutes" passed it; the durations are now found by shape
  // (see `durationsNamedIn`) and this list only answers "what could a number in this prose have come
  // from". `reclaimMs` is here too, and no value is exempted from having to name one of these.
  const namedDurations: Array<{ token: string; ms: number }> = [
    { token: 'xeroAccountingEntry', ms: reclaimMs },
    // The DEFAULT lease, because `outbox-registry.ts` states it too: the WooCommerce stock entry's
    // reclaim waits it, since that drain passes no `staleLockMs` at all. r34's duration audit found
    // round 33 had struck that ten minutes out as "no window this build has".
    { token: 'INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default', ms: INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default },
    { token: 'ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS', ms: deadLetterMs },
    { token: 'ADMIN_OUTBOX_POST_LEASE_MARGIN_MS', ms: ADMIN_OUTBOX_POST_LEASE_MARGIN_MS },
    { token: 'INTEGRATION_OUTBOX_MAX_LEASE_MS', ms: INTEGRATION_OUTBOX_MAX_LEASE_MS },
    { token: '/api/cron/email-outbox', ms: drainMs },
    { token: '/api/cron/wc-reconcile', ms: reconcileMs },
  ]

  /**
   * ONE SENTENCE, EVERY DURATION IT NAMES — FOUND BY SHAPE — EACH ONE SOURCED IN THAT SAME SENTENCE.
   *
   * NO VALUE IS EXEMPT, and that is round 35's HIGH 1. Round 34 wrote this rule as "every duration a
   * sentence names" and implemented it as a walk over the durations it had already listed, with the
   * `900_000` numeral skipped outright — the one number the rule exists to police. So the sentence
   * "FIFTEEN MINUTES IS INSIDE THE HOUR", which sources neither of the two durations it rests the
   * whole ordering on, passed a guard whose stated rule forbids it. Durations now come from
   * `durationsNamedIn`, the sources come from `namedDurations`, and a duration nothing in this build
   * resolves to fails for having no source at all rather than for being unlisted.
   */
  let durationsChecked = 0
  const assertDurationsAreSourced = (where: string, sentence: string) => {
    for (const named of durationsNamedIn(sentence)) {
      durationsChecked++
      const sources = namedDurations
        .filter((duration) => duration.ms === named.ms)
        .map((duration) => duration.token)
      const how = sources.length === 0
        ? 'and NOTHING in this build resolves to that duration at all'
        : 'name one of: ' + sources.join(', ')
      assert.ok(
        sources.some((token) => sentence.includes(token)),
        where + ': names the duration ' + JSON.stringify(named.text) + ' (' + named.ms + ' ms) without '
        + 'naming, in that same sentence, what it resolves from — ' + how + '. Rounds 21 and 33: a '
        + 'duration with no named source is how the dead-letter gate got asserted as the reclaim '
        + 'window twice. Round 35: the rule said EVERY duration and the sweep only knew the ones it '
        + 'had listed: ' + JSON.stringify(sentence),
      )
    }
  }

  for (const site of WINDOW_CLAIM_SITES) {
    const { prose, sentences } = locateWindowSite(read(site.file), site)

    // (4a) THE CORRECTED CLAIM IS STATED HERE, AND IT IS A SENTENCE ABOUT THE DUPLICATE. A "crosses a
    // drain" qualifier in a sentence that is not about the duplicate bounds nothing.
    const corrected = sentences.filter((sentence) => CROSSES_A_DRAIN.test(sentence))
    assert.ok(
      corrected.length > 0,
      `${site.name}: does not say the duplicate needs the timing to CROSS A DRAIN, which is the corrected `
      + `claim. Sentences searched: ${sentences.length}`,
    )
    for (const sentence of corrected) {
      assert.match(
        sentence,
        ABOUT_THE_DUPLICATE,
        `${site.name}: names the drain crossing in a sentence that is not about the duplicate, so the `
        + `condition is stranded from the claim it conditions: ${JSON.stringify(sentence)}`,
      )
    }

    // (4b) AND NO SENTENCE HERE ASSERTS A SECOND DELIVERY UNCONDITIONALLY. This is the exact shape
    // round 33 found: "…inserts a SECOND row. Both are delivered." — true only once a drain has
    // settled the first copy, asserted here as though the reclaim alone did it.
    const unconditional = sentences.filter(
      (sentence) => ASSERTS_A_SECOND_DELIVERY.test(sentence) && !DRAIN_CONDITION.test(sentence),
    )
    assert.deepEqual(
      unconditional,
      [],
      `${site.name}: ${unconditional.length} sentence(s) here assert a second delivery with no drain `
      + 'condition in the same sentence, which is more than the partial index allows — it REFUSES B '
      + `while A's copy is undelivered: ${JSON.stringify(unconditional)}`,
    )

    // (4c) AND EVERY OTHER DURATION NAMED HERE NAMES ITS OWN SOURCE (round 34, HIGH 1). The old rule
    // exempted any sentence containing the word "lease", which is how the DEAD-LETTER GATE's twenty
    // minutes came to be enforced here as the reclaim window. A sentence may name another duration —
    // both copies now name the gate deliberately, so that the two stop being confusable — but only by
    // naming the constant it resolves from, in that sentence. Case-insensitive, so a lower-case stale
    // claim cannot walk through the way "fifteen minutes later worker B reclaims" did in rounds 19-32.
    for (const sentence of sentences) {
      assertDurationsAreSourced(site.name, sentence)
    }
    assert.ok(
      prose.toUpperCase().includes(reclaimWords),
      `${site.name}: no longer states the reclaim window as ${reclaimWords}`,
    )

    // (4d) THE REVERSED PREMISE IS GONE FROM THIS SITE — not merely contradicted further down it.
    assert.doesNotMatch(
      prose,
      /the email drain empties PENDING inside it|empties PENDING far faster than/,
      `${site.name}: still says the drain empties PENDING inside the reclaim window`,
    )
    assert.doesNotMatch(
      prose,
      /A's copy is typically already SENT|has typically already been DELIVERED/,
      `${site.name}: still claims the first copy is typically delivered by the time the replay lands`,
    )

    // (4e) AND THE DERIVING SITES DERIVE IT: the number as this repo writes numbers, the SOURCE that
    // number comes from, and the drain cadence that the ordering in (3) rests on. The counterexample
    // paragraph is not required to restate any of it — it is required to point at the paragraph that
    // does, which (4a) covers by making it carry the conclusion.
    if (!site.derivesTheWindow) continue
    assert.ok(
      prose.includes(grouped),
      `${site.name}: no longer states the reclaim window as ${grouped} ms — re-read it against `
      + '`INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry`, which is the `staleLockMs` the Xero '
      + 'drain passes to `claimIntegrationOutboxWork`',
    )
    // AND IT NAMES WHERE THAT NUMBER COMES FROM (round 34, HIGH 1). Round 33 changed the number here
    // without changing what it was attributed to, and an unattributed number is what drifted.
    for (const token of ['xeroAccountingEntry', 'CLAIM_STALE_MS', 'claimIntegrationOutboxWork']) {
      assert.ok(
        prose.includes(token),
        `${site.name}: no longer names ${token}, so the reclaim window it states is not attributed to the `
        + 'thing that takes it — which is how the dead-letter gate was substituted for it twice',
      )
    }
    // AND IT NAMES THE OTHER WINDOW AS THE OTHER WINDOW, so the next reader meets the distinction at
    // the site rather than having to rediscover it. The sentence that names the gate must say what the
    // gate is FOR.
    const gateSentences = sentences.filter((sentence) => sentence.includes('ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS'))
    assert.ok(
      gateSentences.length > 0,
      `${site.name}: no longer names ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS at all. It is named here on `
      + 'purpose: it is the twenty-minute window rounds 21 and 33 mistook for this one, and a reader who '
      + 'is not told the two are different is the reader who makes that edit a fourth time',
    )
    assert.ok(
      gateSentences.some((sentence) => DEAD_LETTER_GATE.test(sentence)),
      `${site.name}: names ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS without saying, in that sentence, that `
      + `what it gates is DEAD-LETTERING. Sentences naming it: ${JSON.stringify(gateSentences)}`,
    )
    assert.match(
      prose,
      /HOURLY|hourly/,
      `${site.name}: no longer states the drain cadence — the sentence round 19's MEDIUM corrected has `
      + 'been rewritten',
    )
  }

  // (4f) AND THE CLAIM IS MADE ONLY AT THOSE SITES. Every paragraph of these two files that names any
  // duration this rationale has words for must be one of the located sites, or must name the source
  // that duration resolves from. A window claim that drifts into a paragraph nobody anchored is what
  // rounds 19, 21 and 33 each were — and round 34 is the one where the anchored paragraphs were
  // "corrected" to a number nothing in the code produces, so an unanchored sentence is held to the
  // STRICTER rule here: even the resolved window has to say where it came from.
  const anchors = WINDOW_CLAIM_SITES.map((site) => site.anchor)
  for (const file of [...new Set(WINDOW_CLAIM_SITES.map((site) => site.file))]) {
    for (const prose of commentParagraphs(read(file))) {
      if (anchors.some((anchor) => prose.includes(anchor))) continue
      // SENTENCE BY SENTENCE, and with quoted spans stripped, for the SAME two reasons the site
      // checks above use: sourcing is a property of the sentence naming the duration, and a paragraph
      // that QUOTES a window in order to disown it is not stating one.
      for (const sentence of windowSentences(prose)) {
        assertDurationsAreSourced(`${file}: an unanchored sentence`, sentence)
      }
    }
  }

  // (4g) AND THE SWEEP ACTUALLY FOUND DURATIONS. A pattern that matches nothing passes every
  // assertion above while checking nothing at all, which is the failure mode the round-34 sweep had in
  // a different form. The two files state around twenty durations between them; the floor is set well
  // under that so ordinary editing does not trip it, and far over zero so a broken pattern does.
  assert.ok(
    durationsChecked >= 15,
    `the duration sweep found only ${durationsChecked} durations across ${WINDOW_CLAIM_SITES.length} sites `
    + 'and both files entire — `durationsNamedIn` is no longer matching this prose, so every sourcing '
    + 'assertion above passed by examining nothing',
  )

  // (5) EVERY CITATION RESOLVES, AND NONE OF THEM IS A LINE NUMBER. A line number is falsified by
  // any edit above it and cannot be checked; an anchor can be, so it is.
  for (const citation of CITATIONS) {
    const citing = read(citation.citedIn)
    assert.ok(
      citing.includes(citation.citation),
      `${citation.citedIn} no longer carries the citation "${citation.citation}" — the walk is reading a paragraph that has moved`,
    )
    assert.ok(
      read(citation.resolvesIn).includes(citation.anchor),
      `${citation.citedIn} cites ${citation.resolvesIn} for "${citation.anchor}", which is not there any more`,
    )
  }

  // And no line-numbered citation has crept back into the paragraph that had one.
  const cadenceComment = read('lib/domain/accounting/unrecorded-posted-document.ts')
  assert.doesNotMatch(
    cadenceComment,
    /help-docs\/[\w-]+\.md:\d+|lib\/cron-jobs\/xero\.ts:\d+/,
    'a file:line citation is back in unrecorded-posted-document.ts — cite a greppable anchor instead',
  )
})
