import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import {
  DEFAULT_RECONCILIATION_LOOKBACK_DAYS,
  MAX_RECONCILIATION_FINDINGS_PER_RUN,
  MAX_RECONCILIATION_LIST_RUNS,
  MAX_VOID_MIRROR_CONTRADICTIONS,
  collectAccountingReconciliationRows,
  evaluateAccountingReconciliationRows,
  listAccountingReconciliationRuns,
  persistAccountingReconciliationReport,
  reconciliationLookbackDate,
  ECMASCRIPT_BLANK_PATTERN,
  type AccountingReconciliationFinding,
  type AccountingReconciliationTruncation,
} from '../../lib/domain/accounting/reconciliation'
import { mirroredAccountingEventIdempotencyKeys } from '../../lib/domain/accounting/accounting-event-mirror'

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

/**
 * The over-cap fixture, shared by the r4 collector test and the r5 persistence test below.
 *
 * o3d-11rf r9: every event here carries the key ITS OWN sync row derives. These rows have no payload,
 * so that is the `accounting-sync-log:<connector>:<syncLogId>` form, built in SQL because the rows are
 * built in SQL — and then checked against the mirror's own builder before a single one is trusted, so
 * a bulk fixture cannot quietly go on agreeing with a rule that has changed.
 */
async function insertContradictions(tx: Tx, prefix: string, count: number) {
  const firstSyncLogId = `${prefix}${String(1).padStart(5, '0')}-s`
  assert.equal(
    `accounting-sync-log:xero:${firstSyncLogId.toLowerCase()}`,
    mirrorKeyFor({ syncLogId: firstSyncLogId, referenceId: 'unused-by-this-key-form' }),
    'the bulk fixture builds the same key the mirror would',
  )
  // WRITTEN IN THE OPPOSITE ORDER TO THEIR IDS: `lpad($2 + 1 - g)` means the first row on disk
  // carries the HIGHEST id. That removes the cheapest way for a fixture to agree with the query by
  // accident.
  await tx.$executeRawUnsafe(
    `INSERT INTO "accounting_events" (
       "id", "type", "sourceEntityType", "sourceEntityId", "businessDate", "status",
       "idempotencyKey", "linesJson", "currency", "externalSystem", "voidBasis", "createdAt", "updatedAt"
     )
     SELECT
       $1 || lpad(($2::int + 1 - g)::text, 5, '0'), 'SALES_INVOICE', 'SalesOrder',
       $1 || lpad(($2::int + 1 - g)::text, 5, '0'),
       TIMESTAMP '2026-06-01 00:00:00', 'VOID',
       'accounting-sync-log:xero:' || lower($1 || lpad(($2::int + 1 - g)::text, 5, '0') || '-s'),
       '[]'::jsonb, 'GBP', 'xero', NULL, now(), now()
     FROM generate_series(1, $2::int) g`,
    prefix,
    count,
  )
  await tx.$executeRawUnsafe(
    `INSERT INTO "accounting_sync_logs" (
       "id", "connector", "type", "status", "referenceType", "referenceId",
       "externalTransactionId", "createdAt"
     )
     SELECT
       $1 || lpad(($2::int + 1 - g)::text, 5, '0') || '-s', 'xero', 'SALES_INVOICE'::"AccountingSyncType",
       'PENDING'::"AccountingSyncStatus", 'SalesOrder', $1 || lpad(($2::int + 1 - g)::text, 5, '0'),
       NULL, now()
     FROM generate_series(1, $2::int) g`,
    prefix,
    count,
  )
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
  /**
   * o3d-11rf r9 — THE KEY IS THE MIRROR'S IDENTITY, so a fixture that wants to be OWNED by a sync row
   * has to carry the key that row derives. Fixtures used to default to `<id>-key`, an id-shaped
   * string no row could ever produce, and the join paired them anyway because it matched on the four
   * scope columns alone. That is the r9 defect, and it is why these fixtures could not have caught it.
   */
  idempotencyKey?: string
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
      idempotencyKey: shape.idempotencyKey ?? `${shape.id}-key`,
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
  /** What the row was going to send. The mirror key is derived from it, so it is identity here. */
  payload?: unknown
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
      payload: shape.payload === undefined ? undefined : (shape.payload as never),
    },
  })
}

/**
 * The key the mirror would give a row of this shape — asked of the PRODUCTION function, never spelled
 * out here. A fixture that hand-built the string would agree with a SQL derivation that had drifted
 * from the TypeScript one, which is the failure this whole file now exists to make impossible.
 */
