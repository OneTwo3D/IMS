import assert from 'node:assert/strict'
import test from 'node:test'
import * as authNs from '../lib/connectors/mintsoft/api/auth.ts'
import * as normalizersNs from '../lib/connectors/mintsoft/api/normalizers.ts'
import * as stockSyncHelpersNs from '../lib/connectors/mintsoft/sync/stock-sync-helpers.ts'

const auth = 'default' in authNs
  ? authNs.default as typeof import('../lib/connectors/mintsoft/api/auth.ts')
  : authNs
const normalizers = 'default' in normalizersNs
  ? normalizersNs.default as typeof import('../lib/connectors/mintsoft/api/normalizers.ts')
  : normalizersNs
const stockSyncHelpers = 'default' in stockSyncHelpersNs
  ? stockSyncHelpersNs.default as typeof import('../lib/connectors/mintsoft/sync/stock-sync-helpers.ts')
  : stockSyncHelpersNs

test('extractMintsoftArrayPayload handles both array and wrapped payload shapes', () => {
  assert.deepEqual(normalizers.extractMintsoftArrayPayload([{ id: 1 }]), [{ id: 1 }])
  assert.deepEqual(normalizers.extractMintsoftArrayPayload({ Warehouses: [{ id: 2 }] }), [{ id: 2 }])
  assert.deepEqual(normalizers.extractMintsoftArrayPayload({ data: [{ id: 3 }] }), [{ id: 3 }])
  assert.deepEqual(normalizers.extractMintsoftArrayPayload({}), [])
})

test('normalizeMintsoftWarehouse accepts common Mintsoft warehouse field variants', () => {
  assert.deepEqual(
    normalizers.normalizeMintsoftWarehouse({ WarehouseId: 17, WarehouseName: 'Main Warehouse' }),
    { externalId: '17', name: 'Main Warehouse' },
  )
  assert.deepEqual(
    normalizers.normalizeMintsoftWarehouse({ id: 'abc', label: 'Overflow' }),
    { externalId: 'abc', name: 'Overflow' },
  )
  assert.equal(normalizers.normalizeMintsoftWarehouse({ foo: 'bar' }), null)
})

test('normalizeMintsoftStockLine accepts common stock line field variants', () => {
  assert.deepEqual(
    normalizers.normalizeMintsoftStockLine({ SKU: 'ABC-1', FreeStock: '12.5' }),
    {
      sku: 'ABC-1',
      quantity: 12.5,
      raw: { SKU: 'ABC-1', FreeStock: '12.5' },
    },
  )
  assert.deepEqual(
    normalizers.normalizeMintsoftStockLine({ productCode: 'XYZ-2', stockLevel: 3 }),
    {
      sku: 'XYZ-2',
      quantity: 3,
      raw: { productCode: 'XYZ-2', stockLevel: 3 },
    },
  )
  assert.deepEqual(
    normalizers.normalizeMintsoftStockLine({ SKU: 'REALISTIC-3', Level: 9 }),
    {
      sku: 'REALISTIC-3',
      quantity: 9,
      raw: { SKU: 'REALISTIC-3', Level: 9 },
    },
  )
  assert.equal(normalizers.normalizeMintsoftStockLine({ productCode: 'XYZ-2' }), null)
})

test('extractMintsoftAuthToken accepts common Mintsoft auth response variants', () => {
  assert.equal(
    auth.extractMintsoftAuthToken({
      ApiKey: 'mintsoft-generated-key',
    }),
    'mintsoft-generated-key',
  )

  assert.equal(
    auth.extractMintsoftAuthToken('plain-text-token'),
    'plain-text-token',
  )

  assert.equal(auth.extractMintsoftAuthToken({ foo: 'bar' }), null)
})

test('sanitizeMintsoftThresholds normalizes values and drops empty configs', () => {
  assert.equal(stockSyncHelpers.sanitizeMintsoftThresholds(null), null)
  assert.deepEqual(
    stockSyncHelpers.sanitizeMintsoftThresholds({ absoluteDelta: -5, percentDelta: 10 }),
    { absoluteDelta: 0, percentDelta: 10 },
  )
  assert.deepEqual(
    stockSyncHelpers.parseMintsoftThresholds({ absoluteDelta: '2.5', percentDelta: 15 }),
    { absoluteDelta: 2.5, percentDelta: 15 },
  )
})

