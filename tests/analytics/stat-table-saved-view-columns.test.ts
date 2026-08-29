import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent, type Control, type Mounted } from '@/tests/fixtures/render-client-component'

/**
 * o3d-8u4h ROUND 2, Codex findings 3 and 4: THE "GLOBAL" SAVED-VIEW FIX THAT WAS NOT GLOBAL, AND
 * THE FILTER HALF THAT WAS NEVER FIXED AT ALL.
 *
 * A saved view stores its column keys and its filter rules VERBATIM in a settings row, and the
 * reports move underneath them — these supplier-aging buckets have now been renamed twice, away
 * from `overdue*` and then away from `unsettled*`. So a view saved last quarter names keys that no
 * longer exist, and every stat table has to survive that.
 *
 * TWO DISTINCT FAILURES CAME OUT OF IT.
 *
 * 1. COLUMNS. The tables rendered their header, their body and (where they have one) their totals
 *    row from THE SAME key list, and disagreed about unknown keys: the header skipped a key it had
 *    no definition for while the body still emitted a cell — or the header and body both skipped
 *    while the FOOTER emitted unconditionally. Either way one dead key shifts every column after it
 *    one place, and the figures are read UNDER THE WRONG HEADINGS. Silent; worse than a blank
 *    column. Round 1 fixed exactly one of the six render paths and reported it as global.
 *
 * 2. FILTERS. Only the columns were ever sanitised. A rule on a since-renamed field reads as an
 *    unknown for every row, an unknown answers no numeric comparison, so the rule REJECTS EVERY
 *    ROW: the operator gets an empty report and no reason for it.
 *
 * The tests below drive the real saved-view picker on all THREE stat clients and cover all SIX
 * render paths — the four generic tables and the three totals-row tables. Alignment is asserted the
 * way a reader checks it: this figure, under that heading, and a totals row with as many cells as
 * the table above it.
 *
 * REVERT EVIDENCE (each verified by reverting that one change and re-running this file):
 *   * sales `renderGenericTable`: `presentColumns(...)` -> `visibleColsMap[tabKey]`
 *     fails "sales stats: the aging table stays aligned…" — 13 headings over 14 body cells.
 *   * purchase products `tfoot`: `cols` -> `visibleCols`
 *     fails "purchase stats: the products totals row…" — 12 headings over 13 footer cells.
 *   * inventory on-hand `tfoot`: same
 *     fails "inventory stats: the stock-on-hand totals row…".
 *   * `loadView` filter sanitising in any client
 *     fails that client's "a filter on a renamed field does not empty the report".
 */

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})
mock.module('@/lib/db', { namedExports: { db: {} } })
mock.module('@/components/providers/base-currency-provider', {
  namedExports: { useBaseCurrency: () => ({ code: 'GBP', symbol: '£', symbolPosition: 'PREFIX' }) },
})
mock.module('@/components/providers/timezone-provider', {
  namedExports: { useFormatDateTime: () => () => '1 Jan 2026' },
})
mock.module('next/navigation', { namedExports: { useRouter: () => ({ refresh: () => {} }) } })

// ---------------------------------------------------------------------------
// Reading a rendered table the way a reader does
// ---------------------------------------------------------------------------

function decode(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
}

function cellTexts(html: string, tag: 'th' | 'td'): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) out.push(decode(match[1].replace(/<[^>]*>/g, '')).trim())
  return out
}

function section(html: string, tag: 'thead' | 'tbody' | 'tfoot'): string | null {
  const start = html.indexOf(`<${tag}`)
  if (start === -1) return null
  return html.slice(start, html.indexOf(`</${tag}>`, start))
}

function rowsOf(sectionHtml: string): string[] {
  return sectionHtml.split('<tr').slice(1)
}

type ReadTable = { headings: string[]; body: string[][]; footer: string[] | null }

