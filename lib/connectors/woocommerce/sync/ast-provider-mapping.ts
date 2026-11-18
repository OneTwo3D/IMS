/**
 * Courier -> Advanced Shipment Tracking (AST) provider mapping for the tracking item IMS writes to WooCommerce.
 *
 * PURE: no I/O. Ported verbatim from the legacy warehouse-to-WooCommerce sync plugin (its config table and the
 * CLICKDROP_AST_PROVIDER / FEDEX_AST_PROVIDER constants, with the resolution order of its tracking-provider resolver).
 * The table is pinned against a fixture copied from that config (tests/fixtures/wms-courier-to-ast-provider.json).
 *
 * Why: AST resolves a carrier, its tracking link and its brand from the provider SLUG. IMS used to write the courier's
 * display name into `tracking_provider`, which AST cannot resolve, so the customer's tracking link degraded to plain text.
 *
 * Rules, in the plugin's order:
 *   1. A FedEx-labelled order (`_fedex_tracking_number` or `_fedex_shipment_id` on the WooCommerce order) -> `fedex`.
 *      The warehouse reports those with the generic "Local Collection" courier, so the courier name cannot tell them apart.
 *   2. A Click & Drop-forwarded order (`_clickdrop_label_pushed` truthy) -> `royal-mail`. Same reason.
 *   3. Otherwise an EXACT lookup of the courier name in the table. The plugin does `mapping.get(courier_name)`: it has no
 *      aliases and no case folding, so neither does this. Only surrounding whitespace is trimmed (IMS trims carriers
 *      before building a tracking row anyway).
 *   4. Anything else is UNMAPPED. The caller keeps what IMS wrote before, and counts the miss. Never a guess.
 *
 * It is switched by the setting `wc_ast_provider_mapping_enabled` (default off): see readAstProviderMappingEnabled.
 */

import { db } from '@/lib/db'
import type { WcMeta, WcTrackingItem } from './types'

export const WC_AST_PROVIDER_MAPPING_SETTING = 'wc_ast_provider_mapping_enabled'

export const CLICKDROP_AST_PROVIDER = 'royal-mail'
export const FEDEX_AST_PROVIDER = 'fedex'

/** WooCommerce order meta the label plugins stamp; read from the order IMS fetches just before it writes tracking. */
export const WC_FEDEX_TRACKING_META_KEYS = ['_fedex_tracking_number', '_fedex_shipment_id'] as const
export const WC_CLICKDROP_PUSHED_META_KEY = '_clickdrop_label_pushed'

/** Warehouse courier service name -> AST provider slug. Copied exactly from the plugin; do not add rows without the plugin. */
export const WMS_COURIER_TO_AST_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  // Royal Mail (domestic + international)
  'Royal Mail Tracked 24 [Parcel]': 'royal-mail',
  'Royal Mail Tracked 48 [Parcel]': 'royal-mail',
  'Royal Mail Tracked 24 [Large Letter]': 'royal-mail',
  'Royal Mail Tracked 48 [Large Letter]': 'royal-mail',
  'Royal Mail 24 [Large Letter]': 'royal-mail',
  'Royal Mail 48 [Large Letter]': 'royal-mail',
  'Royal Mail 2nd Class [Letter]': 'royal-mail',
  'Royal Mail SD 1PM [Parcel/LL]': 'royal-mail',
  'Royal Mail SD 9AM [Parcel/LL]': 'royal-mail',
  'Royal Mail Intl DE4 Untracked [Parcel]': 'royal-mail',
  'Royal Mail Intl MP7 Tracked [Parcel]': 'royal-mail',
  'Royal Mail Intl MP8 Tracked Extra Comp [Parcel]': 'royal-mail',
  'Royal Mail Intl MP9 Signed [Parcel]': 'royal-mail',
  'Royal Mail Intl MTE Tracked & Signed [Parcel]': 'royal-mail',
  // Parcelforce
  'RM Parcelforce Express10': 'parcelforce',
  'RM Parcelforce Express24': 'parcelforce',
  'RM Parcelforce Express48': 'parcelforce',
  'RM Parcelforce Express24 Returns': 'parcelforce',
  'RM Parcelforce Euro Priority DTP IOSS': 'parcelforce',
  'RM Parcelforce eEuro Priority DTP IOSS Comp 1': 'parcelforce',
  'RM Parcelforce Global Priority Europe': 'parcelforce',
  'RM Parcelforce Global Priority ROW': 'parcelforce',
  // Evri
  'EVRI 24 Tracked [Parcel]': 'evri',
  'EVRI 48 Tracked [Parcel]': 'evri',
  'EVRI 48 Signed [Parcel]': 'evri',
  // DHL
  'DHL Express Intl Worldwide WPX [Parcel]': 'dhl-express',
  'DHL Express Northern Ireland': 'dhl-express',
  // UPS
  'UPS Standard': 'ups',
  'UPS Economy': 'ups',
  // Spring Global (hands off to USPS for the US leg)
  'Spring Global Tracked IOSS / PDDP [USA/EU]': 'spring_global',
  'Spring Global Tracked Worldwide [DDU]': 'spring_global',
  // Palletline and Local Collection have no AST slug in the plugin either: deliberately absent.
})

