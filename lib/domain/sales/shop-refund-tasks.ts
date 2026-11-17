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
 * THE DUPLICATE CREDIT NOTE THIS PREVENTS. The WooCommerce refund import dedups on the storefront refund id alone. The person's later refund in
 * WooCommerce has a new id, so, left alone, the import would raise a SECOND credit note for money IMS already credited. So the import first asks
 * `matchWcRefundToOpenTask`: does this storefront refund settle an IMS refund that is waiting for it?
 *
 *   no task open on the order      nothing here applies: the import runs exactly as before (a refund that began in WooCommerce is untouched)
 *   exactly one task fits          the storefront refund id is set on the IMS refund, the task is resolved, and NO new credit note is raised
 *   anything else                  IMS does not guess: it records nothing and parks the refund with both sets of figures for a person
 *
 * "Fits" is: the same order, the same currency, the amount equal to the minor unit, an IMS refund with no storefront refund id, and an open task.
 *
 * The task holds no personal data: ids, the credit note number and money. The free-text reason typed on the IMS refund is NOT copied; the task
 * states a fixed kind instead, and the operator reads the typed reason on the order.
 */

export const SHOP_REFUND_CONNECTOR = 'woocommerce'
/** Recorded as `doneBy` when the import, not a person, resolved the task. */
export const SHOP_REFUND_TASK_IMPORT_ACTOR = 'system:woocommerce-refund-import'

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
    + 'The typed reason is on the IMS order. When the refund is made in WooCommerce and IMS imports it, IMS links it to this credit note, raises no second credit note and marks this task done. If you refund a different amount, IMS will not match it and will ask you to look at both.'
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

export type ShopRefundMatch =
  | { kind: 'none' }
  | { kind: 'matched'; taskId: string; refundId: string }
  | { kind: 'ambiguous'; message: string }

type MatchClient = Pick<Prisma.TransactionClient, 'wmsOperatorTask' | 'salesOrderRefund'>

function shopRefundOf(payload: Prisma.JsonValue | null): NonNullable<WmsOperatorTaskPayload['shopRefund']> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = (payload as WmsOperatorTaskPayload).shopRefund
  return value && typeof value === 'object' ? value : null
}

/**
 * Does this storefront refund settle an IMS refund that is waiting for it? Read-only.
 *
 * `amountForeign` is the storefront refund's stated amount (tax included) in the order currency, `orderCurrency` the order's. The figures in
 * the ambiguous answer are IMS's and the storefront's own: amounts, currency and credit note numbers; no person is named.
 */
export async function matchWcRefundToOpenTask(
  client: MatchClient,
  input: { orderId: string; orderCurrency: string; wcRefundId: number; amountForeign: Decimal },
): Promise<ShopRefundMatch> {
  const open = await client.wmsOperatorTask.findMany({
    where: { orderId: input.orderId, connector: SHOP_REFUND_CONNECTOR, reason: 'SHOP_REFUND_DUE', status: 'OPEN' },
    select: { id: true, externalOrderId: true, payload: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (open.length === 0) return { kind: 'none' }

  const digits = currencyMinorUnits(input.orderCurrency)
  const incoming = input.amountForeign.toDecimalPlaces(digits)
  // Only a task whose IMS refund still has no storefront refund id can be settled by this one.
  const refunds = await client.salesOrderRefund.findMany({
    where: { id: { in: open.map((task) => task.externalOrderId) }, orderId: input.orderId, externalRefundId: null },
    select: { id: true },
  })
  const waiting = new Set(refunds.map((refund) => refund.id))
  const candidates = open
    .filter((task) => waiting.has(task.externalOrderId))
    .map((task) => ({ task, facts: shopRefundOf(task.payload) }))

  const figures = candidates
    .map(({ task, facts }) => `${facts?.creditNoteNumber ?? task.externalOrderId}: ${facts?.grossForeign ?? 'unknown'} ${facts?.currency ?? input.orderCurrency}`)
    .join('; ')
  const fits = candidates.filter(({ facts }) => facts !== null
    && facts.currency === input.orderCurrency
    && facts.grossForeign !== null
    && toDecimal(facts.grossForeign).toDecimalPlaces(digits).equals(incoming))

  if (fits.length === 1) return { kind: 'matched', taskId: fits[0].task.id, refundId: fits[0].task.externalOrderId }
  const incomingText = `${incoming.toFixed(digits)} ${input.orderCurrency}`
  if (fits.length > 1) {
    return { kind: 'ambiguous', message: `WooCommerce refund ${input.wcRefundId} (${incomingText}) fits ${fits.length} open IMS refunds on this order equally (${figures}), so IMS cannot tell which one it settles.` }
  }
  return {
    kind: 'ambiguous',
    message: candidates.length === 0
      ? `WooCommerce refund ${input.wcRefundId} (${incomingText}) arrived on an order whose open "Refund in WooCommerce" task no longer has an IMS refund waiting for a storefront refund, so IMS cannot tell what it settles.`
      : `WooCommerce refund ${input.wcRefundId} (${incomingText}) does not equal the amount of any open IMS refund on this order (${figures}), so IMS cannot tell whether it settles one of them.`,
  }
}

/**
 * Link the storefront refund to the IMS refund and resolve the task, in one transaction. The IMS refund is changed only while it still has no
 * storefront refund id, and the task only while it is still open, so two racing imports cannot both win.
 * Returns false when either compare-and-set lost (a person or another import got there first): nothing is then written.
 */
export async function settleShopRefundTask(
  tx: Pick<Prisma.TransactionClient, 'wmsOperatorTask' | 'salesOrderRefund'>,
  input: { orderId: string; taskId: string; refundId: string; wcRefundId: number; now?: Date },
): Promise<boolean> {
  const at = input.now ?? new Date()
  const linked = await tx.salesOrderRefund.updateMany({
    where: { id: input.refundId, orderId: input.orderId, externalRefundId: null },
    data: { externalRefundId: input.wcRefundId },
  })
  if (linked.count === 0) return false
  const done = await tx.wmsOperatorTask.updateMany({
    where: { id: input.taskId, status: 'OPEN' },
    data: { status: 'DONE', doneAt: at, doneBy: SHOP_REFUND_TASK_IMPORT_ACTOR },
  })
  if (done.count === 0) throw new Error('The refund task was resolved by someone else while the storefront refund was being linked; nothing was changed.')
  return true
}
