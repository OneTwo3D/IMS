import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { createRecordingDb } from './recording-db'

/**
 * Sales Statistics, Inventory Report and Product Profitability (and the actions behind them) were gated by the
 * `analytics` permission only, which READONLY holds: margins, FIFO value, invoices and customer ageing were open
 * to it. They now follow the Admin / Manager / Finance policy of every other analytics group.
 */
type Role = 'ADMIN' | 'MANAGER' | 'FINANCE' | 'WAREHOUSE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'ADMIN'

mock.module('@/lib/auth', {
  namedExports: { auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole } }) },
})
const recorder = createRecordingDb([])
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

const PAGES = ['sales-stats', 'inventory-stats', 'product-profitability'] as const
const isRedirect = (error: unknown) => error instanceof Error && /NEXT_REDIRECT/.test(`${error.message} ${(error as { digest?: string }).digest ?? ''}`)

before(async () => {
  currentRole = 'ADMIN'
  const mod = await import('@/app/(dashboard)/analytics/product-profitability/page')
  await recorder.prove(async () => { try { await mod.default() } catch { /* rendering is not the point */ } })
})

for (const name of PAGES) {
  for (const role of ['READONLY', 'WAREHOUSE', 'SUPPLIER'] as const) {
    test(`/analytics/${name} redirects a ${role} session without reading`, async () => {
      currentRole = role
      recorder.reset()
      const mod = await import(`@/app/(dashboard)/analytics/${name}/page`)
      await assert.rejects(() => mod.default(), isRedirect)
      recorder.assertNoReads(`${role} opening /analytics/${name}`)
    })
  }
}

test('the overview server actions refuse READONLY without reading', async () => {
  currentRole = 'READONLY'
  recorder.reset()
  const sales = await import('@/app/actions/sales-stats')
  const inv = await import('@/app/actions/inventory-stats')
  const prof = await import('@/app/actions/product-profitability')
  const fc = await import('@/app/actions/forecasting')
  const calls: Array<() => Promise<unknown>> = [
    () => sales.getProductSalesStats(), () => sales.getShipments(), () => sales.getDetails(),
    () => sales.getInvoiceStats(), () => sales.getRefundStats(), () => sales.getCustomerAging(),
    () => inv.getStockOnHand(), () => inv.getStockMovements(), () => inv.getStockAllocations(), () => inv.getReorderInventory(),
    () => prof.getProductProfitability(),
    () => fc.getForecastSettings(), () => fc.generateForecasts(),
  ]
  for (const call of calls) await assert.rejects(call, /Forbidden/)
  recorder.assertNoReads('READONLY calling overview analytics actions')
})
