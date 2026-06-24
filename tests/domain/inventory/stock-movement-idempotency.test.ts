import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  isStockMovementIdempotencyConflict,
  manualStockAdjustmentMovementKey,
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

test('manual adjustment key is content-addressed: stable for identical payloads (r9y2)', () => {
  const base = { token: 'tok-1', productId: 'p1', warehouseId: 'w1', qty: -5, reasonId: 'r1' }
  // Same submission token + same payload (a double-click / network retry) → same key.
  assert.equal(manualStockAdjustmentMovementKey(base), manualStockAdjustmentMovementKey(base))
  // Omitted optional fields normalise identically to explicit nulls.
  assert.equal(
    manualStockAdjustmentMovementKey(base),
    manualStockAdjustmentMovementKey({ ...base, note: null, unitCostBase: null, referenceType: null, referenceId: null }),
  )
  assert.match(manualStockAdjustmentMovementKey(base), /^STOCK_ADJUSTMENT:tok-1:[0-9a-f]{64}$/)
})

test('manual adjustment key changes when any meaningful field changes (r9y2)', () => {
  const base = { token: 'tok-1', productId: 'p1', warehouseId: 'w1', qty: -5, reasonId: 'r1' }
  const key = manualStockAdjustmentMovementKey(base)
  // An edit-and-resubmit under the SAME token must NOT collide with the prior key,
  // otherwise the changed adjustment would be silently deduped away.
  assert.notEqual(key, manualStockAdjustmentMovementKey({ ...base, qty: -4 }))
  assert.notEqual(key, manualStockAdjustmentMovementKey({ ...base, productId: 'p2' }))
  assert.notEqual(key, manualStockAdjustmentMovementKey({ ...base, warehouseId: 'w2' }))
  assert.notEqual(key, manualStockAdjustmentMovementKey({ ...base, reasonId: 'r2' }))
  assert.notEqual(key, manualStockAdjustmentMovementKey({ ...base, note: 'cycle count' }))
  assert.notEqual(key, manualStockAdjustmentMovementKey({ ...base, unitCostBase: 1.5 }))
  // A different submission of an identical adjustment (distinct token) also differs,
  // so two genuine separate write-offs both apply.
  assert.notEqual(key, manualStockAdjustmentMovementKey({ ...base, token: 'tok-2' }))
})

test('manual adjustment key canonicalizes a blank/whitespace note to absent (vzlk)', () => {
  const base = { token: 'tok-1', productId: 'p1', warehouseId: 'w1', qty: -5, reasonId: 'r1' }
  const absent = manualStockAdjustmentMovementKey(base)
  // '' / whitespace / null all store identically to an absent note, so they must hash
  // to the same key — otherwise '' vs null could slip a duplicate movement through.
  assert.equal(manualStockAdjustmentMovementKey({ ...base, note: '' }), absent)
  assert.equal(manualStockAdjustmentMovementKey({ ...base, note: '   ' }), absent)
  assert.equal(manualStockAdjustmentMovementKey({ ...base, note: null }), absent)
  // A real note still changes the key, and surrounding whitespace is ignored.
  const noted = manualStockAdjustmentMovementKey({ ...base, note: 'damaged in transit' })
  assert.notEqual(noted, absent)
  assert.equal(manualStockAdjustmentMovementKey({ ...base, note: '  damaged in transit  ' }), noted)
})

test('manual adjustment key rejects a blank/invalid token', () => {
  assert.throws(() => manualStockAdjustmentMovementKey({ token: ' ', productId: 'p1', warehouseId: 'w1', qty: 1 }), /must not be blank/)
  assert.throws(() => manualStockAdjustmentMovementKey({ token: 'tok:1', productId: 'p1', warehouseId: 'w1', qty: 1 }), /invalid characters/)
})

test('manual adjustment key rejects non-finite numbers (would stringify to null and merge)', () => {
  const base = { token: 'tok-1', productId: 'p1', warehouseId: 'w1' }
  assert.throws(() => manualStockAdjustmentMovementKey({ ...base, qty: NaN }), /qty must be a finite number/)
  assert.throws(() => manualStockAdjustmentMovementKey({ ...base, qty: Infinity }), /qty must be a finite number/)
  assert.throws(() => manualStockAdjustmentMovementKey({ ...base, qty: 1, unitCostBase: NaN }), /unitCostBase must be a finite number/)
})

test('manual adjustment key composes a distinct per-line token (tllm): different line ids do not collide', () => {
  // bulkAdjustStock composes `${submissionToken}.${lineId}`; two lines with identical
  // content but distinct stable ids must produce distinct keys so neither is dropped.
  const content = { productId: 'p1', warehouseId: 'w1', qty: -5, reasonId: 'r1' }
  assert.notEqual(
    manualStockAdjustmentMovementKey({ token: 'sub-1.0', ...content }),
    manualStockAdjustmentMovementKey({ token: 'sub-1.1', ...content }),
  )
  // Same line on retry (same composed token + content) dedups.
  assert.equal(
    manualStockAdjustmentMovementKey({ token: 'sub-1.0', ...content }),
    manualStockAdjustmentMovementKey({ token: 'sub-1.0', ...content }),
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
