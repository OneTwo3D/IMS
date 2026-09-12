import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'

/**
 * o3d-i0o6 r8 (Codex round 7, HIGH) — A CONNECTOR SWITCH CANNOT COMMIT BETWEEN THE PINNED-LEDGER
 * CHECK AND THE QUEUE INSERT. PROVED BY RACING IT, NOT BY MODELLING IT.
 *
 * WHY A REAL DATABASE IS THE ONLY WITNESS HERE. Round 7 added the rule — a credit is only queued to a
 * ledger something still drains — and enforced it with an UNLOCKED read taken several awaits before
 * the INSERT. Its tests reached the race with an `activeConnectorSwitchesAfterNextReadTo` helper that
 * MODELS the window: the double moves the setting after the next read, which is a faithful picture of
 * the interleaving and says nothing whatever about whether a lock prevents it. A modelled window
 * passes for a fix that holds no lock at all, which is exactly how HIGH 1 survived round 6 and how
 * round 7's own gap survived into round 7's tests. The property being claimed now — "no other
 * transaction can commit a change to the plugin selection rows while this enqueue's transaction is
 * open" — is a PostgreSQL property of `pg_advisory_xact_lock` and `SELECT ... FOR UPDATE`. No double
 * can exhibit it and no double can fail to exhibit it.
 *
 * SO THE FENCE IS MEASURED, NOT ARGUED. Every test below races a real pinned enqueue against a real
 * connector switch — the switch taken through `lockIntegrationPluginSelection`, the same helper
 * app/actions/settings.ts and onboarding take — and asserts on the ORDER the two were forced into,
 * timed. An unfenced enqueue does not block the switch and is not blocked by it, so the timings
 * separate the two states by hundreds of milliseconds rather than by a verdict a fixture supplied.
 *
 * THE CONTROL IS LOAD-BEARING. Test 2 runs the identical race with an UNPINNED enqueue, where no
 * fence is taken by design, and asserts the switch is NOT blocked. Without it, "the switch waited"
 * would be reassuring and unfalsifiable — it could be waiting on the follow-up scope lock, on the
 * order lock, on the connection pool, or on nothing at all.
 *
 * o3d-i0o6 r9 (Codex round 8, HIGH) — TESTS 4 AND 5 RACE THE GATE ROUND 8 LEFT IN FRONT OF THE
 * FENCE. Tests 1-3 all run with the connector's own `*_sync_enabled` ON, deliberately, so that a
 * refusal can only have come from the fence. That choice also meant none of them could reach the
 * state where the queue answered from its own toggle read BEFORE opening the fenced transaction —
 * `not-configured`, which is the one no-op the refund obligation ledger may settle an obligation
 * with. Test 4 is test 3's race with `xero_sync_enabled` set to `'false'` first, and test 5 is its
 * uncontended control.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
/**
 * How long the enqueue holds its transaction open after its INSERT (test 1), or the switch holds the
 * selection (test 3). Long enough that "was the other side blocked for the whole of it" is not a
 * scheduling coincidence.
 */
const HOLD_MS = 500
/** Slack for scheduler jitter on the blocked side's own wake-up. */
const SLACK_MS = 100
const TX = { timeout: 30_000, maxWait: 20_000 }

function loadEnv(): void {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-i0o6 r8 concurrency test requires a Postgres DATABASE_URL')
  }
}

async function loadDeps() {
  loadEnv()
  const [{ db }, accounting, lock] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/accounting.ts'),
    import('../../lib/integration-plugin-selection-lock.ts'),
  ])
  return {
    db,
    queueAccountingSync: accounting.queueAccountingSync,
    queueAccountingSyncTx: accounting.queueAccountingSyncTx,
    lockIntegrationPluginSelection: lock.lockIntegrationPluginSelection,
  }
}

type Db = Awaited<ReturnType<typeof loadDeps>>['db']

const probeId = (label: string) => `I0O6R8-${label}-${process.pid}-${randomUUID()}`

/**
 * Xero active, Xero's own sync toggle ON.
 *
 * The toggle matters: it is the SEPARATE setting a plugin switch does not touch, and the whole of
 * round 7's HIGH was that passing it is not licence to write. Left on here so a refusal below can
 * only have come from the fence, never from `xero_sync_enabled`.
 *
 * ALLOCATION_REVERSAL and UNEARNED_REV_REVERSAL are in neither connector's per-type setting map, so
 * their posting mode is the unconditional 'submitted' — nothing else to switch on.
 */
