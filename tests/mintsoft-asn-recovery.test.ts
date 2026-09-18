import assert from 'node:assert/strict'
import test from 'node:test'
import { findRecoverableMintsoftAsn, MintsoftAsnRecoveryWarehouseMismatchError, type MintsoftAsnRecoveryCriteria } from '@/lib/connectors/mintsoft/api/asn-recovery'
import { normalizeMintsoftAsnListRowForRecovery } from '@/lib/connectors/mintsoft/api/client'

/**
 * o3d-bhvu round 2, review M2: THE RECOVER-OR-CREATE DECISION, ON ROWS.
 *
 * Both ASN creators decide "an earlier attempt already created this ASN — recover it" versus "none
 * exists — create one" with findRecoverableMintsoftAsn over the list rows. A wrong "none" creates a
 * DUPLICATE at a live warehouse; a wrong match adopts someone else's ASN. Each case below is a live-shaped
 * /api/ASN/List row (POReference, WarehouseId, Items with SourceLineId and QuantityExpected) put through
 * the same normalizer the creators use, and the assertion is the decision itself.
 */

type Item = { ID: number; SourceLineId: string; QuantityExpected: number }
function row(id: number, poReference: string, warehouseId: number, items: Item[]) {
  return normalizeMintsoftAsnListRowForRecovery({ ID: id, POReference: poReference, WarehouseId: warehouseId, Items: items, QuantityReceieved: 0 })
}

const RESERVATION: MintsoftAsnRecoveryCriteria = {
  reference: 'PO-1',
  externalWarehouseId: '6',
  correlatedCallbackUrl: null,
  lines: [{ sourceLineId: 'line-a', expectedQty: 10 }, { sourceLineId: 'line-b', expectedQty: 2.5 }],
}
const MATCHING_ITEMS: Item[] = [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 10 }, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 2.5 }]

test('an ASN with the same POReference, warehouse and lines is RECOVERED, not created again', () => {
  const found = findRecoverableMintsoftAsn([row(500, 'PO-7', 6, MATCHING_ITEMS), row(501, 'PO-1', 6, MATCHING_ITEMS)], RESERVATION)
  assert.equal(found?.externalAsnId, '501')
})

test('a reference that only shares a PREFIX is not a match: PO-1 never claims PO-10 (review M6)', () => {
  assert.equal(findRecoverableMintsoftAsn([row(510, 'PO-10', 6, MATCHING_ITEMS)], RESERVATION), null, 'PO-10 is another purchase order')
  assert.equal(findRecoverableMintsoftAsn([row(511, 'XPO-1', 6, MATCHING_ITEMS)], RESERVATION), null, 'nor a suffix')
  // And the other way round: a reservation for PO-10 does not claim PO-1's ASN.
  assert.equal(findRecoverableMintsoftAsn([row(512, 'PO-1', 6, MATCHING_ITEMS)], { ...RESERVATION, reference: 'PO-10' }), null)
})

test('surrounding whitespace on either side does not hide the match', () => {
  assert.equal(findRecoverableMintsoftAsn([row(520, '  PO-1 ', 6, MATCHING_ITEMS)], RESERVATION)?.externalAsnId, '520')
  assert.equal(findRecoverableMintsoftAsn([row(521, 'PO-1', 6, MATCHING_ITEMS)], { ...RESERVATION, reference: ' PO-1  ' })?.externalAsnId, '521')
})

test('a different line count, a missing SourceLineId or a different expected quantity is not this ASN', () => {
  assert.equal(findRecoverableMintsoftAsn([row(530, 'PO-1', 6, MATCHING_ITEMS.slice(0, 1))], RESERVATION), null, 'fewer lines')
  assert.equal(findRecoverableMintsoftAsn([row(531, 'PO-1', 6, [...MATCHING_ITEMS, { ID: 3, SourceLineId: 'line-c', QuantityExpected: 1 }])], RESERVATION), null, 'more lines')
  assert.equal(findRecoverableMintsoftAsn([row(532, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-z', QuantityExpected: 2.5 }])], RESERVATION), null, 'another source line')
  assert.equal(findRecoverableMintsoftAsn([row(533, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 3 }])], RESERVATION), null, 'another quantity')
  // Inside the 0.0001 tolerance the quantity still matches: the reservation's figure is a decimal reading.
  assert.equal(findRecoverableMintsoftAsn([row(534, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 2.50005 }])], RESERVATION)?.externalAsnId, '534')
})

test('a match at ANOTHER warehouse (a rebind between the lost attempt and the retry) is refused by name (review M3)', () => {
  // The earlier attempt created ASN 540 at warehouse 5; the binding now points at warehouse 6. Creating
  // again would put a second inbound ASN in Mintsoft; adopting 540 would record an ASN at the wrong
  // warehouse. Neither: the attempt fails, naming both.
  assert.throws(
    () => findRecoverableMintsoftAsn([row(540, 'PO-1', 5, MATCHING_ITEMS)], RESERVATION),
    (error: unknown) => error instanceof MintsoftAsnRecoveryWarehouseMismatchError
      && /ASN 540/.test(error.message) && /warehouse 5/.test(error.message) && /warehouse 6/.test(error.message),
  )
})

test('nothing matching means "create" — and an empty list is the only way to get there, not a partial one', () => {
  assert.equal(findRecoverableMintsoftAsn([], RESERVATION), null)
  assert.equal(findRecoverableMintsoftAsn([row(550, 'PO-2', 6, MATCHING_ITEMS)], RESERVATION), null)
})
