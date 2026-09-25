import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findRecoverableMintsoftAsn,
  MintsoftAsnRecoveryAmbiguousMatchError,
  MintsoftAsnRecoveryLineSetOverlapError,
  MintsoftAsnRecoveryMapUnreadableError,
  MintsoftAsnRecoveryQuantityConflictError,
  MintsoftAsnRecoveryQuantityRoundedError,
  MintsoftAsnRecoveryLineIdentityUnreadableError,
  MintsoftAsnRecoveryQuantityUnreadableError,
  MintsoftAsnRecoveryWarehouseMismatchError,
  type MintsoftAsnRecoveryCriteria,
} from '@/lib/connectors/mintsoft/api/asn-recovery'
import { normalizeMintsoftAsnListRowForRecovery } from '@/lib/connectors/mintsoft/api/client'
import type { WmsAsnRef } from '@/lib/connectors/wms/types'

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

type Item = { ID?: number | string | null; SourceLineId?: string | number; QuantityExpected?: unknown }
function row(id: number, poReference: string, warehouseId: number, items: Item[]) {
  return normalizeMintsoftAsnListRowForRecovery({ ID: id, POReference: poReference, WarehouseId: warehouseId, Items: items, QuantityReceieved: 0 })
}

/**
 * The verdict the code reached BEFORE round 5: "the line sets differ, so this is somebody else's ASN".
 * Asserting it keeps the round-5 tests honest — each one first shows the row really does look foreign to a
 * line-identity comparison, so the refusal is doing work rather than restating a match that already held.
 */
function hasNoLineIdentityMatch(asn: WmsAsnRef, criteria: MintsoftAsnRecoveryCriteria = RESERVATION): boolean {
  const items = asn.raw?.Items
  const remoteItemCount = Array.isArray(items) ? items.length : asn.lines.length
  if (remoteItemCount !== criteria.lines.length) return true
  const bySourceId = new Set(asn.lines.map((line) => line.sourceLineId))
  return !criteria.lines.every((line) => bySourceId.has(line.sourceLineId))
}

/**
 * ROUND 7: every case below states what IMS has already recorded, because the verdict now depends on it. The
 * default is the state a lost create leaves: the remote ASN carries an id IMS has NO map row for.
 */
const NOTHING_MAPPED = { kind: 'readable', mappedExternalAsnIds: new Set<string>() } as const
const mapped = (...externalAsnIds: string[]) => ({ kind: 'readable' as const, mappedExternalAsnIds: new Set(externalAsnIds) })

const RESERVATION: MintsoftAsnRecoveryCriteria = {
  reference: 'PO-1',
  externalWarehouseId: '6',
  lines: [{ sourceLineId: 'line-a', expectedQty: 10 }, { sourceLineId: 'line-b', expectedQty: 2.5 }],
  mapKnowledge: NOTHING_MAPPED,
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

test('an ASN over UNRELATED SOURCE LINES is not this one, and creating ours is right', () => {
  // Determinate evidence, and the strongest duplicate recovery has: every identity on the row was readable,
  // so its item set is known exactly, and it shares NOTHING with this reservation's set. A source line id is
  // an IMS primary key — it does not change under a reservation, and Mintsoft returns it verbatim — so an
  // ASN over none of our lines is an ASN for other goods, whatever its reference says.
  assert.equal(findRecoverableMintsoftAsn([row(530, 'PO-1', 6, [{ ID: 9, SourceLineId: 'line-y', QuantityExpected: 10 }, { ID: 8, SourceLineId: 'line-z', QuantityExpected: 1 }])], RESERVATION), null)
  assert.equal(findRecoverableMintsoftAsn([row(531, 'PO-1', 6, [{ ID: 9, SourceLineId: 'line-y', QuantityExpected: 10 }])], RESERVATION), null, 'and with a different item count')
  // Inside the 0.0001 tolerance the quantity still matches: the reservation's figure is a decimal reading.
  assert.equal(findRecoverableMintsoftAsn([row(534, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 2.50005 }])], RESERVATION)?.externalAsnId, '534')
})

