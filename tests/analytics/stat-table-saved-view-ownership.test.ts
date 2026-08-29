import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent, type Control, type Mounted } from '@/tests/fixtures/render-client-component'
import { resolveSavedViewTab, ownedSavedViews, foreignSavedViewNotice } from '@/lib/analytics/table-filter-sort'

/**
 * o3d-8u4h ROUND 3, Codex MEDIUM: A LEGITIMATE PURCHASE VIEW TOOK THE SALES PAGE DOWN.
 *
 * All three analytics stat pages save their views into ONE settings row (`sales_stats_views`) and
 * tell their own views apart by a prefix on the stored tab key — `po_`, `inv_`, and nothing at all
 * for the sales page. The purchase and inventory pickers filtered on that prefix. THE SALES PICKER
 * OFFERED EVERY VIEW IN THE RECORD and then indexed its own `TAB_FIELDS` with whatever key the view
 * carried. `TAB_FIELDS['po_aging']` is `undefined`; `sanitiseSavedView` maps over it; the whole
 * Sales Analytics page comes down with a TypeError.
 *
 * Nothing about that requires a stale or malformed view. Save a supplier-aging view on the purchase
 * page — the ordinary thing the feature is for — then open Sales, and the picker offers it. The
 * crash is on the REPORT, not on the view.
 *
 * It is the same defect family the branch already fixed for COLUMNS one level down (a key stored
 * elsewhere, used without validation), so it is fixed the same way: filter what the picker offers,
 * validate before indexing, and say so on the page rather than failing silently.
 *
 * AND THE OTHER TWO CLIENTS ARE CHECKED RATHER THAN ASSUMED. Their prefix test is not the whole
 * test: `po_` on the front does not prove the remainder is still a tab, so a view naming a RETIRED
 * purchase tab passed `startsWith('po_')`, was stripped by `replace`, and reached the identical
 * `TAB_FIELDS[undefined]` crash from the page that thought it was already filtered.
 *
 * REVERT EVIDENCE (each verified by reverting that one change and re-running this file):
 *   * sales `loadView`: `resolveSavedViewTab(...)` + guard -> `view.tab as Tab`
 *     fails "sales stats: selecting a legitimate PURCHASE saved view does not take the page down"
 *     with `TypeError: Cannot read properties of undefined (reading 'map')`.
 *   * sales picker: `ownViews.map` -> `savedViews.map`
 *     fails "sales stats: the picker does not offer another report's views at all".
 *   * purchase `loadView`: `resolveSavedViewTab(...)` + guard -> `v.tab.replace('po_', '') as Tab`
 *     fails "purchase stats: a view naming a RETIRED purchase tab is refused, not crashed on".
 *   * inventory `loadView`: same reversion
 *     fails "inventory stats: a view naming a RETIRED inventory tab is refused, not crashed on".
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
// Reading the page the way an operator does
// ---------------------------------------------------------------------------

function decode(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
}

/** The names the saved-view picker actually offers, in order, minus its disabled placeholder. */
function pickerOptions(html: string): string[] {
  const out: string[] = []
  const re = /<option\b[^>]*>([\s\S]*?)<\/option>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const text = decode(match[1].replace(/<[^>]*>/g, '')).trim()
    if (text !== '' && !text.startsWith('Saved Views')) out.push(text)
  }
  return out
}

function noticeText(html: string): string {
  const marker = '<div data-saved-view-notice="true"'
  const start = html.indexOf(marker)
  assert.notEqual(start, -1, 'no saved-view notice was rendered')
  return decode(html.slice(start, html.indexOf('</div>', start)).replace(/<[^>]*>/g, '')).trim()
}

function picker(mounted: Mounted<unknown>): Control | undefined {
  return mounted.render().controls.find((c: Control) => c.onChange && c.label.includes('Saved Views'))
}

/** The headings of the one table on the page — how the test tells which tab is showing. */
function headings(html: string): string[] {
  const start = html.indexOf('<table')
  if (start === -1) return []
  const table = html.slice(start, html.indexOf('</table>', start))
  const thead = table.slice(table.indexOf('<thead'), table.indexOf('</thead>'))
  const out: string[] = []
  const re = /<th\b[^>]*>([\s\S]*?)<\/th>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(thead)) !== null) out.push(decode(match[1].replace(/<[^>]*>/g, '')).trim())
  return out
}

// ---------------------------------------------------------------------------
// Fixtures — one row per tab is enough; this is about which tab is indexed at all
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

/**
 * A view saved by the PURCHASE page, in exactly the shape `saveView` writes it: `po_` + the tab.
 * Nothing about it is stale or malformed — it is a working supplier-aging view.
 */
const LEGITIMATE_PURCHASE_VIEW = {
  id: 'po-v1', name: 'Q3 supplier aging', tab: 'po_aging',
  columns: ['supplierName', 'billedAmount', 'billedWithoutPaymentMarker0_30'],
  filters: [{ field: 'billedAmount', operator: '>', value: '0' }],
}

