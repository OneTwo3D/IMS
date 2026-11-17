import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReorderDemandChart } from '@/lib/domain/inventory/reorder-demand-chart'

const events: string[] = []
let gateAllows = true
let loaderArgs: unknown = null
let chartResult: ReorderDemandChart | null = null

mock.module('@/lib/security/replenishment-report-page-access', {
  namedExports: {
    requireReplenishmentReportAccess: async () => {
      events.push('gate')
      if (!gateAllows) throw new Error('NEXT_REDIRECT:/dashboard')
      return { user: { role: 'ADMIN' } }
    },
  },
})
mock.module('@/lib/domain/inventory/reorder-demand-chart', {
  namedExports: {
    getReorderDemandChart: async (args: unknown) => {
      events.push('loader')
      loaderArgs = args
      return chartResult
    },
  },
})
mock.module('next/navigation', {
  namedExports: { notFound: () => { throw new Error('NEXT_NOT_FOUND') }, redirect: () => { throw new Error('NEXT_REDIRECT') } },
})

function chart(overrides: Partial<ReorderDemandChart> = {}): ReorderDemandChart {
  return {
    productId: 'p1', sku: 'SKU-1', productName: 'Widget', stockUnit: 'pcs', warehouseId: null, warehouseName: null,
    generatedAt: '2027-01-06T10:00:00.000Z', today: '2027-01-06',
    weeks: [{ weekStart: '2027-01-04', kind: 'history', isCurrentWeek: true, actualDemandQty: 4, projectedDemandQty: null, stockPositionQty: 10, inboundQty: 0, requiredReceiptQty: null, isFirstShortageWeek: false, historicalStockQty: null, stockoutDays: 0, inStockDays: 0, unknownDays: 7, stockState: 'unknown' }],
    historyWeeks: 1, forecastWeeks: 12, historyFrom: '2026-12-24', historyTo: '2027-01-06',
    requiredReceiptDate: null, latestPoDate: null, latestPoOverdue: false, firstShortageDate: null, firstShortageWeekStart: null, latestPoWeekStart: null,
    safetyStockQty: 3, reorderPoint: 14, suggestedReorderQty: 0, averageDailyDemand: 1.5, leadTimeDays: 7, openingQty: 20,
    hasHistory: true, ignoreStockouts: false,
    stockout: { firstCoveredDate: null, coveredDays: 0, unknownDays: 14, stockoutDays: 0, demandWindowStockoutDays: 0, demandWindowDays: 90, clamped: false },
    notices: [], ...overrides,
  }
}

type Element = { props: Record<string, unknown> }

function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const element = node as Element
  return textOf(element.props?.children)
}

test('route reads its filters and windows from searchParams, and the product from params', async () => {
  events.length = 0
  gateAllows = true
  chartResult = chart()
  const { default: Page } = await import('@/app/(dashboard)/analytics/reorder/[productId]/page')
  await Page({
    params: Promise.resolve({ productId: 'p1' }),
    searchParams: Promise.resolve({ warehouseId: 'wh-1', categoryId: 'c1', supplierId: 's1', thresholdDays: '30', targetCoverWeeks: '6', historyWeeks: '8', forecastWeeks: ['20', '30'], abcClass: 'A', search: 'x' }),
  })
  assert.deepEqual(events, ['gate', 'loader'])
  assert.deepEqual(loaderArgs, {
    productId: 'p1',
    filters: { warehouseId: 'wh-1', categoryId: 'c1', supplierId: 's1', productType: undefined, thresholdDays: 30, targetCoverWeeks: 6 },
    historyWeeks: 8,
    forecastWeeks: 20,
  })
})

test('route ignores malformed numeric params', async () => {
  chartResult = chart()
  const { default: Page } = await import('@/app/(dashboard)/analytics/reorder/[productId]/page')
  await Page({ params: Promise.resolve({ productId: 'p1' }), searchParams: Promise.resolve({ thresholdDays: 'abc', historyWeeks: '-3', forecastWeeks: '1.5' }) })
  const args = loaderArgs as { filters: { thresholdDays?: number }; historyWeeks?: number; forecastWeeks?: number }
  assert.equal(args.filters.thresholdDays, undefined)
  assert.equal(args.historyWeeks, undefined)
  assert.equal(args.forecastWeeks, undefined)
})

test('route stops at the access gate before loading any data', async () => {
  events.length = 0
  gateAllows = false
  const { default: Page } = await import('@/app/(dashboard)/analytics/reorder/[productId]/page')
  await assert.rejects(Page({ params: Promise.resolve({ productId: 'p1' }), searchParams: Promise.resolve({}) }), /NEXT_REDIRECT/)
  assert.deepEqual(events, ['gate'])
  gateAllows = true
})

test('route shows a message, not a blank panel, when there is no sales history, and 404s an unknown product', async () => {
  const { default: Page } = await import('@/app/(dashboard)/analytics/reorder/[productId]/page')
  chartResult = chart({ hasHistory: false })
  const element = await Page({ params: Promise.resolve({ productId: 'p1' }), searchParams: Promise.resolve({}) })
  assert.match(textOf(element), /No sales history for SKU-1 in the selected window/)
  chartResult = null
  await assert.rejects(Page({ params: Promise.resolve({ productId: 'nope' }), searchParams: Promise.resolve({}) }), /NEXT_NOT_FOUND/)
})
