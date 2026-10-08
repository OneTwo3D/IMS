import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/** The wrapper the cron route calls must never throw: a failing guard cannot fail delivery-status. */
mock.module('@/lib/ops/read-sync-liveness-alarm', {
  namedExports: { liveAlarmDelivery: async () => { throw new Error('database unreachable') }, claimBreachAndDeliver: async () => false },
})

test('[safely] a guard failure is logged and swallowed', async () => {
  const { runSchedulerCoverageGuardSafely } = await import('../../lib/ops/read-sync-scheduler-guard.ts')
  const result = await runSchedulerCoverageGuardSafely()
  console.log(`precondition: ${JSON.stringify(result)}`)
  assert.deepEqual(result, { status: 'FAILED', problems: [] })
})
