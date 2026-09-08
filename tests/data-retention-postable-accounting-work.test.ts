import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { POSTABLE_ACCOUNTING_SYNC_STATUSES } from '@/lib/domain/accounting/postable-sync-statuses'

/**
 * o3d-nepa / o3d-y14, Codex round 1 finding 2. RETENTION COULD DELETE A CLAIMED JOB, DEFEATING THE
 * LIVE-ROW COUNT.
 *
 * `purgeExpiredData` hard-deleted accounting sync logs by AGE ALONE, explicitly including
 * PROCESSING rows. The coupon backfill's fence counts live SALES_INVOICE rows under the order lock
 * and declines to correct an order that has any — which is only meaningful if the row's existence
 * tracks the worker's ability to post:
 *
 *      worker                          retention                    backfill
 *      ------                          ---------                    --------
 *      claim old job, read payload
 *                                      delete it (older than cutoff)
 *                                                                   LOCK order
 *                                                                   count live rows -> 0
 *                                                                   correct + STAMP as fixed
 *      post the in-memory payload
 *      -> remote write happened; its status update fails; nothing records the document.
 *
 * The same count backs the sales-order hard-delete guard, and o3d-ju8t established that FAILED does
 * not prove nothing was posted. So the exemption covers every status a document can still be posted
 * from, keyed on the SHARED constant both readers use — the sets drifting apart is how the hole
 * reopens silently.
 *
 * The `deleteMany` double below EVALUATES the predicate against a row store instead of capturing
 * arguments. A double that only recorded the `where` object could not tell an exemption that works
 * from one whose statuses are spelled slightly differently.
 */

type SyncRow = {
  id: string
  createdAt: Date
  status: string
  type?: string
  /** o3d-v7sy: which reader's evidence this row is. The delete guard and the daily-batch recreate
   * verdict both select on it, so retention's exemption is keyed on it too. */
  referenceType?: string
  externalTransactionId?: string | null
  backReferenceCheckedAt?: Date | null
  backReferenceEvidenceCompactedAt?: Date | null
  /** o3d-nepa: the orphan sweep's record that it cancelled a PENDING — pre-call — row. */
  abandonedBeforeRemoteCall?: boolean | null
  /** o3d-nepa round 4: 'OPERATOR_ASSERTION' when a human settled the row NOT_POSTED. */
  settlementBasis?: string | null
  payload?: Record<string, unknown>
}

const store = {
  settingRows: [] as Array<{ key: string; value: string }>,
  accounting: [] as SyncRow[],
}

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

type Where = {
  /**
   * o3d-bqw7 r2: the compaction writes ONE ROW AT A TIME, re-asserting the un-compacted predicate in
   * the same `where`. Without this clause the double ignored the id and every per-row write hit the
   * whole page — which is the silent-and-wrong failure this file's header warns about, not the loud
   * one.
   */
  id?: string
  createdAt?: { lt: Date }
  status?: { notIn?: string[]; in?: string[] } | string
  type?: { in?: string[]; notIn?: string[] }
  referenceType?: { in?: string[] }
  externalTransactionId?: { not: null } | null
  backReferenceCheckedAt?: null
  backReferenceEvidenceCompactedAt?: null
  abandonedBeforeRemoteCall?: boolean | null
  settlementBasis?: string | null
  NOT?: Where
  AND?: Where[]
  OR?: Where[]
}

/**
 * Evaluates EVERY clause the two passes use, including o3d-9kek's `NOT: UNRESOLVED_…`.
 *
 * The earlier version of this double understood only `createdAt` and `status`. After the merge that
 * would have been actively misleading rather than merely incomplete: the delete predicate now
 * carries both clauses, and a double blind to one of them reports the same survivors whether that
 * clause is present or absent — so the merge could have dropped either half and every test here
 * would still have passed.
 */
