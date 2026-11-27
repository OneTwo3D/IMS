import { Prisma } from '@/app/generated/prisma/client'
import { resolveBaseCurrencyCode } from '@/lib/base-currency'
import { businessDateYmd } from '@/lib/business-date'
import { endOfBusinessDateUtc, getFxRateToBase, isMissingFxRateError } from '@/lib/currencies/fx-lookup'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { roundMoney, roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  GRIR_FX_VARIANCE_SOURCE_TYPE, GRIR_PRICE_VARIANCE_SOURCE_TYPE, loadGrirPoValuation, writeGrirMovement, type GrirSourceType,
} from '@/lib/domain/accounting/grir-subledger-movement'
import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'
import { postingIsOwed, reportPostingNotQueued, type EnqueueOutcomeLike } from '@/lib/domain/accounting/enqueue-outcome'
import { headerDiscountFactorForPo } from '@/lib/domain/purchasing/landed-cost-allocation'
import { isPurchaseEventFxEnabled } from '@/lib/domain/purchasing/purchase-event-fx-settings'
import {
  PURCHASE_FX_SOURCE_FX_TABLE, PURCHASE_FX_SOURCE_XERO_PREPAYMENT, PurchaseFxRefusalError, purchaseFxAccountsRefusal,
  type PrepaymentChecks, type PurchaseFxSource,
} from '@/lib/domain/purchasing/purchase-receipt-fx'
import { PURCHASE_PRICE_VARIANCE_ACCOUNT_KEY, REALISED_FX_ACCOUNT_KEY } from '@/lib/domain/settings/system-switches'

/**
 * PER-EVENT FX RATES FOR PURCHASING, STEP 3: the supplier BILL. Behind `purchase_event_fx_rates_enabled`; while it is off, or for an order in the
 * base currency, every function here answers null / does nothing and the bill is valued and posted exactly as before (at the PO rate).
 *
 * THE BILL RATE (owner's final workflow). A foreign bill is valued and posted to Xero at the order's PREPAYMENT LOCK rate (the exact bank rate of
 * the supplier prepayment the owner recorded in Xero), so the prepayment allocation closes with no FX. With no prepayment it is valued at the
 * fx_rates (Aelia) rate in force at the end of the bill date; a missing rate refuses the bill. The rate is resolved PER BILL and stored on it
 * (`fxRateSource`, `fxEventRateToBase`, and `fxRateToBase` 8dp), never copied from the order.
 *
 * THE PPV LINE. Each goods line's STOCK part stays at the PO goods unit cost (in the supplier's currency, after the order's header discount); ANY
 * difference between the bill's price and that cost goes on its own bill line coded to `xero_purchase_price_variance_account`, in the supplier's
 * currency, with the goods line's tax treatment. There is no tolerance split. Quantity differences are not expensed: a bill is still capped by
 * the received (or, for a prepaid supplier, ordered) quantity exactly as before.
 *
 * THE FX DIFFERENCE. The bill's stock part debits Stock in Transit at the BILL rate; each receipt credited it at the rate ITS goods were valued at
 * (the lock, or the table rate at the receipt). Where those differ (a table-rate receipt before the prepayment was recorded, a table-rate bill on
 * another date) the difference is left in transit. It is cleared, PER BILL, by a GBP manual journal (sync type PURCHASE_FX_VARIANCE): DR or CR
 * Realised FX gains/losses against Stock in Transit, recorded on the transit sub-ledger as PURCHASE_FX_VARIANCE and on GR/IR as BILL_FX_VARIANCE.
 * It is computed PER RECEIPT (a prepayment recorded after earlier receipts leaves mixed rates on one order: owner ruling, MED-7): the billed
 * quantity of each order line is matched to the line's receipts in order (earlier bills, including bills from before the switch, take the earlier
 * receipts), and only a matched quantity can have a difference.
 *
 * TARGET STATE, NOT EVENTS. `reconcilePurchaseBillFx` recomputes what every bill of the order SHOULD have posted (GR/IR rows and the FX journal)
 * from the bills and receipts as they are now, and writes only the difference from what is recorded. So it is idempotent (a second run writes
 * nothing), a bill edit adjusts, a deleted or voided bill reverses, and a receipt that arrives after the bill posts the difference then. It runs
 * inside the transaction of every such event, under the purchase_orders row lock (which serialises them).
 *
 * GR/IR. A bill's goods lines debit GR/IR at the ACCRUED RECEIPT VALUE of the matched quantity (what the receipts credited) and at the bill's own
 * stock value for any quantity not received yet, so a foreign order's GR/IR and its transit both net to zero; the FX difference and the price
 * difference are their own variance rows, outside the balance.
 *
 * Bills valued BEFORE the switch (no `fxRateSource`) are left exactly as they are: they only take their receipts first in the matching.
 */

