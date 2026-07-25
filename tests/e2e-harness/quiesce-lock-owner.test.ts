import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import test from 'node:test'

import {
  claimLock, isLockOwnerAlive, lockRecoveryDecision, LEASE_TTL_MS, LOCK_STALE_AFTER_MS,
  type LockRecord, type LockStore,
} from '../../e2e/full-chain/harness/quiesce.ts'

/**
 * The quiesce lock is the isolation mechanism the whole full-chain tier rests on: one Woo store, one Xero
 * Demo org, one rig database, shared with stage. Two invocations running at once corrupt both. These
 * exercise the three properties that make "one at a time" ENFORCED rather than assumed (o3d-lgo.14):
 * ownership, atomic claim, and a renewed lease.
 */

// --- liveness ----------------------------------------------------------------

test('a live process on THIS host is reported alive — the lock must not be stolen', () => {
  // This test IS a live process, so its own pid is the clearest possible "alive" case.
  assert.equal(isLockOwnerAlive({ ownerPid: process.pid, ownerHost: hostname() }), true)
})

test('a dead pid on THIS host is reported dead — safe to recover immediately', () => {
  // pid 2^22 is above the default pid_max on Linux, so it cannot be running.
  assert.equal(isLockOwnerAlive({ ownerPid: 4_194_304, ownerHost: hostname() }), false)
})

test('an owner on ANOTHER host is UNKNOWABLE, not assumed dead', () => {
  // Guessing "dead" here is what would let a second machine steal a live lock; the caller falls back to
  // the lease.
  assert.equal(isLockOwnerAlive({ ownerPid: process.pid, ownerHost: `${hostname()}-somewhere-else` }), null)
})

test('a lock written by an older build (no owner recorded) is UNKNOWABLE, not assumed dead', () => {
  assert.equal(isLockOwnerAlive({}), null)
  assert.equal(isLockOwnerAlive({ ownerPid: process.pid }), null)
  assert.equal(isLockOwnerAlive({ ownerHost: hostname() }), null)
})

// --- the recovery decision ---------------------------------------------------

const NOW = Date.parse('2026-07-25T12:00:00.000Z')

function lockAt(over: Partial<LockRecord> = {}): LockRecord {
  return {
    takenAt: new Date(NOW - 60_000).toISOString(),
    runId: 'E2E-FC-test',
    stageSettings: { wc_sync_enabled: 'true' },
    e2eSettings: { wc_sync_enabled: 'false' },
    createdWebhookIds: [],
    token: 'tok-1',
    ...over,
  }
}

test('a live pid on this host is HELD even when its lease has lapsed', () => {
  // Hung is not dead. The process may still be driving the shared Woo store, so recovering the lock from
  // under it is the corruption this guards against — killing it is the operator's call, not ours.
  const d = lockRecoveryDecision(
    lockAt({ ownerPid: process.pid, ownerHost: hostname(), heartbeatAt: new Date(NOW - 10 * LEASE_TTL_MS).toISOString() }),
    NOW,
  )
  assert.equal(d.action, 'held')
})

test('a dead pid on this host is recovered at once, without waiting out the lease', () => {
  const d = lockRecoveryDecision(
    lockAt({ ownerPid: 4_194_304, ownerHost: hostname(), heartbeatAt: new Date(NOW - 1_000).toISOString() }),
    NOW,
  )
  assert.equal(d.action, 'recover')
})

test('a HEALTHY run on another host is never stolen, however long it has been going', () => {
  // The bug this replaced: liveness is unknowable across hosts, so recovery fell back to takenAt — never
  // renewed — and a fixed 45-minute window would steal a legitimate long run. This suite is one worker
  // over dozens of tests with timeouts up to 30 minutes, so "long" is normal.
  const d = lockRecoveryDecision(
    lockAt({
      ownerPid: 1234,
      ownerHost: 'some-other-box',
      takenAt: new Date(NOW - 4 * LOCK_STALE_AFTER_MS).toISOString(), // hours old…
      heartbeatAt: new Date(NOW - 5_000).toISOString(),               // …but renewing right now
    }),
    NOW,
  )
  assert.equal(d.action, 'held', 'a renewing lease means a running suite, whatever the age')
})

