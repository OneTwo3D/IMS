import { AccessDenied } from '@/components/auth/access-denied'
import { authorizePage } from '@/lib/auth/server'
import type { Metadata } from 'next'
import { ReleaseNotes } from '@/components/releases/release-notes'

export const metadata: Metadata = { title: "What's New" }

/**
 * Read-only release notes for every role that can use Help (the What's New notification is broadcast to all users,
 * but /settings/system is admin-only). Operator actions stay on the admin settings surface; this page changes nothing.
 */
export default async function ReleasesPage() {
  const gate = await authorizePage('help')
  if (!gate.authorized) return <AccessDenied permission={gate.permission} />

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">What&apos;s New</h1>
      <ReleaseNotes />
    </div>
  )
}
