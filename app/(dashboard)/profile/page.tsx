import type { Metadata } from 'next'
import { getProfileData } from '@/app/actions/profile'
import { ProfileForm } from '@/components/profile/profile-form'
import { TotpSetup } from '@/components/auth/totp-setup'

export const metadata: Metadata = { title: 'Profile' }

export default async function ProfilePage() {
  const user = await getProfileData()
  if (!user) return null

  return (
    <div className="max-w-2xl space-y-6">
      {/* Sticky header keeps the title and Save action visible while scrolling */}
      <div className="sticky top-0 z-10 -mx-3 sm:-mx-4 md:-mx-6 flex items-start justify-between gap-3 border-b bg-background/95 px-3 sm:px-4 md:px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-2xl font-semibold">Profile</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your account, security, and profile picture.
          </p>
        </div>
        {/* Save (portaled here from ProfileForm) sits top-right, matching the product page */}
        <div id="profile-actions" className="flex items-center gap-3" />
      </div>

      <ProfileForm user={user} />

      <TotpSetup enabled={user.totpEnabled} />
    </div>
  )
}
