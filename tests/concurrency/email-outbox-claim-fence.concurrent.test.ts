/**
 * o3d-alnk — the email outbox claim fence, the undelivered-row constraint, and the migration's
 * duplicate collapse, against real Postgres.
 *
 * THIS LANE PROVISIONS ITS OWN DATABASE (r4). It creates one, migrates it, runs everything below
 * against it, and drops it in a `finally`. It refuses to run against a database it did not
 * create — by name, before a single statement is issued.
 *
 * WHY THAT REPLACED THREE ROUNDS OF SCOPING. `processPendingEmailOutbox` is a SWEEP: it selects
 * the globally oldest eligible rows, not the rows this file seeded. Pointing it at the configured
 * `DATABASE_URL` — on this host the LIVE-SERVED dev instance — and then handing it a fake sender
 * is destructive by construction: a genuine queued customer email caught in the batch is stamped
 * SENT with nothing delivered, and the row afterwards is indistinguishable from a real delivery.
 *
 * Round 2 answered that by narrowing the injected client's WHERE. Round 3 answered the hole in
 * round 2 by making the narrowing predicate unforgeable. Codex found a third hole, then a fourth
 * and a fifth: `now` reclaims rows the predicate never mentioned, `prepareQueuedEmail` decides
 * what leaves the building, a one-character `referenceIdPrefix` passed the "not blank" check and
 * narrowed nothing, and a cast past the option union recombined a fake sender with the global
 * database. Five HIGHs across two rounds, each fix correct about its own case, because "which
 * rows may this sweep touch" is a claim over an OPEN space and the list of ways to widen it was
 * never going to close.
 *
 * A DATABASE THE LANE CREATED IS A CLOSED ONE. There are no unrelated rows, so there is nothing
 * for a widened predicate to find, nothing for a future `now` to reclaim, and nothing a cast can
 * combine a fake sender with. The scoping wrapper and its prefix guard are GONE — they existed
 * only to make an unsafe thing less unsafe — and what replaced them is one assertion about one
 * string, in tests/helpers/throwaway-database.ts, proved with no database at all by
 * tests/throwaway-database-guard.test.ts.
 *
 * NO EMAIL IS SENT. Every drain below goes through `drainWith`, which takes a COMPLETE
 * `EmailOutboxHarness` — a fake sender that appends to an array, this lane's own client, its own
 * clock, preparer and logger — and `resolveEmailOutboxDependencies` refuses any mixture of a
 * caller's value with a production one before a row is read (o3d-alnk r6).
 *
 * WHY IT HAS TO BE A REAL DATABASE AT ALL — the in-memory arms live in
 * tests/email-outbox-claim-fence.test.ts, and that is where the pre-fix CONTROL is expressible.
 * Three properties here can only be answered by Postgres:
 *
 *   1. `lib/email-outbox.ts` types its client with `unknown` args (repo precedent:
 *      `IntegrationOutboxClient`), so tsc cannot check that the fence's WHERE names real columns.
 *      A misspelled `lockedBy` makes a double's predicate fail closed and the suite stay green
 *      while production matches every row.
 *   2. `email_outbox_undelivered_reference_uq` is a PARTIAL unique index. Prisma cannot express
 *      one, so it exists only in the migration; nothing but Postgres can say whether it bites.
 *   3. The migration's duplicate COLLAPSE is SQL that ships. The proofs below execute the shipped
 *      statements verbatim, extracted from the migration file by marker, so a rule that changes
 *      there changes here.
 */

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { config } from 'dotenv'

import type { EmailOutboxClient, EmailOutboxHarness, EmailOutboxHarnessClient } from '@/lib/email-outbox'
import {
  ThrowawayDatabaseError,
  provisionThrowawayDatabase,
  type ThrowawayDatabase,
} from '@/tests/helpers/throwaway-database'

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

/** Resolved from this file rather than from the cwd, so the extractor cannot silently miss. */
const MIGRATION_SQL_PATH = fileURLToPath(
  new URL('../../prisma/migrations/20260910120000_email_outbox_claim_fence/migration.sql', import.meta.url),
)
const UNDELIVERED_INDEX = 'email_outbox_undelivered_reference_uq'

const execFileAsync = promisify(execFile)

/** Resolved from this file, never from the runner's cwd. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PRISMA_BIN = fileURLToPath(new URL('../../node_modules/.bin/prisma', import.meta.url))
const THROWAWAY_HELPER_PATH = fileURLToPath(new URL('../helpers/throwaway-database.ts', import.meta.url))

/** The migration under test, by the name `prisma migrate resolve` takes. */
const FENCE_MIGRATION = '20260910120000_email_outbox_claim_fence'
const FIXTURE_RECIPIENT = 'nobody@example.test'

/** 15 minutes is EMAIL_CLAIM_STALE_MS; 16 puts a reclaim just past it. */
const RECLAIM_AFTER_MS = 16 * 60_000

const noPrepare = async () => null
const noLog = async () => undefined

/**
 * EVERY DRAIN IN THIS LANE GOES THROUGH HERE, AND THE PARAMETER TYPE IS THE POINT (o3d-alnk r6).
 *
 * `EmailOutboxHarness` has NO optional members, so a call that forgets one does not compile and
 * cannot quietly fall back to a production dependency — which on this host means the LIVE-SERVED
 * dev database or the real mailer. The drain itself is passed in because this file imports it
 * dynamically; the helper NARROWS its second argument and can only pass a complete harness through.
 */
const drainWith = (
  run: typeof import('@/lib/email-outbox').processPendingEmailOutbox,
  harness: EmailOutboxHarness,
) => run({ harness })