function matches(row: SyncRow, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false
  if (where.createdAt && !(row.createdAt.getTime() < where.createdAt.lt.getTime())) return false
  // o3d-nepa's UNRESOLVED_ABANDONED_CLAIM_WHERE is an AND of a bare equality and an OR of three
  // alternatives, and the delete now composes TWO negated constants under `AND`. All three shapes
  // are modelled: a double that ignored `AND` would report the delete as unconditional and a double
  // that ignored `OR` would report the compaction as universal, and every test here would pass
  // whether the exemption was present or absent — which is the failure mode this file's header
  // already describes for the clauses that came before it.
  if (where.AND && !where.AND.every((clause) => matches(row, clause))) return false
  if (where.OR && !where.OR.some((clause) => matches(row, clause))) return false
  if (typeof where.status === 'string' && row.status !== where.status) return false
  if (typeof where.status === 'object' && where.status.notIn && where.status.notIn.includes(row.status)) return false
  if (typeof where.status === 'object' && where.status.in && !where.status.in.includes(row.status)) return false
  // o3d-nepa added `type: { notIn: REMOTE_MONEY_EVIDENCE_TYPES }` to the delete predicate, while
  // o3d-9kek's back-reference clause uses `type: { in: … }`. The double understood only `in`, so
  // the merged predicate made it read `undefined.includes` and every test here died — which is the
  // benign failure. The dangerous one was ignoring the unknown operator and reporting the same
  // survivors whether the money-evidence clause was present or not.
  if (where.type?.in && !where.type.in.includes(row.type ?? '')) return false
  if (where.type?.notIn && where.type.notIn.includes(row.type ?? '')) return false
  // o3d-v7sy added `referenceType: { in: [...] }` to BOTH passes, via
  // EXTERNAL_DOCUMENT_EVIDENCE_WHERE. WITHOUT THIS LINE the double is wrong in the dangerous
  // direction rather than the loud one: an unknown key is ignored, so the whole clause would
  // collapse to its `OR` and every SYNCED row anywhere would look retained — and the v7sy tests
  // below would pass whether the reference-type restriction existed or not, which is the same
  // vacuity this file's header warns about for the clauses that came before it.
  if (where.referenceType?.in && !where.referenceType.in.includes(row.referenceType ?? '')) return false
  if ('abandonedBeforeRemoteCall' in where && (row.abandonedBeforeRemoteCall ?? null) !== where.abandonedBeforeRemoteCall) {
    return false
  }
  // o3d-nepa round 4 added the operator-assertion arm, spelled as
  // `{ settlementBasis: null } OR NOT { settlementBasis: 'OPERATOR_ASSERTION' }`. WITHOUT THIS LINE
  // the double is silently wrong in the dangerous direction rather than the loud one: the inner
  // `NOT` clause would match every row, so the negation would always be false and the whole arm
  // would rest on the null test alone — an operator-settled row would look retained here while the
  // database deleted it, and every test in this file would still pass.
  if ('settlementBasis' in where && (row.settlementBasis ?? null) !== where.settlementBasis) return false
  if (where.externalTransactionId === null && (row.externalTransactionId ?? null) !== null) return false
  if (where.externalTransactionId && row.externalTransactionId == null) return false
  if ('backReferenceCheckedAt' in where && (row.backReferenceCheckedAt ?? null) !== null) return false
  if ('backReferenceEvidenceCompactedAt' in where && (row.backReferenceEvidenceCompactedAt ?? null) !== null) {
    return false
  }
  if (where.NOT && matches(row, where.NOT)) return false
  return true
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findMany: async () => store.settingRows },
      shoppingSyncLog: noopDelegate(),
      // o3d-xnwu r15: the WooCommerce sync-log delete is a raw statement now — the recovery-witness
      // exemption is a fact in another table and Prisma cannot express it. Nothing here asserts
      // about it (tests/wc-refund-park-recovery-witness-retention.test.ts does), but it must
      // EXIST or purgeExpiredData dies before reaching anything this file measures.
      $queryRaw: async () => [{ count: 0 }],
      accountingSyncLog: {
        ...noopDelegate(),
        deleteMany: async ({ where }: { where: Where }) => {
          const survivors = store.accounting.filter((row) => !matches(row, where))
          const deleted = store.accounting.length - survivors.length
          store.accounting = survivors
          return { count: deleted }
        },
        // o3d-9kek's compaction pass. Modelled rather than no-opped, because "the row survives" is
        // only half the property the o3d-y14 fence needs — the other half is that compaction does
        // not remove it either, and a no-op double cannot tell those apart.
        updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
          const hit = store.accounting.filter((row) => matches(row, where))
          for (const row of hit) Object.assign(row, data)
          return { count: hit.length }
        },
        // o3d-bqw7 r2: the compaction now READS before it writes — it derives a per-row record of
        // what the row owed from the payload it is about to erase. Modelled against the same store,
        // so "the row survives compaction" and "the row was never selected for it" stay distinct.
        findMany: async ({ where, take }: { where: Where; take?: number }) => {
          const hit = store.accounting.filter((row) => matches(row, where))
          return (take ? hit.slice(0, take) : hit).map((row) => ({ ...row }))
        },
        count: async ({ where }: { where: { status: { in: string[] } } }) =>
          store.accounting.filter((row) => where.status.in.includes(row.status)).length,
      },
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      shoppingWebhookEvent: noopDelegate(),
      // Tables purgeExpiredData grew AFTER this double was written (q66in.7.4 WMS inbound-event
      // compaction and sync-run deletion, o3d-osl8's binding sweep). They are no-ops rather than
      // modelled because nothing in this file asserts about them — but they must EXIST, or the
      // function dies on the first one and every accounting assertion below never runs.
      wmsInboundReceiptEvent: noopDelegate(),
      wmsWebhookEvent: noopDelegate(),
      wmsSyncJob: noopDelegate(),
      externalWmsBinding: noopDelegate(),
    },
  },
})

