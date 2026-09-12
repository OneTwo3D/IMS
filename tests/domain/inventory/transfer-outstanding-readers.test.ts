import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { getProductIncomingStock } from '@/lib/domain/inventory/product-lifecycle-archive'
import { getStockTransferReport } from '@/lib/domain/inventory/inventory-ledger-reports'

// o3d-zzgp. THE FIXTURE THAT MATTERS IS A LINE THE WMS STOCK-SYNC ALIGNMENT LANDED
// WITHOUT WRITING `qtyReceived`.
//
// `applyMintsoftAlignmentForProduct` (lib/connectors/mintsoft/sync/stock-sync.ts) adds
// the units to `stock_levels`, lays their cost layers from the dispatch snapshot, and
// records what it did by incrementing `wms_asn_line_maps.qtyAccountedViaSnapshot`. It
// NEVER touches `stock_transfer_lines.qtyReceived`. So a line landed entirely that way
// has `qtyReceived = 0` and `qty − qtyReceived = qty`, and every reader still asking
// that question answered "all of it is still coming".
//
// A test that only pins a qtyReceived-based landing would pass against the OLD
// arithmetic too and prove nothing about this — so each case below drives the landing
// through `qtyAccountedViaSnapshot`, and each asserts the ASN rows were actually
// consulted (`asnLookups`), because a reader that silently stopped reading them would
// otherwise satisfy the same numbers by accident on an all-zero fixture.

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

type AsnRow = {
  sourceType: 'STOCK_TRANSFER_LINE' | 'PURCHASE_ORDER_LINE'
  sourceLineId: string
  expectedQty: string
  qtyAccountedViaSnapshot: string
  qtyAccountedViaReceipt: string
}

type TransferLineRow = { id: string; qty: string; qtyReceived: string }

/**
 * One fake `wmsAsnLineMap.findMany` serving two DIFFERENT queries:
 *
 *  · the landed-quantity loader's, keyed on `sourceType` + `sourceLineId in (…)`, which
 *    must see EVERY ASN row for the line whatever its ASN's status;
 *  · the incoming-stock reader's own, keyed on `productId` + `asn.status in (…)`, which
 *    sees only rows on a WMS-confirmed open ASN.
 *
 * They are answered separately on purpose: routing both at one filtered set is a real
 * way to get this wrong, and the assertions below would not catch it if the fake
 * collapsed them.
 */
function makeAsnDelegate(rows: AsnRow[], openRows: AsnRow[] = rows) {
  const landedLookups: string[][] = []
  const readerLookups: string[][] = []
  return {
    landedLookups,
    readerLookups,
    delegate: {
      findMany: async (args: {
        where: {
          sourceType?: string
          sourceLineId?: { in: string[] } | string
          productId?: string
          asn?: { status: { in: string[] } }
        }
      }) => {
        const where = args.where
        if (where.asn) {
          readerLookups.push(where.asn.status.in)
          return openRows.map((row) => ({
            sourceType: row.sourceType,
            sourceLineId: row.sourceLineId,
            expectedQty: decimal(row.expectedQty),
            qtyAccountedViaSnapshot: decimal(row.qtyAccountedViaSnapshot),
            qtyAccountedViaReceipt: decimal(row.qtyAccountedViaReceipt),
          }))
        }
        assert.equal(where.sourceType, 'STOCK_TRANSFER_LINE')
        const ids = typeof where.sourceLineId === 'string'
          ? [where.sourceLineId]
          : where.sourceLineId?.in ?? []
        landedLookups.push([...ids])
        return rows
          .filter((row) => row.sourceType === 'STOCK_TRANSFER_LINE' && ids.includes(row.sourceLineId))
          .map((row) => ({
            sourceLineId: row.sourceLineId,
            qtyAccountedViaSnapshot: decimal(row.qtyAccountedViaSnapshot),
            qtyAccountedViaReceipt: decimal(row.qtyAccountedViaReceipt),
          }))
      },
    },
  }
}

function makeIncomingStockClient(options: {
  transferLines: TransferLineRow[]
  asnRows: AsnRow[]
  openAsnRows?: AsnRow[]
}) {
  const asn = makeAsnDelegate(options.asnRows, options.openAsnRows ?? options.asnRows)
  const selectedLineId: boolean[] = []
  const client = {
    purchaseOrderLine: { findMany: async () => [] },
    productionOrder: { findMany: async () => [] },
    stockTransferLine: {
      findMany: async (args: { select?: Record<string, boolean> }) => {
        // RECORDED, NOT ASSERTED HERE. An assertion at this point aborts the reader
        // before it produces a number, so every case would fail on the query SHAPE and
        // none of them would witness the arithmetic defect — a sound check establishing
        // the wrong thing. The ids are handed back either way and the shape is asserted
        // AFTER the numbers, so a revert of the arithmetic alone still goes red.
        selectedLineId.push(args.select?.id === true)
        return options.transferLines.map((line) => ({
          id: line.id,
          qty: decimal(line.qty),
          qtyReceived: decimal(line.qtyReceived),
        }))
      },
    },
    wmsAsnLineMap: asn.delegate,
  }
  return { client, asn, selectedLineId }
}

