import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-11rf r3 (Codex r2, HIGH) — WHAT THE VOID-BASIS BACKFILL REPAIRS, AND WHAT IT REFUSES TO GUESS.
 *
 * THE THING BEING ASSERTED IS WHICH ROWS A SQL PREDICATE SELECTS, so it is a property of PostgreSQL
 * and of nothing IMS computes. A double could only show the shape of a string we handed Prisma; it
 * could not show what a correlated `NOT EXISTS` over `accounting_event_logs` joined to
 * `accounting_sync_logs` does to a row, which is the entire question. So this reads THE MIGRATION
 * FILE ITSELF off disk and executes it — not a re-spelling of it, which could drift from the file
 * that will actually run and prove nothing about it.
 *
 * THE BAR THIS HAS TO CLEAR. A backfill that guesses is worse than no backfill: it re-opens retired
 * documents at scale rather than one at a time. So the repairable case is only one of the eight rows
 * below, and the other seven are the ones that must come out UNCHANGED — a test that only showed the
 * happy case would pass just as well against `SET "voidBasis" = 'attempt_settled_not_posted' WHERE
 * status = 'VOID'`, which is precisely the catastrophe.
 *
 * ORDERING IS PROVEN IRRELEVANT, NOT ASSUMED SO. Two ambiguous rows carry both witnesses with the
 * cancellation entry written FIRST in one and LAST in the other. Both must stay NULL. This is the
 * o3d-cvj9 trap stated as an assertion: `accounting_event_logs.createdAt` is TRANSACTION-START time,
 * so any rule that resolved these by "the latest entry wins" would answer differently for the two —
 * and would be reading a clock that cannot order entries written in one transaction anyway. A rule
 * that answers NULL for both is a rule that never consulted the clock.
 *
 * ROLLED BACK, ALWAYS. The migration's UPDATE is unrestricted by design — it has to reach every row
 * in the table — so it is run inside a transaction that always aborts, and the probe rows are
 * re-read from OUTSIDE that transaction afterwards to prove the database was left as it was found.
 * The assertions are made on values captured before the rollback.
 *
 * Gated behind RUN_DB_MIGRATION_TESTS=1: `npm run test:unit` has no database. Imports are RELATIVE
 * for the same reason as tests/concurrency/* and tests/db/*.
 */

const skip = process.env.RUN_DB_MIGRATION_TESTS !== '1'

const MIGRATION_SQL = path.join(
  process.cwd(),
  'prisma/migrations/20260908170000_accounting_event_void_basis_backfill/migration.sql',
)

const ATTEMPT = 'attempt_settled_not_posted'
const CANCELLED_BASIS = 'source_cancelled'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_MIGRATION_TESTS=1')
  }
}

/** Thrown to roll the probe transaction back. Nothing else may throw it. */
class RollbackProbe extends Error {}

type Shape = {
  /** What this row is, in the words the migration's own comment uses. */
  label: string
  /** The basis the row already carries. NULL for every row the backfill is allowed to consider. */
  voidBasis?: string | null
  status?: string
  /** A `voided_source_cancelled` entry — the witness the cancellation writer always leaves. */
  cancellationWitness?: boolean
  /** A `failed_from_sync_log` entry naming a sync row, plus that row. */
  settlementWitness?: {
    syncStatus: 'CANCELLED' | 'FAILED' | 'PENDING'
    settlementBasis: string | null
    externalTransactionId: string | null
  }
  /** Write the cancellation witness BEFORE the settlement one, or after. Must not matter. */
  cancellationFirst?: boolean
  expected: string | null
}

