import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { expectedDisposableDatabaseMarker } from '@/lib/disposable-database-marker'
import { expectedScratchDatabaseMarker } from './concurrency/scratch-database-guard'

// ---------------------------------------------------------------------------
// o3d-1q28 — THE UNBOUNDED ACTIVITY-LOG SWEEP MUST REFUSE A DATABASE NOBODY DECLARED DESTROYABLE.
//
// `purgeExpiredActivityLogs` is an unbounded oldest-first DELETE loop over `activity_logs` with no
// client argument and no predicate seam, and a concurrency test drives it twice. Against a populated
// database that permanently deletes every real row past retention — oldest first, which is the part
// of an audit trail nobody has looked at — and the test's own id-scoped cleanup cannot put any of it
// back. Under the concurrency tier the sweep therefore runs only against a database carrying the
// o3d-zzgp disposable stamp, and the refusal names the database it refused.
//
// EVERY BRANCH IS PROVED TWICE OVER: once as the pure verdict (no database at all), and once through
// the real sweep against a fake client, where what is asserted is that NO `DELETE` STATEMENT WAS
// ISSUED. A guard that throws after the first batch has already destroyed 10,000 rows.
// ---------------------------------------------------------------------------

const DISPOSABLE = 'ims_throwaway_probe_0123456789abcdef'
const LIVE = 'onetwo3d_ims_dev'

/**
 * EVERY reference to the module under test is loaded through here, AFTER `mock.module` below has
 * replaced `@/lib/db`. A static import at the top of this file would pull in the real client — and
 * on this host the real client's `DATABASE_URL` is the live-served dev database.
 */
const loadCleanup = () => import('@/lib/activity-log-cleanup')
const CONCURRENCY_TIER_ENV = 'RUN_DB_CONCURRENCY_TESTS'

test('o3d-1q28: the stamp the sweep demands is the one the tier gate and the stamper issue', () => {
  // ONE definition (lib/disposable-database-marker.ts). If these two ever diverge, the sweep starts
  // refusing every database the stamper stamps — or, worse, accepting one it did not.
  assert.equal(expectedDisposableDatabaseMarker(DISPOSABLE), expectedScratchDatabaseMarker(DISPOSABLE))
  assert.match(expectedDisposableDatabaseMarker(DISPOSABLE), new RegExp(`\\(${DISPOSABLE}\\)`))
})

test('o3d-1q28: the verdict — what is refused, and what the refusal says', async () => {
  const { activityLogPurgeTargetVerdict, CONCURRENCY_TIER_ENV: exported } = await loadCleanup()
  assert.equal(exported, CONCURRENCY_TIER_ENV, 'the flag this file sets is the flag the guard reads')

  const stamped = {
    tierEnabled: true,
    connectedDatabase: DISPOSABLE,
    databaseComment: expectedDisposableDatabaseMarker(DISPOSABLE),
  }
  assert.equal(activityLogPurgeTargetVerdict(stamped).ok, true, 'a stamped database is the one case that passes')

  // THE DEFECT ITSELF: the live-served dev database, unstamped.
  const live = activityLogPurgeTargetVerdict({ ...stamped, connectedDatabase: LIVE, databaseComment: null })
  assert.equal(live.ok, false)
  assert.ok(!live.ok && live.reason.includes(LIVE), 'the refusal names the database it refused')
  assert.ok(!live.ok && live.reason.includes('db:stamp-scratch'), 'and says what would make one acceptable')

  // A stamp issued for ANOTHER database name — a rename or a restore carries the comment along.
  assert.equal(
    activityLogPurgeTargetVerdict({
      ...stamped,
      connectedDatabase: LIVE,
      databaseComment: expectedDisposableDatabaseMarker(DISPOSABLE),
    }).ok,
    false,
    'a marker naming a different database does not license deleting from this one',
  )
  // Near-misses: trailing whitespace, the prefix alone, the sentence without the name.
  for (const comment of [
    `${expectedDisposableDatabaseMarker(DISPOSABLE)} `,
    'ims-scratch-database',
    'created for a test run and safe to destroy (o3d-zzgp)',
    '',
  ]) {
    assert.equal(
      activityLogPurgeTargetVerdict({ ...stamped, databaseComment: comment }).ok,
      false,
      `an inexact comment must not pass: ${JSON.stringify(comment)}`,
    )
  }
  // A server that cannot name itself establishes nothing.
  assert.equal(activityLogPurgeTargetVerdict({ ...stamped, connectedDatabase: '' }).ok, false)

  // AND THE PRODUCTION READING IS UNCHANGED. A real database is never stamped; a retention cron that
  // refused to run against production would be a worse defect than the one this closes.
  assert.equal(
    activityLogPurgeTargetVerdict({ tierEnabled: false, connectedDatabase: LIVE, databaseComment: null }).ok,
    true,
  )
})

