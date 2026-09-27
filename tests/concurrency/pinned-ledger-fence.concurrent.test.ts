import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
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
  // o3d-remove-parked-connectors: `plugin_quickbooks_enabled` and `quickbooks_sync_enabled` were
  // seeded here too. QuickBooks is archived; the rows are no longer read by anything, so seeding them
  // would be theatre.
  for (const [key, value] of [
    [INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true'],
    ['xero_sync_enabled', 'true'],
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
/**
 * o3d-remove-parked-connectors — WHAT THE SWITCH IS NOW.
 *
 * This was `switchToQuickBooks`: it turned Xero's plugin off and QuickBooks' on, under the selection
 * lock, exactly as `saveIntegrationPluginState` does. QuickBooks is archived, so the switch is now
 * "turn the pinned ledger OFF" — which produces the SAME state the fence has to refuse on (the locked
 * read no longer resolves to the pinned connector) through the same writer and the same lock, and is
 * the state a real install reaches by disabling its accounting plugin.
 *
 * What is no longer raced is a switch BETWEEN two live ledgers. Every timing property this file
 * measures — that the fence's read WAITS on the switcher's lock, and that the verdict is taken after
 * it commits — is unchanged, because those are properties of the lock, not of the number of ids.
 */
async function switchAwayFromXero(
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
      return switchAwayFromXero(db, lockIntegrationPluginSelection)
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

/**
 * o3d-j625 r13 (Codex on the merged head, HIGH) — THIS CONTROL ASSERTED THE DEFECT, AND IS INVERTED.
 *
 * It ran test 1's race with the pin removed and required the switch NOT to be blocked, on the stated
 * grounds that "the unpinned path still resolves-then-writes without a fence … it is filed rather than
 * fenced, because fencing it would put a global advisory lock in front of every accounting enqueue".
 * Codex executed that residual: an unpinned call whose connector is deactivated between the chart read
 * and the insert writes a row nothing will ever process AND clears the outstanding refusal, so the
 * identity rule this branch spent four rounds building is handed false evidence. The fence is now
 * unconditional, so the first arm below is the opposite of what this test used to say.
 *
 * ITS STRUCTURAL JOB SURVIVES, AND IT HAD TO. The measurement in test 1 means "the FENCE blocked the
 * switch" only if something else — the order lock, the follow-up scope lock, the pool — is not doing the
 * blocking. With every enqueue now fenced, an unpinned call can no longer be that negative control, so
 * the second arm supplies one: an enqueue whose SYNC TOGGLE IS OFF is answered before the fenced
 * transaction is ever opened (`notConfiguredUnderPinnedLedgerFence` with no pin — see
 * lib/connectors/xero/queue.ts), so it takes no selection lock and does NOT block the switch. Two arms
 * differing in exactly one setting, and the one that takes the fence is the one that blocks.
 */
test(
  '[o3d-j625 r13] an UNPINNED enqueue is fenced TOO — and an enqueue that never opens the fenced transaction still is not',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, queueAccountingSyncTx, lockIntegrationPluginSelection } = await loadDeps()
    await startFromXeroActive(db)
    const referenceId = probeId('tx-unpinned')
    const offReferenceId = probeId('tx-unpinned-sync-off')
    t.after(cleanup(db, referenceId))
    t.after(cleanup(db, offReferenceId))
    t.after(() => startFromXeroActive(db))

    // ── ARM 1: unpinned, connector ACTIVE, sync ON. The fence is taken, so the switch must wait for it.
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
      return switchAwayFromXero(db, lockIntegrationPluginSelection)
    })()

    const [, switchMs] = await Promise.all([enqueue, switcher])

    assert.equal(queued, true, 'the unpinned enqueue still writes when its chart IS the active connector')
    assert.ok(switchMs >= HOLD_MS - SLACK_MS,
      `the switch committed in ${switchMs}ms while an unpinned enqueue that had inserted was still open. `
      + 'Since o3d-j625 r13 that enqueue holds the selection lock too, so a switch must not be able to '
      + `land between its chart read and its commit (it waited ${switchMs}ms of a ${HOLD_MS}ms hold)`)

    // ── ARM 2, THE NEGATIVE CONTROL. It has to come from the FACADE, and finding that out is part of
    //    what r13 established: in `queueAccountingSyncTx` the fence is now unconditional AND FIRST (ahead
    //    of the posting context, because that context answers from the connector's own toggle and would
    //    say "yes, it posts" for a connector the cron has stopped servicing), so there is no longer ANY
    //    unfenced enqueue path there to use as a control — measured, the toggled-off tx call blocked the
    //    switch for 508ms of a 500ms hold.
    //
    //    The facade still has one: with the sync toggle off and no pin, `queueXeroSync` answers
    //    `not-configured` from its own settings read BEFORE `db.$transaction` is ever opened
    //    (`notConfiguredUnderPinnedLedgerFence` with no pin), so it takes no selection lock. That is the
    //    arm that must NOT block the switch — and it is what says arm 1's wait is the fence rather than
    //    the pool, the order guard or the follow-up scope lock.
    await startFromXeroActive(db)
    await setSetting(db, 'xero_sync_enabled', 'false')
    const { queueAccountingSync } = await loadDeps()
    let offOutcome: { queued: boolean; reason?: string } | null = null
    const offSignal: { fire?: () => void } = {}
    const offSwitchHoldsTheLock = new Promise<void>((resolve) => { offSignal.fire = resolve })
    const offSwitcher = switchAwayFromXero(db, lockIntegrationPluginSelection, {
      holdMs: HOLD_MS,
      onLockHeld: () => offSignal.fire!(),
    })
    const offEnqueue = (async () => {
      await offSwitchHoldsTheLock
      const startedAt = Date.now()
      offOutcome = await queueAccountingSync({
        type: 'ALLOCATION_REVERSAL',
        referenceType: REFERENCE_TYPE,
        referenceId: offReferenceId,
        payload: payloadFor(offReferenceId),
        chartConnector: 'xero',
      })
      return Date.now() - startedAt
    })()
    const [, offElapsedMs] = await Promise.all([offSwitcher, offEnqueue])
    await setSetting(db, 'xero_sync_enabled', 'true')

    assert.equal((offOutcome as unknown as { queued: boolean } | null)?.queued, false,
      'PRECONDITION: with the type switched off nothing is queued')
    assert.deepEqual(await db.accountingSyncLog.findMany({ where: { referenceId: offReferenceId }, select: { id: true } }), [],
      'PRECONDITION: and nothing was written, so this arm really did answer before the fenced write')
    console.log(`[r13 fence isolation] the fenced arm blocked the switch for ${switchMs}ms; the unfenced `
      + `(facade, sync-off) arm returned in ${offElapsedMs}ms without waiting out the ${HOLD_MS}ms hold`)
    assert.ok(offElapsedMs < HOLD_MS - SLACK_MS,
      `an enqueue answered BEFORE any fenced transaction waited ${offElapsedMs}ms on a switch holding the `
      + 'selection. It takes no selection lock, so something else is serialising these two — and every '
      + 'timing in this file would then be evidence of that something else rather than of the fence')
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
     * reads the switched-off selection, and refuses with nothing written. Unfenced, its pooled pre-check passes and it
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

    const switcher = switchAwayFromXero(db, lockIntegrationPluginSelection, {
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
     * switch, wakes after it commits, reads the switched-off selection and refuses. Unfenced, it returns
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

    const switcher = switchAwayFromXero(db, lockIntegrationPluginSelection, {
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

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r13 (Codex on the merged head, HIGH) — AN UNPINNED ENQUEUE CAN DISCHARGE A DEBT WITH A ROW
 * NOTHING WILL EVER PROCESS
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE FINDING. The chart check reads the active connector BEFORE queueing, but the locked check inside
 * the enqueue's own transaction was conditional on a PIN — `params.pinnedLedger` in
 * lib/connectors/xero/queue.ts, `params.connector` in `queueAccountingSyncTx`. An UNPINNED call supplied
 * neither, so it skipped the fence entirely: if Xero was deactivated between the chart read and the
 * insert, the call still wrote a Xero row and answered `queued: true`.
 *
 * WHY THAT IS THIS BRANCH'S OWN SUBJECT MATTER AND NOT HARDENING. `queueAccountingSync` CLEARS the
 * outstanding refusal on `queued: true` (r4), and the r12 identity rule then sees a live sync row whose
 * id is not in the baseline and correctly concludes "a posting was queued since I was shut out". The
 * rule is right; the evidence it is handed is false. The row's connector is no longer the active one, so
 * `/api/cron/accounting-sync` returns `skipped` before it looks at any row — the posting never happens
 * and the debt is gone. That is precisely the outcome the whole of r9-r12 exists to prevent, arriving
 * through the enqueue instead of through the reconciler.
 *
 * THE INTERLEAVING IS THE ONE THE FACADE TEST ABOVE ESTABLISHED, with the pin removed: the switch goes
 * FIRST and holds the selection uncommitted, so the enqueue's pooled chart read — under READ COMMITTED —
 * still answers "xero is active", exactly as it does in production. Nothing is modelled: no fixture moves
 * a setting after a read, and no double supplies a verdict. Fenced, the enqueue's transaction blocks on
 * the selection lock, wakes after the switch commits, reads the switched-off selection and refuses with
 * nothing written. Unfenced, it inserts immediately and clears the debt.
 *
 * AND THE CONTROL IS TEST 'r13 POSITIVE CONTROL' BELOW: the same unpinned call with Xero still ACTIVE
 * must still queue and still clear. Without it, "the unpinned enqueue refused" would be satisfied by
 * having broken unpinned enqueues altogether.
 */

/** The posting key an ALLOCATION_REVERSAL with no `_reversalToken` in its payload produces. */
const unpinnedPostingKey = (referenceId: string) => ({
  type: 'ALLOCATION_REVERSAL', referenceType: REFERENCE_TYPE, referenceId, scope: '',
})

/** An outstanding refusal for that posting — the debt whose discharge is the finding. */
async function seedDebt(db: Db, referenceId: string): Promise<string> {
  const row = await db.accountingPostingRefusal.create({
    data: {
      ...unpinnedPostingKey(referenceId),
      kind: 'allocation_reversal',
      chartConnector: 'xero',
      activeConnector: 'xero',
      reason: 'retired_chart',
      committed: 'the allocation trim stands in IMS',
      remedy: 'Post the reversal by hand in the ledger it belongs to.',
    },
    select: { id: true },
  })
  return row.id
}

/** Exactly what the exception inbox lists (app/actions/sync-exceptions.ts: `resolvedAt: null`). */
async function debtIsOutstanding(db: Db, referenceId: string): Promise<boolean> {
  return (await db.accountingPostingRefusal.count({
    where: { ...unpinnedPostingKey(referenceId), resolvedAt: null },
  })) === 1
}

function cleanupDebt(db: Db, referenceId: string): () => Promise<void> {
  return async () => {
    await db.accountingPostingRefusal.deleteMany({ where: { referenceId } }).catch(() => undefined)
  }
}

test(
  '[o3d-j625 r13] the FACADE, UNPINNED: a connector deactivated before the insert must not let the row discharge the debt',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, queueAccountingSync, lockIntegrationPluginSelection } = await loadDeps()
    const { isIntegrationPluginEnabled } = await import('../../lib/integration-plugins.ts')
    await startFromXeroActive(db)
    const referenceId = probeId('r13-facade-unpinned')
    t.after(cleanup(db, referenceId))
    t.after(cleanupDebt(db, referenceId))
    t.after(() => startFromXeroActive(db))
    await seedDebt(db, referenceId)
    assert.equal(await debtIsOutstanding(db, referenceId), true, 'PRECONDITION: the debt is outstanding')

    const signal: { fire?: () => void } = {}
    const switchHoldsTheLock = new Promise<void>((resolve) => { signal.fire = resolve })
    const switcher = switchAwayFromXero(db, lockIntegrationPluginSelection, {
      holdMs: HOLD_MS,
      onLockHeld: () => signal.fire!(),
    })

    const enqueue = (async () => {
      await switchHoldsTheLock
      const startedAt = Date.now()
      // NO `connector`: an unpinned call. It still names the CHART its codes came from (required since
      // r2), and that chart is what decides the queue — so it is the connector whose continued
      // servicing this enqueue depends on, pin or no pin.
      const outcome = await queueAccountingSync({
        type: 'ALLOCATION_REVERSAL',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: payloadFor(referenceId),
        chartConnector: 'xero',
      })
      return { outcome, elapsedMs: Date.now() - startedAt }
    })()

    const [, { outcome, elapsedMs }] = await Promise.all([switcher, enqueue])

    // WHAT THE CRON WILL DO WITH A ROW WRITTEN HERE — established, not asserted by assumption.
    assert.equal(await isIntegrationPluginEnabled('xero'), false,
      'PRECONDITION: Xero is no longer an enabled plugin, which is the FIRST gate in '
      + '/api/cron/accounting-sync — it returns `skipped: No accounting plugin enabled` before it looks '
      + 'at a single row, so a xero row written now is one nothing will ever process')

    const written = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true, status: true } })
    console.log(`[r13 facade] outcome=${JSON.stringify(outcome)} elapsed=${elapsedMs}ms rows=${JSON.stringify(written)} `
      + `debtOutstanding=${await debtIsOutstanding(db, referenceId)}`)

    assert.deepEqual(written, [],
      'THE FINDING, first half: nothing may be written for a connector that stopped being serviced '
      + 'before the insert. Such a row is PENDING for ever and the accounting cron skips it.')
    assert.equal(outcome.queued, false, 'and the caller is told it was not queued')
    assert.equal(await debtIsOutstanding(db, referenceId), true,
      'THE FINDING, second half: the debt is STILL OUTSTANDING. `queued: true` clears the refusal row '
      + '(r4) and the r12 identity rule then reads that row as proof a posting was queued — so an '
      + 'un-processable row does not merely sit there, it discharges a debt that is owed.')
    assert.ok(elapsedMs >= HOLD_MS - SLACK_MS,
      `the enqueue returned in ${elapsedMs}ms without waiting out the switch's ${HOLD_MS}ms hold, so its `
      + 'verdict was NOT taken under the selection lock — measured, so "it refused" cannot be a pooled '
      + 'read that happened to land late')
  },
)

test(
  '[o3d-j625 r13] the IN-TRANSACTION enqueue, UNPINNED: same gap, same refusal',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, queueAccountingSyncTx, lockIntegrationPluginSelection } = await loadDeps()
    await startFromXeroActive(db)
    const referenceId = probeId('r13-tx-unpinned')
    t.after(cleanup(db, referenceId))
    t.after(cleanupDebt(db, referenceId))
    t.after(() => startFromXeroActive(db))
    await seedDebt(db, referenceId)

    const signal: { fire?: () => void } = {}
    const switchHoldsTheLock = new Promise<void>((resolve) => { signal.fire = resolve })
    const switcher = switchAwayFromXero(db, lockIntegrationPluginSelection, {
      holdMs: HOLD_MS,
      onLockHeld: () => signal.fire!(),
    })

    let queued: boolean | null = null
    const caller = (async () => {
      await switchHoldsTheLock
      const startedAt = Date.now()
      await db.$transaction(async (tx) => {
        queued = await queueAccountingSyncTx(tx, {
          type: 'ALLOCATION_REVERSAL',
          referenceType: REFERENCE_TYPE,
          referenceId,
          payload: payloadFor(referenceId),
          chartConnector: 'xero',
        })
      }, TX)
      return Date.now() - startedAt
    })()

    const [, elapsedMs] = await Promise.all([switcher, caller])

    const written = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true, status: true } })
    console.log(`[r13 tx] queued=${queued} elapsed=${elapsedMs}ms rows=${JSON.stringify(written)} `
      + `debtOutstanding=${await debtIsOutstanding(db, referenceId)}`)

    assert.deepEqual(written, [],
      'the in-transaction enqueue has the same gap — its locked check ran only when `params.connector` '
      + 'was set — and the same consequence: a row for an unserviced connector.')
    assert.equal(queued, false, 'and the boolean the caller acts on says nothing was queued')
    assert.equal(await debtIsOutstanding(db, referenceId), true, 'so the debt is kept')
    assert.ok(elapsedMs >= HOLD_MS - SLACK_MS,
      `the caller's transaction returned in ${elapsedMs}ms rather than waiting out the ${HOLD_MS}ms hold, `
      + 'so its verdict was not taken under the selection lock')
  },
)

