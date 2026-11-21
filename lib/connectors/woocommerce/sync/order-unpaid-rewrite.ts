/**
 * WOOCOMMERCE ORDER EDITS, UNPAID ORDER: IMS REWRITES ITS ORDER TO EXACTLY WHAT WOOCOMMERCE SHOWS (o3d-zvec.7, owner ruling 2026-11-20), BEHIND `wc_order_amendment_unpaid_rewrite_enabled` (OFF).
 *
 * An UNPAID order edited in WooCommerce before the warehouse picks it has nothing in IMS that holds a copy of its money except IMS's own rows, so IMS takes WooCommerce's lines and totals as given:
 *
 *   - NOTHING IS RE-DERIVED OR RE-PRICED. A line's total, tax and discount, the order's shipping, tax and total are the figures the payload states (read through the importer's own mapping, so the stored
 *     shape is the one the importer writes: unit price ex tax = subtotal / quantity, discount = subtotal - total). The only arithmetic is the conversion to the base currency at the order's own booked rate
 *     (kept, as for any confirmed order), and a CHECK that the payload agrees with itself (lines + shipping + tax - order-level discount = total, tax lines = tax total). The check refuses; it never adjusts.
 *   - REFUSE RATHER THAN GUESS. Anything that cannot be mapped exactly is refused with a refused action (Sync > Exceptions) and NOTHING is written: a currency that differs, a SKU IMS does not hold, a
 *     tax mismatch (the payload's own tax figures disagree, or a line's rate cannot be resolved), a total that does not reconcile, store credit, a coupon IMS cannot classify, fee lines, a line IMS
 *     cannot match to a WooCommerce item, an order that was edited in IMS (latest-edit-wins territory: a person decides), and an order that already has an invoice, payment, shipment, refund or
 *     return behind it. A later delivery tries again (a product created in the meantime, a corrected tax mapping).
 *   - THE SAME LOCK, RELEASE AND RE-RESERVE AS AN IMS EDIT. One transaction under the order row lock: the stock reservations are released, continued lines are updated in place (matched on the
 *     WooCommerce item id, so a later itemised refund still finds them), removed lines are deleted, added lines created, the money written, the stock re-reserved. The order's `updatedAt` moves
 *     (an ordinary Prisma update), which makes it an amend candidate of the warehouse push sweep (order-push-sweep.ts `updatableLinks`) should a warehouse order exist; an unpaid order normally has none yet
 *     (the push waits for payment), so there is usually nothing to amend, and the draft (pending) shipments drawn from the released reservations are retired with them.
 *   - IT NEVER TOUCHES A PAID ORDER (that is the refund path of order-amendment.ts), NEVER WRITES TO WOOCOMMERCE (no line or total writeback exists: WooCommerce stays authoritative), and is never
 *     asked at or after picking (order-amendment.ts asks the warehouse gate first and raises the operator task instead).
 *
 * `planUnpaidRewrite` is pure (every input is passed in); `rewriteUnpaidOrderFromWc` reads, plans and writes.
 */
