import { createHash } from 'node:crypto'
import type { Prisma } from '@/app/generated/prisma/client'

/**
 * IMS OPERATOR QUERY TASKS: WHAT REPLACED THE ORDER COMMENTS IMS USED TO WRITE TO THE WAREHOUSE.
 *
 * The warehouse's staff do not read order comments; only a query raised in the warehouse's own system reaches them, and the API cannot raise
 * one (owner ruling, 2026-11-15). So IMS writes NO comment to a warehouse order. Wherever it used to, it records one task here: a person
 * raises the query by hand from the copy-ready text and marks the task done.
 *
 * A task holds NO personal data: the warehouse and IMS order numbers, SKUs and quantities. The text is built here and only here, from those.
 *
 * Tasks are deduplicated on (connector, order, warehouse order, reason, content hash): raising the same fact twice is one task, including
 * after it was done. A notice raised for a NEW episode (the order was released and held again) carries the episode in its basis, so it is a
 * new task.
 */

export const WMS_OPERATOR_TASK_REASONS = ['MERGED_LINES_REMOVED', 'PARTIAL_REMOVAL_CHECK', 'COURIER_FALLBACK', 'PUSH_CONFLICT', 'CANCEL_NOTICE', 'REFUND_NOTE', 'MERGE_CANDIDATE', 'SHOP_REFUND_DUE', 'AMENDMENT_NOT_APPLIED', 'ORDER_NOT_FOUND', 'CANCELLED_POSTED_INVOICE', 'MERGE_HOLD', 'MERGE_HOLD_OVERDUE', 'MERGE_HOLD_WITHDRAWAL', 'WITHDRAWAL_REJECT_NOT_WRITTEN'] as const
export type WmsOperatorTaskReasonValue = (typeof WMS_OPERATOR_TASK_REASONS)[number]

/** What an operator reads for each reason (the exceptions section). */
export const WMS_OPERATOR_TASK_REASON_LABELS: Record<WmsOperatorTaskReasonValue, string> = {
  MERGED_LINES_REMOVED: 'Lines removed from a merged order',
  PARTIAL_REMOVAL_CHECK: 'Partial removal: check the lines are gone',
  COURIER_FALLBACK: 'Courier fallback: verify the courier',
  PUSH_CONFLICT: 'Hold not honoured by the warehouse',
  CANCEL_NOTICE: 'Cancel not honoured by the warehouse',
  REFUND_NOTE: 'Refund on an order the warehouse already holds',
  MERGE_CANDIDATE: 'Same-customer orders still NEW: check them in the warehouse system and merge there if appropriate',
  SHOP_REFUND_DUE: 'Refund in WooCommerce: IMS recorded this refund, the shop still has to pay it back',
  AMENDMENT_NOT_APPLIED: 'Order change not applied: the warehouse order is already past NEW',
  ORDER_NOT_FOUND: 'Warehouse order not found on repeated checks: IMS stopped checking its status',
  CANCELLED_POSTED_INVOICE: 'Cancelled order with a posted invoice: the invoice is still uncredited in the ledger',
  WITHDRAWAL_REJECT_NOT_WRITTEN: 'Withdrawal request filed after despatch: IMS could not reject it on the storefront, reject it in WooCommerce',
  MERGE_HOLD: 'Orders on merge hold in the warehouse: merge them there and confirm the merged order yourself',
  MERGE_HOLD_OVERDUE: 'Merge hold overdue: merge and confirm the order in the warehouse',
  MERGE_HOLD_WITHDRAWAL: 'Withdrawal or cancel on an order on merge hold: act in the warehouse',
}

export type WmsOperatorTaskInput = {
  connector: string
  orderId: string
  /** The warehouse order the query is about. */
  externalOrderId: string
  reason: WmsOperatorTaskReasonValue
  queryText: string
  /** Display and Done context. Never personal data. */
  payload?: WmsOperatorTaskPayload
  /** What makes this task the same one raised again. Defaults to the query text; a notice names its episode instead. */
  dedupeBasis?: string
}