/**
 * ROUND 7, CODEX HIGH: AN OVERLAPPING LINE SET IS NOT PROOF THAT THE PRIOR ASN IS UNRELATED.
 *
 * THE SEQUENCE, WHICH THE PURCHASE-ORDER PATH MAKES REACHABLE: Mintsoft creates the ASN, IMS loses the
 * response, and before the retry a line is ADDED to the purchase order. `reserveAsn` refreshes the pending
 * reservation's lines from the order's CURRENT outstanding lines, so the retry covers {a,b,c} while the ASN
 * at the warehouse holds {a,b}. Until this round the differing line set was proof of absence, the matcher
 * answered "create one", and the warehouse was sent a second inbound ASN for a and b — it expects the same
 * goods twice.
 *
 * WHY THE FIX IS THE ASN MAP AND NOT "REFUSE EVERY OVERLAP". Every ASN for a purchase order carries the
 * ORDER's reference, so a second ASN over a different set of its lines is how a partial delivery works;
 * refusing every overlap would put an operator in front of every multi-ASN order (which is exactly why round
 * 6 left this permitted). A create whose response was lost leaves an ASN IMS has NO map row for — that is
 * what "lost" means — so mapped-ness separates the two populations exactly, and only the unmapped overlap
 * refuses.
 */
test('a lost response plus a CHANGED LINE SET is refused, and a partial IMS has already mapped still creates (round 7, Codex HIGH)', () => {
  const RETRY: MintsoftAsnRecoveryCriteria = {
    ...RESERVATION,
    lines: [...RESERVATION.lines, { sourceLineId: 'line-c', expectedQty: 4 }],
  }
  const atTheWarehouse = row(700, 'PO-1', 6, MATCHING_ITEMS)
  // PRECONDITION, so the refusal is doing work: to a line-set comparison this row really does look like
  // somebody else's ASN — which is the answer that sent the second ASN.
  assert.equal(hasNoLineIdentityMatch(atTheWarehouse, RETRY), true, 'precondition: the line sets really do differ')
  assert.throws(
    () => findRecoverableMintsoftAsn([atTheWarehouse], RETRY),
    (error: unknown) => error instanceof MintsoftAsnRecoveryLineSetOverlapError
      && /ASN 700/.test(error.message) && /PO-1/.test(error.message)
      && /line-a, line-b/.test(error.message) && /NO ASN WILL BE CREATED/.test(error.message),
    'an UNMAPPED ASN covering line-a and line-b blocks the create',
  )
  // The same row, once IMS has recorded it: a legitimate earlier partial, and the ASN for the added line
  // goes out without an operator.
  assert.equal(findRecoverableMintsoftAsn([atTheWarehouse], { ...RETRY, mapKnowledge: mapped('700') }), null)
  // Being mapped is about THIS ASN, not about the map having anything in it at all.
  assert.throws(
    () => findRecoverableMintsoftAsn([atTheWarehouse], { ...RETRY, mapKnowledge: mapped('4242', '4243') }),
    (error: unknown) => error instanceof MintsoftAsnRecoveryLineSetOverlapError,
  )

  // THE OTHER DIRECTION — a line REMOVED from the order, so the ASN at the warehouse holds MORE than the
  // retry covers. Same shape, same answer.
  const superset = row(701, 'PO-1', 6, [...MATCHING_ITEMS, { ID: 3, SourceLineId: 'line-c', QuantityExpected: 4 }])
  assert.equal(hasNoLineIdentityMatch(superset), true, 'precondition: the line sets really do differ')
  assert.throws(
    () => findRecoverableMintsoftAsn([superset], RESERVATION),
    (error: unknown) => error instanceof MintsoftAsnRecoveryLineSetOverlapError && /ASN 701/.test(error.message),
  )
  assert.equal(findRecoverableMintsoftAsn([superset], { ...RESERVATION, mapKnowledge: mapped('701') }), null)

  // AN UNREADABLE MAP IS NOT PERMISSION. If IMS cannot read its own ASN map it cannot tell a partial it
  // recorded from the ASN a lost create left behind, so the create is refused rather than let through — the
  // same rule this branch applies to an unreadable ASN list, an unreadable line identity and an unreadable
  // quantity, applied for once to IMS's own state.
  assert.throws(
    () => findRecoverableMintsoftAsn([atTheWarehouse], { ...RETRY, mapKnowledge: { kind: 'unreadable', detail: 'connection refused' } }),
    (error: unknown) => error instanceof MintsoftAsnRecoveryMapUnreadableError
      && /ASN 700/.test(error.message) && /connection refused/.test(error.message)
      && /NO ASN WILL BE CREATED/.test(error.message),
  )
  // …and it does not block what needs no map: a row for ANOTHER reference is ruled out by the reference
  // alone, so an unreadable map still leaves an ordinary create able to proceed.
  assert.equal(
    findRecoverableMintsoftAsn([row(702, 'PO-2', 6, MATCHING_ITEMS)], { ...RETRY, mapKnowledge: { kind: 'unreadable', detail: 'connection refused' } }),
    null,
  )
})