export type AstProviderResolution =
  | { kind: 'fedex'; slug: string }
  | { kind: 'clickdrop'; slug: string }
  | { kind: 'courier'; slug: string }
  | { kind: 'unmapped'; courier: string }

function metaValue(meta: readonly WcMeta[] | null | undefined, key: string): unknown {
  for (const entry of meta ?? []) if (entry?.key === key) return entry.value
  return undefined
}

/** The plugin's `_is_fedex_order`: a FedEx tracking number or shipment id is on the order (Python truthiness). */
export function isFedexLabelledOrder(meta: readonly WcMeta[] | null | undefined): boolean {
  return WC_FEDEX_TRACKING_META_KEYS.some((key) => {
    const value = metaValue(meta, key)
    return value !== undefined && value !== null && value !== '' && value !== 0 && value !== false
  })
}

/** The plugin's `_meta_truthy(order, '_clickdrop_label_pushed')`: only 1, "1" and true count (never the string "0"). */
export function isClickDropForwardedOrder(meta: readonly WcMeta[] | null | undefined): boolean {
  const value = metaValue(meta, WC_CLICKDROP_PUSHED_META_KEY)
  return value === 1 || value === '1' || value === true
}

/**
 * `orderRowCount` and `trackingNumber` are the row's context. With ONE tracking row (or none given) the plugin's order-level
 * rules apply unchanged. With SEVERAL rows the order-level label flags must not rebrand a shipment they do not identify:
 *   - the FedEx label meta overrides a row only when `_fedex_tracking_number` is that row's own tracking number; when it names
 *     another row the flag is skipped for this one, and when the order carries only a shipment id (no number to match) it applies
 *     to rows with a courier the table does not know (the warehouse's generic "Local Collection"), never to a mapped courier;
 *   - the Click & Drop flag likewise applies only to rows whose courier the table does not map.
 * A row the flags skip falls through to its own courier lookup (a mapped carrier is preserved) or to unmapped.
 */
export function resolveAstProvider(input: {
  courier: string | null | undefined
  orderMeta: readonly WcMeta[] | null | undefined
  orderRowCount?: number
  trackingNumber?: string | null
}): AstProviderResolution {
  const courier = (input.courier ?? '').trim()
  const mapped = Boolean(courier) && Object.prototype.hasOwnProperty.call(WMS_COURIER_TO_AST_PROVIDER, courier)
  const multi = (input.orderRowCount ?? 1) > 1
  if (isFedexLabelledOrder(input.orderMeta)) {
    const labelled = metaValue(input.orderMeta, WC_FEDEX_TRACKING_META_KEYS[0])
    const labelledNumber = labelled === undefined || labelled === null || labelled === false || labelled === 0 ? '' : String(labelled).trim()
    const own = (input.trackingNumber ?? '').trim()
    const applies = !multi || (labelledNumber ? labelledNumber === own : !mapped)
    if (applies) return { kind: 'fedex', slug: FEDEX_AST_PROVIDER }
  }
  if (isClickDropForwardedOrder(input.orderMeta) && (!multi || !mapped)) return { kind: 'clickdrop', slug: CLICKDROP_AST_PROVIDER }
  if (mapped) return { kind: 'courier', slug: WMS_COURIER_TO_AST_PROVIDER[courier] }
  return { kind: 'unmapped', courier }
}

/**
 * The tracking item with the AST provider applied. The shape is the one the plugin's own direct write produced
 * (`append_shipment_tracking_item`): the slug in `tracking_provider`, nothing in `custom_tracking_provider` and
 * `custom_tracking_link` (AST builds the link from the slug). An unmapped resolution returns the item untouched.
 */
export function applyAstProvider(item: WcTrackingItem, resolution: AstProviderResolution): WcTrackingItem {
  if (resolution.kind === 'unmapped') return item
  return { ...item, tracking_provider: resolution.slug, custom_tracking_provider: '', custom_tracking_link: '' }
}

type SettingReader = {
  setting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: string } | null> }
}

/**
 * Anything other than the string 'true' (absent, blank, 'false', a typo) is OFF, and the payload is byte-identical to what
 * IMS sent before this module existed. A read failure PROPAGATES: the caller is about to write to a live storefront, and an
 * unreadable setting must not read as consent.
 */
export async function readAstProviderMappingEnabled(reader: SettingReader = db as unknown as SettingReader): Promise<boolean> {
  const row = await reader.setting.findUnique({ where: { key: WC_AST_PROVIDER_MAPPING_SETTING } })
  return row?.value === 'true'
}
