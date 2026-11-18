import type { Prisma } from '@/app/generated/prisma/client'
import { currencyMinorUnits, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { buildTaxTypeRateIndex, priceSnapshottedTaxIdentity, type TaxTypeRateIndex } from '@/lib/domain/sales/refund-posted-tax-identity'
import { raiseWmsOperatorTask, type WmsOperatorTaskPayload } from '@/lib/domain/wms/operator-tasks'

/**
 * "REFUND IN WOOCOMMERCE": THE OPERATOR TASK FOR A REFUND IMS RECORDED THAT THE SHOP STILL HAS TO PAY BACK.
 *
 * Owner rulings 2026-09-28 (D7) and 2026-11-16. When a person records a refund in IMS on an order that came from WooCommerce, IMS books its own
 * credit note and writes NOTHING to WooCommerce: no refund record, no status change, no order note, no money movement. The customer's money
 * is returned by a person in WooCommerce. IMS raises ONE operator task per IMS refund so that person is told.
 *
 * THE DUPLICATE CREDIT NOTE THIS PREVENTS, AND WHY A PERSON DECIDES. The WooCommerce refund import dedups on the storefront refund id alone. The
 * person's later refund in WooCommerce has a new id, so, left alone, the import would raise a SECOND credit note for money IMS already credited.
 * But IMS writes no marker to WooCommerce, so an amount is NOT proof: a separate refund that began in WooCommerce can have the same amount as
 * an open IMS refund. So IMS never links on its own. `findOpenShopRefunds` asks whether the order has an open task:
 *
 *   no task open on the order      nothing here applies: the import runs exactly as before (a refund that began in WooCommerce is untouched)
 *   a task is open                 IMS records nothing and parks the storefront refund QUARANTINED, naming the IMS refunds still owed and the amounts
 *
 * The person then chooses, on that parked row:
 *   "Confirm this WooCommerce refund settles IMS refund <credit note>"   `confirmShopRefundSettlement`: sets the storefront refund id on that IMS
 *                                  refund and resolves the task and the park, with no credit note raised (only offered where the amount is equal)
 *   the existing recording action on the row  it is a separate refund: a credit note is raised for it as for any WooCommerce refund
 *
 * The task holds no personal data: ids, the credit note number and money. The free-text reason typed on the IMS refund is NOT copied; the task
 * states a fixed kind instead, and the operator reads the typed reason on the order.
 */

export const SHOP_REFUND_CONNECTOR = 'woocommerce'

type Money = Parameters<typeof toDecimal>[0]

/** What an IMS refund comes to INCLUDING tax, in the order currency, to the minor unit; null when any line's tax cannot be priced from the snapshot it carries. */
export function refundGrossForeign(
  lines: ReadonlyArray<{ totalForeign: Money; accountingTaxType?: string | null; reverseCharge?: boolean | null }>,
  rates: TaxTypeRateIndex,
  currency: string,
): Decimal | null {
  let gross = toDecimal(0)
  for (const line of lines) {
    const net = toDecimal(line.totalForeign)
    if (line.reverseCharge === true) {
      gross = gross.plus(net)
      continue
    }
    const type = line.accountingTaxType?.trim()
    if (!type) return null
    const priced = priceSnapshottedTaxIdentity({ accountingTaxType: type, rateByTaxType: rates, label: 'refund line' })
    if (!priced.ok) return null
    gross = gross.plus(net.times(toDecimal(1).plus(priced.rate)))
  }
  return gross.toDecimalPlaces(currencyMinorUnits(currency))
}

export function shopRefundQuery(input: { orderNumber: string; creditNoteNumber: string | null; currency: string; grossForeign: string | null; netForeign: string; reasonKind: 'GOODS_RETURNED' | 'AMOUNT_ONLY' }): string {
  const cn = input.creditNoteNumber ? ` (IMS credit note ${input.creditNoteNumber})` : ''
  const what = input.reasonKind === 'GOODS_RETURNED' ? 'goods being returned' : 'an amount only'
  const amount = input.grossForeign !== null
    ? `${input.grossForeign} ${input.currency} including tax`
    : `${input.netForeign} ${input.currency} before tax (IMS could not work out the tax-inclusive figure, so check it against the credit note)`
  return `Please refund ${amount} to the customer of IMS order ${input.orderNumber} in WooCommerce${cn}. IMS recorded this refund for ${what} and has written nothing to WooCommerce: no refund, no status change, no note. `
    + 'The typed reason is on the IMS order. When IMS imports the refund you make in WooCommerce it does not link it on its own, because IMS cannot tell it from a separate refund. It lists it under parked refunds, where you confirm that it settles this credit note (no second credit note is raised and this task is marked done) or record it as a separate refund.'
}

/**
 * Raise the task, once per IMS refund. Called inside the refund's own transaction: the refund and its task commit together or not at all.
 * Returns true when a new task was written.
 */
export async function raiseShopRefundTask(
  tx: Pick<Prisma.TransactionClient, 'wmsOperatorTask' | 'taxRate'>,
  input: {
    orderId: string
    orderNumber: string
    refundId: string
    creditNoteNumber: string | null
    currency: string
    lines: ReadonlyArray<{ totalForeign: Money; qty: number; accountingTaxType?: string | null; reverseCharge?: boolean | null }>
  },
): Promise<boolean> {
  const rates = buildTaxTypeRateIndex(await tx.taxRate.findMany({ where: { usedFor: { not: 'PURCHASE' } }, select: { accountingTaxType: true, rate: true } }))
  const gross = refundGrossForeign(input.lines, rates, input.currency)
  const net = input.lines.reduce((sum, line) => sum.plus(toDecimal(line.totalForeign)), toDecimal(0)).toDecimalPlaces(currencyMinorUnits(input.currency))
  const reasonKind: 'GOODS_RETURNED' | 'AMOUNT_ONLY' = input.lines.some((line) => line.qty > 0) ? 'GOODS_RETURNED' : 'AMOUNT_ONLY'
  const shopRefund = {
    refundId: input.refundId,
    creditNoteNumber: input.creditNoteNumber,
    currency: input.currency,
    grossForeign: gross === null ? null : gross.toFixed(currencyMinorUnits(input.currency)),
    netForeign: net.toFixed(currencyMinorUnits(input.currency)),
    reasonKind,
  }
  return raiseWmsOperatorTask(tx, {
    connector: SHOP_REFUND_CONNECTOR,
    orderId: input.orderId,
    // The IMS refund the task is about: one task per refund.
    externalOrderId: input.refundId,
    reason: 'SHOP_REFUND_DUE',
    queryText: shopRefundQuery({ orderNumber: input.orderNumber, ...shopRefund }),
    dedupeBasis: `shop-refund:${input.refundId}`,
    payload: { orderNumber: input.orderNumber, shopRefund },
  })
}

export type OpenShopRefund = { taskId: string; refundId: string; creditNoteNumber: string | null; currency: string | null; grossForeign: string | null }

type OpenClient = Pick<Prisma.TransactionClient, 'wmsOperatorTask' | 'salesOrderRefund'>

function shopRefundOf(payload: Prisma.JsonValue | null): NonNullable<WmsOperatorTaskPayload['shopRefund']> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = (payload as WmsOperatorTaskPayload).shopRefund
  return value && typeof value === 'object' ? value : null
}

