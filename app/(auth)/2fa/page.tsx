import type { Metadata } from 'next'
import { TotpForm } from '@/components/auth/totp-form'

export const metadata: Metadata = { title: 'Two-Factor Authentication' }

export default function TwoFactorPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
          12
        </div>
        <h1 className="text-2xl font-semibold">Two-factor authentication</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the 6-digit code from your authenticator app
        </p>
      </div>
      <TotpForm />
    </div>
  )
}