function mirrorKeyFor(params: {
  syncLogId?: string
  connector?: string
  type?: string
  referenceType?: string
  referenceId: string
  payload?: unknown
}): string {
  const keys = mirroredAccountingEventIdempotencyKeys({
    syncLogId: params.syncLogId,
    connector: params.connector ?? 'xero',
    type: params.type ?? 'SALES_INVOICE',
    referenceType: params.referenceType ?? 'SalesOrder',
    referenceId: params.referenceId,
    payload: params.payload ?? null,
  })
  assert.ok(keys.length > 0, 'the fixture asked for a key the mirror does not derive')
  return keys[0]
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
  /**
   * o3d-11rf r9 — WHICH KEY FORM MAKES THIS SHAPE'S EVENT THE ROW'S OWN MIRROR.
   *
   * 'row'     — no payload; the key is `accounting-sync-log:<connector>:<syncLogId>`, so exactly ONE
   *             row can own the event.
   * 'payload' — the row carries an `_idempotencyKey`, and the key is derived from it. ONE live row
   *             only, and that is the DATABASE's rule rather than a choice made here:
   *             `accounting_sync_logs_idempotency_key_uq` is UNIQUE on
   *             (connector, type, referenceType, referenceId, payload->>'_idempotencyKey') for
   *             PENDING/PROCESSING/SYNCED, so two LIVE rows in one scope cannot share that token.
   * 'legacy'  — every sync log carries the same `date` and no `_idempotencyKey`, so all of them derive
   *             the SAME legacy `accounting-sync:<connector>:<type>:<ref>:<date>` key and all of them
   *             own the event. The unique index above does not reach these (its predicate needs the
   *             key to be PRESENT), so this — not 'payload' — is how several live rows legitimately
   *             share one mirror, and it is the form the r9 recommendation named by hand.
   */
  ownership?: 'row' | 'payload' | 'legacy'
}

