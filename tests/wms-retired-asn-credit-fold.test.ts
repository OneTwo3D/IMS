import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePurchaseOrderLineLandedQty } from '@/lib/domain/inventory/po-line-landed-quantity'
import { foldRetiredAsnCreditIntoPurchaseOrder } from '@/lib/domain/wms/retired-asn-credit-fold'

// o3d-98hnd: the credit on a RETIRED ASN is folded into qtyReceived; landed quantity is unchanged, the unabsorbed part is zero.

function rig(rows: Array<{ id: string; sourceLineId: string; snapshot: number; receipt: number; expected: number; processed: number; closed: boolean }>) {
  const lineMaps = rows.map((r) => ({ ...r }))
  const poLines = new Map<string, number>([['pl1', 0]])
  const receipts: unknown[] = []
  const movements: unknown[] = []
  const tx = {
    wmsAsnLineMap: {
      findMany: async (args: { where: { asn: { closedAt: unknown } } }) => {
        assert.deepEqual(args.where.asn, { closedAt: { not: null } }, 'only retired rows are touched')
        return lineMaps.filter((r) => r.closed).map((r) => ({
          id: r.id, sourceLineId: r.sourceLineId, sku: 'S', productId: 'p1',
          expectedQty: r.expected, lastProcessedReceivedQty: r.processed,
          qtyAccountedViaSnapshot: r.snapshot, qtyAccountedViaReceipt: r.receipt, asn: { warehouseId: 'w1' },
        }))
      },
      update: async (a: { where: { id: string }; data: { qtyAccountedViaReceipt: { increment: number }; lastProcessedReceivedQty: { increment: number } } }) => {
        const r = lineMaps.find((x) => x.id === a.where.id)!
        r.receipt += a.data.qtyAccountedViaReceipt.increment
        r.processed += a.data.lastProcessedReceivedQty.increment
      },
    },
    purchaseReceipt: { create: async (a: unknown) => { receipts.push(a) } },
    purchaseOrderLine: {
      update: async (a: { where: { id: string }; data: { qtyReceived: { increment: number } } }) => {
        poLines.set(a.where.id, poLines.get(a.where.id)! + a.data.qtyReceived.increment)
      },
    },
    stockMovement: { create: async (a: unknown) => { movements.push(a) } },
  }
  const landed = () => resolvePurchaseOrderLineLandedQty({
    poLineId: 'pl1', qtyReceived: poLines.get('pl1')!,
    wmsAsnLines: lineMaps.map((r) => ({ qtyAccountedViaSnapshot: r.snapshot, qtyAccountedViaReceipt: r.receipt })),
  })
  return { tx, lineMaps, poLines, receipts, movements, landed }
}

test('o3d-98hnd: a retired ASN credit is folded into qtyReceived, leaving landed quantity unchanged and nothing unabsorbed', async () => {
  const r = rig([{ id: 'a1', sourceLineId: 'pl1', snapshot: 4, receipt: 0, expected: 4, processed: 0, closed: true }])
  const before = r.landed()
  assert.equal(before.fromUnabsorbedWmsSnapshot.toNumber(), 4, 'precondition: this is the state that blocks close and return')
  const out = await foldRetiredAsnCreditIntoPurchaseOrder(r.tx as never, { poId: 'po1', reference: 'PO-1', poLineIds: ['pl1'] })
  const after = r.landed()
  assert.equal(out.foldedQty, 4)
  assert.equal(after.fromUnabsorbedWmsSnapshot.toNumber(), 0)
  assert.equal(r.poLines.get('pl1'), 4)
  assert.equal(after.qtyNumber, before.qtyNumber, 'landed quantity is conserved')
  assert.equal(r.receipts.length, 1)
  assert.equal(r.movements.length, 1)
  // idempotent: a second run folds nothing and writes nothing
  const again = await foldRetiredAsnCreditIntoPurchaseOrder(r.tx as never, { poId: 'po1', reference: 'PO-1', poLineIds: ['pl1'] })
  assert.equal(again.foldedQty, 0)
  assert.equal(r.receipts.length, 1)
  assert.equal(r.poLines.get('pl1'), 4)
})

test('o3d-98hnd: an open (not retired) ASN row is never folded', async () => {
  const r = rig([{ id: 'a1', sourceLineId: 'pl1', snapshot: 4, receipt: 0, expected: 10, processed: 0, closed: false }])
  const out = await foldRetiredAsnCreditIntoPurchaseOrder(r.tx as never, { poId: 'po1', reference: 'PO-1', poLineIds: ['pl1'] })
  assert.equal(out.foldedQty, 0)
  assert.equal(r.poLines.get('pl1'), 0)
})
