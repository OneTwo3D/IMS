import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import {
  DEFAULT_RECONCILIATION_LOOKBACK_DAYS,
  MAX_RECONCILIATION_LIST_RUNS,
  MAX_UNMIRRORED_SYNC_LOGS,
  UNMIRRORED_SYNC_LOGS_TRUNCATED,
  collectAccountingReconciliationRows,
  evaluateAccountingReconciliationRows,
  listAccountingReconciliationRuns,
  persistAccountingReconciliationReport,
  reconciliationLookbackDate,
  reconciliationTruncations,
  type AccountingReconciliationFinding,
  type AccountingReconciliationTruncation,
} from '../../lib/domain/accounting/reconciliation'

/**
 * o3d-bnp6 — THE CAP APPLIED BEFORE THE QUESTION, ONE CHECK OVER FROM o3d-11rf r4.
 *
 * `old_sync_log_without_mirrored_event` used to be computed in memory over two general pages:
 * `accounting_sync_logs` ORDER BY createdAt DESC LIMIT 10,000, and `accounting_events` ORDER BY
 * businessDate DESC LIMIT 10,000. The sync-log page reaches PENDING/PROCESSING rows at ANY age
 * precisely so that work owed from before the lookback is still checked — and then the newest-first
 * cap throws those old rows away first. The check named for OLD rows preferentially discarded old
 * rows, and `reconciliation_row_cap_reached` named the dataset, never the stranded row.
 *
 * DATABASE-BACKED BECAUSE THE RULE IS NOW A STATEMENT. What is asserted is which rows PostgreSQL
 * selects, over the whole table, before any bound is applied. A double could only show the shape of a
 * string handed to Prisma.
 *
 * ROLLED BACK, ALWAYS. Every probe runs inside a transaction that aborts.
 *
 * GATED on the pair `npm run test:db` actually sets — RUN_DB_RETENTION_TESTS, with the
 * REQUIRE_DB_RETENTION_TESTS tripwire — for the reason written out in
 * tests/db/reconciliation-void-mirror-contradictions.test.ts: a file gated on anything else skips
 * inside a green job. The tripwire catches one edit shape only (o3d-7zes).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/reconciliation-unmirrored-sync-logs.test.ts would have been skipped in an '
    + 'environment that promised a migrated database. Fix the invocation (npm run test:db) rather '
    + 'than this check: a silent skip here is the o3d-11rf r13 finding.',
  )
}

const UNMIRRORED = 'old_sync_log_without_mirrored_event'
const ROW_CAP = 'reconciliation_row_cap_reached'
/** The page size the OLD code loaded sync rows under. Restated because the point is to exceed it. */
const PREVIOUS_SYNC_LOG_PAGE_CAP = 10_000

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  }
}

class RollbackProbe extends Error {}

type Tx = {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown[]>
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>
}

