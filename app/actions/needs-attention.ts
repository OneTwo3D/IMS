'use server'

import { requirePermission } from '@/lib/auth/server'
import { getExceptionInboxSummary } from '@/app/actions/sync-exceptions'
import { loadNeedsAttentionView } from '@/lib/domain/needs-attention/loader'
import type { NeedsAttentionView } from '@/lib/domain/needs-attention/categories'

/**
 * The dashboard's "Needs attention" card: counts per category for the categories the caller's role
 * may act on, linking to the sync exception inbox (or the existing page for the item type).
 * Counts are shared and cached for a short TTL (see lib/domain/needs-attention/loader.ts).
 */
export async function getNeedsAttentionView(): Promise<NeedsAttentionView> {
  const session = await requirePermission('dashboard')
  return loadNeedsAttentionView(session.user.role, getExceptionInboxSummary)
}