async function loadPurge() {
  return (await import('@/lib/data-retention')).purgeExpiredData
}

const OLD = new Date('2020-01-01T00:00:00.000Z')

function seed() {
  store.settingRows = [{ key: 'retention_sync_logs_months', value: '6' }]
  store.accounting = [
    { id: 'pending', createdAt: OLD, status: 'PENDING' },
    { id: 'processing', createdAt: OLD, status: 'PROCESSING' },
    { id: 'failed', createdAt: OLD, status: 'FAILED' },
    // o3d-v7sy: keyed to a CogsEntry, which is deliberately NOT one of the reference types the
    // sales-order delete guard or the daily-batch recreate verdict read. It is the bound on that
    // exemption — a SYNCED row no such reader looks at still expires by age.
    { id: 'synced', createdAt: OLD, status: 'SYNCED', referenceType: 'CogsEntry', externalTransactionId: 'XERO-1' },
    // o3d-nepa: cancelled AND proved pre-call by the orphan sweep, which is the only cancelled row
    // retention may delete. A bare CANCELLED row is an UNRESOLVED abandoned claim; there is one of
    // those in its own test below.
    // o3d-v7sy: keyed to a SalesOrder — a reference type the delete guard DOES read — and it still
    // expires, because a resolved abandonment with no document id is not evidence of a document.
    { id: 'cancelled', createdAt: OLD, status: 'CANCELLED', referenceType: 'SalesOrder', abandonedBeforeRemoteCall: true },
  ]
}

test('expired work that can STILL BE POSTED survives the purge (Codex r1 F2)', async () => {
  const purgeExpiredData = await loadPurge()
  seed()

  await purgeExpiredData()

  assert.deepEqual(
    store.accounting.map((row) => row.id).sort(),
    ['failed', 'pending', 'processing'],
    'PENDING/PROCESSING/FAILED are unfinished jobs, not history',
  )
})

test('settled work is still expired by age — the exemption is not a blanket one (Codex r1 F2)', async () => {
  // Without this, "never delete anything" would pass the test above and quietly disable retention.
  const purgeExpiredData = await loadPurge()
  seed()

  const result = await purgeExpiredData()

  assert.equal(result.syncLogsDeleted, 2, 'SYNCED and CANCELLED still expire')
  assert.ok(!store.accounting.some((row) => row.id === 'synced'))
  assert.ok(!store.accounting.some((row) => row.id === 'cancelled'))
})

test('unresolved back-reference evidence is COMPACTED, not deleted — o3d-9kek survives the merge', async () => {
  // The OTHER clause on the same predicate, from PR #616. A SYNCED row still carrying an external
  // id the sweep has not reached a verdict on is outside the postable set, so o3d-y14's clause does
  // nothing for it: only `NOT: UNRESOLVED_…` keeps it. Deleting a competing sibling is what turns an
  // ambiguity the sweep was refusing to guess at into a confident wrong attribution.
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting.push({
    id: 'unlinked',
    createdAt: OLD,
    status: 'SYNCED',
    type: 'SALES_INVOICE',
    externalTransactionId: 'XERO-77',
    backReferenceCheckedAt: null,
    payload: { customer: 'A Person' },
  })

  const result = await purgeExpiredData()

  const kept = store.accounting.find((row) => row.id === 'unlinked')
  assert.ok(kept, 'the row survives the age-based delete')
  assert.equal(result.backReferenceEvidenceCompacted, 1, 'and is compacted instead')
  assert.deepEqual(kept.payload, {}, 'its content — customer details, financial lines — is cleared on schedule')
  assert.equal(kept.externalTransactionId, 'XERO-77', 'while the attribution a later reader needs stays')
})

