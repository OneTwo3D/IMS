import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-zvec.14: when Mintsoft merges orders and MORE THAN ONE of them charged the customer postage, an IMS operator sees a
 * possible double postage on Sync > Exceptions and clears it by hand. IMS never refunds automatically, and (the warehouse does not
 * read notes) writes no Mintsoft comment and raises no warehouse task for it.
 *
 * Offline: the decision is pure and the clear action runs against doubles. The rows themselves are in tests/db/wms-double-postage-flag.test.ts.
 */

type Row = Record<string, unknown>

const state = {
  link: null as Row | null,
  updates: [] as Array<{ where: Row; data: Row }>,
  activity: [] as Row[],
  permissionAsked: [] as string[],
  freshFailure: null as Row | null,
  claimCount: 1,
  auditFails: false,
  pendingActivity: [] as Row[],
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshPermission: async (permission: string) => {
      state.permissionAsked.push(`fresh:${permission}`)
      if (state.freshFailure) throw new Error('FRESH_AUTH_REQUIRED')
      return { user: { id: 'user-1', email: 'ops@example.com' } }
    },
    requirePermission: async (permission: string) => {
      state.permissionAsked.push(`plain:${permission}`)
      return { user: { id: 'user-1', email: 'ops@example.com' } }
    },
    freshAuthFailureResult: (error: unknown) => (error instanceof Error && error.message === 'FRESH_AUTH_REQUIRED' ? { success: false, error: 'Sign in again', freshAuthRequired: true } : null),
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Row) => { state.activity.push(entry) },
    logActivityInTransaction: async (_tx: unknown, entry: Row) => {
      if (state.auditFails) throw new Error('audit write failed')
      state.pendingActivity.push(entry)
    },
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsOrderPushLink: { findUnique: async () => state.link },
      // A transaction that COMMITS (updates + audit rows) only if the callback resolves, as the real one does.
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const stagedUpdates: Array<{ where: Row; data: Row }> = []
        state.pendingActivity = []
        const result = await fn({
          wmsOrderPushLink: {
            updateMany: async (args: { where: Row; data: Row }) => {
              stagedUpdates.push(args)
              return { count: state.claimCount }
            },
          },
        })
        state.updates.push(...stagedUpdates)
        state.activity.push(...state.pendingActivity)
        return result
      },
    },
  },
})

function reset() {
  state.link = {
    doublePostageAt: new Date('2026-11-16T10:00:00Z'),
    doublePostageDetail: 'two orders charged postage',
    externalOrderNumber: 'A+B',
    connector: 'mintsoft',
  }
  state.updates = []
  state.activity = []
  state.permissionAsked = []
  state.freshFailure = null
  state.claimCount = 1
  state.auditFails = false
  state.pendingActivity = []
}

const order = (id: string, shipping: string, status = 'PROCESSING') => ({
  id, orderNumber: `IMS-${id}`, externalOrderNumber: id, currency: 'GBP', shippingForeign: shipping, status,
})

test('o3d-zvec.14: two orders that both charged postage raise the flag, naming both and the amounts', async () => {
  const { decideDoublePostage } = await import('@/lib/domain/wms/double-postage')
  const a = order('1001', '4.95')
  const b = order('1002', '4.9500')
  const decision = decideDoublePostage(b, [a, b], 'A+B')
  assert.equal(decision.raise, true)
  if (decision.raise) {
    assert.match(decision.detail, /#1001 \(GBP 4\.95\)/)
    assert.match(decision.detail, /#1002 \(GBP 4\.95\)/)
    assert.match(decision.detail, /does not refund automatically/)
  }
})

test('o3d-zvec.14: acceptance: raised ONLY when more than one order paid postage above zero', async () => {
  const { decideDoublePostage } = await import('@/lib/domain/wms/double-postage')
  const paid = order('1001', '4.95')
  const free = order('1002', '0')
  assert.deepEqual(decideDoublePostage(paid, [paid, free], 'A+B'), { raise: false }, 'one payer is not a double charge')
  assert.deepEqual(decideDoublePostage(free, [paid, free], 'A+B'), { raise: false }, 'the order that paid nothing is never flagged')
  const cancelledPayer = order('1003', '4.95', 'CANCELLED')
  assert.deepEqual(decideDoublePostage(paid, [paid, cancelledPayer], 'A+B'), { raise: false }, 'a cancelled order is not charging anyone')
  assert.deepEqual(decideDoublePostage(paid, [paid], null), { raise: false }, 'a group of one is not a merge')
  assert.equal(decideDoublePostage(paid, [paid, order('1004', '3.50'), free], 'A+B+C').raise, true, 'three orders, two payers')
})

test('o3d-zvec.14: Clear needs the sync permission AND a fresh sign-in, clears the flag once, and audits it', async () => {
  reset()
  const { clearDoublePostageFlag } = await import('@/app/actions/sync-exceptions')
  const result = await clearDoublePostageFlag('so-2')
  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.permissionAsked, ['fresh:sync'])
  assert.equal(state.updates.length, 1)
  assert.deepEqual(state.updates[0].data, { doublePostageAt: null, doublePostageDetail: null })
  assert.equal(state.activity.length, 1)
  assert.equal(state.activity[0].action, 'wms_double_postage_cleared')
  assert.equal(state.activity[0].entityId, 'so-2')
  assert.equal((state.activity[0].metadata as Row).userId, 'user-1')
  assert.equal((state.activity[0].metadata as Row).detail, 'two orders charged postage')
})

test('o3d-zvec.14: Clear without a fresh sign-in writes nothing and audits nothing', async () => {
  reset()
  state.freshFailure = { fresh: true }
  const { clearDoublePostageFlag } = await import('@/app/actions/sync-exceptions')
  const result = await clearDoublePostageFlag('so-2')
  assert.equal(result.success, false)
  assert.deepEqual(state.updates, [])
  assert.deepEqual(state.activity, [])
})

test('o3d-zvec.14: clearing a flag that is already gone (or lost to another operator) audits nothing', async () => {
  reset()
  const { clearDoublePostageFlag } = await import('@/app/actions/sync-exceptions')
  state.link = { ...(state.link as Row), doublePostageAt: null }
  assert.equal((await clearDoublePostageFlag('so-2')).success, false)
  assert.deepEqual(state.updates, [])
  reset()
  state.claimCount = 0
  assert.equal((await clearDoublePostageFlag('so-2')).success, false, 'compare-and-set lost the race')
  assert.deepEqual(state.activity, [])
})

test('o3d-zvec.14: the clear and its audit row are ONE transaction: an audit that cannot be written leaves the flag standing', async () => {
  reset()
  state.auditFails = true
  const { clearDoublePostageFlag } = await import('@/app/actions/sync-exceptions')
  await assert.rejects(() => clearDoublePostageFlag('so-2'), /audit write failed/)
  assert.deepEqual(state.updates, [], 'the clear rolled back with the audit')
  assert.deepEqual(state.activity, [])
})
