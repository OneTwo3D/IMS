import { Prisma, type AccountingSyncType } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import type { AccountingSettings } from '@/lib/accounting'
import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'
import { copyCostLayerSourceLinesProportionally } from '@/lib/cost-layers'
import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  reduceSnapshotByQty,
  serializeCostLayerSnapshot,
  sumCostLayerSnapshot,
  takeFromSnapshotEntries,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'
import { addMoney, multiplyMoney, roundQuantity, subtractMoney, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { isFullRefundAmount } from '@/lib/domain/sales/refund-thresholds'
import { refundDispositionForStatus } from '@/lib/domain/sales/refund-disposition'
import { refundWouldExceedOrderTotal } from '@/lib/domain/sales/o2c-guards'
import { REFUND_PARK_MANUAL_RESOLUTION_HINT } from '@/lib/domain/sales/refund-manual-resolution'
import { scheduleRefundReservationReleaseOutbox, scheduleRefundUnmatchedWarningOutbox, isRefundReleaseEligible, hasUnmatchedSaleRefund } from '@/lib/domain/sales/refund-reservation-release-outbox'
import { calculateCoverageByLine, type FulfillmentRequirement } from '@/lib/products/fulfillment-coverage'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirements } from '@/lib/products/fulfillment-requirement-snapshot'
import {
  isStockMovementIdempotencyConflict,
  refundInboundMovementKey,
  saleDispatchMovementKey,
} from '@/lib/domain/inventory/stock-movement-idempotency'
import { buildStockMovementValueFields } from '@/lib/domain/inventory/stock-movement-value'
import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'
import { withSavepoint } from '@/lib/db/savepoint'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'

export const REFUND_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }
export { REFUND_ACCOUNTING_LOCK_KEY } from '@/lib/db/advisory-locks'
import { REFUND_ACCOUNTING_LOCK_KEY } from '@/lib/db/advisory-locks'

/**
 * Deliberate call-site boundary for this number-shaped refund service contract.
 * Do not treat this as Decimal-internal arithmetic.
 */
function refundBoundaryNumber(value: DecimalInput): number {
  return toDecimal(value).toNumber()
}

const REFUND_RETURN_SOURCE_ERROR_TAG = 'RefundReturnSourceError'

class RefundReturnSourceError extends Error {
  readonly _tag = REFUND_RETURN_SOURCE_ERROR_TAG

  constructor(message: string) {
    super(message)
    this.name = REFUND_RETURN_SOURCE_ERROR_TAG
  }
}

function isRefundReturnSourceError(error: unknown): error is Error {
  const seen = new WeakSet<object>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { _tag?: unknown; name?: unknown; cause?: unknown }
    if (candidate._tag === REFUND_RETURN_SOURCE_ERROR_TAG || candidate.name === REFUND_RETURN_SOURCE_ERROR_TAG) {
      return true
    }
    current = candidate.cause
  }
  return false
}

function refundReturnSourceErrorMessage(error: unknown): string {
  const seen = new WeakSet<object>()
  let current = error
  let fallbackMessage: string | null = null
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { _tag?: unknown; name?: unknown; message?: unknown; cause?: unknown }
    const message = typeof candidate.message === 'string' && candidate.message.trim()
      ? candidate.message
      : null
    if ((candidate._tag === REFUND_RETURN_SOURCE_ERROR_TAG || candidate.name === REFUND_RETURN_SOURCE_ERROR_TAG) && message) {
      return message
    }
    fallbackMessage ??= message
    current = candidate.cause
  }
  return fallbackMessage ?? 'Refund return source validation failed'
}

export type RefundServiceClient = Prisma.TransactionClient | typeof db

type ShipmentLineCostSnapshotSource = {
  id: string
  costLayerSnapshot: Prisma.JsonValue | null
}

export type RefundReturnRow = {
  productId: string
  qty: number
  refundLineId?: string | null
  unitCostBase?: DecimalInput
  poLineId?: string | null
  sourceCostLayerId?: string | null
}

export type RefundRequestLine = {
  lineId?: string | null
  productId: string | null
  description: string
  qty: number
  totalForeign?: number | null
  totalBase: number
  lineKind?: 'sale' | 'shipping' | 'discount'
}

export type ChargebackOrderLine = {
  lineId: string
  productId: string | null
  description: string
  qty: number
  totalBase: number
}

/**
 * Full-order chargeback refund lines (scjz.70 / .42a foundation): every sale line
 * at its REMAINING (un-refunded) quantity and proportional remaining value, PLUS
 * any remaining shipping charge as a shipping-kind line (null product) so the
 * whole order's recognised revenue — goods AND shipping — is unwound. A chargeback
 * refunds everything not already refunded. Lines/shipping fully refunded already are
 * dropped; a zero-qty order line contributes nothing.
 *
 * Values are kept at 4dp to match the Decimal(18,4) sales/refund columns — rounding
 * to cents here would understate the credit-note total and could zero out small
 * lines while still consuming their quantity (Codex). Pure (no IO) so the line
 * selection is unit-testable; the caller passes the result to createSalesOrderRefund
 * with `chargeback: true`.
 */
export function buildChargebackRefundLines(input: {
  lines: readonly ChargebackOrderLine[]
  priorRefundedQtyByLineId?: Record<string, number>
  priorRefundedBaseByLineId?: Record<string, number>
  shipping?: { totalBase: number; priorRefundedBase?: number; description?: string }
  // scjz.71: the order-level discount to MIRROR. The original invoice never scales the
  // product lines for an order discount — it posts each line at full value and adds the
  // discount as a SEPARATE negative line to the discount account at the order-default
  // tax type (see invoices.ts). To reverse the invoice exactly, emit the same: full
  // goods + a negative discount line. The caller passes this only when a discount
  // account is configured (otherwise the invoice posted no discount line at all).
  discount?: { totalBase: number; description?: string }
}): RefundRequestLine[] {
  const priorQty = input.priorRefundedQtyByLineId ?? {}
  const priorBase = input.priorRefundedBaseByLineId ?? {}
  const saleLines = input.lines.flatMap((line): RefundRequestLine[] => {
    const remainingQty = Math.max(0, line.qty - (priorQty[line.lineId] ?? 0))
    // Remaining VALUE is tracked independently of quantity (Codex): prior refunds may
    // be non-proportional — e.g. a price-only (qty:0) adjustment or 1/4 units refunded
    // for ≠25% of the line value — so derive it from the prior refunded base, not a
    // qty fraction, or the chargeback under-reverses / trips the order-total guard.
    const remainingBase = roundQuantity(subtractMoney(line.totalBase, priorBase[line.lineId] ?? 0), 4)
    // Mirror createSalesOrderRefund's line filter (qty > 0 OR totalBase > 0).
    if (remainingQty <= 0 && remainingBase.lte(0)) return []
    return [{
      lineId: line.lineId,
      productId: line.productId,
      description: line.description,
      qty: remainingQty,
      totalBase: Math.max(0, remainingBase.toNumber()),
      lineKind: 'sale',
    }]
  })

  // Clamp to >= 0: an amount-only/ad-hoc prior refund (no sales line) can push
  // priorRefundedBase above the order's shipping, making the raw difference
  // negative. Left unclamped it would *inflate* targetGoodsTotal below (subtracting
  // a negative) and over-credit the customer. targetNetTotalBase already nets out
  // every prior refund, so a fully-refunded shipping leg simply contributes 0 here.
  const remainingShipping = input.shipping
    ? roundQuantity(subtractMoney(input.shipping.totalBase, input.shipping.priorRefundedBase ?? 0), 4)
    : toDecimal(0)
  const remainingShippingClamped = remainingShipping.lt(0) ? toDecimal(0) : remainingShipping

  if (remainingShippingClamped.gt(0)) {
    saleLines.push({
      lineId: null,
      productId: null,
      description: input.shipping?.description ?? 'Shipping',
      qty: 0,
      totalBase: remainingShippingClamped.toNumber(),
      lineKind: 'shipping',
    })
  }

  // Mirror the invoice's separate order-discount line: a NEGATIVE line that the
  // credit-note staging posts to the discount account at the order-default tax type.
  // This reverses the discount account exactly (rather than spreading the discount
  // across the goods), so standard + zero-rated goods with any order discount tie out.
  const discountBase = input.discount ? roundQuantity(toDecimal(input.discount.totalBase), 4) : toDecimal(0)
  if (discountBase.gt(0)) {
    saleLines.push({
      lineId: null,
      productId: null,
      description: input.discount?.description ?? 'Order discount',
      qty: 0,
      totalBase: discountBase.neg().toNumber(),
      lineKind: 'discount',
    })
  }

  return saleLines
}

export type CreatedRefundLine = {
  id: string
  lineId: string | null
  productId: string | null
  description: string
  qty: number
  unitPriceForeign: number
  unitPriceBase: number
  totalForeign: number
  totalBase: number
  lineKind: 'sale' | 'shipping' | 'discount'
  // The VAT identity resolved at refund creation (o3d-w00). NULL for legacy rows created before the
  // snapshot existed; the credit-note poster falls back to its prior prediction only then.
  accountingTaxType?: string | null
  reverseCharge?: boolean | null
}

// Reconstruct a CreatedRefundLine from a PERSISTED refund line for an idempotent replay (o3d-w00 #4).
// Prefer the persisted lineKind + tax snapshot so a duplicate delivery posts identically to the first
// attempt, instead of re-inferring the kind (which turned a monetary-only 'sale' line into 'shipping')
// and re-predicting the tax type. Fall back to the historical inference ONLY for legacy rows whose
// lineKind is NULL, keeping the same base (salesOrderLineId) the replay sites used before.
function reconstructReplayLine(line: {
  id: string
  salesOrderLineId: string | null
  productId: string | null
  description: string
  qty: Prisma.Decimal
  unitPriceForeign: Prisma.Decimal
  unitPriceBase: Prisma.Decimal
  totalForeign: Prisma.Decimal
  totalBase: Prisma.Decimal
  lineKind: string | null
  accountingTaxType: string | null
  reverseCharge: boolean | null
}): CreatedRefundLine {
  const totalBase = refundBoundaryNumber(line.totalBase)
  return {
    id: line.id,
    lineId: line.salesOrderLineId ?? null,
    productId: line.productId,
    description: line.description,
    qty: refundBoundaryNumber(line.qty),
    unitPriceForeign: refundBoundaryNumber(line.unitPriceForeign),
    unitPriceBase: refundBoundaryNumber(line.unitPriceBase),
    totalForeign: refundBoundaryNumber(line.totalForeign),
    totalBase,
    lineKind: (line.lineKind as 'sale' | 'shipping' | 'discount' | null)
      ?? (line.salesOrderLineId != null ? 'sale' : (totalBase < 0 ? 'discount' : 'shipping')),
    accountingTaxType: line.accountingTaxType,
    reverseCharge: line.reverseCharge,
  }
}

export type RefundAccountingSyncRequest = {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey?: string
}

/**
 * o3d-6oyu.18: which of the two credit-note-raising paths already owns this order's
 * reversal, when the OTHER one is refused under the refund transaction's locks.
 *
 *  - `prior-refund`     a chargeback was refused because the order already carries a
 *                       refund (typically the WooCommerce refund webhook winning the
 *                       race). The remaining balance is ambiguous → manual handling.
 *  - `prior-chargeback` an ordinary refund was refused because the payment poller had
 *                       already charged the whole order back → a second credit note
 *                       would double-reverse it.
 *
 * A conflict is NOT a failure to retry: the reversal is already recorded. Callers map
 * it to a clean no-op plus an operator-visible warning.
 */
export type RefundCreationConflict = 'prior-refund' | 'prior-chargeback'

export type CreateSalesOrderRefundResult =
  | { success: false; error: string; conflict?: RefundCreationConflict; quarantine?: true }
  | {
      success: true
      orderId: string
      totalBase: number
      refundFxRate: number
      createdRefund: { id: string }
      createdRefundLines: CreatedRefundLine[]
      creditNoteNumber: string
      newStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED'
      refundOrderRef: string
      so: {
        id: string
        externalOrderNumber: string | null
        orderNumber: string | null
        status: string
      }
      accountingSyncs: RefundAccountingSyncRequest[]
      accountingWarning?: string
      returnedRows: Array<{ productId: string; sku: string; qty: number }>
      /** True when this is an idempotent replay of an already-recorded refund (duplicate
       *  external delivery), not a newly created one — callers skip one-time side effects. */
      replayed?: boolean
      /** o3d-67y: true when the order held stock reservations (OrderAllocation rows) at refund time, so the
       *  caller should run the immediate post-refund reservation release. Derived under the order lock from
       *  actual allocations, not lifecycle status. Undefined on a replay (the original refund scheduled it). */
      releaseEligible?: boolean
      /** o3d-67y: true when a positive-quantity sale refund line has no persisted sales-order-line link and a
       *  live residual reservation exists on a partial refund — the reservation cannot be safely released and
       *  the caller must surface it (a later shipment could include the refunded quantity). */
      releaseUnmatchedAnomaly?: boolean
    }

export type RetrySalesOrderRefundAccountingResult =
  | { success: false; error: string }
  | {
      success: true
      orderId: string
      refundId: string
      refundOrderRef: string
      accountingSyncs: RefundAccountingSyncRequest[]
      returnedRows: Array<{ productId: string; sku: string; qty: number }>
    }

function canRunTransaction(
  client: RefundServiceClient,
): client is typeof db {
  return typeof (client as typeof db).$transaction === 'function'
}

async function runInTransaction<T>(
  client: RefundServiceClient,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return canRunTransaction(client)
    ? client.$transaction(callback, REFUND_TX_OPTIONS)
    : callback(client)
}