/**
 * THE LANE'S HARNESS CLIENT, BUILT BY THE MODULE FROM THE ONE STRING IT WAS GIVEN (r18, r24).
 *
 * `harness.client` is a branded type: `lane.db as unknown as EmailOutboxClient` does not compile
 * there and would be refused at runtime as an unminted client.
 *
 * WHAT THIS FILE NO LONGER DOES IS ASSEMBLE ONE. Until r24 it passed `lane.db`'s delegates and a
 * separate claim about the destination as two independent arguments, and the mint checked only the
 * second — so a claim about the LANE standing beside PRODUCTION delegates passed just as readily,
 * and the drain (a SWEEP over the globally oldest queued customer emails) would have stamped real
 * rows SENT with nothing delivered. `createEmailOutboxLaneClient` takes ONE string and builds the
 * Prisma client from it, so the delegates cannot belong to a database other than the one named.
 *
 * WHAT PROTECTS THIS FILE FROM THE LIVE-SERVED DEV DATABASE IS NOT IN THAT FUNCTION (r26). Its own
 * check is a best-effort refusal of a URL resolving to `DATABASE_URL`'s database; the guarantee is
 * upstream, in `provisionThrowawayDatabase`, which hands out only a database THIS PROCESS WATCHED
 * ITS OWN `CREATE` COMPLETE for. Rounds 22-24 tried to make the harness client prove that for
 * itself with a server-side attestation; r25 showed the proof did not bind the pool that followed
 * and, decisively, that the in-memory arm bypassed it entirely, so it was withdrawn.
 */
function laneHarnessClient(lane: Lane): EmailOutboxHarnessClient {
  return lane.outbox.client
}

/**
 * Pull one statement out of the SHIPPED migration by marker.
 *
 * The point is that these proofs run the SQL that deploys, not a paraphrase of it. A rule change
 * in the migration lands here automatically; a marker that is renamed or deleted fails loudly
 * rather than silently reverting these tests to testing nothing.
 */
function migrationBlock(name: string): string {
  const sql = readFileSync(MIGRATION_SQL_PATH, 'utf8')
  const open = `-- o3d-alnk-sql-block: ${name}\n`
  const start = sql.indexOf(open)
  if (start < 0) throw new Error(`${MIGRATION_SQL_PATH} has no block marked "${name}"`)
  const end = sql.indexOf('-- o3d-alnk-sql-block-end', start)
  if (end < 0) throw new Error(`the block "${name}" in ${MIGRATION_SQL_PATH} is not terminated`)
  const block = sql.slice(start + open.length, end).trim()
  if (block === '') throw new Error(`the block "${name}" in ${MIGRATION_SQL_PATH} is empty`)
  return block
}

/**
 * THE PRE-FIX RULE, KEPT HERE AS A CONTROL AND NOWHERE ELSE.
 *
 * "Keep the OLDEST row per key, whatever its status." This is what shipped in round 3 and what
 * Codex HIGH 4 was about. It is reproduced verbatim so the matrix below can show the two-copy
 * OUTCOME it produces, rather than merely asserting that the new rule does not throw.
 */
const LEGACY_OLDEST_WINS_COLLAPSE = `
UPDATE "email_outbox" a
SET status = 'FAILED',
    "lastError" = 'Superseded duplicate (legacy oldest-wins rule).',
    "processingStartedAt" = NULL,
    "updatedAt" = now()
FROM "email_outbox" b
WHERE a.status IN ('PENDING', 'PROCESSING')
  AND a."referenceType" IS NOT NULL
  AND a."referenceId" IS NOT NULL
  AND b.status IN ('PENDING', 'PROCESSING')
  AND b."referenceType" IS NOT NULL
  AND b."referenceId" IS NOT NULL
  AND b.kind = a.kind
  AND b."referenceType" = a."referenceType"
  AND b."referenceId" = a."referenceId"
  AND (b."createdAt" < a."createdAt" OR (b."createdAt" = a."createdAt" AND b.id < a.id))
`

type PgClient = {
  connect: () => Promise<void>
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
  end: () => Promise<void>
}

type Lane = {
  database: ThrowawayDatabase
  db: {
    emailOutbox: {
      create: (args: unknown) => Promise<{ id: string; createdAt: Date }>
      createMany: (args: unknown) => Promise<{ count: number }>
      deleteMany: (args?: unknown) => Promise<{ count: number }>
      findMany: (args?: unknown) => Promise<Record<string, unknown>[]>
      findUniqueOrThrow: (args: unknown) => Promise<Record<string, unknown>>
      updateMany: (args: unknown) => Promise<{ count: number }>
      count: (args?: unknown) => Promise<number>
    }
    $disconnect: () => Promise<void>
  }
  sql: PgClient
  /** The email-outbox client this lane drains with, built by lib/email-outbox.ts from `database.url`. */
  outbox: import('@/lib/email-outbox').EmailOutboxLaneClient
  close: () => Promise<void>
}

type OpenLaneOptions = {
  /**
   * TEST-ONLY, and it exists so the cleanup below is REACHABLE from a proof rather than argued.
   * Invoked immediately after the database is provisioned and before any client is built; it is
   * handed the handle so a proof can record WHICH database must be gone afterwards.
   */
  failAfterProvision?: (database: ThrowawayDatabase) => void
}

/**
 * PROVISION, THEN BUILD CLIENTS — AND DROP THE DATABASE ON ANY FAILURE IN BETWEEN (o3d-alnk r6,
 * Codex LOW).
 *
 * The caller's `finally { lane.close() }` cannot cover this window: it only begins once
 * `openLane` has RETURNED. A failure in the dynamic imports, in `new PrismaClient`, or in
 * `sql.connect()` therefore used to leave a freshly migrated database behind for good. Everything
 * between the provision and the return is now inside a try whose catch closes what is closable and
 * drops the database before re-throwing.
 *
 * WHAT THIS STILL CANNOT COVER, SAID PLAINLY RATHER THAN IMPLIED. A process that does not get to
 * run any more JavaScript leaves the database behind: SIGKILL, a hard runner timeout that kills
 * the worker, an OOM kill, the machine losing power. No `finally`, no `process.on('exit')` handler
 * and no `catch` runs in those cases, and pretending otherwise is the failure mode this branch has
 * been correcting for six rounds. The mitigation is not a guarantee, it is a NAME: every database
 * this helper creates matches `ims_throwaway_<label>_<16 hex>`, so a leftover says which lane made
 * it and can be dropped by hand. `tests/concurrency` has a proof below that DEMONSTRATES the hole
 * (a child process that provisions and then SIGKILLs itself) instead of asserting its absence.
 */
