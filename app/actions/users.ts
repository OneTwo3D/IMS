'use server'

import { revalidatePath } from 'next/cache'
import { hash } from 'bcryptjs'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin, requirePermission } from '@/lib/auth/server'

const VALID_ROLES = ['ADMIN', 'MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER'] as const
type ValidRole = typeof VALID_ROLES[number]

export type UserRow = {
  id: string
  name: string
  email: string
  role: string
  supplierId: string | null
  supplierName: string | null
  active: boolean
  totpEnabled: boolean
  lastLoginAt: string | null
  createdAt: string
}

export async function getUsers(): Promise<UserRow[]> {
  try {
    await requireAdmin()
  } catch {
    return []
  }

  const users = await db.user.findMany({
    select: {
      id: true, name: true, email: true, role: true,
      supplierId: true, supplier: { select: { name: true } },
      active: true, totpEnabled: true, lastLoginAt: true, createdAt: true,
    },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  })

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    supplierId: u.supplierId,
    supplierName: u.supplier?.name ?? null,
    active: u.active,
    totpEnabled: u.totpEnabled,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  }))
}

export async function createUser(data: {
  name: string
  email: string
  password: string
  role: string
  supplierId?: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin()
    await requirePermission('settings.users')

    if (!data.name?.trim()) return { success: false, error: 'Name is required' }
    if (!data.email?.trim()) return { success: false, error: 'Email is required' }
    if (!data.password || data.password.length < 8) return { success: false, error: 'Password must be at least 8 characters' }
    if (!VALID_ROLES.includes(data.role as ValidRole)) return { success: false, error: 'Invalid role' }

    const existing = await db.user.findUnique({ where: { email: data.email.trim().toLowerCase() } })
    if (existing) return { success: false, error: 'Email already in use' }

    const passwordHash = await hash(data.password, 12)
    await db.user.create({
      data: {
        name: data.name.trim(),
        email: data.email.trim().toLowerCase(),
        passwordHash,
        role: data.role as never,
        supplierId: data.role === 'SUPPLIER' && data.supplierId ? data.supplierId : null,
      },
    })

    revalidatePath('/settings/users')
    await logActivity({
      entityType: 'USER', action: 'created', tag: 'auth', level: 'INFO',
      description: `Created user ${data.name} (${data.email}) with role ${data.role}`,
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function updateUser(
  userId: string,
  data: { name?: string; email?: string; role?: string; supplierId?: string | null; active?: boolean; password?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await requireAdmin()
    await requirePermission('settings.users')

    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, active: true },
    })
    if (!target) return { success: false, error: 'User not found' }

    // Validate role if changing
    if (data.role !== undefined && !VALID_ROLES.includes(data.role as ValidRole)) {
      return { success: false, error: 'Invalid role' }
    }

    // Prevent lockout: you can't demote yourself out of ADMIN
    if (userId === session.user.id && data.role !== undefined && data.role !== 'ADMIN') {
      return { success: false, error: 'You cannot change your own role away from ADMIN' }
    }
    // Prevent lockout: you can't deactivate yourself
    if (userId === session.user.id && data.active === false) {
      return { success: false, error: 'You cannot deactivate your own account' }
    }

    // Prevent demoting the last active ADMIN
    const demotingAdmin =
      target.role === 'ADMIN' && data.role !== undefined && data.role !== 'ADMIN'
    const deactivatingAdmin =
      target.role === 'ADMIN' && data.active === false
    if (demotingAdmin || deactivatingAdmin) {
      const adminCount = await db.user.count({ where: { role: 'ADMIN', active: true } })
      if (adminCount <= 1) {
        return { success: false, error: 'At least one active ADMIN must remain' }
      }
    }

    const updateData: Record<string, unknown> = {}
    if (data.name !== undefined) updateData.name = data.name.trim()
    if (data.email !== undefined) updateData.email = data.email.trim().toLowerCase()
    if (data.role !== undefined) updateData.role = data.role
    if (data.supplierId !== undefined) updateData.supplierId = data.role === 'SUPPLIER' && data.supplierId ? data.supplierId : null
    if (data.active !== undefined) updateData.active = data.active
    if (data.password && data.password.length >= 8) {
      updateData.passwordHash = await hash(data.password, 12)
    }

    await db.user.update({ where: { id: userId }, data: updateData })

    revalidatePath('/settings/users')
    await logActivity({
      entityType: 'USER', entityId: userId, action: 'updated', tag: 'auth', level: 'INFO',
      description: `Updated user ${data.name ?? userId}`,
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
