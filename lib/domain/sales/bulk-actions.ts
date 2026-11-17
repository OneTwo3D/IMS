/**
 * Pure rules for the sales-order list's bulk actions: the request cap, which orders a bulk action
 * skips and why, and the operator wording of a refusal. No I/O here; the server actions in
 * app/actions/sales-bulk.ts call these and then the SAME per-order services the order page uses.
 */

import { nextStatusActions, type StatusFlowAction } from './status-flow'

/** The most orders one bulk request may name. Larger selections are refused, not truncated. */
export const BULK_ORDER_CAP = 100

export type BulkRowOutcome = 'done' | 'skipped' | 'failed'

export type BulkRowResult = {
  id: string
  /** What the operator sees in the list (never the database id). */
  orderNumber: string
  outcome: BulkRowOutcome
  /** Operator-facing: what happened, or why the row was skipped or failed. */
  message: string
}

export type BulkRunResult =
  | { ok: true; results: BulkRowResult[]; counts: Record<BulkRowOutcome, number> }
  | { ok: false; error: string }

export function bulkCounts(results: readonly BulkRowResult[]): Record<BulkRowOutcome, number> {
  const counts: Record<BulkRowOutcome, number> = { done: 0, skipped: 0, failed: 0 }
  for (const r of results) counts[r.outcome] += 1
  return counts
}

/** De-duplicated ids, or the refusal to show. Validates the shape because a server action argument is untrusted. */
export function normaliseBulkOrderIds(input: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(input) || input.some((v) => typeof v !== 'string' || v.length === 0)) {
    return { error: 'Select at least one order first.' }
  }
  const ids = [...new Set(input as string[])]
  if (ids.length === 0) return { error: 'Select at least one order first.' }
  if (ids.length > BULK_ORDER_CAP) {
    return { error: `You can run a bulk action on at most ${BULK_ORDER_CAP} orders at a time (${ids.length} selected). Untick some orders and run it again.` }
  }
  return { ids }
}

const STATUS_NAME: Record<string, string> = {
  DRAFT: 'a draft',
  PENDING_PAYMENT: 'waiting for payment',
  ON_HOLD: 'on hold',
  PROCESSING: 'processing',
  ALLOCATED: 'allocated',
  PICKING: 'being picked',
  PACKING: 'being packed',
  SHIPPED: 'shipped',
  COMPLETED: 'completed',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
}
const statusName = (status: string) => STATUS_NAME[status] ?? status.toLowerCase()

/** Why bulk Allocate leaves this order alone, or null when it should be allocated (only PROCESSING orders are, as on the order page's Allocate button). */
export function allocateSkipReason(status: string): string | null {
  switch (status) {
    case 'PROCESSING':
      return null
    case 'ALLOCATED':
    case 'PICKING':
    case 'PACKING':
      return 'Already allocated. Open the order to re-allocate or change the allocation.'
    case 'DRAFT':
    case 'PENDING_PAYMENT':
    case 'ON_HOLD':
      return `Not ready to allocate: the order is ${statusName(status)}. Process it first.`
    default:
      return `Nothing to allocate: the order is ${statusName(status)}.`
  }
}

/** The single manual step bulk Advance would take, or the reason it is skipped. */
export function advancePlan(
  status: string,
  archived: boolean,
  deliveryTrackingEnabled: boolean,
): { action: StatusFlowAction } | { skip: string } {
  if (archived) return { skip: 'Archived. Unarchive the order before changing its status.' }
  const [action] = nextStatusActions(status, deliveryTrackingEnabled)
  if (action) return { action }
  if (status === 'ALLOCATED' || status === 'PICKING' || status === 'PACKING') {
    return { skip: `Not in a state that can advance here: the order is ${statusName(status)} and moves on through its shipments.` }
  }
  if (status === 'COMPLETED') {
    return { skip: 'Not in a state that can advance: delivery tracking is off, so there is no Delivered step.' }
  }
  return { skip: `Not in a state that can advance: the order is ${statusName(status)}.` }
}

/**
 * The statuses bulk Advance may ever move an order INTO. Pinned so a later edit of the flow cannot
 * quietly reach a status whose transition does its own storefront write (SHIPPED, CANCELLED, ON_HOLD).
 */
export const BULK_ADVANCE_TARGETS: readonly string[] = ['PROCESSING', 'ALLOCATED', 'COMPLETED', 'DELIVERED']

/** A thrown or returned error as one sentence an operator can act on. */
export function operatorMessage(raw: unknown, fallback = 'Something went wrong. Open the order and try again.'): string {
  let text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : ''
  text = text.replace(/^(?:Error:\s*)+/i, '').trim()
  if (!text) return fallback
  const forbidden = /^Forbidden: missing permission/i
  if (forbidden.test(text)) return 'You do not have permission to process sales orders.'
  // Database / driver text is not operator wording.
  if (/prisma|invalid `|\bP\d{4}\b|ECONN|deadlock|could not serialize|reach database/i.test(text)) return fallback
  return /[.!?]$/.test(text) ? text : `${text}.`
}