test('a PENDING job is retained WHOLE — compaction cannot reach it (o3d-y14 + o3d-9kek)', async () => {
  // Where the two rules meet. A PENDING invoice job has no external id, so the back-reference
  // predicate is structurally incapable of seeing it: without o3d-y14's status clause it is deleted
  // by age, and the backfill's live-row count then reads zero while a worker still posts the old
  // payload. It must also NOT be compacted — a blanked payload is not something a worker can post.
  const purgeExpiredData = await loadPurge()
  seed()
  const pending = store.accounting.find((row) => row.id === 'pending')
  assert.ok(pending)
  pending.type = 'SALES_INVOICE'
  pending.payload = { discountAmount: 10 }

  await purgeExpiredData()

  const kept = store.accounting.find((row) => row.id === 'pending')
  assert.ok(kept, 'retained')
  assert.deepEqual(kept.payload, { discountAmount: 10 }, 'and retained WHOLE — the payload is the work')
  assert.equal(kept.backReferenceEvidenceCompactedAt ?? null, null)
})

test('a PROCESSING row an operator later resolves DOES expire afterwards (Codex r1 F2)', async () => {
  // The exemption is about postability, not about age: a row leaves it the moment it settles, so
  // this does not grow without bound and does not need a second clock.
  const purgeExpiredData = await loadPurge()
  seed()

  await purgeExpiredData()
  const claimed = store.accounting.find((row) => row.id === 'processing')
  assert.ok(claimed)
  claimed.status = 'SYNCED'
  await purgeExpiredData()

  assert.ok(!store.accounting.some((row) => row.id === 'processing'))
})

test('a young live row is untouched regardless — the cutoff still applies', async () => {
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting.push({ id: 'fresh-synced', createdAt: new Date(), status: 'SYNCED' })

  await purgeExpiredData()

  assert.ok(store.accounting.some((row) => row.id === 'fresh-synced'))
})

test('the claim -> retention -> backfill interleaving no longer reads zero (Codex r1 F2)', async () => {
  // The whole failure, in order. A worker claims an old invoice job and reads its payload;
  // retention runs; the backfill then counts live rows under the order lock. If the row is gone the
  // count is zero, the order is corrected and STAMPED, and the worker still posts the old payload.
  const purgeExpiredData = await loadPurge()
  const { db } = await import('@/lib/db')
  seed()
  store.accounting = [{ id: 'invoice-job', createdAt: OLD, status: 'PENDING' }]

  // 1. the worker claims it and holds the payload in memory
  const claimed = store.accounting[0]
  claimed.status = 'PROCESSING'
  const heldPayload = { discountAmount: 10 }

  // 2. retention runs
  await purgeExpiredData()

  // 3. the backfill counts what the fence counts
  const liveJobs = await db.accountingSyncLog.count({
    where: { status: { in: [...POSTABLE_ACCOUNTING_SYNC_STATUSES] } },
  })

  assert.equal(liveJobs, 1, 'the worker that can still post is still visible, so the fence declines')
  assert.equal(heldPayload.discountAmount, 10, 'and that payload is exactly what it would have posted')
})

test('the exemption uses the SAME constant the coupon backfill counts on (Codex r1 F2)', async () => {
  // Two independent spellings of this set is how the hole reopens: retention would delete a status
  // the fence still counts, and nothing would fail.
  const { LIVE_SALES_INVOICE_STATUSES } = await import(
    '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'
  )

  assert.deepEqual([...LIVE_SALES_INVOICE_STATUSES], [...POSTABLE_ACCOUNTING_SYNC_STATUSES])

  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'lib/data-retention.ts'), 'utf8')
  assert.match(src, /POSTABLE_ACCOUNTING_SYNC_STATUSES/, 'retention imports it rather than restating it')
  // BOTH ENDS ASSERTED, because `indexOf` answers -1 for a marker that has moved and `slice` reads
  // -1 as "one before the end" rather than as an error. The end marker used to be
  // `syncLogsDeleted = wc.count`, which stopped existing when the delete became a two-statement
  // transaction — so this predicate silently became THE WHOLE FILE FROM THE DELETE ONWARDS, and the
  // check below stopped being about the delete's own `where` at all (o3d-v7sy).
  const deleteStart = src.indexOf('db.accountingSyncLog.deleteMany')
  const deleteEnd = src.indexOf('syncLogsDeleted =', deleteStart)
  assert.ok(deleteStart >= 0, 'the delete statement is still spelled this way')
  assert.ok(deleteEnd > deleteStart, 'and the slice really ends at the assignment that closes it')
  assert.doesNotMatch(
    src.slice(deleteStart, deleteEnd),
    /'PROCESSING'/,
    'and does not spell the statuses out locally',
  )
})

