import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from '@/tests/fixtures/render-client-component'
import { parseCsv } from '@/lib/csv'

/**
 * o3d-iigc round 4, Codex finding 3: THE EXPORTS.
 *
 * Round 3 renamed the supplier-aging column `netAmount` -> `netAmountExVat` for one stated reason —
 * A FILE READER HAS NO TOOLTIP — and then, one file away, left the sales-side derived figures
 * exporting bare. The products CSV carried a single flag column named after `netRevenue` alone, so
 * `grossProfit`, `marginPct` and `avgOrderValue` arrived in the spreadsheet indistinguishable from
 * measurements. And `marginPct` could not have been covered by that flag anyway: it is a ratio whose
 * bound can be `indeterminate` on a row where the other three are sound upper bounds, and a yes/no
 * column cannot say so.
 *
 * The product-profitability page has NO server export route — its browser-built file IS its only
 * export — and it had the same shape: one `Revenue is upper bound` column standing in front of an
 * equally bounded `Profit` column that said nothing.
 *
 * The fixture is round 3's own order: 1 unit at £100 ex-VAT with £40 of COGS, credited in full by a
 * legacy GROSS refund of £120, plus a second product whose COGS exceeds its revenue so the two
 * verdicts differ INSIDE ONE FILE.
 */

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})

// The profitability client reads the base currency from a context; the harness has no useContext,
// so the hook is replaced by its real default.
mock.module('@/components/providers/base-currency-provider', {
  namedExports: { useBaseCurrency: () => ({ code: 'GBP', symbol: '£', symbolPosition: 'PREFIX' }) },
})

function order(id: string, productId: string, cogsBase: number, refunds: unknown[]) {
  return {
    id, totalBase: 120, discountAmount: 0, fxRateToBase: 1,
    pricesIncludeVat: false, taxRatePercent: 0.2,
    customerName: 'Acme', salesRep: null, shoppingLinks: [],
    lines: [{
      productId, sku: `SKU-${productId}`, description: 'Widget',
      qty: 1, totalBase: 100, discountAmount: 0, cogsBase, taxRate: { rate: 0.2 },
    }],
    refunds,
  }
}

const grossCredit = (productId: string) => [{ totalsBasis: 'GROSS', lines: [{ productId, qty: 1, totalBase: 120 }] }]

// p1: COGS £40, so margin 60% and every figure is a sound upper bound.
// p2: COGS £150, so margin -50% and the ≤ relation does NOT hold for it.
const DEFAULT_ORDERS = [
  order('A', 'p1', 40, grossCredit('p1')),
  order('B', 'p2', 150, grossCredit('p2')),
]
let ORDERS: ReturnType<typeof order>[] = [...DEFAULT_ORDERS]

async function withOrders(orders: ReturnType<typeof order>[], body: () => Promise<void>): Promise<void> {
  ORDERS = orders
  try { await body() } finally { ORDERS = [...DEFAULT_ORDERS] }
}

const PRODUCTS = ['p1', 'p2'].map((id) => ({
  id, sku: `SKU-${id}`, name: `Widget ${id}`, type: 'SIMPLE', stockUnit: 'pcs',
  barcode: null, mpn: null, weight: null, salesPriceBase: null,
  lifecycleStatus: 'ACTIVE', stockLevels: [],
}))

let SUPPLIERS: unknown[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findMany: async () => ORDERS },
      product: { findMany: async () => PRODUCTS },
      supplier: { findMany: async () => SUPPLIERS },
    },
  },
})

async function exportCsv(type: string): Promise<Record<string, string>[]> {
  const { GET } = await import('@/app/api/export/analytics/route')
  const { NextRequest } = await import('next/server')
  const res = await GET(new NextRequest(`https://ims.test/api/export/analytics?type=${type}`))
  return parseCsv(await res.text())
}

async function headerOf(type: string): Promise<string[]> {
  const { GET } = await import('@/app/api/export/analytics/route')
  const { NextRequest } = await import('next/server')
  const res = await GET(new NextRequest(`https://ims.test/api/export/analytics?type=${type}`))
  const body = await res.text()
  return body.split('\r\n')[0].split(',')
}

// ---------------------------------------------------------------------------
// The products CSV
// ---------------------------------------------------------------------------

