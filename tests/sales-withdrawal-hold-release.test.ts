import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-rbyg r4 (Codex r3 finding 1) — THE GENERATION GUARD WAS BEING SATISFIED BY ITS OWN READ.
 *
 * `releaseWithdrawalHold` has been generation-guarded since o3d-6x66, and the mechanism was right:
 * `withdrawalHoldAt` is deliberately RETAINED across a repair or redelivery, so only the generation
 * can tell a new customer request from the same hold. What it was comparing was the problem — the
 * generation this function had just fetched, against itself. That closes the window between THIS
 * read and THIS write and no other.
 *
 * The window that matters is the one an operator lives in: the page was drawn, they read it and
 * decided, and (in the exception inbox's despatch remedy) a warehouse round trip happened in
 * between. A customer filing a NEW withdrawal inside that window had it cleared by a decision taken
 * before it existed — silently, with an audit line saying a hold was released.
 */

type Row = Record<string, unknown>

const state = {
  order: null as Row | null,
  updateManyArgs: [] as Row[],
  updateManyCount: 1,
  activity: [] as Row[],
}

function reset() {
  state.order = {
    id: 'so-1', orderNumber: 'SO-1', status: 'ON_HOLD',
    withdrawalHoldAt: new Date('2026-08-19T09:00:00.000Z'),
    withdrawalHoldGeneration: 3,
  }
  state.updateManyArgs = []
  state.updateManyCount = 1
  state.activity = []
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requirePermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Row) => { state.activity.push(entry) },
    redactActivityLogText: (value: string) => value,
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async () => state.order,
        // The `where` is RECORDED, because the conditional update is the second half of the guard:
        // the explicit comparison produces the message, this makes the write itself atomic.
        updateMany: async ({ where }: { where: Row }) => {
          state.updateManyArgs.push(where)
          return { count: state.updateManyCount }
        },
      },
    },
  },
})

async function releaseWithdrawalHold(id: string, expected: { generation: number }, note?: string) {
  const mod = await import('../app/actions/sales.ts')
  return mod.releaseWithdrawalHold(id, expected, note)
}

test('o3d-rbyg r4: a hold whose generation matches the caller’s is released', async () => {
  reset()

  const result = await releaseWithdrawalHold('so-1', { generation: 3 }, 'despatched already')

  assert.equal(result.success, true)
  assert.deepEqual(
    state.updateManyArgs,
    [{ id: 'so-1', withdrawalHoldGeneration: 3, withdrawalHoldAt: { not: null } }],
    'and the write is still conditional, so a submission landing between the comparison and the '
      + 'update cannot be overwritten either',
  )
  assert.equal(state.activity[0]?.action, 'withdrawal_hold_released')
  assert.equal((state.activity[0]?.metadata as Row).generation, 3, 'the timeline records WHICH request was released')
})

test('o3d-rbyg r4: a NEWER withdrawal request refuses the release, by name, and clears nothing', async () => {
  reset()
  // The customer filed again while the page was open (or while the warehouse was being asked).
  state.order = { ...state.order, withdrawalHoldGeneration: 4 }

  const result = await releaseWithdrawalHold('so-1', { generation: 3 })

  assert.equal(result.success, false)
  assert.match(String(result.error), /NEWER withdrawal request/)
  assert.match(String(result.error), /request 3 → 4/, 'the operator is told exactly what moved')
  assert.deepEqual(state.updateManyArgs, [], 'nothing was written — the new request stands')
  assert.deepEqual(state.activity, [], 'and no timeline entry claims a hold was released')
})

test('o3d-rbyg r4: the release refuses a generation it cannot identify rather than guessing one', async () => {
  reset()

  const result = await releaseWithdrawalHold('so-1', { generation: Number.NaN })

  assert.equal(result.success, false)
  assert.match(String(result.error), /could not be identified/)
  assert.deepEqual(state.updateManyArgs, [])
})

test('o3d-rbyg r4: an order with no hold is still reported as such, before any generation talk', async () => {
  reset()
  state.order = { ...state.order, withdrawalHoldAt: null }

  const result = await releaseWithdrawalHold('so-1', { generation: 3 })

  assert.equal(result.success, false)
  assert.match(String(result.error), /not under a withdrawal hold/)
})

test('o3d-rbyg r4: a submission landing between the comparison and the write is caught by the conditional update', async () => {
  reset()
  state.updateManyCount = 0

  const result = await releaseWithdrawalHold('so-1', { generation: 3 })

  assert.equal(result.success, false)
  assert.match(String(result.error), /changed while you were looking at it/)
  assert.deepEqual(state.activity, [], 'a release that did not commit must not be logged as one')
})
