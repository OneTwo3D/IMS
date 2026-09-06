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

/**
 * o3d-kyey REPLACED THE THREE `REFUND_BLIND_NOTICE_*` SENTENCES THESE REPORTS CARRIED.
 *
 * Round 5 declared the blindness rather than fixing it, on the grounds that a stated property beats
 * an oversight. It does — and a stated defect is still a defect. The three reports now bucket every
 * credit by its stamped basis, subtract only the bucket that is the same unit as the figure, publish
 * the rest beside it and mark what the figure then is. The sentences below say what the reader is
 * now looking at, and each one leads with WHICH CREDIT WAS TAKEN OFF, because "net of refunds" with
 * no basis named is the ambiguity that produced the original defect.
 */

/** Sales report: order totals as invoiced, with a gross-basis net figure beside them. */
export const REFUND_BASIS_NOTICE_SALES =
  'Revenue, tax, shipping and discount are order totals AS INVOICED, so they still reconcile to SalesOrder totals; a credited order keeps its full invoiced value in those columns. Net revenue beside them deducts the credit recorded on the same VAT-inclusive basis, and the net/unproven-basis credit columns carry what could not be deducted — where they are non-zero, net revenue is marked as at most (≤) the true figure. Rows are ranked on net revenue.'

/** Customer Mix: gross revenue as invoiced, plus a gross-basis net figure and an ex-VAT profit. */
export const REFUND_BASIS_NOTICE_CUSTOMER_MIX =
  'Revenue is order totals AS INVOICED (VAT-inclusive). Net revenue deducts the credit recorded on that same gross basis, and share of revenue is measured on it, so a customer who returned everything no longer ranks on what they originally bought. Gross profit is measured on the EX-VAT revenue less the net-basis credit, because COGS is ex-tax — it is NOT revenue minus gross profit. Credit that could not be placed on a figure’s basis is listed beside it and marks that figure as at most (≤) the true one.'

