'use server'

import { revalidatePath } from 'next/cache'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { requireAuth, requireFreshAuth } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { validateUserPassword } from '@/lib/security/password-policy'

export async function updateProfile(data: { name: string; email: string }): Promise<{ success: boolean; error?: string }> {
  const session = await requireAuth()
  const userId = session.user.id

  if (!data.name.trim()) return { success: false, error: 'Name is required' }
  if (!data.email.trim()) return { success: false, error: 'Email is required' }

  const newEmail = data.email.trim().toLowerCase()
  const current = await db.user.findUnique({ where: { id: userId }, select: { email: true } })
  if (!current) return { success: false, error: 'User not found' }
  const emailChanging = newEmail !== current.email.toLowerCase()

  // Changing the login email is a sensitive account operation: require a
  // recently-authenticated session and roll sessionVersion to invalidate other
  // sessions once the email moves.
  if (emailChanging) {
    try {
      await requireFreshAuth()
    } catch {
      return { success: false, error: 'Please sign in again to change your email address.' }
    }
  }

  // Check email uniqueness
  const existing = await db.user.findUnique({ where: { email: newEmail } })
  if (existing && existing.id !== userId) return { success: false, error: 'Email already in use' }

  await db.user.update({
    where: { id: userId },
    data: {
      name: data.name.trim(),
      email: newEmail,
      ...(emailChanging ? { sessionVersion: { increment: 1 } } : {}),
    },
  })
  revalidatePath('/profile')
  await logActivity({
    entityType: 'USER',
    entityId: userId,
    tag: 'auth',
    action: emailChanging ? 'email_changed' : 'updated',
    description: emailChanging ? 'Changed account email' : 'Updated profile',
  })
  return { success: true }
}

export async function changePassword(data: { currentPassword: string; newPassword: string }): Promise<{ success: boolean; error?: string }> {
  const session = await requireAuth()
  const userId = session.user.id

  const policyError = validateUserPassword(data.newPassword ?? '')
  if (policyError) return { success: false, error: policyError }

  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
  if (!user) return { success: false, error: 'User not found' }

  const match = await bcrypt.compare(data.currentPassword, user.passwordHash)
  if (!match) return { success: false, error: 'Current password is incorrect' }

  const passwordHash = await bcrypt.hash(data.newPassword, 12)
  await db.user.update({
    where: { id: userId },
    data: { passwordHash, sessionVersion: { increment: 1 } },
  })
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
