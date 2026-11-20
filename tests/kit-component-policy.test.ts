import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'

import { findKitComponentRefusal } from '@/lib/products/kit-component-policy'
import { expandFulfillmentRequirementsDecimal, type FulfillmentGraphNode } from '@/lib/products/kit-fulfillment'

test('refuses a VARIABLE component with a clear message naming it', () => {
  const msg = findKitComponentRefusal([{ sku: 'MUG', type: 'SIMPLE' }, { sku: 'TSHIRT', type: 'VARIABLE' }])
  assert.ok(msg)
  assert.match(msg, /variable product \(TSHIRT\)/)
})

test('refuses a kit made only of NON_INVENTORY components', () => {
  assert.match(findKitComponentRefusal([{ sku: 'WRAP', type: 'NON_INVENTORY' }]) ?? '', /at least one stock-tracked/)
})

test('accepts stock-tracked plus NON_INVENTORY, and a variation', () => {
  assert.equal(findKitComponentRefusal([{ sku: 'MUG', type: 'SIMPLE' }, { sku: 'WRAP', type: 'NON_INVENTORY' }]), null)
  assert.equal(findKitComponentRefusal([{ sku: 'TSHIRT-L', type: 'VARIANT' }]), null)
})

test('fulfilment expansion drops NON_INVENTORY leaves so allocation agrees with the stock push', () => {
  const graph = new Map<string, FulfillmentGraphNode>([
    ['K', {
      id: 'K', type: 'KIT', fulfillmentGraphVersion: 0,
      productComponents: [
        { componentId: 'MUG', componentSku: 'MUG', qty: new Prisma.Decimal(1), componentType: 'SIMPLE', componentOversellAllowed: false },
        { componentId: 'WRAP', componentSku: 'WRAP', qty: new Prisma.Decimal(1), componentType: 'NON_INVENTORY', componentOversellAllowed: false },
      ],
    }],
    ['MUG', { id: 'MUG', type: 'SIMPLE', fulfillmentGraphVersion: 0, productComponents: [] }],
    ['WRAP', { id: 'WRAP', type: 'NON_INVENTORY', fulfillmentGraphVersion: 0, productComponents: [] }],
  ])
  const req = expandFulfillmentRequirementsDecimal('K', 3, graph)
  assert.deepEqual([...req.keys()], ['MUG'])
  assert.equal(req.get('MUG')?.toNumber(), 3)
})