/** Gross Margin: ex-VAT dispatched line revenue, net of net-basis credit, against posted COGS. */
export const REFUND_BASIS_NOTICE_GROSS_MARGIN =
  'Revenue is dispatched ex-VAT sales-line revenue LESS the net-basis credit raised in the period, so a fully credited sale no longer shows its original revenue and margin. Gross-basis and unproven-basis credit is reported but not deducted, and marks revenue and gross profit as at most (≤) the true figures; margin and contribution are ratios whose numerator and denominator both move, so they are marked (?) instead — a bound exists but its direction is not established.'

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
    figures: ['grossProfitBase', 'grossProfitBaseBound', 'loadMarginAnalyticsReportForPage', 'margin', 'marginPct', 'marginPctBound', 'netRevenue', 'netRevenueBase', 'netRevenueBaseBound', 'netRevenueBound', 'netRevenueExVatBase', 'revenue', 'revenueBase', 'revenueBaseBound'],
    treatment: 'basis-aware',
    reason:
      'Loader/empty-totals shim for the six sales analytics reports. It carries their figure names but computes nothing; the treatment is the producer’s, and the empty-totals fallback publishes zeroes (with exact bounds) only when the source scan was refused, which the page states separately.',
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
    figures: ['grossProfitBase', 'grossProfitBaseBound', 'netRevenue', 'netRevenueBase', 'netRevenueBaseBound', 'netRevenueExVat', 'netRevenueExVatBase', 'netRevenueExVatBaseBound', 'profit', 'revenue', 'revenueBase', 'shareOfRevenuePct', 'shareOfRevenuePctBound'],
    treatment: 'basis-aware',
    reason:
      'Renders getCustomerAnalyticsReport invoiced revenue, the gross-basis net revenue, the ex-VAT net revenue gross profit is measured on, the per-basis credit columns and every bound marker; gross profit renders as the withheld word where no cost was posted. o3d-kyey.',
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
    figures: ['grossProfitBase', 'grossProfitBaseBound', 'margin', 'marginPct', 'marginPctBound', 'profit', 'revenue', 'revenueBase', 'revenueBaseBound'],
    treatment: 'basis-aware',
    reason:
      'Renders getMarginAnalyticsReport revenue net of net-basis credit, gross profit, margin and contribution with their bound markers, the per-basis credit columns, and the credit that reached no product row. o3d-kyey.',
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
    figures: ['avgMarginPct', 'avgMarginPctBound', 'avgOrderValue', 'grossProfit', 'grossRevenue', 'marginBoundTitle', 'marginPct', 'marginPctBound', 'netRevenue', 'netRevenueBound', 'netTotal', 'netTotalBasis', 'totalGrossProfit', 'totalGrossRevenue', 'totalNetRevenue'],
    treatment: 'basis-aware',
    reason:
      'Renders every bounded sales-statistics figure, cards included, with the ratio marked separately from the linear figures. o3d-7jfq: the linear cells and cards READ the producer\u2019s netRevenueBound instead of deriving \u2264 from refundBasisComplete, which is a boolean and could not say indeterminate.',
  },
  {
    file: 'app/(dashboard)/analytics/sales/page.tsx',
    figures: ['netRevenue', 'netRevenueBound', 'revenue'],
    treatment: 'basis-aware',
    reason:
      'Renders getSalesAnalyticsReport invoiced revenue/tax/shipping/discount AND the gross-basis net revenue beside it with its bound marker and the per-basis credit columns. The invoiced columns stay invoiced on purpose — this report’s stated contract is that its totals reconcile to SalesOrder totals. o3d-kyey.',
  },
  {
    file: 'app/(dashboard)/dashboard/dashboard-client.tsx',
    figures: ['avgOrderValue', 'bestSellerMarginTitle', 'bestSellerRevenueTitle', 'compMarginPct', 'compMarginPctBound', 'compNetSales', 'compNetSalesBound', 'grossSalesComparison', 'grossSalesCurrent', 'marginBoundComparison', 'marginBoundCurrent', 'marginChartTooltip', 'marginComparison', 'marginCurrent', 'marginPct', 'marginPctBound', 'marginTooltipFormatter', 'netRevenue', 'netRevenueBound', 'netSales', 'netSalesBound', 'netSalesBoundComparison', 'netSalesBoundCurrent', 'netSalesComparison', 'netSalesCurrent', 'netSalesTooltipFormatter', 'profitCurrent'],
    treatment: 'basis-aware',
    reason:
      'Renders the KPI cards, both chart tooltips per bucket, the cash-bridge bars and (round 5) the Best Sellers rows with their bound markers. o3d-7jfq: every linear \u2264 now reads a three-valued marker from the producer \u2014 the booleans it derived them from could not express indeterminate.',
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
    figures: ['avgOrderValue', 'compMarginPct', 'compMarginPctBound', 'compNetSales', 'compNetSalesBound', 'grossSales', 'grossSalesComparison', 'grossSalesCurrent', 'marginBoundComparison', 'marginBoundCurrent', 'marginComparison', 'marginCurrent', 'marginPct', 'marginPctBound', 'netRevenue', 'netRevenueBound', 'netSales', 'netSalesBound', 'netSalesBoundComparison', 'netSalesBoundCurrent', 'netSalesComparison', 'netSalesCurrent', 'profitCurrent'],
    treatment: 'basis-aware',
    reason:
      'KPIs, chart buckets and (round 5) Best Sellers all bucket refunds by stamped basis, subtract only NET, and publish a bound. o3d-7jfq: every bound comes from the unplaced credit\u2019s INTERVAL, recorded as each entry\u2019s positive part, so two opposite same-basis credits can no longer cancel into a \u2264.',
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
    figures: ['avgMarginPct', 'avgMarginPctBound', 'avgOrderValue', 'grossProfit', 'grossRevenue', 'marginPct', 'marginPctBound', 'netRevenue', 'netRevenueBound', 'netTotal', 'netTotalBasis', 'totalGrossProfit', 'totalGrossRevenue', 'totalNetRevenue'],
    treatment: 'basis-aware',
    reason:
      'The original basis-aware producer; round 5 moved its period totals and margin bound onto unrounded aggregates. o3d-7jfq: it now PUBLISHES netRevenueBound for the three linear figures instead of leaving each consumer to re-derive it from two signed bucket columns.',
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
    figures: ['grossProfitBase', 'grossProfitBaseBound', 'margin', 'marginPct', 'marginPctBound', 'netRevenue', 'netRevenueBase', 'netRevenueBaseBound', 'netRevenueBound', 'netRevenueExVatBase', 'netRevenueExVatBaseBound', 'revenue', 'revenueBase', 'revenueBaseBound', 'shareOfRevenuePct', 'shareOfRevenuePctBound'],
    treatment: 'basis-aware',
    reason:
      'Sales/customers/margin CSVs. Every net figure ships with its bound column and its per-basis credit columns beside it, and the producer’s basis notice travels as export metadata comment rows — a file reader has no tooltip.',
  },
  {
    file: 'lib/accounting.ts',
    figures: ['quickbooks_unearned_revenue_account', 'unearnedRevenueAccount', 'xero_unearned_revenue_account'],
    treatment: 'not-refund-sensitive',
    reason:
      'Unearned-revenue account resolution. Ledger account.',
  },
  {
    file: 'lib/cost-layers.ts',
    figures: ['revenueDeferredDate'],
    treatment: 'not-refund-sensitive',
    reason:
      'Not a figure: `revenueDeferredDate` is a TIMESTAMP marking that an order’s revenue recognition was deferred, and it appears in this file only inside the o3d-3zgy proof that the shipment-journal enqueue cannot race a hard delete. No refund line moves a date, and this file computes no revenue, profit or margin.',
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
    file: 'lib/connectors/woocommerce/sync/coupon-discount-backfill.ts',
    figures: ['margin', 'revenueDeferredBatchRef', 'unearnedRevenueAmount'],
    treatment: 'not-refund-sensitive',
    reason:
      'o3d-y14 coupon double-count correction. It publishes no figure to any reader: `revenueDeferredBatchRef` and `unearnedRevenueAmount` are read only to REFUSE a correction on an order whose Group A1 deferral was already computed from the amount being changed, and `margin` is the English word in two doc comments about a cutoff decided by a narrow margin rather than an identifier. Nothing here nets, renders or exports revenue, so no refund basis applies.',
  },
  {
    file: 'lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff.ts',
    figures: ['revenueDeferredBatchRef', 'unearnedRevenueAmount'],
    treatment: 'not-refund-sensitive',
    reason:
      'o3d-y14 operator handoff describing what a corrected order needs doing to it in the accounting system. The two fields are quoted as EVIDENCE in that description — which batch staged the deferral and what it staged — never summed, netted or rendered as a report figure.',
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
    file: 'lib/domain/accounting/daily-batch-discount-fence.ts',
    figures: ['assertRevenueDeferralsUnchanged', 'revenueDeferralAmount', 'revenueDeferredBatchRef', 'unearnedRevenueAmount'],
    treatment: 'not-refund-sensitive',
    reason:
      'o3d-y14 Group A1 fence. It re-derives each order’s deferral under the batch’s own row locks purely to COMPARE it with the figure the unlocked read produced, and refuses the group on a disagreement — the amount is never published, and the only thing it can cause is that no journal is staged at all. The deferral figure it re-derives is the ledger posting already declared under xero/daily-sync.ts.',
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
    file: 'lib/domain/accounting/discount-restatement.ts',
    figures: ['revenueDeferredBatchRef'],
    treatment: 'not-refund-sensitive',
    reason:
      'o3d-y14 restatement record — the persisted basis saying an order’s discount was rewritten after its invoice posted. `revenueDeferredBatchRef` is stored as part of that provenance so a later reader knows which batch had already consumed the old figure. Provenance, not a money figure; no refund can move it.',
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
    figures: ['margin', 'marginFigureBound', 'marginFigureBoundDecimal', 'netRevenue', 'netTotal'],
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
    figures: ['emptyMarginGroup', 'getMarginAnalyticsReport', 'grossProfit', 'grossProfitBase', 'grossProfitBaseBound', 'marginCogsBucket', 'marginPct', 'marginPctBound', 'marginRefundLines', 'netRevenue', 'netRevenueBase', 'netRevenueBaseBound', 'netRevenueBound', 'netRevenueByGroup', 'netRevenueByKey', 'netRevenueExVat', 'netRevenueExVatBase', 'netRevenueExVatBaseBound', 'revenue', 'revenueBase', 'revenueBaseBound', 'revenueDecimal', 'revenueExVat', 'shareOfRevenuePct', 'shareOfRevenuePctBound', 'totalGrossProfit', 'totalRevenue', 'unitRevenue'],
    treatment: 'basis-aware',
    reason:
      'o3d-kyey fixed what round 5 had only declared. Sales, Customer Mix and Gross Margin now load the period’s credit, bucket it by its stamped basis, subtract only the bucket that is the same unit as the figure, publish the rest beside it, and mark each figure exact / ≤ / ? — ratios by their own case analysis, never from the linear flag. Customer Mix’s gross profit also moved onto the EX-VAT revenue (COGS is ex-tax) and is WITHHELD where no cost was posted.',
  },
  {
    file: 'lib/pdf.ts',
    figures: ['margins'],
    treatment: 'not-refund-sensitive',
    reason:
      'PDF page margins — a layout inset, not a money figure.',
  },
  {
    file: 'scripts/backfill-wc-coupon-order-discount.ts',
    figures: ['revenueDeferredBatchRef'],
    treatment: 'not-refund-sensitive',
    reason:
      'o3d-y14 backfill CLI. It reports which orders it would correct and which it refuses; `revenueDeferredBatchRef` appears only as the refusal evidence for an order whose Group A1 deferral already consumed the pre-correction discount. The script computes no revenue, profit or margin.',
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
