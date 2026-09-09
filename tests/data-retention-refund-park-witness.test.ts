import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// o3d-xnwu r15 (Codex HIGH) - A JOIN NEEDS BOTH SIDES.
//
// Round 14 made check 7's WITNESS durable: `wc_refund_park_recovered` is written inside the
// recovery's own transaction and exempted from activity-log retention. The row it ACCUSES was left
// unprotected the moment it stopped being an active park - which is the end of the very sequence
// check 7 documents:
//
//   1. an operator recovers a park; the witness is written naming the row
//   2. the predecessor binary rewrites that row wholesale as a held sales invoice
//   3. the ordinary held-invoice release path settles it to SYNCED
//   4. `purgeExpiredData` expires it on its ORIGINAL createdAt - six months by default, and
//      possibly on the next sweep, because the park may already have been old when it was recovered
//
// Check 7 drives FROM shopping_sync_logs and uses the witness only in an EXISTS subquery, so after
// step 4 it does not report half an accusation: it reports ZERO VIOLATIONS. The cutover proceeds
// over a destroyed accounting payload.
//
// These tests assert at the WIRE - on the statement that actually reaches the driver - because an
// exemption that is described in a comment, or held in a variable the DELETE never sees, protects
// nothing. That is the same standard tests/wc-refund-park-recovery-witness-retention.test.ts holds
// the activity-log half to.
// ---------------------------------------------------------------------------

type RawCall = { sql: string; values: unknown[] }
const calls: RawCall[] = []

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      // No override rows: the DEFAULT retention is what a fresh install sweeps with, and it is the
      // one that would take the accused row.
      setting: { findMany: async () => [] },
      // o3d-272i: the statement is COMPOSED, not joined. `lib/data-retention.ts` now interpolates
      // `unresolvedWcOrderRowSql()` — a `Prisma.Sql` fragment — into this template, and Prisma's own
      // `Sql` constructor is what flattens a nested fragment into the text and parameters the driver
      // sees. Joining the raw `strings` instead would drop the fragment entirely and leave every
      // assertion below examining a statement that was never sent.
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const composed = new Prisma.Sql([...strings], values)
        calls.push({ sql: composed.sql, values: composed.values })
        return [{ count: 0 }]
      },
      shoppingSyncLog: noopDelegate(),
      accountingSyncLog: { ...noopDelegate(), count: async () => 0 },
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      shoppingWebhookEvent: noopDelegate(),
      wmsInboundReceiptEvent: noopDelegate(),
      wmsWebhookEvent: noopDelegate(),
      wmsSyncJob: noopDelegate(),
      externalWmsBinding: noopDelegate(),
    },
  },
})

/** The one statement in the sweep that deletes WooCommerce sync logs. */
async function syncLogDelete(): Promise<RawCall> {
  const { purgeExpiredData } = await import('@/lib/data-retention')
  calls.length = 0
  await purgeExpiredData()
  const hits = calls.filter((call) => call.sql.includes('DELETE FROM "shopping_sync_logs"'))
  assert.equal(hits.length, 1, 'precondition: the sweep issues exactly one shopping_sync_logs DELETE')
  return hits[0]
}

/** The text inside the top-level `NOT ( ... )` group - the ACTIVE-PARK exemption and nothing else. */
function activeParkGroup(sql: string): string {
  const open = sql.indexOf('NOT (')
  assert.notEqual(open, -1, 'precondition: the active-park exemption is a NOT( ... ) group')
  let depth = 0
  for (let i = open + 'NOT '.length; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1
    if (sql[i] === ')') {
      depth -= 1
      if (depth === 0) return sql.slice(open, i + 1)
    }
  }
  throw new Error('unbalanced NOT( ... ) group in the delete statement')
}

test('o3d-xnwu r15: the sweep cannot delete a sync log the recovery witness names', async () => {
  // MUTATION ROUTE: delete the `AND NOT EXISTS ( ... activity_logs ... )` clause from the statement
  // in lib/data-retention.ts. Every assertion below fails, and the accused row goes back to being
  // expired by age like any other settled row.
  const { WC_REFUND_PARK_RECOVERED_ACTION } = await import('@/lib/domain/sales/refund-park-recovery')
  const call = await syncLogDelete()

  // PRECONDITION: this really is the age sweep, and it really does delete - a statement that
  // deleted nothing would satisfy any exemption assertion trivially.
  assert.match(call.sql, /DELETE FROM "shopping_sync_logs"/)
  assert.match(call.sql, /"createdAt" < /, 'and it is bounded by the retention cutoff')
  assert.ok(call.values.some((value) => value instanceof Date), 'the cutoff reaches it as a parameter')

  // THE EXEMPTION, IN THE STATEMENT.
  assert.match(call.sql, /NOT EXISTS/, 'the witness exemption must be part of the DELETE')
  assert.match(call.sql, /FROM "activity_logs"/)
  assert.match(
    call.sql,
    /"activity_logs"\.metadata->>'shoppingSyncLogId' = "shopping_sync_logs"\.id/,
    'and it must join on the row id the witness names',
  )

  // The action reaches it as a PARAMETER equal to the shared constant, not as a literal that can
  // drift away from the writer and from check 7.
  assert.ok(
    call.values.includes(WC_REFUND_PARK_RECOVERED_ACTION),
    `the witness action must reach the statement (had: ${JSON.stringify(call.values)})`,
  )
})