const SHAPES: Shape[] = [
  {
    label: 'an unexplained VOID with a PENDING row that holds no document id — the whole subject',
    event: {},
    syncLogs: [{ status: 'PENDING' }],
    reported: true,
    expectSyncSuffixes: [0],
    ownership: 'row',
  },
  {
    label: 'PROCESSING is live work too',
    event: {},
    syncLogs: [{ status: 'PROCESSING' }],
    reported: true,
    expectSyncSuffixes: [0],
    ownership: 'row',
  },
  {
    label: 'every contradicting row is named, on ONE finding — the shared LEGACY key',
    event: {},
    syncLogs: [{ status: 'PENDING' }, { status: 'PROCESSING' }],
    reported: true,
    expectSyncSuffixes: [0, 1],
    ownership: 'legacy',
  },
  {
    label: 'a blank document id is no document id, so the row is still work owed',
    event: {},
    syncLogs: [{ status: 'PENDING', externalTransactionId: '   ' }],
    reported: true,
    expectSyncSuffixes: [0],
  },
  {
    // o3d-11rf r10 — AND BLANK MEANS WHAT `.trim()` MEANS. Every TypeScript reader of this column
    // asks `externalTransactionId?.trim()`; this statement asked `btrim(text)`, which strips ordinary
    // spaces only. A tab-and-NBSP id therefore described a DOCUMENT THAT EXISTS to the join alone,
    // and the row it belongs to was dropped out of the live set — the same defect Codex found on the
    // payload token, twenty-five lines further down the same statement.
    label: 'a document id of a TAB and an NBSP is blank too, whatever btrim(text) makes of it',
    event: {},
    syncLogs: [{ status: 'PENDING', externalTransactionId: '\u0009\u00a0' }],
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
      const syncLogId = (n: number) => `11rf4-${run}-s${index}-${n}`

      // o3d-11rf r9 — the event carries the key its OWNER derives, asked of the mirror's own builder.
      // A shape that gets this wrong is not a shape the join can report, however its scope reads.
      const ownership = shape.ownership ?? 'payload'
      const payload =
        ownership === 'payload' ? { _idempotencyKey: `11rf4-${run}-doc${index}` }
        : ownership === 'legacy' ? { date: '2026-01-02' }
        : undefined
      if (ownership !== 'legacy') {
        assert.equal(shape.syncLogs.length, 1,
          `${shape.label} — only the legacy key form can be owned by more than one live row`)
      }

      await makeEvent(tx, {
        ...shape.event,
        id: `11rf4-${run}-e${index}`,
        reference,
        // 'row' passes the sync-log id so the PRIMARY key is the row form; 'legacy' withholds it so
        // the primary IS the legacy form. Neither spells a key out.
        idempotencyKey: mirrorKeyFor({
          referenceId: reference,
          payload,
          ...(ownership === 'row' ? { syncLogId: syncLogId(0) } : {}),
        }),
      })
      for (const [n, log] of shape.syncLogs.entries()) {
        await makeSyncLog(tx, { ...log, id: syncLogId(n), reference, payload })
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
      idempotencyKey: mirrorKeyFor({ syncLogId: `11rf4-victim-s-${run}`, referenceId: reference }),
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
    // The fixture writes its rows in the opposite order to their ids; see `insertContradictions`.
    //
    // IT IS STILL NOT A PROOF THAT THE STATEMENT ORDERS, and the comment says so rather than
    // implying otherwise: deleting the `ORDER BY` from the query leaves this test green either way,
    // because the grouped plan emits its rows in group-key order all on its own. That is a property
    // of one planner on one row count, not of the query, so the ORDER BY is asserted where it can
    // be asserted — on the STATEMENT, in the sibling unit suite. What this test proves is the other
    // half: WHICH 500 of the 505 come back.
    await insertContradictions(tx, `11rf4-many-${run}-`, over)

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

  // THE PAGE IS THE FIRST bound-many BY ID, not an arbitrary bound-many — asserted over the WHOLE
  // page rather than its ends, so a page that is the right size but the wrong 500 fails. (That the
  // STATEMENT is what orders it, rather than the plan, is asserted in the unit suite; see the note
  // on the fixture above.)
  assert.deepEqual(
    reported.map((f) => f.accountingEventId),
    Array.from(
      { length: MAX_VOID_MIRROR_CONTRADICTIONS },
      (_unused, i) => `11rf4-many-${run}-${String(i + 1).padStart(5, '0')}`,
    ),
    'the first 500 by id, in id order — the same 500 every run',
  )
})

/**
 * o3d-11rf r5 (Codex r4, HIGH) — THE HALF THE r4 TEST ABOVE COULD NOT REACH.
 *
 * The test above stops at the evaluator's array, where all 501 findings exist. An operator never sees
 * that array. They see a PERSISTED run read back through `listAccountingReconciliationRuns`, which
 * returns at most `MAX_RECONCILIATION_FINDINGS_PER_RUN` findings — so the truncation warning, being
 * the 501st, is the row that need not come back, and a test that stopped at the collector would pass
 * against code where it never does.
 *
 * WHY THE REMEDY COULD NOT BE AN ORDERING, PROVED HERE RATHER THAN ASSERTED. The findings of a run
 * are written by one `createMany` inside one transaction, and `createdAt` defaults to
 * CURRENT_TIMESTAMP — transaction start time in PostgreSQL. This test counts the DISTINCT `createdAt`
 * values of a 501-row run and finds ONE. The reader's `ORDER BY "createdAt" ASC LIMIT 500` therefore
 * has nothing to order by, and which 500 come back is whatever the plan emits: prioritising the
 * sentinel by ordering is not available without a new priority column and an ORDER BY on it. Given a
 * migration either way, the fact belongs on the run, where no page can drop it.
 *
 * So this test deliberately asserts NOTHING about whether the warning is in the returned page. That
 * is unspecified, and a test that pinned it would be pinning one plan.
 */
test('o3d-11rf r5: a PERSISTED over-cap run still tells an operator the list is short', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const over = MAX_VOID_MIRROR_CONTRADICTIONS + 5

  const observed = await withRollback(async (tx) => {
    await insertContradictions(tx, `11rf5-many-${run}-`, over)

    const { findings } = await reportFindings(tx)
    const report = {
      checkedAt: '2026-09-08T12:00:00.000Z',
      fromDate: '2026-06-10T12:00:00.000Z',
      toDate: '2026-09-08T12:00:00.000Z',
      findings,
      summary: {
        total: findings.length,
        warning: findings.filter((finding: AccountingReconciliationFinding) => finding.severity === 'warning').length,
        critical: findings.filter((finding: AccountingReconciliationFinding) => finding.severity === 'critical').length,
      },
    }

    // The real writer and the real reader, against real PostgreSQL — the two steps between the
    // evaluator and the operator, and the only place the warning can go missing.
    const persisted = await persistAccountingReconciliationReport(report, tx as never)
    const runs = await listAccountingReconciliationRuns(tx as never, {
      limit: MAX_RECONCILIATION_LIST_RUNS,
      includeFindings: true,
    })
    const distinct = await tx.$queryRaw`
      SELECT count(DISTINCT "createdAt")::int AS "distinctCreatedAt"
      FROM "accounting_reconciliation_findings"
      WHERE "runId" = ${persisted.runId}
    ` as Array<{ distinctCreatedAt: number }>

    return {
      evaluated: findings.length,
      runId: persisted.runId,
      reloaded: runs.find((entry) => entry.id === persisted.runId),
      distinctCreatedAt: distinct[0]?.distinctCreatedAt,
    }
  })

  // THE PREMISE, ASSERTED BEFORE ANYTHING IS CONCLUDED FROM IT.
  assert.equal(observed.evaluated, MAX_RECONCILIATION_FINDINGS_PER_RUN + 1,
    'the run overflows the reader by exactly the truncation warning — without that there is nothing to lose')

  const reloaded = observed.reloaded
  assert.ok(reloaded, 'the run was persisted and read back')
  assert.equal(reloaded.findings?.length, MAX_RECONCILIATION_FINDINGS_PER_RUN, 'the reader hands back a capped page')
  assert.equal(reloaded._count?.findings, MAX_RECONCILIATION_FINDINGS_PER_RUN + 1, 'and one written row is not on it')

  // WHY ORDERING WAS NEVER AN OPTION.
  assert.equal(observed.distinctCreatedAt, 1,
    'every finding of a run shares one createdAt, so the reader\'s ORDER BY cannot prefer the sentinel')

  // AND WHAT THE OPERATOR CAN STILL READ, whichever 500 the plan chose.
  const truncations = reloaded.truncations as AccountingReconciliationTruncation[]
  assert.equal(truncations.length, 1, 'the run itself names what was truncated')
  assert.equal(truncations[0].code, TRUNCATED)
  assert.deepEqual(truncations[0].details, {
    reported: MAX_VOID_MIRROR_CONTRADICTIONS,
    total: over,
    limit: MAX_VOID_MIRROR_CONTRADICTIONS,
  }, 'with the exact count taken by the statement that produced the page')
  assert.match(truncations[0].message, new RegExp(String(over)))

  // The run this test wrote must not outlive the probe transaction either.
  loadEnv()
  const { db } = await import('../../lib/db')
  assert.equal(await db.accountingReconciliationRun.count({ where: { id: observed.runId } }), 0,
    'the persisted run rolled back with everything else')
})

