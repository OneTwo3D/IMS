import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { provisionThrowawayDatabase, type ThrowawayDatabase } from '@/tests/helpers/throwaway-database'
import { expectedDisposableDatabaseMarker } from '@/lib/disposable-database-marker'

/**
 * o3d-psrx r5 (Codex HIGH 2) — AN UNRESOLVED REVERSAL IS STILL WORKED AFTER THE RETENTION WINDOW.
 *
 * The withheld-reversal marker IS the work item: round 4 built the queue out of activity rows on
 * purpose, so that an entry can only exist if an operator was actually told. Two things then quietly
 * threw the queue away.
 *
 *   THE SCAN'S OWN HORIZON. `openWithheldDocuments` ignored anything older than thirty days, on the
 *   reasoning that an open marker is rewritten every time it is reconsidered. True, and it is the
 *   poll NOT RUNNING that produces an old marker — a disabled connector, an expired credential, a
 *   maintenance window, a poller erroring every cycle — and a failed recheck deliberately leaves the
 *   marker untouched. The watermark had already advanced, so nothing else ever brings the document
 *   back.
 *
 *   ACTIVITY-LOG RETENTION. The open markers are WARNING rows in a table this repository prunes on a
 *   configurable schedule. Sixty days by default, oldest first — which is exactly the documents
 *   nobody has resolved.
 *
 * Both are the stranding the watermark fix existed to prevent, on a slower clock: `paidAt` left
 * standing against a ledger that disagrees, and nothing left to say so.
 *
 * THE FIXTURES ARE FOUR HUNDRED DAYS OLD, well past any horizon and any plausible retention setting,
 * and the test ASSERTS that before it asserts anything else — a fixture inside the window would pass
 * both halves of this file while proving neither.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 *
 * =================================================================================================
 * o3d-1q28 — THIS LANE PROVISIONS ITS OWN DATABASE, AND THE SWEEP IT DRIVES REFUSES ANY OTHER.
 *
 * WHAT THIS FILE USED TO DO. It called `purgeExpiredActivityLogs()` — twice — against whatever
 * `DATABASE_URL` named. That sweep takes no client and no predicate: it imports the module-level
 * `db` and issues an unbounded oldest-first `DELETE FROM activity_logs` loop, 10,000 rows per batch
 * per level until a short batch. Nothing in it is tied to this file's fixtures: no `entityId`, no
 * `id IN`, no run tag. On this host `DATABASE_URL` names the LIVE-SERVED dev database, the only
 * populated IMS database in existence, so the call permanently deleted every real activity-log row
 * past retention — oldest first, which is the part of an audit trail nobody has looked at — and the
 * `t.after` cleanup below, which removes the ids it seeded, cannot put any of it back.
 *
 * WHY SCOPING WAS NOT AVAILABLE. There is no seam to scope. That is what settled the shape here as
 * it did in o3d-alnk r4: THE LANE PROVISIONS ITS OWN DATABASE. A database this lane created has no
 * real activity-log rows in it, so an unbounded oldest-first DELETE loop is harmless and the SHIPPED
 * sweep can be driven unchanged — which is the whole value of this file. `DATABASE_URL` is pointed
 * at the lane's database before `@/lib/db` is first imported, so the module-level client every
 * production function here reaches for is bound to it.
 *
 * AND THE SWEEP ITSELF NOW REFUSES. Pointing the lane elsewhere is configuration, and configuration
 * being wrong is the entire defect — so `purgeExpiredActivityLogs` asks, on the connection it is
 * about to delete through, whether the database it reached carries the o3d-zzgp disposable stamp,
 * and throws naming the database if it does not (lib/activity-log-cleanup.ts). The third subtest
 * below PROVES that refusal against this real server by taking the stamp off and putting it back;
 * the pure branches are in tests/activity-log-purge-disposable-target.test.ts.
 *
 * TWO MORE THINGS THE OWN DATABASE FIXES, both of which used to make this file's verdict depend on
 * whatever happened to be in the dev database:
 *
 *   THE PRECONDITION WAS READ OUT OF THE LIVE DATABASE. `swept.retention.WARNING` comes from the
 *   `settings` table, and `days <= 0` means keep-forever — so an installation with
 *   `activity_log_retention_warning = 0` failed the assertion for a reason with nothing to do with
 *   the invariant. The lane now SETS the three retention settings in its own database and asserts
 *   the sweep used exactly those.
 *
 *   `openWithheldDocuments` IS A GLOBAL `ORDER BY openMax ASC LIMIT 400` SCAN. Four hundred older
 *   real open markers pushed these fixtures off the page and the positive assertions failed
 *   spuriously. In a database this lane created, the only markers are the fixtures.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

const DAY_MS = 24 * 60 * 60 * 1000
const AGED_DAYS = 400

/** What the lane puts in its own database, so the assertions below are about the invariant. */
const LANE_RETENTION = { INFO: 30, WARNING: 60, ERROR: 90 } as const

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS)

