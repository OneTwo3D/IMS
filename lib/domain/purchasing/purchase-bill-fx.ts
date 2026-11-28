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
import { isShadowedOutcome, postingIsOwed, reportPostingNotQueued, type EnqueueOutcomeLike } from '@/lib/domain/accounting/enqueue-outcome'
import { headerDiscountFactorForPo } from '@/lib/domain/purchasing/landed-cost-allocation'
import { isPurchaseEventFxEnabled } from '@/lib/domain/purchasing/purchase-event-fx-settings'
import { purchaseFxBillWriterShadowed } from '@/lib/domain/purchasing/purchase-event-fx-switch-on'
import { withLedgerCheck } from '@/lib/domain/accounting/hand-post-instruction'
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
 * Bills valued BEFORE the switch (no `fxRateSource`) are left exactly as they are: they only take their receipts first in the matching, valued at what
 * they debited GR/IR with (their own grir:bill rows, MED-B); their price difference stays on transit (owner ruling 2026-11-26).
 *
 * STEP 3b: RETURNS AND CREDIT NOTES. What a line has received is its RECEIPT rows and positive OPENING_BALANCE rows less its SUPPLIER_RETURN rows
 * (`receiptLotsAfterReturns`); a return is valued at the goods cost of the layers it consumed, so the lots keep exactly what is still received. A
 * supplier credit note reverses its bill at the bill's rate (`billCreditRate`), a credit with no bill at its own date's fx_rates rate
 * (`resolveNoBillCreditFxRate`). A journal the producer-side hold shadows is SETTLED (`purchase_fx_variance_shadows`, MED-2).
 *
 * MED-D, WHY NO TRANSIT ROW IS WRITTEN LATER for a bill whose first posting was declined: IMS never re-queues a declined PURCHASE_INVOICE (re-sending
 * would be a second bill; its refusal kind is 'manual'), and a refusal marked handled means someone keyed the bill into the ledger by hand. IMS cannot
 * know what was keyed (which account, which rate, split or not), so a PURCHASE_BILL row asserting it would make this writer clear a difference that may
 * not be in transit at all. Such a bill is one IMS did not post: `--in-flight` names it (MED-C) and the journal decision is the owner's.
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

  // The bill-writer check, on the bill's own date (a bill dated before the cut-over, or a rollback to P1): while the producer-side hold shadows the bill,
  // Xero holds another system's bill, so this one is valued at the PO rate exactly as before (purchase-event-fx-switch-on.ts).
  if (purchaseFxBillWriterShadowed(params.invoiceDate.slice(0, 10))) return null
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

// ─── SUPPLIER CREDIT NOTES (step 3b) ────────────────────────────────────────────────────────────────────────────────────────────────────

/** `supplier_credit_notes.fx_rate_source`: the credit takes the exact rate of the bill it reverses (a bill valued under the switch). */
export const CREDIT_FX_SOURCE_BILL = 'BILL'
/** `supplier_credit_notes.fx_rate_source`: a credit with no bill, at the fx_rates rate on its own date. */
export const CREDIT_FX_SOURCE_FX_TABLE = PURCHASE_FX_SOURCE_FX_TABLE

/** A bill valued under the switch (it carries its own exact rate). */
export function billIsFxManaged(bill: { fxRateSource: string | null; fxEventRateToBase: DecimalInput | null }): boolean {
  return Boolean(bill.fxRateSource && bill.fxEventRateToBase !== null && bill.fxEventRateToBase !== undefined)
}

/**
 * THE RATE A CREDIT AGAINST THIS BILL IS VALUED AT: the bill's own. A bill valued under the switch gives its exact rate (and the credit records where it
 * came from); any other bill gives its stored rate, exactly as before.
 */
export function billCreditRate(bill: { fxRateToBase: DecimalInput; fxRateSource: string | null; fxEventRateToBase: DecimalInput | null }): {
  rateToBase: Prisma.Decimal
  columns: { fxRateSource?: string; fxEventRateToBase?: Prisma.Decimal }
} {
  if (billIsFxManaged(bill)) {
    const exact = new Prisma.Decimal(toDecimal(bill.fxEventRateToBase!))
    return { rateToBase: exact, columns: { fxRateSource: CREDIT_FX_SOURCE_BILL, fxEventRateToBase: exact } }
  }
  return { rateToBase: new Prisma.Decimal(toDecimal(bill.fxRateToBase)), columns: {} }
}

/**
 * A CREDIT WITH NO BILL (owner ruling 4): valued at the fx_rates rate in force at the end of its own date, refused when there is none. Null while the
 * switch is off, for a base-currency order, or for an order the switch never touched (the caller keeps its old rule). Read on the caller's client.
 */
export async function resolveNoBillCreditFxRate(
  client: Pick<Prisma.TransactionClient, 'setting' | 'purchaseOrder' | 'organisation' | 'fxRate' | 'purchaseInvoice' | 'purchaseReceipt' | 'grirSubledgerMovement' | 'transitSubledgerMovement' | 'purchaseFxVarianceShadow' | 'purchaseFxNonImsBillApproval'>,
  params: { poId: string; creditDate: string },
): Promise<{ rateToBase: Prisma.Decimal; storedRateToBase: Prisma.Decimal; columns: { fxRateSource: string; fxEventRateToBase: Prisma.Decimal } } | null> {
  if (!(await isPurchaseEventFxEnabled(client))) return null
  // #1157 MED-3: only for an order the switch has touched (a bill, receipt or row valued under it); an order it never touched keeps today's rule.
  if (!(await purchaseFxOrderHasHistory(client, params.poId))) return null
  const po = await client.purchaseOrder.findUnique({ where: { id: params.poId }, select: { reference: true, currency: true } })
  if (!po) throw new Error(`Purchase order ${params.poId} not found`)
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: client.organisation })).toUpperCase()
  const currency = po.currency.trim().toUpperCase()
  if (currency === baseCurrency) return null
  try {
    const fx = await getFxRateToBase(client, { currency, asOf: endOfBusinessDateUtc(params.creditDate.slice(0, 10)), baseCurrency })
    const rateToBase = new Prisma.Decimal(fx.rate)
    return {
      rateToBase,
      storedRateToBase: rateToBase.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP),
      columns: { fxRateSource: CREDIT_FX_SOURCE_FX_TABLE, fxEventRateToBase: rateToBase },
    }
  } catch (error) {
    if (!isMissingFxRateError(error)) throw error
    throw new PurchaseFxRefusalError(
      `There is no ${currency} exchange rate on or before ${params.creditDate.slice(0, 10)} in the exchange-rate table, and the credit note for ${po.reference} `
      + 'has no bill whose rate it could take. The credit note was not saved: IMS never guesses a rate. Check the exchange-rate feed, or record the credit against its bill.',
    )
  }
}

