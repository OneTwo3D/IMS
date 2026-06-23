import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  isStockMovementIdempotencyConflict,
  parseSaleDispatchMovementKey,
  refundInboundMovementKey,
  saleDispatchMovementKey,
  wmsPurchaseReceiptMovementKey,
  wmsTransferInMovementKey,
} from '@/lib/domain/inventory/stock-movement-idempotency'

test('builds deterministic stock movement idempotency keys for irreversible flows', () => {
  assert.equal(
    saleDispatchMovementKey('shipment-line-1'),
    'SALE_DISPATCH:shipmentLine:shipment-line-1',
  )
  assert.equal(
    wmsPurchaseReceiptMovementKey({ asnLineMapId: 'asn-line-1', receiptEventId: 'event-1' }),
    'PURCHASE_RECEIPT:wmsAsnLine:asn-line-1:receipt:event-1',
  )
  assert.equal(
    wmsTransferInMovementKey({ asnLineMapId: 'asn-line-2', receiptEventId: 'event-2' }),
    'TRANSFER_IN:wmsAsnLine:asn-line-2:receipt:event-2',
  )
  assert.equal(
    refundInboundMovementKey({ refundId: 'refund-1', refundLineId: 'refund-line-1', warehouseId: 'warehouse-returns' }),
    'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns',
  )
})

test('builds stable disjoint keys across calls and movement kinds', () => {
  assert.equal(saleDispatchMovementKey('same-id'), saleDispatchMovementKey('same-id'))
  assert.notEqual(
    saleDispatchMovementKey('same-id'),
    refundInboundMovementKey({ refundId: 'same-id', refundLineId: 'same-id', warehouseId: 'same-id' }),
  )
  assert.notEqual(
    refundInboundMovementKey({ refundId: 'refund-1', refundLineId: 'refund-line-1', warehouseId: 'warehouse-a' }),
    refundInboundMovementKey({ refundId: 'refund-1', refundLineId: 'refund-line-1', warehouseId: 'warehouse-b' }),
  )
})

test('rejects blank, overlong, or invalid key parts', () => {
  assert.throws(() => saleDispatchMovementKey(' '), /must not be blank/)
  assert.throws(
    () => refundInboundMovementKey({ refundId: 'refund:1', refundLineId: 'line-1', warehouseId: 'warehouse-1' }),
    /invalid characters/,
  )
  assert.throws(() => saleDispatchMovementKey('a'.repeat(201)), /200 characters or fewer/)
  assert.throws(() => saleDispatchMovementKey('line\n1'), /invalid characters/)
  assert.throws(() => saleDispatchMovementKey('line\u00001'), /invalid characters/)
})

test('parseSaleDispatchMovementKey round-trips the shipmentLineId the backfill extracts', () => {
  // Mirrors the migration backfill regex `SALE_DISPATCH:shipmentLine:(.*)$`.
  for (const id of ['shipment-line-1', 'clxabc123', 'a'.repeat(180)]) {
    assert.equal(parseSaleDispatchMovementKey(saleDispatchMovementKey(id)), id)
  }
})

test('parseSaleDispatchMovementKey returns null for non-sale-dispatch or empty keys', () => {
  assert.equal(parseSaleDispatchMovementKey(null), null)
  assert.equal(parseSaleDispatchMovementKey(undefined), null)
  assert.equal(parseSaleDispatchMovementKey(''), null)
  assert.equal(parseSaleDispatchMovementKey('SALE_DISPATCH:shipmentLine:'), null)
  assert.equal(
    parseSaleDispatchMovementKey('RETURN_INBOUND:refund:r1:line:l1:warehouse:w1'),
    null,
  )
  assert.equal(
    parseSaleDispatchMovementKey('PURCHASE_RECEIPT:wmsAsnLine:a1:receipt:e1'),
    null,
  )
})

function prismaKnownError(code: string, target?: string[] | string) {
  return new Prisma.PrismaClientKnownRequestError('Prisma error', {
    code,
    clientVersion: 'test',
    meta: target == null ? undefined : { target },
  })
}

test('detects only stock movement idempotency unique conflicts', () => {
  assert.equal(isStockMovementIdempotencyConflict(prismaKnownError('P2002', ['idempotencyKey'])), true)
  assert.equal(isStockMovementIdempotencyConflict(prismaKnownError('P2002', 'idempotencyKey')), true)
  assert.equal(isStockMovementIdempotencyConflict(prismaKnownError('P2002', ['referenceId'])), false)
  assert.equal(isStockMovementIdempotencyConflict(prismaKnownError('P2003', ['idempotencyKey'])), false)
  assert.equal(isStockMovementIdempotencyConflict(new Error('Unique constraint failed')), false)
})
