/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/** The bounded starter the cron route calls: never rejects, bounded, re-entrancy safe. */
mock.module('@/lib/ops/read-sync-liveness-alarm', {
  namedExports: {
    liveAlarmDelivery: async () => { throw new Error('database unreachable') },
    withStatementTimeout: async (db: { $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T> }, _ms: number, fn: (tx: unknown) => Promise<unknown>) => db.$transaction(fn),
    // The real claim's contract, reduced: insert-if-absent or conditional update decides delivery.
    claimBreachAndDeliver: async (deps: { db: { $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> }; notifyAdmins: (...a: unknown[]) => Promise<void> }, claim: { stampKey: string; prior: string | undefined; breachKey: string; alert: { title: string; message: string } }) =>
      deps.db.$transaction(async (tx) => {
        const claimed = claim.prior === undefined
          ? await tx.setting.createMany({ data: [{ key: claim.stampKey, value: claim.breachKey }], skipDuplicates: true })
          : await tx.setting.updateMany({ where: { key: claim.stampKey, value: claim.prior }, data: { value: claim.breachKey } })
        if (claimed.count !== 1) return false
        await deps.notifyAdmins(tx, claim.alert.title, claim.alert.message, '/sync')
        return true
      }),
  },
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

test('[cap] a never-settling run plus many invocations across the hard expiry never exceeds the outstanding cap; one stalled warning per episode; a settled run frees a slot', async () => {
  const { startSchedulerCoverageGuard, resetSchedulerCoverageGuardForTests, SCHEDULER_GUARD_MAX_OUTSTANDING, SCHEDULER_GUARD_HARD_EXPIRY_MS } = await guard()
  resetSchedulerCoverageGuardForTests()
  assert.equal(SCHEDULER_GUARD_MAX_OUTSTANDING, 2)
  let now = 0
  let started = 0
  let reports = 0
  const releases: Array<() => void> = []
  const stalled = () => { started += 1; return new Promise<{ status: 'OK'; problems: string[] }>((resolve) => { releases.push(() => resolve({ status: 'OK', problems: [] })) }) }
  const options = () => ({ run: stalled, onStalled: async () => { reports += 1 }, ceilingMs: 20, unrefTimers: false, monotonicNow: () => now })
  const statuses: string[] = []
  for (let i = 0; i < 10; i += 1) {
    now = i * (SCHEDULER_GUARD_HARD_EXPIRY_MS + 1) // every invocation lands after the previous mark's hard expiry
    statuses.push((await startSchedulerCoverageGuard(options())).status)
  }
  console.log(`precondition: statuses=${JSON.stringify(statuses)} started=${started} stalledReports=${reports}`)
  assert.equal(started, SCHEDULER_GUARD_MAX_OUTSTANDING, 'the expiry alone cannot accumulate work: outstanding never exceeds the cap')
  assert.deepEqual(statuses.slice(0, 2), ['TIMED_OUT', 'TIMED_OUT'])
  assert.ok(statuses.slice(2).every((status) => status === 'SKIPPED_STALLED'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(reports, 1, 'ONE warning for the whole stall episode')

  // A run that really settles frees a slot.
  releases[0]!()
  await new Promise((resolve) => setTimeout(resolve, 5))
  now += SCHEDULER_GUARD_HARD_EXPIRY_MS + 1
  const next = await startSchedulerCoverageGuard({ ...options(), run: async () => { started += 1; return { status: 'OK', problems: [] } } })
  assert.equal(next.status, 'OK')
  assert.equal(started, 3)
  releases[1]!()
  await new Promise((resolve) => setTimeout(resolve, 5))
})

test('[cap] the stalled warning is deduplicated through the claim (reportSchedulerGuardStalled)', async () => {
  const { reportSchedulerGuardStalled } = await guard()
  const settings = new Map<string, string>()
  const delivered: string[] = []
  const tx = {
    $executeRawUnsafe: async () => undefined,
    setting: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.filter((k) => settings.has(k)).map((key) => ({ key, value: settings.get(key)! })),
      deleteMany: async () => undefined,
      createMany: async ({ data }: { data: Array<{ key: string; value: string }> }) => { let count = 0; for (const r of data) if (!settings.has(r.key)) { settings.set(r.key, r.value); count += 1 } return { count } },
      updateMany: async ({ where, data }: { where: { key: string; value: string }; data: { value: string } }) => { if (settings.get(where.key) !== where.value) return { count: 0 }; settings.set(where.key, data.value); return { count: 1 } },
    },
  }
  const deps = {
    db: { setting: {} as never, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) } as never,
    notifyAdmins: async (_t: unknown, title: string, message: string) => { delivered.push(`${title}|${message}`) },
    logWarning: async () => undefined,
  }
  assert.equal(await reportSchedulerGuardStalled(deps), 'ALERTED')
  assert.equal(await reportSchedulerGuardStalled(deps), 'ALREADY_ALERTED')
  assert.equal(delivered.length, 1)
  assert.match(delivered[0]!, /may not be verified/)
  assert.match(delivered[0]!, /read-sync:status/)
})