test('a quantity conflict on an ASN IMS has ALREADY MAPPED is a legitimate later partial, not an operator’s problem (round 7 / o3d-54al)', () => {
  // Round 6 refused every same-lines, different-quantity row, and said so: it blocked a second legitimate
  // partial over the same lines until the already-mapped check landed. It has landed, so the mapped case
  // creates again while the UNMAPPED one — an ASN a lost create made whose quantity has changed since, or an
  // operator's edit at the warehouse — still refuses.
  const partial = row(710, 'PO-1', 6, [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 4 }, MATCHING_ITEMS[1]!])
  assert.throws(
    () => findRecoverableMintsoftAsn([partial], RESERVATION),
    (error: unknown) => error instanceof MintsoftAsnRecoveryQuantityConflictError && /ASN 710/.test(error.message),
    'unmapped: still the round-6 refusal',
  )
  assert.equal(findRecoverableMintsoftAsn([partial], { ...RESERVATION, mapKnowledge: mapped('710') }), null, 'mapped: a partial IMS recorded')
  // With the map unreadable it is refused, by the name that says why.
  assert.throws(
    () => findRecoverableMintsoftAsn([partial], { ...RESERVATION, mapKnowledge: { kind: 'unreadable', detail: 'pool timeout' } }),
    (error: unknown) => error instanceof MintsoftAsnRecoveryMapUnreadableError && /ASN 710/.test(error.message) && /pool timeout/.test(error.message),
  )
  // Being mapped does NOT make an ASN that matches exactly disappear: it is still adopted, never duplicated.
  assert.equal(findRecoverableMintsoftAsn([row(711, 'PO-1', 6, MATCHING_ITEMS)], { ...RESERVATION, mapKnowledge: mapped('711') })?.externalAsnId, '711')
  // …nor does it make an unreadable row readable: what that ASN covers is still unknown, so it still refuses.
  assert.throws(
    () => findRecoverableMintsoftAsn([row(712, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, QuantityExpected: 2.5 }])], { ...RESERVATION, mapKnowledge: mapped('712') }),
    (error: unknown) => error instanceof MintsoftAsnRecoveryLineIdentityUnreadableError && /ASN 712/.test(error.message),
  )
})

/**
 * ROUND 6, CODEX HIGH 2: A QUANTITY THAT MERELY DIFFERS IS NOT PERMISSION TO CREATE A DUPLICATE.
 *
 * Until this round, a row carrying our reference and EXACTLY our line ids, whose quantity differed by more
 * than rounding could explain, was answered with "no such ASN exists" — and the creator pushed a SECOND
 * inbound ASN at a live warehouse for lines the first already covers. That is what an ASN a lost create
 * really made looks like after the source quantity changed (the reservation checks validate the CURRENT
 * LOCAL quantities, never whether the earlier remote ASN exists), and equally what an operator's edit at
 * the warehouse looks like. It is refused by name instead, naming the ASN, the line and both figures.
 */