// ---------------------------------------------------------------------------------------------
// o3d-11rf r9 (Codex r9, HIGH) — A SHARED SCOPE IS NOT OWNERSHIP OF THE SAME MIRROR
// ---------------------------------------------------------------------------------------------

/**
 * THE DECISIVE TEST, and the one the r4 suite above could not be: every fixture there gave a document
 * ONE sync row and ONE event, so "the event this row owns" and "an event about this row's document"
 * were the same set and no test could tell the two rules apart.
 *
 * WHAT PRODUCTION LOOKS LIKE INSTEAD. A settled attempt and its replacement share all four scope
 * columns, and the database ALLOWS that: `accounting_sync_logs_idempotency_key_uq` only forbids two
 * LIVE rows sharing a payload `_idempotencyKey`, and a CANCELLED row is outside its predicate
 * entirely. Each attempt derives its own mirror key, so the settled one's unexplained VOID says
 * nothing whatever about the live one — whose own mirror is sitting there PENDING and healthy.
 *
 * IT ASSERTS ITS OWN PRECONDITION BY RUNNING THE OLD RULE. The scope-only join is spelled out below
 * and must PAIR them; if it did not, this fixture would never have reached the defect and the test
 * would pass against the unfixed code for the wrong reason.
 */
test('o3d-11rf r9: a VOID mirror is NOT reported against a live row that owns a different mirror', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const shared = `11rf9-shared-${run}`
  const other = `11rf9-other-${run}`
  const settledRow = `11rf9-s-settled-${run}`
  const liveRow = `11rf9-s-live-${run}`
  const victimRow = `11rf9-s-victim-${run}`

  const { findings, scopeOnlyPairs, scopes } = await withRollback(async (tx) => {
    // ONE document, TWO attempts. The settled attempt's mirror is VOID and nobody recorded why.
    await makeSyncLog(tx, { id: settledRow, reference: shared, status: 'CANCELLED' })
    await makeEvent(tx, {
      id: `11rf9-e-void-${run}`,
      reference: shared,
      status: 'VOID',
      voidBasis: null,
      idempotencyKey: mirrorKeyFor({ syncLogId: settledRow, referenceId: shared }),
    })

    // The replacement, live and unposted — and its OWN mirror, PENDING and perfectly healthy.
    await makeSyncLog(tx, { id: liveRow, reference: shared, status: 'PENDING' })
    await makeEvent(tx, {
      id: `11rf9-e-live-${run}`,
      reference: shared,
      status: 'PENDING',
      idempotencyKey: mirrorKeyFor({ syncLogId: liveRow, referenceId: shared }),
    })

    // A POSITIVE CONTROL on a different document, so "nothing reported" cannot pass by the query
    // having been narrowed into uselessness.
    await makeSyncLog(tx, { id: victimRow, reference: other, status: 'PENDING' })
    await makeEvent(tx, {
      id: `11rf9-e-victim-${run}`,
      reference: other,
      status: 'VOID',
      voidBasis: null,
      idempotencyKey: mirrorKeyFor({ syncLogId: victimRow, referenceId: other }),
    })

    // THE PRECONDITION: the rule this replaced, spelled as it was spelled, against these very rows.
    const scopeOnly = await tx.$queryRaw`
      SELECT e."id" AS "eventId", l."id" AS "syncLogId"
      FROM "accounting_events" e
      JOIN "accounting_sync_logs" l
        ON l."connector"     = e."externalSystem"
       AND l."type"::text    = e."type"
       AND l."referenceType" = e."sourceEntityType"
       AND l."referenceId"   = e."sourceEntityId"
      WHERE e."status" = 'VOID'
        AND e."voidBasis" IS NULL
        AND l."status"::text = ANY(ARRAY['PENDING', 'PROCESSING']::text[])
        AND (l."externalTransactionId" IS NULL OR btrim(l."externalTransactionId") = '')
        AND e."id" LIKE ${`11rf9-e-%-${run}`}
      ORDER BY e."id", l."id"
    ` as Array<{ eventId: string; syncLogId: string }>

    // And that the two attempts really do share every one of the four columns.
    const scopes = await tx.$queryRaw`
      SELECT "id", "connector", "type"::text AS "type", "referenceType", "referenceId"
      FROM "accounting_sync_logs"
      WHERE "id" IN (${settledRow}, ${liveRow})
      ORDER BY "id"
    ` as Array<Record<string, string>>

    return { findings: (await reportFindings(tx)).findings, scopeOnlyPairs: scopeOnly, scopes }
  })

  assert.equal(scopes.length, 2, 'both attempts exist')
  assert.deepEqual(
    { ...scopes[0], id: undefined },
    { ...scopes[1], id: undefined },
    'the two attempts share all four scope columns — which is what made the old join pair them',
  )
  assert.deepEqual(
    scopeOnlyPairs,
    [
      { eventId: `11rf9-e-victim-${run}`, syncLogId: victimRow },
      { eventId: `11rf9-e-void-${run}`, syncLogId: liveRow },
    ],
    'the OLD scope-only rule pairs the settled attempt’s VOID with the LIVE row it does not own — '
    + 'the false finding, reproduced here so its disappearance below means something',
  )

  const reported = findings.filter((f) => f.code === CONTRADICTION)
  assert.deepEqual(
    reported.map((f) => f.accountingEventId),
    [`11rf9-e-victim-${run}`],
    'ownership reports only the document whose OWN mirror is an unexplained VOID',
  )
  assert.deepEqual(
    (reported[0].details as { syncLogIds: string[] }).syncLogIds,
    [victimRow],
    'and names that document’s own row, not a stranger sharing its scope',
  )
})

