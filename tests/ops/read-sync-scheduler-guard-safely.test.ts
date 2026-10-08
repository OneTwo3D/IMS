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

test('[start] a hung run is abandoned at the ceiling and a later run may start', async () => {
  const { startSchedulerCoverageGuard, resetSchedulerCoverageGuardForTests } = await guard()
  resetSchedulerCoverageGuardForTests()
  const startedAt = Date.now()
  const result = await startSchedulerCoverageGuard({ run: () => new Promise(() => undefined), ceilingMs: 100 })
  console.log(`precondition: hung run resolved ${result.status} after ${Date.now() - startedAt}ms`)
  assert.equal(result.status, 'TIMED_OUT')
  const next = await startSchedulerCoverageGuard({ run: async () => ({ status: 'OK', problems: [] }) })
  assert.equal(next.status, 'OK', 'the in-flight mark was released at the ceiling')
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
