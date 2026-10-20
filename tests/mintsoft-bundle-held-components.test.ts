import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * A KIT WHOSE COMPONENTS HAVE NO MINTSOFT PRODUCT LINK BECAUSE PRODUCT UPSERTS ARE SHADOWED IS NOT A BUNDLE IN CONFLICT.
 *
 * While the producer-side hold shadows `product.upsert` no WmsProductLink is ever written (the shadow touches no link), so a component with no
 * link is the held state, not a data problem: raising a durable BUNDLE_DERIVATION_CONFLICT discrepancy would be a finding nothing an operator
 * can do clears until the destination is live. With the switch off, or for another destination, the conflict is raised exactly as before.
 *
 * Named mutation `conflict-while-held`: the held skip is removed; the held arm goes red.
 */
const discrepancyWrites: string[] = []
mock.module('@/lib/db', {
  namedExports: {
    db: {
      externalWmsBinding: { findMany: async () => [{ warehouseId: 'wh-1', bundleSyncDirection: 'IMS_TO_WMS', warehouse: { code: 'W1' } }] },
      product: {
        findUnique: async () => ({
          id: 'kit-1', sku: 'KIT-1', name: 'Kit', type: 'KIT', lifecycleStatus: 'ACTIVE',
          productComponents: [{ qty: 2, component: { id: 'c-1', sku: 'COMP-A', wmsProductLinks: [] } }],
          wmsProductLinks: [{ externalProductId: '500' }],
          wmsBundleLinks: [],
        }),
      },
      wmsStockDiscrepancy: {
        updateMany: async () => { discrepancyWrites.push('updateMany'); return { count: 0 } },
        create: async () => { discrepancyWrites.push('create'); return { id: 'd1' } },
      },
    },
  },
})

const ENV = 'PRODUCER_HOLD_ENFORCED_DESTINATIONS'
async function run(env: string | undefined) {
  const saved = process.env[ENV]
  if (env === undefined) delete process.env[ENV]; else process.env[ENV] = env
  discrepancyWrites.length = 0
  try {
    const { runBundleSyncForProduct } = await import('@/lib/connectors/mintsoft/sync/bundle-sync')
    return await runBundleSyncForProduct('kit-1', 'manual')
  } finally {
    if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved
  }
}

test('HELD: missing component links are skipped with a held reason and write no discrepancy', async () => {
  const result = await run('mintsoft')
  console.log(`# held: ${result.status}/${result.action} writes=${JSON.stringify(discrepancyWrites)}`)
  assert.equal(result.status, 'SKIPPED')
  assert.equal(result.action, 'no_wms_product_link')
  assert.match(result.reason, /held on this installation/)
  assert.deepEqual(discrepancyWrites, [])
})

test('CONTROL: switch off, and enforcement for another destination, raise the conflict as before', async () => {
  for (const env of [undefined, 'xero']) {
    const result = await run(env)
    assert.equal(result.status, 'CONFLICT', String(env))
    assert.equal(result.action, 'conflict')
    assert.ok(discrepancyWrites.length > 0, `${String(env)}: the durable conflict is written`)
  }
})
