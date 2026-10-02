import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  assertPendingAsnReservationStillOurs,
  PendingAsnFinalizationConflictError,
} from '@/lib/domain/wms/pending-asn-finalization'

/**
 * o3d-papk round 2 — the finalize compare-and-set, unit level. The concurrency arms (R2-4..R2-7 in
 * tests/concurrency/po-asn-creator.concurrent.test.ts) prove it against real interleavings; these pin each
 * individual refusal so a check that is dropped cannot hide behind another one that still fires.
 */

type Header = { status: string; closedAt: Date | null; lines: Array<{ id: string; expectedQty: Prisma.Decimal }> } | null

function fakeTx(header: Header) {
  const seen: Array<Record<string, unknown>> = []
  return {
    seen,
    tx: {
      wmsAsnMap: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          seen.push(args.where)
          return header
        },
      },
    } as never,
  }
}

const input: Parameters<typeof assertPendingAsnReservationStillOurs>[1] = {
  parent: { kind: 'PURCHASE_ORDER', id: 'po-1' },
  asnMapId: 'asn-1',
  expectedStatus: 'CREATE_IN_FLIGHT',
  lines: [{ asnLineMapId: 'l1', expectedQty: 10 }],
  remoteExternalAsnId: 'remote-77',
  alreadyRecorded: false,
}
const ok = (): Header => ({ status: 'CREATE_IN_FLIGHT', closedAt: null, lines: [{ id: 'l1', expectedQty: new Prisma.Decimal('10.0000') }] })

async function refusal(header: Header, override: Partial<typeof input> = {}): Promise<PendingAsnFinalizationConflictError> {
  const { tx } = fakeTx(header)
  try {
    await assertPendingAsnReservationStillOurs(tx, { ...input, ...override })
  } catch (error) {
    assert.ok(error instanceof PendingAsnFinalizationConflictError, `a conflict error, got ${String(error)}`)
    return error
  }
  throw new Error('expected a refusal')
}

test('o3d-papk r2 CAS: the reservation as it was reserved passes, scoped to its parent', async () => {
  const { tx, seen } = fakeTx(ok())
  await assertPendingAsnReservationStillOurs(tx, input)
  assert.equal(seen[0]!.sourceType, 'PURCHASE_ORDER')
  assert.equal(seen[0]!.sourceId, 'po-1')
})

test('o3d-papk r2 CAS: each way the reservation can have moved is refused by name, and carries the remote id', async () => {
  const cases: Array<[string, Header, Partial<typeof input>, RegExp]> = [
    ['gone', null, {}, /no longer exists/],
    ['retired', { ...ok()!, closedAt: new Date() }, {}, /retired/],
    ['not claimed any more', { ...ok()!, status: 'CREATE_PENDING' }, {}, /CREATE_PENDING, not CREATE_IN_FLIGHT/],
    ['claimed when a recovery expected it unclaimed', ok(), { expectedStatus: 'CREATE_PENDING' }, /CREATE_IN_FLIGHT, not CREATE_PENDING/],
    ['a line was added', { ...ok()!, lines: [...ok()!.lines, { id: 'l2', expectedQty: new Prisma.Decimal(1) }] }, {}, /lines changed/],
    ['a line was replaced', { ...ok()!, lines: [{ id: 'other', expectedQty: new Prisma.Decimal(10) }] }, {}, /lines changed/],
    ['a quantity changed', { ...ok()!, lines: [{ id: 'l1', expectedQty: new Prisma.Decimal('6.0000') }] }, {}, /now expects 6 where 10 was reserved/],
  ]
  for (const [name, header, override, pattern] of cases) {
    const error = await refusal(header, override)
    assert.match(error.message, pattern, name)
    assert.equal(error.externalAsnId, 'remote-77', `${name}: the remote id rides the error`)
    assert.equal(error.alreadyRecorded, false)
  }
  console.log(`# o3d-papk r2 CAS: evaluated ${cases.length} refusals`)
})

test('o3d-papk r2 CAS: alreadyRecorded is carried (the conflict branch: IMS holds a record, nothing is orphaned)', async () => {
  const error = await refusal(null, { alreadyRecorded: true })
  assert.equal(error.alreadyRecorded, true)
  assert.match(error.message, /already holds a record/)
})
