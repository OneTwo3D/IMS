import type { Prisma } from '@/app/generated/prisma/client'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

const MUTABLE_SALES_TAX_STATUSES = ['DRAFT', 'PENDING_PAYMENT'] as const
const MUTABLE_PURCHASE_TAX_STATUSES = ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED'] as const

type TaxSnapshotClient = Pick<Prisma.TransactionClient, 'salesOrderLine' | 'salesOrder' | 'purchaseOrderLine' | 'purchaseOrder' | 'activityLog'>

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
  const deltas = new Map<string, Delta & { updateHeader: boolean }>()

  for (const line of lines) {
    const next = calculateSalesLineTaxSnapshot({
      qty: line.qty,
      unitPriceForeign: line.unitPriceForeign,
      discountAmount: line.discountAmount,
      fxRateToBase: line.order.fxRateToBase,
      pricesIncludeVat: line.order.pricesIncludeVat,
      taxRateValue: newRate,
    })
    await client.salesOrderLine.update({
      where: { id: line.id },
      data: {
        totalForeign: next.totalForeign,
        totalBase: next.totalBase,
        taxForeign: next.taxForeign,
        taxBase: next.taxBase,
      },
    })
    addDelta(deltas, line.orderId, {
      subtotalForeign: next.totalForeign.sub(line.totalForeign),
      subtotalBase: next.totalBase.sub(line.totalBase),
      taxForeign: next.taxForeign.sub(line.taxForeign),
      taxBase: next.taxBase.sub(line.taxBase),
    }, line.order.taxRateName === oldRate.name)
  }

  for (const [orderId, delta] of deltas) {
    await client.salesOrder.update({
      where: { id: orderId },
      data: {
        subtotalForeign: { increment: delta.subtotalForeign },
        subtotalBase: { increment: delta.subtotalBase },
        taxForeign: { increment: delta.taxForeign },
        taxBase: { increment: delta.taxBase },
        totalForeign: { increment: delta.subtotalForeign.add(delta.taxForeign) },
        totalBase: { increment: delta.subtotalBase.add(delta.taxBase) },
        ...(delta.updateHeader ? {
          taxRateName: newRateSnapshot.name,
          taxRatePercent: newRate.gt(0) ? newRate : null,
        } : {}),
      },
    })
  }

  return { orders: deltas.size, lines: lines.length }
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
  const deltas = new Map<string, Delta & { updateHeader: boolean }>()

  for (const line of lines) {
    const next = calculatePurchaseLineTaxSnapshot({
      totalForeign: line.totalForeign,
      fxRateToBase: line.po.fxRateToBase,
      taxRateValue: newRate,
    })
    await client.purchaseOrderLine.update({
      where: { id: line.id },
      data: {
        taxForeign: next.taxForeign,
        taxBase: next.taxBase,
      },
    })
    addDelta(deltas, line.poId, {
      subtotalForeign: toDecimal(0),
      subtotalBase: toDecimal(0),
      taxForeign: next.taxForeign.sub(line.taxForeign),
      taxBase: next.taxBase.sub(line.taxBase),
    }, line.po.taxRateName === oldRate.name)
  }

  for (const [poId, delta] of deltas) {
    await client.purchaseOrder.update({
      where: { id: poId },
      data: {
        taxForeign: { increment: delta.taxForeign },
        taxBase: { increment: delta.taxBase },
        totalForeign: { increment: delta.taxForeign },
        totalBase: { increment: delta.taxBase },
        ...(delta.updateHeader ? {
          taxRateName: newRateSnapshot.name,
          taxRatePercent: newRate.gt(0) ? newRate : null,
        } : {}),
      },
    })
  }

  return { orders: deltas.size, lines: lines.length }
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
