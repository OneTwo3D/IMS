import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { grirJournalDate, loadGrirPoValuation, writeGrirMovement } from '@/lib/domain/accounting/grir-subledger-movement'
import { loadPurchaseOrderLineLandedQty, requirePoLineLandedQty } from '@/lib/domain/inventory/po-line-landed-quantity'
import { GRIR_BALANCE_SOURCE_TYPES, allocateReturnCredit, loadBilledUnitBaseByLine } from '@/lib/domain/accounting/grir-subledger-movement'
import { resolveSupplierCreditNoteTransitBase } from '@/lib/domain/purchasing/supplier-credit-note'
import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * OPENING GR/IR FROM RECEIVED-BUT-UNBILLED LINES (stage only; production is reinstalled and gets none).
 *
 * A line that was received or billed before the GR/IR sub-ledger existed carries no (or only part of its) history in it. For every order line the
 * EXPECTED position from the source data is landed - returned - billed (landed = `qtyReceived` plus what a warehouse alignment brought in, the same
 * quantity the order's status uses). The line's LIVE position is the sum of its sub-ledger rows (every balance type). The plan is the DIFFERENCE,
 * written as one OPENING_BALANCE row at the PO goods unit cost: so a line received before deployment and billed in part afterwards (live rows: -5)
 * gets the missing +10, and a line the ledger already tracks completely gets nothing. The key carries the line and the quantity
 * (`grir:opening:<poLineId>:<qty>`), and a second run finds expected = live, so it plans nothing; replaying an old plan upserts onto the same key.
 *
 * HISTORICAL RETURN CREDITS count: a POSTED return-generated supplier credit note that has no GR/IR row (it was posted before the sub-ledger) already cleared
 * billed-and-returned goods, so its quantity is ADDED BACK into the expected position, allocated by the SAME function the live writer uses
 * (`allocateReturnCredit`, per line, capped by the credit's net at the bill's unit price), oldest first. Its net is the credit's gross scaled by the bill's
 * net/gross ratio; a reverse-charge credit is taken at its stored amount, which is the one approximation.
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
  /** What the sub-ledger already holds for the line. */
  liveQty: string
  /** (landed - returned - billed) - live: the quantity to open. + received not billed, - billed not received. */
  openQty: string
  unitCostBase: string
  baseDelta: string
  occurredAt: Date
}

export type GrirOpeningPlan = {
  rows: GrirOpeningPlanRow[]
  /** Lines whose live sub-ledger position already equals the source data (nothing to open), including lines with live rows only. */
  alreadyTracked: number
  /** Lines with nothing open at all. */
  settled: number
  totalBaseDelta: string
}

