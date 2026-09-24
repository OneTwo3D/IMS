import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-c08y round 2, Codex HIGH — GROUP B POSTED FROM A SNAPSHOT IT READ BEFORE IT TOOK THE LOCK.
 *
 * MEASURED FIRST on a scratch database (probe kept outside the repository at
 * /var/tmp/ims-session-park-20260913/c08y2-probe/race.ts; own throwaway database, network trapped,
 * zero outbound calls). One unit bought at 4.00, shipped and
 * NOT yet journaled — the case the o3d-c08y refusal deliberately permits to go negative, because the
 * daily batch was supposed to refuse it (o3d-sidy). A landed-cost revaluation applying a -10.00 credit
 * freight line was held open in its own transaction; the batch started, read the window, and parked at
 *
 *     Lock: SELECT id FROM "cost_layers" WHERE id IN ($1) FOR UPDATE      <- from pg_stat_activity
 *
 * The revaluation then committed layer -6.00, snapshot -6.00 and `cogsBatchAmount` -6.00. The batch
 * woke up, computed from its STALE POSITIVE copy and:
 *   - queued DAILY_BATCH_GROUP_B with COGS DR 500 / CR 631 £4.00,
 *   - stamped `shipmentJournalDate` and `allocatedReliefAmount` 4.00,
 *   - wrote `cogsBatchAmount` BACK to 4.00 over the revaluation's -6.00,
 *   - wrote a DISPATCH subledger row of 4.00,
 *   - and reported no error at all: `result.errors` was `[]`.
 * The recalc had already subtracted the whole -10.00 as "shipment-owned", so it posted NOWHERE.
 * `FOR UPDATE` re-reads the row it locks, but Group B selected only `id`.
 *
 * THIS FILE drives the REAL `runDailyBatchSync` for BOTH connectors against doubles, and expresses the
 * interleaving exactly where it happens: the double flips its stored snapshot from +4.00 to -6.00 WHEN
 * THE COST-LAYER LOCK STATEMENT IS ISSUED — i.e. it models the revaluation committing while the batch
 * waits on that lock, which is what was observed. A batch that reads before locking therefore sees
 * +4.00 and a batch that reads after locking sees -6.00, and the two are distinguishable in the
 * journal it writes.
 *
 * It is a WIRING test as well as a behaviour one: the probe/lock/read helper proves nothing unless both
 * batches call it in that order, and a unit test of the helper alone would have passed throughout the
 * whole period this defect existed. The ORDER of the three statements is asserted, not just that they
 * all happened.
 */

const LAYER = 'cl-race'
const SHIPMENT = 'ship-race'
const ORDER = 'order-race'

const world = {
  /** Does the revaluation commit while the batch is parked on the cost-layer lock? */
  commitsAtLock: true,
  /**
   * Instead of a new COST, the post-lock read returns a new LAYER ID — i.e. a snapshot referencing a
   * cost layer the probe never named and the lock therefore never covered. That is the one way the
   * reload could still be computing from something a revaluation can move, and it is what the closure
   * check exists to catch.
   */
  escapeAtLock: false,
  /** Has it committed yet, as far as any read is concerned? */
  committed: false,
  /** Every read/lock the transaction issued, IN ORDER. */
  events: [] as string[],
  created: [] as Array<{ type: string; payload: Record<string, unknown> }>,
  shipmentUpdates: [] as Array<{ id: string; data: Record<string, unknown> }>,
  cogsMovements: [] as Array<{ sourceRef: string; baseDelta: unknown }>,
  activity: [] as Array<Record<string, unknown>>,
  rawStatements: [] as string[],
}

function reset(over: { commitsAtLock?: boolean; escapeAtLock?: boolean } = {}) {
  world.commitsAtLock = over.commitsAtLock ?? true
  world.escapeAtLock = over.escapeAtLock ?? false
  world.committed = false
  world.events = []
  world.created = []
  world.shipmentUpdates = []
  world.cogsMovements = []
  world.activity = []
  world.rawStatements = []
}

/** The one shipment, valued at whatever is committed RIGHT NOW. */
function shipmentRow() {
  const negative = world.committed && !world.escapeAtLock
  const unitCostBase = negative ? '-6.000000' : '4.000000'
  const cogsBatchAmount = negative ? -6 : 4
  const costLayerId = world.committed && world.escapeAtLock ? 'cl-escaped' : LAYER
  return {
    id: SHIPMENT,
    orderId: ORDER,
    warehouseId: 'wh-1',
    createdAt: new Date('2026-09-24T08:00:00.000Z'),
    cogsBatchAmount,
    lines: [{
      id: `sl-${SHIPMENT}`,
      lineId: 'line-race',
      productId: 'prod-1',
      qty: 1,
      costLayerSnapshot: [{ costLayerId, qty: '1.000000', unitCostBase }],
      line: { id: 'line-race', productId: 'prod-1', qty: 1, totalBase: 10 },
    }],
    order: {
      orderNumber: 'SO-race',
      externalOrderNumber: null,
      status: 'PICKING',
      refundStatus: 'NONE',
      totalBase: 10,
      unearnedRevenueAmount: 10,
      lines: [{ id: 'line-race', productId: 'prod-1', qty: 1, totalBase: 10, fulfillmentRequirements: null }],
      shipments: [{ id: SHIPMENT, status: 'SHIPPED', shipmentJournalDate: null, revenueRecognizedAmount: null }],
    },
  }
}

