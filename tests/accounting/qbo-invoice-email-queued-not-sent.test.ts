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
// other way round — the reclaim window is TWENTY MINUTES and the drain is HOURLY — so B's replay
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

test('r22: the reclaim window is the RESOLVED constant, and BOTH copies of the rationale say so', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const read = (relative: string) => readFileSync(`${repoRoot}${relative}`, 'utf8')

  // (1) THE RECLAIM WINDOW, AS A RESOLVED VALUE (Codex round 21, LOW).
  //
  // THIS USED TO BE A PREFIX MATCH, AND THAT IS THE DEFECT. It read
  // `/ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS = INTEGRATION_OUTBOX_MAX_LEASE_MS/` out of the source and
  // called the two constants the same number. They are not: the declaration continues
  // `+ ADMIN_OUTBOX_POST_LEASE_MARGIN_MS` on the NEXT LINE, so the window is 1_200_000 ms and not
  // 900_000. A regex anchored to the start of an expression passes over whatever the expression goes
  // on to add, which means the one test written to stop this rationale drifting could not see the
  // drift — it agreed with the wrong number twice.
  //
  // So the window is taken from the CONSTANT, evaluated, and the derivation is asserted as an
  // EQUALITY of resolved values rather than as a shape of source text. A future edit that changes the
  // margin, drops it, or adds another term changes `reclaimMs` and lands in the words table below.
  const { ADMIN_OUTBOX_POST_LEASE_MARGIN_MS, ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS } =
    await import('@/lib/domain/integrations/outbox-admin')
  const { INTEGRATION_OUTBOX_MAX_LEASE_MS } = await import('@/lib/domain/integrations/outbox-leases')

  const reclaimMs = ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS
  assert.equal(
    reclaimMs,
    INTEGRATION_OUTBOX_MAX_LEASE_MS + ADMIN_OUTBOX_POST_LEASE_MARGIN_MS,
    'the dead-letter gate is no longer the maximum lease plus the post-lease margin — re-read both copies '
    + 'of the rationale, which state the window as a number',
  )
  assert.notEqual(
    reclaimMs,
    INTEGRATION_OUTBOX_MAX_LEASE_MS,
    'ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS is once again EQUAL to the max lease. Round 20 asserted that '
    + 'alias while the margin made it false; if the margin has genuinely gone to zero, both copies of the '
    + 'rationale have to stop naming two numbers',
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

  // (4) BOTH COPIES, CHECKED AGAINST THAT READING — and the reversed premise gone rather than
  // merely contradicted somewhere further down.
  for (const relative of [
    'lib/domain/integrations/outbox-registry.ts',
    'tests/concurrency/outbox-stale-park.concurrent.test.ts',
  ]) {
    const text = read(relative)
    // The number as this repo writes numbers — `1_200_000`, every three digits, not just the last
    // group. The old expression only ever inserted ONE separator, which was right for 900_000 and
    // silently wrong for anything seven digits long.
    const grouped = String(reclaimMs).replace(/\B(?=(\d{3})+(?!\d))/g, '_')

    // THE NUMBER, REQUIRED — NOT "THE NUMBER OR THE WORDS" (r22). This used to be
    // `includes(grouped) || includes(reclaimWords)`, and round 22's own mutation showed what that
    // buys: reverting the sentence to "900_000 ms, FIFTEEN MINUTES" left the NEXT paragraph's
    // "TWENTY MINUTES IS INSIDE THE HOUR" standing, the `||` found the words there, and the test
    // passed over a rationale that now stated the window twice with two different numbers. A stale
    // claim sitting beside the text that corrects it is the shape this guard exists to catch, so
    // BOTH halves are now required and the wrong ones are excluded.
    assert.ok(
      text.includes(grouped),
      `${relative} no longer states the reclaim window as ${grouped} ms — re-read it against `
      + 'ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS, which is the max lease PLUS the post-lease margin',
    )
    assert.ok(
      text.includes(reclaimWords),
      `${relative} no longer states the reclaim window as ${reclaimWords}`,
    )
    // AND NO OTHER WINDOW IS NAMED. Every value in the words table is a window this rationale could
    // be about; exactly one of them may appear in a file that states it. (The LEASE is written in
    // lower case in both copies precisely so the two claims cannot be confused for one another.)
    for (const otherWords of Object.values(RECLAIM_WINDOW_WORDS)) {
      if (otherWords === reclaimWords) continue
      assert.ok(
        !text.includes(otherWords),
        `${relative} states the reclaim window as ${otherWords} as well as ${reclaimWords} — one of the `
        + 'two is stale, and a reader has no way to tell which',
      )
    }
    assert.match(
      text,
      /HOURLY|documented HOURLY/,
      `${relative} no longer states the drain cadence — the sentence this MEDIUM corrected has been rewritten`,
    )
    assert.doesNotMatch(
      text,
      /the email drain empties\s*\n?\s*(\*|\/\/)?\s*PENDING inside it/,
      `${relative} still says the drain empties PENDING inside the reclaim window`,
    )
    assert.doesNotMatch(
      text,
      /empties PENDING far faster than/,
      `${relative} still says the drain empties PENDING faster than the reclaim window`,
    )
    assert.doesNotMatch(
      text,
      /A's copy is typically already SENT|has typically already been DELIVERED/,
      `${relative} still claims the first copy is typically delivered by the time the replay lands`,
    )
    assert.match(
      text,
      /crosses a drain|CROSSES A DRAIN/,
      `${relative} no longer says the duplicate needs the timing to cross a drain, which is the corrected claim`,
    )
  }

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
