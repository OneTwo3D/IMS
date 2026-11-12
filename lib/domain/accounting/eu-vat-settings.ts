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

/**
 * WHO DECIDES THE EU VAT REGIME (`eu_vat_regime_mode`). `adopt_plugin` (the default, and what an unset value means) is the parallel phase while the storefront plugin still posts: IMS adopts the plugin's decision,
 * read from the account it recorded on the order, and refuses an order with scheme VAT that carries none. `decide` is the state after the switchover: IMS decides by value with its own order-date rates.
 * A stored value that is neither is NOT coerced: it reads as null and the caller must refuse rather than guess which mode was meant.
 */
export const EU_VAT_REGIME_MODE_SETTING = 'eu_vat_regime_mode'
export const EU_VAT_REGIME_MODE_DEFAULT = 'adopt_plugin'

export function parseRegimeMode(raw: string | null | undefined): 'adopt_plugin' | 'decide' | null {
  if (raw === null || raw === undefined || raw.trim() === '') return EU_VAT_REGIME_MODE_DEFAULT
  const text = raw.trim()
  return text === 'adopt_plugin' || text === 'decide' ? text : null
}

/**
 * THE GIFT-CARD LINE FLAG CUT-IN (`eu_vat_gift_card_flag_cut_in`). From the storefront plugin's cut-in the store writes an explicit yes/no gift-card flag (`_o3d_is_voucher`) on EVERY order line. Unset (the default)
 * keeps the lenient reading: a line with no flag is "unknown" and only refuses when it could decide the regime. Set to a date (`YYYY-MM-DD`, the start of that day UTC) or an instant (ISO 8601 with a zone, e.g.
 * `2026-12-01T00:00:00Z`): an order created AT OR AFTER it must carry the flag on every line, or the regime resolver refuses it (`gift_card_flag_missing`). A stored value that is not a date is NOT coerced: it reads as
 * `invalid` and every order refuses (`gift_card_cut_in_unreadable`), because guessing the date would either wave unflagged orders through or hold flagged ones.
 */
export const EU_VAT_GIFT_CARD_CUT_IN_SETTING = 'eu_vat_gift_card_flag_cut_in'

export type GiftCardCutIn = { state: 'unset' } | { state: 'ok'; at: Date } | { state: 'invalid'; raw: string }

export function parseGiftCardCutIn(raw: string | null | undefined): GiftCardCutIn {
  if (raw === null || raw === undefined || raw.trim() === '') return { state: 'unset' }
  const text = raw.trim()
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text)
  if (!dateOnly && !instant) return { state: 'invalid', raw: text.slice(0, 40) }
  const at = new Date(dateOnly ? `${text}T00:00:00Z` : text)
  // Date rolls invalid calendar days (2026-02-31) over silently in some forms; require the date part to survive the round trip when it is date-only.
  if (Number.isNaN(at.getTime()) || (dateOnly && at.toISOString().slice(0, 10) !== text)) return { state: 'invalid', raw: text.slice(0, 40) }
  return { state: 'ok', at }
}
