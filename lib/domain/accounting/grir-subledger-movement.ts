import { businessDateYmd } from '@/lib/business-date'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { goodsUnitCostAfterHeaderDiscount, headerDiscountFactorForPo } from '@/lib/domain/purchasing/landed-cost-allocation'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * GR/IR (goods received, not invoiced) accrual: the append-only sub-ledger, one signed row per source event.
 *
 * WHAT IT HOLDS. The value of goods a supplier order has RECEIVED that no supplier bill covers yet (and, for a prepaid supplier, the value
 * BILLED that has not arrived). Every figure is the GOODS value only, at the PO valuation: the line's `unitCostBase` after the order's header
 * discount, which is exactly the goods part of what the receipt puts on the cost layer (`goodsUnitCostAfterHeaderDiscount`, the one definition the
 * landed-cost allocation starts from). Freight and landed cost are NOT here: they follow the Stock in Transit path that already exists
 * (the freight bill debits it, the receipt's gross layer value credits it, a landed-cost reclass moves the difference), so recording them here too
 * would count them twice.
 *
 * SIGN: CREDIT-POSITIVE. `baseDelta` > 0 raises the GR/IR liability, < 0 lowers it.
 *
 *   RECEIPT               +  received qty x PO goods unit cost, 6dp.      Written with the stock, the layer and the receipt journal.
 *   BILL                  -  billed qty x PO goods unit cost.             Written with the bill. Only goods lines (a freight cost line is not here).
 *   BILL_UPDATE           -  the signed delta of an edited bill's goods quantity, valued the same way.
 *   SUPPLIER_RETURN       -  returned qty x PO goods unit cost: reverses the receipt portion. Written with the return.
 *   SUPPLIER_CREDIT_NOTE  +  a return-generated credit note: the supplier crediting back goods that were billed and then returned, valued per line at
 *                            the PO goods unit cost (like the return), lifting the debit that return left. The difference to the credit's net goes to
 *                            BILL_PRICE_VARIANCE. Only return-generated notes (a freight credit note is the transit path's).
 *   OPENING_BALANCE       +/- the received-not-billed (or billed-not-received) quantity of a line that had no sub-ledger history, at the PO goods unit cost.
 *                         Written ONLY by the stage opening-balance script (scripts/grir-opening-balance.ts); production is reinstalled and has none.
 *   BILL_PRICE_VARIANCE   billed value - PO value of the billed goods (positive = the bill is dearer than the order). THE PRICE DIFFERENCE. No
 *                         variance or landed-cost path exists for a bill whose price differs from the order, so it is kept as its own movement,
 *                         OUTSIDE the GR/IR balance and outside the Xero reclass: the difference stays on Stock in Transit as it always has (the bill
 *                         debits transit at the billed price, the receipt credits it at the PO valuation), now visible per order instead of buried.
 *
 * `baseDelta` is written at 6dp; the balance is the sum of the BALANCE source types. Idempotent on `idempotencyKey` (first write wins), so a
 * replayed source event records exactly once. Every writer calls this INSIDE the transaction of its source event, and records whether or not the
 * Xero posting is switched on: the sub-ledger always accrues.
 */
export const GRIR_BALANCE_SOURCE_TYPES = ['RECEIPT', 'BILL', 'BILL_UPDATE', 'SUPPLIER_RETURN', 'SUPPLIER_CREDIT_NOTE', 'OPENING_BALANCE'] as const
export const GRIR_PRICE_VARIANCE_SOURCE_TYPE = 'BILL_PRICE_VARIANCE' as const
export type GrirBalanceSourceType = (typeof GRIR_BALANCE_SOURCE_TYPES)[number]
export type GrirSourceType = GrirBalanceSourceType | typeof GRIR_PRICE_VARIANCE_SOURCE_TYPE

export type GrirClient = Pick<Prisma.TransactionClient, 'grirSubledgerMovement' | 'purchaseOrder' | 'purchaseOrderLine' | 'purchaseInvoiceLine'>

/**
 * The journal date as a date-only UTC midnight (the reclass window is a date window). A date-only string keeps its own day; an INSTANT is stamped with its LONDON
 * business day, the day the ledger documents and the report windows use: a receipt at 23:30Z on 31 July is 1 August in London and must not be inside the 31 July balance.
 * (A bill's date, stored as a day's UTC midnight, is the same London day in GMT and BST.)
 */
export function grirJournalDate(value: Date | string): Date {
  const isoDay = typeof value === 'string' ? value.slice(0, 10) : businessDateYmd(value)
  return new Date(`${isoDay}T00:00:00.000Z`)
}

export type GrirPoValuation = {
  supplierId: string
  /** The PO goods unit cost per order line (6dp): `unitCostBase` after the header discount, no freight. */
  goodsUnitCostByLine: Map<string, Decimal>
}

/** Read the valuation of one order's goods lines. Callers hold the order's row lock, so this read cannot move under them. */
export async function loadGrirPoValuation(client: Pick<Prisma.TransactionClient, 'purchaseOrder'>, poId: string): Promise<GrirPoValuation> {
  const po = await client.purchaseOrder.findUnique({
    where: { id: poId },
    select: { supplierId: true, subtotalBase: true, lines: { select: { id: true, unitCostBase: true, totalBase: true } } },
  })
  if (!po) throw new Error(`GR/IR accrual: purchase order ${poId} not found`)
  const factor = headerDiscountFactorForPo(po)
  const goodsUnitCostByLine = new Map<string, Decimal>()
  for (const line of po.lines) goodsUnitCostByLine.set(line.id, roundQuantity(goodsUnitCostAfterHeaderDiscount(line.unitCostBase, factor), 6))
  return { supplierId: po.supplierId, goodsUnitCostByLine }
}

function unitCostFor(valuation: GrirPoValuation, poLineId: string): Decimal {
  const unit = valuation.goodsUnitCostByLine.get(poLineId)
  if (!unit) throw new Error(`GR/IR accrual: purchase order line ${poLineId} is not on the order`)
  return unit
}

export type GrirMovementInput = {
  sourceType: GrirSourceType
  sourceRef: string
  idempotencyKey: string
  poId: string
  poLineId: string | null
  supplierId: string
  qtyDelta: DecimalInput | null
  baseDelta: DecimalInput
  journalDate: Date | string
  occurredAt: Date
}

export async function writeGrirMovement(client: GrirClient, input: GrirMovementInput): Promise<void> {
  const baseDelta = roundQuantity(input.baseDelta, 6)
  const qtyDelta = input.qtyDelta === null ? null : roundQuantity(input.qtyDelta, 6)
  // A zero movement changes nothing; storing it would be noise.
  if (baseDelta.isZero() && (qtyDelta === null || qtyDelta.isZero())) return
  await client.grirSubledgerMovement.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: {
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      idempotencyKey: input.idempotencyKey,
      poId: input.poId,
      poLineId: input.poLineId,
      supplierId: input.supplierId,
      qtyDelta,
      baseDelta,
      journalDate: grirJournalDate(input.journalDate),
      occurredAt: input.occurredAt,
    },
    // Idempotent: the key identifies one source event, so a replay must not count it twice.
    update: {},
  })
}

