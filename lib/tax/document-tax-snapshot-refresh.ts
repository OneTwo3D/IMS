import { Prisma } from '@/app/generated/prisma/client'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

const MUTABLE_SALES_TAX_STATUSES = ['DRAFT'] as const
const MUTABLE_PURCHASE_TAX_STATUSES = ['DRAFT'] as const
const TAX_TOTAL_UPDATE_CHUNK_SIZE = 1000

type TaxSnapshotClient = Pick<Prisma.TransactionClient, 'salesOrderLine' | 'purchaseOrderLine' | 'activityLog' | '$queryRaw' | '$executeRaw'>

type TaxRateSnapshot = {
  id: string
  name: string
  rate: DecimalInput
}

type Delta = {
  subtotalForeign: Decimal
  subtotalBase: Decimal
  taxForeign: Decimal
  taxBase: Decimal
}

type SalesLineInput = {
  qty: DecimalInput
  unitPriceForeign: DecimalInput
  discountAmount: DecimalInput
  fxRateToBase: DecimalInput
  pricesIncludeVat: boolean
  taxRateValue: DecimalInput
}

type PurchaseLineInput = {
  totalForeign: DecimalInput
  fxRateToBase: DecimalInput
  taxRateValue: DecimalInput
}

export function calculateSalesLineTaxSnapshot(input: SalesLineInput) {
  const fxRate = toDecimal(input.fxRateToBase)
  const taxRate = toDecimal(input.taxRateValue)
  const grossAfterDiscount = maxZero(toDecimal(input.qty).mul(toDecimal(input.unitPriceForeign)).sub(toDecimal(input.discountAmount)))
  const netForeign = input.pricesIncludeVat && taxRate.gt(0)
    ? grossAfterDiscount.div(toDecimal(1).add(taxRate))
    : grossAfterDiscount
  const taxForeign = input.pricesIncludeVat && taxRate.gt(0)
    ? grossAfterDiscount.sub(netForeign)
    : netForeign.mul(taxRate)

  const totalForeign = round4(netForeign)
  const taxForeignRounded = round4(taxForeign)
  return {
    totalForeign,
    totalBase: round4(totalForeign.div(fxRate)),
    taxForeign: taxForeignRounded,
    taxBase: round4(taxForeignRounded.div(fxRate)),
  }
}

export function calculatePurchaseLineTaxSnapshot(input: PurchaseLineInput) {
  const fxRate = toDecimal(input.fxRateToBase)
  const taxForeign = round4(toDecimal(input.totalForeign).mul(toDecimal(input.taxRateValue)))
  return {
    taxForeign,
    taxBase: round4(taxForeign.div(fxRate)),
  }
}

export async function refreshMutableDocumentTaxSnapshotsForRate(
  client: TaxSnapshotClient,
  input: {
    oldRate: TaxRateSnapshot
    newRate: TaxRateSnapshot
  },
): Promise<{ salesOrders: number; salesLines: number; purchaseOrders: number; purchaseLines: number }> {
  const newRate = toDecimal(input.newRate.rate)
  const salesResult = await refreshMutableSalesOrderTaxSnapshots(client, input.oldRate, input.newRate, newRate)
  const purchaseResult = await refreshMutablePurchaseOrderTaxSnapshots(client, input.oldRate, input.newRate, newRate)

  const summary = {
    salesOrders: salesResult.orders,
    salesLines: salesResult.lines,
    purchaseOrders: purchaseResult.orders,
    purchaseLines: purchaseResult.lines,
  }
  if (summary.salesLines > 0 || summary.purchaseLines > 0) {
    await client.activityLog.create({
      data: {
        entityType: 'SETTING',
        entityId: input.newRate.id,
        action: 'tax_rate_snapshot_refresh',
        tag: 'settings',
        level: 'INFO',
        description: `Refreshed mutable document tax snapshots for ${input.newRate.name}`,
        metadata: {
          oldRateName: input.oldRate.name,
          oldRate: toDecimal(input.oldRate.rate).toString(),
          newRateName: input.newRate.name,
          newRate: newRate.toString(),
          ...summary,
        },
      },
    })
  }

  return summary
}