// ---------------------------------------------------------------------------
// o3d-nepa — AN UNRESOLVED ABANDONED CLAIM AGED OUT AND DISAPPEARED.
//
// The status exemption above covers work that CAN STILL BE POSTED. It deliberately releases a row
// the moment it terminalises, and CANCELLED is one of the two statuses that releases it — but
// CANCELLED is not an outcome. It records that somebody or something ABANDONED the row: the
// cross-connector orphan sweep, the post-time retirement of a CLAIMED row whose worker died, or an
// operator. The processors POST BEFORE they persist SYNCED and the external id, so none of those
// writers knows whether pounds moved.
//
// And no reader FAILS when the row goes. `dailyBatchRecreateVerdict` takes its `rows.length === 0`
// arm — "no log at all, so the journal never posted" — and re-raises a DUPLICATE journal into a live
// ledger. `retryFailedXeroSync`'s sibling snapshot reads every row of a scope at any status because,
// in its own words, "a SYNCED or CANCELLED sibling can also represent money already in the ledger";
// one deleted sibling turns an ambiguous scope unambiguous and licenses a second payment.
//
// These rows are COMPACTED rather than retained whole, which is what separates this from the
// PROCESSING exemption that was reverted: a CANCELLED SALES_INVOICE payload is customer names,
// addresses and line descriptions, and NOTHING reads it. Every misled reader reads columns.
// ---------------------------------------------------------------------------

test('[o3d-nepa] an UNRESOLVED abandoned claim survives the purge and is COMPACTED instead', async () => {
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting.push({
    id: 'abandoned-claim',
    createdAt: OLD,
    status: 'CANCELLED',
    type: 'SALES_INVOICE',
    // The retirement nulls processingStartedAt as it writes CANCELLED, so nothing on the row says it
    // was ever claimed. What it does NOT say is that no call was made — and that absence is the
    // whole fact.
    abandonedBeforeRemoteCall: null,
    externalTransactionId: null,
    payload: { customer: 'A Person', lines: [{ description: 'A thing' }] },
  })

  const result = await purgeExpiredData()

  const kept = store.accounting.find((row) => row.id === 'abandoned-claim')
  assert.ok(kept, 'age alone must not expire an abandonment nobody resolved')
  assert.equal(result.backReferenceEvidenceCompacted, 1, 'it is compacted instead of retained whole')
  assert.deepEqual(kept.payload, {}, 'the customer names and line descriptions expire on schedule')
  assert.equal(kept.status, 'CANCELLED', 'while the columns every misled reader reads all survive')
  assert.equal(kept.abandonedBeforeRemoteCall ?? null, null)
})

test('[o3d-nepa] a CANCELLED row PROVED pre-call still expires by age — the exemption is not a blanket one', async () => {
  // The bound, and the reason this does not simply disable retention for cancelled rows.
  // `cancelOrphanedRowsUnderLock` matches `status = PENDING` only — provably pre-call — and writes
  // the proof in the same UPDATE as the status. That row IS resolved: no ledger holds its document.
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting = [
    { id: 'proved-pre-call', createdAt: OLD, status: 'CANCELLED', abandonedBeforeRemoteCall: true, externalTransactionId: null },
    { id: 'unproved', createdAt: OLD, status: 'CANCELLED', abandonedBeforeRemoteCall: null, externalTransactionId: null },
  ]

  const result = await purgeExpiredData()

  assert.equal(result.syncLogsDeleted, 1)
  assert.deepEqual(store.accounting.map((row) => row.id), ['unproved'])
})

