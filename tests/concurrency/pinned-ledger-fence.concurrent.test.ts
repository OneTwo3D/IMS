import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'
import { backendPid, waitUntilParkedBehind, type ParkedBackend } from '../helpers/lock-wait-observer.ts'

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
 * o3d-ohrk3 — THE HOLD IS A STATE, NOT A DURATION. Every test here used to keep the lock holder's
 * transaction open for a fixed `HOLD_MS` and assert on elapsed wall-clock time. That is a race
 * between a sleep and the other side's latency: under host load the waiter's pooled pre-checks,
 * connection checkout and transaction start can outlast the hold, the holder commits first, and the
 * waiter runs uncontended against the already-switched selection (PR #724 test 123: `not-configured`
 * where `refused` was asserted; the r13 in-transaction case: a PENDING xero row where none may exist).
 * Now the holder releases only once the OTHER side is OBSERVED parked behind it — a backend whose
 * `pg_blocking_pids` names the holder, stuck on `pg_advisory_xact_lock` — through
 * tests/helpers/lock-wait-observer.ts, which FAILS LOUD if the park is never seen instead of letting the
 * test proceed. Each case prints the observation, and asserts it, as its precondition. The elapsed-time
 * assertions are replaced by ORDER assertions taken from the same clock as the release (the waiter
 * cannot have finished before the holder released), which is the property they were a proxy for.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
/**
 * The ONE remaining wall-clock bound in this file: the UNCONTENDED liveness test (test 5), where no
 * lock is held by anyone and "it did not hang" is the whole claim, so there is no state to wait for.
 * It is not a hold any more — nothing sleeps for it.
 */
const UNCONTENDED_BOUND_MS = 500
/**
 * Ceiling on how long a NEGATIVE control (an enqueue that must NOT be blocked by the switch) keeps the
 * switch's lock held while waiting for that enqueue to return. A healthy run releases within tens of
 * milliseconds, as soon as the enqueue has answered; this only bounds the failure where it is blocked.
 */
const UNBLOCKED_CEILING_MS = 5_000
/** What a fenced enqueue is stuck on while parked behind a holder (`lockIntegrationPluginSelection`). */
const FENCE_WAIT = /pg_advisory_xact_lock/i
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
 * `holdUntil` keeps the transaction open AFTER the write until a STATE is reached (the other side
 * observed parked behind it — o3d-ohrk3), never for a fixed time. Returns when it released the lock and
 * when COMMIT completed, which is what the order assertions are taken against.
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
type SwitchResult = {
  /** Wall-clock of the whole switch transaction (diagnostic). */
  switchMs: number
  /** Taken as the transaction body returns, i.e. immediately before COMMIT releases the lock. */
  releasedAt: number
  /** Taken after COMMIT returned. */
  completedAt: number
}

