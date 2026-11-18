import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.102: when a component changes, every kit above it is re-pushed, at any nesting depth (a gift box holding a kit that
 * holds the component), not only the kits that contain it directly.
 */

// component -> kits that contain it directly
let parents: Record<string, string[]> = {}
let queries = 0

const fakeDb: object = new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === 'productComponent') {
      return {
        findMany: async (args: { where: { componentId: { in: string[] } } }) => {
          queries++
          return args.where.componentId.in.flatMap((id) => (parents[id] ?? []).map((productId) => ({ productId })))
        },
      }
    }
    return new Proxy({}, { get: () => async () => null })
  },
})
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })

test('a kit holding a kit holding the changed component is included (o3d-hqvrp.102)', async () => {
  parents = { C: ['K1'], K1: ['K2'], K2: ['K3'] }
  const { expandDependentKitIds } = await import('@/lib/connectors/woocommerce/sync/stock-sync-jobs')
  assert.deepEqual((await expandDependentKitIds(['C'])).sort(), ['K1', 'K2', 'K3'])
})

test('a kit cycle and a shared kit terminate and are listed once', async () => {
  parents = { C: ['K1', 'K2'], K1: ['K3'], K2: ['K3'], K3: ['K1'] }
  queries = 0
  const { expandDependentKitIds } = await import('@/lib/connectors/woocommerce/sync/stock-sync-jobs')
  assert.deepEqual((await expandDependentKitIds(['C'])).sort(), ['K1', 'K2', 'K3'])
  assert.ok(queries <= 10)
})