/**
 * THE PRICE-VARIANCE PART OF A RETURN CREDIT reversing a bill valued under the switch (#1157 HIGH-1): per CREDITED order line, the quantity the credit
 * clears there (`returnCreditAllocation`, the same allocation its GR/IR row uses) x (the bill's unit price for the line - the stock unit it put on
 * transit), rounded to the currency. Never the bill's overall proportion: a bill whose lines carry uneven price differences would otherwise move PPV
 * that the returned line never had. Only non-zero lines are returned (order line id -> net foreign). Pure; exported for tests.
 */
export function returnCreditPpvByLine(params: {
  allocation: ReadonlyMap<string, Decimal>
  billLines: ReadonlyArray<{ poLineId: string | null; qtyBilled: DecimalInput; totalForeign: DecimalInput; stockUnitForeign: DecimalInput | null }>
  currency: string
}): Map<string, Decimal> {
  const perLine = new Map<string, { qty: Decimal; total: Decimal; stockUnit: Decimal }>()
  for (const line of params.billLines) {
    if (!line.poLineId || line.stockUnitForeign === null) continue
    const entry = perLine.get(line.poLineId) ?? { qty: zero(), total: zero(), stockUnit: toDecimal(line.stockUnitForeign) }
    entry.qty = entry.qty.add(toDecimal(line.qtyBilled))
    entry.total = entry.total.add(toDecimal(line.totalForeign))
    perLine.set(line.poLineId, entry)
  }
  const out = new Map<string, Decimal>()
  for (const [poLineId, qty] of params.allocation) {
    const line = perLine.get(poLineId)
    if (!line || !line.qty.gt(0) || !qty.gt(0)) continue
    const ppv = roundMoney(qty.mul(line.total.div(line.qty).sub(line.stockUnit)), params.currency)
    if (!ppv.isZero()) out.set(poLineId, ppv)
  }
  return out
}

/**
 * The split of a one-line (non reverse-charge) credit of `grossForeign`, tax-inclusive at `taxRate`, into its stock part and its price-variance part
 * `ppvNetForeign`, each with an exact net and tax (sent as LineAmount and TaxAmount, exclusive, as a split bill is): the tax of the whole is what Xero
 * would take out of the inclusive amount (`round(gross x r / (1 + r))`), the PPV part is taxed on its own and the stock part takes the rest, so the two
 * lines add up to the credit to the penny, tax included. Pure; exported for tests.
 */
export function planCreditPpvSplit(params: { grossForeign: DecimalInput; taxRate: DecimalInput; ppvNetForeign: DecimalInput; currency: string }): {
  stockNet: Decimal; stockTax: Decimal; ppvNet: Decimal; ppvTax: Decimal
} {
  const gross = roundMoney(toDecimal(params.grossForeign), params.currency)
  const rate = toDecimal(params.taxRate)
  const tax = roundMoney(gross.mul(rate).div(rate.add(1)), params.currency)
  const ppvNet = roundMoney(toDecimal(params.ppvNetForeign), params.currency)
  const ppvTax = roundMoney(ppvNet.mul(rate), params.currency)
  return { stockNet: gross.sub(tax).sub(ppvNet), stockTax: tax.sub(ppvTax), ppvNet, ppvTax }
}

/** MED-5: the IMS bill as a confirmation saw it (its goods lines' quantities and amounts, and its net), to tell a later edit. Pure. */
export function nonImsBillFingerprint(bill: { subtotalForeign: DecimalInput; lines: ReadonlyArray<{ poLineId: string | null; qtyBilled: DecimalInput; totalForeign: DecimalInput }> }): string {
  const lines = bill.lines.map((line) => `${line.poLineId ?? '-'}:${toDecimal(line.qtyBilled).toString()}:${toDecimal(line.totalForeign).toString()}`).sort()
  return `${toDecimal(bill.subtotalForeign).toString()}|${lines.join(',')}`
}

/** The confirmation fields its staleness is judged on. */
export type NonImsApprovalBasis = {
  xeroInvoiceId: string | null
  xeroTenantId: string | null
  stockUnits: unknown
  billFingerprint: string | null
  staleAt: Date | null
  staleReason: string | null
}

/**
 * MED-5 / #1164 LOW-5..8: WHETHER A CONFIRMATION OF A BILL POSTED OUTSIDE IMS STILL HOLDS, judged the same way by the reconciliation and by the list. Pure.
 *  - `stale` (persistent; the bill needs confirming again): marked stale before; confirmed before its basis was frozen (no frozen units or bill
 *    fingerprint, no Xero bill or organisation recorded); the bill linked to another Xero bill; the IMS bill edited; the order's goods cost edited; or the
 *    connected Xero organisation not the one the bill was read from.
 *  - `held` (transient): no Xero organisation is connected, so the tenant cannot be compared; the journal is held, nothing is marked.
 *  - `ok`.
 */