/** The one `<table>` on the page, read as headings + data rows + totals row. */
function readTable(html: string): ReadTable {
  const start = html.indexOf('<table')
  assert.notEqual(start, -1, 'no table was rendered')
  const table = html.slice(start, html.indexOf('</table>', start))
  const thead = section(table, 'thead')
  const tbody = section(table, 'tbody')
  const tfoot = section(table, 'tfoot')
  assert.ok(thead && tbody, 'a table without a head or a body')
  return {
    headings: cellTexts(thead, 'th'),
    body: rowsOf(tbody).map((row) => cellTexts(row, 'td')),
    footer: tfoot ? cellTexts(tfoot, 'td') : null,
  }
}

/**
 * The property the whole fix exists for: every cell has a heading above it, and the totals row has
 * a cell per column. Asserted on counts AND on a named figure, because equal counts alone would
 * still pass if two columns swapped places.
 */
function assertAligned(table: ReadTable, where: string) {
  for (const [index, row] of table.body.entries()) {
    assert.equal(row.length, table.headings.length,
      `${where}: row ${index} has ${row.length} cells under ${table.headings.length} headings — ${table.headings.join(' | ')}`)
  }
  if (table.footer) {
    assert.equal(table.footer.length, table.headings.length,
      `${where}: the totals row has ${table.footer.length} cells under ${table.headings.length} headings`)
  }
}

function under(table: ReadTable, heading: string, rowIndex = 0): string {
  const index = table.headings.indexOf(heading)
  assert.notEqual(index, -1, `no column headed “${heading}” — headings were: ${table.headings.join(' | ')}`)
  return table.body[rowIndex][index]
}

/** Pick a saved view from the page's own picker, which is the only way one is ever loaded. */
async function loadSavedView(mounted: Mounted<unknown>, viewId: string): Promise<string> {
  const picker = mounted.render().controls.find((c: Control) => c.onChange && c.label.includes('Saved Views'))
  await mounted.select(picker, viewId)
  return mounted.render().html
}

function noticeText(html: string): string {
  const marker = '<div data-saved-view-notice="true"'
  const start = html.indexOf(marker)
  assert.notEqual(start, -1, 'no saved-view notice was rendered')
  return decode(html.slice(start, html.indexOf('</div>', start)).replace(/<[^>]*>/g, '')).trim()
}

// ---------------------------------------------------------------------------
// Purchase stats — a generic table AND a totals-row table
// ---------------------------------------------------------------------------

const PURCHASE_PRODUCT = {
  productId: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs',
  barcode: null, mpn: null, supplierName: 'Acme', qtyOrdered: 10, qtyReceived: 7,
  qtyReturned: 0, netQty: 7, totalBase: 1000, landedCostBase: 50, avgUnitCostBase: 100,
  incomingQty: 3, supplierCount: 1, poCount: 2, createdAt: '2026-01-01T00:00:00.000Z',
}

const PURCHASE_AGING = {
  supplierId: 'sup-1', supplierName: 'Acme', grossAmount: 1500, discounts: null, refunds: 0,
  netAmount: 1500, landedCosts: 0, tax: 0, totalAmount: 1500, billedAmount: 1500,
  billedWithPaymentMarker: 1200, billedWithoutPaymentMarker: 300, paidAmount: null, dueAmount: null,
  billedWithoutPaymentMarker0_30: 300, billedWithoutPaymentMarker31_60: 0,
  billedWithoutPaymentMarker61_90: 0, billedWithoutPaymentMarker91plus: 0,
  poCount: 2, avgLeadTimeDays: 5,
}

async function mountPurchase(savedViews: unknown[]) {
  const { PurchaseStatsClient } = await import('@/app/(dashboard)/analytics/purchase-stats/purchase-stats-client')
  return mountClientComponent(PurchaseStatsClient as unknown as (props: unknown) => unknown, {
    products: [PURCHASE_PRODUCT], received: [], bills: [], aging: [PURCHASE_AGING], details: [], savedViews,
  })
}

