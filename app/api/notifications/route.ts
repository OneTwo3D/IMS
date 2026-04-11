import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'

// GET — fetch notifications for current user (+ broadcasts with per-user read state)
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id!

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

  // Unread count: all user-owned unread + broadcasts without a receipt.
  const [ownedUnread, totalBroadcasts, totalReceipts] = await Promise.all([
    db.notification.count({ where: { userId, read: false } }),
    db.notification.count({ where: { userId: null } }),
    db.notificationReadReceipt.count({ where: { userId } }),
  ])
  const unreadCount = ownedUnread + Math.max(0, totalBroadcasts - totalReceipts)

  return NextResponse.json({ notifications, unreadCount })
}

// PATCH — mark notification(s) as read for the current user
export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
    return NextResponse.json({ ok: true })
  }

  if (Array.isArray(body.ids) && body.ids.length > 0) {
    // Validate the requested IDs belong to this user or are broadcasts.
    const ids = body.ids.filter((x: unknown): x is string => typeof x === 'string')
    if (ids.length === 0) {
      return NextResponse.json({ error: 'Invalid ids' }, { status: 400 })
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
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Provide { ids: [...] } or { all: true }' }, { status: 400 })
}
