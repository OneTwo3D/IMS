import assert from 'node:assert/strict'
import test from 'node:test'

import { readImsSnapshot, statementAllowed, type ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'

/** The `vat` section of the IMS read (R12's IMS side) over a scripted connection. The SQL itself runs against a real database in the concurrency test. */

type Answers = { orgs?: Array<Record<string, unknown>>; sales?: Array<Record<string, unknown>>; tokens?: Array<Record<string, unknown>>; types?: Array<Record<string, unknown>>; settings?: Array<Record<string, unknown>>; chart?: Array<Record<string, unknown>>; fx?: Array<Record<string, unknown>> }
function fake(answers: Answers): ImsQueryClient & { sent: Array<{ sql: string; values?: unknown[] }> } {
  const sent: Array<{ sql: string; values?: unknown[] }> = []
  return {
    sent,
    async query(sql, values) {
      sent.push({ sql, values })
      if (/^BEGIN|^ROLLBACK|^SET LOCAL/i.test(sql)) return { rows: [] }
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '1:2:', read_only: 'on', isolation: 'repeatable read' }] }
      if (/FROM organisations/.test(sql)) return { rows: answers.orgs ?? [{ base: 'GBP' }] }
      if (/FROM sales_order_lines/.test(sql)) return { rows: answers.sales ?? [] }
      if (/FROM accounting_tokens/.test(sql)) return { rows: answers.tokens ?? [{ tenant: 'tenant-1' }] }
      if (/FROM xero_tax_rates/.test(sql)) return { rows: answers.types ?? [] }
      if (/FROM settings/.test(sql)) return { rows: answers.settings ?? [] }
      if (/FROM accounting_accounts/.test(sql)) return { rows: answers.chart ?? [{ n: '0' }] }
      if (/FROM shopping_order_links/.test(sql)) return { rows: answers.fx ?? [] }
      throw new Error(`unexpected statement ${sql}`)
    },
  }
}
const WINDOW = { from: '2026-08-01', toExclusive: '2026-10-01' }
const read = async (answers: Answers, vatWindow: { from: string; toExclusive: string } | null = WINDOW) => {
  const client = fake(answers)
  const result = await readImsSnapshot(client, { sections: ['vat'], vatWindow: vatWindow ?? undefined })
  assert.ok(result.ok)
  return { section: result.sections.vat!, client }
}

test('the section carries the base currency, the monthly sales tax per rate, the Xero report types, the shipping account and the foreign order rates', async () => {
  const { section, client } = await read({
    orgs: [{ base: 'GBP' }],
    sales: [{ period: '2026-08', rate_id: 'rGB', tax: '50.0000', n: '2', nz: '2' }, { period: '2026-09', rate_id: 'rGB', tax: '100.0000', n: '3', nz: '3' }, { period: '2026-09', rate_id: null, tax: '0.0000', n: '1', nz: '0' }],
    types: [{ tax_type: 'OUTPUT2', report: 'OUTPUT' }, { tax_type: 'NONE', report: null }],
    settings: [{ key: 'xero_shipping_account', value: ' 260 ' }, { key: 'xero_sales_account', value: '200' }, { key: 'xero_discount_account', value: '' }],
    chart: [{ n: '1' }],
    fx: [{ external_id: '9001', currency: 'EUR', fx: '1.15000000' }],
  })
  assert.deepEqual(section, { ok: true, value: {
    baseCurrency: 'GBP', window: WINDOW,
    sales: [{ period: '2026-08', taxRateId: 'rGB', taxBase: '50.0000', lines: 2, nonZeroLines: 2 }, { period: '2026-09', taxRateId: 'rGB', taxBase: '100.0000', lines: 3, nonZeroLines: 3 }, { period: '2026-09', taxRateId: null, taxBase: '0.0000', lines: 1, nonZeroLines: 0 }],
    xeroTenantId: 'tenant-1', xeroReportTypes: [{ taxType: 'OUTPUT2', reportTaxType: 'OUTPUT' }, { taxType: 'NONE', reportTaxType: null }], shippingAccount: '260', shippingAccountInChart: true, salesAccount: '200', discountAccount: '', wooFx: [{ externalOrderId: '9001', currency: 'EUR', fxRateToBase: '1.15000000' }],
  } })
  // The window is a parameter of the sales statement, and the statement leaves out cancelled and archived orders (the IMS VAT report's own population).
  const sales = client.sent.find((s) => /FROM sales_order_lines/.test(s.sql))!
  assert.deepEqual(sales.values, [WINDOW.from, WINDOW.toExclusive])
  assert.match(sales.sql, /so\."invoicedAt" >= \$1::date AND so\."invoicedAt" < \$2::date/)
  assert.match(sales.sql, /so\.status::text <> 'CANCELLED'/)
  assert.match(sales.sql, /so\.archived = false/)
  assert.match(sales.sql, /SUM\(l\."taxBase"\)/)
  assert.doesNotMatch(sales.sql, /shipping|taxBase.*tax_foreign/i)
  for (const { sql } of client.sent) assert.ok(statementAllowed(sql) || /^(BEGIN|ROLLBACK)/.test(sql), sql)
})

test('no organisation row is the documented default GBP; two are DUPLICATE_KEY; a bad currency text is refused', async () => {
  assert.equal(((await read({ orgs: [] })).section as { ok: true; value: { baseCurrency: string } }).value.baseCurrency, 'GBP')
  const eur = (await read({ orgs: [{ base: 'EUR' }] })).section
  assert.ok(eur.ok && eur.value.baseCurrency === 'EUR', 'carried as it is; the item decides what a non-GBP base means')
  assert.deepEqual((await read({ orgs: [{ base: 'GBP' }, { base: 'GBP' }] })).section, { ok: false, reason: 'DUPLICATE_KEY' })
  assert.deepEqual((await read({ orgs: [{ base: '' }] })).section, { ok: false, reason: 'CURRENCY_UNKNOWN' })
})