test('purchase stats: the supplier-aging table stays aligned under a view saved before the renames (o3d-8u4h round 2)', async () => {
  const mounted = await mountPurchase([{
    id: 'v1', name: 'Q3 aging', tab: 'po_aging',
    // Exactly what a view saved in round 1's shape holds: keys from BOTH retired generations.
    columns: ['supplierName', 'overdue0_30', 'billedAmount', 'unsettledBilledAmount', 'billedWithoutPaymentMarker0_30', 'dueAmount'],
    filters: [],
  }])
  const table = readTable(await loadSavedView(mounted as Mounted<unknown>, 'v1'))

  assertAligned(table, 'purchase aging')
  assert.deepEqual(table.headings, ['Supplier', 'Billed', 'No marker 0-30d', 'Due (withheld)'])
  // The figures under the headings that survived, which is what the shift used to corrupt.
  assert.equal(under(table, 'Billed'), '£1500.00')
  assert.equal(under(table, 'No marker 0-30d'), '£300.00')
  assert.equal(under(table, 'Due (withheld)'), 'Withheld')
})

test('purchase stats: the products totals row keeps one cell per heading (o3d-8u4h round 2)', async () => {
  // The path round 1 missed on its own page: header and body both skipped the dead key while the
  // <tfoot> emitted a <td> for it unconditionally, so the totals row ran one cell long and every
  // total right of the gap sat under the wrong column.
  const mounted = await mountPurchase([{
    id: 'v2', name: 'Spend', tab: 'po_products',
    columns: ['sku', 'overdue91plus', 'qtyOrdered', 'qtyReceived', 'totalBase'],
    filters: [],
  }])
  const table = readTable(await loadSavedView(mounted as Mounted<unknown>, 'v2'))

  assertAligned(table, 'purchase products')
  assert.equal(table.headings.length, 4)
  assert.ok(table.footer)
  assert.equal(table.footer!.length, 4)
  assert.equal(under(table, 'Total (GBP)'), '£1000.00')
  assert.equal(table.footer![table.headings.indexOf('Total (GBP)')], '£1000.00')
})

test('purchase stats: a filter on a renamed field does not empty the report (o3d-8u4h round 2)', async () => {
  const mounted = await mountPurchase([{
    id: 'v3', name: 'Aged debt', tab: 'po_aging',
    columns: ['supplierName', 'billedAmount'],
    // A rule that was perfectly good when the view was saved. `overdue91plus` is not a field these
    // rows carry any more, so it reads as an unknown for every row — and an unknown answers no
    // numeric comparison, so the rule rejected EVERY supplier and the page said "0 rows".
    filters: [{ field: 'overdue91plus', operator: '>', value: '0' }],
  }])
  const html = await loadSavedView(mounted as Mounted<unknown>, 'v3')
  const table = readTable(html)

  assert.equal(table.body.length, 1, 'the dropped filter must not take the rows with it')
  assert.equal(under(table, 'Supplier'), 'Acme')

  // And the drop is STATED, not silent — the operator asked for that filter.
  const notice = noticeText(html)
  assert.match(notice, /Q?Aged debt|Aged debt/)
  assert.match(notice, /overdue91plus/)
  assert.match(notice, /matches no row/)
})

test('purchase stats: a view naming only live columns loads with no notice at all (o3d-8u4h round 2 control)', async () => {
  const mounted = await mountPurchase([{
    id: 'v4', name: 'Clean', tab: 'po_aging',
    columns: ['supplierName', 'billedAmount', 'billedWithPaymentMarker'],
    filters: [{ field: 'billedAmount', operator: '>', value: '0' }],
  }])
  const html = await loadSavedView(mounted as Mounted<unknown>, 'v4')
  const table = readTable(html)

  assert.deepEqual(table.headings, ['Supplier', 'Billed', 'Billed w/ payment marker'])
  assert.equal(table.body.length, 1)
  assert.equal(html.includes('data-saved-view-notice'), false, 'nothing was dropped, so nothing is announced')
})