test('[o3d-nepa] a CANCELLED row that NAMES a document is kept even when it carries the pre-call proof', async () => {
  // An external id exists only because the remote call returned, so it is the ledger's own receipt
  // and outranks an abandonment written over the top of it. The recreate verdict already applies
  // exactly this rule; retention must not delete what that verdict blocks on.
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting = [{
    id: 'abandoned-but-posted',
    createdAt: OLD,
    status: 'CANCELLED',
    type: 'COGS_JOURNAL',
    abandonedBeforeRemoteCall: true,
    externalTransactionId: 'XJRNL-1',
  }]

  const result = await purgeExpiredData()

  assert.equal(result.syncLogsDeleted, 0)
  assert.ok(store.accounting.some((row) => row.id === 'abandoned-but-posted'))
})

test('[o3d-nepa] a young unresolved abandonment is untouched by both passes — the cutoff still applies', async () => {
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting = [{
    id: 'fresh-cancelled',
    createdAt: new Date(),
    status: 'CANCELLED',
    type: 'SALES_INVOICE',
    payload: { customer: 'A Person' },
  }]

  const result = await purgeExpiredData()

  assert.equal(result.backReferenceEvidenceCompacted, 0, 'compaction is scheduled by age, like the delete')
  assert.deepEqual(store.accounting[0].payload, { customer: 'A Person' })
})

test('[o3d-nepa round 4] an operator-SETTLED cancelled row is DELETED, not kept for ever', async () => {
  // THE DEFECT. "Resolved" was keyed solely on `abandonedBeforeRemoteCall`, and exactly one writer
  // ever sets it — the orphan sweep, over a PENDING row. An operator who opened the ledger, saw
  // nothing, and settled the row NOT_POSTED produced a CANCELLED row with `settlementBasis =
  // OPERATOR_ASSERTION` and NO flag, so retention held it back for ever as a compacted tombstone.
  // That assertion is a STRONGER resolution than the flag, not a weaker one.
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting = [
    {
      id: 'operator-settled',
      createdAt: OLD,
      status: 'CANCELLED',
      type: 'SALES_INVOICE',
      abandonedBeforeRemoteCall: null,
      externalTransactionId: null,
      settlementBasis: 'OPERATOR_ASSERTION',
      payload: { customer: 'A Person' },
    },
    // The control, so this is about the assertion and not about the cutoff or the status.
    {
      id: 'nobody-resolved',
      createdAt: OLD,
      status: 'CANCELLED',
      type: 'SALES_INVOICE',
      abandonedBeforeRemoteCall: null,
      externalTransactionId: null,
      settlementBasis: null,
      payload: { customer: 'A Person' },
    },
  ]

  const result = await purgeExpiredData()

  assert.equal(result.syncLogsDeleted, 1)
  assert.deepEqual(store.accounting.map((row) => row.id), ['nobody-resolved'])
  assert.equal(result.backReferenceEvidenceCompacted, 1, 'and only the unresolved one becomes a tombstone')
})

test('[o3d-nepa round 4] an operator settlement that NAMES a document is still kept', async () => {
  // `buildCancelledSaleSettlementData` writes CANCELLED + an operator assertion + a real document
  // id, for a POSTED assertion whose sale is cancelled. The external id is the ledger's own receipt
  // and outranks every resolution, so this row must survive exactly as the pre-call-proved one with
  // an id does. Without this the round-4 arm would delete post evidence.
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting = [{
    id: 'settled-but-posted',
    createdAt: OLD,
    status: 'CANCELLED',
    type: 'SALES_INVOICE',
    abandonedBeforeRemoteCall: null,
    externalTransactionId: 'XINV-77',
    settlementBasis: 'OPERATOR_ASSERTION',
  }]

  const result = await purgeExpiredData()

  assert.equal(result.syncLogsDeleted, 0)
  assert.ok(store.accounting.some((row) => row.id === 'settled-but-posted'))
})

// ---------------------------------------------------------------------------
// o3d-v7sy — THE DELETE GUARD'S EVIDENCE AGED OUT.
//
// findSalesOrderDeleteBlocker answers "does an external document already stand against this order?"
// entirely from this table, and it does not FAIL when its rows are gone — it returns the confident
// negative and permits an IRREVERSIBLE hard delete, stranding the document.
//
// The batch verdict is NOT a second victim here, and the tests below do not claim it is: scjz.36
// already bounds `recreateMissingDailyBatchLogs` to the same retention window, so a log old enough
// to be purged belongs to a stage date the sweep has already excluded. See the header of
// lib/domain/accounting/external-document-evidence.ts for why that bound holds in the right
// direction. The delete guard alone is the whole justification.
//
// o3d-nepa closed this for CANCELLED rows. The SYNCED row — the one that says the document DID post
// — was left deletable. Same rule, two populations, one fixed.
// ---------------------------------------------------------------------------