async function lockCostLayers(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "cost_layers" WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`,
  )
}

function aggregateRefundReturnRows(
  rows: RefundReturnRow[],
): RefundReturnRow[] {
  const aggregated = new Map<string, RefundReturnRow>()

  for (const row of rows) {
    if (!row.productId || !Number.isFinite(row.qty) || row.qty <= 0) continue
    // Key by refundLineId when present so same-product refund lines keep
    // distinct movement keys; legacy callers without line ids retain the old
    // product-level aggregation behavior.
    const aggregateKey = refundReturnAggregateKey(row)
    const existing = aggregated.get(aggregateKey)
    if (existing) {
      if (existing.unitCostBase != null && row.unitCostBase != null) {
        const combinedQty = existing.qty + row.qty
        existing.unitCostBase = combinedQty > 0
          ? roundQuantity(
              toDecimal(existing.unitCostBase)
                .mul(existing.qty)
                .add(toDecimal(row.unitCostBase).mul(row.qty))
                .div(combinedQty),
              6,
            ).toFixed(6)
          : existing.unitCostBase
      } else if (existing.unitCostBase == null && row.unitCostBase != null) {
        existing.unitCostBase = row.unitCostBase
      }
      existing.qty += row.qty
      continue
    }
    aggregated.set(aggregateKey, { ...row })
  }

  return [...aggregated.values()]
}

// This key feeds SalesOrderRefund RETURN_INBOUND idempotency keys. Changing it
// requires considering existing stock_movements.idempotencyKey values.
function refundReturnAggregateKey(row: Pick<RefundReturnRow, 'productId' | 'refundLineId'>): string {
  return row.refundLineId ? `${row.productId}:${row.refundLineId}` : row.productId
}

async function getExistingCreditNoteNumberMax(
  tx: Prisma.TransactionClient,
  prefix: string,
): Promise<number> {
  const parseSuffix = (value: string | null): number => {
    if (!value?.startsWith(prefix)) return 0
    const suffix = value.slice(prefix.length)
    return /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : 0
  }
  const rows = await tx.salesOrderRefund.findMany({
    where: { creditNoteNumber: { startsWith: prefix } },
    select: { creditNoteNumber: true },
  })
  return rows.reduce((max, row) => Math.max(max, parseSuffix(row.creditNoteNumber)), 0)
}

async function nextCreditNoteNumber(
  tx: Prisma.TransactionClient,
  params: { prefix: string; date?: Date },
): Promise<string> {
  const date = params.date ?? new Date()
  const year = date.getFullYear()
  const counterKey = `document_counter:credit_note:${year}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${counterKey}))`
  const row = await tx.setting.findUnique({
    where: { key: counterKey },
    select: { value: true },
  })
  const prefix = `${params.prefix}${year}-`
  const current = row?.value
    ? Number.parseInt(row.value, 10)
    : await getExistingCreditNoteNumberMax(tx, prefix)
  const next = Number.isFinite(current) && current >= 0 ? current + 1 : 1
  await tx.setting.upsert({
    where: { key: counterKey },
    create: { key: counterKey, value: String(next) },
    update: { value: String(next) },
  })
  return `${params.prefix}${year}-${String(next).padStart(5, '0')}`
}

/**
 * 6oyu.5: composite key for the ORIGINALLY-POSTED per-layer COGS of a shipment
 * line. Keyed by shipment line AND cost layer because the same cost layer can be
 * consumed by more than one shipment line and each carries its own dispatch-time
 * posted cost.
 */
export function postedShipmentUnitCostKey(shipmentLineId: string, costLayerId: string): string {
  return `${shipmentLineId}::${costLayerId}`
}

/**
 * 6oyu.5: value shipment-source refund snapshot entries at the ORIGINALLY-POSTED
 * COGS unit cost (from the immutable CogsEntry dispatch rows) instead of the
 * current cost-layer cost. Entries with no posted basis (legacy dispatches that
 * pre-date FIFO snapshots / CogsEntry rows) keep their existing unitCostBase so
 * the reversal degrades to the prior carrying-value behaviour rather than
 * dropping to zero. Pure so the reversal basis is unit-testable in isolation.
 */
export function applyPostedShipmentUnitCosts(
  entries: CostLayerSnapshotEntry[],
  postedUnitCostByKey: ReadonlyMap<string, number>,
): CostLayerSnapshotEntry[] {
  return entries.map((entry) => {
    if (!entry.shipmentLineId) return entry
    const posted = postedUnitCostByKey.get(postedShipmentUnitCostKey(entry.shipmentLineId, entry.costLayerId))
    return posted == null ? entry : { ...entry, unitCostBase: posted }
  })
}

/**
 * 6oyu.5: load the ORIGINALLY-POSTED per-layer COGS unit cost for each shipment
 * line, keyed by {@link postedShipmentUnitCostKey}. The source of truth is the
 * immutable CogsEntry rows written at dispatch (shipment-service.ts) — NOT the
 * shipment cost-layer snapshot NOR Shipment.cogsBatchAmount, both of which
 * landed-cost revaluation MUTATES in place to the CURRENT layer cost
 * (cost-layers.ts refreshShipmentCogsForCostLayerChange +
 * updateSnapshotsForCostLayerChange). Reversing a refund at this posted basis
 * leaves any post-dispatch revaluation delta in COGS for the refunded units, per
 * the 2026-07-12 finance decision (bd onetwo3d-ims-6oyu.5); the returned stock's
 * new inventory layer is valued on the same posted basis so the GL inventory leg
 * of the single-amount COGS_REVERSAL journal stays equal to the cost-layer
 * subledger (inventory GL/subledger reconciliation, invariants.ts).
 */
async function loadPostedShipmentUnitCosts(
  tx: Prisma.TransactionClient,
  shipmentLineIds: string[],
): Promise<Map<string, number>> {
  const totalsByKey = new Map<string, { qtyTotal: ReturnType<typeof toDecimal>; costTotal: ReturnType<typeof toDecimal> }>()
  for (const shipmentLineId of shipmentLineIds) {
    const movement = await tx.stockMovement.findUnique({
      where: { idempotencyKey: saleDispatchMovementKey(shipmentLineId) },
      select: {
        cogsEntries: {
          select: { costLayerId: true, qty: true, unitCostBase: true },
        },
      },
    })
    for (const entry of movement?.cogsEntries ?? []) {
      const key = postedShipmentUnitCostKey(shipmentLineId, entry.costLayerId)
      const totals = totalsByKey.get(key) ?? { qtyTotal: toDecimal(0), costTotal: toDecimal(0) }
      const qty = toDecimal(entry.qty)
      totals.qtyTotal = addMoney(totals.qtyTotal, qty)
      totals.costTotal = addMoney(totals.costTotal, multiplyMoney(qty, toDecimal(entry.unitCostBase)))
      totalsByKey.set(key, totals)
    }
  }
  const postedUnitCostByKey = new Map<string, number>()
  for (const [key, { qtyTotal, costTotal }] of totalsByKey) {
    // Qty-weighted mean posted unit cost; robust to a layer split across rows.
    if (qtyTotal.gt(0)) postedUnitCostByKey.set(key, refundBoundaryNumber(costTotal.div(qtyTotal)))
  }
  return postedUnitCostByKey
}

async function getShipmentLineCostSnapshot(
  tx: Prisma.TransactionClient,
  shipmentLine: ShipmentLineCostSnapshotSource,
): Promise<CostLayerSnapshotEntry[]> {
  const explicitSnapshot = parseCostLayerSnapshot(shipmentLine.costLayerSnapshot)
  if (explicitSnapshot.length > 0) return explicitSnapshot

  const movement = await tx.stockMovement.findUnique({
    where: { idempotencyKey: saleDispatchMovementKey(shipmentLine.id) },
    select: {
      cogsEntries: {
        orderBy: { createdAt: 'asc' },
        select: {
          costLayerId: true,
          qty: true,
          unitCostBase: true,
        },
      },
    },
  })
  return serializeCostLayerSnapshot(
    (movement?.cogsEntries ?? []).map((entry) => ({
      costLayerId: entry.costLayerId,
      qty: entry.qty,
      unitCostBase: entry.unitCostBase,
    })),
  )
}

async function buildRefundFallbackReturnRows(
  client: RefundServiceClient,
  orderId: string,
  lines: Array<RefundRequestLine | CreatedRefundLine>,
  excludeRefundId?: string,
): Promise<RefundReturnRow[]> {
  const order = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      lines: {
        select: {
          id: true,
          productId: true,
          description: true,
          qty: true,
        },
      },
      allocations: {
        select: {
          lineId: true,
          productId: true,
          qty: true,
        },
      },
      shipments: {
        where: { status: 'SHIPPED' },
        select: {
          lines: {
            select: {
              lineId: true,
              productId: true,
              qty: true,
            },
          },
        },
      },
      refunds: {
        where: { returnWarehouseId: { not: null } },
        select: {
          id: true,
          lines: {
            select: { productId: true, qty: true },
          },
        },
      },
    },
  })
  if (!order) return []

  const lineById = new Map(order.lines.map((line) => [line.id, line]))
  const lineCandidatesByProduct = new Map<string, typeof order.lines>()
  for (const line of order.lines) {
    if (!line.productId) continue
    const existing = lineCandidatesByProduct.get(line.productId) ?? []
    existing.push(line)
    lineCandidatesByProduct.set(line.productId, existing)
  }

  const sourceRowsByLine = new Map<string, Map<string, number>>()
  const addSourceQty = (lineId: string, productId: string, qty: number) => {
    if (!Number.isFinite(qty) || qty <= 0) return
    const byProduct = sourceRowsByLine.get(lineId) ?? new Map<string, number>()
    byProduct.set(productId, (byProduct.get(productId) ?? 0) + qty)
    sourceRowsByLine.set(lineId, byProduct)
  }

  for (const shipment of order.shipments) {
    for (const line of shipment.lines) {
      addSourceQty(line.lineId, line.productId, refundBoundaryNumber(line.qty))
    }
  }

  const priorReturnedByProduct = new Map<string, number>()
  for (const refund of order.refunds) {
    if (excludeRefundId && refund.id === excludeRefundId) continue
    for (const refundLine of refund.lines) {
      if (!refundLine.productId) continue
      priorReturnedByProduct.set(
        refundLine.productId,
        (priorReturnedByProduct.get(refundLine.productId) ?? 0) + refundBoundaryNumber(refundLine.qty),
      )
    }
  }

  const totalDispatchedByProduct = new Map<string, number>()
  for (const [, sourceRows] of sourceRowsByLine) {
    for (const [productId, qty] of sourceRows) {
      totalDispatchedByProduct.set(productId, (totalDispatchedByProduct.get(productId) ?? 0) + qty)
    }
  }

  const remainingReturnable = new Map<string, number>()
  for (const [productId, dispatched] of totalDispatchedByProduct) {
    const priorReturned = priorReturnedByProduct.get(productId) ?? 0
    remainingReturnable.set(productId, Math.max(0, dispatched - priorReturned))
  }

  return lines.flatMap((line) => {
    if (!line.productId || line.qty <= 0) return []
    const refundLineId = 'id' in line ? line.id : null

    const sourceLine = line.lineId
      ? lineById.get(line.lineId) ?? null
      : (lineCandidatesByProduct.get(line.productId) ?? []).find((candidate) => candidate.description === line.description)
        ?? (lineCandidatesByProduct.get(line.productId) ?? [])[0]
        ?? null

    if (!sourceLine) {
      throw new RefundReturnSourceError(
        `Cannot restock product ${line.productId} for refund: no matching sales order line exists on the original order.`,
      )
    }

    const sourceRows = sourceRowsByLine.get(sourceLine.id)
    const sourceLineQty = refundBoundaryNumber(sourceLine.qty)
    if (!sourceRows || sourceRows.size === 0 || !Number.isFinite(sourceLineQty) || sourceLineQty <= 0) {
      throw new RefundReturnSourceError(
        `Cannot restock product ${sourceLine.productId ?? line.productId} for refund: no shipment line exists on the original order. Process as cash-only or refund a shipped line.`,
      )
    }

    return [...sourceRows.entries()].flatMap(([productId, totalQty]) => {
      const perUnitQty = totalQty / sourceLineQty
      if (!Number.isFinite(perUnitQty) || perUnitQty <= 0) return []
      const rawReturnQty = perUnitQty * line.qty
      const available = Math.max(0, remainingReturnable.get(productId) ?? 0)
      const cappedQty = Math.min(rawReturnQty, available)
      remainingReturnable.set(productId, available - cappedQty)

      if (cappedQty <= 0) return []
      return [{ productId, qty: cappedQty, refundLineId }]
    })
  })
}

/**
 * Applies inbound stock for refund/restock rows.
 *
 * The returned rows describe the requested final returned state for the
 * aggregate, not necessarily writes performed by this call. If an idempotency
 * conflict proves a concurrent/replayed call already created the stock
 * movement, the row is still returned so callers can keep their existing
 * final-state contract. Downstream accounting must keep its own idempotency
 * guard and must not infer "new work was performed" from this return value.
 */
export async function applyReturnInboundStockTx(
  tx: Prisma.TransactionClient,
  params: {
    referenceType: string
    referenceId: string
    warehouseId: string
    rows: RefundReturnRow[]
    note: string
  },
): Promise<Array<{ productId: string; sku: string; qty: number }>> {
  const aggregatedRows = aggregateRefundReturnRows(params.rows)
  if (aggregatedRows.length === 0) return []

  const existingMovements = await tx.stockMovement.findMany({
    where: {
      type: 'RETURN_INBOUND',
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      toWarehouseId: params.warehouseId,
    },
    select: { productId: true, qty: true },
  })
  if (existingMovements.length > 0) {
    const productIds = [...new Set(existingMovements.map((movement) => movement.productId))]
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true },
    })
    const skuByProductId = new Map(products.map((product) => [product.id, product.sku]))
    return existingMovements.map((movement) => ({
      productId: movement.productId,
      sku: skuByProductId.get(movement.productId) ?? movement.productId,
      qty: refundBoundaryNumber(movement.qty),
    }))
  }

  const rowsByAggregateKey = new Map<string, RefundReturnRow[]>()
  for (const row of params.rows) {
    if (!row.productId || !Number.isFinite(row.qty) || row.qty <= 0) continue
    const key = refundReturnAggregateKey(row)
    const rows = rowsByAggregateKey.get(key) ?? []
    rows.push(row)
    rowsByAggregateKey.set(key, rows)
  }

  for (const row of aggregatedRows) {
    const idempotencyKey = row.refundLineId && params.referenceType === 'SalesOrderRefund'
      ? refundInboundMovementKey({
          refundId: params.referenceId,
          refundLineId: row.refundLineId,
          warehouseId: params.warehouseId,
        })
      : undefined
    const result = await createReturnInboundMovementAndCostLayersTx(tx, {
      movementRow: row,
      costLayerRows: rowsByAggregateKey.get(refundReturnAggregateKey(row)) ?? [],
      warehouseId: params.warehouseId,
      note: params.note,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      idempotencyKey,
    })
    if (result === 'duplicate') {
      await tx.activityLog.create({
        data: {
          entityType: 'SALES_ORDER',
          entityId: params.referenceId,
          action: 'refund_return_deduped',
          tag: 'sales',
          level: 'INFO',
          description: `Skipped duplicate refund return for product ${row.productId}`,
          metadata: {
            idempotencyKey,
            productId: row.productId,
            refundLineId: row.refundLineId ?? null,
            referenceType: params.referenceType,
            referenceId: params.referenceId,
          },
        },
      })
      continue
    }
  }

  const returnedProducts = await tx.product.findMany({
    where: { id: { in: aggregatedRows.map((row) => row.productId) } },
    select: { id: true, sku: true },
  })
  const skuByProductId = new Map(returnedProducts.map((product) => [product.id, product.sku]))

  return aggregatedRows.map((row) => ({
    productId: row.productId,
    sku: skuByProductId.get(row.productId) ?? row.productId,
    qty: row.qty,
  }))
}

async function createReturnInboundMovementAndCostLayersTx(
  tx: Prisma.TransactionClient,
  params: {
    movementRow: RefundReturnRow
    costLayerRows: RefundReturnRow[]
    warehouseId: string
    note: string
    referenceType: string
    referenceId: string
    idempotencyKey?: string
  },
): Promise<'created' | 'duplicate'> {
  try {
    // o3d-slrn: returning 'duplicate' leaves the CALLER continuing on this same tx, so the
    // failing insert must be savepointed or everything after it hits a 25P02.
    await withSavepoint(tx, () => tx.stockMovement.create({
      data: {
        type: 'RETURN_INBOUND',
        productId: params.movementRow.productId,
        toWarehouseId: params.warehouseId,
        qty: params.movementRow.qty,
        ...buildStockMovementValueFields({
          qty: params.movementRow.qty,
          unitCostBase: params.movementRow.unitCostBase ?? 0,
        }),
        note: params.note,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      },
    }))
  } catch (error) {
    if (!isStockMovementIdempotencyConflict(error)) throw error
    return 'duplicate'
  }

  await tx.stockLevel.upsert({
    where: {
      productId_warehouseId: {
        productId: params.movementRow.productId,
        warehouseId: params.warehouseId,
      },
    },
    create: {
      productId: params.movementRow.productId,
      warehouseId: params.warehouseId,
      quantity: params.movementRow.qty,
      reservedQty: 0,
    },
    update: { quantity: { increment: params.movementRow.qty } },
  })

  for (const row of params.costLayerRows) {
    if (row.unitCostBase == null || row.qty <= 0) continue
    const unitCostBase = roundQuantity(row.unitCostBase, 6)
    if (unitCostBase.lt(0)) continue
    const newLayer = await tx.costLayer.create({
      data: {
        productId: row.productId,
        warehouseId: params.warehouseId,
        receivedQty: row.qty,
        remainingQty: row.qty,
        unitCostBase: unitCostBase.toFixed(6),
        poLineId: row.poLineId ?? null,
      },
      select: { id: true },
    })
    if (row.sourceCostLayerId) {
      await copyCostLayerSourceLinesProportionally(tx, row.sourceCostLayerId, newLayer.id, row.qty)
    }
  }
  return 'created'
}

function consumeRefundLineQuantity(
  lineStates: Array<{
    id: string
    productId: string | null
    description: string
    qty: number
    totalBase: number
  }>,
  remainingShipped: Map<string, number>,
  remainingUnshipped: Map<string, number>,
  refundLine: {
    lineId?: string | null
    productId: string | null
    description: string
    qty: number
    totalBase: number
    unitPriceBase?: number | null
  },
): {
  shippedRevenue: number
  unshippedRevenue: number
  assignedRevenue: number
  lineAllocations: Array<{ lineId: string; shippedQty: number; unshippedQty: number }>
} {
  if (!refundLine.productId || refundLine.qty <= 0) {
    return {
      shippedRevenue: 0,
      unshippedRevenue: 0,
      assignedRevenue: 0,
      lineAllocations: [],
    }
  }

  let remainingQty = refundLine.qty
  let shippedRevenue = 0
  let unshippedRevenue = 0
  let assignedRevenue = 0
  const lineAllocations: Array<{ lineId: string; shippedQty: number; unshippedQty: number }> = []
  const refundUnitPrice = refundLine.unitPriceBase != null
    ? refundBoundaryNumber(refundLine.unitPriceBase)
    : (refundLine.qty > 0 ? refundLine.totalBase / refundLine.qty : null)

  const priceMatches = (unitRevenue: number, candidateUnitPrice: number | null): boolean => {
    if (candidateUnitPrice == null) return false
    return Math.abs(unitRevenue - candidateUnitPrice) < 0.0001
  }

  const matchingLines = lineStates
    .filter((line) => line.productId === refundLine.productId)
    .sort((a, b) => {
      const aLineMatch = refundLine.lineId != null && a.id === refundLine.lineId
      const bLineMatch = refundLine.lineId != null && b.id === refundLine.lineId
      if (aLineMatch !== bLineMatch) return aLineMatch ? -1 : 1

      const aUnitRevenue = a.qty > 0 ? a.totalBase / a.qty : 0
      const bUnitRevenue = b.qty > 0 ? b.totalBase / b.qty : 0
      const aPriceMatch = priceMatches(aUnitRevenue, refundUnitPrice)
      const bPriceMatch = priceMatches(bUnitRevenue, refundUnitPrice)
      if (aPriceMatch !== bPriceMatch) return aPriceMatch ? -1 : 1

      const aDescMatch = a.description === refundLine.description
      const bDescMatch = b.description === refundLine.description
      if (aDescMatch !== bDescMatch) return aDescMatch ? -1 : 1

      return 0
    })

  for (const line of matchingLines) {
    if (remainingQty <= 0 || line.qty <= 0) break

    const unitRevenue = line.totalBase / line.qty
    const shippedQtyAvailable = remainingShipped.get(line.id) ?? 0
    const shippedTake = Math.min(remainingQty, shippedQtyAvailable)
    if (shippedTake > 0) {
      const shippedValue = unitRevenue * shippedTake
      shippedRevenue += shippedValue
      assignedRevenue += shippedValue
      remainingQty -= shippedTake
      remainingShipped.set(line.id, shippedQtyAvailable - shippedTake)
      lineAllocations.push({ lineId: line.id, shippedQty: shippedTake, unshippedQty: 0 })
    }

    const unshippedQtyAvailable = remainingUnshipped.get(line.id) ?? 0
    const unshippedTake = Math.min(remainingQty, unshippedQtyAvailable)
    if (unshippedTake > 0) {
      const unshippedValue = unitRevenue * unshippedTake
      unshippedRevenue += unshippedValue
      assignedRevenue += unshippedValue
      remainingQty -= unshippedTake
      remainingUnshipped.set(line.id, unshippedQtyAvailable - unshippedTake)
      lineAllocations.push({ lineId: line.id, shippedQty: 0, unshippedQty: unshippedTake })
    }
  }

  return { shippedRevenue, unshippedRevenue, assignedRevenue, lineAllocations }
}

async function stageRefundAccountingReversals(
  client: RefundServiceClient,
  params: {
    orderId: string
    orderRef: string
    refundId: string
    refundLines: CreatedRefundLine[]
    returnWarehouseId?: string
    accountingSettings: AccountingSettings
    so: {
      unearnedRevenueAmount: Prisma.Decimal | number | string | null
    }
    newStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED'
    /** scjz.70: revenue-only chargeback — suppress the COGS reversal (cost kept as a loss). */
    chargeback?: boolean
    /**
     * The active accounting connector that will receive the new reversal syncs. Scopes
     * the prior-reversal double-counting guard to that connector so a post-connector-
     * switch org doesn't subtract reversals posted to a different ledger. Resolved by the
     * server-action layer (the unit-tested domain path passes none → no connector filter).
     */
    activeConnector?: 'xero' | 'quickbooks'
  },
): Promise<{
  accountingSyncs: RefundAccountingSyncRequest[]
  snapshotReturnRows: RefundReturnRow[] | null
}> {
  let snapshotReturnRows: RefundReturnRow[] | null = null
  const accountingSyncs: RefundAccountingSyncRequest[] = []
  const settings = params.accountingSettings
  const toNetRevenue = (amountBase: number): number => Math.round(amountBase * 100) / 100
  const refundRevenue = Math.round(params.refundLines.reduce((sum, line) => sum + toNetRevenue(line.totalBase), 0) * 100) / 100

  const reversalAmounts = await runInTransaction(client, async (tx) => {
    const orderAccounting = await tx.salesOrder.findUnique({
      where: { id: params.orderId },
      select: {
        // o3d-o97 r4: the ORDER-level A2 record, read here as well as at the un-stage below,
        // because valuing an allocation row that carries no posted basis of its own needs the
        // order's recorded debit BEFORE the consume loop runs. Same transaction, same read-only
        // point, no write between the two.
        allocationBatchAmount: true,
        // o3d-0i5y r12 / o3d-xlk7: the pounds ALLOCATION_REVERSAL journals have already credited
        // back out of Allocated Inventory for this order — the THIRD relief source, and the one
        // that did not exist when the open balance below was written. See the netting there.
        allocationReversalAmount: true,
        allocations: {
          select: {
            id: true,
            lineId: true,
            productId: true,
            warehouseId: true,
            qty: true,
            costLayerSnapshot: true,
            // o3d-o97 r3: the pounds A2 DEBITED for this row. `costLayerSnapshot` beside it is
            // re-priced in place by landed-cost revaluation; this is not.
            allocationBatchAmount: true,
          },
        },
        lines: {
          select: {
            id: true,
            productId: true,
            description: true,
            qty: true,
            totalBase: true,
            // o3d-kouj: the recipe this line was ALLOCATED from. The component factors below convert
            // a refund expressed in kit units into the component units its cost basis is denominated
            // in, so they must be the same factors dispatch and A2 used — not whatever the catalogue
            // says today.
            fulfillmentRequirements: true,
          },
        },
        shipments: {
          where: { shipmentJournalDate: { not: null } },
          select: {
            id: true,
            revenueRecognizedAmount: true,
            cogsBatchAmount: true,
            // o3d-o97 r3: the CR Allocated Inventory Group B raised for this shipment, recorded by
            // Group B itself. The CogsEntry-derived fallback below it is HARD-DELETED by
            // `retention_stock_movements_months`.
            allocatedReliefAmount: true,
            // o3d-o97 r4: and WHETHER that credit was ever raised, on which ledger, against which
            // account. The amount alone is written for every stamped shipment; these three are
            // written only when the Group B journal actually carried a CR Allocated line, and the
            // id resolves to that row's STATUS.
            allocatedReliefSyncLogId: true,
            allocatedReliefConnector: true,
            allocatedReliefAccountCode: true,
            lines: {
              select: {
                id: true,
                lineId: true,
                productId: true,
                qty: true,
                costLayerSnapshot: true,
              },
            },
          },
        },
        refunds: {
          where: { id: { not: params.refundId } },
          select: {
            id: true,
            // o3d-o97 r3: the CR Allocated Inventory this earlier refund's own reversal raised,
            // recorded on the refund row. Its sync log — the only previous source — is deleted by
            // `retention_sync_logs_months` once it terminalises.
            allocatedReliefAmount: true,
            lines: {
              select: {
                id: true,
                salesOrderLineId: true,
                productId: true,
                description: true,
                qty: true,
                totalBase: true,
                unitPriceBase: true,
                costLayerSnapshot: true,
              },
            },
          },
        },
      },
    })

    // Connector-agnostic: scope to the connector that will receive the NEW reversal
    // syncs (resolved by the caller), not a hardcoded 'xero'. This keeps the double-
    // reversal guard correct after a connector switch, where accountingSyncLog still
    // holds the old connector's reversal rows. Undefined (unit-test path) → no filter.
    // o3d-o97 r3: NO STATUS FILTER, and the reference columns are selected. The status IN-list
    // used to be part of the query, which made a CANCELLED reversal indistinguishable from a row
    // that was never written at all — and those are opposite facts. A terminal row is positive
    // evidence that the reversal DID NOT post; an ABSENT row is evidence of nothing, because
    // `retention_sync_logs_months` hard-deletes these rows once they terminalise. The status is
    // applied per consumer below instead.
    const priorReversals = await tx.accountingSyncLog.findMany({
      where: {
        ...(params.activeConnector ? { connector: params.activeConnector } : {}),
        OR: [
          { referenceType: 'SalesOrder', referenceId: params.orderId },
          {
            referenceType: 'SalesOrderRefund',
            referenceId: { in: (orderAccounting?.refunds ?? []).map((refund) => refund.id) },
          },
        ],
        // o3d-0i5y r12 / o3d-xlk7: ALLOCATION_REVERSAL joins the list. It is order-scoped, it
        // credits the same Allocated Inventory account, and until it was read here the open balance
        // below could not see it — so a cancelled-then-refunded order credited the same units twice.
        type: { in: ['COGS_REVERSAL', 'UNEARNED_REV_REVERSAL', 'ALLOCATION_REVERSAL'] },
      },
      select: { type: true, status: true, referenceType: true, referenceId: true, payload: true },
    })
    /** Rows whose journal is queued, in flight or in the ledger — i.e. pounds that will move. */
    const livePriorReversals = priorReversals.filter((row) => (
      row.status === 'PENDING' || row.status === 'PROCESSING' || row.status === 'SYNCED'
    ))

    const shipmentLineSnapshots = new Map<string, CostLayerSnapshotEntry[]>()
    for (const shipment of orderAccounting?.shipments ?? []) {
      for (const shipmentLine of shipment.lines) {
        shipmentLineSnapshots.set(
          shipmentLine.id,
          await getShipmentLineCostSnapshot(tx, shipmentLine),
        )
      }
    }

    // 6oyu.5: the ORIGINALLY-POSTED per-layer COGS for every shipment line, used to
    // reverse the refund at the cost that was actually posted at dispatch rather than
    // the current (possibly revalued) layer cost. See loadPostedShipmentUnitCosts.
    const postedShipmentUnitCostByKey = await loadPostedShipmentUnitCosts(
      tx,
      (orderAccounting?.shipments ?? []).flatMap((shipment) => shipment.lines.map((line) => line.id)),
    )

    const referencedCostLayerIds = Array.from(new Set([
      ...(orderAccounting?.allocations ?? []).flatMap((allocation) => (
        parseCostLayerSnapshot(allocation.costLayerSnapshot).map((entry) => entry.costLayerId)
      )),
      ...(orderAccounting?.shipments ?? []).flatMap((shipment) => (
        shipment.lines.flatMap((line) => (
          (shipmentLineSnapshots.get(line.id) ?? []).map((entry) => entry.costLayerId)
        ))
      )),
      ...(orderAccounting?.refunds ?? []).flatMap((refund) => (
        refund.lines.flatMap((line) => (
          parseCostLayerSnapshot(line.costLayerSnapshot).map((entry) => entry.costLayerId)
        ))
      )),
    ]))
    await lockCostLayers(tx, referencedCostLayerIds)
    const referencedCostLayers = referencedCostLayerIds.length > 0
      ? await tx.costLayer.findMany({
          where: { id: { in: referencedCostLayerIds } },
          select: { id: true, productId: true, poLineId: true, unitCostBase: true },
        })
      : []
    const productIdByCostLayerId = new Map(referencedCostLayers.map((layer) => [layer.id, layer.productId]))
    const poLineIdByCostLayerId = new Map(referencedCostLayers.map((layer) => [layer.id, layer.poLineId]))
    // o3d-o97 r3 — THE POSTED UNIT BASIS OF AN ALLOCATION ROW: the pounds A2 debited for the row,
    // divided by the units it debited them for. `OrderAllocation.allocationBatchAmount` is written
    // by A2 in the same transaction as the order's stamp, and nothing revalues it.
    //
    // o3d-o97 r4: NULL and ZERO are different facts here too. A recorded £0 is A2 saying it debited
    // nothing for this row — a KNOWN basis of zero — and it is mapped as such, so the row is not
    // pushed into the no-record branch below and counted as evidence of a missing basis.
    const postedAllocationUnitCostByAllocationId = new Map<string, number>()
    for (const allocation of orderAccounting?.allocations ?? []) {
      if (allocation.allocationBatchAmount == null) continue
      const postedAmount = refundBoundaryNumber(allocation.allocationBatchAmount)
      const allocatedQty = refundBoundaryNumber(allocation.qty)
      if (allocatedQty <= 0) continue
      postedAllocationUnitCostByAllocationId.set(
        allocation.id,
        postedAmount > 0 ? postedAmount / allocatedQty : 0,
      )
    }

    // o3d-o97 r3: value an allocation-source reversal at the basis A2 POSTED for its row.
    //
    // r2 valued it at the CURRENT layer cost — read straight off `CostLayer.unitCostBase`, which is what
    // landed-cost revaluation rewrites — so a partial refund of units A2 debited at £10 reversed
    // them at whatever they are worth today. r2 flagged this itself and argued a full refund
    // self-corrects, because the residue below is the recorded debit less what the lines took. It
    // does not: the residue is floored at zero, so an over-valued line reversal is not clawed back
    // by a negative residue, and a PARTIAL refund never reaches the residue at all. Both are
    // handled — this values at the posted basis, and the cap further down bounds the total by the
    // debit that is actually still open.
    //
    // o3d-o97 r4 — AND WHERE NO POSTED BASIS SURVIVES, THE UNITS ARE STILL NOT PRICED FROM A LAYER.
    //
    // r3 left the old current-cost refresh as the fallback for rows the rebalancer re-pinned after
    // A2 stamped the order and for rows staged before the per-row basis existed — which is EVERY
    // allocation row in the database on the day this ships. That fallback is the defect r3 had just
    // removed, still reachable: the CAP below only bounds the reversal when the ORDER-level record
    // resolved, and even then only when the line total EXCEEDS the open balance, so a PARTIAL
    // refund under that ceiling goes out at whatever the layer is worth today.
    //
    // Worked, at the ceiling and under it. A2 debits four units at £10 — order record £40 — the row
    // is re-created by the rebalancer so it carries no posted amount, and a landed-cost correction
    // rewrites the layer to £18.
    //   THREE units refunded: r3 valued them 3 x £18 = £54 and clamped to £40. Still £10 more than
    //     the £30 those units were debited at, and it leaves the fourth unit £0 of balance instead
    //     of its £10.
    //   TWO units refunded:   r3 sent 2 x £18 = £36 with nothing capping it — £36 is under the £40
    //     balance — against a £20 posted basis. £16 of Inventory conjured from a price A2 never
    //     posted, and the remaining two units, worth £20, left with £4.
    //
    // The answer is not zero, which was tried and is worse than the bug for the existing backlog: a
    // partial refund of never-shipped allocated units is the ONLY thing that ever relieves their
    // share of the contra (Group B relieves only what ships), so reversing nothing strands it
    // permanently on every legacy order rather than temporarily.
    //
    // So the units are valued from A2's OWN RECORDED FIGURE and nothing else: the order's recorded
    // debit, less every row that DID record its share, spread over the units of the rows that did
    // not. Exact whenever the order's rows are all basis-less (the legacy shape: £40/4 = £10, the
    // number A2 actually posted), exact in aggregate always — the parts sum to the recorded debit
    // by construction — and it cannot move with a layer, because no layer is read.
    //
    // o3d-o97 r5 — AND THE BLEND IS ONLY *SAFE* WHERE THOSE TWO GUARANTEES ARE THE ONES BEING USED.
    //
    // r4 named the imprecision itself — "a blend across products, bounded by the recorded debit and
    // closed exactly by the residue" — and then relied on both of those on a PARTIAL refund, where
    // NEITHER IS AVAILABLE. The cap only bites when the line total exceeds the open balance, and the
    // residue only runs on a full refund; under both, a partial takes whatever the blended rate
    // says and nothing corrects it. Where the apportionment pool spans MORE THAN ONE PRODUCT, that
    // rate is no product's rate, so the pounds it credits are fabricated per line.
    //
    // WORKED. A2 debits £40 for an order of 2 units of an expensive product X (a £15 layer, £30) and
    // 2 units of a cheap product Y (a £5 layer, £10). The rebalancer re-created both allocation rows
    // after A2 stamped the order, so neither records its own share; only the order's £40 survives.
    // The pool is 4 units across 2 products, so the blended rate is £10 a unit.
    //   r4, PARTIAL refund of the two Y units: 2 x £10 = £20 credited to Allocated Inventory and £20
    //     debited to Inventory, for units A2 debited £10 for. £10 of inventory conjured; X's real £30
    //     share is left with £20 of balance; the residue never runs, so nothing claws either back.
    //     Refund the two X units instead and the same rate strands £10 the other way.
    //   r5: REFUSED. Nothing is credited, the reason is recorded on the refund row, the order stays
    //     inside both batch windows, and the standing invariant reports it — the pounds stay open
    //     and visible instead of being moved wrongly and silently.
    //
    // o3d-o97 r6 — AND ONE PRODUCT ID IS NOT THE PROPERTY THAT MADE IT SAFE.
    //
    // r5 kept the blend for a single-product pool on the reasoning that "there the rate IS that
    // product's own average across the pool and k units of it are exactly k/n of its debit". That
    // holds only if EVERY UNIT IN THE POOL WAS DEBITED AT THE SAME RATE, and a product is not a
    // rate: two allocation rows of the same product, pinned to different cost layers, were debited
    // at different rates by the same A2 pass. `unrecordedRowProductIds.size === 1` says nothing
    // about that, and the pool is built precisely FROM the rows that record no rate of their own.
    //
    // WORKED, one product. A2 debits £40 for 4 units of product X: row R1 is 3 units pinned to a £5
    // layer (£15) and row R2 is 1 unit pinned to a £25 layer (£25). The rebalancer re-created both
    // rows after A2 stamped the order, so neither records its share and only the order's £40
    // survives. The pool is 4 units of ONE product, so r5 blends at £10 a unit.
    //   r5, PARTIAL refund of R2's single unit: £10 credited to Allocated Inventory for a unit A2
    //     debited £25. £15 of that unit's debit is stranded, while the 3 units left can still claim
    //     £30 against a real £15 — so the next refund conjures £15 of Inventory. Refund R1's 3 units
    //     instead and it is £30 credited against £15 debited, immediately.
    //   r6: REFUSED. Nothing is credited, the reason is recorded on the refund row, the order stays
    //     inside both batch windows and the standing invariant reports it.
    //
    // WHAT THE SAFETY ARGUMENT ACTUALLY NEEDS IS THE THING A2 VALUED, WHICH IS THE ROW. A2 values
    // each allocation ROW and records a figure for it; the order's total is the sum of those. So a
    // rate obtained by spreading the residual is that row's OWN AVERAGE exactly when the residual
    // belongs to ONE row, and is a cross-row blend — a rate A2 never applied to anything — the
    // moment it belongs to two. Products are the wrong unit of account for this: two rows of one
    // product were valued separately (the example above), and one row of one product was valued as
    // a whole however many layers it spanned. So the gate moves from products to ROWS.
    //
    // And there is a second, stronger exemption that needs no uniformity at all: the residual IS the
    // pool's debit BY CONSTRUCTION (the order's recorded figure less every row that recorded its own
    // share), so a refund taking EVERY UNIT of the pool credits exactly that residual whatever the
    // per-row split was — the split cancels in the sum. That covers a many-row pool being wound down
    // completely by a refund that is not (yet) the order's last.
    //
    //   ONE unrecorded row          the rate is that row's own average across the units A2 valued
    //                               together. Allowed, and this is the legacy shape r4 exists for:
    //                               every allocation row in the database is basis-less on the day
    //                               this ships, and refusing them all would strand the backlog
    //                               permanently, which r4 already established is worse than the bug.
    //   k === n over the pool       the apportioned pounds sum to the recorded debit exactly.
    //                               Allowed.
    //   two or more rows, k < n     a share of a pool whose rows A2 priced separately and nothing on
    //                               record can tell apart. Refused on a partial.
    //
    // A FULL refund keeps the blend for every pool, unchanged: the residue closes the order to
    // precisely the open balance whatever the per-line split was.
    const orderRecordedDebit = orderAccounting?.allocationBatchAmount != null
      ? refundBoundaryNumber(orderAccounting.allocationBatchAmount)
      : null
    let recordedRowDebitTotal = 0
    let unrecordedRowQtyTotal = 0
    // o3d-o97 r6: the rows A2 priced SEPARATELY and that record no price. Two or more of them is
    // what makes the apportioned rate a rate A2 never applied — see above. Counted, not just
    // flagged, so the refusal can say how big the pool it could not split actually is.
    let unrecordedRowCount = 0
    const unrecordedRowProductIds = new Set<string>()
    for (const allocation of orderAccounting?.allocations ?? []) {
      const rowQty = refundBoundaryNumber(allocation.qty)
      if (allocation.allocationBatchAmount != null) {
        recordedRowDebitTotal += Math.max(0, refundBoundaryNumber(allocation.allocationBatchAmount))
      } else if (rowQty > 0) {
        unrecordedRowQtyTotal += rowQty
        unrecordedRowCount += 1
        if (allocation.productId) unrecordedRowProductIds.add(allocation.productId)
      }
    }
    // Floored at zero: recorded rows summing past the order's own figure is a contradiction, and
    // the residual is not the place to resolve it — the cap below is.
    const residualDebitForUnrecordedRows = orderRecordedDebit == null
      ? 0
      : Math.max(0, orderRecordedDebit - recordedRowDebitTotal)
    const unrecordedRowUnitCost = unrecordedRowQtyTotal > 0
      ? residualDebitForUnrecordedRows / unrecordedRowQtyTotal
      : 0
    // o3d-o97 r5: true only when a rate was actually apportioned (a zero residual prices the rows at
    // zero, which is an under-reversal the residue closes, not a fabrication) AND that rate belongs
    // to no single product. This is what makes a PARTIAL refund refuse below.

    // Set whenever a refunded unit was priced from that residual rather than from its own row's
    // record. Named in the refusal note, because it is an apportionment rather than a posting.
    let allocationRowBasisMissing = false
    // o3d-o97 r6: how many of the pool's units this refund is actually reversing — the `k` above.
    // Accumulated here because this is the one place a unit is priced from the residual, so it
    // cannot drift from `allocationRowBasisMissing`.
    let unrecordedQtyRefunded = 0
    const applyPostedAllocationUnitCosts = (entries: CostLayerSnapshotEntry[]): CostLayerSnapshotEntry[] => (
      entries.map((entry) => {
        const posted = entry.orderAllocationId
          ? postedAllocationUnitCostByAllocationId.get(entry.orderAllocationId)
          : undefined
        if (posted != null) return { ...entry, unitCostBase: posted }
        const entryQty = refundBoundaryNumber(entry.qty)
        if (entryQty > 0) {
          allocationRowBasisMissing = true
          unrecordedQtyRefunded += entryQty
        }
        return { ...entry, unitCostBase: unrecordedRowUnitCost }
      })
    )

    // o3d-o97 r6 — WHAT AN ACCOUNT MOVED, WHICH IS NOT THE GROSS OF ONE SIDE.
    //
    // r2 read the CREDIT side of a journal's lines for the Allocated Inventory contra and r5 read
    // the DEBIT side for the A2 posting, each summing only the matching lines on the side it cared
    // about. A JOURNAL CAN TOUCH ONE ACCOUNT ON BOTH SIDES, and every reader of these figures is
    // asking what the account MOVED — how much relief it received, how much debit it is carrying —
    // which is the net, never one side's gross.
    //
    // It is not hypothetical for these journals in particular. Group B's is a WHOLE DAY's batch,
    // built line by line, and the reconciliation sweeps add their own rounding lines to it; A2's is
    // likewise a day's window; and both take their account codes from settings, so two roles
    // (Allocated Inventory and, say, the inventory-rounding-difference account) mapped to the SAME
    // code put both sides of a pair on one account.
    //
    // WORKED, on the A2 bound. A day's A2 journal debits Allocated Inventory £1,000 and — because
    // the rounding-difference account is mapped to the same code — credits it £700 in the same
    // journal. The account moved £300. An order records a £500 share of that batch.
    //   gross: 500 <= 1,000, so the share is "inside its batch", the basis resolves, and a full
    //     refund credits Allocated Inventory £500 against a journal that put £300 into it.
    //   net:   500 > 300, so the share cannot have come from this journal, the basis is UNRESOLVED,
    //     nothing is credited and the refund says why. The £300 stays open and visible.
    // The relief side fails the same way in the opposite direction: a batch crediting Allocated
    // £500 and debiting it £120 has relieved £380, and bounding a shipment's £400 recorded share by
    // the £500 gross lets a figure the journal did not deliver be subtracted from the open balance.
    //
    // An empty account code is not a match — an unconfigured account would otherwise sum every line
    // whose own accountCode is blank (o3d-o97 r2).
    const extractPayloadNetMovement = (
      payload: unknown,
      accountCode: string,
      side: 'credit' | 'debit',
    ): number => {
      if (!accountCode) return 0
      const linesPayload = (payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> } | null)?.lines
      if (!Array.isArray(linesPayload)) return 0
      return linesPayload.reduce((sum, line) => {
        if (line.accountCode !== accountCode) return sum
        const debit = refundBoundaryNumber(line.debit ?? 0)
        const credit = refundBoundaryNumber(line.credit ?? 0)
        return sum + (side === 'credit' ? credit - debit : debit - credit)
      }, 0)
    }

    const priorUnearnedReversed = livePriorReversals
      .filter((row) => row.type === 'UNEARNED_REV_REVERSAL')
      .reduce((sum, row) => sum + extractPayloadNetMovement(row.payload, settings.unearnedRevenueAccount, 'debit'), 0)

    // o3d-o97 r5 — WHAT A JOURNAL ROW PROVES, WHICH IS NEVER ITS STATUS.
    //
    // r4 did the hard half of this: it made every relief record NAME the journal that was to carry
    // it, so a figure could be resolved back to a row instead of taken on trust. Then it read the
    // ANSWER off `status` — SYNCED counted the recorded pounds as relief, CANCELLED counted them as
    // a relief of zero — and a status is not an answer:
    //
    //   SYNCED      says THE ROW SETTLED. It does not say which accounts the journal touched, nor
    //               with how much. r3 established exactly this for the A2 amount ("the amount names
    //               no ledger") and r4 lost it one field along: a Group B journal is a WHOLE DAY's
    //               batch, its account codes come from settings that can be re-mapped between the
    //               posting and the refund, and the per-shipment figure beside it is a share of a
    //               total nobody re-checked.
    //   CANCELLED   says THE ROW WAS ABANDONED — by the cross-connector orphan sweep, by an order
    //               cancellation, or by an operator — none of which can see whether the remote call
    //               had already landed, because the processors post BEFORE persisting SYNCED. It is
    //               the same class of fact as FAILED (o3d-ju8t), and reading it as "credited
    //               nothing" over-states the open balance and over-credits the account.
    //
    // What a journal DID is written in the journal: its own payload lines, one of which names this
    // account and carries the pounds. So proof is (a) EVERY row settled, and (b) its lines legible,
    // and then (c) the figure comes from the lines. Anything else is UNPROVED and refuses.
    //
    // ILLEGIBLE is its own answer and is not a refusal. `backReferenceEvidenceCompactedAt`
    // compaction drops `payload` from a row it keeps, so a settled row can be present with nothing
    // readable on it. That is the same epistemic position as a row retention has deleted outright —
    // "finished, outcome no longer legible" — and it is resolved the same way, by the caller, to
    // whichever side moves the least money.
    type JournalLedgerProof =
      | { kind: 'proved'; amount: number }
      | { kind: 'illegible' }
      | { kind: 'unproved'; statuses: string }

    const payloadLinesLegible = (payload: unknown): boolean => (
      Array.isArray((payload as { lines?: unknown } | null)?.lines)
    )

    const proveJournalPosting = (
      rows: Array<{ status: string; payload: unknown }>,
      accountCode: string,
      side: 'credit' | 'debit',
    ): JournalLedgerProof => {
      if (rows.length === 0) return { kind: 'unproved', statuses: 'absent' }
      if (rows.some((row) => row.status !== 'SYNCED')) {
        return { kind: 'unproved', statuses: rows.map((row) => row.status).join('/') }
      }
      if (rows.some((row) => !payloadLinesLegible(row.payload))) return { kind: 'illegible' }
      if (!accountCode) return { kind: 'unproved', statuses: 'no Allocated Inventory account configured' }
      return {
        kind: 'proved',
        // o3d-o97 r6: the account's NET movement across the journal's own lines, not the gross of
        // whichever side the caller expects — see `extractPayloadNetMovement`. Floored at zero
        // because a negative net is the account moving the OTHER WAY, which is not a smaller
        // relief/debit but none of one, and letting it go negative would make several journals sum
        // to a figure no single one of them can be held to.
        amount: Math.max(0, rows.reduce(
          (sum, row) => sum + extractPayloadNetMovement(row.payload, accountCode, side),
          0,
        )),
      }
    }

    // o3d-o97 r4 — WHAT MAKES A RELIEF FIGURE *POSTED* RATHER THAN *QUEUED*.
    //
    // r3 proved, on the A2 side, that an amount written beside a stamp implies no journal: the log
    // is raised only when the window's ROUNDED total is positive, the queued-to-posted step is a
    // DIFFERENT transaction, and the amount names no ledger. It then wrote the two RELIEF records
    // — `Shipment.allocatedReliefAmount` and `SalesOrderRefund.allocatedReliefAmount` — and trusted
    // them exactly the way it had just stopped trusting the A2 amount: recorded, therefore relieved.
    //
    // The direction of that error is what makes it a money bug rather than an untidiness. Relief is
    // SUBTRACTED from the debit, so counting relief that never posted SHRINKS the open balance, the
    // refund credits less than the account holds, and on a FULL refund — which closes both daily
    // batch windows for ever — the difference is stranded permanently with nothing left to notice
    // it. Reading a CANCELLED journal as relief does the same.
    //
    // So a recorded figure is resolved against the journal that was to carry it, answering r3's own
    // three reasons in the same order:
    //
    //   NO JOURNAL RAISED   a relief record that names no journal. Group B stamps the id whenever
    //                       its journal carried a CR Allocated line, so this means the window's
    //                       ROUNDED COGS total was zero and the figure is necessarily sub-penny:
    //                       zero relief, right to within half a penny. A LARGER amount with no id
    //                       cannot have come from that writer and is refused.
    //   NOT SETTLED         PENDING/PROCESSING — queued. The pounds have not moved and may never.
    //                       Not counted as relief, and not counted as zero either: REFUSED, because
    //                       either guess moves real money on a coin flip. FAILED is refused too
    //                       (o3d-ju8t: a FAILED row does not prove nothing was posted). o3d-o97 r5:
    //                       AND SO IS CANCELLED, which r4 read as the one terminal answer that WAS
    //                       evidence. It is not — see `proveJournalPosting` above: cancelling is an
    //                       abandonment written by a sweep or an operator who cannot see whether the
    //                       call had already landed. Reading it as a relief of zero over-states the
    //                       open balance and credits the account pounds it never held.
    //   ANOTHER LEDGER      a relief raised on a connector that is not the one this reversal would
    //                       be raised on, or against an account that is not the one configured as
    //                       Allocated Inventory today, cannot be netted against this credit. r5
    //                       checks the JOURNAL ROW's connector as well as the stamp beside the
    //                       amount, because only the row is the ledger's own record of the fact.
    //   NOT WHAT IT SAYS    o3d-o97 r5, and the finding r4 was still open to: a settled journal
    //                       whose OWN LINES do not carry the credit the record claims. SYNCED says
    //                       the row settled, never what it credited — so the lines are read, the
    //                       account is matched, and a record claiming more relief than the journal
    //                       credited in total, or naming a journal that credits that account
    //                       nothing at all, is refused rather than netted.
    //
    // WHAT IS *NOT* REFUSED, and why: a recorded relief whose journal row has been DELETED. That is
    // the case r3 added these columns for, and it is not the queued case. `data-retention` deletes
    // an accounting sync row only once it is out of POSTABLE_ACCOUNTING_SYNC_STATUSES — i.e. SYNCED
    // or CANCELLED — and past the cutoff, so an absent row is not a queued one; it is a finished
    // one whose outcome is no longer legible. Between the two readings left, counting the recorded
    // amount is the one that MOVES THE LEAST MONEY: if it had in fact been cancelled the refund
    // under-reverses and leaves part of a debit standing (visible, repairable), while reading zero
    // over-credits an account for pounds it never held (silent, and wrong in the ledger). Absence is
    // still not treated as positive evidence of relief — it is treated as no evidence, resolved to
    // the least destructive side, and it is the reason the amount is recorded on a row retention
    // never deletes in the first place.
    //
    // o3d-o97 r6 — AND AN ABSENCE RESOLVED THE LEAST-DESTRUCTIVE WAY IS STILL AN ABSENCE, SO IT HAS
    // TO SAY SO. The reading above is right about the pounds and was silent about the reasoning,
    // and that silence is a defect on its own: the relief record is COUNTED, the open balance
    // shrinks, the refund credits less, and nothing on the refund row or in the invariant report
    // distinguishes it from a relief proved out of a journal's own lines.
    //
    // The combination that makes it a repair signal rather than a footnote: a relief journal that
    // was CANCELLED and never posted refuses while its row survives (r5 — `proveJournalPosting`
    // rejects any non-SYNCED row), and then `retention_sync_logs_months` DELETES that row, because
    // CANCELLED is terminal. From that moment the same record resolves to "posted" at the recorded
    // amount. RETENTION HAS MANUFACTURED A RESOLUTION: the refusal that was standing yesterday is
    // gone today, the invariant stops reporting the order, and the under-reversal — a debit left
    // standing in Allocated Inventory that nothing points at — becomes permanent on a FULL refund.
    //
    // So the third verdict, ASSUMED: the pounds are counted exactly as before (the reading that
    // moves the least money is unchanged), and the reason is recorded on the refund row alongside
    // any refusal, so the finding stands until a human resolves it. It does NOT withhold the
    // reversal — an assumption is not a refusal, and treating it as one would strand the very
    // pre-column and post-retention cases these columns were added to survive.
    type AllocatedReliefVerdict =
      | { kind: 'posted' }
      | { kind: 'none' }
      | { kind: 'assumed'; reason: string }
      | { kind: 'unresolved'; reason: string }


    // Resolves a relief record that names its own journal — Group B stamps the row's id, connector
    // and account on the shipment. `recorded` is the pounds the record claims.
    const resolveAllocatedReliefPosting = async (record: {
      syncLogId: string | null
      connector: string | null
      accountCode: string | null
      subject: string
      recorded: number
    }): Promise<AllocatedReliefVerdict> => {
      if (record.recorded <= 0) return { kind: 'none' }
      if (!record.syncLogId) {
        if (record.recorded < 0.005) return { kind: 'none' }
        return {
          kind: 'unresolved',
          reason: `${record.subject} records £${record.recorded.toFixed(2)} of Allocated Inventory relief but names no journal, so whether that credit was ever raised — and in which ledger — cannot be established`,
        }
      }
      if (params.activeConnector && record.connector && record.connector !== params.activeConnector) {
        return {
          kind: 'unresolved',
          reason: `${record.subject} credited Allocated Inventory on ${record.connector}, but this reversal would be raised on ${params.activeConnector} — relief in one ledger cannot be netted against a debit in another`,
        }
      }
      if (record.accountCode && record.accountCode !== settings.allocatedInventoryAccount) {
        return {
          kind: 'unresolved',
          reason: `${record.subject} credited account ${record.accountCode}, but Allocated Inventory is configured as ${settings.allocatedInventoryAccount} today, so that relief did not touch the account this reversal would credit`,
        }
      }
      const journal = await tx.accountingSyncLog.findUnique({
        where: { id: record.syncLogId },
        select: { status: true, connector: true, payload: true },
      })
      // Deleted by retention once terminal: read as the recorded amount, the least destructive of
      // the two readings left — but ASSUMED, not proved (o3d-o97 r6). Retention deletes SYNCED and
      // CANCELLED rows alike, so this absence is equally consistent with a relief that never
      // posted; counting it silently is how a refusal that was standing becomes a resolution.
      if (!journal) {
        return {
          kind: 'assumed',
          reason: `${record.subject}'s £${record.recorded.toFixed(2)} of Allocated Inventory relief was counted from its own record because the journal it names is no longer on record (retention) — retention deletes cancelled journals as well as settled ones, so whether those pounds ever reached the account is not established`,
        }
      }
      // o3d-o97 r5: the ROW's own connector, not just the stamp beside the amount. The stamp is
      // written by the same statement as the figure and can only be as right as that writer was;
      // the row is the ledger's own record of which books it was raised into.
      if (params.activeConnector && journal.connector && journal.connector !== params.activeConnector) {
        return {
          kind: 'unresolved',
          reason: `the journal that was to credit Allocated Inventory £${record.recorded.toFixed(2)} for ${record.subject} was raised on ${journal.connector}, but this reversal would be raised on ${params.activeConnector} — a credit in one set of books cannot be netted against a debit in another`,
        }
      }
      // o3d-o97 r5 — AND NOW WHAT IT CREDITED, from its own lines. Group B's journal covers a WHOLE
      // DAY, so the lines give the batch's total CR to Allocated Inventory, not this shipment's
      // share; the share is the recorded figure, and the journal BOUNDS it. Two ways to fail:
      const proof = proveJournalPosting([journal], settings.allocatedInventoryAccount, 'credit')
      // Payload compacted off a settled row (backReferenceEvidenceCompactedAt): the same position
      // as a row retention deleted, resolved the same way — the recorded amount stands, and says
      // that it stands on the record rather than on the journal (o3d-o97 r6).
      if (proof.kind === 'illegible') {
        return {
          kind: 'assumed',
          reason: `${record.subject}'s £${record.recorded.toFixed(2)} of Allocated Inventory relief was counted from its own record because its journal has settled but its lines have been compacted off the row, so what that journal actually credited to ${settings.allocatedInventoryAccount} cannot be read`,
        }
      }
      if (proof.kind === 'unproved') {
        return {
          kind: 'unresolved',
          reason: `the journal that was to credit Allocated Inventory £${record.recorded.toFixed(2)} for ${record.subject} is ${proof.statuses}, not SYNCED — whether those pounds moved is not established, and guessing either way moves real money`,
        }
      }
      if (proof.amount <= 0) {
        return {
          kind: 'unresolved',
          reason: `${record.subject} records £${record.recorded.toFixed(2)} of Allocated Inventory relief, but the journal it names credits nothing to ${settings.allocatedInventoryAccount} — the record and the journal disagree about what was relieved, so how much of the A2 debit is open cannot be established`,
        }
      }
      if (record.recorded > proof.amount + 0.005) {
        return {
          kind: 'unresolved',
          reason: `${record.subject} records £${record.recorded.toFixed(2)} of Allocated Inventory relief, more than the £${proof.amount.toFixed(2)} its journal credited to ${settings.allocatedInventoryAccount} in total — a share cannot exceed the batch it came from, so that figure cannot be netted against the A2 debit`,
        }
      }
      return { kind: 'posted' }
    }

    // o3d-o97 r3 — THE ALLOCATED CONTRA THIS ORDER'S PRIOR REFUNDS RELIEVED, and — separately —
    // whether that is KNOWN at all.
    //
    // r2 read it off the live reversal journals alone. That is neither FINAL nor DURABLE:
    //
    //   not final    the query counted PENDING and PROCESSING rows as relief. Those are pounds
    //                that have not moved yet. Kept, deliberately — the refund is blocked while an
    //                earlier one still owes a retry (scjz.22), so a queued reversal is work that
    //                completes, and counting it errs towards UNDER-reversing (a debit left
    //                standing) rather than crediting an account twice.
    //   not durable  the row is HARD-DELETED by `retention_sync_logs_months` the moment it is
    //                terminal and past the cutoff. With the row gone the relief read ZERO and the
    //                residue below reversed the WHOLE A2 debit a second time. A record that
    //                survives the crash and then expires is not evidence.
    //
    // So the relief now comes from a record on the REFUND ROW, which retention never deletes, and
    // the sync log is only the fallback for refunds written before that column existed. Four
    // outcomes per prior refund, and the fourth REFUSES rather than assuming zero:
    let priorRefundAllocationRelief = 0
    let priorRefundReliefUnresolved: string | null = null
    // o3d-o97 r6: relief counted from a record because its journal could not be read — deleted by
    // retention, or compacted. Not a refusal (the pounds are counted, the reversal is not withheld),
    // but it MUST reach the refund row, or retention silently turns an unproved relief into a
    // resolved one and the standing invariant stops reporting the order.
    const assumedReliefNotes: string[] = []
    let assumedReliefTotal = 0
    // Order-scoped reversal rows (referenceType 'SalesOrder') belong to no refund in particular,
    // so they are counted whole. There is no per-order row to record them on.
    for (const row of livePriorReversals) {
      if (row.type !== 'UNEARNED_REV_REVERSAL' || row.referenceType !== 'SalesOrder') continue
      priorRefundAllocationRelief += extractPayloadNetMovement(row.payload, settings.allocatedInventoryAccount, 'credit')
    }
    for (const priorRefund of orderAccounting?.refunds ?? []) {
      // (1) THE RECORD the refund wrote when it decided its own reversal — RESOLVED, not trusted.
      //
      // o3d-o97 r4: r3 added this column and read it as posted relief on sight. It is written
      // inside the reversal transaction, BEFORE the UNEARNED_REV_REVERSAL sync exists at all: that
      // sync is queued afterwards, in a different transaction (queueRefundAccountingActions), and
      // the remote call is later still. So the recorded amount says what the earlier refund DECIDED
      // to credit, never what reached a ledger — the same distinction r3 drew for A2 and then lost
      // one field along.
      //
      // The refund carries no journal id of its own (the row does not exist when the amount is
      // written), so the journal is found the way the double-reversal guard already finds it: by
      // reference, on the active connector. That is the SAME three-part identity A2 stamps and
      // nothing weaker — the row's existence proves it was created, `referenceType`/`referenceId`
      // tie it to this refund and nothing else, and the query is scoped to the connector this
      // reversal would be raised on — so no extra column is owed here.
      //
      // o3d-o97 r5: AND THE FIGURE NOW COMES FROM THE JOURNAL'S OWN LINES, not from the column.
      // r4 took the amount from the column and only the verdict from the row, which is the same
      // "SYNCED means it credited what I say it credited" inference in a smaller place. Unlike
      // Group B's, this journal is raised for ONE REFUND, so its CR to the Allocated Inventory
      // account IS exactly what that refund relieved — no share, no apportionment, no bound needed.
      // The column stays the fallback for the case it was added for: the row deleted by
      // `retention_sync_logs_months`, or its payload compacted off it.
      if (priorRefund.allocatedReliefAmount != null) {
        const recordedRelief = refundBoundaryNumber(priorRefund.allocatedReliefAmount)
        // A recorded ZERO is the refund saying it raised no CR Allocated line at all — there is no
        // journal to look for, and no pounds either way.
        if (recordedRelief <= 0) continue
        const ownReversalRows = priorReversals.filter((row) => (
          row.type === 'UNEARNED_REV_REVERSAL' &&
          row.referenceType === 'SalesOrderRefund' &&
          row.referenceId === priorRefund.id
        ))
        // No row at all: retention has taken a TERMINAL row (only SYNCED and CANCELLED rows are
        // ever deleted), which is precisely what this column exists to survive. Count it — the
        // reading that moves the least money — exactly as r3 does, and SAY that it was counted on
        // the record rather than on a journal (o3d-o97 r6): "only SYNCED and CANCELLED are deleted"
        // includes CANCELLED, so this absence is exactly as consistent with a relief that never
        // reached the ledger, and counting it silently retires the refusal that stood yesterday.
        if (ownReversalRows.length === 0) {
          priorRefundAllocationRelief += recordedRelief
          assumedReliefTotal += recordedRelief
          assumedReliefNotes.push(`prior refund ${priorRefund.id}'s £${recordedRelief.toFixed(2)} of Allocated Inventory relief was counted from its own record because its reversal journal is no longer on record (retention) — retention deletes cancelled journals as well as settled ones, so whether those pounds ever reached the account is not established`)
          continue
        }
        const proof = proveJournalPosting(ownReversalRows, settings.allocatedInventoryAccount, 'credit')
        if (proof.kind === 'illegible') {
          // A settled row whose payload was compacted away. Same position as no row at all, and
          // recorded as an assumption for the same reason (o3d-o97 r6).
          priorRefundAllocationRelief += recordedRelief
          assumedReliefTotal += recordedRelief
          assumedReliefNotes.push(`prior refund ${priorRefund.id}'s £${recordedRelief.toFixed(2)} of Allocated Inventory relief was counted from its own record because its reversal journal has settled but its lines have been compacted off the row, so what it actually credited to ${settings.allocatedInventoryAccount} cannot be read`)
        } else if (proof.kind === 'unproved') {
          priorRefundReliefUnresolved = `prior refund ${priorRefund.id} recorded £${recordedRelief.toFixed(2)} of Allocated Inventory relief but its reversal journal is ${proof.statuses}, not SYNCED — whether that credit reached the ledger is not established, so how much of the A2 debit is still open cannot be either`
        } else {
          // PROVED. The pounds are the journal's own CR to this account — which may legitimately be
          // ZERO (a settled reversal that credited a different account, or none), and a proved zero
          // is a fact: none of that part of the debit was relieved, so this refund may take it all.
          priorRefundAllocationRelief += proof.amount
        }
        continue
      }
      // (2) It claimed no ALLOCATION-source units, so it cannot have relieved the allocated
      // contra at all — whatever became of its journal. A monetary-only or shipped-only refund
      // is the common case, and this is durable: the snapshot is written for every line.
      const claimedAllocationUnits = priorRefund.lines.some((line) => (
        parseCostLayerSnapshot(line.costLayerSnapshot).some((entry) => entry.source === 'allocation')
      ))
      if (!claimedAllocationUnits) continue
      // (3) Its reversal sync still exists, so what it credited can be read off the journal itself.
      const ownRows = priorReversals.filter((row) => (
        row.type === 'UNEARNED_REV_REVERSAL' &&
        row.referenceType === 'SalesOrderRefund' &&
        row.referenceId === priorRefund.id
      ))
      if (ownRows.length > 0) {
        // o3d-o97 r4: r3 counted PENDING/PROCESSING as relief and read FAILED as zero; both are
        // guesses in the direction that moves money — o3d-ju8t established that a FAILED row does
        // NOT prove nothing was posted, so zero relief there can over-credit the account.
        //
        // o3d-o97 r5: and the same now goes for CANCELLED, which r4 still read as a proved zero.
        // With no recorded column behind this branch there is nothing to fall back on either, so an
        // ILLEGIBLE payload on a settled row refuses here rather than resolving to a figure.
        const proof = proveJournalPosting(ownRows, settings.allocatedInventoryAccount, 'credit')
        if (proof.kind === 'proved') {
          priorRefundAllocationRelief += proof.amount
        } else if (proof.kind === 'illegible') {
          priorRefundReliefUnresolved = `prior refund ${priorRefund.id} claimed allocated units and its reversal journal has settled, but the journal's lines are no longer on the row, so how much it credited Allocated Inventory cannot be established`
        } else {
          priorRefundReliefUnresolved = `prior refund ${priorRefund.id} claimed allocated units and its reversal journal is ${proof.statuses}, not SYNCED — how much it has already credited Allocated Inventory cannot be established`
        }
        continue
      }
      // (4) It claimed allocated units and NOTHING says what it did with them. Reading that as
      // zero relief is what double-credits the account.
      priorRefundReliefUnresolved = `prior refund ${priorRefund.id} claimed allocated units but its reversal journal is no longer on record (retention), so how much it already credited Allocated Inventory cannot be established`
    }

    // o3d-0i5y r12 / o3d-xlk7 — THE THIRD RELIEF SOURCE: WHAT AN ALLOCATION_REVERSAL ALREADY
    // CREDITED BACK OUT OF ALLOCATED INVENTORY.
    //
    // THE DEFECT THIS CLOSES, measured on both branches rather than guessed. Group A2 debits
    // Allocated Inventory for an order's allocated units. o3d-o97 (merged as #635) says how many of
    // those pounds are still open — `allocationBatchAmount` less relief it can PROVE — and it knows
    // exactly two relief sources: Group B's per-shipment `allocatedReliefAmount`, and each earlier
    // refund's `allocatedReliefAmount`. o3d-batch-shiporder raises ALLOCATION_REVERSAL journals from
    // four callers (the allocator's re-file, the deallocation teardown, the manual editor, the
    // over-allocation rebalancer) for units ORPHANED off an order — units that will not ship and
    // were not refunded, so NEITHER of those two sources will ever describe them.
    //
    // An ALLOCATION_REVERSAL is neither, so it was invisible to the subtraction. Reverse £30 of
    // orphaned units in March, refund the order in full in June, and the residue credits the SAME
    // £30 a second time: Allocated Inventory ends £30 to the good with nothing in IMS saying so.
    // Nothing double-counts on either branch alone — this only becomes reachable when both are
    // present, which is why it is fixed here, on the side that arrived second.
    //
    // WHY COUNTING IT HERE, RATHER THAN REMOVING THE REVERSAL. The reversal is not redundant with
    // anything merged: o3d-o97 states in `allocated-inventory-debit.ts` that reversing an orphaned
    // debit is deliberately NOT attempted there ("there is no credit note to carry that reversal and
    // it needs a sync type of its own"), and it is the refund side of the contra that it owns. The
    // two halves are complementary, and the only thing they disagreed about is this arithmetic.
    //
    // AND IT IS PROVED THE SAME WAY EVERY OTHER RELIEF HERE IS PROVED — from the journal's OWN
    // LINES, netted (`proveJournalPosting`), never from a status and never from a recorded figure
    // taken on trust. Four outcomes, matching the prior-refund block above exactly:
    //
    //   PROVED       every reversal row settled and legible: the relief is what those journals
    //                actually credited to the configured Allocated Inventory account, netted, so a
    //                journal that touches the account on both sides counts only its net movement.
    //   ASSUMED      the order records reversals whose journals can no longer be read — deleted by
    //                `retention_sync_logs_months` (it deletes CANCELLED rows as well as SYNCED
    //                ones), or with their payload compacted off a settled row. The recorded figure
    //                is counted, because that is the reading that MOVES THE LEAST MONEY: counting
    //                it can only UNDER-reverse, leaving a visible standing debit, while ignoring it
    //                credits the account pounds it does not hold. The assumption is recorded on the
    //                refund row so retention cannot quietly turn it into a resolution.
    //   UNRESOLVED   a reversal row that is present and NOT SYNCED — PENDING, PROCESSING, FAILED or
    //                CANCELLED. None of those says what reached the ledger (o3d-ju8t for FAILED,
    //                o3d-o97 r5 for CANCELLED: a status is not a posting), and guessing either way
    //                moves real money, so the refund refuses and says which journal.
    //   NONE         the order has never had a reversal raised for it, which is every order until
    //                one is.
    //
    // The RECORDED figure is the durable half and the journals are the provable half, and both are
    // needed: `retention_sync_logs_months` hard-deletes these rows once terminal, and an orphaning
    // can precede its order's refund by many months.
    let allocationReversalRelief = 0
    let allocationReversalReliefUnresolved: string | null = null
    {
      const reversalRows = priorReversals.filter((row) => (
        row.type === 'ALLOCATION_REVERSAL' && row.referenceType === 'SalesOrder'
      ))
      const recordedReversalTotal = orderAccounting?.allocationReversalAmount != null
        ? refundBoundaryNumber(orderAccounting.allocationReversalAmount)
        : 0
      const unsettled = reversalRows.filter((row) => row.status !== 'SYNCED')
      const settledRows = reversalRows.filter((row) => row.status === 'SYNCED')
      const legible = settledRows.filter((row) => payloadLinesLegible(row.payload))
      if (unsettled.length > 0) {
        // Deliberately BEFORE the arithmetic, and a refusal rather than a partial figure: an
        // in-flight or abandoned reversal is pounds that may or may not have moved, and either
        // guess is wrong in the ledger. The refusal names the statuses so an operator can see which.
        allocationReversalReliefUnresolved = `this order has ${unsettled.length} Allocated Inventory reversal journal(s) recorded ${[...new Set(unsettled.map((row) => row.status))].join('/')}, not SYNCED — whether those pounds have left Allocated Inventory is not established, so how much of the A2 debit is still open cannot be either`
      } else {
        const proof = proveJournalPosting(legible, settings.allocatedInventoryAccount, 'credit')
        // `proveJournalPosting` answers 'unproved'/'absent' for an EMPTY list, which here means only
        // that no legible reversal survives — not that none was raised. The recorded total is what
        // answers that, below.
        const provedRelief = legible.length > 0 && proof.kind === 'proved' ? proof.amount : 0
        allocationReversalRelief = provedRelief
        // Whatever the record claims beyond what the surviving journals can account for belongs to
        // a reversal retention has taken or compacted. Counted, and SAID to be counted on the
        // record rather than on a journal (the o3d-o97 r6 'assumed' verdict, same wording, same
        // reason).
        const unreadable = roundQuantity(
          subtractMoney(toDecimal(recordedReversalTotal), toDecimal(provedRelief)),
          2,
        ).toNumber()
        if (unreadable > 0.005) {
          allocationReversalRelief += unreadable
          assumedReliefTotal += unreadable
          assumedReliefNotes.push(`£${unreadable.toFixed(2)} of this order's recorded Allocated Inventory reversal relief was counted from its own record because the journal(s) that raised it can no longer be read — deleted by retention, or compacted off a settled row — and retention deletes cancelled journals as well as settled ones, so whether those pounds ever left the account is not established`)
        }
      }
    }

    // o3d-o97 r2: THE RECORD of the Allocated Inventory contra Group B relieved — its CR Allocated
    // equals the dispatch COGS it debited, per journaled shipment. Valued at the ORIGINALLY-POSTED
    // basis (immutable CogsEntry rows, 6oyu.5), never at the current layer cost: a later landed-cost
    // revaluation rewrites the snapshot and Shipment.cogsBatchAmount in place while posting only to
    // COGS/Inventory, so the Allocated relief stays exactly what Group B credited.
    // `orderAccounting.shipments` is already filtered to journaled shipments, so an un-journaled
    // dispatch contributes nothing here — its allocated contra is still open, which is what lets
    // consumeAllocationCostForLine reverse it.
    //
    // o3d-o97 r3: FROM THE RECORD GROUP B WROTE, not from the CogsEntry rows. r2 valued this at the
    // "immutable posted basis" — but `retention_stock_movements_months` HARD-DELETES the
    // StockMovement rows and their CogsEntry children outright (data-retention.ts), and once they
    // are gone the derivation below silently degrades: it re-values the stored line snapshot at the
    // CURRENT (revalued) layer cost, or — for a shipment whose lines carry no stored snapshot at
    // all — returns ZERO, which reads as "Group B relieved nothing" and reverses its relief a
    // second time. So `Shipment.allocatedReliefAmount`, written in the same UPDATE as
    // `shipmentJournalDate`, is the source; the derivation is only for shipments journaled before
    // that column existed, and it REFUSES when its own basis has expired.
    let postedGroupBAllocationRelief = toDecimal(0)
    let groupBReliefUnresolved: string | null = null
    for (const shipment of orderAccounting?.shipments ?? []) {
      if (shipment.allocatedReliefAmount != null) {
        // o3d-o97 r4: RESOLVED through the journal Group B named, not taken on the amount alone.
        // `shipmentJournalDate` says the shipment passed through the Group B window; it does not
        // say the window raised a CR Allocated Inventory line (a window whose ROUNDED COGS total is
        // zero raises a revenue-only journal), nor that the journal reached a ledger.
        const recordedRelief = refundBoundaryNumber(shipment.allocatedReliefAmount)
        const verdict = await resolveAllocatedReliefPosting({
          syncLogId: shipment.allocatedReliefSyncLogId,
          connector: shipment.allocatedReliefConnector,
          accountCode: shipment.allocatedReliefAccountCode,
          subject: `shipment ${shipment.id}`,
          recorded: recordedRelief,
        })
        if (verdict.kind === 'unresolved') {
          groupBReliefUnresolved = verdict.reason
          continue
        }
        if (verdict.kind === 'assumed') {
          // o3d-o97 r6: counted, and reported as counted-on-the-record. Not a refusal.
          assumedReliefTotal += recordedRelief
          assumedReliefNotes.push(verdict.reason)
        }
        if (verdict.kind === 'posted' || verdict.kind === 'assumed') {
          postedGroupBAllocationRelief = addMoney(postedGroupBAllocationRelief, toDecimal(recordedRelief))
        }
        // 'none' contributes zero relief, which is a FACT and not a gap: the contra never received
        // this shipment's credit, so the whole of it is still open for the reversal to take.
        continue
      }
      let derived = toDecimal(0)
      let basisIntact = true
      for (const shipmentLine of shipment.lines) {
        // The stored snapshot does not name its own shipment line — the consume path stamps that
        // on at take time (takeFromSnapshotEntries), and the posted-cost lookup is keyed by it —
        // so stamp it here the same way before valuing.
        const entries = (shipmentLineSnapshots.get(shipmentLine.id) ?? []).map((entry) => ({
          ...entry,
          shipmentLineId: shipmentLine.id,
        }))
        if (entries.length === 0) {
          // A journaled line that dispatched units and can show no basis for them: its movement
          // and CogsEntry rows have been swept. Zero here is a wrong answer, not a small one.
          if (refundBoundaryNumber(shipmentLine.qty) > 0) basisIntact = false
          continue
        }
        for (const entry of entries) {
          if (!postedShipmentUnitCostByKey.has(postedShipmentUnitCostKey(shipmentLine.id, entry.costLayerId))) {
            // The snapshot survived but the posted unit cost behind it did not, so the only
            // valuation left is the CURRENT layer cost — the exact revaluation 6oyu.5 forbids.
            basisIntact = false
          }
        }
        derived = addMoney(
          derived,
          sumCostLayerSnapshot(applyPostedShipmentUnitCosts(entries, postedShipmentUnitCostByKey)),
        )
      }
      if (!basisIntact) {
        groupBReliefUnresolved = `shipment ${shipment.id} was journaled but the dispatch cost rows behind its Allocated Inventory relief have been swept by stock-movement retention, so how much Group B already credited cannot be established`
        continue
      }
      postedGroupBAllocationRelief = addMoney(postedGroupBAllocationRelief, derived)
    }

    const lineContexts = (orderAccounting?.lines ?? []).map((line) => ({
      id: line.id,
      productId: line.productId,
      description: line.description,
      qty: refundBoundaryNumber(line.qty),
      totalBase: refundBoundaryNumber(line.totalBase),
      fulfillmentRequirements: line.fulfillmentRequirements,
    }))

    // scjz.20: refund quantities are in SALES-LINE (kit) units, but shipment lines
    // and cost-layer snapshots are in COMPONENT units (a KIT ships its expanded
    // components). Build per-line component requirements (component productId ->
    // units per 1 sales-line unit) so the cost consume can convert kit qty to the
    // component qty its snapshot is denominated in, and measure shipped qty as
    // kit-equivalent COVERAGE rather than a raw component-unit sum.
    //
    // o3d-kouj: FROM THE LINE'S PINNED RECIPE. This is the money end of the snapshot. These factors
    // decide how much cost basis a refund reverses, and the basis being relieved was recorded — by
    // dispatch onto the shipment line, and by Group A2 onto the allocation row — in the component
    // units of the recipe the order was ALLOCATED from. Re-deriving them from the current graph is
    // what made a kit re-composed after dispatch reverse the wrong quantity of the right layers:
    // too little and COGS never reconciles, too much and the reversal eats another line's basis and
    // the whole refund fails closed on "only M available across recorded shipments".
    const fulfillmentGraph = await loadFulfillmentProductGraph(
      tx,
      (orderAccounting?.lines ?? []).map((line) => line.productId).filter((id): id is string => !!id),
    )
    const componentFactorsByLine = new Map<string, Map<string, number>>()
    const requirementsByLine = new Map<string, FulfillmentRequirement[]>()
    for (const line of lineContexts) {
      if (!line.productId) continue
      const requirements = lineFulfillmentRequirements(line, fulfillmentGraph)
      componentFactorsByLine.set(line.id, new Map(requirements.map((requirement) => [requirement.productId, requirement.factor.toNumber()])))
      requirementsByLine.set(line.id, requirements.map((requirement) => ({
        productId: requirement.productId,
        factor: requirement.factor.toNumber(),
      })))
    }

    const shipmentComponentRows = (orderAccounting?.shipments ?? []).flatMap((shipment) =>
      shipment.lines.map((line) => ({ lineId: line.lineId, productId: line.productId, qty: refundBoundaryNumber(line.qty) })),
    )
    const shippedQtyByLine = calculateCoverageByLine(requirementsByLine, shipmentComponentRows)
    let totalRecognized = 0
    for (const shipment of orderAccounting?.shipments ?? []) {
      totalRecognized += refundBoundaryNumber(shipment.revenueRecognizedAmount)
    }

    const remainingShippedQtyByLine = new Map<string, number>()
    const remainingUnshippedQtyByLine = new Map<string, number>()

    for (const line of lineContexts) {
      const shippedQty = Math.min(line.qty, shippedQtyByLine.get(line.id) ?? 0)
      const unshippedQty = Math.max(0, line.qty - shippedQty)
      remainingShippedQtyByLine.set(line.id, shippedQty)
      remainingUnshippedQtyByLine.set(line.id, unshippedQty)
    }

    for (const priorRefund of orderAccounting?.refunds ?? []) {
      for (const priorRefundLine of priorRefund.lines) {
        consumeRefundLineQuantity(
          lineContexts,
          remainingShippedQtyByLine,
          remainingUnshippedQtyByLine,
          {
            lineId: priorRefundLine.salesOrderLineId,
            productId: priorRefundLine.productId,
            description: priorRefundLine.description,
            qty: refundBoundaryNumber(priorRefundLine.qty),
            totalBase: refundBoundaryNumber(priorRefundLine.totalBase),
            unitPriceBase: refundBoundaryNumber(priorRefundLine.unitPriceBase),
          },
        )
      }
    }

    let shippedQtyRevenue = 0
    let unshippedQtyRevenue = 0
    let nonQtyRevenue = 0
    const refundLayerSnapshots = new Map<string, CostLayerSnapshotEntry[]>()
    const shipmentLineAvailability = new Map<string, CostLayerSnapshotEntry[]>()
    const allocationAvailability = new Map<string, CostLayerSnapshotEntry[]>()

    for (const shipment of orderAccounting?.shipments ?? []) {
      for (const shipmentLine of shipment.lines) {
        shipmentLineAvailability.set(
          shipmentLine.id,
          shipmentLineSnapshots.get(shipmentLine.id) ?? [],
        )
      }
    }

    for (const allocation of orderAccounting?.allocations ?? []) {
      allocationAvailability.set(
        allocation.id,
        parseCostLayerSnapshot(allocation.costLayerSnapshot),
      )
    }

    for (const shipment of orderAccounting?.shipments ?? []) {
      for (const shipmentLine of shipment.lines) {
        for (const entry of shipmentLineSnapshots.get(shipmentLine.id) ?? []) {
          if (!entry.orderAllocationId) continue
          const available = allocationAvailability.get(entry.orderAllocationId) ?? []
          // Relieve the allocation by QTY, not exact costLayerId: dispatch consumes
          // FIFO-oldest layers that can differ from the allocation's pinned ones, so
          // a costLayerId match would leave the shipped qty available for an unshipped
          // refund to wrongly reverse allocation cost for already-shipped units
          // (cogs-audit scjz.21; mirrors the daily-sync relief).
          allocationAvailability.set(
            entry.orderAllocationId,
            reduceSnapshotByQty(available, entry.qty),
          )
        }
      }
    }

    for (const priorRefund of orderAccounting?.refunds ?? []) {
      for (const priorRefundLine of priorRefund.lines) {
        for (const entry of parseCostLayerSnapshot(priorRefundLine.costLayerSnapshot)) {
          if (entry.source === 'shipment' && entry.shipmentLineId) {
            const available = shipmentLineAvailability.get(entry.shipmentLineId) ?? []
            shipmentLineAvailability.set(
              entry.shipmentLineId,
              reduceSnapshotByCostLayer(available, [{ costLayerId: entry.costLayerId, qty: entry.qty }]),
            )
          }
          if (entry.source === 'allocation' && entry.orderAllocationId) {
            const available = allocationAvailability.get(entry.orderAllocationId) ?? []
            // Qty-based, consistent with the shipment relief above (scjz.21).
            allocationAvailability.set(
              entry.orderAllocationId,
              reduceSnapshotByQty(available, entry.qty),
            )
          }
        }
      }
    }

    const consumeShipmentCostForLine = (lineId: string, qty: number): CostLayerSnapshotEntry[] => {
      const matchingShipmentLines = (orderAccounting?.shipments ?? [])
        .flatMap((shipment) => shipment.lines)
        .filter((line) => line.lineId === lineId)
      if (matchingShipmentLines.length === 0) return []
      // scjz.20: `qty` is in SALES-LINE (kit) units, but each shipment line's
      // cost-layer snapshot is denominated in COMPONENT units. A KIT line ships every
      // component, so reverse `qty * componentFactor` of each component's basis
      // (componentFactor === 1 for SIMPLE products, leaving them unchanged). Without
      // this conversion a kit refund reverses only `qty` component units instead of
      // `qty * factor`, under-reversing COGS so inventory/GL can never reconcile.
      const factors = componentFactorsByLine.get(lineId)
      const componentProductIds = new Set(
        matchingShipmentLines.map((line) => line.productId).filter((id): id is string => !!id),
      )
      const consumed: CostLayerSnapshotEntry[] = []
      for (const componentProductId of componentProductIds) {
        const factor = factors?.get(componentProductId) ?? 1
        let remainingQty = qty * factor
        for (const shipment of orderAccounting?.shipments ?? []) {
          for (const shipmentLine of shipment.lines) {
            if (
              shipmentLine.lineId !== lineId ||
              shipmentLine.productId !== componentProductId ||
              remainingQty <= 0
            )
              continue
            const available = shipmentLineAvailability.get(shipmentLine.id) ?? []
            const taken = takeFromSnapshotEntries(available, remainingQty, {
              shipmentLineId: shipmentLine.id,
              source: 'shipment',
            })
            // 6oyu.5: value the reversed shipment units at the ORIGINALLY-POSTED
            // COGS, not the current (possibly revalued) layer cost.
            consumed.push(...applyPostedShipmentUnitCosts(taken.taken, postedShipmentUnitCostByKey))
            remainingQty = taken.remainingQty
            shipmentLineAvailability.set(
              shipmentLine.id,
              reduceSnapshotByCostLayer(
                available,
                taken.taken.map((entry) => ({ costLayerId: entry.costLayerId, qty: entry.qty })),
              ),
            )
          }
        }
        if (remainingQty > 0.0000001) {
          throw new Error(
            `Cannot reverse COGS for refunded line ${lineId} component ${componentProductId}: requested ` +
            `${(qty * factor).toFixed(4)} unit(s) of shipment cost basis but only ` +
            `${(qty * factor - remainingQty).toFixed(4)} available across recorded shipments. ` +
            `This usually means the cost-layer snapshot is stale or was cleared between batch runs.`,
          )
        }
      }
      return consumed
    }

    const consumeAllocationCostForLine = (lineId: string, qty: number): CostLayerSnapshotEntry[] => {
      const matchingAllocations = (orderAccounting?.allocations ?? [])
        .filter((allocation) => allocation.lineId === lineId)
      if (matchingAllocations.length === 0) return []
      // scjz.20: allocations are COMPONENT-level (a KIT allocates each component), so
      // mirror the shipment consume and reverse `qty * componentFactor` per component.
      const factors = componentFactorsByLine.get(lineId)
      const componentProductIds = new Set(
        matchingAllocations.map((allocation) => allocation.productId).filter((id): id is string => !!id),
      )
      const consumed: CostLayerSnapshotEntry[] = []
      for (const componentProductId of componentProductIds) {
        const factor = factors?.get(componentProductId) ?? 1
        let remainingQty = qty * factor
        for (const allocation of orderAccounting?.allocations ?? []) {
          if (
            allocation.lineId !== lineId ||
            allocation.productId !== componentProductId ||
            remainingQty <= 0
          )
            continue
          const available = allocationAvailability.get(allocation.id) ?? []
          const taken = takeFromSnapshotEntries(available, remainingQty, {
            orderAllocationId: allocation.id,
            source: 'allocation',
          })
          consumed.push(...applyPostedAllocationUnitCosts(taken.taken))
          remainingQty = taken.remainingQty
          allocationAvailability.set(
            allocation.id,
            reduceSnapshotByCostLayer(
              available,
              taken.taken.map((entry) => ({ costLayerId: entry.costLayerId, qty: entry.qty })),
            ),
          )
        }
        if (remainingQty > 0.0000001) {
          throw new Error(
            `Cannot reverse COGS for refunded line ${lineId} component ${componentProductId}: requested ` +
            `${(qty * factor).toFixed(4)} unit(s) of allocation cost basis but only ` +
            `${(qty * factor - remainingQty).toFixed(4)} available across recorded allocations. ` +
            `This usually means the cost-layer snapshot is stale or was cleared between batch runs.`,
          )
        }
      }
      return consumed
    }

    for (const refundLine of params.refundLines) {
      const refundLineNet = toNetRevenue(refundLine.totalBase)
      if (!refundLine.productId || refundLine.qty <= 0) {
        nonQtyRevenue += refundLineNet
        continue
      }

      const allocation = consumeRefundLineQuantity(
        lineContexts,
        remainingShippedQtyByLine,
        remainingUnshippedQtyByLine,
        refundLine,
      )
      shippedQtyRevenue += allocation.shippedRevenue
      unshippedQtyRevenue += allocation.unshippedRevenue

      const costSnapshot: CostLayerSnapshotEntry[] = []
      for (const lineAllocation of allocation.lineAllocations) {
        // scjz.70: a chargeback keeps SHIPPED COGS as a loss (skip the shipment
        // consume — no COGS reversal, no restock; the customer keeps the goods), and
        // skipping it also avoids "Cannot reverse COGS…" failures on stale shipment
        // snapshots stranding the chargeback in retry (Codex). But UNSHIPPED allocated
        // qty is still in stock — not a loss — so its allocated-inventory contra MUST
        // still be reversed, or the A2 allocation journal stays unreversed while a
        // full refund clears inventoryAllocatedDate (Codex).
        if (lineAllocation.shippedQty > 0 && !params.chargeback) {
          costSnapshot.push(...consumeShipmentCostForLine(lineAllocation.lineId, lineAllocation.shippedQty))
        }
        if (lineAllocation.unshippedQty > 0) {
          costSnapshot.push(...consumeAllocationCostForLine(lineAllocation.lineId, lineAllocation.unshippedQty))
        }
      }
      refundLayerSnapshots.set(refundLine.id, costSnapshot)
      nonQtyRevenue += Math.max(0, refundLineNet - allocation.assignedRevenue)
    }

    const componentTotal = shippedQtyRevenue + unshippedQtyRevenue + nonQtyRevenue
    const roundingDelta = Math.round((refundRevenue - componentTotal) * 100) / 100
    if (roundingDelta > 0) {
      nonQtyRevenue += roundingDelta
    }

    for (const refundLine of params.refundLines) {
      const costSnapshot = refundLayerSnapshots.get(refundLine.id) ?? []
      await tx.salesOrderRefundLine.update({
        where: { id: refundLine.id },
        data: {
          costLayerSnapshot: serializeCostLayerSnapshot(costSnapshot) as never,
        },
      })
    }

    if (params.returnWarehouseId) {
      snapshotReturnRows = params.refundLines.flatMap((refundLine) => (
        (refundLayerSnapshots.get(refundLine.id) ?? []).flatMap((entry) => {
          if (entry.source !== 'shipment') return []
          const productId = productIdByCostLayerId.get(entry.costLayerId)
          if (!productId) return []
          return [{
            productId,
            qty: refundBoundaryNumber(entry.qty),
            refundLineId: refundLine.id,
            unitCostBase: entry.unitCostBase,
            poLineId: poLineIdByCostLayerId.get(entry.costLayerId) ?? null,
            sourceCostLayerId: entry.costLayerId,
          }]
        })
      ))
    }

    const remainingUnearned = Math.round(Math.max(
      0,
      refundBoundaryNumber(params.so.unearnedRevenueAmount) - totalRecognized - priorUnearnedReversed,
    ) * 100) / 100
    // 6oyu.5: shipment-source entries are valued at the ORIGINALLY-POSTED COGS
    // (applyPostedShipmentUnitCosts), so both the COGS reversal below and the
    // returned-stock new inventory layer (snapshotReturnRows, shipment-source only)
    // reverse/re-enter on the posted basis. Any post-dispatch landed-cost
    // revaluation delta therefore stays in COGS for the refunded units.
    const shipmentRefundSnapshot = params.refundLines.flatMap((line) => (
      (refundLayerSnapshots.get(line.id) ?? []).filter((entry) => entry.source === 'shipment')
    ))
    const allocationRefundSnapshot = params.refundLines.flatMap((line) => (
      (refundLayerSnapshots.get(line.id) ?? []).filter((entry) => entry.source === 'allocation')
    ))

    // o3d-o97 — THE ALLOCATED CONTRA THIS REFUND'S LINES DID NOT REACH.
    //
    // Group A2 (DAILY_BATCH_INVENTORY_ALLOC) posted DR Allocated Inventory / CR Inventory for this
    // order's allocated cost. Exactly three things relieve that contra and there is no fourth: a
    // Group B shipment journal (DR COGS / CR Allocated), a refund's allocation reversal (DR
    // Inventory / CR Allocated), and nothing else. Once refundStatus is FULL, BOTH daily-batch
    // windows exclude this order permanently — Group A2 and Group B each filter
    // `refundStatus: { not: 'FULL' }` — so no later run can ever post either side of it again.
    // The un-stage immediately below is therefore the last moment anything in IMS will look at
    // this order's A2 posting.
    //
    // The line-driven reversal (`allocationRefundSnapshot`) only covers allocation cost the refund
    // LINES consumed, but `newStatus` is decided by AMOUNT (isFullRefundAmount), not by line
    // coverage. A monetary-only full refund — the WooCommerce shape carrying no productId and no
    // qty (o3d-w00) — consumes NO allocation cost at all, so today it reaches this un-stage with an
    // empty allocation snapshot: the stamp is cleared, and the whole A2 debit is stranded in
    // Allocated Inventory with nothing left in IMS that knows it is owed. The same happens, in
    // part, to any full-by-amount refund whose lines cover fewer units than the order allocated.
    //
    // WHAT HAS BEEN POSTED IS A RECORD, NOT A QUANTITY RE-DERIVED EACH PASS (o3d-o97 r2, the rule
    // o3d-0i5y round 8 established on the A2 side of the same contra). Round 1 answered "what is
    // still owed?" with `allocationAvailability` — the allocation rows' pinned layers as they stand
    // NOW, netted by whatever snapshots happen to sit on the shipment and refund rows NOW. That is a
    // re-derivation from mutable current state, and it was wrong three separate ways:
    //
    //   * IT REVALUED A HISTORICAL POSTING. A2 debited Allocated Inventory a fixed number of pounds.
    //     Landed-cost revaluation rewrites the pinned layers' unitCostBase in place
    //     (updateSnapshotsForCostLayerChange), and a transfer re-source rewrites which layers are
    //     pinned at all — so a £30 debit was reversed as £12 once the layers behind it fell to £4,
    //     stranding £18, and as £42 when they rose, moving £12 that was never in the account.
    //   * IT READ A PRIOR REFUND'S SNAPSHOT AS PROOF THAT REFUND'S REVERSAL POSTED. A refund line's
    //     costLayerSnapshot is written for EVERY line, unconditionally, in this same transaction,
    //     before any journal decision — and it long outlives the journal's fate. The reversal sync
    //     it belongs to can be CANCELLED as a cross-connector orphan when the active connector is
    //     switched (audit-46ry), or end FAILED against a locked period or an archived account, and
    //     a refund old enough to predate the allocation-reversal journal never had one at all. In
    //     every one of those the snapshot still says the units were relieved. (The one route that
    //     is NOT reachable is staging failing outright: scjz.22 blocks a further refund while a
    //     prior one still has accountingRetryRequired.) The snapshot says which units a refund
    //     CLAIMED; only a live sync log says which pounds it POSTED.
    //   * IT TREATED THE A2 STAMP AS EVIDENCE A2 POSTED. The stamp only says the order passed
    //     through the A2 window. A2 stamps EVERY order it selects, including ones it valued at
    //     zero — the batch journal is raised only when the window's total is positive, and it
    //     names no order individually — so a stamp on its own is consistent with this order having
    //     contributed nothing to any journal. A reversal posted wrongly is as bad as the original,
    //     so this path needs POSITIVE evidence of the original, not the absence of evidence
    //     against it.
    //
    // So all three inputs are RECORDS written BY the postings they stand for — and r3 makes each of
    // them survive the sweep whose entire job is deleting old rows:
    //
    //   posted    `SalesOrder.allocationBatchAmount` — the DR Allocated Inventory A2 wrote for THIS
    //             order, in the same UPDATE as the stamp. It is the same record
    //             `recreateMissingDailyBatchLogs` rebuilds the A2 journal from, so the two paths can
    //             never disagree about what A2 posted, and it is per-ORDER, so it survives
    //             allocation rows being deleted, re-created or re-pinned. r3 adds what the amount
    //             alone never said: WHICH JOURNAL carried it, whether that journal POSTED, and to
    //             WHICH LEDGER AND ACCOUNT (see the block below the narrative).
    //   relieved  every JOURNALED shipment's own `Shipment.allocatedReliefAmount`, written by Group
    //             B in the same UPDATE as `shipmentJournalDate`. r2 derived this from the CogsEntry
    //             dispatch rows instead, calling them immutable — they are, right up until
    //             `retention_stock_movements_months` HARD-DELETES them, after which the derivation
    //             re-values at the CURRENT layer cost or returns zero. It is still the fallback for
    //             shipments journaled before the column existed, and it now REFUSES rather than
    //             returning a number it cannot stand behind.
    //   relieved  every PRIOR refund's own `SalesOrderRefund.allocatedReliefAmount`, written by that
    //             refund when it decided its reversal. Its UNEARNED_REV_REVERSAL sync — r2's only
    //             source — is deleted by `retention_sync_logs_months` once terminal, and a missing
    //             row read as zero relief credits the same pounds twice. The sync is still consulted
    //             for pre-column refunds, and where it says nothing at all this refuses too.
    //
    //   relieved  o3d-0i5y r12 / o3d-xlk7 — every ALLOCATION_REVERSAL raised for this order, for
    //             units ORPHANED off it (re-allocated away, deallocated, edited out, rebalanced)
    //             that will therefore never reach either of the two sources above. This source did
    //             not exist when the list was written and an allocation reversal is NEITHER of the
    //             other two, so omitting it credited the same units a second time on the residue.
    //             Proved from those journals' own lines, netted; recorded durably on
    //             `SalesOrder.allocationReversalAmount` because retention hard-deletes the journals.
    //
    // The open balance is the arithmetic on those records — posted, less relieved — and it both
    // CAPS what this refund's lines may reverse and, on a full refund, supplies the residue no line
    // reached. No layer cost is consulted, so nothing downstream of A2 can revalue it.
    //
    // NOT a fix for the other un-stage sites — and o3d-0i5y r12 now IS, which is worth saying here
    // because this paragraph used to describe the gap as open. `resetAllocationAccountingIfStaged`
    // and `releaseOverallocations` un-stage an order that is NOT refunded; o3d-o97 r4 stopped them
    // nulling `allocationBatchAmount` where the debit stands, and o3d-batch-shiporder added the
    // sync type this note said was missing (`ALLOCATION_REVERSAL`) so those sites credit the
    // orphaned units instead of stranding them. What that costs is the netting above: a reversal is
    // relief, and relief this arithmetic cannot see is a debit reversed twice.

    // Read BEFORE the update at the bottom of this block clears the stamp. Read on EVERY refund,
    // not only a full one: the open balance it yields is what caps a PARTIAL line-driven reversal.
    const stagedA2 = await tx.salesOrder.findUnique({
      where: { id: params.orderId },
      select: {
        inventoryAllocatedDate: true,
        allocationBatchAmount: true,
        allocationBatchSyncLogId: true,
        allocationBatchConnector: true,
        allocationBatchAccountCode: true,
      },
    })
    // NULL and ZERO are different facts and must not collapse into one. A recorded £0 is A2
    // saying it valued this order at nothing — a KNOWN debit of zero, nothing to reverse and
    // nothing to refuse over. A NULL is A2 having recorded no figure at all.
    const hasRecordedAllocationAmount = stagedA2?.allocationBatchAmount != null
    const postedAllocationDebit = refundBoundaryNumber(stagedA2?.allocationBatchAmount ?? 0)

    // o3d-o97 r3 — WHAT THE A2 AMOUNT PROVES, AND ABOUT WHICH LEDGER.
    //
    // r2 argued the amount is positive evidence A2 posted, because it is written in the SAME
    // UPDATE as the stamp. That establishes only that the A2 PASS RAN and valued this order. It
    // does not establish that a journal was created, that the journal reached a ledger, or WHICH
    // ledger — and the residue below credits an account off the back of all three:
    //
    //   no journal      the batch log is created only when the window's ROUNDED total is positive
    //                   (`totalAllocatedValueNumber > 0`), while the per-order amount is written
    //                   unconditionally. A window whose only member values at £0.004 stamps an
    //                   amount and raises nothing.
    //   never posted    the log is created PENDING inside the batch transaction. Everything after
    //                   that — the remote call — is a different transaction that can end FAILED,
    //                   or CANCELLED as a cross-connector orphan when the connector is switched.
    //   another ledger  the reversal is raised on the connector active NOW, against the Allocated
    //                   Inventory account configured NOW. A2 may have debited a different ledger,
    //                   or a different account in the same one.
    //
    // A2 now records all three with the amount: the sync log's OWN ID (a value that cannot exist
    // unless `createPendingSyncLog` created the row — see o3d-batch-billpay: a stamp nothing minted
    // can be trusted by nobody), the CONNECTOR, and the ACCOUNT CODE it debited (o3d-batch-realm: a
    // record must name which ledger it was raised against). The id is resolved back to the row to
    // read its status, so "queued" is not read as "posted".
    //
    // Rows staged BEFORE those columns existed carry null and keep the older amount-implies-posting
    // inference, unchanged. Nothing can retroactively prove a 2025 batch posted; what is available
    // is that every batch from here on says so itself.
    let allocationBasisUnresolved: string | null = null
    let openAllocatedContra: number | null = null
    if (stagedA2?.inventoryAllocatedDate && !hasRecordedAllocationAmount) {
      allocationBasisUnresolved = 'the order carries an A2 stamp with no recorded allocation amount, so the pounds A2 debited to Allocated Inventory are not on record and cannot be reversed automatically'
    } else if (stagedA2?.inventoryAllocatedDate && postedAllocationDebit > 0 && stagedA2.allocationBatchSyncLogId) {
      const recordedConnector = stagedA2.allocationBatchConnector
      const recordedAccount = stagedA2.allocationBatchAccountCode
      const a2Journal = await tx.accountingSyncLog.findUnique({
        where: { id: stagedA2.allocationBatchSyncLogId },
        select: { status: true, connector: true, payload: true },
      })
      if (params.activeConnector && recordedConnector && recordedConnector !== params.activeConnector) {
        allocationBasisUnresolved = `A2 debited Allocated Inventory on ${recordedConnector}, but this reversal would be raised on ${params.activeConnector} — crediting it there would leave the ${recordedConnector} debit standing and move pounds a ${params.activeConnector} ledger never held`
      } else if (recordedAccount && recordedAccount !== settings.allocatedInventoryAccount) {
        allocationBasisUnresolved = `A2 debited account ${recordedAccount}, but Allocated Inventory is configured as ${settings.allocatedInventoryAccount} today — the reversal would credit an account that was never debited for this order`
      } else if (!a2Journal) {
        allocationBasisUnresolved = 'the A2 journal this order was staged into is no longer on record (retention), so whether it reached the ledger cannot be established'
      } else if (params.activeConnector && a2Journal.connector && a2Journal.connector !== params.activeConnector) {
        // o3d-o97 r5: the ROW's connector, not only the stamp beside the amount. The stamp is
        // written by the batch in the same statement as the figure; the row is the ledger's own
        // record of which books it was raised into, and they are two different assertions.
        allocationBasisUnresolved = `the A2 journal this order was staged into was raised on ${a2Journal.connector}, but this reversal would be raised on ${params.activeConnector} — a credit there would move pounds that ledger never held`
      } else if (a2Journal.status !== 'SYNCED') {
        allocationBasisUnresolved = `the A2 journal this order was staged into is ${a2Journal.status}, not SYNCED — nothing has been debited to Allocated Inventory for this order to reverse`
      } else {
        // o3d-o97 r5 — AND SYNCED IS STILL NOT A STATEMENT ABOUT POUNDS. The batch journal covers a
        // whole day, so its DR to Allocated Inventory is the window's total and this order's
        // recorded share must fit inside it. A journal that debits that account NOTHING, or less
        // than this one order claims, cannot be what put `postedAllocationDebit` there — and the
        // residue would otherwise credit an account off a figure the journal contradicts.
        //
        // An ILLEGIBLE payload (compacted off a settled row) is not a contradiction: it is the
        // recorded three-part attribution being the only evidence left, which is the state every
        // pre-column order is in already, so it falls through to the recorded figure.
        const proof = proveJournalPosting([a2Journal], settings.allocatedInventoryAccount, 'debit')
        if (proof.kind === 'proved' && proof.amount <= 0) {
          allocationBasisUnresolved = `the A2 journal this order was staged into has settled, but its lines debit nothing to Allocated Inventory (${settings.allocatedInventoryAccount}) — the £${postedAllocationDebit.toFixed(2)} recorded against this order is contradicted by the journal that was to carry it`
        } else if (proof.kind === 'proved' && postedAllocationDebit > proof.amount + 0.005) {
          allocationBasisUnresolved = `this order records a £${postedAllocationDebit.toFixed(2)} share of an A2 journal that debited Allocated Inventory only £${proof.amount.toFixed(2)} in total — a share cannot exceed its batch, so the pounds standing against this order cannot be established`
        }
      }
    }
    if (!allocationBasisUnresolved) {
      // o3d-0i5y r12: the reversal relief refuses on the same terms as the other two. It is last
      // only because it is the newest source; the order of the three carries no meaning beyond
      // which reason an operator is shown first.
      allocationBasisUnresolved = groupBReliefUnresolved ?? priorRefundReliefUnresolved ?? allocationReversalReliefUnresolved
    }
    // o3d-o97 r6: the apportionment prices only SOME of the pool's unrecorded units and this refund
    // is PARTIAL, so neither of the two things that make the blend safe applies — the cap only bites
    // above the open balance and the residue only runs on a full refund, and a strict subset of a
    // pool whose internal rates are unknown is a guess whichever products it spans. See the worked
    // example beside `unrecordedRowUnitCost`.
    const apportionmentIsInexact = unrecordedRowUnitCost > 0
      && unrecordedRowCount > 1
      && unrecordedQtyRefunded < unrecordedRowQtyTotal - 0.0000001
    if (!allocationBasisUnresolved && allocationRowBasisMissing && apportionmentIsInexact && params.newStatus !== 'REFUNDED') {
      allocationBasisUnresolved = `some refunded units came from allocation rows carrying no posted A2 basis of their own, and this refund reverses ${unrecordedQtyRefunded} of the ${unrecordedRowQtyTotal} such unit(s) spread across ${unrecordedRowCount} separately-valued allocation rows (${unrecordedRowProductIds.size} product(s)) that share this order's remaining A2 debit of £${residualDebitForUnrecordedRows.toFixed(2)} — apportioning that debit by unit prices them at a blended rate A2 applied to no row, and a partial refund has neither the open-balance cap nor the full refund's residue to correct it`
    }
    if (stagedA2?.inventoryAllocatedDate && hasRecordedAllocationAmount && !allocationBasisUnresolved) {
      // THE LEDGER BALANCE: what A2 debited, less every relief already credited against it. This
      // is a per-order figure derived from records the postings wrote — not a pool of entries
      // netted to choose units, which is the sibling's rule and would be the wrong shape here.
      // o3d-0i5y r12 / o3d-xlk7: THREE relief sources now, not two — Group B for what dispatched,
      // earlier refunds for what they took back, and ALLOCATION_REVERSAL for what was ORPHANED off
      // the order and will never reach either of the first two. Omitting the third is what credited
      // the same units twice on a cancelled-then-refunded order.
      const relieved = addMoney(
        addMoney(postedGroupBAllocationRelief, toDecimal(priorRefundAllocationRelief)),
        toDecimal(allocationReversalRelief),
      )
      const open = subtractMoney(toDecimal(postedAllocationDebit), relieved)
      openAllocatedContra = open.gt(0) ? roundQuantity(open, 2).toNumber() : 0
    }

    // o3d-o97 r3 — THE DEBIT CAP. The line-driven reversal reverses whatever the refund's lines
    // consumed; nothing bounded it by what the account actually holds. Even at the posted basis a
    // partial refund can exceed it — units re-pinned after A2, a kit re-composed, a row created by
    // the rebalancer with no posted amount of its own. The reversal can never credit more than is
    // open, so it is clamped here; on a FULL refund the residue below then tops it back up to
    // exactly the open balance, which is the whole point of the residue.
    // Kept in Decimal until the single 2dp round below, so the capped line value and the residue
    // cannot each shed half a penny (o3d-o97 r2).
    //
    // o3d-o97 r4 — AND A REFUSAL MUST NOT LET *MORE* OUT THAN AN ACCEPTANCE DOES. `openAllocatedContra`
    // is computed only when the basis resolved, and it is the cap — so under r3 a refusal did not
    // withhold the line reversal at all, it removed its ceiling and sent the whole uncapped figure.
    // The refusal now means what it says: nothing is credited to an account whose open balance this
    // refund could not establish. The residue below is already null-guarded, so the two agree.
    const lineAllocationBasis = sumCostLayerSnapshot(allocationRefundSnapshot)
    const cappedLineBasis = allocationBasisUnresolved != null
      ? toDecimal(0)
      : openAllocatedContra != null && lineAllocationBasis.gt(toDecimal(openAllocatedContra))
        ? toDecimal(openAllocatedContra)
        : lineAllocationBasis
    const lineAllocationReversal = roundQuantity(lineAllocationBasis, 2).toNumber()
    const cappedLineAllocationReversal = roundQuantity(cappedLineBasis, 2).toNumber()
    // A full refund closes BOTH batch windows for ever (`refundStatus: { not: 'FULL' }` on Group A2
    // and Group B), so this is the last moment anything will look at the order's A2 posting: the
    // part of the open balance no line reached has to come out now or never.
    const residualAllocationBasis = params.newStatus === 'REFUNDED' && openAllocatedContra != null
      ? subtractMoney(toDecimal(openAllocatedContra), cappedLineBasis)
      : toDecimal(0)
    const allocationReversal = roundQuantity(
      addMoney(cappedLineBasis, residualAllocationBasis.gt(0) ? residualAllocationBasis : toDecimal(0)),
      2,
    ).toNumber()

    // o3d-o97 r3 — THE REMEDY, and why it has to be this one.
    //
    // r2 refused on a null amount and named the remedy as the standing accounting invariant
    // `sales_order_inventory_allocation_missing_amount`, which reports every STAMPED order with no
    // allocation amount. The very next statement nulled `inventoryAllocatedDate` — so the refusal
    // destroyed its own remedy: the invariant reads `hasA2 = !!order.inventoryAllocatedDate`, and
    // from that update onwards the order was not stamped, would never be reported again, and the
    // stranded debit had nothing anywhere pointing at it.
    //
    // So the un-stage is now CONDITIONAL. If this refund could not account for the A2 debit, the
    // A2 stamp and its attribution SURVIVE — the standing invariants keep reporting the order,
    // exactly as claimed — and the reason is recorded on the refund row, which outlives every
    // stamp on the order. Keeping the stamp is inert for the batches: Group A2 selects only
    // `inventoryAllocatedDate: null`, and both groups exclude `refundStatus: FULL`, so a
    // fully-refunded order is out of both windows whatever its stamp says.
    // o3d-o97 r6: a REFUSAL is not a cap. Under r5 both were reported for the same refund, because a
    // refusal zeroes `cappedLineBasis` and so trivially "bit into" the line value — and the cap's
    // sentence then printed `openAllocatedContra ?? 0`, telling an operator the balance was £0.00
    // when the truth is that it could not be established at all. Two contradictory explanations of
    // the same withheld pounds, one of them a fabricated figure. The cap now speaks only where the
    // basis RESOLVED and the ceiling genuinely bound the reversal.
    const capBitInto = allocationBasisUnresolved == null
      && cappedLineAllocationReversal < lineAllocationReversal - 0.005
    // Recorded only when the refusal COST something: a full refund is the last chance to take the
    // residue out, so an unresolved basis there strands pounds and must be reported. On a partial
    // the order stays inside both batch windows and no residue was owed yet, so an unresolved
    // basis withheld nothing — flagging it would be noise, and the full refund that follows will
    // raise it for real.
    // o3d-o97 r4: a line whose allocation row carries no posted basis reverses ZERO for those units
    // (see applyPostedAllocationUnitCosts). On a partial that is a deliberate under-reversal the
    // full refund's residue closes out, but it is still a figure an operator may be reconciling
    // against, so it is named whenever it happened.
    //
    // o3d-o97 r5 — AND A REFUSAL ON A *PARTIAL* NOW COUNTS AS COSTING SOMETHING WHEN IT DID. r4's
    // "on a partial nothing was withheld" argument was true only while a refusal left the cap off
    // and let the whole uncapped figure out; the same round made a refusal WITHHOLD the line
    // reversal, so a partial refund whose lines valued real allocated basis and then credited none
    // of it has withheld exactly that much — and said nothing, on the row the invariant report
    // reads. That is the "refusal an operator cannot see" defect for the third time in this area,
    // so the test is now what the refusal COST rather than which status the refund reached: a full
    // refund always (the residue is owed and lost), a partial only when a non-zero line reversal was
    // actually withheld, which keeps a monetary-only partial from generating noise.
    //
    // o3d-o97 r6 — AND AN ASSUMPTION COUNTS AS COSTING SOMETHING TOO, because it is subtracted from
    // the open balance. Relief counted from a record whose journal retention has deleted (or
    // compacted) SHRINKS what this refund credits, by exactly those pounds, on evidence nobody can
    // read. Silently, that is how a refusal standing yesterday becomes a resolution today: the
    // cancelled journal is deleted, the record resolves, the invariant stops reporting the order and
    // the under-reversal is permanent on a FULL refund. So it is reported whenever it moved money.
    const refusalWithheldLineReversal = allocationBasisUnresolved != null && lineAllocationReversal > 0.005
    const assumedReliefCounted = assumedReliefTotal > 0.005 && assumedReliefNotes.length > 0
    const withheldSomething = (allocationBasisUnresolved != null && params.newStatus === 'REFUNDED')
      || refusalWithheldLineReversal
      || capBitInto
      || assumedReliefCounted
      || (allocationRowBasisMissing && params.newStatus === 'REFUNDED')
    const unresolvedNote = withheldSomething
      ? [
          allocationBasisUnresolved,
          // The pounds this refund did NOT credit because a relief it could not read was counted
          // against the debit. Listed per record, so an operator knows which journal to go and find.
          assumedReliefCounted
            ? `£${assumedReliefTotal.toFixed(2)} of Allocated Inventory relief was counted against this order's A2 debit WITHOUT the journal that was to carry it being legible, so the open balance may be overstated as relieved by up to that much: ${assumedReliefNotes.join('; ')}`
            : null,
          capBitInto
            ? `the refund's own lines valued £${lineAllocationReversal.toFixed(2)} of allocated basis against an open balance of £${(openAllocatedContra ?? 0).toFixed(2)} and were capped to it`
            : null,
          // o3d-o97 r5: what the refusal actually cost, in pounds, on the row an operator reads.
          refusalWithheldLineReversal
            ? `the refund's own lines valued £${lineAllocationReversal.toFixed(2)} of allocated basis and NONE of it was credited, because the pounds still open on the account could not be established`
            : null,
          // Only where the apportioned rate was actually used to value a credit — under a refusal
          // nothing was credited at all, and saying "valued by apportioning" there would describe a
          // posting that did not happen.
          allocationRowBasisMissing && allocationBasisUnresolved == null
            ? 'some refunded units came from allocation rows carrying no posted A2 basis of their own (re-pinned after the order was staged, or staged before the per-row basis was recorded), so they were valued by apportioning the order\'s recorded debit rather than from any posted figure of their own'
            : null,
          `Recorded A2 debit £${postedAllocationDebit.toFixed(2)}; this refund credited Allocated Inventory £${allocationReversal.toFixed(2)}.`,
        ].filter((part): part is string => !!part).join('. ')
      : null

    // o3d-o97 r3: written on EVERY pass, so a retry that now resolves clears a stale refusal.
    //  * `allocatedReliefAmount` — THIS REFUND'S OWN RELIEF, recorded inside the same transaction
    //    that decides it, so a later refund on this order can subtract it without depending on a
    //    sync log retention will delete. It records what the journal this refund is about to queue
    //    WILL RAISE — which is why a later refund resolves it against that journal's status before
    //    subtracting it (o3d-o97 r4) rather than treating the figure as money already moved.
    //  * `allocationBasisUnresolved` — the refusal, on a row that outlives every stamp on the
    //    order, naming which record was missing and how many pounds are still sitting in the
    //    account. Surfaced by `sales_order_refund_allocation_basis_unresolved` in the accounting
    //    invariants.
    await tx.salesOrderRefund.update({
      where: { id: params.refundId },
      data: {
        allocatedReliefAmount: allocationReversal,
        allocationBasisUnresolved: unresolvedNote,
      },
    })

    if (params.newStatus === 'REFUNDED') {
      // o3d-0qoo: each batch ref is cleared IN THE SAME UPDATE as the stamp it pairs with. A row
      // left holding a ref with no stamp would make the delete guard match a batch the row is no
      // longer part of, and block that order forever. The A1 ref is still discarded with nothing
      // checking that the deferral reversal below covers what A1 posted.
      await tx.salesOrder.update({
        where: { id: params.orderId },
        data: {
          revenueDeferredDate: null,
          revenueDeferredBatchRef: null,
          ...(allocationBasisUnresolved ? {} : {
            inventoryAllocatedDate: null,
            inventoryAllocatedBatchRef: null,
            allocationBatchSyncLogId: null,
            allocationBatchConnector: null,
            allocationBatchAccountCode: null,
          }),
        },
      })
    }

    return {
      cogsReversal: roundQuantity(sumCostLayerSnapshot(shipmentRefundSnapshot), 2).toNumber(),
      // khdw: pre-round 6dp basis behind the COGS reversal, captured so the daily-batch
      // COGS reconciliation has an independent subledger source (the GL gets the 2dp
      // value above; the 6dp-vs-2dp residue is what the reconciliation sweeps).
      cogsReversalBase: roundQuantity(sumCostLayerSnapshot(shipmentRefundSnapshot), 6).toNumber(),
      unearnedReversal: Math.min(
        remainingUnearned,
        Math.round((unshippedQtyRevenue + nonQtyRevenue) * 100) / 100,
      ),
      // o3d-o97: the lines' own allocation cost, capped by the open balance, PLUS — on a full
      // refund — the part of that balance no line reached. On a resolved full refund the two sum
      // to exactly the open balance.
      allocationReversal,
    }
  })

  // scjz.70: a chargeback is a revenue-only unwind — the credit note reverses
  // recognised revenue against AR, but COGS is intentionally KEPT (booked as a
  // loss), so suppress the COGS reversal. Restock is suppressed separately in
  // createSalesOrderRefund (the goods are not returned in a chargeback).
  // khdw: capture the COGS reversal's GL posting date once so it both drives the
  // journal payload and is persisted on the refund for the daily-batch reconciliation.
  if (reversalAmounts.cogsReversal > 0 && !params.chargeback) {
    const cogsReversalJournalDate = new Date().toISOString().slice(0, 10)
    accountingSyncs.push({
      type: 'COGS_REVERSAL',
      referenceType: 'SalesOrderRefund',
      referenceId: params.refundId,
      idempotencyKey: `sales-order-refund:${params.refundId}:cogs-reversal`,
      payload: {
        date: cogsReversalJournalDate,
        reference: `COGS reversal: ${params.orderRef}`,
        narration: `COGS reversal — refund on order ${params.orderRef}`,
        // bcz9.4: carry the 6dp cost-layer base so the subledger row, recorded at
        // queue time (queueRefundAccountingActions) atomically with the COGS_REVERSAL
        // sync, preserves the residue the GL's 2dp posting drops — without re-deriving
        // it from the journal's 2dp credit lines. Ignored by the connectors (like the
        // other private `_`-prefixed payload fields).
        _cogsReversalBase: reversalAmounts.cogsReversalBase,
        lines: [
          { accountCode: settings.inventoryAccount, description: `COGS reversal: ${params.orderRef}`, debit: reversalAmounts.cogsReversal },
          { accountCode: settings.cogsAccount, description: `COGS reversal: ${params.orderRef}`, credit: reversalAmounts.cogsReversal },
        ],
      },
    })
  }

  const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []
  if (reversalAmounts.unearnedReversal > 0) {
    journalLines.push(
      { accountCode: settings.unearnedRevenueAccount, description: `Unearned revenue reversal: ${params.orderRef}`, debit: reversalAmounts.unearnedReversal },
      { accountCode: settings.salesAccount, description: `Unearned revenue reversal: ${params.orderRef}`, credit: reversalAmounts.unearnedReversal },
    )
  }
  if (reversalAmounts.allocationReversal > 0) {
    journalLines.push(
      { accountCode: settings.inventoryAccount, description: `Allocation reversal: ${params.orderRef}`, debit: reversalAmounts.allocationReversal },
      { accountCode: settings.allocatedInventoryAccount, description: `Allocation reversal: ${params.orderRef}`, credit: reversalAmounts.allocationReversal },
    )
  }

  if (journalLines.length > 0) {
    // o3d-o97: this journal now has an ALLOCATION-ONLY shape. It is reached when a full refund
    // un-stages A2 on an order whose deferral is already fully recognised (remainingUnearned 0)
    // but whose allocation pin is not fully relieved — allocate 3, ship and journal 2, refund in
    // full. Naming it "Unearned revenue + allocation reversal" would describe a debit to the
    // unearned account that this journal does not contain, so the label follows the lines.
    const hasInventoryReversal = reversalAmounts.allocationReversal > 0
    const hasUnearnedReversal = reversalAmounts.unearnedReversal > 0
    const subject = hasUnearnedReversal && hasInventoryReversal
      ? 'Unearned revenue + allocation reversal'
      : hasUnearnedReversal
        ? 'Unearned revenue reversal'
        : 'Allocation reversal'
    accountingSyncs.push({
      type: 'UNEARNED_REV_REVERSAL',
      referenceType: 'SalesOrderRefund',
      referenceId: params.refundId,
      idempotencyKey: `sales-order-refund:${params.refundId}:unearned-reversal`,
      payload: {
        date: new Date().toISOString().slice(0, 10),
        reference: hasUnearnedReversal
          ? `Unearned reversal: ${params.orderRef}`
          : `Allocation reversal: ${params.orderRef}`,
        narration: `${subject} — refund on order ${params.orderRef}`,
        lines: journalLines,
      },
    })
  }

  return { accountingSyncs, snapshotReturnRows }
}