async function openLane(options: OpenLaneOptions = {}): Promise<Lane> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }

  const database = await provisionThrowawayDatabase({ label: 'alnkfence' })

  let db: { $disconnect: () => Promise<void> } | null = null
  let sql: PgClient | null = null
  let outbox: import('@/lib/email-outbox').EmailOutboxLaneClient | null = null
  try {
    options.failAfterProvision?.(database)

    const [{ PrismaClient }, { PrismaPg }, { default: pg }] = await Promise.all([
      import('@/app/generated/prisma/client'),
      import('@prisma/adapter-pg'),
      import('pg'),
    ])

    // Config form, NOT `new PrismaPg(pool)` (o3d-4ajo): a second copy of `pg` fails the adapter's
    // `instanceof` check, the Pool is used as a connection CONFIG, and startup dies in the socket
    // callback with an unsettled promise.
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url, max: 5 }) })
    sql = new pg.Client({ connectionString: database.url }) as unknown as PgClient
    await sql.connect()

    // THE DRAIN'S CLIENT IS NOT BUILT HERE (r24). `createEmailOutboxLaneClient` takes this string
    // and builds its own pool from it, so there is no way to hand the drain delegates belonging to
    // one database while naming another. Pointed at the configured dev database it refuses before
    // opening anything; that `database.url` is a throwaway at all is the provisioner's rule (r26).
    const { createEmailOutboxLaneClient } = await import('@/lib/email-outbox')
    outbox = await createEmailOutboxLaneClient({ url: database.url })
  } catch (error) {
    await outbox?.disconnect().catch(() => undefined)
    await sql?.end().catch(() => undefined)
    await db?.$disconnect().catch(() => undefined)
    await database.drop()
    throw error
  }

  const openedDb = db as NonNullable<typeof db>
  const openedSql = sql as NonNullable<typeof sql>
  const openedOutbox = outbox as NonNullable<typeof outbox>

  return {
    database,
    db: openedDb as unknown as Lane['db'],
    sql: openedSql,
    outbox: openedOutbox,
    close: async () => {
      // Ordered: let go of every connection before DROP DATABASE, even though it is FORCEd.
      await openedOutbox.disconnect().catch(() => undefined)
      await openedSql.end().catch(() => undefined)
      await openedDb.$disconnect().catch(() => undefined)
      await database.drop()
    },
  }
}

type SeedRow = {
  id: string
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED'
  createdAt: Date
  attempts?: number
  processingStartedAt?: Date | null
  lockedBy?: string | null
  referenceId?: string | null
  referenceType?: string | null
  kind?: string
}

async function seed(lane: Lane, reference: string, rows: SeedRow[], t0: Date): Promise<void> {
  await lane.db.emailOutbox.deleteMany({})
  await lane.db.emailOutbox.createMany({
    data: rows.map((row) => ({
      id: row.id,
      kind: row.kind ?? 'ACCOUNTING_INVOICE',
      toEmail: FIXTURE_RECIPIENT,
      subject: `collapse probe ${row.id}`,
      html: 'queued',
      referenceType: row.referenceType === undefined ? 'SalesOrder' : row.referenceType,
      referenceId: row.referenceId === undefined ? reference : row.referenceId,
      status: row.status,
      attempts: row.attempts ?? 0,
      availableAt: new Date(t0.getTime() - 60_000),
      processingStartedAt: row.processingStartedAt ?? (row.status === 'PROCESSING' ? t0 : null),
      lockedBy: row.lockedBy ?? (row.status === 'PROCESSING' ? 'holder-token' : null),
      createdAt: row.createdAt,
    })),
  })
}

async function statuses(lane: Lane): Promise<Map<string, string>> {
  const rows = await lane.db.emailOutbox.findMany({ select: { id: true, status: true } })
  return new Map(rows.map((row) => [row.id as string, row.status as string]))
}

