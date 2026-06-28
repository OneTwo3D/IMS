import type { Metadata } from 'next'

import { db } from '@/lib/db'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'

export const metadata: Metadata = { title: 'Choose a new password' }
export const dynamic = 'force-dynamic'

type ResetPasswordPageProps = {
  searchParams: Promise<{ token?: string | string[] }>
}

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const org = await db.organisation.findFirst({ select: { name: true, logoUrl: true } })
  const companyName = org?.name || 'IMS'
  const rawToken = (await searchParams).token
  const token = typeof rawToken === 'string' ? rawToken : ''

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        {org?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={org.logoUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="mx-auto mb-4 h-10 w-10 rounded-lg object-contain"
          />
        ) : (
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
            {companyName.slice(0, 2).toUpperCase()}
          </div>
        )}
        <h1 className="text-2xl font-semibold">Choose a new password</h1>
        <p className="mt-1 text-sm text-muted-foreground">Set a new password for your account</p>
      </div>
      <ResetPasswordForm token={token} />
    </div>
  )
}