test('a same-reference, same-line-id ASN whose QUANTITY differs is an unresolved conflict, never a licence to create (round 6, Codex HIGH 2)', () => {
  for (const [label, items, criteria, line, remote, expected] of [
    ['a whole-number difference on one line', [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 12 }, MATCHING_ITEMS[1]!], RESERVATION, 'line-a', 12, 10],
    ['a quantity of zero', [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 0 }, MATCHING_ITEMS[1]!], RESERVATION, 'line-a', 0, 10],
    ['a whole unit away from a FRACTIONAL expectation, which rounding cannot explain', [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 4 }], RESERVATION, 'line-b', 4, 2.5],
    ['a single-line reservation', [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 11 }], { ...RESERVATION, lines: [{ sourceLineId: 'line-a', expectedQty: 10 }] }, 'line-a', 11, 10],
  ] as const) {
    const asn = row(533, 'PO-1', 6, [...items] as Item[])
    // PRECONDITION, so the refusal is doing work rather than restating a state that never arises: the row
    // really does carry our reference and EXACTLY our line ids, and the quantity really is readable.
    assert.equal(hasNoLineIdentityMatch(asn, criteria), false, `precondition (${label}): the line identity matches`)
    assert.equal(asn.lines.find((entry) => entry.sourceLineId === line)?.expectedQty, remote, `precondition (${label}): and the remote EXPECTED quantity is readable`)
    assert.throws(
      () => findRecoverableMintsoftAsn([asn], criteria),
      (error: unknown) => error instanceof MintsoftAsnRecoveryQuantityConflictError
        && /ASN 533/.test(error.message) && new RegExp(line).test(error.message)
        && new RegExp(`expects ${remote} `).test(error.message) && new RegExp(`reservation expects ${expected}`).test(error.message)
        && /NO ASN WILL BE CREATED/.test(error.message),
      label,
    )
  }
  // The ASN whose quantities DO match is still recovered, so the refusal has not swallowed the match.
  assert.equal(findRecoverableMintsoftAsn([row(535, 'PO-1', 6, MATCHING_ITEMS)], RESERVATION)?.externalAsnId, '535')
})

test('an item Mintsoft returned but the normalizer could not read STILL COUNTS (review L-a)', () => {
  // normalizeMintsoftAsnListRowForRecovery drops an item whose SourceLineId cannot be one of ours — most of
  // this tenant's ASNs come from another integration and carry none — so counting the NORMALIZED lines
  // made an ASN with an extra item look like "exactly our two lines" and adopted it. The raw Items array is
  // the count, so an ASN carrying a third item is not ours. ROUND 5 SPLITS THIS CASE (Codex HIGH 2): a
  // DETERMINATE foreign identity (a numeric SourceLineId, which an IMS cuid can never be) still means "not
  // ours"; one that cannot be READ at all is refused instead, by the test below.
  const withForeignExtra = row(536, 'PO-1', 6, [...MATCHING_ITEMS, { ID: 4, SourceLineId: 77, QuantityExpected: 1 }])
  assert.equal(withForeignExtra.lines.length, 2, 'precondition: the normalizer really does drop that item')
  assert.equal((withForeignExtra.raw?.Items as unknown[]).length, 3, 'precondition: and Mintsoft really did return three')
  // ROUND 7 tightens what happens next. The row carries our reference and BOTH our lines plus an item that
  // is determinately another integration's, so its set is not ours — but it OVERLAPS ours completely, and an
  // ASN IMS never recorded that already covers these lines is refused rather than answered with "create one".
  assert.throws(
    () => findRecoverableMintsoftAsn([withForeignExtra], RESERVATION),
    (error: unknown) => error instanceof MintsoftAsnRecoveryLineSetOverlapError && /ASN 536/.test(error.message),
    'an unmapped row covering our lines, whatever else it carries',
  )
  assert.equal(findRecoverableMintsoftAsn([withForeignExtra], { ...RESERVATION, mapKnowledge: mapped('536') }), null, 'once IMS has recorded it, a numeric SourceLineId is another integration\u2019s')
  // A row over lines that are all determinately another integration's is unrelated, and still creates.
  assert.equal(findRecoverableMintsoftAsn([row(537, 'PO-1', 6, [{ ID: 4, SourceLineId: 77, QuantityExpected: 1 }, { ID: 5, SourceLineId: 78, QuantityExpected: 1 }])], RESERVATION), null)
  // The same, on a row for ANOTHER reference: an unreadable item there is not our concern at all.
  assert.equal(findRecoverableMintsoftAsn([row(538, 'PO-9', 6, [...MATCHING_ITEMS, { ID: 5, QuantityExpected: 1 }])], RESERVATION), null)
})