test('THE WINDOW IS REQUIRED AND MUST BE A WINDOW: none, a bad date, or an empty or reversed one is a section failure and no statement', async () => {
  for (const window of [null, { from: '2026-08-01', toExclusive: '2026-08-01' }, { from: '2026-10-01', toExclusive: '2026-08-01' }, { from: '2026-13-01', toExclusive: '2026-14-01' }, { from: '2026-8-1', toExclusive: '2026-10-01' }]) {
    const { section, client } = await read({}, window)
    assert.deepEqual(section, { ok: false, reason: 'BAD_MODE' }, JSON.stringify(window))
    assert.ok(!client.sent.some((s) => /FROM organisations|FROM sales_order_lines/.test(s.sql)))
  }
})

// [mutation: the period or amount parsing loosened / the uniqueness check removed]
test('a row that cannot be read exactly makes the whole section unreadable: a bad period, a non-decimal tax, a repeated (period, rate), a bad count, a bad Xero type', async () => {
  const cases: Array<[string, Answers, string]> = [
    ['period shape', { sales: [{ period: '2026-8', rate_id: 'r', tax: '1.0000', n: '1', nz: '1' }] }, 'SOURCE_UNREADABLE'],
    ['period month', { sales: [{ period: '2026-13', rate_id: 'r', tax: '1.0000', n: '1', nz: '1' }] }, 'SOURCE_UNREADABLE'],
    ['tax not a decimal', { sales: [{ period: '2026-09', rate_id: 'r', tax: '1e3', n: '1', nz: '1' }] }, 'BAD_VALUE'],
    ['tax a number', { sales: [{ period: '2026-09', rate_id: 'r', tax: 5, n: '1', nz: '1' }] }, 'BAD_VALUE'],
    ['repeated key', { sales: [{ period: '2026-09', rate_id: 'r', tax: '1.0000', n: '1', nz: '1' }, { period: '2026-09', rate_id: 'r', tax: '2.0000', n: '1', nz: '1' }] }, 'DUPLICATE_KEY'],
    ['repeated null rate', { sales: [{ period: '2026-09', rate_id: null, tax: '1.0000', n: '1', nz: '1' }, { period: '2026-09', rate_id: null, tax: '2.0000', n: '1', nz: '1' }] }, 'DUPLICATE_KEY'],
    ['non-zero count', { sales: [{ period: '2026-09', rate_id: 'r', tax: '1.0000', n: '1', nz: 'x' }] }, 'BAD_VALUE'],
    ['count', { sales: [{ period: '2026-09', rate_id: 'r', tax: '1.0000', n: 'many', nz: '0' }] }, 'BAD_VALUE'],
    ['xero type', { types: [{ tax_type: 'OUT PUT', report: 'OUTPUT' }] }, 'SOURCE_UNREADABLE'],
    ['xero report', { types: [{ tax_type: 'OUTPUT2', report: 5 }] }, 'SOURCE_UNREADABLE'],
    ['xero duplicate', { types: [{ tax_type: 'OUTPUT2', report: 'OUTPUT' }, { tax_type: 'OUTPUT2', report: 'OUTPUT' }] }, 'DUPLICATE_KEY'],
    ['two tokens', { tokens: [{ tenant: 'a' }, { tenant: 'b' }] }, 'DUPLICATE_KEY'],
    ['setting control char', { settings: [{ key: 'xero_shipping_account', value: '2\u000060' }] }, 'SOURCE_UNREADABLE'],
    ['setting not text', { settings: [{ key: 'xero_shipping_account', value: null }] }, 'SOURCE_UNREADABLE'],
    ['chart count text', { settings: [{ key: 'xero_shipping_account', value: '260' }], chart: [{ n: 'x' }] }, 'BAD_VALUE'],
    ['two settings', { settings: [{ key: 'xero_shipping_account', value: '1' }, { key: 'xero_shipping_account', value: '2' }] }, 'DUPLICATE_KEY'],
    ['fx rate', { fx: [{ external_id: '9', currency: 'EUR', fx: 'x' }] }, 'BAD_VALUE'],
    ['fx duplicate', { fx: [{ external_id: '9', currency: 'EUR', fx: '1.1' }, { external_id: '9', currency: 'EUR', fx: '1.1' }] }, 'DUPLICATE_KEY'],
  ]
  for (const [name, answers, reason] of cases) assert.deepEqual((await read(answers)).section, { ok: false, reason }, name)
})

test('no connected organisation: no Xero report types are read at all and the tenant is null; an absent shipping account is the empty string', async () => {
  const { section, client } = await read({ tokens: [] })
  assert.ok(section.ok)
  assert.deepEqual([section.value.xeroTenantId, section.value.xeroReportTypes, section.value.shippingAccount, section.value.shippingAccountInChart], [null, [], '', false])
  assert.ok(!client.sent.some((s) => /FROM xero_tax_rates/.test(s.sql)))
})

test('the row cap is a section failure, never a shorter list', async () => {
  const client = fake({ sales: [{ period: '2026-09', rate_id: 'a', tax: '1.0000', n: '1', nz: '1' }, { period: '2026-09', rate_id: 'b', tax: '1.0000', n: '1', nz: '1' }] })
  const result = await readImsSnapshot(client, { sections: ['vat'], vatWindow: WINDOW, rowCap: 1 })
  assert.ok(result.ok)
  assert.deepEqual(result.sections.vat, { ok: false, reason: 'CAP_EXCEEDED' })
})