/**
 * THE DERIVATION ITSELF, CHECKED AGAINST THE FUNCTION IT REIMPLEMENTS.
 *
 * The join builds mirror keys in SQL because it has to: the pairing must BE the filter, or the bound
 * lands before the question again (see the r4 note at the top of this file). The cost of that is two
 * implementations of one rule, and the only honest mitigation is to make them prove they agree — over
 * every branch `mirroredAccountingEventIdempotencyKeys` has, including the two payload shapes that
 * LOOK like a key and are not one, and the type that is not mirrored at all.
 *
 * EACH SHAPE IS ASSERTED IN BOTH DIRECTIONS: an event carrying a key the function derives IS reported,
 * and an event in the SAME SCOPE carrying a sibling attempt’s key is NOT. Without the negative half
 * every one of these would pass against the scope-only join this replaced.
 */
const PAYLOAD_SHAPES: Array<{ label: string; payload: unknown; keys: number; type?: string }> = [
  { label: 'no payload at all: the sync-log id form, and only that', payload: null, keys: 1 },
  { label: 'a payload key, normalised the way the builder normalises it', payload: { _idempotencyKey: 'Doc/42' }, keys: 1 },
  { label: 'a date and no key: the row form AND the legacy form beside it', payload: { date: '2026-01-02' }, keys: 2 },
  { label: 'a key beats a date, and is then the only key', payload: { _idempotencyKey: 'K1', date: '2026-01-02' }, keys: 1 },
  { label: 'a NUMERIC _idempotencyKey is not a string, so it is not a key', payload: { _idempotencyKey: 77, date: '2026-01-03' }, keys: 2 },
  { label: 'a blank _idempotencyKey is not a key either', payload: { _idempotencyKey: '   ', date: '2026-01-04' }, keys: 2 },
  { label: 'a payload that is not a record at all reads as an empty one', payload: [1, 2], keys: 1 },

  // o3d-11rf r10 (Codex r10, HIGH) — THE SHAPES THIS BATTERY WAS MISSING, AND WHY IT MISSED THEM.
  //
  // Every case above spells "blank" with ORDINARY SPACES, which is the one whitespace character
  // `btrim(text)` happens to strip. So the battery agreed with a SQL derivation that agreed with
  // JavaScript on spaces alone. Each token below is BLANK to `.trim()` and NOT blank to `btrim`: the
  // statement used to read it as a PRESENT payload key, disable both fallback arms, and then
  // normalise the token itself away — deriving NO KEY AT ALL where TypeScript derives two, and
  // dropping a live row out of reconciliation entirely.
  //
  // Each carries a `date` as well, so both fallback forms are asserted: the row key AND the legacy
  // one, which is what Codex asked for by name.
  { label: 'a TAB-only _idempotencyKey is blank, so the row form and the legacy form both stand', payload: { _idempotencyKey: '\u0009', date: '2026-01-05' }, keys: 2 },
  { label: 'a NEWLINE-only one likewise', payload: { _idempotencyKey: '\u000a', date: '2026-01-06' }, keys: 2 },
  { label: 'a CARRIAGE RETURN, and the CRLF pair a pasted value carries', payload: { _idempotencyKey: '\u000d\u000a', date: '2026-01-07' }, keys: 2 },
  { label: 'a VERTICAL TAB and a FORM FEED', payload: { _idempotencyKey: '\u000b\u000c', date: '2026-01-08' }, keys: 2 },
  { label: 'a NON-BREAKING SPACE, which PostgreSQL\u2019s own ctype class does NOT call whitespace', payload: { _idempotencyKey: '\u00a0', date: '2026-01-09' }, keys: 2 },
  { label: 'a BYTE ORDER MARK, which JavaScript trims and Unicode does not call a space', payload: { _idempotencyKey: '\ufeff', date: '2026-01-10' }, keys: 2 },
  { label: 'an EN QUAD, a Unicode space separator', payload: { _idempotencyKey: '\u2000', date: '2026-01-11' }, keys: 2 },
  { label: 'a LINE SEPARATOR, which is a LineTerminator rather than a space', payload: { _idempotencyKey: '\u2028', date: '2026-01-12' }, keys: 2 },
  { label: 'an IDEOGRAPHIC SPACE', payload: { _idempotencyKey: '\u3000', date: '2026-01-13' }, keys: 2 },
  { label: 'a MIXED RUN of them, leading, trailing and in between', payload: { _idempotencyKey: '\u0009\u000a \u00a0\ufeff\u3000\u000d', date: '2026-01-14' }, keys: 2 },

  // THE OTHER HALF OF THE RULE, AND IT IS A DIFFERENT RULE. Trimming decides whether the token is
  // THERE; the normaliser then COLLAPSES every run of characters outside `[a-z0-9._:-]` to one `-`
  // wherever it sits. A token with whitespace in the middle is PRESENT, so the payload key is the
  // only key — and it is the collapsed form, which is what these two prove.
  { label: 'INTERIOR whitespace is collapsed, not trimmed: the token is present and is the only key', payload: { _idempotencyKey: 'Doc\u000943', date: '2026-01-15' }, keys: 1 },
  { label: 'LEADING and TRAILING whitespace around a real token comes off, and the token stays', payload: { _idempotencyKey: '\u00a0 Doc/44\u000a', date: '2026-01-16' }, keys: 1 },

  // A BLANK DATE, for completeness of the branch rather than for discrimination: this shape cannot
  // tell the two spellings apart, because a date that normalises away drops its key either way (the
  // legacy arm is enabled and then yields NULL). Stated so nobody reads it as evidence it is not.
  { label: 'a whitespace-only date is no date, so the row form stands alone', payload: { date: '\u000b' }, keys: 1 },
]

