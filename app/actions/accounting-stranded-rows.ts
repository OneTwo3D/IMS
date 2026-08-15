'use server'

import { db } from '@/lib/db'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { requirePermission } from '@/lib/auth/server'
import {
  buildStrandedSyncRowOrderBy,
  buildStrandedSyncRowWhere,
  pageStrandedSyncRows,
  type StrandedSyncRowsResult,
} from '@/lib/domain/accounting/stranded-sync-rows'

// ---------------------------------------------------------------------------
// o3d-osl8 item 1 — the stranded-row LOADER.
//
// Read-only. This module lists unresolved accounting sync rows on a connector that is no longer
// active; it does not settle, cancel or retry any of them. A per-row remedy for a PROCESSING row
// needs an immutable claim generation the connectors' writeback compare-and-sets on (o3d-e2mz),
// and does not exist yet.
//
// NOTE: StrandedSyncRow / StrandedSyncRowsResult are deliberately NOT re-exported from here. This module is 'use server',
// and Turbopack registers every export of such a module in the server-actions manifest —
// including a type-only re-export, which then fails to resolve at build time with "The export
// StrandedSyncRow was not found". tsc does not catch it, because to tsc the re-export is sound.
// Consumers import the type straight from lib/domain/accounting/stranded-sync-rows instead.
// ---------------------------------------------------------------------------

/**
 * Mirrors the private getActiveConnector in app/actions/accounting-sync.ts. Duplicated rather
 * than exported from there because that module is 'use server': exporting it would mint a new
 * RPC endpoint for a four-line plugin-state read.
 */
async function resolveActiveAccountingConnector(): Promise<string | null> {
  if (await isIntegrationPluginEnabled('xero')) return 'xero'
  if (await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  return null
}

/**
 * Unresolved accounting sync rows on a connector that is NOT the active one — WITH the detail
 * needed to act on them: connector, type, reference, status, age, and the last error.
 *
 * o3d-osl8 is explicit that an aggregate count is not a remedy; that was the specific
 * criticism. Every existing accounting log view is scoped to the active connector
 * (getAccountingSyncLogs resolves it; getXeroSyncLogs / getQuickBooksSyncLogs hard-filter), so
 * a row left behind on a retired connector is visible ONLY as the integer in the orphan
 * banner. This loader is deliberately NOT connector-scoped, which is the whole point of it.
 *
 * Oldest first, tie-broken on id so a truncated page is deterministic.
 * Backed by @@index([connector, status, createdAt]) on AccountingSyncLog.
 *
 * TRUNCATION IS REPORTED, NOT HIDDEN. The result carries `hasMore` and `total`, because this
 * view is read-only: nothing on the page can clear a FAILED row (that needs the claim
 * generation, o3d-e2mz), so the oldest `limit` rows would otherwise starve every newer stranded
 * row permanently — invisibly. `total` is counted with a second query ONLY when the list is cut
 * short; a complete list is still one query.
 *
 * GUARDED ON `sync`, NOT merely on being logged in. This is an exported server action, so it is
 * a callable RPC endpoint for ANY authenticated session — and what it returns is not a summary:
 * sync-log ids, the referenced entity ids, external transaction ids, and raw connector error
 * text, across connectors the caller has nothing to do with. requireAuth would hand all of that
 * to WAREHOUSE, FINANCE, READONLY and SUPPLIER sessions. `sync` is the permission that already
 * gates every other accounting-sync read, so this is the same boundary rather than a new one.
 */
export async function getStrandedAccountingSyncRows(limit = 50): Promise<StrandedSyncRowsResult> {
  await requirePermission('sync')
  const activeConnector = await resolveActiveAccountingConnector()
  // Client-supplied bound; clamp rather than trust.
  const take = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 200)
  const where = buildStrandedSyncRowWhere(activeConnector)
  const sourceRows = await db.accountingSyncLog.findMany({
    where,
    orderBy: buildStrandedSyncRowOrderBy(),
    // One more than asked for: the extra row is how truncation is DETECTED, and it is dropped
    // again by pageStrandedSyncRows before anything is returned.
    take: take + 1,
    select: {
      id: true,
      connector: true,
      type: true,
      status: true,
      referenceType: true,
      referenceId: true,
      externalTransactionId: true,
      errorMessage: true,
      createdAt: true,
    },
  })
  const page = pageStrandedSyncRows(sourceRows, take, new Date())
  return {
    ...page,
    total: page.hasMore ? await db.accountingSyncLog.count({ where }) : page.rows.length,
  }
}