test('a run on another host that STOPPED renewing is recovered once the lease expires', () => {
  const base = { ownerPid: 1234, ownerHost: 'some-other-box' }
  assert.equal(
    lockRecoveryDecision(lockAt({ ...base, heartbeatAt: new Date(NOW - LEASE_TTL_MS + 5_000).toISOString() }), NOW).action,
    'held',
    'still inside the TTL — it may just be a slow renewal',
  )
  assert.equal(
    lockRecoveryDecision(lockAt({ ...base, heartbeatAt: new Date(NOW - LEASE_TTL_MS - 5_000).toISOString() }), NOW).action,
    'recover',
  )
})

test('a pre-lease lock is judged on age alone, and only after the legacy window', () => {
  // Locks written by an older build carry no heartbeat. They must still be recoverable, or an upgrade
  // could strand stage disabled forever — but not eagerly.
  const legacy = { token: undefined, ownerPid: undefined, ownerHost: undefined }
  assert.equal(lockRecoveryDecision(lockAt({ ...legacy, takenAt: new Date(NOW - 60_000).toISOString() }), NOW).action, 'wait')
  assert.equal(
    lockRecoveryDecision(lockAt({ ...legacy, takenAt: new Date(NOW - LOCK_STALE_AFTER_MS - 60_000).toISOString() }), NOW).action,
    'recover',
  )
})

test('the legacy window is far longer than any legitimate pre-lease hold', () => {
  assert.ok(LOCK_STALE_AFTER_MS >= 30 * 60_000, 'at least 30 minutes')
})

// --- the claim protocol ------------------------------------------------------

/**
 * An in-memory LockStore with exactly the conditional-write semantics of the Postgres one: claim inserts
 * only when absent, the deletes and the write are compare-and-set. That equivalence is what makes these
 * tests meaningful; the real implementation's atomicity is proved separately against a live Postgres in
 * tests/concurrency/quiesce-lock.concurrent.test.ts.
 */
function fakeStore(initial: LockRecord | null = null) {
  let row: string | null = initial ? JSON.stringify(initial) : null
  const store: LockStore = {
    async claim(raw) { if (row !== null) return false; row = raw; return true },
    async read() { return row === null ? null : { raw: row, lock: JSON.parse(row) as LockRecord } },
    async deleteIfUnchanged(expected) { if (row !== expected) return false; row = null; return true },
    async deleteIfOwned(token) {
      if (row === null || (JSON.parse(row) as LockRecord).token !== token) return false
      row = null; return true
    },
    async writeIfOwned(token, raw) {
      if (row === null || (JSON.parse(row) as LockRecord).token !== token) return false
      row = raw; return true
    },
  }
  return {
    store,
    current: () => (row === null ? null : (JSON.parse(row) as LockRecord)),
    put: (lock: LockRecord) => { row = JSON.stringify(lock) },
  }
}

const snapshotOf = (lock: LockRecord) => async () => lock
const neverRecovers = async () => { throw new Error('recover must not be called here') }

test('claimLock takes a free lock', async () => {
  const s = fakeStore()
  const mine = lockAt({ token: 'mine' })
  const got = await claimLock(s.store, snapshotOf(mine), neverRecovers, { now: () => NOW })
  assert.equal(got.lock.token, 'mine')
  assert.equal(s.current()?.token, 'mine')
})

test('claimLock REFUSES a held lock and leaves it completely alone', async () => {
  // The whole point: the second invocation aborts rather than restoring stage under the first.
  const incumbent = lockAt({ token: 'theirs', ownerPid: process.pid, ownerHost: hostname() })
  const s = fakeStore(incumbent)
  await assert.rejects(
    claimLock(s.store, snapshotOf(lockAt({ token: 'mine' })), neverRecovers, { now: () => NOW }),
    /ABORT: the quiesce lock is HELD/,
  )
  assert.equal(s.current()?.token, 'theirs', 'the incumbent lock must be untouched')
})