test('o3d-11rf r9: the SQL key derivation is the TypeScript one, branch for branch', { skip }, async () => {
  const run = randomUUID().slice(0, 8)

  // NOT VACUOUS: the battery must actually exercise the two-key case, or the legacy form is untested.
  assert.ok(PAYLOAD_SHAPES.some((shape) => shape.keys === 2), 'the battery covers a row with two keys')

  const expected: string[] = []
  const findings = await withRollback(async (tx) => {
    for (const [index, shape] of PAYLOAD_SHAPES.entries()) {
      const reference = `11rf9-k-${run}-o${index}`
      const rowId = `11rf9-k-${run}-s${index}`
      const keys = mirroredAccountingEventIdempotencyKeys({
        syncLogId: rowId,
        connector: 'xero',
        type: 'SALES_INVOICE',
        referenceType: 'SalesOrder',
        referenceId: reference,
        payload: shape.payload,
      })
      assert.equal(keys.length, shape.keys, `${shape.label} — the builder yields the stated number of keys`)

      await makeSyncLog(tx, { id: rowId, reference, status: 'PENDING', payload: shape.payload })
      for (const [k, key] of keys.entries()) {
        const eventId = `11rf9-k-${run}-e${index}-${k}`
        await makeEvent(tx, { id: eventId, reference, status: 'VOID', voidBasis: null, idempotencyKey: key })
        expected.push(eventId)
      }
      // The negative half: a sibling attempt's mirror, same document, same four columns, not owned.
      await makeEvent(tx, {
        id: `11rf9-k-${run}-e${index}-ghost`,
        reference,
        status: 'VOID',
        voidBasis: null,
        idempotencyKey: mirrorKeyFor({ syncLogId: `${rowId}-ghost`, referenceId: reference }),
      })
    }

    // A TYPE THAT IS NOT MIRRORED HAS NO MIRROR TO OWN. INVOICE_PAYMENT is a real sync type and it is
    // not in MIRRORED_ACCOUNTING_SYNC_TYPES, so the builder returns nothing for it and neither may the
    // join — even though an event sharing its four columns is sitting right there.
    const unmirroredRef = `11rf9-k-${run}-unmirrored`
    assert.deepEqual(
      mirroredAccountingEventIdempotencyKeys({
        syncLogId: `${unmirroredRef}-s`, connector: 'xero', type: 'INVOICE_PAYMENT',
        referenceType: 'SalesOrder', referenceId: unmirroredRef, payload: null,
      }),
      [], 'the builder mirrors nothing for an unmirrored type',
    )
    await makeSyncLog(tx, { id: `${unmirroredRef}-s`, reference: unmirroredRef, status: 'PENDING', type: 'INVOICE_PAYMENT' })
    await makeEvent(tx, {
      id: `${unmirroredRef}-e`, reference: unmirroredRef, status: 'VOID', voidBasis: null,
      type: 'INVOICE_PAYMENT', idempotencyKey: `accounting-sync-log:xero:${unmirroredRef}-s`,
    })

    // A KEY THE BUILDER CANNOT BUILD. Every part of '!!!' is stripped by the normaliser, so TypeScript
    // THROWS rather than returning a key; SQL yields no key instead, which is the safe direction and
    // the one deliberate divergence between the two. Either way this row owns nothing.
    //
    // o3d-11rf r10 — U+0085 NEL and U+200B ZWSP join it, and they are the NEAR MISSES rather than more
    // of the same. JavaScript does NOT trim either, so both are PRESENT tokens that normalise away,
    // exactly like '!!!'. They are what separates the blank test the statement now asks from the two
    // plausible wrong ones: PostgreSQL's ctype-driven `[[:space:]]` calls NEL whitespace, and a
    // `btrim(v, characters)` set built from the trimmable characters holds the bytes C2 and 85, so it
    // eats NEL outright — every database in this estate being SQL_ASCII, where character operations
    // are byte operations. Either mistake reads these rows as having no payload key, falls through to
    // the row form, and reports the fallthrough event below.
    const unbuildable = [
      { suffix: 'junk', token: '!!!' },
      { suffix: 'nel', token: '\u0085' },
      { suffix: 'zwsp', token: '\u200b' },
    ]
    for (const [index, { suffix, token }] of unbuildable.entries()) {
      const junkRef = `11rf9-k-${run}-${suffix}`
      assert.throws(() => mirroredAccountingEventIdempotencyKeys({
        syncLogId: `${junkRef}-s`, connector: 'xero', type: 'SALES_INVOICE',
        referenceType: 'SalesOrder', referenceId: junkRef, payload: { _idempotencyKey: token },
      }), /must not be blank/, `a part that normalises away is refused, not silently skipped (${suffix})`)
      // AND IT IS REFUSED FOR THE RIGHT REASON: the token is PRESENT and normalises to nothing, not
      // absent. Without this the NEL and ZWSP rows would prove nothing that '!!!' does not.
      assert.notEqual(token.trim(), '', `${suffix} is not blank to JavaScript — which is what makes it a near miss`)
      await makeSyncLog(tx, { id: `${junkRef}-s`, reference: junkRef, status: 'PENDING', payload: { _idempotencyKey: token } })
      // The two keys a WRONG derivation would reach for, sitting in the row's own scope so that
      // either mistake is a reported finding rather than a silent difference:
      //   • the empty-part key, which is what dropping the blank-part guard produces;
      //   • the sync-log id key, which is what branching on the NORMALISED payload key rather than on
      //     the raw one produces — and what reading the token as BLANK produces too.
      // The builder above throws for every one of these rows, so the right answer is that they own
      // neither. The empty-part key is written once because it has no scope in it to differ by, and
      // `accounting_events.idempotencyKey` is UNIQUE.
      if (index === 0) {
        await makeEvent(tx, {
          id: `${junkRef}-e-empty`, reference: junkRef, status: 'VOID', voidBasis: null,
          idempotencyKey: 'accounting-sync:xero:sales_invoice:',
        })
      }
      await makeEvent(tx, {
        id: `${junkRef}-e-fallthrough`, reference: junkRef, status: 'VOID', voidBasis: null,
        idempotencyKey: `accounting-sync-log:xero:${junkRef}-s`,
      })
    }

    return (await reportFindings(tx)).findings
  })

  assert.deepEqual(
    findings.filter((f) => f.code === CONTRADICTION).map((f) => f.accountingEventId).sort(),
    [...expected].sort(),
    'every key the builder derives is joined on, no key it does not derive is, and the two unbuildable '
    + 'rows own nothing',
  )
})