const SHAPES: Shape[] = [
  {
    label: 'a provable NOT_POSTED settlement: settlement witness, no cancellation witness',
    settlementWitness: { syncStatus: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION', externalTransactionId: null },
    expected: ATTEMPT,
  },
  {
    label: 'a cancellation void: the witness the cancellation writer always leaves',
    cancellationWitness: true,
    expected: null,
  },
  {
    label: 'AMBIGUOUS, cancellation witness written FIRST — both witnesses, no trustworthy order',
    cancellationWitness: true,
    cancellationFirst: true,
    settlementWitness: { syncStatus: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION', externalTransactionId: null },
    expected: null,
  },
  {
    label: 'AMBIGUOUS, cancellation witness written LAST — the same answer, which is the point',
    cancellationWitness: true,
    cancellationFirst: false,
    settlementWitness: { syncStatus: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION', externalTransactionId: null },
    expected: null,
  },
  {
    label: 'settled before settlement_basis existed to record it (o3d-nf9i): a real victim, unprovable',
    settlementWitness: { syncStatus: 'CANCELLED', settlementBasis: null, externalTransactionId: null },
    expected: null,
  },
  {
    label: 'a POSTED assertion on a CANCELLED sale: same status and basis, but it carries a document',
    settlementWitness: { syncStatus: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION', externalTransactionId: 'INV-11RF' },
    expected: null,
  },
  {
    label: 'a connector FAILURE, never settled: the audit action is shared, the sync row is not',
    settlementWitness: { syncStatus: 'FAILED', settlementBasis: null, externalTransactionId: null },
    expected: null,
  },
  {
    label: 'a VOID a writer already explained: the backfill only ever fills a NULL',
    voidBasis: CANCELLED_BASIS,
    settlementWitness: { syncStatus: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION', externalTransactionId: null },
    expected: CANCELLED_BASIS,
  },
  {
    label: 'a PENDING event beside a settled row: not VOID, so not this migration\'s business',
    status: 'PENDING',
    settlementWitness: { syncStatus: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION', externalTransactionId: null },
    expected: null,
  },
]

test('the void-basis backfill repairs only what it can prove, and ordering never decides (o3d-11rf)', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db')
  const sql = readFileSync(MIGRATION_SQL, 'utf8')
  // The file is the subject. If it ever stops being an idempotent, NULL-only UPDATE this test is no
  // longer testing what its comment says it is, so that is asserted rather than trusted.
  assert.match(sql, /"voidBasis" IS NULL/, 'the migration must only ever fill a NULL basis')
  assert.match(sql, /voided_source_cancelled/, 'the cancellation witness must be consulted')
  assert.doesNotMatch(sql, /ORDER BY|"createdAt"/, 'nothing may be decided by the untrustworthy clock')

  const run = randomUUID().slice(0, 8)
  const eventIds: string[] = []
  let observed: Array<{ id: string; voidBasis: string | null }> = []

  try {
    await db.$transaction(async (tx) => {
      for (const [index, shape] of SHAPES.entries()) {
        const eventId = `11rf-${run}-e${index}`
        const syncLogId = `11rf-${run}-s${index}`
        eventIds.push(eventId)

        await tx.accountingEvent.create({
          data: {
            id: eventId,
            type: 'SALES_INVOICE',
            sourceEntityType: 'SalesOrder',
            sourceEntityId: `11rf-${run}-o${index}`,
            businessDate: new Date('2026-01-01T00:00:00Z'),
            status: shape.status ?? 'VOID',
            idempotencyKey: `${eventId}-key`,
            linesJson: [],
            currency: 'GBP',
            externalSystem: 'xero',
            voidBasis: shape.voidBasis ?? null,
          },
        })

        const writeCancellation = async () => {
          if (!shape.cancellationWitness) return
          await tx.accountingEventLog.create({
            data: { accountingEventId: eventId, action: 'voided_source_cancelled', metadata: { reason: 'probe' } },
          })
        }
        const writeSettlement = async () => {
          if (!shape.settlementWitness) return
          await tx.accountingSyncLog.create({
            data: {
              id: syncLogId,
              connector: 'xero',
              type: 'SALES_INVOICE',
              status: shape.settlementWitness.syncStatus,
              referenceType: 'SalesOrder',
              referenceId: `11rf-${run}-o${index}`,
              externalTransactionId: shape.settlementWitness.externalTransactionId,
              settlementBasis: shape.settlementWitness.settlementBasis,
            },
          })
          await tx.accountingEventLog.create({
            data: { accountingEventId: eventId, action: 'failed_from_sync_log', metadata: { syncLogId } },
          })
        }

        if (shape.cancellationFirst === true) { await writeCancellation(); await writeSettlement() }
        else { await writeSettlement(); await writeCancellation() }
      }

      // THE MIGRATION, VERBATIM, ON THE SCHEMA THE MIGRATIONS BUILT.
      await tx.$executeRawUnsafe(sql)

      observed = await tx.accountingEvent.findMany({
        where: { id: { in: eventIds } },
        select: { id: true, voidBasis: true },
        orderBy: { id: 'asc' },
      })
      throw new RollbackProbe()
    }, { timeout: 30000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }

  const byId = new Map(observed.map((row) => [row.id, row.voidBasis]))
  assert.equal(byId.size, SHAPES.length, 'every probe row was read back inside the transaction')

  for (const [index, shape] of SHAPES.entries()) {
    assert.equal(
      byId.get(`11rf-${run}-e${index}`) ?? null,
      shape.expected,
      shape.label,
    )
  }

  // NOT VACUOUS: exactly one shape is repaired, and it is the one with a settlement witness and no
  // cancellation witness. A predicate that matched more broadly (or not at all) fails here.
  const repaired = [...byId.values()].filter((basis) => basis === ATTEMPT)
  assert.equal(repaired.length, 1, 'exactly one of the nine shapes is provable, and the rest are refused')

  // And the transaction really did abort: nothing survives outside it.
  const survivors = await db.accountingEvent.count({ where: { id: { in: eventIds } } })
  assert.equal(survivors, 0, 'the probe rolled back and left the database as it found it')
})

test('the backfill is idempotent: a second application changes nothing (o3d-11rf)', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db')
  const sql = readFileSync(MIGRATION_SQL, 'utf8')
  const run = randomUUID().slice(0, 8)
  const eventId = `11rf-idem-${run}`
  const syncLogId = `11rf-idem-s-${run}`
  let first: string | null = null
  let second: string | null = null

  try {
    await db.$transaction(async (tx) => {
      await tx.accountingEvent.create({
        data: {
          id: eventId,
          type: 'SALES_INVOICE',
          sourceEntityType: 'SalesOrder',
          sourceEntityId: `11rf-idem-o-${run}`,
          businessDate: new Date('2026-01-01T00:00:00Z'),
          status: 'VOID',
          idempotencyKey: `${eventId}-key`,
          linesJson: [],
          currency: 'GBP',
          externalSystem: 'xero',
        },
      })
      await tx.accountingSyncLog.create({
        data: {
          id: syncLogId,
          connector: 'xero',
          type: 'SALES_INVOICE',
          status: 'CANCELLED',
          referenceType: 'SalesOrder',
          referenceId: `11rf-idem-o-${run}`,
          settlementBasis: 'OPERATOR_ASSERTION',
        },
      })
      await tx.accountingEventLog.create({
        data: { accountingEventId: eventId, action: 'failed_from_sync_log', metadata: { syncLogId } },
      })

      await tx.$executeRawUnsafe(sql)
      first = (await tx.accountingEvent.findUniqueOrThrow({ where: { id: eventId }, select: { voidBasis: true } })).voidBasis
      await tx.$executeRawUnsafe(sql)
      second = (await tx.accountingEvent.findUniqueOrThrow({ where: { id: eventId }, select: { voidBasis: true } })).voidBasis
      throw new RollbackProbe()
    }, { timeout: 30000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }

  assert.equal(first, ATTEMPT, 'the first application repairs the provable row')
  assert.equal(second, ATTEMPT, 'and the second leaves it exactly as the first did')
})