const tx = {
  // The lock. THE STATEMENT is recorded, not merely that some raw query happened, and the flip is tied
  // to the cost-layer lock specifically — the point in the real run where the batch waited.
  $queryRaw: async (...args: unknown[]) => {
    const statement = (args[0] as { sql?: string; text?: string; strings?: string[] } | undefined) ?? {}
    const sql = statement.sql ?? statement.text ?? (statement.strings ?? []).join('?')
    world.rawStatements.push(sql)
    if (/cost_layers/.test(sql) && /FOR UPDATE/.test(sql)) {
      world.events.push('lock-cost-layers')
      if (world.commitsAtLock) world.committed = true
    }
    return []
  },
  shipment: {
    // The PROBE asks for the window by its selection clause; the REAL READ asks for named ids. That is
    // the only difference in the where, and it is the discriminator (the same one the A1 fence double
    // uses). Both are answered from the same world, so what distinguishes them is WHEN they run.
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      world.events.push(where && 'id' in where ? 'read-window' : 'probe-window')
      return [shipmentRow()]
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      world.shipmentUpdates.push({ id: where.id, data })
      return { id: where.id }
    },
  },
  orderAllocation: { findMany: async () => [], update: async () => ({}) },
  shipmentLine: { findMany: async () => [], update: async () => ({}) },
  salesOrderRefundLine: { findMany: async () => [] },
  salesOrderRefund: { findMany: async () => [] },
  salesOrder: { findMany: async () => [], update: async () => ({}) },
  costLayer: { update: async () => ({}) },
  accountingSyncLog: {
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
    create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => {
      world.created.push({ type: data.type, payload: data.payload })
      return { id: `log-${world.created.length}` }
    },
  },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      salesOrder: { findMany: async () => [] },
      shipment: { findMany: async () => [] },
      accountingSyncLog: { count: async () => 0, findMany: async () => [] },
      accountingToken: { findUnique: async () => ({ tenantId: 'tenant-A' }) },
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    },
  },
})
mock.module('@/lib/db/pinned-advisory-lock', {
  namedExports: {
    acquirePinnedAdvisoryLockOrNull: async () => ({ assertHeld: () => undefined, release: async () => undefined }),
  },
})
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_sync_enabled: 'true',
      xero_sales_account: '200',
      xero_unearned_revenue_account: '830',
      xero_inventory_account: '630',
      xero_allocated_inventory_account: '631',
      xero_cogs_account: '310',
      xero_rounding_difference_account: '',
      xero_transit_account: '',
    }),
  },
})
mock.module('@/lib/connectors/quickbooks/settings', {
  namedExports: {
    getQuickBooksSettings: async () => ({
      quickbooks_sync_enabled: 'true',
      quickbooks_sales_account: '200',
      quickbooks_unearned_revenue_account: '830',
      quickbooks_inventory_account: '630',
      quickbooks_allocated_inventory_account: '631',
      quickbooks_cogs_account: '310',
    }),
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (params: Record<string, unknown>) => { world.activity.push(params) } },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    mirrorAccountingSyncLogToEvent: async () => undefined,
    resetMirroredAccountingEventsToPending: async () => undefined,
    updateMirroredAccountingEventStatus: async () => undefined,
  },
})
mock.module('@/lib/connectors/xero/outbox', { namedExports: { scheduleXeroAccountingOutbox: async () => undefined } })
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async () => ({}),
    expandFulfillmentRequirementsDecimal: (productId: string) => new Map([[productId, 1]]),
  },
})
for (const path of [
  '@/lib/domain/accounting/inventory-gl-reconciliation',
  '@/lib/domain/accounting/cogs-gl-reconciliation',
  '@/lib/domain/accounting/transit-gl-reconciliation',
]) {
  const build = path.includes('inventory') ? 'buildInventoryReconciliationSweepJournal'
    : path.includes('cogs') ? 'buildCogsReconciliationSweepJournal' : 'buildTransitReconciliationSweepJournal'
  const load = path.includes('inventory') ? 'loadInventoryGlReconciliation'
    : path.includes('cogs') ? 'loadCogsGlReconciliation' : 'loadTransitGlReconciliation'
  mock.module(path, { namedExports: { [load]: async () => null, [build]: () => null } })
}
mock.module('@/lib/domain/accounting/cogs-subledger-movement', {
  namedExports: {
    recordCogsSubledgerMovement: async (_client: unknown, args: { sourceRef: string; baseDelta: unknown }) => {
      world.cogsMovements.push({ sourceRef: args.sourceRef, baseDelta: args.baseDelta })
    },
  },
})

