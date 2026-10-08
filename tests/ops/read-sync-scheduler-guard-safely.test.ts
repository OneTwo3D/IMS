import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/** The bounded starter the cron route calls: never rejects, bounded, re-entrancy safe. */
mock.module('@/lib/ops/read-sync-liveness-alarm', {
  namedExports: { liveAlarmDelivery: async () => { throw new Error('database unreachable') }, claimBreachAndDeliver: async () => false },
})

async function guard() { return import('../../lib/ops/read-sync-scheduler-guard.ts') }

test('[safely] a guard failure is logged and swallowed', async () => {
  const { runSchedulerCoverageGuardSafely } = await guard()
  const result = await runSchedulerCoverageGuardSafely()
  console.log(`precondition: ${JSON.stringify(result)}`)
  assert.deepEqual(result, { status: 'FAILED', problems: [] })
})

test('[start] a rejecting run resolves FAILED, never rejects', async () => {
  const { startSchedulerCoverageGuard, resetSchedulerCoverageGuardForTests } = await guard()
  resetSchedulerCoverageGuardForTests()
  const result = await startSchedulerCoverageGuard({ run: async () => { throw new Error('boom') } })
  assert.equal(result.status, 'FAILED')
})

test('[start] the DEFAULT ceiling resolves a hung run as TIMED_OUT (fake timers)', async () => {
  const { startSchedulerCoverageGuard, resetSchedulerCoverageGuardForTests, SCHEDULER_GUARD_CEILING_MS } = await guard()
  resetSchedulerCoverageGuardForTests()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = startSchedulerCoverageGuard({ run: () => new Promise(() => undefined) })
    mock.timers.tick(29_999) // the documented 30 s default, spelled out so changing the constant is noticed
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve()
    assert.equal(settled, false, 'not before the default ceiling')
    mock.timers.tick(1)
    const result = await pending
    console.log(`precondition: default ceiling ${SCHEDULER_GUARD_CEILING_MS}ms -> ${result.status}`)
    assert.equal(SCHEDULER_GUARD_CEILING_MS, 30_000)
    assert.equal(result.status, 'TIMED_OUT')
  } finally {
    mock.timers.reset()
  }
})

test('[start] a stalled dependency cannot collect stacked runs: the mark outlives the ceiling until the work settles or the hard expiry', async () => {
  const { startSchedulerCoverageGuard, resetSchedulerCoverageGuardForTests } = await guard()
  resetSchedulerCoverageGuardForTests()
  let now = 0
  let runs = 0
  let release!: () => void
  const hung = new Promise<void>((resolve) => { release = resolve })
  const stalled = () => { runs += 1; return hung.then(() => ({ status: 'OK' as const, problems: [] })) }
  const first = await startSchedulerCoverageGuard({ run: stalled, ceilingMs: 50, monotonicNow: () => now, unrefTimers: false })
  assert.equal(first.status, 'TIMED_OUT')
  for (let i = 0; i < 4; i += 1) {
    now += 15 * 60_000 // four more 15-minute invocations (one hour is the expiry, so stop short of it)
    if (now >= 60 * 60_000) break
    const again = await startSchedulerCoverageGuard({ run: stalled, ceilingMs: 50, monotonicNow: () => now, unrefTimers: false })
    assert.equal(again.status, 'SKIPPED_IN_FLIGHT', `invocation ${i + 2} must not stack`)
  }
  console.log(`precondition: runs started against the stalled dependency = ${runs}`)
  assert.equal(runs, 1)
  now = 60 * 60_000 // the hard monotonic expiry writes the stuck run off
  const afterExpiry = await startSchedulerCoverageGuard({ run: async () => ({ status: 'OK', problems: [] }), monotonicNow: () => now })
  assert.equal(afterExpiry.status, 'OK')
  release()
})

test('[start] the mark is released as soon as the work really settles', async () => {
  const { startSchedulerCoverageGuard, resetSchedulerCoverageGuardForTests } = await guard()
  resetSchedulerCoverageGuardForTests()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const slow = await startSchedulerCoverageGuard({ run: async () => { await gate; return { status: 'OK', problems: [] } }, ceilingMs: 20, unrefTimers: false })
  assert.equal(slow.status, 'TIMED_OUT')
  assert.equal((await startSchedulerCoverageGuard({ run: async () => ({ status: 'OK', problems: [] }) })).status, 'SKIPPED_IN_FLIGHT')
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await startSchedulerCoverageGuard({ run: async () => ({ status: 'OK', problems: [] }) })).status, 'OK')
})

test('[start] overlapping invocations do not stack: the second starts nothing', async () => {
  const { startSchedulerCoverageGuard, resetSchedulerCoverageGuardForTests } = await guard()
  resetSchedulerCoverageGuardForTests()
  let runs = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const first = startSchedulerCoverageGuard({ run: async () => { runs += 1; await gate; return { status: 'OK', problems: [] } } })
  const second = await startSchedulerCoverageGuard({ run: async () => { runs += 1; return { status: 'OK', problems: [] } } })
  console.log(`precondition: second status=${second.status} runs=${runs}`)
  assert.equal(second.status, 'SKIPPED_IN_FLIGHT')
  assert.equal(runs, 1)
  release()
  assert.equal((await first).status, 'OK')
  const third = await startSchedulerCoverageGuard({ run: async () => { runs += 1; return { status: 'OK', problems: [] } } })
  assert.equal(third.status, 'OK', 'released when the first settled')
  assert.equal(runs, 2)
})