async function refreshMutableSalesOrderTaxSnapshots(
  client: TaxSnapshotClient,
  oldRate: TaxRateSnapshot,
  newRateSnapshot: TaxRateSnapshot,
  newRate: Decimal,
) {
  const lines = await client.salesOrderLine.findMany({
    where: {
      taxRateId: oldRate.id,
      order: { status: { in: [...MUTABLE_SALES_TAX_STATUSES] } },
    },
    select: {
      id: true,
      orderId: true,
      qty: true,
      unitPriceForeign: true,
      discountAmount: true,
      taxForeign: true,
      taxBase: true,
      totalForeign: true,
      totalBase: true,
      order: {
        select: {
          id: true,
          fxRateToBase: true,
          pricesIncludeVat: true,
          taxRateName: true,
        },
      },
    },
  })
  const lockedOrderIds = await lockMutableSalesOrders(client, unique(lines.map((line) => line.orderId)))
  const deltas = new Map<string, Delta & { updateHeader: boolean }>()
  const updates: Array<{
    id: string
    next: ReturnType<typeof calculateSalesLineTaxSnapshot>
  }> = []

  for (const line of lines) {
    if (!lockedOrderIds.has(line.orderId)) continue
    const next = calculateSalesLineTaxSnapshot({
      qty: line.qty,
      unitPriceForeign: line.unitPriceForeign,
      discountAmount: line.discountAmount,
      fxRateToBase: line.order.fxRateToBase,
      pricesIncludeVat: line.order.pricesIncludeVat,
      taxRateValue: newRate,
    })
    updates.push({ id: line.id, next })
    addDelta(deltas, line.orderId, {
      subtotalForeign: next.totalForeign.sub(line.totalForeign),
      subtotalBase: next.totalBase.sub(line.totalBase),
      taxForeign: next.taxForeign.sub(line.taxForeign),
      taxBase: next.taxBase.sub(line.taxBase),
    }, line.order.taxRateName === oldRate.name)
  }

  await updateSalesTaxLines(client, updates)

  await updateSalesOrderTaxTotals(client, deltas, newRateSnapshot, newRate)

  return { orders: deltas.size, lines: updates.length }
}

async function refreshMutablePurchaseOrderTaxSnapshots(
  client: TaxSnapshotClient,
  oldRate: TaxRateSnapshot,
  newRateSnapshot: TaxRateSnapshot,
  newRate: Decimal,
) {
  const lines = await client.purchaseOrderLine.findMany({
    where: {
      taxRateId: oldRate.id,
      po: { status: { in: [...MUTABLE_PURCHASE_TAX_STATUSES] } },
    },
    select: {
      id: true,
      poId: true,
      taxForeign: true,
      taxBase: true,
      totalForeign: true,
      po: {
        select: {
          id: true,
          fxRateToBase: true,
          taxRateName: true,
        },
      },
    },
  })
  const lockedPoIds = await lockMutablePurchaseOrders(client, unique(lines.map((line) => line.poId)))
  const deltas = new Map<string, Delta & { updateHeader: boolean }>()
  const updates: Array<{
    id: string
    next: ReturnType<typeof calculatePurchaseLineTaxSnapshot>
  }> = []

  for (const line of lines) {
    if (!lockedPoIds.has(line.poId)) continue
    const next = calculatePurchaseLineTaxSnapshot({
      totalForeign: line.totalForeign,
      fxRateToBase: line.po.fxRateToBase,
      taxRateValue: newRate,
    })
    updates.push({ id: line.id, next })
    addDelta(deltas, line.poId, {
      subtotalForeign: toDecimal(0),
      subtotalBase: toDecimal(0),
      taxForeign: next.taxForeign.sub(line.taxForeign),
      taxBase: next.taxBase.sub(line.taxBase),
    }, line.po.taxRateName === oldRate.name)
  }

  await updatePurchaseTaxLines(client, updates)

  await updatePurchaseOrderTaxTotals(client, deltas, newRateSnapshot, newRate)

  return { orders: deltas.size, lines: updates.length }
}