test('[o3d-v7sy] a posted DAILY BATCH journal survives the purge — it is the only proof the batch ran', async () => {
  // The money reader. Delete this row and a re-run of that past-dated batch reads "no log at all,
  // so the journal never posted" and raises the same journal a second time into a live ledger.
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting.push({
    id: 'a2-batch',
    createdAt: OLD,
    status: 'SYNCED',
    type: 'DAILY_BATCH_INVENTORY_ALLOC',
    referenceType: 'DailyBatch',
    externalTransactionId: 'XERO-JOURNAL-42',
    settlementBasis: null,
    abandonedBeforeRemoteCall: null,
    payload: { lines: [{ description: 'Allocated Inventory', amount: 1234.56 }] },
  })

  const result = await purgeExpiredData()

  const kept = store.accounting.find((row) => row.id === 'a2-batch')
  assert.ok(kept, 'the batch row survives the age-based delete')
  assert.equal(result.backReferenceEvidenceCompacted, 1, 'and is compacted rather than retained whole')
  assert.deepEqual(kept.payload, {}, 'so the journal lines still expire on the promised schedule')
  // EXACTLY the columns the delete guard's batch query and dailyBatchRecreateVerdict select between
  // them. Neither reads the payload, so the tombstone is a complete answer for both — that is what
  // makes COMPACTING rather than retaining whole the right shape here.
  assert.equal(kept.status, 'SYNCED')
  assert.equal(kept.externalTransactionId, 'XERO-JOURNAL-42')
  assert.equal(kept.abandonedBeforeRemoteCall ?? null, null)
  assert.equal(kept.settlementBasis ?? null, null)
})

test('[o3d-v7sy] a posted SHIPMENT-keyed document survives — a COGS journal has no marker on the order', async () => {
  // The non-invoice half of the issue. An invoice is covered by SalesOrder.accountingInvoiceId,
  // which lives on the order row and is never purged. A COGS journal, stock movement or allocation
  // reversal has no such column anywhere: this row IS the record.
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting.push({
    id: 'shipment-cogs',
    createdAt: OLD,
    status: 'SYNCED',
    type: 'COGS_JOURNAL',
    referenceType: 'Shipment',
    externalTransactionId: 'XERO-COGS-9',
    payload: { lines: [{ description: 'Cost of goods sold', amount: 88.2 }] },
  })

  await purgeExpiredData()

  const kept = store.accounting.find((row) => row.id === 'shipment-cogs')
  assert.ok(kept, 'without it the hard-delete guard finds nothing and strands the journal')
  assert.deepEqual(kept.payload, {}, 'compacted, not retained whole')
})

test('[o3d-v7sy] the "or carries a document id" arm is real, and is NOT what keeps such a row today', async () => {
  // WHY THIS IS ASSERTED AGAINST THE CONSTANT AND NOT THROUGH THE PURGE.
  //
  // The exemption is "SYNCED **or** carries an id" because the status filter cannot come first:
  // Xero reverts an already-posted row to PENDING when a follow-up fails, KEEPING the external id,
  // and the orphan sweep can then cancel it — a row whose document is real and whose status says
  // nothing of the sort. The delete guard matches it on the id alone.
  //
  // But a CANCELLED row naming a document ALREADY survives `purgeExpiredData`, and did before this
  // rule existed: it is the FIRST arm of o3d-nepa's UNRESOLVED_ABANDONED_CLAIM_WHERE ("the row names
  // a document the ledger returned, which outranks every resolution below"). An end-to-end test of
  // that row would therefore pass with this whole module deleted — it would prove nepa, not v7sy.
  // The first draft of this file contained exactly that test, asserting the opposite of what the
  // nepa rule says, and it passed for the wrong reason.
  //
  // So the arm is tested where it is the only thing answering: on the predicate itself. It is
  // redundant with nepa for the CANCELLED case and stated anyway, because this rule has to be
  // complete on its own — nepa's clause is about ABANDONMENT and could be narrowed to non-posted
  // rows without anyone noticing it was also carrying this.
  const { EXTERNAL_DOCUMENT_EVIDENCE_WHERE } = await import(
    '@/lib/domain/accounting/external-document-evidence'
  )
  const cancelledButPosted: SyncRow = {
    id: 'cancelled-but-posted',
    createdAt: OLD,
    status: 'CANCELLED',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    abandonedBeforeRemoteCall: true,
    externalTransactionId: 'XERO-INV-5',
    payload: { customer: 'A Person' },
  }
  assert.equal(
    matches(cancelledButPosted, EXTERNAL_DOCUMENT_EVIDENCE_WHERE as Where),
    true,
    'an abandonment written over a document id does not undo the document',
  )
  assert.equal(
    matches({ ...cancelledButPosted, externalTransactionId: null }, EXTERNAL_DOCUMENT_EVIDENCE_WHERE as Where),
    false,
    'and with the id gone the same row is outside this rule entirely — the arm is load-bearing',
  )
})