export function nonImsApprovalStanding(
  row: NonImsApprovalBasis,
  bill: { accountingInvoiceId: string | null; subtotalForeign: DecimalInput; lines: ReadonlyArray<{ poLineId: string | null; qtyBilled: DecimalInput; totalForeign: DecimalInput }> },
  currentStockUnits: ReadonlyMap<string, Decimal>,
  connectedTenantId: string | null,
): { kind: 'ok' } | { kind: 'stale'; reason: string } | { kind: 'held'; reason: string } {
  if (row.staleAt) return { kind: 'stale', reason: row.staleReason ?? 'marked stale' }
  // #1167 LOW-4: an empty frozen basis (`{}`) is no basis.
  if (!row.stockUnits || typeof row.stockUnits !== 'object' || Array.isArray(row.stockUnits) || Object.keys(row.stockUnits).length === 0
    || !row.billFingerprint || !row.xeroInvoiceId || !row.xeroTenantId) {
    return { kind: 'stale', reason: 'confirmed before its basis was frozen with it; confirm it again' }
  }
  if (bill.accountingInvoiceId !== row.xeroInvoiceId) return { kind: 'stale', reason: `the bill is linked to another Xero bill (${bill.accountingInvoiceId ?? 'none'}, confirmed on ${row.xeroInvoiceId})` }
  if (row.billFingerprint !== nonImsBillFingerprint(bill)) return { kind: 'stale', reason: 'the IMS bill was edited after it was confirmed' }
  const frozen = Object.entries(row.stockUnits as Record<string, string>)
  if (frozen.some(([lineId, unit]) => !(currentStockUnits.get(lineId)?.eq(toDecimal(unit)) ?? false))) return { kind: 'stale', reason: 'the order\'s goods cost was edited after the bill was confirmed' }
  if (connectedTenantId === null) return { kind: 'held', reason: 'no Xero organisation is connected, so the one the bill was read from cannot be confirmed; held until it is' }
  if (connectedTenantId !== row.xeroTenantId) return { kind: 'stale', reason: `the connected Xero organisation (${connectedTenantId}) is not the one the bill was read from (${row.xeroTenantId})` }
  return { kind: 'ok' }
}

// ─── THE MATCHING (pure) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One receipt of one order line, in receipt order: its quantity and the goods value it credited (GR/IR RECEIPT row). */
export type ReceiptLot = { qty: Decimal; valueBase: Decimal }

/**
 * One GR/IR movement that changes what an order line has RECEIVED, in time order: a RECEIPT (+), a positive OPENING_BALANCE (+, goods received before
 * the sub-ledger existed: MED-7) or a SUPPLIER_RETURN (-). Signed as the sub-ledger records them.
 */
export type ReceivedMovement = { poLineId: string; qty: Decimal; valueBase: Decimal }

const UNIT_MATCH_TOLERANCE = new Prisma.Decimal('0.000001')

/**
 * The receipt lots each order line still holds, in receipt order, after its returns (step 3b). A return takes its quantity first from the lots valued
 * at the return's own unit value (the layers it consumed were valued at it: a goods unit cost belongs to one receipt rate), then in receipt order; the
 * remaining lots then hold exactly the receipts less the returns in value too (any rounding between the two is taken off the first lot still holding
 * goods). A return beyond the lots (stock that came from outside them) removes what there is. Pure; exported for tests.
 */
export function receiptLotsAfterReturns(movements: ReadonlyArray<ReceivedMovement>): Map<string, ReceiptLot[]> {
  const out = new Map<string, ReceiptLot[]>()
  for (const movement of movements) {
    const lots = out.get(movement.poLineId) ?? []
    out.set(movement.poLineId, lots)
    if (movement.qty.gt(0)) {
      lots.push({ qty: movement.qty, valueBase: movement.valueBase })
      continue
    }
    if (!movement.qty.lt(0)) continue
    const qty = movement.qty.neg()
    const value = movement.valueBase.neg()
    const unit = value.div(qty)
    let left = qty
    let removed = new Prisma.Decimal(0)
    const take = (lot: ReceiptLot): void => {
      const taken = Prisma.Decimal.min(lot.qty, left)
      const takenValue = taken.eq(lot.qty) ? lot.valueBase : lot.valueBase.mul(taken).div(lot.qty)
      lot.qty = lot.qty.sub(taken)
      lot.valueBase = lot.valueBase.sub(takenValue)
      left = left.sub(taken)
      removed = removed.add(takenValue)
    }
    for (const lot of lots) {
      if (!left.gt(0)) break
      if (lot.qty.gt(0) && lot.valueBase.div(lot.qty).sub(unit).abs().lte(UNIT_MATCH_TOLERANCE)) take(lot)
    }
    for (const lot of lots) {
      if (!left.gt(0)) break
      if (lot.qty.gt(0)) take(lot)
    }
    const kept = lots.filter((lot) => lot.qty.gt(0))
    const residual = value.sub(removed)
    // Only the value the removed quantity really carried is moved: a return beyond the lots has nothing left to take its value from.
    if (!residual.isZero() && !left.gt(0) && kept.length > 0) kept[0]!.valueBase = kept[0]!.valueBase.sub(residual)
    out.set(movement.poLineId, kept)
  }
  return out
}

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
  /**
   * HIGH-2 / MED-B: the base unit value a PO-rate bill debited GR/IR (and transit) with for a line (from its own grir:bill and grir:bill-update rows),
   * to value it; absent = that bill line gets no target.
   */
  poRateUnitBase?: (invoiceId: string, poLineId: string) => Decimal | undefined,
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
      const poUnit = poRateUnitBase?.(bill.invoiceId, poLineId)
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
  /** The FX journals queued by this run (bill id and number, signed transit movement). In a dry run: the journals it WOULD queue. */
  journals: Array<{ invoiceId: string; invoiceNumber: string | null; transitDelta: string }>
  /** Journals the queue declined while owed: the caller reports them after its commit (`reportPurchaseFxVarianceNotQueued`). */
  notQueued: Array<{ invoiceId: string; invoiceNumber: string | null; outcome: EnqueueOutcomeLike; transitDelta: string }>
  /** MED-2: journals the producer-side hold recorded as a shadow; settled (never caught up later). */
  /** #1164 LOW-6: the confirmations of bills posted outside IMS that do not hold (stale) or are held (no Xero organisation connected); their journals are held. */
  stale?: Array<{ invoiceId: string; reason: string; held: boolean }>
  /** `reversal`: the take-back of an amount settled as a shadow before (LOW-2); otherwise a new journal the hold recorded as a shadow. */
  shadowed?: Array<{ invoiceId: string; transitDelta: string; reversal?: boolean }>
}

