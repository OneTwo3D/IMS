/**
 * o3d-alnk — the email outbox claim fence and the undelivered-row constraint, against real
 * Postgres.
 *
 * WHY THIS EXISTS ALONGSIDE tests/email-outbox-claim-fence.test.ts. That file drives the two
 * pause arms against an in-memory double, which is what makes the CONTROL arm (the pre-fix
 * unfenced write) expressible at all. But two of the properties this fix rests on are things a
 * double can only restate:
 *
 *   1. `lib/email-outbox.ts` types its client with `unknown` args (repo precedent:
 *      `IntegrationOutboxClient`), so tsc cannot check that the fence's WHERE names real
 *      columns. A misspelled `lockedBy` would make the double's predicate fail closed and the
 *      suite stay green while production matched every row.
 *   2. `email_outbox_undelivered_reference_uq` is a PARTIAL unique index. Prisma cannot express
 *      one, so it exists only in the migration; nothing but Postgres can say whether it bites.
 *
 * NO EMAIL IS SENT. `processPendingEmailOutbox` takes its sender as an injected dependency and
 * both tests pass a fake that appends to an array. The real mailer is never reached.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

/** A reference id unique to this run, so seeded rows cannot collide with anything real. */
function scopedReference(): string {
  return `test-email-fence-${randomUUID().slice(0, 8)}`
}

const noPrepare = async () => null
const noLog = async () => undefined

test(
  'a worker reclaimed while on the SMTP socket is REFUSED its terminal write by Postgres (o3d-alnk)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
    const referenceId = scopedReference()
    const deliveries: string[] = []

    try {
      const row = await db.emailOutbox.create({
        data: {
          kind: 'ACCOUNTING_INVOICE',
          toEmail: 'nobody@example.test',
          subject: 'fence probe',
          html: 'queued',
          referenceType: 'SalesOrder',
          referenceId,
          status: 'PENDING',
          availableAt: new Date(Date.now() - 60_000),
        },
      })

      const t0 = new Date()
      const tReclaim = new Date(t0.getTime() + 16 * 60_000)
      let reclaimHappened = false

      // Worker A claims, then stalls on the socket. Worker B's whole run happens inside that
      // stall, against the same database.
      const workerA = await processPendingEmailOutbox({
        client: db as never,
        now: () => t0,
        prepareQueuedEmail: noPrepare,
        logActivity: noLog,
        async sendEmail() {
          deliveries.push('worker-A')
          const workerB = await processPendingEmailOutbox({
            client: db as never,
            now: () => tReclaim,
            prepareQueuedEmail: noPrepare,
            logActivity: noLog,
            async sendEmail() {
              deliveries.push('worker-B')
              return { success: true }
            },
          })
          reclaimHappened = workerB.sent === 1
          // A's send comes back retryably — the branch that used to re-arm the row.
          return { success: false, error: 'SMTP read timeout' }
        },
      })

      // Non-vacuity: a green here would mean nothing if B never took the row.
      assert.equal(reclaimHappened, true, 'the contended path was not reached: worker B never reclaimed')
      assert.deepEqual(deliveries, ['worker-A', 'worker-B'], 'the reclaim itself always costs one duplicate')

      assert.equal(workerA.conflicted, 1, "worker A's refusal is recorded rather than silent")
      assert.equal(workerA.failed, 0, 'and not scored against a row it no longer owns')

      const after = await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })
      assert.equal(after.status, 'SENT', "worker B's SENT stands — it was not overwritten with a re-armed PENDING")
      assert.equal(after.processingStartedAt, null)
      assert.equal(after.lockedBy, null, 'a settled row holds no claim')
      assert.equal(after.attempts, 0, "A's attempts+1 never landed either")
    } finally {
      await db.emailOutbox.deleteMany({ where: { referenceId } })
      await db.$disconnect()
    }
  },
)

test(
  'Postgres refuses a second UNDELIVERED row for one logical email, and allows a later re-send (o3d-alnk)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { queueEmail } = await import('@/lib/email-outbox')
    const referenceId = scopedReference()
    const email = {
      kind: 'ACCOUNTING_INVOICE',
      to: 'nobody@example.test',
      subject: 'constraint probe',
      html: 'queued',
      referenceType: 'SalesOrder',
      referenceId,
    }

    try {
      assert.deepEqual(await queueEmail(email, { client: db as never }), { queued: true })

      // THE PROOF: the second enqueue is refused by the partial unique index, and that refusal
      // reaches the caller as `already_queued` rather than as a thrown P2002. This is the
      // o3d-8td2 INVOICE_EMAIL replay: `xero/accounting.post` re-running its enqueue.
      assert.deepEqual(
        await queueEmail(email, { client: db as never }),
        { queued: false, reason: 'already_queued' },
      )
      assert.equal(await db.emailOutbox.count({ where: { referenceId } }), 1, 'one row, not two')

      // Non-vacuity in both directions. A different KIND for the same reference is a different
      // logical email and is allowed...
      assert.deepEqual(
        await queueEmail({ ...email, kind: 'INVOICE' }, { client: db as never }),
        { queued: true },
      )
      // ...and once the first row is delivered, a deliberate LATER re-send is allowed too. The
      // index is scoped to PENDING/PROCESSING precisely so it constrains duplicates rather than
      // decisions.
      await db.emailOutbox.updateMany({
        where: { referenceId, kind: 'ACCOUNTING_INVOICE' },
        data: { status: 'SENT', sentAt: new Date() },
      })
      assert.deepEqual(await queueEmail(email, { client: db as never }), { queued: true })
      assert.equal(await db.emailOutbox.count({ where: { referenceId, kind: 'ACCOUNTING_INVOICE' } }), 2)
    } finally {
      await db.emailOutbox.deleteMany({ where: { referenceId } })
      await db.$disconnect()
    }
  },
)
