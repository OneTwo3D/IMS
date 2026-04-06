import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/auth/server'
import { getUsers } from '@/app/actions/users'
import { getSuppliers } from '@/app/actions/suppliers'
import { UsersClient } from './users-client'

export const metadata: Metadata = { title: 'User Management' }

export default async function UsersPage() {
  const session = await requireAuth()
  if (session.user.role !== 'ADMIN') redirect('/dashboard')

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
