import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * SOURCE PINS for the wiring that no behavioural test can see from inside a unit: which callers pass the trim flag,
 * and that the returns-inbox restock clears expectations under the order lock before it books stock. The behaviour
 * behind each flag is tested elsewhere (DB and concurrency tiers); these pin that the callers still ask for it.
 */
const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8')

test('the immediate post-refund release and the outbox drain both ask for the unshipped trim, beside the refusal', () => {
  assert.match(read('app/actions/sales.ts'), /refuseIfShipmentsExist: true,[\s\S]{0,400}trimUnshippedWhenShipmentsExist: true,/)
  assert.match(read('lib/domain/sales/refund-reservation-release-outbox.ts'), /refuseIfShipmentsExist: true,[\s\S]{0,300}trimUnshippedWhenShipmentsExist: true,/)
})

test('autoAllocateOrder hands the trim flag to the allocator, and the allocator only trims when BOTH flags are set', () => {
  assert.match(read('app/actions/allocation.ts'), /trimUnshippedWhenShipmentsExist: options\?\.trimUnshippedWhenShipmentsExist,/)
  assert.match(read('lib/domain/sales/allocation-service.ts'), /if \(input\.refuseIfShipmentsExist && input\.trimUnshippedWhenShipmentsExist\) \{\n\s*const trim = await trimUnshippedAllocationsForRefundTx\(/)
})

test('other refuse-if-shipments callers do NOT trim (only the refund paths do)', () => {
  for (const file of ['lib/fulfillment/pre-fulfilment-reallocation.ts', 'lib/fulfillment/reallocation-sweep.ts']) {
    assert.doesNotMatch(read(file), /trimUnshippedWhenShipmentsExist/, file)
  }
})

test('the returns-inbox restock takes the order lock, then clears expectations, and books the rows the clearing returns', () => {
  const text = read('app/actions/mintsoft-sync.ts')
  assert.match(text, /await lockSalesOrder\(tx, item\.orderId\)[\s\S]{0,600}receiveReturnAgainstExpectationsTx\(tx, \{/)
  assert.match(text, /if \(receipt\.expectationIds\.length > 0\) rows = receipt\.rows/)
  assert.match(text, /const receiptAccounting = await readReceiptAccounting\(\)/)
})
