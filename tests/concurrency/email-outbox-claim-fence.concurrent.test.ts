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
 * NO EMAIL IS SENT. Every drain below is given a fake sender that appends to an array, and the
 * option union plus `assertBothOrNeitherInjected` make a drain with a fake sender and the GLOBAL
 * client refuse before it reads a row.
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
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { config } from 'dotenv'

import type { EmailOutboxClient } from '@/lib/email-outbox'
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
const FIXTURE_RECIPIENT = 'nobody@example.test'

/** 15 minutes is EMAIL_CLAIM_STALE_MS; 16 puts a reclaim just past it. */
const RECLAIM_AFTER_MS = 16 * 60_000

const noPrepare = async () => null
const noLog = async () => undefined

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
  close: () => Promise<void>
}

async function openLane(): Promise<Lane> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }

  const database = await provisionThrowawayDatabase({ label: 'alnkfence' })

  const [{ PrismaClient }, { PrismaPg }, { default: pg }] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('pg'),
  ])

  // Config form, NOT `new PrismaPg(pool)` (o3d-4ajo): a second copy of `pg` fails the adapter's
  // `instanceof` check, the Pool is used as a connection CONFIG, and startup dies in the socket
  // callback with an unsettled promise.
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url, max: 5 }) })
  const sql = new pg.Client({ connectionString: database.url }) as unknown as PgClient
  await sql.connect()

  return {
    database,
    db: db as unknown as Lane['db'],
    sql,
    close: async () => {
      // Ordered: let go of every connection before DROP DATABASE, even though it is FORCEd.
      await sql.end().catch(() => undefined)
      await db.$disconnect().catch(() => undefined)
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
  const delivered: string[] = []
  for (const at of [t0, new Date(t0.getTime() + RECLAIM_AFTER_MS), new Date(t0.getTime() + 2 * RECLAIM_AFTER_MS)]) {
    await processPendingEmailOutbox({
      client: lane.db as unknown as EmailOutboxClient,
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

        const client = lane.db as unknown as EmailOutboxClient
        const tReclaim = new Date(t0.getTime() + RECLAIM_AFTER_MS)
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

        // NON-VACUITY. A green here would mean nothing if B never took the row: the contended
        // path has to have been REACHED for the refusal to be evidence of anything.
        assert.equal(reclaimHappened, true, 'the contended path was not reached: worker B never reclaimed')
        assert.deepEqual(deliveries, ['worker-A', 'worker-B'], 'the reclaim itself always costs one duplicate')

        assert.equal(workerA.conflicted, 1, "worker A's refusal is recorded rather than silent")
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
    } finally {
      // UNCONDITIONAL. The database goes whether every proof above passed, one failed, or one
      // threw before the assertions were reached.
      await lane.close()
    }
  },
)
