import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findRecoverableMintsoftAsn,
  MintsoftAsnRecoveryAmbiguousMatchError,
  MintsoftAsnRecoveryQuantityRoundedError,
  MintsoftAsnRecoveryWarehouseMismatchError,
  type MintsoftAsnRecoveryCriteria,
} from '@/lib/connectors/mintsoft/api/asn-recovery'
import { normalizeMintsoftAsnListRowForRecovery } from '@/lib/connectors/mintsoft/api/client'

/**
 * o3d-bhvu round 2 (review M2) and round 3 (review M-b, L-a, L-b): THE RECOVER-OR-CREATE DECISION, ON ROWS.
 *
 * Both ASN creators decide "an earlier attempt already created this ASN — recover it" versus "none
 * exists — create one" with findRecoverableMintsoftAsn over the list rows. A wrong "none" creates a
 * DUPLICATE at a live warehouse; a wrong match adopts someone else's ASN. Each case below is a live-shaped
 * /api/ASN/List row (POReference, WarehouseId, Items with SourceLineId and QuantityExpected) put through
 * the same normalizer the creators use, and the assertion is the decision itself.
 *
 * ROUND 3 ADDS THE CASES THE LIST CAN ACTUALLY PRODUCE: two rows that both match (where round 2 let the
 * unstable list order decide), an ASN carrying an item this tenant's other integration wrote without a
 * SourceLineId (which the normalizer drops, so counting normalized lines missed it), and a whole-number
 * `QuantityExpected` against a fractional reservation — Mintsoft types that field as int32, so it is the
 * only shape a fractional expectation can come back in.
 */

type Item = { ID: number; SourceLineId?: string | number; QuantityExpected: number }
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

