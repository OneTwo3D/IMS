import {
  ActivityEntityType,
  Prisma,
  ProductType,
  SalesOrderStatus,
  ShipmentStatus,
  StockMovementType,
} from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { dateOnly, defaultUtcDateWindow, exclusiveEndOfUtcDay, parseDateOnly, startOfUtcDay } from '@/lib/domain/math/date-window'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'
import { DEFAULT_BASE_CURRENCY, getBaseCurrencyCode } from '@/lib/base-currency'
import { SourceScanTooLargeError, assertSourceLimit } from '@/lib/security/source-scan-error'
import {
  calculateDecimalCoverageByLine,
  requirementsMapToDecimalRows,
  type DecimalFulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirementsDecimal,
  loadFulfillmentProductGraph,
} from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirements } from '@/lib/products/fulfillment-requirement-snapshot'
import { isStockTrackedProductType } from '@/lib/domain/inventory/backorder-policy'
import {
  creditPlacement,
  marginFigureBoundDecimal,
  netLinearFigureBoundDecimal,
  refundTotalsBasis,
  shareFigureBound,
  type DerivedFigureBound,
} from '@/lib/domain/sales/refund-basis-analytics'
import {
  REFUND_BASIS_NOTICE_CUSTOMER_MIX,
  REFUND_BASIS_NOTICE_GROSS_MARGIN,
  REFUND_BASIS_NOTICE_SALES,
  RETURNS_MIXED_BASIS_MARKER,
  RETURNS_MIXED_BASIS_NOTICE,
} from '@/lib/analytics/refund-figure-surfaces'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const SOURCE_ROW_LIMIT = 50000
const DEFAULT_PERIOD_DAYS = 30
const ACTIVE_ORDER_STATUSES = Object.values(SalesOrderStatus).filter((status) => status !== SalesOrderStatus.CANCELLED)

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

export type SalesFulfillmentAnalyticsClient = {
  // o3d-4kfh r3: the fulfillment graph loader reads this to expand a KIT line into the leaf
  // components its shipment lines are actually denominated in.
  product: FindManyDelegate
  salesOrder: FindManyDelegate
  salesOrderRefund: FindManyDelegate
  salesOrderRefundLine: FindManyDelegate
  cogsEntry: FindManyDelegate
  stockMovement: FindManyDelegate
  shipment: FindManyDelegate
  activityLog: FindManyDelegate
}

export type SalesFulfillmentAnalyticsDeps = {
  client?: SalesFulfillmentAnalyticsClient
  now?: () => Date
  baseCurrency?: () => Promise<string>
  paginate?: boolean
}

export type SalesAnalyticsGroupBy = 'product' | 'category' | 'customer' | 'channel'
export type SalesCurrencyMode = 'base' | 'foreign'

export type SalesAnalyticsFilters = {
  dateFrom?: string
  dateTo?: string
  groupBy?: SalesAnalyticsGroupBy
  currencyMode?: SalesCurrencyMode
  page?: number
  pageSize?: number
}

export type SalesAnalyticsReport<Row> = {
  generatedAt: string
  dateFrom: string
  dateTo: string
  rows: Row[]
  pageInfo: PageInfo
  totals: Record<string, string>
  notices: string[]
}

export type SalesReportRow = {
  key: string
  label: string
  groupBy: SalesAnalyticsGroupBy
  currency: string
  orderCount: number
  lineCount: number
  /**
   * AS INVOICED, and deliberately still so after o3d-kyey. This report's contract — stated in its
   * own notices, and the reason the product/category views allocate order totals across lines at all
   * — is that its grand totals reconcile to `SalesOrder` totals. A figure that reconciles to the
   * invoices cannot also be net of credit notes, so the refund-aware figure is `netRevenue` beside
   * it rather than a redefinition of this one. `tax`, `shipping` and `discount` are as invoiced for
   * the same reason.
   */
  revenue: string
  tax: string
  shipping: string
  discount: string
  /**
   * `revenue` less the credit recorded on the SAME (gross, VAT-inclusive) basis. Not `revenue` minus
   * every refund: a NET-basis credit is ex-VAT and subtracting it from a VAT-inclusive figure
   * under-credits by its VAT, and an unproven one cannot be placed at all. Both sit in the buckets
   * below and make this an upper bound — see `netRevenueBound`.
   */
  netRevenue: string
  /** What `netRevenue` is: `exact`, `upper` (`≤`), or `indeterminate` (`?`). */
  netRevenueBound: DerivedFigureBound
  /** Credit stamped GROSS — the comparable one, already subtracted from `netRevenue`. */
  refundsGrossBasis: string
  /** Credit stamped NET — reported, NOT subtracted. */
  refundsNetBasis: string
  /** Credit with no proven basis — reported, NOT subtracted. */
  refundsUnknownBasis: string
}

/**
 * THE STATE OF A CUSTOMER'S COST EVIDENCE — and therefore why their gross profit is or is not there.
 *
 * `incomplete` and `inconsistent` both withhold, and an operator handles them differently. See
 * `dispatchCostEvidenceByOrder` for why excess evidence is not a gap.
 */
export type CostEvidenceStatus =
  /** Every in-period order's posted cost covers, exactly, the revenue the profit is measured against. */
  | 'complete'
  /** Some cost is missing or unknowable. It may arrive: the rest ships, the rest is costed. */
  | 'incomplete'
  /** Some dispatch is costed for MORE units than it moved. Cost evidence that contradicts itself. */
  | 'inconsistent'

export type CustomerReportRow = {
  customerId: string | null
  customerName: string
  customerEmail: string | null
  orderCount: number
  /** AS INVOICED, unchanged, so this column still agrees with Sales Analytics' customer grouping. */
  revenueBase: string
  /** `revenueBase` less the GROSS-basis credit — the only credit on the same basis as it. */
  netRevenueBase: string
  netRevenueBaseBound: DerivedFigureBound
  /**
   * The EX-VAT revenue gross profit is actually computed from: `Σ(totalBase - taxBase)` less the
   * NET-basis credit. Published because otherwise the profit below is a number with no visible
   * arithmetic — `revenueBase - grossProfitBase` is not COGS and never was.
   */
  netRevenueExVatBase: string
  netRevenueExVatBaseBound: DerivedFigureBound
  /**
   * `netRevenueExVatBase - cogs`, or NULL when this customer has an order in the period with no
   * posted COGS at all.
   *
   * o3d-kyey. It used to be `Σ SalesOrder.totalBase - Σ CogsEntry.totalCostBase`, which was wrong
   * twice over. It subtracted an EX-TAX cost from a VAT-INCLUSIVE revenue, so it overstated profit
   * by the whole VAT on every taxable order; and `cogsByOrder.get(id) ?? 0` turned "this order has
   * not dispatched yet, so its cost is not known" into "this order cost nothing", which published
   * an order's entire revenue as profit. A missing cost is not a zero cost, so the figure is
   * WITHHELD for that customer rather than published wrong — see `costCaptured`.
   */
  grossProfitBase: string | null
  grossProfitBaseBound: DerivedFigureBound
  /**
   * False when at least one of this customer's in-period orders has no COGS posted in the period.
   * `grossProfitBase` is null exactly when this is false, and this is `costEvidence === 'complete'`.
   */
  costCaptured: boolean
  /**
   * WHY, when `costCaptured` is false. The decision and the reason are separate fields because they
   * are read by different people: a reader who only wants to know whether a number is there reads
   * the boolean, and one who has to DO something about a blank needs to know which thing to do.
   * Derived from this in the projection, so the two cannot drift.
   */
  costEvidence: CostEvidenceStatus
  /** Unpaid order value, less the GROSS-basis credit raised against those unpaid orders. */
  arExposureBase: string
  /**
   * AR exposure nets credit too, so it is bounded on the same terms as every other figure here. A
   * NET-basis credit against an unpaid order is real relief this figure could not apply, which
   * leaves the published exposure at most the true one.
   */
  arExposureBaseBound: DerivedFigureBound
  /** Share of the period's REFUND-AWARE revenue, so a customer who returned everything ranks on it. */
  shareOfRevenuePct: string
  /** A ratio moves both its parts; it is never an upper bound. See `shareFigureBound`. */
  shareOfRevenuePctBound: DerivedFigureBound
  refundsGrossBasis: string
  refundsNetBasis: string
  refundsUnknownBasis: string
}

export type MarginReportRow = {
  productId: string | null
  sku: string
  productName: string
  categoryName: string | null
  lineCount: number
  /**
   * Dispatched ex-VAT line revenue LESS the NET-basis credit raised in the period. Corrected in
   * place rather than published beside an as-invoiced twin (the way Sales Analytics' is), because
   * this figure reconciles to nothing: it is already prorated away from the order totals to the
   * quantity each line dispatched inside the window, so there is no invoiced number for it to agree
   * with. Its basis is NET, so the NET-basis credit is the comparable one.
   */
  revenueBase: string
  revenueBaseBound: DerivedFigureBound
  cogsBase: string
  grossProfitBase: string
  grossProfitBaseBound: DerivedFigureBound
  marginPct: string
  /** Margin is a RATIO: `refundBasisComplete === false` does not make it an upper bound. */
  marginPctBound: DerivedFigureBound
  contributionPct: string
  contributionPctBound: DerivedFigureBound
  /** Credit stamped NET — the comparable one, already subtracted from `revenueBase`. */
  refundsNetBasis: string
  /** Credit stamped GROSS — reported, NOT subtracted. */
  refundsGrossBasis: string
  /** Credit with no proven basis — reported, NOT subtracted. */
  refundsUnknownBasis: string
}

export type ReturnsReportRow = {
  productId: string | null
  sku: string
  productName: string
  customerName: string
  reason: string
  refundCount: number
  returnedQty: string
  /**
   * o3d-iigc round 5. The credit on this row, ON ITS OWN BASIS — and `null` when the row's credits
   * are not all on one basis, because a NET amount added to a GROSS one is a number with no unit.
   * Round 4 flagged this producer and left it; it was summing all three bases into one figure AND
   * SORTING THE REPORT BY IT, so a row of legacy gross credits outranked a larger net one purely
   * on the VAT it still carried.
   *
   * A null here is an ADMISSION, never a zero: a zero would read as "nothing was credited", which
   * is the opposite of what is being said. The three buckets below always add up to the whole
   * credit, so how much credit exists is never in doubt even when its unit is.
   */
  refundValueBase: string | null
  /** Which basis `refundValueBase` is expressed on, or why it could not be expressed. */
  refundValueBasis: 'NONE' | 'NET' | 'GROSS' | 'UNKNOWN' | 'MIXED'
  /** Credit stamped NET (ex-VAT). Always reported, whatever the row's overall basis. */
  refundValueNetBasis: string
  /** Credit stamped GROSS (VAT-inclusive). */
  refundValueGrossBasis: string
  /** Credit whose basis was never proved. Never guessed at, never converted. */
  refundValueUnknownBasis: string
  shippedQty: string
  returnRatePct: string
}

export type FulfillmentReportRow = {
  metric: string
  value: string
  numerator: string
  denominator: string
}

export type ThroughputReportRow = {
  date: string
  userName: string
  orderCount: number
  shipmentCount: number
  lineCount: number
}

type SalesOrderLineRow = {
  id: string
  productId: string | null
  sku: string | null
  description: string
  qty: DecimalInput
  totalForeign: DecimalInput
  totalBase: DecimalInput
  taxForeign: DecimalInput
  taxBase: DecimalInput
  discountAmount: DecimalInput
  product: {
    id: string
    sku: string
    /**
     * What the line SELLS, which is what says whether it has a cost to post at all. Loaded for
     * `orderCostCoverage`; see the distinction it draws between a line with no cost and a line
     * whose cost is unknown.
     */
    type: ProductType
    name: string
    category: { name: string } | null
  } | null
}

type SalesOrderRow = {
  id: string
  status: SalesOrderStatus
  currency: string
  customerId: string | null
  customerName: string | null
  customerEmail: string | null
  createdAt: Date
  expectedDelivery: Date | null
  paidAt: Date | null
  totalForeign: DecimalInput
  totalBase: DecimalInput
  taxForeign: DecimalInput
  taxBase: DecimalInput
  shippingForeign: DecimalInput
  shippingBase: DecimalInput
  discountAmount: DecimalInput
  lines: SalesOrderLineRow[]
  shoppingLinks: Array<{ connector: string }>
}

type MarginProductRef = {
  sku: string
  name: string
  category: { name: string } | null
}

type CogsEntryRow = {
  id: string
  totalCostBase: DecimalInput
  movement: {
    referenceType: string | null
    referenceId: string | null
    productId: string
    createdAt: Date
    product: MarginProductRef
    /**
     * o3d-7r6x: the sales line the dispatch was for. For a KIT the movement's own product is a leaf
     * COMPONENT, so this is the only way to bucket the cost under the product the order line —
     * and therefore the revenue — is denominated in. Null for unlinked/legacy rows.
     */
    shipmentLine: {
      line: { productId: string | null; product: MarginProductRef | null } | null
    } | null
  }
}

/**
 * o3d-7r6x: which product a COGS row belongs to for REVENUE-COMPARABLE bucketing. A linked dispatch
 * reports the sales line's product (the kit), everything else the movement's own product. For a
 * SIMPLE product the two are the same id, so non-kit bucketing is byte-for-byte unchanged.
 */
function marginCogsBucket(row: CogsEntryRow): { productId: string; product: MarginProductRef } {
  const line = row.movement.shipmentLine?.line
  if (line?.productId && line.product) return { productId: line.productId, product: line.product }
  return { productId: row.movement.productId, product: row.movement.product }
}

/**
 * o3d-kyey: WHAT A PERIOD'S CREDIT IS, SPLIT BY THE BASIS IT WAS RECORDED ON.
 *
 * Every one of these three reports subtracts credit from a revenue figure, and each figure is on a
 * basis of its own: Sales Analytics and Customer Mix build revenue from `SalesOrder.totalBase`,
 * which is VAT-INCLUSIVE, while Gross Margin builds it from `SalesOrderLine.totalBase`, which is
 * ex-VAT. Only the credit recorded on the SAME basis as the figure is the same unit as it, so only
 * that one is subtracted; the other two are carried beside the figure and make it a stated bound.
 * Nothing is converted between the bases — on a mixed-rate order the rate that produced a gross
 * credit is not recoverable from stored data, which is the conclusion `refund-basis-analytics`
 * reaches and `o3d-w00` made the refund CREATE path fail closed over.
 *
 * The two completeness flags are tracked SEPARATELY rather than derived from the sums, because a
 * +5 and a -5 of unplaceable credit sum to zero while neither was placeable.
 */
