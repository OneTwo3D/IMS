/**
 * Thrown by an email preparer when the kind of email is switched off by a setting at SEND time. The outbox drain settles the row
 * FAILED with `message` as the reason (keeping the stored address, nothing is sent) instead of treating it as a send conflict.
 * This is what makes a switch-off cover rows that were queued before it was turned off.
 */
export class EmailKindDisabledError extends Error {
  override readonly name = 'EmailKindDisabledError'
}
