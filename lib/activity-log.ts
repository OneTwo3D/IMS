import { db } from '@/lib/db'
import { auth } from '@/lib/auth'
import { cache } from 'react'
import type { ActivityEntityType, ActivityLogLevel } from '@/app/generated/prisma/client'

type LogParams = {
  entityType: ActivityEntityType
  entityId?: string | null
  action: string
  tag: string
  level?: ActivityLogLevel
  description: string
  metadata?: object | null
  userId?: string | null // override — useful when session isn't available (e.g. login)
  resolveUser?: boolean
}

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const REDACTED_VALUE = '[redacted]'
const SENSITIVE_METADATA_KEY = /(email|address|line1|line2|postcode|postCode|zip|phone|vat|taxId|customerEmail|supplierEmail|recipientEmail)/i
const SECRET_METADATA_KEY = /(password|passphrase|secret|token|apiKey|api_key|authorization|bearer|consumerSecret|consumer_secret|clientSecret|client_secret|refreshToken|refresh_token|accessToken|access_token|privateKey|private_key)/i
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const KEY_VALUE_SECRET_PATTERN = /\b(password|passphrase|secret|token|api[_-]?key|authorization|consumer[_-]?secret|client[_-]?secret|refresh[_-]?token|access[_-]?token|private[_-]?key)(\s*[:=]\s*)(["']?)[^"',&\s;)]+/gi
const URL_SECRET_QUERY_PATTERN = /([?&](?:password|passphrase|secret|token|api[_-]?key|authorization|consumer[_-]?secret|client[_-]?secret|refresh[_-]?token|access[_-]?token|private[_-]?key)=)[^&#\s]+/gi

const getCachedSession = cache(async () => {
  try {
    return await auth()
  } catch {
    return null
  }
})

export function redactActivityLogText(value: string): string {
  return value
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(URL_SECRET_QUERY_PATTERN, '$1[redacted]')
    .replace(KEY_VALUE_SECRET_PATTERN, (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`)
}

export function sanitizeActivityLogMetadata(value: unknown, key?: string): unknown {
  if (value == null) return value
  if (key && SECRET_METADATA_KEY.test(key)) return REDACTED_VALUE
  if (key && SENSITIVE_METADATA_KEY.test(key)) return REDACTED_VALUE
  if (typeof value === 'string') return redactActivityLogText(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeActivityLogMetadata(item))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, sanitizeActivityLogMetadata(childValue, childKey)]),
    )
  }
  return value
}

/**
 * Log an activity. Always await to avoid concurrent-query warnings.
 * Silently swallows errors to never break the caller.
 */
export async function logActivity(params: LogParams) {
  try {
    let userId = params.userId ?? null
    if (!userId && params.resolveUser !== false) {
      const session = await getCachedSession()
      userId = session?.user?.id ?? null
    }

    await db.activityLog.create({
      data: {
        userId,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        action: params.action,
        tag: params.tag,
        level: params.level ?? 'INFO',
        description: redactActivityLogText(params.description),
        metadata: params.metadata ? JSON.parse(JSON.stringify(sanitizeActivityLogMetadata(params.metadata))) : undefined,
      },
    })
  } catch (e) {
    // Never let logging break the caller
    console.error('[activity-log] Failed to write:', e)
  }
}
