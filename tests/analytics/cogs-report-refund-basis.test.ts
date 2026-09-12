import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { parseCsv } from '@/lib/csv'

/**
 * o3d-rv4a. THE ARITHMETIC IN EVERY ASSERTION IS WORKED OUT IN THE COMMENT ABOVE IT, FROM NAMED
 * INPUTS, AND NEVER BY RE-RUNNING THE IMPLEMENTATION.
 *
 * That is the only kind of test that could have caught this. The report did not crash and did not
 * disagree with itself; it published a confident wrong number. `assert.equal(row.revenueBase,
 * computeTheSameWayTheCodeDoes(fixture))` would have been green for the whole five rounds this
 * survived, and round 5 responded by writing the blindness down instead of removing it.
 *
 * THE ISSUE'S WORKED EXAMPLE, which every case below is a variation of: one order, one ex-VAT sales
 * line of 100, one dispatch, 40 of posted COGS, and one full credit against that line.
 *
 *   refund-blind (what shipped before this branch)   100 revenue | 60 margin | 60% — and no marker
 *   NET-basis credit of 100                            0 revenue | -40 margin | 0% — exact
 *   GROSS-basis credit of 120                        100 revenue | 60 margin | 60% — every one ≤
 *   unproven-basis credit of 100                     100 revenue | 60 margin | 60% — every one ≤
 *
 * The last two print the SAME NUMBERS the blind report printed. That is the point: the defect was
 * never only the arithmetic, it was that a bounded figure was presented as a measurement. A test
 * covering only the NET case would prove an adjacent property and leave both of those unexamined —
 * and they are precisely where the round-5 disclosure lived.
 */

const D = (value: string | number) => new Prisma.Decimal(value)
const WINDOW = { dateFrom: '2026-06-01', dateTo: '2026-06-30' }
/** Keeps `hasCogsGlScope` false so no accounting connector is reached. Filtering is mocked away. */
const FILTERS = { ...WINDOW, product: 'Widget' }

const WAREHOUSE = { id: 'wh-a', code: 'WHA', name: 'Warehouse A' }

function product(id: string) {
  return {
    id,
    sku: id.toUpperCase(),
    name: `Widget ${id}`,
    stockUnit: 'pcs',
    category: { name: 'Widgets' },
    supplierProducts: [],
  }
}

/**
 * One COGS entry for one dispatch movement, LINKED to the sales line it shipped.
 *
 * The link is what makes this report key revenue (and therefore credit) at line granularity —
 * `L:<lineId>` — instead of the blended `<orderId>:<productId>` pair. Both schemes are exercised
 * below, because the credit has to follow whichever one the report chose.
 */
function cogsEntry(input: {
  id: string
  orderId: string
  productId: string
  qty: string
  cost: string
  line?: { id: string; productId: string | null; totalBase: string }
}) {
  return {
    id: input.id,
    qty: D(input.qty),
    totalCostBase: D(input.cost),
    createdAt: new Date('2026-06-10T00:00:00.000Z'),
    movement: {
      id: `mv-${input.id}`,
      referenceType: 'SalesOrder',
      referenceId: input.orderId,
      fromWarehouseId: WAREHOUSE.id,
      toWarehouseId: null,
      product: product(input.productId),
      fromWarehouse: WAREHOUSE,
      toWarehouse: null,
      shipmentLine: input.line
        ? { lineId: input.line.id, line: { id: input.line.id, productId: input.line.productId, totalBase: D(input.line.totalBase) } }
        : null,
    },
  }
}

function order(id: string, lines: Array<{ productId: string; totalBase: string }>) {
  return {
    id,
    customerName: 'Acme',
    shoppingLinks: [],
    lines: lines.map((line) => ({ productId: line.productId, totalBase: D(line.totalBase) })),
  }
}

/** A credit line against a named sales line. `totalsBasis` is the parent refund's persisted marker. */
function creditAgainstLine(lineId: string, orderId: string, productId: string, totalBase: string, totalsBasis: string | null) {
  return {
    totalBase: D(totalBase),
    productId,
    salesOrderLine: { id: lineId, orderId, productId },
    refund: { orderId, totalsBasis },
  }
}

/** A credit line that names nothing keyable — a shipping or monetary-only credit. */
function creditNamingNothing(orderId: string, totalBase: string, totalsBasis: string | null) {
  return { totalBase: D(totalBase), productId: null, salesOrderLine: null, refund: { orderId, totalsBasis } }
}

let COGS_ROWS: unknown[] = []
let ORDERS: unknown[] = []
let CREDIT_LINES: unknown[] = []
let CREDIT_WHERE: Record<string, unknown> | null = null
let PRODUCT_WHERE: Record<string, unknown> | null = null
/**
 * THE PRODUCTS THE REPORT'S OWN FILTER ADMITS — what `db.product.findMany({ where: productWhere })`
 * answers. `FILTERS` carries `product: 'Widget'`, so the filter is ACTIVE in every test in this file
 * and the report resolves this set on every run; the default admits every product the fixtures use,
 * and the one test about a filtered-out sibling narrows it deliberately.
 */
const ALL_FIXTURE_PRODUCTS = ['p1', 'p2', 'p9', 'other']
let FILTER_PRODUCT_IDS: string[] = [...ALL_FIXTURE_PRODUCTS]

mock.module('@/lib/db', {
  namedExports: {
    db: {
      cogsEntry: { findMany: async () => COGS_ROWS },
      salesOrder: { findMany: async () => ORDERS },
      salesOrderRefundLine: {
        /**
         * THE STAND-IN HONOURS THE `WHERE` IT IS GIVEN, because the defect under test is IN the where.
         *
         * A stub that returns its fixture whatever it is asked cannot fail when the query narrows —
         * and the narrowing that dropped in-period credit against earlier-period orders (Codex round
         * 2, HIGH 1) is exactly that kind of change. Postgres would have dropped those rows, so this
         * drops them too: the row set a test observes is the row set the real query would return.
         */
        findMany: async (args?: { where?: Record<string, unknown> }) => {
          CREDIT_WHERE = args?.where ?? null
          const scope = (args?.where as { refund?: { orderId?: { in?: string[] } } } | undefined)?.refund?.orderId?.in
          if (!scope) return CREDIT_LINES
          return (CREDIT_LINES as Array<{ refund: { orderId: string } }>).filter((line) => scope.includes(line.refund.orderId))
        },
      },
      product: {
        findMany: async (args?: { where?: Record<string, unknown> }) => {
          PRODUCT_WHERE = args?.where ?? null
          return FILTER_PRODUCT_IDS.map((id) => ({ id }))
        },
      },
    },
  },
})

mock.module('@/lib/security/inventory-costing-access', {
  namedExports: {
    requireInventoryCostingReportAccess: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    inventoryCostingApiAccessDenied: () => null,
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})
mock.module('@/app/actions/company', {
  namedExports: { getOrganisation: async () => ({ baseCurrency: 'GBP' }) },
})
mock.module('@/lib/domain/inventory/stock-position-reports', {
  namedExports: {
    getStockPositionFilterOptions: async () => ({ warehouses: [], categories: [], suppliers: [] }),
    stockPositionSelectedFilterOptionInputs: () => ({}),
  },
})

/** THE FIXTURE: the issue's worked example, with `credit` as the only variable. */
function workedExample(credit: unknown[], cost = '40') {
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost, line: { id: 'L1', productId: 'p1', totalBase: '100' } })]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100' }])]
  CREDIT_LINES = credit
  FILTER_PRODUCT_IDS = [...ALL_FIXTURE_PRODUCTS]
}

async function report() {
  const { getCogsReport } = await import('@/lib/domain/inventory/inventory-costing-reports')
  return await getCogsReport(FILTERS, { paginate: false })
}

