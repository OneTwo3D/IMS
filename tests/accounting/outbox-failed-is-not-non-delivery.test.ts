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
// This file DRIVES that interleaving through the shipped sender rather than asserting about it, and
// then drives the one path that IS conclusive — the suppression check, which runs BEFORE anything
// reaches a mail server — so the record's discriminator is an observation too.
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
// longer empty and the "nothing was handed to the transport" assertion fails. Running BEFORE the
// send is exactly the property that makes this one FAILED path conclusive.
test('ROUND 8: the suppression path is the conclusive FAILED — it runs BEFORE anything is handed to a mail server', async () => {
  reset([outboxRow({ attempts: 0 })])
  state.suppressed = { id: 'sup-1', reason: 'hard bounce' }

  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  await processPendingEmailOutbox()

  assert.deepEqual(state.delivered, [], 'nothing was handed to the transport')
  assert.equal(state.rows[0].status, 'FAILED')
  assert.match(
    String(state.rows[0].lastError),
    /^Suppressed recipient:/,
    'and the record tells the operator to read exactly this prefix, because it is what separates the '
      + 'conclusive FAILED from the ambiguous one',
  )
})

// MUTATION THAT KILLS THIS (run): restore "a FAILED row never went at all" to the INVOICE_EMAIL
// `check` in lib/domain/accounting/unrecorded-posted-document.ts — this test and
// tests/accounting/qbo-invoice-email-queued-not-sent.test.ts both fail.
test('ROUND 8: the record describes FAILED as missing confirmation, and names the one conclusive path', async () => {
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  const description = describeUnpersistedQboPost(
    { entry: { id: 'log-1', type: 'INVOICE_EMAIL', referenceType: 'SalesOrder', referenceId: 'order-1' }, postedExternalId: null },
    new Error('write conflict'),
  )

  assert.doesNotMatch(description, /never went at all/, 'FAILED is not proof of non-delivery')
  assert.match(description, /A FAILED ROW IS NOT PROOF THAT NOTHING WENT/)
  assert.match(description, /HOLDS NO DURABLE CONFIRMATION OF DELIVERY/)
  // The split Codex asked for: conclusive pre-send rejection vs ambiguous post-dispatch failure,
  // and the recorded field that tells them apart.
  assert.match(description, /ONE FAILED PATH IS CONCLUSIVE/)
  assert.match(description, /Suppressed recipient:/)
  assert.match(description, /EVERY OTHER FAILED ROW IS AMBIGUOUS/)
  assert.match(description, /lastError/, 'the operator has to read the field the split lives in')
})
