import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * isBaseCurrencyLocked(client) reads ONLY through the client it is handed (a transaction), never through the global one: inside the FX table lock the global client would need a second pooled
 * connection (see the census in tests/currencies/fx-table-writers-census.test.ts). The global client here throws on any use.
 */
const boom = () => { throw new Error('the global client was used') }
mock.module('@/lib/db', { namedExports: { db: new Proxy({}, { get: boom }) } })

function fakeClient(opts: { marker?: string; counts?: Partial<Record<'product' | 'supplier' | 'customer' | 'purchaseOrder' | 'salesOrder' | 'stockMovement', number>> }) {
  const calls: string[] = []
  const count = (name: string, n = 0) => ({ count: async () => { calls.push(name); return n } })
  return {
    calls,
    client: {
      setting: { findUnique: async () => { calls.push('setting'); return opts.marker === undefined ? null : { value: opts.marker } } },
      product: count('product', opts.counts?.product),
      supplier: count('supplier', opts.counts?.supplier),
      customer: count('customer', opts.counts?.customer),
      purchaseOrder: count('purchaseOrder', opts.counts?.purchaseOrder),
      salesOrder: count('salesOrder', opts.counts?.salesOrder),
      stockMovement: count('stockMovement', opts.counts?.stockMovement),
    },
  }
}

test('isBaseCurrencyLocked(client): the marker, then each count, all through the client; the global client is never touched', async () => {
  const { isBaseCurrencyLocked } = await import('@/lib/base-currency')
  const unlocked = fakeClient({})
  assert.equal(await isBaseCurrencyLocked(unlocked.client as never), false)
  assert.deepEqual(unlocked.calls, ['setting', 'product', 'supplier', 'customer', 'purchaseOrder', 'salesOrder', 'stockMovement'])
  assert.equal(await isBaseCurrencyLocked(fakeClient({ marker: 'true' }).client as never), true, 'the marker locks it')
  assert.equal(await isBaseCurrencyLocked(fakeClient({ marker: 'false' }).client as never), false)
  for (const table of ['product', 'supplier', 'customer', 'purchaseOrder', 'salesOrder', 'stockMovement'] as const) {
    assert.equal(await isBaseCurrencyLocked(fakeClient({ counts: { [table]: 2 } }).client as never), true, `${table} data locks it`)
  }
})