test(
  '[o3d-j625 r13] POSITIVE CONTROL — an UNPINNED enqueue with the connector still ACTIVE still queues, and still clears the debt',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    /**
     * Without this the two tests above are satisfied by having disabled unpinned enqueues altogether.
     * Same call, same absence of a pin, same required chart — and no switch racing it.
     */
    const { db, queueAccountingSync } = await loadDeps()
    await startFromXeroActive(db)
    const referenceId = probeId('r13-positive')
    t.after(cleanup(db, referenceId))
    t.after(cleanupDebt(db, referenceId))
    await seedDebt(db, referenceId)
    assert.equal(await debtIsOutstanding(db, referenceId), true, 'PRECONDITION: the debt is outstanding')

    const outcome = await queueAccountingSync({
      type: 'ALLOCATION_REVERSAL',
      referenceType: REFERENCE_TYPE,
      referenceId,
      payload: payloadFor(referenceId),
      chartConnector: 'xero',
    })

    const written = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true, status: true } })
    console.log(`[r13 control] outcome=${JSON.stringify(outcome)} rows=${JSON.stringify(written)} `
      + `debtOutstanding=${await debtIsOutstanding(db, referenceId)}`)

    assert.equal(outcome.queued, true, 'an unpinned enqueue against the ACTIVE connector still queues')
    assert.deepEqual(written.map((row) => row.connector), ['xero'], 'and writes exactly one xero row')
    assert.equal(await debtIsOutstanding(db, referenceId), false,
      'and THAT row legitimately clears the debt — the posting really is queued to the connector the '
      + 'cron services, which is the whole difference from the two tests above')
  },
)
