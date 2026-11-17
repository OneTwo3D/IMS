import { parseBatchDay } from '@/lib/domain/accounting/daily-batch-event-date'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { isFullRefundAmount } from '@/lib/domain/sales/refund-thresholds'

/**
 * o3d-ngmt.22: DELETING A REFUND RECORDED IN ERROR. The pure half: the switch, every reason a delete is refused (with the wording an
 * operator reads), and the arithmetic that has no database in it. The writer is refund-delete-service.ts.
 *
 * THE DESIGN RULE, STATED ONCE: A DELETE UNWINDS EXACTLY WHAT THE REFUND POSTED; IT NEVER RECOMPUTES IT. Stock goes out as the recorded
 * return movement and the cost layers that return created; the COGS reversal is reversed at the amount its own journal carries; the credit
 * note is voided at the ledger id it was posted under. Nothing here prices anything again, so the result does not depend on the open finance
 * decision about how a refund's COGS reversal is valued (onetwo3d-ims-6oyu.5): whichever basis a refund used, its delete undoes that basis.
 */

/** The switch. Off unless the row says exactly 'true'; a missing row is off. */
export const REFUND_DELETE_SETTING = 'refund_delete_enabled'

export function refundDeleteEnabledFromSetting(value: string | null | undefined): boolean {
  return value === 'true'
}

/** The refund `source` of a refund an operator recorded in IMS. Every other source is imported or automatic and would come back. */
export const IMS_RECORDED_REFUND_SOURCE = 'MANUAL_UI'

export const REFUND_DELETE_REFUSAL_CODES = [
  'setting_off',
  'order_erased',
  'woocommerce_origin',
  'automatic_origin',
  'credit_note_settled',
  'books_locked',
  'stock_moved',
  'stock_untraceable',
  'store_credit_order',
  'accounting_in_flight',
  'accounting_uncertain',
  'accounting_not_queued',
  'accounting_unfinished',
  'journal_unsupported',
  'in_transit_return',
  'warehouse_release_in_flight',
  'legacy_basis',
] as const
export type RefundDeleteRefusalCode = (typeof REFUND_DELETE_REFUSAL_CODES)[number]

export type RefundDeleteRefusal = { code: RefundDeleteRefusalCode; message: string }

export type RefundDeleteEvaluation = { eligible: boolean; refusals: RefundDeleteRefusal[] }

