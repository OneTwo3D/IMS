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
import { RESERVATION_RELEASING_SHIPMENT_STATUS, residualAllocationRows } from '@/lib/domain/inventory/reservation-residual'

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
  /** Optional so older callers keep their shape; a missing value is read as not set. */
  defaultReturnWarehouse?: boolean
  availableForPurchaseOrders?: boolean
}): string | null {
  if (!params.enabled || !isQuarantineWarehouseType(params.type)) return null
  const flags = quarantineSellableFlags(params)
  if (flags.length === 0) return null
  return `A quarantine warehouse holds stock that is not sellable, so it cannot be marked ${flags.join(', ')}. Clear ${flags.length === 1 ? 'that option' : 'those options'} or choose another type.`
}

/**
 * The flags a quarantine warehouse may not carry. Default return warehouse: storefront refunds restock there with no condition asked, so
 * sellable returns would land in quarantine unseen. Available in purchase orders: a quarantine warehouse takes only unsellable returns and
 * transfers; new purchases received into it would be fresh stock booked as unsellable.
 */
export function quarantineSellableFlags(params: {
  availableForSale: boolean
  syncToStore: boolean
  isDefault: boolean
  defaultReturnWarehouse?: boolean
  availableForPurchaseOrders?: boolean
}): string[] {
  return [
    params.availableForSale ? 'Available for sale' : null,
    params.syncToStore ? 'Sync to store' : null,
    params.isDefault ? 'Default warehouse' : null,
    params.defaultReturnWarehouse ? 'Default return warehouse' : null,
    params.availableForPurchaseOrders ? 'Available in purchase orders' : null,
  ].filter((flag): flag is string => flag != null)
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

export const QUARANTINE_IN_TRANSIT_EXPECTED_REFUSAL =
  'Returns in transit are on, so this refund restocks nothing now: the units come back when the parcel is restocked from the returns inbox, and that is where their condition is asked. Choose an ordinary return warehouse (not a quarantine one). Nothing was recorded.'

export const QUARANTINE_PRODUCTION_REFUSAL =
  'That warehouse is a quarantine warehouse: its stock is not sellable and cannot be used in a production order. Transfer the units to a sellable warehouse first if they can be used.'

export const QUARANTINE_REORDER_REFUSAL =
  'That warehouse is a quarantine warehouse: it holds unsellable stock and cannot receive a reorder. Choose a sellable warehouse.'

type WarehouseTypeReader = {
  setting: SettingReader['setting']
  warehouse: { findUnique(args: { where: { id: string }; select: { type: true } }): Promise<{ type: string } | null> }
}

/** True only with the switch on and a QUARANTINE-type warehouse: the caller then refuses to put sellable work there. */
export async function isQuarantineTargetWarehouse(client: WarehouseTypeReader, warehouseId: string): Promise<boolean> {
  if (!(await readReturnConditionCheckEnabled(client))) return false
  const warehouse = await client.warehouse.findUnique({ where: { id: warehouseId }, select: { type: true } })
  return isQuarantineWarehouseType(warehouse?.type)
}

/**
 * Owner ruling (2026-11-27): quarantine is kept in IMS only. A warehouse-system (3PL) return is physically at the 3PL, where the
 * warehouse system still counts it: booking it into an IMS-only quarantine warehouse would hold the unit twice once stock alignment
 * (ALIGN_TO_WMS) books the warehouse system's count into the bound warehouse. So with the switch on an UNSELLABLE returns-inbox restock
 * is always refused.
 */
export const WMS_UNSELLABLE_RETURN_REFUSAL =
  'This return is at the 3PL warehouse, and quarantine is kept in IMS only: the warehouse system would still count the unit, and stock alignment would book it into the bound warehouse a second time. Restock it as Sellable into the bound warehouse instead (that also clears a return in transit), ask the 3PL to write it off or hold it out of sellable stock, then write it off in IMS with a stock adjustment in that warehouse (a reason mapped to your write-off account). Nothing was recorded.'

/** The rule for the warehouse-system (WMS) returns-inbox restock: the general rule, except that an unsellable unit held at the 3PL is never quarantined. Pure. */
export function wmsReturnRestockRefusal(params: {
  enabled: boolean
  condition: ReturnCondition | null
  warehouse: { code: string; type: string | null }
}): string | null {
  if (params.enabled && params.condition === 'UNSELLABLE') return WMS_UNSELLABLE_RETURN_REFUSAL
  return returnConditionRestockRefusal(params)
}

type QuarantineCensusClient = Pick<Prisma.TransactionClient, 'externalWmsBinding' | 'orderAllocation' | 'shipment' | 'shipmentLine' | 'productionOrder' | 'stockTransfer' | 'purchaseOrder'>

export type QuarantineBlockers = {
  wmsBindings: number
  allocations: number
  openShipments: number
  openProductionOrders: number
  inboundTransfers: number
  openPurchaseOrders: number
}

/** Purchase orders still to be received (not received, closed, invoiced, returned or cancelled). */
const OPEN_PURCHASE_ORDER_STATUSES = ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'] as const

/**
 * Open allocations in a warehouse: allocation rows whose RESIDUAL (qty less what SHIPPED shipments of the same line, warehouse and product
 * dispatched; lib/domain/inventory/reservation-residual.ts) is still above zero. Allocation rows survive dispatch, so counting raw rows would
 * call every warehouse that ever shipped "allocated".
 */
export async function countOpenAllocations(
  client: Pick<Prisma.TransactionClient, 'orderAllocation' | 'shipmentLine'>,
  warehouseId: string,
): Promise<number> {
  const allocations = await client.orderAllocation.findMany({
    where: { warehouseId, qty: { gt: 0 } },
    select: { lineId: true, productId: true, warehouseId: true, qty: true },
  })
  if (allocations.length === 0) return 0
  const lines = await client.shipmentLine.findMany({
    where: {
      lineId: { in: [...new Set(allocations.map((a) => a.lineId))] },
      shipment: { warehouseId, status: RESERVATION_RELEASING_SHIPMENT_STATUS },
    },
    select: { lineId: true, productId: true, qty: true, shipment: { select: { warehouseId: true } } },
  })
  const dispatched = lines.map((line) => ({ lineId: line.lineId, productId: line.productId, warehouseId: line.shipment.warehouseId, qty: line.qty }))
  return residualAllocationRows(allocations, dispatched).filter((row) => row.qty.gt(0)).length
}

/**
 * Sellable work that points at a warehouse: a warehouse-system binding, open (residual) allocations, shipments not yet shipped, open
 * production orders, purchase orders still to be received there and, for a TYPE CHANGE only, transfers in transit into it (moving damaged
 * stock into an existing quarantine warehouse is the normal route, so the switch-on census leaves them out). Each count is exact.
 */
export async function loadQuarantineBlockers(
  client: QuarantineCensusClient,
  warehouseId: string,
  options: { inboundTransfers?: boolean } = { inboundTransfers: true },
): Promise<QuarantineBlockers> {
  const [wmsBindings, allocations, openShipments, openProductionOrders, inboundTransfers, openPurchaseOrders] = await Promise.all([
    client.externalWmsBinding.count({ where: { warehouseId } }),
    countOpenAllocations(client, warehouseId),
    client.shipment.count({ where: { warehouseId, status: { in: ['PENDING', 'PICKING', 'PACKED'] } } }),
    client.productionOrder.count({ where: { warehouseId, status: { in: ['DRAFT', 'IN_PROGRESS'] } } }),
    options.inboundTransfers === false ? Promise.resolve(0) : client.stockTransfer.count({ where: { toWarehouseId: warehouseId, status: 'IN_TRANSIT' } }),
    client.purchaseOrder.count({ where: { destinationWarehouseId: warehouseId, status: { in: [...OPEN_PURCHASE_ORDER_STATUSES] } } }),
  ])
  return { wmsBindings, allocations, openShipments, openProductionOrders, inboundTransfers, openPurchaseOrders }
}

export function quarantineBlockerParts(blockers: QuarantineBlockers): string[] {
  return [
    blockers.wmsBindings > 0 ? `${blockers.wmsBindings} warehouse-system binding(s)` : null,
    blockers.allocations > 0 ? `${blockers.allocations} open allocation(s)` : null,
    blockers.openShipments > 0 ? `${blockers.openShipments} shipment(s) not yet shipped` : null,
    blockers.openProductionOrders > 0 ? `${blockers.openProductionOrders} open production order(s)` : null,
    blockers.inboundTransfers > 0 ? `${blockers.inboundTransfers} transfer(s) in transit into it` : null,
    blockers.openPurchaseOrders > 0 ? `${blockers.openPurchaseOrders} purchase order(s) still to be received there` : null,
  ].filter((part): part is string => part != null)
}

/** The refusal for turning a warehouse INTO a quarantine warehouse while it still carries sellable work, or null. Pure. */
export function quarantineTypeChangeRefusal(blockers: QuarantineBlockers): string | null {
  const parts = quarantineBlockerParts(blockers)
  if (parts.length === 0) return null
  return `This warehouse cannot become a quarantine warehouse while it has ${parts.join(', ')}: its stock would stop being sellable under them. Finish, move or release them first (and remove the binding), then change the type.`
}

/**
 * The refusal for turning a quarantine warehouse into an ordinary one while it holds stock (switch on): its units would become sellable
 * without anyone deciding so. Pure; null when it holds none.
 */
export function quarantineLeaveRefusal(onHandQty: Prisma.Decimal | number): string | null {
  const qty = typeof onHandQty === 'number' ? onHandQty : onHandQty.toNumber()
  if (!(qty > 0)) return null
  return `This quarantine warehouse still holds ${qty} unit(s) of unsellable stock, which would become sellable if its type changed. Empty it first: write units off with a stock adjustment (a reason mapped to your write-off account), or transfer the ones that can be sold to a sellable warehouse. Then change the type.`
}

export type QuarantineWarehouseIssue = {
  id: string
  code: string
  name: string
  /** The sellable flags still set on it, and the open allocations still pointing at it. */
  problems: string[]
}

/**
 * Every quarantine warehouse that is not clean for the switch: a sellable flag still set (available for sale, sync to store,
 * default) or open allocations against its stock. Shown with the switch's status so turning it on is never blind.
 */
export async function listQuarantineWarehouseIssues(
  client: Pick<Prisma.TransactionClient, 'warehouse'> & QuarantineCensusClient,
): Promise<QuarantineWarehouseIssue[]> {
  const warehouses = await client.warehouse.findMany({
    where: { type: QUARANTINE_WAREHOUSE_TYPE },
    select: { id: true, code: true, name: true, availableForSale: true, syncToStore: true, isDefault: true, defaultReturnWarehouse: true, availableForPurchaseOrders: true },
    orderBy: { code: 'asc' },
  })
  const issues: QuarantineWarehouseIssue[] = []
  for (const w of warehouses) {
    const problems = [
      ...quarantineSellableFlags(w).map((flag) => `marked ${flag}`),
      ...quarantineBlockerParts(await loadQuarantineBlockers(client, w.id, { inboundTransfers: false })),
    ]
    if (problems.length > 0) issues.push({ id: w.id, code: w.code, name: w.name, problems })
  }
  return issues
}

/** The turn-on interlock of the switch: refused while any quarantine warehouse is not clean. Run in the dry run and inside the write. */
export async function quarantineSwitchOnRefusal(
  client: Pick<Prisma.TransactionClient, 'warehouse'> & QuarantineCensusClient,
): Promise<string | null> {
  const issues = await listQuarantineWarehouseIssues(client)
  if (issues.length === 0) return null
  return `return_condition_check_enabled cannot be turned on while a quarantine warehouse still looks sellable: ${issues.map((i) => `${i.code} (${i.problems.join('; ')})`).join(' | ')}. Fix them (Inventory Settings, Warehouses; release or move the work) and try again. Nothing was written.`
}

export const WMS_UNSELLABLE_REFUND_REFUSAL =
  'These units shipped from a 3PL warehouse (bound to the warehouse system), so they go back to the 3PL, and quarantine is kept in IMS only: the warehouse system would count them again and stock alignment would book them into the bound warehouse a second time. Record the refund as Sellable into that warehouse, ask the 3PL to write the unit off or hold it out of sellable stock, then write it off in IMS with a stock adjustment there (a reason mapped to your write-off account); or record the refund with no stock return. Nothing was recorded.'

/**
 * The refund dialog's counterpart of the returns-inbox rule: units that shipped from a warehouse bound to a warehouse system (or an
 * order the warehouse system holds, a SYNCED push link) come back to that 3PL, where the warehouse system counts them again. With the
 * switch on, such an UNSELLABLE return cannot be quarantined in IMS (quarantine is IMS-only): the same refusal as the inbox.
 * `lineIds` are the refunded order lines; null means some refund line names no order line, so every shipment of the order counts.
 */
export async function refundReturnsToWmsWarehouse(
  client: Pick<Prisma.TransactionClient, 'wmsOrderPushLink' | 'shipment'>,
  params: { orderId: string; lineIds: readonly string[] | null },
): Promise<boolean> {
  const link = await client.wmsOrderPushLink.findFirst({ where: { orderId: params.orderId, state: 'SYNCED' }, select: { id: true } })
  if (link) return true
  const bound = await client.shipment.findFirst({
    where: {
      orderId: params.orderId,
      status: { not: 'PENDING' },
      warehouse: { wmsBindings: { some: {} } },
      ...(params.lineIds ? { lines: { some: { lineId: { in: [...params.lineIds] } } } } : {}),
    },
    select: { id: true },
  })
  return bound != null
}
