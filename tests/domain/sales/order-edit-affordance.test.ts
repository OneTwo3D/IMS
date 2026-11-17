import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { resolveSalesOrderEditBlock } from '@/lib/domain/sales/order-edit-affordance'

/**
 * An order can be edited only while it is a DRAFT nothing else holds a copy of. The server action and the order page both call this helper, so the page disables Edit with the reason the action would give.
 * [mutation: drop any one check below from the helper: its arm is red]
 */
type EditInput = Parameters<typeof resolveSalesOrderEditBlock>[0]
const clean: EditInput = { status: 'DRAFT', allocations: 0, shipments: 0, accountingInvoiceId: null, wmsPush: false, hasExternalSource: false }

test('a clean draft is editable', () => {
  assert.equal(resolveSalesOrderEditBlock({ ...clean }), null)
})

test('every non-draft status is refused, with the reason that editing confirmed orders is not available yet', () => {
  for (const status of ['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED']) {
    const block = resolveSalesOrderEditBlock({ ...clean, status })
    assert.equal(block?.code, 'NOT_DRAFT', status)
    assert.match(block!.reason, /Only draft orders can be edited/)
  }
})

test('each blocker on an otherwise clean draft refuses, with its own reason', () => {
  const cases: Array<[Partial<EditInput>, string, RegExp]> = [
    [{ allocations: 1 }, 'ALLOCATION', /Stock is allocated/],
    [{ shipments: 1 }, 'SHIPMENT', /shipment exists/],
    [{ accountingInvoiceId: 'INV-1' }, 'ACCOUNTING_INVOICE', /accounting invoice has already been posted/],
    [{ wmsPush: true }, 'WMS_PUSH', /sent to the warehouse/],
    [{ hasExternalSource: true }, 'EXTERNAL_SOURCE', /WooCommerce/],
    [{ erased: true }, 'ERASED', /erased/],
    [{ refunds: 1 }, 'REFUND', /refunds/],
    [{ refundStatus: 'PARTIAL' }, 'REFUND', /refunds/],
    [{ returnExpectations: 1 }, 'RETURN_EXPECTATION', /return expectations/],
  ]
  for (const [over, code, reason] of cases) {
    const block = resolveSalesOrderEditBlock({ ...clean, ...over })
    assert.equal(block?.code, code)
    assert.match(block!.reason, reason)
  }
})

test('several blockers at once report the most fundamental first (erased, status, source, invoice, warehouse, shipment, allocation)', () => {
  const all = { allocations: 2, shipments: 1, accountingInvoiceId: 'INV-1', wmsPush: true, hasExternalSource: true }
  assert.equal(resolveSalesOrderEditBlock({ ...clean, ...all, erased: true })?.code, 'ERASED')
  assert.equal(resolveSalesOrderEditBlock({ ...clean, ...all, status: 'ALLOCATED' })?.code, 'NOT_DRAFT')
  assert.equal(resolveSalesOrderEditBlock({ ...clean, ...all })?.code, 'EXTERNAL_SOURCE')
  assert.equal(resolveSalesOrderEditBlock({ ...clean, ...all, hasExternalSource: false })?.code, 'ACCOUNTING_INVOICE')
  assert.equal(resolveSalesOrderEditBlock({ ...clean, ...all, hasExternalSource: false, accountingInvoiceId: null })?.code, 'WMS_PUSH')
  assert.equal(resolveSalesOrderEditBlock({ ...clean, allocations: 2, shipments: 1 })?.code, 'SHIPMENT')
})

test('the server action and the order page both go through the helper (one rule, two callers)', async () => {
  const action = await readFile('app/actions/sales.ts', 'utf8')
  const page = await readFile('app/(dashboard)/sales/[id]/so-detail-client.tsx', 'utf8')
  assert.match(action, /resolveSalesOrderEditBlock\(\{/)
  assert.match(page, /resolveSalesOrderEditBlock\(\{/)
})