/**
 * bcz9.4: resolve the COGS-reversal base (for the subledger ledger) from a
 * COGS_REVERSAL sync payload. Prefers the structured 6dp `_cogsReversalBase`
 * embedded at staging; falls back to summing the journal's 2dp credit lines for
 * reversals persisted before that field existed. Returns null when no positive
 * base is present (nothing to record).
 */
export function resolveRefundCogsReversalBase(payload: unknown): number | null {
  if (!isRecord(payload)) return null
  const structured = payload._cogsReversalBase
  if (typeof structured === 'number' && Number.isFinite(structured) && structured > 0) return structured
  const lines = Array.isArray(payload.lines) ? payload.lines : null
  if (!lines) return null
  // The COGS_REVERSAL journal credits the COGS account (debits inventory); that
  // credit is the reversal amount, so the net COGS movement is its negation.
  let credit = 0
  for (const line of lines) {
    if (isRecord(line) && typeof line.credit === 'number' && Number.isFinite(line.credit)) credit += line.credit
  }
  return credit > 0 ? credit : null
}

/**
 * bcz9.4: record the refund's COGS reversal into the cogs_subledger_movements ledger
 * (negative: a refund credits/decreases COGS) ATOMICALLY with queuing the
 * COGS_REVERSAL sync — call this from queueRefundAccountingActions inside the same
 * db.$transaction that queues the journal. Recording at queue time (not at refund
 * staging) guarantees the negative ledger row exists only once the GL reversal is
 * durably queued, so the daily-batch COGS reconciliation can't sweep a not-yet-queued
 * reversal as rounding and then double-count it when a retry posts the real journal
 * (Codex PR #353 F5). Idempotent on the sync's key, so initial + retry record exactly
 * once. No-op when the journal won't post, for a non-COGS_REVERSAL sync, or when the
 * payload carries no positive base / date.
 */