const GRIR_KEY_PREFIX = 'grir:bill-fx:'
const JOURNAL_KEY_PREFIX = 'purchase-fx-variance:'

export type BillFxRate = {
  source: PurchaseFxSource
  /** The rate exactly as it values the bill and is sent to Xero (1 base = rate foreign). */
  rateToBase: Prisma.Decimal
  /** The 8dp copy for `purchase_invoices.fx_rate_to_base`. */
  storedRateToBase: Prisma.Decimal
  lockId: string | null
  currency: string
}

type BillFxClient = Pick<Prisma.TransactionClient, 'setting' | 'purchaseOrder' | 'purchaseOrderFxLock' | 'organisation' | 'fxRate'>

/**
 * The rate a NEW bill of this order is valued at, or null (switch off, or a base-currency order: the PO rate, as before). Read on the caller's
 * client: before the transaction to price the bill, and again inside it, under the purchase_orders row lock, where the caller refuses if the two
 * disagree. `checks` is the evidence `preparePurchaseReceiptFx` established before the transaction (a "no prepayment" answer, Xero sync off).
 */
export async function resolveBillFxRate(
  client: BillFxClient,
  params: { poId: string; invoiceDate: string; checks: PrepaymentChecks },
): Promise<BillFxRate | null> {
  if (!(await isPurchaseEventFxEnabled(client))) return null
  const po = await client.purchaseOrder.findUnique({ where: { id: params.poId }, select: { reference: true, currency: true } })
  if (!po) throw new Error(`Purchase order ${params.poId} not found`)
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: client.organisation })).toUpperCase()
  const currency = po.currency.trim().toUpperCase()
  if (currency === baseCurrency) return null

  const accountsRefusal = await purchaseFxAccountsRefusal(client)
  if (accountsRefusal) throw new PurchaseFxRefusalError(accountsRefusal.replace('Nothing was received.', 'The bill was not saved.'))
  const check = params.checks.get(params.poId)
  if (check?.kind === 'refused') throw new PurchaseFxRefusalError(check.reason.replace('Nothing was received.', 'The bill was not saved.'), { transient: check.transient })

  const lock = await client.purchaseOrderFxLock.findUnique({ where: { poId: params.poId }, select: { id: true, currency: true, rateToBase: true, xeroPrepaymentId: true } })
  if (lock) {
    if (lock.currency.trim().toUpperCase() !== currency) {
      throw new PurchaseFxRefusalError(
        `${po.reference} is in ${currency} but its goods are locked to a ${lock.currency} Xero prepayment (${lock.xeroPrepaymentId}). The bill was not saved. `
        + 'Correct the prepayment or the order so they agree, then use Read from Xero on the order.',
      )
    }
    const rateToBase = new Prisma.Decimal(lock.rateToBase)
    return { source: PURCHASE_FX_SOURCE_XERO_PREPAYMENT, rateToBase, storedRateToBase: rateToBase.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP), lockId: lock.id, currency }
  }
  if (!check || check.kind === 'locked') {
    throw new PurchaseFxRefusalError(
      `The Xero supplier prepayment for ${po.reference} was not read before this bill (per-event FX rates were turned on, or its lock removed, while it was `
      + 'being saved). The bill was not saved; try again.',
      { transient: true },
    )
  }
  try {
    const fx = await getFxRateToBase(client, { currency, asOf: endOfBusinessDateUtc(params.invoiceDate.slice(0, 10)), baseCurrency })
    const rateToBase = new Prisma.Decimal(fx.rate)
    return { source: PURCHASE_FX_SOURCE_FX_TABLE, rateToBase, storedRateToBase: rateToBase.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP), lockId: null, currency }
  } catch (error) {
    if (!isMissingFxRateError(error)) throw error
    throw new PurchaseFxRefusalError(
      `There is no ${currency} exchange rate on or before the bill date ${params.invoiceDate.slice(0, 10)} in the exchange-rate table, and Xero holds no prepayment `
      + `for ${po.reference}. The bill was not saved: IMS never guesses a rate. Check the exchange-rate feed, or give the order a Xero supplier prepayment whose Reference is ${po.reference}.`,
    )
  }
}

/** Two resolutions of the same bill agree (the same rule and the same exact rate). */
export function sameBillFxRate(a: BillFxRate | null, b: BillFxRate | null): boolean {
  if (!a || !b) return a === b
  return a.source === b.source && a.rateToBase.eq(b.rateToBase) && a.lockId === b.lockId
}

/** The bill now posts at the lock's rate: the lock is final from here on (a lock a posting has used is never replaced). Idempotent. */
export async function markPurchaseFxLockUsedByBill(tx: Pick<Prisma.TransactionClient, 'purchaseOrderFxLock'>, rate: BillFxRate | null, at: Date): Promise<void> {
  if (!rate?.lockId) return
  await tx.purchaseOrderFxLock.updateMany({ where: { id: rate.lockId, firstUsedAt: null }, data: { firstUsedAt: at } })
}

