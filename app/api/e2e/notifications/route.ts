import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { assertE2eRouteModuleEnabled, requireE2eAdminRoute } from '@/lib/testing/e2e-route-guard'

assertE2eRouteModuleEnabled('app/api/e2e/notifications/route.ts')

type SeedNotification = {
  userEmail?: string | null
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  actionUrl?: string | null
}

export async function POST(request: NextRequest) {
  const access = await requireE2eAdminRoute(request)
  if (access instanceof NextResponse) return access

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
