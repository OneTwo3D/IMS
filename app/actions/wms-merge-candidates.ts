'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { listMergeCandidateGroups } from '@/lib/domain/wms/merge-candidates'
import { WMS_MERGE_CANDIDATE_MODE_SETTING, parseWmsMergeCandidateMode, readWmsMergeCandidateMode, type WmsMergeCandidateMode } from '@/lib/domain/wms/merge-candidate-mode'

/**
 * MERGE CANDIDATES (flag mode, default OFF): what the Sales order badge and the warehouse screen read, and the mode setting.
 *
 * These are reads of IMS's own data and one IMS setting. Nothing here calls the warehouse or the storefront, and IMS never merges: a person merges in
 * the warehouse system.
 */

export type MergeCandidateBadgeView = {
  /** The other orders of the group (this order is not listed). */
  partners: Array<{ orderId: string; orderNumber: string; warehouseOrder: string }>
  warnings: string[]
}

/** The badge for one sales order, or null (mode off, not in a group, or the read failed: the order page must still render). */
export async function getMergeCandidateForSalesOrder(salesOrderId: string): Promise<MergeCandidateBadgeView | null> {
  await requireInternalUser()
  try {
    const { groups } = await listMergeCandidateGroups()
    const group = groups.find((candidate) => candidate.members.some((member) => member.orderId === salesOrderId))
    if (!group) return null
    return {
      partners: group.members
        .filter((member) => member.orderId !== salesOrderId)
        .map((member) => ({ orderId: member.orderId, orderNumber: member.orderNumber ?? member.orderId, warehouseOrder: member.externalOrderNumber || member.externalOrderId })),
      warnings: group.warnings,
    }
  } catch (error) {
    console.error('[merge-candidates] badge read failed', error instanceof Error ? error.message : String(error))
    return null
  }
}

export type MergeCandidatePanel = {
  mode: WmsMergeCandidateMode
  groups: Array<{
    members: Array<{ orderId: string; orderNumber: string; warehouseOrder: string }>
    warnings: string[]
  }>
  /** Set when the list could not be read. */
  error?: string
}

/** The mode and the current groups for the warehouse screen. */
export async function getMergeCandidatePanel(): Promise<MergeCandidatePanel> {
  await requirePermission('sync')
  const mode = await readWmsMergeCandidateMode()
  if (mode === 'off') return { mode, groups: [] }
  try {
    const { groups } = await listMergeCandidateGroups()
    return {
      mode,
      groups: groups.map((group) => ({
        members: group.members.map((member) => ({ orderId: member.orderId, orderNumber: member.orderNumber ?? member.orderId, warehouseOrder: member.externalOrderNumber || member.externalOrderId })),
        warnings: group.warnings,
      })),
    }
  } catch (error) {
    console.error('[merge-candidates] list failed', error instanceof Error ? error.message : String(error))
    return { mode, groups: [], error: 'The list could not be read. Try again in a moment.' }
  }
}

/** Set the mode. Any value but `flag` is stored as `off` (`hold` is reserved and not built). Audited. */
export async function saveMergeCandidateMode(input: unknown): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  const requested = typeof input === 'string' ? input.trim().toLowerCase() : ''
  if (requested !== 'off' && requested !== 'flag') return { success: false, error: 'The mode must be off or flag.' }
  const next = parseWmsMergeCandidateMode(requested)
  const previous = await readWmsMergeCandidateMode()
  await db.setting.upsert({
    where: { key: WMS_MERGE_CANDIDATE_MODE_SETTING },
    create: { key: WMS_MERGE_CANDIDATE_MODE_SETTING, value: next },
    update: { value: next },
  })
  if (previous !== next) {
    await logActivity({
      entityType: 'SYNC',
      tag: 'sync',
      action: 'wms_merge_candidate_mode_updated',
      level: 'INFO',
      description: `Merge-candidate mode changed from ${previous} to ${next}.`,
      metadata: { from: previous, to: next },
    })
  }
  revalidatePath('/sync')
  return { success: true }
}
