import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-zzgp — the incoming-stock badges.
 *
 * Display only, so nothing here moves stock or money, but the number an operator reads
 * before deciding whether to reorder was `qty − qtyReceived`: the whole line, for units
 * the WMS stock-sync alignment had already brought into stock. That path credits
 * `wms_asn_line_maps.qtyAccountedViaSnapshot` and never writes
 * `stock_transfer_lines.qtyReceived`, so the badge over-stated what was still coming.
 *
 * `getIncomingDetails` is the drill-through behind the badge and returns one row per
 * source document, so it pins the per-line figure rather than a total that could be
 * right for the wrong reasons.
 */

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

let transferLines: Array<{ id: string; qty: string; qtyReceived: string; reference: string }> = []
let asnRows: Array<{ sourceLineId: string; snapshot: string; receipt: string }> = []
const landedLookups: string[][] = []
const selectedLineId: boolean[] = []

const db: Record<string, unknown> = {
  purchaseOrderLine: { findMany: async () => [] },
  stockTransferLine: {
    findMany: async (args: { select?: Record<string, unknown> }) => {
      // Recorded, not asserted: asserting here aborts the reader before it produces a
      // number, so the pre-fix run would fail on the query SHAPE and never witness the
      // arithmetic. The ids are returned either way; the shape is asserted after the
      // numbers.
      selectedLineId.push(args.select?.id === true)
      return transferLines.map((line) => ({
        id: line.id,
        qty: decimal(line.qty),
        qtyReceived: decimal(line.qtyReceived),
        transfer: { id: `t-${line.id}`, reference: line.reference, status: 'IN_TRANSIT' },
      }))
    },
  },
  wmsAsnLineMap: {
    findMany: async (args: { where: { sourceType?: string; sourceLineId?: { in?: string[] } } }) => {
      assert.equal(args.where.sourceType, 'STOCK_TRANSFER_LINE')
      const wanted = args.where.sourceLineId?.in ?? []
      landedLookups.push([...wanted])
      return asnRows
        .filter((row) => wanted.includes(row.sourceLineId))
        .map((row) => ({
          sourceLineId: row.sourceLineId,
          qtyAccountedViaSnapshot: decimal(row.snapshot),
          qtyAccountedViaReceipt: decimal(row.receipt),
        }))
    },
  },
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('next/navigation', { namedExports: { redirect: () => { throw new Error('redirect') } } })
mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireInternalUser: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }),
    requirePermission: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
    logActivityPersisted: async () => true,
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})

test('o3d-zzgp: the incoming drill-through shows what is still coming, not what the WMS alignment already landed', async () => {
  const { getIncomingDetails } = await import('@/app/actions/products')
  transferLines = [
    // Six of ten landed through the alignment's snapshot credit; qtyReceived is zero.
    { id: 'tl-part', qty: '10', qtyReceived: '0', reference: 'TRF-PART' },
    // Landed in full the same way: nothing is still coming, so it must disappear.
    { id: 'tl-full', qty: '5', qtyReceived: '0', reference: 'TRF-FULL' },
    // Untouched by any WMS ASN — the ordinary transfer, which must not change.
    { id: 'tl-plain', qty: '3', qtyReceived: '1', reference: 'TRF-PLAIN' },
  ]
  asnRows = [
    { sourceLineId: 'tl-part', snapshot: '6', receipt: '0' },
    { sourceLineId: 'tl-full', snapshot: '5', receipt: '0' },
  ]
  landedLookups.length = 0
  selectedLineId.length = 0

  const rows = await getIncomingDetails('p-1', 'wh-1')

  const byReference = new Map(rows.map((row) => [row.reference, row.qty]))
  // Was 10.
  assert.equal(byReference.get('TRF-PART'), 4)
  // Was present with qty 5.
  assert.equal(byReference.has('TRF-FULL'), false, 'a fully landed transfer is no longer incoming')
  assert.equal(byReference.get('TRF-PLAIN'), 2)
  assert.equal(rows.length, 2)

  // THEN the preconditions: one batched lookup covering all three lines. Without them
  // the absence of TRF-FULL above could come from a reader that returned nothing.
  assert.equal(landedLookups.length, 1, `expected one batched landed lookup, saw ${landedLookups.length}`)
  assert.deepEqual([...landedLookups[0]!].sort(), ['tl-full', 'tl-part', 'tl-plain'])
  assert.deepEqual(selectedLineId, [true], 'the reader must select the transfer line id')
})

test('o3d-zzgp: a WMS receipt already absorbed into qtyReceived is not deducted twice', async () => {
  const { getIncomingDetails } = await import('@/app/actions/products')
  // The webhook book-in moved three units into qtyReceived and recorded the same three
  // on qtyAccountedViaReceipt. The unabsorbed snapshot arm is max(0, 3 − 3) = 0, so
  // landed is 3 — a plain sum of the two columns would show 4 incoming instead of 7.
  transferLines = [{ id: 'tl-1', qty: '10', qtyReceived: '3', reference: 'TRF-1' }]
  asnRows = [{ sourceLineId: 'tl-1', snapshot: '3', receipt: '3' }]
  landedLookups.length = 0
  selectedLineId.length = 0

  const rows = await getIncomingDetails('p-1', 'wh-1')

  // NOTE, HONESTLY: 10 − 3 = 7 either way, so this case passes against the pre-fix code
  // as well. It is a guard against the fix double-deducting an absorbed WMS receipt —
  // the failure mode of a naive `qtyReceived + qtyAccountedViaSnapshot` — not a witness
  // for the defect. Its evidence is the mutation table, not a red run on the old code.
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.qty, 7)
  assert.equal(landedLookups.length, 1, 'the landed loader must have been consulted')
})