export const NO_BILL_FX_RECONCILE: PurchaseBillFxReconcileResult = { journals: [], notQueued: [] }

export type ReconcilePurchaseBillFxParams = {
  poId: string
  connector: string | null
  syncEnabled: boolean
  at: Date
  /** LOW: the event is this bill's own create or edit, so its journal is dated on the bill date (as the bill's own transit row is), not today. */
  billEventInvoiceId?: string
  /** LOW: compute what would be queued without queueing it (the caller rolls the transaction back): `journals` lists the deltas. */
  dryRun?: boolean
  /**
   * MED-C proposal only (with `dryRun`): treat these bills as confirmed by the owner, each at the CurrencyRate its Xero bill carries (null = its own GR/IR
   * value), to show the journal a confirmation would post.
   */
  assumeConfirmed?: ReadonlyMap<string, Decimal | null>
}

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
  params: ReconcilePurchaseBillFxParams,
): Promise<PurchaseBillFxReconcileResult> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: params.poId },
    select: {
      reference: true, currency: true, supplierId: true, subtotalForeign: true,
      lines: { select: { id: true, unitCostForeign: true, totalForeign: true } },
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
      id: true, invoiceNumber: true, invoiceDate: true, fxRateSource: true, fxEventRateToBase: true, accountingInvoiceId: true, subtotalForeign: true,
      lines: { select: { poLineId: true, costLineId: true, qtyBilled: true, totalForeign: true, totalBase: true, stockUnitForeign: true } },
    },
  })
  // What each line has received: receipts, positive opening balances (MED-7) and returns (step 3b), in time order.
  const received = await tx.grirSubledgerMovement.findMany({
    where: {
      poId: params.poId, poLineId: { not: null },
      OR: [{ sourceType: { in: ['RECEIPT', 'SUPPLIER_RETURN'] } }, { sourceType: 'OPENING_BALANCE', qtyDelta: { gt: 0 } }],
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { poLineId: true, qtyDelta: true, baseDelta: true },
  })
  const lotsByLine = receiptLotsAfterReturns(received.flatMap((row) => (row.poLineId && row.qtyDelta !== null
    ? [{ poLineId: row.poLineId, qty: toDecimal(row.qtyDelta), valueBase: toDecimal(row.baseDelta) }]
    : [])))
  const managed = new Map(bills.filter((bill) => bill.fxRateSource && bill.fxEventRateToBase).map((bill) => [bill.id, bill]))
  const billById = new Map(bills.map((bill) => [bill.id, bill]))
  // HIGH-2 / MED-B: a bill valued at the PO rate (before the switch) is valued at what IT debited GR/IR (and transit) with, read from its own
  // grir:bill and grir:bill-update rows, never from the order's current cost (an order edited since would value it differently). A bill with no such
  // row (recorded before the sub-ledger) falls back to the PO goods unit cost.
  const poRateBillIds = bills.filter((bill) => !managed.has(bill.id)).map((bill) => bill.id)
  const ownRows = poRateBillIds.length === 0 ? [] : await tx.grirSubledgerMovement.findMany({
    where: { poId: params.poId, sourceRef: { in: poRateBillIds }, sourceType: { in: ['BILL', 'BILL_UPDATE'] }, NOT: { idempotencyKey: { startsWith: GRIR_KEY_PREFIX } } },
    select: { sourceRef: true, poLineId: true, qtyDelta: true, baseDelta: true },
  })
  const ownByBillLine = new Map<string, { qty: Decimal; base: Decimal }>()
  for (const row of ownRows) {
    if (!row.poLineId) continue
    const key = `${row.sourceRef}|${row.poLineId}`
    const entry = ownByBillLine.get(key) ?? { qty: zero(), base: zero() }
    entry.qty = entry.qty.add(toDecimal(row.qtyDelta ?? 0))
    entry.base = entry.base.add(toDecimal(row.baseDelta))
    ownByBillLine.set(key, entry)
  }
  const poGoods = poRateBillIds.length === 0 ? new Map<string, Decimal>() : (await loadGrirPoValuation(tx, params.poId)).goodsUnitCostByLine
  const poRateUnitBase = (invoiceId: string, poLineId: string): Decimal | undefined => {
    const own = ownByBillLine.get(`${invoiceId}|${poLineId}`)
    if (own && own.qty.lt(0)) return own.base.div(own.qty)
    return poGoods.get(poLineId)
  }
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
  }), poRateUnitBase)
  // MED-C: the bills an admin confirmed as posted to Xero OUTSIDE IMS (`purchase_fx_non_ims_bill_approvals`, purchase-fx-non-ims-bills.ts), each with the
  // CurrencyRate its Xero bill was read at. Their GR/IR is corrected as for any bill from before the switch (above); what sits in Stock in Transit for
  // them is the Xero bill's goods at the XERO rate, so the exchange-rate journal is measured on that basis: the order's goods cost (after the header
  // discount) at the Xero rate, matched to the receipts in the same order. The bill's price difference stays on transit (owner ruling 2026-11-26).
  const staleReport: Array<{ invoiceId: string; reason: string; held: boolean }> = []
  const confirmedRows = await tx.purchaseFxNonImsBillApproval.findMany({
    where: { poId: params.poId },
    select: { id: true, invoiceId: true, xeroCurrencyRate: true, xeroInvoiceId: true, xeroTenantId: true, stockUnits: true, billFingerprint: true, staleAt: true, staleReason: true, heldSince: true },
  })
  const confirmedRate = new Map<string, Decimal | null>(confirmedRows.map((row) => [row.invoiceId, row.xeroCurrencyRate === null ? null : toDecimal(row.xeroCurrencyRate)]))
  const currentStockUnits = stockUnitsForeign(po)
  // MED-5: the basis is FROZEN with the confirmation (the order's goods unit costs it was measured on). A confirmation whose basis no longer holds is STALE
  // (`nonImsApprovalStanding`): marked so, with a WARNING once, on the transition, and its journal is held where it is until the bill is confirmed again
  // (an edit in Xero is not seen here: it needs a re-confirmation, see purchase-fx-non-ims-bills.ts). A HELD one (no Xero organisation connected) only
  // holds its journal.
  const frozenUnits = new Map<string, Map<string, Decimal>>()
  const stale = new Map<string, string>()
  const connectedTenantId = confirmedRows.length === 0 ? null
    : (await tx.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true } }))?.tenantId ?? null
  for (const row of confirmedRows) {
    const bill = billById.get(row.invoiceId)
    if (row.stockUnits && typeof row.stockUnits === 'object' && !Array.isArray(row.stockUnits) && Object.keys(row.stockUnits).length > 0) {
      frozenUnits.set(row.invoiceId, new Map(Object.entries(row.stockUnits as Record<string, string>).map(([lineId, unit]) => [lineId, toDecimal(unit)])))
    }
    if (!bill) continue
    const standing = nonImsApprovalStanding(row, bill, currentStockUnits, connectedTenantId)
    // #1167 MED-1: a hold ends as soon as the organisation can be compared again; its journal then catches up in this same run.
    if (standing.kind !== 'held' && row.heldSince && !params.dryRun) await tx.purchaseFxNonImsBillApproval.updateMany({ where: { id: row.id, heldSince: { not: null } }, data: { heldSince: null } })
    if (standing.kind === 'ok') continue
    stale.set(row.invoiceId, standing.reason)
    const { logActivityInTransaction } = await import('@/lib/activity-log')
    if (standing.kind === 'held') {
      staleReport.push({ invoiceId: row.invoiceId, reason: standing.reason, held: true })
      // Reported once, when the journal is first held (the order stays in the re-run's list, so `purchase-fx:reconcile` catches it up after reconnecting).
      if (!row.heldSince && !params.dryRun) {
        const marked = await tx.purchaseFxNonImsBillApproval.updateMany({ where: { id: row.id, heldSince: null }, data: { heldSince: params.at } })
        if (marked.count === 1) {
          await logActivityInTransaction(tx, {
            userId: null,
            entityType: 'PURCHASE_ORDER',
            entityId: params.poId,
            action: 'purchase_fx_non_ims_bill_held',
            tag: 'accounting',
            level: 'WARNING',
            description: withLedgerCheck(`The exchange-rate difference journal of bill ${bill.invoiceNumber ?? bill.id} of ${po.reference} (posted to Xero outside IMS) is held: no Xero organisation `
              + 'is connected, so the one the bill was confirmed on cannot be compared. Once the same organisation is connected again, the next receipt, return or bill change of the order, '
              + `or \`npm run purchase-fx:reconcile -- --po ${params.poId} --apply\`, catches it up. Connecting a different organisation makes the confirmation stale.`),
            metadata: { invoiceId: bill.id, reason: standing.reason },
          })
        }
      }
      continue
    }
    staleReport.push({ invoiceId: row.invoiceId, reason: standing.reason, held: false })
    // #1167 LOW-1: marked (and warned) by exactly one run.
    const marked = row.staleAt || params.dryRun ? { count: 0 } : await tx.purchaseFxNonImsBillApproval.updateMany({ where: { id: row.id, staleAt: null }, data: { staleAt: params.at, staleReason: standing.reason } })
    if (marked.count === 1) {
      await logActivityInTransaction(tx, {
        userId: null,
        entityType: 'PURCHASE_ORDER',
        entityId: params.poId,
        action: 'purchase_fx_non_ims_bill_stale',
        tag: 'accounting',
        level: 'WARNING',
        description: withLedgerCheck(`The confirmation of bill ${bill.invoiceNumber ?? bill.id} of ${po.reference} (posted to Xero outside IMS) no longer holds: ${standing.reason}. Its exchange-rate `
          + 'difference journal is held where it is until the bill is confirmed again with `npm run purchase-fx:non-ims-bills` (the dry run lists it as stale).'),
        metadata: { invoiceId: bill.id, reason: standing.reason },
      })
    }
  }
  if (params.dryRun) for (const [id, rate] of params.assumeConfirmed ?? []) { confirmedRate.set(id, rate); stale.delete(id); frozenUnits.delete(id) }
  const staleAfterAssumed = staleReport.filter((entry) => !(params.dryRun && params.assumeConfirmed?.has(entry.invoiceId)))
  const xeroRated = [...confirmedRate.entries()].filter(([, rate]) => rate !== null)
  let journalTargets = targets
  if (xeroRated.length > 0) {
    const journalUnitBase = (invoiceId: string, poLineId: string): Decimal | undefined => {
      const rate = confirmedRate.get(invoiceId)
      const unit = (frozenUnits.get(invoiceId) ?? currentStockUnits).get(poLineId)
      if (rate && unit) return unit.div(rate)
      return poRateUnitBase(invoiceId, poLineId)
    }
    journalTargets = matchBillsToReceipts(lotsByLine, bills.map((bill) => {
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
    }), journalUnitBase)
  }

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
  for (const target of journalTargets) fxByBill.set(target.invoiceId, (fxByBill.get(target.invoiceId) ?? zero()).add(target.fxVarianceBase))
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
  // MED-2: a journal the producer-side hold recorded as a shadow is SETTLED: IMS did not send it and never will, so it counts here beside the queued ones
  // and the difference is not caught up by a live journal once the hold lifts.
  const shadowRows = await tx.purchaseFxVarianceShadow.findMany({ where: { poId: params.poId }, select: { invoiceId: true, baseDelta: true } })
  const postedByBill = new Map<string, { sum: Decimal; rows: number }>()
  const count = (invoiceId: string, baseDelta: DecimalInput): void => {
    const entry = postedByBill.get(invoiceId) ?? { sum: zero(), rows: 0 }
    entry.sum = entry.sum.add(toDecimal(baseDelta))
    entry.rows += 1
    postedByBill.set(invoiceId, entry)
  }
  for (const row of transitRows) count(row.idempotencyKey.slice(JOURNAL_KEY_PREFIX.length).split(':')[0]!, row.baseDelta)
  for (const row of shadowRows) count(row.invoiceId, row.baseDelta)
  const shadowByBill = new Map<string, { sum: Decimal; rows: number }>()
  for (const row of shadowRows) {
    const entry = shadowByBill.get(row.invoiceId) ?? { sum: zero(), rows: 0 }
    entry.sum = entry.sum.add(toDecimal(row.baseDelta))
    entry.rows += 1
    shadowByBill.set(row.invoiceId, entry)
  }
  // MED-1: only a bill whose OWN posting was queued (its PURCHASE_BILL transit row exists, keyed `purchase-invoice:<bill>:...`) can leave a difference
  // in the ledger's transit account. A bill posted by hand, declined, or recorded with bill sync off has nothing in transit to clear: its target is 0.
  const billTransitKeys = (await tx.transitSubledgerMovement.findMany({
    where: { sourceType: 'PURCHASE_BILL', sourceRef: params.poId }, select: { idempotencyKey: true },
  })).map((row) => row.idempotencyKey)
  // MED-C (owner ruling "post a one-off journal"): a bill that reached Xero OUTSIDE IMS has no such row; once an admin has confirmed it
  // (`purchase_fx_non_ims_bill_approvals`, lib/domain/purchasing/purchase-fx-non-ims-bills.ts) it is treated as being in transit at its own GR/IR value.
  const billPosted = (invoiceId: string): boolean => confirmedRate.has(invoiceId) || billTransitKeys.some((key) => key.startsWith(`purchase-invoice:${invoiceId}:`))
  const billIds = new Set([...fxByBill.keys(), ...postedByBill.keys()])
  const result: PurchaseBillFxReconcileResult = { journals: [], notQueued: [], shadowed: [], stale: staleAfterAssumed }
  let accounts: { transit: string; realisedFx: string } | null = null
  for (const invoiceId of billIds) {
    // MED-5: a stale confirmation holds its journal where it is.
    if (stale.has(invoiceId)) continue
    const owed = billById.has(invoiceId) && billPosted(invoiceId)
    const targetTransit = owed ? roundQuantity((fxByBill.get(invoiceId) ?? zero()).neg(), 2) : zero()
    const posted = postedByBill.get(invoiceId) ?? { sum: zero(), rows: 0 }
    let delta = roundQuantity(targetTransit.sub(posted.sum), 2)
    if (delta.isZero()) continue
    // #1157 LOW-2: a change that takes back an amount settled as a SHADOW (the bill deleted, an edit, a return) is settled as a shadow too: the ledger
    // never received that amount from IMS, so a live journal reversing it would post a difference that was never there.
    const shadowed = shadowByBill.get(invoiceId)
    if (shadowed && !shadowed.sum.isZero() && delta.isNegative() !== shadowed.sum.isNegative()) {
      const back = Prisma.Decimal.min(delta.abs(), shadowed.sum.abs()).mul(delta.isNegative() ? -1 : 1)
      if (!params.dryRun) {
        const key = `${JOURNAL_KEY_PREFIX}${invoiceId}:shadow-reversal:${shadowed.rows}`
        await tx.purchaseFxVarianceShadow.upsert({
          where: { idempotencyKey: key },
          create: { poId: params.poId, invoiceId, idempotencyKey: key, baseDelta: back, journalDate: businessDateYmd(params.at) },
          update: {},
        })
      }
      // Reported in a dry run as well (#1164 LOW-4), so a proposal shows the part a confirmation settles as a shadow reversal.
      result.shadowed!.push({ invoiceId, transitDelta: back.toFixed(2), reversal: true })
      delta = roundQuantity(delta.sub(back), 2)
      if (delta.isZero()) continue
    }
    if (!params.syncEnabled || params.connector !== 'xero') continue
    const bill = billById.get(invoiceId)
    const invoiceNumber = bill?.invoiceNumber ?? null
    if (params.dryRun) {
      result.journals.push({ invoiceId, invoiceNumber, transitDelta: delta.toFixed(2) })
      continue
    }
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
    const amount = delta.abs().toNumber()
    const label = bill ? `bill ${bill.invoiceNumber ?? bill.id}` : `deleted bill ${invoiceId}`
    const description = `Exchange-rate difference: ${po.reference} ${label}`
    const transitLine = { accountCode: accounts.transit, description, ...(delta.gt(0) ? { debit: amount } : { credit: amount }) }
    const fxLine = { accountCode: accounts.realisedFx, description, ...(delta.gt(0) ? { credit: amount } : { debit: amount }) }
    // LOW: the journal raised by the bill's own create or edit is dated on the bill date (the bill's own transit row's date); any other event's on its own.
    const journalDay = bill && params.billEventInvoiceId === invoiceId ? bill.invoiceDate.toISOString().slice(0, 10) : businessDateYmd(params.at)
    const payload = {
      date: journalDay,
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
      result.journals.push({ invoiceId, invoiceNumber, transitDelta: delta.toFixed(2) })
    } else if (answered.outcome && isShadowedOutcome(answered.outcome)) {
      // MED-2: settled as a shadow. Nothing mirrors a ledger posting (no transit row); the marker only stops a later live catch-up.
      await tx.purchaseFxVarianceShadow.upsert({
        where: { idempotencyKey },
        create: { poId: params.poId, invoiceId, idempotencyKey, baseDelta: delta, journalDate: payload.date },
        update: {},
      })
      result.shadowed!.push({ invoiceId, transitDelta: delta.toFixed(2) })
    } else if (answered.outcome && postingIsOwed(answered.outcome)) {
      result.notQueued.push({ invoiceId, invoiceNumber, outcome: answered.outcome, transitDelta: delta.toFixed(2) })
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
      posting: `the exchange-rate difference journal for PO ${poReference} (bill ${entry.invoiceNumber ?? entry.invoiceId})`,
      committed: 'the bill and the receipts are recorded in IMS',
      // HIGH-1: never by hand. The reconciliation works from target state, so the next run queues what is still owed; a journal posted by hand as
      // well would be booked twice.
      remedy: 'Stock in Transit still holds the exchange-rate difference between the receipts and the bill. Leave the ledger as it is (a copy keyed in by hand would be booked twice): '
        + `once the cause is fixed, run \`npm run purchase-fx:reconcile -- --po ${poId} --apply\`, which queues only what is still owed (the next bill `
        + 'edit or receipt of the order does the same), then mark this row handled.',
      outcome: entry.outcome,
      metadata: { reference: poReference, invoiceId: entry.invoiceId, invoiceNumber: entry.invoiceNumber, chartConnector: 'xero' },
    })
  }
}

