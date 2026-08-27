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
  /** Set to make the SENT stamp fail the way a lost connection to Postgres would. */
  failSentStamp: false,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      emailOutbox: {
        findMany: async () => state.rows.filter((row) => row.attempts < 5 && row.status === 'PENDING'),
        updateMany: async ({ where }: { where: { id: string } }) => {
          const row = state.rows.find((candidate) => candidate.id === where.id)
          if (!row) return { count: 0 }
          row.status = 'PROCESSING'
          row.processingStartedAt = new Date()
          return { count: 1 }
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.rows.find((candidate) => candidate.id === where.id)
          if (!row) throw new Error('row gone')
          // THE INTERLEAVING. The SENT stamp is the write that fails; every other write lands, so
          // the row that comes out of this is the row the shipped catch decided on.
          if (state.failSentStamp && data.status === 'SENT') {
            throw new Error('could not write SENT: connection terminated')
          }
          Object.assign(row, data)
          return row
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
      return { success: true }
    },
  },
})

function reset(rows: OutboxRow[]) {
  state.rows = rows
  state.suppressed = null
  state.delivered = []
  state.failSentStamp = false
}

// MUTATION THAT KILLS THIS (run): in lib/email-outbox.ts, change the CATCH's
// `status: permanentFailure ? 'FAILED' : 'PENDING'` to `status: 'PENDING'` — the row no longer
// terminalises and the FAILED assertion fails. That write is the whole defect: it is what stamps a
// delivered copy FAILED, and this test observes it through the shipped sender.
test('ROUND 8 (Codex HIGH): a delivered copy whose SENT stamp fails ends FAILED — FAILED is not non-delivery', async () => {
  // attempts 4 so the catch's `attempts >= EMAIL_MAX_ATTEMPTS` is reached on this pass, which is
  // the terminal FAILED an operator reads. (At attempts < 4 the same catch writes PENDING and the
  // copy is sent AGAIN — the other half of the same defect.)
  reset([outboxRow({ attempts: 4 })])
  state.failSentStamp = true

  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  const result = await processPendingEmailOutbox()

  assert.deepEqual(state.delivered, ['customer@example.test'], 'the mail server accepted the message')
  assert.equal(state.rows[0].status, 'FAILED', 'and the row an operator reads afterwards says FAILED')
  assert.equal(state.rows[0].attempts, 5)
  assert.match(String(state.rows[0].lastError), /could not write SENT/)
  assert.equal(state.rows[0].sentAt, null, 'nothing marks it as gone, though it went')
  assert.equal(result.failed, 1)
  assert.equal(result.sent, 0, 'the sender itself does not know it delivered anything')
})

// MUTATION THAT KILLS THIS (run): the mirror of the one above — force the same catch to
// `status: 'FAILED'` and this assertion fails. Below the attempt cap the shipped catch schedules
// ANOTHER send of a message that already went, which is the second way a delivered copy is
// duplicated by a write failure that has nothing to do with the mail server.
test('ROUND 8: below the attempt cap the same catch returns the delivered copy to PENDING, so it goes again', async () => {
  reset([outboxRow({ attempts: 0 })])
  state.failSentStamp = true

  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  await processPendingEmailOutbox()

  assert.deepEqual(state.delivered, ['customer@example.test'])
  assert.equal(state.rows[0].status, 'PENDING', 'it will be picked up and sent a second time')
  assert.equal(state.rows[0].attempts, 1)
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

// MUTATION THAT KILLS THIS (run): make the suppression branch in lib/email-outbox.ts skip a row
// that has already been attempted — `if (suppression && email.attempts === 0)` — and the row ends
// the second pass PENDING rather than FAILED, so both the status and the prefix assertions fail.
// That mutation is also the shape of the fix this test says does NOT exist today.
//
// ROUTE: both passes go through the SHIPPED `processPendingEmailOutbox`. The first pass reaches
// `sendEmail` (recorded in `state.delivered`) and fails only the SENT stamp, so the shipped catch
// decides the row; the suppression row is inserted between the two calls, exactly as a bounce
// processed between sweeps would. Nothing about the outcome is asserted from the wording.
test('ROUND 9 (Codex HIGH): a suppression-prefixed FAILED row can be a copy an EARLIER attempt already delivered', async () => {
  reset([outboxRow({ attempts: 0 })])
  state.failSentStamp = true

  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  await processPendingEmailOutbox()

  assert.deepEqual(state.delivered, ['customer@example.test'], 'the mail server accepted it on attempt 1')
  assert.equal(state.rows[0].status, 'PENDING', 'and the catch returned it to the queue')

  // A hard bounce lands and the recipient is suppressed before the next sweep.
  state.suppressed = { id: 'sup-1', reason: 'hard bounce' }
  await processPendingEmailOutbox()

  assert.deepEqual(state.delivered, ['customer@example.test'], 'the second pass never reaches the transport')
  assert.equal(state.rows[0].status, 'FAILED')
  assert.match(
    String(state.rows[0].lastError),
    /^Suppressed recipient:/,
    'THE DEFECT: the prefix round 8 called conclusive proof of non-delivery, on a copy that went',
  )
  assert.equal(
    state.rows[0].attempts,
    1,
    'the row still carries the earlier attempt, and the suppression branch overwrote it without reading it',
  )
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
