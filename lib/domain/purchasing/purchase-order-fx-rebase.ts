import { Prisma } from '@/app/generated/prisma/client'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  lockPurchaseOrdersWithCostRows,
  type PurchaseOrderLockClient,
} from '@/lib/domain/wms/transfer-asn-lock-order'

export type PurchaseOrderFxRebaseInput = {
  subtotalForeign: unknown
  taxForeign: unknown
  totalForeign: unknown
  directFreightForeign: unknown
  lines: Array<{ id: string; unitCostForeign: unknown; totalForeign: unknown; taxForeign: unknown }>
  freightCostLines: Array<{ id: string; amountForeign: unknown }>
}

export type PurchaseOrderFxRebaseStoredOrder = Omit<PurchaseOrderFxRebaseInput, 'lines' | 'freightCostLines'>

export type PurchaseOrderFxRebaseDb = {
  purchaseOrderLine: {
    findMany(args: {
      where: { poId: string }
      select: { id: true; unitCostForeign: true; totalForeign: true; taxForeign: true }
    }): Promise<PurchaseOrderFxRebaseInput['lines']>
    update(args: {
      where: { id: string }
      data: { unitCostBase: number; totalBase: number; taxBase: number }
    }): Promise<unknown>
  }
  freightCostLine: {
    findMany(args: {
      where: { poId: string }
      select: { id: true; amountForeign: true }
    }): Promise<PurchaseOrderFxRebaseInput['freightCostLines']>
    update(args: {
      where: { id: string }
      data: { amountBase: number }
    }): Promise<unknown>
  }
}

export type PurchaseOrderFxRebaseTransactionDb<TResult = unknown> = PurchaseOrderFxRebaseDb
  & PurchaseOrderLockClient
  & {
    purchaseOrder: {
      update(args: {
        where: { id: string }
        data: Record<string, unknown>
        select?: unknown
      }): Promise<TResult>
    }
  }

export type PurchaseOrderFxRebaseTransactionalDb<TResult = unknown> = {
  $transaction<T>(fn: (tx: PurchaseOrderFxRebaseTransactionDb<TResult>) => Promise<T>): Promise<T>
}

export type PurchaseOrderFxRebaseParentUpdate = {
  data: Record<string, unknown>
  select?: unknown
}

function safeFxRate(rate: number): number {
  return rate > 0 ? rate : 1
}

export function buildPurchaseOrderFxRebaseUpdates(input: PurchaseOrderFxRebaseInput, fxRateToBase: number) {
  const rate = toDecimal(safeFxRate(fxRateToBase))
  const baseMoney = (value: unknown) => roundQuantity(toDecimal(value as Prisma.Decimal | DecimalInput).div(rate), 4).toNumber()
  const baseUnit = (value: unknown) => roundQuantity(toDecimal(value as Prisma.Decimal | DecimalInput).div(rate), 6).toNumber()

  return {
    purchaseOrder: {
      subtotalBase: baseMoney(input.subtotalForeign),
      taxBase: baseMoney(input.taxForeign),
      totalBase: baseMoney(input.totalForeign),
      directFreightBase: baseMoney(input.directFreightForeign),
    },
    lines: input.lines.map((line) => ({
      id: line.id,
      unitCostBase: baseUnit(line.unitCostForeign),
      totalBase: baseMoney(line.totalForeign),
      taxBase: baseMoney(line.taxForeign),
    })),
    freightCostLines: input.freightCostLines.map((line) => ({
      id: line.id,
      amountBase: baseMoney(line.amountForeign),
    })),
  }
}

export async function rebasePurchaseOrderStoredBaseAmounts(
  db: PurchaseOrderFxRebaseDb,
  poId: string,
  order: PurchaseOrderFxRebaseStoredOrder,
  fxRateToBase: number,
) {
  const [lines, freightCostLines] = await Promise.all([
    db.purchaseOrderLine.findMany({
      where: { poId },
      select: { id: true, unitCostForeign: true, totalForeign: true, taxForeign: true },
    }),
    db.freightCostLine.findMany({
      where: { poId },
      select: { id: true, amountForeign: true },
    }),
  ])
  const rebased = buildPurchaseOrderFxRebaseUpdates({
    ...order,
    lines,
    freightCostLines,
  }, fxRateToBase)

  await Promise.all([
    ...rebased.lines.map((line) => db.purchaseOrderLine.update({
      where: { id: line.id },
      data: {
        unitCostBase: line.unitCostBase,
        totalBase: line.totalBase,
        taxBase: line.taxBase,
      },
    })),
    ...rebased.freightCostLines.map((line) => db.freightCostLine.update({
      where: { id: line.id },
      data: { amountBase: line.amountBase },
    })),
  ])

  return rebased.purchaseOrder
}

export async function rebasePurchaseOrderStoredBaseAmountsWithParentUpdate<TResult>(
  db: PurchaseOrderFxRebaseTransactionalDb<TResult>,
  poId: string,
  order: PurchaseOrderFxRebaseStoredOrder,
  fxRateToBase: number,
  parentUpdate: PurchaseOrderFxRebaseParentUpdate,
): Promise<TResult> {
  return db.$transaction(async (tx) => {
    // ─── o3d-6nd55 r3: THE PARENT BEFORE ITS COST ROWS ───
    //
    // This transaction rewrote `purchase_order_lines` and `freight_cost_lines` and only THEN updated
    // the `purchase_orders` row — children before parent, the signature that deadlocks against the WMS
    // stock-sync alignment's parent-then-children order. Found by the writer census in
    // lib/domain/wms/transfer-asn-lock-order.ts rather than by a production failure; an fx-rate edit on
    // a linked FREIGHT order is exactly a case an alignment can be holding.
    //
    // The lock is taken HERE, inside the function that does the writing, rather than asked of the
    // caller — which is why `PurchaseOrderFxRebaseTransactionDb` now requires `$queryRaw`. A caller
    // that forgets is the defect this whole round is about.
    await lockPurchaseOrdersWithCostRows(tx, [poId])

    const rebasedPurchaseOrder = await rebasePurchaseOrderStoredBaseAmounts(tx, poId, order, fxRateToBase)

    return tx.purchaseOrder.update({
      where: { id: poId },
      data: {
        ...parentUpdate.data,
        ...rebasedPurchaseOrder,
      },
      ...(parentUpdate.select === undefined ? {} : { select: parentUpdate.select }),
    })
  })
}