async function lockMutableSalesOrders(client: TaxSnapshotClient, orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set()
  // Lock parent documents and re-check mutable status inside the same
  // transaction so a concurrent status transition cannot be silently re-rated.
  // DRAFT is the only sales tax-mutable state; PENDING_PAYMENT has crossed the
  // customer quote/invoice boundary and keeps its original tax snapshot.
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "sales_orders"
    WHERE id IN (${Prisma.join(orderIds)})
      AND status IN (${Prisma.join([...MUTABLE_SALES_TAX_STATUSES])})
    FOR UPDATE
  `)
  return new Set(rows.map((row) => row.id))
}

async function lockMutablePurchaseOrders(client: TaxSnapshotClient, poIds: string[]): Promise<Set<string>> {
  if (poIds.length === 0) return new Set()
  // Purchase tax snapshots are mutable only before the document crosses a
  // supplier boundary. RFQ_SENT/QUOTE_RECEIVED keep their original tax fields.
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "purchase_orders"
    WHERE id IN (${Prisma.join(poIds)})
      AND status IN (${Prisma.join([...MUTABLE_PURCHASE_TAX_STATUSES])})
    FOR UPDATE
  `)
  return new Set(rows.map((row) => row.id))
}

async function updateSalesTaxLines(
  client: TaxSnapshotClient,
  updates: Array<{
    id: string
    next: ReturnType<typeof calculateSalesLineTaxSnapshot>
  }>,
): Promise<void> {
  if (updates.length === 0) return
  // Parent status is guarded by lockMutableSalesOrders' SELECT ... FOR UPDATE
  // in the same transaction, so this line update does not repeat that filter.
  const values = Prisma.join(updates.map(({ id, next }) => Prisma.sql`(
    ${id}::text,
    ${next.totalForeign.toString()}::numeric,
    ${next.totalBase.toString()}::numeric,
    ${next.taxForeign.toString()}::numeric,
    ${next.taxBase.toString()}::numeric
  )`))
  await client.$executeRaw(Prisma.sql`
    UPDATE "sales_order_lines" AS line
    SET
      "totalForeign" = updates."totalForeign",
      "totalBase" = updates."totalBase",
      "taxForeign" = updates."taxForeign",
      "taxBase" = updates."taxBase"
    FROM (VALUES ${values}) AS updates("id", "totalForeign", "totalBase", "taxForeign", "taxBase")
    WHERE line.id = updates.id
  `)
}

async function updateSalesOrderTaxTotals(
  client: TaxSnapshotClient,
  deltas: Map<string, Delta & { updateHeader: boolean }>,
  newRateSnapshot: TaxRateSnapshot,
  newRate: Decimal,
): Promise<void> {
  if (deltas.size === 0) return
  const taxRatePercent = newRate.gt(0) ? newRate.toString() : null
  for (const entries of chunks([...deltas.entries()], TAX_TOTAL_UPDATE_CHUNK_SIZE)) {
    const values = Prisma.join(entries.map(([id, delta]) => Prisma.sql`(
      ${id}::text,
      ${delta.subtotalForeign.toString()}::numeric,
      ${delta.subtotalBase.toString()}::numeric,
      ${delta.taxForeign.toString()}::numeric,
      ${delta.taxBase.toString()}::numeric,
      ${delta.subtotalForeign.add(delta.taxForeign).toString()}::numeric,
      ${delta.subtotalBase.add(delta.taxBase).toString()}::numeric,
      ${delta.updateHeader}::boolean,
      ${newRateSnapshot.name}::text,
      ${taxRatePercent}::numeric
    )`))
    await client.$executeRaw(Prisma.sql`
      UPDATE "sales_orders" AS orders
      SET
        "subtotalForeign" = orders."subtotalForeign" + updates."subtotalForeignDelta",
        "subtotalBase" = orders."subtotalBase" + updates."subtotalBaseDelta",
        "taxForeign" = orders."taxForeign" + updates."taxForeignDelta",
        "taxBase" = orders."taxBase" + updates."taxBaseDelta",
        "totalForeign" = orders."totalForeign" + updates."totalForeignDelta",
        "totalBase" = orders."totalBase" + updates."totalBaseDelta",
        "taxRateName" = CASE WHEN updates."updateHeader" THEN updates."taxRateName" ELSE orders."taxRateName" END,
        "taxRatePercent" = CASE WHEN updates."updateHeader" THEN updates."taxRatePercent" ELSE orders."taxRatePercent" END
      FROM (VALUES ${values}) AS updates(
        "id",
        "subtotalForeignDelta",
        "subtotalBaseDelta",
        "taxForeignDelta",
        "taxBaseDelta",
        "totalForeignDelta",
        "totalBaseDelta",
        "updateHeader",
        "taxRateName",
        "taxRatePercent"
      )
      WHERE orders.id = updates.id
        AND orders.status IN (${Prisma.join([...MUTABLE_SALES_TAX_STATUSES])})
    `)
  }
}

