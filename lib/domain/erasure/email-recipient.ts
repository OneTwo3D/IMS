import { ERASURE_PLACEHOLDER_EMAIL } from './erasure-record'

/**
 * THE EMAIL DRAIN'S SIDE OF AN ERASURE. Pure, import-light: lib/email-outbox.ts and lib/order-email.ts both import it.
 *
 * An email row queued for an order carries the recipient address. The body is rendered at SEND time from the live
 * order, so an erased order already cannot be rendered; what this closes is the rows that would otherwise still go out
 * to the stored address: a row claimed (PROCESSING) when the erasure ran, a kind whose preparer returns nothing, and a
 * row whose address stopped matching the order.
 */
export class EmailRecipientErasedError extends Error {
  override readonly name = 'EmailRecipientErasedError'
}

export const EMAIL_RECIPIENT_ERASED_REASON = 'Cancelled: the recipient\'s personal data was erased'
export const EMAIL_RECIPIENT_CHANGED_REASON = 'Cancelled: the address on the order no longer matches the queued recipient'
export const ERASED_RECIPIENT_PLACEHOLDER = ERASURE_PLACEHOLDER_EMAIL
