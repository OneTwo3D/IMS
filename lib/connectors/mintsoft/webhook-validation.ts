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
    const trimmed = value.trim()
    const numeric = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed) ? Number(trimmed) : null
    if (numeric != null && Number.isFinite(numeric)) {
      return parseWebhookTimestampValue(numeric)
    }

    const parsed = new Date(trimmed)
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
  // Internal tests and non-route callers may pass pre-normalized Date values.
  // JSON webhook request bodies never deserialize directly to Date instances.
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

function parseRawJsonTimestampValue(rawValue: string): string | null {
  const trimmed = rawValue.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null
    } catch {
      return null
    }
  }

  return /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed) ? trimmed : null
}

export function extractMintsoftWebhookTimestampCandidateFromRequest(
  rawBody: string,
  headers?: Headers | Record<string, string | undefined>,
): MintsoftWebhookTimestampCandidate | null {
  for (const key of MINTSOFT_WEBHOOK_TIMESTAMP_HEADERS) {
    const headerValue = getHeaderValue(headers, key)
    const value = timestampSignatureValue(headerValue)
    const parsed = parseWebhookTimestampValue(headerValue)
    if (value && parsed) return { date: parsed, value, source: 'header', key }
  }

  for (const key of MINTSOFT_WEBHOOK_TIMESTAMP_KEYS) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)`, 'i')
    const match = pattern.exec(rawBody)
    const value = match?.[1] ? parseRawJsonTimestampValue(match[1]) : null
    const parsed = value ? parseWebhookTimestampValue(value) : null
    if (value && parsed) return { date: parsed, value, source: 'payload', key }
  }

  return null
}

export function isMintsoftWebhookTimestampFresh(
  timestamp: Date,
  now: Date = new Date(),
): boolean {
  return Math.abs(now.getTime() - timestamp.getTime()) <= MAX_MINTSOFT_WEBHOOK_CLOCK_SKEW_MS
}
