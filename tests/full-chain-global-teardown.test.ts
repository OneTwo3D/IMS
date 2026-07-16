import assert from 'node:assert/strict'
import test from 'node:test'

import { runTeardown, type TeardownDeps } from '@/e2e/full-chain/harness/global-teardown'

/**
 * Teardown must FAIL THE RUN when cleanup does not hold (o3d-0qk) — it used to catch
 * everything and only warn, so Playwright exited 0 with the shared Demo ledger still
 * polluted, and X-02 asserts against that ledger being clean.
 *
 * But the ORDER matters more than the failure. Releasing the quiesce lock has to happen
 * BEFORE anything throws: a polluted ledger costs a manual void, whereas a held lock leaves
 * STAGE DISABLED — not importing Woo orders, not posting to Xero — until a human notices.
 * Reporting a fault must never cost more than the fault itself. These exist to stop a future
 * "just throw early" tidy-up quietly trading the cheap failure for the expensive one.
 */

function deps(over: Partial<TeardownDeps> = {}): TeardownDeps {
  return {
    cancelPendingQueue: async () => [],
    voidTrackedDocuments: async () => ({ voided: 1, failed: [] }),
    findStragglers: async () => [],
    release: async () => {},
    ...over,
  }
}

test('teardown passes cleanly when nothing is left behind', async () => {
  let released = false
  await runTeardown(deps({ release: async () => { released = true } }))
  assert.equal(released, true)
})

test('teardown FAILS the run when a Xero document could not be voided', async () => {
  // The Phase 2b case: a POSTED manual journal stranded because the void sent DELETED,
  // which only a DRAFT accepts — and the run still went green.
  let released = false
  await assert.rejects(
    runTeardown(deps({
      voidTrackedDocuments: async () => ({ voided: 2, failed: ['ManualJournals/abc (PP-01 receipt): cannot be applied'] }),
      release: async () => { released = true },
    })),
    /could NOT be voided/,
    'a polluted shared ledger must not exit 0',
  )
  assert.equal(released, true, 'the lock must still be released even as teardown fails')
})

test('teardown releases the quiesce lock BEFORE throwing', async () => {
  // The asymmetry that drives the whole ordering: never leave stage disabled in order to
  // report a lesser fault.
  const order: string[] = []
  await runTeardown(deps({
    voidTrackedDocuments: async () => ({ voided: 0, failed: ['Invoices/xyz: nope'] }),
    release: async () => { order.push('release') },
  })).catch(() => order.push('throw'))
  assert.deepEqual(order, ['release', 'throw'], 'release must come first — a held lock is worse than a dirty ledger')
})

test('teardown FAILS when voiding throws outright, and still releases', async () => {
  let released = false
  await assert.rejects(
    runTeardown(deps({
      voidTrackedDocuments: async () => { throw new Error('Xero unreachable') },
      release: async () => { released = true },
    })),
    /Xero unreachable/,
  )
  assert.equal(released, true)
})

test('a REJECTING cancelPendingQueue still releases the lock', async () => {
  // THE CATASTROPHE (caught by Codex review of PR #489, not by these tests — they only ever
  // modelled a resolved problem array, so the gap was invisible). db.connect() sat outside
  // cancelPendingQueue's try, so an unreachable Postgres threw straight past release() and
  // left STAGE DISABLED indefinitely: the precise failure the ordering exists to prevent.
  // Nothing before release() may abort runTeardown, whatever a dependency does.
  let released = false
  await assert.rejects(
    runTeardown(deps({
      cancelPendingQueue: async () => { throw new Error('ECONNREFUSED: postgres is down') },
      release: async () => { released = true },
    })),
    /ECONNREFUSED/,
  )
  assert.equal(released, true, 'stage must NEVER be left disabled because the queue check blew up')
})

test('teardown FAILS when the sync queue could not be cleared', async () => {
  await assert.rejects(
    runTeardown(deps({ cancelPendingQueue: async () => ['could not clear the Xero sync queue: connection refused'] })),
    /could not clear the Xero sync queue/,
  )
})

test('stragglers from EARLIER runs warn but do not fail this run', async () => {
  // Somebody else's mess by definition. Failing on them would paint every future run red
  // until a human intervened, punishing the next person for a fault they did not cause —
  // which is exactly how a signal gets routinely ignored. This run answers for this run.
  await runTeardown(deps({ findStragglers: async () => ['Invoices/old-one (E2E-FC-abc)'] }))
})

test('a lock-release failure rethrows the original error, keeping its stack', async () => {
  // When the lock is the ONLY fault, the operator needs the real error rather than a
  // summary wrapper — that message is what tells them stage is still disabled.
  const boom = new Error('stage settings write refused')
  await assert.rejects(
    runTeardown(deps({ release: async () => { throw boom } })),
    (e: unknown) => e === boom,
    'the original error object must survive',
  )
})

test('a lock-release failure is reported ALONGSIDE other faults, not instead of them', async () => {
  // Two faults must not mask each other: the aggregate has to name both.
  await assert.rejects(
    runTeardown(deps({
      voidTrackedDocuments: async () => ({ voided: 0, failed: ['Invoices/xyz: nope'] }),
      release: async () => { throw new Error('stage settings write refused') },
    })),
    (e: unknown) => {
      const m = (e as Error).message
      assert.match(m, /could NOT be voided/, 'the ledger fault must be reported')
      assert.match(m, /STAGE IS STILL DISABLED/, 'the lock fault must be reported')
      return true
    },
  )
})

test('a HANGING Xero clean-up still releases the lock, on time', async () => {
  // THE 42-MINUTE INCIDENT. Ordering alone was not enough: release ran LAST, so it waited on the
  // void, and the void waits on Xero. When the Demo tenant rate-limited us its client slept on
  // Retry-After (the daily 5,000-call cap can return hours) and stage sat DISABLED the whole
  // time — the exact catastrophe the ordering exists to prevent, by a route the ordering does
  // not cover.
  //
  // A document left in the ledger is a manual void at someone's leisure; a held lock is a
  // production stoppage. So the clean-up gets a budget and the lock is freed regardless.
  let released = false
  const started = Date.now()
  await assert.rejects(
    runTeardown(deps({
      voidTrackedDocuments: () => new Promise(() => {}), // never settles, like a long Retry-After
      release: async () => { released = true },
      budgets: { voidMs: 50 }, // the real budget is 90s; no need to sit through it here
    })),
    /ABANDONED so that stage could be released/,
    'an abandoned clean-up must FAIL the run — it is still residue in a shared ledger',
  )
  assert.equal(released, true, 'stage must be freed even though Xero never answered')
  assert.ok(Date.now() - started < 5_000, 'and freed on the budget, not on Xero\'s schedule')
})

test('a HANGING straggler scan does not delay the release either', async () => {
  // Diagnostics are the least important thing here and must never hold the lock. Unlike the void,
  // an abandoned straggler scan is NOT a failure: it reports other runs' mess, which this run
  // does not answer for.
  let released = false
  await runTeardown(deps({
    findStragglers: () => new Promise(() => {}),
    release: async () => { released = true },
    budgets: { stragglerMs: 50 },
  }))
  assert.equal(released, true)
})