test('a different line count, a missing SourceLineId or a quantity rounding cannot explain is not this ASN', () => {
  assert.equal(findRecoverableMintsoftAsn([row(530, 'PO-1', 6, MATCHING_ITEMS.slice(0, 1))], RESERVATION), null, 'fewer lines')
  assert.equal(findRecoverableMintsoftAsn([row(531, 'PO-1', 6, [...MATCHING_ITEMS, { ID: 3, SourceLineId: 'line-c', QuantityExpected: 1 }])], RESERVATION), null, 'more lines')
  assert.equal(findRecoverableMintsoftAsn([row(532, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-z', QuantityExpected: 2.5 }])], RESERVATION), null, 'another source line')
  // A WHOLE-NUMBER expectation against a different whole number: rounding cannot produce that, so this is
  // some other ASN and creating ours is right. (The fractional case is the test below, and is refused.)
  assert.equal(findRecoverableMintsoftAsn([row(533, 'PO-1', 6, [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 12 }, MATCHING_ITEMS[1]!])], RESERVATION), null, 'another quantity')
  // Inside the 0.0001 tolerance the quantity still matches: the reservation's figure is a decimal reading.
  assert.equal(findRecoverableMintsoftAsn([row(534, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 2.50005 }])], RESERVATION)?.externalAsnId, '534')
})

test('an item Mintsoft returned but the normalizer could not read STILL COUNTS (review L-a)', () => {
  // normalizeMintsoftAsnListRowForRecovery drops an item without a usable string SourceLineId — most of
  // this tenant's ASNs come from another integration and carry none — so counting the NORMALIZED lines
  // made an ASN with an extra item look like "exactly our two lines" and adopted it. The raw Items array
  // is the count, so an ASN carrying a third item is not ours, whatever shape that item is in.
  const withUnreadableExtra = row(535, 'PO-1', 6, [...MATCHING_ITEMS, { ID: 3, QuantityExpected: 1 }])
  assert.equal(withUnreadableExtra.lines.length, 2, 'precondition: the normalizer really does drop that item')
  assert.equal((withUnreadableExtra.raw?.Items as unknown[]).length, 3, 'precondition: and Mintsoft really did return three')
  assert.equal(findRecoverableMintsoftAsn([withUnreadableExtra], RESERVATION), null, 'an item with no SourceLineId')
  assert.equal(findRecoverableMintsoftAsn([row(536, 'PO-1', 6, [...MATCHING_ITEMS, { ID: 4, SourceLineId: 77, QuantityExpected: 1 }])], RESERVATION), null, 'a numeric SourceLineId')
  assert.equal(findRecoverableMintsoftAsn([row(537, 'PO-1', 6, [...MATCHING_ITEMS, { ID: 5, SourceLineId: '   ', QuantityExpected: 1 }])], RESERVATION), null, 'a blank one')
})

test('TWO ASNs that both match are refused, in EITHER order the list returns them (review M-b)', () => {
  // Round 2 sorted the candidates by a CreatedAt that live rows do not carry, so every row sorted equal
  // and the list's order — documented as unstable across pages — decided whether ASN 560 was adopted or
  // ASN 561 was, and at another warehouse whether the attempt adopted or threw. Two ASNs with this
  // reference and these line ids mean the duplicate has already happened: neither is adopted, and no
  // third is created.
  const first = row(560, 'PO-1', 6, MATCHING_ITEMS)
  const second = row(561, 'PO-1', 6, MATCHING_ITEMS)
  for (const order of [[first, second], [second, first]]) {
    assert.throws(
      () => findRecoverableMintsoftAsn(order, RESERVATION),
      (error: unknown) => error instanceof MintsoftAsnRecoveryAmbiguousMatchError
        && /ASNs 56[01], 56[01]/.test(error.message) && /560/.test(error.message) && /561/.test(error.message),
      `order ${order.map((asn) => asn.externalAsnId).join(',')}`,
    )
  }
  // And the same two rows at DIFFERENT warehouses: still the ambiguity, not whichever verdict the order
  // happened to reach first (round 2 gave "adopt 560" one way and "warehouse mismatch on 561" the other).
  const elsewhere = row(561, 'PO-1', 5, MATCHING_ITEMS)
  for (const order of [[first, elsewhere], [elsewhere, first]]) {
    assert.throws(
      () => findRecoverableMintsoftAsn(order, RESERVATION),
      (error: unknown) => error instanceof MintsoftAsnRecoveryAmbiguousMatchError,
      `mixed-warehouse order ${order.map((asn) => asn.externalAsnId).join(',')}`,
    )
  }
})

test('a FRACTIONAL expectation against Mintsoft’s whole-number store is refused, never created again (review L-b)', () => {
  // Mintsoft types ASNItem.QuantityExpected as int32, so a reservation line of 2.5 comes back as 2 or as 3
  // by a rounding rule Mintsoft does not publish. Round 2 answered that with "no match", which creates a
  // SECOND ASN at a live warehouse for the same lines. It cannot be told apart from a genuinely different
  // ASN either, so the attempt fails naming the ASN, the line and both figures, and an operator decides.
  for (const remote of [3, 2]) {
    assert.throws(
      () => findRecoverableMintsoftAsn([row(570, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: remote }])], RESERVATION),
      (error: unknown) => error instanceof MintsoftAsnRecoveryQuantityRoundedError
        && /ASN 570/.test(error.message) && /line-b/.test(error.message) && /2\.5/.test(error.message) && new RegExp(`expects ${remote} `).test(error.message),
      `remote quantity ${remote}`,
    )
  }
  // The refusal is only for a difference rounding could explain. A whole unit away from a FRACTIONAL
  // expectation is not: 2.5 cannot be stored as 4.
  assert.equal(findRecoverableMintsoftAsn([row(571, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 4 }])], RESERVATION), null)
  // …and a reservation whose lines are all whole numbers is never refused this way: it round-trips.
  const whole: MintsoftAsnRecoveryCriteria = { ...RESERVATION, lines: [{ sourceLineId: 'line-a', expectedQty: 10 }] }
  assert.equal(findRecoverableMintsoftAsn([row(572, 'PO-1', 6, [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 11 }])], whole), null)
  assert.equal(findRecoverableMintsoftAsn([row(573, 'PO-1', 6, [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 10 }])], whole)?.externalAsnId, '573')
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