type CreditBuckets = {
  /** Credit stamped NET (ex-VAT). */
  net: Prisma.Decimal
  /** Credit stamped GROSS (VAT-inclusive). */
  gross: Prisma.Decimal
  /** Credit whose basis was never proved. Never guessed at, never converted. */
  unknown: Prisma.Decimal
  /**
   * THE POSITIVE PART OF EACH BUCKET — `Σ max(entry, 0)` — carried beside the signed total because
   * the signed total cannot bound anything on its own.
   *
   * A credit that is not the figure's unit contributes an INTERVAL, not an amount: an entry `b` on
   * another basis is worth somewhere in `[min(b, 0), max(b, 0)]` once expressed in the figure's
   * unit. Adding the entries up first destroys that interval — +120 and −120 of GROSS credit sum to
   * a bucket of zero, and a bound read off that zero says the figure cannot move when the figure
   * can move by 120 in either direction. Recording the positive part AT THE ENTRY keeps both
   * endpoints recoverable from the two numbers: `Σ max(b, 0)` is this field and `Σ min(b, 0)` is
   * `total − this field`.
   *
   * Same reasoning as the two completeness flags below being tracked rather than derived from the
   * sums, applied to the AMOUNTS instead of the flags.
   */
  netPositive: Prisma.Decimal
  grossPositive: Prisma.Decimal
  unknownPositive: Prisma.Decimal
  /** True while every credit seen could be placed on a NET-basis figure. */
  netBasisComplete: boolean
  /** True while every credit seen could be placed on a GROSS-basis figure. */
  grossBasisComplete: boolean
}

function emptyCredits(): CreditBuckets {
  return {
    net: new Prisma.Decimal(0),
    gross: new Prisma.Decimal(0),
    unknown: new Prisma.Decimal(0),
    netPositive: new Prisma.Decimal(0),
    grossPositive: new Prisma.Decimal(0),
    unknownPositive: new Prisma.Decimal(0),
    netBasisComplete: true,
    grossBasisComplete: true,
  }
}

function addCredit(buckets: CreditBuckets, totalsBasis: string | null, amount: DecimalInput): void {
  const onNet = creditPlacement('NET', totalsBasis, amount)
  const onGross = creditPlacement('GROSS', totalsBasis, amount)
  const value = toDecimal(amount)
  // THIS IS THE LAST PLACE AN INDIVIDUAL CREDIT EXISTS. Every consumer above this line sees bucket
  // sums only, so a separation that is not made here can never be made at all — which is exactly
  // how two opposite same-basis credits used to reach the interval arithmetic as a single zero.
  const positive = value.gt(0) ? value : new Prisma.Decimal(0)
  if (onNet.bucket === 'net') {
    buckets.net = buckets.net.add(value)
    buckets.netPositive = buckets.netPositive.add(positive)
  } else if (onNet.bucket === 'gross') {
    buckets.gross = buckets.gross.add(value)
    buckets.grossPositive = buckets.grossPositive.add(positive)
  } else {
    buckets.unknown = buckets.unknown.add(value)
    buckets.unknownPositive = buckets.unknownPositive.add(positive)
  }
  if (!onNet.placeable) buckets.netBasisComplete = false
  if (!onGross.placeable) buckets.grossBasisComplete = false
}

function mergeCredits(into: CreditBuckets, from: CreditBuckets): void {
  into.net = into.net.add(from.net)
  into.gross = into.gross.add(from.gross)
  into.unknown = into.unknown.add(from.unknown)
  into.netPositive = into.netPositive.add(from.netPositive)
  into.grossPositive = into.grossPositive.add(from.grossPositive)
  into.unknownPositive = into.unknownPositive.add(from.unknownPositive)
  if (!from.netBasisComplete) into.netBasisComplete = false
  if (!from.grossBasisComplete) into.grossBasisComplete = false
}

/** The credit that is the same unit as a figure on `basis`, and is therefore SUBTRACTED from it. */
function comparableCredit(buckets: CreditBuckets, basis: 'NET' | 'GROSS'): Prisma.Decimal {
  return basis === 'NET' ? buckets.net : buckets.gross
}

/**
 * THE CREDIT A FIGURE COULD NOT ABSORB, AS THE INTERVAL IT ACTUALLY OCCUPIES — never as one signed
 * amount, because one signed amount is what loses the cancellation.
 *
 * `[lower, upper]` is stated in the FIGURE'S unit and bounds the credit that was left unsubtracted,
 * so the true figure lies in `[published − upper, published − lower]`.
 *
 * On a NET figure the bound is TIGHT in both directions: a GROSS entry `g` is worth `g / (1 + rate)`
 * ex-VAT, which lies in `[0, g]` for `g >= 0` and in `[g, 0]` for `g < 0`, and an entry of unproven
 * basis is worth either itself or that, so the same interval covers it.
 *
 * On a GROSS figure only the DIRECTION is established, which is all `netLinearFigureBoundDecimal`
 * reads from it (its own docstring says so): a NET entry `n` is worth `n * (1 + rate)` VAT-inclusive
 * and has no finite ceiling, so `upper` is a sign carrier there and not a magnitude. `lower` is
 * still sign-correct — it is below zero exactly when some unplaced entry was negative, which is
 * exactly when the published figure may be too LOW and no `≤` may be claimed.
 */
type UnplacedCreditInterval = { lower: Prisma.Decimal; upper: Prisma.Decimal }

function unplacedCreditInterval(buckets: CreditBuckets, basis: 'NET' | 'GROSS'): UnplacedCreditInterval {
  const zero = new Prisma.Decimal(0)
  const unplaced: Array<[Prisma.Decimal, Prisma.Decimal]> = basis === 'NET'
    ? [[buckets.gross, buckets.grossPositive], [buckets.unknown, buckets.unknownPositive]]
    : [[buckets.net, buckets.netPositive], [buckets.unknown, buckets.unknownPositive]]
  return unplaced.reduce<UnplacedCreditInterval>((interval, [total, positive]) => ({
    // Σ min(b, 0) = total − Σ max(b, 0). The two fields are all the endpoints need.
    lower: interval.lower.add(total.sub(positive)),
    upper: interval.upper.add(positive),
  }), { lower: zero, upper: zero })
}

function addUnplacedIntervals(a: UnplacedCreditInterval, b: UnplacedCreditInterval): UnplacedCreditInterval {
  return { lower: a.lower.add(b.lower), upper: a.upper.add(b.upper) }
}

/**
 * The one number `netLinearFigureBoundDecimal` and `marginFigureBoundDecimal` take, derived from the
 * interval rather than from a sum.
 *
 * Both classifiers read a NEGATIVE value as "no `≤` claim holds", so a below-zero lower end is
 * handed straight to them and produces `indeterminate`; otherwise the credit provably cannot be
 * negative and the ceiling is the interval's upper end.
 */
function unplacedCreditBound(interval: UnplacedCreditInterval): Prisma.Decimal {
  return interval.lower.lt(0) ? interval.lower : interval.upper
}

/** The bound input for the credit a figure on `basis` could not absorb. */
function unplacedCredit(buckets: CreditBuckets, basis: 'NET' | 'GROSS'): Prisma.Decimal {
  return unplacedCreditBound(unplacedCreditInterval(buckets, basis))
}

function creditBasisComplete(buckets: CreditBuckets, basis: 'NET' | 'GROSS'): boolean {
  return basis === 'NET' ? buckets.netBasisComplete : buckets.grossBasisComplete
}

/** What off-row credit does to a report's figures, decided WITHOUT ever adding its bases together. */
type OffRowCreditSummary = {
  /**
   * True when the off-row credit can move the figures at all. Decided from the INTERVAL, never from
   * a signed sum and never from a bucket total:
   *   - +100 GROSS and −100 NET add to zero while both still sit off every row (the cross-basis
   *     cancellation), and
   *   - +120 GROSS and −120 GROSS collapse to a zero GROSS BUCKET while their ex-VAT values need
   *     not cancel at all, since the rates behind them may differ (the same-basis cancellation).
   * Only when both endpoints are zero is nothing unaccounted for, and only then may a report call
   * its revenue, profit and margin exact.
   */
  present: boolean
  /**
   * The interval, IN NET TERMS, on the off-row credit that no row subtracted.
   *
   * Off-row credit reached no row, so even the NET-basis part of it is missing from the figures —
   * that part is added at BOTH endpoints, exactly, because it needs no conversion. The GROSS and
   * unproven parts contribute `unplacedCreditInterval`'s per-entry interval. Sum:
   *   `[ Σnet + Σ min(b, 0) , Σnet + Σ max(b, 0) ]`, over the ENTRIES, not the buckets.
   * A lower end below zero means the unsubtracted credit may itself be negative, so the published
   * figures are not ceilings and `unplacedCreditBound` turns that into `indeterminate`.
   */
  interval: UnplacedCreditInterval
}

function offRowCreditSummary(...sets: CreditBuckets[]): OffRowCreditSummary {
  const merged = emptyCredits()
  for (const set of sets) mergeCredits(merged, set)
  const convertible = unplacedCreditInterval(merged, 'NET')
  const interval = {
    lower: merged.net.add(convertible.lower),
    upper: merged.net.add(convertible.upper),
  }
  return { present: !(interval.lower.isZero() && interval.upper.isZero()), interval }
}

/** An order's whole credit, as Sales Analytics and Customer Mix attribute it: by order id. */
type OrderRefundRow = {
  orderId: string
  totalBase: DecimalInput
  totalForeign: DecimalInput
  /** NET / GROSS / null. Governs what the two totals above MEAN. */
  totalsBasis: string | null
}

/**
 * A refund LINE as Gross Margin attributes it: to the sales line's product, which is the bucket the
 * revenue it credits was booked into. `salesOrderLine.productId` is preferred over the refund line's
 * own `productId` for the same reason `marginCogsBucket` prefers the shipment line's — the sales
 * line is what the revenue is denominated in, and for a KIT the two differ.
 */
type MarginRefundLineRow = {
  productId: string | null
  totalBase: DecimalInput
  salesOrderLine: { productId: string | null } | null
  refund: { totalsBasis: string | null }
}

async function loadOrderRefunds(client: SalesFulfillmentAnalyticsClient, orderIds: string[]): Promise<OrderRefundRow[]> {
  if (orderIds.length === 0) return []
  const rows = await client.salesOrderRefund.findMany({
    where: { orderId: { in: [...new Set(orderIds)] } },
    select: { orderId: true, totalBase: true, totalForeign: true, totalsBasis: true },
    take: SOURCE_ROW_LIMIT + 1,
  }) as OrderRefundRow[]
  assertSourceLimit(rows.length, SOURCE_ROW_LIMIT, 'Sales analytics refund source rows')
  return rows
}

type RefundLineRow = {
  id: string
  refundId: string
  productId: string | null
  description: string
  qty: DecimalInput
  totalBase: DecimalInput
  product: { id: string; sku: string; name: string } | null
  refund: {
    id: string
    reason: string | null
    totalBase: DecimalInput
    /** o3d-iigc round 5: NET / GROSS / null. Governs the line amounts under it. */
    totalsBasis: string | null
    refundedAt: Date
    order: {
      customerName: string | null
      lines: Array<{ productId: string | null; qty: DecimalInput }>
    }
  }
}

/**
 * A SALE_DISPATCH movement as the returns reader needs it: `productId` is the leaf component that
 * physically left, `shipmentLine.line.productId` the parent product its sales line is priced in.
 */
type DispatchMovementRow = {
  productId: string
  qty: DecimalInput
  shipmentLine: { lineId: string; line: { productId: string | null } | null } | null
}

type ShipmentRow = {
  id: string
  orderId: string
  status: ShipmentStatus
  shippedAt: Date | null
  createdAt: Date
  updatedAt: Date
  lines: Array<{ lineId: string; productId: string; qty: DecimalInput }>
  order: {
    id: string
    createdAt: Date
    expectedDelivery: Date | null
    lines: Array<{ id: string; productId: string | null; qty: DecimalInput; fulfillmentRequirements?: unknown }>
  }
}

type ActivityLogRow = {
  userId: string | null
  createdAt: Date
  metadata: Prisma.JsonValue | null
  user: { name: string } | null
}

function clientFromDeps(deps?: SalesFulfillmentAnalyticsDeps): SalesFulfillmentAnalyticsClient {
  return (deps?.client ?? db) as unknown as SalesFulfillmentAnalyticsClient
}

function nowFromDeps(deps?: SalesFulfillmentAnalyticsDeps): Date {
  return deps?.now?.() ?? new Date()
}

async function baseCurrencyFromDeps(deps?: SalesFulfillmentAnalyticsDeps): Promise<string> {
  if (deps?.baseCurrency) return deps.baseCurrency()
  return deps?.client ? DEFAULT_BASE_CURRENCY : getBaseCurrencyCode()
}

function period(filters: SalesAnalyticsFilters, now: Date): { dateFrom: Date; dateTo: Date; dateToExclusive: Date } {
  const { dateFrom: defaultFrom, dateTo: defaultTo } = defaultUtcDateWindow(now, DEFAULT_PERIOD_DAYS)
  const dateTo = parseDateOnly(filters.dateTo, defaultTo, { endOfDay: true })
  const dateFrom = parseDateOnly(filters.dateFrom, defaultFrom)
  return dateFrom.getTime() <= dateTo.getTime()
    ? { dateFrom, dateTo, dateToExclusive: exclusiveEndOfUtcDay(dateTo) }
    : { dateFrom: startOfUtcDay(dateTo), dateTo, dateToExclusive: exclusiveEndOfUtcDay(dateTo) }
}

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.floor(value as number)))
}

function pageInfo(totalRows: number, page: number | undefined, pageSize: number): PageInfo {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const currentPage = Math.min(totalPages, Math.max(1, Math.floor(page ?? 1)))
  return {
    page: currentPage,
    pageSize,
    totalRows,
    totalPages,
    hasNextPage: currentPage < totalPages,
    hasPreviousPage: currentPage > 1,
  }
}

export function emptySalesAnalyticsReportForSourceLimit<Row>(
  filters: SalesAnalyticsFilters,
  error: SourceScanTooLargeError,
  totals: Record<string, string>,
  now = new Date(),
): SalesAnalyticsReport<Row> {
  const window = period(filters, now)
  const pageSize = clampPageSize(filters.pageSize)
  return {
    generatedAt: now.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: [],
    pageInfo: pageInfo(0, filters.page, pageSize),
    totals,
    notices: [error.message],
  }
}

function paginate<T>(rows: T[], filters: SalesAnalyticsFilters, enabled = true): { rows: T[]; pageInfo: PageInfo } {
  const pageSize = clampPageSize(filters.pageSize)
  const info = pageInfo(rows.length, filters.page, pageSize)
  if (!enabled) return { rows, pageInfo: { ...info, page: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false } }
  const start = (info.page - 1) * pageSize
  return { rows: rows.slice(start, start + pageSize), pageInfo: info }
}

function moneyString(value: DecimalInput, currency = DEFAULT_BASE_CURRENCY): string {
  return roundMoney(value, currency).toString()
}

function qtyString(value: DecimalInput): string {
  return roundQuantity(value, 4).toString()
}

function pctString(numerator: DecimalInput, denominator: DecimalInput): string {
  const den = toDecimal(denominator)
  if (den.lte(0)) return '0'
  return roundQuantity(toDecimal(numerator).div(den).mul(100), 2).toString()
}

function channel(order: Pick<SalesOrderRow, 'shoppingLinks'>): string {
  return order.shoppingLinks[0]?.connector ?? 'manual'
}

function customerName(order: Pick<SalesOrderRow, 'customerName' | 'customerEmail' | 'customerId'>): string {
  return order.customerName ?? order.customerEmail ?? order.customerId ?? 'Unknown customer'
}

function groupBy(filters: SalesAnalyticsFilters): SalesAnalyticsGroupBy {
  const value = filters.groupBy
  return value === 'category' || value === 'customer' || value === 'channel' ? value : 'product'
}

function currencyMode(filters: SalesAnalyticsFilters): SalesCurrencyMode {
  return filters.currencyMode === 'foreign' ? 'foreign' : 'base'
}

