import type { Prisma } from '@/app/generated/prisma/client'
import { queueAccountingSyncTxWithOutcome, getAccountingSettings, accountingPostingVerdictForChart } from '@/lib/accounting'
import { withSavepoint } from '@/lib/db/savepoint'
import { recordAccountingPostingRefusal, type PostingRefusalClient } from '@/lib/domain/accounting/posting-refusal-inbox'
import { accountingPostingKey } from '@/lib/accounting/posting-key'
import { postingIsOwed, reportPostingNotQueued } from '@/lib/domain/accounting/enqueue-outcome'
import { cogsEntryDataFromConsumed, consumeFifoLayersStrict, createCostLayer, getAverageUnitCost, getHistoricalAverageUnitCost, lockStockLevelRow } from '@/lib/cost-layers'
import { assertStockAdjustmentFeasible } from '@/lib/domain/inventory/stock-adjustment-edit'
import {
  buildStockMovementValueFields,
  buildStockMovementValueFieldsFromConsumed,
} from '@/lib/domain/inventory/stock-movement-value'
import { manualStockAdjustmentMovementKey } from '@/lib/domain/inventory/stock-movement-idempotency'
import { businessDateYmd } from '@/lib/business-date'
import { withHandPostSafety } from '@/lib/domain/accounting/hand-post-instruction'
import { multiplyMoney, roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import {
  getLatestLayerUnitCost,
  missingReasonMessage,
  readStockAdjustmentReasonCostRequired,
  resolveRequiredAdditionUnitCost,
  unmappedReasonMessage,
} from '@/lib/domain/inventory/stock-adjustment-policy'

// Extracted from app/actions/stock.ts (6oyu.1) so non-action callers — the WMS
// stock-sync align-down path runs from a cron job — can post an adjustment
// without importing a 'use server' module from lib. Behaviour is unchanged; the
// stock actions call this same implementation.

// ---------------------------------------------------------------------------
// Helpers for inventory adjustment accounting journal
// ---------------------------------------------------------------------------


/**
 * Build the journal payload for an inventory adjustment.
 *
 *   qty > 0 (stock added, e.g. "stock found"):
 *     DR Inventory / CR reason.accountCode   — the reason account is a gain
 *
 *   qty < 0 (stock removed, e.g. "write-off", "shrinkage"):
 *     DR reason.accountCode / CR Inventory   — the reason account is an expense
 *
 * Returns null when there is nothing to post (no cost, no reason account,
 * or zero quantity).
 */
export function buildInventoryAdjustmentJournal(params: {
  reasonAccountCode: string
  inventoryAccountCode: string
  productSku: string
  productName: string
  warehouseCode: string
  warehouseName: string
  qty: number
  /**
   * The base-currency value the movement actually booked (cbxu): for an addition,
   * qty × the layer unit cost; for a removal, the FIFO cost of the layers consumed.
   * The journal credits/debits Inventory by ROUND(this, 2) so Inventory GL ties to
   * the cost-layer reduction, not a product-wide blended average.
   */
  totalValueBase: number
  note: string | null
}): {
  date: string
  reference: string
  narration: string
  lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }>
} | null {
  const { reasonAccountCode, inventoryAccountCode, productSku, productName, warehouseCode, warehouseName, qty, totalValueBase, note } = params
  if (qty === 0 || totalValueBase === 0 || !reasonAccountCode || !inventoryAccountCode) return null

  const totalValue = Math.round(Math.abs(totalValueBase) * 100) / 100
  if (totalValue === 0) return null

  const date = businessDateYmd(new Date())
  const directionLabel = qty > 0 ? 'increase' : 'decrease'
  const reference = `Adj: ${productSku} ${qty > 0 ? '+' : ''}${qty} @ ${warehouseCode}`
  const narration = [
    `Stock ${directionLabel} — ${productName} @ ${warehouseName}`,
    note,
  ].filter(Boolean).join(' — ')
  const description = `${productSku} ${qty > 0 ? '+' : ''}${qty} @ ${warehouseCode}`

  const lines = qty > 0
    ? [
        { accountCode: inventoryAccountCode, description, debit: totalValue },
        { accountCode: reasonAccountCode, description, credit: totalValue },
      ]
    : [
        { accountCode: reasonAccountCode, description, debit: totalValue },
        { accountCode: inventoryAccountCode, description, credit: totalValue },
      ]

  return { date, reference, narration, lines }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApplyStockAdjustmentInput = {
  tx: Prisma.TransactionClient
  productId: string
  warehouseId: string
  qty: number
  reasonId?: string
  note?: string | null
  /**
   * Explicit base-currency unit cost for a positive adjustment. When omitted, the
   * cost basis is derived (warehouse average → product historical average); with the
   * switch `stock_adjustment_reason_cost_required` on, it defaults to the latest cost
   * layer's unit cost instead (warehouse, else any) and is never an average
   * (o3d-0ypv9, see stock-adjustment-policy.ts). If no
   * basis can be derived (brand-new product, no cost layers anywhere) an explicit
   * cost is REQUIRED — otherwise the addition would silently book £0 stock and
   * later sell at zero COGS (cogs-audit scjz.2). Pass 0 only for genuinely
   * zero-cost stock (samples/consigned).
   */
  unitCostBase?: number | null
  /**
   * 8biu: pre-fetched accounting settings. Pass this from a bulk loop so
   * getAccountingSettings() is read once for the whole batch instead of per line.
   * Omit for single adjustments (fetched on demand only when a reason has an
   * account code).
   */
  settings?: Awaited<ReturnType<typeof getAccountingSettings>>
  /**
   * Optional provenance for the ADJUSTMENT stock movement. Used by stocktake
   * (om9w) to tie variance movements to their count (referenceType 'StockCount',
   * referenceId = count id) so the stock-count report can attribute them.
   */
  referenceType?: string
  referenceId?: string
  /**
   * 0tr0: per-submission idempotency token (a stable client-generated UUID that
   * survives retries of one submission). When supplied, the ADJUSTMENT movement key
   * is derived as a content fingerprint of this token plus the adjustment payload
   * (see manualStockAdjustmentMovementKey): a re-submission of the SAME adjustment
   * (network retry / double-click / refresh during pending) is detected under the
   * stock-level lock and skipped, while an edited resubmit gets a fresh key and
   * applies. Backed by StockMovement.idempotencyKey @unique.
   */
  idempotencyToken?: string | null
  /**
   * o3d-hqvrp.80: when a removal exceeds the AVAILABLE stock (it would cut into reserved units),
   * release the newest orders' unshipped allocations first, in this transaction, instead of refusing.
   * Off unless the caller passes it (the flag `stock_adjustment_release_reserved`, read by the action).
   */
  releaseReservedForRemoval?: boolean
}

export type AppliedStockAdjustment = {
  movementId: string
  productSku: string
  warehouseName: string
}

export async function applyStockAdjustment({
  tx,
  productId,
  warehouseId,
  qty,
  reasonId,
  note,
  unitCostBase,
  settings: providedSettings,
  referenceType,
  referenceId,
  idempotencyToken,
  releaseReservedForRemoval,
}: ApplyStockAdjustmentInput): Promise<AppliedStockAdjustment> {
  const isAddition = qty > 0
  // 0tr0/r9y2: content-addressed key from the per-submission token + payload, so an
  // edited resubmit gets a new key (not deduped) and same-key requests always target
  // the same stock row (serialised by the lock below).
  const idempotencyKey = idempotencyToken
    ? manualStockAdjustmentMovementKey({
        token: idempotencyToken,
        productId,
        warehouseId,
        qty,
        reasonId,
        note,
        unitCostBase,
        referenceType,
        referenceId,
      })
    : null
  const absQty = Math.abs(qty).toString()

  let reasonName: string | null = note || null
  let accountCode: string | null = null
  // o3d-0ypv9: what the switch-on checks below need to know about the reason. Unused with the switch off.
  let resolvedReason: { name: string; active: boolean | undefined } | null = null

  if (reasonId) {
    const reason = await tx.adjustmentReason.findUnique({
      where: { id: reasonId },
      select: { name: true, accountCode: true, active: true },
    })
    if (reason) {
      reasonName = note ? `${reason.name}: ${note}` : reason.name
      accountCode = reason.accountCode
      resolvedReason = { name: reason.name, active: reason.active }
    }
  }

  // The key is unique, so a plain read answers "was this already applied?" without the stock-level lock.
  const findReplayedAdjustment = async (): Promise<AppliedStockAdjustment | null> => {
    if (!idempotencyKey) return null
    const existing = await tx.stockMovement.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    })
    if (!existing) return null
    const [product, warehouse] = await Promise.all([
      tx.product.findUnique({ where: { id: productId }, select: { sku: true } }),
      tx.warehouse.findUnique({ where: { id: warehouseId }, select: { name: true } }),
    ])
    return {
      movementId: existing.id,
      productSku: product?.sku ?? productId,
      warehouseName: warehouse?.name ?? warehouseId,
    }
  }

  // A replay must not release anybody's reservation: its first submission already did (or needed to),
  // and the release would commit for an adjustment that now writes nothing.
  //
  // The key is CLAIMED first, under a transaction-scoped advisory lock: two concurrent submissions with the
  // same key serialise here, so the loser only reads after the winner has committed, finds its movement and
  // returns the replay BEFORE it can release anything. Its transaction therefore never writes a release for
  // an adjustment that wrote nothing. (Taken before any sales_orders / stock_levels lock, and only ever
  // contended by the same key, so it cannot join a lock cycle.)
  if (idempotencyKey) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-adjustment-key:${idempotencyKey}`}, 0))`
    const replay = await findReplayedAdjustment()
    if (replay) return replay
  }

  // o3d-0ypv9 (switch `stock_adjustment_reason_cost_required`, off by default): read through this transaction, AFTER the replay
  // check (a retry of an adjustment that already committed is answered, never re-judged) and BEFORE anything is written.
  const reasonCostRequired = await readStockAdjustmentReasonCostRequired(tx)
  let productLabel = productId
  // Settings read once for the switch-on checks; the switch-off path keeps its own reads exactly as before.
  let requiredSettings: Awaited<ReturnType<typeof getAccountingSettings>> | null = null
  const assertAdjustmentPostable = async (valueBase: Decimal) => {
    if (roundQuantity(valueBase.abs(), 2).isZero()) return
    requiredSettings = requiredSettings ?? providedSettings ?? await getAccountingSettings()
    if (accountCode && requiredSettings.inventoryAccount) return
    if (!requiredSettings.connector) return
    // The same verdict that, with the switch off, decides whether the unmapped adjustment is owed to the exception inbox.
    const { verdict } = await accountingPostingVerdictForChart(requiredSettings.connector, 'INVENTORY_ADJUSTMENT')
    if (verdict !== 'post' && verdict !== 'chart-retired') return
    throw new Error(unmappedReasonMessage({ reasonName: resolvedReason?.name ?? null, inventoryAccountMapped: Boolean(requiredSettings.inventoryAccount) }))
  }
  if (reasonCostRequired) {
    const productRow = await tx.product.findUnique({ where: { id: productId }, select: { sku: true } })
    productLabel = productRow?.sku ?? productId
    if (!reasonId || !resolvedReason) throw new Error(missingReasonMessage(productLabel))
    if (resolvedReason.active === false) {
      throw new Error(`The adjustment reason "${resolvedReason.name}" is inactive. Choose an active reason for ${productLabel}.`)
    }
  }

  // o3d-hqvrp.80: sales_orders are locked BEFORE stock_levels everywhere, so the release for a removal that
  // would cut into reserved units runs before this transaction takes the stock-level lock.
  if (releaseReservedForRemoval && qty < 0) {
    const level = await tx.stockLevel.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
      select: { quantity: true, reservedQty: true },
    })
    if (level && Number(level.quantity) - Number(level.reservedQty) < Math.abs(qty)) {
      const { releaseReservationsForRemovalInTx } = await import('@/lib/fulfillment/overallocation-rebalancer')
      await releaseReservationsForRemovalInTx(tx, { productId, warehouseId }, Math.abs(qty), {
        source: 'stock_adjustment',
        referenceId: productId,
        referenceLabel: `stock adjustment (${qty})`,
      })
    }
  }

  const locked = await lockStockLevelRow(tx, productId, warehouseId)

  // 0tr0: idempotency check UNDER the stock-level lock. Same-(product,warehouse)
  // re-submissions serialise here, so a duplicate carrying the same key sees the
  // first submission's committed movement and returns it instead of double-booking.
  if (idempotencyKey) {
    const replay = await findReplayedAdjustment()
    if (replay) return replay
  }

  // ig58: pre-flight availability check against the locked row, before any
  // movement/cost-layer/upsert is written. Rejects an infeasible removal (one
  // that would drive on-hand below the reserved quantity, which includes going
  // negative) with a clear message instead of letting the DB non-negative CHECK
  // abort opaquely — and so the upsert create branch never builds a negative.
  assertStockAdjustmentFeasible({
    signedQty: qty,
    currentQuantity: locked.quantity,
    currentReservedQty: locked.reservedQty,
  })

  let additionUnitCost: number | null = null
  let removalCostBase: number | null = null
  // o3d-0ypv9 switch on: the exact Decimal cost and value the movement books. Null with the switch off.
  let requiredAdditionUnitCost: Decimal | null = null
  let requiredValueBase: Decimal | null = null
  if (isAddition && reasonCostRequired) {
    // An entered cost (0 included), else the latest layer cost: never an average.
    const explicit = unitCostBase ?? null
    // At the 6dp the cost layer and the movement store, so the journal is valued at exactly what is booked.
    requiredAdditionUnitCost = roundQuantity(resolveRequiredAdditionUnitCost({
      explicitUnitCostBase: explicit,
      latest: explicit == null ? await getLatestLayerUnitCost(tx, productId, warehouseId) : null,
      productLabel,
    }), 6)
    additionUnitCost = requiredAdditionUnitCost.toNumber()
    requiredValueBase = multiplyMoney(Math.abs(qty), requiredAdditionUnitCost)
    // Refused BEFORE anything is written.
    await assertAdjustmentPostable(requiredValueBase)
  } else if (isAddition) {
    if (unitCostBase != null && Number.isFinite(unitCostBase) && unitCostBase >= 0) {
      // Operator/caller supplied an explicit cost (0 allowed for sample/consigned stock).
      additionUnitCost = unitCostBase
    } else {
      const warehouseAvgCost = await getAverageUnitCost(tx, productId, warehouseId)
      additionUnitCost = warehouseAvgCost > 0 ? warehouseAvgCost : await getHistoricalAverageUnitCost(tx, productId)
      if (!(additionUnitCost > 0)) {
        // No cost basis anywhere for this product. Booking the layer at £0 would
        // create real on-hand stock valued at £0 and later sell it at zero COGS
        // (cogs-audit scjz.2). Require an explicit unit cost instead.
        throw new Error(
          'Enter a unit cost for this stock addition — no cost basis could be derived (the product has no existing cost layers). Use 0 only for genuinely zero-cost stock such as samples.',
        )
      }
    }
  }

  const movement = await tx.stockMovement.create({
    data: {
      type: 'ADJUSTMENT',
      productId,
      fromWarehouseId: isAddition ? null : warehouseId,
      toWarehouseId: isAddition ? warehouseId : null,
      qty: absQty,
      note: reasonName,
      ...(referenceType ? { referenceType } : {}),
      ...(referenceId ? { referenceId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(isAddition ? buildStockMovementValueFields({ qty: absQty, unitCostBase: requiredAdditionUnitCost ?? additionUnitCost ?? 0 }) : {}),
    },
  })

  await tx.stockLevel.upsert({
    where: { productId_warehouseId: { productId, warehouseId } },
    // lockStockLevelRow already upserted the row, so the create branch is
    // effectively unreachable; keep it non-negative (a removal that reached it
    // would mean a zero on-hand row, already rejected by the guard above).
    create: {
      productId,
      warehouseId,
      quantity: isAddition ? absQty : '0',
    },
    update: {
      quantity: {
        increment: qty,
      },
    },
  })

  if (isAddition) {
    await createCostLayer(tx, {
      productId,
      warehouseId,
      qty: Math.abs(qty),
      unitCostBase: requiredAdditionUnitCost ?? additionUnitCost ?? 0,
      receivedAt: movement.createdAt,
      isOpeningStock: false,
      adjustmentMovementId: movement.id,
    })
  } else {
    const { consumed } = await consumeFifoLayersStrict(tx, productId, warehouseId, Math.abs(qty))
    // cbxu (Codex): value the GL journal at the SAME totalValueBase the movement
    // actually stores — derived from the consumed layers at the movement's row qty
    // (constraint-consistent) — rather than the raw FIFO sum, which can differ by a
    // cent at scale and drift the GL from the movement ledger. Ties Inventory GL to
    // the cost-layer reduction, not a product-wide blended average.
    const valueFields = buildStockMovementValueFieldsFromConsumed(consumed, absQty)
    removalCostBase = Number(valueFields.totalValueBase)
    if (reasonCostRequired) {
      requiredValueBase = toDecimal(valueFields.totalValueBase)
      // A removal's value is known only once FIFO has been consumed; the refusal rolls the caller's transaction back.
      await assertAdjustmentPostable(requiredValueBase)
    }
    await tx.stockMovement.update({
      where: { id: movement.id },
      data: valueFields,
    })
    if (consumed.length > 0) {
      await tx.cogsEntry.createMany({
        data: consumed.map((entry) => cogsEntryDataFromConsumed(movement.id, entry)),
      })
    }
  }

  const [product, warehouse] = await Promise.all([
    tx.product.findUnique({ where: { id: productId }, select: { sku: true, name: true } }),
    tx.warehouse.findUnique({ where: { id: warehouseId }, select: { code: true, name: true } }),
  ])

  // o3d-hqvrp.47: a valued adjustment with NO account to post against (no reason, a reason with no account,
  // or no inventory account mapped) changed the cost layers and posted nothing, silently. Record the owed
  // posting the way every other refused producer does, so the ledger gap shows in the exception inbox.
  // Only when the adjustment would post (connector active, sync on, type on): otherwise nothing is owed (the `not-configured` rule). The owed row is the report; no separate activity-log row.
  // The one identity of this movement's journal: the enqueue below and the owed-posting row both take it.
  const journalIdentity = { type: 'INVENTORY_ADJUSTMENT' as const, referenceType: 'StockMovement', referenceId: movement.id }
  const adjustmentValueBase = isAddition
    ? Math.abs(qty) * (additionUnitCost ?? 0)
    : (removalCostBase ?? 0)
  const adjustmentHasValue = qty !== 0 && Math.round(Math.abs(adjustmentValueBase) * 100) !== 0
  if (adjustmentHasValue) {
    const unmappedSettings = providedSettings ?? await getAccountingSettings()
    // Owed only when a mapped adjustment WOULD post: the same verdict the enqueue answers from (connector active,
    // xero_sync_enabled on, the inventory-adjustment type on). `not-configured` and `no-chart` owe nothing.
    const wouldPost = (!accountCode || !unmappedSettings.inventoryAccount) && unmappedSettings.connector
      ? (await accountingPostingVerdictForChart(unmappedSettings.connector, 'INVENTORY_ADJUSTMENT')).verdict
      : null
    if (unmappedSettings.connector && (wouldPost === 'post' || wouldPost === 'chart-retired')) {
      // No enqueue ran (there was no journal to build), so there is no answer to forward: the outstanding row is
      // recorded directly, in the caller's transaction, under the key the journal would have been queued under.
      const unmapped = !accountCode ? 'reason_account' : 'inventory_account'
      const remedy = withHandPostSafety(!accountCode
        ? 'The adjustment has no reason, or its reason has no account, so no journal was built. Inventory in the '
          + 'ledger no longer matches IMS by the value of this adjustment. Post the journal by hand.'
        : 'No inventory account is mapped, so no journal was built. Inventory in the ledger no longer matches IMS '
          + 'by the value of this adjustment. Post the journal by hand.')
      await recordAccountingPostingRefusal(
        tx as unknown as PostingRefusalClient,
        accountingPostingKey(journalIdentity),
        {
          kind: 'stock_adjustment_journal',
          chartConnector: unmappedSettings.connector,
          activeConnector: unmappedSettings.connector,
          reason: `unmapped_${unmapped}`,
          committed: 'the stock movement and its cost layers are written in IMS',
          remedy,
          detail: { movementId: movement.id, productId, warehouseId, unmapped },
        },
        { withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn) },
      )
    }
  }

  if (accountCode) {
    const settings = providedSettings ?? await getAccountingSettings()
    // Value the GL journal at the value the movement/cost-layer actually booked so
    // Inventory GL ties to the cost-layer change, not a blended product-wide
    // average: additions use qty × the booked layer unit cost (scjz.2); removals
    // use the FIFO cost of the layers consumed (cbxu — the prior product-average
    // basis mis-stated both COGS and inventory, especially across warehouses).
    const totalValueBase = requiredValueBase
      ? roundQuantity(requiredValueBase, 2).toNumber()
      : isAddition
        ? Math.abs(qty) * (additionUnitCost ?? 0)
        : (removalCostBase ?? 0)
    const journal = buildInventoryAdjustmentJournal({
      reasonAccountCode: accountCode,
      inventoryAccountCode: settings.inventoryAccount,
      productSku: product?.sku ?? productId,
      productName: product?.name ?? '',
      warehouseCode: warehouse?.code ?? '',
      warehouseName: warehouse?.name ?? '',
      qty,
      totalValueBase,
      note: reasonName,
    })
    if (journal) {
      // o3d-j625 r6 (review M3) — IN THE CALLER'S TRANSACTION. This runs inside the bulk adjustment and the
      // stock-count post, whose later lines can throw and roll the batch back. Through the facade (its own
      // transaction and the pool) both the sync row AND r5's refusal row survived that rollback — an
      // outstanding posting, or a queued journal, for a stock movement that never existed. Written through
      // `tx`, the sync row and the refusal row share the movement's fate.
      const enqueued = await queueAccountingSyncTxWithOutcome(tx, {
        ...journalIdentity,
        payload: journal as unknown as Record<string, unknown>,
        // o3d-j625: `inventoryAccountCode` on the journal is `settings.inventoryAccount`. The window is
        // wider here than at a single call site, because `providedSettings` is read ONCE for a whole
        // batch of adjustments by the caller (see the `settings` option) and every row in that batch is
        // enqueued against it — so an unrouted enqueue could write the tail of a batch under the other
        // connector while carrying the first connector's inventory account.
        chartConnector: settings.connector,
        recordRefusalAsOutstanding: true,
      })
      // o3d-j625 r3 (Codex HIGH 1 family) — THE ANSWER IS READ. The movement and its cost layers are
      // already written, and a non-null return from this function is every caller's success signal
      // (stock actions, stock counts, the import, the WMS stock sync), so a refusal committed the
      // stock change and reported it as done. Worse for a BATCH: `providedSettings` is read once for the
      // whole batch, so every row in the tail can refuse in silence.
      if (postingIsOwed(enqueued)) {
        await reportPostingNotQueued({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: movement.id,
          action: 'inventory_adjustment_journal_not_queued',
          // o3d-j625 r6 (review H4): which site refused, and so whether its row clears itself or is marked handled.
          kind: 'stock_adjustment_journal',
          posting: `the inventory adjustment journal for ${product?.sku ?? productId} at ${warehouse?.name ?? warehouseId}`,
          committed: 'the stock movement and its cost layers are written in IMS',
          remedy:
            'Inventory in the ledger no longer matches IMS by the value of this adjustment. Post the '
            + 'journal by hand.',
          outcome: enqueued,
          metadata: { movementId: movement.id, productId, warehouseId, chartConnector: settings.connector },
          inTransaction: {
            client: tx as unknown as PostingRefusalClient,
            withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
          },
        })
      }
    }
  }

  return {
    movementId: movement.id,
    productSku: product?.sku ?? productId,
    warehouseName: warehouse?.name ?? warehouseId,
  }
}
