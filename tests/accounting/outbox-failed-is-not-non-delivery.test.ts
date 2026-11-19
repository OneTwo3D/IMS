import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// ROUND 8 (Codex HIGH) — "A FAILED ROW NEVER WENT AT ALL" WAS AN ABSENCE READ AS A NEGATIVE ANSWER.
//
// The QuickBooks no-identifier record tells an operator how to read the email outbox after a
// replay. Round 7 ended that instruction with "a FAILED row never went at all", which is a claim
// about the WORLD made from a field that only records what IMS managed to write down.
//
// `processPendingEmailOutbox` stamps SENT only AFTER `sendEmail` has returned, and that stamp is
// inside the same `try` whose `catch` writes `status: permanentFailure ? 'FAILED' : 'PENDING'`. So
// a copy the mail server accepted, whose SENT stamp then failed, ends FAILED — and an operator who
// believed the old sentence would count it as never sent and send it again.
//
// This file DRIVES that interleaving through the shipped sender rather than asserting about it.
//
// ROUND 9 (Codex HIGH) — AND THE PATH ROUND 8 CALLED CONCLUSIVE IS NOT. The suppression check runs
// before THIS retry's send, which is not the same claim as "before any send". It reads the
// suppression table and NOTHING else — not `attempts`, not `sentAt`, not the error already on the
// row — and then overwrites the row with FAILED and `Suppressed recipient: …`. So the last test
// below drives an accepted send whose SENT stamp fails, adds a suppression between the sweeps, and
// watches the shipped sender label a delivered copy with the prefix round 8 told the operator to
// trust.
//
// MUTATION THAT KILLS EACH TEST is recorded above each one.
// ---------------------------------------------------------------------------

type OutboxRow = {
  id: string
  kind: string
  toEmail: string
  subject: string
  html: string
  attachments: unknown
  referenceType: string | null
  referenceId: string | null
  status: string
  attempts: number
  lastError: string | null
  availableAt: Date
  processingStartedAt: Date | null
  lockedBy: string | null
  sentAt: Date | null
  createdAt: Date
}

function outboxRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox-1',
    kind: 'ACCOUNTING_INVOICE',
    toEmail: 'customer@example.test',
    subject: 'Invoice INV-1',
    html: '<p>Invoice</p>',
    attachments: null,
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    availableAt: new Date(0),
    processingStartedAt: null,
    lockedBy: null,
    sentAt: null,
    createdAt: new Date(0),
    ...overrides,
  }
}

const state = {
  rows: [] as OutboxRow[],
  suppressed: null as { id: string; reason: string } | null,
  /** Messages the mail server accepted. The ONLY record of what actually went. */
  delivered: [] as string[],
  /** How many SENT stamps to fail, the way a lost connection to Postgres would. 0 = none. */
  failSentStamp: 0,
  /** Make the sender itself throw AFTER the mail server accepted the message (it never reported a result). */
  senderThrowsAfterAccept: false,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      emailOutbox: {
        findMany: async () => state.rows.filter((row) => row.attempts < 5 && row.status === 'PENDING'),
        // o3d-alnk: every write is now an updateMany — the claim, and each FENCED terminal write.
        // The two are told apart the way Postgres tells them apart: a terminal write repeats the
        // claim (`lockedBy`) in its WHERE, and matches nothing when this worker no longer holds it.
        updateMany: async (
          { where, data }: { where: { id: string; lockedBy?: string }; data: Record<string, unknown> },
        ) => {
          const row = state.rows.find((candidate) => candidate.id === where.id)
          if (!row) return { count: 0 }
          if (where.lockedBy === undefined) {
            row.status = 'PROCESSING'
            row.processingStartedAt = data.processingStartedAt as Date
            row.lockedBy = data.lockedBy as string
            return { count: 1 }
          }
          if (where.lockedBy !== row.lockedBy) return { count: 0 }
          // THE INTERLEAVING. The SENT stamp is the write that fails; every other write lands, so
          // the row that comes out of this is the row the shipped catch decided on.
          if (state.failSentStamp > 0 && data.status === 'SENT') {
            state.failSentStamp--
            throw new Error('could not write SENT: connection terminated')
          }
          Object.assign(row, data)
          return { count: 1 }
        },
      },
      emailSuppression: {
        findUnique: async () => state.suppressed,
        upsert: async () => ({}),
      },
    },
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/order-email', { namedExports: { prepareQueuedEmail: async () => null } })
mock.module('@/lib/mailer', {
  namedExports: {
    sendEmail: async (opts: { to: string }) => {
      state.delivered.push(opts.to)
      if (state.senderThrowsAfterAccept) throw new Error('connection reset after the server accepted the message')
      return { success: true }
    },
  },
})