async function startFromXeroActive(db: Db): Promise<void> {
  for (const [key, value] of [
    [INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true'],
    [INTEGRATION_PLUGIN_SETTING_KEYS.quickbooks, 'false'],
    ['xero_sync_enabled', 'true'],
    ['quickbooks_sync_enabled', 'true'],
  ] as Array<[string, string]>) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
}

/**
 * The switch, taken exactly as the app takes it: the selection lock FIRST, then the write.
 *
 * `holdMs` keeps the transaction open AFTER the write so the other side can be observed waiting on
 * it. Returns how long the whole transaction took, which is the measurement.
 */
async function switchToQuickBooks(
  db: Db,
  lockIntegrationPluginSelection: Awaited<ReturnType<typeof loadDeps>>['lockIntegrationPluginSelection'],
  options: { holdMs?: number; onLockHeld?: () => void } = {},
): Promise<number> {
  const startedAt = Date.now()
  await db.$transaction(async (tx) => {
    await lockIntegrationPluginSelection(tx)
    options.onLockHeld?.()
    for (const [key, value] of [
      [INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'false'],
      [INTEGRATION_PLUGIN_SETTING_KEYS.quickbooks, 'true'],
    ] as Array<[string, string]>) {
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    if (options.holdMs) await new Promise((resolve) => setTimeout(resolve, options.holdMs))
  }, TX)
  return Date.now() - startedAt
}

/** One setting row, for the tests that need a toggle the plugin switch does not touch. */
async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

/** `CogsEntry` is not an order-scoped reference type, so no hoisted sales-order row lock is needed. */
const REFERENCE_TYPE = 'CogsEntry'

function payloadFor(referenceId: string) {
  return {
    narration: `o3d-i0o6 r8 pinned-ledger fence probe ${referenceId}`,
    lines: [
      { description: 'Inventory', accountCode: '630', debit: 16 },
      { description: 'Allocated Inventory', accountCode: '631', credit: 16 },
    ],
  }
}

function cleanup(db: Db, referenceId: string): () => Promise<void> {
  return async () => {
    const rows = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { id: true } })
    for (const row of rows) {
      // No FK: the outbox row is keyed on the sync log id inside its idempotency key.
      await db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: row.id } } }).catch(() => undefined)
    }
    await db.accountingEvent.deleteMany({ where: { sourceEntityId: referenceId } }).catch(() => undefined)
    await db.accountingSyncLog.deleteMany({ where: { referenceId } })
  }
}

test(
  '[o3d-i0o6 r8] a connector switch CANNOT commit while a pinned enqueue that has inserted is still open',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, queueAccountingSyncTx, lockIntegrationPluginSelection } = await loadDeps()
    await startFromXeroActive(db)
    const referenceId = probeId('tx-pinned')
    t.after(cleanup(db, referenceId))
    t.after(() => startFromXeroActive(db))

    /**
     * THE INTERLEAVING, and why this direction is the one that proves the HIGH.
     *
     * The enqueue goes first and INSERTS. Its transaction then stays open for HOLD_MS before
     * committing. If the selection lock is genuinely held by that transaction, the switch — which
     * takes the same lock and the same rows — cannot commit until the insert is durable. So the
     * question "could a switch have landed between the check and the write" is answered by measuring
     * whether the switch was able to land at all while the writing transaction lived.
     *
     * Under round 7's unlocked check the enqueue takes no plugin lock, the switch commits in a few
     * milliseconds, and the assertion below fails by ~400ms.
     */
    let queued: boolean | null = null
    const signal: { fire?: () => void } = {}
    const enqueueHasInserted = new Promise<void>((resolve) => { signal.fire = resolve })

    const enqueue = db.$transaction(async (tx) => {
      queued = await queueAccountingSyncTx(tx, {
        type: 'ALLOCATION_REVERSAL',
        connector: 'xero',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: payloadFor(referenceId),
        // o3d-j625 r2: required now. Every test here starts from XERO ACTIVE, so the pooled chart check
        // passes and the refusal under test is still the LOCKED fence's.
        chartConnector: 'xero',
      })
      signal.fire!()
      // Held open, so the switch is demonstrably parked rather than merely losing a coin toss.
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    }, TX)

    const switcher = (async () => {
      await enqueueHasInserted
      return switchToQuickBooks(db, lockIntegrationPluginSelection)
    })()

    const [, switchMs] = await Promise.all([enqueue, switcher])

    // THE PRECONDITION WAS REACHED. Without a row written, every timing below would hold over an
    // enqueue that refused and locked nothing — a guard that cannot fail.
    assert.equal(queued, true, 'the pinned enqueue must have written its row: xero was the active ledger')
    const rows = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true } })
    assert.deepEqual(rows, [{ connector: 'xero' }], 'exactly one row, on the ledger the credit was pinned to')

    // THE FENCE, MEASURED. The switch took the plugin-selection lock through the same helper the app
    // uses and could not complete until the enqueue's transaction ended.
    assert.ok(switchMs >= HOLD_MS - SLACK_MS,
      `the connector switch committed in ${switchMs}ms while the enqueue's transaction was open for `
      + `${HOLD_MS}ms after its INSERT. That is the defect: the pinned-ledger check is a snapshot and `
      + 'the selection can move between it and the write, which puts the credit on a queue no '
      + 'scheduled drain reads — and the orphan path then records its amount as posted relief',
    )
  },
)

