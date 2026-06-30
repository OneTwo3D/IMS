import { redactActivityLogText } from '@/lib/activity-log'

// A WMS API error can echo the customer's address/bank details back in its
// message. Beyond the shared email/secret redaction, strip UK postcodes and
// IBANs (matching the legacy plugin's scrub_error_message) before the text is
// persisted to WmsOrderPushLink.lastError / WmsSyncLog.reason.
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g
const UK_POSTCODE_PATTERN = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi

const MAX_LENGTH = 300

/**
 * Scrub PII from a WMS sync error before persisting it. Emails + secrets via the
 * shared redactor, plus IBANs and UK postcodes, then capped so a verbose upstream
 * error can't bloat the row. Accepts an Error, a string, or unknown.
 */
export function scrubWmsError(value: unknown, fallback = 'WMS sync error'): string {
  const raw = value instanceof Error ? value.message
    : typeof value === 'string' ? value
    : fallback
  const scrubbed = redactActivityLogText(raw || fallback)
    .replace(IBAN_PATTERN, '[redacted-iban]')
    .replace(UK_POSTCODE_PATTERN, '[redacted-postcode]')
  return scrubbed.length > MAX_LENGTH ? `${scrubbed.slice(0, MAX_LENGTH - 3)}...` : scrubbed
}
