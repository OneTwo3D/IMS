import assert from 'node:assert/strict'
import test from 'node:test'

import type { PurchaseOrderStatus } from '@/app/generated/prisma/client'
import {
  computeBilledAheadOfReceipt,
  describeBilledAhead,
  describeRetireOutcome,
  PoLiveAsnRefusedError,
  retirePurchaseOrderLocked,
} from '@/lib/domain/purchasing/po-close-short'

type FakeLine = { id: string; qty: number; qtyReceived: number; sku: string }

function fakeTx(po: { status: PurchaseOrderStatus; lines: FakeLine[]; invoiceLines?: Array<{ poLineId: string; qtyBilled: number; totalBase: number }>; live?: Array<{ sourceLineId: string; status: string }>; freight?: Array<{ amountBase: number }> }) {
  const writes: Array<{ status: PurchaseOrderStatus }> = []
  const tx = {
    purchaseOrder: {
      findUnique: async () => ({
        status: po.status,
        reference: 'PO-T',
        lines: po.lines.map((l) => ({ id: l.id, qty: l.qty, qtyReceived: l.qtyReceived, product: { sku: l.sku } })),
        freightCostLines: po.freight ?? [],
        landedCostLinks: [],
        invoices: [{ lines: po.invoiceLines ?? [] }],
      }),
      update: async ({ data }: { data: { status: PurchaseOrderStatus } }) => {
        writes.push(data)
        po.status = data.status
      },
    },
    wmsAsnLineMap: {
      // findLiveAsnBlocks selects `asn`; the landed-quantity loader does not. Same method, two shapes.
      findMany: async (args: { select: Record<string, unknown> }) => {
        if ('asn' in args.select) {
          return (po.live ?? []).map((l) => ({ sourceLineId: l.sourceLineId, sku: 'SKU-A', asn: { externalAsnId: 'ASN-1', status: l.status } }))
        }
        return []
      },
    },
  }
  return { tx: tx as never, writes }
}

const twoLines: FakeLine[] = [
  { id: 'a', qty: 100, qtyReceived: 60, sku: 'SKU-A' },
  { id: 'b', qty: 10, qtyReceived: 0, sku: 'SKU-B' },
]

test('close with nothing landed retires the order (CLOSED), cancel with nothing landed cancels it (CANCELLED)', async () => {
  const untouched: FakeLine[] = [{ id: 'a', qty: 100, qtyReceived: 0, sku: 'SKU-A' }]
  const closed = fakeTx({ status: 'PO_SENT', lines: untouched })
  const outcome = await retirePurchaseOrderLocked(closed.tx, 'po', 'close')
  assert.equal(outcome.newStatus, 'CLOSED')
  assert.equal(outcome.keptReceivedStock, false)
  assert.equal(outcome.droppedQty, 100)
  assert.deepEqual(closed.writes, [{ status: 'CLOSED' }])

  const cancelled = fakeTx({ status: 'QUOTE_RECEIVED', lines: untouched })
  const c = await retirePurchaseOrderLocked(cancelled.tx, 'po', 'cancel')
  assert.equal(c.newStatus, 'CANCELLED')
  assert.equal(describeRetireOutcome(c, 'cancel'), 'Cancelled PO-T. Nothing had been received, so stock and accounts are unchanged.')
})

test('close and cancel of a part-received order are the same operation: CLOSED, received stock kept, balance dropped', async () => {
  for (const intent of ['close', 'cancel'] as const) {
    const t = fakeTx({ status: 'PARTIALLY_RECEIVED', lines: twoLines })
    const outcome = await retirePurchaseOrderLocked(t.tx, 'po', intent)
    assert.equal(outcome.newStatus, 'CLOSED', intent)
    assert.equal(outcome.keptReceivedStock, true)
    assert.equal(outcome.landedQty, 60)
    assert.equal(outcome.droppedQty, 50, '40 on line A and the 10 never received on line B')
    // The only write is the status: no stock, layer or journal write is even available on the fake.
    assert.deepEqual(t.writes, [{ status: 'CLOSED' }])
    assert.match(describeRetireOutcome(outcome, intent), /closed short: 50 unit\(s\) still due were dropped; the 60 unit\(s\) received stay in stock at their cost/)
  }
})

test('a live warehouse ASN refuses close and cancel before any write', async () => {
  for (const status of ['OPEN', 'PARTIALLY_BOOKED_IN', 'CREATE_IN_FLIGHT', 'BOOKED_IN']) {
    const t = fakeTx({ status: 'PARTIALLY_RECEIVED', lines: twoLines, live: [{ sourceLineId: 'b', status }] })
    await assert.rejects(
      () => retirePurchaseOrderLocked(t.tx, 'po', 'close'),
      (err: unknown) => err instanceof PoLiveAsnRefusedError && /Cannot close PO-T: SKU-A \(ASN ASN-1, /.test(err.message),
    )
    assert.deepEqual(t.writes, [])
  }
})

test('the status graph decides: a RECEIVED order closes, a CLOSED/CANCELLED/RETURNED one cannot be retired again', async () => {
  const ok = fakeTx({ status: 'RECEIVED', lines: [{ id: 'a', qty: 5, qtyReceived: 5, sku: 'SKU-A' }] })
  assert.equal((await retirePurchaseOrderLocked(ok.tx, 'po', 'close')).droppedQty, 0)
  for (const status of ['CLOSED', 'CANCELLED', 'RETURNED'] as const) {
    const t = fakeTx({ status, lines: twoLines })
    await assert.rejects(() => retirePurchaseOrderLocked(t.tx, 'po', 'close'))
    assert.deepEqual(t.writes, [])
  }
})

test('the supplier-bill hook runs after the facts are read and before the status write', async () => {
  const t = fakeTx({ status: 'PO_SENT', lines: [{ id: 'a', qty: 5, qtyReceived: 0, sku: 'SKU-A' }] })
  const seen: boolean[] = []
  await assert.rejects(
    () => retirePurchaseOrderLocked(t.tx, 'po', 'cancel', ({ keptReceivedStock }) => { seen.push(keptReceivedStock); throw new Error('billed') }),
    /billed/,
  )
  assert.deepEqual(seen, [false])
  assert.deepEqual(t.writes, [], 'nothing was written when the hook refused')
})

test('computeBilledAheadOfReceipt reports only lines billed beyond what landed, valued at the billed average', () => {
  const rows = computeBilledAheadOfReceipt({
    lines: [
      { id: 'a', sku: 'SKU-A', landedQty: 60 },
      { id: 'b', sku: 'SKU-B', landedQty: 10 },
      { id: 'c', sku: 'SKU-C', landedQty: 0 },
    ],
    invoiceLines: [
      { poLineId: 'a', qtyBilled: 100, totalBase: 500 },
      { poLineId: 'b', qtyBilled: 10, totalBase: 40 },
      { poLineId: null, qtyBilled: 5, totalBase: 9 },
    ],
  })
  assert.deepEqual(rows, [{ poLineId: 'a', sku: 'SKU-A', billedQty: 100, landedQty: 60, excessQty: 40, excessValueBase: 200 }])
  assert.match(describeBilledAhead(rows) ?? '', /SKU-A: billed 100, received 60 \(40 over, about 200\.00 base\)/)
  assert.equal(describeBilledAhead([]), null)
})