test(
  '[o3d-i0o6 r8] THE CONTROL — an UNPINNED enqueue takes no fence, and the switch sails past it',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    /**
     * The same race, the same timings, the same helper — with the pin removed.
     *
     * This is what makes the measurement above mean something. An unpinned enqueue resolves the
     * active connector for itself and takes no selection lock by design, so the switch is NOT
     * blocked; if it were blocked here too, the timing in test 1 would be evidence of some unrelated
     * serialisation (the follow-up scope lock, the pool, the order guard) rather than of the fence.
     *
     * It also states the residual honestly: the unpinned path still resolves-then-writes without a
     * fence. No proof is split across the two reads there — the row is written for whatever was
     * active at resolution, `assertAllocationReversalQueued` is never consulted for it, and the
     * orphan sweep and the manual Sync button both handle it — so it is not the money path this
     * branch closes. It is filed rather than fenced, because fencing it would put a global advisory
     * lock in front of every accounting enqueue in the system.
     */
    const { db, queueAccountingSyncTx, lockIntegrationPluginSelection } = await loadDeps()
    await startFromXeroActive(db)
    const referenceId = probeId('tx-unpinned')
    t.after(cleanup(db, referenceId))
    t.after(() => startFromXeroActive(db))

    const signal: { fire?: () => void } = {}
    const enqueueHasInserted = new Promise<void>((resolve) => { signal.fire = resolve })
    let queued: boolean | null = null

    const enqueue = db.$transaction(async (tx) => {
      queued = await queueAccountingSyncTx(tx, {
        type: 'ALLOCATION_REVERSAL',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: payloadFor(referenceId),
        // o3d-j625 r2: required now. Every test here starts from XERO ACTIVE, so the pooled chart check
        // passes and the refusal under test is still the LOCKED fence's.
        chartConnector: 'xero',
      })
      signal.fire!()
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    }, TX)

    const switcher = (async () => {
      await enqueueHasInserted
      return switchToQuickBooks(db, lockIntegrationPluginSelection)
    })()

    const [, switchMs] = await Promise.all([enqueue, switcher])

    assert.equal(queued, true, 'the unpinned enqueue writes, resolving the active connector itself')
    assert.ok(switchMs < HOLD_MS - SLACK_MS,
      `the unpinned enqueue blocked the switch for ${switchMs}ms. It takes no selection lock, so `
      + 'something else is serialising these two — and the fence measured in test 1 would then be '
      + 'evidence of that something else rather than of the lock',
    )
  },
)

