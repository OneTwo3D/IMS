import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { BillData } from '@/lib/connectors/types'

/**
 * ACC-H3, the connector's last word: a supplier bill (create and update) or supplier credit note with a line that has no decided tax
 * type is refused BEFORE any request - no contact, nothing on the wire - and the pure builders throw. NONE posts only on a line that
 * names why, and the name is never sent. (Used to be `line.taxType || 'NONE'`.)
 */

const wire: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
let contactResolves = 0

mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => { wire.push({ method: 'GET', path }); return { ok: true, status: 200, data: {} } },
    xeroPost: async (path: string, body: Record<string, unknown>) => { wire.push({ method: 'POST', path, body }); return { ok: true, status: 200, data: { Invoices: [{ InvoiceID: 'b-1', InvoiceNumber: 'N', Status: 'AUTHORISED' }] } } },
    xeroPut: async (path: string, body: Record<string, unknown>) => { wire.push({ method: 'PUT', path, body }); return { ok: true, status: 200, data: { Invoices: [{ InvoiceID: 'b-1', InvoiceNumber: 'N', Status: 'AUTHORISED' }] } } },
  },
})
mock.module('@/lib/connectors/xero/contacts', {
  namedExports: { findOrCreateContact: async () => { contactResolves += 1; return { success: true, contactId: 'contact-1' } } },
})

test.beforeEach(() => { wire.length = 0; contactResolves = 0 })

const line = { description: 'Goods', quantity: 1, unitAmount: 10, accountCode: '631', taxType: 'INPUT2' }
const bill = (extra: Partial<BillData> = {}): BillData => ({ invoiceNumber: 'SUP-1', contactName: 'Supplier', date: '2026-11-02', currency: 'GBP', lines: [line], ...extra }) as BillData

const BAD: Array<[string, Partial<BillData>]> = [
  ['a line with no TaxType', { lines: [{ ...line, taxType: undefined }] }],
  ['a line with a blank TaxType', { lines: [{ ...line, taxType: '  ' }] }],
  ['an explicit NONE with no named kind', { lines: [{ ...line, taxType: 'NONE' }] }],
]

for (const [label, extra] of BAD) {
  test(`builder throws and ${label} is refused before any request (bill create and update)`, async () => {
    const { buildPurchaseBillPayload, pushPurchaseBill, updatePurchaseBill } = await import('@/lib/connectors/xero/bills')
    assert.throws(() => buildPurchaseBillPayload(bill(extra), 'AUTHORISED', 'c1', 'GBP'), /NOTHING WAS SENT/)
    for (const result of [await pushPurchaseBill(bill(extra), 'AUTHORISED'), await updatePurchaseBill('b-9', bill(extra), 'AUTHORISED')]) {
      assert.equal(result.success, false)
      assert.match(String(result.error), /^NOTHING WAS SENT\. Purchase bill SUP-1 was refused/)
    }
    assert.equal(contactResolves, 0, 'no contact round trip')
    assert.deepEqual(wire, [], 'nothing on the wire')
  })
}

test('a decided bill posts with the types it was given; a named NONE posts as NONE and the kind name is never sent', async () => {
  const { pushPurchaseBill } = await import('@/lib/connectors/xero/bills')
  const result = await pushPurchaseBill(bill({ lines: [line, { ...line, description: 'Duty', taxType: 'NONE', noTaxKind: 'cost-not-vatable' }] }), 'AUTHORISED')
  assert.equal(result.success, true)
  const items = wire.find((w) => w.method === 'PUT')!.body!.LineItems as Array<Record<string, unknown>>
  assert.deepEqual(items.map((l) => l.TaxType), ['INPUT2', 'NONE'])
  for (const l of items) assert.equal('noTaxKind' in l, false)
})
