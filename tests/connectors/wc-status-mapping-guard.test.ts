import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-gz6 (prevent at source): a WooCommerce status must never map to IMS SHIPPED — importWcOrder writes
// the mapping straight into SalesOrder.status, so a WC->SHIPPED mapping mints "false-SHIPPED" orders
// (SHIPPED with no shipment) that then can't be cancelled. The server action rejects it at the
// persistence boundary.

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'admin' } }),
    requireFreshPermission: async () => ({ user: { id: 'admin' } }),
  },
})

const upsertCalls: Array<{ imsStatus: string }> = []
mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingStatusMapping: {
        upsert: async ({ update }: { update: { imsStatus: string } }) => {
          upsertCalls.push({ imsStatus: update.imsStatus })
          return {}
        },
      },
    },
  },
})

async function loadAction() {
  return (await import('@/app/actions/wc-sync')).upsertShoppingStatusMapping
}

test('mapping a WC status to SHIPPED is rejected before any write (o3d-gz6)', async () => {
  const upsertShoppingStatusMapping = await loadAction()
  upsertCalls.length = 0
  await assert.rejects(
    () => upsertShoppingStatusMapping('completed', 'SHIPPED'),
    /cannot map to SHIPPED/,
  )
  assert.equal(upsertCalls.length, 0, 'nothing is persisted when SHIPPED is rejected')
})

test('a non-SHIPPED mapping still persists', async () => {
  const upsertShoppingStatusMapping = await loadAction()
  upsertCalls.length = 0
  const result = await upsertShoppingStatusMapping('processing', 'PROCESSING')
  assert.deepEqual(result, { success: true })
  assert.deepEqual(upsertCalls, [{ imsStatus: 'PROCESSING' }])
})