/** The page's OWN cells and footers, read out of the element it returns. This is what is on screen. */
async function pageCells(): Promise<{ cell: (key: string) => string; cellOf: (key: string, row: unknown) => string; footer: (key: string) => string; rows: unknown[]; summary: Map<string, string>; notices: string[] }> {
  const { default: CogsPage } = await import('@/app/(dashboard)/analytics/cogs/page')
  const element = await CogsPage({ searchParams: Promise.resolve({ ...FILTERS }) }) as {
    props: {
      columns: Array<{ key: string; render: (row: unknown) => unknown; footer?: unknown }>
      rows: unknown[]
      summary: Array<{ label: string; value: string }>
      notices: string[]
    }
  }
  const { columns, rows, summary, notices } = element.props
  const column = (key: string) => {
    const found = columns.find((c) => c.key === key)
    assert.ok(found, `the page has no ${key} column`)
    return found
  }
  return {
    cell: (key: string) => String(column(key).render(rows[0])),
    cellOf: (key: string, row: unknown) => String(column(key).render(row)),
    footer: (key: string) => String(column(key).footer),
    // The rows the page actually rendered — needed by the one test that adds a COLUMN up and compares
    // it with the footer, which is the reader's check and cannot be done one row at a time.
    rows,
    summary: new Map(summary.map((item) => [item.label, item.value])),
    notices,
  }
}

/**
 * THE NUMBER AS AN OPERATOR READS IT OFF THE SCREEN — currency symbol, thousands separators, percent
 * sign and bound marker stripped, and nothing else touched.
 *
 * Tests about display rounding have to compare the PRINTED figure with the truth. Re-deriving the
 * figure from the producer would test the producer twice and leave `Intl.NumberFormat` unexamined,
 * which is precisely where Codex round 2 found the broken ≤.
 */
function printedNumber(text: string): Prisma.Decimal {
  const cleaned = text.replace(/[\u00a3,%\s]/g, '').replace(/[\u2264\u2265?]/g, '')
  assert.match(cleaned, /^-?\d+(\.\d+)?$/, `no number could be read out of ${JSON.stringify(text)}`)
  return D(cleaned)
}

async function csvRows(): Promise<{ rows: Record<string, string>[]; header: string[]; metadata: Map<string, string> }> {
  const { GET } = await import('@/app/api/export/inventory-costing/route')
  const { NextRequest } = await import('next/server')
  const params = new URLSearchParams({ report: 'cogs', ...FILTERS })
  const res = await GET(new NextRequest(`https://ims.test/api/export/inventory-costing?${params.toString()}`))
  const body = await res.text()
  const metadata = new Map<string, string>()
  for (const line of body.split('\r\n')) {
    const match = /^"?# ([A-Za-z0-9_.]+)"?,(.*)$/.exec(line)
    if (match) metadata.set(match[1]!, match[2]!.replace(/^"|"$/g, '').replace(/""/g, '"'))
  }
  return { rows: parseCsv(body), header: body.split('\r\n')[0]!.split(','), metadata }
}

// ---------------------------------------------------------------------------------------------
// The three bases, at the numbers an operator sees
// ---------------------------------------------------------------------------------------------

test('NET credit: the fully credited line reads 0 revenue and MINUS 40 margin, exactly (o3d-rv4a)', async () => {
  // Line revenue 100 ex-VAT; the credit is stamped NET, so it is the same unit and comes off in
  // full: 100 - 100 = 0 revenue, 0 - 40 = -40 margin. Nothing was left unsubtracted, so no relation
  // is owed and the figures carry NO marker — `exact` is a claim, not a hedge.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', 'NET')])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '0.000000')
  assert.equal(rows[0]!.grossMarginBase, '-40.000000')
  assert.equal(rows[0]!.refundsNetBasis, '100.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'exact')
  assert.equal(rows[0]!.grossMarginBaseBound, 'exact')
  assert.equal(rows[0]!.grossMarginPctBound, 'exact')
  assert.equal(totals.revenueBase, '0.000000')
  assert.equal(totals.grossMarginBase, '-40.000000')
  assert.equal(totals.revenueBaseBound, 'exact')

  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£0.00')
  assert.equal(page.cell('margin'), '-£40.00')
  // Revenue is not positive, so the ratio is 0% under the same guard the Gross Margin report uses.
  // Before this branch a non-positive revenue was unreachable here; it is routine now.
  assert.equal(page.cell('marginPct'), '0%')
  assert.equal(page.footer('revenue'), '£0.00')
  assert.equal(page.summary.get('Gross margin (GBP)'), '-£40.00')
})

test('GROSS credit: the same 100/60/60% print, but every one of them marked ≤ (o3d-rv4a)', async () => {
  // A 120 VAT-inclusive credit against a 100 ex-VAT line. Its ex-VAT value is 120/(1+rate) — and the
  // rate is not recoverable from stored data on a mixed-rate order, so it is NOT converted and NOT
  // subtracted (refund-basis-analytics, o3d-w00's fail-closed conclusion). Revenue stays 100 and
  // margin 60, which is what the blind report printed; what changes is that all three now say they
  // are at most the true figure, and the 120 is published beside them so the reader can see how
  // loose that is.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '120', 'GROSS')])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.grossMarginBase, '60.000000')
  assert.equal(rows[0]!.grossMarginPct, '60')
  assert.equal(rows[0]!.refundsGrossBasis, '120.000000')
  assert.equal(rows[0]!.refundsNetBasis, '0.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginBaseBound, 'upper')
  // Margin is a RATIO: published 60%, and placing the credit at any ex-VAT value in [0, 120] takes
  // revenue to at most 100 and the quotient no higher, while the report's own `revenue > 0` guard
  // pins the worst reading to 0%. 0% is below 60%, so the published figure is a genuine ceiling here.
  assert.equal(rows[0]!.grossMarginPctBound, 'upper')
  assert.equal(totals.revenueBaseBound, 'upper')
  assert.equal(totals.refundsGrossBasis, '120.000000')

  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£100.00 ≤')
  assert.equal(page.cell('margin'), '£60.00 ≤')
  assert.equal(page.cell('marginPct'), '60% ≤')
  assert.equal(page.cell('creditGross'), '£120.00')
  assert.equal(page.footer('revenue'), '£100.00 ≤')
  assert.equal(page.summary.get('Revenue (GBP, net of credit)'), '£100.00 ≤')
})

test('unproven basis: not converted, not guessed, and not reported as zero credit (o3d-rv4a)', async () => {
  // `totalsBasis` NULL is a first-class answer, not a missing NET (o3d-n8p/o3d-w00): a legacy row, or
  // one the o3d-lvk backfill could not PROVE either way. 100 of credit exists and is published; what
  // is withheld is the subtraction. Same 100/60/60%, same three ≤ marks, and the amount lands in the
  // unproven column rather than being quietly treated as net.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', null)])
  const { rows } = await report()
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.grossMarginBase, '60.000000')
  assert.equal(rows[0]!.refundsUnknownBasis, '100.000000')
  assert.equal(rows[0]!.refundsNetBasis, '0.000000')
  assert.equal(rows[0]!.refundsGrossBasis, '0.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginPctBound, 'upper')

  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£100.00 ≤')
  assert.equal(page.cell('creditUnknown'), '£100.00')
})

test('an UNSTAMPED basis is not read as NET even when the amounts would agree (o3d-rv4a control)', async () => {
  // The two tests above differ ONLY in `totalsBasis`, at the same 100. Pin that the difference is
  // the marker and not the amount: read as NET this would be 0 revenue, and it is not.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', 'NET')])
  const asNet = await report()
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', 'MYSTERY')])
  const asUnrecognised = await report()
  assert.equal(asNet.rows[0]!.revenueBase, '0.000000')
  assert.equal(asUnrecognised.rows[0]!.revenueBase, '100.000000')
  // An unrecognised marker is UNKNOWN, never NET. Guessing is the mislabelling the backfill exists
  // to avoid, and a future writer's new value must not silently become a subtraction.
  assert.equal(asUnrecognised.rows[0]!.refundsUnknownBasis, '100.000000')
  assert.equal(asUnrecognised.rows[0]!.revenueBaseBound, 'upper')
})

test('no credit at all: exact, unmarked, and the credit columns are zero (o3d-rv4a control)', async () => {
  // Not vacuous: the SAME cells read `£100.00 ≤` two tests up, on this same fixture with a
  // gross-basis credit added. Blindness looked exactly like this, which is why the control matters.
  workedExample([])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.grossMarginBase, '60.000000')
  assert.equal(rows[0]!.grossMarginPct, '60')
  assert.equal(rows[0]!.revenueBaseBound, 'exact')
  assert.equal(rows[0]!.grossMarginPctBound, 'exact')
  assert.equal(totals.revenueBaseBound, 'exact')
  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£100.00')
  assert.equal(page.cell('marginPct'), '60%')
})

// ---------------------------------------------------------------------------------------------
// The ratio is not the linear figures, and the bound is not a signed sum
// ---------------------------------------------------------------------------------------------

test('the ratio verdict can differ from the two linear ones on one row (o3d-iigc r4 #1)', async () => {
  // 100 ex-VAT revenue, 150 of COGS, and a 120 gross-basis credit that cannot be placed. Published
  // margin is 100*(1 - 150/100) = -50%. Place that credit at its 100 ex-VAT value and revenue is 0,
  // where the report's guard prints 0% — and 0% is NOT "at most -50%". Revenue and margin are still
  // genuine ceilings; the ratio is not, and marking it ≤ would be a false claim.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '120', 'GROSS')], '150')
  const { rows } = await report()
  assert.equal(rows[0]!.grossMarginBase, '-50.000000')
  assert.equal(rows[0]!.grossMarginPct, '-50')
  assert.equal(rows[0]!.revenueBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginPctBound, 'indeterminate')
  const page = await pageCells()
  assert.equal(page.cell('margin'), '-£50.00 ≤')
  assert.equal(page.cell('marginPct'), '-50% ?')
})

test('two opposite same-basis credits do not cancel behind the bound (o3d-la3n)', async () => {
  // +120 and -120 of GROSS credit. The signed bucket is ZERO, and zero is not negative, so any rule
  // that classified from `refundsGrossBasis + refundsUnknownBasis` would answer `upper` about a
  // figure whose truth can be 120 EITHER side of the published one — the two credits' ex-VAT values
  // need not cancel, because the rates behind them may differ. The interval is [-120, +120], it
  // straddles zero, and the only sound answer is that no direction is established.
  workedExample([
    creditAgainstLine('L1', 'O1', 'p1', '120', 'GROSS'),
    creditAgainstLine('L1', 'O1', 'p1', '-120', 'GROSS'),
  ])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.refundsGrossBasis, '0.000000', 'the published bucket really is a zero')
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'indeterminate')
  assert.equal(rows[0]!.grossMarginBaseBound, 'indeterminate')
  assert.equal(totals.revenueBaseBound, 'indeterminate')
  const page = await pageCells()
  assert.equal(page.cell('revenue'), '£100.00 ?')
})

