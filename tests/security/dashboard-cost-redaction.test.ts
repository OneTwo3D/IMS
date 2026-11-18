import assert from 'node:assert/strict'
import test from 'node:test'

import { canViewDashboardCostFigures, redactDashboardCostFigures } from '../../lib/security/dashboard-cost-redaction.ts'

test('only Admin, Manager and Finance may see dashboard cost figures', () => {
  for (const role of ['ADMIN', 'MANAGER', 'FINANCE']) assert.equal(canViewDashboardCostFigures(role), true, role)
  for (const role of ['READONLY', 'WAREHOUSE', 'SUPPLIER', '', null, undefined]) assert.equal(canViewDashboardCostFigures(role), false, String(role))
})

test('redaction zeroes COGS, profit, margin and inventory value and keeps sales figures', () => {
  const out = redactDashboardCostFigures({
    kpi: { marginBoundCurrent: 'upper', marginBoundComparison: 'upper', cogsCurrent: 5, profitCurrent: 7, marginCurrent: 58, cogsComparison: 4, marginComparison: 40, inventoryValue: 900, netSalesCurrent: 12 },
    chartData: [{ marginPctBound: 'upper', compMarginPctBound: 'upper', cogs: 5, marginPct: 58, compCogs: 4, compMarginPct: 40, netSales: 12 }],
    topProducts: [{ productId: 'p', marginPct: 58, marginPctBound: 'upper', netRevenue: 12, totalCogs: 5 }],
  })
  assert.deepEqual(out.kpi, { marginBoundCurrent: 'exact', marginBoundComparison: 'exact', cogsCurrent: 0, profitCurrent: 0, marginCurrent: 0, cogsComparison: 0, marginComparison: 0, inventoryValue: 0, netSalesCurrent: 12 })
  assert.deepEqual(out.chartData, [{ marginPctBound: 'exact', compMarginPctBound: 'exact', cogs: 0, marginPct: 0, compCogs: 0, compMarginPct: 0, netSales: 12 }])
  assert.equal(out.topProducts[0].marginPct, 0)
  assert.equal(out.topProducts[0].netRevenue, 12)
  assert.ok(!('totalCogs' in out.topProducts[0]), 'working cost field is dropped by the allowlist')
})