// --- the same branches through the real sweep, asserting no DELETE was issued -------------------

type Probe = { db: string | null; comment: string | null }

let probe: Probe = { db: DISPOSABLE, comment: expectedDisposableDatabaseMarker(DISPOSABLE) }
const statements: string[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join('?')
        statements.push(sql)
        if (sql.includes('shobj_description')) return [probe]
        return [{ count: 0 }]
      },
    },
  },
})

const deletesIssued = () => statements.filter((sql) => sql.includes('DELETE FROM "activity_logs"')).length

async function sweepWithTierOn(target: Probe): Promise<{ error: unknown; deletes: number }> {
  const previous = process.env[CONCURRENCY_TIER_ENV]
  process.env[CONCURRENCY_TIER_ENV] = '1'
  probe = target
  statements.length = 0
  try {
    const { purgeExpiredActivityLogs } = await loadCleanup()
    try {
      await purgeExpiredActivityLogs()
      return { error: null, deletes: deletesIssued() }
    } catch (error) {
      return { error, deletes: deletesIssued() }
    }
  } finally {
    if (previous === undefined) delete process.env[CONCURRENCY_TIER_ENV]
    else process.env[CONCURRENCY_TIER_ENV] = previous
  }
}

test('o3d-1q28: with the tier on and no stamp, the sweep throws BEFORE issuing a single DELETE', async () => {
  const { ActivityLogPurgeRefusedError } = await loadCleanup()
  const { error, deletes } = await sweepWithTierOn({ db: LIVE, comment: null })

  assert.ok(error instanceof ActivityLogPurgeRefusedError, `expected a refusal, got ${String(error)}`)
  assert.match((error as Error).message, new RegExp(LIVE), 'the refusal names the database')
  // THE PRECONDITION, PRINTED: the guard was reached through the connection it protects.
  assert.equal(
    statements.filter((sql) => sql.includes('shobj_description')).length,
    1,
    'the sweep asked the server, through the client that would have deleted',
  )
  assert.equal(deletes, 0, 'not one batch — a guard that fires after the first 10,000 rows is not a guard')
})

test('o3d-1q28: with the tier on and the stamp present, the sweep proceeds', async () => {
  const { error, deletes } = await sweepWithTierOn({
    db: DISPOSABLE,
    comment: expectedDisposableDatabaseMarker(DISPOSABLE),
  })

  assert.equal(error, null, `the guard must not refuse a stamped database: ${String(error)}`)
  // Three levels, one batch each (the fake returns count 0, which is a short batch).
  assert.equal(deletes, 3, 'INFO, WARNING and ERROR are all swept')
})

test('o3d-1q28: with the tier OFF the guard costs nothing and asks nothing', async () => {
  const previous = process.env[CONCURRENCY_TIER_ENV]
  delete process.env[CONCURRENCY_TIER_ENV]
  statements.length = 0
  try {
    const { purgeExpiredActivityLogs } = await loadCleanup()
    await purgeExpiredActivityLogs()
  } finally {
    if (previous !== undefined) process.env[CONCURRENCY_TIER_ENV] = previous
  }

  assert.equal(
    statements.filter((sql) => sql.includes('shobj_description')).length,
    0,
    'production pays one env comparison, not a round trip',
  )
  assert.equal(deletesIssued(), 3)
})