test(
  '[o3d-i0o6 r8] the FACADE enqueue cannot insert under a selection a switch is holding — it refuses',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    /**
     * THE OTHER DIRECTION, and the one the facade can be raced in.
     *
     * `queueAccountingSync` hands off to `queueXeroSync`, which opens and commits its OWN transaction;
     * nothing outside can hold that transaction open, so the enqueue cannot be made to wait mid-flight
     * from out here. The race is therefore inverted: the SWITCH goes first and holds the selection
     * uncommitted, and the facade enqueue — whose own pooled pre-check, under READ COMMITTED, cannot
     * see the uncommitted UPDATE and therefore still answers "xero is active", exactly as it did in
     * production — arrives behind it.
     *
     * Fenced, the queue's transaction blocks on the selection lock, wakes after the switch commits,
     * reads QuickBooks, and refuses with nothing written. Unfenced, its pooled pre-check passes and it
     * inserts a Xero row immediately — the row nothing scheduled drains, which the orphan path counts
     * as posted relief.
     */
    const { db, queueAccountingSync, lockIntegrationPluginSelection } = await loadDeps()
    await startFromXeroActive(db)
    const referenceId = probeId('facade-pinned')
    t.after(cleanup(db, referenceId))
    t.after(() => startFromXeroActive(db))

    const signal: { fire?: () => void } = {}
    const switchHoldsTheLock = new Promise<void>((resolve) => { signal.fire = resolve })

    const switcher = switchToQuickBooks(db, lockIntegrationPluginSelection, {
      holdMs: HOLD_MS,
      onLockHeld: () => signal.fire!(),
    })

    const enqueue = (async () => {
      await switchHoldsTheLock
      const startedAt = Date.now()
      const outcome = await queueAccountingSync({
        type: 'UNEARNED_REV_REVERSAL',
        connector: 'xero',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: payloadFor(referenceId),
        // o3d-j625 r2: required now. Every test here starts from XERO ACTIVE, so the pooled chart check
        // passes and the refusal under test is still the LOCKED fence's.
        chartConnector: 'xero',
      })
      return { outcome, elapsedMs: Date.now() - startedAt }
    })()

    const [, { outcome, elapsedMs }] = await Promise.all([switcher, enqueue])

    assert.deepEqual(
      await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true } }),
      [],
      'NOTHING may be written. A PENDING xero row here is one assertAllocationReversalQueued finds '
      + 'and counts as posted relief, so every later refund under-credits Allocated Inventory by it',
    )
    assert.equal(outcome.queued, false)
    assert.equal(outcome.reason, 'refused',
      '`refused`, never `not-configured` — the posting is still owed, and `not-configured` is the one '
      + 'no-op the refund obligation ledger may settle an obligation with')
    assert.equal(outcome.connector, 'xero', 'and the answer is about the ledger the credit was proved on')

    // AND IT REALLY WAITED, which is what says the refusal came from the locked read rather than from
    // a pooled read that happened to be taken late. An unfenced facade returns in milliseconds with a
    // row written.
    assert.ok(elapsedMs >= HOLD_MS - SLACK_MS,
      `the facade enqueue returned in ${elapsedMs}ms without waiting out the switch's ${HOLD_MS}ms `
      + 'hold, so its verdict was not taken under the selection lock',
    )
  },
)

