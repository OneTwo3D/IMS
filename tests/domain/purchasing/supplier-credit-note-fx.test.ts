import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { supplierCreditNoteAmountBase } from '@/lib/domain/purchasing/supplier-credit-note-amount'

/**
 * A SUPPLIER CREDIT NOTE'S BASE AMOUNT DIVIDES BY THE RATE (o3d-a1nbz).
 *
 * `fxRateToBase` is foreign units per ONE base unit (EUR 1.17 = GBP 1), so EUR 100 at 1.17 is GBP 85.47. The
 * action used to MULTIPLY and booked GBP 117.00. A test with a rate of 1 cannot tell the two apart, so every arm
 * here uses a rate that is not 1 and prints the rate and the amounts it saw.
 */

type Captured = { created: Array<Record<string, unknown>> }
const captured: Captured = { created: [] }

let poFixture: Record<string, unknown> = {}
const fakeDb = {
  purchaseOrder: { findUnique: async () => poFixture },
  supplierCreditNote: {
    aggregate: async () => ({ _sum: { amountForeign: null } }),
    create: async (args: { data: Record<string, unknown> }) => { captured.created.push(args.data); return { id: 'cn-1' } },
  },
}
const dbProxy = new Proxy(fakeDb as Record<string, unknown>, {
  get(target, key) {
    if (key in target) return target[key as string]
    if (key === 'then') return undefined
    // Anything else (the activity log) is accepted and ignored.
    return new Proxy(function noop() {}, { get: () => async () => null, apply: async () => null })
  },
})
mock.module('@/lib/db', { namedExports: { db: dbProxy } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
    requireApiFreshAdmin: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })

test('helper: foreign / rate, 4dp half-up; EUR 100 at 1.17 is 85.4701, never 117', () => {
  const base = supplierCreditNoteAmountBase('100', '1.17')
  console.log(`helper PRECONDITION: EUR 100 at rate 1.17 -> base ${base.toString()}`)
  assert.equal(base.toString(), '85.4701')
  assert.equal(supplierCreditNoteAmountBase(50, 0.5).toString(), '100')
  assert.equal(supplierCreditNoteAmountBase('10', '1').toString(), '10')
})

test('helper: a rate that is not above zero is refused, not turned into Infinity or zero', () => {
  for (const rate of [0, -1, '0.00000000']) {
    assert.throws(() => supplierCreditNoteAmountBase(10, rate), /greater than zero/, `rate ${rate}`)
  }
})

test('recordSupplierFreightCreditNote: base amount divides by the BILL rate, and the stored rate is that rate', async () => {
  poFixture = {
    id: 'po-1', reference: 'PO-1', currency: 'EUR', fxRateToBase: '1.25', supplierId: 's1',
    invoices: [{ id: 'inv-1', fxRateToBase: '1.17', totalForeign: '500' }],
  }
  captured.created.length = 0
  const { recordSupplierFreightCreditNote } = await import('@/app/actions/purchase-orders')
  const result = await recordSupplierFreightCreditNote({ poId: 'po-1', amountForeign: 100, creditNoteNumber: 'CN-1' })
  console.log(`action PRECONDITION: success=${result.success} creates=${captured.created.length} data=${JSON.stringify(captured.created[0])}`)
  assert.equal(result.success, true, String(result.error))
  assert.equal(captured.created.length, 1, 'exactly one credit note was created')
  assert.equal(Number(captured.created[0]!.fxRateToBase), 1.17, 'the bill rate (not the PO rate 1.25) was used')
  assert.equal(Number(captured.created[0]!.amountForeign), 100)
  assert.equal(Number(captured.created[0]!.amountBase), 85.4701)
})

test('recordSupplierFreightCreditNote: with no bill rate the order rate is used, divided', async () => {
  poFixture = {
    id: 'po-2', reference: 'PO-2', currency: 'EUR', fxRateToBase: '1.25', supplierId: 's1',
    invoices: [{ id: 'inv-2', fxRateToBase: null, totalForeign: '500' }],
  }
  captured.created.length = 0
  const { recordSupplierFreightCreditNote } = await import('@/app/actions/purchase-orders')
  const result = await recordSupplierFreightCreditNote({ poId: 'po-2', amountForeign: 100 })
  console.log(`action PRECONDITION (order-rate fallback): success=${result.success} data=${JSON.stringify(captured.created[0])}`)
  assert.equal(result.success, true, String(result.error))
  assert.equal(captured.created.length, 1)
  assert.equal(Number(captured.created[0]!.amountBase), 80)
})

test('posting path: the transit base of a credit note is computed with the helper, never foreign x rate', () => {
  const source = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  const multiplying = source.match(/Number\(cn\.amountForeign\)\s*\*\s*Number\(cn\.fxRateToBase\)|mul\(fxRateToBase\)/g) ?? []
  const viaHelper = source.match(/supplierCreditNoteAmountBase\(/g) ?? []
  console.log(`source PRECONDITION: multiplying sites=${multiplying.length}, helper call sites=${viaHelper.length}`)
  assert.equal(viaHelper.length, 2, 'the record action and the posting transit base both use the helper')
  assert.equal(multiplying.length, 0)
})