/**
 * The PO goods unit cost of every order line in the ORDER's currency, after the header discount (the same factor the receipt valuation uses,
 * read from the foreign totals), 4dp HALF_UP: the price a bill's stock part is billed at.
 */
export function stockUnitsForeign(po: {
  subtotalForeign: DecimalInput
  lines: ReadonlyArray<{ id: string; unitCostForeign: DecimalInput; totalForeign: DecimalInput }>
}): Map<string, Decimal> {
  const factor = headerDiscountFactorForPo({ subtotalBase: toDecimal(po.subtotalForeign), lines: po.lines.map((line) => ({ totalBase: toDecimal(line.totalForeign) })) })
  const out = new Map<string, Decimal>()
  for (const line of po.lines) out.set(line.id, roundQuantity(toDecimal(line.unitCostForeign).mul(factor), 4))
  return out
}

/** The PPV account code, as the bill's variance lines are coded. Read on the caller's client. */
export async function purchasePriceVarianceAccount(client: Pick<Prisma.TransactionClient, 'setting'>): Promise<string> {
  const row = await client.setting.findUnique({ where: { key: PURCHASE_PRICE_VARIANCE_ACCOUNT_KEY }, select: { value: true } })
  return row?.value?.trim() ?? ''
}

// ─── THE MATCHING (pure) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One receipt of one order line, in receipt order: its quantity and the goods value it credited (GR/IR RECEIPT row). */
export type ReceiptLot = { qty: Decimal; valueBase: Decimal }

export type BillForMatching = {
  invoiceId: string
  /**
   * A bill valued under the switch. A bill valued at the PO rate (before the switch) takes its receipts first too, and gets a target only when
   * `poGoodsUnitBaseByLine` is given (HIGH-2): its stock is valued at the PO goods unit cost it debited transit with.
   */
  managed: boolean
  /** Managed only: the bill's exact rate. */
  rateToBase: Decimal | null
  lines: ReadonlyArray<{ poLineId: string; qty: Decimal; stockForeign: Decimal; ppvBase: Decimal }>
}

export type BillLineFxTarget = {
  invoiceId: string
  poLineId: string
  qty: Decimal
  /** What GR/IR is debited with: the matched receipts' value, plus the bill's own stock value for the quantity not received yet. */
  accruedBase: Decimal
  /** The bill's stock part at its own rate. */
  stockBase: Decimal
  /** stockBase - accruedBase (positive = the bill costs more in base than the goods were received at). */
  fxVarianceBase: Decimal
  ppvBase: Decimal
  /** False for a PO-rate bill (valued before the switch): only its FX difference is this writer's; its BILL and PPV rows are the standard writer's. */
  managed: boolean
}

/**
 * Match each bill's billed quantity, per order line, to the line's receipts in order (bills in bill order), and value each managed bill line.
 * A matched quantity is accrued at the receipt's own value (per receipt: mixed rates on one order are valued receipt by receipt); a quantity no
 * receipt covers yet is accrued at the bill's stock value and so carries no difference until its receipt arrives.
 */
