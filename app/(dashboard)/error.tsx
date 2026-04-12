'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function DashboardError({
  error,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  useEffect(() => {
    // Auth-related errors (session expired, JWT corrupt, etc.) → redirect to login
    // This prevents the generic "This page couldn't load" message
    const msg = error.message?.toLowerCase() ?? ''
    const isAuthError =
      msg.includes('unauthorized') ||
      msg.includes('unauthenticated') ||
      msg.includes('session') ||
      msg.includes('jwt') ||
      msg.includes('token') ||
      msg.includes('callback') ||
      msg.includes('auth')

    if (isAuthError) {
      router.replace('/login')
    }
  }, [error, router])

  // For non-auth errors, show a simple retry UI
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">
        An unexpected error occurred. Please try again.
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => router.replace('/login')}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
        >
          Go to Login
        </button>
        <button
          onClick={() => router.refresh()}
          className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
        >
          Try Again
        </button>
      </div>
    </div>
  )
}
