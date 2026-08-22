/**
 * What the POSTED sales invoice actually did with the order-level discount (o3d-356o).
 *
 * A chargeback credit note has to reverse the document that exists, not the document today's
 * settings would produce. The Xero adapter appends its negative "Order discount" line only when
 * the ENQUEUED payload carried BOTH a positive `discountAmount` AND a `discountAccountCode`
 * (lib/connectors/xero/invoices.ts). Reading `getAccountingSettings().discountAccount` live is
 * therefore a proxy for that decision, and the proxy is wrong whenever the setting moved after
 * the invoice posted:
 *
 *   • discount account configured AFTER the post — the invoice charged the FULL goods value, but
 *     the chargeback mirrors a discount line anyway and UNDER-CREDITS by the discount;
 *   • discount account removed after the post — the chargeback safe-skips to manual, which is
 *     merely conservative.
 *
 * The mirrored accounting event is the record of what was sent: `queueXeroSync` mirrors the
 * payload at enqueue time and the sync processor flips it to POSTED once Xero accepts it, so a
 * POSTED SALES_INVOICE / SALES_INVOICE_UPDATE event for the order carries the discount exactly
 * as the connector saw it. `normalizeAdjustment` in the document-event builder drops a
 * non-positive amount entirely and keeps `accountCode` optional, which reproduces the
 * connector's own two-part condition without re-implementing it.
 *
 * ORDERS WITH NO MIRRORED POSTED EVENT KEEP TODAY'S BEHAVIOUR, deliberately: making every
 * chargeback depend on a mirror existing is a far larger blast radius than the bug being fixed.
 */

export type PostedDocumentDiscount =
  /** No POSTED document event for this order — nothing to read; caller falls back. */
  | { known: false; unreadable?: false }
  /** The event could not be read at all (query failed / payload unrecognised). Fail closed. */
  | { known: false; unreadable: true; reason: string }
  /** The document posted, and carried NO order-level discount line. */
  | { known: true; postedDiscountLine: false }
  /** The document posted an order-level discount line to `accountCode`. */
  | { known: true; postedDiscountLine: true; accountCode: string; amount: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the discount decision out of a mirrored accounting-document event payload.
 *
 * Returns `unreadable` — NOT "no discount line" — when the payload is not a recognisable
 * accounting-document payload. The two are not interchangeable: "the document carried no
 * discount line" is a positive finding that suppresses the credit note's discount line, and
 * inferring it from an unparseable blob would be exactly the silent guess this replaces.
 */
export function readPostedDocumentDiscount(linesJson: unknown): PostedDocumentDiscount {
  if (!isRecord(linesJson) || linesJson.kind !== 'accounting-document') {
    return { known: false, unreadable: true, reason: 'the mirrored accounting event is not a document payload' }
  }
  const discount = linesJson.discount
  if (discount === undefined || discount === null) return { known: true, postedDiscountLine: false }
  if (!isRecord(discount)) {
    return { known: false, unreadable: true, reason: 'the mirrored accounting event has a malformed discount' }
  }

  const amount = discount.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { known: true, postedDiscountLine: false }
  }
  const accountCode = typeof discount.accountCode === 'string' ? discount.accountCode.trim() : ''
  if (!accountCode) return { known: true, postedDiscountLine: false }

  return { known: true, postedDiscountLine: true, accountCode, amount }
}

export type ChargebackDiscountDecision =
  /** Mirror the order-level discount onto the credit note. */
  | { action: 'mirror-discount' }
  /** Credit the full goods value — the invoice posted no discount line. */
  | { action: 'no-discount-line'; reason: string }
  /** Refuse to auto-raise; an operator must raise the credit note by hand. */
  | { action: 'manual'; reason: string }

/**
 * Decide whether a chargeback credit note carries an order-level discount line.
 *
 * `configuredDiscountAccount` stays in the decision, but ONLY as "can we post the line at all"
 * — the credit-note builder takes its account code from the live setting, so a posted discount
 * line that today has no account, or a DIFFERENT account, cannot be mirrored faithfully. Both go
 * to manual rather than posting the reversal somewhere the original debit never went.
 */
export function decideChargebackDiscountLine(params: {
  /** SalesOrder.discountAmount, in the order's own convention. Only its sign is used here. */
  orderDiscountAmount: number
  /** getAccountingSettings().discountAccount as it stands NOW, or null when unreadable. */
  configuredDiscountAccount: string | null | undefined
  posted: PostedDocumentDiscount
}): ChargebackDiscountDecision {
  if (!(params.orderDiscountAmount > 0)) {
    return { action: 'no-discount-line', reason: 'the order carries no order-level discount' }
  }

  const configured = params.configuredDiscountAccount?.trim() || null

  if (params.posted.known) {
    if (!params.posted.postedDiscountLine) {
      return {
        action: 'no-discount-line',
        reason: 'the posted sales invoice carried no order discount line, so the chargeback credits the full goods value',
      }
    }
    if (!configured) {
      return {
        action: 'manual',
        reason: `the posted sales invoice carried an order discount line to account ${params.posted.accountCode} but no discount account is configured now`,
      }
    }
    if (configured !== params.posted.accountCode) {
      return {
        action: 'manual',
        reason: `the posted sales invoice put its order discount line on account ${params.posted.accountCode} but the configured discount account is now ${configured}`,
      }
    }
    return { action: 'mirror-discount' }
  }

  if (params.posted.unreadable) {
    return { action: 'manual', reason: `could not determine what the posted sales invoice did with the order discount — ${params.posted.reason}` }
  }

  // No mirrored posted document: unchanged pre-o3d-356o behaviour, live setting as the proxy.
  if (!configured) {
    return { action: 'manual', reason: 'no discount account is configured' }
  }
  return { action: 'mirror-discount' }
}

type PostedDocumentEventReader = {
  findFirst(args: {
    where: {
      sourceEntityType: string
      sourceEntityId: string
      type: { in: string[] }
      status: string
    }
    orderBy: { createdAt: 'desc' }
    select: { linesJson: true }
  }): Promise<{ linesJson: unknown } | null>
}

export const POSTED_SALES_INVOICE_EVENT_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const

/**
 * Load the LATEST posted sales-invoice document event for an order. A SALES_INVOICE_UPDATE
 * supersedes the create it amends, so the newest POSTED row — not the first — is the one that
 * describes the document standing in the ledger right now.
 */
export async function readPostedSalesInvoiceDiscountForOrder(
  accountingEvent: PostedDocumentEventReader,
  orderId: string,
): Promise<PostedDocumentDiscount> {
  let row: { linesJson: unknown } | null
  try {
    row = await accountingEvent.findFirst({
      where: {
        sourceEntityType: 'SalesOrder',
        sourceEntityId: orderId,
        type: { in: [...POSTED_SALES_INVOICE_EVENT_TYPES] },
        status: 'POSTED',
      },
      orderBy: { createdAt: 'desc' },
      select: { linesJson: true },
    })
  } catch (error) {
    return { known: false, unreadable: true, reason: `the accounting event could not be read (${String(error)})` }
  }
  if (!row) return { known: false }
  return readPostedDocumentDiscount(row.linesJson)
}
