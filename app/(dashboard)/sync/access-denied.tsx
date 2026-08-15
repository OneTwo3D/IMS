import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button-variants'

/**
 * o3d-osl8 round 4, finding 2 — the page-boundary denial, PRESENTED.
 *
 * The Integrations page requires `sync`. Letting that denial escape the server component sent the
 * reader to app/(dashboard)/error.tsx, which knows nothing about authorization: it renders
 * "Something went wrong — an unexpected error occurred" with a Go to Login and a Try Again button.
 * Neither can ever resolve a stable role denial (signing in again produces the same role, and the
 * retry re-runs the same gate), and in production the error's message is reduced to a digest, so
 * the boundary cannot even tell the two apart after the fact. An entitlement failure was being
 * reported as a crash and answered with two dead ends.
 *
 * So it is answered HERE, before crossing the RSC boundary, and answered as what it is.
 *
 * Deliberately NOT a redirect. The pre-gate page sent a reader with no integration plugin enabled
 * to /settings/system?tab=plugins; for a role that may not see Integrations that is a tour of
 * somewhere else it probably may not act on either, and it hides the reason. This states the
 * reason and offers the one destination every authenticated role can reach.
 *
 * This is ONLY for the page's own gate. A denial raised by one of the page's reads still takes the
 * whole page down (see isFatal in page.tsx): that means a read demands more than the page does,
 * which is a wiring bug to surface, not a state to render prettily.
 */
export function SyncAccessDenied() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <ShieldAlert className="h-8 w-8 text-muted-foreground" aria-hidden />
      <h1 className="text-lg font-semibold">You don&apos;t have access to Integrations</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        This page requires the <span className="font-medium">sync</span> permission, which your role
        does not have. Signing in again or reloading will not change that — ask an administrator if
        you need access.
      </p>
      <Link href="/dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        Back to dashboard
      </Link>
    </div>
  )
}