// ---------------------------------------------------------------------------------------------
// Credit that reached no row
// ---------------------------------------------------------------------------------------------

test('a NET credit that reached no row still bounds the totals (o3d-kyey)', async () => {
  // The trap a basis flag alone walks into: a NET credit IS the figure's unit, so it is `placeable`
  // and the basis flag stays true — while the credit sits unsubtracted because no row could own it.
  // 10 of net credit on a line this report has no revenue row for: every ROW is exact, and the
  // period totals are not.
  workedExample([creditAgainstLine('L9', 'O1', 'p9', '10', 'NET')])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '100.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'exact', 'no credit reached this row')
  assert.equal(totals.refundsOutsideReportNetBasis, '10.000000')
  assert.equal(totals.refundsUnattributedNetBasis, '0.000000')
  assert.equal(totals.revenueBaseBound, 'upper')
  assert.equal(totals.grossMarginBaseBound, 'upper')
  const page = await pageCells()
  assert.equal(page.footer('revenue'), '£100.00 ≤')
  assert.equal(page.summary.get('Credit off-report — no revenue row here (net / gross / unproven)'), '£10.00 / £0.00 / £0.00')
})

test('a credit line naming nothing keyable is separated from one naming a row we lack (o3d-rv4a)', async () => {
  // Two different facts, kept apart because they have different remedies: a shipping or monetary-only
  // credit line can NEVER reach a product row however the dates are widened, while a credit naming a
  // product this window has no revenue row for may well appear on another period.
  workedExample([
    creditNamingNothing('O1', '7', 'GROSS'),
    creditAgainstLine('L9', 'O1', 'p9', '3', null),
  ])
  const { totals } = await report()
  assert.equal(totals.refundsUnattributedGrossBasis, '7.000000')
  assert.equal(totals.refundsOutsideReportUnknownBasis, '3.000000')
  assert.equal(totals.refundsGrossBasis, '7.000000', 'the report-wide credit total includes both')
  assert.equal(totals.refundsUnknownBasis, '3.000000')
  assert.equal(totals.revenueBaseBound, 'upper')
})

test('a row whose revenue is Unmatched publishes no relation, and its credit is not lost (o3d-rv4a)', async () => {
  // The dispatch references an order whose lines name a different product, so this key carries no
  // revenue — the null-not-zero discipline this report already had. A credit naming that key has no
  // figure anywhere to reduce, so it cannot be attributed at all and lands in the off-report totals;
  // the cell stays `Unmatched` with NO relation attached, because a withheld figure bears none, and
  // `exact` there would read as a measurement.
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40' })]
  ORDERS = [order('O1', [{ productId: 'other', totalBase: '100' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '50', 'NET')]
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueCaptured, false)
  assert.equal(rows[0]!.revenueBase, null)
  assert.equal(rows[0]!.revenueBaseBound, null, 'a withheld figure carries no relation, not `exact`')
  assert.equal(rows[0]!.grossMarginPctBound, null)
  assert.equal(totals.refundsOutsideReportNetBasis, '50.000000')
  assert.equal(totals.revenueBaseBound, 'upper')
  const page = await pageCells()
  assert.equal(page.cell('revenue'), 'Unmatched')
  assert.equal(page.cell('marginPct'), 'Unmatched')
})

test('credit that DID reach a row whose figure is withheld still bounds the totals (o3d-rv4a)', async () => {
  // THIS IS THE CASE THE TEST ABOVE DOES NOT REACH, and a green mutation is how I found that out:
  // replacing the withheld-row branch with the ordinary unplaced-credit one left the suite entirely
  // green, because in that fixture no credit ever reached a row at all.
  //
  // Here it does. One product bucket, two dispatches: order O1's is line-linked and carries 100 of
  // ex-VAT revenue, order O2's references an order whose lines name a different product, so the
  // GROUP's revenue is withheld (`revenueCaptured` is all-or-nothing per group, by design — a partial
  // figure summed with a hole in it is worse than no figure). A 100 NET credit against O1's line IS
  // attributed to this row. Its basis is the figure's own unit, so every completeness FLAG stays
  // true — and the credit is still missing from the period revenue, because the row it reached
  // publishes nothing for it to come off. Read from the flags alone the totals would say `exact`
  // over a period with a credit note missing from it.
  COGS_ROWS = [
    cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40', line: { id: 'L1', productId: 'p1', totalBase: '100' } }),
    cogsEntry({ id: 'c2', orderId: 'O2', productId: 'p1', qty: '1', cost: '15' }),
  ]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100' }]), order('O2', [{ productId: 'other', totalBase: '60' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '100', 'NET')]
  const { rows, totals } = await report()
  assert.equal(rows.length, 1, 'one product bucket')
  assert.equal(rows[0]!.revenueCaptured, false)
  assert.equal(rows[0]!.revenueBase, null)
  assert.equal(rows[0]!.revenueBaseBound, null)
  // The credit reached the row and is published on it — it is not off-report and it is not lost.
  assert.equal(rows[0]!.refundsNetBasis, '100.000000')
  assert.equal(totals.refundsNetBasis, '100.000000')
  assert.equal(totals.refundsOutsideReportNetBasis, '0.000000')
  assert.equal(totals.refundsUnattributedNetBasis, '0.000000')
  // The withheld row contributes neither revenue nor margin to the period totals (that is what the
  // null means, and the totals have always summed it as nothing), so both are zero against 55 of
  // posted cost — and both are BOUNDED, because 100 of real credit sits outside them.
  assert.equal(totals.cogsBase, '55.000000')
  assert.equal(totals.revenueBase, '0.000000')
  assert.equal(totals.grossMarginBase, '0.000000')
  assert.equal(totals.revenueBaseBound, 'upper')
  assert.equal(totals.grossMarginBaseBound, 'upper')
  const page = await pageCells()
  assert.equal(page.footer('revenue'), '£0.00 ≤')
  assert.equal(page.cell('creditNet'), '£100.00')
})

// ---------------------------------------------------------------------------------------------
// Attribution: the same keys, and the same quantity share
// ---------------------------------------------------------------------------------------------

test('credit follows the BLENDED order:product key where revenue does (o3d-rv4a)', async () => {
  // No shipment-line link, so `resolveCogsRevenueKeys` falls back to `<orderId>:<productId>` and the
  // credit has to be keyed the same way. Keyed by line id instead it would reach no row, and the row
  // would publish 100 as exact with 100 of net credit sitting off-report.
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40' })]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100' }])]
  CREDIT_LINES = [{ totalBase: D('100'), productId: 'p1', salesOrderLine: null, refund: { orderId: 'O1', totalsBasis: 'NET' } }]
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '0.000000')
  assert.equal(rows[0]!.revenueBaseBound, 'exact')
  assert.equal(totals.refundsOutsideReportNetBasis, '0.000000')
})