export function matchBillsToReceipts(
  lotsByLine: ReadonlyMap<string, ReadonlyArray<ReceiptLot>>,
  bills: ReadonlyArray<BillForMatching>,
  /** HIGH-2: the PO goods unit cost per line (base, 6dp), to value the PO-rate bills; absent = they get no target. */
  poGoodsUnitBaseByLine?: ReadonlyMap<string, Decimal>,
): BillLineFxTarget[] {
  const remaining = new Map<string, Array<{ qty: Decimal; valueBase: Decimal }>>()
  for (const [lineId, lots] of lotsByLine) remaining.set(lineId, lots.filter((lot) => lot.qty.gt(0)).map((lot) => ({ qty: lot.qty, valueBase: lot.valueBase })))
  const out: BillLineFxTarget[] = []
  for (const bill of bills) {
    const perLine = new Map<string, { qty: Decimal; stockForeign: Decimal; ppvBase: Decimal }>()
    for (const line of bill.lines) {
      const entry = perLine.get(line.poLineId) ?? { qty: new Prisma.Decimal(0), stockForeign: new Prisma.Decimal(0), ppvBase: new Prisma.Decimal(0) }
      entry.qty = entry.qty.add(line.qty)
      entry.stockForeign = entry.stockForeign.add(line.stockForeign)
      entry.ppvBase = entry.ppvBase.add(line.ppvBase)
      perLine.set(line.poLineId, entry)
    }
    for (const [poLineId, line] of perLine) {
      if (line.qty.lte(0)) continue
      const lots = remaining.get(poLineId) ?? []
      let matchedQty = new Prisma.Decimal(0)
      let matchedValue = new Prisma.Decimal(0)
      while (lots.length > 0 && matchedQty.lt(line.qty)) {
        const lot = lots[0]!
        const want = line.qty.sub(matchedQty)
        if (lot.qty.lte(want)) {
          matchedQty = matchedQty.add(lot.qty)
          matchedValue = matchedValue.add(lot.valueBase)
          lots.shift()
        } else {
          const value = lot.valueBase.mul(want).div(lot.qty)
          matchedQty = matchedQty.add(want)
          matchedValue = matchedValue.add(value)
          lot.qty = lot.qty.sub(want)
          lot.valueBase = lot.valueBase.sub(value)
        }
      }
      const unmatched = line.qty.sub(matchedQty)
      if (bill.managed && bill.rateToBase) {
        const stockBase = roundQuantity(line.stockForeign.div(bill.rateToBase), 6)
        const accruedBase = roundQuantity(matchedValue.add(stockBase.mul(unmatched).div(line.qty)), 6)
        out.push({ invoiceId: bill.invoiceId, poLineId, qty: line.qty, accruedBase, stockBase, fxVarianceBase: stockBase.sub(accruedBase), ppvBase: roundQuantity(line.ppvBase, 6), managed: true })
        continue
      }
      const poUnit = poGoodsUnitBaseByLine?.get(poLineId)
      if (!poUnit) continue
      // A PO-rate bill debited GR/IR (and transit) at the PO goods value; a receipt valued under the switch credited its own value. Receipts valued at
      // the PO rate leave no difference, so the dust of the proportional split is dropped below 0.0001.
      const stockBase = roundQuantity(line.qty.mul(poUnit), 6)
      const accruedBase = roundQuantity(matchedValue.add(poUnit.mul(unmatched)), 6)
      let fxVarianceBase = stockBase.sub(accruedBase)
      if (fxVarianceBase.abs().lt('0.0001')) fxVarianceBase = new Prisma.Decimal(0)
      out.push({ invoiceId: bill.invoiceId, poLineId, qty: line.qty, accruedBase: stockBase.sub(fxVarianceBase), stockBase, fxVarianceBase, ppvBase: new Prisma.Decimal(0), managed: false })
    }
  }
  return out
}

// ─── THE RECONCILIATION (in the event's transaction) ─────────────────────────────────────────────────────────────────────────────────

export type PurchaseBillFxReconcileResult = {
  /** The FX journals queued by this run (bill id, signed transit movement). */
  journals: Array<{ invoiceId: string; transitDelta: string }>
  /** Journals the queue declined while owed: the caller reports them after its commit (`reportPurchaseFxVarianceNotQueued`). */
  notQueued: Array<{ invoiceId: string; outcome: EnqueueOutcomeLike }>
}

export const NO_BILL_FX_RECONCILE: PurchaseBillFxReconcileResult = { journals: [], notQueued: [] }

type Accum = { balQty: Decimal; balBase: Decimal; fx: Decimal; ppv: Decimal; rows: number; journalDate: Date | null }

const zero = (): Decimal => new Prisma.Decimal(0)

/**
 * Bring every bill of this order valued under the switch to its target GR/IR rows and FX journal (see the module comment). The caller holds the
 * purchase_orders row lock and runs this in the transaction of the event that changed the bills or the receipts (a bill created, edited or
 * deleted, a receipt laid). THE CALLER DECIDES whether it applies: a bill valued under the switch, or a receipt valued under it (so a bill valued
 * under the switch is still corrected, or reversed when it is deleted in Xero, after the switch is turned off). Nothing to do for a base-currency
 * order or an order with no such bill. The journal is queued only while `syncEnabled` and the connector is Xero; GR/IR always accrues.
 */
