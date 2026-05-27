import type { Metadata } from 'next'
import { db } from '@/lib/db'
import { LoginForm } from '@/components/auth/login-form'
import { getTurnstileSiteKey, isTurnstileEnabled } from '@/lib/turnstile'
import {
  sessionInvalidLoginMessage,
  type SessionInvalidLoginReason,
} from '@/lib/auth/session-state'

export const metadata: Metadata = { title: 'Sign In' }
export const dynamic = 'force-dynamic'

type LoginPageProps = {
  searchParams: Promise<{ reason?: string | string[] }>
}

const LOGIN_REASONS = new Set<SessionInvalidLoginReason>([
  'account-deactivated',
  'session-expired',
  'signed-out',
])

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const org = await db.organisation.findFirst({ select: { name: true, logoUrl: true } })
  const companyName = org?.name || 'IMS'
  const turnstileSiteKey = isTurnstileEnabled() ? getTurnstileSiteKey() : null
  const rawReason = (await searchParams).reason
  const reason = typeof rawReason === 'string' && LOGIN_REASONS.has(rawReason as SessionInvalidLoginReason)
    ? rawReason as SessionInvalidLoginReason
    : null

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
        <h1 className="text-2xl font-semibold">One Two Inventory</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sign in to your account</p>
      </div>
      <LoginForm
        turnstileSiteKey={turnstileSiteKey}
        sessionMessage={sessionInvalidLoginMessage(reason)}
      />
    </div>
  )
}