test('o3d-xnwu r15: the witness exemption is NOT inside the active-park group, so a SYNCED row is protected too', async () => {
  // THE FINDING'S OWN SEQUENCE, AS AN ASSERTION ABOUT STRUCTURE. The pre-existing exemption is
  // `NOT (connector ... AND status = ANY(PENDING/FAILED/QUARANTINED) ...)`, and step 3 of the
  // sequence - the release path settling the rewritten row to SYNCED - is precisely what takes the
  // row out of that group. If the witness clause were folded INSIDE it, the exemption would apply
  // only to rows that are already exempt and the accused row would still be deleted.
  //
  // MUTATION ROUTE: move the `NOT EXISTS ( ... )` inside the `NOT ( ... )` group (or add
  // `AND status = ANY(...)` to it) and this fails while the previous test still passes - which is
  // exactly the shape of a fix that looks present and protects nothing.
  const call = await syncLogDelete()
  const group = activeParkGroup(call.sql)

  // PRECONDITION: there IS a witness exemption to place. Without this the slice below would run
  // from index -1 over a statement that has none, and this test would pass over the clause's
  // outright removal - a guard examining nothing.
  assert.match(call.sql, /NOT EXISTS/, 'precondition: the witness exemption is present at all')
  assert.match(group, /status = ANY/, 'precondition: the group found is the active-park status exemption')
  assert.ok(
    !group.includes('activity_logs'),
    'the witness exemption must be a top-level conjunct, not a member of the active-park group',
  )
  // And there is no status clause guarding the witness exemption anywhere: the whole point is that
  // the accused row has been settled.
  const witness = call.sql.slice(call.sql.indexOf('NOT EXISTS'))
  assert.ok(!witness.includes('status'), 'the witness exemption must not be conditioned on status')
})

test('o3d-xnwu r15: the witness is spelled identically by the writer, the retention sweep and check 7', async () => {
  // Four places have to agree, and only two of them are type-checked: the recovery that WRITES the
  // entry, the activity-log retention that must not delete the entry, the sync-log retention that
  // must not delete the ROW, and a SQL file nothing compiles. A rename that misses one switches
  // check 7 off silently.
  //
  // MUTATION ROUTE: change the metadata key in either lib/data-retention.ts or the app action, or
  // the action literal in verify.sql, and this fails.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const { WC_REFUND_PARK_RECOVERED_ACTION } = await import('@/lib/domain/sales/refund-park-recovery')

  const writer = await readFile(path.join(process.cwd(), 'app/actions/sync-exceptions.ts'), 'utf8')
  assert.ok(
    writer.includes('shoppingSyncLogId: park.id'),
    'precondition: the recovery names the row it acted on under this metadata key',
  )

  const verify = await readFile(
    path.join(process.cwd(), 'prisma/migrations/20260822120000_shopping_sync_log_record_kind/verify.sql'),
    'utf8',
  )
  const check7 = verify.slice(verify.lastIndexOf("SELECT 'shopping_sync_logs recovered refund park"))
  assert.ok(check7.includes(`"activity_logs".action = '${WC_REFUND_PARK_RECOVERED_ACTION}'`))
  assert.ok(
    check7.includes(`"activity_logs".metadata->>'shoppingSyncLogId' = "shopping_sync_logs".id`),
    'precondition: check 7 joins on the same key the retention exemption keeps alive',
  )

  const call = await syncLogDelete()
  assert.ok(call.sql.includes(`"activity_logs".metadata->>'shoppingSyncLogId' = "shopping_sync_logs".id`))
  assert.ok(call.values.includes(WC_REFUND_PARK_RECOVERED_ACTION))
})


// ---------------------------------------------------------------------------
// o3d-272i — the retention exemption is the SHARED predicate, in SQL.
// ---------------------------------------------------------------------------

test('o3d-272i: the exemption asks the row what family it is, and reaches the driver saying so', async () => {
  // THE READER THAT COULD NOT USE A TYPESCRIPT HELPER. This is a bulk `DELETE ... WHERE NOT (...)`,
  // so consolidating the other three readers behind `unresolvedWcOrderRowWhere()` and leaving this
  // one hand-written next to it would have been the same defect with better ergonomics. It renders
  // the same rule through `unresolvedWcOrderRowSql()`, and
  // tests/domain/sales/wc-sync-row-families.test.ts runs BOTH spellings over one seeded table to
  // prove they select the same rows.
  //
  // MUTATION ROUTE: drop the recordKind clause from UNRESOLVED_WC_ORDER_ROW / the SQL renderer.
  // Neither record kind reaches the statement as a parameter and the group loses its clause, so both
  // assertions below fail — at this reader, as they must at every other one.
  const {
    HELD_SALES_INVOICE_RECORD_KIND,
    WC_REFUND_PARK_RECORD_KIND,
  } = await import('@/lib/domain/sales/wc-sync-row-families')
  const call = await syncLogDelete()
  const group = activeParkGroup(call.sql)

  assert.match(group, /status = ANY/, 'precondition: the group found is the row-family exemption')
  assert.match(
    group,
    /"shopping_sync_logs"\."recordKind" = ANY/,
    'the exemption must ask the row which family it belongs to',
  )

  // The two families reach the statement as PARAMETERS carrying the shared constants, so a rename of
  // either stamp cannot leave a literal behind in a statement nothing type-checks.
  const kinds = call.values.find(
    (value): value is string[] => Array.isArray(value) && value.includes(WC_REFUND_PARK_RECORD_KIND),
  )
  assert.deepEqual(
    kinds,
    [WC_REFUND_PARK_RECORD_KIND, HELD_SALES_INVOICE_RECORD_KIND],
    `both exempt families must reach the statement (had: ${JSON.stringify(call.values)})`,
  )
})
