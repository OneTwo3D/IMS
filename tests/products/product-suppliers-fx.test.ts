import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { fakeFxClient, type FakeFxRow } from '@/tests/helpers/fx-fake-client'

/**
 * getProductSuppliers shows each supplier price with its base equivalent. It used to read "the newest fx_rates row
 * for the currency" with no base filter and no date bound, and to treat the literal 'GBP' as the base. It now reads
 * the one central lookup (as of now, for the organisation's base); a currency with no usable rate shows null.
 */
const state = { fx: fakeFxClient([]), supplierProducts: [] as unknown[], base: 'GBP' as string | null }
function seed(rows: FakeFxRow[], supplierProducts: unknown[], base = 'GBP') {
  state.fx = fakeFxClient(rows, base)
  state.supplierProducts = supplierProducts
}
const sp = (currency: string, cost = 12) => ({ supplierId: `s-${currency}`, supplier: { id: `s-${currency}`, name: `Sup ${currency}` }, supplierSku: null, lastUnitCost: cost, currency, updatedAt: new Date('2026-01-01') })
const ago = (ms: number) => new Date(Date.now() - ms)

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('next/navigation', { namedExports: { redirect: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: { requireAuth: async () => ({}), requireInternalUser: async () => ({ user: { id: 'u1', role: 'ADMIN' } }), requirePermission: async () => {} },
})
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {}, pushProductMetadata: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      supplierProduct: { findMany: async () => state.supplierProducts },
      currency: { findMany: async () => [{ code: 'EUR', symbol: '€' }, { code: 'USD', symbol: '$' }] },
      get organisation() { return state.fx.organisation },
      get fxRate() { return state.fx.fxRate },
      get setting() { return state.fx.setting },
    },
  },
})

const run = async () => (await import('@/app/actions/products')).getProductSuppliers('p1')

test('supplier prices: base-currency prices need no rate; foreign ones use the latest stored rate on or before now', async () => {
  seed([
    { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.10', fetchedAt: ago(5 * 86400_000) },
    { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.20', fetchedAt: ago(86400_000) },
    { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '9.99', fetchedAt: new Date(Date.now() + 86400_000) }, // future: never "latest"
  ], [sp('GBP', 10), sp('EUR', 12)])
  const rows = await run()
  const gbp = rows.find((r) => r.currency === 'GBP')!
  assert.equal(gbp.baseEquivalent, '10.00'); assert.equal(gbp.fxRate, '1')
  const eur = rows.find((r) => r.currency === 'EUR')!
  assert.equal(eur.fxRate, '1.2000'); assert.equal(eur.baseEquivalent, '10.00')
  assert.equal(eur.currencySymbol, '€')
})

test('supplier prices: no rate, an ambiguous tie, a zero rate and a rate from another base all show no base equivalent', async () => {
  const at = ago(86400_000)
  seed([
    { fromCurrency: 'GBP', toCurrency: 'USD', rate: '1.3', fetchedAt: at }, { fromCurrency: 'GBP', toCurrency: 'USD', rate: '1.4', fetchedAt: at },
    { fromCurrency: 'GBP', toCurrency: 'JPY', rate: '0', fetchedAt: at },
    { fromCurrency: 'EUR', toCurrency: 'CHF', rate: '0.95', fetchedAt: at },
  ], [sp('USD'), sp('JPY'), sp('CHF'), sp('SEK')])
  const rows = await run()
  assert.deepEqual(rows.map((r) => [r.currency, r.baseEquivalent, r.fxRate]), [['USD', null, null], ['JPY', null, null], ['CHF', null, null], ['SEK', null, null]])
})

test('supplier prices: the base is the organisation\'s, not a literal GBP', async () => {
  seed([{ fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.25', fetchedAt: ago(86400_000) }, { fromCurrency: 'GBP', toCurrency: 'USD', rate: '9', fetchedAt: ago(86400_000) }],
    [sp('EUR', 10), sp('USD', 25)], 'EUR')
  const rows = await run()
  assert.deepEqual(rows.map((r) => [r.currency, r.baseEquivalent, r.fxRate]), [['EUR', '10.00', '1'], ['USD', '20.00', '1.2500']])
})
