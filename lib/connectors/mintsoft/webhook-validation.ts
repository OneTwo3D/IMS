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

export function extractMintsoftWebhookTimestamp(
  payload: Record<string, unknown>,
  headers?: Headers | Record<string, string | undefined>,
): Date | null {
  for (const key of MINTSOFT_WEBHOOK_TIMESTAMP_KEYS) {
    const parsed = parseWebhookTimestampValue(payload[key])
    if (parsed) return parsed
  }

  for (const key of MINTSOFT_WEBHOOK_TIMESTAMP_HEADERS) {
    const parsed = parseWebhookTimestampValue(getHeaderValue(headers, key))
    if (parsed) return parsed
  }

  return null
}

export function isMintsoftWebhookTimestampFresh(
  timestamp: Date,
  now: Date = new Date(),
): boolean {
  return Math.abs(now.getTime() - timestamp.getTime()) <= MAX_MINTSOFT_WEBHOOK_CLOCK_SKEW_MS
}
