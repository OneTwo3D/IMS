import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button-variants'

/**
 * Rendered at a page boundary when the signed-in principal lacks the required
 * permission (o3d-512h).
 *
 * A permission denial is stable for this session, so this deliberately offers
 * neither "Try Again" nor "Go to Login" — the two actions app/(dashboard)/error.tsx
 * offers, both of which are dead ends for a role that simply is not allowed in.
 * Server Component: no interactivity, so the denial cannot be dismissed client-side.
 */
export function AccessDenied({ permission }: { permission: string }) {
  return (
    <div
      className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-8 text-center"
      data-testid="access-denied"
      data-required-permission={permission}
    >
      <ShieldAlert className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-lg font-semibold">Access denied</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Your role does not include the{' '}
        <code className="text-xs">{permission}</code> permission, which is required to
        view this page. Ask an administrator if you need access.
      </p>
      <Link href="/dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        Back to dashboard
      </Link>
    </div>
  )
}