/**
 * o3d-11rf r10 (Codex r10, HIGH) — THE DECISIVE CASE, AND IT CANNOT BE SEEN FROM TYPESCRIPT.
 *
 * `stringValue` asks JavaScript `.trim()`; the statement asked PostgreSQL `btrim(text)`, which strips
 * ORDINARY SPACES AND NOTHING ELSE. So `_idempotencyKey: "\t"` was ABSENT to TypeScript and PRESENT to
 * SQL. TypeScript fell through to the row key with the legacy date key beside it; SQL took the payload
 * branch, disabled both fallback arms, and then normalised the tab away to NULL — so the row derived
 * NO KEY AT ALL and its unexplained VOID mirror vanished from the report.
 *
 * COMPARING TWO STRINGS IN NODE COULD NOT HAVE SHOWN THIS. The second derivation is a SQL statement,
 * and what it does with a tab is a fact about PostgreSQL. So both sides are asserted here: the keys
 * the production TypeScript function returns, and the events the production statement reports for a
 * row carrying exactly that payload.
 *
 * IT ASSERTS ITS OWN PRECONDITION by running BOTH spellings of "blank" against the token, in the
 * database, and showing they disagree. Without that this fixture might never have reached the defect.
 */
test('o3d-11rf r10: a TAB _idempotencyKey derives the SAME keys in SQL as in TypeScript', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const reference = `11rf10-${run}-o`
  const rowId = `11rf10-${run}-s`
  const payload = { _idempotencyKey: '\u0009', date: '2026-02-03' }

  // THE TYPESCRIPT SIDE, from the production function and spelled out so a drift in either is loud.
  const keys = mirroredAccountingEventIdempotencyKeys({
    syncLogId: rowId,
    connector: 'xero',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: reference,
    payload,
  })
  assert.deepEqual(keys, [
    `accounting-sync-log:xero:${rowId}`,
    `accounting-sync:xero:sales_invoice:salesorder:${reference}:2026-02-03`,
  ], 'a tab is blank to .trim(), so the token is absent and BOTH fallback forms stand')

  const { findings, blankness } = await withRollback(async (tx) => {
    // THE PRECONDITION: the two spellings really do disagree about this token.
    const [row] = await tx.$queryRaw`
      SELECT btrim(${payload._idempotencyKey}::text) = '' AS "blankToBtrim",
             ${payload._idempotencyKey}::text ~ ${ECMASCRIPT_BLANK_PATTERN} AS "blankToJavaScript"
    ` as Array<{ blankToBtrim: boolean; blankToJavaScript: boolean }>

    await makeSyncLog(tx, { id: rowId, reference, status: 'PENDING', payload })
    for (const [n, key] of keys.entries()) {
      await makeEvent(tx, {
        id: `11rf10-${run}-e${n}`, reference, status: 'VOID', voidBasis: null, idempotencyKey: key,
      })
    }
    return { findings: (await reportFindings(tx)).findings, blankness: row }
  })

  assert.equal(blankness.blankToBtrim, false,
    'btrim(text) reads a lone tab as a PRESENT token — the defect, stated as a fact about this fixture')
  assert.equal(blankness.blankToJavaScript, true, 'and the statement now reads it the way .trim() does')

  assert.deepEqual(
    findings.filter((f) => f.code === CONTRADICTION).map((f) => f.accountingEventId).sort(),
    [`11rf10-${run}-e0`, `11rf10-${run}-e1`],
    'SQL derives the same two keys TypeScript does; before r10 it derived none and both rows vanished',
  )
})