test('a line split across two warehouses shares its credit by the same qty proportion (scjz.50)', async () => {
  // One line of 4 units at 300 ex-VAT, dispatched 1 from WHA and 3 from WHB, with a 300 NET credit.
  // Revenue is allocated 75/225 by quantity share, so the credit must be too: 75 and 225. Charging
  // each warehouse the WHOLE 300 would report -225 and -75 and a report total 300 too low — the
  // mirror of the double-count that rule exists to prevent.
  COGS_ROWS = [
    { ...cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '10', line: { id: 'L1', productId: 'p1', totalBase: '300' } }) },
    {
      ...cogsEntry({ id: 'c2', orderId: 'O1', productId: 'p1', qty: '3', cost: '30', line: { id: 'L1', productId: 'p1', totalBase: '300' } }),
      movement: {
        ...cogsEntry({ id: 'c2', orderId: 'O1', productId: 'p1', qty: '3', cost: '30', line: { id: 'L1', productId: 'p1', totalBase: '300' } }).movement,
        fromWarehouseId: 'wh-b',
        fromWarehouse: { id: 'wh-b', code: 'WHB', name: 'Warehouse B' },
      },
    },
  ]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '300' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '300', 'NET')]
  const { getCogsReport } = await import('@/lib/domain/inventory/inventory-costing-reports')
  const { rows, totals } = await getCogsReport({ ...FILTERS, groupBy: 'warehouse' }, { paginate: false })
  const byCode = new Map(rows.map((row) => [row.warehouseCode, row]))
  assert.equal(byCode.get('WHA')!.refundsNetBasis, '75.000000')
  assert.equal(byCode.get('WHB')!.refundsNetBasis, '225.000000')
  assert.equal(byCode.get('WHA')!.revenueBase, '0.000000')
  assert.equal(byCode.get('WHB')!.revenueBase, '0.000000')
  assert.equal(totals.revenueBase, '0.000000')
  assert.equal(totals.refundsNetBasis, '300.000000')
})

// ---------------------------------------------------------------------------------------------
// THE PERIOD AND THE SCOPE (Codex round 2, HIGH 1)
//
// Round 1 restricted the credit load to `sourceOrderIds` — the orders behind this window's
// dispatches — and round 1's own test asserted that restriction as a decision. Codex round 2 tested
// the decision instead of reading it, and it is wrong IN BOTH DIRECTIONS, which is why widening one
// filter is not the fix:
//
//   - it DROPS credit it must load: an in-period credit against an earlier period's order, which
//     Gross Margin loads and deducts, so COGS published exact revenue over a period with a credit
//     note missing from it; and
//   - it LOADS credit it must exclude: a credit for a sibling product the operator's own filter
//     removed from every row, which landed in `outsideReport` and marked the filtered view bounded
//     for a reason that is not about the view.
//
// The period rule is now Gross Margin's, to the byte — both reports build the same WHERE from one
// shared helper — and the PRODUCT filter is applied to the credit lines separately, because the
// period and the filter are two different questions and round 1 answered them with one clause.
// ---------------------------------------------------------------------------------------------

test('the credit window is the refund date, and nothing else narrows the query (o3d-rv4a, Codex r2 HIGH 1)', async () => {
  // The period rule is the refund's own `refundedAt`, and it is now the ONLY clause: an order-id
  // restriction here is the round-1 defect, so its absence is asserted universally rather than by
  // listing the keys that happen to be present today.
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '100', 'NET')])
  await report()
  const where = CREDIT_WHERE as { refund: { refundedAt: { gte: Date; lt: Date } } }
  assert.deepEqual(Object.keys(where), ['refund'], 'the refund-line query carries the period clause and nothing else')
  assert.deepEqual(Object.keys(where.refund), ['refundedAt'])
  assert.equal(where.refund.refundedAt.gte.toISOString(), '2026-06-01T00:00:00.000Z')
  assert.equal(where.refund.refundedAt.lt.toISOString(), '2026-07-01T00:00:00.000Z')
})

test('an in-period credit against an EARLIER period’s order is loaded, not dropped (Codex r2 HIGH 1)', async () => {
  // Codex round 2, verbatim: "Restricting refunds to `sourceOrderIds` drops in-period credits against
  // earlier-period orders, while Gross Margin loads every refund raised in the period. With a current
  // dispatch of the same product, Gross Margin deducts that credit but COGS reports healthy, exact
  // revenue and margin."
  //
  // The fixture is that sentence. June holds one dispatch of p1 on order O1 — 100 ex-VAT, 40 of cost.
  // A 30 NET credit was RAISED IN JUNE against order O0, May's dispatch of the same product, for which
  // this window holds no revenue row. Gross Margin's rows are products, so it puts that 30 on p1's row
  // and publishes 70. This report keys credit by order and by sales line, so no row of THIS window
  // owns O0's revenue and the 30 cannot be deducted anywhere — but it is real credit raised in the
  // period, so what the report may NOT do is publish the period as exact. Round 1 never saw the row:
  // the query asked only for O1.
  workedExample([creditAgainstLine('L0', 'O0', 'p1', '30', 'NET')])
  const { rows, totals } = await report()
  assert.equal(rows[0]!.revenueBase, '100.000000', 'June’s own dispatch is not reduced by May’s credit')
  assert.equal(rows[0]!.revenueBaseBound, 'exact', 'and no credit reached this row')
  assert.equal(totals.refundsOutsideReportNetBasis, '30.000000', 'the credit is LOADED and published')
  assert.equal(totals.revenueBaseBound, 'upper', 'so the period figures are bounded, not exact')
  assert.equal(totals.grossMarginBaseBound, 'upper')
})

