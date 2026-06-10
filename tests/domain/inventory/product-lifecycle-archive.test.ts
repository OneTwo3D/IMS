import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { getProductIncomingStock } from '@/lib/domain/inventory/product-lifecycle-archive'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

test('product incoming stock breakdown sums only remaining inbound quantities', async () => {
  const client = {
    purchaseOrderLine: {
      findMany: async () => [
        { qty: decimal('10'), qtyReceived: decimal('4') },
        { qty: decimal('2'), qtyReceived: decimal('3') },
      ],
    },
    stockTransferLine: {
      findMany: async () => [
        { qty: decimal('5'), qtyReceived: decimal('1.5') },
      ],
    },
    productionOrder: {
      findMany: async () => [
        { qtyPlanned: decimal('8'), qtyProduced: decimal('2') },
      ],
    },
    wmsAsnLineMap: {
      findMany: async () => [
        {
          expectedQty: decimal('7'),
          qtyAccountedViaSnapshot: decimal('2'),
          qtyAccountedViaReceipt: decimal('1.25'),
        },
      ],
    },
  }

  const incoming = await getProductIncomingStock('product-1', { client: client as never })

  assert.equal(incoming.purchaseOrders, '6')
  assert.equal(incoming.stockTransfers, '3.5')
  assert.equal(incoming.productionOrders, '6')
  assert.equal(incoming.wmsAsn, '3.75')
  assert.equal(incoming.total, '19.25')
})
