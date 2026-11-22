import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE SALES INVOICES SWITCH GATES THE WHOLE EU VAT TREATMENT. While it is off (or the chart's connector is not Xero, or the order carries store credit) `treatImportedSalesInvoice`
 * returns `skipped` before it reads a fact, gathers a rate, writes a stamp or copies the payload: the database is not touched at all, and the caller's payload is the very object it passed in.
 */
const touched: string[] = []
const dbProbe = new Proxy({}, { get: (_target, key) => { touched.push(String(key)); throw new Error(`the database was touched (${String(key)}) while the switch was off`) } })
const logged: unknown[] = []
let enabled = false
const asked: Array<[string, string]> = []

mock.module('@/lib/db', { namedExports: { db: dbProbe } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (p: unknown) => { logged.push(p) }, logActivityPersisted: async () => true, logActivityInTransaction: async () => {} } })
mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingSyncTypeEnabledFor: async (connector: string, type: string) => { asked.push([connector, type]); return enabled },
  },
})

const params = (over: Record<string, unknown> = {}) => ({
  orderId: 'order-1',
  wcOrder: { id: 1, number: '1', total: '100.00', currency: 'EUR', line_items: [], fee_lines: [], tax_lines: [], meta_data: [] } as never,
  payload: { currency: 'EUR', lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200', taxType: 'OUTPUT2' }] } as Record<string, unknown>,
  mappedLines: [{ isFeeLine: false, wclcFeeKind: null, forceNoTax: false, taxForeign: 0 }],
  connector: 'xero' as string | null,
  taxBindingDeps: { reverseChargeSalesTaxType: '', invoiceTypes: { lines: [], shipping: { rateId: null, type: null }, discount: { rateId: null, source: 'mapped', type: null } } },
  accounts: { ioss: '821', ddp: '232', fee: '232', rounding: '860' },
  storeCreditForeign: { gt: () => false },
  now: new Date('2026-11-10T00:00:00Z'),
  ...over,
})

test('switch off: skipped, the database untouched, nothing logged', async () => {
  const { treatImportedSalesInvoice } = await import('../../lib/connectors/woocommerce/sync/eu-vat-invoice-treatment')
  enabled = false
  const outcome = await treatImportedSalesInvoice(params())
  assert.deepEqual(outcome, { kind: 'skipped', why: 'switch_off' })
  assert.deepEqual(touched, [])
  assert.deepEqual(logged, [])
  assert.deepEqual(asked, [['xero', 'SALES_INVOICE']], 'the question is the Sales Invoices switch of the chart\'s connector')
})

test('a connector that is not Xero is skipped without even asking', async () => {
  const { treatImportedSalesInvoice } = await import('../../lib/connectors/woocommerce/sync/eu-vat-invoice-treatment')
  enabled = true
  asked.length = 0
  for (const connector of [null, 'retired-ledger']) {
    assert.deepEqual(await treatImportedSalesInvoice(params({ connector })), { kind: 'skipped', why: 'switch_off' })
  }
  assert.deepEqual(asked, [])
  assert.deepEqual(touched, [])
})

test('switch on, but the order carries store credit: skipped (its invoice is refused whole), nothing stamped', async () => {
  const { treatImportedSalesInvoice } = await import('../../lib/connectors/woocommerce/sync/eu-vat-invoice-treatment')
  enabled = true
  assert.deepEqual(await treatImportedSalesInvoice(params({ storeCreditForeign: { gt: () => true } })), { kind: 'skipped', why: 'store_credit' })
  assert.deepEqual(touched, [])
})

test('the shadow preview assumes the switch ON in memory: it never asks the setting; the held-invoice preview still asks and stays off', async () => {
  const { previewTreatedSalesInvoice } = await import('../../lib/connectors/woocommerce/sync/eu-vat-invoice-treatment')
  enabled = false
  asked.length = 0
  const client = dbProbe as never
  // Default (the held-invoice check): the switch is asked, and off means skipped.
  assert.deepEqual(await previewTreatedSalesInvoice(client, params()), { kind: 'skipped', why: 'switch_off' })
  assert.deepEqual(asked, [['xero', 'SALES_INVOICE']])
  // Shadow: the switch is not asked at all (so it is neither read nor changed); the next gate is reached instead.
  asked.length = 0
  assert.deepEqual(await previewTreatedSalesInvoice(client, params({ storeCreditForeign: { gt: () => true } }), { assumeSwitchOn: true, provisionalStamp: true }), { kind: 'skipped', why: 'store_credit' })
  assert.deepEqual(asked, [])
  // Still Xero only.
  assert.deepEqual(await previewTreatedSalesInvoice(client, params({ connector: 'retired-ledger' }), { assumeSwitchOn: true }), { kind: 'skipped', why: 'switch_off' })
  assert.deepEqual(touched, [])
})
