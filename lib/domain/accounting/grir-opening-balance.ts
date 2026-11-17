import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { grirJournalDate, loadGrirPoValuation, writeGrirMovement } from '@/lib/domain/accounting/grir-subledger-movement'
import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * OPENING GR/IR FROM RECEIVED-BUT-UNBILLED LINES (stage only; production is reinstalled and gets none).
 *
 * A line that was received or billed before the GR/IR sub-ledger existed carries no history in it. For every order line with NO sub-ledger row at all and a
 * non-zero (received - returned - billed) quantity, the plan is ONE OPENING_BALANCE row for that quantity at the PO goods unit cost (positive = received
 * not billed, negative = billed not received). A line that already has any sub-ledger row is left alone and counted, because its history is already
 * accruing correctly and an opening row on top would count the same goods twice. The key is `grir:opening:<poLineId>`, so a second run writes nothing
 * for a line it already opened, and a line that has since gained live rows is skipped by the same rule: the script is idempotent and safe to re-run.
 *
 * The plan is computed by the one function both the dry run and the write use, so the dry run reports exactly what a real run would write.
 */
export type GrirOpeningPlanRow = {
  poId: string
  poReference: string
  poLineId: string
  supplierId: string
  received: string
  returned: string
  billed: string
  /** received - returned - billed: + received not billed, - billed not received. */
  openQty: string
  unitCostBase: string
  baseDelta: string
  occurredAt: Date
}

export type GrirOpeningPlan = {
  rows: GrirOpeningPlanRow[]
  /** Lines with a non-zero open quantity that already carry sub-ledger rows and were left alone. */
  skippedWithHistory: number
  /** Lines whose open quantity is zero. */
  settled: number
  totalBaseDelta: string
}

type OpeningClient = Pick<Prisma.TransactionClient, 'purchaseOrder' | 'purchaseInvoiceLine' | 'grirSubledgerMovement' | 'purchaseReceipt'>

const FREIGHT_ORDER_TYPE = 'FREIGHT'

export async function planGrirOpeningBalance(client: OpeningClient = db, options: { now?: Date } = {}): Promise<GrirOpeningPlan> {
  const now = options.now ?? new Date()
  const orders = await client.purchaseOrder.findMany({
    where: { type: { not: FREIGHT_ORDER_TYPE }, status: { notIn: ['DRAFT', 'CANCELLED'] } },
    select: {
      id: true, reference: true, supplierId: true,
      lines: { select: { id: true, qtyReceived: true, qtyReturned: true } },
    },
    orderBy: { id: 'asc' },
  })
  const lineIds = orders.flatMap((order) => order.lines.map((line) => line.id))
  const billedRows = lineIds.length === 0 ? [] : await client.purchaseInvoiceLine.groupBy({
    by: ['poLineId'],
    where: { poLineId: { in: lineIds } },
    _sum: { qtyBilled: true },
  })
  const billedByLine = new Map(billedRows.map((row) => [row.poLineId, toDecimal(row._sum.qtyBilled)]))
  const withHistory = new Set((lineIds.length === 0 ? [] : await client.grirSubledgerMovement.findMany({
    where: { poLineId: { in: lineIds } },
    select: { poLineId: true },
    distinct: ['poLineId'],
  })).map((row) => row.poLineId))
  const receiptRows = lineIds.length === 0 ? [] : await client.purchaseReceipt.findMany({
    where: { lines: { some: { poLineId: { in: lineIds } } } },
    select: { receivedAt: true, lines: { select: { poLineId: true } } },
  })
  const firstReceiptByLine = new Map<string, Date>()
  for (const receipt of receiptRows) {
    for (const line of receipt.lines) {
      const existing = firstReceiptByLine.get(line.poLineId)
      if (!existing || receipt.receivedAt.getTime() < existing.getTime()) firstReceiptByLine.set(line.poLineId, receipt.receivedAt)
    }
  }

  const rows: GrirOpeningPlanRow[] = []
  let skippedWithHistory = 0
  let settled = 0
  let total: Decimal = toDecimal(0)
  for (const order of orders) {
    const valuation = await loadGrirPoValuation(client, order.id)
    for (const line of order.lines) {
      const received = toDecimal(line.qtyReceived)
      const returned = toDecimal(line.qtyReturned)
      const billed = billedByLine.get(line.id) ?? toDecimal(0)
      const openQty = received.sub(returned).sub(billed)
      if (openQty.isZero()) { settled += 1; continue }
      if (withHistory.has(line.id)) { skippedWithHistory += 1; continue }
      const unit = valuation.goodsUnitCostByLine.get(line.id) ?? toDecimal(0)
      const baseDelta = roundQuantity(openQty.mul(unit), 6)
      total = total.add(baseDelta)
      rows.push({
        poId: order.id,
        poReference: order.reference,
        poLineId: line.id,
        supplierId: order.supplierId,
        received: received.toString(),
        returned: returned.toString(),
        billed: billed.toString(),
        openQty: openQty.toString(),
        unitCostBase: unit.toString(),
        baseDelta: baseDelta.toString(),
        occurredAt: firstReceiptByLine.get(line.id) ?? now,
      })
    }
  }
  return { rows, skippedWithHistory, settled, totalBaseDelta: total.toString() }
}

/** Write the plan. Each row is a first-write-wins upsert on its own key, so a re-run (or two runs at once) cannot double-open a line. */
export async function applyGrirOpeningBalance(plan: GrirOpeningPlan, options: { asOf: Date | string; client?: Pick<Prisma.TransactionClient, 'grirSubledgerMovement'> } ): Promise<number> {
  const client = options.client ?? db
  const journalDate = grirJournalDate(options.asOf)
  for (const row of plan.rows) {
    await writeGrirMovement(client as never, {
      sourceType: 'OPENING_BALANCE',
      sourceRef: row.poId,
      idempotencyKey: `grir:opening:${row.poLineId}`,
      poId: row.poId,
      poLineId: row.poLineId,
      supplierId: row.supplierId,
      qtyDelta: row.openQty,
      baseDelta: row.baseDelta,
      journalDate,
      occurredAt: row.occurredAt,
    })
  }
  return plan.rows.length
}