/** Sum a quantity per order line, so a line received into two warehouses in one receipt is one movement. */
function sumByLine(lines: ReadonlyArray<{ poLineId: string; qty: DecimalInput }>): Map<string, Decimal> {
  const out = new Map<string, Decimal>()
  for (const line of lines) out.set(line.poLineId, (out.get(line.poLineId) ?? new Prisma.Decimal(0)).add(toDecimal(line.qty)))
  return out
}

/**
 * GOODS RECEIVED: credit GR/IR with the received quantity at the PO goods unit cost. `keyBase` names the source event (a receipt id, a WMS book-in
 * movement key); the row key is `keyBase:poLineId`, so a replay of the same event is a no-op.
 */
export async function recordGrirReceipt(
  client: GrirClient,
  input: { poId: string; sourceRef: string; keyBase: string; at: Date; journalDate?: Date | string; lines: ReadonlyArray<{ poLineId: string; qty: DecimalInput }> },
): Promise<void> {
  const valuation = await loadGrirPoValuation(client, input.poId)
  for (const [poLineId, qty] of sumByLine(input.lines)) {
    if (qty.lte(0)) continue
    await writeGrirMovement(client, {
      sourceType: 'RECEIPT',
      sourceRef: input.sourceRef,
      idempotencyKey: `grir:receipt:${input.keyBase}:${poLineId}`,
      poId: input.poId,
      poLineId,
      supplierId: valuation.supplierId,
      qtyDelta: qty,
      baseDelta: qty.mul(unitCostFor(valuation, poLineId)),
      journalDate: input.journalDate ?? input.at,
      occurredAt: input.at,
    })
  }
}