test('a filtered-out sibling product’s credit does not pollute the filtered totals (Codex r2 HIGH 1)', async () => {
  // Codex round 2, verbatim: "Conversely, a refund for a filtered-out sibling product on an included
  // order is loaded into `outsideReport`, polluting filtered totals and bounds."
  //
  // The operator's filter admits p1 and nothing else. Order O1 carries two lines: p1, dispatched and
  // reported here, and sibling p2, which that filter removed from every row of this report. A 25 NET
  // credit against p2's line is not credit against anything this view publishes. Loading it would put
  // 25 in the off-report bucket and stamp the view `≤` for a reason that has nothing to do with the
  // view — and a marker that shows up on every filtered view is a marker that stops being read.
  FILTER_PRODUCT_IDS = ['p1']
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40', line: { id: 'L1', productId: 'p1', totalBase: '100' } })]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100' }, { productId: 'p2', totalBase: '80' }])]
  CREDIT_LINES = [creditAgainstLine('L2', 'O1', 'p2', '25', 'NET')]
  const { totals } = await report()
  // The filter query actually ran, and it ran with the report's own product filter — asserted so a
  // future edit cannot satisfy this test by resolving an empty scope that admits nothing.
  assert.ok(PRODUCT_WHERE, 'the report never asked which products its filter admits')
  assert.deepEqual(PRODUCT_WHERE, { OR: [{ sku: { contains: 'Widget', mode: 'insensitive' } }, { name: { contains: 'Widget', mode: 'insensitive' } }] })
  assert.equal(totals.refundsOutsideReportNetBasis, '0.000000', 'p2 is outside the FILTER, not outside the report')
  assert.equal(totals.refundsUnattributedNetBasis, '0.000000')
  assert.equal(totals.refundsNetBasis, '0.000000')
  assert.equal(totals.revenueBase, '100.000000')
  assert.equal(totals.revenueBaseBound, 'exact', 'nothing this view publishes is missing a credit')
  assert.equal(totals.grossMarginBaseBound, 'exact')
})

test('a credit naming NO product is kept under a product filter — fail closed (Codex r2 HIGH 1 control)', async () => {
  // The exclusion above is allowed only because p2 is PROVABLY another product. A shipping or
  // monetary-only credit line names no product at all, so it cannot be shown to be about something
  // the filter removed — and on an order that contains the filtered product it is partly about it.
  // The same fail-closed rule the basis buckets apply to an unstamped credit: what cannot be proved
  // out is kept in, and it bounds the totals. Without this control, "exclude what does not match" is
  // one edit away from excluding everything unkeyable and quietly restoring the exactness claim.
  FILTER_PRODUCT_IDS = ['p1']
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40', line: { id: 'L1', productId: 'p1', totalBase: '100' } })]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100' }])]
  CREDIT_LINES = [creditNamingNothing('O1', '7', 'GROSS')]
  const { totals } = await report()
  assert.equal(totals.refundsUnattributedGrossBasis, '7.000000', 'an unkeyable credit is never filtered away')
  assert.equal(totals.revenueBaseBound, 'upper')
})

test('COGS and Gross Margin load the SAME period of credit, from the query each actually issues (Codex r2 HIGH 1)', async () => {
  // Consistency with Gross Margin is the entire basis of this design, so where the two must agree it
  // is PROVED, not documented. Both wheres are captured from the queries the two reports really run,
  // over the same window, and compared whole. Re-adding an order-id restriction to either side — or
  // moving one report's period anchor off `refundedAt` — turns this red; a comment claiming agreement
  // could not.
  workedExample([])
  await report()
  const cogsWhere = CREDIT_WHERE
  assert.ok(cogsWhere, 'the COGS report issued no refund-line query')

  let marginWhere: unknown = null
  const empty = { findMany: async () => [] }
  const marginClient = {
    product: { findMany: async (args?: unknown) => ((args as { where: { id: { in: string[] } } }).where.id.in.map((id) => ({ id, type: 'SIMPLE', productComponents: [] }))) },
    salesOrder: empty,
    salesOrderRefund: empty,
    salesOrderRefundLine: {
      findMany: async (args?: { where?: unknown }) => {
        marginWhere = args?.where ?? null
        return []
      },
    },
    cogsEntry: empty,
    stockMovement: empty,
    shipment: empty,
    activityLog: empty,
  }
  const { getMarginAnalyticsReport } = await import('@/lib/domain/sales/sales-fulfillment-analytics')
  await getMarginAnalyticsReport({ ...WINDOW }, {
    client: marginClient,
    now: () => new Date('2026-06-30T00:00:00.000Z'),
  } as unknown as Parameters<typeof getMarginAnalyticsReport>[1])
  assert.ok(marginWhere, 'the Gross Margin report issued no refund-line query')
  assert.deepEqual(cogsWhere, marginWhere, 'the two reports must ask for one and the same period of credit')
})

// ---------------------------------------------------------------------------------------------
// AN UPPER BOUND BELOW THE TRUTH IS NOT A BOUND (Codex round 2, HIGH 2 and HIGH 3)
//
// Both findings are one error: a bound was rounded and aggregated as if it were an ordinary number.
// o3d-la3n settled the rule for figures that are summed — endpoints ADD, the verdict is derived LAST,
// and rounding happens ONCE, at the end, IN THE DIRECTION THE RELATION ALLOWS. Round 1 of this branch
// broke both halves: it reconstructed the period totals from the rows' six-decimal STRINGS while
// taking the verdict from the unrounded interval, and then let `Intl.NumberFormat` round the result
// to the NEAREST penny under a `≤`.
// ---------------------------------------------------------------------------------------------

test('the period total is summed UNROUNDED, so its upper bound is not below the truth (Codex r2 HIGH 2)', async () => {
  // Codex round 2, verbatim: "A £1 line split across 300 groups with £0.0001 GROSS credit produces
  // `0.999900 upper`, although at 20% VAT the true completed-basis total is `0.999916667`; the
  // advertised upper bound is below the truth."
  //
  // That example, exactly. ONE sales line of 1.00 ex-VAT, dispatched a single unit from each of 300
  // warehouses, grouped by warehouse. Revenue is allocated by quantity share, so every row's share is
  // 1/300 = 0.003333333…, which the six-decimal money string rounds to 0.003333 — and 300 × 0.003333
  // is 0.999900. Round 1 rebuilt the total by adding those 300 strings back up, so it published
  // 0.999900 and took the ≤ from the unrounded credit interval.
  //
  // The 0.0001 credit is stamped GROSS, so it is not this figure's unit and nothing is subtracted. At
  // 20% VAT its ex-VAT value is 0.0001 / 1.2 = 0.0000833333…, so the true completed-basis total is
  // 1 - 0.0000833333… = 0.9999166666… — ABOVE the 0.999900 the report advertised as a ceiling.
  const line = { id: 'L1', productId: 'p1', totalBase: '1' }
  COGS_ROWS = Array.from({ length: 300 }, (_unused, index) => {
    const entry = cogsEntry({ id: `c${index}`, orderId: 'O1', productId: 'p1', qty: '1', cost: '0', line })
    return { ...entry, movement: { ...entry.movement, fromWarehouseId: `wh-${index}`, fromWarehouse: { id: `wh-${index}`, code: `W${index}`, name: `Warehouse ${index}` } } }
  })
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '1' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '0.0001', 'GROSS')]
  FILTER_PRODUCT_IDS = [...ALL_FIXTURE_PRODUCTS]
  const { getCogsReport } = await import('@/lib/domain/inventory/inventory-costing-reports')
  const { rows, totals } = await getCogsReport({ ...FILTERS, groupBy: 'warehouse' }, { paginate: false })
  assert.equal(rows.length, 300, 'the 300 groups the example needs')
  assert.equal(totals.revenueBaseBound, 'upper', 'a ceiling is being claimed, so the claim has to hold')

  // THE ASSERTION IS THE BOUND PROPERTY ITSELF, not a golden string: the published figure must be at
  // or above the true completed-basis one. A golden string would go green again the moment someone
  // rounded it back the wrong way by the same amount in both places.
  const trueTotal = D('1').sub(D('0.0001').div(D('1.2')))
  assert.equal(trueTotal.toFixed(9), '0.999916667', 'the reviewer\u2019s own figure for the truth')
  assert.ok(
    D(totals.revenueBase).gte(trueTotal),
    `published upper bound ${totals.revenueBase} is BELOW the truth ${trueTotal.toFixed(12)}`,
  )
  assert.equal(totals.revenueBase, '1.000000')
  // Margin is revenue less zero cost here, so the same claim rides on the same sum.
  assert.ok(D(totals.grossMarginBase).gte(trueTotal), `published margin ceiling ${totals.grossMarginBase} is below the truth`)
})

