import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isPurchaseOrderEditableStatus,
  lineIsTouched,
  lineQtyFloor,
  normaliseCostLinesForCompare,
  planLineAmend,
  unitCostMatchesStored,
  type PoEditFacts,
  type PoEditLineFact,
} from '@/lib/domain/purchasing/po-edit-plan'

function line(over: Partial<PoEditLineFact> & { id: string }): PoEditLineFact {
  return {
    productId: `prod-${over.id}`,
    sku: `SKU-${over.id}`,
    qty: 100,
    unitCostForeign: 5,
    unitCostBase: 5,
    totalForeign: 500,
    totalBase: 500,
    taxForeign: 0,
    taxBase: 0,
    landedQty: 0,
    billedQty: 0,
    returnedQty: 0,
    receiptLineCount: 0,
    liveAsn: [],
    ...over,
  }
}

function facts(lines: PoEditLineFact[], over: Partial<PoEditFacts> = {}): PoEditFacts {
  const anyLanded = lines.some((l) => l.landedQty > 0)
  return {
    status: anyLanded ? 'PARTIALLY_RECEIVED' : 'PO_SENT',
    reference: 'PO-T',
    lines,
    costLines: [],
    billCount: 0,
    receiptCount: anyLanded ? 1 : 0,
    returnCount: 0,
    asnMapCount: 0,
    hasCostLines: false,
    anyLanded,
    anyLiveAsn: lines.some((l) => l.liveAsn.length > 0),
    pristine: false,
    ...over,
  }
}

const req = (l: PoEditLineFact, qty = l.qty) => ({ poLineId: l.id, productId: l.productId, qty })