test('o3d-zzgp: incoming stock treats a transfer line the WMS alignment landed as arrived, not as still in transit', async () => {
  const { client, asn, selectedLineId } = makeIncomingStockClient({
    transferLines: [{ id: 'tl-1', qty: '10', qtyReceived: '0' }],
    asnRows: [{
      sourceType: 'STOCK_TRANSFER_LINE',
      sourceLineId: 'tl-1',
      expectedQty: '10',
      // The alignment credited all ten. Nothing folded them into qtyReceived.
      qtyAccountedViaSnapshot: '10',
      qtyAccountedViaReceipt: '0',
    }],
  })

  const incoming = await getProductIncomingStock('product-1', { client: client as never })

  // THE NUMBER FIRST. Was '10' — the whole line read as still coming, for units already
  // on the shelf.
  assert.equal(incoming.stockTransfers, '0')
  assert.equal(incoming.wmsAsn, '0')
  assert.equal(incoming.total, '0')

  // THEN the preconditions, so the number above is what fails when the arithmetic is
  // reverted. Without these the two zeroes could come from a reader that stopped
  // looking at either source.
  assert.deepEqual(asn.landedLookups, [['tl-1']], 'the landed loader must be asked for this line')
  assert.equal(asn.readerLookups.length, 1)
  assert.deepEqual(selectedLineId, [true], 'the reader must select the transfer line id')
})

test('o3d-zzgp: incoming stock counts a partly aligned transfer line once, at its real remainder', async () => {
  const { client, asn } = makeIncomingStockClient({
    transferLines: [{ id: 'tl-1', qty: '10', qtyReceived: '0' }],
    asnRows: [{
      sourceType: 'STOCK_TRANSFER_LINE',
      sourceLineId: 'tl-1',
      expectedQty: '10',
      qtyAccountedViaSnapshot: '7',
      qtyAccountedViaReceipt: '0',
    }],
  })

  const incoming = await getProductIncomingStock('product-1', { client: client as never })

  // Was stockTransfers '10' + wmsAsn '3' = '13', for three units actually due in.
  assert.equal(incoming.stockTransfers, '3')
  assert.equal(incoming.wmsAsn, '0')
  assert.equal(incoming.total, '3')
  assert.deepEqual(asn.landedLookups, [['tl-1']])
})

test('o3d-zzgp: an in-transit transfer line with an open ASN is counted ONCE, not through both arms', async () => {
  // Nothing has landed at all here, so this case isolates the DOUBLE-COUNT from the
  // landed-quantity error: the old code summed 10 on the transfer arm and 10 again on
  // the ASN arm over the very same row.
  const { client, asn } = makeIncomingStockClient({
    transferLines: [{ id: 'tl-1', qty: '10', qtyReceived: '0' }],
    asnRows: [{
      sourceType: 'STOCK_TRANSFER_LINE',
      sourceLineId: 'tl-1',
      expectedQty: '10',
      qtyAccountedViaSnapshot: '0',
      qtyAccountedViaReceipt: '0',
    }],
  })

  const incoming = await getProductIncomingStock('product-1', { client: client as never })

  assert.equal(incoming.stockTransfers, '10')
  assert.equal(incoming.wmsAsn, '0')
  // Was '20'.
  assert.equal(incoming.total, '10')
  assert.deepEqual(asn.landedLookups, [['tl-1']])
})

test('o3d-zzgp: an ASN row whose transfer is no longer in transit still counts as incoming', async () => {
  // THE OTHER DIRECTION. Removing the mirror row unconditionally would swing this
  // reader from over-stating to UNDER-stating, and under-stating incoming stock lets
  // the EOL auto-archive retire a product with units still due in. The exclusion is
  // therefore keyed on the transfer arm having authority over that line — i.e. on the
  // line being in the IN_TRANSIT set — and this transfer is not, so its ASN row stands.
  const { client, asn } = makeIncomingStockClient({
    transferLines: [],
    asnRows: [{
      sourceType: 'STOCK_TRANSFER_LINE',
      sourceLineId: 'tl-received',
      expectedQty: '5',
      qtyAccountedViaSnapshot: '0',
      qtyAccountedViaReceipt: '0',
    }],
  })

  const incoming = await getProductIncomingStock('product-1', { client: client as never })

  // NOTE, HONESTLY: this case passes against the pre-fix code too, because the pre-fix
  // code had no exclusion to over-apply. It is a GUARD against the fix swinging the
  // error the other way — under-stating incoming stock would let the EOL auto-archive
  // retire a product with units still due in — not a witness for the defect. Its
  // mutation evidence is the exclusion being widened to every transfer-sourced row.
  assert.equal(incoming.stockTransfers, '0')
  assert.equal(incoming.wmsAsn, '5')
  assert.equal(incoming.total, '5')
  assert.equal(asn.landedLookups.length, 0, 'no in-transit line to load landed quantity for')
})

