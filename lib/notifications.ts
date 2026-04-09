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
 */
export async function notify(params: NotifyParams) {
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
  } catch (e) {
    console.error('[notifications] Failed to create:', e)
  }
}
