import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  creditedQtyOnPendingAsnLine,
  pendingAsnReservationCarriesCredit,
  planPendingAsnReservationRetirement,
  retirePendingAsnReservation,
  retiredAsnLineNote,
} from '@/lib/domain/wms/pending-asn-retirement'

/**
 * o3d-zzgp round 2, Codex HIGH-1 and HIGH-2 — the decision, on its own.
 *
 * The rule: a pending ASN reservation may be DELETED only while it holds no credit, and
 * a reservation that holds credit is RETIRED with its expectation shrunk to exactly what
 * it was credited. Both halves matter, so both are pinned here: a planner that always
 * retires would leave one closed reservation behind per retry attempt (and every attempt
 * currently fails — o3d-bhvu), and a planner that never retires is the defect.
 */

function line(input: {
  id?: string
  expectedQty: string
  snapshot?: string
  receipt?: string
  lastProcessed?: string
}) {
  return {
    id: input.id ?? 'al-1',
    sourceLineId: 'tl-1',
    expectedQty: new Prisma.Decimal(input.expectedQty),
    qtyAccountedViaSnapshot: new Prisma.Decimal(input.snapshot ?? '0'),
    qtyAccountedViaReceipt: new Prisma.Decimal(input.receipt ?? '0'),
    lastProcessedReceivedQty: new Prisma.Decimal(input.lastProcessed ?? '0'),
  }
}

test('o3d-zzgp: a reservation with no credit anywhere is left alone', () => {
  const lines = [line({ expectedQty: '10' }), line({ id: 'al-2', expectedQty: '5' })]
  assert.equal(pendingAsnReservationCarriesCredit(lines), false)
  assert.equal(planPendingAsnReservationRetirement(lines), null)
})

test('o3d-zzgp: one credited row retires the WHOLE reservation', () => {
  // The retry resizes rows one at a time, so "safe to resize" has to be a property of
  // the reservation, not of the row being resized.
  const lines = [line({ expectedQty: '10', snapshot: '6' }), line({ id: 'al-2', expectedQty: '5' })]
  const retirement = planPendingAsnReservationRetirement(lines)

  assert.ok(retirement, 'a credited reservation must be retired')
  assert.equal(retirement.reason, 'credited')
  assert.equal(retirement.lines.length, 2, 'every row of the reservation goes with it')
  assert.equal(retirement.lines[0]!.retainedCreditQtyNumber, 6)
  assert.equal(retirement.lines[0]!.originalExpectedQty, 10)
  // The uncredited sibling retains nothing, so its own residue is zero as well: a
  // retired reservation must not look like capacity to anything that reads these rows
  // without filtering on `closedAt`.
  assert.equal(retirement.lines[1]!.retainedCreditQtyNumber, 0)
  assert.equal(retirement.lines[1]!.originalExpectedQty, 5)
})

test('o3d-zzgp: the credit is the MAX of the three counters, never their sum', () => {
  // snapshot 6 with 6 absorbed into qtyReceived is still six units, not twelve. Summing
  // would leave the retired row expecting more than it ever reserved, and
  // `getProductIncomingStock` would then report a negative residue to clamp.
  assert.equal(Number(creditedQtyOnPendingAsnLine(line({ expectedQty: '10', snapshot: '6', receipt: '6' }))), 6)
  // A remote regression can push the receipt column past the snapshot column.
  assert.equal(Number(creditedQtyOnPendingAsnLine(line({ expectedQty: '10', snapshot: '4', receipt: '7' }))), 7)
  // And a row the WMS has reported on, with no alignment credit at all, still counts.
  assert.equal(Number(creditedQtyOnPendingAsnLine(line({ expectedQty: '10', lastProcessed: '3' }))), 3)
  assert.equal(pendingAsnReservationCarriesCredit([line({ expectedQty: '10', lastProcessed: '3' })]), true)
})

test('o3d-zzgp: retiring closes the reservation, shrinks the expectation to the credit and says so', async () => {
  const mapUpdates: Array<{ id: string; data: Record<string, unknown> }> = []
  const lineUpdates: Array<{ id: string; data: Record<string, unknown> }> = []
  const client = {
    wmsAsnMap: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        mapUpdates.push({ id: args.where.id, data: args.data })
        return {}
      },
    },
    wmsAsnLineMap: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        lineUpdates.push({ id: args.where.id, data: args.data })
        return {}
      },
    },
  }

  const retirement = planPendingAsnReservationRetirement([line({ expectedQty: '10', snapshot: '6' })])
  assert.ok(retirement)
  await retirePendingAsnReservation(client, 'asn-1', retirement, new Date('2026-03-01T00:00:00Z'))

  assert.deepEqual(mapUpdates, [{
    id: 'asn-1',
    // closedAt is what takes it out of the alignment-candidate population
    // (`asn.closedAt IS NULL`), the reuse lookups and the overdue-ASN watchdog at once.
    data: { closedAt: new Date('2026-03-01T00:00:00Z'), sloAlertedAt: null },
  }])
  assert.equal(lineUpdates.length, 1)
  assert.equal(lineUpdates[0]!.id, 'al-1')
  assert.equal(lineUpdates[0]!.data.expectedQty, '6.0000', 'the expectation becomes exactly the credit')
  assert.match(String(lineUpdates[0]!.data.note), /retired on retry/i)
  assert.match(String(lineUpdates[0]!.data.note), /from 10 to the 6 unit/)
  // AND NOT the credit columns: those are the thing being preserved.
  for (const update of lineUpdates) {
    assert.equal('qtyAccountedViaSnapshot' in update.data, false, 'the credit must not be written')
    assert.equal('qtyAccountedViaReceipt' in update.data, false)
    assert.equal('lastProcessedReceivedQty' in update.data, false)
  }
})

test('o3d-zzgp: the note names both figures', () => {
  const note = retiredAsnLineNote({
    asnLineMapId: 'al-1',
    sourceLineId: 'tl-1',
    retainedCreditQty: new Prisma.Decimal(6),
    retainedCreditQtyNumber: 6,
    originalExpectedQty: 10,
  })
  assert.match(note, /o3d-zzgp/)
  assert.match(note, /from 10 to the 6 unit/)
})
