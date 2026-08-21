/**
 * THE PINNED INVENTORY OF EVERY SURFACE THAT PUBLISHES A REVENUE / PROFIT / MARGIN / NET / AOV
 * FIGURE, AND WHAT EACH ONE DOES ABOUT REFUNDS.
 *
 * -----------------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * -----------------------------------------------------------------------------------------------
 * o3d-iigc ran four rounds. Each one declared its enumeration complete. Each one was wrong:
 *
 *   round 1  fixed two surfaces a sibling had left, and missed two more.
 *   round 2  found them, and diagnosed the miss — the sweep had followed a helper module's
 *            IMPORTERS instead of its DOCSTRINGS, and two dead exports were the receipt.
 *   round 3  fixed the table cells and missed the summary cards, the dashboard and the exports.
 *   round 4  swept BY PRODUCER, found a fifth surface, declared the consumer list complete — and
 *            walked straight past `dashboard.ts` `topProducts.netRevenue`, filing it in its own
 *            notes as "a naming issue, not a basis one". It was the same defect. Round 5 fixed it.
 *
 * Four different search strategies, four misses. The common failure is that every one of them
 * searched by RELATIONSHIP — who imports what, who calls what, who produces what — and a surface
 * that participates in no relationship the searcher happened to traverse is invisible. So round 5
 * swept by FIELD NAME instead: every identifier in the repository whose name contains revenue,
 * profit, margin, netSales/netTotal/netAmount/netValue, avgOrder/aov, grossSales or turnover,
 * whether it is DECLARED (a producer emitting it), READ (`row.netRevenue` — a consumer rendering
 * it), or QUOTED (a CSV column key). A name cannot hide from that; a relationship can.
 *
 * The result is pinned below, and `tests/analytics/refund-figure-surface-coverage.test.ts` re-runs
 * that sweep on every test run and fails on anything it finds that is not listed here. A SEVENTH
 * SURFACE THEREFORE CANNOT ARRIVE SILENTLY: it arrives as a red test naming the file and the field,
 * and the only way to make it green is to write down what that figure does about refunds.
 *
 * -----------------------------------------------------------------------------------------------
 * WHAT THE THREE TREATMENTS MEAN
 * -----------------------------------------------------------------------------------------------
 * `basis-aware`          The figure buckets each refund by its stamped basis, subtracts only the
 *                        NET-basis credit from an ex-VAT figure, reports the credit it could not
 *                        place, and publishes a bound marker. This is the fixed state.
 *
 * `refund-blind`         The figure deliberately does not net off refunds. THIS IS SOMETIMES
 *                        CORRECT — a gross-sales tile, a lifetime-turnover figure and a
 *                        product-ranking are all legitimately refund-blind — and sometimes it is a
 *                        defect that is declared and disclosed rather than fixed today. Either way
 *                        blindness becomes a STATED PROPERTY instead of an oversight, and where the
 *                        figure could be mistaken for a net one the entry carries a `disclosure`
 *                        that must appear at the render site.
 *
 * `not-refund-sensitive` No refund can move the figure: ledger postings, account-code settings,
 *                        COGS-only ratios, and a couple of identifiers that merely LOOK like
 *                        figures (PDF page margins). Listed anyway — deciding what is "obviously
 *                        not a figure" before you look is how you skip the one that was.
 *
 * -----------------------------------------------------------------------------------------------
 * KEEP THIS FILE IMPORT-FREE
 * -----------------------------------------------------------------------------------------------
 * For the same reason `derived-figure-bound.ts` is: the disclosure strings are read by server
 * report producers AND could reasonably be read by a page, and a stray import here would drag
 * whatever it pulls into a browser chunk. Data and strings only.
 */

export type RefundTreatment = 'basis-aware' | 'refund-blind' | 'not-refund-sensitive'

export type RefundFigureSurface = {
  /** Repo-relative POSIX path of the file the sweep found. */
  file: string
  /**
   * Every figure-named identifier the sweep finds in that file. Pinned at this granularity ON
   * PURPOSE: round 4's miss was a NEW figure inside an ALREADY-LISTED file, so a file-level pin
   * would not have caught the very thing this inventory exists to catch.
   */
  figures: readonly string[]
  treatment: RefundTreatment
  /** Why. Every entry has one — an entry without a reason is the oversight, just written down. */
  reason: string
  /**
   * For a `refund-blind` figure a reader could mistake for a net one: the sentence they must be
   * shown. The coverage test asserts this exact string is present in `file`, so deleting the
   * notice fails the build rather than quietly restoring the blindness.
   */
  disclosure?: string
}