export async function reconcilePurchaseBillFx(
  tx: Prisma.TransactionClient,
  params: { poId: string; connector: string | null; syncEnabled: boolean; at: Date },
): Promise<PurchaseBillFxReconcileResult> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: params.poId },
    select: {
      reference: true, currency: true, supplierId: true,
      freightCostLines: { select: { id: true, amountForeign: true, amountBase: true } },
    },
  })
  if (!po) throw new Error(`Purchase order ${params.poId} not found`)
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: tx.organisation })).toUpperCase()
  if (po.currency.trim().toUpperCase() === baseCurrency) return NO_BILL_FX_RECONCILE

  const bills = await tx.purchaseInvoice.findMany({
    where: { poId: params.poId },
    orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, invoiceNumber: true, invoiceDate: true, fxRateSource: true, fxEventRateToBase: true,
      lines: { select: { poLineId: true, costLineId: true, qtyBilled: true, totalForeign: true, totalBase: true, stockUnitForeign: true } },
    },
  })
  const receipts = await tx.grirSubledgerMovement.findMany({
    where: { poId: params.poId, sourceType: 'RECEIPT', poLineId: { not: null } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { poLineId: true, qtyDelta: true, baseDelta: true },
  })
  const lotsByLine = new Map<string, ReceiptLot[]>()
  for (const row of receipts) {
    if (!row.poLineId || row.qtyDelta === null) continue
    const lots = lotsByLine.get(row.poLineId) ?? []
    lots.push({ qty: toDecimal(row.qtyDelta), valueBase: toDecimal(row.baseDelta) })
    lotsByLine.set(row.poLineId, lots)
  }
  const managed = new Map(bills.filter((bill) => bill.fxRateSource && bill.fxEventRateToBase).map((bill) => [bill.id, bill]))
  const billById = new Map(bills.map((bill) => [bill.id, bill]))
  // HIGH-2: bills valued at the PO rate (before the switch) are valued at the PO goods unit cost, the figure they debited GR/IR and transit with.
  const poGoods = (await loadGrirPoValuation(tx, params.poId)).goodsUnitCostByLine
  const targets = matchBillsToReceipts(lotsByLine, bills.map((bill) => {
    const rate = bill.fxEventRateToBase ? toDecimal(bill.fxEventRateToBase) : null
    return {
      invoiceId: bill.id,
      managed: managed.has(bill.id),
      rateToBase: rate,
      lines: bill.lines.flatMap((line) => {
        if (!line.poLineId) return []
        const qty = toDecimal(line.qtyBilled)
        const stockForeign = line.stockUnitForeign !== null ? roundMoney(qty.mul(toDecimal(line.stockUnitForeign)), po.currency) : toDecimal(line.totalForeign)
        const stockBase4 = rate ? roundQuantity(stockForeign.div(rate), 4) : toDecimal(line.totalBase)
        return [{ poLineId: line.poLineId, qty, stockForeign, ppvBase: toDecimal(line.totalBase).sub(stockBase4) }]
      }),
    }
  }), poGoods)

  // ── GR/IR: target rows per (bill, line), against what is recorded under this writer's keys (a deleted bill's rows go back to zero). ──
  const recorded = await tx.grirSubledgerMovement.findMany({
    where: { poId: params.poId, idempotencyKey: { startsWith: GRIR_KEY_PREFIX } },
    select: { sourceRef: true, poLineId: true, sourceType: true, qtyDelta: true, baseDelta: true },
  })
  const current = new Map<string, Accum>()
  const keyOf = (invoiceId: string, poLineId: string): string => `${invoiceId}|${poLineId}`
  for (const row of recorded) {
    if (!row.poLineId) continue
    const key = keyOf(row.sourceRef, row.poLineId)
    const acc = current.get(key) ?? { balQty: zero(), balBase: zero(), fx: zero(), ppv: zero(), rows: 0, journalDate: null }
    acc.rows += 1
    if (row.sourceType === GRIR_FX_VARIANCE_SOURCE_TYPE) acc.fx = acc.fx.add(toDecimal(row.baseDelta))
    else if (row.sourceType === GRIR_PRICE_VARIANCE_SOURCE_TYPE) acc.ppv = acc.ppv.add(toDecimal(row.baseDelta))
    else {
      acc.balBase = acc.balBase.add(toDecimal(row.baseDelta))
      acc.balQty = acc.balQty.add(toDecimal(row.qtyDelta ?? 0))
    }
    current.set(key, acc)
  }
  const wanted = new Map<string, { invoiceId: string; poLineId: string; balQty: Decimal; balBase: Decimal; fx: Decimal; ppv: Decimal; journalDate: Date }>()
  for (const target of targets) {
    const bill = billById.get(target.invoiceId)!
    if (target.managed) {
      wanted.set(keyOf(target.invoiceId, target.poLineId), {
        invoiceId: target.invoiceId, poLineId: target.poLineId,
        balQty: target.qty.neg(), balBase: target.accruedBase.neg(), fx: target.fxVarianceBase, ppv: target.ppvBase, journalDate: bill.invoiceDate,
      })
      continue
    }
    // HIGH-2: a PO-rate bill keeps its standard BILL and PPV rows (the PO goods value); this writer only moves its GR/IR debit from that value to the
    // value the receipts credited (a BILL_UPDATE of base only) and records the FX difference, dated on the event that revealed it.
    if (target.fxVarianceBase.isZero() && !current.has(keyOf(target.invoiceId, target.poLineId))) continue
    wanted.set(keyOf(target.invoiceId, target.poLineId), {
      invoiceId: target.invoiceId, poLineId: target.poLineId,
      balQty: zero(), balBase: target.fxVarianceBase, fx: target.fxVarianceBase, ppv: zero(), journalDate: params.at,
    })
  }
  // A bill that is gone (deleted, or voided in Xero) or no longer bills the line: its rows go back to zero.
  for (const key of current.keys()) {
    if (wanted.has(key)) continue
    const [invoiceId, poLineId] = key.split('|') as [string, string]
    wanted.set(key, { invoiceId, poLineId, balQty: zero(), balBase: zero(), fx: zero(), ppv: zero(), journalDate: params.at })
  }
  for (const [key, want] of wanted) {
    const have = current.get(key) ?? { balQty: zero(), balBase: zero(), fx: zero(), ppv: zero(), rows: 0, journalDate: null }
    const seq = have.rows
    const base = {
      sourceRef: want.invoiceId, poId: params.poId, poLineId: want.poLineId, supplierId: po.supplierId,
      journalDate: have.rows === 0 ? want.journalDate : params.at, occurredAt: params.at,
    }
    const write = async (sourceType: GrirSourceType, kind: string, qtyDelta: Decimal | null, baseDelta: Decimal): Promise<void> => {
      await writeGrirMovement(tx, { ...base, sourceType, idempotencyKey: `${GRIR_KEY_PREFIX}${want.invoiceId}:${want.poLineId}:${kind}:${seq}`, qtyDelta, baseDelta })
    }
    const balQtyDelta = roundQuantity(want.balQty.sub(have.balQty), 6)
    const balBaseDelta = roundQuantity(want.balBase.sub(have.balBase), 6)
    const firstRowOfManagedBill = have.rows === 0 && managed.has(want.invoiceId)
    if (!balQtyDelta.isZero() || !balBaseDelta.isZero()) await write(firstRowOfManagedBill ? 'BILL' : 'BILL_UPDATE', 'bal', balQtyDelta.isZero() && !firstRowOfManagedBill ? null : balQtyDelta, balBaseDelta)
    await write(GRIR_FX_VARIANCE_SOURCE_TYPE, 'fx', null, want.fx.sub(have.fx))
    await write(GRIR_PRICE_VARIANCE_SOURCE_TYPE, 'ppv', null, want.ppv.sub(have.ppv))
  }

  // ── Stock in Transit: one GBP journal per bill for the change in its FX difference (goods lines per receipt, plus freight lines vs the PO rate). ──
  const fxByBill = new Map<string, Decimal>()
  for (const target of targets) fxByBill.set(target.invoiceId, (fxByBill.get(target.invoiceId) ?? zero()).add(target.fxVarianceBase))
  const costLineById = new Map(po.freightCostLines.map((line) => [line.id, line]))
  for (const bill of managed.values()) {
    for (const line of bill.lines) {
      const costLine = line.costLineId ? costLineById.get(line.costLineId) : undefined
      if (!costLine) continue
      const amountForeign = toDecimal(costLine.amountForeign)
      if (!amountForeign.gt(0)) continue
      // The receipt drains a cost line at its PO-rate base value; the bill debited transit at its own rate.
      const atPoRate = toDecimal(line.totalForeign).mul(toDecimal(costLine.amountBase)).div(amountForeign)
      fxByBill.set(bill.id, (fxByBill.get(bill.id) ?? zero()).add(toDecimal(line.totalBase).sub(atPoRate)))
    }
  }
  const transitRows = await tx.transitSubledgerMovement.findMany({
    where: { sourceType: 'PURCHASE_FX_VARIANCE', sourceRef: params.poId, idempotencyKey: { startsWith: JOURNAL_KEY_PREFIX } },
    select: { idempotencyKey: true, baseDelta: true },
  })
  const postedByBill = new Map<string, { sum: Decimal; rows: number }>()
  for (const row of transitRows) {
    const invoiceId = row.idempotencyKey.slice(JOURNAL_KEY_PREFIX.length).split(':')[0]!
    const entry = postedByBill.get(invoiceId) ?? { sum: zero(), rows: 0 }
    entry.sum = entry.sum.add(toDecimal(row.baseDelta))
    entry.rows += 1
    postedByBill.set(invoiceId, entry)
  }
  // MED-1: only a bill whose OWN posting was queued (its PURCHASE_BILL transit row exists, keyed `purchase-invoice:<bill>:...`) can leave a difference
  // in the ledger's transit account. A bill posted by hand, declined, or recorded with bill sync off has nothing in transit to clear: its target is 0.
  const billTransitKeys = (await tx.transitSubledgerMovement.findMany({
    where: { sourceType: 'PURCHASE_BILL', sourceRef: params.poId }, select: { idempotencyKey: true },
  })).map((row) => row.idempotencyKey)
  const billPosted = (invoiceId: string): boolean => billTransitKeys.some((key) => key.startsWith(`purchase-invoice:${invoiceId}:`))
  const billIds = new Set([...fxByBill.keys(), ...postedByBill.keys()])
  const result: PurchaseBillFxReconcileResult = { journals: [], notQueued: [] }
  let accounts: { transit: string; realisedFx: string } | null = null
  for (const invoiceId of billIds) {
    const owed = billById.has(invoiceId) && billPosted(invoiceId)
    const targetTransit = owed ? roundQuantity((fxByBill.get(invoiceId) ?? zero()).neg(), 2) : zero()
    const posted = postedByBill.get(invoiceId) ?? { sum: zero(), rows: 0 }
    const delta = roundQuantity(targetTransit.sub(posted.sum), 2)
    if (delta.isZero()) continue
    if (!params.syncEnabled || params.connector !== 'xero') continue
    const { lockAccountingMappingSelection } = await import('@/lib/integration-plugin-selection-lock')
    const { queueAccountingSyncTx, readStockReceiptAccountsTx } = await import('@/lib/accounting')
    if (!accounts) {
      await lockAccountingMappingSelection(tx, 'xero')
      const receiptAccounts = await readStockReceiptAccountsTx(tx, 'xero')
      const realised = (await tx.setting.findUnique({ where: { key: REALISED_FX_ACCOUNT_KEY }, select: { value: true } }))?.value?.trim() ?? ''
      if (!receiptAccounts.transitAccount || !realised) {
        throw new PurchaseFxRefusalError(
          `The exchange-rate difference on ${po.reference} cannot be posted: ${!receiptAccounts.transitAccount ? 'the Stock in Transit account' : `Realised FX Gain/Loss (${REALISED_FX_ACCOUNT_KEY})`} `
          + 'is not mapped. Nothing was changed. Map it under Sync > Accounting settings, then retry.',
        )
      }
      accounts = { transit: receiptAccounts.transitAccount, realisedFx: realised }
    }
    const bill = billById.get(invoiceId)
    const amount = delta.abs().toNumber()
    const label = bill ? `bill ${bill.invoiceNumber ?? bill.id}` : `deleted bill ${invoiceId}`
    const description = `Exchange-rate difference: ${po.reference} ${label}`
    const transitLine = { accountCode: accounts.transit, description, ...(delta.gt(0) ? { debit: amount } : { credit: amount }) }
    const fxLine = { accountCode: accounts.realisedFx, description, ...(delta.gt(0) ? { credit: amount } : { debit: amount }) }
    const payload = {
      date: businessDateYmd(params.at),
      reference: `FX: ${po.reference}`,
      narration: `Exchange-rate difference between the receipts and ${label} of PO ${po.reference}, cleared from Stock in Transit to Realised FX gains/losses`,
      lines: delta.gt(0) ? [transitLine, fxLine] : [fxLine, transitLine],
    }
    const idempotencyKey = accountingPayloadKey(`${JOURNAL_KEY_PREFIX}${invoiceId}`, { ...payload, revision: posted.rows })
    const answered: { outcome?: EnqueueOutcomeLike } = {}
    const queued = await queueAccountingSyncTx(tx, {
      type: 'PURCHASE_FX_VARIANCE',
      referenceType: 'PurchaseOrder',
      referenceId: params.poId,
      payload,
      idempotencyKey,
      chartConnector: 'xero',
      reportOutcome: (outcome) => { answered.outcome = outcome },
    })
    if (queued) {
      await recordTransitSubledgerMovement(tx, {
        sourceType: 'PURCHASE_FX_VARIANCE', sourceRef: params.poId, idempotencyKey, baseDelta: delta, journalDate: payload.date,
      })
      result.journals.push({ invoiceId, transitDelta: delta.toFixed(2) })
    } else if (answered.outcome && postingIsOwed(answered.outcome)) {
      result.notQueued.push({ invoiceId, outcome: answered.outcome })
    }
  }
  return result
}

