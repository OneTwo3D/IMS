import type { WmsDispatchSweepResult } from '@/lib/domain/wms/dispatch-sweep'
import type { ProcessMintsoftBookedInEventsResult } from '@/lib/jobs/wms/process-mintsoft-booked-in-event'
import { counts, enumResult, from, structural, type Rec } from '@/lib/ops/cron-outcome-helpers'
import type { MintsoftBundleVerifyResult } from './sync/bundle-sync'
import type { MintsoftProductSyncResult } from './sync/product-sync'
import type { MintsoftReturnsSyncResult } from './sync/returns-sync'
import type { MintsoftStockSyncResult } from './sync/stock-sync'

/**
 * THE EXIT-STATUS MAPPING OF THE MINTSOFT CRON ROUTES (see lib/ops/cron-outcomes.ts for the contract and the other routes).
 * Each entry says how that route's own result reports failure; lib/ops/cron-outcomes.ts spreads this object into the registry.
 */

type MintsoftStockSyncCronResult = { ran: number; due: number; details: Array<Pick<MintsoftStockSyncResult, 'status' | 'errors'>> }

export const mintsoftCronOutcomes = {
  // status: SKIPPED | SUCCEEDED | PARTIAL | FAILED; errors: number
  'mintsoft-bundle-verify': (r: MintsoftBundleVerifyResult) => enumResult(r, ['errors']),
  // status enum; errors: number; outboundHeld: number
  'mintsoft-dispatch-sync': (r: WmsDispatchSweepResult) => enumResult(r, ['errors']),
  // status enum; errors: number
  'mintsoft-product-verify': (r: MintsoftProductSyncResult) => enumResult(r, ['errors']),
  // status enum; errors: number
  'mintsoft-returns-sync': (r: MintsoftReturnsSyncResult) => enumResult(r, ['errors']),
  // one result per binding: status enum and errors: number
  'mintsoft-stock-sync': (r: MintsoftStockSyncCronResult) => from(r, ...r.details.map((detail) => enumResult(detail, ['errors']))),
  // failed: number (booked-in events that failed to process); error texts in the recheck
  'mintsoft-webhook-sweeper': (r: Partial<ProcessMintsoftBookedInEventsResult> & Rec) => from(r, counts(r, ['failed']), structural(r)),
}