test('o3d-zzgp: a purchase-order ASN row is untouched by the transfer-line exclusion', async () => {
  const { client } = makeIncomingStockClient({
    transferLines: [{ id: 'tl-1', qty: '4', qtyReceived: '0' }],
    asnRows: [
      {
        sourceType: 'PURCHASE_ORDER_LINE',
        // Deliberately colliding with the transfer line id: the exclusion must key on
        // the source TYPE as well, or a coincidental id would delete a PO expectation.
        sourceLineId: 'tl-1',
        expectedQty: '9',
        qtyAccountedViaSnapshot: '0',
        qtyAccountedViaReceipt: '0',
      },
    ],
  })

  const incoming = await getProductIncomingStock('product-1', { client: client as never })

  assert.equal(incoming.stockTransfers, '4')
  assert.equal(incoming.wmsAsn, '9')
  assert.equal(incoming.total, '13')
})

// ---------------------------------------------------------------------------
// READER 3: the transfer report's received and drift columns.
// ---------------------------------------------------------------------------

test('o3d-zzgp: the transfer report reports an alignment-landed transfer as received, not as 100% drift', async () => {
  const lines = [
    // Landed entirely by the WMS alignment: qtyReceived is zero and six units are in.
    { id: 'tl-a', qty: decimal('6'), qtyReceived: decimal('0'), sku: 'A', productName: 'A' },
    // Landed by a manual receipt, the case the old arithmetic already got right.
    { id: 'tl-b', qty: decimal('4'), qtyReceived: decimal('4'), sku: 'B', productName: 'B' },
  ]
  const transfers = [{
    id: 't1',
    reference: 'TRF-1',
    status: 'IN_TRANSIT',
    fromWarehouse: { code: 'A', name: 'A' },
    toWarehouse: { code: 'B', name: 'B' },
    fromWarehouseId: 'a',
    toWarehouseId: 'b',
    dispatchedAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lines,
  }]
  const asnLookups: string[][] = []
  const totalsSelectedLineId: boolean[] = []
  const client = {
    stockTransfer: {
      async count() { return transfers.length },
      async findMany(args: { skip?: number; take?: number; select?: Record<string, boolean> }) {
        if (args.select) return transfers.map((transfer) => ({ id: transfer.id }))
        return transfers
      },
    },
    stockTransferLine: {
      async findMany(args: { select?: Record<string, boolean> }) {
        // Recorded, not asserted here — see the note on `selectedLineId` above.
        totalsSelectedLineId.push(args.select?.id === true)
        return lines.map((line) => ({ id: line.id, qty: line.qty, qtyReceived: line.qtyReceived }))
      },
    },
    stockMovement: { async findMany() { return [] } },
    wmsAsnLineMap: {
      async findMany(args: { where: { sourceLineId?: { in: string[] } } }) {
        asnLookups.push([...(args.where.sourceLineId?.in ?? [])])
        return [{
          sourceLineId: 'tl-a',
          qtyAccountedViaSnapshot: decimal('6'),
          qtyAccountedViaReceipt: decimal('0'),
        }]
      },
    },
  } as never

  const report = await getStockTransferReport({ pageSize: 50 }, { client, now: new Date('2026-01-10T00:00:00Z') })

  // THE NUMBERS FIRST. Was receivedQty '4' / driftQty '6' — a transfer with everything
  // accounted for reporting 60% of its units missing.
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]!.requestedQty, '10')
  assert.equal(report.rows[0]!.receivedQty, '10')
  assert.equal(report.rows[0]!.driftQty, '0')
  assert.equal(report.totals.requestedQty, '10')
  assert.equal(report.totals.receivedQty, '10')
  assert.equal(report.totals.driftQty, '0')

  // THEN the preconditions. The totals come from a SEPARATE unpaginated query, so a fix
  // applied to the row and not the total would leave the grand total wrong — two
  // lookups, each over both lines.
  assert.equal(asnLookups.length, 2, `expected a landed lookup for the page and for the totals, saw ${asnLookups.length}`)
  for (const lookup of asnLookups) {
    assert.deepEqual([...lookup].sort(), ['tl-a', 'tl-b'])
  }
  assert.deepEqual(totalsSelectedLineId, [true], 'the totals query must select line ids')
})
