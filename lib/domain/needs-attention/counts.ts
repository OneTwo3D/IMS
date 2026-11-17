import { hasPermission } from '@/lib/permissions'
import {
  buildNeedsAttentionView,
  type NeedsAttentionCounts,
  type NeedsAttentionView,
} from './categories'
import { countNonInboxCategories, type SourceDeps } from './sources'
import { createTtlCache } from './ttl-cache'

/** The inbox-summary fields the card reads (a structural slice of ExceptionInboxSummary). */
export type InboxSummarySlice = {
  total: number
  wmsPushDeadLetters: number
  stuckDispatches: number
  refundSyncParks: number
  wmsOperatorTasksOpen: number
  /** Serious and medium refused or stalled actions (optional: absent reads as none). */
  refusedActionsOpen?: number
}

export type NeedsAttentionSnapshot = {
  /** Null for roles that cannot read the inbox. */
  inbox: InboxSummarySlice | null
  nonInbox: { failedAccounting: number; receiptReviews: number; stockDiscrepancies: number }
}

/**
 * Pure: fold a snapshot into one count per category. `otherExceptions` is the inbox total minus the
 * five categories shown on their own, so the card total never counts an exception twice.
 */
export function countsFromSnapshot(snapshot: NeedsAttentionSnapshot): NeedsAttentionCounts {
  const inbox = snapshot.inbox
  const dedicated = inbox
    ? inbox.wmsPushDeadLetters + inbox.stuckDispatches + inbox.refundSyncParks + inbox.wmsOperatorTasksOpen + (inbox.refusedActionsOpen ?? 0)
    : 0
  return {
    wmsPushBlocked: inbox?.wmsPushDeadLetters ?? 0,
    dispatchDeadLetters: inbox?.stuckDispatches ?? 0,
    refundParks: inbox?.refundSyncParks ?? 0,
    operatorTasks: inbox?.wmsOperatorTasksOpen ?? 0,
    refusedActions: inbox?.refusedActionsOpen ?? 0,
    otherExceptions: inbox ? Math.max(0, inbox.total - dedicated) : 0,
    ...snapshot.nonInbox,
  }
}

const NO_NON_INBOX = { failedAccounting: 0, receiptReviews: 0, stockDiscrepancies: 0 }

/**
 * A count loader with its own TTL caches. The inbox summary is the heavy read (about twenty
 * counts) and a permission-gated server action, so it is injected per call and the cache only ever
 * fills from a caller that was allowed to read it.
 */
export function createNeedsAttentionLoader(options: { sources: SourceDeps; ttlMs: number; now?: () => number }) {
  const nonInboxCache = createTtlCache(() => countNonInboxCategories(options.sources), options.ttlMs, options.now)
  let inboxCache: ReturnType<typeof createTtlCache<InboxSummarySlice>> | null = null
  let inboxLoader: (() => Promise<InboxSummarySlice>) | null = null

  function inboxSummary(loader: () => Promise<InboxSummarySlice>) {
    if (!inboxCache || inboxLoader !== loader) {
      inboxLoader = loader
      inboxCache = createTtlCache(loader, options.ttlMs, options.now)
    }
    return inboxCache.get()
  }

  return {
    /** Only the categories the role may act on are queried at all. */
    async loadView(role: string, loadInboxSummary: () => Promise<InboxSummarySlice>): Promise<NeedsAttentionView> {
      const mayReadSync = hasPermission(role, 'sync')
      const [inbox, nonInbox] = await Promise.all([
        mayReadSync ? inboxSummary(loadInboxSummary) : Promise.resolve(null),
        mayReadSync || hasPermission(role, 'settings.company') ? nonInboxCache.get() : Promise.resolve(NO_NON_INBOX),
      ])
      return buildNeedsAttentionView(countsFromSnapshot({ inbox, nonInbox }), role)
    },
    clear() {
      nonInboxCache.clear()
      inboxCache?.clear()
      inboxCache = null
      inboxLoader = null
    },
  }
}
