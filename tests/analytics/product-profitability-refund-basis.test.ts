import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-iigc: the FY profitability report built `revenue` from ex-VAT line totals and then did
 * `agg.revenue -= Number(rl.totalBase)` for every refund line, whatever basis the parent refund was
 * stamped with. The previous FY is far likelier to hold GROSS-basis credits than the current one, so
 * the defect landed hardest on exactly the column pair the report exists to compare.
 *
 * Worked example: a £120 taxable order at 20% — £100 net + £20 VAT — credited in full by a legacy
 * GROSS refund. The old arithmetic reported that product's FY revenue as MINUS £20.
 */

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})

const NOW = new Date()
// The org FY below starts 1 January, so the current FY is this calendar year and the previous FY is
// the one before it, whatever month the suite runs in. The two FY queries differ only in their
// createdAt.gte, so that is what the fixture db dispatches on.
const CURRENT_FY_YEAR = NOW.getFullYear()

type RefundFixture = { totalsBasis: string | null; lines: { productId: string; qty: number; totalBase: number }[] }
type OrderFixture = {
  lines: { productId: string; qty: number; totalBase: number; cogsBase: number }[]
  refunds: RefundFixture[]
}

function order(o: OrderFixture) {
  return {
    // Ex-VAT contract, no discounts, no FX — the refund basis is the only variable.
    fxRateToBase: 1, discountAmount: 0, pricesIncludeVat: false, taxRatePercent: 20,
    shoppingLinks: [],
    lines: o.lines.map((l) => ({ ...l, discountAmount: 0, taxRate: { rate: 0.2 } })),
    refunds: o.refunds,
  }
}

let CURRENT_FY_ORDERS: ReturnType<typeof order>[] = []
let PREVIOUS_FY_ORDERS: ReturnType<typeof order>[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      organisation: {
        findFirst: async () => ({ financialYearStartMonth: 1, financialYearStartDay: 1 }),
      },
      product: {
        findMany: async () => [
          { id: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', lifecycleStatus: 'ACTIVE', salesPriceBase: null, salePriceBase: null, stockLevels: [] },
          { id: 'p2', sku: 'SKU-2', name: 'Gadget', type: 'SIMPLE', lifecycleStatus: 'ACTIVE', salesPriceBase: null, salePriceBase: null, stockLevels: [] },
        ],
      },
      costLayer: { findMany: async () => [] },
      salesOrder: {
        findMany: async (args: { where: { createdAt: { gte: Date } } }) =>
          (args.where.createdAt.gte.getFullYear() === CURRENT_FY_YEAR ? CURRENT_FY_ORDERS : PREVIOUS_FY_ORDERS),
      },
    },
  },
})

async function rowsBySku() {
  const { getProductProfitability } = await import('@/app/actions/product-profitability')
  const { rows, summary } = await getProductProfitability()
  return { bySku: new Map(rows.map((r) => [r.sku, r])), summary }
}

test('a legacy GROSS credit is NOT subtracted from ex-VAT FY revenue — £100, not -£20 (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 }],
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(r.currentFyRevenue, 100, 'the VAT-inclusive credit is not the same unit as this figure')
  assert.equal(r.currentFyRefundsGrossBasis, 120, 'it is reported beside the revenue, not discarded')
  assert.equal(r.currentFyRefundsUnknownBasis, 0)
  assert.equal(r.currentFyRefundBasisComplete, false, 'revenue is an upper bound and says so')
  assert.equal(r.currentFyProfit, 60, 'old arithmetic gave -60 here (-20 revenue less £40 COGS)')
  // Quantity is basis-independent — the unit came back whatever the credit was stamped with.
  assert.equal(r.currentFyQtySold, 0)
})

test('the previous-FY column is fixed on the same terms, so the FY comparison is like-for-like (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 2, totalBase: 200, cogsBase: 80 }],
    refunds: [{ totalsBasis: 'NET', lines: [{ productId: 'p1', qty: 1, totalBase: 100 }] }],
  })]
  PREVIOUS_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 2, totalBase: 200, cogsBase: 80 }],
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] }],
  })]
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(r.currentFyRevenue, 100, 'modern NET credit, subtracted as before')
  assert.equal(r.currentFyRefundBasisComplete, true)
  assert.equal(r.previousFyRevenue, 200, 'old arithmetic gave 80, understating the prior FY by the VAT')
  assert.equal(r.previousFyRefundsGrossBasis, 120)
  assert.equal(r.previousFyRefundBasisComplete, false)
  assert.equal(r.previousFyProfit, 120, 'old arithmetic gave 0')
})

test('a SUB-PENNY unstamped credit still makes the row an upper bound (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 50, cogsBase: 0 }],
    refunds: [{ totalsBasis: null, lines: [{ productId: 'p1', qty: 0, totalBase: 0.004 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(r.currentFyRefundBasisComplete, false, 'dust is still value')
  assert.equal(r.currentFyRefundsUnknownBasis, 0, 'the amount rounds away, but the FLAG does not')
  assert.equal(r.currentFyRevenue, 50)
})

test('an EXACTLY-zero unstamped credit leaves the row exact (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 50, cogsBase: 0 }],
    refunds: [{ totalsBasis: null, lines: [{ productId: 'p1', qty: 0, totalBase: 0 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  // Zero is identical on both bases, so it carries no basis information.
  assert.equal(r.currentFyRefundBasisComplete, true)
  assert.equal(r.currentFyRevenue, 50)
})

test('the summary is complete only when EVERY row is, and totals the unplaceable value (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [
      { productId: 'p1', qty: 1, totalBase: 100, cogsBase: 0 },
      { productId: 'p2', qty: 1, totalBase: 60, cogsBase: 0 },
    ],
    refunds: [
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] },
      { totalsBasis: 'NET', lines: [{ productId: 'p2', qty: 0, totalBase: 10 }] },
    ],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku, summary } = await rowsBySku()

  assert.equal(bySku.get('SKU-2')!.currentFyRefundBasisComplete, true, 'a clean row stays clean')
  assert.equal(bySku.get('SKU-2')!.currentFyRevenue, 50)
  assert.equal(summary.currentFyRefundBasisComplete, false, 'one dirty row taints the total')
  assert.equal(summary.currentFyRefundsGrossBasis, 120)
  assert.equal(summary.currentFyRefundsUnknownBasis, 0)
  // 100 + 50. The old total was (100 - 120) + 50 = 30.
  assert.equal(summary.currentFyRevenue, 150)
})

test('a product with no sales at all is not reported as an upper bound (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = []
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-2')!

  // There is nothing it failed to subtract, so nothing to warn about.
  assert.equal(r.currentFyRefundBasisComplete, true)
  assert.equal(r.previousFyRefundBasisComplete, true)
  assert.equal(r.currentFyRevenue, 0)
})