test('[o3d-v7sy] the exemption is NOT blanket — a SYNCED row no such reader looks at still expires', async () => {
  // Without this, "retain every SYNCED row" would pass the three tests above and quietly disable
  // retention for the whole table. The seed's `synced` row is keyed to a CogsEntry, which neither
  // the delete guard nor the batch verdict ever selects.
  const purgeExpiredData = await loadPurge()
  seed()

  const result = await purgeExpiredData()

  assert.equal(result.syncLogsDeleted, 2, 'SYNCED (CogsEntry) and the resolved CANCELLED row still expire')
  assert.ok(!store.accounting.some((row) => row.id === 'synced'))
  assert.ok(!store.accounting.some((row) => row.id === 'cancelled'))
})

test('[o3d-v7sy] every status the delete guard blocks on is one retention cannot delete', async () => {
  // THE JOIN BETWEEN THE TWO HALVES, asserted rather than left to be noticed. Retention keeps the
  // guard's evidence through TWO clauses that know nothing of each other: POSTABLE_ACCOUNTING_SYNC_
  // STATUSES (o3d-y14) and EXTERNAL_DOCUMENT_EVIDENCE_WHERE's SYNCED arm. If a status is ever added
  // to LIVE_ACCOUNTING_SYNC_STATUSES and to neither of those, the guard blocks on rows retention
  // deletes and nothing else in this suite would say so.
  const { LIVE_ACCOUNTING_SYNC_STATUSES } = await import('@/lib/domain/sales/order-delete-guard')
  const { EXTERNAL_DOCUMENT_EVIDENCE_STATUS } = await import(
    '@/lib/domain/accounting/external-document-evidence'
  )

  const retained = new Set<string>([
    ...POSTABLE_ACCOUNTING_SYNC_STATUSES,
    EXTERNAL_DOCUMENT_EVIDENCE_STATUS,
  ])
  const uncovered = LIVE_ACCOUNTING_SYNC_STATUSES.filter((status) => !retained.has(status))

  assert.deepEqual(uncovered, [], 'a blocking status retention can delete is the whole of o3d-v7sy')
})

test('[o3d-v7sy] the reference types retention keeps are the ones the delete guard queries with', async () => {
  // The other half of the same join. The guard does not select by document TYPE — it matches
  // referenceType + referenceId and blocks on ANY row it finds — so a type list would drift the
  // moment a new AccountingSyncType is queued against an order. Both sides therefore name the same
  // three identifiers, and this asserts they are still the same objects rather than two spellings.
  const guard = await import('@/lib/domain/sales/order-delete-guard')
  const {
    EXTERNAL_DOCUMENT_EVIDENCE_REFERENCE_TYPES,
    SALES_ORDER_REFERENCE_TYPE,
    SHIPMENT_REFERENCE_TYPE,
    DAILY_BATCH_REFERENCE_TYPE,
  } = await import('@/lib/domain/accounting/external-document-evidence')

  assert.deepEqual(
    [...EXTERNAL_DOCUMENT_EVIDENCE_REFERENCE_TYPES],
    [SALES_ORDER_REFERENCE_TYPE, SHIPMENT_REFERENCE_TYPE, DAILY_BATCH_REFERENCE_TYPE],
  )
  assert.deepEqual(
    [...guard.DELETE_GUARD_EVIDENCE_REFERENCE_TYPES],
    [...EXTERNAL_DOCUMENT_EVIDENCE_REFERENCE_TYPES],
    'the guard re-exports what it queries with, so a fourth reference type cannot be added to one side only',
  )
})