/** The operator wording of each refusal. Fixed text built here: no remote error and no customer text is ever copied into it. */
export const refundDeleteRefusals = {
  settingOff: (): RefundDeleteRefusal => ({
    code: 'setting_off',
    message: 'Deleting refunds is switched off for this system, so this refund cannot be deleted. An administrator can switch it on with the refund_delete_enabled setting.',
  }),
  orderErased: (): RefundDeleteRefusal => ({
    code: 'order_erased',
    message: 'This order has been erased (its personal data was removed), so its refunds are a closed record and cannot be deleted.',
  }),
  woocommerceOrigin: (): RefundDeleteRefusal => ({
    code: 'woocommerce_origin',
    message: 'This refund came from WooCommerce. IMS would import it again, so it cannot be deleted here. Remove or correct it in WooCommerce; only refunds recorded in IMS can be deleted in IMS.',
  }),
  automaticOrigin: (): RefundDeleteRefusal => ({
    code: 'automatic_origin',
    message: 'This refund was raised automatically (for example from a payment reversal), not recorded by a person in IMS, so it cannot be deleted here.',
  }),
  creditNoteSettled: (count: number): RefundDeleteRefusal => ({
    code: 'credit_note_settled',
    message: `This refund's credit note has ${count} payment${count === 1 ? '' : 's'} or allocation${count === 1 ? '' : 's'} recorded against it. Remove ${count === 1 ? 'it' : 'them'} first; a credit note that has been paid out or applied cannot be voided.`,
  }),
  booksLocked: (date: string, lockDate: string): RefundDeleteRefusal => ({
    code: 'books_locked',
    message: `The credit note is dated ${date}, which is on or before the accounting lock date ${lockDate}. The accounting system will not accept a change in a locked period, so this refund cannot be deleted. Correct it with a new entry dated after the lock.`,
  }),
  stockMoved: (detail: string): RefundDeleteRefusal => ({
    code: 'stock_moved',
    message: `The stock this refund returned has since been used, reserved or moved (${detail}), so it cannot be taken back out cleanly. Resolve that stock first, or correct the refund with a new entry instead.`,
  }),
  stockUntraceable: (): RefundDeleteRefusal => ({
    code: 'stock_untraceable',
    message: 'This refund returned stock before IMS recorded which cost layers the return created, so the return cannot be reversed exactly. Correct the refund with a new entry instead.',
  }),
  storeCreditOrder: (): RefundDeleteRefusal => ({
    code: 'store_credit_order',
    message: 'This order carries store credit. Whether any credit issued for this refund has been spent is held in the store, not in IMS, so the refund cannot be deleted from here.',
  }),
  accountingInFlight: (what: string): RefundDeleteRefusal => ({
    code: 'accounting_in_flight',
    message: `The ${what} for this refund is being sent to the accounting system right now. Wait a few minutes and try again.`,
  }),
  accountingUncertain: (what: string): RefundDeleteRefusal => ({
    code: 'accounting_uncertain',
    message: `IMS cannot prove what happened to the ${what} for this refund: it may have reached the accounting system without being recorded, or it is held there for another system to post. Check the accounting system and the sync page first; the refund is left as it is.`,
  }),
  accountingNotQueued: (what: string, reason: string | undefined): RefundDeleteRefusal => ({
    code: 'accounting_not_queued',
    message: reason === 'shadowed'
      ? `IMS does not post the ${what} for this document type (another system owns it and IMS only shadows it), so it cannot queue the change and the refund is left as it is. The ${what} has to be changed in the accounting system itself.`
      : reason === 'not-configured'
        ? `Posting of the ${what} is switched off in the accounting settings, so IMS cannot queue the change and the refund is left as it is. Switch it on in the accounting settings and try again.`
        : `IMS could not queue the change to the ${what} (the accounting connector refused it), so the refund is left as it is. Check the accounting settings and the sync page, then try again.`,
  }),
  accountingUnfinished: (): RefundDeleteRefusal => ({
    code: 'accounting_unfinished',
    message: 'This refund\'s accounting is still being queued or needs a retry. Finish or retry it first, then delete the refund.',
  }),
  journalUnsupported: (what: string): RefundDeleteRefusal => ({
    code: 'journal_unsupported',
    message: `This refund also moved ${what}, which a delete cannot unwind exactly. Correct the refund with a new entry instead.`,
  }),
  inTransitReturn: (): RefundDeleteRefusal => ({
    code: 'in_transit_return',
    message: 'This refund routed its returned goods in transit. Close or write off the return first; a refund with a return expectation cannot be deleted.',
  }),
  warehouseReleaseInFlight: (): RefundDeleteRefusal => ({
    code: 'warehouse_release_in_flight',
    message: 'The stock reservation for this refund is being released right now. Wait a few minutes and try again.',
  }),
  legacyBasis: (): RefundDeleteRefusal => ({
    code: 'legacy_basis',
    message: 'This order has an older refund whose totals are not on the current net basis, so the order\'s refund status cannot be recalculated safely after a delete.',
  }),
} as const

/** The day (YYYY-MM-DD) of a refund's credit note: the sync payload's own date when there is one, else the day the refund was recorded. */
export function creditNoteDay(payloadDate: unknown, refundedAt: Date): string {
  const parsed = typeof payloadDate === 'string' ? parseBatchDay(payloadDate) : null
  return parsed ?? refundedAt.toISOString().slice(0, 10)
}

/**
 * True when `day` is on or before the books lock date. A missing or unreadable lock date locks nothing (the importer stores '' when Xero
 * reports none); the live void still fails safely in the ledger if the period is in fact locked.
 */
export function isOnOrBeforeLockDate(day: string, lockDate: string | null | undefined): boolean {
  const lock = parseBatchDay(lockDate)
  return lock !== null && day <= lock
}

/**
 * The refund disposition of an order once `remaining` refunds are all that is left. NONE with no refund; FULL when the NET refunds cover the NET
 * order total (the basis the writer classifies on); otherwise PARTIAL. Returns null when any remaining refund is not on the NET basis: the sum
 * would mix units, so the caller refuses rather than guess.
 */
export function refundDispositionAfterDelete(input: {
  orderTotalBase: DecimalInput
  orderTaxBase: DecimalInput | null | undefined
  remaining: ReadonlyArray<{ totalBase: DecimalInput; totalsBasis: string | null }>
}): 'NONE' | 'PARTIAL' | 'FULL' | null {
  if (input.remaining.length === 0) return 'NONE'
  if (!input.remaining.every((refund) => refund.totalsBasis === 'NET')) return null
  const net = toDecimal(input.orderTotalBase).sub(toDecimal(input.orderTaxBase ?? 0))
  const orderTotal = net.lt(0) ? toDecimal(0) : net
  const refunded = input.remaining.reduce((sum, refund) => sum.add(toDecimal(refund.totalBase)), toDecimal(0))
  if (orderTotal.lte(0)) return refunded.gte(0) ? 'FULL' : 'PARTIAL'
  return isFullRefundAmount(refunded, orderTotal) ? 'FULL' : 'PARTIAL'
}
