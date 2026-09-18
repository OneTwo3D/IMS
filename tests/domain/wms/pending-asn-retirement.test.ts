import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  PendingAsnDisposalBackstopError,
  creditedQtyOnPendingAsnLine,
  disposePendingTransferAsnReservation,
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

// ---------------------------------------------------------------------------
// o3d-zzgp round 3 (Codex HIGH): the decision is HELD across the act it guards.
//
// These are the unit-level half. The race itself is proved against real PostgreSQL in
// tests/concurrency/pending-asn-disposal-race.concurrent.test.ts; what is pinned here
// is the SEQUENCE a real interleaving cannot cheaply enumerate — that the three locks
// are taken in the established order, that every credit read the decision uses comes
// after all three, and that the delete carries the backstop and refuses loudly when it
// fires.
// ---------------------------------------------------------------------------

type FakeLine = {
  id: string
  sourceLineId: string
  productId: string
  sku: string
  expectedQty: Prisma.Decimal
  qtyAccountedViaSnapshot: Prisma.Decimal
  qtyAccountedViaReceipt: Prisma.Decimal
  lastProcessedReceivedQty: Prisma.Decimal
  note: string | null
}

function fakeTx(options: {
  lines: FakeLine[]
  headerMatches?: boolean
  /** Runs immediately before the delete statement: a writer that ignored the locks. */
  beforeDelete?: (lines: FakeLine[]) => void
}) {
  const events: string[] = []
  const state = { lines: options.lines, headerDeleted: false, closedAt: null as Date | null }
  const credited = (line: FakeLine) => !line.qtyAccountedViaSnapshot.equals(0)
    || !line.qtyAccountedViaReceipt.equals(0)
    || !line.lastProcessedReceivedQty.equals(0)
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?')
      const table = /FROM (\w+)/.exec(sql)?.[1] ?? 'unknown'
      events.push(`lock:${table}`)
      return []
    },
    wmsAsnMap: {
      findFirst: async () => {
        events.push('read:header')
        return options.headerMatches === false ? null : { id: 'asn-1' }
      },
      update: async (args: { data: { closedAt?: Date } }) => {
        events.push('write:retire-header')
        state.closedAt = args.data.closedAt ?? null
        return {}
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        options.beforeDelete?.(state.lines)
        events.push('write:delete-header')
        if (args.where.lines && state.lines.some(credited)) return { count: 0 }
        state.headerDeleted = true
        return { count: 1 }
      },
    },
    wmsAsnLineMap: {
      findMany: async (args: { select: Record<string, boolean> }) => {
        const creditRead = 'qtyAccountedViaSnapshot' in args.select
        events.push(creditRead ? 'read:credit' : 'read:line-ids')
        return state.lines.map((line) => ({ ...line }))
      },
      update: async () => {
        events.push('write:retire-line')
        return {}
      },
    },
  }
  return { tx, events, state }
}

function fakeLine(overrides: Partial<Record<'snapshot' | 'receipt' | 'lastProcessed', string>> = {}): FakeLine {
  return {
    id: 'al-1',
    sourceLineId: 'tl-1',
    productId: 'p-1',
    sku: 'SKU-1',
    expectedQty: new Prisma.Decimal(10),
    qtyAccountedViaSnapshot: new Prisma.Decimal(overrides.snapshot ?? '0'),
    qtyAccountedViaReceipt: new Prisma.Decimal(overrides.receipt ?? '0'),
    lastProcessedReceivedQty: new Prisma.Decimal(overrides.lastProcessed ?? '0'),
    note: null,
  }
}

test('o3d-zzgp r3: the disposal locks transfer → header → lines, and reads the credit only after all three', async () => {
  const { tx, events } = fakeTx({ lines: [fakeLine()] })

  const outcome = await disposePendingTransferAsnReservation(tx as never, { transferId: 'trf-1', asnMapId: 'asn-1' })

  assert.equal(outcome, 'deleted')
  const locks = events.filter((event) => event.startsWith('lock:'))
  assert.deepEqual(locks, ['lock:stock_transfers', 'lock:wms_asn_maps', 'lock:wms_asn_line_maps'], 'the established order, and only it')
  const lastLock = events.lastIndexOf('lock:wms_asn_line_maps')
  const creditReads = events.map((event, index) => [event, index] as const).filter(([event]) => event === 'read:credit')
  assert.equal(creditReads.length, 1, `exactly one credit read, saw ${creditReads.length}`)
  for (const [, index] of creditReads) {
    assert.ok(index > lastLock, `the credit read at ${index} must come after the step-4 lock at ${lastLock}: ${events.join(' → ')}`)
  }
  assert.ok(events.indexOf('write:delete-header') > creditReads[0]![1], 'and the delete comes after the read it depends on')
})

test('o3d-zzgp r3: a credited reservation is retired under the same locks, and never reaches the delete', async () => {
  const { tx, events, state } = fakeTx({ lines: [fakeLine({ snapshot: '6' })] })

  const outcome = await disposePendingTransferAsnReservation(tx as never, { transferId: 'trf-1', asnMapId: 'asn-1' })

  assert.equal(outcome, 'retired')
  assert.equal(events.includes('write:delete-header'), false)
  assert.ok(state.closedAt instanceof Date)
  assert.deepEqual(events.filter((event) => event.startsWith('lock:')), ['lock:stock_transfers', 'lock:wms_asn_maps', 'lock:wms_asn_line_maps'])
})

test('o3d-zzgp r3: the backstop refuses a delete if credit appears after the locked read, and says so loudly', async () => {
  // Simulates a writer that ignored the locks — the case the backstop exists for. The
  // real-database race where the lock is what prevents it lives in the concurrency test.
  const { tx, state } = fakeTx({
    lines: [fakeLine()],
    beforeDelete: (lines) => { lines[0]!.qtyAccountedViaSnapshot = new Prisma.Decimal(5) },
  })

  await assert.rejects(
    disposePendingTransferAsnReservation(tx as never, { transferId: 'trf-1', asnMapId: 'asn-1' }),
    (error: unknown) => error instanceof PendingAsnDisposalBackstopError,
  )
  assert.equal(state.headerDeleted, false, 'the credited reservation must still be there')
})

test('o3d-zzgp r3: a reservation that is no longer the caller\'s is left alone', async () => {
  const { tx, events } = fakeTx({ lines: [fakeLine()], headerMatches: false })

  const outcome = await disposePendingTransferAsnReservation(tx as never, {
    transferId: 'trf-1',
    asnMapId: 'asn-1',
    reservationWhere: { status: 'CREATE_PENDING' },
  })

  assert.equal(outcome, 'absent')
  assert.equal(events.some((event) => event.startsWith('write:')), false, 'nothing written')
  // The header was checked AFTER its lock, not before.
  assert.ok(events.indexOf('read:header') > events.indexOf('lock:wms_asn_maps'))
})
