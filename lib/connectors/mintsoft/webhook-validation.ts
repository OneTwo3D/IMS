const MAX_MINTSOFT_WEBHOOK_CLOCK_SKEW_MS = 10 * 60 * 1000

const MINTSOFT_WEBHOOK_TIMESTAMP_KEYS = [
  'timestamp',
  'eventTime',
  'occurredAt',
  'createdAt',
] as const

const MINTSOFT_WEBHOOK_TIMESTAMP_HEADERS = [
  'x-mintsoft-timestamp',
  'x-webhook-timestamp',
  'x-timestamp',
] as const

export type MintsoftWebhookTimestampCandidate = {
  date: Date
  value: string
  source: 'payload' | 'header'
  key: string
}

function parseWebhookTimestampValue(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = value > 1e12 ? value : value * 1000
    const parsed = new Date(normalized)
    return Number.isFinite(parsed.getTime()) ? parsed : null
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed : null
  }

  return null
}

function getHeaderValue(
  headers: Headers | Record<string, string | undefined> | undefined,
  key: string,
): string | null {
  if (!headers) return null
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(key)
  }

  const normalizedHeaders = headers as Record<string, string | undefined>
  return normalizedHeaders[key] ?? normalizedHeaders[key.toLowerCase()] ?? null
}

function timestampSignatureValue(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

export function extractMintsoftWebhookTimestampCandidate(
  payload: Record<string, unknown>,
  headers?: Headers | Record<string, string | undefined>,
): MintsoftWebhookTimestampCandidate | null {
  for (const key of MINTSOFT_WEBHOOK_TIMESTAMP_KEYS) {
    const value = timestampSignatureValue(payload[key])
    const parsed = parseWebhookTimestampValue(payload[key])
    if (value && parsed) return { date: parsed, value, source: 'payload', key }
  }

  for (const key of MINTSOFT_WEBHOOK_TIMESTAMP_HEADERS) {
    const headerValue = getHeaderValue(headers, key)
    const value = timestampSignatureValue(headerValue)
    const parsed = parseWebhookTimestampValue(headerValue)
    if (value && parsed) return { date: parsed, value, source: 'header', key }
  }

  return null
}

export function extractMintsoftWebhookTimestamp(
  payload: Record<string, unknown>,
  headers?: Headers | Record<string, string | undefined>,
): Date | null {
  return extractMintsoftWebhookTimestampCandidate(payload, headers)?.date ?? null
}

export function isMintsoftWebhookTimestampFresh(
  timestamp: Date,
  now: Date = new Date(),
): boolean {
  return Math.abs(now.getTime() - timestamp.getTime()) <= MAX_MINTSOFT_WEBHOOK_CLOCK_SKEW_MS
}