/**
 * ROUND 5, CODEX HIGH 2: AN UNREADABLE LINE IDENTITY IS NOT PERMISSION TO CREATE A DUPLICATE.
 *
 * The shape that matters is the FIRST case: our own ASN, our reference, our two items, but one item's
 * SourceLineId comes back degraded. The normalizer drops it, hasSameLineIdentity no longer finds line-b,
 * the row reads as somebody else's, findRecoverableMintsoftAsn returns null — and the creator pushes a
 * SECOND ASN at a live warehouse for lines the first one already covers. It is refused by name instead.
 */
test('a row carrying OUR reference whose line identity cannot be read is UNRESOLVED, never a licence to create (round 5, Codex HIGH 2)', () => {
  for (const [label, degraded] of [
    ['absent', { ID: 2, QuantityExpected: 2.5 }],
    ['null', { ID: 2, SourceLineId: null, QuantityExpected: 2.5 }],
    ['blank', { ID: 2, SourceLineId: '   ', QuantityExpected: 2.5 }],
    ['not an object', 'line-b'],
  ] as const) {
    const ours = row(590, 'PO-1', 6, [MATCHING_ITEMS[0]!, degraded as never])
    assert.equal(ours.lines.length, 1, `precondition (${label}): the degraded item really is dropped`)
    assert.equal((ours.raw?.Items as unknown[]).length, 2, `precondition (${label}): Mintsoft still returned two`)
    assert.equal(hasNoLineIdentityMatch(ours), true, `precondition (${label}): the old code called this somebody else's ASN`)
    assert.throws(
      () => findRecoverableMintsoftAsn([ours], RESERVATION),
      (error: unknown) => error instanceof MintsoftAsnRecoveryLineIdentityUnreadableError
        && /ASN 590/.test(error.message) && /PO-1/.test(error.message),
      `a ${label} SourceLineId`,
    )
  }

  // An EXTRA item we cannot read, on a row with our reference, is the same refusal: the row cannot be
  // excluded, so it cannot be answered with "create another one" either.
  assert.throws(
    () => findRecoverableMintsoftAsn([row(591, 'PO-1', 6, [...MATCHING_ITEMS, { ID: 3, QuantityExpected: 1 }])], RESERVATION),
    (error: unknown) => error instanceof MintsoftAsnRecoveryLineIdentityUnreadableError && /ASN 591/.test(error.message),
  )

  // Several such rows: all named, in sorted order, so which one the refusal blames does not depend on the
  // list's order across pages (review M-b).
  const rows = [row(593, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, QuantityExpected: 2.5 }]), row(592, 'PO-1', 6, [{ ID: 1, QuantityExpected: 10 }, MATCHING_ITEMS[1]!])]
  for (const order of [rows, [...rows].reverse()]) {
    assert.throws(
      () => findRecoverableMintsoftAsn(order, RESERVATION),
      (error: unknown) => error instanceof MintsoftAsnRecoveryLineIdentityUnreadableError && /ASNs 592, 593/.test(error.message),
    )
  }

  // And it does not swallow the ordinary path: every item readable still recovers the ASN.
  assert.equal(findRecoverableMintsoftAsn([row(594, 'PO-1', 6, MATCHING_ITEMS)], RESERVATION)?.externalAsnId, '594')
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
  // THIS refusal is only for a difference rounding could explain; a difference it cannot explain is the
  // round-6 conflict above, not a licence to create. Either way nothing is created — what changes is which
  // error names the state, because "Mintsoft rounded our 2.5" and "somebody changed the quantity" need
  // different things done about them.
  assert.throws(
    () => findRecoverableMintsoftAsn([row(571, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: 4 }])], RESERVATION),
    (error: unknown) => error instanceof MintsoftAsnRecoveryQuantityConflictError,
    '2.5 cannot be stored as 4, so rounding is not the explanation — but it is still not a different ASN',
  )
  // …and a reservation whose lines are all whole numbers is never refused as a ROUNDING case: it round-trips.
  const whole: MintsoftAsnRecoveryCriteria = { ...RESERVATION, lines: [{ sourceLineId: 'line-a', expectedQty: 10 }] }
  assert.throws(
    () => findRecoverableMintsoftAsn([row(572, 'PO-1', 6, [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 11 }])], whole),
    (error: unknown) => error instanceof MintsoftAsnRecoveryQuantityConflictError,
  )
  assert.equal(findRecoverableMintsoftAsn([row(573, 'PO-1', 6, [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 10 }])], whole)?.externalAsnId, '573')
})

