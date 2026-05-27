import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
    refundInboundMovementKey({ refundId: 'refund-1', refundLineId: 'refund-line-1' }),
    'RETURN_INBOUND:refund:refund-1:line:refund-line-1',
  )
})

test('rejects blank or delimiter-containing key parts', () => {
  assert.throws(() => saleDispatchMovementKey(' '), /must not be blank/)
  assert.throws(
    () => refundInboundMovementKey({ refundId: 'refund:1', refundLineId: 'line-1' }),
    /must not contain/,
  )
})
