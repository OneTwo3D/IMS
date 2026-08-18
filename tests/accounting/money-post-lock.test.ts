import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-0m56 round 4, Codex CRITICAL #2 — the lock the money post is actually made under.
 *
 * The fence's own tests drive an injected double, which proves the FENCE serializes. These prove
 * the thing that double stands for: that the real lock is the shared connection-pinned
 * `pg_try_advisory_lock`, taken in the money-post namespace on the document's scope, that it
 * refuses rather than waits, and that it is released however the run leaves. A leaked lock here
 * would make one document unpayable until the process restarted.
 */

type Acquisition = { key: number; namespace: number | undefined }
const acquisitions: Acquisition[] = []
const releases: string[] = []
let grantLock = true
let lostAfterAcquire = false

mock.module('@/lib/db/pinned-advisory-lock', {
  namedExports: {
    AdvisoryLockLostError: class AdvisoryLockLostError extends Error {},
    acquirePinnedAdvisoryLockOrNull: async (key: number, namespace?: number) => {
      acquisitions.push({ key, namespace })
      if (!grantLock) return null
      return {
        get lost() { return lostAfterAcquire },
        assertHeld(context?: string) {
          if (lostAfterAcquire) throw new Error(`Advisory lock was lost before ${context}`)
        },
        async release() { releases.push('released') },
      }
    },
  },
})

const load = async () => await import('@/lib/domain/accounting/money-post-lock')

const SCOPE = { connector: 'xero', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1' }

function reset() {
  acquisitions.length = 0
  releases.length = 0
  grantLock = true
  lostAfterAcquire = false
}

test('the money-post lock is taken in its OWN namespace, on the document scope (o3d-0m56 r4)', async () => {
  // Its own namespace on purpose: sharing the follow-up scope lock's would put every enqueue
  // TRANSACTION behind this lock's HTTP calls, which is longer than Prisma's transaction timeout —
  // the enqueue would not merely wait, it would abort.
  reset()
  const { withMoneyPostLock } = await load()
  const { ACCOUNTING_MONEY_POST_LOCK_NAMESPACE, ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE } = await import('@/lib/db/advisory-locks')
  const { followUpScopeLockId } = await import('@/lib/domain/accounting/followup-scope-lock')

  const outcome = await withMoneyPostLock(SCOPE, async () => 'posted')

  assert.deepEqual(outcome, { locked: true, result: 'posted' })
  assert.deepEqual(acquisitions, [{
    key: followUpScopeLockId(SCOPE),
    namespace: ACCOUNTING_MONEY_POST_LOCK_NAMESPACE,
  }], 'keyed on the same scope the fence judges contenders in')
  assert.notEqual(ACCOUNTING_MONEY_POST_LOCK_NAMESPACE, ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE)
  assert.deepEqual(releases, ['released'])
})

test('a contended lock refuses immediately and runs nothing (o3d-0m56 r4)', async () => {
  // Waiting would only arrive at a ledger read that refuses. Refusing now returns the row to the
  // ordinary retry path, where it re-probes once the holder's payment is readable — and it means
  // nothing ever BLOCKS on this lock, so a holder needing a pooled connection cannot deadlock
  // against a queue of waiters.
  reset()
  grantLock = false
  const ran: string[] = []
  const outcome = await (await load()).withMoneyPostLock(SCOPE, async () => { ran.push('post'); return 'x' })

  assert.deepEqual(outcome, { locked: false })
  assert.deepEqual(ran, [], 'the holder is posting to this very document right now')
  assert.deepEqual(releases, [], 'and nothing is released that was never taken')
})

test('the lock is released when the run throws (o3d-0m56 r4)', async () => {
  reset()
  await assert.rejects(
    (await load()).withMoneyPostLock(SCOPE, async () => { throw new Error('Xero exploded') }),
    /Xero exploded/,
  )
  assert.deepEqual(releases, ['released'], 'however the run leaves, the lock does not stay held')
})

test('a run can tell the lock has been LOST under it (o3d-0m56 r4)', async () => {
  // PostgreSQL frees a session advisory lock the instant its connection dies. The run is handed
  // the lock, not a bare callback, precisely so the money post can check that before it calls.
  reset()
  lostAfterAcquire = true
  await assert.rejects(
    (await load()).withMoneyPostLock(SCOPE, async (held) => { held.assertHeld('posting'); return 'x' }),
    /Advisory lock was lost/,
  )
  assert.deepEqual(releases, ['released'])
})

test('two documents take two different locks (o3d-0m56 r4)', async () => {
  // Per document, deliberately: a lock coarse enough to serialize the whole connector would be a
  // throughput bug wearing a safety badge.
  const { followUpScopeLockId } = await import('@/lib/domain/accounting/followup-scope-lock')
  assert.notEqual(followUpScopeLockId(SCOPE), followUpScopeLockId({ ...SCOPE, referenceId: 'so-2' }))
  assert.notEqual(followUpScopeLockId(SCOPE), followUpScopeLockId({ ...SCOPE, type: 'BILL_PAYMENT' }))
  assert.notEqual(followUpScopeLockId(SCOPE), followUpScopeLockId({ ...SCOPE, connector: 'quickbooks' }))
})