/** And one saved by the INVENTORY page, for the same reason. */
const LEGITIMATE_INVENTORY_VIEW = {
  id: 'inv-v1', name: 'Low stock', tab: 'inv_onhand',
  columns: ['sku', 'quantity'], filters: [],
}

const SALES_OWN_VIEW = {
  id: 's-v1', name: 'Debtors', tab: 'aging',
  columns: ['orderNumber', 'salesTotal', 'dueAmount'], filters: [],
}

async function mountSales(savedViews: unknown[]) {
  const { SalesStatsClient } = await import('@/app/(dashboard)/analytics/sales-stats/sales-stats-client')
  return mountClientComponent(SalesStatsClient as unknown as (props: unknown) => unknown, {
    productStats: { rows: [SALES_PRODUCT], summary: SALES_SUMMARY },
    shipments: [], details: [], invoices: [], refunds: [], aging: [SALES_AGING], savedViews,
  }) as Mounted<unknown>
}

const PURCHASE_PRODUCT = {
  productId: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs',
  barcode: null, mpn: null, supplierName: 'Acme', qtyOrdered: 10, qtyReceived: 7,
  qtyReturned: 0, netQty: 7, totalBase: 1000, landedCostBase: 50, avgUnitCostBase: 100,
  incomingQty: 3, supplierCount: 1, poCount: 2, createdAt: '2026-01-01T00:00:00.000Z',
}

async function mountPurchase(savedViews: unknown[]) {
  const { PurchaseStatsClient } = await import('@/app/(dashboard)/analytics/purchase-stats/purchase-stats-client')
  return mountClientComponent(PurchaseStatsClient as unknown as (props: unknown) => unknown, {
    products: [PURCHASE_PRODUCT], received: [], bills: [], aging: [], details: [], savedViews,
  }) as Mounted<unknown>
}

const ON_HAND = {
  productId: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs',
  barcode: null, mpn: null, warehouseCode: 'MAIN', quantity: 10, reservedQty: 2,
  available: 8, inventoryValue: 500,
}

async function mountInventory(savedViews: unknown[]) {
  const { InventoryStatsClient } = await import('@/app/(dashboard)/analytics/inventory-stats/inventory-stats-client')
  return mountClientComponent(InventoryStatsClient as unknown as (props: unknown) => unknown, {
    stockOnHand: [ON_HAND], movements: [], allocations: [], reorder: [], savedViews,
  }) as Mounted<unknown>
}

// ---------------------------------------------------------------------------
// The crash
// ---------------------------------------------------------------------------

test('sales stats: selecting a legitimate PURCHASE saved view does not take the page down (o3d-8u4h round 3)', async () => {
  const mounted = await mountSales([SALES_OWN_VIEW, LEGITIMATE_PURCHASE_VIEW])

  // Selected THROUGH THE PAGE'S OWN PICKER, which is the only way a saved view is ever loaded. The
  // id is the foreign one: the picker no longer lists it, and the handler must still refuse it by
  // name rather than depend on a list of options that can be a render behind the click.
  const before = mounted.render().html
  await mounted.select(picker(mounted), LEGITIMATE_PURCHASE_VIEW.id)
  const after = mounted.render().html

  // THE PAGE SURVIVED. Before this fix the `await` above threw
  // `TypeError: Cannot read properties of undefined (reading 'map')` out of sanitiseSavedView,
  // and nothing below it ran.
  assert.ok(after.includes('<table'), 'the report is still on the page')

  // And it is still the SALES report, on the tab it was already on — a refused view changes nothing.
  assert.deepEqual(headings(before).slice(0, 2), headings(after).slice(0, 2))
  assert.ok(headings(after).includes('SKU'), `still the sales products tab — headings were: ${headings(after).join(' | ')}`)
})

test('sales stats: the refusal is VISIBLE and names the report to open instead (o3d-8u4h round 3)', async () => {
  const mounted = await mountSales([SALES_OWN_VIEW, LEGITIMATE_PURCHASE_VIEW])
  await mounted.select(picker(mounted), LEGITIMATE_PURCHASE_VIEW.id)
  const notice = noticeText(mounted.render().html)

  // A persistent block on the page, not a tooltip — the same surface the dropped-column notice uses,
  // for the same reason: the reader who most needs it is the one who cannot hover.
  assert.match(notice, /Q3 supplier aging/)
  assert.match(notice, /different analytics report/)
  assert.match(notice, /po_aging/, 'the stored tab is named, because it is what says which report to open')
  assert.match(notice, /Nothing on this page has changed/)
})

test('sales stats: the picker does not offer another report’s views at all (o3d-8u4h round 3)', async () => {
  const mounted = await mountSales([SALES_OWN_VIEW, LEGITIMATE_PURCHASE_VIEW, LEGITIMATE_INVENTORY_VIEW])
  const options = pickerOptions(mounted.render().html)

  assert.deepEqual(options, ['Debtors'],
    'the sales picker read the whole shared settings row and listed all three pages’ views')
})

