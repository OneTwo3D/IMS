import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-xnwu r14 (Codex HIGH) — A CHECK WHOSE EVIDENCE A CLEANUP CRON DELETES IS NOT A CHECK.
//
// `wc_refund_park_recovered` is what check 7 of the 20260822120000 migration's verify.sql joins to,
// and check 7 is the only check there whose evidence is not in the row it accuses — deliberately,
// because the row can be overwritten wholesale by the predecessor's held-invoice writer and every
// check that reads it alone then goes quiet over a destroyed accounting payload.
//
// The entry is written at level WARNING, and `purgeExpiredActivityLogs` deletes WARNING entries
// after 60 days by default. So the check would have gone quiet on its own — silently, and FIRST for
// the oldest incidents, the ones nobody has looked at — while a cutover may run a year after the
// recovery it needs to see. The action is now in RETAINED_ACTIONS.
//
// This is asserted at the WIRE, on the parameters that actually reach the DELETE, rather than by
// reading the source: an exemption that is in the array but not in the statement protects nothing.
// ---------------------------------------------------------------------------

type RawCall = { sql: string; values: unknown[] }
const calls: RawCall[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        // No override rows: the DEFAULT retention is what a fresh install sweeps with, and it is the
        // one that would have taken this entry.
        findUnique: async () => null,
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values })
        // Nothing deleted, so the batching loop ends after one pass per level.
        return [{ count: 0 }]
      },
    },
  },
})

test('the recovery witness is exempt from activity-log retention, in the statement that does the deleting', async () => {
  // MUTATION ROUTE: remove WC_REFUND_PARK_RECOVERED_ACTION from RETAINED_ACTIONS in
  // lib/activity-log-cleanup.ts and this fails on every level — the witness becomes an ordinary
  // WARNING and the 60-day sweep takes it, blinding check 7 for exactly the incidents that have
  // been sitting unlooked-at the longest.
  const { purgeExpiredActivityLogs } = await import('@/lib/activity-log-cleanup')
  const { WC_REFUND_PARK_RECOVERED_ACTION } = await import('@/lib/domain/sales/refund-park-recovery')

  calls.length = 0
  const { retention } = await purgeExpiredActivityLogs()

  // PRECONDITION 1: the sweep really did run, and it really does delete.
  assert.ok(calls.length > 0, 'the cleanup must have issued its DELETE')
  for (const call of calls) {
    assert.match(call.sql, /DELETE FROM "activity_logs"/, 'this is the statement that removes rows')
    assert.match(call.sql, /action <> ALL\(/, 'and the exemption must be IN it, not merely declared nearby')
  }

  // PRECONDITION 2: WARNING — the witness's own level — is a level this sweep processes, on a
  // finite retention. Without this the assertion below would pass over a sweep that never touches
  // the entry for reasons that have nothing to do with the exemption.
  assert.equal(retention.WARNING, 60, 'the default WARNING retention is what would have taken it')
  const warningCalls = calls.filter((call) => call.values.includes('WARNING'))
  assert.ok(warningCalls.length > 0, 'and WARNING rows really are swept')

  // THE GUARANTEE: every DELETE this sweep issues carries the witness action in its exempt list.
  for (const call of calls) {
    const exempt = call.values.find((value): value is string[] => Array.isArray(value))
    assert.ok(exempt, 'the retained-action list must reach the statement as a parameter')
    assert.ok(
      exempt.includes(WC_REFUND_PARK_RECOVERED_ACTION),
      `the witness action must be exempt in every level's DELETE (had: ${exempt.join(', ')})`,
    )
  }
})

test('the verify.sql check joins to exactly the action the recovery writes', async () => {
  // The witness only works if three places spell it identically: the writer, the retention
  // exemption and the check. Two of them are TypeScript and the third is a SQL file nothing
  // type-checks, so it is asserted here.
  //
  // MUTATION ROUTE: change the literal in verify.sql's EXISTS subquery — or the constant — and this
  // fails. It is the seam where a rename would silently switch check 7 off.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const { WC_REFUND_PARK_RECOVERED_ACTION } = await import('@/lib/domain/sales/refund-park-recovery')

  const verify = await readFile(
    path.join(process.cwd(), 'prisma/migrations/20260822120000_shopping_sync_log_record_kind/verify.sql'),
    'utf8',
  )
  const statement = verify.slice(verify.lastIndexOf('SELECT \'shopping_sync_logs recovered refund park'))
  assert.match(statement, /FROM "activity_logs"/, 'precondition: check 7 is the one that joins history')
  assert.ok(
    statement.includes(`"activity_logs".action = '${WC_REFUND_PARK_RECOVERED_ACTION}'`),
    'check 7 must join to the action the recovery actually writes',
  )
})
