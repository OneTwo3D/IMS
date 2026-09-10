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
 *
 * WHY THE CLIENT IS NARROWED BEFORE IT IS INJECTED (Codex MEDIUM, r2). `processPendingEmailOutbox`
 * is a SWEEP: it selects the globally oldest EMAIL_OUTBOX_BATCH_SIZE eligible rows, not the rows this
 * file seeded. Handing it the real client therefore used to point a real drain at whatever the
 * configured database already held, and that is two defects rather than one:
 *
 *   SAFETY. The sender is a fake, so a genuine queued customer email caught in the batch would
 *   be marked SENT with nothing delivered. The row afterwards is indistinguishable from a
 *   successful send, so the loss is silent AND unrecoverable. This suite's own database URL is
 *   whatever `.env` names, which on a developer machine is a database with real rows in it.
 *
 *   CORRECTNESS. EMAIL_OUTBOX_BATCH_SIZE pre-existing eligible rows older than the fixture push the
 *   fixture out of the batch entirely. The proof then fails — or worse, passes vacuously —
 *   for a reason that has nothing to do with the fence.
 *
 * `options.client` is the only seam production offers, and it is enough: it is the drain's ONLY
 * database access (sender, preparer and activity log are injected too). `fixtureScopedClient`
 * ANDs a fixture predicate into every read and every write the drain issues, so a row outside
 * the fixture set is not merely unlikely to be touched — it is unreachable. It cannot be
 * SELECTed, so it cannot be claimed; it cannot be UPDATEd even if it were. The two proofs below
 * (`bystanders`) are the backstop for the one thing the wrapper cannot police: a future edit
 * that reaches for the module-level `db` directly instead of the injected client.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import type { EmailOutboxClient } from '@/lib/email-outbox'

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

/**
 * The real client, narrowed so this run's own rows are the only rows it can reach.
 *
 * `rows` is ANDed into the WHERE of every `emailOutbox` read and write. ANDed, never merged:
 * the caller's predicate is preserved verbatim as one arm, so the drain's selection and — more
 * importantly — the fence's `(id, status, lockedBy, processingStartedAt)` terminal predicate
 * still mean exactly what they mean in production. Narrowing a WHERE can only ever remove rows
 * from a match, so it can turn a fenced write that would have landed into one that does not,
 * but never the reverse; the fixture rows it is scoped TO are unaffected.
 *
 * `emailSuppression` is a table keyed by address rather than by row, so an id predicate says
 * nothing about it. It gets an explicit allow-list instead, and refuses anything else outright
 * rather than passing it through: the drain upserts a suppression on an `invalidRecipient`
 * result, and a suppression written for a real customer's address would stop that customer's
 * mail for good.
 *
 * Every refusal THROWS rather than returning empty. A wrapper that quietly returned `null` for
 * an out-of-scope read would let a scoping mistake look like a passing test, which is the shape
 * of the finding this wrapper exists to answer.
 */
function fixtureScopedClient(
  real: EmailOutboxClient,
  scope: {
    rows: Record<string, unknown>
    recipients?: readonly string[]
    allowCreate?: (data: Record<string, unknown>) => boolean
  },
): EmailOutboxClient {
  const narrow = (args: unknown): Record<string, unknown> => {
    const given = (args ?? {}) as Record<string, unknown>
    return { ...given, where: { AND: [given.where ?? {}, scope.rows] } }
  }
  const recipientAllowed = (args: unknown): boolean => {
    const where = ((args ?? {}) as { where?: { email?: unknown } }).where
    return typeof where?.email === 'string' && (scope.recipients ?? []).includes(where.email)
  }
  return {
    emailOutbox: {
      findMany: (args) => real.emailOutbox.findMany(narrow(args)),
      updateMany: (args) => real.emailOutbox.updateMany(narrow(args)),
      create: (args) => {
        const data = ((args ?? {}) as { data?: Record<string, unknown> }).data ?? {}
        if (scope.allowCreate?.(data) !== true) {
          throw new Error(`fixtureScopedClient: refused an out-of-scope emailOutbox.create: ${JSON.stringify(data.referenceId)}`)
        }
        return real.emailOutbox.create(args)
      },
    },
    emailSuppression: {
      findUnique: (args) => {
        if (!recipientAllowed(args)) {
          throw new Error('fixtureScopedClient: refused an out-of-scope emailSuppression.findUnique')
        }
        return real.emailSuppression.findUnique(args)
      },
      upsert: (args) => {
        if (!recipientAllowed(args)) {
          throw new Error('fixtureScopedClient: refused an out-of-scope emailSuppression.upsert')
        }
        return real.emailSuppression.upsert(args)
      },
    },
  }
}