test('products CSV: every bounded figure carries its OWN bound column, beside it (o3d-iigc r4 #3)', async () => {
  const header = await headerOf('products')

  // The old single column, named after one of the four figures it silently spoke for.
  assert.ok(!header.includes('netRevenueIsUpperBound'), 'a yes/no flag cannot express "indeterminate"')

  for (const [figure, bound] of [
    ['netRevenue', 'netRevenueBound'],
    ['grossProfit', 'grossProfitBound'],
    ['marginPct', 'marginPctBound'],
    ['avgOrderValue', 'avgOrderValueBound'],
  ]) {
    assert.ok(header.includes(bound), `${bound} is missing`)
    assert.equal(header.indexOf(bound), header.indexOf(figure) + 1, `${bound} must sit immediately right of ${figure}`)
  }

  // Basis-independent columns get no bound, because marking them would be noise.
  for (const key of ['cogs', 'orderCount', 'qtySold', 'netQty', 'grossRevenue', 'discounts']) {
    assert.ok(!header.includes(`${key}Bound`), `${key} does not move with the refund basis`)
  }
})

test('products CSV: the ratio and the linear figures disagree INSIDE ONE FILE (o3d-iigc r4 #1 + #3)', async () => {
  const rows = await exportCsv('products')
  const p1 = rows.find((r) => r.sku === 'SKU-p1')!
  const p2 = rows.find((r) => r.sku === 'SKU-p2')!

  // p1 — £100 net revenue, £40 COGS: published margin 60%, and the worst reachable reading is the
  // report's guard at 0%. Everything is a genuine ceiling.
  assert.equal(p1.netRevenue, '100.00')
  assert.equal(p1.grossProfit, '60.00')
  assert.equal(p1.marginPct, '60')
  assert.equal(p1.netRevenueBound, 'upper')
  assert.equal(p1.grossProfitBound, 'upper')
  assert.equal(p1.marginPctBound, 'upper')
  assert.equal(p1.avgOrderValueBound, 'upper')

  // p2 — £100 net revenue, £150 COGS: published margin -50%, but placing the £120 gross credit at
  // its £100 ex-VAT value takes net revenue to £0, where the report prints 0%. 0% is not at most
  // -50%, so the ratio is INDETERMINATE while the three linear figures beside it are still ceilings.
  assert.equal(p2.netRevenue, '100.00')
  assert.equal(p2.grossProfit, '-50.00')
  assert.equal(p2.marginPct, '-50')
  assert.equal(p2.netRevenueBound, 'upper')
  assert.equal(p2.grossProfitBound, 'upper')
  assert.equal(p2.marginPctBound, 'indeterminate')
  assert.equal(p2.avgOrderValueBound, 'upper')

  // How loose all of them are is still exported beside them.
  assert.equal(p2.refundsGrossBasis, '120.00')
  assert.equal(p2.refundsUnknownBasis, '0.00')
})

test('products CSV: a clean row exports "exact" everywhere and no marks (o3d-iigc r4 #3 control)', async () => {
  await withOrders([order('A', 'p1', 40, [{ totalsBasis: 'NET', lines: [{ productId: 'p1', qty: 1, totalBase: 25 }] }])], async () => {
    const [row] = await exportCsv('products')
    assert.equal(row.netRevenue, '75.00')
    // Not vacuous: the SAME two columns read 'upper' for this product in the test above, on the same
    // fixture with a gross-basis credit instead of a net one.
    assert.equal(row.netRevenueBound, 'exact')
    assert.equal(row.grossProfitBound, 'exact')
    assert.equal(row.marginPctBound, 'exact')
    assert.equal(row.avgOrderValueBound, 'exact')
  })
})

// ---------------------------------------------------------------------------
// The supplier-aging CSV — round 3's rename, and round 4's credit basis
// ---------------------------------------------------------------------------

test('supplier-aging CSV: the ex-VAT header survives, and its columns still subtract (o3d-iigc r4 #4)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [{
      totalBase: 1080, taxBase: 180, directFreightBase: 0, subtotalBase: 900,
      lines: [{ totalBase: 1000 }], poSentAt: null, receivedAt: null, invoices: [],
      returns: [{ lines: [{ qtyReturned: 1, poLine: { unitCostBase: 100 } }] }],
    }],
  }]
  const header = await headerOf('po_aging')
  // Round 3's rename must survive: 'net' beside a Gross column and a Tax column reads as either
  // net-of-VAT or net-of-returns, and a file reader has no tooltip to disambiguate it.
  assert.ok(header.includes('netAmountExVat'))
  assert.ok(!header.includes('netAmount,'), 'the ambiguous name must not come back')

  const [row] = await exportCsv('po_aging')
  assert.equal(row.grossAmount, '1080.00')
  assert.equal(row.tax, '180.00')
  assert.equal(row.refunds, '90.00', 'the credit is exported on the basis the net amount subtracts it')
  assert.equal(row.netAmountExVat, '810.00')
  assert.equal(
    Number(row.grossAmount) - Number(row.tax) - Number(row.refunds),
    Number(row.netAmountExVat),
    'the columns in the file must still reconcile — a reader has only the file',
  )
})

