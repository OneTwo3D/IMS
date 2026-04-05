import type { Metadata } from 'next'
import { requireAuth } from '@/lib/auth/server'
import { TotpSetup } from '@/components/auth/totp-setup'

export const metadata: Metadata = { title: 'Profile' }

export default async function ProfilePage() {
  const session = await requireAuth()

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your account and security settings.
        </p>
      </div>

      <div className="rounded-lg border p-6 space-y-4">
        <h2 className="font-semibold">Account</h2>
        <div className="grid gap-1 text-sm">
          <div className="flex justify-between py-2 border-b">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">{session.user.name}</span>
          </div>
          <div className="flex justify-between py-2 border-b">
            <span className="text-muted-foreground">Email</span>
            <span className="font-medium">{session.user.email}</span>
          </div>
          <div className="flex justify-between py-2">
            <span className="text-muted-foreground">Role</span>
            <span className="font-medium capitalize">{session.user.role.toLowerCase()}</span>
          </div>
        </div>
      </div>

      <TotpSetup enabled={session.user.totpEnabled} />
    </div>
  )
}
