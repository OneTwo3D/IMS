import assert from 'node:assert/strict'
import test from 'node:test'
import * as bundleSyncNs from '../lib/connectors/mintsoft/sync/bundle-sync.ts'
import * as normalizersNs from '../lib/connectors/mintsoft/api/normalizers.ts'
import * as clientNs from '../lib/connectors/mintsoft/api/client.ts'

const bundleSync = 'default' in bundleSyncNs
  ? bundleSyncNs.default as typeof import('../lib/connectors/mintsoft/sync/bundle-sync.ts')
  : bundleSyncNs
const normalizers = 'default' in normalizersNs
  ? normalizersNs.default as typeof import('../lib/connectors/mintsoft/api/normalizers.ts')
  : normalizersNs
const client = 'default' in clientNs
  ? clientNs.default as typeof import('../lib/connectors/mintsoft/api/client.ts')
  : clientNs

test('computeBundleChecksum is stable across component reordering', () => {
  const checksumA = bundleSync.computeBundleChecksum({
    sku: 'KIT-1',
    name: 'Starter Kit',
    packingInstructions: null,
    components: [
      { externalProductId: '100', sku: 'COMP-A', quantity: 2 },
      { externalProductId: '200', sku: 'COMP-B', quantity: 1 },
    ],
  })
  const checksumB = bundleSync.computeBundleChecksum({
    sku: 'KIT-1',
    name: 'Starter Kit',
    packingInstructions: null,
    components: [
      { externalProductId: '200', sku: 'COMP-B', quantity: 1 },
      { externalProductId: '100', sku: 'COMP-A', quantity: 2 },
    ],
  })
  assert.equal(checksumA, checksumB)
})

test('computeBundleChecksum changes when a component quantity changes', () => {
  const before = bundleSync.computeBundleChecksum({
    sku: 'KIT-2',
    name: 'Duo',
    packingInstructions: null,
    components: [
      { externalProductId: '1', sku: 'A', quantity: 2 },
      { externalProductId: '2', sku: 'B', quantity: 2 },
    ],
  })
  const after = bundleSync.computeBundleChecksum({
    sku: 'KIT-2',
    name: 'Duo',
    packingInstructions: null,
    components: [
      { externalProductId: '1', sku: 'A', quantity: 2 },
      { externalProductId: '2', sku: 'B', quantity: 3 },
    ],
  })
  assert.notEqual(before, after)
})

test('computeBundleChecksum ignores ±0.0001 quantity drift but detects coarser changes', () => {
  const baseline = bundleSync.computeBundleChecksum({
    sku: 'KIT-3',
    name: 'Rounding',
    packingInstructions: null,
    components: [
      { externalProductId: '1', sku: 'X', quantity: 1 },
    ],
  })
  const drifted = bundleSync.computeBundleChecksum({
    sku: 'KIT-3',
    name: 'Rounding',
    packingInstructions: null,
    components: [
      { externalProductId: '1', sku: 'X', quantity: 1.00001 },
    ],
  })
  assert.equal(baseline, drifted)

  const changed = bundleSync.computeBundleChecksum({
    sku: 'KIT-3',
    name: 'Rounding',
    packingInstructions: null,
    components: [
      { externalProductId: '1', sku: 'X', quantity: 1.5 },
    ],
  })
  assert.notEqual(baseline, changed)
})

test('normalizeMintsoftBundle accepts the documented Mintsoft Bundle shape', () => {
  const result = normalizers.normalizeMintsoftBundle({
    ID: 42,
    SKU: 'KIT-AA',
    Name: 'Assorted',
    Components: [
      { ProductId: 100, SKU: 'A', Quantity: 2 },
      { ProductId: 200, SKU: 'B', Quantity: 3 },
    ],
  })

  assert.ok(result)
  assert.equal(result?.externalBundleId, '42')
  assert.equal(result?.sku, 'KIT-AA')
  assert.equal(result?.components.length, 2)
  assert.deepEqual(
    result?.components.map((component) => ({ sku: component.sku, quantity: component.quantity, externalProductId: component.externalProductId })),
    [
      { sku: 'A', quantity: 2, externalProductId: '100' },
      { sku: 'B', quantity: 3, externalProductId: '200' },
    ],
  )
})

test('normalizeMintsoftBundle prefers bundle ID over component-level productId aliases', () => {
  const result = normalizers.normalizeMintsoftBundle({
    ID: 42,
    ProductId: 9999,
    SKU: 'KIT-AA',
    Name: 'Assorted',
    Components: [
      { ProductId: 100, SKU: 'A', Quantity: 2 },
    ],
  })

  assert.ok(result)
  assert.equal(result?.externalBundleId, '42')
  assert.notEqual(result?.externalBundleId, '9999')
})

test('normalizeMintsoftBundle rejects payload without SKU or ID', () => {
  assert.equal(normalizers.normalizeMintsoftBundle({ Components: [] }), null)
  assert.equal(normalizers.normalizeMintsoftBundle({ SKU: 'KIT-1', Components: [] }), null)
})

test('normalizeMintsoftBundleItem drops zero or negative quantities', () => {
  assert.equal(normalizers.normalizeMintsoftBundleItem({ SKU: 'A', Quantity: 0 }), null)
  assert.equal(normalizers.normalizeMintsoftBundleItem({ SKU: 'A', Quantity: -1 }), null)
})

test('buildMintsoftBundleCreateRequest targets PUT /api/Product/Bundle with numeric component ProductId', () => {
  const request = client.buildMintsoftBundleCreateRequest({
    sku: 'KIT-Z',
    name: 'Test',
    packingInstructions: 'Wrap in foam',
    components: [
      { externalProductId: '1001', sku: 'COMP-1', quantity: 2 },
      { externalProductId: null, sku: 'COMP-2', quantity: 1 },
    ],
  })
  assert.equal(request.path, '/api/Product/Bundle')
  assert.equal(request.method, 'PUT')

  const body = JSON.parse(request.body) as {
    SKU: string
    Name: string
    PackingInstructions: string | null
    Components: Array<{ SKU: string; Quantity: number; ProductId?: number | string }>
  }
  assert.equal(body.SKU, 'KIT-Z')
  assert.equal(body.PackingInstructions, 'Wrap in foam')
  assert.equal(body.Components[0].ProductId, 1001)
  assert.equal(body.Components[1].ProductId, undefined)
})
