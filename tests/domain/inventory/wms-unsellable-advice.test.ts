import assert from 'node:assert/strict'
import test from 'node:test'
import {
  wmsStockModeFromSyncMode,
  wmsUnsellableRefundRefusal,
  wmsUnsellableReturnRefusal,
  wmsUnsellableWriteOffAdvice,
} from '@/lib/domain/inventory/wms-unsellable-advice'

/**
 * The write-off route for an unsellable unit held at the 3PL depends on the binding's stock mode. Aligned: the 3PL writes it off and
 * align-down books it; an IMS adjustment as well would write it off twice. IMS master: a real write-off in the warehouse system AND an IMS
 * stock adjustment. Unknown: both, keyed on the mode.
 */

test('the stock mode follows the binding\'s stock sync mode', () => {
  assert.equal(wmsStockModeFromSyncMode('ALIGN_TO_WMS'), 'ALIGNED')
  assert.equal(wmsStockModeFromSyncMode('NOTIFICATION_ONLY'), 'IMS_MASTER')
  assert.equal(wmsStockModeFromSyncMode('DISABLED'), 'IMS_MASTER')
  for (const value of [null, undefined, '', 'align_to_wms']) assert.equal(wmsStockModeFromSyncMode(value), 'UNKNOWN')
})

test('aligned: the 3PL writes it off and align-down books it; no IMS adjustment', () => {
  const advice = wmsUnsellableWriteOffAdvice('ALIGNED')
  assert.match(advice, /write the unit off there/)
  assert.match(advice, /align-down reason/)
  assert.match(advice, /Do not also make a stock adjustment in IMS: that would write the unit off twice/)
  assert.doesNotMatch(advice, /write it off in IMS with a stock adjustment/)
  assert.doesNotMatch(advice, /hold it out of sellable stock/)
})

test('IMS master: a real write-off in the warehouse system and an IMS stock adjustment; never "hold it"', () => {
  const advice = wmsUnsellableWriteOffAdvice('IMS_MASTER')
  assert.match(advice, /a real write-off/)
  assert.match(advice, /write it off in IMS with a stock adjustment/)
  assert.doesNotMatch(advice, /align-down/)
  assert.doesNotMatch(advice, /hold it out of sellable stock/)
})

test('unknown: both routes, keyed on the binding', () => {
  const advice = wmsUnsellableWriteOffAdvice('UNKNOWN')
  assert.match(advice, /if its stock is aligned/)
  assert.match(advice, /do not also adjust in IMS/)
  assert.match(advice, /otherwise .* stock adjustment/)
})

test('every route says the write-off is valued at FIFO, not at the returned unit\'s layer', () => {
  for (const mode of ['ALIGNED', 'IMS_MASTER', 'UNKNOWN'] as const) assert.match(wmsUnsellableWriteOffAdvice(mode), /FIFO/)
})

test('both refusals carry the route of their mode, after restocking as Sellable', () => {
  for (const mode of ['ALIGNED', 'IMS_MASTER', 'UNKNOWN'] as const) {
    const inbox = wmsUnsellableReturnRefusal(mode)
    const refund = wmsUnsellableRefundRefusal(mode)
    assert.ok(inbox.includes(wmsUnsellableWriteOffAdvice(mode)))
    assert.ok(refund.includes(wmsUnsellableWriteOffAdvice(mode)))
    assert.match(inbox, /Restock it as Sellable into the bound warehouse/)
    assert.match(refund, /Record the refund as Sellable/)
    assert.match(inbox, /Nothing was recorded\.$/)
    assert.match(refund, /Nothing was recorded\.$/)
  }
})