test('a displayed upper bound rounds UP, so the printed figure is not below the truth (Codex r2 HIGH 3)', async () => {
  // Codex round 2, verbatim: "`Intl.NumberFormat` rounds bounded money to nearest cents, and
  // `grossMarginPct` has already been rounded to nearest hundredth before its marker is appended. For
  // £100.004 revenue with £0.0001 GROSS credit and £40 COGS, the page prints `£100.00 ≤`, `£60.00 ≤`,
  // and `60% ≤`, while the corresponding true values at 20% VAT can exceed all three displayed
  // figures."
  //
  // That example, exactly. PUBLISHED: revenue 100.004 (the GROSS credit is not this figure's unit, so
  // nothing comes off it), margin 100.004 - 40 = 60.004, and margin % = 100 × (1 - 40/100.004) =
  // 60.0015999…%. TRUE, at 20% VAT, where the credit is worth 0.0001/1.2 = 0.0000833333… ex-VAT:
  //   revenue  100.004   - 0.0000833333… = 100.0039166666…
  //   margin    60.004   - 0.0000833333… =  60.0039166666…
  //   margin %  100 × (1 - 40/100.0039166666…) = 60.0015666…%
  // Rounded to the NEAREST penny and hundredth those print as 100.00, 60.00 and 60 — every one of them
  // strictly BELOW the truth it carries a ≤ over. An upper bound has to round UP.
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40', line: { id: 'L1', productId: 'p1', totalBase: '100.004' } })]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100.004' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '0.0001', 'GROSS')]
  FILTER_PRODUCT_IDS = [...ALL_FIXTURE_PRODUCTS]
  const { rows } = await report()
  assert.equal(rows[0]!.revenueBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginBaseBound, 'upper')
  assert.equal(rows[0]!.grossMarginPctBound, 'upper')

  const netCredit = D('0.0001').div(D('1.2'))
  const trueRevenue = D('100.004').sub(netCredit)
  const trueMargin = trueRevenue.sub(D('40'))
  const truePct = D('1').sub(D('40').div(trueRevenue)).mul(100)
  assert.equal(trueRevenue.toFixed(7), '100.0039167')
  assert.equal(trueMargin.toFixed(7), '60.0039167')
  assert.equal(truePct.toFixed(7), '60.0015666')

  const page = await pageCells()
  // Every printed figure carries the relation, and every one of them must honour it. These read the
  // NUMBER BACK OFF THE SCREEN, which is the only place the display rounding can be caught.
  for (const [key, truth] of [['revenue', trueRevenue], ['margin', trueMargin], ['marginPct', truePct]] as const) {
    const printed = page.cell(key)
    assert.match(printed, / ≤$/, `${key} must still carry its relation`)
    assert.ok(
      printedNumber(printed).gte(truth),
      `${key} prints ${printed}, which is BELOW the true ${truth.toFixed(9)} it claims to be at or above`,
    )
  }
  assert.equal(page.cell('revenue'), '£100.01 ≤')
  assert.equal(page.cell('margin'), '£60.01 ≤')
  assert.equal(page.cell('marginPct'), '60.01% ≤')
  // And the same claim in the footer and the summary card, which are the period figures.
  assert.ok(printedNumber(page.footer('revenue')).gte(trueRevenue), `the footer prints ${page.footer('revenue')}`)
  assert.ok(printedNumber(page.summary.get('Revenue (GBP, net of credit)') ?? '').gte(trueRevenue))
})

test('the CSV rounds a bounded column UP at its own precision too (Codex r2 HIGH 3)', async () => {
  // "A CSV column that rounds a bound the wrong way is the same defect in a different skin." The file
  // publishes six decimals rather than two, so the example has to bite at the SEVENTH: a line of
  // 100.0000004 ex-VAT with a 0.0000001 GROSS credit.
  //
  // PUBLISHED revenue is 100.0000004. Rounded to the nearest six decimals that is 100.000000. TRUE, at
  // 20% VAT: 100.0000004 - 0.0000001/1.2 = 100.0000004 - 0.0000000833… = 100.0000003166…, which is
  // ABOVE 100.000000. Rounded UP the column reads 100.000001 and the ≤ in the column beside it holds.
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40', line: { id: 'L1', productId: 'p1', totalBase: '100.0000004' } })]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '100.0000004' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '0.0000001', 'GROSS')]
  FILTER_PRODUCT_IDS = [...ALL_FIXTURE_PRODUCTS]
  const { rows } = await csvRows()
  const row = rows[0]!
  const trueRevenue = D('100.0000004').sub(D('0.0000001').div(D('1.2')))
  assert.equal(trueRevenue.toFixed(10), '100.0000003167')
  assert.equal(row.revenueBaseBound, 'upper', 'the file claims a ceiling in its own column')
  assert.ok(
    D(row.revenueBase!).gte(trueRevenue),
    `the CSV publishes ${row.revenueBase} under a ≤ over a true ${trueRevenue.toFixed(10)}`,
  )
  assert.equal(row.revenueBase, '100.000001')
  // The period total travels as metadata and carries the same relation, so it owes the same direction.
  const { metadata } = await csvRows()
  assert.equal(metadata.get('totals.revenueBaseBound'), 'upper')
  assert.ok(D(metadata.get('totals.revenueBase')!).gte(trueRevenue), `the metadata total ${metadata.get('totals.revenueBase')} is below the truth`)
})

test('a displayed upper bound survives the FLOAT BOUNDARY, not only the formatter (Codex r3 HIGH)', async () => {
  // Codex round 3, verbatim: "`Number(amount)` loses precision before directed rounding. For
  // schema-valid `90071992547409.990000` with a true completed-basis value of `90071992547409.989917`,
  // the page displays `90071992547409.98 <=`, which is below the truth. The bound-preserving producer
  // and CSV remain sound, but the on-screen upper bound does not."
  //
  // Round 2 moved the rounding to the producer and made it directed; the page then handed the
  // producer's decimal STRING to `Number(...)` before the ceiling was applied. Above 2^53 that
  // conversion rounds to NEAREST, and the representable doubles there are 0.015625 apart — wider than
  // the penny being rounded to — so the ceiling was applied to a value that was already below the
  // truth and had nothing left to fix. Directed rounding cannot undo a conversion.
  //
  // PUBLISHED revenue is the line's 90071992547409.99: the credit is stamped GROSS, so it is not this
  // figure's unit and nothing comes off it. TRUE, at 20% VAT, where the 0.0001 credit is worth
  // 0.0001 / 1.2 = 0.0000833333… ex-VAT:
  //   90071992547409.99 - 0.0000833333… = 90071992547409.9899166666…
  // which is the reviewer's own 90071992547409.989917.
  COGS_ROWS = [cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '40', line: { id: 'L1', productId: 'p1', totalBase: '90071992547409.99' } })]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '90071992547409.99' }])]
  CREDIT_LINES = [creditAgainstLine('L1', 'O1', 'p1', '0.0001', 'GROSS')]
  FILTER_PRODUCT_IDS = [...ALL_FIXTURE_PRODUCTS]
  const { rows } = await report()
  // THE REVIEWER'S EXACT SCHEMA-VALID STRING has to be the thing the producer published, or this test
  // is about a different number than the finding was.
  assert.equal(rows[0]!.revenueBase, '90071992547409.990000')
  assert.equal(rows[0]!.revenueBaseBound, 'upper')

  const trueRevenue = D('90071992547409.99').sub(D('0.0001').div(D('1.2')))
  assert.equal(trueRevenue.toFixed(6), '90071992547409.989917', 'the reviewer’s own figure for the truth')
  // THE CONVERSION THE PAGE USED TO MAKE, NAMED. Without this the test would not say what it defends
  // against, and a reader could not tell the example still bites on today's floating point.
  assert.equal(Number(rows[0]!.revenueBase), 90071992547409.984375, 'float64 still loses the ninth digit')
  assert.ok(D(Number(rows[0]!.revenueBase)).lt(trueRevenue), 'and what it loses is the bound itself')

  const page = await pageCells()
  const printed = page.cell('revenue')
  assert.match(printed, / ≤$/, 'revenue must still carry its relation')
  assert.ok(
    printedNumber(printed).gte(trueRevenue),
    `revenue prints ${printed}, which is BELOW the true ${trueRevenue.toFixed(12)} it claims to be at or above`,
  )
  assert.equal(printed, '£90,071,992,547,409.99 ≤')
  // The footer and the summary card are the same figure through the same helper, so they owe the same.
  assert.ok(printedNumber(page.footer('revenue')).gte(trueRevenue), `the footer prints ${page.footer('revenue')}`)
  assert.ok(printedNumber(page.summary.get('Revenue (GBP, net of credit)') ?? '').gte(trueRevenue))
})

