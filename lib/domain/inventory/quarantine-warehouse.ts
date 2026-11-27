/**
 * RETURN CONDITION CHECK AND THE QUARANTINE WAREHOUSE (FRS 102 s13.4: stock at the lower of cost and estimated selling price).
 *
 * The switch `return_condition_check_enabled` (off by default). With it off nothing here changes anything: every reader below
 * answers exactly as before and the return paths record no condition.
 *
 * With it on:
 *  - A warehouse whose type is QUARANTINE (the existing `Warehouse.type` value, no new column) holds stock that is NOT SELLABLE:
 *    it is never allocated to an order (automatic or manual), never counted as available (product stock, reorder planning,
 *    dashboards) and never pushed to the storefront. It cannot be bound to a warehouse system (WMS), so nothing in it is ever
 *    reported to one as sellable, and its sellable flags (available for sale, sync to store, default warehouse) are refused.
 *  - Every operator restock of a customer return states the condition of the returned items: SELLABLE units go to an
 *    ordinary warehouse, UNSELLABLE units to a quarantine warehouse. The stock comes back exactly as before, at its return
 *    cost layer and with the same journal: only the warehouse differs, so restocking into quarantine moves no value.
 *  - The quarantine is reviewed with the existing flows: an ADJUSTMENT with a reason mapped to a write-off account writes the
 *    units off (FIFO cost, Dr the reason's account / Cr Inventory), and a TRANSFER to a sellable warehouse puts them back in
 *    stock (the transfer moves the FIFO layers at their cost).
 *
 * The condition is a property of the restock, enforced against the warehouse chosen for it: an unsellable return into a
 * sellable warehouse, or a sellable return into quarantine, is refused, so the warehouse a unit sits in always says whether
 * it may be sold.
 */
import type { Prisma } from '@/app/generated/prisma/client'

export const RETURN_CONDITION_CHECK_SETTING_KEY = 'return_condition_check_enabled'

export const QUARANTINE_WAREHOUSE_TYPE = 'QUARANTINE' as const

export const RETURN_CONDITIONS = ['SELLABLE', 'UNSELLABLE'] as const
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number]

export function returnConditionCheckEnabledFromSetting(value: string | null | undefined): boolean {
  return value === 'true'
}

type SettingReader = { setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> } }

/** Reads the switch. A client without a settings table (a narrow test double) reads as off. */
export async function readReturnConditionCheckEnabled(client: unknown): Promise<boolean> {
  const reader = client as Partial<SettingReader> | null | undefined
  if (!reader?.setting?.findUnique) return false
  const row = await reader.setting.findUnique({ where: { key: RETURN_CONDITION_CHECK_SETTING_KEY }, select: { value: true } })
  return returnConditionCheckEnabledFromSetting(row?.value)
}

export function isQuarantineWarehouseType(type: string | null | undefined): boolean {
  return type === QUARANTINE_WAREHOUSE_TYPE
}

export function parseReturnCondition(value: unknown): ReturnCondition | null {
  return value === 'SELLABLE' || value === 'UNSELLABLE' ? value : null
}

/**
 * A Prisma `Warehouse` filter for the SELLABLE warehouses: with the switch on it leaves quarantine out, with it off it is
 * empty, so a query spread with it is the query of before.
 */
export function sellableWarehouseWhere(enabled: boolean): Prisma.WarehouseWhereInput {
  return enabled ? { type: { not: QUARANTINE_WAREHOUSE_TYPE } } : {}
}

/** The same filter for a `StockLevel` (or any row with a `warehouse` relation). */
export function sellableStockLevelWhere(enabled: boolean): { warehouse?: Prisma.WarehouseWhereInput } {
  return enabled ? { warehouse: sellableWarehouseWhere(true) } : {}
}

export const RETURN_CONDITION_MISSING_REFUSAL =
  'State the condition of the returned items (sellable or unsellable) before restocking them. Nothing was recorded.'

export function returnConditionWarehouseRefusal(condition: ReturnCondition, warehouse: { code: string }): string {
  return condition === 'UNSELLABLE'
    ? `Unsellable returned items go to a quarantine warehouse, and ${warehouse.code} is not one. Choose the quarantine warehouse, or mark the items sellable. Nothing was recorded.`
    : `${warehouse.code} is a quarantine warehouse: its stock is not sellable. Choose an ordinary warehouse for sellable returned items, or mark them unsellable. Nothing was recorded.`
}

/**
 * THE ONE RULE for a restock of returned items: may `condition` go into `warehouse`? Pure.
 * Returns null when it may (always, with the switch off), else the operator's refusal.
 */
export function returnConditionRestockRefusal(params: {
  enabled: boolean
  condition: ReturnCondition | null
  warehouse: { code: string; type: string | null }
}): string | null {
  if (!params.enabled) return null
  if (!params.condition) return RETURN_CONDITION_MISSING_REFUSAL
  const quarantine = isQuarantineWarehouseType(params.warehouse.type)
  if (params.condition === 'UNSELLABLE' && !quarantine) return returnConditionWarehouseRefusal('UNSELLABLE', params.warehouse)
  if (params.condition === 'SELLABLE' && quarantine) return returnConditionWarehouseRefusal('SELLABLE', params.warehouse)
  return null
}

/**
 * Warehouse settings: with the switch on, a quarantine warehouse may not carry a flag that makes its stock sellable. Pure;
 * null when the settings are acceptable.
 */
export function quarantineWarehouseSettingsRefusal(params: {
  enabled: boolean
  type: string
  availableForSale: boolean
  syncToStore: boolean
  isDefault: boolean
}): string | null {
  if (!params.enabled || !isQuarantineWarehouseType(params.type)) return null
  const flags = [
    params.availableForSale ? 'Available for sale' : null,
    params.syncToStore ? 'Sync to store' : null,
    params.isDefault ? 'Default warehouse' : null,
  ].filter((flag): flag is string => flag != null)
  if (flags.length === 0) return null
  return `A quarantine warehouse holds stock that is not sellable, so it cannot be marked ${flags.join(', ')}. Clear ${flags.length === 1 ? 'that option' : 'those options'} or choose another type.`
}

export const QUARANTINE_ALLOCATION_REFUSAL =
  'That warehouse is a quarantine warehouse: its stock is not sellable and cannot be allocated to an order. Transfer the units to a sellable warehouse first if they can be sold.'

export const QUARANTINE_WMS_BINDING_REFUSAL =
  'A quarantine warehouse cannot be bound to a warehouse system: its stock is not sellable and is kept in IMS only.'

/**
 * Quarantine stock per product (the switch on), for readers that subtract it from what is available. Empty with the
 * switch off, and without a query.
 */
export async function loadQuarantineQtyByProduct(
  client: { stockLevel: Prisma.TransactionClient['stockLevel'] },
  enabled: boolean,
  /** The products to read, or null for every product. */
  productIds: readonly string[] | null,
): Promise<Map<string, Prisma.Decimal>> {
  const out = new Map<string, Prisma.Decimal>()
  if (!enabled || productIds?.length === 0) return out
  const rows = await client.stockLevel.groupBy({
    by: ['productId'],
    where: { ...(productIds ? { productId: { in: [...productIds] } } : {}), warehouse: { type: QUARANTINE_WAREHOUSE_TYPE } },
    _sum: { quantity: true },
  })
  for (const row of rows) {
    const qty = row._sum?.quantity
    if (qty != null && !qty.isZero()) out.set(row.productId, qty)
  }
  return out
}
