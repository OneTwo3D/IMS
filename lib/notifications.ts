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
 * Swallows errors to never break the caller — and RETURNS whether the row was
 * actually written, so a caller that treats the bell as the thing an operator
 * will be told by can tell the difference (o3d-xnwu round 3, finding 4).
 *
 * Nearly every caller ignores the result on purpose: a notification is a
 * courtesy alongside some other durable record. The one place it is not is a
 * bell that is deduplicated FOREVER after the first attempt — there, "it threw
 * and we carried on" means nobody is ever told.
 */
export async function notify(params: NotifyParams): Promise<boolean> {
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