// ─── THE SUPPORTED RE-RUN AND THE TURN-ON CHECK (HIGH-1, HIGH-2) ─────────────────────────────────────────────────────────────────────────

/**
 * MED-3: whether this order has anything the reconciliation looks after, WHATEVER THE SWITCH SAYS NOW: a bill or receipt valued under the switch, a row this writer
 * wrote, or a journal it queued or settled as a shadow. A receipt or a return of such an order reconciles even after the switch is turned off (a
 * rollback), so the bills it already manages keep matching the goods. False for every order the switch never touched, so with the switch never on
 * nothing changes. Read in the event's transaction, under the order's row lock.
 */
export async function purchaseFxOrderHasHistory(
  tx: Pick<Prisma.TransactionClient, 'purchaseInvoice' | 'purchaseReceipt' | 'grirSubledgerMovement' | 'transitSubledgerMovement' | 'purchaseFxVarianceShadow' | 'purchaseFxNonImsBillApproval'>,
  poId: string,
): Promise<boolean> {
  if (await tx.purchaseInvoice.findFirst({ where: { poId, fxRateSource: { not: null } }, select: { id: true } })) return true
  if (await tx.purchaseReceipt.findFirst({ where: { poId, fxRateSource: { not: null } }, select: { id: true } })) return true
  if (await tx.grirSubledgerMovement.findFirst({ where: { poId, idempotencyKey: { startsWith: GRIR_KEY_PREFIX } }, select: { id: true } })) return true
  if (await tx.transitSubledgerMovement.findFirst({ where: { sourceType: 'PURCHASE_FX_VARIANCE', sourceRef: poId }, select: { id: true } })) return true
  if (await tx.purchaseFxNonImsBillApproval.findFirst({ where: { poId }, select: { id: true } })) return true
  return Boolean(await tx.purchaseFxVarianceShadow.findFirst({ where: { poId }, select: { id: true } }))
}

