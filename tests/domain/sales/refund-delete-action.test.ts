import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-ngmt.22 — the authenticated edge of deleting a refund: permission, switch, and the post-commit follow-ups. No database, no network.

const state = {
  allowed: true,
  permissionAsked: [] as string[],
  serviceCalls: [] as Array<Record<string, unknown>>,
  evaluateCalls: [] as string[],
  setting: null as string | null,
  refunds: [{ id: 'r1' }, { id: 'r2' }],
  serviceResult: { success: true, alreadyDeleted: false, orderId: 'o1', creditNoteNumber: 'CN-1', productIds: ['p1'], voidQueued: true, counterJournalQueued: false } as Record<string, unknown>,
  stockSync: [] as unknown[],
  allocate: [] as unknown[],
  activity: [] as Array<Record<string, unknown>>,
  orderStatus: 'PROCESSING',
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => (state.setting === null ? null : { value: state.setting }) },
      salesOrderRefund: { findMany: async () => state.refunds },
      salesOrder: { findUnique: async () => ({ status: state.orderStatus }) },
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      state.permissionAsked.push(permission)
      if (!state.allowed) throw new Error(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'user-1', role: 'ADMIN' } }
    },
  },
})
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async (ids: unknown) => { state.stockSync.push(ids) } } })
mock.module('@/app/actions/allocation', { namedExports: { autoAllocateOrder: async (...args: unknown[]) => { state.allocate.push(args); return { success: true } } } })
mock.module('@/lib/domain/sales/refund-delete-service', {
  namedExports: {
    evaluateRefundDeletion: async (_c: unknown, id: string) => { state.evaluateCalls.push(id); return { eligible: id === 'r1', refusals: id === 'r1' ? [] : [{ code: 'stock_moved', message: 'moved' }], plan: null, alreadyDeleted: false } },
    deleteSalesOrderRefund: async (_c: unknown, input: Record<string, unknown>) => { state.serviceCalls.push(input); return state.serviceResult },
  },
})

const actions = () => import('@/app/actions/refund-delete')

function reset() {
  state.allowed = true
  state.permissionAsked.length = 0
  state.serviceCalls.length = 0
  state.evaluateCalls.length = 0
  state.stockSync.length = 0
  state.allocate.length = 0
  state.activity.length = 0
  state.setting = null
  state.orderStatus = 'PROCESSING'
  state.serviceResult = { success: true, alreadyDeleted: false, orderId: 'o1', creditNoteNumber: 'CN-1', productIds: ['p1'], voidQueued: true, counterJournalQueued: false }
}

test('permission denial: without the refund permission nothing is evaluated, deleted, re-reserved or pushed', async () => {
  reset()
  state.allowed = false
  const { deleteRefund, getRefundDeleteEligibility } = await actions()
  await assert.rejects(() => deleteRefund('r1', 'typo'), /missing permission sales\.refund/)
  await assert.rejects(() => getRefundDeleteEligibility('o1'), /missing permission sales\.refund/)
  assert.deepEqual(state.permissionAsked, ['sales.refund', 'sales.refund'], 'the existing refund key gates both the question and the act')
  assert.equal(state.serviceCalls.length, 0)
  assert.equal(state.evaluateCalls.length, 0)
  assert.equal(state.allocate.length, 0)
  assert.equal(state.stockSync.length, 0)
})

test('while the switch is off the page is told so and nothing is evaluated', async () => {
  reset()
  const { getRefundDeleteEligibility } = await actions()
  assert.deepEqual(await getRefundDeleteEligibility('o1'), { enabled: false, refunds: {} })
  state.setting = 'false'
  assert.deepEqual(await getRefundDeleteEligibility('o1'), { enabled: false, refunds: {} })
  assert.equal(state.evaluateCalls.length, 0)
})

test('with the switch on each refund is answered: eligible, or the reasons it is not', async () => {
  reset()
  state.setting = 'true'
  const { getRefundDeleteEligibility } = await actions()
  const result = await getRefundDeleteEligibility('o1')
  assert.equal(result.enabled, true)
  assert.equal(result.refunds.r1.eligible, true)
  assert.equal(result.refunds.r2.eligible, false)
  assert.equal(result.refunds.r2.refusals[0].message, 'moved')
})

test('a delete passes the actor and a trimmed reason, then re-reserves the order and queues the stock push', async () => {
  reset()
  const { deleteRefund } = await actions()
  const result = await deleteRefund('r1', '  entered on the wrong order  ')
  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.serviceCalls, [{ refundId: 'r1', actorUserId: 'user-1', reason: 'entered on the wrong order' }])
  assert.equal(state.allocate.length, 1)
  assert.deepEqual(state.stockSync, [['p1']])
})

test('an order that is not being fulfilled is not re-reserved (a delete never promotes a draft or an unpaid order)', async () => {
  reset()
  state.orderStatus = 'PENDING_PAYMENT'
  const { deleteRefund } = await actions()
  assert.deepEqual(await deleteRefund('r1'), { success: true })
  assert.equal(state.allocate.length, 0)
  assert.deepEqual(state.stockSync, [['p1']], 'the stock change still goes to the storefront')
})

test('a refusal is returned in operator wording and triggers no follow-up', async () => {
  reset()
  state.serviceResult = { success: false, error: 'This refund came from WooCommerce.', refusals: [{ code: 'woocommerce_origin', message: 'This refund came from WooCommerce.' }] }
  const { deleteRefund } = await actions()
  const result = await deleteRefund('r1')
  assert.equal(result.success, false)
  assert.equal(result.error, 'This refund came from WooCommerce.')
  assert.equal(state.allocate.length, 0)
  assert.equal(state.stockSync.length, 0)
})

test('an idempotent retry of a delete that already happened reports success and does nothing more', async () => {
  reset()
  state.serviceResult = { success: true, alreadyDeleted: true, orderId: 'o1', creditNoteNumber: 'CN-1', productIds: [], voidQueued: false, counterJournalQueued: false }
  const { deleteRefund } = await actions()
  assert.deepEqual(await deleteRefund('r1'), { success: true })
  assert.equal(state.allocate.length, 0)
  assert.equal(state.stockSync.length, 0)
  assert.equal(state.activity.length, 0)
})
