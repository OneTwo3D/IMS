import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ERASURE_CLASSIFICATION } from '../lib/domain/erasure/erasure-classification.ts'
import { TABLE_CLASSES } from '../lib/first-load/apply/table-classes.ts'

/**
 * The classification decisions for return reasons and PO line notes, stated once and pinned:
 *
 *  - ReturnReason is configuration (names, order, active flag): not personal, so it has no erasure entry of its own and it is CONFIG_ALLOWED for a first
 *    load. A refund holds only the reason's id (SalesOrderRefund.returnReasonId), classified not-personal. The free-text refund `reason` keeps its
 *    existing decision (retained).
 *  - PurchaseOrderLine.notes is an internal remark on a supplier business document. The erasure census covers tables reachable from a customer or a sales
 *    order; a purchase order line is not one, so the column carries no erasure entry. It is never supplier-facing (see tests/purchasing/po-line-notes.test.ts).
 */
const schema = readFileSync('prisma/schema.prisma', 'utf8')
const body = (model: string) => new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema)?.[1] ?? ''

test('the refund holds the reason by id only: classified not-personal; the free-text reason decision is unchanged', () => {
  const refund = ERASURE_CLASSIFICATION.SalesOrderRefund!
  assert.ok(refund.notPersonal.includes('returnReasonId'))
  assert.ok(!refund.erased.includes('returnReasonId'))
  assert.match(refund.retained.reason ?? '', /refund reason text is kept/)
  assert.ok(body('SalesOrderRefund').includes('returnReasonId'), 'PRECONDITION: the column exists')
})

test('ReturnReason is configuration: no personal text, no relation path to a customer or an order, CONFIG_ALLOWED for first load', () => {
  assert.ok(body('ReturnReason').includes('@@map("return_reasons")'), 'PRECONDITION: the model exists')
  assert.deepEqual(Object.keys(ERASURE_CLASSIFICATION).filter((m) => m === 'ReturnReason'), [], 'not an erasure-scope table')
  assert.ok(!/\b(Customer|SalesOrder)\b/.test(body('ReturnReason').replace(/SalesOrderRefund/g, '')), 'it points at no customer or order')
  assert.equal(TABLE_CLASSES.return_reasons?.kind, 'CONFIG_ALLOWED')
})

test('PurchaseOrderLine.notes exists, is not order-linked, and so has no erasure entry', () => {
  assert.match(body('PurchaseOrderLine'), /^\s+notes\s+String\?/m, 'PRECONDITION: the column exists')
  assert.ok(!/\b(Customer|SalesOrder)\b/.test(body('PurchaseOrderLine')), 'no relation path from a PO line to a customer or sales order')
  assert.equal(ERASURE_CLASSIFICATION.PurchaseOrderLine, undefined)
  assert.equal(TABLE_CLASSES.purchase_order_lines?.kind, 'RUNNER_WRITES', 'the table keeps its first-load class; the nullable column adds nothing the runner must write')
})
