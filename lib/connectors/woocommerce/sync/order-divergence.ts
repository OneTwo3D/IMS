/**
 * WOOCOMMERCE-VS-IMS ORDER DIVERGENCE: DETECT AND REPORT, WRITE NOTHING TO THE ORDER (the read-only first step of the order-amendment design).
 *
 * The update path of `importWcOrder` refreshes six fields of an order IMS already holds and never rebuilds its lines or money. A quantity, price,
 * shipping, discount or tax edited in WooCommerce after import therefore leaves IMS invoicing and the warehouse picking the original. The older
 * edit-drift row (order-edit-drift.ts) notices a changed quantity or total; this compares the rest as well (unit prices, added and removed lines,
 * shipping, discount, tax) and does it against refunds, so a refund is never reported as an edit.
 *
 * WHAT IT NEVER DOES (the detection itself; the separate write step in order-amendment.ts is behind `wc_order_amendment_write_enabled`, off by default)
 *   - It writes to `wc_order_divergences` only. Not to the order (so `SalesOrder.updatedAt` never moves and the order never becomes a warehouse
 *     amend candidate), not to WooCommerce, not to the warehouse, not to the ledger.
 *   - It does not touch status handling, the echo guard or the refund sync. It runs after the existing update, behind a setting that is OFF by default,
 *     and a failure of any kind is caught and logged: it can never fail or delay the delivery whose real work already committed.
 *
 * THE COMPARISON BASIS (decided once, here)
 *   WooCommerce side: the order.updated payload. IMS side: the stored order and lines, minus what IMS has ALREADY recorded as refunded.
 *   Every figure is the amount EXCLUDING tax unless named otherwise, in the order's own currency, compared in exact decimal.
 *     lines      matched on the WooCommerce line id: quantity, SKU, unit price ex-tax (payload subtotal / quantity, which is what the importer stored),
 *                plus lines only one side has.
 *     shipping   payload `shipping_total`                   vs `shippingForeign`
 *     discount   payload `discount_total`                   vs the sum of the line discounts plus the order-level discount
 *     tax        payload `total_tax`                        vs `taxForeign`
 *     total      payload `total` (tax included)             vs `totalForeign`
 *
 * NET OF REFUNDS (the double-counting hazard). A line a customer returns or a shop removes is usually a refund, which already flows through the
 * refund sync and already reversed its cost of goods. Reporting the same event as an edit as well would be a second signal for one fact. So a
 * quantity (or a whole line) that WooCommerce shows LOWER than IMS is explained, and not reported, when the IMS refund lines recorded for that line
 * account for the whole of the gap; the same share of that line's net, tax and discount is then taken out of the IMS-side order figures before they
 * are compared. WooCommerce's own `total`, `total_tax` and `discount_total` are never reduced by a refund, and neither are IMS's stored figures, so a
 * refund on its own moves neither side. A refund the payload names that IMS has not recorded yet is the one case where the comparison cannot be made
 * safely (the refund sync runs after the import in the same delivery): detection is DEFERRED for that delivery and the next delivery or poll compares.
 *
 * TOLERANCE. Half a minor unit of the order currency (`ledgerMatchEpsilon`: 0.005 in a two-decimal currency), strictly below one minor unit, so a
 * genuine one-penny difference is reported and storage rounding (IMS keeps four decimals, a unit price six) is not. When a line was only PARTLY
 * explained by a refund its share of tax and discount is pro rata and the order-level tolerance is widened to one whole minor unit for that comparison.
 * Quantities are compared to 0.0001 (the stored precision).
 *
 * NOT COMPARED (so nothing is guessed): an order in another currency than the payload (the paid-block row carries that), a cancelled or erased order,
 * the discount when the order carries store credit or its stored discount does not say it was allocated into the lines (older rows), and any figure the
 * payload does not state. Fee lines carry no WooCommerce line id and are compared only through the order figures.
 */

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import { currencyMinorUnits, ledgerMatchEpsilon, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { WC_DIVERGENCE_DRAIN_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import type { WcFullOrder } from './types'
import { applyWcOrderAmendment } from './order-amendment'
import { recordRefusedAction, resolveRefusedActions, REFUSED_ACTION_ENTITY_SALES_ORDER } from '@/lib/domain/refused-actions'
import { parseWcGmtInstant } from './receipt-settlement-rate'
import { buildWcSeenLines, hasLineItems, isOlderThanSeen, isSameSecondConflict, parseWcSeenLines, type WcSeenLines } from './wc-seen-lines'

export const WC_ORDER_DIVERGENCE_SETTING = 'wc_order_divergence_detection_enabled'
export const WC_ORDER_DIVERGED_ACTION = 'wc_order_diverged'
/** The operator-facing name of the record (a label on the exceptions page and in the activity log). */
export const WC_ORDER_DIVERGED = 'WC_ORDER_DIVERGED'

const QTY_EPS = toDecimal('0.0001')

export type DivergenceField = 'LINE_QUANTITY' | 'LINE_PRICE' | 'LINE_PRODUCT' | 'LINE_ADDED' | 'LINE_REMOVED' | 'SHIPPING' | 'DISCOUNT' | 'TAX' | 'TOTAL'

/** One field-level difference. SKUs, quantities and amounts only (strings, already formatted); never customer data. */
export type DivergenceDifference = {
  field: DivergenceField
  /** What an operator reads, with the field named. */
  label: string
  woocommerce: string
  ims: string
  /** The WooCommerce item id, on a line-level difference that is about one item (LINE_ADDED). NOT part of the fingerprint (an open row recorded before this field existed keeps its fingerprint). */
  externalLineItemId?: number
}

export type StoredOrderForDivergence = {
  currency: string
  status: string
  erasedAt: Date | null
  shippingForeign: unknown
  taxForeign: unknown
  totalForeign: unknown
  discountAmount: unknown
  discountModel: string | null
  storeCreditForeign: unknown
  lines: ReadonlyArray<{
    id: string
    externalLineItemId: number | null
    sku: string | null
    qty: unknown
    unitPriceForeign: unknown
    discountAmount: unknown
    taxForeign: unknown
    totalForeign: unknown
  }>
}

export type RefundFactsForDivergence = {
  /** Storefront refund ids IMS has recorded for this order. */
  recordedExternalRefundIds: ReadonlyArray<number>
  /** Quantity IMS has recorded as refunded, per sales order line id. */
  refundedQtyByLineId: ReadonlyMap<string, unknown>
}

export type DivergenceVerdict =
  | { kind: 'compared'; differences: DivergenceDifference[] }
  /** Nothing was compared, and an open record must be left exactly as it is (a refund is still arriving). */
  | { kind: 'deferred'; reason: string }
  /** The order is not one this compares (ended, erased, another currency): an open record is closed. */
  | { kind: 'not-comparable'; reason: string }

function money(value: unknown): Decimal | null {
  if (value === undefined || value === null || String(value).trim() === '') return null
  try {
    return toDecimal(value as never)
  } catch {
    return null
  }
}

function fmt(value: Decimal, dp: number): string {
  return value.toDecimalPlaces(dp).toFixed(dp)
}

/** A unit price: the currency's own decimals, or four when it has more (a unit price is stored to six). */
function fmtUnit(value: Decimal, dp: number): string {
  const rounded = value.toDecimalPlaces(4)
  return rounded.decimalPlaces() <= dp ? rounded.toFixed(dp) : rounded.toFixed(4)
}

function fmtQty(value: Decimal): string {
  return value.toDecimalPlaces(4).toString()
}

function sku(value: string | null | undefined): string {
  const t = (value ?? '').trim()
  return t === '' ? 'no SKU' : t
}

/**
 * Pure: the differences between the payload and the stored order, net of the refunds IMS has recorded. See the file header for the basis.
 */
export function compareWcOrderWithIms(
  wcOrder: Pick<WcFullOrder, 'currency' | 'line_items' | 'shipping_total' | 'discount_total' | 'total_tax' | 'total'> & { refunds?: ReadonlyArray<{ id?: unknown }> },
  stored: StoredOrderForDivergence,
  refunds: RefundFactsForDivergence,
): DivergenceVerdict {
  if (stored.erasedAt) return { kind: 'not-comparable', reason: 'the order was erased' }
  if (stored.status === 'CANCELLED') return { kind: 'not-comparable', reason: 'the order is cancelled' }
  if (wcOrder.currency && wcOrder.currency !== stored.currency) return { kind: 'not-comparable', reason: 'the currencies differ' }

  const recorded = new Set(refunds.recordedExternalRefundIds)
  const pending = (Array.isArray(wcOrder.refunds) ? wcOrder.refunds : []).filter((r) => typeof r?.id === 'number' && !recorded.has(r.id))
  if (pending.length > 0) return { kind: 'deferred', reason: 'a refund on the WooCommerce order is not recorded in IMS yet' }

  const dp = currencyMinorUnits(stored.currency)
  const half = ledgerMatchEpsilon(stored.currency)
  const one = toDecimal(1).div(toDecimal(10).pow(dp))
  const differences: DivergenceDifference[] = []

  // The IMS-side order figures, reduced by whatever a refund explains (below).
  let imsTax = money(stored.taxForeign) ?? toDecimal(0)
  let imsTotal = money(stored.totalForeign) ?? toDecimal(0)
  let imsDiscount = (money(stored.discountAmount) ?? toDecimal(0))
  for (const line of stored.lines) imsDiscount = imsDiscount.plus(money(line.discountAmount) ?? 0)
  let partlyExplained = false

  type Agg = { sku: string; qty: Decimal; refunded: Decimal; extension: Decimal; tax: Decimal; net: Decimal; discount: Decimal }
  const ims = new Map<number, Agg>()
  for (const line of stored.lines) {
    if (line.externalLineItemId === null || line.externalLineItemId === undefined) continue
    const qty = money(line.qty) ?? toDecimal(0)
    const prior = ims.get(line.externalLineItemId)
    const refunded = money(refunds.refundedQtyByLineId.get(line.id)) ?? toDecimal(0)
    ims.set(line.externalLineItemId, {
      sku: prior?.sku && prior.sku.trim() !== '' ? prior.sku : (line.sku ?? ''),
      qty: (prior?.qty ?? toDecimal(0)).plus(qty),
      refunded: (prior?.refunded ?? toDecimal(0)).plus(refunded),
      extension: (prior?.extension ?? toDecimal(0)).plus(qty.times(money(line.unitPriceForeign) ?? 0)),
      tax: (prior?.tax ?? toDecimal(0)).plus(money(line.taxForeign) ?? 0),
      net: (prior?.net ?? toDecimal(0)).plus(money(line.totalForeign) ?? 0),
      discount: (prior?.discount ?? toDecimal(0)).plus(money(line.discountAmount) ?? 0),
    })
  }

  const wc = new Map<number, { sku: string; qty: Decimal; subtotal: Decimal | null }>()
  if (Array.isArray(wcOrder.line_items)) {
    for (const item of wcOrder.line_items as Array<{ id?: unknown; quantity?: unknown; sku?: unknown; subtotal?: unknown }>) {
      if (typeof item?.id !== 'number' || typeof item.quantity !== 'number') continue
      const prior = wc.get(item.id)
      const subtotal = money(item.subtotal)
      wc.set(item.id, {
        sku: typeof item.sku === 'string' && item.sku.trim() !== '' ? item.sku : (prior?.sku ?? ''),
        qty: (prior?.qty ?? toDecimal(0)).plus(item.quantity),
        subtotal: prior?.subtotal != null && subtotal !== null ? prior.subtotal.plus(subtotal) : (prior?.subtotal ?? subtotal),
      })
    }
    const ids = [...new Set([...wc.keys(), ...ims.keys()])].sort((a, b) => a - b)
    for (const id of ids) {
      const w = wc.get(id)
      const i = ims.get(id)
      if (w && !i) {
        const unit = w.subtotal !== null && w.qty.gt(0) ? w.subtotal.div(w.qty) : null
        differences.push({
          field: 'LINE_ADDED',
          label: `Item ${sku(w.sku)} was added in WooCommerce`,
          woocommerce: `${fmtQty(w.qty)} x ${sku(w.sku)}${unit ? ` at ${fmtUnit(unit, dp)} each` : ''}`,
          ims: 'not on the order',
          externalLineItemId: id,
        })
        continue
      }
      if (!w && i) {
        if (i.refunded.gte(i.qty.minus(QTY_EPS))) {
          // The whole line is gone from WooCommerce and IMS has refunded all of it: one event, already handled by the refund.
          imsTax = imsTax.minus(i.tax)
          imsTotal = imsTotal.minus(i.net).minus(i.tax)
          imsDiscount = imsDiscount.minus(i.discount)
          continue
        }
        differences.push({
          field: 'LINE_REMOVED',
          label: `Item ${sku(i.sku)} was removed in WooCommerce`,
          woocommerce: 'not on the order',
          ims: `${fmtQty(i.qty)} x ${sku(i.sku)}`,
        })
        continue
      }
      if (!w || !i) continue

      if (i.sku.trim() !== '' && w.sku.trim() !== '' && i.sku.trim().toLowerCase() !== w.sku.trim().toLowerCase()) {
        differences.push({ field: 'LINE_PRODUCT', label: `Item on line ${id} was changed to another product`, woocommerce: sku(w.sku), ims: sku(i.sku) })
      }

      if (w.qty.minus(i.qty).abs().gt(QTY_EPS)) {
        const gap = i.qty.minus(w.qty)
        if (gap.gt(0) && i.refunded.gt(0) && gap.minus(i.refunded).abs().lte(QTY_EPS)) {
          // WooCommerce shows fewer than IMS holds and IMS has refunded exactly that many: the refund is the explanation, not an edit.
          const share = gap.div(i.qty)
          if (share.lt(1)) partlyExplained = true
          imsTax = imsTax.minus(i.tax.times(share))
          imsTotal = imsTotal.minus(i.net.plus(i.tax).times(share))
          imsDiscount = imsDiscount.minus(i.discount.times(share))
        } else {
          differences.push({
            field: 'LINE_QUANTITY',
            label: `Quantity of ${sku(w.sku || i.sku)} changed in WooCommerce`,
            woocommerce: fmtQty(w.qty),
            ims: fmtQty(i.qty),
          })
        }
      }

      if (w.subtotal !== null && w.qty.gt(0) && i.qty.gt(0)) {
        const imsUnit = i.extension.div(i.qty)
        const wcUnit = w.subtotal.div(w.qty)
        // The extension at WooCommerce's quantity, so a rounded unit price and a changed quantity do not look like a price change.
        if (w.subtotal.minus(imsUnit.times(w.qty)).abs().gt(half)) {
          differences.push({
            field: 'LINE_PRICE',
            label: `Unit price (excluding tax) of ${sku(w.sku || i.sku)} changed in WooCommerce`,
            woocommerce: fmtUnit(wcUnit, dp),
            ims: fmtUnit(imsUnit, dp),
          })
        }
      }
    }
  }

  const tol = partlyExplained ? one : half
  const compare = (field: DivergenceField, label: string, wcValue: unknown, imsValue: Decimal, tolerance: Decimal) => {
    const w = money(wcValue)
    if (w === null) return // the payload states nothing: nothing to compare
    if (w.minus(imsValue).abs().gt(tolerance)) differences.push({ field, label, woocommerce: fmt(w, dp), ims: fmt(imsValue, dp) })
  }

  compare('SHIPPING', 'Shipping (excluding tax) changed in WooCommerce', wcOrder.shipping_total, money(stored.shippingForeign) ?? toDecimal(0), half)
  const storeCredit = money(stored.storeCreditForeign) ?? toDecimal(0)
  if (stored.discountModel === 'LINE_ALLOCATED' && storeCredit.eq(0)) {
    compare('DISCOUNT', 'Discount (excluding tax) changed in WooCommerce', wcOrder.discount_total, imsDiscount, tol)
  }
  compare('TAX', 'Tax total changed in WooCommerce', wcOrder.total_tax, imsTax, tol)
  compare('TOTAL', 'Order total (including tax) changed in WooCommerce', wcOrder.total, imsTotal, tol)

  return { kind: 'compared', differences }
}

/** The order of the differences is stable, so the same difference seen again hashes the same. */
export function divergenceFingerprint(differences: ReadonlyArray<DivergenceDifference>): string {
  // The item id is left out: it is a later addition and must not change the fingerprint of a difference an open row already holds.
  return createHash('sha256').update(JSON.stringify(differences.map(({ field, label, woocommerce, ims }) => ({ field, label, woocommerce, ims })))).digest('hex').slice(0, 40)
}

/** One readable sentence per difference, e.g. "Quantity of RED-M changed in WooCommerce: WooCommerce 3, IMS 2". */
export function describeDivergence(differences: ReadonlyArray<DivergenceDifference>, currency: string): string {
  return differences.map((d) => {
    const moneyField = d.field === 'LINE_PRICE' || d.field === 'SHIPPING' || d.field === 'DISCOUNT' || d.field === 'TAX' || d.field === 'TOTAL'
    return `${d.label}: WooCommerce ${d.woocommerce}${moneyField ? ` ${currency}` : ''}, IMS ${d.ims}${moneyField ? ` ${currency}` : ''}`
  }).join('; ')
}

/**
 * DEFERRED COMPARISONS AWAITING A REFUND. A delivery whose payload names a refund IMS has not recorded yet is deferred (above): the comparison cannot be made safely until the refund sync has run.
 * The deferral is PERSISTED (`wc_order_divergence_rechecks`, one row per order, removed by any later comparison that completes), so it survives a restart and is the same in every mode:
 *   - the refund sweep of a webhook / reconcile run repeats the comparison straight away (`rerunDeferredWcOrderDivergence`, same payload);
 *   - the ordinary poll runs no refund sweep, so `drainDeferredWcOrderDivergences` (called by every order sweep, poll included) re-reads each deferred order live and compares again, a few per run;
 *   - a row that stays deferred (the refund never arrives) is dropped after `RECHECK_MAX_ATTEMPTS` attempts or `RECHECK_MAX_AGE_DAYS` days, so the table is bounded and nothing grows with the order history.
 *     A row dropped with NO successful read behind it (its live reads kept failing: `failedReads > 0`) or queued by the write step because it could not decide (`fromRetry`) is surfaced as a refused action first.
 */
export const RECHECK_MAX_ATTEMPTS = 20
export const RECHECK_MAX_AGE_DAYS = 14
export const RECHECK_PER_RUN = 25
/** Failed live reads (error, timeout, hang) a row survives. They do NOT count as attempts (an attempt is a read that returned an order); at this many the row is dropped and a refused action says the comparison was lost. */
export const RECHECK_MAX_FAILED_READS = 48
/** A row is dropped at the failed-read cap only once it has also been deferred this long: reads that fail FAST (a 401, a refused connection) reach 48 within about two days of a 15-minute poll, which is not a lost comparison yet. The age cap still applies. */
export const RECHECK_MIN_AGE_AT_FAILED_CAP_HOURS = 72
/** One drain's wall-clock budget, kept well under the deployed proxy's 60 s read timeout, and the longest one live read may take. The drain stops starting reads once a whole read no longer fits. */
export const RECHECK_BUDGET_MS = 25_000
export const RECHECK_READ_TIMEOUT_MS = 8_000

export const divergenceSeams: { readLiveOrder?: (externalOrderId: string, signal?: AbortSignal) => Promise<WcFullOrder | null> } = {}

async function readLiveOrder(externalOrderId: string, signal?: AbortSignal): Promise<WcFullOrder | null> {
  if (divergenceSeams.readLiveOrder) return divergenceSeams.readLiveOrder(externalOrderId, signal)
  try {
    const { wcFetch } = await import('../api')
    const { data, error } = await wcFetch(`/orders/${externalOrderId}`, {}, undefined, { signal })
    if (error || !data || typeof data !== 'object' || !('status' in data)) return null
    return data as WcFullOrder
  } catch {
    return null
  }
}

/** Repeat a comparison that was deferred for an unrecorded refund. Call it after the refund sweep of the same delivery; a no-op for an order whose comparison was not deferred. Never throws. */
export async function rerunDeferredWcOrderDivergence(wcOrder: WcFullOrder): Promise<void> {
  try {
    const row = await db.wcOrderDivergenceRecheck.findFirst({ where: { externalOrderId: String(wcOrder.id) }, select: { orderId: true } })
    if (!row) return
    await surfaceWcOrderDivergence(row.orderId, wcOrder)
  } catch (e) {
    console.error('wc_order_divergence: could not repeat a deferred comparison', e instanceof Error ? e.constructor.name : typeof e)
  }
}

export const WC_AMENDMENT_RECHECK_GATE = 'WC_AMENDMENT_RECHECK_EXHAUSTED'

async function raiseRecheckExhausted(row: { orderId: string; externalOrderId: string; attempts: number; failedReads: number }): Promise<void> {
  const readsFailed = row.failedReads > 0
  const detail = readsFailed
    ? `WooCommerce changed this order but IMS could not read it back from WooCommerce to compare (the last ${row.failedReads} live read(s) failed or timed out, with no successful read since), and has stopped retrying. IMS changed, refunded and sent nothing: check the order in WooCommerce and decide.`
    : `WooCommerce changed this order but IMS could not decide what to do (the warehouse state could not be read) ${row.attempts > 0 ? `after ${row.attempts} live re-read(s)` : 'before any live re-read could be made'}, and has stopped retrying. IMS changed, refunded and sent nothing: check the order in WooCommerce and decide.`
  await recordRefusedAction(db, {
    entityType: REFUSED_ACTION_ENTITY_SALES_ORDER,
    entityId: row.orderId,
    action: 'WC_ORDER_AMENDMENT',
    gate: WC_AMENDMENT_RECHECK_GATE,
    permanence: 'PERMANENT',
    severity: 'MEDIUM',
    intent: { externalOrderId: row.externalOrderId, attempts: row.attempts, failedReads: row.failedReads },
    detail,
  })
  console.error('wc_order_divergence: a recheck ran out of attempts; a refused action was raised for the order')
}

/** A live read that never takes longer than `ms` and never throws: a hang, a timeout or an error is a failed read (null). */
async function readLiveOrderWithin(externalOrderId: string, ms: number): Promise<WcFullOrder | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The request itself is aborted at the deadline (not only abandoned), so a hung read no longer runs on in the background for up to the transport's own 120 s.
  const controller = new AbortController()
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null) }, ms) })
  try {
    return await Promise.race([readLiveOrder(externalOrderId, controller.signal).catch(() => null), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Resolve deferred comparisons by a live read, for the runs that do not sweep refunds (the ordinary poll). Called by the order sweeps once the poll position is saved (in webhook-primary mode the full
 * reconciliation is daily, so that is how often it runs there). Bounded per run (`limit` rows, a wall-clock budget), oldest first; a row that is still deferred counts an attempt, a failed read counts
 * against its own cap, and a row is dropped at the attempt cap, the failed-read cap or the age cap. A dropped row that IMS could not compare or decide (see `raiseRecheckExhausted`) raises a refused
 * action first. Never throws.
 */
export async function drainDeferredWcOrderDivergences(
  limit: number = RECHECK_PER_RUN,
  opts: { budgetMs?: number; readTimeoutMs?: number } = {},
): Promise<{ examined: number; resolved: number; dropped: number; /** True when the drain failed with an error (logged): the caller reports it as a warning. */ failed?: boolean; /** True when another drain held the single-flight lock, so this one did nothing. */ busy?: boolean }> {
  const out: { examined: number; resolved: number; dropped: number; failed?: boolean; busy?: boolean } = { examined: 0, resolved: 0, dropped: 0 }
  const budgetMs = opts.budgetMs ?? RECHECK_BUDGET_MS
  try {
    // SINGLE FLIGHT: the cron sweep and a manual reconcile (or two overlapping sweeps) must not both read the same rows. A try-lock on one idle connection held across the drain (the amendment lock's accepted shape); a drain
    // that does not get it does nothing. The transaction's own timeout is the budget plus a long margin for the comparison and write steps of the last row.
    await db.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${WC_DIVERGENCE_DRAIN_LOCK_NAMESPACE}::int, 0) AS locked`
      if (!locked) {
        out.busy = true
        return
      }
      Object.assign(out, await drainLocked(limit, opts))
    }, { timeout: budgetMs + 120_000, maxWait: 5_000 })
  } catch (e) {
    console.error('wc_order_divergence: could not drain deferred comparisons', e instanceof Error ? e.constructor.name : typeof e)
    out.failed = true
  }
  return out
}

async function drainLocked(limit: number, opts: { budgetMs?: number; readTimeoutMs?: number }): Promise<{ examined: number; resolved: number; dropped: number; failed?: boolean }> {
  const budgetMs = opts.budgetMs ?? RECHECK_BUDGET_MS
  const readTimeoutMs = opts.readTimeoutMs ?? RECHECK_READ_TIMEOUT_MS
  const startedAt = Date.now()
  const out: { examined: number; resolved: number; dropped: number; failed?: boolean } = { examined: 0, resolved: 0, dropped: 0 }
  try {
    if (!(await isWcOrderDivergenceDetectionEnabled())) {
      // Detection is off: nothing is owed, so nothing is kept.
      out.dropped = (await db.wcOrderDivergenceRecheck.deleteMany({})).count
      return out
    }
    const cutoff = new Date(Date.now() - RECHECK_MAX_AGE_DAYS * 86_400_000)
    const failedCapCutoff = new Date(Date.now() - RECHECK_MIN_AGE_AT_FAILED_CAP_HOURS * 3_600_000)
    const expired = await db.wcOrderDivergenceRecheck.findMany({ where: { OR: [{ deferredAt: { lt: cutoff } }, { attempts: { gte: RECHECK_MAX_ATTEMPTS } }, { failedReads: { gte: RECHECK_MAX_FAILED_READS }, deferredAt: { lt: failedCapCutoff } }] }, select: { id: true, orderId: true, externalOrderId: true, attempts: true, failedReads: true, fromRetry: true } })
    for (const row of expired) {
      // A row the write step queued because it could NOT decide (warehouse unreadable, two deliveries in one second) is a paid order WooCommerce changed that IMS has neither refunded nor told anyone about: dropping it silently leaves
      // nothing that says so. It becomes a visible refused action (Sync > Exceptions) a person decides. A row deferred only for an unrecorded refund that never came owes nothing and is dropped as before.
      // A row dropped because its live read kept failing is a comparison IMS lost: it is surfaced the same way, whatever queued it, and whether it was dropped at the failed-read cap or aged out at the age cap with its
      // latest reads still failing (`failedReads` is reset by any successful read, so above zero means no successful read since): the 14-day age cap is reached long before 48 failed reads when the poll drains rarely.
      if (row.fromRetry || row.failedReads > 0) await raiseRecheckExhausted(row).catch((e) => console.error('wc_order_divergence: could not raise the exhausted recheck', e instanceof Error ? e.constructor.name : typeof e))
    }
    if (expired.length > 0) out.dropped += (await db.wcOrderDivergenceRecheck.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } })).count
    const rows = await db.wcOrderDivergenceRecheck.findMany({ orderBy: { lastAttemptAt: 'asc' }, take: Math.max(1, limit) })
    for (const row of rows) {
      // Stop before a read that could overrun the budget (a hung WooCommerce must not hold the caller); the remaining rows wait for the next run. The elapsed time counts everything since the drain began, the comparison and
      // write step of the rows already handled included, so a slow row shortens what follows. A single comparison and write step is not itself interrupted: the budget bounds when a NEW read starts.
      if (Date.now() - startedAt + readTimeoutMs > budgetMs) break
      out.examined++
      const live = await readLiveOrderWithin(row.externalOrderId, readTimeoutMs)
      if (!live) {
        // A failed read is NOT an attempt (the comparison never happened). It has its own bounded counter, and the new lastAttemptAt sends the row to the back of the oldest-first queue (a backoff).
        // updateMany, not update: a row deleted (or deleted and re-created by a comparison that could not decide) during the read is simply gone; a P2025 here would abort the rest of the drain.
        await db.wcOrderDivergenceRecheck.updateMany({ where: { id: row.id }, data: { failedReads: { increment: 1 }, lastAttemptAt: new Date() } })
        continue
      }
      const counted = await db.wcOrderDivergenceRecheck.updateMany({ where: { id: row.id }, data: { attempts: { increment: 1 }, failedReads: 0, lastAttemptAt: new Date() } })
      if (counted.count === 0) continue // the row went away during the read: a re-created row is drained next run
      await surfaceWcOrderDivergence(row.orderId, live)
      // By ORDER, not row id: a comparison that could not decide deletes the row and re-creates it (new id) for the next drain, and that order is still pending, not resolved.
      if ((await db.wcOrderDivergenceRecheck.count({ where: { orderId: row.orderId } })) === 0) out.resolved++
    }
  } catch (e) {
    console.error('wc_order_divergence: could not drain deferred comparisons', e instanceof Error ? e.constructor.name : typeof e)
    out.failed = true
  }
  return out
}

/**
 * Store the seen WooCommerce lines, CONDITIONALLY IN SQL on the stored time: an older delivery never overwrites a newer one however the two commit. Raw, so `updatedAt` (client-side @updatedAt) is NOT bumped:
 * the detection never makes the order a warehouse amend candidate. Never throws.
 */
const SEEN_AT_SHAPE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$'

function logSeenLinesFailure(e: unknown): undefined {
  console.error('wc_order_divergence: could not record the seen WooCommerce lines', e instanceof Error ? e.constructor.name : typeof e)
  return undefined
}

export async function recordWcSeenLines(orderId: string, seen: WcSeenLines): Promise<void> {
  const json = JSON.stringify(seen)
  if (seen.at) {
    // NO CAST: both sides are WooCommerce's offset-less GMT string `YYYY-MM-DDTHH:MM:SS`, fixed width, so a byte-wise (COLLATE "C") text comparison orders them exactly like the instants and can never raise. A stored or incoming value
    // in any other shape (a pre-round-2 row, an odd date_modified fallback) cannot be ordered here: it is overwritten, as the JS isOlderThanSeen above treats an unparseable time as "not older". A `::timestamp` cast here threw on such a value
    // and froze the seen state for the order for good.
    await db.$executeRaw`UPDATE sales_orders SET wc_seen_lines = ${json}::jsonb WHERE id = ${orderId} AND (wc_seen_lines IS NULL OR wc_seen_lines->>'at' IS NULL OR CASE WHEN wc_seen_lines->>'at' ~ ${SEEN_AT_SHAPE}::text AND ${seen.at}::text ~ ${SEEN_AT_SHAPE}::text THEN (wc_seen_lines->>'at') COLLATE "C" <= ${seen.at}::text COLLATE "C" ELSE true END)`.catch(logSeenLinesFailure)
  } else {
    await db.$executeRaw`UPDATE sales_orders SET wc_seen_lines = ${json}::jsonb WHERE id = ${orderId} AND wc_seen_lines IS NULL`.catch(logSeenLinesFailure)
  }
}

export async function isWcOrderDivergenceDetectionEnabled(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: WC_ORDER_DIVERGENCE_SETTING }, select: { value: true } })
  return row?.value === 'true'
}

/**
 * Compare and record, behind the setting. Read-only against the order. Best effort by design: any failure is logged and swallowed, because the
 * delivery's real work (the six-field update, the paid step, the refunds) has already committed and nothing here may fail or delay it.
 */
export async function surfaceWcOrderDivergence(orderId: string, wcOrder: WcFullOrder): Promise<void> {
  try {
    if (!(await isWcOrderDivergenceDetectionEnabled())) return
    const stored = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        currency: true, status: true, erasedAt: true, shippingForeign: true, taxForeign: true, totalForeign: true, discountAmount: true, discountModel: true, storeCreditForeign: true,
        externalOrderNumber: true, wcSeenLines: true, externalUpdatedAt: true,
        lines: { select: { id: true, externalLineItemId: true, sku: true, qty: true, unitPriceForeign: true, discountAmount: true, taxForeign: true, totalForeign: true } },
      },
    })
    if (!stored) return
    const refundRows = await db.salesOrderRefund.findMany({
      where: { orderId, deletedAt: null },
      select: { externalRefundId: true, wcAmendment: true, lines: { select: { salesOrderLineId: true, qty: true } } },
    })
    const refundedQtyByLineId = new Map<string, Decimal>()
    const recordedExternalRefundIds: number[] = []
    const hasAmendmentRefund = refundRows.some((refund) => refund.wcAmendment)
    for (const refund of refundRows) {
      if (refund.externalRefundId !== null) recordedExternalRefundIds.push(refund.externalRefundId)
      for (const line of refund.lines) {
        if (!line.salesOrderLineId) continue
        refundedQtyByLineId.set(line.salesOrderLineId, (refundedQtyByLineId.get(line.salesOrderLineId) ?? toDecimal(0)).plus(toDecimal(line.qty)))
      }
    }
    // What WooCommerce shows for the lines, kept for the amendment step (the baseline at an IMS edit; two deliveries in one second). Best effort.
    // The write is CONDITIONAL IN SQL on the stored time, so two overlapping deliveries cannot put an older one over a newer one whatever order they commit in; and a delivery the core update
    // already rejected as stale (older than external_updated_at) is not recorded at all. A payload with no line_items array says nothing about the lines and is not recorded either.
    const seen = buildWcSeenLines(wcOrder)
    const previousSeen = parseWcSeenLines(stored.wcSeenLines)
    const incomingInstant = parseWcGmtInstant(String(wcOrder.date_modified_gmt || wcOrder.date_modified || ''))
    const rejectedAsStale = Boolean(incomingInstant && !Number.isNaN(incomingInstant.getTime()) && stored.externalUpdatedAt && incomingInstant.getTime() < stored.externalUpdatedAt.getTime())
    const recordable = hasLineItems(wcOrder) && !rejectedAsStale && !stored.erasedAt
    const sameSecondConflict = recordable && isSameSecondConflict(previousSeen, seen)
    if (recordable && !isOlderThanSeen(previousSeen, seen) && (previousSeen?.digest !== seen.digest || previousSeen?.at !== seen.at)) {
      await recordWcSeenLines(orderId, seen)
    }
    const verdict = compareWcOrderWithIms(wcOrder, stored, { recordedExternalRefundIds, refundedQtyByLineId })
    if (verdict.kind === 'deferred') {
      // Remembered durably, so a run that sweeps no refunds (the poll) still repeats the comparison. A row already there keeps its age and attempt count.
      await db.wcOrderDivergenceRecheck.upsert({ where: { orderId }, create: { orderId, externalOrderId: String(wcOrder.id) }, update: {} })
      return
    }
    const priorRecheck = await db.wcOrderDivergenceRecheck.findUnique({ where: { orderId }, select: { attempts: true, deferredAt: true } })
    await db.wcOrderDivergenceRecheck.deleteMany({ where: { orderId } })
    // The write step asks for a live re-read when it could not decide (warehouse unreadable, two deliveries in one second): the same bounded recheck row the deferred comparisons use, keeping the attempts and age already spent.
    const runStep = async (differences: ReadonlyArray<DivergenceDifference>, fingerprint: string) => {
      const outcome = await applyWcOrderAmendment(orderId, wcOrder, differences, fingerprint, undefined, { sameSecondConflict })
      if (!(outcome.kind === 'skipped' && outcome.retry)) {
        // The step decided (or is off): an "ran out of rechecks" refusal raised earlier for this order has been overtaken.
        await resolveRefusedActions(db, { entityType: REFUSED_ACTION_ENTITY_SALES_ORDER, entityId: orderId, action: 'WC_ORDER_AMENDMENT', gate: WC_AMENDMENT_RECHECK_GATE }, 'NO_LONGER_NEEDED').catch(() => undefined)
      }
      if (outcome.kind === 'skipped' && outcome.retry) {
        await db.wcOrderDivergenceRecheck.upsert({ where: { orderId }, create: { orderId, externalOrderId: String(wcOrder.id), fromRetry: true, attempts: priorRecheck?.attempts ?? 0, ...(priorRecheck ? { deferredAt: priorRecheck.deferredAt } : {}) }, update: { fromRetry: true } }).catch(() => undefined)
      }
    }
    const now = new Date()
    if (verdict.kind === 'not-comparable' || verdict.differences.length === 0) {
      await db.wcOrderDivergence.updateMany({
        where: { orderId, resolvedAt: null },
        data: { resolvedAt: now, resolution: verdict.kind === 'not-comparable' ? `Not compared: ${verdict.reason}.` : 'A later WooCommerce delivery matched the IMS order again.' },
      })
      // The order compares clean (or is not compared): the rewrite's and the paid-increase refusals no longer apply.
      await resolveRefusedActions(db, { entityType: REFUSED_ACTION_ENTITY_SALES_ORDER, entityId: orderId, action: 'WC_ORDER_REWRITE' }, 'NO_LONGER_NEEDED').catch(() => undefined)
      await resolveRefusedActions(db, { entityType: REFUSED_ACTION_ENTITY_SALES_ORDER, entityId: orderId, action: 'WC_ORDER_AMENDMENT', gate: 'WC_PAID_INCREASE' }, 'NO_LONGER_NEEDED').catch(() => undefined)
      // A REDUCTION WOOCOMMERCE UNDID leaves NO difference (the amendment refund changes neither the lines nor the stored total), so the write step would never run for it. Run it for an order that carries an amendment
      // refund, with no differences: it raises the "a person decides" task when WooCommerce shows more units than IMS holds after those refunds, and does nothing otherwise (off by default; never throws).
      if (verdict.kind === 'compared' && hasAmendmentRefund) await runStep([], 'restore')
      return
    }
    const fingerprint = divergenceFingerprint(verdict.differences)
    const existing = await db.wcOrderDivergence.findUnique({ where: { orderId }, select: { id: true, fingerprint: true, resolvedAt: true } })
    if (existing && existing.resolvedAt === null && existing.fingerprint === fingerprint) {
      await db.wcOrderDivergence.update({ where: { id: existing.id }, data: { lastSeenAt: now, seenCount: { increment: 1 } } })
      // The write step (off by default) retries a difference it has not yet acted on (a failed refund released its claim); one already acted on is skipped by its claim.
      await runStep(verdict.differences, fingerprint)
      return
    }
    const data = {
      externalOrderId: String(wcOrder.id),
      externalOrderNumber: stored.externalOrderNumber ?? wcOrder.number ?? null,
      differences: verdict.differences as unknown as Prisma.InputJsonValue,
      fingerprint,
    }
    // A new difference (or a reopened one) is a new episode on the same row: the age restarts and the count starts again.
    await db.wcOrderDivergence.upsert({
      where: { orderId },
      create: { orderId, ...data },
      update: { ...data, seenCount: 1, firstSeenAt: now, lastSeenAt: now, resolvedAt: null, resolution: null, amendmentClaim: null },
    })
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: WC_ORDER_DIVERGED_ACTION,
      tag: 'sync',
      level: 'WARNING',
      description: `WooCommerce order ${wcOrder.number} no longer matches the IMS order. IMS has changed nothing (not the order, WooCommerce or the warehouse); it is listed under Sync > Exceptions for a person to decide. ${describeDivergence(verdict.differences, stored.currency)}`,
      metadata: { connector: 'woocommerce', externalOrderId: String(wcOrder.id), differences: verdict.differences },
      resolveUser: false,
    })
    // THE WRITE STEP, behind `wc_order_amendment_write_enabled` (off by default; order-amendment.ts). A no-op while it is off, and it never throws.
    await runStep(verdict.differences, fingerprint)
  } catch (e) {
    console.error('wc_order_divergence: could not compare or record', e instanceof Error ? e.constructor.name : typeof e)
  }
}