/**
 * The foreign orders this writer may owe something for: a bill valued under the switch, a receipt or layer valued under it, or a row it wrote.
 * Read-only.
 */
export async function purchaseFxOrdersToReconcile(
  client: Pick<Prisma.TransactionClient, 'purchaseInvoice' | 'purchaseReceipt' | 'costLayer' | 'grirSubledgerMovement' | 'transitSubledgerMovement' | 'purchaseFxVarianceShadow' | 'purchaseFxNonImsBillApproval'>,
): Promise<string[]> {
  const ids = new Set<string>()
  for (const row of await client.purchaseInvoice.findMany({ where: { fxRateSource: { not: null } }, select: { poId: true } })) ids.add(row.poId)
  for (const row of await client.purchaseReceipt.findMany({ where: { fxRateSource: { not: null } }, select: { poId: true } })) ids.add(row.poId)
  for (const row of await client.costLayer.findMany({ where: { fxRateSource: { not: null }, poLineId: { not: null } }, select: { poLine: { select: { poId: true } } } })) {
    if (row.poLine) ids.add(row.poLine.poId)
  }
  for (const row of await client.grirSubledgerMovement.findMany({ where: { idempotencyKey: { startsWith: GRIR_KEY_PREFIX } }, select: { poId: true }, distinct: ['poId'] })) ids.add(row.poId)
  for (const row of await client.transitSubledgerMovement.findMany({ where: { sourceType: 'PURCHASE_FX_VARIANCE' }, select: { sourceRef: true }, distinct: ['sourceRef'] })) ids.add(row.sourceRef)
  for (const row of await client.purchaseFxVarianceShadow.findMany({ select: { poId: true }, distinct: ['poId'] })) ids.add(row.poId)
  for (const row of await client.purchaseFxNonImsBillApproval.findMany({ select: { poId: true }, distinct: ['poId'] })) ids.add(row.poId)
  return [...ids].sort()
}

