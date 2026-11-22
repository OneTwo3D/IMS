import { db } from '@/lib/db'
import { CURRENT_RELEASE } from '@/lib/releases'

// The "What's New" notification for the current release. The release notes themselves are data in
// lib/releases.ts.

export function getReleaseNotificationId(version: string): string {
  return `release-${version.replace(/\./g, '-')}`
}

type ReleaseNotificationData = {
  id: string
  userId: string | null
  type: string
  title: string
  message: string
  actionUrl: string | null
}

type ReleaseNotificationStore = {
  createMany(args: { data: ReleaseNotificationData[]; skipDuplicates: boolean }): Promise<{ count: number }>
  findUnique(args: {
    where: { id: string }
    select: Record<keyof Omit<ReleaseNotificationData, 'id'>, true>
  }): Promise<Omit<ReleaseNotificationData, 'id'> | null>
  update(args: {
    where: { id: string }
    data: Omit<ReleaseNotificationData, 'id'>
  }): Promise<unknown>
}

function releaseNotificationHasDrift(
  existing: Omit<ReleaseNotificationData, 'id'>,
  desired: Omit<ReleaseNotificationData, 'id'>,
): boolean {
  return existing.userId !== desired.userId
    || existing.type !== desired.type
    || existing.title !== desired.title
    || existing.message !== desired.message
    || existing.actionUrl !== desired.actionUrl
}

export async function ensureCurrentReleaseNotificationInStore(
  notificationStore: ReleaseNotificationStore,
): Promise<void> {
  const release = CURRENT_RELEASE
  const id = getReleaseNotificationId(release.version)
  const title = `What's New in ${release.version}`
  const actionUrl = '/help/releases'
  const desired = {
    id,
    userId: null,
    type: 'info',
    title,
    message: release.userMessage,
    actionUrl,
  }

  const created = await notificationStore.createMany({
    data: [desired],
    skipDuplicates: true,
  })
  if (created.count > 0) return

  const existing = await notificationStore.findUnique({
    where: { id },
    select: {
      userId: true,
      type: true,
      title: true,
      message: true,
      actionUrl: true,
    },
  })

  if (!existing) return

  const desiredUpdate = {
    userId: desired.userId,
    type: desired.type,
    title: desired.title,
    message: desired.message,
    actionUrl: desired.actionUrl,
  }

  if (releaseNotificationHasDrift(existing, desiredUpdate)) {
    await notificationStore.update({
      where: { id },
      data: desiredUpdate,
    })
  }
}

export async function ensureCurrentReleaseNotification(): Promise<void> {
  await ensureCurrentReleaseNotificationInStore(db.notification)
}
