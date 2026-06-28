import type { Metadata } from 'next'

import { db } from '@/lib/db'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'

export const metadata: Metadata = { title: 'Reset password' }
export const dynamic = 'force-dynamic'

export default async function ForgotPasswordPage() {
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
        <h1 className="text-2xl font-semibold">Reset your password</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your account email and we&apos;ll send you a reset link
        </p>
      </div>
      <ForgotPasswordForm />
    </div>
  )
}