function reset(rows: OutboxRow[]) {
  state.rows = rows
  state.suppressed = null
  state.delivered = []
  state.failSentStamp = 0
  state.senderThrowsAfterAccept = false
}

// ROUND 8 (Codex HIGH), re-pinned after the owner decision "a customer email is NEVER sent twice" (the catch in
// processPendingEmailOutbox no longer settles a delivered copy FAILED/PENDING on the strength of a database error).
//
// WHAT CHANGED AND WHAT DID NOT. The old route to "a delivered copy ends FAILED" was a failed SENT stamp: that route is
// closed on purpose — the catch now settles such a copy SENT (see the next test). What round 8 really pinned is that a
// FAILED row is not proof of non-delivery, and that still has a live route: the sender is entered, the mail server accepts
// the message, and the sender then throws before reporting a result. The row ends FAILED (unknown outcome) although the
// copy went. This test drives that route through the shipped sender, so the intent (FAILED is not non-delivery) is kept
// and only the way the interleaving is produced is changed.
//
// MUTATION THAT KILLS THIS (run): in lib/email-outbox.ts, change the CATCH's `status: permanentFailure ? 'FAILED' : 'PENDING'`
// to `status: 'PENDING'` — the unknown-outcome row no longer terminalises (and the copy would be sent again), so the FAILED
// assertion fails.
test('ROUND 8 (Codex HIGH): a delivered copy whose sender never reported ends FAILED — FAILED is not non-delivery', async () => {
  reset([outboxRow({ attempts: 0 })])
  state.senderThrowsAfterAccept = true

  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  const result = await processPendingEmailOutbox()

  assert.deepEqual(state.delivered, ['customer@example.test'], 'the mail server accepted the message')
  assert.equal(state.rows[0].status, 'FAILED', 'and the row an operator reads afterwards says FAILED, even below the attempt cap')
  assert.match(String(state.rows[0].lastError), /Outcome unknown/, 'with the unknown-outcome notice, which is the honest wording')
  assert.equal(state.rows[0].sentAt, null, 'nothing marks it as gone, though it went')
  assert.equal(result.failed, 1)
  assert.equal(result.sent, 0, 'the sender itself does not know it delivered anything')
  await processPendingEmailOutbox()
  assert.deepEqual(state.delivered, ['customer@example.test'], 'and it is never picked up for a second send')
})

// OWNER DECISION (round 4): a send that was delivered ends SENT and is NEVER put back to PENDING. This test used to pin the
// opposite — that a failed SENT stamp below the attempt cap returned the delivered copy to PENDING so it went again — which
// is exactly the duplicate-customer-email bug the decision removed, so it now pins the new rule: the sender answered
// success, the stamp failed once, and the catch settles the copy SENT, so a second sweep sends nothing.
//
// MUTATION THAT KILLS THIS (run): in the catch, drop the `deliveredByAnswer ? { status: 'SENT', … }` branch (always write
// the PENDING/FAILED data) — the row ends PENDING, the second sweep delivers again, and the assertions fail.
test('ROUND 8: below the attempt cap a delivered copy whose SENT stamp failed is settled SENT, never requeued', async () => {
  reset([outboxRow({ attempts: 0 })])
  state.failSentStamp = 1

  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  const result = await processPendingEmailOutbox()

  assert.deepEqual(state.delivered, ['customer@example.test'])
  assert.equal(state.rows[0].status, 'SENT', 'the copy went, so it is SENT')
  assert.notEqual(state.rows[0].sentAt, null)
  assert.equal(result.sent, 1)
  await processPendingEmailOutbox()
  assert.deepEqual(state.delivered, ['customer@example.test'], 'it is not sent a second time')
})

// MUTATION THAT KILLS THIS (run): delete the `if (suppression) { … }` short-circuit from
// lib/email-outbox.ts so a suppressed row falls through to the send — `state.delivered` is no
// longer empty and the "nothing was handed to the transport" assertion fails.
//
// WHAT IT DOES AND DOES NOT ESTABLISH (round 9): on the attempt that takes it, the suppression
// branch refuses before the transport. That is all. The next test is the same branch on a row with
// a history, and it reaches the opposite conclusion.
test('ROUND 8: on the attempt that takes it, the suppression branch refuses before anything reaches a mail server', async () => {
  reset([outboxRow({ attempts: 0 })])
  state.suppressed = { id: 'sup-1', reason: 'hard bounce' }

  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  await processPendingEmailOutbox()

  assert.deepEqual(state.delivered, [], 'nothing was handed to the transport on THIS attempt')
  assert.equal(state.rows[0].status, 'FAILED')
  assert.match(String(state.rows[0].lastError), /^Suppressed recipient:/)
})

