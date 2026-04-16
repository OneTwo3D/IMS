import { db } from '@/lib/db'

export type AppRelease = {
  version: string
  date: string
  title: string
  summary: string
  userMessage: string
  userHighlights: string[]
  technicalHighlights: string[]
}

export const RELEASES: AppRelease[] = [
  {
    version: '1.1',
    date: '2026-04-16',
    title: 'Visible app version in System Settings',
    summary: 'Added the current release number directly to the System Settings header for faster support and deployment verification.',
    userMessage: 'System Settings now shows the current app version directly in the page header.',
    userHighlights: [
      'Added a visible version badge to the System Settings header.',
      'Kept the Releases tab as the place for fuller release history and notes.',
    ],
    technicalHighlights: [
      'Bumped the application release to 1.1 and recorded it in the repo changelog.',
    ],
  },
  {
    version: '1.0',
    date: '2026-04-16',
    title: 'Release tracking and operational hardening',
    summary: 'Introduced repo-backed release versioning, user-visible release notes, deployment hardening, and health checks.',
    userMessage: 'New product profitability analytics are live, login protection has been tightened with Turnstile, and the app now shows release updates directly in the UI.',
    userHighlights: [
      'Added the Product Profitability analytics view.',
      'Added Turnstile protection to password login.',
      'Added in-app release notifications and a release history view in System Settings.',
    ],
    technicalHighlights: [
      'Added connector groundwork for Shopify and QuickBooks, including multi-connector shopping foundations.',
      'Hardened install and update scripts for git-based deployments, Prisma generation, and webhook routing.',
      'Added a real /api/health endpoint for deployment checks.',
    ],
  },
]

export const CURRENT_RELEASE = RELEASES[0]

export function getReleaseNotificationId(version: string): string {
  return `release-${version.replace(/\./g, '-')}`
}

export async function ensureCurrentReleaseNotification(): Promise<void> {
  const release = CURRENT_RELEASE
  const id = getReleaseNotificationId(release.version)
  const title = `What's New in ${release.version}`
  const actionUrl = '/settings/system?tab=releases'
  const existing = await db.notification.findUnique({ where: { id } })

  if (!existing) {
    await db.notification.create({
      data: {
        id,
        userId: null,
        type: 'info',
        title,
        message: release.userMessage,
        actionUrl,
      },
    })
    return
  }

  if (
    existing.userId !== null ||
    existing.type !== 'info' ||
    existing.title !== title ||
    existing.message !== release.userMessage ||
    existing.actionUrl !== actionUrl
  ) {
    await db.notification.update({
      where: { id },
      data: {
        userId: null,
        type: 'info',
        title,
        message: release.userMessage,
        actionUrl,
      },
    })
  }
}
