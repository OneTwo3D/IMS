import type { WmsProductSyncOutcome } from '@/lib/connectors/wms/connector-hooks'
import type { MintsoftBundleSyncResult } from '@/lib/connectors/mintsoft/sync/bundle-sync'
import type { MintsoftProductSyncResult } from '@/lib/connectors/mintsoft/sync/product-sync'

/**
 * What a Mintsoft product / bundle sync result means to a caller that must know whether the warehouse really has the
 * change (the product-sync-marks drain). The sync functions return their failures instead of throwing them, so a caller that
 * ignores the value treats a failed sync as done.
 */

/** SUCCEEDED and SKIPPED (an ineligible product) are clean. FAILED, PARTIAL, any error, and a push the outbound hold only shadowed or refused are not. */
export function mintsoftProductOutcome(result: Pick<MintsoftProductSyncResult, 'status' | 'errors' | 'shadowed' | 'outboundHeld' | 'skippedReason'>): WmsProductSyncOutcome {
  const clean = (result.status === 'SUCCEEDED' || result.status === 'SKIPPED') && result.errors === 0 && !result.shadowed && !result.outboundHeld
  return clean ? { ok: true } : { ok: false, detail: `product sync ${result.status}${result.skippedReason ? `: ${result.skippedReason}` : ''} (${result.errors} error(s))` }
}

/** SYNCED, SKIPPED and SKIPPED_NOT_KIT are clean. ERROR, CONFLICT and a shadowed push are not. */
export function mintsoftBundleOutcome(result: Pick<MintsoftBundleSyncResult, 'status' | 'action' | 'reason'>): WmsProductSyncOutcome {
  const clean = (result.status === 'SYNCED' || result.status === 'SKIPPED' || result.status === 'SKIPPED_NOT_KIT') && result.action !== 'shadowed'
  return clean ? { ok: true } : { ok: false, detail: `bundle sync ${result.status}/${result.action}: ${result.reason}` }
}
