import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-6ldlj — the manual cancel / hold path's half of the decision: when a durable job is enqueued, when it is
 * NOT, and what the post-commit attempt does. (The real-Postgres half — the enqueue inside the locked
 * transaction, rollback with it, the key per flip — is tests/concurrency/wc-order-status-jobs.concurrent.test.ts.)
 *
 * Doubles: `@/lib/shopping` (records what the helper asked the facade for) and the activity log.
 */

const state = {
  scheduleCalls: [] as Array<Record<string, unknown>>,
  scheduleResult: { operation: 'order.hold', key: 'woocommerce:order.hold:so-1:1' } as { operation: string; key: string } | null,
  processCalls: [] as Array<Record<string, unknown> | undefined>,
  processMode: 'ok' as 'ok' | 'reject' | 'hang',
  activity: [] as Array<Record<string, unknown>>,
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } } })
mock.module('@/lib/shopping', {
  namedExports: {
    scheduleShoppingOrderStatusPush: async (_tx: unknown, input: Record<string, unknown>) => {
      state.scheduleCalls.push(input)
      return state.scheduleResult
    },
    processShoppingOrderStatusPushes: (options?: Record<string, unknown>) => {
      state.processCalls.push(options)
      if (state.processMode === 'reject') return Promise.reject(new Error('database unavailable'))
      if (state.processMode === 'hang') return new Promise(() => {})
      return Promise.resolve({ claimed: 1 })
    },
  },
})

beforeEach(() => {
  state.scheduleCalls.length = 0
  state.processCalls.length = 0
  state.activity.length = 0
  state.scheduleResult = { operation: 'order.hold', key: 'woocommerce:order.hold:so-1:1' }
  state.processMode = 'ok'
})

/** A transaction client that FAILS THE TEST on any use: proves a path touched nothing. */
const untouchable = new Proxy({}, { get: (_target, prop) => { throw new Error(`the transaction client was used (${String(prop)})`) } }) as never

test('o3d-6ldlj (enqueue gate): a transition that does not own the storefront status creates NO row and touches nothing', async () => {
  const { scheduleManualStatusPush } = await import('@/lib/fulfillment/order-status-push')
  let evaluated = 0
  for (const target of ['CANCELLED', 'ON_HOLD'] as const) {
    const ref = await scheduleManualStatusPush(untouchable, { orderId: 'so-1', target, enabled: false })
    assert.equal(ref, null, `${target}: disabled returns no job`)
    evaluated++
  }
  assert.equal(evaluated, 2)
  assert.deepEqual(state.scheduleCalls, [], 'the facade was never asked to schedule anything')
})

test('o3d-6ldlj (enqueue gate): an owning transition asks the facade for a job on the SAME transaction client, stamped with the flip time', async () => {
  const { scheduleManualStatusPush } = await import('@/lib/fulfillment/order-status-push')
  const before = Date.now()
  const ref = await scheduleManualStatusPush({} as never, { orderId: 'so-1', target: 'ON_HOLD', enabled: true })
  assert.deepEqual(ref, state.scheduleResult)
  assert.equal(state.scheduleCalls.length, 1, 'precondition: the facade was reached')
  const call = state.scheduleCalls[0]
  assert.equal(call.orderId, 'so-1')
  assert.equal(call.target, 'ON_HOLD')
  assert.ok(call.flippedAt instanceof Date && call.flippedAt.getTime() >= before, 'flippedAt is now')
  const fixed = new Date(1_760_000_000_000)
  await scheduleManualStatusPush({} as never, { orderId: 'so-2', target: 'CANCELLED', enabled: true, flippedAt: fixed })
  assert.equal(state.scheduleCalls[1].flippedAt, fixed, 'a supplied flip time is used as given')

  state.scheduleResult = null // unlinked order: the facade decides, the helper passes it on
  assert.equal(await scheduleManualStatusPush({} as never, { orderId: 'so-3', target: 'CANCELLED', enabled: true }), null)
})

