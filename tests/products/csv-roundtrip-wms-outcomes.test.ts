import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * A warehouse sync that RETURNS a failure (it does not throw) must not count as done: the drain would delete the product's
 * mark and the edit would never reach the warehouse. These pin the whole chain: the Mintsoft result -> the generic hook's
 * outcome -> syncWmsProductNow (throws) -> the sweep (keeps the mark).
 */

const world = {
  product: { status: 'SUCCEEDED', errors: 0, shadowed: 0, outboundHeld: 0, skippedReason: undefined as string | undefined } as Record<string, unknown>,
  bundle: { status: 'SYNCED', action: 'verified', reason: 'ok' } as Record<string, unknown>,
  parents: [] as string[],
  bundleCalls: [] as string[],
}

mock.module('@/lib/db', {
  namedExports: { db: { productComponent: { findMany: async () => world.parents.map((productId) => ({ productId })) } } },
})
mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({}) } })
mock.module('@/lib/connectors/wms/enabled-connector', { namedExports: { enabledWmsConnectorId: () => 'mintsoft' } })
mock.module('next/server', { namedExports: { after: () => undefined } })
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnectorHooks: () => ({
      // The shipped result -> outcome mapping, fed by the mocked Mintsoft sync results above.
      productSync: async () => {
        const outcome = await import('@/lib/connectors/mintsoft/sync/wms-outcome')
        return {
          syncProduct: async () => outcome.mintsoftProductOutcome(world.product as never),
          syncBundle: async (id: string) => { world.bundleCalls.push(id); return outcome.mintsoftBundleOutcome(world.bundle as never) },
        }
      },
    }),
  },
})

beforeEach(() => {
  world.product = { status: 'SUCCEEDED', errors: 0, shadowed: 0, outboundHeld: 0 }
  world.bundle = { status: 'SYNCED', action: 'verified', reason: 'ok' }
  world.parents = []
  world.bundleCalls.length = 0
})

test('a clean product and bundle sync completes', async () => {
  const { syncWmsProductNow } = await import('@/lib/domain/wms/product-sync-dispatch')
  await syncWmsProductNow('p1')
  assert.deepEqual(world.bundleCalls, ['p1'])
})

test('SKIPPED (an ineligible product, no bundle) is clean', async () => {
  world.product = { status: 'SKIPPED', errors: 0, skippedReason: 'not eligible' }
  world.bundle = { status: 'SKIPPED_NOT_KIT', action: 'noop', reason: 'not a kit' }
  const { syncWmsProductNow } = await import('@/lib/domain/wms/product-sync-dispatch')
  await syncWmsProductNow('p1')
})

for (const [label, product] of [
  ['FAILED', { status: 'FAILED', errors: 1, skippedReason: 'Product not found' }],
  ['PARTIAL', { status: 'PARTIAL', errors: 0 }],
  ['SUCCEEDED but with errors', { status: 'SUCCEEDED', errors: 2 }],
  ['shadowed by the outbound hold', { status: 'SUCCEEDED', errors: 0, shadowed: 1 }],
  ['refused by the outbound hold', { status: 'SUCCEEDED', errors: 0, outboundHeld: 1 }],
] as const) {
  test(`REGRESSION: a returned ${label} product sync throws, so the drain keeps the mark`, async () => {
    world.product = { ...product }
    const { syncWmsProductNow } = await import('@/lib/domain/wms/product-sync-dispatch')
    await assert.rejects(syncWmsProductNow('p1'), /Warehouse sync did not complete: product: product sync/)
  })
}

for (const [label, bundle] of [
  ['ERROR', { status: 'ERROR', action: 'noop', reason: 'lookup failed' }],
  ['CONFLICT', { status: 'CONFLICT', action: 'conflict', reason: 'differs' }],
  ['shadowed', { status: 'SYNCED', action: 'shadowed', reason: 'held' }],
] as const) {
  test(`REGRESSION: a returned ${label} bundle sync throws`, async () => {
    world.bundle = { ...bundle }
    const { syncWmsProductNow } = await import('@/lib/domain/wms/product-sync-dispatch')
    await assert.rejects(syncWmsProductNow('p1'), /Warehouse sync did not complete: bundle: bundle sync/)
  })
}

test('REGRESSION: a failing parent-KIT bundle sync throws too, and every parent is still tried', async () => {
  world.parents = ['kit-a', 'kit-b']
  world.bundle = { status: 'ERROR', action: 'noop', reason: 'x' }
  const { syncWmsProductNow } = await import('@/lib/domain/wms/product-sync-dispatch')
  await assert.rejects(syncWmsProductNow('p1'), /parent bundle kit-a.*parent bundle kit-b/)
  assert.deepEqual(world.bundleCalls, ['p1', 'kit-a', 'kit-b'])
})

test('the Mintsoft hook returns the mapped outcome of the sync result instead of discarding it', async () => {
  const { readFileSync } = await import('node:fs')
  const registry = readFileSync('lib/connectors/wms/registry.ts', 'utf8')
  assert.match(registry, /syncProduct: async \(productId, triggeredBy\) => outcome\.mintsoftProductOutcome\(await product\.runMintsoftProductSyncForProduct/)
  assert.match(registry, /syncBundle: async \(productId, triggeredBy\) => outcome\.mintsoftBundleOutcome\(await bundle\.runBundleSyncForProduct/)
})
