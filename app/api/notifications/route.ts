import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { ensureCurrentReleaseNotification } from '@/lib/releases'

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  headers.set('Cache-Control', 'no-store')
  return NextResponse.json(body, { ...init, headers })
}

// GET — fetch notifications for current user (+ broadcasts with per-user read state)
export async function GET() {
  const session = await auth()
  if (!session?.user) return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id!

  await ensureCurrentReleaseNotification()

  // Load both user-owned and broadcast rows (latest 50).
  const rows = await db.notification.findMany({
    where: { OR: [{ userId }, { userId: null }] },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  // Find which of those rows are broadcasts and look up this user's receipts.
  const broadcastIds = rows.filter(r => r.userId === null).map(r => r.id)
  const receipts = broadcastIds.length
    ? await db.notificationReadReceipt.findMany({
        where: { userId, notificationId: { in: broadcastIds } },
        select: { notificationId: true },
      })
    : []
  const receiptSet = new Set(receipts.map(r => r.notificationId))

  // Compute per-user `read` — for broadcasts read = a receipt exists,
  // for user-owned rows use the row's own read flag.
  const notifications = rows.map(r =>
    r.userId === null ? { ...r, read: receiptSet.has(r.id) } : r,
  )

  // Unread count: all user-owned unread + broadcasts this user has not acknowledged.
  const [ownedUnread, broadcastUnread] = await Promise.all([
    db.notification.count({ where: { userId, read: false } }),
    db.notification.count({
      where: {
        userId: null,
        readReceipts: { none: { userId } },
      },
    }),
  ])
  const unreadCount = ownedUnread + broadcastUnread

  return jsonNoStore({ notifications, unreadCount })
}

// PATCH — mark notification(s) as read for the current user
export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id!
  const body = await req.json()

  if (body.all === true) {
    // Mark every user-owned notification as read.
    await db.notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    })
    // Insert a receipt for every broadcast that has no receipt yet.
    const broadcasts = await db.notification.findMany({
      where: { userId: null },
      select: { id: true },
    })
    if (broadcasts.length > 0) {
      await db.notificationReadReceipt.createMany({
        data: broadcasts.map(b => ({ notificationId: b.id, userId })),
        skipDuplicates: true,
      })
    }
    return jsonNoStore({ ok: true })
  }

  if (Array.isArray(body.ids) && body.ids.length > 0) {
    // Validate the requested IDs belong to this user or are broadcasts.
    const ids = body.ids.filter((x: unknown): x is string => typeof x === 'string')
    if (ids.length === 0) {
      return jsonNoStore({ error: 'Invalid ids' }, { status: 400 })
    }
    const rows = await db.notification.findMany({
      where: { id: { in: ids }, OR: [{ userId }, { userId: null }] },
      select: { id: true, userId: true },
    })
    const ownedIds = rows.filter(r => r.userId === userId).map(r => r.id)
    const broadcastIds = rows.filter(r => r.userId === null).map(r => r.id)

    if (ownedIds.length > 0) {
      await db.notification.updateMany({
        where: { id: { in: ownedIds }, userId, read: false },
        data: { read: true, readAt: new Date() },
      })
    }
    if (broadcastIds.length > 0) {
      await db.notificationReadReceipt.createMany({
        data: broadcastIds.map(id => ({ notificationId: id, userId })),
        skipDuplicates: true,
      })
    }
    return jsonNoStore({ ok: true })
  }

  return jsonNoStore({ error: 'Provide { ids: [...] } or { all: true }' }, { status: 400 })
}
