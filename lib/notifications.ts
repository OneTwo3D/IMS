import { db } from '@/lib/db'

type NotifyParams = {
  userId?: string | null
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  actionUrl?: string | null
}

/**
 * Create a notification. Call fire-and-forget (no await needed) in most cases.
 * If userId is null, the notification is a broadcast visible to all users.
 * Silently swallows errors to never break the caller.
 *
 * WHICH MEANS AWAITING IT PROVES NOTHING about whether the alert reached anybody. A caller for whom
 * the notification IS the durable record of a decision it has otherwise written nothing down for
 * must use notifyPersisted below, for the same reason logActivity has logActivityPersisted beside
 * it (o3d-clxw round 2).
 */
export async function notify(params: NotifyParams) {
  await notifyPersisted(params)
}

/**
 * notify, but REPORTS whether the notification actually reached the database.
 *
 * Same swallow-and-continue behaviour — it never throws — so it is a drop-in for notify; the
 * difference is that `false` lets the caller decline to act as though somebody has been alerted.
 */
export async function notifyPersisted(params: NotifyParams): Promise<boolean> {
  try {
    await db.notification.create({
      data: {
        userId: params.userId ?? null,
        type: params.type,
        title: params.title,
        message: params.message,
        actionUrl: params.actionUrl ?? null,
      },
    })
    return true
  } catch (e) {
    console.error('[notifications] Failed to create:', e)
    return false
  }
}