/** Order-independent, because `findMany` without an `orderBy` is not order-stable. */
function statusPairs(map: Map<string, string>): [string, string][] {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/** Run the SHIPPED collapse: the refusal guard, then the UPDATE, then rebuild the index. */
async function runShippedCollapse(lane: Lane): Promise<void> {
  await lane.sql.query(migrationBlock('refuse-ambiguous-processing'))
  await lane.sql.query(migrationBlock('collapse-duplicate-undelivered'))
  await lane.sql.query(`DROP INDEX IF EXISTS "${UNDELIVERED_INDEX}"`)
  await lane.sql.query(migrationBlock('undelivered-unique-index'))
}

/**
 * Drain the outbox to exhaustion and return every recipient the (fake) sender was asked to
 * deliver to. Three passes: at `t0`, once past the stale window, and once past it again — so a
 * retained row that re-arms, or one that is reclaimed and sent a second time, is COUNTED rather
 * than merely possible.
 */
async function futureSends(lane: Lane, t0: Date): Promise<string[]> {
  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  const client = laneHarnessClient(lane)
  const delivered: string[] = []
  for (const at of [t0, new Date(t0.getTime() + RECLAIM_AFTER_MS), new Date(t0.getTime() + 2 * RECLAIM_AFTER_MS)]) {
    await drainWith(processPendingEmailOutbox, {
      client,
      now: () => at,
      prepareQueuedEmail: noPrepare,
      logActivity: noLog,
      async sendEmail({ to }) {
        delivered.push(to)
        return { success: true }
      },
    })
  }
  return delivered
}

test(
  'o3d-alnk: the claim fence, the undelivered index and the migration collapse, on a database this lane created',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const lane = await openLane()

    try {
      await t.test('the lane is running against a database it created, and not against a real one', async () => {
        assert.match(lane.database.name, /^ims_throwaway_alnkfence_[0-9a-f]{16}$/)
        assert.notEqual(lane.database.name, lane.database.configuredDatabase)
        assert.notEqual(lane.database.name, 'onetwo3d_ims_dev')
        assert.ok(
          lane.database.url.includes(lane.database.name),
          'the lane URL does not name the database the lane created',
        )

        // AND IT IS MIGRATED, which is the other half of "provisioned": the partial unique index
        // only exists if `prisma migrate deploy` actually ran the migration under test.
        const index = await lane.sql.query('SELECT indexdef FROM pg_indexes WHERE indexname = $1', [UNDELIVERED_INDEX])
        assert.equal(index.rows.length, 1, `${UNDELIVERED_INDEX} is missing: the lane database was not migrated`)
      })

      await t.test('the lane REFUSES a database it did not create, by name (o3d-alnk r4)', async () => {
        // (a) POINTED AT ONE IT DID NOT CREATE — its own, which now exists. `CREATE DATABASE` is
        // the authority on "did this lane create it", and the refusal names the database.
        await assert.rejects(
          () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => lane.database.name }),
          (error: unknown) =>
            error instanceof ThrowawayDatabaseError
            && error.message.includes(lane.database.name)
            && /ALREADY EXISTS, so this lane did not create it/.test(error.message),
          'the lane provisioned a database that already existed',
        )

        // (b) POINTED AT THE CONFIGURED DATABASE — the live-served one on this host. Refused
        // before any connection is opened, and the refusal names it.
        await assert.rejects(
          () => provisionThrowawayDatabase({ label: 'alnkfence', mintName: () => lane.database.configuredDatabase }),
          (error: unknown) =>
            error instanceof ThrowawayDatabaseError
            && error.message.includes(lane.database.configuredDatabase),
          'the lane accepted the configured DATABASE_URL database',
        )

        // NON-VACUITY: it is not refusing everything. A freshly minted name provisions, and is
        // dropped immediately.
        const spare = await provisionThrowawayDatabase({ label: 'alnkspare' })
        try {
          assert.notEqual(spare.name, lane.database.name)
        } finally {
          await spare.drop()
        }
        const gone = await lane.sql.query('SELECT 1 FROM pg_database WHERE datname = $1', [spare.name])
        assert.equal(gone.rows.length, 0, 'drop() left the database behind')

        // (c) AND THE DROPPED NAME IS NEVER HANDED OUT AGAIN (r14), against a REAL server: the
        // database is provably gone — the query above just said so — and the name is still this
        // process's, because an ISSUED DROP is not a LANDED one and the register cannot tell the
        // difference without asking. Under r12 this provision SUCCEEDED, which is the window the
        // r14 finding is about; the unit proofs stage the window itself with a fake wire.
        await assert.rejects(
          () => provisionThrowawayDatabase({ label: 'alnkspare', mintName: () => spare.name }),
          (error: unknown) =>
            error instanceof ThrowawayDatabaseError
            && error.message.includes(spare.name)
            && /THIS PROCESS ALREADY HOLDS/.test(error.message),
          'a name this process had already issued a DROP for was provisioned again',
        )
        const stillGone = await lane.sql.query('SELECT 1 FROM pg_database WHERE datname = $1', [spare.name])
        assert.equal(stillGone.rows.length, 0, 'the refused provision created a database at the dropped name')
      })

      await t.test('a worker reclaimed while on the SMTP socket is REFUSED its terminal write', async () => {
        const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
        const reference = `fence-${randomUUID().slice(0, 8)}`
        const t0 = new Date()
        const deliveries: string[] = []

        await lane.db.emailOutbox.deleteMany({})
        const row = await lane.db.emailOutbox.create({
          data: {
            kind: 'ACCOUNTING_INVOICE',
            toEmail: FIXTURE_RECIPIENT,
            subject: 'fence probe',
            html: 'queued',
            referenceType: 'SalesOrder',
            referenceId: reference,
            status: 'PENDING',
            availableAt: new Date(t0.getTime() - 60_000),
          },
        })

        const client = laneHarnessClient(lane)
        const tReclaim = new Date(t0.getTime() + RECLAIM_AFTER_MS)
        let reclaimHappened = false

        // Worker A claims, then stalls on the socket. Worker B's whole run happens inside that
        // stall, against the same database.
        const workerA = await drainWith(processPendingEmailOutbox, {
          client,
          now: () => t0,
          prepareQueuedEmail: noPrepare,
          logActivity: noLog,
          async sendEmail() {
            deliveries.push('worker-A')
            const workerB = await drainWith(processPendingEmailOutbox, {
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

        // NON-VACUITY. A green here would mean nothing if B never took the row: the contended
        // path has to have been REACHED for the refusal to be evidence of anything.
        assert.equal(reclaimHappened, true, 'the contended path was not reached: worker B never reclaimed')
        assert.deepEqual(deliveries, ['worker-A', 'worker-B'], 'the reclaim itself always costs one duplicate')

        assert.equal(workerA.conflicted, 1, "worker A's refusal is recorded rather than silent")
        // AND IT IS THE POST-SEND COUNTER (r18): A was on the socket when it lost the row, so a
        // duplicate delivery really did happen here — `deliveries` above is asserted to hold both, which
        // is exactly what makes the suppression path, where nothing was sent, a different fact needing a
        // different counter. (The MESSAGE the drain prints says only that a duplicate is POSSIBLE, and
        // r35's HIGH 2 is why: this test arranges a sender that delivers, and production cannot know
        // that it did.)
        assert.equal(workerA.conflictedWithoutSend, 0, 'a send WAS attempted, so this is not the no-send refusal')
        assert.equal(workerA.failed, 0, 'and not scored against a row it no longer owns')

        const after = await lane.db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })
        assert.equal(after.status, 'SENT', "worker B's SENT stands — not overwritten with a re-armed PENDING")
        assert.equal(after.processingStartedAt, null)
        assert.equal(after.lockedBy, null, 'a settled row holds no claim')
        assert.equal(after.attempts, 0, "A's attempts+1 never landed either")
      })

      await t.test('Postgres refuses a second UNDELIVERED row, and allows a later re-send', async () => {
        const { queueEmail } = await import('@/lib/email-outbox')
        const reference = `enqueue-${randomUUID().slice(0, 8)}`
        const client = lane.db as unknown as EmailOutboxClient
        const email = {
          kind: 'ACCOUNTING_INVOICE',
          to: FIXTURE_RECIPIENT,
          subject: 'constraint probe',
          html: 'queued',
          referenceType: 'SalesOrder',
          referenceId: reference,
        }

        await lane.db.emailOutbox.deleteMany({})
        assert.deepEqual(await queueEmail(email, { client }), { queued: true })

        // THE PROOF: the second enqueue is refused by the partial unique index, and that refusal
        // reaches the caller as `already_queued` rather than as a thrown P2002. This is the
        // o3d-8td2 INVOICE_EMAIL replay: `xero/accounting.post` re-running its enqueue.
        assert.deepEqual(await queueEmail(email, { client }), { queued: false, reason: 'already_queued' })
        assert.equal(await lane.db.emailOutbox.count({ where: { referenceId: reference } }), 1, 'one row, not two')

        // Non-vacuity in both directions. A different KIND for the same reference is a different
        // logical email and is allowed...
        assert.deepEqual(await queueEmail({ ...email, kind: 'INVOICE' }, { client }), { queued: true })

        // ...and once the first row is delivered, a deliberate LATER re-send is allowed too. The
        // index is scoped to PENDING/PROCESSING precisely so it constrains duplicates rather than
        // decisions.
        await lane.db.emailOutbox.updateMany({
          where: { referenceId: reference, kind: 'ACCOUNTING_INVOICE' },
          data: { status: 'SENT', sentAt: new Date() },
        })
        assert.deepEqual(await queueEmail(email, { client }), { queued: true })
        assert.equal(
          await lane.db.emailOutbox.count({ where: { referenceId: reference, kind: 'ACCOUNTING_INVOICE' } }),
          2,
        )
      })

      /**
       * CODEX HIGH 4 — THE COLLAPSE'S RETENTION RULE, EVERY STATUS COMBINATION.
       *
       * The measured quantity is COPIES ATTRIBUTABLE TO THE COLLAPSE, and it has two parts:
       *
       *   DISCARDED-IN-FLIGHT. A PROCESSING row is one a worker has CLAIMED and may at this
       *   moment be on the SMTP socket for. Marking it FAILED stops no send — the send is already
       *   outside the database — so if the collapse discards one AND retains a row that will send,
       *   the customer gets two copies. This must be ZERO in every case.
       *
       *   FUTURE SENDS. What the drain actually delivers afterwards, measured over three passes
       *   spanning two stale windows so a re-armed or reclaimed row is counted rather than
       *   assumed absent. This must be AT MOST ONE.
       *
       * The CONTROL at the end runs the pre-fix "oldest wins" rule on the same fixture and shows
       * both quantities go to one — that is the two-copy outcome, asserted as an outcome.
       */
      await t.test('the collapse retains by STATUS, and no combination can produce two sends', async () => {
        const t0 = new Date('2026-09-10T09:00:00.000Z')
        const older = new Date(t0.getTime() - 4 * 60 * 60_000)
        const newer = new Date(t0.getTime() - 1 * 60 * 60_000)

        type Case = {
          name: string
          rows: SeedRow[]
          /** The row that must still be undelivered afterwards; null when nothing is collapsed. */
          keeper: string | null
          /** Rows that must be FAILED by the collapse. */
          failed: string[]
          /** Rows the collapse must not have touched at all. */
          untouched: string[]
          expectedSends: number
        }

        const cases: Case[] = [
          {
            name: 'two PENDING rows: nothing is on the wire, so the oldest is kept',
            rows: [
              { id: 'c1-old', status: 'PENDING', createdAt: older },
              { id: 'c1-new', status: 'PENDING', createdAt: newer },
            ],
            keeper: 'c1-old',
            failed: ['c1-new'],
            untouched: [],
            expectedSends: 1,
          },
          {
            name: 'PENDING is OLDER than PROCESSING: the CLAIMED row is kept anyway (HIGH 4)',
            rows: [
              { id: 'c2-pending-old', status: 'PENDING', createdAt: older },
              { id: 'c2-processing', status: 'PROCESSING', createdAt: newer },
            ],
            keeper: 'c2-processing',
            failed: ['c2-pending-old'],
            untouched: [],
            expectedSends: 1,
          },
          {
            name: 'PROCESSING is older: the same row is kept, so the rule does not depend on age',
            rows: [
              { id: 'c3-processing', status: 'PROCESSING', createdAt: older },
              { id: 'c3-pending', status: 'PENDING', createdAt: newer },
            ],
            keeper: 'c3-processing',
            failed: ['c3-pending'],
            untouched: [],
            expectedSends: 1,
          },
          {
            name: 'one PROCESSING among many PENDING: every PENDING sibling is failed',
            rows: [
              { id: 'c4-p1', status: 'PENDING', createdAt: older },
              { id: 'c4-p2', status: 'PENDING', createdAt: newer },
              { id: 'c4-processing', status: 'PROCESSING', createdAt: t0 },
            ],
            keeper: 'c4-processing',
            failed: ['c4-p1', 'c4-p2'],
            untouched: [],
            expectedSends: 1,
          },
          {
            name: 'an ATTEMPT-EXHAUSTED PENDING row is not the one retained, so the email is not lost',
            rows: [
              { id: 'c5-exhausted', status: 'PENDING', createdAt: older, attempts: 5 },
              { id: 'c5-fresh', status: 'PENDING', createdAt: newer, attempts: 0 },
            ],
            keeper: 'c5-fresh',
            failed: ['c5-exhausted'],
            untouched: [],
            expectedSends: 1,
          },
          {
            name: 'PENDING beside a SENT row: SENT is terminal, outside the index, and untouched',
            rows: [
              { id: 'c6-sent', status: 'SENT', createdAt: older },
              { id: 'c6-pending', status: 'PENDING', createdAt: newer },
            ],
            keeper: 'c6-pending',
            failed: [],
            untouched: ['c6-sent'],
            expectedSends: 1,
          },
          {
            name: 'PENDING beside a FAILED row: FAILED is terminal too, and is not resurrected',
            rows: [
              { id: 'c7-failed', status: 'FAILED', createdAt: older },
              { id: 'c7-pending', status: 'PENDING', createdAt: newer },
            ],
            keeper: 'c7-pending',
            failed: [],
            untouched: ['c7-failed'],
            expectedSends: 1,
          },
          {
            name: 'PROCESSING beside SENT and FAILED: the claimed row is kept and nothing terminal moves',
            rows: [
              { id: 'c8-sent', status: 'SENT', createdAt: older },
              { id: 'c8-failed', status: 'FAILED', createdAt: older },
              { id: 'c8-processing', status: 'PROCESSING', createdAt: newer },
            ],
            keeper: 'c8-processing',
            failed: [],
            untouched: ['c8-sent', 'c8-failed'],
            expectedSends: 1,
          },
          {
            name: 'two SENT rows for one key: a deliberate re-send history, left exactly as it is',
            rows: [
              { id: 'c9-sent-a', status: 'SENT', createdAt: older },
              { id: 'c9-sent-b', status: 'SENT', createdAt: newer },
            ],
            keeper: null,
            failed: [],
            untouched: ['c9-sent-a', 'c9-sent-b'],
            expectedSends: 0,
          },
          {
            name: 'undelivered rows with a NULL reference carry no identity, so none is collapsed',
            rows: [
              { id: 'c10-null-a', status: 'PENDING', createdAt: older, referenceType: null, referenceId: null },
              { id: 'c10-null-b', status: 'PENDING', createdAt: newer, referenceType: null, referenceId: null },
            ],
            keeper: null,
            failed: [],
            untouched: ['c10-null-a', 'c10-null-b'],
            expectedSends: 2,
          },
          {
            name: 'a lone PROCESSING row is not a duplicate and is not touched',
            rows: [{ id: 'c11-processing', status: 'PROCESSING', createdAt: older }],
            keeper: 'c11-processing',
            failed: [],
            untouched: ['c11-processing'],
            expectedSends: 1,
          },
        ]

        for (const testCase of cases) {
          const reference = `collapse-${randomUUID().slice(0, 8)}`
          await lane.sql.query(`DROP INDEX IF EXISTS "${UNDELIVERED_INDEX}"`)
          await seed(lane, reference, testCase.rows, t0)

          const before = await statuses(lane)
          await runShippedCollapse(lane)
          const after = await statuses(lane)

          // (1) NO POSSIBLY-IN-FLIGHT ROW WAS DISCARDED. This is the HIGH-4 property, and it is
          // measured against the rows as seeded, not against what the rule says it does.
          const discarded = [...before.entries()]
              .filter(([id, status]) => status === 'PROCESSING' && after.get(id) !== 'PROCESSING')
              .map(([id]) => id)
          assert.deepEqual(discarded, [], `${testCase.name}: the collapse discarded a CLAIMED row`)

          for (const id of testCase.failed) {
            assert.equal(after.get(id), 'FAILED', `${testCase.name}: ${id} should have been collapsed`)
          }
          for (const id of testCase.untouched) {
            assert.equal(after.get(id), before.get(id), `${testCase.name}: ${id} was touched`)
          }
          if (testCase.keeper !== null) {
            assert.equal(
              after.get(testCase.keeper),
              before.get(testCase.keeper),
              `${testCase.name}: the retained row ${testCase.keeper} did not survive unchanged`,
            )
          }

          // (2) AND THE DRAIN AFTERWARDS DELIVERS AT MOST ONE COPY PER LOGICAL EMAIL.
          const delivered = await futureSends(lane, t0)
          assert.equal(
            delivered.length,
            testCase.expectedSends,
            `${testCase.name}: the drain delivered ${delivered.length} copies, expected ${testCase.expectedSends}`,
          )
        }
      })

      await t.test('two PROCESSING rows for one logical email are REFUSED, not guessed at', async () => {
        const reference = `ambiguous-${randomUUID().slice(0, 8)}`
        const t0 = new Date('2026-09-10T09:00:00.000Z')
        await lane.sql.query(`DROP INDEX IF EXISTS "${UNDELIVERED_INDEX}"`)
        await seed(lane, reference, [
          { id: 'amb-a', status: 'PROCESSING', createdAt: new Date(t0.getTime() - 3600_000) },
          { id: 'amb-b', status: 'PROCESSING', createdAt: t0 },
        ], t0)
        const before = await statuses(lane)

        // NEITHER of these rows can be shown to have sent or not sent, so there is no ranking that
        // is safe: keep the wrong one and its reclaim mails a second copy on top of a send that
        // already went out. The migration stops, and it says which key stopped it.
        await assert.rejects(
          () => lane.sql.query(migrationBlock('refuse-ambiguous-processing')),
          (error: unknown) => {
            const message = (error as Error).message
            return /refusing to collapse duplicates for/.test(message)
              && message.includes('ACCOUNTING_INVOICE')
              && message.includes(reference)
              && message.includes('(2 rows)')
          },
          'the migration collapsed two PROCESSING rows instead of refusing',
        )

        assert.deepEqual(
          statusPairs(await statuses(lane)),
          statusPairs(before),
          'the refused migration still changed rows',
        )

        // NON-VACUITY: the same guard PASSES once the ambiguity is gone, so it is not a statement
        // that always throws.
        await lane.db.emailOutbox.updateMany({ where: { id: 'amb-b' }, data: { status: 'SENT' } })
        await lane.sql.query(migrationBlock('refuse-ambiguous-processing'))
      })

      await t.test('CONTROL: the pre-fix OLDEST-WINS rule really does produce two copies', async () => {
        const reference = `control-${randomUUID().slice(0, 8)}`
        const t0 = new Date('2026-09-10T09:00:00.000Z')
        await lane.sql.query(`DROP INDEX IF EXISTS "${UNDELIVERED_INDEX}"`)
        await seed(lane, reference, [
          { id: 'ctrl-pending-old', status: 'PENDING', createdAt: new Date(t0.getTime() - 4 * 3600_000) },
          { id: 'ctrl-processing', status: 'PROCESSING', createdAt: new Date(t0.getTime() - 3600_000) },
        ], t0)
        const before = await statuses(lane)

        await lane.sql.query(LEGACY_OLDEST_WINS_COLLAPSE)
        const after = await statuses(lane)

        // THE OUTCOME, NOT THE ABSENCE OF A THROW. The legacy rule discards the CLAIMED row —
        // whose send it cannot retract — and retains the PENDING one.
        const discarded = [...before.entries()]
            .filter(([id, status]) => status === 'PROCESSING' && after.get(id) !== 'PROCESSING')
            .map(([id]) => id)
        assert.deepEqual(discarded, ['ctrl-processing'], 'the legacy rule was expected to discard the claimed row')
        assert.equal(after.get('ctrl-pending-old'), 'PENDING', 'and to retain a row that will send again')

        // ...and that retained row DOES send. One copy already on the wire from ctrl-processing,
        // one more from here: two copies to the customer. This is Codex HIGH 4, reproduced.
        const delivered = await futureSends(lane, t0)
        assert.equal(delivered.length, 1, 'the retained PENDING row delivers a SECOND copy')
        assert.deepEqual(delivered, [FIXTURE_RECIPIENT])
      })

      /**
       * CODEX r6 MEDIUM — IF THE REFUSAL FIRES, THE DATABASE IS LEFT EXACTLY AS IT WAS, AND THE
       * RECOVERY THE HINT PRESCRIBES ACTUALLY WORKS.
       *
       * This runs `prisma migrate deploy` — the real runner, not a paraphrase — against a database
       * this sub-test provisions, strips back to the state before this migration, and seeds with the
       * ambiguity that makes the guard fire. Then it performs the HINT's recovery verbatim and shows
       * the deploy succeeds. A HINT that describes an impossible recovery is worse than no HINT, and
       * the only way to know which kind this is, is to do what it says.
       *
       * IT ALSO ASSERTS THE OPERATOR CAN READ THE REFUSAL. That is not decoration: with the DO block
       * INSIDE the explicit transaction, `migrate deploy` printed `current transaction is aborted`
       * and nothing else — the message, the DETAIL and the HINT were all lost, because the engine
       * records the outcome in `_prisma_migrations` on the same connection and that statement failed
       * first. Move the guard back inside BEGIN and this assertion goes red.
       */
      await t.test('the refusal leaves the database untouched, says why, and its recovery works', async () => {
        const scratch = await provisionThrowawayDatabase({ label: 'alnkmigrate' })
        try {
          const runPrisma = async (args: string[]): Promise<{ code: number; output: string }> => {
            try {
              const { stdout, stderr } = await execFileAsync(PRISMA_BIN, args, {
                cwd: REPO_ROOT,
                env: { ...process.env, DATABASE_URL: scratch.url },
                timeout: 300_000,
                maxBuffer: 32 * 1024 * 1024,
              })
              return { code: 0, output: `${stdout}\n${stderr}` }
            } catch (error) {
              const failure = error as { code?: number; stdout?: string; stderr?: string }
              return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}` }
            }
          }

          const { default: pg } = await import('pg')
          const sql = new pg.Client({ connectionString: scratch.url }) as unknown as PgClient
          await sql.connect()
          try {
            const hasColumn = async (): Promise<number> => {
              const rows = await sql.query(
                "SELECT 1 FROM information_schema.columns WHERE table_name = 'email_outbox' AND column_name = 'lockedBy'",
              )
              return rows.rows.length
            }
            const hasIndex = async (): Promise<number> => {
              const rows = await sql.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [UNDELIVERED_INDEX])
              return rows.rows.length
            }

            // Rewind to the state this migration is applied FROM, so the deploy below really is
            // this migration running for the first time against a database that has never had it.
            await sql.query(`DROP INDEX IF EXISTS "${UNDELIVERED_INDEX}"`)
            await sql.query('ALTER TABLE "email_outbox" DROP COLUMN "lockedBy"')
            await sql.query('DELETE FROM "_prisma_migrations" WHERE migration_name = $1', [FENCE_MIGRATION])
            await sql.query(
              `INSERT INTO "email_outbox"
                 (id, kind, "toEmail", subject, html, "referenceType", "referenceId", status, attempts,
                  "availableAt", "processingStartedAt", "createdAt", "updatedAt")
               VALUES
                 ('amb-a', 'ACCOUNTING_INVOICE', $1, 's', 'h', 'SalesOrder', 'ref-1', 'PROCESSING', 0,
                  now(), now(), now(), now()),
                 ('amb-b', 'ACCOUNTING_INVOICE', $1, 's', 'h', 'SalesOrder', 'ref-1', 'PROCESSING', 0,
                  now(), now(), now(), now())`,
              [FIXTURE_RECIPIENT],
            )

            assert.equal(await hasColumn(), 0, 'the rewind did not remove lockedBy')
            assert.equal(await hasIndex(), 0, 'the rewind did not remove the index')
            const before = await sql.query('SELECT id, status FROM "email_outbox" ORDER BY id')

            // (1) THE REFUSAL FIRES, THROUGH THE REAL RUNNER.
            const refused = await runPrisma(['migrate', 'deploy'])
            assert.notEqual(refused.code, 0, 'migrate deploy applied a migration it should have refused')
            assert.match(refused.output, /refusing to collapse duplicates for ACCOUNTING_INVOICE\/SalesOrder\/ref-1 \(2 rows\)/)

            // (2) THE OPERATOR CAN READ IT. Both halves matter: the actionable text is present, and
            // the message that used to REPLACE it is absent.
            assert.match(refused.output, /HINT: [\s\S]*prisma migrate resolve --rolled-back/)
            assert.doesNotMatch(
              refused.output,
              /current transaction is aborted/,
              'the refusal was masked by the engine bookkeeping error again: the guard is inside the explicit transaction',
            )

            // (3) THE DATABASE IS EXACTLY AS IT WAS. Not "mostly": the column the review was about,
            // the index, and the rows.
            assert.equal(await hasColumn(), 0, 'a refused migration left the lockedBy column behind')
            assert.equal(await hasIndex(), 0, 'a refused migration left the unique index behind')
            const afterRefusal = await sql.query('SELECT id, status FROM "email_outbox" ORDER BY id')
            assert.deepEqual(afterRefusal.rows, before.rows, 'a refused migration changed rows')

            // (4) AND THE RECOVERY THE HINT PRESCRIBES WORKS, done exactly as written: mark it rolled
            // back, settle the ambiguity, deploy again.
            const resolved = await runPrisma(['migrate', 'resolve', '--rolled-back', FENCE_MIGRATION])
            assert.equal(resolved.code, 0, `migrate resolve --rolled-back failed: ${resolved.output}`)
            await sql.query("UPDATE \"email_outbox\" SET status = 'SENT' WHERE id = 'amb-b'")
            const redeployed = await runPrisma(['migrate', 'deploy'])
            assert.equal(redeployed.code, 0, `the prescribed recovery did not work: ${redeployed.output}`)

            assert.equal(await hasColumn(), 1, 'the recovered deploy did not add lockedBy')
            assert.equal(await hasIndex(), 1, 'the recovered deploy did not create the index')
          } finally {
            await sql.end().catch(() => undefined)
          }
        } finally {
          await scratch.drop()
        }
      })

      /**
       * CODEX r6 LOW — WHAT THE CLEANUP NOW COVERS, AND WHAT IT CANNOT.
       *
       * The lane's `finally { lane.close() }` only begins once `openLane` has RETURNED, so a failure
       * in the dynamic imports, in `new PrismaClient`, or in `sql.connect()` used to leave a freshly
       * migrated database behind. That window is closed, and closed is DEMONSTRATED here rather than
       * asserted: the failure is injected at exactly that point and the database is then shown to be
       * gone from `pg_database`.
       *
       * A SECOND CATCHABLE WINDOW IS DELIBERATELY LEFT OPEN, AND IT IS NOT PROVED HERE. If
       * PostgreSQL executes `CREATE DATABASE` and the connection dies before the response arrives,
       * the provision rejects with the database possibly already made. r7 through r9 tried to
       * reclaim it — by dropping, then by a lock, then by an ownership stamp — and each attempt was
       * found unsound in a new way, because every one of them decided ownership from evidence a
       * third party can also produce. r10 stopped: `provisionThrowawayDatabase` now drops ONLY a
       * name whose own `CREATE` it saw complete, so that window LEAKS ONE DATABASE and the refusal
       * NAMES it. That is proved in `tests/throwaway-database-guard.test.ts` against a
       * module-mocked `pg` wire, because it needs a server that loses a response on demand — and
       * because a proof that only runs in this opt-in lane is a proof that mostly does not run.
       *
       * SO THERE ARE NOW TWO LEAKS WITH THE SAME MITIGATION, and the one below is the more brutal
       * of the two. Both are answered by the NAME.
       *
       * THE REMAINING HOLE IS DEMONSTRATED TOO, NOT WAVED AT. A process that is SIGKILLed — a hard
       * runner timeout, an OOM kill, the machine losing power — runs no `finally`, no `catch` and no
       * exit handler. The child below provisions a database and kills itself, and the parent then
       * finds that database still on the server. That is the honest boundary: what survives it is not
       * a guarantee but a NAME, `ims_throwaway_<label>_<16 hex>`, which says which lane made the
       * leftover and makes it safe to drop by hand. This test drops it, because it knows the name.
       */
      await t.test('a failure between provisioning and the first query drops the database; a SIGKILL cannot', async () => {
        // (a) THE WINDOW THAT IS NOW CLOSED.
        let provisioned: ThrowawayDatabase | null = null
        const injected = new Error('injected failure between provisioning and the first query')
        await assert.rejects(
          () => openLane({
            failAfterProvision: (database) => {
              provisioned = database
              throw injected
            },
          }),
          (error: unknown) => error === injected,
          'openLane swallowed the injected failure',
        )
        const abandoned = provisioned as ThrowawayDatabase | null
        assert.ok(abandoned, 'the failure hook never ran, so nothing was proved')
        const leftBehind = await lane.sql.query('SELECT 1 FROM pg_database WHERE datname = $1', [abandoned.name])
        assert.equal(leftBehind.rows.length, 0, `openLane left ${abandoned.name} behind`)

        // (b) THE HOLE THAT REMAINS. A child provisions, records the name, and SIGKILLs itself.
        const scratchDir = await mkdtemp(join(tmpdir(), 'alnk-sigkill-'))
        const namePath = join(scratchDir, 'name')
        const childPath = join(scratchDir, 'child.ts')
        let orphan: string | null = null
        try {
          // An async IIFE, not top-level await: this file is transformed to CJS by tsx and a
          // top-level await is a transform error there, which would fail the child for the wrong
          // reason and make the assertion below vacuous.
          await writeFile(childPath, [
            `import { writeFileSync } from 'node:fs'`,
            `import { provisionThrowawayDatabase } from ${JSON.stringify(THROWAWAY_HELPER_PATH)}`,
            `void (async () => {`,
            `  const database = await provisionThrowawayDatabase({ label: 'alnkkilled' })`,
            `  writeFileSync(${JSON.stringify(namePath)}, database.name)`,
            `  process.kill(process.pid, 'SIGKILL')`,
            `})()`,
            '',
          ].join('\n'), 'utf8')

          const killed = await new Promise<{ code: number | null; signal: string | null; noise: string }>((resolve) => {
            const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
              cwd: REPO_ROOT,
              env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            let noise = ''
            child.stdout?.on('data', (chunk: Buffer) => { noise += chunk.toString() })
            child.stderr?.on('data', (chunk: Buffer) => { noise += chunk.toString() })
            child.on('exit', (code, signal) => resolve({ code, signal, noise }))
          })

          assert.equal(
            killed.signal,
            'SIGKILL',
            `the child did not actually die the way this is about (code ${killed.code}): ${killed.noise.slice(-2000)}`,
          )
          orphan = (await readFile(namePath, 'utf8')).trim()
          assert.match(orphan, /^ims_throwaway_alnkkilled_[0-9a-f]{16}$/)

          // THE HOLE, MEASURED: the database is still there. No `finally` ran, and none could.
          const survived = await lane.sql.query('SELECT 1 FROM pg_database WHERE datname = $1', [orphan])
          assert.equal(
            survived.rows.length,
            1,
            'a SIGKILLed provision did NOT leave its database behind — if that is now true, say so here '
            + 'instead of claiming a hole that no longer exists',
          )
        } finally {
          // The mitigation, exercised: the NAME is enough to clean up by hand.
          if (orphan) await lane.sql.query(`DROP DATABASE IF EXISTS "${orphan.replace(/"/g, '""')}" WITH (FORCE)`)
          await rm(scratchDir, { recursive: true, force: true })
        }

        const cleaned = orphan
          ? await lane.sql.query('SELECT 1 FROM pg_database WHERE datname = $1', [orphan])
          : { rows: [] as Record<string, unknown>[] }
        assert.equal(cleaned.rows.length, 0, 'the orphan this test created is still on the server')
      })
    } finally {
      // UNCONDITIONAL. The database goes whether every proof above passed, one failed, or one
      // threw before the assertions were reached.
      await lane.close()
    }
  },
)
