import type { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * STOCK ADJUSTMENTS: A REASON WITH AN ACCOUNT, AND A UNIT COST THAT IS NEVER AN AVERAGE (FRS 102 review, owner-approved 2026-11-22).
 *
 * BEHIND A SWITCH. The system setting `stock_adjustment_reason_cost_required` (absent / anything but 'true' = OFF) turns on new
 * refusals on a live operator flow, so it ships off and the owner turns it on at go-live. With it OFF every writer behaves exactly
 * as before: the switch is read and nothing else changes.
 *
 * With it ON, every stock adjustment (single, bulk line, CSV row, stock-count variance, the WMS align-down). The in-place
 * edit (updateAdjustmentMovement) is NOT re-judged for reason or account; it only values a removal edited into an addition at the
 * latest costed layer, never an average, and refuses when there is none:
 *   1. must carry an adjustment reason that exists and is active;
 *   2. when the adjustment moves value and the accounting connector would post its journal (the same verdict that, with the
 *      switch off, raises the "post this journal by hand" exception), the reason must have an account and an inventory account
 *      must be mapped. Otherwise it is REFUSED, naming the reason to map, instead of committing a stock change the ledger never
 *      sees;
 *   3. an addition is valued at the unit cost the operator entered (0 only when entered, for genuinely free stock) or, when left
 *      blank, at the unit cost of the product's LATEST cost layer with a non-zero cost in that warehouse, else in any warehouse.
 *      Never at an average. With no such layer it is refused.
 * Removals keep consuming FIFO layers exactly as before.
 */
export const STOCK_ADJUSTMENT_REASON_COST_REQUIRED_KEY = 'stock_adjustment_reason_cost_required'

/** The adjustment reason a stock count posts its variances under when the operator picks none (matched by name, case-insensitive). */
export const STOCK_COUNT_REASON_NAME = 'Stock count'

type SettingReadClient = Pick<Prisma.TransactionClient, 'setting'>

/** Read through the caller's transaction so the switch and the writes it governs are one unit of work. */
export async function readStockAdjustmentReasonCostRequired(client: SettingReadClient): Promise<boolean> {
  const row = await client.setting.findUnique({ where: { key: STOCK_ADJUSTMENT_REASON_COST_REQUIRED_KEY }, select: { value: true } })
  return row?.value === 'true'
}

export type LatestLayerUnitCost = { unitCostBase: Decimal; source: 'warehouse' | 'any_warehouse' }

type LayerReadClient = Pick<Prisma.TransactionClient, 'costLayer'>

/**
 * The unit cost of the product's most recently received cost layer with a non-zero cost, in this warehouse, else in any warehouse.
 * A consumed layer counts (it is still the latest price paid). Zero-cost layers (samples, free stock) are skipped: a zero is only
 * ever booked when an operator enters it. Exact: the stored 6dp Decimal, never a blend.
 */
export async function getLatestLayerUnitCost(client: LayerReadClient, productId: string, warehouseId: string): Promise<LatestLayerUnitCost | null> {
  const orderBy: Prisma.CostLayerOrderByWithRelationInput[] = [{ receivedAt: 'desc' }, { id: 'desc' }]
  const inWarehouse = await client.costLayer.findFirst({
    where: { productId, warehouseId, unitCostBase: { gt: 0 } },
    orderBy,
    select: { unitCostBase: true },
  })
  if (inWarehouse) return { unitCostBase: toDecimal(inWarehouse.unitCostBase), source: 'warehouse' }
  const anywhere = await client.costLayer.findFirst({
    where: { productId, unitCostBase: { gt: 0 } },
    orderBy,
    select: { unitCostBase: true },
  })
  return anywhere ? { unitCostBase: toDecimal(anywhere.unitCostBase), source: 'any_warehouse' } : null
}

/** An explicit cost wins (0 included); a blank defaults to the latest layer cost; neither refuses. Pure. */
export function resolveRequiredAdditionUnitCost(params: {
  explicitUnitCostBase: number | null | undefined
  latest: LatestLayerUnitCost | null
  productLabel: string
}): Decimal {
  const { explicitUnitCostBase, latest, productLabel } = params
  if (explicitUnitCostBase != null) {
    if (!Number.isFinite(explicitUnitCostBase) || explicitUnitCostBase < 0) {
      throw new Error(`Unit cost for ${productLabel} must be zero or greater.`)
    }
    return toDecimal(explicitUnitCostBase)
  }
  if (latest) return latest.unitCostBase
  throw new Error(
    `Enter a unit cost for this addition of ${productLabel}: it has no cost layer with a cost to default to. `
    + 'Use 0 only for genuinely free stock such as samples.',
  )
}

export function missingReasonMessage(productLabel: string): string {
  return `Choose an adjustment reason for ${productLabel}. Every stock adjustment needs a reason.`
}

export function unmappedReasonMessage(params: { reasonName: string | null; inventoryAccountMapped: boolean }): string {
  if (!params.inventoryAccountMapped) {
    return 'No inventory account is mapped in the accounting settings, so this adjustment could not be posted to the ledger. '
      + 'Map the inventory account first. Nothing was saved.'
  }
  return `The adjustment reason "${params.reasonName ?? ''}" has no account, so this adjustment could not be posted to the ledger. `
    + `Map an account to "${params.reasonName ?? ''}" in Settings > Adjustment reasons first. Nothing was saved.`
}

export type ReasonMatchCandidate = { id: string; name: string }

/**
 * Match a CSV `reason` cell to an ACTIVE reason: by name (trimmed, case-insensitive), or by the reason's id. Two active reasons
 * with the same name are ambiguous and refused rather than guessed. Pure.
 */
export function matchAdjustmentReason(
  cell: string | null | undefined,
  reasons: ReasonMatchCandidate[],
): { ok: true; reasonId: string } | { ok: false; message: string } {
  const value = (cell ?? '').trim()
  if (!value) return { ok: false, message: 'missing reason' }
  const byId = reasons.find((r) => r.id === value)
  if (byId) return { ok: true, reasonId: byId.id }
  const needle = value.toLocaleLowerCase('en-GB')
  const byName = reasons.filter((r) => r.name.trim().toLocaleLowerCase('en-GB') === needle)
  if (byName.length === 1) return { ok: true, reasonId: byName[0]!.id }
  if (byName.length > 1) return { ok: false, message: `reason "${value}" matches ${byName.length} active reasons; rename one so each name is unique` }
  return { ok: false, message: `reason "${value}" is not an active adjustment reason` }
}