async function switchAwayFromXero(
  db: Db,
  lockIntegrationPluginSelection: Awaited<ReturnType<typeof loadDeps>>['lockIntegrationPluginSelection'],
  options: {
    /**
     * Awaited INSIDE the transaction after the write: the lock stays held until it settles. A rejection
     * rolls the switch back and fails the test with the rejection's diagnostic.
     */
    holdUntil?: (holderPid: number) => Promise<void>
    onLockHeld?: (holderPid: number) => void
  } = {},
): Promise<SwitchResult> {
  const startedAt = Date.now()
  let releasedAt = 0
  await db.$transaction(async (tx) => {
    const holderPid = await backendPid(tx)
    await lockIntegrationPluginSelection(tx)
    options.onLockHeld?.(holderPid)
    for (const [key, value] of [
      [INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'false'],
    ] as Array<[string, string]>) {
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    if (options.holdUntil) await options.holdUntil(holderPid)
    releasedAt = Date.now()
  }, TX)
  const completedAt = Date.now()
  return { switchMs: completedAt - startedAt, releasedAt, completedAt }
}

/**
 * THE SWITCH-FIRST RACE, with the hold made a state (o3d-ohrk3).
 *
 * The switch takes the selection and writes it uncommitted. `startEnqueue` runs only once the lock is
 * held. The switch then keeps the lock until a backend blocked by it, stuck on the fence's advisory
 * lock, is OBSERVED — and only then commits. So the enqueue's pooled pre-checks (which cannot see the
 * uncommitted switch under READ COMMITTED) have happened or are happening against a selection that has
 * provably not moved, however long checkout and transaction start take under load.
 *
 * If the park is never observed the switch's transaction rejects and ROLLS BACK, and this rejects with
 * the observer's diagnostic: an enqueue that stopped taking the fence goes red as "never parked".
 */
async function raceEnqueueBehindSwitch<T>(
  db: Db,
  lockIntegrationPluginSelection: Awaited<ReturnType<typeof loadDeps>>['lockIntegrationPluginSelection'],
  describe: string,
  startEnqueue: () => Promise<T>,
): Promise<{ switched: SwitchResult; enqueue: T; enqueueDoneAt: number; parked: ParkedBackend }> {
  let lockHeld!: () => void
  const switchHoldsTheLock = new Promise<void>((resolve) => { lockHeld = resolve })
  let parked: ParkedBackend | null = null

  const switcher = switchAwayFromXero(db, lockIntegrationPluginSelection, {
    onLockHeld: () => lockHeld(),
    holdUntil: async (holderPid) => {
      parked = await waitUntilParkedBehind(db, { holderPid, waitingOn: FENCE_WAIT, describe })
    },
  })
  const enqueueing = (async () => {
    await switchHoldsTheLock
    const enqueue = await startEnqueue()
    return { enqueue, enqueueDoneAt: Date.now() }
  })()

  const [switchedOutcome, enqueueOutcome] = await Promise.allSettled([switcher, enqueueing])
  // The observer's diagnostic is the root cause; whatever the enqueue did without a fence is fallout.
  if (switchedOutcome.status === 'rejected') throw switchedOutcome.reason
  if (enqueueOutcome.status === 'rejected') throw enqueueOutcome.reason
  assert.ok(parked, 'PRECONDITION: the enqueue was observed parked behind the switch')
  return { switched: switchedOutcome.value, ...enqueueOutcome.value, parked }
}

type Deps = Awaited<ReturnType<typeof loadDeps>>

/**
 * THE ENQUEUE-FIRST RACE, with the hold made a state (o3d-ohrk3).
 *
 * The enqueue goes first, INSERTS, and keeps its transaction open until the switch is OBSERVED parked
 * behind it (a backend blocked by the enqueue's own backend, on the selection lock) — and only then
 * commits. Nothing sleeps. If the switch is never seen parked the enqueue's transaction rejects and
 * rolls back, with the observer's diagnostic: a fence that stopped holding the selection goes red as
 * "never parked", not as a timing guess.
 */
async function raceSwitchBehindOpenEnqueue(
  db: Db,
  deps: Pick<Deps, 'queueAccountingSyncTx' | 'lockIntegrationPluginSelection'>,
  describe: string,
  enqueueParams: Parameters<Deps['queueAccountingSyncTx']>[1],
): Promise<{ queued: boolean | null; switched: SwitchResult; enqueueReleasedAt: number; parked: ParkedBackend }> {
  let queued: boolean | null = null
  let parked: ParkedBackend | null = null
  let enqueueReleasedAt = 0
  let inserted!: (pid: number) => void
  const enqueueHasInserted = new Promise<number>((resolve) => { inserted = resolve })

  const enqueueing = db.$transaction(async (tx) => {
    const enqueuePid = await backendPid(tx)
    queued = await deps.queueAccountingSyncTx(tx, enqueueParams)
    inserted(enqueuePid)
    // Held open until the switch is DEMONSTRABLY parked on the lock this transaction holds.
    parked = await waitUntilParkedBehind(db, { holderPid: enqueuePid, waitingOn: FENCE_WAIT, describe })
    enqueueReleasedAt = Date.now()
  }, TX)
  // Never rejects: lets the switch side stop waiting if the enqueue fails before it has inserted.
  const enqueueSettled = enqueueing.then(() => undefined, () => undefined)

  const switching = (async () => {
    const pid = await Promise.race([enqueueHasInserted, enqueueSettled])
    if (pid === undefined) return null
    return switchAwayFromXero(db, deps.lockIntegrationPluginSelection)
  })()

  const [enqueueOutcome, switchOutcome] = await Promise.allSettled([enqueueing, switching])
  if (enqueueOutcome.status === 'rejected') throw enqueueOutcome.reason
  if (switchOutcome.status === 'rejected') throw switchOutcome.reason
  assert.ok(switchOutcome.value, 'PRECONDITION: the enqueue reached its insert, so the switch was started')
  assert.ok(parked, 'PRECONDITION: the switch was observed parked behind the open enqueue')
  return { queued, switched: switchOutcome.value, enqueueReleasedAt, parked }
}

/**
 * The PRECONDITION and the ORDER, for a waiter that was released by a holder (o3d-ohrk3).
 * `parked` proves the waiter reached the lock while the holder still held it; `waiterDoneAt >=
 * releasedAt` says it could not have answered before the holder let go — which is what the old
 * `elapsedMs >= HOLD_MS - SLACK_MS` was a wall-clock proxy for.
 */
function assertWaitedForHolder(
  label: string, parked: ParkedBackend, releasedAt: number, waiterDoneAt: number, defect = '',
): void {
  console.log(`[o3d-ohrk3 parked] ${label}: waiter backend ${parked.pid} observed blocked on `
    + `\`${parked.query.replace(/\s+/g, ' ').slice(0, 60)}\` after ${parked.observedAfterMs}ms; holder released `
    + `${waiterDoneAt - releasedAt}ms before the waiter finished`)
  assert.ok(parked.pid > 0, `${label}: PRECONDITION — the waiter was observed parked behind the holder`)
  assert.ok(waiterDoneAt >= releasedAt,
    `${label}: the waiter finished ${releasedAt - waiterDoneAt}ms BEFORE the holder released the selection, `
    + `so its verdict was not taken under the lock it was meant to wait for. ${defect}`)
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
     * The enqueue goes first and INSERTS. Its transaction then stays open until the switch is OBSERVED
     * parked behind it (o3d-ohrk3), and only then commits. If the selection lock is genuinely held by that transaction, the switch — which
     * takes the same lock and the same rows — cannot commit until the insert is durable. So the
     * question "could a switch have landed between the check and the write" is answered by measuring
     * whether the switch was able to land at all while the writing transaction lived.
     *
     * Under round 7's unlocked check the enqueue takes no plugin lock, the switch commits in a few
     * milliseconds and is never seen parked, so the observer fails the test with "never parked".
     */
    const { queued, switched, enqueueReleasedAt, parked } = await raceSwitchBehindOpenEnqueue(
      db,
      { queueAccountingSyncTx, lockIntegrationPluginSelection },
      'test 1 (pinned, in-transaction)',
      {
        type: 'ALLOCATION_REVERSAL',
        connector: 'xero',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: payloadFor(referenceId),
        // o3d-j625 r2: required now. Every test here starts from XERO ACTIVE, so the pooled chart check
        // passes and the refusal under test is still the LOCKED fence's.
        chartConnector: 'xero',
      },
    )

    // THE PRECONDITION WAS REACHED. Without a row written, every timing below would hold over an
    // enqueue that refused and locked nothing — a guard that cannot fail.
    assert.equal(queued, true, 'the pinned enqueue must have written its row: xero was the active ledger')
    const rows = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true } })
    assert.deepEqual(rows, [{ connector: 'xero' }], 'exactly one row, on the ledger the credit was pinned to')

    // THE FENCE, OBSERVED. The switch took the plugin-selection lock through the same helper the app
    // uses, was seen parked behind the enqueue's open transaction, and could not complete until that
    // transaction ended.
    assertWaitedForHolder(
      'test 1: the connector switch waited for the open pinned enqueue',
      parked, enqueueReleasedAt, switched.completedAt,
      'A switch that commits while the enqueue is open is the defect: the pinned-ledger check is a '
      + 'snapshot and the selection can move between it and the write, which puts the credit on a queue '
      + 'no scheduled drain reads — and the orphan path then records its amount as posted relief',
    )
  },
)

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
    const arm1 = await raceSwitchBehindOpenEnqueue(
      db,
      { queueAccountingSyncTx, lockIntegrationPluginSelection },
      'test 2 arm 1 (unpinned, in-transaction)',
      {
        type: 'ALLOCATION_REVERSAL',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: payloadFor(referenceId),
        // o3d-j625 r2: required now. Every test here starts from XERO ACTIVE, so the pooled chart check
        // passes and the refusal under test is still the LOCKED fence's.
        chartConnector: 'xero',
      },
    )

    assert.equal(arm1.queued, true, 'the unpinned enqueue still writes when its chart IS the active connector')
    assertWaitedForHolder(
      'test 2 arm 1: the switch waited for the open UNPINNED enqueue',
      arm1.parked, arm1.enqueueReleasedAt, arm1.switched.completedAt,
      'Since o3d-j625 r13 that enqueue holds the selection lock too, so a switch must not be able to '
      + 'land between its chart read and its commit',
    )

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
    // o3d-ohrk3: the switch holds the selection until the enqueue has RETURNED (bounded, so a blocked
    // enqueue fails the assertion below rather than hanging) — not for a fixed time, so a slow enqueue
    // is not mistaken for a blocked one. The negative control is: it answered while the switch still held.
    let offEnqueueReturned!: () => void
    const offEnqueueDone = new Promise<void>((resolve) => { offEnqueueReturned = resolve })
    let offEnqueueDoneAt = 0
    const offSwitcher = switchAwayFromXero(db, lockIntegrationPluginSelection, {
      onLockHeld: () => offSignal.fire!(),
      holdUntil: async () => {
        await Promise.race([offEnqueueDone, new Promise((resolve) => setTimeout(resolve, UNBLOCKED_CEILING_MS))])
      },
    })
    const offEnqueue = (async () => {
      await offSwitchHoldsTheLock
      try {
        offOutcome = await queueAccountingSync({
          type: 'ALLOCATION_REVERSAL',
          referenceType: REFERENCE_TYPE,
          referenceId: offReferenceId,
          payload: payloadFor(offReferenceId),
          chartConnector: 'xero',
        })
      } finally {
        offEnqueueDoneAt = Date.now()
        offEnqueueReturned()
      }
    })()
    const [offSwitched] = await Promise.all([offSwitcher, offEnqueue])
    await setSetting(db, 'xero_sync_enabled', 'true')

    assert.equal((offOutcome as unknown as { queued: boolean } | null)?.queued, false,
      'PRECONDITION: with the type switched off nothing is queued')
    assert.deepEqual(await db.accountingSyncLog.findMany({ where: { referenceId: offReferenceId }, select: { id: true } }), [],
      'PRECONDITION: and nothing was written, so this arm really did answer before the fenced write')
    console.log(`[r13 fence isolation] the fenced arm waited for the switch (parked, observed); the unfenced `
      + `(facade, sync-off) arm returned ${offSwitched.releasedAt - offEnqueueDoneAt}ms BEFORE the switch released `
      + 'the selection')
    assert.ok(offEnqueueDoneAt > 0 && offEnqueueDoneAt <= offSwitched.releasedAt,
      `an enqueue answered BEFORE any fenced transaction only returned ${offEnqueueDoneAt - offSwitched.releasedAt}ms `
      + 'AFTER the switch released the selection it was holding. It takes no selection lock, so something else '
      + 'is serialising these two — and every timing in this file would then be evidence of that something '
      + 'else rather than of the fence')
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

    const { switched, enqueue: { outcome }, enqueueDoneAt, parked } = await raceEnqueueBehindSwitch(
      db, lockIntegrationPluginSelection, 'test 3 (facade, pinned)',
      async () => {
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
        return { outcome }
      },
    )

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
    // a pooled read that happened to be taken late: the enqueue was OBSERVED parked behind the switch's
    // lock, and could not answer before the switch released it. An unfenced facade is never parked and
    // returns with a row written.
    assertWaitedForHolder(
      'test 3: the facade enqueue waited under the selection lock',
      parked, switched.releasedAt, enqueueDoneAt,
      'so its verdict was not taken under the selection lock',
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

    const { switched, enqueue: { outcome }, enqueueDoneAt, parked } = await raceEnqueueBehindSwitch(
      db, lockIntegrationPluginSelection, 'test 4 (facade, pinned, sync toggle off)',
      async () => {
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
        return { outcome }
      },
    )

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
    // queue answers from its own toggle read and never touches the selection lock, so it is never
    // parked behind the switch and returns long before the switch has committed. Here it was OBSERVED
    // parked, and could not answer before the switch released the selection.
    assertWaitedForHolder(
      'test 4: the toggled-off pinned enqueue waited under the selection lock',
      parked, switched.releasedAt, enqueueDoneAt,
      'so its verdict was taken from the sync toggle rather than from under the selection lock',
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
    assert.ok(elapsedMs < UNCONTENDED_BOUND_MS,
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

    const { switched, enqueue: { outcome }, enqueueDoneAt, parked } = await raceEnqueueBehindSwitch(
      db, lockIntegrationPluginSelection, 'r13 facade (unpinned)',
      async () => {
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
        return { outcome }
      },
    )

    // WHAT THE CRON WILL DO WITH A ROW WRITTEN HERE — established, not asserted by assumption.
    assert.equal(await isIntegrationPluginEnabled('xero'), false,
      'PRECONDITION: Xero is no longer an enabled plugin, which is the FIRST gate in '
      + '/api/cron/accounting-sync — it returns `skipped: No accounting plugin enabled` before it looks '
      + 'at a single row, so a xero row written now is one nothing will ever process')

    const written = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true, status: true } })
    console.log(`[r13 facade] outcome=${JSON.stringify(outcome)} elapsed=${enqueueDoneAt - switched.releasedAt}ms-after-release rows=${JSON.stringify(written)} `
      + `debtOutstanding=${await debtIsOutstanding(db, referenceId)}`)

    assert.deepEqual(written, [],
      'THE FINDING, first half: nothing may be written for a connector that stopped being serviced '
      + 'before the insert. Such a row is PENDING for ever and the accounting cron skips it.')
    assert.equal(outcome.queued, false, 'and the caller is told it was not queued')
    assert.equal(await debtIsOutstanding(db, referenceId), true,
      'THE FINDING, second half: the debt is STILL OUTSTANDING. `queued: true` clears the refusal row '
      + '(r4) and the r12 identity rule then reads that row as proof a posting was queued — so an '
      + 'un-processable row does not merely sit there, it discharges a debt that is owed.')
    assertWaitedForHolder(
      'r13 facade (unpinned): the enqueue waited under the selection lock',
      parked, switched.releasedAt, enqueueDoneAt,
      'so its verdict was NOT taken under the selection lock — observed, so "it refused" cannot be a '
      + 'pooled read that happened to land late',
    )
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

    let queued: boolean | null = null
    const { switched, enqueueDoneAt, parked } = await raceEnqueueBehindSwitch(
      db, lockIntegrationPluginSelection, 'r13 tx (unpinned)',
      async () => {
        await db.$transaction(async (tx) => {
          queued = await queueAccountingSyncTx(tx, {
            type: 'ALLOCATION_REVERSAL',
            referenceType: REFERENCE_TYPE,
            referenceId,
            payload: payloadFor(referenceId),
            chartConnector: 'xero',
          })
        }, TX)
      },
    )

    const written = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { connector: true, status: true } })
    console.log(`[r13 tx] queued=${queued} elapsed=${enqueueDoneAt - switched.releasedAt}ms-after-release rows=${JSON.stringify(written)} `
      + `debtOutstanding=${await debtIsOutstanding(db, referenceId)}`)

    assert.deepEqual(written, [],
      'the in-transaction enqueue has the same gap — its locked check ran only when `params.connector` '
      + 'was set — and the same consequence: a row for an unserviced connector.')
    assert.equal(queued, false, 'and the boolean the caller acts on says nothing was queued')
    assert.equal(await debtIsOutstanding(db, referenceId), true, 'so the debt is kept')
    assertWaitedForHolder(
      'r13 tx (unpinned): the caller\'s transaction waited under the selection lock',
      parked, switched.releasedAt, enqueueDoneAt,
      'so its verdict was not taken under the selection lock',
    )
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