test(
  '[o3d-i0o6 r9] a pinned enqueue whose SYNC TOGGLE IS OFF still waits for the fence, and refuses',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    /**
     * o3d-i0o6 r9 (Codex round 8, HIGH) — THE GATE ROUND 8 LEFT IN THE FENCE, RACED.
     *
     * r8's fence is real and the three tests above measure it. What it did not do is stop anything
     * else answering FIRST. The connector queue read `xero_sync_enabled` BEFORE opening the
     * transaction that takes the fence, and returned `not-configured` from there — so with the toggle
     * off, `pinnedLedgerIsServicedUnderLock` was never reached at all, and `not-configured` is the ONE
     * no-op `lib/domain/sales/refund-accounting-obligations.ts` lets SETTLE an obligation (it settles
     * when the pinned connector's `willPost` verdict, taken as the hand-off opened, was already false
     * — which is exactly the state below). The refund's reversal obligation was discharged with no row
     * on any ledger, against a configuration the switch had retired.
     *
     * SAME RACE AS TEST 3, ONE SETTING DIFFERENT. The switch holds the selection uncommitted; the
     * facade's pooled pre-check cannot see it under READ COMMITTED and still answers "xero is active",
     * exactly as in production; and Xero's own master toggle is off before either side starts, which
     * is what the r8 unit fixture could not express — it stubs both toggles to `'true'`.
     *
     * Fenced, the queue cannot answer from that toggle: it takes the selection lock, parks behind the
     * switch, wakes after it commits, reads QuickBooks and refuses. Unfenced, it returns
     * `not-configured` in a couple of milliseconds without waiting for anything — which is why the
     * elapsed time is asserted as well as the reason. The timing is the part no fixture can fake.
     */
    const { db, queueAccountingSync, lockIntegrationPluginSelection } = await loadDeps()
    await startFromXeroActive(db)
    // THE PRECONDITION THE R8 FIXTURE EXCLUDED: the pinned connector's own sync is off.
    await setSetting(db, 'xero_sync_enabled', 'false')
    const referenceId = probeId('facade-toggle-off')
    t.after(cleanup(db, referenceId))
    t.after(() => startFromXeroActive(db))

    const signal: { fire?: () => void } = {}
    const switchHoldsTheLock = new Promise<void>((resolve) => { signal.fire = resolve })

    const switcher = switchToQuickBooks(db, lockIntegrationPluginSelection, {
      holdMs: HOLD_MS,
      onLockHeld: () => signal.fire!(),
    })

    const enqueue = (async () => {
      await switchHoldsTheLock
      const startedAt = Date.now()
      const outcome = await queueAccountingSync({
        type: 'UNEARNED_REV_REVERSAL',
        connector: 'xero',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: payloadFor(referenceId),
        // o3d-j625 r2: required now. Every test here starts from XERO ACTIVE, so the pooled chart check
        // passes and the refusal under test is still the LOCKED fence's.
        chartConnector: 'xero',
      })
      return { outcome, elapsedMs: Date.now() - startedAt }
    })()

    const [, { outcome, elapsedMs }] = await Promise.all([switcher, enqueue])

    assert.deepEqual(
      await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true } }),
      [],
      'nothing may be written — the toggle is off',
    )
    assert.equal(outcome.queued, false)
    assert.equal(outcome.reason, 'refused',
      '`not-configured` here SETTLES the refund obligation with no reversal row on any ledger, on a '
      + 'configuration the switch has retired — while the ledger now being serviced would have taken '
      + 'the posting. The posting is owed: `refused`')
    assert.equal(outcome.connector, 'xero', 'and the answer is about the ledger the credit was proved on')

    // AND IT WAITED. This is the half that separates a fenced answer from a lucky one: an unfenced
    // queue answers from its own toggle read and never touches the selection lock, so it returns long
    // before the switch has committed.
    assert.ok(elapsedMs >= HOLD_MS - SLACK_MS,
      `the enqueue answered in ${elapsedMs}ms without waiting out the switch's ${HOLD_MS}ms hold, so `
      + 'its verdict was taken from the sync toggle rather than from under the selection lock',
    )
  },
)

test(
  '[o3d-i0o6 r9] THE NARROWING — with no switch in flight, a toggled-off pinned enqueue is `not-configured` and does not hang',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    /**
     * The control for the test above, and it is load-bearing twice over.
     *
     * FIRST, it stops the fix being a blanket rename. A deliberately disabled connector must still
     * produce `not-configured`, because that is the one answer that lets the refund obligation ledger
     * settle a posting that will genuinely never exist — if this came back `refused`, no refund could
     * be staged at all on a system with Xero sync switched off.
     *
     * SECOND, it is the liveness half. The fenced path now takes a real advisory lock and real row
     * locks on a path that writes nothing; uncontended it must acquire them, answer and release
     * immediately rather than waiting on anything.
     */
    const { db, queueAccountingSync } = await loadDeps()
    await startFromXeroActive(db)
    await setSetting(db, 'xero_sync_enabled', 'false')
    const referenceId = probeId('facade-toggle-off-control')
    t.after(cleanup(db, referenceId))
    t.after(() => startFromXeroActive(db))

    const startedAt = Date.now()
    const outcome = await queueAccountingSync({
      type: 'UNEARNED_REV_REVERSAL',
      connector: 'xero',
      referenceType: REFERENCE_TYPE,
      referenceId,
      payload: payloadFor(referenceId),
      // o3d-j625 r2: required now. Every test here starts from XERO ACTIVE, so the pooled chart check
      // passes and the refusal under test is still the LOCKED fence's.
      chartConnector: 'xero',
    })
    const elapsedMs = Date.now() - startedAt

    assert.equal(outcome.reason, 'not-configured',
      'the pinned ledger IS the one being serviced and its sync is off — no counterpart will ever '
      + 'exist, so nothing is outstanding and the obligation may settle')
    assert.equal(outcome.connector, 'xero')
    assert.deepEqual(
      await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true } }),
      [],
    )
    assert.ok(elapsedMs < HOLD_MS,
      `an uncontended fenced answer took ${elapsedMs}ms — it should acquire, read and release`)
  },
)
