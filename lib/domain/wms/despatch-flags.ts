import { getSettingValue } from '@/lib/settings-store'

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
}

export async function getWmsDespatchDateStatus(): Promise<WmsDespatchDateStatus> {
  const [switchOn, snapshotCronEnabled] = await Promise.all([isOn(WMS_DESPATCH_DATE_SETTING), isOn(INVENTORY_SNAPSHOT_CRON_ENABLED_SETTING)])
  return { switchOn, snapshotCronEnabled, effective: switchOn && snapshotCronEnabled }
}

export const isWmsDespatchDateEnabled = async (): Promise<boolean> => (await getWmsDespatchDateStatus()).effective
export const isWmsDespatchQuantityCheckEnabled = (): Promise<boolean> => isOn(WMS_DESPATCH_QUANTITY_CHECK_SETTING)