test('isMintsoftBindingDue and hasMintsoftThresholdBreach reflect phase 2 scheduling rules', () => {
  const now = new Date('2026-04-21T12:00:00.000Z')
  assert.equal(stockSyncHelpers.isMintsoftBindingDue(null, 60, now), true)
  assert.equal(stockSyncHelpers.isMintsoftBindingDue(new Date('2026-04-21T11:01:00.000Z'), 60, now), false)
  assert.equal(stockSyncHelpers.isMintsoftBindingDue(new Date('2026-04-21T10:59:00.000Z'), 60, now), true)

  assert.equal(
    stockSyncHelpers.hasMintsoftThresholdBreach(10, 14, { absoluteDelta: 5, percentDelta: null }),
    false,
  )
  assert.equal(
    stockSyncHelpers.hasMintsoftThresholdBreach(10, 15, { absoluteDelta: 5, percentDelta: null }),
    true,
  )
  assert.equal(
    stockSyncHelpers.hasMintsoftThresholdBreach(10, 12, { absoluteDelta: null, percentDelta: 15 }),
    true,
  )
})

test('consolidateMintsoftStockLines merges duplicate SKUs and keeps the latest raw payload', () => {
  assert.deepEqual(
    stockSyncHelpers.consolidateMintsoftStockLines([
      { sku: 'ABC', quantity: 2, raw: { first: true } },
      { sku: 'ABC', quantity: 3, raw: { second: true } },
      { sku: 'DEF', quantity: 1, raw: null },
    ]),
    [
      { sku: 'ABC', quantity: 5, raw: { second: true } },
      { sku: 'DEF', quantity: 1, raw: null },
    ],
  )
})

test('planMintsoftAlignmentAllocations consumes the oldest open ASN capacity first', () => {
  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 9,
      candidates: [
        {
          asnLineMapId: 'line-b',
          expectedQty: 10,
          qtyAccountedViaSnapshot: 3,
          lastProcessedReceivedQty: 0,
          sortKey: '2026-04-22T10:05:00.000Z:line-b',
        },
        {
          asnLineMapId: 'line-a',
          expectedQty: 5,
          qtyAccountedViaSnapshot: 0,
          lastProcessedReceivedQty: 0,
          sortKey: '2026-04-22T10:00:00.000Z:line-a',
        },
      ],
    }),
    {
      allocations: [
        { asnLineMapId: 'line-a', qty: 5 },
        { asnLineMapId: 'line-b', qty: 4 },
      ],
      unallocatedQty: 0,
    },
  )

  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 20,
      candidates: [
        {
          asnLineMapId: 'line-a',
          expectedQty: 5,
          qtyAccountedViaSnapshot: 2,
          lastProcessedReceivedQty: 0,
          sortKey: '2026-04-22T10:00:00.000Z:line-a',
        },
      ],
    }),
    {
      allocations: [
        { asnLineMapId: 'line-a', qty: 3 },
      ],
      unallocatedQty: 17,
    },
  )
})

test('collectMissingInWmsCandidates keeps feed omissions visible without zero-zero noise', () => {
  assert.deepEqual(
    stockSyncHelpers.collectMissingInWmsCandidates({
      returnedSkus: ['LIVE-SKU'],
      snapshots: [
        { productId: 'p1', sku: 'MISSING-WITH-STOCK', externalQty: 4 },
        { productId: 'p2', sku: 'ZERO-ZERO', externalQty: 0 },
      ],
      stockLevels: [
        { productId: 'p1', sku: 'MISSING-WITH-STOCK', quantity: 2 },
        { productId: 'p2', sku: 'ZERO-ZERO', quantity: 0 },
        { productId: 'p3', sku: 'IMS-ONLY', quantity: 7 },
      ],
    }),
    [
      { productId: 'p3', sku: 'IMS-ONLY', imsQty: 7, lastExternalQty: null },
      { productId: 'p1', sku: 'MISSING-WITH-STOCK', imsQty: 2, lastExternalQty: 4 },
    ],
  )
})