// ---------------------------------------------------------------------------------------------
// The disclosures. One constant per report family, imported by the producer AND (for the CSVs) by
// the export route, so the page and the file cannot drift apart on what the figure means.
// ---------------------------------------------------------------------------------------------

/** Sales report: order-level totals, no refund loaded at all. */
export const REFUND_BLIND_NOTICE_SALES =
  'Refunds are NOT deducted: these are order totals as invoiced, so a credited or returned order still contributes its full revenue, tax, shipping and discount. Use the Returns report for credit values, and Sales Statistics for a refund-aware net revenue.'

/** Customer Mix: revenue/gross profit/share from SalesOrder.totalBase. */
export const REFUND_BLIND_NOTICE_CUSTOMER_MIX =
  'Refunds are NOT deducted: customer revenue, gross profit and share of revenue are built from order totals as invoiced, so a customer who returned everything still ranks on what they originally bought. Use Sales Statistics for a refund-aware net revenue.'

/** Gross Margin: ex-VAT dispatched line revenue against posted COGS. */
export const REFUND_BLIND_NOTICE_GROSS_MARGIN =
  'Refunds are NOT deducted: revenue, gross profit, margin and contribution are built from dispatched sales-line revenue, so a fully credited sale still shows its original revenue and margin here. Use Sales Statistics for a refund-aware net revenue and its stated bounds.'

/** COGS / inventory-turnover: revenue attributed back to the original sales line. */
export const REFUND_BLIND_NOTICE_COGS_MARGIN =
  'Refunds are NOT deducted: revenue and gross margin are attributed from the original sales line behind each dispatch, so a returned sale keeps its full revenue and margin in this report. Use Sales Statistics for a refund-aware net revenue.'

/** What the Returns report prints where a period's credit is not on one basis. */
export const RETURNS_MIXED_BASIS_MARKER = 'Mixed basis'

/** Why it prints that. */
export const RETURNS_MIXED_BASIS_NOTICE =
  'Refund values are shown on their own recorded basis. Where a row or the period mixes NET (ex-VAT) and GROSS (VAT-inclusive) credits, no single total is shown — adding the two gives an amount on neither basis — and the NET, GROSS and unproven-basis columns carry the whole credit instead. Rows with no single stated value sort last.'

// ---------------------------------------------------------------------------------------------
// The inventory. Generated from the field-name sweep, then classified by hand, one file at a time.
// ---------------------------------------------------------------------------------------------

