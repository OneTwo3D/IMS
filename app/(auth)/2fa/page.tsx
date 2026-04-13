import type { Metadata } from 'next'
import { db } from '@/lib/db'
import { TotpForm } from '@/components/auth/totp-form'

export const metadata: Metadata = { title: 'Two-Factor Authentication' }
export const dynamic = 'force-dynamic'

export default async function TwoFactorPage() {
  const org = await db.organisation.findFirst({ select: { name: true, logoUrl: true } })
  const companyName = org?.name || 'IMS'

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        {org?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logoUrl} alt="" className="mx-auto mb-4 h-10 w-10 rounded-lg object-contain" />
        ) : (
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
            {companyName.slice(0, 2).toUpperCase()}
          </div>
        )}
        <h1 className="text-2xl font-semibold">Two-factor authentication</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the 6-digit code from your authenticator app
        </p>
      </div>
      <TotpForm />
    </div>
  )
}