export type WmsOperatorTaskLine = { externalItemId: string; sku: string; quantity: number }
export type WmsOperatorTaskPayload = {
  /** The IMS order number, for display. */
  orderNumber?: string | null
  /** The warehouse's own order number, for display (the id is stored on the row). */
  externalOrderNumber?: string | null
  /** Partial-removal check: the link to settle and the lines that must all be gone first. */
  linkId?: string
  items?: WmsOperatorTaskLine[]
  /** Merge candidate: the orders of the group (IMS and warehouse numbers only). */
  members?: Array<{ orderId: string; orderNumber: string | null; externalOrderNumber: string }>
  /** Merge hold: the group this task is about (so a later retry can re-word it), its warnings, and for an unsettled-hold task which case it is. */
  groupBasis?: string
  warnings?: string[]
  kind?: string
  /** Refund in WooCommerce (SHOP_REFUND_DUE): the IMS refund the task is about and the figures the operator refunds. IMS figures and ids only. */
  shopRefund?: {
    refundId: string
    creditNoteNumber: string | null
    currency: string
    /** What the customer is to be paid back, tax included, in the order currency, to the currency's minor unit. Null when IMS could not price the refund's tax. */
    grossForeign: string | null
    /** The refund's net, in the order currency. */
    netForeign: string
    /** A fixed vocabulary, never the free-text reason typed on the refund. */
    reasonKind: 'GOODS_RETURNED' | 'AMOUNT_ONLY'
  }
}

export function wmsOperatorTaskHash(input: Pick<WmsOperatorTaskInput, 'reason' | 'queryText' | 'dedupeBasis'>): string {
  return createHash('sha256').update(`${input.reason}\n${input.dedupeBasis ?? input.queryText}`).digest('hex').slice(0, 40)
}

/**
 * Record a task, once. Returns true when a NEW row was written, false when the same task already exists (open or done). INSERT ... ON CONFLICT
 * DO NOTHING, so two overlapping writers cannot raise a unique violation.
 */
