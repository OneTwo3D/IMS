import type { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings } from '@/lib/accounting'
import { enabledWmsConnectorIds } from '@/lib/connectors/wms/enabled-connector'
import { readStockAdjustmentReasonCostRequired } from '@/lib/domain/inventory/stock-adjustment-policy'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import {
  combineWmsWriteOffRoutes,
  wmsWriteOffRoute,
  type WmsBindingWriteOffFacts,
  type WmsWriteOffRoute,
} from '@/lib/domain/inventory/wms-unsellable-advice'

/**
 * THE SERVER SIDE OF THE 3PL WRITE-OFF ROUTE (see wms-unsellable-advice.ts): reads, for the warehouse(s) a returned unit is at, every
 * warehouse-system binding with what decides whether its align-down can write the unit off. The refusals (returns inbox, refund dialog) and
 * the restock dialog's hint (the dashboard hands it the route per warehouse) all go through `loadWmsWriteOffRoute`, so they cannot disagree.
 *
 * Static facts only: a per-product hold the align-down plan can still apply at run time (a delta beyond the thresholds, reservations, open
 * goods-in, a despatch in flight, the persistence wait) is named in the ALIGNED advice instead.
 */

export const WRITE_OFF_ROUTE_BINDING_SELECT = {
  connector: true,
  active: true,
  stockSyncMode: true,
  alignmentConfirmedAt: true,
  discrepancyThresholds: true,
  alignDownReason: { select: { active: true, accountCode: true } },
  connection: { select: { active: true } },
} as const

type BindingRow = {
  connector: string
  active: boolean
  stockSyncMode: string
  alignmentConfirmedAt: Date | null
  discrepancyThresholds: Prisma.JsonValue | null
  alignDownReason: { active: boolean; accountCode: string | null } | null
  connection: { active: boolean }
}

/** The binding's discrepancy thresholds are configured (either cap set to a number), as the align-down plan requires. */
export function thresholdsConfigured(value: Prisma.JsonValue | null | undefined): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const isNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
  return isNumber(record.absoluteDelta) || isNumber(record.percentDelta)
}

/** The facts of one binding. `enabledConnectors` are the warehouse-system plugins switched on: a binding of a disabled one aligns nothing. */
export function bindingWriteOffFacts(binding: BindingRow, enabledConnectors: readonly string[], inventoryAccountMissing: boolean): WmsBindingWriteOffFacts {
  return {
    stockSyncMode: binding.stockSyncMode,
    active: binding.active,
    connectionActive: binding.connection.active && enabledConnectors.includes(binding.connector),
    alignmentConfirmed: binding.alignmentConfirmedAt != null,
    alignDownReason: binding.alignDownReason,
    thresholdsConfigured: thresholdsConfigured(binding.discrepancyThresholds),
    inventoryAccountMissing,
  }
}

/**
 * The reason-cost rule holds an align-down write-off while no inventory account is mapped and an accounting connector is set (the
 * conservative reading of stock-sync's hold: it also needs a non-zero value, which is not known before the unit is restocked).
 */
async function readInventoryAccountMissing(client: Pick<Prisma.TransactionClient, 'setting'>): Promise<boolean> {
  if (!(await readStockAdjustmentReasonCostRequired(client))) return false
  const accounting = await getAccountingSettings()
  return Boolean(accounting.connector) && !accounting.inventoryAccount
}

/** The write-off route for a unit at these warehouses: the route their bindings agree on, else UNKNOWN (also with no binding). */
export async function loadWmsWriteOffRoute(
  client: Pick<Prisma.TransactionClient, 'externalWmsBinding' | 'setting'>,
  warehouseIds: readonly (string | null | undefined)[],
): Promise<WmsWriteOffRoute> {
  const ids = [...new Set(warehouseIds.filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return { mode: 'UNKNOWN' }
  const bindings = await client.externalWmsBinding.findMany({ where: { warehouseId: { in: ids } }, select: WRITE_OFF_ROUTE_BINDING_SELECT }) as BindingRow[]
  if (bindings.length === 0) return { mode: 'UNKNOWN' }
  const enabled = enabledWmsConnectorIds(await getIntegrationPluginState())
  const inventoryAccountMissing = bindings.some((b) => b.stockSyncMode === 'ALIGN_TO_WMS') ? await readInventoryAccountMissing(client) : false
  return combineWmsWriteOffRoutes(bindings.map((b) => wmsWriteOffRoute(bindingWriteOffFacts(b, enabled, inventoryAccountMissing))))
}
