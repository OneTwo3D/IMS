/**
 * THE SETTINGS OF THE EU IOSS / VOEC / DDP TREATMENT that are not account mappings (those are `xero_eu_vat_ioss_account`, `xero_eu_vat_ddp_account` and `xero_eu_fee_account`,
 * ordinary Xero account roles in lib/connectors/xero/settings.ts).
 *
 * CONFIGURATION ONLY IN THIS CHANGE: nothing reads these to post or hold a document yet. They exist so the credit-note work can, and so the preflight can say whether they are sane.
 *
 * THE HOLD (owner ruling Q3): a refund whose VAT was booked on WooCommerce rate 182 for a scheme order is posted to the order's stamped VAT account, but the first N such credit notes are held
 * for a person to check before release. N is `eu_vat_refund182_hold_threshold` (default 10); how many have been held so far is `eu_vat_refund182_held_count`, a persisted counter the
 * holding code increments. A held note is released by a person, never by the count.
 */

export const EU_VAT_REFUND_HOLD_THRESHOLD_SETTING = 'eu_vat_refund182_hold_threshold'
export const EU_VAT_REFUND_HELD_COUNT_SETTING = 'eu_vat_refund182_held_count'
export const EU_VAT_REFUND_HOLD_DEFAULT_THRESHOLD = 10

export type CountSetting = { state: 'unset' } | { state: 'ok'; value: number } | { state: 'invalid'; raw: string }

/** A stored non-negative whole number; blank or absent is `unset`; anything else is `invalid` (never coerced). */
export function parseCountSetting(raw: string | null | undefined): CountSetting {
  if (raw === null || raw === undefined || raw.trim() === '') return { state: 'unset' }
  const text = raw.trim()
  if (!/^\d{1,9}$/.test(text)) return { state: 'invalid', raw: text.slice(0, 40) }
  return { state: 'ok', value: Number(text) }
}

/** The threshold in force: the stored one, the default when none is stored, null when what is stored is not a count (the holding code must then hold, not guess). */
export function refundHoldThreshold(raw: string | null | undefined): number | null {
  const parsed = parseCountSetting(raw)
  if (parsed.state === 'unset') return EU_VAT_REFUND_HOLD_DEFAULT_THRESHOLD
  return parsed.state === 'ok' ? parsed.value : null
}
