'use server'

import { revalidatePath } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { runPostCommit } from '@/lib/domain/post-commit'

// ---------------------------------------------------------------------------
// Return reasons: a configured list (Settings > Inventory), the structured companion to the free-text refund reason.
// Same shape as the stock adjustment reasons: name, sort order, active flag. A reason that refunds point at cannot be deleted
// (deactivate it instead), so the returns analytics keeps its history.
// ---------------------------------------------------------------------------

export type ReturnReason = {
  id: string
  name: string
  sortOrder: number
  active: boolean
}

export type ReturnReasonFormState = {
  errors?: Record<string, string[]>
  message?: string
  success?: boolean
  item?: ReturnReason
  /** COMMITTED, but a step after the commit did not complete (audit entry or cache revalidation). */
  warning?: string
}

export type ReturnReasonInput = {
  name: string
  sortOrder: number
  active: boolean
}

const SELECT = { id: true, name: true, sortOrder: true, active: true } as const

const reasonSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  sortOrder: z.coerce.number().int().default(0),
  active: z.boolean().default(true),
})

export async function getReturnReasons(activeOnly = false): Promise<ReturnReason[]> {
  await requireInternalUser()
  return db.returnReason.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: SELECT,
  })
}

/** Another reason already uses this name, ignoring case: the WooCommerce import maps by name, so a name must identify one reason. */
async function nameTaken(name: string, exceptId?: string): Promise<boolean> {
  const clash = await db.returnReason.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  })
  return clash !== null
}

export async function createReturnReason(data: ReturnReasonInput): Promise<ReturnReasonFormState> {
  await requirePermission('settings.company')
  const parsed = reasonSchema.safeParse(data)
  if (!parsed.success) return { errors: parsed.error.flatten().fieldErrors }
  const { name, sortOrder, active } = parsed.data
  try {
    if (await nameTaken(name)) return { errors: { name: ['A return reason with this name already exists'] } }
    const item = await db.returnReason.create({ data: { name, sortOrder, active }, select: SELECT })
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'created', description: `Created return reason: ${name}` })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the new return reason')
    if (postCommit.status === 'failed') return { success: true, item, warning: postCommit.error }
    return { success: true, item }
  } catch (e) {
    unstable_rethrow(e)
    await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to create return reason: ${name}` })
    return { message: 'Failed to create reason.' }
  }
}

export async function updateReturnReason(id: string, data: ReturnReasonInput): Promise<ReturnReasonFormState> {
  await requirePermission('settings.company')
  const parsed = reasonSchema.safeParse(data)
  if (!parsed.success) return { errors: parsed.error.flatten().fieldErrors }
  const { name, sortOrder, active } = parsed.data
  try {
    if (await nameTaken(name, id)) return { errors: { name: ['A return reason with this name already exists'] } }
    const item = await db.returnReason.update({ where: { id }, data: { name, sortOrder, active }, select: SELECT })
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: item.id, tag: 'settings', action: 'updated', description: `Updated return reason: ${name}` })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the return reason change')
    if (postCommit.status === 'failed') return { success: true, item, warning: postCommit.error }
    return { success: true, item }
  } catch (e) {
    unstable_rethrow(e)
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to update return reason: ${name}` })
    return { message: 'Failed to update reason.' }
  }
}

export async function deleteReturnReason(id: string): Promise<{ error?: string; warning?: string }> {
  await requirePermission('settings.company')
  try {
    // soft-delete exception: a soft-deleted refund still references its reason, so it still counts as in use.
    const inUse = await db.salesOrderRefund.count({ where: { returnReasonId: id } })
    if (inUse > 0) {
      return { error: `This reason is used by ${inUse} refund${inUse === 1 ? '' : 's'}. Set it inactive instead, so the returns report keeps its history.` }
    }
    await db.returnReason.delete({ where: { id } })
    const postCommit = await runPostCommit(async () => {
      await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', description: 'Deleted return reason' })
      revalidatePath('/settings', 'layout')
    }, 'Failed to record the return reason deletion')
    // The row is GONE: reporting an error would invite a retry of a delete that succeeded.
    if (postCommit.status === 'failed') return { warning: postCommit.error }
    return {}
  } catch (e) {
    unstable_rethrow(e)
    await logActivity({ entityType: 'SETTING', entityId: id, tag: 'settings', action: 'deleted', level: 'ERROR', description: 'Failed to delete return reason' })
    return { error: 'Failed to delete reason.' }
  }
}
