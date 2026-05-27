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

async function anotherActiveAdminExists(excludingUserId: string): Promise<boolean> {
  const adminCount = await db.user.count({
    where: {
      role: 'ADMIN',
      active: true,
      id: { not: excludingUserId },
    },
  })
  return adminCount > 0
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
      select: { id: true, name: true, email: true, role: true, supplierId: true, active: true },
    })
    if (!target) return { success: false, error: 'User not found' }

    const nextName = data.name?.trim()
    const nextEmail = data.email?.trim().toLowerCase()

    if (data.name !== undefined && !nextName) return { success: false, error: 'Name is required' }
    if (data.email !== undefined && !nextEmail) return { success: false, error: 'Email is required' }

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
    const demotingAdmin = target.role === 'ADMIN' && data.role !== undefined && data.role !== 'ADMIN'
    const deactivatingAdmin = target.role === 'ADMIN' && data.active === false
    if ((demotingAdmin || deactivatingAdmin) && !await anotherActiveAdminExists(userId)) {
      return { success: false, error: 'At least one active ADMIN must remain' }
    }

    const updateData: Record<string, unknown> = {}
    if (nextName !== undefined) updateData.name = nextName
    if (nextEmail !== undefined) updateData.email = nextEmail
    if (data.role !== undefined) updateData.role = data.role
    if (data.supplierId !== undefined) updateData.supplierId = data.role === 'SUPPLIER' && data.supplierId ? data.supplierId : null
    if (data.active !== undefined) updateData.active = data.active
    if (data.password && data.password.length >= 8) {
      updateData.passwordHash = await hash(data.password, 12)
    }
    const roleChanged = data.role !== undefined && data.role !== target.role
    const emailChanged = nextEmail !== undefined && nextEmail !== target.email
    const activeChanged = data.active !== undefined && data.active !== target.active
    const supplierChanged = data.supplierId !== undefined && data.supplierId !== target.supplierId
    const passwordChanged = Boolean(data.password && data.password.length >= 8)
    if (roleChanged || emailChanged || activeChanged || supplierChanged || passwordChanged) {
      updateData.sessionVersion = { increment: 1 }
      if (data.active === false) updateData.forceLogoutAt = new Date()
      if (data.active === true) updateData.forceLogoutAt = null
    }

    await db.$transaction(async (tx) => {
      if (nextName && nextName !== target.name) {
        await tx.salesOrder.updateMany({
          where: { salesRep: target.name },
          data: { salesRep: nextName },
        })
      }

      await tx.user.update({ where: { id: userId }, data: updateData })
    })

    revalidatePath('/settings/users')
    if (nextName && nextName !== target.name) {
      revalidatePath('/sales')
      revalidatePath('/analytics/sales-stats')
    }
    await logActivity({
      entityType: 'USER', entityId: userId, action: 'updated', tag: 'auth', level: 'INFO',
      description: `Updated user ${data.name ?? userId}`,
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function deleteUser(
  userId: string,
  options: {
    salesOrderMode: 'keep_text' | 'transfer_user'
    transferToUserId?: string | null
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await requireAdmin()
    await requirePermission('settings.users')

    if (!['keep_text', 'transfer_user'].includes(options.salesOrderMode)) {
      return { success: false, error: 'Invalid sales order handling option' }
    }
    if (userId === session.user.id) return { success: false, error: 'You cannot delete your own account' }

    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, active: true },
    })

    if (!target) return { success: false, error: 'User not found' }

    if (target.role === 'ADMIN' && target.active && !await anotherActiveAdminExists(userId)) {
      return { success: false, error: 'At least one active ADMIN must remain' }
    }

    let transferTo: { id: string; name: string; email: string; active: boolean } | null = null
    if (options.salesOrderMode === 'transfer_user') {
      if (!options.transferToUserId) return { success: false, error: 'Select a user to transfer sales orders to' }
      if (options.transferToUserId === userId) {
        return { success: false, error: 'Choose a different user to transfer sales orders to' }
      }

      transferTo = await db.user.findUnique({
        where: { id: options.transferToUserId },
        select: { id: true, name: true, email: true, active: true },
      })
      if (!transferTo) return { success: false, error: 'Transfer user not found' }
      if (!transferTo.active) return { success: false, error: 'Transfer user must be active' }
    }

    const transferredSalesOrders = await db.$transaction(async (tx) => {
      const transferResult = options.salesOrderMode === 'transfer_user' && transferTo && target.name
        ? await tx.salesOrder.updateMany({
          where: { salesRep: target.name },
          data: { salesRep: transferTo.name },
        })
        : { count: 0 }

      await tx.user.delete({ where: { id: userId } })
      return transferResult.count
    })

    revalidatePath('/settings/users')
    revalidatePath('/sales')
    revalidatePath('/analytics/sales-stats')
    await logActivity({
      entityType: 'USER',
      entityId: userId,
      action: 'deleted',
      tag: 'auth',
      level: 'WARNING',
      description: options.salesOrderMode === 'transfer_user' && transferTo
        ? `Deleted user ${target.name} (${target.email}) and transferred ${transferredSalesOrders} sales order(s) to ${transferTo.name}`
        : `Deleted user ${target.name} (${target.email}) and kept their name on existing sales orders`,
      metadata: {
        salesOrderMode: options.salesOrderMode,
        transferredSalesOrders,
        transferToUserId: transferTo?.id ?? null,
        transferToName: transferTo?.name ?? null,
      },
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