// ---------------------------------------------------------------------------
// The product-profitability CSV — built in the browser, and the only export that page has
// ---------------------------------------------------------------------------

test('profitability CSV: Profit gets its own bound column instead of borrowing Revenue’s (o3d-iigc r4 #3)', async () => {
  const captured: Blob[] = []
  const realCreate = globalThis.URL.createObjectURL
  const realRevoke = globalThis.URL.revokeObjectURL
  const hadDocument = 'document' in globalThis
  globalThis.URL.createObjectURL = ((blob: Blob) => { captured.push(blob); return 'blob:test' }) as typeof URL.createObjectURL
  globalThis.URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  ;(globalThis as { document?: unknown }).document = {
    createElement: () => ({ href: '', download: '', click() {} }),
  }

  try {
    const { ProductProfitabilityClient } = await import('@/app/(dashboard)/analytics/product-profitability/product-profitability-client')
    const mounted = mountClientComponent(ProductProfitabilityClient as unknown as (props: unknown) => unknown, {
      data: {
        rows: [{
          productId: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', lifecycleStatus: 'ACTIVE',
          totalStock: 0, salesPrice: null, salePrice: null, latestCogs: null,
          unitMargin: null, unitMarginPct: null,
          currentFyRevenue: 100, currentFyRefundsGrossBasis: 120, currentFyRefundsUnknownBasis: 0,
          currentFyRefundBasisComplete: false, currentFyCogs: 40, currentFyProfit: 60, currentFyQtySold: 1,
          previousFyRevenue: 50, previousFyRefundsGrossBasis: 0, previousFyRefundsUnknownBasis: 0,
          previousFyRefundBasisComplete: true, previousFyCogs: 20, previousFyProfit: 30, previousFyQtySold: 1,
        }],
        summary: {
          totalProducts: 1,
          currentFyRevenue: 100, currentFyRefundsGrossBasis: 120, currentFyRefundsUnknownBasis: 0,
          currentFyRefundBasisComplete: false, currentFyCogs: 40, currentFyProfit: 60,
          previousFyRevenue: 50, previousFyRefundsGrossBasis: 0, previousFyRefundsUnknownBasis: 0,
          previousFyRefundBasisComplete: true, previousFyCogs: 20, previousFyProfit: 30,
          fyLabel: 'FY26', prevFyLabel: 'FY25',
        },
      },
    })
    const { controls } = mounted.render()
    const exportControl = controls.find((c) => c.label.includes('Export'))
    assert.ok(exportControl, 'the page must still offer its only export')
    // Pressed, not called directly: what is asserted is the file the button actually produces.
    await mounted.click(exportControl)

    assert.equal(captured.length, 1)
    const csv = await captured[0].text()
    const header = csv.split('\n')[0].split(',')
    const values = csv.split('\n')[1].split(',')

    // Was `Revenue is upper bound (FY26)` sitting in front of an unmarked Profit column.
    assert.ok(!header.some((h) => h.startsWith('Revenue is upper bound')))
    assert.equal(header.indexOf('Revenue bound (FY26)'), header.indexOf('Revenue (FY26)') + 1)
    assert.equal(header.indexOf('Profit bound (FY26)'), header.indexOf('Profit (FY26)') + 1)
    assert.equal(header.indexOf('Profit bound (FY25)'), header.indexOf('Profit (FY25)') + 1)

    // Current FY is bounded; the previous FY, on the same row, is not.
    assert.equal(values[header.indexOf('Revenue bound (FY26)')], 'upper')
    assert.equal(values[header.indexOf('Profit bound (FY26)')], 'upper')
    assert.equal(values[header.indexOf('Revenue bound (FY25)')], 'exact')
    assert.equal(values[header.indexOf('Profit bound (FY25)')], 'exact')

    // `Margin %` here is unitMarginPct — list price against latest COGS, which no refund touches —
    // so it is deliberately unmarked, and this control proves the marking is not blanket.
    assert.ok(!header.includes('Margin % bound'))
  } finally {
    globalThis.URL.createObjectURL = realCreate
    globalThis.URL.revokeObjectURL = realRevoke
    if (!hadDocument) delete (globalThis as { document?: unknown }).document
  }
})