// ROUND 9 (Codex HIGH), re-pinned after the round-4 owner decision. The old interleaving (a delivered copy returned to
// PENDING by a failed SENT stamp, then overwritten by a later suppression with a `Suppressed recipient:` FAILED) can no
// longer happen: a delivered copy ends SENT, or FAILED with the unknown-outcome notice, and in neither state is it claimed
// again, so the suppression branch can never relabel it. The intent of the original test — a `Suppressed recipient:` prefix
// must not be trusted as proof of non-delivery — is kept by driving both routes a delivered copy can take and asserting the
// suppression branch never overwrites what an earlier attempt settled.
//
// MUTATION THAT KILLS THIS (run): make the catch settle a delivered copy PENDING again (drop the `deliveredByAnswer` branch,
// and the unknown-outcome FAILED) — the second pass then reaches the suppression branch and overwrites the row with
// `Suppressed recipient:`, so the status and lastError assertions fail.
test('ROUND 9 (Codex HIGH): a delivered copy is not relabelled by a later suppression — SENT stays SENT, unknown-outcome FAILED keeps its notice', async () => {
  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')

  // Route A: the sender answered success and the SENT stamp failed once.
  reset([outboxRow({ id: 'outbox-a', attempts: 0 })])
  state.failSentStamp = 1
  await processPendingEmailOutbox()
  assert.deepEqual(state.delivered, ['customer@example.test'], 'the mail server accepted it on attempt 1')
  assert.equal(state.rows[0].status, 'SENT')
  state.suppressed = { id: 'sup-1', reason: 'hard bounce' } // a hard bounce lands before the next sweep
  await processPendingEmailOutbox()
  assert.deepEqual(state.delivered, ['customer@example.test'], 'the second pass never reaches the transport')
  assert.equal(state.rows[0].status, 'SENT', 'the suppression branch does not relabel a copy that went')
  assert.doesNotMatch(String(state.rows[0].lastError), /^Suppressed recipient:/)

  // Route B: the sender threw after the server accepted (outcome unknown).
  reset([outboxRow({ id: 'outbox-b', attempts: 0 })])
  state.senderThrowsAfterAccept = true
  await processPendingEmailOutbox()
  state.suppressed = { id: 'sup-1', reason: 'hard bounce' }
  await processPendingEmailOutbox()
  assert.deepEqual(state.delivered, ['customer@example.test'], 'delivered once, never reclaimed')
  assert.equal(state.rows[0].status, 'FAILED')
  assert.match(String(state.rows[0].lastError), /Outcome unknown/, 'the unknown-outcome notice survives; a later suppression does not overwrite it')
  assert.doesNotMatch(String(state.rows[0].lastError), /^Suppressed recipient:/)
})

// MUTATION THAT KILLS THIS (run): restore "a FAILED row never went at all", or round 8's "ONE
// FAILED PATH IS CONCLUSIVE … that copy was never sent", to the INVOICE_EMAIL `check` in
// lib/domain/accounting/unrecorded-posted-document.ts — the first fails the first assertion, the
// second fails the round-9 block.
test('ROUND 9: the record describes FAILED as missing confirmation, and calls NO failed row conclusive', async () => {
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  const description = describeUnpersistedQboPost(
    { entry: { id: 'log-1', type: 'INVOICE_EMAIL', referenceType: 'SalesOrder', referenceId: 'order-1' }, postedExternalId: null },
    new Error('write conflict'),
  )

  assert.doesNotMatch(description, /never went at all/, 'FAILED is not proof of non-delivery')
  assert.match(description, /A FAILED ROW IS NOT PROOF THAT NOTHING WENT/)
  assert.match(description, /HOLDS NO DURABLE CONFIRMATION OF DELIVERY/)

  // ROUND 9: the split round 8 added is gone, because the test above disproves it.
  assert.doesNotMatch(description, /ONE FAILED PATH IS CONCLUSIVE/)
  assert.doesNotMatch(description, /EVERY OTHER FAILED ROW IS AMBIGUOUS/)
  assert.doesNotMatch(description, /that copy was never sent/)
  assert.match(description, /NO FAILED ROW PROVES A COPY WAS NEVER SENT/)
  assert.match(description, /NOT EVEN "Suppressed recipient:"/, 'the prefix is named as NOT a discriminator')
  assert.match(description, /speaks for the attempt that wrote it and for no attempt before it/)
  assert.match(description, /o3d-ch0h/, 'and the durable per-attempt outcome that would settle it is filed')
  assert.match(description, /lastError/, 'the operator still has to read the field the claim was made from')
})