/** AFTER the commit: report each FX journal the queue declined while it was owed (an activity write uses its own connection). */
export async function reportPurchaseFxVarianceNotQueued(poId: string, poReference: string, result: PurchaseBillFxReconcileResult): Promise<void> {
  if (result.notQueued.length === 0) return
  for (const entry of result.notQueued) {
    await reportPostingNotQueued({
      entityType: 'PURCHASE_ORDER',
      entityId: poId,
      action: 'purchase_fx_variance_not_queued',
      kind: 'purchase_fx_variance',
      posting: `the exchange-rate difference journal for PO ${poReference} (bill ${entry.invoiceId})`,
      committed: 'the bill and the receipts are recorded in IMS',
      // HIGH-1: never by hand. The reconciliation works from target state, so the next run queues what is still owed; a journal posted by hand as
      // well would be booked twice.
      remedy: 'Stock in Transit still holds the exchange-rate difference between the receipts and the bill. Leave the ledger as it is (a copy keyed in by hand would be booked twice): '
        + `once the cause is fixed, run \`npm run purchase-fx:reconcile -- --po ${poId} --apply\`, which queues only what is still owed (the next bill `
        + 'edit or receipt of the order does the same), then mark this row handled.',
      outcome: entry.outcome,
      metadata: { reference: poReference, invoiceId: entry.invoiceId, chartConnector: 'xero' },
    })
  }
}