async function loadSalesOrders(client: SalesFulfillmentAnalyticsClient, filters: SalesAnalyticsFilters, window: { dateFrom: Date; dateTo: Date; dateToExclusive: Date }): Promise<SalesOrderRow[]> {
  return client.salesOrder.findMany({
    where: {
      status: { in: ACTIVE_ORDER_STATUSES },
      createdAt: { gte: window.dateFrom, lt: window.dateToExclusive },
      archived: false,
    },
    select: {
      id: true,
      status: true,
      currency: true,
      customerId: true,
      customerName: true,
      customerEmail: true,
      createdAt: true,
      expectedDelivery: true,
      paidAt: true,
      totalForeign: true,
      totalBase: true,
      taxForeign: true,
      taxBase: true,
      shippingForeign: true,
      shippingBase: true,
      discountAmount: true,
      lines: {
        select: {
          id: true,
          productId: true,
          sku: true,
          description: true,
          qty: true,
          totalForeign: true,
          totalBase: true,
          taxForeign: true,
          taxBase: true,
          discountAmount: true,
          product: { select: { id: true, sku: true, type: true, name: true, category: { select: { name: true } } } },
        },
      },
      shoppingLinks: { select: { connector: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
    take: SOURCE_ROW_LIMIT + 1,
  }) as Promise<SalesOrderRow[]>
}

async function loadSalesOrdersByIds(client: SalesFulfillmentAnalyticsClient, orderIds: string[]): Promise<SalesOrderRow[]> {
  if (orderIds.length === 0) return []
  assertSourceLimit(orderIds.length, SOURCE_ROW_LIMIT, 'Sales analytics source orders')
  return client.salesOrder.findMany({
    where: {
      id: { in: [...new Set(orderIds)] },
      archived: false,
    },
    select: {
      id: true,
      status: true,
      currency: true,
      customerId: true,
      customerName: true,
      customerEmail: true,
      createdAt: true,
      expectedDelivery: true,
      paidAt: true,
      totalForeign: true,
      totalBase: true,
      taxForeign: true,
      taxBase: true,
      shippingForeign: true,
      shippingBase: true,
      discountAmount: true,
      lines: {
        select: {
          id: true,
          productId: true,
          sku: true,
          description: true,
          qty: true,
          totalForeign: true,
          totalBase: true,
          taxForeign: true,
          taxBase: true,
          discountAmount: true,
          product: { select: { id: true, sku: true, type: true, name: true, category: { select: { name: true } } } },
        },
      },
      shoppingLinks: { select: { connector: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  }) as Promise<SalesOrderRow[]>
}

function orderLineTotal(order: SalesOrderRow, mode: SalesCurrencyMode): Prisma.Decimal {
  return order.lines.reduce((sum, line) => sum.add(toDecimal(mode === 'foreign' ? line.totalForeign : line.totalBase)), new Prisma.Decimal(0))
}

function allocatedOrderAmount(orderAmount: DecimalInput, lineAmount: DecimalInput, lineTotal: DecimalInput, fallbackShare: Prisma.Decimal): Prisma.Decimal {
  const total = toDecimal(lineTotal)
  if (total.gt(0)) return toDecimal(orderAmount).mul(toDecimal(lineAmount)).div(total)
  return toDecimal(orderAmount).mul(fallbackShare)
}

export async function getSalesAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<SalesReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const baseCurrency = await baseCurrencyFromDeps(deps)
  const window = period(filters, generatedAt)
  const rowsByKey = new Map<string, SalesReportRow & { revenueDecimal: Prisma.Decimal; taxDecimal: Prisma.Decimal; shippingDecimal: Prisma.Decimal; discountDecimal: Prisma.Decimal; credits: CreditBuckets; orderIds: Set<string> }>()
  const orders = await loadSalesOrders(client, filters, window)
  assertSourceLimit(orders.length, SOURCE_ROW_LIMIT, 'Sales analytics source orders')
  const grouping = groupBy(filters)
  const mode = currencyMode(filters)
  // o3d-kyey: the credit raised against these orders, WHENEVER it was raised. The report's rows are
  // an ORDER COHORT (orders created in the window), so its refund-aware figure is "what these orders
  // were finally worth" — the same reading `getProductSalesStats` takes, and the reason neither
  // filters credits by `refundedAt`. Attributed by order id and then, in the product/category views,
  // spread across that order's lines by line value: the report's OWN allocation rule, already used
  // for tax, shipping and discount, which is what keeps the credit total reconciling to the refunds.
  const refunds = await loadOrderRefunds(client, orders.map((order) => order.id))
  const refundsByOrder = new Map<string, OrderRefundRow[]>()
  for (const refund of refunds) {
    const existing = refundsByOrder.get(refund.orderId)
    if (existing) existing.push(refund)
    else refundsByOrder.set(refund.orderId, [refund])
  }
  const creditAmount = (refund: OrderRefundRow) => mode === 'foreign' ? refund.totalForeign : refund.totalBase

  for (const order of orders) {
    if (grouping === 'customer' || grouping === 'channel') {
      const currencyKey = mode === 'foreign' ? `:${order.currency}` : ''
      const key = grouping === 'customer'
        ? `${order.customerId ?? (order.customerEmail ? `guest-email:${order.customerEmail.toLowerCase()}` : `guest-name:${customerName(order)}`)}${currencyKey}`
        : `${channel(order)}${currencyKey}`
      const label = grouping === 'customer' ? customerName(order) : channel(order)
      const current = rowsByKey.get(key) ?? {
        key,
        label,
        groupBy: grouping,
        currency: mode === 'foreign' ? order.currency : baseCurrency,
        orderCount: 0,
        lineCount: 0,
        revenue: '0',
        tax: '0',
        shipping: '0',
        discount: '0',
        netRevenue: '0',
        netRevenueBound: 'exact',
        refundsGrossBasis: '0',
        refundsNetBasis: '0',
        refundsUnknownBasis: '0',
        revenueDecimal: new Prisma.Decimal(0),
        taxDecimal: new Prisma.Decimal(0),
        shippingDecimal: new Prisma.Decimal(0),
        discountDecimal: new Prisma.Decimal(0),
        credits: emptyCredits(),
        orderIds: new Set<string>(),
      }
      current.orderIds.add(order.id)
      current.orderCount = current.orderIds.size
      current.lineCount += order.lines.length
      for (const refund of refundsByOrder.get(order.id) ?? []) addCredit(current.credits, refund.totalsBasis, creditAmount(refund))
      current.revenueDecimal = current.revenueDecimal.add(toDecimal(mode === 'foreign' ? order.totalForeign : order.totalBase))
      current.taxDecimal = current.taxDecimal.add(toDecimal(mode === 'foreign' ? order.taxForeign : order.taxBase))
      current.shippingDecimal = current.shippingDecimal.add(toDecimal(mode === 'foreign' ? order.shippingForeign : order.shippingBase))
      // The order's WHOLE discount: the order-level field PLUS what the lines carry. Adding only the
      // order-level field made a WooCommerce coupon report as zero here while the product/category
      // grouping below (which reads line discounts) reported the full amount — the same order, two
      // answers. It is also simply wrong for a native order with a per-line markdown (o3d-y14).
      current.discountDecimal = current.discountDecimal.add(
        order.lines.reduce((sum, line) => sum.add(toDecimal(line.discountAmount)), toDecimal(order.discountAmount)),
      )
      current.currency = current.currency === (mode === 'foreign' ? order.currency : baseCurrency) ? current.currency : 'Multiple'
      rowsByKey.set(key, current)
      continue
    }

    const lineTotal = orderLineTotal(order, mode)
    const fallbackShare = order.lines.length > 0 ? new Prisma.Decimal(1).div(order.lines.length) : new Prisma.Decimal(0)
    for (const line of order.lines) {
      const currencyKey = mode === 'foreign' ? `:${order.currency}` : ''
      const key = `${grouping === 'category' ? (line.product?.category?.name ?? 'Uncategorised') : (line.productId ?? `sku:${line.sku ?? line.description}`)}${currencyKey}`
      const label = grouping === 'category' ? key : `${line.sku ?? line.product?.sku ?? 'No SKU'} ${line.product?.name ?? line.description}`.trim()
      const lineAmount = mode === 'foreign' ? line.totalForeign : line.totalBase
      const current = rowsByKey.get(key) ?? {
        key,
        label,
        groupBy: grouping,
        currency: mode === 'foreign' ? order.currency : baseCurrency,
        orderCount: 0,
        lineCount: 0,
        revenue: '0',
        tax: '0',
        shipping: '0',
        discount: '0',
        netRevenue: '0',
        netRevenueBound: 'exact',
        refundsGrossBasis: '0',
        refundsNetBasis: '0',
        refundsUnknownBasis: '0',
        revenueDecimal: new Prisma.Decimal(0),
        taxDecimal: new Prisma.Decimal(0),
        shippingDecimal: new Prisma.Decimal(0),
        discountDecimal: new Prisma.Decimal(0),
        credits: emptyCredits(),
        orderIds: new Set<string>(),
      }
      current.orderIds.add(order.id)
      current.orderCount = current.orderIds.size
      current.lineCount += 1
      // This line's share of the order's credit, allocated by line value exactly as revenue, tax,
      // shipping and discount are above. Allocating a GROSS credit by EX-VAT line value is the same
      // approximation the report already makes for the order-level tax and shipping it apportions;
      // it is exact whenever the order carries one rate, and the whole credit reaches SOME row of
      // the order either way, so the grand total is unaffected by how it splits.
      for (const refund of refundsByOrder.get(order.id) ?? []) {
        addCredit(current.credits, refund.totalsBasis, allocatedOrderAmount(creditAmount(refund), lineAmount, lineTotal, fallbackShare))
      }
      current.revenueDecimal = current.revenueDecimal.add(allocatedOrderAmount(mode === 'foreign' ? order.totalForeign : order.totalBase, lineAmount, lineTotal, fallbackShare))
      current.taxDecimal = current.taxDecimal.add(allocatedOrderAmount(mode === 'foreign' ? order.taxForeign : order.taxBase, lineAmount, lineTotal, fallbackShare))
      current.shippingDecimal = current.shippingDecimal.add(allocatedOrderAmount(mode === 'foreign' ? order.shippingForeign : order.shippingBase, lineAmount, lineTotal, fallbackShare))
      // The line's own discount PLUS this line's share of any order-level residual — the same whole
      // that the customer/channel grouping above reports, allocated the way revenue, tax and shipping
      // already are. Reading only the line field omitted a retained unallocated coupon, so the same
      // orders reported different discount totals purely as a function of grouping (o3d-3gp).
      current.discountDecimal = current.discountDecimal.add(
        toDecimal(line.discountAmount).add(allocatedOrderAmount(order.discountAmount, lineAmount, lineTotal, fallbackShare)),
      )
      current.currency = current.currency === (mode === 'foreign' ? order.currency : baseCurrency) ? current.currency : 'Multiple'
      rowsByKey.set(key, current)
    }
  }

  // Revenue here is `SalesOrder.totalBase` (or totalForeign), which is VAT-INCLUSIVE, so GROSS is
  // the basis every net figure below is on and the GROSS-basis credit is the comparable one.
  const FIGURE_BASIS = 'GROSS' as const
  const rows = [...rowsByKey.values()]
    .map((row) => {
      const currency = row.currency === 'Multiple' ? baseCurrency : row.currency
      return {
        key: row.key,
        label: row.label,
        groupBy: row.groupBy,
        currency: row.currency,
        orderCount: row.orderCount,
        lineCount: row.lineCount,
        revenue: moneyString(row.revenueDecimal, currency),
        tax: moneyString(row.taxDecimal, currency),
        shipping: moneyString(row.shippingDecimal, currency),
        discount: moneyString(row.discountDecimal, currency),
        netRevenue: moneyString(row.revenueDecimal.sub(comparableCredit(row.credits, FIGURE_BASIS)), currency),
        // Classified from the UNROUNDED figures, before the rounding above: the claim is about which
        // side of the published number the truth lies on, not about its last penny.
        netRevenueBound: netLinearFigureBoundDecimal({
          basisComplete: creditBasisComplete(row.credits, FIGURE_BASIS),
          unplacedCredit: unplacedCredit(row.credits, FIGURE_BASIS),
        }),
        refundsGrossBasis: moneyString(row.credits.gross, currency),
        refundsNetBasis: moneyString(row.credits.net, currency),
        refundsUnknownBasis: moneyString(row.credits.unknown, currency),
      }
    })
    // Ranked on the refund-aware figure. Ranking on `revenue` put a group that credited everything
    // back above one that kept a smaller sale, which is the ordering defect o3d-kyey names.
    .sort((a, b) => toDecimal(b.netRevenue).cmp(a.netRevenue) || a.label.localeCompare(b.label))

  const totals = [...rowsByKey.values()].reduce(
    (total, row) => {
      mergeCredits(total.credits, row.credits)
      return {
        revenue: total.revenue.add(row.revenueDecimal),
        tax: total.tax.add(row.taxDecimal),
        shipping: total.shipping.add(row.shippingDecimal),
        discount: total.discount.add(row.discountDecimal),
        credits: total.credits,
      }
    },
    { revenue: new Prisma.Decimal(0), tax: new Prisma.Decimal(0), shipping: new Prisma.Decimal(0), discount: new Prisma.Decimal(0), credits: emptyCredits() },
  )
  const paged = paginate(rows, filters, deps?.paginate !== false)

  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      revenue: moneyString(totals.revenue, baseCurrency),
      tax: moneyString(totals.tax, baseCurrency),
      shipping: moneyString(totals.shipping, baseCurrency),
      discount: moneyString(totals.discount, baseCurrency),
      netRevenue: moneyString(totals.revenue.sub(comparableCredit(totals.credits, FIGURE_BASIS)), baseCurrency),
      netRevenueBound: netLinearFigureBoundDecimal({
        basisComplete: creditBasisComplete(totals.credits, FIGURE_BASIS),
        unplacedCredit: unplacedCredit(totals.credits, FIGURE_BASIS),
      }),
      refundsGrossBasis: moneyString(totals.credits.gross, baseCurrency),
      refundsNetBasis: moneyString(totals.credits.net, baseCurrency),
      refundsUnknownBasis: moneyString(totals.credits.unknown, baseCurrency),
    },
    notices: [
      'Sales totals exclude cancelled orders. Product/category views allocate order-level totals across lines by line value so grand totals reconcile to SalesOrder totals.',
      REFUND_BASIS_NOTICE_SALES,
      mode === 'foreign' ? 'Foreign-currency product/category rows are split by original order currency; customer/channel rows show Multiple when a group contains more than one original currency.' : `Base-currency rows use ${baseCurrency} amounts recorded on the order.`,
    ],
  }
}

/**
 * The in-window SALE_DISPATCH cost, TOGETHER WITH WHICH DISPATCH MOVEMENT EACH PART OF IT COSTS.
 *
 * The amount alone cannot answer the caller's question. A cost total says a cost was posted; it
 * cannot say WHICH of the order's dispatches it covers, and an order whose every unit shipped but
 * whose lines only partly posted their cost produces a perfectly ordinary-looking total. So the
 * costed QUANTITY is carried per movement beside it, and `ordersWithEveryDispatchCosted` joins the
 * two populations — these entries and the dispatch movements they hang off — into the only
 * statement that supports a profit figure: every unit this order dispatched is a unit whose cost
 * was posted.
 */
type OrderDispatchCostEvidence = {
  /** Cost posted per order, summed over the in-window dispatch entries. */
  costByOrder: Map<string, Prisma.Decimal>
  /** Quantity COSTED per dispatch movement — `Σ CogsEntry.qty`, keyed by `movementId`. */
  costedQtyByMovement: Map<string, Prisma.Decimal>
}

async function loadCogsByOrder(client: SalesFulfillmentAnalyticsClient, window: { dateFrom: Date; dateTo: Date; dateToExclusive: Date }): Promise<OrderDispatchCostEvidence> {
  const rows = await client.cogsEntry.findMany({
    where: {
      movement: {
        type: StockMovementType.SALE_DISPATCH,
        createdAt: { gte: window.dateFrom, lt: window.dateToExclusive },
        referenceType: 'SalesOrder',
        referenceId: { not: null },
      },
    },
    select: {
      totalCostBase: true,
      qty: true,
      movement: { select: { id: true, referenceId: true } },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as Array<{ totalCostBase: DecimalInput; qty: DecimalInput; movement: { id: string; referenceId: string | null } }>
  assertSourceLimit(rows.length, SOURCE_ROW_LIMIT, 'Sales COGS source rows')
  const costByOrder = new Map<string, Prisma.Decimal>()
  const costedQtyByMovement = new Map<string, Prisma.Decimal>()
  for (const row of rows) {
    costedQtyByMovement.set(row.movement.id, (costedQtyByMovement.get(row.movement.id) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
    if (!row.movement.referenceId) continue
    costByOrder.set(row.movement.referenceId, (costByOrder.get(row.movement.referenceId) ?? new Prisma.Decimal(0)).add(toDecimal(row.totalCostBase)))
  }
  return { costByOrder, costedQtyByMovement }
}

/** How many contradicted customers the Customer Mix notice names before it points at the export. */
const INCONSISTENT_NOTICE_NAME_LIMIT = 10

/**
 * THE CONTRADICTED CUSTOMERS BY NAME, SO THE NOTICE CAN BE ACTED ON FROM ANY PAGE (o3d-7jfq r3).
 *
 * The count is computed over every group and the rows are then PAGINATED, so on a report longer
 * than a page the customers the notice is about can all rank outside the slice on screen — the
 * notice then announces a problem with nothing visible that carries it. That is the same complaint
 * that made over-costing its own status rather than a line in a summary: a count cannot tell an
 * operator WHICH customer to go and look at, and a count on page 1 about a row on page 4 is that
 * failure with an extra step. Names, not ids: the Customer column renders `customerName`, so the
 * identifier the notice hands over is the one the operator will be reading down the page for.
 *
 * Semicolons separate them because a company name may contain a comma, and a list a reader cannot
 * split is not a list of identifiers.
 *
 * Capped, because a notice is one line of prose and a data incident could contradict hundreds. The
 * overflow is not dropped: it is COUNTED, said out loud, and pointed at the CSV export, which is
 * built with `paginate: false` and carries `costEvidence` on every row — so the complete answer
 * always exists somewhere the notice names, however long the list gets.
 */
function namedInconsistentCustomers(names: string[]): string {
  const shown = names.slice(0, INCONSISTENT_NOTICE_NAME_LIMIT)
  const rest = names.length - shown.length
  const overflow = rest > 0
    ? `, and ${rest} more not named here — the CSV export is not paginated and stamps every one of them costEvidence=inconsistent`
    : ''
  return `They are, highest-ranked first: ${shown.join('; ')}${overflow}.`
}

/**
 * THE COSTED-QUANTITY SHORTFALL A DISPATCH MAY CARRY AND STILL COUNT AS COSTED.
 *
 * SHORTFALL ONLY. There is no excess counterpart and deliberately none — see the closing
 * paragraph of `dispatchCostEvidenceByOrder`.
 *
 * `consumeFifoLayersStrict` (lib/cost-layers) absorbs a FIFO shortfall of at most this, and throws
 * above it. Using the SAME figure means a movement is treated as costed here exactly when the
 * costing engine treated it as costed there — a looser tolerance would let a real uncosted
 * fraction through, and a tighter one would withhold profit for float-to-Decimal noise the engine
 * has already ruled acceptable.
 */
const COSTED_QTY_TOLERANCE = new Prisma.Decimal('0.000001')

/**
 * The orders whose EVERY in-window dispatch movement is costed for its whole quantity.
 *
 * `cogsByOrder.has(orderId)` — the test this replaced — asks whether ANY cost was posted, which is
 * the missing-cost defect one step along and the exact mirror of what `orderCostCoverage` fixed on
 * the dispatch side. Coverage proves every ordered unit SHIPPED; this proves every shipped unit was
 * COSTED. A profit figure needs both, because either one alone lets a real cost be silently treated
 * as zero: coverage alone accepts an order that shipped in full and posted one line's cost, and
 * `.has` alone accepts an order that posted one line's cost and shipped nothing else at all.
 *
 * Matched at the MOVEMENT, not summed per order. The sum would let one over-costed movement cover
 * another's shortfall — and while the FIFO engine never consumes more than a movement's quantity,
 * relying on that is relying on the writer whose output this function exists to check.
 *
 * SO THE MATCH IS TWO-SIDED, AND THE TWO SIDES DO NOT MEAN THE SAME THING (o3d-7jfq round 2). A
 * one-sided `movement.qty - costedQty > tolerance` rejects only a SHORTFALL; a movement costed
 * BEYOND its own quantity gives a negative difference and reads as fully costed — which is the very
 * thing the paragraph above refuses to take on trust, granted anyway by the shape of the
 * comparison. `Σ CogsEntry.qty > StockMovement.qty` cannot be a real event: `consumeFifoLayersStrict`
 * consumes at most the requested quantity, so the consumed layers it writes entries from can never
 * exceed the movement. Nothing in the schema ties the two together, and the deferred COGS-evidence
 * guard checks only that an entry EXISTS — so a double-posted entry set is exactly what excess
 * looks like, and it lands in `costByOrder` twice while the gate calls the order complete.
 *
 * AND EXCESS IS NOT A GAP — it is CONTRADICTORY EVIDENCE, so it is reported apart from a shortfall.
 * Both withhold, because neither supports a profit figure. But an incomplete order resolves itself:
 * the rest ships, the rest is costed, and next month's report publishes. Contradictory evidence
 * never resolves, means the COGS ledger itself is double-posted — which silently overstates cost in
 * every OTHER report that sums `CogsEntry.totalCostBase` — and is acted on by deleting an entry, not
 * by waiting. Folding the two into one boolean would send an operator looking for a missing entry
 * that is not missing, and the report's own notice names its causes: an unnamed third cause makes
 * that notice a false statement about the row in front of them.
 *
 * AND THE TOLERANCE BELONGS TO ONE SIDE ONLY (o3d-7jfq round 3). Carrying the same band into both
 * arms looked like symmetry and was not. The band exists to absorb the FIFO engine's own
 * arithmetic, and on the SHORTFALL side there is arithmetic to absorb: `consumeFifoLayersStrict`
 * really does leave a residue that small and treats the movement as costed, so a match tighter
 * than the engine's would withhold profit the engine has already ruled complete. On the EXCESS
 * side there is nothing to absorb, by the paragraph above — the engine consumes at most the
 * requested quantity, so it cannot produce excess AT ALL, and any excess that exists was written
 * by something else. Nor is 0.000001 sub-storage noise: `StockMovement.qty` and `CogsEntry.qty`
 * are both `Decimal(14,6)`, so it is the smallest quantity the schema can represent — one whole
 * unit of the stored scale, a real posted figure and not a rounding artefact. So the excess arm
 * rejects at `> 0`, and the tolerance survives only on `excess.neg()`.
 *
 * Kit-safe by construction: both quantities are the MOVEMENT's own, so the parent-vs-component unit
 * mismatch that `loadInWindowDispatchedQtyByLine` has to convert around never arises here.
 */
type DispatchCostEvidence = {
  /** Orders whose every in-window dispatch is costed for its whole quantity — and for no more. */
  fullyCosted: Set<string>
  /** Orders carrying a dispatch costed BEYOND its own quantity. Withheld, and separately named. */
  inconsistent: Set<string>
}

function dispatchCostEvidenceByOrder(
  dispatchMovements: InWindowDispatchMovement[],
  costedQtyByMovement: Map<string, Prisma.Decimal>,
): DispatchCostEvidence {
  const fullyCosted = new Set<string>()
  const shortOrders = new Set<string>()
  const inconsistent = new Set<string>()
  for (const movement of dispatchMovements) {
    if (!movement.orderId) continue
    fullyCosted.add(movement.orderId)
    const costed = costedQtyByMovement.get(movement.id) ?? new Prisma.Decimal(0)
    // Excess POSITIVE, shortfall NEGATIVE. `excess.neg()` is the old `qty - costed`, so the
    // shortfall arm is unchanged to the digit — tolerance and all — while the excess arm, which
    // has no engine arithmetic to forgive, rejects the first storage unit of it.
    const excess = costed.sub(toDecimal(movement.qty))
    if (excess.gt(0)) inconsistent.add(movement.orderId)
    else if (excess.neg().gt(COSTED_QTY_TOLERANCE)) shortOrders.add(movement.orderId)
  }
  for (const orderId of shortOrders) fullyCosted.delete(orderId)
  for (const orderId of inconsistent) fullyCosted.delete(orderId)
  return { fullyCosted, inconsistent }
}

export async function getCustomerAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<CustomerReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const baseCurrency = await baseCurrencyFromDeps(deps)
  const window = period(filters, generatedAt)
  const [orders, { costByOrder: cogsByOrder, costedQtyByMovement }] = await Promise.all([
    loadSalesOrders(client, filters, window),
    loadCogsByOrder(client, window),
  ])
  assertSourceLimit(orders.length, SOURCE_ROW_LIMIT, 'Customer analytics source orders')
  // What each line actually shipped inside the window — the evidence that the cost posted for an
  // order covers the revenue this report measures it against. See `orderCostCoverage`.
  const { byLine: dispatchedQtyByLine, dispatchMovements } = await loadInWindowDispatchedQtyByLine(client, window, orders, 'Customer analytics')
  // ...and, from the SAME movements, which orders had every one of those dispatches costed — and
  // which carry a dispatch costed for more units than it moved, which is a different answer.
  const { fullyCosted: fullyCostedOrders, inconsistent: inconsistentOrders } = dispatchCostEvidenceByOrder(dispatchMovements, costedQtyByMovement)
  // As in Sales Analytics: an order cohort, so ALL of these orders' credit counts, whenever raised.
  const refunds = await loadOrderRefunds(client, orders.map((order) => order.id))
  const refundsByOrder = new Map<string, OrderRefundRow[]>()
  for (const refund of refunds) {
    const existing = refundsByOrder.get(refund.orderId)
    if (existing) existing.push(refund)
    else refundsByOrder.set(refund.orderId, [refund])
  }

  // `costCaptured` is OMITTED, not carried and ignored: it is derived from `costEvidence` at the
  // projection, and a group field of the same name would be a second place to get it wrong.
  type CustomerGroup = Omit<CustomerReportRow, 'costCaptured'> & {
    revenue: Prisma.Decimal
    revenueExVat: Prisma.Decimal
    cogs: Prisma.Decimal
    arExposure: Prisma.Decimal
    credits: CreditBuckets
    /** Credit on the orders that are UNPAID, which is the only credit AR exposure may net off. */
    unpaidCredits: CreditBuckets
    orderIds: Set<string>
  }
  const groups = new Map<string, CustomerGroup>()
  for (const order of orders) {
    const key = order.customerId ?? (order.customerEmail ? `guest-email:${order.customerEmail.toLowerCase()}` : `guest-name:${customerName(order)}`)
    const current: CustomerGroup = groups.get(key) ?? {
      customerId: order.customerId,
      customerName: customerName(order),
      customerEmail: order.customerEmail,
      orderCount: 0,
      revenueBase: '0',
      netRevenueBase: '0',
      netRevenueBaseBound: 'exact',
      netRevenueExVatBase: '0',
      netRevenueExVatBaseBound: 'exact',
      grossProfitBase: '0',
      grossProfitBaseBound: 'exact',
      costEvidence: 'complete',
      arExposureBase: '0',
      arExposureBaseBound: 'exact',
      shareOfRevenuePct: '0',
      shareOfRevenuePctBound: 'exact',
      refundsGrossBasis: '0',
      refundsNetBasis: '0',
      refundsUnknownBasis: '0',
      revenue: new Prisma.Decimal(0),
      revenueExVat: new Prisma.Decimal(0),
      cogs: new Prisma.Decimal(0),
      arExposure: new Prisma.Decimal(0),
      credits: emptyCredits(),
      unpaidCredits: emptyCredits(),
      orderIds: new Set<string>(),
    }
    current.orderIds.add(order.id)
    current.orderCount = current.orderIds.size
    current.revenue = current.revenue.add(toDecimal(order.totalBase))
    // The EX-VAT revenue gross profit is measured against. `SalesOrder.totalBase` is VAT-INCLUSIVE
    // and `CogsEntry.totalCostBase` is ex-tax, so the old `totalBase - cogs` was a subtraction
    // between two different units and overstated profit by the whole VAT on every taxable order.
    current.revenueExVat = current.revenueExVat.add(toDecimal(order.totalBase).sub(toDecimal(order.taxBase)))
    // A MISSING COST IS NOT A ZERO COST, AND A PARTIAL COST IS NOT A COMPLETE ONE.
    //
    // `cogsByOrder` is keyed on orders with a SALE_DISPATCH COGS entry inside the window; an order
    // created near the end of the period and dispatched after it has none, and the old `?? 0`
    // published its entire revenue as profit. `.has` is the right question for THAT — `.get() ?? 0`
    // cannot tell "no cost posted" from "cost posted, and it was zero".
    //
    // But `.has` only asks whether ANY cost exists. A partially dispatched order has some, so it
    // passed, and one dispatched unit's cost was then set against the whole order's revenue. The
    // question the figure needs is whether the cost is COMPLETE for the revenue being measured, and
    // that is `orderCostCoverage`: every dispatchable ordered unit shipped inside the window.
    //
    // COVERAGE IS ONLY HALF OF IT, AND `.has` WAS STILL THE OTHER HALF UNTIL NOW. Coverage proves
    // every ordered unit was DISPATCHED; `.has` then proved only that the order carries at least
    // one COGS row. An order whose every unit shipped but whose lines only PARTLY posted their cost
    // satisfies both — and publishes a profit built from part of its cost, which is the same defect
    // as the `?? 0` and the partial dispatch, arrived at from the third side. Nothing about a cost
    // TOTAL can rule it out: the total is the thing that is short. So the second half now matches
    // the posted cost to the DISPATCHED UNITS it is being set against, movement by movement —
    // `ordersWithEveryDispatchCosted`. It subsumes `.has`: an order that is `covered` dispatched at
    // least one unit, and a costed dispatch has a COGS entry by construction.
    //
    // AND NEITHER IS THE RIGHT SECOND HALF FOR EVERY ORDER. A service-only order — one
    // whose lines are all NON_INVENTORY — has no COGS entry BY DESIGN, so requiring one would
    // withhold that customer's profit permanently for an order whose cost is a known zero. That is
    // `nothing-to-dispatch`, and it is complete on its own evidence. The `?? 0` there is not the
    // one this branch removed: that one could not tell an absent cost from a zero one, while this
    // has just established there is nothing on the order that could post a cost at all.
    const coverage = orderCostCoverage(order, dispatchedQtyByLine)
    if (inconsistentOrders.has(order.id)) {
      // FIRST, ahead of coverage: a dispatch costed beyond its own quantity contradicts itself, and
      // nothing coverage can say about the order repairs that. `nothing-to-dispatch` in particular
      // must not publish here — an order with no dispatchable line that nonetheless carries an
      // over-costed dispatch movement is contradictory twice over, not "costed at zero".
      current.costEvidence = 'inconsistent'
    } else if (coverage === 'nothing-to-dispatch') {
      current.cogs = current.cogs.add(cogsByOrder.get(order.id) ?? new Prisma.Decimal(0))
    } else if (coverage === 'covered' && fullyCostedOrders.has(order.id)) {
      // `?? 0` is sound HERE and nowhere else in this block: membership of `fullyCostedOrders`
      // requires a costed dispatch movement, so an absent total would be an order whose entries
      // cost a positive quantity at no cost at all — a genuine zero, not an unknown.
      current.cogs = current.cogs.add(cogsByOrder.get(order.id) ?? new Prisma.Decimal(0))
    } else if (current.costEvidence !== 'inconsistent') {
      // A customer's other order may already have contradicted itself. The graver answer stands:
      // downgrading it to `incomplete` would send the operator after the wrong thing.
      current.costEvidence = 'incomplete'
    }
    const orderRefunds = refundsByOrder.get(order.id) ?? []
    for (const refund of orderRefunds) addCredit(current.credits, refund.totalsBasis, refund.totalBase)
    if (!order.paidAt) {
      current.arExposure = current.arExposure.add(toDecimal(order.totalBase))
      // Only an UNPAID order's credit reduces exposure: a credit note against an order already paid
      // is a debt to the customer, not less money owed by them.
      for (const refund of orderRefunds) addCredit(current.unpaidCredits, refund.totalsBasis, refund.totalBase)
    }
    groups.set(key, current)
  }

  // Accumulated UNROUNDED and rounded exactly once, at the figure. Summing the rounded row strings
  // would put the published totals and the counterfactual their bounds are classified against on
  // different numbers — the o3d-iigc round-5 finding in the sales-stats summary.
  const period_ = {
    revenue: new Prisma.Decimal(0),
    netRevenue: new Prisma.Decimal(0),
    revenueExVat: new Prisma.Decimal(0),
    netRevenueExVat: new Prisma.Decimal(0),
    cogs: new Prisma.Decimal(0),
    grossProfit: new Prisma.Decimal(0),
    arExposure: new Prisma.Decimal(0),
    credits: emptyCredits(),
    unpaidCredits: emptyCredits(),
    costCapturedRows: 0,
  }
  const netRevenueByGroup = new Map<string, Prisma.Decimal>()
  for (const [key, group] of groups) {
    const netRevenue = group.revenue.sub(comparableCredit(group.credits, 'GROSS'))
    netRevenueByGroup.set(key, netRevenue)
    period_.revenue = period_.revenue.add(group.revenue)
    period_.netRevenue = period_.netRevenue.add(netRevenue)
    period_.revenueExVat = period_.revenueExVat.add(group.revenueExVat)
    period_.arExposure = period_.arExposure.add(group.arExposure.sub(comparableCredit(group.unpaidCredits, 'GROSS')))
    mergeCredits(period_.credits, group.credits)
    mergeCredits(period_.unpaidCredits, group.unpaidCredits)
    if (group.costEvidence === 'complete') {
      period_.costCapturedRows += 1
      const netRevenueExVat = group.revenueExVat.sub(comparableCredit(group.credits, 'NET'))
      period_.netRevenueExVat = period_.netRevenueExVat.add(netRevenueExVat)
      period_.cogs = period_.cogs.add(group.cogs)
      period_.grossProfit = period_.grossProfit.add(netRevenueExVat.sub(group.cogs))
    }
  }
  // A ratio is bounded by the WHOLE report's completeness, not the row's: a row with no unplaced
  // credit of its own still had its denominator moved by another row's.
  const shareBound = shareFigureBound({ reportBasisComplete: creditBasisComplete(period_.credits, 'GROSS') })

  const rows: CustomerReportRow[] = [...groups.entries()]
    .map(([key, row]) => {
      const netRevenue = netRevenueByGroup.get(key)!
      const netRevenueExVat = row.revenueExVat.sub(comparableCredit(row.credits, 'NET'))
      const grossProfit = netRevenueExVat.sub(row.cogs)
      // The single derivation of the decision from the reason — see `CustomerReportRow.costEvidence`.
      const costCaptured = row.costEvidence === 'complete'
      return {
        customerId: row.customerId,
        customerName: row.customerName,
        customerEmail: row.customerEmail,
        orderCount: row.orderCount,
        revenueBase: moneyString(row.revenue, baseCurrency),
        netRevenueBase: moneyString(netRevenue, baseCurrency),
        netRevenueBaseBound: netLinearFigureBoundDecimal({
          basisComplete: creditBasisComplete(row.credits, 'GROSS'),
          unplacedCredit: unplacedCredit(row.credits, 'GROSS'),
        }),
        netRevenueExVatBase: moneyString(netRevenueExVat, baseCurrency),
        netRevenueExVatBaseBound: netLinearFigureBoundDecimal({
          basisComplete: creditBasisComplete(row.credits, 'NET'),
          unplacedCredit: unplacedCredit(row.credits, 'NET'),
        }),
        grossProfitBase: costCaptured ? moneyString(grossProfit, baseCurrency) : null,
        // A withheld figure carries no bound: there is no published number for a relation to be
        // about, and marking it would read as a claim about something that was not published.
        grossProfitBaseBound: costCaptured
          ? netLinearFigureBoundDecimal({
            basisComplete: creditBasisComplete(row.credits, 'NET'),
            unplacedCredit: unplacedCredit(row.credits, 'NET'),
          })
          : 'indeterminate',
        costCaptured,
        costEvidence: row.costEvidence,
        arExposureBase: moneyString(row.arExposure.sub(comparableCredit(row.unpaidCredits, 'GROSS')), baseCurrency),
        arExposureBaseBound: netLinearFigureBoundDecimal({
          basisComplete: creditBasisComplete(row.unpaidCredits, 'GROSS'),
          unplacedCredit: unplacedCredit(row.unpaidCredits, 'GROSS'),
        }),
        shareOfRevenuePct: pctString(netRevenue, period_.netRevenue),
        shareOfRevenuePctBound: shareBound,
        refundsGrossBasis: moneyString(row.credits.gross, baseCurrency),
        refundsNetBasis: moneyString(row.credits.net, baseCurrency),
        refundsUnknownBasis: moneyString(row.credits.unknown, baseCurrency),
      }
    })
    // Ranked on the refund-aware figure, so a customer who returned everything no longer outranks
    // one who kept a smaller order.
    .sort((a, b) => toDecimal(b.netRevenueBase).cmp(a.netRevenueBase) || a.customerName.localeCompare(b.customerName))
  // ONE derivation of both the count and the list, taken from the SORTED, UNPAGINATED rows: the
  // only place where "which customers" and "in the order the operator will page through them" are
  // both true. A second walk over `groups` for the count would be a second thing to get wrong, and
  // a count that disagreed with the names beneath it would be worse than either alone.
  const inconsistentCustomers = rows.filter((row) => row.costEvidence === 'inconsistent').map((row) => row.customerName)
  const paged = paginate(rows, filters, deps?.paginate !== false)
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      revenueBase: moneyString(period_.revenue, baseCurrency),
      netRevenueBase: moneyString(period_.netRevenue, baseCurrency),
      netRevenueBaseBound: netLinearFigureBoundDecimal({
        basisComplete: creditBasisComplete(period_.credits, 'GROSS'),
        unplacedCredit: unplacedCredit(period_.credits, 'GROSS'),
      }),
      netRevenueExVatBase: moneyString(period_.netRevenueExVat, baseCurrency),
      // The period profit sums the CAPTURED rows only, which is why the count travels with it: a
      // total over a subset that does not say it is a subset is the withheld-figure defect again,
      // one level up.
      grossProfitBase: moneyString(period_.grossProfit, baseCurrency),
      grossProfitBaseBound: netLinearFigureBoundDecimal({
        basisComplete: creditBasisComplete(period_.credits, 'NET'),
        unplacedCredit: unplacedCredit(period_.credits, 'NET'),
      }),
      costCapturedRows: String(period_.costCapturedRows),
      // Travels beside the count it is NOT part of: an inconsistent customer is withheld like an
      // incomplete one, and unlike one it will still be withheld next month if nobody acts.
      costInconsistentRows: String(inconsistentCustomers.length),
      arExposureBase: moneyString(period_.arExposure, baseCurrency),
      arExposureBaseBound: netLinearFigureBoundDecimal({
        basisComplete: creditBasisComplete(period_.unpaidCredits, 'GROSS'),
        unplacedCredit: unplacedCredit(period_.unpaidCredits, 'GROSS'),
      }),
      refundsGrossBasis: moneyString(period_.credits.gross, baseCurrency),
      refundsNetBasis: moneyString(period_.credits.net, baseCurrency),
      refundsUnknownBasis: moneyString(period_.credits.unknown, baseCurrency),
    },
    notices: [
      'AR exposure is unpaid sales-order totalBase for the selected period, less the gross-basis credit raised against those unpaid orders. COGS comes from CogsEntry rows linked to SALE_DISPATCH movements.',
      `Gross profit is withheld for a customer with an in-period order whose posted cost does not cover the revenue it is measured against — no COGS posted in the period, not every ordered stock unit dispatched within it, or a dispatch costed for more units than it moved — and the period total covers ${period_.costCapturedRows} of ${groups.size} customers. A missing cost is not a zero cost, and a partially dispatched order's cost is not the whole order's cost.`,
      // Named separately, and only when there is one: it is the cause an operator has to ACT on,
      // and the only one of the three that will still be here next month if nobody does.
      ...(inconsistentCustomers.length > 0
        ? [`${inconsistentCustomers.length} of ${groups.size} customers are withheld as INCONSISTENT rather than incomplete: an in-period dispatch carries COGS entries for more units than the movement moved, which the FIFO engine cannot produce and most often means the entries were posted twice. Nothing further will ship to complete these — the posted cost has to be corrected. Until it is, every report that sums COGS entries is overstating cost by the duplicate. ${namedInconsistentCustomers(inconsistentCustomers)}`]
        : []),
      'Non-inventory lines — services, fees, delivery charges — book no stock movement and post no cost, so they are not asked to show a dispatch and an order made only of them is fully costed at zero. A variable-parent line is not exempt: goods do leave for it and cannot be traced to it, so its cost is unknown and the order is withheld.',
      REFUND_BASIS_NOTICE_CUSTOMER_MIX,
    ],
  }
}

export type MarginDispatchLinkRow = {
  /** movement.referenceId when referenceType === 'SalesOrder', else null */
  orderId: string | null
  /** movement.productId (== shipmentLine.productId for a real dispatch) */
  productId: string
  qty: DecimalInput
  /** shipmentLine.lineId for a linked dispatch, null for legacy/unlinked rows */
  shipmentLineLineId: string | null
}

export type MarginLineRef = {
  id: string
  orderId: string
  productId: string | null
  qty: DecimalInput
}

/**
 * In-window dispatched quantity attributed to each sales-order line, keyed by
 * `${lineId}|${productId}`, so margin revenue can be prorated to units actually
 * dispatched in the reporting window (fixes the scjz.51 period mismatch where a
 * line shipped across periods booked its full revenue against in-window COGS).
 *
 * Linked dispatch movements (StockMovement.shipmentLineId set — the common case
 * after the 4pz6.1 backfill) attribute exactly to their sales line. Any legacy
 * unlinked residual for an (order, product) is distributed across that order's
 * lines of the product proportionally to line quantity — never worse than the
 * old full-revenue behaviour, and exact once every movement is linked.
 *
 * o3d-7r6x: LINKED DISPATCH IS IN COMPONENT UNITS, THE LINE IS IN PARENT UNITS.
 * A KIT line's dispatch movements carry the leaf component productIds, so keying
 * the linked quantity on `(lineId, movement.productId)` and reading it back with
 * `(lineId, salesOrderLine.productId)` never matched: every kit line contributed
 * ZERO dispatched quantity and silently dropped out of margin altogether. Linked
 * quantities are now converted to WHOLE ORDERED units through the same
 * fulfillment-requirement graph the fill-rate and backorder readers use
 * (`requirementsByLine`), i.e. min over components of qty/factor. A non-kit line
 * is one self-requirement of factor 1, so its arithmetic is unchanged.
 *
 * The unlinked residual stays keyed on the movement's own productId: with no
 * shipment-line link there is nothing to convert through, so a kit's legacy
 * unlinked component rows still find no matching line and contribute nothing —
 * exactly as before, and the only remaining gap here.
 */
export function computeInWindowDispatchedQtyByLine(
  dispatchRows: MarginDispatchLinkRow[],
  orderLines: MarginLineRef[],
  requirementsByLine: Map<string, DecimalFulfillmentRequirement[]>,
): Map<string, Prisma.Decimal> {
  const lineKey = (lineId: string, productId: string) => `${lineId}|${productId}`
  const orderProductKey = (orderId: string, productId: string) => `${orderId}|${productId}`

  const linkedRows: Array<{ lineId: string; productId: string; qty: DecimalInput }> = []
  const totalByOrderProduct = new Map<string, Prisma.Decimal>()
  const linkedByOrderProduct = new Map<string, Prisma.Decimal>()
  for (const row of dispatchRows) {
    const qty = toDecimal(row.qty)
    if (row.orderId) {
      const opk = orderProductKey(row.orderId, row.productId)
      totalByOrderProduct.set(opk, (totalByOrderProduct.get(opk) ?? new Prisma.Decimal(0)).add(qty))
      if (row.shipmentLineLineId) {
        linkedByOrderProduct.set(opk, (linkedByOrderProduct.get(opk) ?? new Prisma.Decimal(0)).add(qty))
      }
    }
    if (row.shipmentLineLineId) {
      linkedRows.push({ lineId: row.shipmentLineLineId, productId: row.productId, qty })
    }
  }

  // Fall back to a factor-1 self-requirement for any line the caller did not
  // resolve through the graph, so the conversion is total and a non-kit line
  // behaves identically to the pre-o3d-7r6x arithmetic.
  const effectiveRequirements = new Map<string, DecimalFulfillmentRequirement[]>()
  for (const line of orderLines) {
    if (!line.productId) continue
    const requirements = requirementsByLine.get(line.id)
    effectiveRequirements.set(
      line.id,
      requirements && requirements.length > 0
        ? requirements
        : [{ productId: line.productId, factor: new Prisma.Decimal(1) }],
    )
  }
  const linkedCoverageByLine = calculateDecimalCoverageByLine(effectiveRequirements, linkedRows)

  const lineQtySumByOrderProduct = new Map<string, Prisma.Decimal>()
  for (const line of orderLines) {
    if (!line.productId) continue
    const opk = orderProductKey(line.orderId, line.productId)
    lineQtySumByOrderProduct.set(opk, (lineQtySumByOrderProduct.get(opk) ?? new Prisma.Decimal(0)).add(toDecimal(line.qty)))
  }

  const effective = new Map<string, Prisma.Decimal>()
  for (const line of orderLines) {
    if (!line.productId) continue
    const opk = orderProductKey(line.orderId, line.productId)
    let qty = linkedCoverageByLine.get(line.id) ?? new Prisma.Decimal(0)
    const residual = (totalByOrderProduct.get(opk) ?? new Prisma.Decimal(0))
      .sub(linkedByOrderProduct.get(opk) ?? new Prisma.Decimal(0))
    if (residual.gt(0)) {
      const lineQtySum = lineQtySumByOrderProduct.get(opk) ?? new Prisma.Decimal(0)
      if (lineQtySum.gt(0)) {
        qty = qty.add(residual.mul(toDecimal(line.qty)).div(lineQtySum))
      }
    }
    if (qty.gt(0)) effective.set(lineKey(line.id, line.productId), qty)
  }
  return effective
}

/**
 * The in-window dispatched quantity of every line of `orders`, keyed `${lineId}|${productId}`.
 *
 * ONE loader for the questions that all need it, so they cannot drift on what "dispatched in this
 * window" means: Gross Margin PRORATES a line's revenue to it, and Customer Mix asks whether the
 * cost posted for an order covers the revenue that order is publishing (see `orderCostCoverage`).
 * Both are the same measurement — how much of what was ordered was actually shipped, and therefore
 * costed, inside the period being reported.
 *
 * The unaggregated movements come back beside the map for the third question, which the aggregate
 * cannot answer: whether each of those dispatches actually posted its cost
 * (`ordersWithEveryDispatchCosted`).
 */
type InWindowDispatchMovement = { id: string; orderId: string | null; qty: DecimalInput }

async function loadInWindowDispatchedQtyByLine(
  client: SalesFulfillmentAnalyticsClient,
  window: { dateFrom: Date; dateTo: Date; dateToExclusive: Date },
  orders: SalesOrderRow[],
  sourceLabel: string,
): Promise<{ byLine: Map<string, Prisma.Decimal>; dispatchMovements: InWindowDispatchMovement[] }> {
  // In-window dispatch movements carry the line-granularity link (scjz.51/4pz6).
  const dispatchRows = await client.stockMovement.findMany({
    where: {
      type: StockMovementType.SALE_DISPATCH,
      referenceType: 'SalesOrder',
      createdAt: { gte: window.dateFrom, lt: window.dateToExclusive },
    },
    select: { id: true, qty: true, referenceId: true, productId: true, shipmentLine: { select: { lineId: true } } },
    take: SOURCE_ROW_LIMIT + 1,
  }) as Array<{ id: string; qty: DecimalInput; referenceId: string | null; productId: string; shipmentLine: { lineId: string } | null }>
  assertSourceLimit(dispatchRows.length, SOURCE_ROW_LIMIT, `${sourceLabel} dispatch source rows`)
  // o3d-7r6x: a KIT line's dispatch movements are denominated in leaf components, the line in
  // parent units. Resolve each line's component requirements so the linked dispatch can be
  // converted to whole ordered units before it is matched back to the line.
  const graph = await loadFulfillmentProductGraph(
    client as unknown as Parameters<typeof loadFulfillmentProductGraph>[0],
    [...new Set(orders.flatMap((order) => order.lines.map((line) => line.productId)).filter((id): id is string => Boolean(id)))],
  )
  const requirementsByLine = new Map<string, DecimalFulfillmentRequirement[]>()
  for (const order of orders) {
    for (const line of order.lines) {
      if (!line.productId || requirementsByLine.has(line.id)) continue
      requirementsByLine.set(
        line.id,
        requirementsMapToDecimalRows(expandFulfillmentRequirementsDecimal(line.productId, 1, graph)),
      )
    }
  }
  return {
    byLine: computeInWindowDispatchedQtyByLine(
      dispatchRows.map((row) => ({
        orderId: row.referenceId,
        productId: row.productId,
        qty: row.qty,
        shipmentLineLineId: row.shipmentLine?.lineId ?? null,
      })),
      orders.flatMap((order) => order.lines.map((line) => ({
        id: line.id,
        orderId: order.id,
        productId: line.productId,
        qty: line.qty,
      }))),
      requirementsByLine,
    ),
    // The SAME rows, unaggregated. `ordersWithEveryDispatchCosted` has to ask about each movement
    // individually, and the per-line map has already added them up — so the population that
    // establishes coverage and the population that establishes costedness are one query, and can
    // never drift on what "dispatched in this window" means.
    dispatchMovements: dispatchRows.map((row) => ({ id: row.id, orderId: row.referenceId, qty: row.qty })),
  }
}

/**
 * IS THE POSTED COST COMPLETE FOR THE REVENUE BEING MEASURED?
 *
 * Customer Mix measures gross profit against the WHOLE order's ex-VAT revenue — `SalesOrder.
 * totalBase` less tax, every ordered unit of it. The question "was a cost posted for this order?"
 * is therefore the wrong question, and answering it with `cogsByOrder.has(order.id)` is the
 * missing-cost defect one step along: an order that dispatched one of ten units has a COGS entry,
 * passes that test, and gets ONE unit's cost set against TEN units' revenue. The profit that comes
 * out is plausible, confident and far too high — the same shape as the `?? 0` it replaced.
 *
 * COMPLETE therefore means: every ordered unit of every line THAT CAN BE DISPATCHED was dispatched
 * INSIDE THE WINDOW. The in-window part is not a detail. Orders are selected by `createdAt`, so a
 * dispatch can never fall before the window, but it can fall after it: an order created on the 30th
 * and shipped on the 2nd has cost in NEXT period's `cogsByOrder` and revenue in THIS one. Measuring
 * coverage with the same in-window dispatched quantity Gross Margin prorates by makes both leaks
 * one rule.
 *
 * AND THE "THAT CAN BE DISPATCHED" IS THE WHOLE OF THE REST OF IT. Withholding is right when a
 * figure cannot be supported and wrong when it can, so this has to separate two things a naive
 * "every line must show dispatch" rule folds together:
 *
 *   NO COST TO POST. A NON_INVENTORY line — a service, a fee, a delivery charge — is by definition
 *   not stock-tracked. It books no stock movement, so it can never carry a dispatch and never
 *   produces a `CogsEntry`; its contribution to the order's cost is a KNOWN ZERO. Requiring a
 *   dispatch for it would withhold that customer's gross profit for as long as the order exists,
 *   and an order carrying a delivery charge is the ordinary case, not the exotic one. It is skipped
 *   here, and an order whose only quantity-bearing lines are of this kind is `nothing-to-dispatch`:
 *   completely costed, at zero, with no COGS entry needed to prove it.
 *
 *   COST UNKNOWN. Everything else that cannot show coverage fails closed, because "no dispatch
 *   found" is then not evidence of no cost:
 *     - a line with no `productId` (the schema's "product deleted / not found") has no product for
 *       a dispatch movement to be attributed through, so what it shipped is not knowable;
 *     - a line whose product row did not load, for the same reason — the type that would decide
 *       this is the thing that is missing;
 *     - a VARIABLE line. VARIABLE is a parent of stock-tracked variants: goods really will leave
 *       for it, and `external-fulfillment` records that such a line can never receive shipment
 *       coverage. So its cost is real and permanently untraceable — the opposite of NON_INVENTORY,
 *       and the case where publishing profit would silently treat a cost as zero. Naming the two
 *       types together (as `isStockTrackedProductType` does, for a question about STOCK) would put
 *       a real unposted cost into the same bucket as a service line's absent one.
 *
 * A line ordered at zero quantity has no units to cover and is skipped. An order with no
 * quantity-bearing line at all is `incomplete`, not `nothing-to-dispatch`: it sold nothing this
 * report can see while carrying revenue that says otherwise, and that is an absence of evidence.
 *
 * Note this is about COVERAGE, not amount: an order whose posted cost is genuinely zero is complete
 * as long as its units shipped, which is the "cost posted, and it was zero" evidence `.has` was
 * introduced to preserve.
 *
 * AND `dispatched < ordered` IS ONE-SIDED ON PURPOSE — unlike the costed-quantity match beside it,
 * which o3d-7jfq round 2 had to make symmetric. Asked and answered, so it is not re-litigated:
 *
 *   - The two sides here are not the same measurement. `costedQty` and `movement.qty` are one
 *     movement's own two fields in one unit; `dispatched` is DERIVED — a kit conversion plus the
 *     proration of unlinked legacy movements across a line's quantity share, which
 *     `computeInWindowDispatchedQtyByLine` documents as its remaining gap. A line already covered
 *     by a linked dispatch that also picks up a share of a legacy unlinked movement for the same
 *     product exceeds its ordered quantity with nothing wrong anywhere. That is an imprecise
 *     estimate, not evidence contradicting itself.
 *   - The writers differ in what they can be trusted for. `StockMovement.idempotencyKey` is UNIQUE
 *     and `validateActiveShipmentTotalsWithinOrder` caps a shipment at ordered − refunded − already-shipped, so
 *     a duplicated or oversized dispatch is refused by a constraint. `CogsEntry` carries no unique
 *     constraint at all — which is exactly why the costed side needs the two-sided check and this
 *     side does not.
 *   - The failure modes are opposite. Withholding for an over-estimate would withhold a profit that
 *     IS supported, and this branch's other failure mode is refusing figures it can stand behind.
 */
type OrderCostCoverage =
  /** Every dispatchable unit shipped in the window. The caller must still prove they were COSTED. */
  | 'covered'
  /** Nothing on this order could ever dispatch or post a cost. Complete, at zero, on its own. */
  | 'nothing-to-dispatch'
  /** Some line's cost is short or unknowable. No profit may be published for this order. */
  | 'incomplete'

function orderCostCoverage(order: SalesOrderRow, dispatchedQtyByLine: Map<string, Prisma.Decimal>): OrderCostCoverage {
  let sawDispatchable = false
  let sawNonStock = false
  for (const line of order.lines) {
    const ordered = toDecimal(line.qty)
    if (ordered.lte(0)) continue
    if (!line.productId || !line.product) return 'incomplete'
    if (line.product.type === ProductType.NON_INVENTORY) {
      sawNonStock = true
      continue
    }
    if (!isStockTrackedProductType(line.product.type)) return 'incomplete'
    sawDispatchable = true
    const dispatched = dispatchedQtyByLine.get(`${line.id}|${line.productId}`) ?? new Prisma.Decimal(0)
    if (dispatched.lt(ordered)) return 'incomplete'
  }
  if (sawDispatchable) return 'covered'
  return sawNonStock ? 'nothing-to-dispatch' : 'incomplete'
}

export async function getMarginAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<MarginReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const baseCurrency = await baseCurrencyFromDeps(deps)
  const window = period(filters, generatedAt)
  const cogsRows = await client.cogsEntry.findMany({
    where: { createdAt: { gte: window.dateFrom, lt: window.dateToExclusive }, movement: { type: StockMovementType.SALE_DISPATCH } },
    select: {
      id: true,
      totalCostBase: true,
      movement: {
        select: {
          referenceType: true,
          referenceId: true,
          productId: true,
          createdAt: true,
          product: { select: { sku: true, name: true, category: { select: { name: true } } } },
          // o3d-7r6x: a KIT dispatches its leaf components, so movement.productId is a component
          // and never matches the sales line's kit product. Carry the line's product through so
          // cost and revenue land in the SAME bucket.
          shipmentLine: {
            select: {
              line: {
                select: {
                  productId: true,
                  product: { select: { sku: true, name: true, category: { select: { name: true } } } },
                },
              },
            },
          },
        },
      },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as CogsEntryRow[]
  assertSourceLimit(cogsRows.length, SOURCE_ROW_LIMIT, 'Margin analytics COGS source rows')
  const cogsOrderIds = cogsRows
    .map((row) => row.movement.referenceType === 'SalesOrder' ? row.movement.referenceId : null)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const cogsProductIds = new Set(cogsRows.map((row) => marginCogsBucket(row).productId))
  const orders = await loadSalesOrdersByIds(client, cogsOrderIds)
  // o3d-kyey: the credit RAISED IN THE WINDOW, which is the period this report already measures —
  // it is anchored to CogsEntry.createdAt and prorates revenue to the quantity dispatched inside the
  // window, so it is a DISPATCH-PERIOD report, not an order cohort. A credit note therefore belongs
  // to the period it was raised in, exactly as the Returns report reads it. A credit raised here
  // against a dispatch from an earlier period consequently reduces this period's revenue, which is
  // the same thing a credit note does to a month's accounts.
  const marginRefundLines = await client.salesOrderRefundLine.findMany({
    where: { refund: { refundedAt: { gte: window.dateFrom, lt: window.dateToExclusive } } },
    select: {
      productId: true,
      totalBase: true,
      // The sales line the credit reverses. Its product is the bucket the revenue was booked into;
      // for a KIT it differs from the refund line's own product, exactly as in marginCogsBucket.
      salesOrderLine: { select: { productId: true } },
      refund: { select: { totalsBasis: true } },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as MarginRefundLineRow[]
  assertSourceLimit(marginRefundLines.length, SOURCE_ROW_LIMIT, 'Margin analytics refund source rows')
  const { byLine: dispatchedQtyByLine } = await loadInWindowDispatchedQtyByLine(client, window, orders, 'Margin analytics')
  type MarginGroup = MarginReportRow & { revenue: Prisma.Decimal; cogs: Prisma.Decimal; credits: CreditBuckets; lineIds: Set<string> }
  const emptyMarginGroup = (productId: string, sku: string, productName: string, categoryName: string | null): MarginGroup => ({
    productId,
    sku,
    productName,
    categoryName,
    lineCount: 0,
    revenueBase: '0',
    revenueBaseBound: 'exact',
    cogsBase: '0',
    grossProfitBase: '0',
    grossProfitBaseBound: 'exact',
    marginPct: '0',
    marginPctBound: 'exact',
    contributionPct: '0',
    contributionPctBound: 'exact',
    refundsNetBasis: '0',
    refundsGrossBasis: '0',
    refundsUnknownBasis: '0',
    revenue: new Prisma.Decimal(0),
    cogs: new Prisma.Decimal(0),
    credits: emptyCredits(),
    lineIds: new Set<string>(),
  })
  const groups = new Map<string, MarginGroup>()
  for (const order of orders) {
    for (const line of order.lines) {
      if (!line.productId || !cogsProductIds.has(line.productId)) continue
      const key = line.productId ?? `sku:${line.sku ?? line.description}`
      const current = groups.get(key) ?? emptyMarginGroup(
        line.productId,
        line.sku ?? line.product?.sku ?? 'No SKU',
        line.product?.name ?? line.description,
        line.product?.category?.name ?? null,
      )
      current.lineIds.add(line.id)
      current.lineCount = current.lineIds.size
      const dispatchedQty = dispatchedQtyByLine.get(`${line.id}|${line.productId}`) ?? new Prisma.Decimal(0)
      const lineQty = toDecimal(line.qty)
      const unitRevenue = lineQty.gt(0) ? toDecimal(line.totalBase).div(lineQty) : new Prisma.Decimal(0)
      current.revenue = current.revenue.add(unitRevenue.mul(dispatchedQty))
      groups.set(key, current)
    }
  }
  for (const row of cogsRows) {
    const bucket = marginCogsBucket(row)
    const key = bucket.productId
    const current = groups.get(key) ?? emptyMarginGroup(
      key,
      bucket.product.sku,
      bucket.product.name,
      bucket.product.category?.name ?? null,
    )
    current.cogs = current.cogs.add(toDecimal(row.totalCostBase))
    groups.set(key, current)
  }

  // THE CREDIT THAT COULD NOT REACH A ROW IS STATED, NEVER DROPPED. Two ways it can fail to:
  //   - the refund line names no product at all (a shipping or monetary-only credit line), so there
  //     is no revenue bucket it could belong to;
  //   - it names a product this report has no row for, because that product posted no COGS inside
  //     the window. A row is invented for it NOT: this report's rows are "what was dispatched in
  //     the window", and a bucket with credit and no cost cannot support a margin — publishing one
  //     would be the missing-cost defect wearing a minus sign.
  // Both are published in the totals and both make the report's ratio bounds indeterminate.
  const refundsUnattributed = emptyCredits()
  const refundsOutsideReport = emptyCredits()
  for (const refundLine of marginRefundLines) {
    const productId = refundLine.salesOrderLine?.productId ?? refundLine.productId
    const target = productId ? groups.get(productId) : undefined
    const buckets = target ? target.credits : productId ? refundsOutsideReport : refundsUnattributed
    addCredit(buckets, refundLine.refund.totalsBasis, refundLine.totalBase)
  }
  // Line revenue here is `SalesOrderLine.totalBase`, which is ex-VAT, so this report's basis is NET
  // and the NET-basis credit is the comparable one. Every net figure is computed from the UNROUNDED
  // Decimal and rounded once, at the string.
  const MARGIN_FIGURE_BASIS = 'NET' as const
  const netRevenueByKey = new Map<string, Prisma.Decimal>()
  for (const [key, row] of groups) {
    netRevenueByKey.set(key, row.revenue.sub(comparableCredit(row.credits, MARGIN_FIGURE_BASIS)))
  }
  const totalGrossProfit = [...groups.entries()].reduce((sum, [key, row]) => sum.add(netRevenueByKey.get(key)!.sub(row.cogs)), new Prisma.Decimal(0))
  // The report-wide credit: every row's, plus the credit that reached no row at all.
  const reportCredits = emptyCredits()
  for (const row of groups.values()) mergeCredits(reportCredits, row.credits)
  const rowBasisComplete = creditBasisComplete(reportCredits, MARGIN_FIGURE_BASIS)
  const rowUnplacedInterval = unplacedCreditInterval(reportCredits, MARGIN_FIGURE_BASIS)
  mergeCredits(reportCredits, refundsUnattributed)
  mergeCredits(reportCredits, refundsOutsideReport)
  /**
   * OFF-ROW CREDIT BOUNDS THE PERIOD FIGURES WHATEVER BASIS IT IS ON, and this is the one place the
   * basis test is not enough on its own. A NET-basis credit that reached no row is `placeable` by
   * `creditPlacement` — it is the same unit as the figure — so the basis flag stays true while the
   * credit sits unsubtracted. Reading completeness off the basis alone would publish the period
   * revenue as EXACT with a credit note missing from it. Existence is decided by the AMOUNTS here
   * because that is what "reached no row" means — but from the INTERVAL those amounts occupy, never
   * from a sum. A cross-basis sum lets a negative credit on one basis cancel a real one on another;
   * a per-bucket sum lets two opposite credits on the SAME basis cancel, though their ex-VAT values
   * need not. Either restores the exactness claim this whole mechanism exists to withhold. See
   * `offRowCreditSummary`.
   */
  const offRow = offRowCreditSummary(refundsUnattributed, refundsOutsideReport)
  const contributionBound = shareFigureBound({ reportBasisComplete: rowBasisComplete && !offRow.present })
  const rows: MarginReportRow[] = [...groups.entries()]
    .map(([key, row]) => {
      const netRevenue = netRevenueByKey.get(key)!
      const grossProfit = netRevenue.sub(row.cogs)
      const basisComplete = creditBasisComplete(row.credits, MARGIN_FIGURE_BASIS)
      const unplaced = unplacedCredit(row.credits, MARGIN_FIGURE_BASIS)
      const linearBound = netLinearFigureBoundDecimal({ basisComplete, unplacedCredit: unplaced })
      return {
        productId: row.productId,
        sku: row.sku,
        productName: row.productName,
        categoryName: row.categoryName,
        lineCount: row.lineCount,
        revenueBase: moneyString(netRevenue, baseCurrency),
        revenueBaseBound: linearBound,
        cogsBase: moneyString(row.cogs, baseCurrency),
        grossProfitBase: moneyString(grossProfit, baseCurrency),
        grossProfitBaseBound: linearBound,
        marginPct: pctString(grossProfit, netRevenue),
        marginPctBound: marginFigureBoundDecimal({ netRevenue, cogs: row.cogs, unplacedCredit: unplaced, basisComplete }),
        contributionPct: pctString(grossProfit, totalGrossProfit),
        contributionPctBound: contributionBound,
        refundsNetBasis: moneyString(row.credits.net, baseCurrency),
        refundsGrossBasis: moneyString(row.credits.gross, baseCurrency),
        refundsUnknownBasis: moneyString(row.credits.unknown, baseCurrency),
      }
    })
    .sort((a, b) => toDecimal(b.grossProfitBase).cmp(a.grossProfitBase) || a.sku.localeCompare(b.sku))
  const paged = paginate(rows, filters, deps?.paginate !== false)
  const totalRevenue = [...netRevenueByKey.values()].reduce((sum, revenue) => sum.add(revenue), new Prisma.Decimal(0))
  const totalCogs = [...groups.values()].reduce((sum, row) => sum.add(row.cogs), new Prisma.Decimal(0))
  // The two intervals ADD, endpoint by endpoint — both are in NET terms, and the credit missing
  // from the totals is the row credit no row could absorb plus the credit that reached no row at
  // all. A below-zero lower end (the off-row credit could itself be negative) survives the addition
  // and `unplacedCreditBound` hands it to the classifiers, which answer `indeterminate` rather than
  // print a ceiling that is not one.
  const totalUnplaced = unplacedCreditBound(addUnplacedIntervals(rowUnplacedInterval, offRow.interval))
  const totalBasisComplete = rowBasisComplete && !offRow.present
  const totalLinearBound: DerivedFigureBound = netLinearFigureBoundDecimal({
    basisComplete: totalBasisComplete,
    unplacedCredit: totalUnplaced,
  })
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      revenueBase: moneyString(totalRevenue, baseCurrency),
      revenueBaseBound: totalLinearBound,
      cogsBase: moneyString(totalCogs, baseCurrency),
      grossProfitBase: moneyString(totalGrossProfit, baseCurrency),
      grossProfitBaseBound: totalLinearBound,
      marginPct: pctString(totalGrossProfit, totalRevenue),
      marginPctBound: marginFigureBoundDecimal({
        netRevenue: totalRevenue,
        cogs: totalCogs,
        unplacedCredit: totalUnplaced,
        basisComplete: totalBasisComplete,
      }),
      refundsNetBasis: moneyString(reportCredits.net, baseCurrency),
      refundsGrossBasis: moneyString(reportCredits.gross, baseCurrency),
      refundsUnknownBasis: moneyString(reportCredits.unknown, baseCurrency),
      // Credit that reached no row, stated separately from credit that did, and ON ITS BASIS. Both
      // are inside refunds*Basis above; these say how much of it no product row could account for.
      // A single combined figure would be the one thing this report refuses to publish — a number
      // adding NET, GROSS and unproven amounts is in no unit at all, and the operator reading it
      // beside a NET revenue column would take it for one.
      refundsUnattributedNetBasis: moneyString(refundsUnattributed.net, baseCurrency),
      refundsUnattributedGrossBasis: moneyString(refundsUnattributed.gross, baseCurrency),
      refundsUnattributedUnknownBasis: moneyString(refundsUnattributed.unknown, baseCurrency),
      refundsOutsideReportNetBasis: moneyString(refundsOutsideReport.net, baseCurrency),
      refundsOutsideReportGrossBasis: moneyString(refundsOutsideReport.gross, baseCurrency),
      refundsOutsideReportUnknownBasis: moneyString(refundsOutsideReport.unknown, baseCurrency),
    },
    notices: [
      'Gross margin is anchored to CogsEntry.createdAt, matches the inventory COGS report period semantics, and uses source SalesOrderLine revenue without recalculating FIFO.',
      'Margin rows are product-level buckets: COGS is grouped by the sales line product behind the dispatch (the movement product for unlinked rows) and revenue is grouped from sales-order lines for COGS-linked orders. Duplicate SKU lines share the same product bucket; this report is not line-level COGS attribution.',
      'Line revenue is prorated to the quantity each line dispatched within the window (via the shipment-line link on dispatch movements), so a line shipped across periods books only its in-window revenue against in-window COGS.',
    'Kit lines are converted from component dispatch quantities to whole ordered units through the fulfillment-requirement graph, so a kit contributes revenue in the same units its line is priced in.',
      REFUND_BASIS_NOTICE_GROSS_MARGIN,
    ],
  }
}


/**
 * o3d-iigc round 5: state a period's (or a row's) credit ON ITS BASIS, or refuse to state it.
 *
 * A NET amount and a GROSS amount differ by VAT, so adding them yields a number that is on neither
 * basis — the same reason `netOfRefunds` returns null for a mixed set rather than a plausible-looking
 * total. EXACTLY-ZERO buckets are skipped: zero is identical on both bases, so it carries no basis
 * information and must not turn an otherwise unanimous set into a mixed one. The test is `isZero()`
 * rather than a tolerance, for the reason refundSetBasis gives — dust is still value.
 */
function statedRefundValue(
  net: Prisma.Decimal,
  gross: Prisma.Decimal,
  unknown: Prisma.Decimal,
): { value: Prisma.Decimal | null; basis: 'NONE' | 'NET' | 'GROSS' | 'UNKNOWN' | 'MIXED' } {
  const present: Array<['NET' | 'GROSS' | 'UNKNOWN', Prisma.Decimal]> = []
  if (!net.isZero()) present.push(['NET', net])
  if (!gross.isZero()) present.push(['GROSS', gross])
  if (!unknown.isZero()) present.push(['UNKNOWN', unknown])
  if (present.length === 0) return { value: new Prisma.Decimal(0), basis: 'NONE' }
  if (present.length > 1) return { value: null, basis: 'MIXED' }
  const [basis, value] = present[0]!
  // A single UNPROVEN bucket is a stated AMOUNT on an unstated basis. The amount is real — that much
  // credit exists — so it is published, with `basis: 'UNKNOWN'` saying what is not known about it.
  return { value, basis }
}

export async function getReturnsAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<ReturnsReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const baseCurrency = await baseCurrencyFromDeps(deps)
  const window = period(filters, generatedAt)
  const [refundLines, shippedMovements] = await Promise.all([
    client.salesOrderRefundLine.findMany({
      where: { refund: { refundedAt: { gte: window.dateFrom, lt: window.dateToExclusive } } },
      select: {
        id: true,
        refundId: true,
        productId: true,
        description: true,
        qty: true,
        totalBase: true,
        product: { select: { id: true, sku: true, name: true } },
        refund: {
          select: {
            id: true,
            reason: true,
            totalBase: true,
            // o3d-iigc round 5: the basis was not fetched, so the report could not have respected it.
            totalsBasis: true,
            refundedAt: true,
            order: { select: { customerName: true, lines: { select: { productId: true, qty: true } } } },
          },
        },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<RefundLineRow[]>,
    client.stockMovement.findMany({
      where: {
        type: StockMovementType.SALE_DISPATCH,
        createdAt: { gte: window.dateFrom, lt: window.dateToExclusive },
      },
      // o3d-7r6x: productId is the DISPATCHED (leaf component) product; the sales line behind the
      // shipment line carries the PARENT product the refund line is denominated in. Both are needed
      // to state the denominator in the numerator's units.
      select: {
        productId: true,
        qty: true,
        shipmentLine: { select: { lineId: true, line: { select: { productId: true } } } },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<DispatchMovementRow[]>,
  ])
  assertSourceLimit(Math.max(refundLines.length, shippedMovements.length), SOURCE_ROW_LIMIT, 'Returns analytics source rows')

  // o3d-7r6x: RETURN RATE DIVIDED PARENT UNITS BY COMPONENT UNITS.
  //
  // `SalesOrderRefundLine.qty` is in the sales line's PARENT product units, while a SALE_DISPATCH
  // movement for a kit is in LEAF COMPONENT units keyed on the component's productId. Summing the
  // movements by movement.productId therefore produced a denominator that a kit refund line could
  // never match: `shippedByProduct.get(kitProductId)` was 0, so every kit's return rate read 0%
  // (and its "Shipped qty" column read 0) no matter how much had shipped or come back.
  //
  // Linked movements are converted to WHOLE ORDERED units through the same fulfillment-requirement
  // graph as the fill-rate reader — coverage is min over components of qty/factor — and then
  // attributed to the parent product of the sales line they shipped against. A non-kit line is one
  // self-requirement of factor 1, so non-kit arithmetic is unchanged.
  const parentProductIdByShipmentLine = new Map<string, string>()
  for (const movement of shippedMovements) {
    const lineId = movement.shipmentLine?.lineId
    const parentProductId = movement.shipmentLine?.line?.productId
    if (lineId && parentProductId) parentProductIdByShipmentLine.set(lineId, parentProductId)
  }
  const returnsGraph = await loadFulfillmentProductGraph(
    client as unknown as Parameters<typeof loadFulfillmentProductGraph>[0],
    [...new Set(parentProductIdByShipmentLine.values())],
  )
  const returnsRequirementsByLine = new Map<string, DecimalFulfillmentRequirement[]>()
  for (const [lineId, parentProductId] of parentProductIdByShipmentLine) {
    returnsRequirementsByLine.set(
      lineId,
      requirementsMapToDecimalRows(expandFulfillmentRequirementsDecimal(parentProductId, 1, returnsGraph)),
    )
  }
  const dispatchedCoverageByLine = calculateDecimalCoverageByLine(
    returnsRequirementsByLine,
    shippedMovements.flatMap((movement) => movement.shipmentLine
      ? [{ lineId: movement.shipmentLine.lineId, productId: movement.productId, qty: movement.qty }]
      : []),
  )
  const shippedByProduct = new Map<string, Prisma.Decimal>()
  for (const [lineId, coverage] of dispatchedCoverageByLine) {
    const parentProductId = parentProductIdByShipmentLine.get(lineId)
    if (!parentProductId) continue
    shippedByProduct.set(parentProductId, (shippedByProduct.get(parentProductId) ?? new Prisma.Decimal(0)).add(coverage))
  }
  // Legacy/unlinked dispatch rows (no shipment-line link, so nothing to convert through) keep the
  // historical raw attribution on the movement's own product. Correct for the simple products these
  // rows are in practice; a kit's unlinked rows still cannot reach their parent line.
  for (const movement of shippedMovements) {
    if (movement.shipmentLine) continue
    shippedByProduct.set(movement.productId, (shippedByProduct.get(movement.productId) ?? new Prisma.Decimal(0)).add(toDecimal(movement.qty)))
  }
  type ReturnsGroup = ReturnsReportRow & {
    refundIds: Set<string>
    returned: Prisma.Decimal
    net: Prisma.Decimal
    gross: Prisma.Decimal
    unknown: Prisma.Decimal
  }
  const groups = new Map<string, ReturnsGroup>()
  for (const line of refundLines) {
    const productKey = line.productId ?? `desc:${line.description}`
    const reason = line.refund.reason ?? 'Unspecified'
    const customer = line.refund.order.customerName ?? 'Unknown customer'
    const key = `${productKey}:${customer}:${reason}`
    const current: ReturnsGroup = groups.get(key) ?? {
      productId: line.productId,
      sku: line.product?.sku ?? 'No SKU',
      productName: line.product?.name ?? line.description,
      customerName: customer,
      reason,
      refundCount: 0,
      returnedQty: '0',
      refundValueBase: '0',
      refundValueBasis: 'NONE',
      refundValueNetBasis: '0',
      refundValueGrossBasis: '0',
      refundValueUnknownBasis: '0',
      shippedQty: '0',
      returnRatePct: '0',
      refundIds: new Set<string>(),
      returned: new Prisma.Decimal(0),
      net: new Prisma.Decimal(0),
      gross: new Prisma.Decimal(0),
      unknown: new Prisma.Decimal(0),
    }
    current.refundIds.add(line.refundId)
    current.refundCount = current.refundIds.size
    // Quantity is basis-independent, so it keeps taking EVERY line whatever the basis.
    current.returned = current.returned.add(toDecimal(line.qty))
    const amount = toDecimal(line.totalBase)
    const bucket = refundTotalsBasis(line.refund.totalsBasis)
    if (bucket === 'NET') current.net = current.net.add(amount)
    else if (bucket === 'GROSS') current.gross = current.gross.add(amount)
    else current.unknown = current.unknown.add(amount)
    groups.set(key, current)
  }
  const rows = [...groups.values()]
    .map((row) => {
      const shippedQty = row.productId ? shippedByProduct.get(row.productId) ?? new Prisma.Decimal(0) : new Prisma.Decimal(0)
      const stated = statedRefundValue(row.net, row.gross, row.unknown)
      return {
        productId: row.productId,
        sku: row.sku,
        productName: row.productName,
        customerName: row.customerName,
        reason: row.reason,
        refundCount: row.refundCount,
        returnedQty: qtyString(row.returned),
        refundValueBase: stated.value == null ? null : moneyString(stated.value, baseCurrency),
        refundValueBasis: stated.basis,
        refundValueNetBasis: moneyString(row.net, baseCurrency),
        refundValueGrossBasis: moneyString(row.gross, baseCurrency),
        refundValueUnknownBasis: moneyString(row.unknown, baseCurrency),
        shippedQty: qtyString(shippedQty),
        returnRatePct: pctString(row.returned, shippedQty),
      }
    })
    // o3d-iigc round 3's rule, applied to the report that was RANKED by the mixed figure: a row
    // whose value could not be stated has no position in the ordering, so it goes LAST rather than
    // being coerced to zero and sorted in among the rows that genuinely returned nothing.
    .sort((a, b) => {
      if (a.refundValueBase == null || b.refundValueBase == null) {
        if (a.refundValueBase == null && b.refundValueBase == null) return a.sku.localeCompare(b.sku)
        return a.refundValueBase == null ? 1 : -1
      }
      return toDecimal(b.refundValueBase).cmp(a.refundValueBase) || a.sku.localeCompare(b.sku)
    })
  const paged = paginate(rows, filters, deps?.paginate !== false)
  const totalReturned = [...groups.values()].reduce((sum, row) => sum.add(row.returned), new Prisma.Decimal(0))
  const totalNet = [...groups.values()].reduce((sum, row) => sum.add(row.net), new Prisma.Decimal(0))
  const totalGross = [...groups.values()].reduce((sum, row) => sum.add(row.gross), new Prisma.Decimal(0))
  const totalUnknown = [...groups.values()].reduce((sum, row) => sum.add(row.unknown), new Prisma.Decimal(0))
  const statedTotal = statedRefundValue(totalNet, totalGross, totalUnknown)
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      returnedQty: qtyString(totalReturned),
      // `refundValueBase` is the whole period on ONE basis, or the MIXED marker. The three buckets
      // are always present, so a reader always sees how much credit exists.
      refundValueBase: statedTotal.value == null ? RETURNS_MIXED_BASIS_MARKER : moneyString(statedTotal.value, baseCurrency),
      refundValueBasis: statedTotal.basis,
      refundValueNetBasis: moneyString(totalNet, baseCurrency),
      refundValueGrossBasis: moneyString(totalGross, baseCurrency),
      refundValueUnknownBasis: moneyString(totalUnknown, baseCurrency),
    },
    notices: [
      'Returns analysis uses SalesOrderRefundLine values and compares returned quantity with SALE_DISPATCH quantity in the same period. Return rate is a same-period returned ÷ same-period dispatched metric, not an order-cohort return rate.',
      'Dispatched quantity for kit products is converted from component movements to whole ordered units via the fulfillment-requirement graph, so the return rate divides like units by like units.',
      RETURNS_MIXED_BASIS_NOTICE,
    ],
  }
}

export async function getFulfillmentAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<FulfillmentReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const window = period(filters, generatedAt)
  const shipments = await client.shipment.findMany({
    where: {
      status: ShipmentStatus.SHIPPED,
      shippedAt: { gte: window.dateFrom, lt: window.dateToExclusive },
    },
    select: {
      id: true,
      orderId: true,
      status: true,
      shippedAt: true,
      createdAt: true,
      updatedAt: true,
      // o3d-4kfh r3: productId on BOTH sides. Without it there is no way to tell that a shipment
      // line's quantity is in a different unit from the order line's.
      lines: { select: { lineId: true, productId: true, qty: true } },
      // o3d-kouj: `fulfillmentRequirements` — a shipped order is reported against the recipe it
      // SHIPPED under, not against whatever the kit contains at report time. This was the residual
      // o3d-4kfh r5 left open when it stopped freezing the catalogue: completed history was still
      // read from the current graph, so editing a KIT rewrote what past orders appeared to require
      // and moved their shipped-coverage figures with it.
      order: { select: { id: true, createdAt: true, expectedDelivery: true, lines: { select: { id: true, productId: true, qty: true, fulfillmentRequirements: true } } } },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as ShipmentRow[]
  assertSourceLimit(shipments.length, SOURCE_ROW_LIMIT, 'Fulfillment analytics source rows')

  // o3d-4kfh r3: FILL RATE WAS COMPONENT UNITS OVER PARENT UNITS.
  //
  // `ShipmentLine.qty` is a LEAF-COMPONENT quantity; `SalesOrderLine.qty` is in parent product
  // units. Summing both by order and dividing gave 300% fill rate for a one-kit order whose kit
  // expands to three components — and, because `shipmentQty.lt(orderQty)` was then false, that
  // order was never counted as partial no matter how short it actually shipped. With fractional
  // component factors the error runs the other way and a fully shipped kit order reads as partial.
  // Both the KPI and the "Shipped qty" total (and the CSV export that carries them) were wrong for
  // any order containing a kit.
  //
  // Converted through the same fulfillment-requirement graph as the backorder reports: coverage is
  // min over components of qty/factor, i.e. how many WHOLE ordered units the shipment lines add up
  // to. A non-kit line is a single self-requirement of factor 1, so its arithmetic is unchanged.
  const orderLineProductIds = [...new Set(
    shipments.flatMap((shipment) => shipment.order.lines.map((line) => line.productId))
      .filter((productId): productId is string => Boolean(productId)),
  )]
  const graph = await loadFulfillmentProductGraph(
    client as unknown as Parameters<typeof loadFulfillmentProductGraph>[0],
    orderLineProductIds,
  )
  const requirementsByLine = new Map<string, DecimalFulfillmentRequirement[]>()
  for (const shipment of shipments) {
    for (const line of shipment.order.lines) {
      if (!line.productId || requirementsByLine.has(line.id)) continue
      requirementsByLine.set(line.id, lineFulfillmentRequirements(line, graph))
    }
  }
  // Line ids are unique across orders, so one pass covers every shipment of every order.
  const shippedCoverageByLine = calculateDecimalCoverageByLine(
    requirementsByLine,
    shipments.flatMap((shipment) => shipment.lines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      qty: line.qty,
    }))),
  )
  const orders = new Map<string, { order: ShipmentRow['order']; shipments: ShipmentRow[] }>()
  for (const shipment of shipments) {
    const current = orders.get(shipment.orderId) ?? { order: shipment.order, shipments: [] }
    current.shipments.push(shipment)
    orders.set(shipment.orderId, current)
  }
  let onTime = 0
  let shippedOrders = 0
  let partialOrders = 0
  let orderedQty = new Prisma.Decimal(0)
  let shippedQty = new Prisma.Decimal(0)
  let totalDays = new Prisma.Decimal(0)
  const lateOutliers: Array<{ orderId: string; lateDays: Prisma.Decimal }> = []
  for (const group of orders.values()) {
    const firstShipped = group.shipments.map((shipment) => shipment.shippedAt).filter((date): date is Date => Boolean(date)).sort((a, b) => a.getTime() - b.getTime())[0]
    if (!firstShipped) continue
    shippedOrders += 1
    if (group.order.expectedDelivery && firstShipped.getTime() <= group.order.expectedDelivery.getTime()) onTime += 1
    if (group.order.expectedDelivery && firstShipped.getTime() > group.order.expectedDelivery.getTime()) {
      lateOutliers.push({
        orderId: group.order.id,
        lateDays: new Prisma.Decimal(firstShipped.getTime() - group.order.expectedDelivery.getTime()).div(86_400_000),
      })
    }
    const orderQty = group.order.lines.reduce((sum, line) => sum.add(toDecimal(line.qty)), new Prisma.Decimal(0))
    // Both sides in ORDERED units now. A line whose product has been deleted has no requirements
    // and so contributes nothing shipped — the same as its allocation coverage everywhere else.
    const shipmentQty = group.order.lines.reduce(
      (sum, line) => sum.add(shippedCoverageByLine.get(line.id) ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    )
    orderedQty = orderedQty.add(orderQty)
    shippedQty = shippedQty.add(shipmentQty)
    if (group.shipments.length > 1 || shipmentQty.lt(orderQty)) partialOrders += 1
    totalDays = totalDays.add(new Prisma.Decimal(firstShipped.getTime() - group.order.createdAt.getTime()).div(86_400_000))
  }
  const avgDays = shippedOrders > 0 ? totalDays.div(shippedOrders) : new Prisma.Decimal(0)
  const rows: FulfillmentReportRow[] = [
    { metric: 'On-time ship rate', value: `${pctString(onTime, shippedOrders)}%`, numerator: String(onTime), denominator: String(shippedOrders) },
    { metric: 'Fill rate', value: `${pctString(shippedQty, orderedQty)}%`, numerator: qtyString(shippedQty), denominator: qtyString(orderedQty) },
    { metric: 'Average order-to-ship days', value: roundQuantity(avgDays, 2).toString(), numerator: roundQuantity(totalDays, 2).toString(), denominator: String(shippedOrders) },
    { metric: 'Partial ship rate', value: `${pctString(partialOrders, shippedOrders)}%`, numerator: String(partialOrders), denominator: String(shippedOrders) },
  ]
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows,
    pageInfo: pageInfo(rows.length, 1, rows.length || 1),
    totals: {
      shippedOrders: String(shippedOrders),
      shippedQty: qtyString(shippedQty),
    },
    notices: [
      'Fulfillment metrics use Shipment.shippedAt and ShipmentLine quantity; SalesOrder dates are used only for elapsed-day and expected-delivery comparisons.',
      ...(lateOutliers.length > 0
        ? [`Slowest late shipments: ${lateOutliers.sort((a, b) => b.lateDays.cmp(a.lateDays)).slice(0, 5).map((row) => `${row.orderId} (${roundQuantity(row.lateDays, 2)} days late)`).join(', ')}.`]
        : []),
    ],
  }
}

function activityShipmentId(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, Prisma.JsonValue>).shipmentId
  return typeof value === 'string' ? value : null
}

export async function getThroughputAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<ThroughputReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const window = period(filters, generatedAt)
  const [activities, shipments, pendingShipments] = await Promise.all([
    client.activityLog.findMany({
      where: {
        entityType: ActivityEntityType.SALES_ORDER,
        action: 'shipment_status_changed',
        createdAt: { gte: window.dateFrom, lt: window.dateToExclusive },
      },
      select: {
        userId: true,
        createdAt: true,
        metadata: true,
        user: { select: { name: true } },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<ActivityLogRow[]>,
    client.shipment.findMany({
      where: { shippedAt: { gte: window.dateFrom, lt: window.dateToExclusive } },
      select: { id: true, orderId: true, lines: { select: { lineId: true, qty: true } } },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<Array<{ id: string; orderId: string; lines: Array<{ lineId: string; qty: DecimalInput }> }>>,
    client.shipment.findMany({
      where: { status: { in: [ShipmentStatus.PENDING, ShipmentStatus.PICKING, ShipmentStatus.PACKED] } },
      select: { id: true },
    }) as Promise<Array<{ id: string }>>,
  ])
  assertSourceLimit(Math.max(activities.length, shipments.length), SOURCE_ROW_LIMIT, 'Throughput analytics source rows')
  const shipmentById = new Map(shipments.map((shipment) => [shipment.id, shipment]))
  const groups = new Map<string, ThroughputReportRow & { orderIds: Set<string>; shipmentIds: Set<string>; lineIds: Set<string> }>()
  for (const activity of activities) {
    const shipmentId = activityShipmentId(activity.metadata)
    const shipment = shipmentId ? shipmentById.get(shipmentId) : undefined
    const date = dateOnly(activity.createdAt)
    const userName = activity.user?.name ?? 'System'
    const key = `${date}:${activity.userId ?? 'system'}`
    const current = groups.get(key) ?? {
      date,
      userName,
      orderCount: 0,
      shipmentCount: 0,
      lineCount: 0,
      orderIds: new Set<string>(),
      shipmentIds: new Set<string>(),
      lineIds: new Set<string>(),
    }
    if (shipment) {
      current.orderIds.add(shipment.orderId)
      current.shipmentIds.add(shipment.id)
      for (const line of shipment.lines) current.lineIds.add(line.lineId)
    }
    current.orderCount = current.orderIds.size
    current.shipmentCount = current.shipmentIds.size
    current.lineCount = current.lineIds.size
    groups.set(key, current)
  }
  const rows = [...groups.values()]
    .map((row) => ({
      date: row.date,
      userName: row.userName,
      orderCount: row.orderCount,
      shipmentCount: row.shipmentCount,
      lineCount: row.lineCount,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.userName.localeCompare(b.userName))
  const paged = paginate(rows, filters, deps?.paginate !== false)
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      orders: String(rows.reduce((sum, row) => sum + row.orderCount, 0)),
      shipments: String(rows.reduce((sum, row) => sum + row.shipmentCount, 0)),
      lines: String(rows.reduce((sum, row) => sum + row.lineCount, 0)),
      queueDepth: String(pendingShipments.length),
    },
    notices: ['Throughput uses shipment_status_changed ActivityLog rows linked to Shipment metadata. Current queue depth is exposed only in totals because it is a live snapshot, not a historical per-day value.'],
  }
}