export type GrirBillLine = {
  poLineId: string
  qtyBilled: DecimalInput
  /** The line's billed value in base currency (`PurchaseInvoiceLine.totalBase`), net of tax. */
  billedBase: DecimalInput
}

/**
 * A SUPPLIER BILL: debit GR/IR by the billed quantity at the PO goods unit cost, and record the difference between what the bill charges and what
 * the order valued those goods at as its own BILL_PRICE_VARIANCE movement. Only goods lines (a freight cost line has no order line and is the
 * transit path's). `invoiceDate` is the GL date, as the bill's transit row is dated.
 */
export async function recordGrirBill(
  client: GrirClient,
  input: { poId: string; invoiceId: string; invoiceDate: Date | string; at: Date; lines: ReadonlyArray<GrirBillLine> },
): Promise<void> {
  const valuation = await loadGrirPoValuation(client, input.poId)
  const perLine = new Map<string, { qty: Decimal; billed: Decimal }>()
  for (const line of input.lines) {
    const entry = perLine.get(line.poLineId) ?? { qty: new Prisma.Decimal(0), billed: new Prisma.Decimal(0) }
    entry.qty = entry.qty.add(toDecimal(line.qtyBilled))
    entry.billed = entry.billed.add(toDecimal(line.billedBase))
    perLine.set(line.poLineId, entry)
  }
  for (const [poLineId, { qty, billed }] of perLine) {
    if (qty.lte(0)) continue
    const poValue = roundQuantity(qty.mul(unitCostFor(valuation, poLineId)), 6)
    const base = {
      sourceRef: input.invoiceId, poId: input.poId, poLineId, supplierId: valuation.supplierId,
      journalDate: input.invoiceDate, occurredAt: input.at,
    }
    await writeGrirMovement(client, { ...base, sourceType: 'BILL', idempotencyKey: `grir:bill:${input.invoiceId}:${poLineId}`, qtyDelta: qty.neg(), baseDelta: poValue.neg() })
    await writeGrirMovement(client, { ...base, sourceType: 'BILL_PRICE_VARIANCE', idempotencyKey: `grir:bill-ppv:${input.invoiceId}:${poLineId}`, qtyDelta: null, baseDelta: billed.sub(poValue) })
  }
}

export type GrirBillEditLine = { poLineId: string; qtyBilledDelta: DecimalInput; billedBaseDelta: DecimalInput }

/**
 * AN EDITED BILL: the signed delta of each goods line, valued the same way. The key carries `editId` (a fresh id per edit): the rows commit or
 * roll back with the edit's own transaction, so there is no retry of one edit to deduplicate, and two genuine edits must not collide.
 */
export async function recordGrirBillEdit(
  client: GrirClient,
  input: { poId: string; invoiceId: string; editId: string; at: Date; lines: ReadonlyArray<GrirBillEditLine> },
): Promise<void> {
  const valuation = await loadGrirPoValuation(client, input.poId)
  for (const line of input.lines) {
    const qty = toDecimal(line.qtyBilledDelta)
    const billed = toDecimal(line.billedBaseDelta)
    if (qty.isZero() && billed.isZero()) continue
    const poValue = roundQuantity(qty.mul(unitCostFor(valuation, line.poLineId)), 6)
    const base = {
      sourceRef: input.invoiceId, poId: input.poId, poLineId: line.poLineId, supplierId: valuation.supplierId,
      journalDate: input.at, occurredAt: input.at,
    }
    await writeGrirMovement(client, { ...base, sourceType: 'BILL_UPDATE', idempotencyKey: `grir:bill-update:${input.invoiceId}:${input.editId}:${line.poLineId}`, qtyDelta: qty.neg(), baseDelta: poValue.neg() })
    await writeGrirMovement(client, { ...base, sourceType: GRIR_PRICE_VARIANCE_SOURCE_TYPE, idempotencyKey: `grir:bill-update-ppv:${input.invoiceId}:${input.editId}:${line.poLineId}`, qtyDelta: null, baseDelta: billed.sub(poValue) })
  }
}