const noPrepare = async () => null
const noLog = async () => undefined

const FIXTURE_RECIPIENT = 'nobody@example.test'

test(
  'a worker reclaimed while on the SMTP socket is REFUSED its terminal write by Postgres (o3d-alnk)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { EMAIL_OUTBOX_BATCH_SIZE, processPendingEmailOutbox } = await import('@/lib/email-outbox')
    const referenceId = scopedReference()
    const deliveries: string[] = []

    try {
      const t0 = new Date()

      /**
       * BYSTANDERS: undelivered rows this test did not seed, standing in for the real queued
       * customer email the finding is about. There are more of them than one batch holds and
       * every one of them is OLDER than the fixture, so an unscoped drain would fill its whole
       * batch with them, mark them SENT through the fake sender, and never reach the fixture at
       * all. Both halves of the finding are therefore reachable from here, and both assertions
       * below go red the moment the scoping is removed.
       */
      const bystanders = await Promise.all(
        Array.from({ length: EMAIL_OUTBOX_BATCH_SIZE + 5 }, (_, index) =>
          db.emailOutbox.create({
            data: {
              kind: 'ACCOUNTING_INVOICE',
              toEmail: 'bystander@example.test',
              subject: 'a real queued email this test must not touch',
              html: 'queued',
              referenceType: 'SalesOrder',
              referenceId: `${referenceId}-bystander-${index}`,
              status: 'PENDING',
              availableAt: new Date(t0.getTime() - 60 * 60_000),
              createdAt: new Date(t0.getTime() - (60 - index) * 60_000),
            },
            select: { id: true },
          })),
      )

      const row = await db.emailOutbox.create({
        data: {
          kind: 'ACCOUNTING_INVOICE',
          toEmail: FIXTURE_RECIPIENT,
          subject: 'fence probe',
          html: 'queued',
          referenceType: 'SalesOrder',
          referenceId,
          status: 'PENDING',
          availableAt: new Date(t0.getTime() - 60_000),
        },
      })

      // PRECONDITION, not decoration. The correctness half of this test measures nothing unless
      // an unscoped drain really would be full before it reached the fixture, and that depends
      // on a batch size this file does not own. Counted over the WHOLE table, because rows the
      // database already held crowd the batch exactly as this run's own bystanders do.
      const crowd = await db.emailOutbox.count({
        where: { status: 'PENDING', availableAt: { lte: t0 }, createdAt: { lt: row.createdAt } },
      })
      assert.ok(
        crowd >= EMAIL_OUTBOX_BATCH_SIZE,
        `precondition: ${crowd} eligible rows precede the fixture, fewer than the batch size `
        + `${EMAIL_OUTBOX_BATCH_SIZE} — an unscoped drain would still reach the fixture and the `
        + 'crowding half of this proof would pass without measuring anything',
      )

      // THE NARROWED CLIENT. Nothing outside this id set is selectable or writable through it,
      // so the drain below cannot claim, send for, or settle a row it did not seed — whatever
      // else the configured database happens to hold.
      const fixtureIds = [row.id, ...bystanders.map((bystander) => bystander.id)]
      const client = fixtureScopedClient(db as unknown as EmailOutboxClient, {
        rows: { id: { in: [row.id] } },
        recipients: [FIXTURE_RECIPIENT],
      })

      const tReclaim = new Date(t0.getTime() + 16 * 60_000)
      let reclaimHappened = false

      // Worker A claims, then stalls on the socket. Worker B's whole run happens inside that
      // stall, against the same database.
      const workerA = await processPendingEmailOutbox({
        client,
        now: () => t0,
        prepareQueuedEmail: noPrepare,
        logActivity: noLog,
        async sendEmail() {
          deliveries.push('worker-A')
          const workerB = await processPendingEmailOutbox({
            client,
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

      // Non-vacuity: a green here would mean nothing if B never took the row. It is also the
      // crowding half of the Codex finding: with an unscoped client the fixture is not in
      // either worker's batch, so neither worker reaches it and this is where that shows.
      assert.equal(reclaimHappened, true, 'the contended path was not reached: worker B never reclaimed')
      assert.deepEqual(deliveries, ['worker-A', 'worker-B'], 'the reclaim itself always costs one duplicate')

      assert.equal(workerA.conflicted, 1, "worker A's refusal is recorded rather than silent")
      assert.equal(workerA.failed, 0, 'and not scored against a row it no longer owns')

      const after = await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })
      assert.equal(after.status, 'SENT', "worker B's SENT stands — it was not overwritten with a re-armed PENDING")
      assert.equal(after.processingStartedAt, null)
      assert.equal(after.lockedBy, null, 'a settled row holds no claim')
      assert.equal(after.attempts, 0, "A's attempts+1 never landed either")

      // THE SAFETY HALF. Not one bystander was selected, claimed, delivered for or settled. An
      // unscoped drain marks the first EMAIL_OUTBOX_BATCH_SIZE of them SENT with a fake sender —
      // a real customer email recorded as delivered, with nothing delivered and no way to tell
      // afterwards. This is the assertion that says that cannot happen here.
      const untouched = await db.emailOutbox.findMany({
        where: { id: { in: bystanders.map((bystander) => bystander.id) } },
        select: { id: true, status: true, attempts: true, sentAt: true, lockedBy: true, processingStartedAt: true },
      })
      assert.equal(untouched.length, bystanders.length, 'no bystander row was deleted')
      for (const bystander of untouched) {
        assert.deepEqual(
          { status: bystander.status, attempts: bystander.attempts, sentAt: bystander.sentAt, lockedBy: bystander.lockedBy, processingStartedAt: bystander.processingStartedAt },
          { status: 'PENDING', attempts: 0, sentAt: null, lockedBy: null, processingStartedAt: null },
          `bystander ${bystander.id} was touched by a drain that was never meant to see it`,
        )
      }
      assert.equal(fixtureIds.length, bystanders.length + 1)
    } finally {
      await db.emailOutbox.deleteMany({ where: { referenceId: { startsWith: referenceId } } })
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
      to: FIXTURE_RECIPIENT,
      subject: 'constraint probe',
      html: 'queued',
      referenceType: 'SalesOrder',
      referenceId,
    }

    // `queueEmail` only ever CREATEs, so it cannot sweep — but it is given the narrowed client
    // all the same, keyed on this run's reference prefix, so that a future edit which teaches it
    // to read or update is scoped by construction rather than by whoever remembers.
    const client = fixtureScopedClient(db as unknown as EmailOutboxClient, {
      rows: { referenceId: { startsWith: referenceId } },
      allowCreate: (data) => data.referenceId === referenceId,
    })

    try {
      assert.deepEqual(await queueEmail(email, { client }), { queued: true })

      // THE PROOF: the second enqueue is refused by the partial unique index, and that refusal
      // reaches the caller as `already_queued` rather than as a thrown P2002. This is the
      // o3d-8td2 INVOICE_EMAIL replay: `xero/accounting.post` re-running its enqueue.
      assert.deepEqual(
        await queueEmail(email, { client }),
        { queued: false, reason: 'already_queued' },
      )
      assert.equal(await db.emailOutbox.count({ where: { referenceId } }), 1, 'one row, not two')

      // Non-vacuity in both directions. A different KIND for the same reference is a different
      // logical email and is allowed...
      assert.deepEqual(
        await queueEmail({ ...email, kind: 'INVOICE' }, { client }),
        { queued: true },
      )
      // ...and once the first row is delivered, a deliberate LATER re-send is allowed too. The
      // index is scoped to PENDING/PROCESSING precisely so it constrains duplicates rather than
      // decisions.
      await db.emailOutbox.updateMany({
        where: { referenceId, kind: 'ACCOUNTING_INVOICE' },
        data: { status: 'SENT', sentAt: new Date() },
      })
      assert.deepEqual(await queueEmail(email, { client }), { queued: true })
      assert.equal(await db.emailOutbox.count({ where: { referenceId, kind: 'ACCOUNTING_INVOICE' } }), 2)
    } finally {
      await db.emailOutbox.deleteMany({ where: { referenceId: { startsWith: referenceId } } })
      await db.$disconnect()
    }
  },
)