export async function recordRefundCogsReversalFromSync(
  client: RefundServiceClient,
  sync: RefundAccountingSyncRequest,
  cogsReversalSyncEnabled: boolean,
): Promise<void> {
  if (sync.type !== 'COGS_REVERSAL' || !cogsReversalSyncEnabled) return
  if (!isRecord(sync.payload)) return
  const date = typeof sync.payload.date === 'string' ? sync.payload.date : null
  const base = resolveRefundCogsReversalBase(sync.payload)
  if (!date || base === null) return
  await recordCogsSubledgerMovement(client, {
    sourceType: 'REFUND_REVERSAL',
    sourceRef: sync.referenceId,
    idempotencyKey: sync.idempotencyKey ?? `sales-order-refund:${sync.referenceId}:cogs-reversal`,
    baseDelta: -base,
    journalDate: date,
  })
}

function formatRefundAccountingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function accountingWarningMessage(error: unknown): string {
  return `Refund was created, but accounting reversal staging failed: ${formatRefundAccountingError(error)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRefundAccountingRetrySyncs(
  value: Prisma.JsonValue | null | undefined,
): RefundAccountingSyncRequest[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.payload)) return []
    if (
      typeof entry.type !== 'string' ||
      typeof entry.referenceType !== 'string' ||
      typeof entry.referenceId !== 'string'
    ) {
      return []
    }
    return [{
      type: entry.type as AccountingSyncType,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      payload: entry.payload,
      idempotencyKey: typeof entry.idempotencyKey === 'string' ? entry.idempotencyKey : undefined,
    }]
  })
}

function refundAccountingSyncsJson(
  syncs: RefundAccountingSyncRequest[],
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (syncs.length === 0) return Prisma.DbNull
  return JSON.parse(JSON.stringify(syncs)) as Prisma.InputJsonValue
}

/**
 * scjz.71: did the refund stage a COGS/unearned reversal? The UNEARNED_REV_REVERSAL
 * sync also carries the allocation reversal, so these two types cover every
 * reversal a refund posts. Persisted on the refund (`reversalStaged`) so the
 * accounting evidence checks can distinguish a credit-note-only chargeback from one
 * that still owes reversal evidence.
 */
function stagedAReversal(syncs: RefundAccountingSyncRequest[]): boolean {
  return syncs.some((sync) => sync.type === 'COGS_REVERSAL' || sync.type === 'UNEARNED_REV_REVERSAL')
}

export async function createSalesOrderRefund(
  client: RefundServiceClient,
  input: {
    orderId: string
    lines: RefundRequestLine[]
    reason: string
    returnWarehouseId?: string
    externalRefundId?: number
    creditNotePrefix: string
    accountingSettings?: AccountingSettings | null
    /**
     * scjz.70: revenue-only chargeback. The credit note still reverses recognised
     * revenue against AR, but COGS reversal and inventory restock are suppressed —
     * the customer keeps the goods and the cost is booked as a loss. Used by the
     * payment-poller when a payment reversal (chargeback) is detected.
     */
    chargeback?: boolean
    /** Active accounting connector (scopes the prior-reversal guard); resolved by the caller. */
    activeAccountingConnector?: 'xero' | 'quickbooks'
  },
): Promise<CreateSalesOrderRefundResult> {
  // Keep discount lines (negative totalBase, qty 0) which the qty>0/totalBase>0 filter
  // would otherwise drop — a chargeback mirrors the invoice's order-discount line.
  const refundLines = input.lines.filter((line) => line.qty > 0 || line.totalBase > 0 || line.lineKind === 'discount')
  if (!refundLines.length) return { success: false, error: 'Select at least one line to refund' }

  // scjz.70: a chargeback never restocks (customer keeps the goods), so neutralise
  // the return warehouse entirely — this skips the pre-shipment return guard, the
  // fallback return-row build, the snapshot return rows AND the inbound movement, so
  // a chargeback can't fail on a restock path even if a warehouse was supplied (Codex).
  const effectiveReturnWarehouseId = input.chargeback ? undefined : input.returnWarehouseId

  const totalBase = refundLines.reduce((sum, line) => sum + line.totalBase, 0)
  const txResult = await runInTransaction(client, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_ACCOUNTING_LOCK_KEY})`
    // o3d-ee9: serialize this refund CREATE against the park CREATE for the SAME external refund id
    // (upsertRefundPark takes the same per-refund advisory lock). The global lock above + the order row lock
    // below do NOT cover the cross-order case — a refund committing on order A while a park commits on order B
    // take different order locks and would not conflict, leaving a refund on A and a stale actionable park on
    // B. This per-refund key closes that window; held until commit, so the park path re-reads the committed
    // refund. Taken BEFORE the order row lock, matching upsertRefundPark's order, so the two cannot deadlock.
    if (input.externalRefundId != null) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wc_refund:${input.externalRefundId}`}))`

      // o3d-ee9 (park-first ordering): under the per-refund lock, refuse to create a refund whose external id
      // is already parked as an actionable WooCommerce refund for a DIFFERENT order. Otherwise order B could
      // win the lock, write its park, and commit; then order A creates its refund here without noticing —
      // leaving order A's refund AND order B's stale actionable park (which blocks B's deletion/rebind and
      // shows a phantom exception). A WC refund id maps to one order, so a foreign park is a genuine anomaly:
      // fail closed and surface it rather than silently create contradictory state. (Same-order actionable
      // parks are resolved atomically after the refund row is created, below.)
      const foreignPark = await tx.shoppingSyncLog.findFirst({
        where: {
          connector: 'woocommerce',
          direction: 'FROM_CONNECTOR',
          entityType: 'SalesOrder',
          externalId: String(input.externalRefundId),
          entityId: { not: input.orderId }, // Prisma `not` also excludes NULL, so this is "another order".
          status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
        },
        select: { entityId: true },
      })
      if (foreignPark) {
        throw new Error(`WooCommerce refund ${input.externalRefundId} is already parked for a different order (${foreignPark.entityId}); refusing to create it here.`)
      }
    }
    await lockSalesOrder(tx, input.orderId)

    const so = await tx.salesOrder.findUnique({
      where: { id: input.orderId },
      select: {
        id: true,
        externalOrderNumber: true,
        orderNumber: true,
        status: true,
        refundStatus: true,
        fxRateToBase: true,
        totalBase: true,
        taxBase: true,
        taxRatePercent: true,
        pricesIncludeVat: true,
        revenueDeferredDate: true,
        unearnedRevenueAmount: true,
        inventoryAllocatedDate: true,
        allocationBatchAmount: true,
        // taxRateName -> the order-default tax type; per-line taxRate -> each line's own identity. Both
        // are needed to snapshot the SAME tax type the invoice resolved, at creation time (o3d-w00).
        taxRateName: true,
        lines: {
          select: {
            id: true,
            productId: true,
            qty: true,
            taxRate: { select: { accountingTaxType: true, reverseCharge: true } },
          },
        },
        shipments: {
          where: { status: 'SHIPPED' },
          select: { id: true },
        },
      },
    })
    if (!so) return { error: 'Order not found' } as const

    const fxRate = refundBoundaryNumber(so.fxRateToBase) || 1

    // Snapshot each refund line's VAT identity at creation, resolved EXACTLY as the invoice did
    // (o3d-w00). Store the resolved connector tax type so the credit note posts under the rate that was
    // actually validated, instead of re-predicting it from the order default at post time — which
    // mis-taxed deactivated-rate, reverse-charged and mixed-rate refunds.
    const orderDefaultTaxType = so.taxRateName
      ? (await tx.taxRate.findFirst({
          where: { name: so.taxRateName, active: true },
          select: { accountingTaxType: true },
        }))?.accountingTaxType ?? null
      : null
    const salesLineTaxById = new Map(so.lines.map((line) => [line.id, line.taxRate]))
    const reverseChargeSalesTaxType = input.accountingSettings?.reverseChargeSalesTaxType

    // Order tax uniformity, resolved from the LINES via the relation (active-independent, so a rate
    // deactivated after the sale still counts) — o3d-w00 #5. The order is uniformly taxed when every line
    // shares one non-null connector tax type and none is reverse-charged. Only then can a monetary-only
    // (unlinked, un-attributable) SALE amount be posted under a single identity without mis-allocating.
    const orderBaseTaxTypes = new Set(so.lines.map((line) => line.taxRate?.accountingTaxType ?? null))
    const orderHasReverseCharge = so.lines.some((line) => line.taxRate?.reverseCharge)
    const orderUniformlyTaxed = orderBaseTaxTypes.size === 1 && !orderBaseTaxTypes.has(null) && !orderHasReverseCharge
    const orderSingleSafeTaxType = orderUniformlyTaxed ? ([...orderBaseTaxTypes][0] as string) : null

    const resolveRefundLineTaxIdentity = (
      lineId: string | null | undefined,
      lineKind: 'sale' | 'shipping' | 'discount',
    ) => {
      // A line-linked refund carries its OWN rate (read via the relation, so a rate deactivated after the
      // sale still resolves).
      const linked = lineId ? salesLineTaxById.get(lineId) : undefined
      if (linked) {
        return {
          accountingTaxType: resolveSalesLineTaxType({
            baseTaxType: linked.accountingTaxType ?? orderDefaultTaxType,
            reverseCharge: linked.reverseCharge,
            reverseChargeSalesTaxType,
          }) ?? null,
          reverseCharge: linked.reverseCharge ?? null,
        }
      }
      // Unlinked. A monetary-only SALE line uses the order's single safe identity — guaranteed present,
      // since a non-uniform order with such a line is REFUSED below (o3d-w00 #2/#5). Shipping/discount
      // lines keep the order-default treatment, consistent with how the invoice posts them (even on a
      // mixed-rate order the invoice posts shipping under the order default), so they are not gated.
      if (lineKind === 'sale') {
        return { accountingTaxType: orderSingleSafeTaxType, reverseCharge: false }
      }
      return { accountingTaxType: orderDefaultTaxType, reverseCharge: null }
    }

    // External refund deliveries provide a stable replay key. Manual refunds
    // intentionally rely on the operator UI's double-submit guard instead of
    // inventing a synthetic service-level idempotency key.
    if (input.externalRefundId != null) {
      const existingExternalRefund = await tx.salesOrderRefund.findFirst({
        where: {
          orderId: input.orderId,
          externalRefundId: input.externalRefundId,
        },
        select: {
          id: true,
          creditNoteNumber: true,
          totalBase: true,
          lines: {
            select: {
              id: true,
              salesOrderLineId: true,
              productId: true,
              description: true,
              qty: true,
              unitPriceForeign: true,
              unitPriceBase: true,
              totalForeign: true,
              totalBase: true,
              // The persisted kind + tax snapshot (o3d-w00 #4) so a duplicate external delivery replays
              // the SAME posting the first attempt did, not a re-inferred one.
              lineKind: true,
              accountingTaxType: true,
              reverseCharge: true,
            },
          },
        },
      })
      if (existingExternalRefund) {
        return {
          replay: true as const,
          so,
          fxRate,
          replayTotalBase: refundBoundaryNumber(existingExternalRefund.totalBase),
          createdRefund: { id: existingExternalRefund.id },
          createdRefundLines: existingExternalRefund.lines.map(reconstructReplayLine),
          creditNoteNumber: existingExternalRefund.creditNoteNumber ?? '',
          newStatus: so.refundStatus === 'FULL' ? 'REFUNDED' as const : 'PARTIALLY_REFUNDED' as const,
        }
      }
    }

    // scjz.71: chargeback idempotency must be atomic. The pre-check in
    // raiseChargebackForReversedOrder runs OUTSIDE this lock, so two overlapping
    // payment-poller runs can both pass it before either commits. Re-check here
    // under the advisory + row lock so a second run replays the first chargeback
    // (one credit note per order) instead of posting a duplicate.
    if (input.chargeback) {
      const existingChargeback = await tx.salesOrderRefund.findFirst({
        where: { orderId: input.orderId, chargeback: true },
        select: {
          id: true,
          creditNoteNumber: true,
          totalBase: true,
          accountingRetryRequired: true,
          lines: {
            select: {
              id: true,
              salesOrderLineId: true,
              productId: true,
              description: true,
              qty: true,
              unitPriceForeign: true,
              unitPriceBase: true,
              totalForeign: true,
              totalBase: true,
              // Persisted kind + tax snapshot (o3d-w00 #4) so a chargeback replay posts identically.
              lineKind: true,
              accountingTaxType: true,
              reverseCharge: true,
            },
          },
        },
      })
      if (existingChargeback) {
        // If the first run's reversal staging hasn't completed (accountingRetryRequired),
        // the financial reversal is incomplete — a pending/deferred chargeback may still
        // owe its UNEARNED/allocation reversal. Fail closed so the caller (poller) holds
        // paidAt and re-surfaces it, rather than replaying a clean success that clears
        // the retry state. The refund-accounting retry sweep completes the staging.
        if (existingChargeback.accountingRetryRequired) {
          return { error: 'chargeback exists but its accounting reversal is still pending retry' } as const
        }
        return {
          replay: true as const,
          so,
          fxRate,
          replayTotalBase: refundBoundaryNumber(existingChargeback.totalBase),
          createdRefund: { id: existingChargeback.id },
          createdRefundLines: existingChargeback.lines.map(reconstructReplayLine),
          creditNoteNumber: existingChargeback.creditNoteNumber ?? '',
          newStatus: so.refundStatus === 'FULL' ? 'REFUNDED' as const : 'PARTIALLY_REFUNDED' as const,
        }
      }
    }

    // -----------------------------------------------------------------------
    // o3d-6oyu.18: CROSS-PATH double-reversal guard.
    //
    // Two independent paths raise credit notes for one order: the WooCommerce refund
    // webhook (createRefund with an externalRefundId) and the Xero payment poller's
    // chargeback (createRefund with chargeback: true). Each decides "is a credit note
    // owed?" from a read taken OUTSIDE this transaction — raiseChargebackForReversedOrder's
    // prior-refund pre-check and the poller's window-scoped wasHandledByRecentWcRefund.
    // Neither can see the other path's UNCOMMITTED row, so when a Xero payment removal and
    // a WC refund land in the same poll cycle both pre-checks pass and BOTH post a credit
    // note. (The refund-total cap below does not catch it: chargeback lines are NET while
    // so.totalBase is the order's gross, so on a VAT-inclusive order a full chargeback plus
    // a partial WC refund can still sit under the gross total.)
    //
    // So the decision is re-taken HERE, inside the transaction that already holds
    // pg_advisory_xact_lock(REFUND_ACCOUNTING_LOCK_KEY) and the sales_orders row lock. Both
    // locks are held to COMMIT, so the second path BLOCKS on the first and then — under
    // READ COMMITTED, where every statement takes a fresh snapshot — reads the row the
    // first path just committed. That visibility is exactly what an application-level
    // pre-check cannot buy at any distance.
    //
    // Deliberately NOT a unique index: SalesOrderRefund is legitimately many-per-order
    // (partial refunds), and the two racing rows differ in `chargeback` / `externalRefundId`
    // so no uniqueness key collides. The invariant is "an order carrying any refund must not
    // also be charged back, and vice versa" — a cross-row CONDITIONAL predicate, which a
    // unique index cannot express.
    //
    // The loser is a clean no-op, not an error: `conflict` tells the caller which path won,
    // so the poller records a manual-handling warning and still reconciles paidAt, and the
    // WC refund sync marks the delivery handled instead of dead-lettering it.
    // -----------------------------------------------------------------------
    const conflictingRefund = await tx.salesOrderRefund.findFirst({
      // A chargeback is refused by ANY prior refund; an ordinary refund only by a chargeback
      // (partial refunds may legitimately stack). An existing chargeback replayed above, so a
      // hit here on the chargeback branch is always the other path's row.
      where: input.chargeback ? { orderId: input.orderId } : { orderId: input.orderId, chargeback: true },
      select: { id: true, creditNoteNumber: true },
    })
    if (conflictingRefund) {
      const conflictRef = conflictingRefund.creditNoteNumber ?? conflictingRefund.id
      const conflictResult: { conflict: RefundCreationConflict; conflictError: string } = input.chargeback
        ? {
            conflict: 'prior-refund',
            conflictError: `Order already carries refund ${conflictRef} — auto-chargeback skipped because the remaining balance is ambiguous; raise the credit note manually.`,
          }
        : {
            conflict: 'prior-chargeback',
            conflictError: `Order was already charged back (credit note ${conflictRef}) — a second credit note would double-reverse it; reconcile this refund manually.`,
          }
      return conflictResult
    }

    if (
      effectiveReturnWarehouseId &&
      refundLines.some((refundLine) => refundLine.productId && refundLine.qty > 0) &&
      so.shipments.length === 0
    ) {
      return { error: 'Cannot return refunded stock before the order has shipped' } as const
    }

    // o3d-w00 #2/#5 + o3d-iup: fail closed on a monetary-only (unlinked) SALE line the order can't tax
    // uniformly. Such a line is an un-attributable goods amount; posting it under one header rate would
    // mis-allocate the credit note on a mixed-rate / reverse-charged / deactivated-rate order (e.g.
    // £100@20% + £100@0% posted entirely at 20%). Refuse and PARK it (the caller quarantines) rather than
    // silently mis-tax it. Shipping/discount unlinked lines are exempt — the invoice posts them under the
    // order default too, so a refund matching that is consistent.
    const hasUnlinkedSaleLine = refundLines.some(
      (refundLine) => refundLine.lineId == null && refundLine.lineKind !== 'shipping' && refundLine.lineKind !== 'discount',
    )
    if (hasUnlinkedSaleLine && !orderUniformlyTaxed) {
      // o3d-w00 (Codex r1 #3): name a remedy the operator can actually carry out. For a refund that
      // arrived from a storefront (externalRefundId set) that is the exception inbox's Record-manually
      // action, which allocates the amount across the order's own lines — line-linked, so this very
      // refusal no longer applies — and stamps the external id so a redelivery dedups. For a refund an
      // operator is typing in by hand there is no park to resolve: they simply pick the lines in the
      // refund dialog instead of leaving the amount unattributed.
      return {
        error:
          'This refund is monetary-only (not itemised) but the order is not uniformly taxed, so its VAT ' +
          'cannot be determined automatically and no credit note has been raised. ' +
          (input.externalRefundId != null
            ? `The money has ALREADY been returned in the storefront (refund ${input.externalRefundId}) — do NOT ` +
              'issue another storefront refund. ' + REFUND_PARK_MANUAL_RESOLUTION_HINT
            : 'Record it against the specific order lines it covers instead of as an unattributed amount, ' +
              'so each line carries its own VAT rate.'),
        quarantine: true as const,
      } as const
    }

    const existingRefunds = await tx.salesOrderRefund.findMany({
      where: { orderId: input.orderId },
      select: { totalBase: true, accountingRetryRequired: true, totalsBasis: true },
    })
    // scjz.22: block a NEW refund while a prior refund on this order still has
    // unresolved accounting (accountingRetryRequired). A refund whose accounting
    // staging failed may not have written its cost-layer snapshot, so its quantity
    // counts toward the refund qty cap while NOT reducing shipment cost availability —
    // a second refund can then be under qty-budget yet over-draw the cost basis and
    // throw spuriously (the refund qty cap and the COGS-basis reduction read divergent
    // state). Requiring the prior refund's accounting to be retried first (manually via
    // retryRefundAccounting, or automatically by the accounting-sync sweep) keeps the
    // two sources consistent. Idempotent replays of an existing refund returned earlier,
    // so this only blocks genuinely-new refunds.
    if (existingRefunds.some((refund) => refund.accountingRetryRequired)) {
      return { error: 'A previous refund on this order has unresolved accounting and must be retried before another refund can be created.' } as const
    }
    const previouslyRefunded = existingRefunds.reduce((sum, refund) => sum + refundBoundaryNumber(refund.totalBase), 0)
    // o3d-w00 / o3d-n8p (Codex): the NET ceiling is only sound when EVERY existing refund on this order
    // stores NET totals (totalsBasis='NET'). A NULL-basis row is legacy/unknown — its stored total may be
    // GROSS, and it can't be summed with new NET totals safely: a gross ceiling would let the grossed-up
    // new credit note over-refund (e.g. a legacy £60 gross + a new £60 net passes 60+60=120 on a £120
    // order, yet the new line grosses to £72 -> £132 of credit), and converting a legacy mixed-rate gross
    // refund to net is undecidable. So FAIL CLOSED: block a further automated refund and require manual
    // reconciliation rather than risk an over-refund or a premature FULL. Orders with no prior refunds, or
    // only NET ones, take the correct net ceiling below.
    const allExistingRefundsNet = existingRefunds.every((refund) => refund.totalsBasis === 'NET')
    if (!allExistingRefundsNet) {
      return {
        error:
          'This order has an earlier refund recorded on a legacy/unknown amount basis, which cannot be ' +
          'safely reconciled with a new refund automatically. Reconcile the order manually before creating ' +
          'another refund.',
        quarantine: true as const,
      } as const
    }
    const netOrderTotal = Math.max(0, refundBoundaryNumber(so.totalBase) - refundBoundaryNumber(so.taxBase))
    // audit-M-o2c: cumulative refunded must not exceed the order total, with a
    // fixed rounding epsilon (not a 0.1% relative slack, which on a large order
    // is pounds of headroom) so N partial refunds can't creep over.
    if (refundWouldExceedOrderTotal(totalBase, previouslyRefunded, netOrderTotal)) {
      return { error: 'Refund total would exceed order total' } as const
    }

    const existingRefundLines = await tx.salesOrderRefundLine.findMany({
      where: { refund: { orderId: input.orderId } },
      select: { productId: true, qty: true },
    })
    const refundedQtyByProduct = new Map<string, number>()
    for (const refundLine of existingRefundLines) {
      if (!refundLine.productId) continue
      refundedQtyByProduct.set(
        refundLine.productId,
        (refundedQtyByProduct.get(refundLine.productId) ?? 0) + refundBoundaryNumber(refundLine.qty),
      )
    }
    const originalQtyByProduct = new Map<string, number>()
    for (const salesLine of so.lines) {
      if (!salesLine.productId) continue
      originalQtyByProduct.set(
        salesLine.productId,
        (originalQtyByProduct.get(salesLine.productId) ?? 0) + refundBoundaryNumber(salesLine.qty),
      )
    }
    const soLineProductIds = new Set(
      so.lines.map((salesLine) => salesLine.productId).filter((productId): productId is string => productId != null),
    )
    for (const refundLine of refundLines) {
      if (!refundLine.productId || refundLine.qty <= 0) continue
      if (!input.externalRefundId && !soLineProductIds.has(refundLine.productId)) {
        return {
          error: `Product ${refundLine.productId} is a kit component, not a sales line product. ` +
            'Refund the kit product instead — component stock will be returned proportionally.',
        } as const
      }
      const originalQty = originalQtyByProduct.get(refundLine.productId) ?? 0
      const alreadyRefunded = refundedQtyByProduct.get(refundLine.productId) ?? 0
      const remainingRefundable = originalQty - alreadyRefunded
      if (refundLine.qty > remainingRefundable + 0.001) {
        return { error: `Refund qty ${refundLine.qty} for product ${refundLine.productId} exceeds remaining refundable qty ${remainingRefundable.toFixed(2)}` } as const
      }
    }

    const totalForeign = Math.round(totalBase * fxRate * 10000) / 10000
    const creditNoteNumber = await nextCreditNoteNumber(tx, {
      prefix: input.creditNotePrefix,
    })

    // o3d-n8p: the WRITER stamps what the stored totals mean and where the refund came from — derived from
    // the call context here, not taken from a caller option. Every refund created on this path stores NET
    // totals. source lets the audit/classification be a lookup instead of a reconstruction.
    const refundSource = input.chargeback
      ? 'CHARGEBACK_POLLER'
      : input.externalRefundId != null
        ? 'WOO_SYNC'
        : 'MANUAL_UI'
    const createdRefund = await tx.salesOrderRefund.create({
      data: {
        orderId: input.orderId,
        creditNoteNumber,
        externalRefundId: input.externalRefundId ?? null,
        reason: input.reason || null,
        totalForeign,
        totalBase,
        totalsBasis: 'NET',
        source: refundSource,
        returnWarehouseId: effectiveReturnWarehouseId || null,
        // scjz.70: persist so a later accounting retry that RE-STAGES (vs replays
        // the stored syncs) reproduces the revenue-only treatment.
        chargeback: input.chargeback ?? false,
        // o3d-mrwu: born OWING its accounting, cleared only once staging has actually
        // succeeded. This transaction commits before stageRefundAccountingReversals runs,
        // so defaulting the flag to false meant a crash in that window left a committed
        // refund/chargeback row with no queued reversal AND nothing marking it unfinished.
        // The concurrency guard then reads that row as a completed reversal and refuses the
        // other source, and the poller reads the false flag as completion and advances —
        // both acknowledged, no reversal recoverable anywhere.
        //
        // Same shape as the defects the o3d-bjc.9 rounds converged on: absent data treated
        // as a positive fact on an irreversible path. Fail closed instead: a crash leaves
        // accountingRetryRequired true, which the replay path at `existingChargeback` and
        // the unresolved-accounting guard both already know how to act on.
        accountingRetryRequired: Boolean(so.revenueDeferredDate && input.accountingSettings),
      },
      select: { id: true },
    })

    // o3d-ee9: the refund has now landed for THIS order, so resolve any actionable same-order WooCommerce
    // park for the same external id atomically (in the same tx, under the per-refund + order locks). Without
    // this, a park written by an earlier refused delivery of this refund could linger as an exception even
    // though the refund succeeded. Cross-order parks were already refused above; QUARANTINED is operator-gated.
    if (input.externalRefundId != null) {
      await tx.shoppingSyncLog.updateMany({
        where: {
          connector: 'woocommerce',
          direction: 'FROM_CONNECTOR',
          entityType: 'SalesOrder',
          externalId: String(input.externalRefundId),
          entityId: input.orderId,
          status: { in: ['PENDING', 'FAILED'] },
        },
        data: { status: 'SYNCED', syncedAt: new Date(), errorMessage: null },
      })
    }

    const createdRefundLines: CreatedRefundLine[] = []
    for (const refundLine of refundLines) {
      const lineTotalForeign = refundLine.totalForeign != null
        ? Math.round(refundLine.totalForeign * 10000) / 10000
        : Math.round(refundLine.totalBase * fxRate * 10000) / 10000
      // Normalize once and PERSIST it (o3d-w00 #4) so an accounting retry posts to the same account
      // without re-inferring the kind from productId/amount sign. Kind also drives the unlinked tax
      // identity (a monetary SALE line uses the order's single safe type; shipping/discount the default).
      const lineKind: 'sale' | 'shipping' | 'discount' =
        refundLine.lineKind === 'shipping' ? 'shipping' : refundLine.lineKind === 'discount' ? 'discount' : 'sale'
      const taxIdentity = resolveRefundLineTaxIdentity(refundLine.lineId, lineKind)
      const createdLine = await tx.salesOrderRefundLine.create({
        data: {
          refundId: createdRefund.id,
          salesOrderLineId: refundLine.lineId ?? null,
          productId: refundLine.productId,
          description: refundLine.description,
          qty: refundLine.qty,
          unitPriceForeign: refundLine.qty > 0 ? lineTotalForeign / refundLine.qty : 0,
          unitPriceBase: refundLine.qty > 0 ? refundLine.totalBase / refundLine.qty : 0,
          totalForeign: lineTotalForeign,
          totalBase: refundLine.totalBase,
          accountingTaxType: taxIdentity.accountingTaxType,
          reverseCharge: taxIdentity.reverseCharge,
          lineKind,
        },
        select: {
          id: true,
          salesOrderLineId: true,
          productId: true,
          description: true,
          qty: true,
          unitPriceForeign: true,
          unitPriceBase: true,
          totalForeign: true,
          totalBase: true,
          accountingTaxType: true,
          reverseCharge: true,
        },
      })
      createdRefundLines.push({
        id: createdLine.id,
        lineId: createdLine.salesOrderLineId ?? null,
        productId: createdLine.productId,
        description: createdLine.description,
        qty: refundBoundaryNumber(createdLine.qty),
        unitPriceForeign: refundBoundaryNumber(createdLine.unitPriceForeign),
        unitPriceBase: refundBoundaryNumber(createdLine.unitPriceBase),
        totalForeign: refundBoundaryNumber(createdLine.totalForeign),
        totalBase: refundBoundaryNumber(createdLine.totalBase),
        lineKind,
        accountingTaxType: createdLine.accountingTaxType,
        reverseCharge: createdLine.reverseCharge,
      })
    }

    const totalRefundedNow = previouslyRefunded + totalBase
    // Chargebacks unwind recognised revenue on the NET (ex-VAT) basis: the refund
    // lines are stored net and the credit note grosses them back up via taxType to
    // reverse the full gross AR. Refund totals (here and in priorRefunded) are net,
    // so a full chargeback sums to (totalBase − taxBase). Compare against that net
    // order total — comparing against the gross so.totalBase would leave a full
    // revenue unwind stuck at PARTIALLY_REFUNDED on taxable orders. Non-taxable
    // orders have taxBase 0, so this is identical to the gross basis for them.
    // Refund totals are NET for every caller (o3d-w00 gave the WooCommerce monetary-only refund a net
    // contract like the others), so compare against the NET order total. Using the gross so.totalBase
    // left a full refund of a taxable order stuck at PARTIALLY_REFUNDED. Non-taxable orders have taxBase
    // 0, so this is identical to the gross basis for them. Safe to use the net total unconditionally here:
    // an order with any legacy/unknown-basis refund was already blocked above (o3d-n8p), so at this point
    // every refund on the order is NET-basis.
    const orderTotal = netOrderTotal
    // `newStatus` is the refund *classification* (drives the accounting reversal
    // treatment), NOT the order's lifecycle status — refund state is now the
    // orthogonal refundStatus dimension.
    const newStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED' = isFullRefundAmount(totalRefundedNow, orderTotal)
      ? 'REFUNDED'
      : 'PARTIALLY_REFUNDED'
    // A cancelled order has nothing to refund — preserve the prior reject (the old
    // status machine blocked CANCELLED → REFUNDED/PARTIALLY_REFUNDED).
    if (so.status === 'CANCELLED') {
      return { error: 'Cannot refund a cancelled order' } as const
    }
    // The lifecycle status is left untouched; only the refund disposition is written,
    // so an order can be e.g. Delivered + Fully refunded and keep flowing through
    // fulfilment for any unrefunded remainder.
    await tx.salesOrder.update({
      where: { id: input.orderId },
      data: { refundStatus: refundDispositionForStatus(newStatus) },
    })

    // Build fallback rows inside the refund transaction so source-stock errors
    // roll back the refund and its lines. Stock application remains in the
    // later return-stock transaction because accounting staging may provide a
    // fresher cost-layer snapshot; if that later step fails, the persisted
    // refund is retained and marked for accounting retry like other post-refund
    // side-effect failures.
    const fallbackReturnRows = effectiveReturnWarehouseId
      ? await buildRefundFallbackReturnRows(tx, input.orderId, createdRefundLines, createdRefund.id)
      : []

    // o3d-67y: eligibility is derived from RESIDUAL reserved quantity under this order lock, not lifecycle
    // status and not raw allocation-row count. Dispatch decrements stockLevel.reservedQty but RETAINS the
    // OrderAllocation rows for accounting snapshots (Codex review r5), so a fully-dispatched order still has
    // rows yet nothing to release — counting rows would enqueue a job that refuses and becomes a false
    // dead-letter. Residual = allocated qty − already-shipped qty; only a positive residual is a live
    // reservation a refund can strand.
    const [allocatedAgg, shippedAgg] = await Promise.all([
      tx.orderAllocation.aggregate({ where: { orderId: input.orderId }, _sum: { qty: true } }),
      tx.shipmentLine.aggregate({
        where: { shipment: { orderId: input.orderId, status: 'SHIPPED' } },
        _sum: { qty: true },
      }),
    ])
    const residualReserved =
      refundBoundaryNumber(allocatedAgg._sum.qty ?? 0) - refundBoundaryNumber(shippedAgg._sum.qty ?? 0)
    const releaseEligible = isRefundReleaseEligible({ residualReserved, newStatus, refundLines: createdRefundLines })
    // o3d-67y (Codex r8/r9): a positive-qty sale refund line with no persisted sales-order-line link (an
    // unmatched external WooCommerce line) can't reduce a tracked line's demand and is not a safe release
    // target — but with a live residual reservation on a partial refund it is a data-quality anomaly the
    // operator must see (the reservation stays held and a later shipment could include the refunded quantity).
    // Computed INDEPENDENTLY of releaseEligible so a MIXED refund (one matched + one unmatched line) still
    // surfaces it (a matched line makes the release eligible but does not resolve the unmatched line).
    const releaseUnmatchedAnomaly =
      residualReserved > 0 && newStatus !== 'REFUNDED' && hasUnmatchedSaleRefund(createdRefundLines)

    // Enqueue the durable reservation-release backstop INSIDE this tx so it commits atomically with the refund.
    // The immediate post-commit release (in the caller) stays for timeliness; this row guarantees the release
    // still happens if that call is bypassed by a post-commit throw or lost to a crash. No-op when the order
    // holds no allocations.
    await scheduleRefundReservationReleaseOutbox(tx, {
      orderId: input.orderId,
      refundId: createdRefund.id,
      eligible: releaseEligible,
    })
    // Separate durable row (Codex r10): delivering the unmatched-line WARNING must never re-run allocation, so
    // it does not share the release row's lifecycle.
    await scheduleRefundUnmatchedWarningOutbox(tx, {
      orderId: input.orderId,
      refundId: createdRefund.id,
      refundOrderRef: getSalesOrderReference(so),
      unmatched: releaseUnmatchedAnomaly,
    })

    return {
      so,
      fxRate,
      createdRefund,
      createdRefundLines,
      creditNoteNumber,
      newStatus,
      releaseEligible,
      releaseUnmatchedAnomaly,
      fallbackReturnRows,
    }
  }).catch((error) => {
    if (isRefundReturnSourceError(error)) {
      return { error: refundReturnSourceErrorMessage(error) } as const
    }
    throw error
  })

  // Two INDEPENDENT discriminators ride on the failure result, and a caller may see either:
  //
  //   `conflict`   (o3d-6oyu.18) — the other path already reversed this order. A no-op the caller
  //                must never retry. Reported BEFORE the generic error path.
  //   `quarantine` (o3d-w00 #2/#5) — the refund is monetary-only and the order cannot be taxed
  //                uniformly, so it is parked for a human rather than posted on a guess.
  //
  // They are not mutually exclusive in principle, so the conflict branch is checked first (it is
  // the stronger statement: there is nothing left to refund) and quarantine is carried through on
  // the generic path.
  if ('conflict' in txResult) {
    return { success: false, error: txResult.conflictError, conflict: txResult.conflict }
  }
  if ('error' in txResult) {
    return {
      success: false,
      error: txResult.error ?? 'Refund failed',
      ...('quarantine' in txResult && txResult.quarantine ? { quarantine: true as const } : {}),
    }
  }

  const refundOrderRef = getSalesOrderReference(txResult.so)
  if ('replay' in txResult) {
    if (txResult.replayTotalBase == null) throw new Error('Refund replay result missing persisted total')
    return {
      success: true,
      orderId: input.orderId,
      totalBase: txResult.replayTotalBase,
      refundFxRate: txResult.fxRate,
      createdRefund: txResult.createdRefund,
      createdRefundLines: txResult.createdRefundLines,
      creditNoteNumber: txResult.creditNoteNumber,
      newStatus: txResult.newStatus,
      refundOrderRef,
      so: txResult.so,
      accountingSyncs: [],
      returnedRows: [],
      replayed: true,
    }
  }

  let accountingSyncs: RefundAccountingSyncRequest[] = []
  let accountingWarning: string | undefined
  let snapshotReturnRows: RefundReturnRow[] | null = null
  if (txResult.so.revenueDeferredDate && input.accountingSettings) {
    try {
      const staged = await stageRefundAccountingReversals(client, {
        orderId: input.orderId,
        orderRef: refundOrderRef,
        refundId: txResult.createdRefund.id,
        refundLines: txResult.createdRefundLines,
        returnWarehouseId: effectiveReturnWarehouseId,
        accountingSettings: input.accountingSettings,
        so: txResult.so,
        newStatus: txResult.newStatus,
        chargeback: input.chargeback,
        activeConnector: input.activeAccountingConnector,
      })
      accountingSyncs = staged.accountingSyncs
      snapshotReturnRows = staged.snapshotReturnRows
      await client.salesOrderRefund.update({
        where: { id: txResult.createdRefund.id },
        data: {
          accountingRetrySyncs: refundAccountingSyncsJson(accountingSyncs),
          // o3d-mrwu: staging succeeded and the syncs are now durable, so the row no longer
          // owes anything. This is the ONLY place the flag is cleared — everything else
          // leaves it set, which is what makes a crash recoverable.
          accountingRetryRequired: false,
          // scjz.71: durably record whether any COGS/unearned reversal was staged
          // (the UNEARNED_REV_REVERSAL sync also carries allocation reversal) so the
          // invariant/reconciliation evidence checks can tell a credit-note-only
          // chargeback from one that owes reversal evidence — independent of
          // accountingRetrySyncs, which is cleared once the syncs queue.
          reversalStaged: stagedAReversal(accountingSyncs),
        },
      })
      // bcz9.4: the COGS subledger row is recorded later, atomically with queuing the
      // COGS_REVERSAL sync (queueRefundAccountingActions), not here at staging.
    } catch (error) {
      accountingWarning = accountingWarningMessage(error)
      await client.salesOrderRefund.update({
        where: { id: txResult.createdRefund.id },
        data: {
          accountingRetryRequired: true,
          accountingWarning,
        },
      })
    }
  }

  let returnedRows: Array<{ productId: string; sku: string; qty: number }> = []
  // scjz.70: effectiveReturnWarehouseId is undefined for a chargeback, so the
  // inbound return movement is skipped (the customer keeps the goods).
  if (effectiveReturnWarehouseId && !accountingWarning) {
    const snapshotRows = snapshotReturnRows ?? []
    const returnRows = snapshotRows.length > 0
      ? snapshotRows
      : txResult.fallbackReturnRows

    returnedRows = await runInTransaction(client, (tx) => (
      applyReturnInboundStockTx(tx, {
        referenceType: 'SalesOrderRefund',
        referenceId: txResult.createdRefund.id,
        warehouseId: effectiveReturnWarehouseId!,
        rows: returnRows,
        note: 'Refund return',
      })
    ))
  }

  return {
    success: true,
    orderId: input.orderId,
    totalBase,
    refundFxRate: txResult.fxRate,
    createdRefund: txResult.createdRefund,
    createdRefundLines: txResult.createdRefundLines,
    creditNoteNumber: txResult.creditNoteNumber,
    newStatus: txResult.newStatus,
    refundOrderRef,
    so: txResult.so,
    accountingSyncs,
    accountingWarning,
    returnedRows,
    releaseEligible: txResult.releaseEligible,
    releaseUnmatchedAnomaly: txResult.releaseUnmatchedAnomaly,
  }
}