/** MED-A: `--po` names an order the switch never touched (nothing to reconcile, and running the writer on it would start managing it). */
export class PurchaseFxNotReconcilableError extends Error {
  constructor(readonly poId: string) {
    super(`Purchase order ${poId} has nothing valued under per-event FX rates (no bill, receipt or layer valued under purchase_event_fx_rates_enabled, and no row `
      + 'or journal of the reconciliation). It is not reconciled: run without --po to see the orders that are.')
    this.name = 'PurchaseFxNotReconcilableError'
  }
}

class DryRunRollback extends Error {
  constructor(readonly result: PurchaseBillFxReconcileResult) {
    super('purchase-fx dry run: rolled back')
  }
}

/**
 * HIGH-1, THE SUPPORTED RE-RUN: bring one order's bills to their target state now, under its purchase_orders row lock, exactly as the next bill edit
 * or receipt would. Idempotent: an order that owes nothing writes nothing. What the queue declines is reported (and stays owed for the next run).
 * MED-A: refused for an order the switch never touched. LOW: `dryRun` computes the same deltas inside a transaction that is then rolled back, so it
 * shows what `--apply` would queue and writes nothing.
 */
export async function rerunPurchaseBillFx(poId: string, options: { at?: Date; dryRun?: boolean } = {}): Promise<PurchaseBillFxReconcileResult> {
  const { db } = await import('@/lib/db')
  const { getAccountingSettings } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  const po = await db.purchaseOrder.findUnique({ where: { id: poId }, select: { reference: true } })
  if (!po) throw new Error(`Purchase order ${poId} not found`)
  if (!(await purchaseFxOrdersToReconcile(db)).includes(poId)) throw new PurchaseFxNotReconcilableError(poId)
  const run = (tx: Prisma.TransactionClient) => reconcilePurchaseBillFx(tx, {
    poId, connector: settings.connector, syncEnabled: settings.syncEnabled, at: options.at ?? new Date(), dryRun: options.dryRun,
  })
  if (options.dryRun) {
    try {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
        throw new DryRunRollback(await run(tx))
      }, { timeout: 60_000, maxWait: 10_000 })
    } catch (error) {
      if (error instanceof DryRunRollback) return error.result
      throw error
    }
    throw new Error('purchase-fx dry run: the transaction did not roll back')
  }
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
    return run(tx)
  }, { timeout: 60_000, maxWait: 10_000 })
  await reportPurchaseFxVarianceNotQueued(poId, po.reference, result)
  return result
}