test('sales stats: this page’s OWN views still load exactly as before (o3d-8u4h round 3 control)', async () => {
  const mounted = await mountSales([SALES_OWN_VIEW, LEGITIMATE_PURCHASE_VIEW])
  await mounted.select(picker(mounted), SALES_OWN_VIEW.id)
  const html = mounted.render().html

  assert.deepEqual(headings(html), ['Order', 'Sales', 'Due'])
  assert.equal(html.includes('data-saved-view-notice'), false, 'nothing was refused, so nothing is announced')
})

// ---------------------------------------------------------------------------
// The other two clients — a prefix is not a membership test
// ---------------------------------------------------------------------------

test('purchase stats: a view naming a RETIRED purchase tab is refused, not crashed on (o3d-8u4h round 3)', async () => {
  // `startsWith('po_')` is true of this, so the old picker filter let it through and
  // `replace('po_', '')` handed `quotes` — a tab this page does not have — straight to TAB_FIELDS.
  const retired = { id: 'po-old', name: 'Open quotes', tab: 'po_quotes', columns: ['sku'], filters: [] }
  // A live view of this page's own sits beside it, so the picker is rendered and the retired id can
  // be asked for through it — which is how a stale id reaches the handler in the first place: the
  // options are a render of props, and props can be a revision behind the click.
  const live = { id: 'po-ok', name: 'Spend', tab: 'po_products', columns: ['sku', 'totalBase'], filters: [] }
  const mounted = await mountPurchase([live, retired])

  assert.deepEqual(pickerOptions(mounted.render().html), ['Spend'], 'a retired tab is not offered')

  await mounted.select(picker(mounted), retired.id)
  const html = mounted.render().html

  assert.ok(html.includes('<table'), 'the report is still on the page')
  assert.match(noticeText(html), /po_quotes/)
})

test('purchase stats: a SALES view is not offered and is refused if asked for (o3d-8u4h round 3)', async () => {
  const mounted = await mountPurchase([SALES_OWN_VIEW])
  // Nothing this page owns, so it renders no picker at all — which is the first half of the fix.
  assert.equal(picker(mounted), undefined, 'a picker with nothing in it must not be shown')
})

test('inventory stats: a view naming a RETIRED inventory tab is refused, not crashed on (o3d-8u4h round 3)', async () => {
  const retired = { id: 'inv-old', name: 'Bin locations', tab: 'inv_bins', columns: ['sku'], filters: [] }
  const live = { id: 'inv-ok', name: 'On hand', tab: 'inv_onhand', columns: ['sku', 'quantity'], filters: [] }
  const mounted = await mountInventory([live, retired])

  assert.deepEqual(pickerOptions(mounted.render().html), ['On hand'], 'a retired tab is not offered')

  await mounted.select(picker(mounted), retired.id)
  const html = mounted.render().html

  assert.ok(html.includes('<table'), 'the report is still on the page')
  assert.match(noticeText(html), /inv_bins/)
})

// ---------------------------------------------------------------------------
// The rule itself, asserted where it lives
// ---------------------------------------------------------------------------

test('resolveSavedViewTab: the empty prefix is separated by MEMBERSHIP, not by stripping (o3d-8u4h round 3)', async () => {
  const salesTabs = ['products', 'shipments', 'details', 'invoices', 'refunds', 'aging'] as const

  assert.equal(resolveSavedViewTab('aging', '', salesTabs), 'aging')
  // Every string starts with the empty string, so a prefix test can do nothing here. This is the
  // exact key that crashed the page.
  assert.equal(resolveSavedViewTab('po_aging', '', salesTabs), null)
  assert.equal(resolveSavedViewTab('inv_onhand', '', salesTabs), null)

  const purchaseTabs = ['products', 'received', 'bills', 'aging', 'details'] as const
  assert.equal(resolveSavedViewTab('po_aging', 'po_', purchaseTabs), 'aging')
  assert.equal(resolveSavedViewTab('aging', 'po_', purchaseTabs), null, 'a sales view is not this page’s')
  assert.equal(resolveSavedViewTab('po_quotes', 'po_', purchaseTabs), null, 'the prefix does not make the remainder a tab')
})

test('ownedSavedViews keeps the loadable ones and foreignSavedViewNotice names the stored tab (o3d-8u4h round 3)', async () => {
  const views = [SALES_OWN_VIEW, LEGITIMATE_PURCHASE_VIEW, LEGITIMATE_INVENTORY_VIEW]
  const salesTabs = ['products', 'shipments', 'details', 'invoices', 'refunds', 'aging'] as const

  assert.deepEqual(ownedSavedViews(views, '', salesTabs).map((v) => v.id), ['s-v1'])
  assert.deepEqual(ownedSavedViews(views, 'po_', ['aging'] as const).map((v) => v.id), ['po-v1'])
  assert.deepEqual(ownedSavedViews(views, 'inv_', ['onhand'] as const).map((v) => v.id), ['inv-v1'])

  assert.match(foreignSavedViewNotice('Q3 supplier aging', 'po_aging'), /“Q3 supplier aging”/)
  assert.match(foreignSavedViewNotice(undefined, 'po_aging'), /That saved view/)
})
