import { db } from '@/lib/db'

/**
 * THE MODE OF THE MERGE-CANDIDATE DETECTION (setting `wms_merge_candidate_mode`).
 *
 * Two orders from the same customer to the same address, both still NEW in the warehouse, are a chance for the warehouse to ship one parcel.
 * IMS never merges: Mintsoft has no merge API, so a person merges in the Mintsoft UI. This setting only decides whether IMS tells that person.
 *
 *   off   (the default) nothing is computed and nothing is written: no badge, no activity entry, no operator task.
 *   flag  IMS flags the group: a Mergeable badge on each order, an activity entry, a list on the Mintsoft screen and ONE operator task
 *         per group asking a person to check the orders in Mintsoft and merge them there. Flag mode writes NOTHING to Mintsoft or WooCommerce.
 *
 * Holding the orders of a group in Mintsoft until a person has merged them is NOT a mode of this setting: it is the separate, off-by-default setting
 * `wms_merge_hold_enabled` (lib/domain/wms/merge-hold.ts), which needs this mode to be `flag`. The value `hold` is not recognised here, so it reads as
 * `off`, exactly like any unknown value (a typo must never turn a feature on).
 *
 * A read failure PROPAGATES; an unreadable setting must not read as consent.
 */
export const WMS_MERGE_CANDIDATE_MODE_SETTING = 'wms_merge_candidate_mode'

export const WMS_MERGE_CANDIDATE_MODES = ['off', 'flag'] as const
export type WmsMergeCandidateMode = (typeof WMS_MERGE_CANDIDATE_MODES)[number]

/** Anything that is not exactly `flag` (case and surrounding space ignored) is `off`: unset, blank, `hold` (reserved), a typo. */
export function parseWmsMergeCandidateMode(value: string | null | undefined): WmsMergeCandidateMode {
  return typeof value === 'string' && value.trim().toLowerCase() === 'flag' ? 'flag' : 'off'
}

type SettingReader = {
  setting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: string } | null> }
}

export async function readWmsMergeCandidateMode(reader: SettingReader = db as unknown as SettingReader): Promise<WmsMergeCandidateMode> {
  const row = await reader.setting.findUnique({ where: { key: WMS_MERGE_CANDIDATE_MODE_SETTING } })
  return parseWmsMergeCandidateMode(row?.value)
}