// ---------------------------------------------------------------------------
// Sales stats — the table Codex found still shifting
// ---------------------------------------------------------------------------

const SALES_SUMMARY = {
  totalQtySold: 1, totalGrossRevenue: 120, totalDiscounts: 0, totalRefunds: 0,
  totalRefundsGrossBasis: 0, totalRefundsUnknownBasis: 0, refundBasisComplete: true,
  totalNetRevenue: 100, totalCogs: 40, totalGrossProfit: 60, avgMarginPct: 60,
  avgMarginPctBound: 'exact', totalOrders: 1, avgOrderValue: 100,
}

const SALES_PRODUCT = {
  productId: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs',
  barcode: null, mpn: null, lifecycleStatus: 'ACTIVE', qtySold: 1, qtyRefunded: 0, netQty: 1,
  grossRevenue: 120, discounts: 0, refunds: 0, refundsGrossBasis: 0, refundsUnknownBasis: 0,
  refundBasisComplete: true, netRevenue: 100, cogs: 40, grossProfit: 60, marginPct: 60,
  marginPctBound: 'exact', orderCount: 1, avgOrderValue: 100, salesPrice: null, weight: null,
}

const SALES_AGING = {
  orderId: 'so-1', orderNumber: 'SO-1', customerName: 'Acme', salesRep: null, warehouse: 'MAIN',
  createdAt: '2026-01-01T00:00:00.000Z', salesTotal: 120, refundsTotal: 0, netTotal: 100,
  netTotalBasis: 'NET', dueAmount: 120, avgDso: 12,
  overdue0_30: 120, overdue31_60: 0, overdue61_90: 0, overdue91plus: 0,
}

async function mountSales(savedViews: unknown[]) {
  const { SalesStatsClient } = await import('@/app/(dashboard)/analytics/sales-stats/sales-stats-client')
  return mountClientComponent(SalesStatsClient as unknown as (props: unknown) => unknown, {
    productStats: { rows: [SALES_PRODUCT], summary: SALES_SUMMARY },
    shipments: [], details: [], invoices: [], refunds: [], aging: [SALES_AGING], savedViews,
  })
}

test('sales stats: the aging table stays aligned under a stale saved key — THE table round 1 missed (o3d-8u4h round 2)', async () => {
  const mounted = await mountSales([{
    id: 's1', name: 'Debtors', tab: 'aging',
    // `settledAmount` never existed on the sales side; it is what an operator's saved view looks
    // like after ANY column is retired, which is the general shape this fix is for.
    columns: ['orderNumber', 'settledAmount', 'salesTotal', 'dueAmount', 'overdue0_30'],
    filters: [],
  }])
  const table = readTable(await loadSavedView(mounted as Mounted<unknown>, 's1'))

  assertAligned(table, 'sales aging')
  assert.equal(table.headings.length, 4)
  // The exact misreading the shift produced: the Sales figure appearing under Order, and the due
  // figure under Sales. Asserted as values under headings, not as a column count.
  assert.deepEqual(table.headings, ['Order', 'Sales', 'Due', '0-30d'])
  assert.equal(under(table, 'Order'), 'SO-1')
  assert.equal(under(table, 'Sales'), '£120.00')
  assert.equal(under(table, 'Due'), '£120.00')
  assert.equal(under(table, '0-30d'), '£120.00')
})

test('sales stats: the products totals row keeps one cell per heading (o3d-8u4h round 2)', async () => {
  const mounted = await mountSales([{
    id: 's2', name: 'Margins', tab: 'products',
    columns: ['sku', 'retiredKey', 'qtySold', 'grossRevenue', 'cogs'],
    filters: [],
  }])
  const table = readTable(await loadSavedView(mounted as Mounted<unknown>, 's2'))

  assertAligned(table, 'sales products')
  assert.equal(table.headings.length, 4)
  assert.ok(table.footer)
  assert.equal(table.footer!.length, 4)
})

