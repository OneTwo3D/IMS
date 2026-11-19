import { createHash } from 'crypto'

export function accountingPayloadKey(prefix: string, payload: Record<string, unknown>): string {
  // Hash the full document payload, including currencyRateToBase. Normal retries
  // read the document-stamped FX rate and dedupe; a deliberate FX re-stamp is a
  // materially different accounting payload and should produce a new key.
  // `orderTotal` (the order total a sales document is rounded to, setting xero_round_to_order_total_enabled) is a build instruction, not document content: it is left out so
  // switching the setting never changes the key of a document that is already queued or posted, and a re-queue of it still dedupes onto the existing row.
  const { orderTotal: _orderTotal, ...keyed } = payload
  return `${prefix}:${createHash('sha256').update(JSON.stringify(keyed)).digest('hex')}`
}