import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { currencyMinorUnits, ledgerMatchEpsilon, roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { resolveSalesOrderEditBlock } from '@/lib/domain/sales/order-edit-affordance'
import { lockSalesOrder, allocateSalesOrder, releaseOrderAllocationsForDeallocationInTx } from '@/lib/domain/sales/allocation-service'
import { recordPegsRemovedWithLines } from '@/lib/domain/sales/peg-service'
import { lockOrderNamedTaxRate, resolveLinesTaxRates } from '@/lib/tax/writable-tax-rate'
import { Prisma } from '@/app/generated/prisma/client'
import { heldSalesInvoiceQueueWhere } from './held-sales-invoice'
import type { MappedLine } from './field-mapping'
import type { WcFullOrder } from './types'

export const WC_ORDER_AMENDMENT_UNPAID_REWRITE_SETTING = 'wc_order_amendment_unpaid_rewrite_enabled'

export type RewriteRefusalCode =
  | 'EDITED_IN_IMS' | 'CURRENCY' | 'FX_RATE' | 'STORE_CREDIT' | 'COUPON' | 'DISCOUNT_MODEL' | 'FEE_LINES' | 'NO_LINES' | 'BAD_LINE' | 'UNMAPPED_LINE'
  | 'UNKNOWN_SKU' | 'TAX_RATE_UNMAPPED' | 'TAX_MISMATCH' | 'TOTAL_MISMATCH' | 'INVOICED' | 'BLOCKED' | 'ALLOCATION'

export type RewriteRefusal = { ok: false; code: RewriteRefusalCode; /** Fixed wording plus SKUs, quantities and amounts only: never remote free text. */ detail: string }

export type RewriteLineData = {
  productId: string
  externalLineItemId: number
  wclcFeeKind: null
  wcCustomsUnitValue: string | null
  sku: string
  description: string
  qty: number
  unitPriceForeign: number
  unitPriceBase: number
  discountStr: string | null
  discountAmount: number
  taxRateId: string | null
  taxForeign: number
  taxBase: number
  totalForeign: number
  totalBase: number
}

export type RewriteOrderData = {
  subtotalForeign: number
  subtotalBase: number
  shippingForeign: number
  shippingBase: number
  taxForeign: number
  taxBase: number
  totalForeign: number
  totalBase: number
  discountAmount: number
  discountStr: string | null
  taxRateName: string | null
  taxRatePercent: number | null
  shippingService?: string | null
  courierKey?: string | null
  shippingMethodId?: string | null
}

export type RewritePlan = {
  ok: true
  lines: { update: Array<{ lineId: string; productChanged: boolean; data: RewriteLineData }>; create: RewriteLineData[]; deleteIds: string[] }
  order: RewriteOrderData
  /** What changes, in words (SKUs, quantities and amounts): the activity entry. */
  summary: string[]
  /** True when nothing the order holds differs from the plan (an echo of what is already there). */
  unchanged: boolean
}

export type RewriteInput = {
  wc: Pick<WcFullOrder, 'currency' | 'line_items' | 'fee_lines' | 'shipping_lines' | 'tax_lines' | 'shipping_total' | 'total' | 'total_tax'>
  stored: {
    currency: string
    fxRateToBase: unknown
    storeCreditForeign: unknown
    discountModel: string | null
    editedInImsAt: Date | null
    totalForeign: unknown
    shippingForeign: unknown
    taxForeign: unknown
    discountAmount: unknown
    lines: ReadonlyArray<{ id: string; externalLineItemId: number | null; productId: string | null; sku: string | null; qty: unknown; unitPriceForeign: unknown; discountAmount: unknown; taxForeign: unknown; totalForeign: unknown; taxRateId: string | null }>
  }
  /** The payload's goods lines through the importer's mapping (mapWcLineItems), index-aligned with `wc.line_items`. */
  mapped: ReadonlyArray<MappedLine>
  /** The IMS tax rate id the importer's resolution picks for each mapped line (resolveWcOrderTaxResolution.lineTaxResolved), index-aligned. */
  taxRateIds: ReadonlyArray<string | null>
  /** The importer's own block: a line whose rate fell back to the order default where the destination says otherwise. */
  taxFallbackBlocked: boolean
  header: { taxRateName: string | null; taxRatePercent: number | null }
  coupon: { refusal: boolean; storeCreditForeign: unknown; orderLevelDiscount: number; unallocated: number; discountStr: string | null }
  shipping: { shippingService: string | null; courierKey: string | null; shippingMethodId: string | null } | null
}

function money(value: unknown): Decimal | null {
  if (value === undefined || value === null || String(value).trim() === '') return null
  try {
    return toDecimal(value as never)
  } catch {
    return null
  }
}

const refuse = (code: RewriteRefusalCode, detail: string): RewriteRefusal => ({ ok: false, code, detail })
const num = (d: Decimal, dp: number): number => roundQuantity(d, dp).toNumber()
const fmt = (d: Decimal, currency: string): string => d.toDecimalPlaces(currencyMinorUnits(currency)).toFixed(currencyMinorUnits(currency))

/** Pure: what the rewrite would write, or why it refuses. See the file header. */
export function planUnpaidRewrite(input: RewriteInput): RewritePlan | RewriteRefusal {
  const { wc, stored } = input
  if (stored.editedInImsAt !== null) return refuse('EDITED_IN_IMS', 'the order was edited in IMS, so latest-edit-wins applies and a person decides (IMS does not overwrite an IMS edit from WooCommerce)')
  const wcCurrency = typeof wc.currency === 'string' ? wc.currency.trim().toUpperCase() : ''
  if (wcCurrency === '') return refuse('CURRENCY', 'the WooCommerce payload states no currency, so IMS cannot tell that its amounts are in the order\'s currency')
  if (wcCurrency !== stored.currency.trim().toUpperCase()) return refuse('CURRENCY', `the currency differs (WooCommerce ${wcCurrency}, IMS ${stored.currency}); IMS does not convert a booked order`)
  const fx = money(stored.fxRateToBase)
  if (fx === null || fx.lte(0)) return refuse('FX_RATE', 'the order has no usable booked FX rate')
  const currency = stored.currency
  const half = ledgerMatchEpsilon(currency)
  if ((money(stored.storeCreditForeign) ?? toDecimal(0)).gt(0) || (money(input.coupon.storeCreditForeign) ?? toDecimal(0)).gt(0)) {
    return refuse('STORE_CREDIT', 'the order carries store credit, whose treatment is fixed at import and never restated')
  }
  if (input.coupon.refusal || input.coupon.unallocated > 0) return refuse('COUPON', 'a coupon on the order cannot be classified exactly (part of its discount is not on any line)')
  if (stored.discountModel !== 'LINE_ALLOCATED') return refuse('DISCOUNT_MODEL', 'the order was imported before discounts were allocated to its lines, so its stored discount cannot be compared exactly')
  if (Array.isArray(wc.fee_lines) && wc.fee_lines.length > 0) return refuse('FEE_LINES', 'WooCommerce shows fee lines (for example duty or handling), which IMS keeps as mirrored lines it does not rewrite')
  const items = Array.isArray(wc.line_items) ? wc.line_items : []
  if (items.length === 0 || input.mapped.length !== items.length) return refuse('NO_LINES', 'WooCommerce shows no items (or the items could not be read), so IMS will not empty the order')

  // WooCommerce items -> stored lines, on the WooCommerce item id. A stored line with no id (added in IMS, a fee) or two with one id cannot be matched exactly.
  const byExternal = new Map<number, (typeof stored.lines)[number]>()
  for (const line of stored.lines) {
    if (line.externalLineItemId === null) return refuse('UNMAPPED_LINE', `IMS holds a line (${line.sku ?? 'no SKU'}) that is not a WooCommerce item, so the order cannot be matched exactly`)
    if (byExternal.has(line.externalLineItemId)) return refuse('UNMAPPED_LINE', `IMS holds two lines for one WooCommerce item (${line.sku ?? 'no SKU'}), so the order cannot be matched exactly`)
    byExternal.set(line.externalLineItemId, line)
  }
  const seen = new Set<number>()
  const lineDataList: RewriteLineData[] = []
  let sumLines = toDecimal(0)
  let sumLineTax = toDecimal(0)
  for (const [index, item] of items.entries()) {
    const m = input.mapped[index]!
    if (typeof item?.id !== 'number' || seen.has(item.id) || !(m.qty > 0) || m.externalLineItemId !== item.id) return refuse('BAD_LINE', `an item WooCommerce shows (${m?.sku ?? 'no SKU'}) has no usable id or quantity`)
    seen.add(item.id)
    if (m.productId === null) return refuse('UNKNOWN_SKU', `IMS holds no product for the SKU ${m.sku}`)
    const lineTotal = money(item.total)
    const lineTax = money(item.total_tax) ?? toDecimal(0)
    if (lineTotal === null) return refuse('BAD_LINE', `the item ${m.sku} states no total`)
    // The importer clamps a line's discount (subtotal - total) at zero, so a line whose total is ABOVE its subtotal would be stored with figures that disagree (total != subtotal - discount): refused, beyond half a minor unit.
    const lineSubtotal = money(item.subtotal)
    if (lineSubtotal !== null && lineTotal.minus(lineSubtotal).gt(half)) return refuse('BAD_LINE', `the item ${m.sku} shows a total (${fmt(lineTotal, currency)}) above its subtotal (${fmt(lineSubtotal, currency)}), which IMS cannot store as a discount`)
    sumLines = sumLines.plus(roundQuantity(lineTotal, 4))
    sumLineTax = sumLineTax.plus(lineTax)
    lineDataList.push({
      productId: m.productId,
      externalLineItemId: item.id,
      wclcFeeKind: null,
      wcCustomsUnitValue: m.wcCustomsUnitValue ?? null,
      sku: m.sku,
      description: m.description,
      qty: m.qty,
      unitPriceForeign: m.unitPriceForeign,
      unitPriceBase: num(toDecimal(m.unitPriceForeign).div(fx), 6),
      discountStr: m.discountStr,
      discountAmount: m.discountAmount,
      // WooCommerce's own line total and tax, as stated (never qty x unit - discount).
      taxRateId: input.taxRateIds[index] ?? null,
      taxForeign: m.taxForeign,
      taxBase: num(toDecimal(m.taxForeign).div(fx), 4),
      totalForeign: num(lineTotal, 4),
      totalBase: num(roundQuantity(lineTotal, 4).div(fx), 4),
    })
  }
  if (input.taxFallbackBlocked) return refuse('TAX_RATE_UNMAPPED', 'a line\'s tax rate cannot be resolved from WooCommerce\'s rate (it would fall back to the order default where the destination says otherwise)')

  // THE PAYLOAD MUST AGREE WITH ITSELF. A check that refuses; nothing is adjusted to make it pass.
  const shipping = money(wc.shipping_total) ?? toDecimal(0)
  const shippingTax = (Array.isArray(wc.shipping_lines) ? wc.shipping_lines : []).reduce((sum, l) => sum.plus(money(l?.total_tax) ?? 0), toDecimal(0))
  const totalTax = money(wc.total_tax)
  const total = money(wc.total)
  if (totalTax === null || total === null) return refuse('TOTAL_MISMATCH', 'WooCommerce states no total or no tax total')
  if (sumLineTax.plus(shippingTax).minus(totalTax).abs().gt(half)) {
    return refuse('TAX_MISMATCH', `the items' and shipping's tax (${fmt(sumLineTax.plus(shippingTax), currency)}) differs from WooCommerce's tax total (${fmt(totalTax, currency)})`)
  }
  const taxLines = Array.isArray(wc.tax_lines) ? wc.tax_lines : []
  if (taxLines.length > 0) {
    const byTaxLines = taxLines.reduce((sum, l) => sum.plus(money(l?.tax_total) ?? 0).plus(money(l?.shipping_tax_total) ?? 0), toDecimal(0))
    if (byTaxLines.minus(totalTax).abs().gt(half)) return refuse('TAX_MISMATCH', `WooCommerce's tax lines (${fmt(byTaxLines, currency)}) differ from its tax total (${fmt(totalTax, currency)})`)
  } else if (totalTax.abs().gt(half)) {
    return refuse('TAX_MISMATCH', 'WooCommerce states a tax total but no tax lines to say which rates it is at')
  }
  const orderLevelDiscount = toDecimal(input.coupon.orderLevelDiscount)
  const expectedTotal = sumLines.plus(shipping).plus(totalTax).minus(orderLevelDiscount)
  if (expectedTotal.minus(total).abs().gt(half)) {
    return refuse('TOTAL_MISMATCH', `the items, shipping and tax come to ${fmt(expectedTotal, currency)} but WooCommerce's order total is ${fmt(total, currency)}`)
  }

  const order: RewriteOrderData = {
    subtotalForeign: num(sumLines, 4),
    subtotalBase: num(sumLines.div(fx), 4),
    shippingForeign: num(shipping, 4),
    shippingBase: num(shipping.div(fx), 4),
    taxForeign: num(totalTax, 4),
    taxBase: num(totalTax.div(fx), 4),
    totalForeign: num(total, 4),
    totalBase: num(total.div(fx), 4),
    discountAmount: input.coupon.orderLevelDiscount,
    discountStr: input.coupon.discountStr,
    taxRateName: input.header.taxRateName,
    taxRatePercent: input.header.taxRatePercent,
    // No shipping line on the payload: the shipping method fields are cleared too (they must not keep the old service while the shipping total is zero).
    ...(input.shipping ?? { shippingService: null, courierKey: null, shippingMethodId: null }),
  }

  const update: RewritePlan['lines']['update'] = []
  const create: RewriteLineData[] = []
  const summary: string[] = []
  let anyLineChange = false
  for (const data of lineDataList) {
    const existing = byExternal.get(data.externalLineItemId)
    if (!existing) {
      create.push(data)
      anyLineChange = true
      summary.push(`added ${data.qty} x ${data.sku}`)
      continue
    }
    const productChanged = existing.productId !== data.productId
    const same = !productChanged
      && toDecimal(existing.qty as never).eq(toDecimal(data.qty))
      && toDecimal(existing.unitPriceForeign as never).minus(data.unitPriceForeign).abs().lt(toDecimal('0.000001'))
      && toDecimal(existing.discountAmount as never).minus(data.discountAmount).abs().lt(toDecimal('0.0001'))
      && toDecimal(existing.taxForeign as never).minus(data.taxForeign).abs().lt(toDecimal('0.0001'))
      && toDecimal(existing.totalForeign as never).minus(data.totalForeign).abs().lt(toDecimal('0.0001'))
      && (existing.taxRateId ?? null) === data.taxRateId
    if (!same) {
      anyLineChange = true
      summary.push(`${data.sku}: quantity ${toDecimal(existing.qty as never).toString()} to ${data.qty}, line total ${fmt(toDecimal(existing.totalForeign as never), currency)} to ${fmt(toDecimal(data.totalForeign), currency)}`)
    }
    update.push({ lineId: existing.id, productChanged, data })
  }
  const keep = new Set(lineDataList.map((d) => d.externalLineItemId))
  const deleteIds: string[] = []
  for (const line of stored.lines) {
    if (line.externalLineItemId !== null && !keep.has(line.externalLineItemId)) {
      deleteIds.push(line.id)
      anyLineChange = true
      summary.push(`removed ${toDecimal(line.qty as never).toString()} x ${line.sku ?? 'no SKU'}`)
    }
  }
  const sameMoney = toDecimal(stored.totalForeign as never).minus(order.totalForeign).abs().lt(toDecimal('0.0001'))
    && toDecimal(stored.shippingForeign as never).minus(order.shippingForeign).abs().lt(toDecimal('0.0001'))
    && toDecimal(stored.taxForeign as never).minus(order.taxForeign).abs().lt(toDecimal('0.0001'))
    && toDecimal(stored.discountAmount as never).minus(order.discountAmount).abs().lt(toDecimal('0.0001'))
  if (!sameMoney) summary.push(`order total ${fmt(toDecimal(stored.totalForeign as never), currency)} to ${fmt(total, currency)} (shipping ${fmt(shipping, currency)}, tax ${fmt(totalTax, currency)})`)
  return { ok: true, lines: { update, create, deleteIds }, order, summary, unchanged: !anyLineChange && sameMoney }
}

export type RewriteOutcome =
  | { kind: 'rewritten'; summary: string[]; unallocatedQty: number }
  | { kind: 'unchanged' }
  | { kind: 'refused'; code: RewriteRefusalCode; detail: string }
  /** Nothing was done and nothing is wrong with the order: it is not (or no longer) an unpaid order the rewrite applies to, or the warehouse order moved while it was being checked. */
  | { kind: 'skipped'; reason: string; retry?: true }

/** WooCommerce says the order is paid (a paid date), whatever IMS has recorded so far. */
export function wcSaysPaid(wcOrder: Pick<WcFullOrder, 'date_paid_gmt'>): boolean {
  return typeof wcOrder.date_paid_gmt === 'string' && wcOrder.date_paid_gmt.trim() !== ''
}

/** An open (pending or given-up) paid-block obligation for this WooCommerce order: the receipt is still to be recorded at the total the gateway charged. */
export async function hasOpenPaidBlock(client: Pick<typeof db, 'shoppingSyncLog'>, externalOrderId: string): Promise<boolean> {
  // The paid-block obligation is a row of the pending-FX family (it carries the order's payload and a `paidBlock` marker); a block that gave up is FAILED and still means the receipt was never recorded.
  const { pendingFxQueueWhere } = await import('./order-import')
  const rows = await client.shoppingSyncLog.findMany({ where: { ...pendingFxQueueWhere(externalOrderId), status: { in: ['PENDING', 'FAILED'] } }, select: { payload: true } })
  return rows.some((r) => typeof r.payload === 'object' && r.payload !== null && (r.payload as { paidBlock?: unknown }).paidBlock !== undefined)
}

/** What says an invoice already exists (or is owed) for the order, so the rewrite refuses: pure, so each piece of evidence is pinned. Null when there is none. */
export function invoiceEvidence(o: { accountingInvoiceId: string | null; invoiceNumber: string | null; invoicedAt: Date | null; salesInvoiceOwedAt: Date | null; invoiceDocuments: number; accountingSyncLogs: number; heldInvoices: number }): string | null {
  if (o.accountingInvoiceId) return 'an accounting invoice is posted for the order'
  if (o.accountingSyncLogs > 0) return 'an accounting entry is queued or posted for the order'
  if (o.heldInvoices > 0) return 'a sales invoice is held for the order'
  if (o.salesInvoiceOwedAt !== null) return 'a sales invoice is owed for the order'
  if (o.invoicedAt !== null || o.invoiceNumber) return 'the order has been invoiced'
  if (o.invoiceDocuments > 0) return 'an invoice document exists for the order'
  return null
}

/** The importer's own rule for the header tax rate lock: a header name that matched an ACTIVE rate when the payload was mapped must still be there under the lock; one that matched none may stay missing. Pure. */
export function headerRateLockOptions(lineRateIds: ReadonlyArray<string | null | undefined>, headerRateWasActive: boolean): { lineRateIds: ReadonlyArray<string | null | undefined>; allowMissing: boolean } {
  return { lineRateIds, allowMissing: !headerRateWasActive }
}

const NO_PICKING_YET = new Set(['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED'])
const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

class RewriteAbort extends Error {
  constructor(readonly outcome: RewriteOutcome) {
    super('wc_unpaid_rewrite_abort')
  }
}

/**
 * Read, plan and write. The caller (order-amendment.ts) holds the per-order amendment lock, has checked the switch, the stale / same-second guards and the warehouse gate (`expectedWarehouseOrderId` is the
 * warehouse order that gate answered for, re-checked under the order row lock). Never throws for an expected condition: every refusal is returned.
 */
export async function rewriteUnpaidOrderFromWc(orderId: string, wcOrder: WcFullOrder, expectedWarehouseOrderId: string | null): Promise<RewriteOutcome> {
  let syncProductIds: string[] = []
  let releasedProductIds: string[] = []
  try {
    // THE IMPORTER'S OWN MAPPING of the payload (reads only: the same product match, the same per-line tax resolution, the same coupon classification as the creating import), done BEFORE the transaction. These
    // helpers read through the shared pool, so run inside the row-lock transaction they held a third connection and lengthened the lock for nothing (o3d-9x6wk L6). What they depend on (the booked rate and
    // currency) is read here and checked again under the lock: a change in between is a retry, never a write from a stale mapping.
    const pre = await db.salesOrder.findUnique({ where: { id: orderId }, select: { fxRateToBase: true, currency: true } })
    if (!pre) return { kind: 'skipped', reason: 'the order is erased, a quote or gone' }
    const importer = await import('./order-import')
    const fieldMapping = await import('./field-mapping')
    const coupons = await import('./coupon-classification')
    const items = Array.isArray(wcOrder.line_items) ? wcOrder.line_items : []
    const mapped = await fieldMapping.mapWcLineItems(items, Number(pre.fxRateToBase))
    const resolution = await importer.resolveWcOrderTaxResolution(wcOrder, mapped)
    const lineDiscountTotal = mapped.reduce((sum, l) => sum.plus(toDecimal(l.discountAmount)), toDecimal(0))
    const couponPlan = coupons.planWcOrderCoupons({
      couponLines: wcOrder.coupon_lines ?? [], orderMeta: wcOrder.meta_data, feeLines: wcOrder.fee_lines, lineDiscountTotalForeign: lineDiscountTotal, currency: pre.currency,
      resolveResidual: ({ couponTotalForeign, lineDiscountTotalForeign, currency }) => fieldMapping.resolveWcOrderLevelDiscount({ couponTotalForeign, lineDiscountTotalForeign, currency }),
    })
    // The importer's own rule for the header rate (order-import.ts): a header name that matches no ACTIVE rate (free text, a deactivated legacy name) is allowed to be missing; one that does is locked and must still be there.
    const headerRateName = resolution.taxRateName ?? null
    const headerRateWasActive = headerRateName ? (await db.taxRate.findFirst({ where: { name: headerRateName, active: true }, select: { id: true } })) !== null : false
    const outcome = await db.$transaction(async (tx): Promise<RewriteOutcome> => {
      await lockSalesOrder(tx, orderId)
      const current = await tx.salesOrder.findUnique({
        where: { id: orderId },
        select: {
          id: true, status: true, isQuote: true, erasedAt: true, currency: true, fxRateToBase: true, paidAt: true, unregisteredPaidAt: true, storeCreditForeign: true, discountModel: true, editedInImsAt: true,
          totalForeign: true, shippingForeign: true, taxForeign: true, discountAmount: true, accountingInvoiceId: true, invoiceNumber: true, invoicedAt: true, salesInvoiceOwedAt: true, refundStatus: true, orderNumber: true,
          _count: { select: { allocations: true, shipments: true, shoppingLinks: true, lines: true, refunds: true, returnExpectations: true, payments: true, invoiceDocuments: true } },
          wmsOrderPush: { select: { externalOrderId: true } },
          lines: { select: { id: true, externalLineItemId: true, productId: true, sku: true, qty: true, unitPriceForeign: true, discountAmount: true, taxForeign: true, totalForeign: true, taxRateId: true }, orderBy: { id: 'asc' } },
        },
      })
      if (!current || current.erasedAt || current.isQuote) return { kind: 'skipped', reason: 'the order is erased, a quote or gone' }
      if (Number(current.fxRateToBase) !== Number(pre.fxRateToBase) || current.currency !== pre.currency) return { kind: 'skipped', retry: true, reason: 'the order\'s booked rate or currency changed while the payload was being mapped' }
      if (current.paidAt !== null || current.unregisteredPaidAt !== null || current._count.payments > 0) return { kind: 'skipped', reason: 'the order is paid: a paid order is never rewritten' }
      // PAID IN WOOCOMMERCE counts as paid even when IMS has not recorded it yet (a post-payment edit seen after a missed webhook; a receipt that could not be recorded and waits in a paid-block obligation): the
      // receipt is registered at the TOTAL THE GATEWAY CHARGED, so the order must not be rewritten under it.
      if (wcSaysPaid(wcOrder) || await hasOpenPaidBlock(tx, String(wcOrder.id))) return { kind: 'skipped', reason: 'WooCommerce shows the order as paid (or its receipt is still to be recorded): a paid order is never rewritten' }
      if (!NO_PICKING_YET.has(current.status)) return { kind: 'skipped', reason: `the order is ${current.status}` }
      if ((current.wmsOrderPush?.externalOrderId ?? null) !== expectedWarehouseOrderId) {
        return { kind: 'skipped', retry: true, reason: 'the warehouse order changed while the warehouse state was being checked' }
      }

      // WHAT HOLDS A COPY OF THIS ORDER OUTSIDE ITS OWN ROWS: the same rule an IMS edit asks (refunds, returns, committed shipments, an unposted invoice), plus any invoice or accounting entry at all
      // (an update of a posted invoice is not built here: refused, never left out of step).
      const [accountingSyncLogs, unpostedInvoices, productlessLines, committedShipments, shippedShipments] = await Promise.all([
        tx.accountingSyncLog.count({ where: { referenceType: 'SalesOrder', referenceId: orderId } }),
        tx.accountingSyncLog.count({ where: { referenceType: 'SalesOrder', referenceId: orderId, type: 'SALES_INVOICE', externalTransactionId: null, status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } } }),
        tx.salesOrderLine.count({ where: { orderId, productId: null } }),
        tx.shipment.count({ where: { orderId, status: { not: 'PENDING' } } }),
        tx.shipment.count({ where: { orderId, status: 'SHIPPED' } }),
      ])
      // INVOICE EVIDENCE FIRST (so it is reported as such, not as the edit rule's generic block): any invoice, held invoice, owed invoice or accounting entry refuses (an update of a posted invoice is not built).
      const heldInvoices = await tx.shoppingSyncLog.count({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
      const evidence = invoiceEvidence({ accountingInvoiceId: current.accountingInvoiceId, invoiceNumber: current.invoiceNumber, invoicedAt: current.invoicedAt, salesInvoiceOwedAt: current.salesInvoiceOwedAt, invoiceDocuments: current._count.invoiceDocuments, accountingSyncLogs, heldInvoices })
      if (evidence) return { kind: 'refused', code: 'INVOICED', detail: `${evidence}, and IMS does not rewrite an order that has one (it would have to update the posted document)` }
      const block = resolveSalesOrderEditBlock({
        status: current.status, allocations: current._count.allocations, shipments: current._count.shipments, committedShipments, shippedShipments, accountingInvoiceId: current.accountingInvoiceId,
        wmsPush: current.wmsOrderPush !== null, hasExternalSource: current._count.shoppingLinks > 0, erased: false, payments: current._count.payments, paid: false,
        storeCreditForeign: Number(current.storeCreditForeign), invoiceRecords: current._count.invoiceDocuments + (current.invoiceNumber ? 1 : 0), accountingSyncLogs, refunds: current._count.refunds,
        refundStatus: current.refundStatus, returnExpectations: current._count.returnExpectations, invoiceNotPosted: unpostedInvoices > 0, productlessLines,
      })
      if (block) return { kind: 'refused', code: 'BLOCKED', detail: block.reason }

      const plan = planUnpaidRewrite({
        wc: wcOrder,
        stored: { ...current, currency: current.currency, lines: current.lines },
        mapped,
        taxRateIds: resolution.lineTaxResolved.map((r) => r.taxRateId ?? null),
        taxFallbackBlocked: importer.shouldBlockWcTaxRateFallback(resolution.taxFallbackLines),
        header: { taxRateName: resolution.taxRateName ?? null, taxRatePercent: resolution.taxRateValue > 0 ? resolution.taxRateValue : null },
        coupon: { refusal: couponPlan.refusal !== null, storeCreditForeign: couponPlan.storeCreditForeign, orderLevelDiscount: couponPlan.orderLevelDiscount, unallocated: couponPlan.unallocated, discountStr: couponPlan.discountStr },
        shipping: Array.isArray(wcOrder.shipping_lines) && wcOrder.shipping_lines.length > 0 ? (({ shippingService, courierKey, shippingMethodId }) => ({ shippingService, courierKey, shippingMethodId }))(fieldMapping.mapWcShipping(wcOrder)) : null,
      })
      if (!plan.ok) return { kind: 'refused', code: plan.code, detail: plan.detail }
      if (plan.unchanged) return { kind: 'unchanged' }

      // THE WRITE: the same release, in-place line edit and re-reserve as an IMS edit of a confirmed order, with WooCommerce's figures.
      await lockOrderNamedTaxRate(tx, plan.order.taxRateName, headerRateLockOptions([...plan.lines.update.map((l) => l.data.taxRateId), ...plan.lines.create.map((l) => l.taxRateId)], headerRateWasActive))
      const allLines = [...plan.lines.update.map((l) => l.data), ...plan.lines.create]
      await resolveLinesTaxRates(tx, allLines, { lenient: true })
      const allocationsBefore = current._count.allocations
      releasedProductIds = [...new Set((await tx.orderAllocation.findMany({ where: { orderId }, select: { productId: true } })).map((a) => a.productId))]
      await releaseOrderAllocationsForDeallocationInTx(tx, orderId, { cause: 'a WooCommerce edit of an unpaid order', userId: null })
      if (plan.lines.deleteIds.length > 0) {
        await recordPegsRemovedWithLines(tx, { salesOrderLineIds: plan.lines.deleteIds }, null)
        await tx.salesOrderLine.deleteMany({ where: { orderId, id: { in: plan.lines.deleteIds } } })
      }
      // A continued line whose PRODUCT changed keeps its row but not the pegs (a peg ties a sales line to a purchase line for the old product): they are ended, as for a removed line.
      const productChangedIds = plan.lines.update.filter((l) => l.productChanged).map((l) => l.lineId)
      if (productChangedIds.length > 0) await recordPegsRemovedWithLines(tx, { salesOrderLineIds: productChangedIds }, null, { labelOverride: 'the product on the sales order line was changed in WooCommerce (the line stays, its pegs were for the old product)' })
      for (const { lineId, productChanged, data } of plan.lines.update) {
        await tx.salesOrderLine.update({ where: { id: lineId }, data: { ...data, ...(productChanged ? { fulfillmentRequirements: Prisma.DbNull } : {}) } })
      }
      // An ordinary Prisma update: `updatedAt` moves, which is what makes the order an amend candidate of the warehouse push sweep.
      await tx.salesOrder.update({
        where: { id: orderId },
        data: { ...plan.order, lines: { create: plan.lines.create } },
      })
      if (current.status === 'ALLOCATED') await tx.salesOrder.updateMany({ where: { id: orderId, status: 'ALLOCATED' }, data: { status: 'PROCESSING' } })
      let unallocatedQty = 0
      if (allocationsBefore > 0 || ['PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED'].includes(current.status)) {
        const allocation = await allocateSalesOrder(tx as never, { orderId, userId: null, runInCallerTransaction: true })
        if (!allocation.success) throw new RewriteAbort({ kind: 'refused', code: 'ALLOCATION', detail: `stock could not be re-reserved for the rewritten order (${allocation.error ?? 'unknown reason'}), so nothing was changed` })
        unallocatedQty = allocation.unallocatedQty ?? 0
        syncProductIds = allocation.syncProductIds ?? []
      }
      await tx.wcOrderDivergence.updateMany({ where: { orderId, resolvedAt: null }, data: { resolvedAt: new Date(), resolution: 'IMS rewrote the unpaid order to match WooCommerce.' } })
      await logActivityInTransaction(tx, {
        userId: null,
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'wc_order_unpaid_rewritten',
        tag: 'sync',
        level: 'INFO',
        description: `The unpaid order was edited in WooCommerce before picking; IMS rewrote its lines and totals to exactly what WooCommerce shows (WooCommerce's own figures, nothing re-priced). ${plan.summary.join('; ')}`,
        metadata: { connector: 'woocommerce', externalOrderId: String(wcOrder.id), changes: plan.summary, unallocatedQty },
      })
      return { kind: 'rewritten', summary: plan.summary, unallocatedQty }
    }, STOCK_TX_OPTIONS)
    if (outcome.kind === 'rewritten') {
      // The storefront stock follows: the products the re-reservation touched and those whose reservations the rewrite released (a removed product is not seen by the re-reservation).
      const ids = [...new Set([...syncProductIds, ...releasedProductIds])]
      if (ids.length > 0) {
        try {
          const { enqueueStockSync } = await import('@/lib/shopping')
          await enqueueStockSync(ids, 'IMS_CHANGE')
        } catch (error) {
          console.error('wc_unpaid_rewrite: the storefront stock update could not be queued', error instanceof Error ? error.constructor.name : typeof error)
        }
      }
    }
    return outcome
  } catch (error) {
    if (error instanceof RewriteAbort) return error.outcome
    throw error
  }
}
