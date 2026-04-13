'use server'

import { revalidatePath } from 'next/cache'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'

export async function updateProfile(data: { name: string; email: string }): Promise<{ success: boolean; error?: string }> {
  const session = await requireAuth()
  const userId = session.user.id

  if (!data.name.trim()) return { success: false, error: 'Name is required' }
  if (!data.email.trim()) return { success: false, error: 'Email is required' }

  // Check email uniqueness
  const existing = await db.user.findUnique({ where: { email: data.email } })
  if (existing && existing.id !== userId) return { success: false, error: 'Email already in use' }

  await db.user.update({ where: { id: userId }, data: { name: data.name.trim(), email: data.email.trim().toLowerCase() } })
  revalidatePath('/profile')
  await logActivity({ entityType: 'USER', entityId: userId, tag: 'auth', action: 'updated', description: 'Updated profile' })
  return { success: true }
}

export async function changePassword(data: { currentPassword: string; newPassword: string }): Promise<{ success: boolean; error?: string }> {
  const session = await requireAuth()
  const userId = session.user.id

  if (!data.newPassword || data.newPassword.length < 8) return { success: false, error: 'New password must be at least 8 characters' }

  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
  if (!user) return { success: false, error: 'User not found' }

  const match = await bcrypt.compare(data.currentPassword, user.passwordHash)
  if (!match) return { success: false, error: 'Current password is incorrect' }

  const passwordHash = await bcrypt.hash(data.newPassword, 12)
  await db.user.update({ where: { id: userId }, data: { passwordHash } })
  await logActivity({ entityType: 'USER', entityId: userId, tag: 'auth', action: 'password_changed', description: 'Changed password' })
  return { success: true }
}

export async function updatePictureUrl(pictureUrl: string | null): Promise<{ success: boolean }> {
  const session = await requireAuth()
  await db.user.update({ where: { id: session.user.id }, data: { pictureUrl } })
  revalidatePath('/profile')
  await logActivity({ entityType: 'USER', entityId: session.user.id, tag: 'auth', action: 'updated', description: 'Updated profile picture' })
  return { success: true }
}

export async function getProfileData() {
  const session = await requireAuth()
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, role: true, pictureUrl: true, totpEnabled: true, createdAt: true },
  })
  if (!user) return null
  return { ...user, createdAt: user.createdAt.toISOString() }
}