type PgClient = {
  connect(): Promise<void>
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
}

/** The application client, typed from the module this file loads dynamically. */
type AppDb = typeof import('@/lib/db')['db']

type Lane = {
  database: ThrowawayDatabase
  db: AppDb
  sql: PgClient
  close(): Promise<void>
}

/**
 * PROVISION, POINT `DATABASE_URL` AT IT, AND ONLY THEN LOAD `@/lib/db`.
 *
 * The order is the whole mechanism. Every production function this file drives —
 * `purgeExpiredActivityLogs`, `openWithheldDocuments` — imports the module-level client, which is
 * built once from the environment the first time the module is loaded. Nothing in this file imports
 * it before this function runs (the throwaway helper talks to Postgres through `pg` directly), so
 * the client the shipped code reaches for is the lane's.
 *
 * As in o3d-alnk r6, everything between the provision and the return is inside a try that drops the
 * database before re-throwing: the caller's `finally` only begins once this has RETURNED.
 */
async function openLane(): Promise<Lane> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const configured = process.env.DATABASE_URL
  if (!configured) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!configured.startsWith('postgres://') && !configured.startsWith('postgresql://')) {
    throw new Error('o3d-psrx r5 concurrency test requires a Postgres DATABASE_URL')
  }

  const database = await provisionThrowawayDatabase({ label: 'psrx5marker' })

  let sql: PgClient | null = null
  try {
    const { default: pg } = await import('pg')
    sql = new pg.Client({ connectionString: database.url }) as unknown as PgClient
    await sql.connect()

    // THE STAMP, on a database this process watched itself create. This is what licenses the sweep
    // (o3d-1q28) — and `assertThrowawayDatabaseName` has already refused any protected name, the
    // configured database, and any name this module did not mint, so the `COMMENT ON DATABASE`
    // below cannot land anywhere else. The marker names the database inside itself, so it is
    // invalid for any other.
    await stamp(sql, database.name, expectedDisposableDatabaseMarker(database.name))

    // NOW the environment is the lane's, and only now is the application client loaded.
    process.env.DATABASE_URL = database.url
    const { db } = await import('@/lib/db')
    const [{ current_database: reached }] = await db.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database()::text AS current_database
    `
    assert.equal(reached, database.name, 'the application client must be bound to the lane database')

    for (const [level, days] of Object.entries(LANE_RETENTION)) {
      const key = `activity_log_retention_${level.toLowerCase()}`
      await db.setting.upsert({
        where: { key },
        update: { value: String(days) },
        create: { key, value: String(days) },
      })
    }

    return {
      database,
      db,
      sql,
      close: async () => {
        await db.$disconnect().catch(() => undefined)
        await sql?.end().catch(() => undefined)
        process.env.DATABASE_URL = configured
        await database.drop()
      },
    }
  } catch (error) {
    await sql?.end().catch(() => undefined)
    process.env.DATABASE_URL = configured
    await database.drop()
    throw error
  }
}

/** `COMMENT ON DATABASE` takes no parameters, so the two literals are quoted by hand. */
async function stamp(sql: PgClient, name: string, marker: string | null): Promise<void> {
  const ident = `"${name.replace(/"/g, '""')}"`
  const literal = marker === null ? 'NULL' : `'${marker.replace(/'/g, "''")}'`
  await sql.query(`COMMENT ON DATABASE ${ident} IS ${literal}`)
}

async function databaseComment(sql: PgClient): Promise<string | null> {
  const { rows } = await sql.query(
    `SELECT shobj_description(d.oid, 'pg_database') AS comment FROM pg_database d WHERE d.datname = current_database()`,
  )
  return (rows[0]?.comment as string | null) ?? null
}