/** A SUPPLIER RETURN: reverse the receipt portion, the returned quantity at the PO goods unit cost. */
export async function recordGrirSupplierReturn(
  client: GrirClient,
  input: { poId: string; returnId: string; at: Date; lines: ReadonlyArray<{ poLineId: string; qty: DecimalInput }> },
): Promise<void> {
  const valuation = await loadGrirPoValuation(client, input.poId)
  for (const [poLineId, qty] of sumByLine(input.lines)) {
    if (qty.lte(0)) continue
    await writeGrirMovement(client, {
      sourceType: 'SUPPLIER_RETURN',
      sourceRef: input.returnId,
      idempotencyKey: `grir:return:${input.returnId}:${poLineId}`,
      poId: input.poId,
      poLineId,
      supplierId: valuation.supplierId,
      qtyDelta: qty.neg(),
      baseDelta: qty.mul(unitCostFor(valuation, poLineId)).neg(),
      journalDate: input.at,
      occurredAt: input.at,
    })
  }
}

export type GrirCreditAllocationLine = {
  id: string
  /** Quantity still billed and not received on the line (never negative). */
  billedNotReceived: Decimal
  /** Quantity returned and not yet credited. */
  returnedNotCredited: Decimal
  /** The bill's unit price in base currency (billed total / billed quantity); 0 = unknown, which applies no money cap. */
  billedUnitBase: Decimal
}

/**
 * THE ONE ALLOCATION of a return credit note to order lines, used by the live writer and by the stage opening balance so the two cannot disagree: per
 * line (by id), the quantity cleared is the smallest of billed-not-received, returned-not-credited and what the credit's NET still pays for at the bill's
 * unit price (`remaining net / billed unit price`). A credit that covers only part of the returned quantity (a capacity-limited credit) therefore clears
 * only that part; the rest stays for a later note.
 */
export function allocateReturnCredit(lines: ReadonlyArray<GrirCreditAllocationLine>, netBase: DecimalInput): Map<string, Decimal> {
  const out = new Map<string, Decimal>()
  let budget = toDecimal(netBase)
  for (const line of [...lines].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    let qty = Prisma.Decimal.min(line.billedNotReceived, line.returnedNotCredited)
    if (qty.lte(0)) continue
    if (line.billedUnitBase.gt(0)) {
      if (budget.lte(0)) continue
      qty = Prisma.Decimal.min(qty, roundQuantity(budget.div(line.billedUnitBase), 6))
      if (qty.lte(0)) continue
      budget = budget.sub(qty.mul(line.billedUnitBase))
    }
    out.set(line.id, qty)
  }
  return out
}

/** Each order line's billed unit price in base currency (billed total / billed quantity), from the bills' goods lines. */
export async function loadBilledUnitBaseByLine(client: Pick<Prisma.TransactionClient, 'purchaseInvoiceLine'>, poLineIds: string[]): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>()
  if (poLineIds.length === 0) return out
  const rows = await client.purchaseInvoiceLine.groupBy({ by: ['poLineId'], where: { poLineId: { in: poLineIds } }, _sum: { qtyBilled: true, totalBase: true } })
  for (const row of rows) {
    const qty = toDecimal(row._sum.qtyBilled)
    if (row.poLineId && qty.gt(0)) out.set(row.poLineId, toDecimal(row._sum.totalBase).div(qty))
  }
  return out
}

/**
 * A RETURN-GENERATED SUPPLIER CREDIT NOTE: the supplier crediting back goods that were billed and then returned. Valued like the return it answers:
 * the credited quantity at the PO goods unit cost, per line, so a line that was received, billed, returned and credited nets to exactly zero
 * whatever price the bill carried. The credited quantity of a line is what is still BILLED NOT RECEIVED on it (a negative net quantity), capped by the
 * quantity returned and not yet credited AND by what this credit's net pays for at the bill's unit price (`allocateReturnCredit`) (so a prepaid bill ahead of receipt is never cleared by a credit). The difference between the credit's NET
 * (`netBase`, the figure its transit row carries, which carries the bill's price and any FX difference) and the PO-valued credit is a
 * BILL_PRICE_VARIANCE reversal (negative = the credit gives back price difference), so it never reaches the balance. A credit with nothing to clear
 * writes only the variance.
 */