async function withRollback<T>(fn: (tx: Tx) => Promise<T>, timeout = 300_000): Promise<T> {
  loadEnv()
  const { db } = await import('../../lib/db')
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

async function report(tx: Tx, options: Parameters<typeof collectAccountingReconciliationRows>[1] = {}) {
  const rows = await collectAccountingReconciliationRows(
    tx as unknown as Parameters<typeof collectAccountingReconciliationRows>[0],
    options,
  )
  return { rows, findings: evaluateAccountingReconciliationRows(rows) }
}

/**
 * o3d-bnp6 review L4 — A PRECONDITION EVERY TEST HERE RESTS ON, STATED RATHER THAN ASSUMED.
 *
 * The statement lists at most MAX_UNMIRRORED_SYNC_LOGS rows, OLDEST first. On a database already
 * holding that many unmirrored rows older than a test's own, the test's rows are simply not in the
 * list — and then "X is reported" fails for the wrong reason, and "X is NOT reported" PASSES for the
 * wrong reason, which is the dangerous one. So each test first establishes that the list it is about
 * to read is the WHOLE set, and refuses to conclude anything otherwise. Assertions are also scoped to
 * the test's own row ids, so rows another suite or a real tenant left behind cannot enter them.
 */
function assertListIsWhole(rows: Awaited<ReturnType<typeof report>>['rows'], what: string) {
  const unmirrored = rows.unmirroredSyncLogs
  assert.ok(unmirrored, `PRECONDITION (${what}): the unmirrored-sync-row dataset was read`)
  assert.equal(unmirrored.rows.length, unmirrored.total,
    `PRECONDITION (${what}): every unmirrored row in this database is listed (${unmirrored.total} of `
    + `them, bound ${MAX_UNMIRRORED_SYNC_LOGS}). On a database holding more than the bound, what is `
    + 'absent from the list proves nothing, so this test refuses to conclude rather than pass.')
}

/** This test's own findings, by the run-specific prefix its row ids carry. */
const ownIds = (findings: AccountingReconciliationFinding[], marker: string) =>
  findings.filter((f) => f.code === 'old_sync_log_without_mirrored_event' && f.syncLogId?.includes(marker))
    .map((f) => f.syncLogId).sort()

/**
 * `count` SYNCED sync rows created NOW, each WITH the mirrored event the check looks for, so none of
 * them is a finding in its own right. They exist to fill the old newest-first page. Ids are written
 * in the opposite order to their creation so a fixture cannot agree with a query by accident.
 */
async function insertMirroredRecentRows(tx: Tx, prefix: string, count: number) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "accounting_sync_logs" (
       "id", "connector", "type", "status", "referenceType", "referenceId", "externalTransactionId", "createdAt"
     )
     SELECT $1 || lpad(($2::int + 1 - g)::text, 6, '0') || '-s', 'xero', 'SALES_INVOICE'::"AccountingSyncType",
            'SYNCED'::"AccountingSyncStatus", 'SalesOrder', $1 || lpad(($2::int + 1 - g)::text, 6, '0'),
            'INV-' || $1 || lpad(g::text, 6, '0'), (now() AT TIME ZONE 'UTC') - (g || ' seconds')::interval
     FROM generate_series(1, $2::int) g`,
    prefix, count,
  )
  await tx.$executeRawUnsafe(
    `INSERT INTO "accounting_events" (
       "id", "type", "sourceEntityType", "sourceEntityId", "businessDate", "status",
       "idempotencyKey", "linesJson", "currency", "externalSystem", "externalId", "createdAt", "updatedAt"
     )
     SELECT $1 || lpad(g::text, 6, '0') || '-e', 'SALES_INVOICE', 'SalesOrder', $1 || lpad(g::text, 6, '0'),
            now(), 'POSTED', $1 || lpad(g::text, 6, '0') || '-key', '[]'::jsonb, 'GBP', 'xero',
            'EXT-' || $1 || lpad(g::text, 6, '0'), now(), now()
     FROM generate_series(1, $2::int) g`,
    prefix, count,
  )
}

/** One sync row with NO mirrored event, created `ageDays` ago. */
async function insertUnmirroredRow(
  tx: Tx,
  id: string,
  shape: {
    status?: string
    ageDays?: number
    /** A PostgreSQL interval, for ages that need more precision than whole days. */
    age?: string
    type?: string
    connector?: string
    referenceId?: string
  },
) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "accounting_sync_logs" (
       "id", "connector", "type", "status", "referenceType", "referenceId", "createdAt"
     ) VALUES ($1, $2, $3::"AccountingSyncType", $4::"AccountingSyncStatus", 'SalesOrder', $5,
               (now() AT TIME ZONE 'UTC') - $6::interval)`,
    id, shape.connector ?? 'xero', shape.type ?? 'SALES_INVOICE', shape.status ?? 'PENDING',
    shape.referenceId ?? `${id}-ref`, shape.age ?? `${shape.ageDays} days`,
  )
}

const unmirroredIds = (findings: AccountingReconciliationFinding[]) =>
  findings.filter((f) => f.code === UNMIRRORED).map((f) => f.syncLogId).sort()