// Both connectors run the ordering and stale-value tests; what they do with the reloaded NEGATIVE
// basis differs, so that is asserted per connector below rather than parameterised here.
const CONNECTORS = [
  { name: 'xero', load: () => import('@/lib/connectors/xero/daily-sync') },
  { name: 'quickbooks', load: () => import('@/lib/connectors/quickbooks/daily-sync') },
] as const

type JournalLine = { accountCode: string; debit?: number; credit?: number }
const groupB = () => world.created.filter((entry) => entry.type === 'DAILY_BATCH_GROUP_B')
const linesOf = (entry: { payload: Record<string, unknown> }) => (entry.payload.lines ?? []) as JournalLine[]
const cogsDebit = () => groupB().flatMap(linesOf).filter((line) => line.accountCode === '310' && line.debit !== undefined)

for (const connector of CONNECTORS) {
  test(`${connector.name} Group B reads the shipment window UNDER the cost-layer lock, not before it`, async () => {
    reset()
    const { runDailyBatchSync } = await connector.load()

    await runDailyBatchSync()

    // The whole fix, as an order: the first three things Group B does to this window.
    assert.deepEqual(
      world.events.slice(0, 3),
      ['probe-window', 'lock-cost-layers', 'read-window'],
      `Group B must probe, lock, then read: ${JSON.stringify(world.events)}`,
    )
    assert.ok(
      world.rawStatements.some((sql) => /cost_layers/.test(sql) && /ORDER BY id/.test(sql) && /FOR UPDATE/.test(sql)),
      `PRECONDITION: the cost-layer lock was taken, in id order: ${JSON.stringify(world.rawStatements)}`,
    )
    assert.equal(world.committed, true, 'PRECONDITION: the revaluation committed during the lock, as measured')
  })

  test(`${connector.name} Group B never posts the STALE positive COGS it read before the lock`, async () => {
    reset()
    const { runDailyBatchSync } = await connector.load()

    await runDailyBatchSync()

    assert.deepEqual(
      cogsDebit(), [],
      'the 4.00 COGS debit read before the lock must not reach a journal — the committed basis is -6.00 '
      + `(o3d-c08y r2): ${JSON.stringify(world.created)}`,
    )
    assert.equal(
      world.shipmentUpdates.some((update) => Number(update.data.cogsBatchAmount) === 4), false,
      'and the stale 4.00 must not be written back over the revaluation\'s -6.00',
    )
    assert.deepEqual(
      world.cogsMovements.filter((movement) => Number(movement.baseDelta) === 4), [],
      'and no 4.00 DISPATCH row may reach the COGS subledger',
    )
  })

  test(`${connector.name} POSITIVE CONTROL: with no revaluation in the window the batch posts the 4.00 as usual`, async () => {
    // Without this, "no 4.00 was posted" above is indistinguishable from a rig that posts nothing at
    // all, and a batch that had stopped working entirely would pass it.
    reset({ commitsAtLock: false })
    const { runDailyBatchSync } = await connector.load()

    await runDailyBatchSync()

    assert.equal(world.committed, false, 'PRECONDITION: nothing revalued in this run')
    assert.deepEqual(cogsDebit().map((line) => line.debit), [4], `COGS 4.00 is posted: ${JSON.stringify(world.created)}`)
    assert.ok(
      world.shipmentUpdates.some((update) => update.id === SHIPMENT && update.data.shipmentJournalDate !== undefined),
      'and the shipment is journaled',
    )
  })
}

test('xero Group B REFUSES the order on the reloaded negative basis: nothing stamped, named in the errors and in an ERROR entry', async () => {
  // The o3d-sidy refusal, reached for the first time by this interleaving. Per order, nothing stamped,
  // so a corrected basis flows through the next batch.
  reset()
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')

  const result = await runDailyBatchSync()

  const refusals = result.errors.filter((error) => error.startsWith('Group B order SO-race:') && /negative/i.test(error))
  assert.equal(refusals.length, 1, `the order is refused by name: ${JSON.stringify(result.errors)}`)
  assert.match(refusals[0], new RegExp(LAYER), 'naming the cost layer whose basis is negative')
  assert.match(refusals[0], /-6\.00/, 'and the COGS it would have posted')
  assert.equal(
    world.shipmentUpdates.some((update) => update.data.shipmentJournalDate !== undefined), false,
    'the shipment is NOT stamped journaled, so the next run retries it once the basis is corrected',
  )
  assert.deepEqual(groupB(), [], 'and no Group B journal was written for it')
  assert.deepEqual(world.cogsMovements, [], 'and no COGS subledger dispatch was recorded')
  const logged = world.activity.filter((entry) => entry.action === 'daily_batch_negative_cost_basis_refused')
  assert.equal(logged.length, 1, 'one ERROR activity entry for the refusal')
  assert.equal(logged[0].level, 'ERROR')
})

