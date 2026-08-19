import type { Metadata } from 'next'
import { authorizePage } from '@/lib/auth/server'
import { AccessDenied } from '@/components/auth/access-denied'
import { getUsers } from '@/app/actions/users'
import { getSuppliers } from '@/app/actions/suppliers'
import { UsersClient } from './users-client'

export const metadata: Metadata = { title: 'User Management' }

export default async function UsersPage() {
  // o3d-512h: was `role !== 'ADMIN' -> redirect('/dashboard')`. Two changes:
  // it now checks the PERMISSION rather than the role (so the matrix in
  // lib/permissions.ts stays the single source of truth), and it renders an
  // explicit denial instead of bouncing to /dashboard, which is indistinguishable
  // from the page not existing.
  const gate = await authorizePage('settings.users')
  if (!gate.authorized) return <AccessDenied permission={gate.permission} />

  const [users, suppliers] = await Promise.all([
    getUsers(),
    getSuppliers(),
  ])

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">User Management</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage users, roles, and access rights.</p>
      </div>
      <UsersClient users={users} suppliers={suppliers} />
    </div>
  )
}