async function updatePurchaseTaxLines(
  client: TaxSnapshotClient,
  updates: Array<{
    id: string
    next: ReturnType<typeof calculatePurchaseLineTaxSnapshot>
  }>,
): Promise<void> {
  if (updates.length === 0) return
  // Parent status is guarded by lockMutablePurchaseOrders' SELECT ... FOR UPDATE
  // in the same transaction, so this line update does not repeat that filter.
  const values = Prisma.join(updates.map(({ id, next }) => Prisma.sql`(
    ${id}::text,
    ${next.taxForeign.toString()}::numeric,
    ${next.taxBase.toString()}::numeric
  )`))
  await client.$executeRaw(Prisma.sql`
    UPDATE "purchase_order_lines" AS line
    SET
      "taxForeign" = updates."taxForeign",
      "taxBase" = updates."taxBase"
    FROM (VALUES ${values}) AS updates("id", "taxForeign", "taxBase")
    WHERE line.id = updates.id
  `)
}

async function updatePurchaseOrderTaxTotals(
  client: TaxSnapshotClient,
  deltas: Map<string, Delta & { updateHeader: boolean }>,
  newRateSnapshot: TaxRateSnapshot,
  newRate: Decimal,
): Promise<void> {
  if (deltas.size === 0) return
  const taxRatePercent = newRate.gt(0) ? newRate.toString() : null
  for (const entries of chunks([...deltas.entries()], TAX_TOTAL_UPDATE_CHUNK_SIZE)) {
    const values = Prisma.join(entries.map(([id, delta]) => Prisma.sql`(
      ${id}::text,
      ${delta.taxForeign.toString()}::numeric,
      ${delta.taxBase.toString()}::numeric,
      ${delta.updateHeader}::boolean,
      ${newRateSnapshot.name}::text,
      ${taxRatePercent}::numeric
    )`))
    await client.$executeRaw(Prisma.sql`
      UPDATE "purchase_orders" AS orders
      SET
        "taxForeign" = orders."taxForeign" + updates."taxForeignDelta",
        "taxBase" = orders."taxBase" + updates."taxBaseDelta",
        "totalForeign" = orders."totalForeign" + updates."taxForeignDelta",
        "totalBase" = orders."totalBase" + updates."taxBaseDelta",
        "taxRateName" = CASE WHEN updates."updateHeader" THEN updates."taxRateName" ELSE orders."taxRateName" END,
        "taxRatePercent" = CASE WHEN updates."updateHeader" THEN updates."taxRatePercent" ELSE orders."taxRatePercent" END
      FROM (VALUES ${values}) AS updates(
        "id",
        "taxForeignDelta",
        "taxBaseDelta",
        "updateHeader",
        "taxRateName",
        "taxRatePercent"
      )
      WHERE orders.id = updates.id
        AND orders.status IN (${Prisma.join([...MUTABLE_PURCHASE_TAX_STATUSES])})
    `)
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function addDelta(
  deltas: Map<string, Delta & { updateHeader: boolean }>,
  id: string,
  delta: Delta,
  updateHeader: boolean,
) {
  const existing = deltas.get(id)
  if (!existing) {
    deltas.set(id, { ...delta, updateHeader })
    return
  }
  existing.subtotalForeign = existing.subtotalForeign.add(delta.subtotalForeign)
  existing.subtotalBase = existing.subtotalBase.add(delta.subtotalBase)
  existing.taxForeign = existing.taxForeign.add(delta.taxForeign)
  existing.taxBase = existing.taxBase.add(delta.taxBase)
  existing.updateHeader ||= updateHeader
}

function maxZero(value: Decimal): Decimal {
  return value.lt(0) ? toDecimal(0) : value
}

function round4(value: DecimalInput): Decimal {
  return roundQuantity(value, 4)
}
