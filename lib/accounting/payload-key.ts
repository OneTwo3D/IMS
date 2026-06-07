import { createHash } from 'crypto'

export function accountingPayloadKey(prefix: string, payload: Record<string, unknown>): string {
  // Hash the full document payload, including currencyRateToBase. Normal retries
  // read the document-stamped FX rate and dedupe; a deliberate FX re-stamp is a
  // materially different accounting payload and should produce a new key.
  return `${prefix}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`
}
