import type { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings } from '@/lib/accounting'
import { enabledWmsConnectorIds } from '@/lib/connectors/wms/enabled-connector'
import { readStockAdjustmentReasonCostRequired } from '@/lib/domain/inventory/stock-adjustment-policy'
import { cronEnablementKeys, resolveCronEnablement } from '@/lib/domain/settings/cron-enablement'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import {
  combineWmsWriteOffRoutes,
  wmsWriteOffRoute,
  type WmsBindingWriteOffFacts,
  type WmsWriteOffRoute,
} from '@/lib/domain/inventory/wms-unsellable-advice'

/**
 * THE SERVER SIDE OF THE 3PL WRITE-OFF ROUTE (see wms-unsellable-advice.ts): for the warehouse(s) a returned unit is at, every
 * warehouse-system binding with what decides whether its align-down can write the unit off. The refusals (returns inbox, refund dialog) use
 * `loadWmsWriteOffRoute`; the dashboard (the restock dialog's hint) uses `writeOffRoutesByWarehouseCode` over the bindings it already holds.
 * Both resolve each binding through `routeForBinding` with a context read ONCE (`loadWriteOffRouteContext`), so they cannot disagree.
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

export type WriteOffRouteBinding = {
  connector: string
  active: boolean
  stockSyncMode: string
  alignmentConfirmedAt: Date | null
  discrepancyThresholds: Prisma.JsonValue | null
  alignDownReason: { active: boolean; accountCode: string | null } | null
  connection: { active: boolean }
}

/** What every binding's route is read against, read once. */
export type WriteOffRouteContext = {
  enabledConnectors: readonly string[]
  inventoryAccountMissing: boolean
  /** Per connector: its stock-sync cron (`<connector>-stock-sync`) is enabled. A job that is not registered reads as not scheduled. */
  stockSyncScheduled: Readonly<Record<string, boolean>>
}

/** The binding's discrepancy thresholds are configured (either cap set to a number), as the align-down plan requires. */
export function thresholdsConfigured(value: Prisma.JsonValue | null | undefined): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const isNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
  return isNumber(record.absoluteDelta) || isNumber(record.percentDelta)
}

/** The facts of one binding against the context. Pure. */
export function bindingWriteOffFacts(binding: WriteOffRouteBinding, context: WriteOffRouteContext): WmsBindingWriteOffFacts {
  return {
    stockSyncMode: binding.stockSyncMode,
    active: binding.active,
    connectionActive: binding.connection.active && context.enabledConnectors.includes(binding.connector),
    alignmentConfirmed: binding.alignmentConfirmedAt != null,
    alignDownReason: binding.alignDownReason,
    thresholdsConfigured: thresholdsConfigured(binding.discrepancyThresholds),
    inventoryAccountMissing: context.inventoryAccountMissing,
    stockSyncScheduled: context.stockSyncScheduled[binding.connector] === true,
  }
}

export function routeForBinding(binding: WriteOffRouteBinding, context: WriteOffRouteContext): WmsWriteOffRoute {
  return wmsWriteOffRoute(bindingWriteOffFacts(binding, context))
}

/** The stock-sync cron slug of a warehouse-system connector (its connector module registers `<id>-stock-sync`). */
export function stockSyncCronSlug(connector: string): string {
  return `${connector}-stock-sync`
}

/**
 * Read the context ONCE for these connectors: the plugin state (unless the caller holds it), the reason-cost rule with the accounting
 * inventory account, and each connector's stock-sync cron enablement (registry default included).
 */
export async function loadWriteOffRouteContext(
  client: Pick<Prisma.TransactionClient, 'setting'>,
  connectors: readonly string[],
  options: { enabledConnectors?: readonly string[] } = {},
): Promise<WriteOffRouteContext> {
  const enabledConnectors = options.enabledConnectors ?? enabledWmsConnectorIds(await getIntegrationPluginState())
  let inventoryAccountMissing = false
  if (await readStockAdjustmentReasonCostRequired(client)) {
    const accounting = await getAccountingSettings()
    inventoryAccountMissing = Boolean(accounting.connector) && !accounting.inventoryAccount
  }
  const { getAllCronJobs } = await import('@/lib/cron-jobs')
  const jobs = getAllCronJobs()
  const wanted = [...new Set(connectors)].map((connector) => ({ connector, job: jobs.find((j) => j.slug === stockSyncCronSlug(connector)) }))
  const keys = wanted.flatMap(({ job }) => {
    if (!job) return []
    const { canonicalKey, legacyKey } = cronEnablementKeys(job)
    return legacyKey ? [canonicalKey, legacyKey] : [canonicalKey]
  })
  const rows = keys.length > 0 ? await client.setting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } }) : []
  const values = new Map(rows.map((row) => [row.key, row.value]))
  const stockSyncScheduled: Record<string, boolean> = {}
  for (const { connector, job } of wanted) {
    if (!job) { stockSyncScheduled[connector] = false; continue }
    const { canonicalKey, legacyKey } = cronEnablementKeys(job)
    stockSyncScheduled[connector] = resolveCronEnablement({
      canonical: values.get(canonicalKey),
      legacy: legacyKey ? values.get(legacyKey) : undefined,
      hasLegacyKey: legacyKey != null,
      defaultEnabled: job.defaultEnabled,
    })
  }
  return { enabledConnectors, inventoryAccountMissing, stockSyncScheduled }
}

/** The write-off route for a unit at these warehouses: the route their bindings agree on, else UNKNOWN (also with no binding). */
export async function loadWmsWriteOffRoute(
  client: Pick<Prisma.TransactionClient, 'externalWmsBinding' | 'setting'>,
  warehouseIds: readonly (string | null | undefined)[],
): Promise<WmsWriteOffRoute> {
  const ids = [...new Set(warehouseIds.filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return { mode: 'UNKNOWN' }
  const bindings = await client.externalWmsBinding.findMany({ where: { warehouseId: { in: ids } }, select: WRITE_OFF_ROUTE_BINDING_SELECT }) as WriteOffRouteBinding[]
  if (bindings.length === 0) return { mode: 'UNKNOWN' }
  const context = await loadWriteOffRouteContext(client, bindings.map((b) => b.connector))
  return combineWmsWriteOffRoutes(bindings.map((b) => routeForBinding(b, context)))
}

/**
 * The dashboard's batch: the route per bound warehouse code over bindings already fetched, the context read once. A failing read never
 * breaks the dashboard: every code then reads UNKNOWN (both routes).
 */
export async function writeOffRoutesByWarehouseCode(
  client: Pick<Prisma.TransactionClient, 'setting'>,
  bindings: ReadonlyArray<WriteOffRouteBinding & { warehouse: { code: string } }>,
  enabledConnectors: readonly string[],
): Promise<Record<string, WmsWriteOffRoute>> {
  const codes = [...new Set(bindings.map((b) => b.warehouse.code))]
  try {
    const context = await loadWriteOffRouteContext(client, bindings.map((b) => b.connector), { enabledConnectors })
    return Object.fromEntries(codes.map((code) => [code, combineWmsWriteOffRoutes(bindings.filter((b) => b.warehouse.code === code).map((b) => routeForBinding(b, context)))]))
  } catch {
    return Object.fromEntries(codes.map((code) => [code, { mode: 'UNKNOWN' as const }]))
  }
}