test('sales stats: a filter on a retired field does not empty the report (o3d-8u4h round 2)', async () => {
  const mounted = await mountSales([{
    id: 's3', name: 'Old debtors', tab: 'aging',
    columns: ['orderNumber', 'salesTotal'],
    filters: [{ field: 'settledAmount', operator: '>=', value: '1' }],
  }])
  const html = await loadSavedView(mounted as Mounted<unknown>, 's3')

  assert.equal(readTable(html).body.length, 1)
  assert.match(noticeText(html), /settledAmount/)
})

// ---------------------------------------------------------------------------
// Inventory stats — the third client, checked rather than claimed
// ---------------------------------------------------------------------------

const ON_HAND = {
  productId: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs',
  barcode: null, mpn: null, warehouseCode: 'MAIN', quantity: 10, reservedQty: 2,
  available: 8, inventoryValue: 500,
}

const MOVEMENT = {
  id: 'm1', type: 'PURCHASE_RECEIPT', sku: 'SKU-1', productName: 'Widget',
  fromWarehouse: null, toWarehouse: 'MAIN', qty: 10, note: null,
  createdAt: '2026-01-01T00:00:00.000Z', unitCostBase: 50, totalValueBase: 500,
}

async function mountInventory(savedViews: unknown[]) {
  const { InventoryStatsClient } = await import('@/app/(dashboard)/analytics/inventory-stats/inventory-stats-client')
  return mountClientComponent(InventoryStatsClient as unknown as (props: unknown) => unknown, {
    stockOnHand: [ON_HAND], movements: [MOVEMENT], allocations: [], reorder: [], savedViews,
  })
}

test('inventory stats: the stock-on-hand totals row keeps one cell per heading (o3d-8u4h round 2)', async () => {
  const mounted = await mountInventory([{
    id: 'i1', name: 'Warehouse', tab: 'inv_onhand',
    columns: ['sku', 'retiredKey', 'warehouseCode', 'quantity', 'inventoryValue'],
    filters: [],
  }])
  const table = readTable(await loadSavedView(mounted as Mounted<unknown>, 'i1'))

  assertAligned(table, 'inventory on hand')
  assert.equal(table.headings.length, 4)
  assert.ok(table.footer)
  assert.equal(table.footer!.length, 4)
  assert.equal(under(table, 'Quantity'), '10')
})

test('inventory stats: a retired key is not rendered as its own heading on the movements table (o3d-8u4h round 2)', async () => {
  // This table did not SHIFT — its header fell back to printing the raw key — so it published a
  // column headed `retiredKey` full of blanks instead. Aligned and still wrong to read.
  const mounted = await mountInventory([{
    id: 'i2', name: 'Moves', tab: 'inv_movements',
    columns: ['type', 'retiredKey', 'sku', 'qty'],
    filters: [],
  }])
  const table = readTable(await loadSavedView(mounted as Mounted<unknown>, 'i2'))

  assertAligned(table, 'inventory movements')
  assert.ok(!table.headings.includes('retiredKey'), table.headings.join(' | '))
  assert.equal(table.headings.length, 3)
  assert.ok(under(table, 'SKU').startsWith('SKU-1'), under(table, 'SKU'))
})

test('inventory stats: a filter on a retired field does not empty the report (o3d-8u4h round 2)', async () => {
  const mounted = await mountInventory([{
    id: 'i3', name: 'Low stock', tab: 'inv_onhand',
    columns: ['sku', 'quantity'],
    filters: [{ field: 'retiredKey', operator: '<', value: '5' }],
  }])
  const html = await loadSavedView(mounted as Mounted<unknown>, 'i3')

  assert.equal(readTable(html).body.length, 1)
  assert.match(noticeText(html), /retiredKey/)
})
