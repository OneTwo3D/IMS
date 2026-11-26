import type { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * STOCK ADJUSTMENTS: A REASON WITH AN ACCOUNT, AND A UNIT COST THAT IS NEVER AN AVERAGE (FRS 102 review, owner-approved 2026-11-22).
 *
 * BEHIND A SWITCH. The system setting `stock_adjustment_reason_cost_required` (absent / anything but 'true' = OFF) turns on new
 * refusals on a live operator flow, so it ships off and the owner turns it on at go-live. With it OFF every writer behaves exactly
 * as before: the switch is read and nothing else changes.
 *
 * With it ON, every stock adjustment (single, bulk line, CSV row, stock-count variance, the WMS align-down):
 *   1. must carry an adjustment reason that exists and is active;
 *   2. when the adjustment moves value and the accounting connector would post its journal (the same verdict that, with the
 *      switch off, raises the "post this journal by hand" exception), the reason must have an account and an inventory account
 *      must be mapped. Otherwise it is REFUSED, naming the reason to map, instead of committing a stock change the ledger never
 *      sees;
 *   3. an addition is valued at the unit cost the operator entered (0 only when entered, for genuinely free stock) or, when left
 *      blank, at the unit cost of the product's LATEST cost layer with a non-zero cost in that warehouse, else in any warehouse.
 *      Never at an average. With no such layer it is refused.
 *
 * The in-place edit (updateAdjustmentMovement), with the switch ON: only a plain stock adjustment (no reference) is editable at all (a supplier
 * return, stock-count variance or WMS align-down is refused); an edit that changes the movement's value to the penny while accounting posting
 * applies is refused (reverse and re-enter instead), because an in-place edit cannot post or revise a journal; and a removal edited into an
 * addition is valued at the latest costed layer, never an average, and refused when there is none. Removals keep consuming FIFO layers exactly as before.
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
 * The unit cost of the product's most recently received RECEIPT or PRODUCTION cost layer with a non-zero cost, in this warehouse, else in any
 * warehouse. A consumed layer counts (it is still the latest price paid). Zero-cost layers (samples, free stock) are skipped: a zero is only
 * ever booked when an operator enters it. Exact: the stored 6dp Decimal, never a blend.
 *
 * Only a layer that records what was PAID or what making it COST qualifies (o3d-jwa8m): a purchase receipt (poLineId set) or a production
 * output (productionOrderId set). Excluded, because each carries a figure that is not a fresh price: a transfer's recreated layers (the source
 * layers' old cost, stamped received now), a refund restock (returnMovementId), an adjustment layer (an earlier default would perpetuate
 * itself) and an opening-stock layer (a moving average). A layer for a refund restock or a transfer carries none of the two ids, so it falls out.
 * "Latest" is by receivedAt, ties by the creation sequence (createdSeq), never by the cuid.
 */
export async function getLatestLayerUnitCost(client: LayerReadClient, productId: string, warehouseId: string): Promise<LatestLayerUnitCost | null> {
  const orderBy: Prisma.CostLayerOrderByWithRelationInput[] = [{ receivedAt: 'desc' }, { createdSeq: 'desc' }]
  const qualifying: Prisma.CostLayerWhereInput = {
    unitCostBase: { gt: 0 },
    adjustmentMovementId: null,
    returnMovementId: null,
    isOpeningStock: false,
    OR: [{ poLineId: { not: null } }, { productionOrderId: { not: null } }],
  }
  const inWarehouse = await client.costLayer.findFirst({
    where: { productId, warehouseId, ...qualifying },
    orderBy,
    select: { unitCostBase: true },
  })
  if (inWarehouse) return { unitCostBase: toDecimal(inWarehouse.unitCostBase), source: 'warehouse' }
  const anywhere = await client.costLayer.findFirst({
    where: { productId, ...qualifying },
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

/** Most (product, warehouse) pairs one getAdjustmentDefaultUnitCosts call answers; the bulk dialog asks in chunks of this size. */
export const MAX_DEFAULT_COST_PAIRS = 200

export function defaultCostCapMessage(max: number): string {
  return `Default unit costs can be looked up for at most ${max} product and warehouse pairs at a time. Ask in batches of ${max} or fewer.`
}

/** The in-place edit refused for a movement that is not a plain stock adjustment (switch on). */
export function editNotPlainAdjustmentRefusedMessage(referenceType: string | null): string {
  const kind = referenceType === 'PurchaseReturn' ? 'a supplier return'
    : referenceType === 'StockCount' ? 'a stock-count variance'
    : referenceType === 'WmsSyncJob' ? 'a warehouse sync align-down'
    : 'a movement booked by another process'
  return `This movement is ${kind}, not a plain stock adjustment, so it cannot be edited here. `
    + 'Correct it from where it came from, or enter a compensating stock adjustment.'
}

/** The in-place edit refused because it would change a value the ledger should see (switch on, accounting posting applies). */
export function editChangesValueRefusedMessage(): string {
  return 'This edit would change the value of the adjustment, and an in-place edit cannot post or revise its accounting journal. '
    + 'Reverse this adjustment with a new one of the opposite sign, then enter the correct adjustment with a reason and unit cost.'
}

export function missingReasonMessage(productLabel: string): string {
  return `Choose an adjustment reason for ${productLabel}. Every stock adjustment needs a reason.`
}

export function unmappedReasonMessage(params: { reasonName: string | null; inventoryAccountMapped: boolean; chartRetired?: boolean }): string {
  if (params.chartRetired) {
    // Mapping an account to the reason does not help here: the accounts on file belong to a connector that is no longer active.
    return 'The accounting connector these accounts were set up for is no longer the active one, so this adjustment could not be posted to the ledger. '
      + 'Reconnect it or re-map the reason account and the inventory account for the active connector in the accounting settings first. Nothing was saved.'
  }
  if (!params.inventoryAccountMapped) {
    return 'No inventory account is mapped in the accounting settings, so this adjustment could not be posted to the ledger. '
      + 'Map the inventory account first. Nothing was saved.'
  }
  return `The adjustment reason "${params.reasonName ?? ''}" has no account, so this adjustment could not be posted to the ledger. `
    + `Map an account to "${params.reasonName ?? ''}" in Settings > Adjustment reasons first. Nothing was saved.`
}

/**
 * A movement stores its reason as the note's prefix: "<reason name>" or "<reason name>: <note>". Split it back into the two cells the
 * adjustments CSV import reads (the longest matching reason name wins). A note with no known reason prefix keeps all of it as the note. Pure.
 */
export function splitReasonFromNote(note: string | null | undefined, reasonNames: string[]): { reason: string; note: string } {
  const text = note ?? ''
  let best: string | null = null
  for (const name of reasonNames) {
    if (!name) continue
    if ((text === name || text.startsWith(`${name}: `)) && (best === null || name.length > best.length)) best = name
  }
  if (best === null) return { reason: '', note: text }
  return { reason: best, note: text === best ? '' : text.slice(best.length + 2) }
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