test('o3d-6ldlj (post-commit attempt): no job means no attempt; a job runs ONE un-awaited attempt on its own key; a failing or hanging attempt cannot fail or block the caller', async () => {
  const { attemptShoppingStatusPushAfterCommit } = await import('@/lib/fulfillment/order-status-push')
  attemptShoppingStatusPushAfterCommit({ orderId: 'so-1', job: null })
  assert.deepEqual(state.processCalls, [], 'no job, no attempt')

  const job = { operation: 'order.hold', key: 'woocommerce:order.hold:so-1:1' } as never
  attemptShoppingStatusPushAfterCommit({ orderId: 'so-1', job })
  assert.equal(state.processCalls.length, 1, 'precondition: the attempt was made')
  assert.deepEqual(state.processCalls[0], { idempotencyKeys: ['woocommerce:order.hold:so-1:1'] })

  state.processMode = 'hang'
  attemptShoppingStatusPushAfterCommit({ orderId: 'so-1', job }) // returns although the attempt never settles
  assert.equal(state.processCalls.length, 2, 'the hanging attempt was started and did not block us')

  state.processMode = 'reject'
  attemptShoppingStatusPushAfterCommit({ orderId: 'so-1', job })
  for (let i = 0; i < 20 && state.activity.length === 0; i++) await new Promise((resolve) => setImmediate(resolve))
  const failed = state.activity.filter((a) => a.action === 'wc_status_push_attempt_failed')
  assert.equal(failed.length, 1, 'a rejected attempt is recorded as a WARNING and not thrown')
  assert.equal(failed[0].level, 'WARNING')
  assert.match(String(failed[0].description), /queued job will be retried/)
})

// ---------------------------------------------------------------------------------------------------------------
// The census: who may create a row. Source-level, because the callers are 'use server' actions that cannot be
// driven here; the behavioural proof for the options they pass is arm 21 of the concurrency file.
// ---------------------------------------------------------------------------------------------------------------

/** Every `applySalesOrderStatusTransition(` CALL in a file, with its balanced argument text. */
function callsOf(path: string): string[] {
  const src = readFileSync(path, 'utf8')
  const calls: string[] = []
  let from = 0
  for (;;) {
    const at = src.indexOf('applySalesOrderStatusTransition(', from)
    if (at < 0) break
    from = at + 1
    const before = src.slice(Math.max(0, at - 9), at)
    if (/function\s*$/.test(before)) continue // the declaration, not a call
    let depth = 0
    let end = at + 'applySalesOrderStatusTransition'.length
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++
      else if (src[end] === ')') { depth--; if (depth === 0) break }
    }
    calls.push(src.slice(at, end + 1))
  }
  return calls
}

test('o3d-6ldlj (census): every WooCommerce-driven caller of the transition passes pushStatusToWooCommerce:false, so none can create a row', () => {
  const files = [
    'lib/connectors/woocommerce/sync/withdrawal.ts',
    'lib/connectors/woocommerce/sync/order-status.ts',
  ]
  let sites = 0
  for (const file of files) {
    const calls = callsOf(file)
    assert.ok(calls.length >= 1, `${file}: precondition — the call sites were found`)
    for (const call of calls) {
      assert.match(call, /pushStatusToWooCommerce:\s*false\b/, `${file}: ${call.slice(0, 80)}`)
      sites++
    }
  }
  assert.equal(sites, 3, `the three WooCommerce-driven call sites (withdrawal hold, withdrawal cancel, order-status sync), found ${sites}`)
  console.log(`census: ${sites} WooCommerce-driven transition call sites all pass pushStatusToWooCommerce:false`)
})

test('o3d-6ldlj (census): the manual action no longer fires an un-awaited, never-retried status push; its two enqueue sites are the cancel and hold', () => {
  const src = readFileSync('app/actions/sales.ts', 'utf8')
  // Absence checks are universal: nothing in this file may push a status directly any more.
  assert.equal(src.includes('pushSalesOrderStatus'), false, 'no direct pushSalesOrderStatus left in sales.ts')
  assert.equal(src.includes('shopping_status_push_failed'), false, 'and no log-and-forget failure path')
  const sites = [...src.matchAll(/scheduleManualStatusPush\([^)]*\{[^}]*target:\s*'([A-Z_]+)'/g)].map((m) => m[1])
  assert.deepEqual(sites.sort(), ['CANCELLED', 'ON_HOLD'], `the enqueue sites, found ${JSON.stringify(sites)}`)
  assert.equal([...src.matchAll(/attemptShoppingStatusPushAfterCommit\(/g)].length, 1, 'one post-commit attempt site')
})
