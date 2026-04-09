import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'

// GET — fetch notifications for current user (+ broadcasts)
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id!

  const [notifications, unreadCount] = await Promise.all([
    db.notification.findMany({
      where: { OR: [{ userId }, { userId: null }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    db.notification.count({
      where: { OR: [{ userId }, { userId: null }], read: false },
    }),
  ])

  return NextResponse.json({ notifications, unreadCount })
}

// PATCH — mark notification(s) as read
export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id!
  const body = await req.json()

  if (body.all === true) {
    await db.notification.updateMany({
      where: { OR: [{ userId }, { userId: null }], read: false },
      data: { read: true, readAt: new Date() },
    })
  } else if (Array.isArray(body.ids) && body.ids.length > 0) {
    await db.notification.updateMany({
      where: {
        id: { in: body.ids },
        OR: [{ userId }, { userId: null }],
      },
      data: { read: true, readAt: new Date() },
    })
  } else {
    return NextResponse.json({ error: 'Provide { ids: [...] } or { all: true }' }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