export async function raiseWmsOperatorTask(
  client: Pick<Prisma.TransactionClient, 'wmsOperatorTask'>,
  input: WmsOperatorTaskInput,
): Promise<boolean> {
  const { count } = await client.wmsOperatorTask.createMany({
    data: [{
      connector: input.connector,
      orderId: input.orderId,
      externalOrderId: input.externalOrderId,
      reason: input.reason,
      queryText: input.queryText,
      ...(input.payload ? { payload: input.payload as Prisma.InputJsonValue } : {}),
      contentHash: wmsOperatorTaskHash(input),
    }],
    skipDuplicates: true,
  })
  return count > 0
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The copy-ready text. One place, so what an operator is told for a case never differs by where it was raised from.
// ---------------------------------------------------------------------------------------------------------------------------------------

type LineRef = Pick<WmsOperatorTaskLine, 'externalItemId' | 'sku' | 'quantity'>

/** One warehouse line as an operator reads it: quantity, SKU and the warehouse's own line id. */
export function describeTaskLines(items: ReadonlyArray<LineRef>): string {
  return items.map((item) => `${item.quantity} x ${item.sku} (line ${item.externalItemId})`).join(', ')
}

/** The warehouse order as the operator knows it: its number when there is one, else its id. */
export function warehouseOrderRef(externalOrderNumber: string | null | undefined, externalOrderId: string): string {
  return externalOrderNumber && externalOrderNumber !== '' ? externalOrderNumber : externalOrderId
}

export function mergedLinesRemovedQuery(wmsOrder: string, imsOrder: string, removed: ReadonlyArray<LineRef>): string {
  return `Please confirm on warehouse order ${wmsOrder} that these lines are gone and that no other line was changed: ${describeTaskLines(removed)}. IMS removed them from this merged order because IMS order ${imsOrder} was cancelled / fully refunded.`
}

export function partialRemovalCheckQuery(wmsOrder: string, imsOrder: string, recorded: ReadonlyArray<LineRef>): string {
  return `Please take the lines of IMS order ${imsOrder} out of merged warehouse order ${wmsOrder} before it ships: ${describeTaskLines(recorded)}. IMS began removing them (the order was cancelled / fully refunded) and stopped part way, so some may still be on it. Do not cancel the merged order: it holds other orders' goods.`
}

export function courierFallbackQuery(wmsOrder: string, imsOrder: string, shippingService: string | null | undefined): string {
  return `Please verify the courier on warehouse order ${wmsOrder} (IMS order ${imsOrder}) before despatch. IMS shipping method '${shippingService ?? '—'}' did not map to a warehouse courier, so a default courier was used.`
}

/**
 * The query for a group of same-customer orders that are all still NEW in the warehouse. IMS never merges (the warehouse has no merge API):
 * a person checks the orders in Mintsoft and merges them there if that is right. Order numbers only.
 */
export function mergeCandidateQuery(members: ReadonlyArray<{ orderNumber: string | null; externalOrderId: string; externalOrderNumber: string }>, warnings: ReadonlyArray<string>, warehouseLabel: string): string {
  const list = members.map((member) => `${warehouseOrderRef(member.externalOrderNumber, member.externalOrderId)} (IMS order ${member.orderNumber ?? '—'})`).join(', ')
  const extra = warnings.length > 0 ? ` Warning: ${warnings.join(' ')}` : ''
  return `Please check these orders in ${warehouseLabel} and merge them there if appropriate: ${list}. They are for the same customer and delivery address and are all still NEW in ${warehouseLabel}. IMS does not merge orders and has changed nothing.${extra}`
}

/**
 * The query for an amendment the warehouse order could not take because it was already past NEW (so IMS changed nothing there). It names the EXACT
 * lines IMS wants the order to hold, so a person can apply them (or decide the warehouse should not) without opening IMS. SKUs and quantities only.
 */
export function amendmentNotAppliedQuery(wmsOrder: string, imsOrder: string, lines: ReadonlyArray<{ sku: string; quantity: number }>, wmsStatus: string): string {
  const wanted = lines.length > 0 ? lines.map((line) => `${line.quantity} x ${line.sku}`).join(', ') : 'no lines'
  return `IMS order ${imsOrder} was changed after warehouse order ${wmsOrder} left NEW (warehouse status ${wmsStatus}), so IMS could not amend it and has changed nothing there. `
    + `IMS now holds this order as: ${wanted}. Please check the warehouse order against these lines and, if it is not yet despatched, make the change there.`
}

/**
 * The query for a warehouse order the status sweep asked about several times in a row and the warehouse said does not exist. IMS has marked the
 * order NOTFOUND and stopped polling it; it has changed nothing in the warehouse or the storefront. Order numbers only.
 */
export function orderNotFoundQuery(wmsOrder: string, imsOrder: string, checks: number): string {
  return `IMS sent order ${imsOrder} to the warehouse as order ${wmsOrder}, but the warehouse answered that it does not exist on ${checks} status checks in a row, so IMS has stopped checking its status. `
    + `Please look the order up in the warehouse's own system. If it was cancelled, merged or renamed there, nothing more is needed. If it should still exist, raise a query with the warehouse to find out what happened to it before it is despatched. IMS has changed nothing.`
}

export function refundNoteQuery(wmsOrder: string, imsOrder: string, creditNote: string | null | undefined, full: boolean): string {
  const cn = creditNote ? ` (credit note ${creditNote})` : ''
  return full
    ? `Warehouse order ${wmsOrder} (IMS order ${imsOrder}) was fully refunded in IMS${cn}. If it has not been despatched please cancel it; if it is already in progress please treat this as a cancellation request.`
    : `Warehouse order ${wmsOrder} (IMS order ${imsOrder}) was partly refunded in IMS${cn} and its line quantities were reduced. If the order can no longer be amended automatically, please remove the refunded items from it.`
}

/**
 * The query for a hold or cancel whose warehouse order could not be PROVED to be this order (its number did not match, could not be read, or
 * the order was not found and no merge could be proven). IMS sent nothing. An operator investigates and acts; nothing here tells them to cancel
 * an order that may not be this one.
 */
export function identityCheckQuery(intent: 'HOLD' | 'CANCEL', wmsOrder: string, imsOrder: string): string {
  const what = intent === 'HOLD' ? 'placed ON HOLD in IMS' : 'CANCELLED / fully refunded in IMS'
  const act = intent === 'HOLD' ? 'pause' : 'cancel'
  return `IMS order ${imsOrder} was ${what}, but IMS could not confirm that warehouse order ${wmsOrder} is this order (its number or id does not match what IMS sent, or it could not be found), so IMS sent nothing to the warehouse. `
    + `Please look the order up in the warehouse and act: if it is this order and has not been despatched, ${act} it; if it was merged or renamed, deal with the order it became; do not change an order that is not this one.`
}

/** The lastError of a notice whose task is an investigation: the retry pass reads it to raise the same kind of task. */
export const INVESTIGATE_NOTICE_PREFIX = 'Check needed: '

export function noticeQuery(intent: 'HOLD' | 'CANCEL', merged: boolean, wmsOrder: string, imsOrder: string): string {
  if (intent === 'HOLD') {
    return merged
      ? `IMS order ${imsOrder} was placed ON HOLD in IMS, and it is part of merged warehouse order ${wmsOrder}. IMS has not cancelled the merged order because it holds other orders' goods. Please take the held order's items out of it if you can.`
      : `IMS order ${imsOrder} was placed ON HOLD in IMS but warehouse order ${wmsOrder} is already being fulfilled and could not be cancelled automatically. Please pause it if possible.`
  }
  return merged
    ? `IMS order ${imsOrder} was CANCELLED / fully refunded in IMS, and it is part of merged warehouse order ${wmsOrder}. IMS has not cancelled the merged order because it holds other orders' goods. Please take the cancelled order's items out of it before despatch.`
    : `IMS order ${imsOrder} was cancelled / fully refunded in IMS but warehouse order ${wmsOrder} is already being fulfilled and could not be cancelled automatically. Please cancel it before despatch.`
}