// ─── THE SUPPORTED RE-RUN AND THE TURN-ON CHECK (HIGH-1, HIGH-2) ─────────────────────────────────────────────────────────────────────────

/**
 * The foreign orders this writer may owe something for: a bill valued under the switch, a receipt or layer valued under it, or a row it wrote.
 * Read-only.
 */
export async function purchaseFxOrdersToReconcile(client: Pick<Prisma.TransactionClient, 'purchaseInvoice' | 'purchaseReceipt' | 'costLayer' | 'grirSubledgerMovement' | 'transitSubledgerMovement'>): Promise<string[]> {
  const ids = new Set<string>()
  for (const row of await client.purchaseInvoice.findMany({ where: { fxRateSource: { not: null } }, select: { poId: true } })) ids.add(row.poId)
  for (const row of await client.purchaseReceipt.findMany({ where: { fxRateSource: { not: null } }, select: { poId: true } })) ids.add(row.poId)
  for (const row of await client.costLayer.findMany({ where: { fxRateSource: { not: null }, poLineId: { not: null } }, select: { poLine: { select: { poId: true } } } })) {
    if (row.poLine) ids.add(row.poLine.poId)
  }
  for (const row of await client.grirSubledgerMovement.findMany({ where: { idempotencyKey: { startsWith: GRIR_KEY_PREFIX } }, select: { poId: true }, distinct: ['poId'] })) ids.add(row.poId)
  for (const row of await client.transitSubledgerMovement.findMany({ where: { sourceType: 'PURCHASE_FX_VARIANCE' }, select: { sourceRef: true }, distinct: ['sourceRef'] })) ids.add(row.sourceRef)
  return [...ids].sort()
}

