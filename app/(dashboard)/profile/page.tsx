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
      <div>
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your account, security, and profile picture.
        </p>
      </div>

      <ProfileForm user={user} />

      <TotpSetup enabled={user.totpEnabled} />
    </div>
  )
}