test('an expected quantity Mintsoft did not return is UNRESOLVED, never permission to create another ASN (round 4, Codex HIGH 1)', () => {
  // A degraded row — the key absent, null, a string, a NaN — used to normalize to quantity null, which the
  // matcher read as "a different quantity", which is "no such ASN exists, create one". For a row carrying
  // OUR reference and OUR line ids that answer pushes a second ASN to a live warehouse. It is refused by
  // name instead, exactly like the ambiguous-match and rounded-quantity refusals.
  for (const [label, quantityExpected] of [
    ['the key absent', undefined],
    ['null', null],
    ['a string', '2.5'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as const) {
    const asn = row(580, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: 2, SourceLineId: 'line-b', QuantityExpected: quantityExpected }])
    assert.equal(asn.lines.length, 2, `precondition (${label}): the line is still matched by SourceLineId`)
    assert.equal(asn.lines[1]!.expectedQty, null, `precondition (${label}): and its expected quantity is unreadable`)
    assert.throws(
      () => findRecoverableMintsoftAsn([asn], RESERVATION),
      (error: unknown) => error instanceof MintsoftAsnRecoveryQuantityUnreadableError
        && /ASN 580/.test(error.message) && /line-b/.test(error.message) && /2\.5/.test(error.message)
        && /NO ASN WILL BE CREATED/.test(error.message),
      `remote quantity ${label}`,
    )
  }
  // Unreadable OUTRANKS a readable difference on another line: while any line cannot be read, this ASN
  // cannot be told apart from ours, so "not ours, create one" is not available.
  assert.throws(
    () => findRecoverableMintsoftAsn(
      [row(581, 'PO-1', 6, [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 12 }, { ID: 2, SourceLineId: 'line-b', QuantityExpected: null }])],
      RESERVATION,
    ),
    (error: unknown) => error instanceof MintsoftAsnRecoveryQuantityUnreadableError && /ASN 581/.test(error.message),
    'a different quantity on line-a does not license creating another ASN while line-b is unreadable',
  )
  // And a readable quantity of zero is a quantity, not an unreadable one — so it is the round-6 CONFLICT
  // refusal, by a different name, rather than the unreadable one. (Before round 6 it was "some other ASN,
  // create another".)
  assert.throws(
    () => findRecoverableMintsoftAsn([row(582, 'PO-1', 6, [{ ID: 1, SourceLineId: 'line-a', QuantityExpected: 0 }, MATCHING_ITEMS[1]!])], RESERVATION),
    (error: unknown) => error instanceof MintsoftAsnRecoveryQuantityConflictError && /ASN 582/.test(error.message),
  )
})

test('an item carrying OUR source line id but no item ID of its own is refused by the normalizer, not dropped (round 4)', () => {
  // The same failure one step earlier. Dropping it left the row with one line against two items, so
  // hasSameLineIdentity called the ASN somebody else's and the creator pushed a duplicate. The row is
  // refused instead, with the ASN and the line named.
  for (const [label, id] of [['null', null], ['absent', undefined], ['blank', '  ']] as const) {
    assert.throws(
      () => row(583, 'PO-1', 6, [MATCHING_ITEMS[0]!, { ID: id, SourceLineId: 'line-b', QuantityExpected: 2.5 }]),
      (error: unknown) => error instanceof Error
        && error.name === 'MintsoftAsnListIncompleteError'
        && /ASN 583/.test(error.message) && /line-b/.test(error.message) && /no item ID/.test(error.message),
      `item ID ${label}`,
    )
  }
  // An item with a DETERMINATE foreign SourceLineId is still DROPPED and still COUNTED (review L-a): it is
  // not ours, and it is not unreadable either. (One that cannot be read at all is refused — round 5.)
  const notOurs = row(584, 'PO-1', 6, [...MATCHING_ITEMS, { SourceLineId: 4242, QuantityExpected: 1 }])
  assert.equal(notOurs.lines.length, 2)
  assert.equal((notOurs.raw?.Items as unknown[]).length, 3)
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