test('o3d-bnp6: an OLD pending row with no mirrored event is reported past 10,000 newer rows', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const victim = `bnp6-old-${run}`
  const observed = await withRollback(async (tx) => {
    await insertMirroredRecentRows(tx, `bnp6-r-${run}-`, PREVIOUS_SYNC_LOG_PAGE_CAP + 1)
    await insertUnmirroredRow(tx, victim, { status: 'PENDING', ageDays: 200 })
    const { rows, findings } = await report(tx)
    assertListIsWhole(rows, 'the central case')
    return {
      pageSize: rows.syncLogs.length,
      victimOnPage: rows.syncLogs.some((log) => log.id === victim),
      syncLogCapReported: findings.some((f) => f.code === ROW_CAP
        && (f.details as { dataset?: string } | undefined)?.dataset === 'syncLogs'),
      // Scoped to THIS run's rows (review L4): the recent rows and the victim both carry `run`.
      unmirrored: ownIds(findings, run),
    }
  })

  // THE PREMISE, ASSERTED BEFORE ANYTHING IS CONCLUDED FROM IT: the general page really is full, and
  // really does NOT contain the victim. Without this the test could pass against a version that
  // never fixed anything, because nothing would have pushed the victim off.
  assert.equal(observed.pageSize, PREVIOUS_SYNC_LOG_PAGE_CAP, 'the general sync-log page is full')
  assert.equal(observed.victimOnPage, false, 'and the old pending row is NOT on it')
  assert.equal(observed.syncLogCapReported, true,
    'the generic cap warning fires — and names a dataset, never the row that fell off')

  // THE FINDING: the old row is reported, and it is the ONLY row reported. Every one of the 10,001
  // recent rows has its mirrored event, so a finding for any of them would be a false positive — the
  // shape the old code produced whenever the matching event fell off the EVENT page.
  assert.deepEqual(observed.unmirrored, [victim],
    'the old pending row with no mirrored event is reported, and none of the 10,001 mirrored rows is')
})