export async function recordGrirReturnCreditNote(
  client: GrirClient,
  input: { poId: string; supplierId: string; creditNoteId: string; netBase: DecimalInput; journalDate: Date | string; at: Date },
): Promise<void> {
  const valuation = await loadGrirPoValuation(client, input.poId)
  const lines = await client.purchaseOrderLine.findMany({ where: { poId: input.poId }, select: { id: true, qtyReturned: true } })
  const history = await client.grirSubledgerMovement.groupBy({
    by: ['poLineId', 'sourceType'],
    where: { poId: input.poId, poLineId: { not: null }, sourceType: { in: [...GRIR_BALANCE_SOURCE_TYPES] } },
    _sum: { qtyDelta: true },
  })
  const netQty = new Map<string, Decimal>()
  const creditedQty = new Map<string, Decimal>()
  for (const row of history) {
    if (!row.poLineId) continue
    const qty = toDecimal(row._sum.qtyDelta)
    netQty.set(row.poLineId, (netQty.get(row.poLineId) ?? new Prisma.Decimal(0)).add(qty))
    if (row.sourceType === 'SUPPLIER_CREDIT_NOTE') creditedQty.set(row.poLineId, (creditedQty.get(row.poLineId) ?? new Prisma.Decimal(0)).add(qty))
  }
  const billedUnit = await loadBilledUnitBaseByLine(client, lines.map((line) => line.id))
  const allocation = allocateReturnCredit(lines.map((line) => ({
    id: line.id,
    billedNotReceived: Prisma.Decimal.max(0, (netQty.get(line.id) ?? new Prisma.Decimal(0)).neg()),
    returnedNotCredited: toDecimal(line.qtyReturned).sub(creditedQty.get(line.id) ?? 0),
    billedUnitBase: billedUnit.get(line.id) ?? new Prisma.Decimal(0),
  })), input.netBase)
  let poValued = new Prisma.Decimal(0)
  for (const [lineId, qty] of allocation) {
    const value = roundQuantity(qty.mul(unitCostFor(valuation, lineId)), 6)
    poValued = poValued.add(value)
    await writeGrirMovement(client, {
      sourceType: 'SUPPLIER_CREDIT_NOTE',
      sourceRef: input.creditNoteId,
      idempotencyKey: `grir:credit-note:${input.creditNoteId}:${lineId}`,
      poId: input.poId,
      poLineId: lineId,
      supplierId: input.supplierId,
      qtyDelta: qty,
      baseDelta: value,
      journalDate: input.journalDate,
      occurredAt: input.at,
    })
  }
  await writeGrirMovement(client, {
    sourceType: GRIR_PRICE_VARIANCE_SOURCE_TYPE,
    sourceRef: input.creditNoteId,
    idempotencyKey: `grir:credit-note-ppv:${input.creditNoteId}`,
    poId: input.poId,
    poLineId: null,
    supplierId: input.supplierId,
    qtyDelta: null,
    baseDelta: poValued.sub(toDecimal(input.netBase)),
    journalDate: input.journalDate,
    occurredAt: input.at,
  })
}

/** The open GR/IR balance (credit-positive) up to and including `asOf`, optionally for one order. */
export async function sumGrirBalance(asOf: Date | string, options: { poId?: string; client?: Pick<typeof db, 'grirSubledgerMovement'> } = {}): Promise<Decimal> {
  const aggregate = await (options.client ?? db).grirSubledgerMovement.aggregate({
    where: {
      sourceType: { in: [...GRIR_BALANCE_SOURCE_TYPES] },
      journalDate: { lte: grirJournalDate(asOf) },
      ...(options.poId ? { poId: options.poId } : {}),
    },
    _sum: { baseDelta: true },
  })
  return toDecimal(aggregate._sum.baseDelta)
}