export type PurchaseFxInFlightOrder = {
  poId: string
  reference: string
  currency: string
  status: string
  lines: Array<{ poLineId: string; billedQty: string; receivedQty: string }>
  /**
   * MED-C: the order's PO-rate bills that IMS did not post (no PURCHASE_BILL transit row: posted by Qoblex in P1, by the first load, by hand, or with
   * bill sync off). Their GR/IR is corrected but NO exchange-rate journal is raised for them; whether one should be is an owner decision still open.
   */
  billsNotPostedByIms: Array<{ invoiceId: string; invoiceNumber: string | null }>
}

/**
 * HIGH-2, THE TURN-ON CHECK: foreign orders with a bill valued at the PO rate for goods not received yet. Their later receipts are valued under the
 * switch, so each leaves an exchange-rate difference that this writer clears per receipt; the list is what the owner reviews before turning it on.
 * "Received" counts receipts, positive opening balances and returns; "billed" counts the bills and a negative opening balance (billed before the
 * sub-ledger, not received). Read-only.
 */
export async function listPurchaseFxInFlightOrders(
  client: Pick<Prisma.TransactionClient, 'purchaseOrder' | 'organisation' | 'grirSubledgerMovement' | 'transitSubledgerMovement'>,
): Promise<PurchaseFxInFlightOrder[]> {
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: client.organisation })).toUpperCase()
  const orders = await client.purchaseOrder.findMany({
    where: { status: { not: 'CANCELLED' }, NOT: { currency: baseCurrency }, invoices: { some: { fxRateSource: null } } },
    orderBy: { reference: 'asc' },
    select: {
      id: true, reference: true, currency: true, status: true,
      invoices: { where: { fxRateSource: null }, orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }], select: { id: true, invoiceNumber: true, lines: { select: { poLineId: true, qtyBilled: true } } } },
    },
  })
  const out: PurchaseFxInFlightOrder[] = []
  for (const order of orders) {
    if (order.currency.trim().toUpperCase() === baseCurrency) continue
    const billed = new Map<string, Decimal>()
    const add = (map: Map<string, Decimal>, lineId: string, qty: DecimalInput): void => { map.set(lineId, (map.get(lineId) ?? zero()).add(toDecimal(qty))) }
    for (const invoice of order.invoices) for (const line of invoice.lines) if (line.poLineId) add(billed, line.poLineId, line.qtyBilled)
    const received = new Map<string, Decimal>()
    const rows = await client.grirSubledgerMovement.findMany({
      where: { poId: order.id, poLineId: { not: null }, sourceType: { in: ['RECEIPT', 'SUPPLIER_RETURN', 'OPENING_BALANCE'] } },
      select: { poLineId: true, sourceType: true, qtyDelta: true },
    })
    for (const row of rows) {
      if (!row.poLineId || row.qtyDelta === null) continue
      const qty = toDecimal(row.qtyDelta)
      if (row.sourceType === 'OPENING_BALANCE' && qty.lt(0)) add(billed, row.poLineId, qty.neg())
      else add(received, row.poLineId, qty)
    }
    const lines = [...billed].filter(([lineId, qty]) => qty.gt(received.get(lineId) ?? 0))
      .map(([poLineId, qty]) => ({ poLineId, billedQty: qty.toString(), receivedQty: (received.get(poLineId) ?? zero()).toString() }))
    if (lines.length === 0) continue
    const billKeys = (await client.transitSubledgerMovement.findMany({ where: { sourceType: 'PURCHASE_BILL', sourceRef: order.id }, select: { idempotencyKey: true } }))
      .map((row) => row.idempotencyKey)
    const billsNotPostedByIms = order.invoices
      .filter((invoice) => !billKeys.some((key) => key.startsWith(`purchase-invoice:${invoice.id}:`)))
      .map((invoice) => ({ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber }))
    out.push({ poId: order.id, reference: order.reference, currency: order.currency, status: order.status, lines, billsNotPostedByIms })
  }
  return out
}