async function writeMarker(
  db: AppDb,
  row: { id: string; entityId: string; action: string; level: 'INFO' | 'WARNING'; connector: string | null; createdAt: Date },
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "activity_logs" (id, "entityType", "entityId", action, tag, level, description, metadata, "createdAt")
     VALUES ($1, 'SALES_ORDER'::"ActivityEntityType", $2, $3, 'sync', $4::"ActivityLogLevel", 'o3d-psrx r5 probe',
             $5::jsonb, $6::timestamptz AT TIME ZONE 'UTC')`,
    row.id,
    row.entityId,
    row.action,
    row.level,
    row.connector === null ? JSON.stringify({}) : JSON.stringify({ connector: row.connector }),
    row.createdAt.toISOString(),
  )
}

async function survivingIds(db: AppDb, ids: string[]): Promise<Set<string>> {
  const rows = await db.activityLog.findMany({ where: { id: { in: ids } }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

test(
  '[o3d-psrx r5] withheld markers outlive every horizon, in a database this lane created',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const lane = await openLane()
    const { db } = lane
    try {
      await t.test('[o3d-1q28] the sweep refuses this very database once its stamp is gone', async () => {
        const { purgeExpiredActivityLogs, ActivityLogPurgeRefusedError } =
          await import('@/lib/activity-log-cleanup')

        // A ROW THAT WOULD BE DELETED IF THE SWEEP RAN, so the refusal below is not vacuous: an aged
        // unexempt WARNING, which the guarded sweep in the next subtest does delete.
        const witness = `al-guard-${process.pid}-${randomUUID()}`
        await writeMarker(db, {
          id: witness, entityId: `PSRX5-GUARD-${witness}`, action: 'payment_reversal_probe_control',
          level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS),
        })

        await stamp(lane.sql, lane.database.name, null)
        assert.equal(await databaseComment(lane.sql), null, 'the precondition: the stamp really is off')

        await assert.rejects(
          () => purgeExpiredActivityLogs(),
          (error: unknown) => {
            assert.ok(error instanceof ActivityLogPurgeRefusedError, `wrong error type: ${String(error)}`)
            assert.ok(
              error.message.includes(lane.database.name),
              `the refusal must name the database it refused: ${error.message}`,
            )
            return true
          },
          'an unstamped database is exactly the case the defect was: the sweep must not delete from it',
        )
        assert.ok(
          (await survivingIds(db, [witness])).has(witness),
          'and it refused BEFORE the first batch — the row a stamped sweep deletes is still here',
        )

        await stamp(lane.sql, lane.database.name, expectedDisposableDatabaseMarker(lane.database.name))
        assert.equal(await databaseComment(lane.sql), expectedDisposableDatabaseMarker(lane.database.name))
        await db.activityLog.deleteMany({ where: { id: witness } })
      })

      await t.test('a marker older than every horizon is still in the recheck queue', async () => {
        const { openWithheldDocuments, dueWithheldMarkers, withheldEntityKey } =
          await import('@/lib/domain/accounting/withheld-reversal-markers')

        const run = `${process.pid}-${randomUUID()}`
        const stranded = `PSRX5-STRANDED-${run}`
        const settled = `PSRX5-SETTLED-${run}`
        const reconsidered = `PSRX5-RECONSIDERED-${run}`
        const ids: string[] = []
        const marker = async (row: Parameters<typeof writeMarker>[1]) => { ids.push(row.id); await writeMarker(db, row) }

        // The document a poll outage stranded: withheld once, never reconsidered since.
        await marker({ id: `al-str-${run}`, entityId: stranded, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
        // The CONTROL that keeps "return everything old" from passing: this one was settled.
        await marker({ id: `al-set-o-${run}`, entityId: settled, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
        await marker({ id: `al-set-c-${run}`, entityId: settled, action: 'payment_reversal_withheld_cleared', level: 'INFO', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 1) })
        // And one that HAS been reconsidered, so its history must not be what the scan reads its timer from.
        await marker({ id: `al-rec-o1-${run}`, entityId: reconsidered, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
        await marker({ id: `al-rec-o2-${run}`, entityId: reconsidered, action: 'payment_reversal_recheck_deferred', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 50) })

        // THE PRECONDITION. Round 4's horizon was thirty days; if these rows were inside it the
        // assertions below would hold for the wrong reason.
        assert.equal(AGED_DAYS - 50 > 30, true, 'every fixture must be older than the horizon this finding removed')

        const { open, closed } = await openWithheldDocuments({ connector: 'xero', legacyOwner: true })
        const openByKey = new Map(open.map((m) => [withheldEntityKey(m.entityType, m.entityId), m]))

        assert.ok(openByKey.has(withheldEntityKey('SALES_ORDER', stranded)),
          'a withheld reversal nobody reconsidered for over a year is still open work')
        assert.ok(!openByKey.has(withheldEntityKey('SALES_ORDER', settled)),
          'and a settled one has left the candidate set for good')

        const reconsideredMarker = openByKey.get(withheldEntityKey('SALES_ORDER', reconsidered))
        assert.ok(reconsideredMarker, 'a reconsidered document is still open')
        assert.equal(
          Math.round((Date.now() - reconsideredMarker.createdAt.getTime()) / DAY_MS), AGED_DAYS - 50,
          'and the timer is read from its LAST reconsideration, not from its history',
        )

        const due = dueWithheldMarkers(open, closed, Date.now())
        const dueKeys = new Set(due.map((m) => withheldEntityKey(m.entityType, m.entityId)))
        assert.ok(dueKeys.has(withheldEntityKey('SALES_ORDER', stranded)),
          'the stranded document is DUE — the whole point is that it goes back in front of the poller')
        assert.ok(!dueKeys.has(withheldEntityKey('SALES_ORDER', settled)))

        await db.activityLog.deleteMany({ where: { id: { in: ids } } })
      })

      await t.test('activity retention keeps the open marker and releases everything else', async () => {
        const { purgeExpiredActivityLogs } = await import('@/lib/activity-log-cleanup')

        const run = `${process.pid}-${randomUUID()}`
        const open = `PSRX5-R-OPEN-${run}`
        const settled = `PSRX5-R-SETTLED-${run}`
        const twoConnectors = `PSRX5-R-BOTH-${run}`
        const ids: string[] = []
        const marker = async (row: Parameters<typeof writeMarker>[1]) => { ids.push(row.id); await writeMarker(db, row) }

        // Still open: one current marker, and one history row from an earlier reconsideration.
        await marker({ id: `al-ro-old-${run}`, entityId: open, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
        await marker({ id: `al-ro-new-${run}`, entityId: open, action: 'payment_reversal_recheck_deferred', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 100) })
        // Settled: the closure must outlive the marker it settles, then go.
        await marker({ id: `al-rs-open-${run}`, entityId: settled, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
        await marker({ id: `al-rs-close-${run}`, entityId: settled, action: 'payment_reversal_withheld_cleared', level: 'INFO', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 1) })
        // One document, two connectors. The newer XERO marker must not license deleting the QuickBooks
        // one — a marker scoped to a poller that is not running is not a marker that has been answered.
        await marker({ id: `al-rb-qbo-${run}`, entityId: twoConnectors, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'quickbooks', createdAt: daysAgo(AGED_DAYS) })
        await marker({ id: `al-rb-xero-${run}`, entityId: twoConnectors, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 100) })
        // THE CONTROL THAT PROVES THE SWEEP REACHED THESE ROWS AT ALL. An ordinary aged `sync` WARNING,
        // same table, same age, no exemption: if this survives, the test has proved nothing.
        await marker({ id: `al-ctl-${run}`, entityId: open, action: 'payment_reversal_probe_control', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })

        const swept = await purgeExpiredActivityLogs()
        // THE PRECONDITION, AND IT IS NOW A FACT ABOUT THIS LANE'S OWN DATABASE (o3d-1q28). The
        // retention rows were written by `openLane`, so the window is known rather than read out of
        // whatever installation the URL reached — where `activity_log_retention_warning = 0` (which
        // means keep-forever) failed this assertion for a reason unrelated to the invariant.
        assert.deepEqual(
          { INFO: swept.retention.INFO, WARNING: swept.retention.WARNING, ERROR: swept.retention.ERROR },
          { INFO: LANE_RETENTION.INFO, WARNING: LANE_RETENTION.WARNING, ERROR: LANE_RETENTION.ERROR },
          'the sweep used the window this lane set',
        )
        assert.ok(LANE_RETENTION.WARNING > 0 && LANE_RETENTION.WARNING < AGED_DAYS - 100,
          `WARNING retention ${LANE_RETENTION.WARNING}d must leave the fixtures outside the window`)
        assert.ok(LANE_RETENTION.INFO > 0 && LANE_RETENTION.INFO < AGED_DAYS - 1,
          `INFO retention ${LANE_RETENTION.INFO}d must leave the closure outside the window`)

        let alive = await survivingIds(db, ids)

        assert.ok(!alive.has(`al-ctl-${run}`), 'the sweep must actually have deleted an unexempt aged row')
        assert.ok(alive.has(`al-ro-new-${run}`), 'the open document keeps its CURRENT marker')
        assert.ok(!alive.has(`al-ro-old-${run}`), 'and lets its superseded history expire — the exemption is one row, not a log')
        assert.ok(alive.has(`al-rb-qbo-${run}`), "the other connector's open marker is not answered by this one's")
        assert.ok(alive.has(`al-rb-xero-${run}`))
        assert.ok(!alive.has(`al-rs-open-${run}`), 'a settled document releases its marker')
        assert.ok(alive.has(`al-rs-close-${run}`),
          'but its closure outlives it — INFO expires a month before WARNING, and a lone survivor would read as open again')

        // AND IT TERMINATES. With no open row left to protect it, the closure goes on the next sweep.
        await purgeExpiredActivityLogs()
        alive = await survivingIds(db, ids)
        assert.ok(!alive.has(`al-rs-close-${run}`), 'the settled document leaves nothing behind at all')
        assert.ok(alive.has(`al-ro-new-${run}`), 'and the open one is still open')
        assert.ok(alive.has(`al-rb-qbo-${run}`))

        await db.activityLog.deleteMany({ where: { id: { in: ids } } })
      })
    } finally {
      await lane.close()
    }
  },
)