/** The IMS refunds on this order that the shop still has to pay back: an OPEN task whose IMS refund has no storefront refund id yet. Read-only. */
export async function findOpenShopRefunds(client: OpenClient, orderId: string): Promise<OpenShopRefund[]> {
  const open = await client.wmsOperatorTask.findMany({
    where: { orderId, connector: SHOP_REFUND_CONNECTOR, reason: 'SHOP_REFUND_DUE', status: 'OPEN' },
    select: { id: true, externalOrderId: true, payload: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (open.length === 0) return []
  const waiting = new Set((await client.salesOrderRefund.findMany({
    where: { id: { in: open.map((task) => task.externalOrderId) }, orderId, externalRefundId: null, deletedAt: null },
    select: { id: true },
  })).map((refund) => refund.id))
  return open
    .filter((task) => waiting.has(task.externalOrderId))
    .map((task) => {
      const facts = shopRefundOf(task.payload)
      return { taskId: task.id, refundId: task.externalOrderId, creditNoteNumber: facts?.creditNoteNumber ?? null, currency: facts?.currency ?? null, grossForeign: facts?.grossForeign ?? null }
    })
}

/** Whether an open IMS refund is for exactly this storefront amount: the same currency and the tax-inclusive amount equal to the minor unit. An unpriced one never is. */
export function shopRefundAmountEquals(open: OpenShopRefund, orderCurrency: string, amountForeign: Decimal): boolean {
  if (open.currency !== orderCurrency || open.grossForeign === null) return false
  const digits = currencyMinorUnits(orderCurrency)
  return toDecimal(open.grossForeign).toDecimalPlaces(digits).equals(amountForeign.toDecimalPlaces(digits))
}

/**
 * What the parked row says. The figures are IMS's and the storefront's own: amounts, currency and credit note numbers. It says plainly which of the
 * two choices to make and why: IMS cannot tell, because it writes no marker to WooCommerce.
 */
export function shopRefundParkMessage(input: { wcRefundId: number; orderCurrency: string; amountForeign: Decimal; open: OpenShopRefund[] }): string {
  const digits = currencyMinorUnits(input.orderCurrency)
  const amount = `${input.amountForeign.toDecimalPlaces(digits).toFixed(digits)} ${input.orderCurrency}`
  const owed = input.open.map((o) => `${o.creditNoteNumber ?? o.refundId}: ${o.grossForeign ?? 'tax-inclusive amount unknown'} ${o.currency ?? input.orderCurrency}`).join('; ')
  const equal = input.open.filter((o) => shopRefundAmountEquals(o, input.orderCurrency, input.amountForeign))
  const choice = equal.length > 0
    ? 'IMS cannot tell whether this WooCommerce refund is the payment of one of those IMS refunds, because IMS writes no marker to WooCommerce and the amount alone is not proof. '
      + 'Look at the refund in WooCommerce, then choose one. If it is the payment IMS asked for, choose "Confirm this WooCommerce refund settles IMS refund" and name the credit note: IMS links them, resolves the task and raises no second credit note. '
      + 'If it is a separate refund, record it as a separate refund from this row (the usual recording action): a credit note is raised for it as for any WooCommerce refund and the IMS refund stays owed.'
    : 'None of them has this amount, so IMS cannot link this refund to any of them. Look at the refund in WooCommerce. It is a separate refund, so record it as one from this row (the usual recording action): a credit note is raised for it as for any WooCommerce refund and the IMS refunds stay owed. '
      + 'If it was meant to pay one of them for a different amount, check the credit note and the refund first.'
  return `WooCommerce refund ${input.wcRefundId} (${amount}) was NOT recorded and nothing was linked. This order has IMS refund(s) the shop still has to pay back in WooCommerce (${owed}). ${choice}`
}

export type ConfirmShopRefundResult =
  | { ok: true; taskId: string; creditNoteNumber: string | null }
  | { ok: false; error: string }

/**
 * THE OPERATOR'S "CONFIRM": this storefront refund settles that IMS refund. The caller holds the per-refund advisory lock and the order lock and runs
 * this inside the same transaction as the park resolution and the audit entry. It re-checks everything the person looked at: the IMS refund is the
 * one named, is on this order, still has no storefront refund id, still has an open task, and is for exactly this amount and currency. Then it sets
 * the storefront refund id (the unique key; a clash is a refusal) and resolves the task. No credit note is raised.
 */
export async function confirmShopRefundSettlement(
  tx: Pick<Prisma.TransactionClient, 'wmsOperatorTask' | 'salesOrderRefund'>,
  input: { orderId: string; orderCurrency: string; imsRefundId: string; wcRefundId: number; amountForeign: Decimal; userId: string; now?: Date },
): Promise<ConfirmShopRefundResult> {
  const open = (await findOpenShopRefunds(tx, input.orderId)).find((o) => o.refundId === input.imsRefundId)
  if (!open) return { ok: false, error: 'That IMS refund is no longer waiting for a WooCommerce refund (it was settled, or its task was marked done). Nothing was changed.' }
  if (!shopRefundAmountEquals(open, input.orderCurrency, input.amountForeign)) {
    return { ok: false, error: `That IMS refund (${open.creditNoteNumber ?? open.refundId}) is not for this WooCommerce refund's amount, so it cannot be confirmed as settled by it. Nothing was changed.` }
  }
  const taken = await tx.salesOrderRefund.findFirst({ where: { externalRefundId: input.wcRefundId }, select: { id: true } })
  if (taken) return { ok: false, error: `WooCommerce refund ${input.wcRefundId} is already recorded in IMS. Nothing was changed.` }
  const linked = await tx.salesOrderRefund.updateMany({ where: { id: input.imsRefundId, orderId: input.orderId, deletedAt: null, externalRefundId: null }, data: { externalRefundId: input.wcRefundId } })
  if (linked.count === 0) return { ok: false, error: 'That IMS refund changed while it was being linked. Nothing was changed.' }
  const done = await tx.wmsOperatorTask.updateMany({ where: { id: open.taskId, status: 'OPEN' }, data: { status: 'DONE', doneAt: input.now ?? new Date(), doneBy: input.userId } })
  if (done.count === 0) throw new Error('The refund task was resolved by someone else while the WooCommerce refund was being linked; nothing was changed.')
  return { ok: true, taskId: open.taskId, creditNoteNumber: open.creditNoteNumber }
}
