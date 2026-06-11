import assert from 'node:assert/strict'
import test from 'node:test'

import { cancelPurchaseOrderAction } from '@/lib/domain/purchasing/cancel-purchase-order-action'

test('cancelPurchaseOrderAction enforces permission before calling the service', async () => {
  let serviceCalled = false

  await assert.rejects(
    () => cancelPurchaseOrderAction('po-1', {
      requirePermission: async () => {
        throw new Error('Forbidden')
      },
      cancelPurchaseOrderService: async () => {
        serviceCalled = true
        return { success: true }
      },
      revalidatePath: () => undefined,
    }),
    /Forbidden/,
  )

  assert.equal(serviceCalled, false)
})

test('cancelPurchaseOrderAction returns service result and revalidates on success', async () => {
  const revalidated: string[] = []
  const result = await cancelPurchaseOrderAction('po-1', {
    requirePermission: async () => ({ user: { id: 'user-1' } }) as never,
    cancelPurchaseOrderService: async () => ({ success: true, notice: 'Already cancelled' }),
    revalidatePath: (path: string) => {
      revalidated.push(path)
    },
  })

  assert.deepEqual(result, { success: true, notice: 'Already cancelled' })
  assert.deepEqual(revalidated, ['/purchase-orders', '/purchase-orders/po-1'])
})

test('cancelPurchaseOrderAction does not revalidate failed cancellations', async () => {
  const revalidated: string[] = []
  const result = await cancelPurchaseOrderAction('po-1', {
    requirePermission: async () => ({ user: { id: 'user-1' } }) as never,
    cancelPurchaseOrderService: async () => ({ success: false, error: 'Cannot cancel' }),
    revalidatePath: (path: string) => {
      revalidated.push(path)
    },
  })

  assert.deepEqual(result, { success: false, error: 'Cannot cancel' })
  assert.deepEqual(revalidated, [])
})
