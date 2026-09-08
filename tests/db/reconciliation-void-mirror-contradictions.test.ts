import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import {
  DEFAULT_RECONCILIATION_LOOKBACK_DAYS,
  MAX_VOID_MIRROR_CONTRADICTIONS,
  collectAccountingReconciliationRows,
  evaluateAccountingReconciliationRows,
  reconciliationLookbackDate,
} from '../../lib/domain/accounting/reconciliation'

/**
 * o3d-11rf r4 (Codex r4, HIGH) — THE CAP APPLIED BEFORE THE QUESTION.
 *
 * WHAT CODEX FOUND. The unclassified-VOID warning paired events against sync rows in memory, over two
 * general pages the report already loads. Both are `ORDER BY <date> DESC LIMIT 10,000`: a bound
 * imposed on a broad load, with the filter that decides relevance applied afterwards. On a mature
 * install the event page is dominated by pre-column cancellation VOIDs, which compete for those
 * 10,000 slots with the rows the warning exists to find — and those rows are OLD BY DEFINITION. The
 * mechanism built to surface abandoned documents preferentially discarded the most abandoned ones.
 *
 * WHY THIS SUITE IS DATABASE-BACKED AND NOT A FIXTURE. The rule is now a JOIN, so what is being
 * asserted is WHICH ROWS A SQL STATEMENT SELECTS — a property of PostgreSQL, not of anything IMS
 * computes. A double could show the shape of a string handed to Prisma; it could not show what the
 * join does to a row. The evaluator deliberately does not re-apply the rule to what comes back (a
 * second filter there would mask a widened predicate here), so this file is the only place the rule
 * is proved at all.
 *
 * THE CENTRAL TEST is `an OLD contradiction sitting beyond the previous 10,000-row page is reported`.
 * It asserts its own precondition first — that the page the old code would have loaded really does
 * NOT contain the victim — so it cannot pass by accident against a version that never fixed anything.
 *
 * ROLLED BACK, ALWAYS. Every test runs inside a transaction that aborts, and the last one re-reads
 * from outside to prove it, so pointing RUN_DB_MIGRATION_TESTS at a database with real rows in it
 * cannot leave anything behind.
 *
 * Gated behind RUN_DB_MIGRATION_TESTS=1 (`npm run test:unit` has no database), against a database
 * built from `prisma migrate deploy`. Imports are RELATIVE for the same reason as the rest of
 * tests/db/*.
 */

const skip = process.env.RUN_DB_MIGRATION_TESTS !== '1'

/** The cap the OLD code loaded its event page under. Restated here because the point is to exceed it. */
const PREVIOUS_EVENT_PAGE_CAP = 10_000

const CONTRADICTION = 'void_mirror_basis_unknown_with_live_sync_row'
const TRUNCATED = 'void_mirror_basis_unknown_contradictions_truncated'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_MIGRATION_TESTS=1')
  }
}

/** Thrown to roll the probe transaction back. Nothing else may throw it. */
class RollbackProbe extends Error {}

type Tx = {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>
  accountingEvent: { create(args: unknown): Promise<unknown>; findMany(args: unknown): Promise<Array<{ id: string }>> }
  accountingSyncLog: { create(args: unknown): Promise<unknown> }
}