test('the float boundary on a NEGATIVE ceiling and on a floor, the two signs ROUND_CEIL splits (Codex r3 HIGH)', async () => {
  // ROUND_CEIL over a NEGATIVE figure is the case round 2's own test did not cover, and the float
  // conversion breaks it in the mirror direction. `Number('-90071992547409.995000')` is exactly
  // -90071992547410 — BELOW the published figure — so a ceiling computed from it printed
  // -£90,071,992,547,410.00 over a truth that is at or above -…409.995. A floor has the same defect at
  // the same magnitude with the signs swapped: `Number('90071992547409.995000')` is 90071992547410,
  // ABOVE the published figure, so a `≥` printed a floor the truth can be below.
  //
  // ASSERTED ON THE RENDERER, through a synthetic row, exactly as the withheld-amount test below is and
  // for the reason stated there: the property has to hold for whatever the producer publishes, and
  // building a margin of this magnitude out of a revenue line and a cost would make the test about the
  // fixture rather than about the display. Both strings are what a schema-valid Decimal(20, 6) holds.
  workedExample([])
  const page = await pageCells()

  // A CEILING OVER A NEGATIVE FIGURE. The truth is at or below the published -90071992547409.995, so
  // the printed figure must be at or above it; toward +infinity at two decimals that is -…409.99.
  assert.equal(Number('-90071992547409.995000'), -90071992547410, 'float64 moves it the wrong way')
  const printedCeiling = page.cellOf('margin', { grossMarginBase: '-90071992547409.995000', grossMarginBaseBound: 'upper' })
  assert.match(printedCeiling, / ≤$/)
  assert.ok(
    printedNumber(printedCeiling).gte(D('-90071992547409.995')),
    `a ≤ over a negative prints ${printedCeiling}, below the -90071992547409.995 it is a ceiling for`,
  )
  assert.equal(printedCeiling, '-£90,071,992,547,409.99 ≤')

  // THE MIRROR: a floor, where the truth is at or ABOVE the published figure and the printed number
  // must therefore be at or below it. Toward -infinity that is …409.99, never …410.00.
  assert.equal(Number('90071992547409.995000'), 90071992547410, 'float64 moves it the wrong way')
  const printedFloor = page.cellOf('margin', { grossMarginBase: '90071992547409.995000', grossMarginBaseBound: 'lower' })
  assert.match(printedFloor, / ≥$/)
  assert.ok(
    printedNumber(printedFloor).lte(D('90071992547409.995')),
    `a ≥ prints ${printedFloor}, above the 90071992547409.995 it is a floor for`,
  )
  assert.equal(printedFloor, '£90,071,992,547,409.99 ≥')
})

test('the report itself explains why the rows do not add up to the total (Codex r3 MEDIUM)', async () => {
  // Codex round 3, verbatim: "`report.notices` contains no rounding/reconciliation notice, so operators
  // only see individually ceiled rows that may not sum to the independently ceiled total. The help
  // document explains this, but the report itself does not; across 500 rows the visible discrepancy can
  // approach £5 and look like a calculation defect."
  //
  // THE DISCREPANCY IS DELIBERATE AND NEITHER FIGURE IS WRONG. Each row is ceiled to its own penny and
  // the total is ceiled ONCE from the unrounded sum — which is what makes both of them sound bounds —
  // so the column misses the footer by up to a penny per row. Reconciling them the way o3d-8u4h's
  // supplier-ageing bands were reconciled is not available here: there the parent was a measurement and
  // the residue could be pushed into the largest component, while here both figures are bounds and
  // moving either to make them tally is what would make it false. So the only thing owed is the
  // explanation, and it has to travel WITH the figures.
  //
  // THE FIXTURE MAKES THE DISCREPANCY REAL rather than asserting a sentence into an empty report: three
  // products, each with an ex-VAT line of 1.001 and a 0.0001 GROSS credit of its own so each row is
  // bounded. Nothing is deducted (the credit is not the figure's unit), so each row publishes 1.001 and
  // ceils to 1.01 — 3.03 down the column — while the period publishes 3.003 and ceils once to 3.01.
  const line = (id: string, productId: string) => ({ id, productId, totalBase: '1.001' })
  COGS_ROWS = [
    cogsEntry({ id: 'c1', orderId: 'O1', productId: 'p1', qty: '1', cost: '0', line: line('L1', 'p1') }),
    cogsEntry({ id: 'c2', orderId: 'O1', productId: 'p2', qty: '1', cost: '0', line: line('L2', 'p2') }),
    cogsEntry({ id: 'c3', orderId: 'O1', productId: 'p9', qty: '1', cost: '0', line: line('L9', 'p9') }),
  ]
  ORDERS = [order('O1', [{ productId: 'p1', totalBase: '1.001' }, { productId: 'p2', totalBase: '1.001' }, { productId: 'p9', totalBase: '1.001' }])]
  CREDIT_LINES = [
    creditAgainstLine('L1', 'O1', 'p1', '0.0001', 'GROSS'),
    creditAgainstLine('L2', 'O1', 'p2', '0.0001', 'GROSS'),
    creditAgainstLine('L9', 'O1', 'p9', '0.0001', 'GROSS'),
  ]
  FILTER_PRODUCT_IDS = [...ALL_FIXTURE_PRODUCTS]

  const page = await pageCells()
  assert.equal(page.rows.length, 3, 'the three groups the example needs')
  // THE READER'S CHECK, at the precision the reader sees: add the column up and compare it with the
  // footer. Asserted as a real inequality, because a notice explaining a discrepancy that does not
  // happen would be noise, and this test would then be proof of nothing.
  const columnSum = page.rows
    .map((row) => printedNumber(page.cellOf('revenue', row)))
    .reduce((total, value) => total.add(value), D(0))
  const footer = printedNumber(page.footer('revenue'))
  assert.equal(columnSum.toString(), '3.03', 'three rows of 1.001, each ceiled to its own penny')
  assert.equal(footer.toString(), '3.01', 'and the period ceiled once from the unrounded 3.003')
  assert.ok(columnSum.gt(footer), 'the fixture must actually show the discrepancy the notice explains')
  // Both are sound over the unrounded 3.003, which is why neither may be moved to make them tally.
  assert.ok(footer.gte(D('3.003')) && columnSum.gte(D('3.003')))

  // AND THE EXPLANATION IS IN THE PAYLOAD THE PAGE RENDERS — the constant itself, not a paraphrase, so
  // the page and the CSV cannot drift apart on what it says.
  const { BOUNDED_FIGURE_ROUNDING_NOTICE_COGS } = await import('@/lib/analytics/refund-figure-surfaces')
  assert.ok(
    page.notices.includes(BOUNDED_FIGURE_ROUNDING_NOTICE_COGS),
    `the rounding notice never reached the page; notices were: ${JSON.stringify(page.notices)}`,
  )
  // It has to say the USEFUL thing, not merely exist: that the two are not expected to sum, and how
  // large the visible gap can get. A notice that only said "figures are rounded" would leave the
  // operator exactly where the finding found them.
  assert.match(BOUNDED_FIGURE_ROUNDING_NOTICE_COGS, /not expected to add up/)
  assert.match(BOUNDED_FIGURE_ROUNDING_NOTICE_COGS, /penny per row/)

  // THE FILE READER IS THE ONE WHO PUTS `=SUM()` UNDER THE COLUMN, so the CSV carries the same
  // sentence in the only channel it has. Untruncated, for the reason the metadata test below gives.
  const { metadata } = await csvRows()
  assert.equal(metadata.get('metadataTruncated'), undefined, 'the metadata must still fit; see headerMetadata in lib/csv.ts')
  assert.equal(metadata.get('roundingReconciliation'), BOUNDED_FIGURE_ROUNDING_NOTICE_COGS)
})

