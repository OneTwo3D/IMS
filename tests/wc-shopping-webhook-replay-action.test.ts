import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * The exception-inbox Replay for a dead-lettered store webhook delivery: permission-gated (a FRESH
 * login, like the WMS replays), compare-and-set on the original row through the shared builders,
 * and idempotent. The listing and the count read the same drained-connector predicate.
 */

const state = {
  permissions: new Set<string>(['sync']),
  fresh: [] as string[],
  plain: [] as string[],
  updateManyCalls: [] as Array<{ where: unknown; data: unknown }>,
  updateManyCount: 1,
  activity: [] as Array<Record<string, unknown>>,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingWebhookEvent: {
        updateMany: async (args: { where: unknown; data: unknown }) => {
          state.updateManyCalls.push(args)
          return { count: state.updateManyCount }
        },
      },
    },
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      state.plain.push(permission)
      if (!state.permissions.has(permission)) throw new Error(`Forbidden: ${permission}`)
      return { user: { id: 'op-1' } }
    },
    requireFreshPermission: async (permission: string) => {
      state.fresh.push(permission)
      if (!state.permissions.has(permission)) throw new Error(`Forbidden: ${permission}`)
      return { user: { id: 'op-1' } }
    },
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

function reset() {
  state.permissions = new Set(['sync'])
  state.fresh = []
  state.plain = []
  state.updateManyCalls = []
  state.updateManyCount = 1
  state.activity = []
}

test('replay: needs a FRESH sync permission and changes nothing without it', async () => {
  reset()
  state.permissions = new Set()
  const { replayDeadShoppingWebhookEvent } = await import('@/app/actions/sync-exceptions')
  await assert.rejects(() => replayDeadShoppingWebhookEvent('evt-1'))
  assert.deepEqual(state.fresh, ['sync'])
  assert.deepEqual(state.updateManyCalls, [])
})

test('replay: resets the ORIGINAL row through the shared compare-and-set builders and logs it', async () => {
  reset()
  const { replayDeadShoppingWebhookEvent } = await import('@/app/actions/sync-exceptions')
  const { buildDeadShoppingWebhookReplayWhere, buildDeadShoppingWebhookReplayData } = await import('@/lib/domain/shopping-webhook-exception')

  const result = await replayDeadShoppingWebhookEvent('evt-1')

  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.updateManyCalls, [{ where: buildDeadShoppingWebhookReplayWhere('evt-1'), data: buildDeadShoppingWebhookReplayData() }])
  assert.equal(state.activity.length, 1)
  assert.equal(state.activity[0].action, 'shopping_webhook_event_replay')
  assert.deepEqual(state.plain, [], 'the weaker non-fresh permission check is not what gates it')
})

test('replay: a row that is no longer dead-lettered (second click, drained meanwhile) is refused, not re-queued', async () => {
  reset()
  state.updateManyCount = 0
  const { replayDeadShoppingWebhookEvent } = await import('@/app/actions/sync-exceptions')
  const result = await replayDeadShoppingWebhookEvent('evt-1')
  assert.equal(result.success, false)
  assert.deepEqual(state.activity, [])
})

test('the exception inbox counts and lists store dead letters through the one drained-connector predicate', () => {
  const src = readFileSync('app/actions/sync-exceptions.ts', 'utf8')
  assert.match(src, /db\.shoppingWebhookEvent\.count\(\{ where: DEAD_SHOPPING_WEBHOOK_WHERE \}\)/)
  assert.match(src, /db\.shoppingWebhookEvent\.findMany\(\{\s*where: DEAD_SHOPPING_WEBHOOK_WHERE,/)
})