test('quickbooks RESIDUAL, recorded rather than implied: it reloads the committed basis but has no negative-basis refusal', async () => {
  // o3d-sidy added the negative-basis refusals to the XERO batch only; the QuickBooks batch still drops
  // a negative COGS pair under its `> 0` gate (docs/todo/negative-basis-cost-layers-decision.md item
  // (e)) and stamps the shipment anyway (item (f)). This round did not change that — it is deliberately
  // out of scope (QuickBooks is not taking new work) — and this test pins what QuickBooks DOES now do,
  // so the gap is a recorded expectation instead of a surprise: it posts the committed -6.00 basis
  // (i.e. no COGS line), never the stale +4.00.
  reset()
  const { runDailyBatchSync } = await import('@/lib/connectors/quickbooks/daily-sync')

  const result = await runDailyBatchSync()

  assert.deepEqual(result.errors, [], 'QuickBooks raises no refusal today — the gap this test records')
  const [journal] = groupB()
  assert.ok(journal, 'it still writes its batch journal')
  assert.match(String(journal.payload.narration), /COGS £-6\.00/, 'from the RELOADED basis, not the stale 4.00')
  assert.deepEqual(cogsDebit(), [], 'with the negative COGS pair dropped by its `> 0` gate (decision-doc item (e))')
})

for (const connector of CONNECTORS) {
  test(`${connector.name} Group B refuses the window when the reloaded data references a cost layer it did not lock`, async () => {
    // The WIRING of the closure check, not the function: removing the assertion from the batch leaves the
    // helper's own unit tests green, and this is what notices. A post-lock read naming an unlocked layer
    // is the one remaining way the reload could still be reading something a revaluation can move.
    reset({ escapeAtLock: true })
    const { runDailyBatchSync } = await connector.load()

    const result = await runDailyBatchSync()

    assert.ok(
      result.errors.some((error) => /cl-escaped/.test(error) && /did not lock/.test(error)),
      `the window is refused, naming the escaped layer: ${JSON.stringify(result.errors)}`,
    )
    assert.deepEqual(groupB(), [], 'and nothing was journaled from it')
    assert.deepEqual(world.shipmentUpdates, [], 'and no shipment was stamped')
  })
}

// ---------------------------------------------------------------------------
// THE CLOSURE CHECK. The reload is only sound if everything Group B computes from is inside the locked
// set; the argument for that is in the helper's module comment, and this is the assertion that makes it
// load-bearing instead of a comment.
// ---------------------------------------------------------------------------

test('o3d-c08y r2: a snapshot referencing an UNLOCKED cost layer refuses the window by name', async () => {
  const { assertGroupBSnapshotsWereLocked, UnlockedCostLayerError } =
    await import('@/lib/domain/accounting/daily-batch-group-b-lock')

  assert.throws(
    () => assertGroupBSnapshotsWereLocked(new Set(['cl-locked']), [
      { what: 'the shipment lines it would post', rows: [
        { costLayerSnapshot: [{ costLayerId: 'cl-locked', qty: '1.000000', unitCostBase: '4.000000' }] },
        { costLayerSnapshot: [{ costLayerId: 'cl-escaped', qty: '1.000000', unitCostBase: '4.000000' }] },
      ] },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof UnlockedCostLayerError, `wrong error: ${String(error)}`)
      assert.deepEqual(error.costLayerIds, ['cl-escaped'], 'naming only the id that escaped the lock')
      assert.match(error.message, /the shipment lines it would post/, 'and where it came from')
      return true
    },
  )
})

test('o3d-c08y r2: POSITIVE CONTROL — a fully covered window passes the closure check', async () => {
  const { assertGroupBSnapshotsWereLocked } = await import('@/lib/domain/accounting/daily-batch-group-b-lock')
  assertGroupBSnapshotsWereLocked(new Set(['cl-a', 'cl-b']), [
    { what: 'the shipment lines it would post', rows: [
      { costLayerSnapshot: [{ costLayerId: 'cl-a', qty: '1.000000', unitCostBase: '4.000000' }] },
    ] },
    { what: 'the order allocations it would consume from', rows: [
      { costLayerSnapshot: [{ costLayerId: 'cl-b', qty: '1.000000', unitCostBase: '4.000000' }] },
      { costLayerSnapshot: null },
    ] },
  ])
})