// ---------------------------------------------------------------------------------------------
// The CSV — a file reader has no tooltip
// ---------------------------------------------------------------------------------------------

test('the CSV gives every bounded figure its OWN column, immediately right of it (o3d-rv4a)', async () => {
  workedExample([creditAgainstLine('L1', 'O1', 'p1', '120', 'GROSS')], '150')
  const { header, rows } = await csvRows()
  for (const [figure, bound] of [
    ['revenueBase', 'revenueBaseBound'],
    ['grossMarginBase', 'grossMarginBaseBound'],
    ['grossMarginPct', 'grossMarginPctBound'],
  ]) {
    assert.ok(header.includes(bound!), `${bound} is missing from the file`)
    assert.equal(header.indexOf(bound!), header.indexOf(figure!) + 1, `${bound} must sit immediately right of ${figure}`)
  }
  // Basis-independent columns get no bound, because marking them would be noise.
  for (const key of ['qty', 'cogsBase', 'movementCount']) {
    assert.ok(!header.includes(`${key}Bound`), `${key} does not move with the refund basis`)
  }
  const [row] = rows
  // The same three verdicts the page prints, and the ratio disagreeing with the linear pair INSIDE
  // ONE FILE. A single shared flag column could not have said this.
  assert.equal(row!.revenueBase, '100.000000')
  assert.equal(row!.revenueBaseBound, 'upper')
  assert.equal(row!.grossMarginBase, '-50.000000')
  assert.equal(row!.grossMarginBaseBound, 'upper')
  assert.equal(row!.grossMarginPct, '-50')
  assert.equal(row!.grossMarginPctBound, 'indeterminate')
  assert.equal(row!.refundsGrossBasis, '120.000000')
  assert.equal(row!.refundsNetBasis, '0.000000')
})

test('the CSV carries the period totals and their bounds as metadata, untruncated (o3d-rv4a)', async () => {
  // A bound that exists only on the page is a disclosure the file reader never sees. The off-report
  // credit and the totals' own markers exist nowhere in `rows`, so they travel as `totals.<name>`
  // comment rows — and the assertion that the metadata was NOT truncated is load-bearing: the helper
  // silently drops everything but a handful of essential keys past 4096 bytes, which would take the
  // whole disclosure with it.
  workedExample([creditAgainstLine('L9', 'O1', 'p9', '10', 'NET')])
  const { metadata } = await csvRows()
  assert.equal(metadata.get('metadataTruncated'), undefined, 'the metadata must fit; see headerMetadata in lib/csv.ts')
  assert.equal(metadata.get('totals.revenueBaseBound'), 'upper')
  assert.equal(metadata.get('totals.grossMarginBaseBound'), 'upper')
  assert.equal(metadata.get('totals.refundsOutsideReportNetBasis'), '10.000000')
  assert.equal(metadata.get('totals.refundsUnattributedNetBasis'), '0.000000')
  const treatment = metadata.get('refundTreatment') ?? ''
  assert.match(treatment, /net-basis credit/)
  assert.doesNotMatch(treatment, /Refunds are NOT deducted/)
})

test('the report’s own notice names the basis it deducted and no longer claims blindness (o3d-rv4a)', async () => {
  workedExample([])
  const page = await pageCells()
  const notice = page.notices.find((line) => /net-basis credit/.test(line))
  assert.ok(notice, `no basis notice reached the page; notices were: ${JSON.stringify(page.notices)}`)
  for (const stale of [/Refunds are NOT deducted/, /keeps its full revenue and margin/, /refund-aware net revenue/]) {
    assert.ok(!page.notices.some((line) => stale.test(line)), `the round-5 disclosure is still on the page: ${stale}`)
  }
})

// ---------------------------------------------------------------------------------------------
// The mark is a fact about the bound, and no branch the cell controls may suppress it
// ---------------------------------------------------------------------------------------------

test('a withheld AMOUNT still prints the relation the producer published (o3d-la3n r3)', async () => {
  // o3d-la3n round 2 composed amount and mark into one string and let a `show` predicate branch
  // around the whole of it, so a row that owed "— ≥" printed a bare em dash. The fix was to pass the
  // amount RENDERER into the marker and append the mark after it, outside every branch the cell
  // controls. This report's own withheld amount is `Unmatched`, and it is that branch.
  //
  // A ROW LIKE THIS IS NOT REACHABLE FROM TODAY'S PRODUCER — it publishes a null bound with a null
  // amount — so the property is asserted directly on the renderer rather than through a fixture.
  // That is deliberate: the structure has to hold for whatever the producer publishes next, and a
  // test that could only reach it through today's producer would be a test of today's coincidence.
  workedExample([])
  const page = await pageCells()
  const row = { revenueBase: null, revenueBaseBound: 'upper', grossMarginBase: null, grossMarginBaseBound: 'lower', grossMarginPct: null, grossMarginPctBound: 'indeterminate' }
  assert.equal(page.cellOf('revenue', row), 'Unmatched ≤')
  assert.equal(page.cellOf('margin', row), 'Unmatched ≥')
  assert.equal(page.cellOf('marginPct', row), 'Unmatched ?')
})

test('the credit-share helper refuses a negative share rather than inverting the interval (o3d-rv4a)', async () => {
  // `Σ max(k·e, 0) = k · Σ max(e, 0)` holds only for k >= 0. A negative share would swap the
  // interval's ends and turn a sound ceiling into a claim the figure cannot support, so the helper
  // refuses instead of documenting the precondition. Asserted here because a defensive throw nothing
  // exercises is a comment with a stack trace.
  const { emptyCredits, scaleCredits } = await import('@/lib/domain/sales/refund-credit-buckets')
  assert.throws(() => scaleCredits(emptyCredits(), D('-1'), D('4')), /non-negative share/)
  assert.throws(() => scaleCredits(emptyCredits(), D('1'), D('0')), /non-negative share/)
  // And the share is taken as `value * numerator / denominator`, in that order — the same expression
  // the revenue allocation beside it uses. A third of 100 is 33.33… in both, so the two halves of the
  // subtraction carry the same residual instead of drifting apart.
  const buckets = emptyCredits()
  buckets.net = D('100')
  assert.equal(scaleCredits(buckets, D('1'), D('3')).net.toString(), D('100').mul(1).div(3).toString())
})