export async function retrySalesOrderRefundAccounting(
  client: RefundServiceClient,
  input: {
    refundId: string
    accountingSettings: AccountingSettings
    /** Active accounting connector (scopes the prior-reversal guard); resolved by the caller. */
    activeAccountingConnector?: 'xero' | 'quickbooks'
  },
): Promise<RetrySalesOrderRefundAccountingResult> {
  try {
    return await runInTransaction(client, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_ACCOUNTING_LOCK_KEY})`

      const refund = await tx.salesOrderRefund.findUnique({
        where: { id: input.refundId },
        select: {
          id: true,
          orderId: true,
          returnWarehouseId: true,
          chargeback: true,
          accountingRetryRequired: true,
          accountingRetrySyncs: true,
          order: {
            select: {
              id: true,
              externalOrderNumber: true,
              orderNumber: true,
              status: true,
              refundStatus: true,
              revenueDeferredDate: true,
              unearnedRevenueAmount: true,
            },
          },
          lines: {
            select: {
              id: true,
              salesOrderLineId: true,
              productId: true,
              description: true,
              qty: true,
              unitPriceForeign: true,
              unitPriceBase: true,
              totalForeign: true,
              totalBase: true,
              accountingTaxType: true,
              reverseCharge: true,
            },
          },
        },
      })
      if (!refund) return { success: false, error: 'Refund not found' }
      if (!refund.accountingRetryRequired) {
        return { success: false, error: 'No failed refund accounting action is pending for this refund' }
      }
      const persistedSyncs = parseRefundAccountingRetrySyncs(refund.accountingRetrySyncs)
      if (persistedSyncs.length > 0) {
        // bcz9.4: the COGS subledger row is recorded by queueRefundAccountingActions
        // when it re-queues these persisted syncs, atomically with the COGS_REVERSAL.
        return {
          success: true,
          orderId: refund.orderId,
          refundId: refund.id,
          refundOrderRef: getSalesOrderReference(refund.order),
          accountingSyncs: persistedSyncs,
          returnedRows: [],
        }
      }
      if (!refund.order.revenueDeferredDate) {
        return {
          success: true,
          orderId: refund.orderId,
          refundId: refund.id,
          refundOrderRef: getSalesOrderReference(refund.order),
          accountingSyncs: [],
          returnedRows: [],
        }
      }

      const refundOrderRef = getSalesOrderReference(refund.order)
      const refundLines: CreatedRefundLine[] = refund.lines.map((line) => ({
        id: line.id,
        lineId: line.salesOrderLineId,
        productId: line.productId,
        description: line.description,
        qty: refundBoundaryNumber(line.qty),
        unitPriceForeign: refundBoundaryNumber(line.unitPriceForeign),
        unitPriceBase: refundBoundaryNumber(line.unitPriceBase),
        totalForeign: refundBoundaryNumber(line.totalForeign),
        totalBase: refundBoundaryNumber(line.totalBase),
        lineKind: line.productId ? 'sale' : 'shipping',
        accountingTaxType: line.accountingTaxType,
        reverseCharge: line.reverseCharge,
      }))
      // Refund classification comes from the orthogonal refundStatus now (the lifecycle
      // status is no longer set to REFUNDED on a full refund).
      const newStatus = refund.order.refundStatus === 'FULL' ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
      const staged = await stageRefundAccountingReversals(tx, {
        orderId: refund.orderId,
        orderRef: refundOrderRef,
        refundId: refund.id,
        refundLines,
        returnWarehouseId: refund.returnWarehouseId ?? undefined,
        accountingSettings: input.accountingSettings,
        so: refund.order,
        newStatus,
        chargeback: refund.chargeback,
        activeConnector: input.activeAccountingConnector,
      })

      let returnedRows: Array<{ productId: string; sku: string; qty: number }> = []
      if (refund.returnWarehouseId && !refund.chargeback) {
        const snapshotRows = staged.snapshotReturnRows ?? []
        const returnRows = snapshotRows.length > 0
          ? snapshotRows
          : await buildRefundFallbackReturnRows(tx, refund.orderId, refundLines, refund.id)
        returnedRows = await applyReturnInboundStockTx(tx, {
          referenceType: 'SalesOrderRefund',
          referenceId: refund.id,
          warehouseId: refund.returnWarehouseId!,
          rows: returnRows,
          note: 'Refund return',
        })
      }
      await tx.salesOrderRefund.update({
        where: { id: refund.id },
        data: {
          accountingRetrySyncs: refundAccountingSyncsJson(staged.accountingSyncs),
          reversalStaged: stagedAReversal(staged.accountingSyncs),
        },
      })
      // bcz9.4: the COGS subledger row is recorded by queueRefundAccountingActions when
      // it queues these staged syncs, atomically with the COGS_REVERSAL sync.

      return {
        success: true,
        orderId: refund.orderId,
        refundId: refund.id,
        refundOrderRef,
        accountingSyncs: staged.accountingSyncs,
        returnedRows,
      }
    })
  } catch (error) {
    const warning = accountingWarningMessage(error)
    await client.salesOrderRefund.update({
      where: { id: input.refundId },
      data: {
        accountingRetryRequired: true,
        accountingWarning: warning,
      },
    })
    return { success: false, error: warning }
  }
}