async function withRollback<T>(fn: (tx: Tx) => Promise<T>, timeout = 180_000): Promise<T> {
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

type EventShape = {
  id: string
  reference: string
  status?: string
  voidBasis?: string | null
  externalSystem?: string | null
  type?: string
  sourceEntityType?: string
  businessDate?: Date
}

async function makeEvent(tx: Tx, shape: EventShape) {
  await tx.accountingEvent.create({
    data: {
      id: shape.id,
      type: shape.type ?? 'SALES_INVOICE',
      sourceEntityType: shape.sourceEntityType ?? 'SalesOrder',
      sourceEntityId: shape.reference,
      businessDate: shape.businessDate ?? new Date('2026-01-01T00:00:00Z'),
      status: shape.status ?? 'VOID',
      idempotencyKey: `${shape.id}-key`,
      linesJson: [],
      currency: 'GBP',
      externalSystem: shape.externalSystem === undefined ? 'xero' : shape.externalSystem,
      voidBasis: shape.voidBasis ?? null,
    },
  })
}

type SyncShape = {
  id: string
  reference: string
  status?: string
  externalTransactionId?: string | null
  connector?: string
  type?: string
  referenceType?: string
}

async function makeSyncLog(tx: Tx, shape: SyncShape) {
  await tx.accountingSyncLog.create({
    data: {
      id: shape.id,
      connector: shape.connector ?? 'xero',
      type: shape.type ?? 'SALES_INVOICE',
      status: shape.status ?? 'PENDING',
      referenceType: shape.referenceType ?? 'SalesOrder',
      referenceId: shape.reference,
      externalTransactionId: shape.externalTransactionId ?? null,
    },
  })
}

/** The whole path a cron run takes: collect (which issues the join) then evaluate. */
async function reportFindings(tx: Tx) {
  const rows = await collectAccountingReconciliationRows(
    tx as unknown as Parameters<typeof collectAccountingReconciliationRows>[0],
  )
  return {
    rows,
    findings: evaluateAccountingReconciliationRows(rows),
  }
}

// ---------------------------------------------------------------------------------------------
// THE RULE, IN THE DATABASE
// ---------------------------------------------------------------------------------------------

/**
 * Every shape is its own document — a distinct `referenceId` — so nothing here can be reported by
 * matching something else's row. The shapes that must NOT be reported are what stop this suite
 * passing against a join that simply pairs every VOID with every sync row.
 */
type Shape = {
  label: string
  event: Omit<EventShape, 'id' | 'reference'>
  syncLogs: Array<Omit<SyncShape, 'id' | 'reference'>>
  reported: boolean
  /** When reported, the sync-row suffixes expected in the finding, in order. */
  expectSyncSuffixes?: number[]
}

const SHAPES: Shape[] = [
  {
    label: 'an unexplained VOID with a PENDING row that holds no document id — the whole subject',
    event: {},
    syncLogs: [{ status: 'PENDING' }],
    reported: true,
    expectSyncSuffixes: [0],
  },
  {
    label: 'PROCESSING is live work too',
    event: {},
    syncLogs: [{ status: 'PROCESSING' }],
    reported: true,
    expectSyncSuffixes: [0],
  },
  {
    label: 'every contradicting row is named, on ONE finding',
    event: {},
    syncLogs: [{ status: 'PENDING' }, { status: 'PROCESSING' }],
    reported: true,
    expectSyncSuffixes: [0, 1],
  },
  {
    label: 'a blank document id is no document id (btrim), so the row is still work owed',
    event: {},
    syncLogs: [{ status: 'PENDING', externalTransactionId: '   ' }],
    reported: true,
    expectSyncSuffixes: [0],
  },
  {
    label: 'SYNCED ON ITS OWN is excluded: it has already done its posting, whatever id it kept',
    event: {},
    syncLogs: [{ status: 'SYNCED' }],
    reported: false,
  },
  {
    label: 'a FAILED row is terminal, so no VOID mirror is preventing it',
    event: {},
    syncLogs: [{ status: 'FAILED' }],
    reported: false,
  },
  {
    label: 'and neither is a CANCELLED one',
    event: {},
    syncLogs: [{ status: 'CANCELLED' }],
    reported: false,
  },
  {
    label: 'a live row carrying a document id describes a document that EXISTS (o3d-ju8t)',
    event: {},
    syncLogs: [{ status: 'PENDING', externalTransactionId: 'INV-8' }],
    reported: false,
  },
  {
    label: 'a void a writer explained as a cancellation is not unclassified',
    event: { voidBasis: 'source_cancelled' },
    syncLogs: [{ status: 'PENDING' }],
    reported: false,
  },
  {
    label: 'nor is one explained as a settled attempt — the column is the whole point',
    event: { voidBasis: 'attempt_settled_not_posted' },
    syncLogs: [{ status: 'PENDING' }],
    reported: false,
  },
  {
    label: 'a PENDING event is not a VOID mirror at all',
    event: { status: 'PENDING' },
    syncLogs: [{ status: 'PENDING' }],
    reported: false,
  },
  {
    label: 'a POSTED event is not either',
    event: { status: 'POSTED' },
    syncLogs: [{ status: 'PENDING' }],
    reported: false,
  },
  {
    label: 'a different CONNECTOR is a different document',
    event: {},
    syncLogs: [{ status: 'PENDING', connector: 'quickbooks' }],
    reported: false,
  },
  {
    label: 'a different TYPE is a different document',
    event: {},
    syncLogs: [{ status: 'PENDING', type: 'CREDIT_NOTE' }],
    reported: false,
  },
  {
    label: 'a different REFERENCE TYPE is a different document',
    event: { sourceEntityType: 'Shipment' },
    syncLogs: [{ status: 'PENDING', referenceType: 'SalesOrder' }],
    reported: false,
  },
  {
    label: 'an event with NO external system matches nothing: SQL equality never matches a NULL',
    event: { externalSystem: null },
    syncLogs: [{ status: 'PENDING' }],
    reported: false,
  },
]

test('o3d-11rf r4: which pairs the contradiction join selects, and which it refuses', { skip }, async () => {
  const run = randomUUID().slice(0, 8)

  const findings = await withRollback(async (tx) => {
    for (const [index, shape] of SHAPES.entries()) {
      const reference = `11rf4-${run}-o${index}`
      await makeEvent(tx, { ...shape.event, id: `11rf4-${run}-e${index}`, reference })
      for (const [n, log] of shape.syncLogs.entries()) {
        await makeSyncLog(tx, { ...log, id: `11rf4-${run}-s${index}-${n}`, reference })
      }
    }
    return (await reportFindings(tx)).findings
  })

  const byEvent = new Map(
    findings.filter((f) => f.code === CONTRADICTION).map((f) => [f.accountingEventId, f]),
  )

  for (const [index, shape] of SHAPES.entries()) {
    const finding = byEvent.get(`11rf4-${run}-e${index}`)
    assert.equal(Boolean(finding), shape.reported, shape.label)
    if (!finding || !shape.expectSyncSuffixes) continue
    assert.deepEqual(
      (finding.details as { syncLogIds: string[] }).syncLogIds,
      shape.expectSyncSuffixes.map((n) => `11rf4-${run}-s${index}-${n}`),
      `${shape.label} — and it names every row whose work the void is blocking`,
    )
  }

  // NOT VACUOUS in either direction: a join that matched everything, or nothing, fails here.
  const expected = SHAPES.filter((shape) => shape.reported).length
  assert.equal(byEvent.size, expected, `exactly ${expected} of the ${SHAPES.length} shapes are contradictions`)
  assert.ok(expected > 0 && expected < SHAPES.length, 'and the fixture really does contain both kinds')

  // A complete list carries no truncation finding; that is what makes a short list mean something.
  assert.equal(findings.some((f) => f.code === TRUNCATED), false)
})

// ---------------------------------------------------------------------------------------------
// THE FINDING ITSELF — the over-cap case Codex asked for by name
// ---------------------------------------------------------------------------------------------

test('o3d-11rf r4: an OLD contradiction beyond the previous 10,000-row page IS reported', { skip }, async () => {
  // THE REGRESSION. The victim's business date is older than every one of the decoys, and there are
  // more decoys than the page the old code loaded. Under `businessDate DESC LIMIT 10,000` the victim
  // is not in the page at all, so the in-memory pairing could never have seen it however correct the
  // pairing was. The decoys are the exact shape Codex named: pre-column cancellation VOIDs, which are
  // non-POSTED and so occupy the page unconditionally, with nothing live beside them.
  const run = randomUUID().slice(0, 8)
  const decoys = PREVIOUS_EVENT_PAGE_CAP + 50

  const { findings, pagedEventIds } = await withRollback(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO "accounting_events" (
         "id", "type", "sourceEntityType", "sourceEntityId", "businessDate", "status",
         "idempotencyKey", "linesJson", "currency", "externalSystem", "voidBasis", "createdAt", "updatedAt"
       )
       SELECT
         $1 || g, 'SALES_INVOICE', 'SalesOrder', $1 || g,
         TIMESTAMP '2026-06-01 00:00:00' + (g * INTERVAL '1 second'),
         'VOID', $1 || g || '-key', '[]'::jsonb, 'GBP', 'xero', NULL, now(), now()
       FROM generate_series(1, $2::int) g`,
      `11rf4-decoy-${run}-`,
      decoys,
    )

    // The victim: older than every decoy, unexplained, with live unposted work against it.
    const reference = `11rf4-victim-${run}`
    await makeEvent(tx, {
      id: `11rf4-victim-e-${run}`,
      reference,
      businessDate: new Date('2019-03-04T00:00:00Z'),
    })
    await makeSyncLog(tx, { id: `11rf4-victim-s-${run}`, reference, status: 'PENDING' })

    // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED: the page the old code loaded, spelled exactly
    // as it spelled it. If the victim were inside this, the test would pass against the unfixed
    // code and would be proving nothing.
    const paged = await tx.accountingEvent.findMany({
      where: {
        OR: [
          { businessDate: { gte: reconciliationLookbackDate(DEFAULT_RECONCILIATION_LOOKBACK_DAYS) } },
          { status: { not: 'POSTED' } },
        ],
      },
      orderBy: { businessDate: 'desc' },
      take: PREVIOUS_EVENT_PAGE_CAP,
      select: { id: true },
    })

    return { findings: (await reportFindings(tx)).findings, pagedEventIds: paged.map((row) => row.id) }
  })

  assert.equal(pagedEventIds.length, PREVIOUS_EVENT_PAGE_CAP, 'the old page really did fill up')
  assert.equal(
    pagedEventIds.includes(`11rf4-victim-e-${run}`),
    false,
    'and the victim is NOT in it — which is the defect, stated as a fact about this fixture',
  )

  const reported = findings.filter((f) => f.code === CONTRADICTION)
  assert.deepEqual(
    reported.map((f) => f.accountingEventId),
    [`11rf4-victim-e-${run}`],
    'the join finds it anyway: the filter is the query, and only what survives it is bounded',
  )
  assert.deepEqual((reported[0].details as { syncLogIds: string[] }).syncLogIds, [`11rf4-victim-s-${run}`])
  assert.equal(findings.some((f) => f.code === TRUNCATED), false, 'one contradiction is not a truncated list')
})

test('o3d-11rf r4: over the bound, the list says how much of it is missing', { skip }, async () => {
  // THE BOUND, AND WHAT HAPPENS AT IT. A silently short list is the original defect one level up, so
  // the operator is told the exact number found — a count taken by the same statement, over the same
  // snapshot, as the page it describes.
  const run = randomUUID().slice(0, 8)
  const over = MAX_VOID_MIRROR_CONTRADICTIONS + 5

  const { findings, surviving } = await withRollback(async (tx) => {
    // Ids are zero-padded so `ORDER BY "accountingEventId"` is the numeric order, and the page the
    // query returns is therefore predictable rather than whatever the planner felt like.
    await tx.$executeRawUnsafe(
      `INSERT INTO "accounting_events" (
         "id", "type", "sourceEntityType", "sourceEntityId", "businessDate", "status",
         "idempotencyKey", "linesJson", "currency", "externalSystem", "voidBasis", "createdAt", "updatedAt"
       )
       SELECT
         $1 || lpad(g::text, 5, '0'), 'SALES_INVOICE', 'SalesOrder', $1 || lpad(g::text, 5, '0'),
         TIMESTAMP '2026-06-01 00:00:00', 'VOID',
         $1 || lpad(g::text, 5, '0') || '-key', '[]'::jsonb, 'GBP', 'xero', NULL, now(), now()
       FROM generate_series(1, $2::int) g`,
      `11rf4-many-${run}-`,
      over,
    )
    await tx.$executeRawUnsafe(
      `INSERT INTO "accounting_sync_logs" (
         "id", "connector", "type", "status", "referenceType", "referenceId",
         "externalTransactionId", "createdAt"
       )
       SELECT
         $1 || lpad(g::text, 5, '0') || '-s', 'xero', 'SALES_INVOICE'::"AccountingSyncType",
         'PENDING'::"AccountingSyncStatus", 'SalesOrder', $1 || lpad(g::text, 5, '0'), NULL, now()
       FROM generate_series(1, $2::int) g`,
      `11rf4-many-${run}-`,
      over,
    )

    const { rows, findings: all } = await reportFindings(tx)
    return { findings: all, surviving: rows.voidMirrorContradictions }
  })

  const reported = findings.filter((f) => f.code === CONTRADICTION)
  assert.equal(reported.length, MAX_VOID_MIRROR_CONTRADICTIONS, 'the page is exactly the bound, not more')
  assert.equal(surviving?.total, over, 'and the count is of what EXISTS, not of what fitted')

  const truncated = findings.filter((f) => f.code === TRUNCATED)
  assert.equal(truncated.length, 1, 'the truncation is said once, as a finding of its own')
  assert.deepEqual(truncated[0].details, {
    reported: MAX_VOID_MIRROR_CONTRADICTIONS,
    total: over,
    limit: MAX_VOID_MIRROR_CONTRADICTIONS,
  })
  assert.match(truncated[0].message, new RegExp(String(over)), 'the number is where an operator reads it')

  // The page is the FIRST bound-many by id, not an arbitrary bound-many: a LIMIT with no ORDER BY
  // would pass every assertion above while returning a different set on every run, and an operator
  // working the list would never reach the end of it.
  assert.deepEqual(
    reported.slice(0, 3).map((f) => f.accountingEventId),
    [1, 2, 3].map((n) => `11rf4-many-${run}-${String(n).padStart(5, '0')}`),
  )
  assert.equal(
    reported.at(-1)?.accountingEventId,
    `11rf4-many-${run}-${String(MAX_VOID_MIRROR_CONTRADICTIONS).padStart(5, '0')}`,
  )
})

test('o3d-11rf r4: the probes left the database as they found it', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db')
  const survivors = await db.accountingEvent.count({ where: { id: { startsWith: '11rf4-' } } })
  assert.equal(survivors, 0, 'every probe above rolled back')
})
