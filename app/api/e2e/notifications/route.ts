import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'

type SeedNotification = {
  userEmail?: string | null
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  actionUrl?: string | null
}

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const session = await auth()
  if (!session?.user?.id || (session.user as { role?: string }).role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json() as {
    clearForUserEmail?: string
    notifications?: SeedNotification[]
  }

  if (body.clearForUserEmail) {
    const user = await db.user.findUnique({
      where: { email: body.clearForUserEmail },
      select: { id: true },
    })
    if (user) {
      await db.notificationReadReceipt.deleteMany({ where: { userId: user.id } })
      await db.notification.deleteMany({ where: { OR: [{ userId: user.id }, { userId: null }] } })
    }
  }

  const notifications = body.notifications ?? []
  for (const notification of notifications) {
    const user = notification.userEmail
      ? await db.user.findUnique({
          where: { email: notification.userEmail },
          select: { id: true },
        })
      : null

    await db.notification.create({
      data: {
        userId: user?.id ?? null,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        actionUrl: notification.actionUrl ?? null,
      },
    })
  }

  return NextResponse.json({ success: true })
}
