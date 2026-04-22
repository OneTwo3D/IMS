import assert from 'node:assert/strict'
import test from 'node:test'
import * as normalizersNs from '../lib/connectors/mintsoft/api/normalizers.ts'
import * as returnsSyncNs from '../lib/connectors/mintsoft/sync/returns-sync.ts'

const normalizers = 'default' in normalizersNs
  ? normalizersNs.default as typeof import('../lib/connectors/mintsoft/api/normalizers.ts')
  : normalizersNs
const returnsSync = 'default' in returnsSyncNs
  ? returnsSyncNs.default as typeof import('../lib/connectors/mintsoft/sync/returns-sync.ts')
  : returnsSyncNs

test('normalizeMintsoftReturn accepts common Mintsoft return payload variants', () => {
  assert.deepEqual(
    normalizers.normalizeMintsoftReturn({
      ReturnId: 42,
      WarehouseId: 301,
      SKU: 'RET-SKU-1',
      Qty: '2',
      OrderNumber: 'WC-1001',
      Reason: 'Damaged',
      ReceivedAt: '2026-04-21T12:00:00.000Z',
    }),
    {
      externalReturnId: '42',
      externalWarehouseId: '301',
      sku: 'RET-SKU-1',
      qty: 2,
      orderReference: 'WC-1001',
      reason: 'Damaged',
      receivedAt: '2026-04-21T12:00:00.000Z',
      raw: {
        ReturnId: 42,
        WarehouseId: 301,
        SKU: 'RET-SKU-1',
        Qty: '2',
        OrderNumber: 'WC-1001',
        Reason: 'Damaged',
        ReceivedAt: '2026-04-21T12:00:00.000Z',
      },
    },
  )

  assert.equal(normalizers.normalizeMintsoftReturn({ foo: 'bar' }), null)
})

test('selectMintsoftReturnBinding prefers an explicit warehouse match and otherwise requires a single binding', () => {
  const bindings = [
    {
      id: 'b-1',
      externalWarehouseId: '301',
      warehouseId: 'w-1',
      returnsMode: 'POLL',
      active: true,
      connection: { active: true },
      warehouse: { code: 'MAIN', name: 'Main' },
    },
    {
      id: 'b-2',
      externalWarehouseId: '302',
      warehouseId: 'w-2',
      returnsMode: 'POLL',
      active: true,
      connection: { active: true },
      warehouse: { code: 'OVER', name: 'Overflow' },
    },
  ] as const

  assert.equal(
    returnsSync.selectMintsoftReturnBinding({ externalWarehouseId: '302' }, [...bindings])?.id,
    'b-2',
  )
  assert.equal(
    returnsSync.selectMintsoftReturnBinding({ externalWarehouseId: null }, [bindings[0]])?.id,
    'b-1',
  )
  assert.equal(
    returnsSync.selectMintsoftReturnBinding({ externalWarehouseId: null }, [...bindings]),
    null,
  )
})

test('isMintsoftReturnFullyMatched requires an order, product, and warehouse binding', () => {
  assert.equal(
    returnsSync.isMintsoftReturnFullyMatched({
      orderId: 'so-1',
      productId: 'prod-1',
      bindingId: 'binding-1',
    }),
    true,
  )

  assert.equal(
    returnsSync.isMintsoftReturnFullyMatched({
      orderId: 'so-1',
      productId: 'prod-1',
      bindingId: null,
    }),
    false,
  )
})

test('resolveMintsoftReturnWarehouseId preserves a restock destination on later polling updates', () => {
  assert.equal(
    returnsSync.resolveMintsoftReturnWarehouseId({
      existingStatus: 'RESTOCKED',
      existingWarehouseId: 'restock-wh',
      bindingWarehouseId: 'source-wh',
    }),
    'restock-wh',
  )

  assert.equal(
    returnsSync.resolveMintsoftReturnWarehouseId({
      existingStatus: 'NEW',
      existingWarehouseId: 'old-wh',
      bindingWarehouseId: 'source-wh',
    }),
    'source-wh',
  )
})

test('resolveMintsoftReturnsNextCursor replays the full window when a failed record has no stable timestamp', () => {
  const since = new Date('2026-04-20T10:00:00.000Z')
  const startedAt = new Date('2026-04-21T10:00:00.000Z')

  assert.deepEqual(
    returnsSync.resolveMintsoftReturnsNextCursor({
      since,
      startedAt,
      earliestFailedReceivedAt: new Date('2026-04-21T09:00:00.000Z'),
      replayFullWindow: false,
    }),
    new Date('2026-04-21T09:00:00.000Z'),
  )

  assert.deepEqual(
    returnsSync.resolveMintsoftReturnsNextCursor({
      since,
      startedAt,
      earliestFailedReceivedAt: null,
      replayFullWindow: true,
    }),
    since,
  )
})
