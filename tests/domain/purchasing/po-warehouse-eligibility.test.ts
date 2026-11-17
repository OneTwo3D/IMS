import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkReceiptLocations,
  isAvailableForPurchaseOrders,
  refuseRestrictedDestination,
  selectablePoWarehouses,
} from '@/lib/domain/purchasing/po-warehouse-eligibility'

const WH = [
  { id: 'a', code: 'MIL1', name: 'Mildenhall', availableForPurchaseOrders: true },
  { id: 'q', code: 'QUA', name: 'Quarantine', availableForPurchaseOrders: false },
  { id: 'd', code: 'DROP', name: 'Dropship', availableForPurchaseOrders: false },
  { id: 'legacy', code: 'OLD', name: 'No flag on the row' },
]

/** A reader that behaves like the warehouses table: it returns the restricted rows among the requested ids. */
function fakeClient() {
  return {
    warehouse: {
      findMany: async (args: { where: { id: { in: string[] }; availableForPurchaseOrders: false } }) =>
        WH.filter((w) => args.where.id.in.includes(w.id) && w.availableForPurchaseOrders === false).map(({ id, code, name }) => ({ id, code, name })),
    },
  }
}

test('the flag is on unless it is explicitly false', () => {
  assert.equal(isAvailableForPurchaseOrders({ availableForPurchaseOrders: true }), true)
  assert.equal(isAvailableForPurchaseOrders({ availableForPurchaseOrders: false }), false)
  assert.equal(isAvailableForPurchaseOrders({}), true)
  assert.equal(isAvailableForPurchaseOrders({ availableForPurchaseOrders: null }), true)
})

test('pickers hide restricted warehouses', () => {
  assert.deepEqual(selectablePoWarehouses(WH).map((w) => w.id), ['a', 'legacy'])
})

test('a picker keeps the warehouse an existing order already points at, even when restricted, and only that one', () => {
  assert.deepEqual(selectablePoWarehouses(WH, 'q').map((w) => w.id), ['a', 'q', 'legacy'])
  assert.deepEqual(selectablePoWarehouses(WH, null).map((w) => w.id), ['a', 'legacy'])
  assert.deepEqual(selectablePoWarehouses(WH, '').map((w) => w.id), ['a', 'legacy'])
})

test('a restricted destination is refused with operator wording; an eligible, empty or unknown one passes', async () => {
  const refusal = await refuseRestrictedDestination(fakeClient(), 'q')
  assert.match(refusal ?? '', /QUA — Quarantine is not available for purchase orders/)
  assert.match(refusal ?? '', /Available in purchase orders/)
  assert.equal(await refuseRestrictedDestination(fakeClient(), 'a'), null)
  assert.equal(await refuseRestrictedDestination(fakeClient(), ''), null)
  assert.equal(await refuseRestrictedDestination(fakeClient(), undefined), null)
  assert.equal(await refuseRestrictedDestination(fakeClient(), 'unknown-id'), null)
})

test('an unchanged restricted destination passes (an existing order stays editable); changing to a restricted one is refused', async () => {
  assert.equal(await refuseRestrictedDestination(fakeClient(), 'q', 'q'), null)
  assert.match((await refuseRestrictedDestination(fakeClient(), 'd', 'q')) ?? '', /DROP — Dropship/)
  assert.match((await refuseRestrictedDestination(fakeClient(), 'q', 'a')) ?? '', /QUA — Quarantine/)
})

test('a receipt into a restricted warehouse that is not the order destination is refused', async () => {
  const result = await checkReceiptLocations(fakeClient(), 'a', ['a', 'q'])
  assert.match(result.refusal ?? '', /goods cannot be received into it/)
  assert.deepEqual(result.warnings, [])
})

test('a receipt into the order\'s own restricted destination is allowed with a warning', async () => {
  const result = await checkReceiptLocations(fakeClient(), 'q', ['q', 'q'])
  assert.equal(result.refusal, null)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0]!, /already pointed at it/)
})

test('a receipt into a different restricted warehouse is refused even when the order destination is also restricted', async () => {
  const result = await checkReceiptLocations(fakeClient(), 'q', ['q', 'd'])
  assert.match(result.refusal ?? '', /DROP — Dropship/)
})

test('a receipt across eligible warehouses has no refusal and no warning', async () => {
  assert.deepEqual(await checkReceiptLocations(fakeClient(), null, ['a', 'legacy']), { refusal: null, warnings: [] })
})
