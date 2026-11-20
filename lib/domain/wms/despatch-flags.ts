import { getSettingValue } from '@/lib/settings-store'
import { cronEnablementKeys, resolveCronEnablement } from '@/lib/domain/settings/cron-enablement'

/**
 * Two switches for how a warehouse despatch is applied in IMS. BOTH OFF BY DEFAULT: only an explicit `true` turns one on, an unreadable
 * setting is off, and while a switch is off the despatch is applied exactly as it was before it existed. Both are system-managed keys: not on
 * the generic writers' allowlist, set with `npm run settings:set` (docs/installation.md).
 *
 *  - `wms_despatch_date_enabled`: the shipment, the stock movement and the order flip are dated with the warehouse's own despatch time
 *    (bounded; see lib/domain/sales/despatch-instant.ts) instead of the moment the sweep applied it. IT TAKES EFFECT ONLY WHILE THE DAILY
 *    INVENTORY SNAPSHOT CRON IS ENABLED: the snapshot's run rows are the day bound that keeps a late despatch out of a day already snapshotted, and
 *    that cron is off by default. With the cron off the switch is read as off (the despatch is dated at the apply instant, as before) and the
 *    readiness report carries a warning saying so (lib/ops/rollout-readiness.ts).
 *  - `wms_despatch_quantity_check_enabled`: the units the warehouse despatched are compared with the units IMS books, and a despatch that
 *    differs is held and raised for a person instead of being applied (see findDespatchQuantityMismatch in lib/fulfillment/despatch-quantity-check.ts).
 */
export const WMS_DESPATCH_DATE_SETTING = 'wms_despatch_date_enabled'
export const WMS_DESPATCH_QUANTITY_CHECK_SETTING = 'wms_despatch_quantity_check_enabled'
/** The scheduled-job switch of the daily inventory snapshot (lib/cron-jobs/system.ts: slug inventory-snapshot, default disabled). */
export const INVENTORY_SNAPSHOT_CRON_ENABLED_SETTING = 'cron_inventory_snapshot_enabled'
/** A stored accounting lock date last read longer ago than this is not trusted to bound a backdate (the daily batch refreshes it; 36 h leaves headroom for a late or failed batch). */
export const DESPATCH_LOCK_DATE_MAX_AGE_HOURS = 36

async function isOn(key: string): Promise<boolean> {
  try {
    return (await getSettingValue(key)) === 'true'
  } catch {
    return false
  }
}

export type WmsDespatchDateStatus = {
  /** The switch itself. */
  switchOn: boolean
  /** The daily inventory snapshot cron the day bound depends on. */
  snapshotCronEnabled: boolean
  /** What the sweep acts on: the switch, AND the cron. */
  effective: boolean
  /** True when a stored accounting lock date exists but was last read more than DESPATCH_LOCK_DATE_MAX_AGE_HOURS ago (or has no read time): despatches are then not backdated. Optional: absent means not judged. */
  lockDateStale?: boolean
}

/** Is the daily inventory snapshot job on? Resolved through the shared resolver (canonical row, legacy row, registry default), never by reading the row alone. */
export async function isInventorySnapshotCronEnabled(): Promise<boolean> {
  try {
    // The system module registers the inventory-snapshot job as it loads (the registry is empty until a module registers).
    await import('@/lib/cron-jobs/system')
    const { getAllCronJobs } = await import('@/lib/cron-registry')
    const job = getAllCronJobs().find((entry) => entry.slug === 'inventory-snapshot')
    if (!job) return false
    const { canonicalKey, legacyKey } = cronEnablementKeys(job)
    const [canonical, legacy] = await Promise.all([getSettingValue(canonicalKey), legacyKey ? getSettingValue(legacyKey) : Promise.resolve(null)])
    return resolveCronEnablement({ canonical, legacy, hasLegacyKey: legacyKey !== null, defaultEnabled: job.defaultEnabled })
  } catch {
    return false
  }
}

export async function getWmsDespatchDateStatus(): Promise<WmsDespatchDateStatus> {
  const [switchOn, snapshotCronEnabled] = await Promise.all([isOn(WMS_DESPATCH_DATE_SETTING), isInventorySnapshotCronEnabled()])
  const effective = switchOn && snapshotCronEnabled
  let lockDateStale = false
  if (switchOn) {
    try {
      const [value, readAt] = await Promise.all([getSettingValue('xero_books_lock_date'), getSettingValue('xero_books_lock_date_read_at')])
      if ((value ?? '') !== '' || (readAt ?? '') !== '') {
        const at = readAt ? new Date(readAt) : null
        lockDateStale = !at || Number.isNaN(at.getTime()) || Date.now() - at.getTime() > DESPATCH_LOCK_DATE_MAX_AGE_HOURS * 3_600_000
      }
    } catch {
      lockDateStale = false
    }
  }
  return { switchOn, snapshotCronEnabled, effective, lockDateStale }
}

export const isWmsDespatchDateEnabled = async (): Promise<boolean> => (await getWmsDespatchDateStatus()).effective
export const isWmsDespatchQuantityCheckEnabled = (): Promise<boolean> => isOn(WMS_DESPATCH_QUANTITY_CHECK_SETTING)
