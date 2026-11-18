import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { NextRequest } from 'next/server'

/**
 * The sales order CSV export carries the order's invoicing state as its LAST column, so no existing column moves (the file is also the import
 * round-trip: the import reads columns by name and ignores this one). The import TEMPLATE does not carry it.
 * [mutation: put the column anywhere but last, drop it, or add it to the template: red]
 */

const lineRow = { sku: 'SKU-1', qty: 2, unitPriceForeign: 5, discountAmount: 0, discountStr: null, taxRate: null }
const base = {
  orderNumber: 'SO-1', externalOrderNumber: null, id: 'o1', customerName: 'A', customerEmail: 'a@example.test', currency: 'GBP', fxRateToBase: 1,
  shipFromWarehouse: { code: 'MAIN' }, taxRateName: null, taxRatePercent: null, pricesIncludeVat: false, shippingService: null, shippingForeign: 0,
  discountAmount: 0, expectedDelivery: null, salesRep: null, notes: null, lines: [lineRow],
}
mock.module('@/lib/auth/server', { namedExports: { requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findMany: async () => [
          { ...base, invoicingState: 'FULLY_INVOICED' },
          { ...base, orderNumber: 'SO-2', id: 'o2', invoicingState: 'NOT_INVOICED' },
          { ...base, orderNumber: 'SO-3', id: 'o3', invoicingState: 'PARTIALLY_INVOICED' },
        ],
      },
    },
  },
})

test('the invoicing state is the last column of the sales export and holds each order\'s state', async () => {
  const { GET } = await import('../../app/api/export/sales/route.ts')
  const response = await GET(new NextRequest('http://localhost/api/export/sales'))
  const [header, ...rows] = (await response.text()).split('\r\n')
  const columns = header.split(',')
  assert.equal(columns[columns.length - 1], 'invoicingState')
  assert.equal(columns[columns.length - 2], 'notes', 'the previous last column did not move')
  assert.deepEqual(rows.map((r) => r.split(',').pop()), ['FULLY_INVOICED', 'NOT_INVOICED', 'PARTIALLY_INVOICED'])
})

test('the import template is unchanged: it does not offer an invoicing column', async () => {
  const { GET } = await import('../../app/api/export/sales/route.ts')
  const response = await GET(new NextRequest('http://localhost/api/export/sales?template=1'))
  const header = (await response.text()).split('\r\n')[0]
  assert.ok(!header.includes('invoicingState'))
  assert.ok(header.endsWith(',notes'))
})