/**
 * o3d-11rf r10 — THE WHOLE SET, AND THE NEAR MISSES EITHER SIDE OF IT.
 *
 * The lesson of r10 is that a parity battery proves parity only over the shapes it contains, so this
 * one does not choose shapes at all: it takes EVERY character `String.prototype.trim` strips, from the
 * running engine, and asks PostgreSQL about each one — as raw text and through a jsonb round trip,
 * because the production predicate reads its value out of a jsonb payload.
 *
 * THE DECOYS ARE THE POINT AS MUCH AS THE SET IS. U+0085 NEL and U+200B ZWSP are NOT trimmed by
 * JavaScript, and U+201A is an ordinary punctuation mark. Each is a character one of the plausible
 * wrong spellings gets wrong: `[[:space:]]` calls NEL whitespace, and `btrim(v, characters)` — the
 * obvious fix — chews all three, because every database in this estate is SQL_ASCII and its character
 * sets are BYTE sets. That is why the predicate is an alternation of whole characters.
 */
test('o3d-11rf r10: PostgreSQL agrees with JavaScript trim() on every character, and on the near misses', { skip }, async () => {
  const trimmable: string[] = []
  for (let point = 0; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue
    const character = String.fromCodePoint(point)
    if (character.trim() === '') trimmable.push(character)
  }
  assert.ok(trimmable.length > 6, 'the trimmable set reaches well past the ASCII controls')

  const decoys = [
    '\u0085', '\u200b', '\u201a', '\u180e', '!!!', 'a b', 'x', ' x ', '\u3000x', '',
    '\u0009\u000a\u00a0\ufeff', ' \u0009 ',
  ]
  const cases = [...trimmable, ...decoys]

  const observed = await withRollback(async (tx) => await tx.$queryRaw`
    SELECT v,
           (v ~ ${ECMASCRIPT_BLANK_PATTERN}) AS "blankAsText",
           ((jsonb_build_object('_idempotencyKey', v) ->> '_idempotencyKey') ~ ${ECMASCRIPT_BLANK_PATTERN})
             AS "blankViaJsonb",
           ((jsonb_build_object('_idempotencyKey', v) ->> '_idempotencyKey') IS NOT DISTINCT FROM v)
             AS "survivesJsonb",
           (btrim(v) = '') AS "blankToBtrim"
    FROM unnest(${cases}::text[]) AS v
  ` as Array<{ v: string; blankAsText: boolean; blankViaJsonb: boolean; survivesJsonb: boolean; blankToBtrim: boolean }>)

  assert.equal(observed.length, cases.length, 'every case came back')
  const disagreements = observed
    .filter((row) => {
      const blankToJavaScript = row.v.trim() === ''
      return row.blankAsText !== blankToJavaScript || row.blankViaJsonb !== blankToJavaScript || !row.survivesJsonb
    })
    .map((row) => JSON.stringify(row.v))
  assert.deepEqual(disagreements, [],
    'PostgreSQL and JavaScript agree on every one, through jsonb as well as raw text')

  // NOT VACUOUS. The spelling this replaced disagrees with JavaScript on most of these, so a fixture
  // that had reached none of them would show up here as a number that is too small.
  const btrimWrong = observed.filter((row) => row.blankToBtrim !== (row.v.trim() === ''))
  assert.ok(btrimWrong.length >= 20,
    `btrim(text) is wrong on ${btrimWrong.length} of these — the battery really does reach the defect`)
  assert.ok(btrimWrong.some((row) => row.v === '\u0009'), 'a lone tab among them, the character Codex named')
})

test('o3d-11rf r4: the probes left the database as they found it', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db')
  const survivors = await db.accountingEvent.count({ where: { id: { startsWith: '11rf4-' } } })
  assert.equal(survivors, 0, 'every probe above rolled back')
  const r5Survivors = await db.accountingEvent.count({ where: { id: { startsWith: '11rf5-' } } })
  assert.equal(r5Survivors, 0, 'the persistence probe too')
  const r9Survivors = await db.accountingEvent.count({ where: { id: { startsWith: '11rf9-' } } })
  assert.equal(r9Survivors, 0, 'and the ownership probes')
  const r9Rows = await db.accountingSyncLog.count({ where: { id: { startsWith: '11rf9-' } } })
  assert.equal(r9Rows, 0, 'sync rows included — these fixtures write both sides')
  const r10Survivors = await db.accountingEvent.count({ where: { id: { startsWith: '11rf10-' } } })
  assert.equal(r10Survivors, 0, 'and the r10 whitespace probes')
  const r10Rows = await db.accountingSyncLog.count({ where: { id: { startsWith: '11rf10-' } } })
  assert.equal(r10Rows, 0, 'both sides of those too')
})
