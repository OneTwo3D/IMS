// o3d-clxw round 4 — THE WRITING END OF THE REVERSAL FENCE.
//
// The payment poller decides whether a supplier payment was REMOVED by asking whether the
// registration IMS holds had already posted when the Xero snapshot was taken. Round 3 answered that
// by comparing `AccountingSyncLog.syncedAt` — `new Date()` on whichever app instance ran the sync
// processor — against `new Date()` on whichever instance ran the poll. Two machines, two free-running
// clocks, and one of the two skew directions clears `paidAt` over a payment that is still in flight,
// which re-arms Mark Paid and pays the supplier twice.
//
// The comparison now happens between two readings of ONE clock: the database's. These tests pin the
// writing end — that the stamp comes from the database, from the right function, and that no SYNCED
// write in the Xero sync processor can quietly go back to stamping a host clock.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { stampSyncedAtFromDatabaseClock } from '@/lib/connectors/xero/synced-at-clock'

type Captured = { sql: string; values: unknown[] }

function captureStatement(): { tx: Parameters<typeof stampSyncedAtFromDatabaseClock>[0]; issued: Captured[] } {
  const issued: Captured[] = []
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      issued.push({ sql: strings.join('?'), values })
      return Promise.resolve(1)
    },
  } as unknown as Parameters<typeof stampSyncedAtFromDatabaseClock>[0]
  return { tx, issued }
}

test('the registration completion stamp is read from the DATABASE clock, at statement time', async () => {
  const { tx, issued } = captureStatement()

  await stampSyncedAtFromDatabaseClock(tx, 'log_1')

  assert.equal(issued.length, 1)
  const { sql, values } = issued[0]!
  assert.match(sql, /UPDATE accounting_sync_logs/)
  assert.match(sql, /clock_timestamp\(\)/,
    'the stamp must come from the database, not from any application host')
  assert.match(sql, /"syncedAt"\s*=\s*(clock_timestamp\(\)|[A-Za-z0-9_]+\.[A-Za-z0-9_]+)/,
    'syncedAt is assigned from the database clock — directly, or from the single reading of it this '
    + 'statement takes so both columns get the same instant (round 5) — never from a bound value')
  assert.doesNotMatch(sql, /=\s*now\(\)/,
    "now() is TRANSACTION-START time: it can report an instant before the payment this row's POST created")
  assert.match(sql, /AT TIME ZONE 'UTC'/,
    'the column is TIMESTAMP WITHOUT TIME ZONE and Prisma reads it back as UTC, so the cast must be explicit')
  assert.deepEqual(values, ['log_1'], 'the row id is bound, never interpolated into the statement')
})

test('the stamp writes BOTH columns from ONE reading of the clock (o3d-clxw r5, finding 1)', async () => {
  // The provenance marker is the two columns holding the SAME instant, so a build that writes
  // `syncedAt` without knowing about the marker is visible as one. Two calls to `clock_timestamp()`
  // in one statement return two different instants — the equality would never hold, and EVERY
  // registration this process stamps would read as undecidable to the reversal fence. A total,
  // silent loss of the reversal path, from a statement that looks correct.
  const { tx, issued } = captureStatement()

  await stampSyncedAtFromDatabaseClock(tx, 'log_1')

  const { sql } = issued[0]!
  assert.match(sql, /"syncedAtDatabaseClock"\s*=/,
    'without the marker the row cannot say which clock produced its completion time')
  assert.equal((sql.match(/clock_timestamp\(\)/g) ?? []).length, 1,
    'clock_timestamp() is evaluated PER CALL: a second call means the two columns can never be equal')
  const assignments = [...sql.matchAll(/"(syncedAt|syncedAtDatabaseClock)"\s*=\s*([A-Za-z0-9_.]+)/g)]
  assert.equal(assignments.length, 2)
  assert.equal(assignments[0]![2], assignments[1]![2],
    'both columns must be assigned the SAME single reading, not two expressions that happen to agree')
})

test('every SYNCED write in the Xero sync processor stamps from the database clock (o3d-clxw r4)', () => {
  // A source invariant rather than a behavioural one on purpose: the defect is a write site that
  // FORGETS the stamp, and a new one can be added at any time. Four sites exist today, all inside the
  // transaction that sets the status, and each of them is where a host clock used to be written.
  const source = readFileSync(
    path.join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'),
    'utf8',
  )
  const marker = "status: 'SYNCED',"
  const sites = source.split(marker).slice(1)
  assert.equal(sites.length, 4, 'the number of SYNCED write sites changed — check each one still stamps')

  for (const [index, tail] of sites.entries()) {
    const window = tail.split('\n').slice(0, 30).join('\n')
    assert.match(window, /await stampSyncedAtFromDatabaseClock\(tx, entry\.id\)/,
      `SYNCED write site ${index + 1} does not stamp syncedAt from the database clock; the payment `
      + `poller's reversal fence would be comparing this host's wall clock against the poll host's`)
  }
})