test('claimLock recovers an abandoned lock and then takes it', async () => {
  const abandoned = lockAt({ token: 'dead', ownerPid: 4_194_304, ownerHost: hostname() })
  const s = fakeStore(abandoned)
  let restoredFrom: string | undefined
  const got = await claimLock(
    s.store,
    snapshotOf(lockAt({ token: 'mine' })),
    async (found) => { restoredFrom = found.lock.token; return s.store.deleteIfUnchanged(found.raw) },
    { now: () => NOW },
  )
  assert.equal(restoredFrom, 'dead', 'stage is restored from the abandoned record before we take over')
  assert.equal(got.lock.token, 'mine')
  assert.equal(s.current()?.token, 'mine')
})

test('two simultaneous invocations: exactly one takes the lock, the other aborts', async () => {
  // Read-then-write let both see no row and both write one, and neither knew the other existed. The claim
  // is a single conditional insert, so the loser cannot help but notice.
  const s = fakeStore()
  const contender = (token: string) => claimLock(
    s.store,
    // Yield first, so both contenders are genuinely in flight when the claims land.
    async () => { await Promise.resolve(); return lockAt({ token, ownerPid: process.pid, ownerHost: hostname() }) },
    neverRecovers,
    { now: () => NOW },
  )
  const results = await Promise.allSettled([contender('a'), contender('b'), contender('c')])
  const won = results.filter((r) => r.status === 'fulfilled')
  assert.equal(won.length, 1, 'exactly one invocation may hold the lock')
  for (const lost of results.filter((r) => r.status === 'rejected')) {
    assert.match((lost as PromiseRejectedResult).reason.message, /ABORT: the quiesce lock is HELD/)
  }
  assert.equal(s.current()?.token, (won[0] as PromiseFulfilledResult<{ lock: LockRecord }>).value.lock.token)
})

test('recovery is compare-and-set: losing the race deletes nobody else’s lock', async () => {
  // Two runs can judge the same abandoned lock at the same moment. Whichever restores second must not
  // delete the row the winner has since written — that would hand the lock to a third party while the
  // winner is running.
  const abandoned = lockAt({ token: 'dead', ownerPid: 4_194_304, ownerHost: hostname() })
  const s = fakeStore(abandoned)
  const winner = lockAt({ token: 'winner', ownerPid: process.pid, ownerHost: hostname() })

  await assert.rejects(
    claimLock(
      s.store,
      snapshotOf(lockAt({ token: 'mine' })),
      async (found) => {
        // Another contender recovers and claims it first, in the window before our delete.
        s.put(winner)
        return s.store.deleteIfUnchanged(found.raw)
      },
      { now: () => NOW },
    ),
    /ABORT: the quiesce lock is HELD/,
    'having lost the recovery race, we must abort rather than steal',
  )
  assert.equal(s.current()?.token, 'winner', 'the winner still holds the lock it claimed')
})

test('claimLock retries when the holder releases as we look, rather than failing', async () => {
  const s = fakeStore(lockAt({ token: 'going', ownerPid: process.pid, ownerHost: hostname() }))
  let attempts = 0
  const snapshot = async () => {
    attempts += 1
    if (attempts === 1) {
      // The holder finishes between our failed claim and the read that would have judged it.
      queueMicrotask(() => { void s.store.deleteIfOwned('going') })
    }
    return lockAt({ token: 'mine' })
  }
  // Drain the queued release before the read happens.
  const got = await claimLock(s.store, async () => { const l = await snapshot(); await Promise.resolve(); return l }, neverRecovers, { now: () => NOW })
  assert.equal(got.lock.token, 'mine')
})

test('claimLock gives up loudly rather than looping forever', async () => {
  // A lock that keeps changing hands is a rig with two runners pointed at it — a configuration problem
  // that must be reported, not absorbed by an infinite retry.
  const s = fakeStore()
  await assert.rejects(
    claimLock(
      s.store,
      // Never actually claimable: something else always slips in.
      async () => { s.put(lockAt({ token: 'other', ownerPid: 4_194_304, ownerHost: hostname() })); return lockAt({ token: 'mine' }) },
      async () => true, // "recovered" but the next snapshot re-creates the squatter
      { attempts: 3, now: () => NOW },
    ),
    /could not take the quiesce lock after 3 attempts/,
  )
})
