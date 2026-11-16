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

export const WMS_OPERATOR_TASK_REASONS = ['MERGED_LINES_REMOVED', 'PARTIAL_REMOVAL_CHECK', 'COURIER_FALLBACK', 'PUSH_CONFLICT', 'CANCEL_NOTICE', 'REFUND_NOTE'] as const
export type WmsOperatorTaskReasonValue = (typeof WMS_OPERATOR_TASK_REASONS)[number]

/** What an operator reads for each reason (the exceptions section). */
export const WMS_OPERATOR_TASK_REASON_LABELS: Record<WmsOperatorTaskReasonValue, string> = {
  MERGED_LINES_REMOVED: 'Lines removed from a merged order',
  PARTIAL_REMOVAL_CHECK: 'Partial removal: check the lines are gone',
  COURIER_FALLBACK: 'Courier fallback: verify the courier',
  PUSH_CONFLICT: 'Hold not honoured by the warehouse',
  CANCEL_NOTICE: 'Cancel not honoured by the warehouse',
  REFUND_NOTE: 'Refund on an order the warehouse already holds',
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

export function refundNoteQuery(wmsOrder: string, imsOrder: string, creditNote: string | null | undefined, full: boolean): string {
  const cn = creditNote ? ` (credit note ${creditNote})` : ''
  return full
    ? `Warehouse order ${wmsOrder} (IMS order ${imsOrder}) was fully refunded in IMS${cn}. If it has not been despatched please cancel it; if it is already in progress please treat this as a cancellation request.`
    : `Warehouse order ${wmsOrder} (IMS order ${imsOrder}) was partly refunded in IMS${cn} and its line quantities were reduced. If the order can no longer be amended automatically, please remove the refunded items from it.`
}

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