type OpeningClient = Pick<Prisma.TransactionClient, 'purchaseOrder' | 'purchaseOrderLine' | 'purchaseInvoiceLine' | 'grirSubledgerMovement' | 'purchaseReceipt' | 'wmsAsnLineMap' | 'supplierCreditNote'>

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
  const liveRows = lineIds.length === 0 ? [] : await client.grirSubledgerMovement.groupBy({
    by: ['poLineId'],
    where: { poLineId: { in: lineIds }, sourceType: { in: [...GRIR_BALANCE_SOURCE_TYPES] } },
    _sum: { qtyDelta: true },
  })
  const liveByLine = new Map(liveRows.map((row) => [row.poLineId, toDecimal(row._sum.qtyDelta)]))
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

  const billedUnit = await loadBilledUnitBaseByLine(client, lineIds)
  const rows: GrirOpeningPlanRow[] = []
  let alreadyTracked = 0
  let settled = 0
  let total: Decimal = toDecimal(0)
  for (const order of orders) {
    const valuation = await loadGrirPoValuation(client, order.id)
    const landed = await loadPurchaseOrderLineLandedQty(client as never, order.lines.map((line) => ({ id: line.id, qtyReceived: line.qtyReceived })))
    // Historical return credits: posted, return-generated, and not yet in the sub-ledger.
    const notes = await client.supplierCreditNote.findMany({
      where: { poId: order.id, isReturnGenerated: true, status: 'POSTED' },
      select: { id: true, amountBase: true, postedAt: true, createdAt: true, purchaseInvoice: { select: { subtotalForeign: true, taxForeign: true } } },
      orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
    })
    // o3d-o35oo: a credit note the sub-ledger already tracks still reduced the position the SOURCE data implies (the goods it cleared are
    // billed-and-returned and credited), and its quantity is already in `liveByLine`. Leaving it out of the expected quantity while the live
    // rows carry it made a received-10, billed-10, returned-4, credited-4 line (return and credit both recorded after the sub-ledger started)
    // expect -4 against a live 0 and open another -4. Its credited quantity is therefore read off its OWN rows (exact, not re-allocated) and
    // seeds the per-line credited quantity; only untracked notes are allocated below.
    const trackedRows = notes.length === 0 ? [] : await client.grirSubledgerMovement.findMany({
      where: { sourceType: { in: ['SUPPLIER_CREDIT_NOTE', 'BILL_PRICE_VARIANCE'] }, sourceRef: { in: notes.map((note) => note.id) } },
      select: { sourceRef: true, sourceType: true, poLineId: true, qtyDelta: true },
    })
    const covered = new Set(trackedRows.map((row) => row.sourceRef))
    const creditedByLine = new Map<string, Decimal>()
    for (const row of trackedRows) {
      if (row.sourceType !== 'SUPPLIER_CREDIT_NOTE' || !row.poLineId) continue
      creditedByLine.set(row.poLineId, (creditedByLine.get(row.poLineId) ?? toDecimal(0)).add(toDecimal(row.qtyDelta)))
    }
    for (const note of notes) {
      if (covered.has(note.id)) continue
      const allocation = allocateReturnCredit(order.lines.map((line) => {
        const expectedBeforeCredit = requirePoLineLandedQty(landed, line.id).qty.sub(line.qtyReturned).sub(billedByLine.get(line.id) ?? 0)
        const credited = creditedByLine.get(line.id) ?? toDecimal(0)
        return {
          id: line.id,
          billedNotReceived: expectedBeforeCredit.neg().sub(credited).gt(0) ? expectedBeforeCredit.neg().sub(credited) : toDecimal(0),
          returnedNotCredited: toDecimal(line.qtyReturned).sub(credited),
          billedUnitBase: billedUnit.get(line.id) ?? toDecimal(0),
        }
      }), resolveSupplierCreditNoteTransitBase({
        grossBase: toDecimal(note.amountBase).toNumber(),
        billSubtotalForeign: Number(note.purchaseInvoice?.subtotalForeign ?? 0),
        billTaxForeign: Number(note.purchaseInvoice?.taxForeign ?? 0),
      }))
      for (const [lineId, qty] of allocation) creditedByLine.set(lineId, (creditedByLine.get(lineId) ?? toDecimal(0)).add(qty))
    }
    for (const line of order.lines) {
      const received = requirePoLineLandedQty(landed, line.id).qty
      const returned = toDecimal(line.qtyReturned)
      const billed = billedByLine.get(line.id) ?? toDecimal(0)
      const expected = received.sub(returned).sub(billed).add(creditedByLine.get(line.id) ?? 0)
      const live = liveByLine.get(line.id) ?? toDecimal(0)
      const openQty = expected.sub(live)
      if (openQty.isZero()) { if (expected.isZero()) settled += 1; else alreadyTracked += 1; continue }
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
        liveQty: live.toString(),
        openQty: openQty.toString(),
        unitCostBase: unit.toString(),
        baseDelta: baseDelta.toString(),
        occurredAt: firstReceiptByLine.get(line.id) ?? now,
      })
    }
  }
  return { rows, alreadyTracked, settled, totalBaseDelta: total.toString() }
}

/** Write the plan. Each row is a first-write-wins upsert on its own key, so a re-run (or two runs at once) cannot double-open a line. */
export async function applyGrirOpeningBalance(plan: GrirOpeningPlan, options: { asOf: Date | string; client?: Pick<Prisma.TransactionClient, 'grirSubledgerMovement'> } ): Promise<number> {
  const client = options.client ?? db
  const journalDate = grirJournalDate(options.asOf)
  for (const row of plan.rows) {
    await writeGrirMovement(client as never, {
      sourceType: 'OPENING_BALANCE',
      sourceRef: row.poId,
      idempotencyKey: `grir:opening:${row.poLineId}:${row.openQty}`,
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