/** An event mirroring `referenceId` with the given shape. */
async function insertEvent(
  tx: Tx,
  id: string,
  shape: {
    referenceId: string
    type?: string
    sourceEntityType?: string
    externalSystem?: string | null
    status?: string
    businessDateAgeDays?: number
  },
) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "accounting_events" (
       "id", "type", "sourceEntityType", "sourceEntityId", "businessDate", "status",
       "idempotencyKey", "linesJson", "currency", "externalSystem", "createdAt", "updatedAt"
     ) VALUES ($1, $2, $7, $3, (now() AT TIME ZONE 'UTC') - ($4 || ' days')::interval, $5,
               $1 || '-key', '[]'::jsonb, 'GBP', $6, now(), now())`,
    id, shape.type ?? 'SALES_INVOICE', shape.referenceId, String(shape.businessDateAgeDays ?? 0),
    shape.status ?? 'POSTED', shape.externalSystem === undefined ? 'xero' : shape.externalSystem,
    shape.sourceEntityType ?? 'SalesOrder',
  )
}

test('o3d-bnp6: over the bound, the OLDEST are listed and the exact count of the rest is reported', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const over = MAX_UNMIRRORED_SYNC_LOGS + 7
  const observed = await withRollback(async (tx) => {
    // PRECONDITION (review L4): this test asserts WHICH 500 are listed, so it needs the list to be
    // made of its own rows. That holds only on a database with no unmirrored rows of its own, which is
    // checked here rather than assumed — inside the same transaction as everything below.
    const baseline = await report(tx)
    assert.equal(baseline.rows.unmirroredSyncLogs?.total, 0,
      'PRECONDITION: the database holds no unmirrored sync rows before this test adds its own; on one '
      + 'that does, "the oldest 500 are these" cannot be asserted, so the test refuses to conclude')
    // `over` unmirrored PENDING rows, row i created i days ago, so age order is id order reversed.
    await tx.$executeRawUnsafe(
      `INSERT INTO "accounting_sync_logs" (
         "id", "connector", "type", "status", "referenceType", "referenceId", "createdAt"
       )
       SELECT $1 || lpad(g::text, 4, '0'), 'xero', 'SALES_INVOICE'::"AccountingSyncType",
              'PENDING'::"AccountingSyncStatus", 'SalesOrder', $1 || lpad(g::text, 4, '0') || '-ref',
              (now() AT TIME ZONE 'UTC') - (g || ' days')::interval
       FROM generate_series(1, $2::int) g`,
      `bnp6-over-${run}-`, over,
    )
    const { rows, findings } = await report(tx)
    const persisted = await persistAccountingReconciliationReport({
      checkedAt: new Date().toISOString(),
      fromDate: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      toDate: new Date().toISOString(),
      findings,
      summary: {
        total: findings.length,
        warning: findings.filter((f) => f.severity === 'warning').length,
        critical: findings.filter((f) => f.severity === 'critical').length,
      },
    }, tx as never)
    const runs = await listAccountingReconciliationRuns(tx as never, {
      limit: MAX_RECONCILIATION_LIST_RUNS, includeFindings: false,
    })
    return {
      dataset: rows.unmirroredSyncLogs,
      listed: unmirroredIds(findings),
      truncation: findings.filter((f) => f.code === UNMIRRORED_SYNC_LOGS_TRUNCATED),
      lifted: reconciliationTruncations(findings),
      reloaded: runs.find((entry) => entry.id === persisted.runId)?.truncations as
        AccountingReconciliationTruncation[] | null | undefined,
    }
  })

  // The expected page, computed from the fixture's own construction: the OLDEST are the highest g.
  const oldest = Array.from({ length: MAX_UNMIRRORED_SYNC_LOGS }, (_, i) =>
    `bnp6-over-${run}-${String(over - i).padStart(4, '0')}`).sort()

  assert.equal(observed.dataset?.total, over, 'the statement counted every unmirrored row, over the bound')
  assert.equal(observed.listed.length, MAX_UNMIRRORED_SYNC_LOGS, 'and listed exactly the bound')
  assert.deepEqual(observed.listed, oldest,
    'the listed rows are the OLDEST — the ones the old newest-first page discarded first')

  assert.equal(observed.truncation.length, 1, 'one truncation finding')
  assert.deepEqual(observed.truncation[0].details, {
    reported: MAX_UNMIRRORED_SYNC_LOGS, total: over, limit: MAX_UNMIRRORED_SYNC_LOGS,
  }, 'carrying the EXACT count the statement took')
  assert.match(observed.truncation[0].message, new RegExp(`^${over} `))

  // AND IT CANNOT READ AS COMPLETE: lifted onto the run, through the real writer and reader.
  assert.deepEqual(observed.lifted.map((t) => t.code), [UNMIRRORED_SYNC_LOGS_TRUNCATED],
    'the truncation is one of the run-level sentinels')
  assert.ok(Array.isArray(observed.reloaded), 'the run row recorded its truncations')
  const onRun = observed.reloaded?.find((t) => t.code === UNMIRRORED_SYNC_LOGS_TRUNCATED)
  assert.ok(onRun, 'and the persisted run carries this one')
  assert.deepEqual(onRun.details, { reported: MAX_UNMIRRORED_SYNC_LOGS, total: over, limit: MAX_UNMIRRORED_SYNC_LOGS })
})

test('o3d-bnp6: a row whose POSTED event fell off the EVENT page is not reported (the false positive)', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const row = `bnp6-fp-${run}`
  const observed = await withRollback(async (tx) => {
    // SYNCED inside the lookback, its mirror POSTED long before it — outside the event page's filter
    // (businessDate >= fromDate OR status <> POSTED), so the old in-memory lookup could not see it.
    await insertUnmirroredRow(tx, row, { status: 'SYNCED', ageDays: 3, referenceId: `${row}-ref` })
    await insertEvent(tx, `${row}-e`, { referenceId: `${row}-ref`, status: 'POSTED', businessDateAgeDays: 200 })
    const { rows, findings } = await report(tx)
    // An ABSENCE is asserted below, so the list it is absent from must be the whole set (review L4).
    assertListIsWhole(rows, 'the event-page false positive')
    return {
      eventOnPage: rows.accountingEvents.some((event) => event.id === `${row}-e`),
      rowOnPage: rows.syncLogs.some((log) => log.id === row),
      unmirrored: unmirroredIds(findings),
    }
  })
  assert.equal(observed.rowOnPage, true, 'PRECONDITION: the sync row is on the general page')
  assert.equal(observed.eventOnPage, false, 'PRECONDITION: its event is NOT on the event page')
  assert.ok(!observed.unmirrored.includes(row), 'and the row is not reported as having no event')
})

test('o3d-bnp6: the population is the page\'s, and an event of another connector, none, or another type is not a mirror', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const id = (name: string) => `bnp6-pop-${run}-${name}`
  const outsideWindow = DEFAULT_RECONCILIATION_LOOKBACK_DAYS + 10
  const observed = await withRollback(async (tx) => {
    await insertUnmirroredRow(tx, id('pending-old'), { status: 'PENDING', ageDays: outsideWindow })
    await insertUnmirroredRow(tx, id('processing-old'), { status: 'PROCESSING', ageDays: outsideWindow })
    await insertUnmirroredRow(tx, id('synced-old'), { status: 'SYNCED', ageDays: outsideWindow })
    await insertUnmirroredRow(tx, id('failed-old'), { status: 'FAILED', ageDays: outsideWindow })
    await insertUnmirroredRow(tx, id('synced-new'), { status: 'SYNCED', ageDays: 2 })
    await insertUnmirroredRow(tx, id('failed-new'), { status: 'FAILED', ageDays: 2 })
    await insertUnmirroredRow(tx, id('cancelled-new'), { status: 'CANCELLED', ageDays: 2 })
    await insertUnmirroredRow(tx, id('not-mirrored'), { status: 'PENDING', ageDays: 2, type: 'INVOICE_PDF' })
    // Events that do NOT count as this row's mirror: another connector, no connector, another type.
    await insertUnmirroredRow(tx, id('other-connector'), { status: 'PENDING', ageDays: 2, referenceId: id('oc-ref') })
    await insertEvent(tx, id('oc-e'), { referenceId: id('oc-ref'), externalSystem: 'quickbooks' })
    await insertUnmirroredRow(tx, id('null-connector'), { status: 'PENDING', ageDays: 2, referenceId: id('nc-ref') })
    await insertEvent(tx, id('nc-e'), { referenceId: id('nc-ref'), externalSystem: null })
    await insertUnmirroredRow(tx, id('other-type'), { status: 'PENDING', ageDays: 2, referenceId: id('ot-ref') })
    await insertEvent(tx, id('ot-e'), { referenceId: id('ot-ref'), type: 'CREDIT_NOTE' })
    // And one that DOES, in a status other than POSTED: the test is existence, in any status.
    await insertUnmirroredRow(tx, id('void-mirrored'), { status: 'PENDING', ageDays: 2, referenceId: id('vm-ref') })
    await insertEvent(tx, id('vm-e'), { referenceId: id('vm-ref'), status: 'VOID' })
    const { rows, findings } = await report(tx)
    assertListIsWhole(rows, 'the population')
    return ownIds(findings, `bnp6-pop-${run}-`)
  })

  assert.deepEqual(observed, [
    id('failed-new'),
    id('null-connector'),
    id('other-connector'),
    id('other-type'),
    id('pending-old'),
    id('processing-old'),
    id('synced-new'),
  ].sort(), 'work owed at any age, finished work inside the lookback, mirrored types only, and an '
    + 'event counts only on (connector, type, reference) in any status')
})

test('o3d-bnp6: the lookback boundary is the page\'s own, whatever the session time zone', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const inside = `bnp6-edge-${run}-inside`
  const outside = `bnp6-edge-${run}-outside`
  const observed = await withRollback(async (tx) => {
    // Ten minutes either side of the default lookback: wide enough for the clock the report reads
    // and the clock the database reads to disagree, narrow enough that a time-zone error flips one.
    await insertUnmirroredRow(tx, inside, {
      status: 'SYNCED', age: `${DEFAULT_RECONCILIATION_LOOKBACK_DAYS} days - 10 minutes`,
    })
    await insertUnmirroredRow(tx, outside, {
      status: 'SYNCED', age: `${DEFAULT_RECONCILIATION_LOOKBACK_DAYS} days + 10 minutes`,
    })
    // A session fourteen hours ahead of UTC. `createdAt` holds UTC wall-clock time, so a lookback that
    // were converted in the SESSION's zone would move the cutoff by fourteen hours and flip `outside`.
    await tx.$executeRawUnsafe(`SET LOCAL TimeZone = 'Pacific/Kiritimati'`)
    const { rows, findings } = await report(tx)
    assertListIsWhole(rows, 'the lookback boundary')
    return {
      page: rows.syncLogs.filter((log) => log.id === inside || log.id === outside).map((log) => log.id).sort(),
      reported: unmirroredIds(findings).filter((found) => found === inside || found === outside),
    }
  })
  assert.deepEqual(observed.page, [inside], 'PRECONDITION: the page itself takes exactly the inside row')
  assert.deepEqual(observed.reported, observed.page, 'and the question selects exactly what the page selects')
})

/**
 * o3d-bnp6 review M1 + L2 — AN EVENT MIRRORS A ROW ONLY ON FOUR EXACT EQUALITIES.
 *
 * The population test above covers a different connector, no connector and a different type. It did
 * not cover the other two columns, and the review showed that mattered: replacing the
 * `sourceEntityType` clause with TRUE left every test green, because no fixture had an event that
 * differed from its row ONLY there. The same was true of `sourceEntityId` except through test 1's
 * volume, and nothing pinned CASE or WHITESPACE: `lower(a) = lower(b)` on the connector and
 * `btrim(a) = btrim(b)` on the reference both survived. Each fixture below is a row whose would-be
 * event differs from it in exactly one column, in exactly one way, so each clause is the only thing
 * standing between that row and a false "mirrored" — plus a control whose event matches on all four,
 * which must NOT be reported, so the test cannot pass by reporting everything.
 */
test('o3d-bnp6: an event mirrors a row only when all four columns are EXACTLY equal', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const id = (name: string) => `bnp6-exact-${run}-${name}`
  const observed = await withRollback(async (tx) => {
    // Differs ONLY in sourceEntityType (review M1).
    await insertUnmirroredRow(tx, id('entity-type'), { ageDays: 2, referenceId: id('et-ref') })
    await insertEvent(tx, id('et-e'), { referenceId: id('et-ref'), sourceEntityType: 'OtherEntity' })
    // Differs ONLY in sourceEntityId — stated explicitly rather than left to test 1's volume.
    await insertUnmirroredRow(tx, id('entity-id'), { ageDays: 2, referenceId: id('ei-ref') })
    await insertEvent(tx, id('ei-e'), { referenceId: id('ei-ref-other') })
    // Differs ONLY in the CASE of the connector (review L2): 'Xero' is not 'xero'.
    await insertUnmirroredRow(tx, id('connector-case'), { ageDays: 2, connector: 'Xero', referenceId: id('cc-ref') })
    await insertEvent(tx, id('cc-e'), { referenceId: id('cc-ref'), externalSystem: 'xero' })
    // Differs ONLY in trailing WHITESPACE on the reference (review L2): 'R ' is not 'R'.
    await insertUnmirroredRow(tx, id('reference-space'), { ageDays: 2, referenceId: `${id('ws-ref')} ` })
    await insertEvent(tx, id('ws-e'), { referenceId: id('ws-ref') })
    // CONTROL: equal on all four, so it IS mirrored and must not be reported.
    await insertUnmirroredRow(tx, id('control'), { ageDays: 2, referenceId: id('ctl-ref') })
    await insertEvent(tx, id('ctl-e'), { referenceId: id('ctl-ref') })
    const { rows, findings } = await report(tx)
    assertListIsWhole(rows, 'exact matching')
    return ownIds(findings, `bnp6-exact-${run}-`)
  })

  assert.deepEqual(observed, [
    id('connector-case'),
    id('entity-id'),
    id('entity-type'),
    id('reference-space'),
  ].sort(), 'each row whose event differs in one column, by case or whitespace included, is reported; '
    + 'the control whose event matches on all four is not')
})

/**
 * o3d-bnp6 review L3 — THE CUTOFF INSTANT ITSELF.
 *
 * The boundary test above stands ten minutes either side of the lookback, so `>=` weakened to `>`
 * survived it. The page is `createdAt >= fromDate` (Prisma `gte`); a SYNCED row created AT fromDate,
 * to the millisecond, is on the page and must be asked about. `toDate` is fixed and fromDate is
 * derived from it with the report's own function, so the row can be placed on the instant exactly
 * rather than approximately — `createdAt` is timestamp(3), the same millisecond resolution as a Date.
 */
test('o3d-bnp6: a finished row created exactly AT the lookback cutoff is included, as the page includes it', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const atCutoff = `bnp6-cut-${run}-at`
  const justBefore = `bnp6-cut-${run}-before`
  const toDate = new Date(Math.floor(Date.now() / 1000) * 1000)
  const fromDate = reconciliationLookbackDate(DEFAULT_RECONCILIATION_LOOKBACK_DAYS, toDate)
  const observed = await withRollback(async (tx) => {
    for (const [rowId, at] of [[atCutoff, fromDate], [justBefore, new Date(fromDate.getTime() - 1)]] as const) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "accounting_sync_logs" (
           "id", "connector", "type", "status", "referenceType", "referenceId", "createdAt"
         ) VALUES ($1, 'xero', 'SALES_INVOICE'::"AccountingSyncType", 'SYNCED'::"AccountingSyncStatus",
                   'SalesOrder', $1 || '-ref', ($2::timestamptz AT TIME ZONE 'UTC'))`,
        rowId, at.toISOString(),
      )
    }
    const stored = await tx.$queryRawUnsafe(
      `SELECT "id", to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "at"
         FROM "accounting_sync_logs" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [atCutoff, justBefore],
    ) as Array<{ id: string; at: string }>
    const { rows, findings } = await report(tx, { toDate })
    assertListIsWhole(rows, 'the cutoff instant')
    return {
      stored,
      page: rows.syncLogs.filter((log) => log.id === atCutoff || log.id === justBefore).map((log) => log.id).sort(),
      reported: ownIds(findings, `bnp6-cut-${run}-`),
    }
  })

  assert.deepEqual(observed.stored, [
    { id: atCutoff, at: fromDate.toISOString() },
    { id: justBefore, at: new Date(fromDate.getTime() - 1).toISOString() },
  ], 'PRECONDITION: the two rows sit exactly on the cutoff and one millisecond before it')
  assert.deepEqual(observed.page, [atCutoff], 'PRECONDITION: the page takes the row AT the cutoff and not the one before')
  assert.deepEqual(observed.reported, observed.page, 'and the question is inclusive exactly where the page is')
})

test('o3d-bnp6: the probes left the database as they found it', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db')
  const [left] = await db.$queryRaw`
    SELECT (SELECT count(*) FROM "accounting_sync_logs" WHERE "id" LIKE 'bnp6-%')::int
         + (SELECT count(*) FROM "accounting_events"    WHERE "id" LIKE 'bnp6-%')::int AS "rows"
  ` as Array<{ rows: number }>
  assert.equal(left.rows, 0, 'every probe row was rolled back with its transaction')
})