test('editable statuses are Draft through Part-received', () => {
  for (const s of ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED']) assert.equal(isPurchaseOrderEditableStatus(s), true, s)
  for (const s of ['RECEIVED', 'INVOICED', 'CLOSED', 'CANCELLED', 'RETURNED', 'PARTIALLY_RETURNED']) assert.equal(isPurchaseOrderEditableStatus(s), false, s)
})

test('a line is touched by landed, billed, returned or receipt rows; the floor is the largest of them', () => {
  assert.equal(lineIsTouched(line({ id: 'a' })), false)
  assert.equal(lineIsTouched(line({ id: 'a', landedQty: 1 })), true)
  assert.equal(lineIsTouched(line({ id: 'a', billedQty: 1 })), true)
  assert.equal(lineIsTouched(line({ id: 'a', returnedQty: 1 })), true)
  assert.equal(lineIsTouched(line({ id: 'a', receiptLineCount: 1 })), true)
  assert.equal(lineQtyFloor(line({ id: 'a', landedQty: 60, billedQty: 70, returnedQty: 5 })), 70)
})

test('PO_SENT amend (nothing landed, e.g. an ASN row exists): qty and set changes are free', () => {
  const a = line({ id: 'a' })
  const b = line({ id: 'b' })
  const plan = planLineAmend(facts([a, b]), [req(a, 80), { productId: 'prod-new', qty: 3 }])
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.deepEqual(plan.keep.map((k) => [k.fact.id, k.qtyChanged]), [['a', true]])
  assert.deepEqual(plan.create, [1])
  assert.deepEqual(plan.remove.map((l) => l.id), ['b'])
})

test('part-received: qty cannot go below what landed, billed or returned; equal to landed is allowed', () => {
  const a = line({ id: 'a', landedQty: 60, receiptLineCount: 1 })
  const b = line({ id: 'b' })
  const f = facts([a, b])
  const below = planLineAmend(f, [req(a, 59), req(b)])
  assert.equal(below.ok, false)
  assert.match(below.ok ? '' : below.error, /SKU-a cannot go below 60/)
  const equal = planLineAmend(f, [req(a, 60), req(b)])
  assert.equal(equal.ok, true)
  const billed = facts([line({ id: 'a', landedQty: 60, billedQty: 80, receiptLineCount: 1 }), b])
  const belowBilled = planLineAmend(billed, [req(billed.lines[0]!, 70), req(b)])
  assert.equal(belowBilled.ok, false)
  assert.match(belowBilled.ok ? '' : belowBilled.error, /cannot go below 80/)
})

test('part-received: a received line cannot be removed or have its product swapped; an untouched one can', () => {
  const a = line({ id: 'a', landedQty: 60, receiptLineCount: 1 })
  const b = line({ id: 'b' })
  const f = facts([a, b])
  const removeReceived = planLineAmend(f, [req(b)])
  assert.equal(removeReceived.ok, false)
  assert.match(removeReceived.ok ? '' : removeReceived.error, /SKU-a has been received, billed or returned, so it cannot be removed/)
  const swap = planLineAmend(f, [{ poLineId: 'a', productId: 'other', qty: 60 }, req(b)])
  assert.equal(swap.ok, false)
  const removeUntouched = planLineAmend(f, [req(a)])
  assert.equal(removeUntouched.ok, true)
  if (removeUntouched.ok) assert.deepEqual(removeUntouched.remove.map((l) => l.id), ['b'])
})

test('part-received: an edit that leaves nothing outstanding is refused in favour of Close', () => {
  const a = line({ id: 'a', landedQty: 60, receiptLineCount: 1 })
  const b = line({ id: 'b', landedQty: 10, qty: 10, receiptLineCount: 1 })
  const none = planLineAmend(facts([a, b]), [req(a, 60), req(b)])
  assert.equal(none.ok, false)
  assert.match(none.ok ? '' : none.error, /use Close instead/)
})

test('part-received with cost lines: quantity, price-set and line-set edits are refused; header-only and unchanged-qty pass', () => {
  const a = line({ id: 'a', landedQty: 60, receiptLineCount: 1 })
  const b = line({ id: 'b' })
  const f = facts([a, b], { hasCostLines: true })
  const qty = planLineAmend(f, [req(a), req(b, 90)])
  assert.equal(qty.ok, false)
  assert.match(qty.ok ? '' : qty.error, /freight or other cost lines/)
  const add = planLineAmend(f, [req(a), req(b), { productId: 'new', qty: 1 }])
  assert.equal(add.ok, false)
  const unchanged = planLineAmend(f, [req(a), req(b)])
  assert.equal(unchanged.ok, true)
  // Before anything lands, cost lines do not block: the next receipt allocates on the new lines.
  const preReceipt = facts([line({ id: 'x' })], { hasCostLines: true })
  assert.equal(planLineAmend(preReceipt, [req(preReceipt.lines[0]!, 10)]).ok, true)
})

test('a live ASN refuses a reduction or removal on its line but not an increase or another line', () => {
  const asn = { poLineId: 'a', sku: 'SKU-a', externalAsnId: '900', status: 'OPEN' }
  const a = line({ id: 'a', liveAsn: [asn] })
  const b = line({ id: 'b' })
  const f = facts([a, b], { asnMapCount: 1 })
  const reduce = planLineAmend(f, [req(a, 50), req(b)])
  assert.equal(reduce.ok, false)
  assert.match(reduce.ok ? '' : reduce.error, /SKU-a has an open warehouse ASN \(900, OPEN\), so its quantity cannot be reduced/)
  const remove = planLineAmend(f, [req(b)])
  assert.equal(remove.ok, false)
  assert.match(remove.ok ? '' : remove.error, /cannot be removed/)
  assert.equal(planLineAmend(f, [req(a, 150), req(b, 5)]).ok, true)
})

test('duplicate or foreign line ids, zero quantity and an empty order are refused', () => {
  const a = line({ id: 'a' })
  const f = facts([a])
  assert.equal(planLineAmend(f, [req(a), req(a)]).ok, false)
  assert.equal(planLineAmend(f, [{ poLineId: 'zzz', productId: 'p', qty: 1 }]).ok, false)
  assert.equal(planLineAmend(f, [req(a, 0)]).ok, false)
  assert.equal(planLineAmend(f, []).ok, false)
})

test('price comparison tolerates the form round trip and nothing more', () => {
  assert.equal(unitCostMatchesStored(5.000001, 5), true)
  assert.equal(unitCostMatchesStored(5.01, 5), false)
  assert.equal(unitCostMatchesStored(0.0001, 0.0002), true)
})

test('cost-line comparison ignores order, zero lines and blank descriptions', () => {
  const a = normaliseCostLinesForCompare([
    { description: 'Freight', amountForeign: 10, vatable: true, distributionMethod: 'BY_VALUE' },
    { description: '', amountForeign: 2.5, vatable: false, distributionMethod: 'BY_QUANTITY' },
    { description: 'zero', amountForeign: 0, vatable: false, distributionMethod: 'BY_VALUE' },
  ])
  const b = normaliseCostLinesForCompare([
    { description: 'Additional cost', amountForeign: 2.5, vatable: false, distributionMethod: 'BY_QUANTITY' },
    { description: 'Freight', amountForeign: 10, vatable: true, distributionMethod: 'BY_VALUE' },
  ])
  assert.deepEqual(a, b)
})

test('the part-received cost-line refusal message names prices as well as quantities', async () => {
  const { PO_COST_LINES_PART_RECEIVED_MESSAGE } = await import('@/lib/domain/purchasing/po-edit-plan')
  assert.match(PO_COST_LINES_PART_RECEIVED_MESSAGE, /quantities, prices or discounts/)
})