export const REFUND_FIGURE_SURFACES: readonly RefundFigureSurface[] = [
  {
    file: 'app/(dashboard)/analytics/_components/sales-analytics-page-utils.ts',
    figures: ['grossProfitBase', 'loadMarginAnalyticsReportForPage', 'margin', 'marginPct', 'revenue', 'revenueBase'],
    treatment: 'refund-blind',
    reason:
      'Loader/empty-totals shim for the six sales analytics reports. It carries their figure names but computes nothing; the treatment is the producer’s, and the empty-totals fallback publishes zeroes only when the source scan was refused, which the page states separately.',
  },
  {
    file: 'app/(dashboard)/analytics/_components/sales-analytics-report.tsx',
    figures: ['margin'],
    treatment: 'not-refund-sensitive',
    reason:
      '`margin` here is the report-key union member for the Gross Margin page, not a figure.',
  },
  {
    file: 'app/(dashboard)/analytics/cogs/page.tsx',
    figures: ['grossMarginBase', 'grossMarginPct', 'margin', 'marginPct', 'revenue', 'revenueBase', 'revenueCapturedRows'],
    treatment: 'refund-blind',
    reason:
      'Renders getCogsReport revenue/gross margin. Refund-blind by the producer; the disclosure is carried in report.notices, which this page renders.',
  },
  {
    file: 'app/(dashboard)/analytics/customers/page.tsx',
    figures: ['grossProfitBase', 'profit', 'revenue', 'revenueBase', 'shareOfRevenuePct'],
    treatment: 'refund-blind',
    reason:
      'Renders getCustomerAnalyticsReport revenue/gross profit/share. Refund-blind by the producer; the disclosure is carried in report.notices, which this page renders.',
  },
  {
    file: 'app/(dashboard)/analytics/inventory-turnover/page.tsx',
    figures: ['turnover', 'turnoverRatio'],
    treatment: 'not-refund-sensitive',
    reason:
      'Turnover ratio and days-inventory-outstanding are COGS ÷ average inventory value. No refund line moves either input.',
  },
  {
    file: 'app/(dashboard)/analytics/margin/page.tsx',
    figures: ['grossProfitBase', 'margin', 'marginPct', 'profit', 'revenue', 'revenueBase'],
    treatment: 'refund-blind',
    reason:
      'Renders getMarginAnalyticsReport revenue/gross profit/margin/contribution. Refund-blind by the producer; the disclosure is carried in report.notices, which this page renders.',
  },
  {
    file: 'app/(dashboard)/analytics/product-profitability/product-profitability-client.tsx',
    figures: ['currentFyProfit', 'currentFyRevenue', 'previousFyProfit', 'previousFyRevenue', 'unitMargin', 'unitMarginPct'],
    treatment: 'basis-aware',
    reason:
      'Renders the FY revenue/profit bounds and the unplaced-credit columns from app/actions/product-profitability.ts.',
  },
  {
    file: 'app/(dashboard)/analytics/purchase-stats/purchase-stats-client.tsx',
    figures: ['netAmount'],
    treatment: 'basis-aware',
    reason:
      'Renders the consistent-net purchase figure and its return-credit basis.',
  },
  {
    file: 'app/(dashboard)/analytics/sales-stats/sales-stats-client.tsx',
    figures: ['avgMarginPct', 'avgMarginPctBound', 'avgOrderValue', 'grossProfit', 'grossRevenue', 'marginBoundTitle', 'marginPct', 'marginPctBound', 'netRevenue', 'netTotal', 'netTotalBasis', 'totalGrossProfit', 'totalGrossRevenue', 'totalNetRevenue'],
    treatment: 'basis-aware',
    reason:
      'Renders every bounded sales-statistics figure, cards included, with the ratio marked separately from the linear figures.',
  },
  {
    file: 'app/(dashboard)/analytics/sales/page.tsx',
    figures: ['revenue'],
    treatment: 'refund-blind',
    reason:
      'Renders getSalesAnalyticsReport revenue/tax/shipping/discount. Refund-blind by the producer; the disclosure is carried in report.notices, which this page renders.',
  },
  {
    file: 'app/(dashboard)/dashboard/dashboard-client.tsx',
    figures: ['avgOrderValue', 'bestSellerMarginTitle', 'bestSellerRevenueTitle', 'compMarginPct', 'compMarginPctBound', 'compNetSales', 'compNetSalesUpperBound', 'grossSalesComparison', 'grossSalesCurrent', 'marginBoundComparison', 'marginBoundCurrent', 'marginChartTooltip', 'marginComparison', 'marginCurrent', 'marginPct', 'marginPctBound', 'marginTooltipFormatter', 'netRevenue', 'netRevenueBound', 'netSales', 'netSalesComparison', 'netSalesCurrent', 'netSalesTooltipFormatter', 'netSalesUpperBound', 'profitCurrent'],
    treatment: 'basis-aware',
    reason:
      'Renders the KPI cards, both chart tooltips per bucket, the cash-bridge bars and (round 5) the Best Sellers rows with their bound markers.',
  },
  {
    file: 'app/(dashboard)/sales/[id]/so-detail-client.tsx',
    figures: ['margin', 'marginPct', 'profitMarginPercent', 'revenueBase'],
    treatment: 'refund-blind',
    reason:
      'ONE order’s margin, on the page that lists that order’s own refunds directly beneath it. The reader can see every credit that would move it, so a period-level bound would add nothing a scroll does not.',
  },
  {
    file: 'app/(dashboard)/sales/contacts/[id]/customer-detail-client.tsx',
    figures: ['annualTurnoverBase', 'totalTurnoverBase'],
    treatment: 'refund-blind',
    reason:
      'Customer turnover: a GROSS, VAT-inclusive lifetime sales figure that excludes fully-refunded orders by status. Deliberately gross-sales, which is legitimately refund-blind; partial credits are not netted and the label says turnover, not net.',
  },
  {
    file: 'app/(dashboard)/sales/so-list-client.tsx',
    figures: ['profit', 'profitMarginPercent'],
    treatment: 'refund-blind',
    reason:
      'Per-order margin column, same reading as the order detail page.',
  },
  {
    file: 'app/(dashboard)/sync/accounting-settings-fields.ts',
    figures: ['unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Unearned-revenue ACCOUNT CODE setting. A ledger account, not a figure.',
  },
  {
    file: 'app/(dashboard)/sync/xero-client.tsx',
    figures: ['revenue', 'totalRevenue'],
    treatment: 'not-refund-sensitive',
    reason:
      'Daily-batch journal preview totals. Ledger postings, whose refund handling is the batch’s own reversal logic, not an analytics basis question.',
  },
  {
    file: 'app/actions/accounting-batch.ts',
    figures: ['totalRevenue'],
    treatment: 'not-refund-sensitive',
    reason:
      'Daily-batch journal total. Ledger posting.',
  },
  {
    file: 'app/actions/company.ts',
    figures: ['margin'],
    treatment: 'not-refund-sensitive',
    reason:
      '`margin` appears only in inline CSS of a test email template.',
  },
  {
    file: 'app/actions/customers.ts',
    figures: ['annualTurnoverBase', 'revenueOrders', 'totalTurnoverBase'],
    treatment: 'refund-blind',
    reason:
      'Customer turnover producer — see the customer detail client. Gross, by label and by design.',
  },
  {
    file: 'app/actions/dashboard.ts',
    figures: ['avgOrderValue', 'compMarginPct', 'compMarginPctBound', 'compNetSales', 'compNetSalesUpperBound', 'grossSales', 'grossSalesComparison', 'grossSalesCurrent', 'marginBoundComparison', 'marginBoundCurrent', 'marginComparison', 'marginCurrent', 'marginPct', 'marginPctBound', 'netRevenue', 'netRevenueBound', 'netSales', 'netSalesComparison', 'netSalesCurrent', 'netSalesUpperBound', 'profitCurrent'],
    treatment: 'basis-aware',
    reason:
      'KPIs, chart buckets and (round 5) Best Sellers all bucket refunds by stamped basis, subtract only NET, and publish a bound.',
  },
  {
    file: 'app/actions/forecasting.ts',
    figures: ['productsByRevenue', 'revenueByProduct', 'totalRevenue'],
    treatment: 'refund-blind',
    reason:
      'ABC classification ranks products by cumulative line revenue share. A RANKING, not a published money figure; it exposes no revenue number to a reader.',
  },
  {
    file: 'app/actions/product-profitability.ts',
    figures: ['currentFyProfit', 'currentFyRevenue', 'getProductProfitability', 'previousFyProfit', 'previousFyRevenue', 'revenue', 'unitMargin', 'unitMarginPct'],
    treatment: 'basis-aware',
    reason:
      'FY revenue/profit bucket refunds by basis and publish per-FY bounds.',
  },
  {
    file: 'app/actions/purchase-stats.ts',
    figures: ['netAmount'],
    treatment: 'basis-aware',
    reason:
      'Supplier aging net amount: consistent-net, with the return credit proved net rather than assumed.',
  },
  {
    file: 'app/actions/quickbooks-daily-batch.ts',
    figures: ['totalRevenue'],
    treatment: 'not-refund-sensitive',
    reason:
      'Ledger posting (and out of scope by owner instruction).',
  },
  {
    file: 'app/actions/quickbooks-sync.ts',
    figures: ['quickbooks_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Unearned-revenue account setting key (and out of scope by owner instruction).',
  },
  {
    file: 'app/actions/sales-stats.ts',
    figures: ['avgMarginPct', 'avgMarginPctBound', 'avgOrderValue', 'grossProfit', 'grossRevenue', 'marginPct', 'marginPctBound', 'netRevenue', 'netTotal', 'netTotalBasis', 'totalGrossProfit', 'totalGrossRevenue', 'totalNetRevenue'],
    treatment: 'basis-aware',
    reason:
      'The original basis-aware producer; round 5 moved its period totals and margin bound onto unrounded aggregates.',
  },
  {
    file: 'app/actions/sales.ts',
    figures: ['profitMarginPercent', 'revenueDeferredBatchRef', 'revenueDeferredDate'],
    treatment: 'refund-blind',
    reason:
      'Per-order profitMarginPercent plus revenue-deferral ledger fields. Same reading as the order detail page.',
  },
  {
    file: 'app/actions/xero-daily-batch.ts',
    figures: ['bRevenue', 'proportionalRevenue', 'revenue', 'revenueDeferredDate', 'revenueProportion', 'revenueRecognizedAmount', 'runningRevenue', 'totalRevenue', 'unearnedRevenueAmount', 'xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Revenue deferral/recognition journal amounts. Ledger postings.',
  },
  {
    file: 'app/actions/xero-sync.ts',
    figures: ['xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Unearned-revenue account setting key.',
  },
  {
    file: 'app/api/export/analytics/route.ts',
    figures: ['avgOrderValue', 'avgOrderValueBound', 'grossProfit', 'grossProfitBound', 'grossRevenue', 'marginPct', 'marginPctBound', 'netAmount', 'netAmountExVat', 'netRevenue', 'netRevenueBound', 'netTotal', 'netTotalBasis'],
    treatment: 'basis-aware',
    reason:
      'Every bounded figure carries its OWN bound column beside it, because a file reader has no tooltip.',
  },
  {
    file: 'app/api/export/inventory-costing/route.ts',
    figures: ['getInventoryTurnoverReport', 'grossMarginBase', 'grossMarginPct', 'revenueBase', 'revenueCaptured', 'turnoverRatio'],
    treatment: 'refund-blind',
    reason:
      'COGS/turnover CSV. Carries the disclosure as export metadata comment rows, which is this repo’s CSV-side equivalent of a notice.',
    disclosure: REFUND_BLIND_NOTICE_COGS_MARGIN,
  },
  {
    file: 'app/api/export/sales-analytics/route.ts',
    figures: ['grossProfitBase', 'margin', 'marginPct', 'revenue', 'revenueBase', 'shareOfRevenuePct'],
    treatment: 'refund-blind',
    reason:
      'Sales/customers/margin CSVs. Carry the producer’s disclosure as export metadata comment rows.',
    disclosure: REFUND_BLIND_NOTICE_GROSS_MARGIN,
  },
  {
    file: 'lib/accounting.ts',
    figures: ['quickbooks_unearned_revenue_account', 'unearnedRevenueAccount', 'xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Unearned-revenue account resolution. Ledger account.',
  },
  {
    file: 'lib/connectors/quickbooks/daily-sync.ts',
    figures: ['proportionalRevenue', 'quickbooks_unearned_revenue_account', 'revenue', 'revenueDeferredBatchRef', 'revenueDeferredDate', 'revenueProportion', 'revenueRecognizedAmount', 'runningRevenue', 'totalRevenue', 'totalRevenueDeferred', 'unearnedRevenueAmount'],
    treatment: 'not-refund-sensitive',
    reason:
      'Ledger posting (out of scope by owner instruction).',
  },
  {
    file: 'lib/connectors/quickbooks/payment-poller.ts',
    figures: ['revenueDeferredDate'],
    treatment: 'not-refund-sensitive',
    reason:
      'Ledger deferral date (out of scope by owner instruction).',
  },
  {
    file: 'lib/connectors/quickbooks/settings.ts',
    figures: ['quickbooks_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Account setting key (out of scope by owner instruction).',
  },
  {
    file: 'lib/connectors/xero/daily-sync.ts',
    figures: ['proportionalRevenue', 'revenue', 'revenueDeferredBatchRef', 'revenueDeferredDate', 'revenueProportion', 'revenueRecognizedAmount', 'runningRevenue', 'totalRevenue', 'totalRevenueDeferred', 'unearnedRevenueAmount', 'xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Revenue deferral/recognition journal amounts. Ledger postings.',
  },
  {
    file: 'lib/connectors/xero/payment-poller.ts',
    figures: ['revenueDeferredDate'],
    treatment: 'not-refund-sensitive',
    reason:
      'Ledger deferral date.',
  },
  {
    file: 'lib/connectors/xero/settings.ts',
    figures: ['xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Account setting key.',
  },
  {
    file: 'lib/domain/accounting/daily-batch-preview.ts',
    figures: ['revenueDeferredDate', 'totalRevenue'],
    treatment: 'not-refund-sensitive',
    reason:
      'Ledger posting preview.',
  },
  {
    file: 'lib/domain/accounting/daily-batch-reference.ts',
    figures: ['revenueDeferredBatchRef'],
    treatment: 'not-refund-sensitive',
    reason:
      'Batch reference string.',
  },
  {
    file: 'lib/domain/accounting/deferred-trueup.ts',
    figures: ['unearnedRevenueAccount'],
    treatment: 'not-refund-sensitive',
    reason:
      'Deferred-revenue true-up posting. It moves a ledger balance, not a report figure; no refund basis question arises.',
  },
  {
    file: 'lib/domain/accounting/invariants.ts',
    figures: ['postedRevenue', 'recognizedRevenueTotal', 'revenueDeferredBatchRef', 'revenueDeferredDate', 'revenueRecognizedAmount', 'revenue_posted_without_payment', 'sales_order_inventory_allocated_without_revenue_deferral', 'sales_order_recognized_revenue_deferral_mismatch', 'sales_order_revenue_deferral_missing_amount', 'sales_order_revenue_deferral_without_sync_evidence', 'shipment_posted_missing_revenue_amount', 'unearnedRevenueAmount'],
    treatment: 'not-refund-sensitive',
    reason:
      'Ledger invariant codes and amounts.',
  },
  {
    file: 'lib/domain/accounting/reconciliation.ts',
    figures: ['revenueDeferredBatchRef', 'revenueDeferredDate', 'source_order_revenue_deferral_without_event'],
    treatment: 'not-refund-sensitive',
    reason:
      'Ledger reconciliation codes.',
  },
  {
    file: 'lib/domain/accounting/revenue-recognition.ts',
    figures: ['proportionalRevenue', 'recognizeShipmentRevenue', 'runningRevenue'],
    treatment: 'not-refund-sensitive',
    reason:
      'Shipment revenue recognition posting.',
  },
  {
    file: 'lib/domain/accounting/reversal-handling.ts',
    figures: ['revenueDeferredDate'],
    treatment: 'not-refund-sensitive',
    reason:
      'Reversal of a posted revenue-deferral journal. A ledger operation, not a published figure.',
  },
  {
    file: 'lib/domain/inventory/inventory-costing-reports.ts',
    figures: ['aggregateInventoryTurnoverRows', 'aggregateInventoryTurnoverTotalAverage', 'assertInventoryTurnoverSourceLimit', 'emptyInventoryTurnoverReportForSourceLimit', 'getInventoryTurnoverReport', 'grossMarginBase', 'grossMarginPct', 'groupRevenue', 'isInventoryTurnoverGroupBy', 'lineRevenueByKey', 'loadRevenueByOrderProduct', 'qtyByRevenueKey', 'resolveCogsRevenueKeys', 'resolvedRevenue', 'revenue', 'revenueBase', 'revenueByOrderProduct', 'revenueCaptured', 'revenueCapturedRows', 'revenueKey', 'turnover', 'turnoverGroupMetas', 'turnoverRatio', 'unkeyedRevenue'],
    treatment: 'refund-blind',
    reason:
      'COGS report revenue/gross margin and the turnover report. Revenue is the ORIGINAL ex-VAT sales-line total attributed through the dispatch; no refund line is loaded, so a credited sale still shows its full revenue and margin. Declared and disclosed rather than fixed — the fix needs refund lines attributed through the same order/product and line-linked keys, which is filed.',
    disclosure: REFUND_BLIND_NOTICE_COGS_MARGIN,
  },
  {
    file: 'lib/domain/inventory/inventory-health-reports.ts',
    figures: ['revenueBase'],
    treatment: 'refund-blind',
    reason:
      'revenueBase is a caller-supplied attribution input for dead-stock/health grouping; it is not published as a money figure by any report row.',
  },
  {
    file: 'lib/domain/inventory/velocity.ts',
    figures: ['calculateInventoryTurnover', 'revenue', 'revenueBase', 'turnoverRatio'],
    treatment: 'refund-blind',
    reason:
      'revenueBase is a per-sale velocity input used for ABC value ranking; turnover is COGS-based. No revenue figure is published.',
  },
  {
    file: 'lib/domain/sales/order-delete-guard.ts',
    figures: ['revenueDeferredBatchRef', 'revenueDeferredDate'],
    treatment: 'not-refund-sensitive',
    reason:
      'Ledger deferral fields read as a delete precondition.',
  },
  {
    file: 'lib/domain/sales/refund-basis-analytics.ts',
    figures: ['margin', 'marginFigureBound', 'netRevenue', 'netTotal'],
    treatment: 'basis-aware',
    reason:
      'The classifier every basis-aware surface reads. Establishes the basis and the bound; converts nothing.',
  },
  {
    file: 'lib/domain/sales/refund-basis-audit.ts',
    figures: ['orderNetTotal'],
    treatment: 'basis-aware',
    reason:
      'Proves a stored refund’s basis from its linked-line evidence. This is where a stamp comes from.',
  },
  {
    file: 'lib/domain/sales/refund-service.ts',
    figures: ['aUnitRevenue', 'assignedRevenue', 'bUnitRevenue', 'nonQtyRevenue', 'refundRevenue', 'revenueDeferredBatchRef', 'revenueDeferredDate', 'revenueRecognizedAmount', 'shippedQtyRevenue', 'shippedRevenue', 'toNetRevenue', 'unearnedRevenueAccount', 'unearnedRevenueAmount', 'unitRevenue', 'unshippedQtyRevenue', 'unshippedRevenue'],
    treatment: 'not-refund-sensitive',
    reason:
      'The refund WRITER. It creates the rows the reports classify; it publishes no report figure.',
  },
  {
    file: 'lib/domain/sales/sales-fulfillment-analytics.ts',
    figures: ['getMarginAnalyticsReport', 'grossProfit', 'grossProfitBase', 'marginCogsBucket', 'marginGraph', 'marginPct', 'marginRequirementsByLine', 'revenue', 'revenueBase', 'revenueDecimal', 'shareOfRevenuePct', 'totalGrossProfit', 'totalRevenue', 'unitRevenue'],
    treatment: 'refund-blind',
    reason:
      'Sales, Customer Mix and Gross Margin publish revenue/profit/margin with NO refund loaded at all. Declared and disclosed here rather than fixed; the Returns report in the same module WAS fixed in round 5 because its defect was a mixed-basis sum used as a sort key.',
    disclosure: REFUND_BLIND_NOTICE_GROSS_MARGIN,
  },
  {
    file: 'lib/pdf.ts',
    figures: ['margins'],
    treatment: 'not-refund-sensitive',
    reason:
      'PDF page margins — a layout inset, not a money figure.',
  },
  {
    file: 'scripts/commerce-accounting-e2e-fixture.ts',
    figures: ['revenueBase', 'revenueDeferred', 'revenueDeferredDate', 'revenueRecognizedAmount', 'unearnedRevenueAmount', 'xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Test fixture seeding ledger fields.',
  },
  {
    file: 'scripts/generate-xero-demo-template.ts',
    figures: ['xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Demo template generator.',
  },
  {
    file: 'scripts/landed-cost-e2e-fixture.ts',
    figures: ['revenueDeferredDate', 'revenueRecognizedAmount', 'unearnedRevenueAmount', 'xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Test fixture seeding ledger fields.',
  },
  {
    file: 'scripts/repro-scjz68.ts',
    figures: ['revenueDeferredDate', 'revenueRecognizedAmount', 'unearnedRevenueAmount', 'xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Reproduction script seeding ledger fields.',
  },
  {
    file: 'scripts/xero-daily-batch-refund-fixture.ts',
    figures: ['revenueDeferredDate', 'revenueRecognizedAmount', 'shipmentRevenueRecognizedAmount', 'unearnedRevenueAmount', 'xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Test fixture seeding ledger fields.',
  },
]

/** Look a file up. Used by the coverage test and useful from a REPL when triaging a red run. */
export function refundFigureSurface(file: string): RefundFigureSurface | undefined {
  return REFUND_FIGURE_SURFACES.find((surface) => surface.file === file)
}
