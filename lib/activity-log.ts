import { db } from '@/lib/db'
import { auth } from '@/lib/auth'
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
}

/**
 * Log an activity. Always await to avoid concurrent-query warnings.
 * Silently swallows errors to never break the caller.
 */
export async function logActivity(params: LogParams) {
  try {
    let userId = params.userId ?? null
    if (!userId) {
      try {
        const session = await auth()
        userId = session?.user?.id ?? null
      } catch {
        // no session available (e.g. during login flow)
      }
    }

    await db.activityLog.create({
      data: {
        userId,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        action: params.action,
        tag: params.tag,
        level: params.level ?? 'INFO',
        description: params.description,
        metadata: params.metadata ? JSON.parse(JSON.stringify(params.metadata)) : undefined,
      },
    })
  } catch (e) {
    // Never let logging break the caller
    console.error('[activity-log] Failed to write:', e)
  }
}
