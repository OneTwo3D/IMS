const MAX_MINTSOFT_WEBHOOK_CLOCK_SKEW_MS = 10 * 60 * 1000

const MINTSOFT_WEBHOOK_TIMESTAMP_KEYS = [
  'timestamp',
  'eventTime',
  'occurredAt',
  'createdAt',
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

export function extractMintsoftWebhookTimestamp(payload: Record<string, unknown>): Date | null {
  for (const key of MINTSOFT_WEBHOOK_TIMESTAMP_KEYS) {
    const parsed = parseWebhookTimestampValue(payload[key])
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