/**
 * HIGH-1, THE SUPPORTED RE-RUN: bring one order's bills to their target state now, under its purchase_orders row lock, exactly as the next bill edit
 * or receipt would. Idempotent: an order that owes nothing writes nothing. What the queue declines is reported (and stays owed for the next run).
 */
export async function rerunPurchaseBillFx(poId: string, options: { at?: Date } = {}): Promise<PurchaseBillFxReconcileResult> {
  const { db } = await import('@/lib/db')
  const { getAccountingSettings } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  const po = await db.purchaseOrder.findUnique({ where: { id: poId }, select: { reference: true } })
  if (!po) throw new Error(`Purchase order ${poId} not found`)
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
    return reconcilePurchaseBillFx(tx, { poId, connector: settings.connector, syncEnabled: settings.syncEnabled, at: options.at ?? new Date() })
  }, { timeout: 60_000, maxWait: 10_000 })
  await reportPurchaseFxVarianceNotQueued(poId, po.reference, result)
  return result
}

export type PurchaseFxInFlightOrder = { poId: string; reference: string; currency: string; status: string; lines: Array<{ poLineId: string; billedQty: string; receivedQty: string }> }

/**
 * HIGH-2, THE TURN-ON CHECK: foreign orders with a bill valued at the PO rate for goods not received yet. Their later receipts are valued under the
 * switch, so each leaves an exchange-rate difference that this writer clears per receipt; the list is what the owner reviews before turning it on.
 * Read-only.
 */
export async function listPurchaseFxInFlightOrders(client: Pick<Prisma.TransactionClient, 'purchaseOrder' | 'organisation' | 'grirSubledgerMovement'>): Promise<PurchaseFxInFlightOrder[]> {
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: client.organisation })).toUpperCase()
  const orders = await client.purchaseOrder.findMany({
    where: { status: { not: 'CANCELLED' }, NOT: { currency: baseCurrency }, invoices: { some: { fxRateSource: null } } },
    orderBy: { reference: 'asc' },
    select: { id: true, reference: true, currency: true, status: true, invoices: { where: { fxRateSource: null }, select: { lines: { select: { poLineId: true, qtyBilled: true } } } } },
  })
  const out: PurchaseFxInFlightOrder[] = []
  for (const order of orders) {
    if (order.currency.trim().toUpperCase() === baseCurrency) continue
    const billed = new Map<string, Decimal>()
    for (const invoice of order.invoices) for (const line of invoice.lines) {
      if (line.poLineId) billed.set(line.poLineId, (billed.get(line.poLineId) ?? zero()).add(toDecimal(line.qtyBilled)))
    }
    const received = new Map<string, Decimal>()
    for (const row of await client.grirSubledgerMovement.groupBy({ by: ['poLineId'], where: { poId: order.id, sourceType: 'RECEIPT' }, _sum: { qtyDelta: true } })) {
      if (row.poLineId) received.set(row.poLineId, toDecimal(row._sum.qtyDelta ?? 0))
    }
    const lines = [...billed].filter(([lineId, qty]) => qty.gt(received.get(lineId) ?? 0))
      .map(([poLineId, qty]) => ({ poLineId, billedQty: qty.toString(), receivedQty: (received.get(poLineId) ?? zero()).toString() }))
    if (lines.length > 0) out.push({ poId: order.id, reference: order.reference, currency: order.currency, status: order.status, lines })
  }
  return out
}
