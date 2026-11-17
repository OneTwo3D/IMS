import { db } from '@/lib/db'
import { getActiveAccountingConnectorId } from '@/lib/accounting'
import { getEnabledWmsConnectorId } from '@/lib/connectors/wms/active-connector'
import { announceNeedsAttention, type AnnounceDeps } from './announce'
import type { NeedsAttentionView } from './categories'
import { createNeedsAttentionLoader, type InboxSummarySlice } from './counts'
import type { SourceDeps } from './sources'
import { createTtlCache } from './ttl-cache'

/**
 * Seconds-scale TTL: long enough that every dashboard load and every 30 s bell poll across all
 * users shares one set of count queries, short enough that a cleared item vanishes from the card
 * within about a minute.
 */
export const NEEDS_ATTENTION_TTL_MS = 60_000

const sources: SourceDeps = {
  // The real Prisma client satisfies the structural slice the sources use.
  db: db as unknown as SourceDeps['db'],
  activeAccountingConnector: getActiveAccountingConnectorId,
  activeWmsConnector: getEnabledWmsConnectorId,
}

const loader = createNeedsAttentionLoader({ sources, ttlMs: NEEDS_ATTENTION_TTL_MS })

export function loadNeedsAttentionView(
  role: string,
  loadInboxSummary: () => Promise<InboxSummarySlice>,
): Promise<NeedsAttentionView> {
  return loader.loadView(role, loadInboxSummary)
}

const announceDeps: AnnounceDeps = {
  db: db as unknown as AnnounceDeps['db'],
  activeAccountingConnector: getActiveAccountingConnectorId,
  activeWmsConnector: getEnabledWmsConnectorId,
}

const announceCache = createTtlCache(() => announceNeedsAttention(announceDeps), NEEDS_ATTENTION_TTL_MS)

/**
 * Called from the bell's poll. At most one pass per TTL window per process; never throws — a
 * failure here must not break the notification list.
 */
export async function announceNeedsAttentionThrottled(): Promise<void> {
  try {
    await announceCache.get()
  } catch (error) {
    console.error('[needs-attention] announce pass failed:', error)
  }
}
