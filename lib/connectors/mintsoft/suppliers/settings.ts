import { db } from '@/lib/db'

/**
 * THE THREE SETTINGS OF THE MINTSOFT SUPPLIER FEATURE. Mintsoft is a LIVE production warehouse, so both switches read ON only for the exact
 * string 'true' (absent, blank, 'false', 'TRUE' and a typo are all OFF) and a read failure PROPAGATES rather than reading as either.
 *
 *   mintsoft_supplier_create_enabled   (default OFF) a "create in Mintsoft" choice on the mapping screen is SENT. Off, the choice is recorded
 *                                      as pending and nothing leaves IMS. Even on, it goes through the producer seam and the outbound hold.
 *   mintsoft_asn_supplier_required     (default OFF) an ASN is refused, with an operator task, when its supplier has no Mintsoft mapping. Off,
 *                                      an ASN is created exactly as before (and carries the supplier id only when a mapping exists). MUST be on
 *                                      before step M.
 *   mintsoft_asn_send_supplier_enabled (default OFF) `ProductSupplierId` goes on an ASN ONLY when this is ON. The field name is UNVERIFIED against the live
 *                                      tenant, so it goes ON only after controlled-run step 2 (docs/mintsoft.md) has read it back. With it OFF an ASN
 *                                      body is byte-identical to what it was before suppliers existed, even when suppliers are mapped.
 *                                      `mintsoft_asn_supplier_required` cannot be saved ON unless this is ON (and an ASN is refused if the two ever disagree).
 *   mintsoft_supplier_cache_max_age_minutes  (default 30) a create in Mintsoft is refused when the cached Mintsoft list was last read longer ago than this.
 *   mintsoft_transfer_supplier_id      the IMS supplier ("One Two Enterprises Ltd") that transfer ASNs carry; mapped through the same screen.
 */
export const MINTSOFT_SUPPLIER_CREATE_SETTING = 'mintsoft_supplier_create_enabled'
export const MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING = 'mintsoft_asn_supplier_required'
export const MINTSOFT_ASN_SEND_SUPPLIER_SETTING = 'mintsoft_asn_send_supplier_enabled'
export const MINTSOFT_SUPPLIER_CACHE_MAX_AGE_SETTING = 'mintsoft_supplier_cache_max_age_minutes'
/** Written by the read sync when it finishes (an ISO timestamp): the cache age comes from here, never from row timestamps. */
/** An ASN carrying a supplier id is refused when the list was last read longer ago than this many HOURS (default 24). */
export const MINTSOFT_ASN_SUPPLIER_CACHE_MAX_AGE_SETTING = 'mintsoft_asn_supplier_cache_max_age_hours'
export const DEFAULT_ASN_SUPPLIER_CACHE_MAX_AGE_HOURS = 24
export const MINTSOFT_SUPPLIER_LAST_SYNC_SETTING = 'mintsoft_supplier_last_sync_at'
export const MINTSOFT_TRANSFER_SUPPLIER_SETTING = 'mintsoft_transfer_supplier_id'
export const DEFAULT_SUPPLIER_CACHE_MAX_AGE_MINUTES = 30

export const MINTSOFT_SUPPLIER_SETTING_KEYS = [
  MINTSOFT_SUPPLIER_CREATE_SETTING,
  MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING,
  MINTSOFT_ASN_SEND_SUPPLIER_SETTING,
  MINTSOFT_SUPPLIER_CACHE_MAX_AGE_SETTING,
  MINTSOFT_ASN_SUPPLIER_CACHE_MAX_AGE_SETTING,
  MINTSOFT_SUPPLIER_LAST_SYNC_SETTING,
  MINTSOFT_TRANSFER_SUPPLIER_SETTING,
] as const

export type SupplierSettingReader = {
  setting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: string } | null> }
}

const reader = (client?: SupplierSettingReader): SupplierSettingReader => client ?? (db as unknown as SupplierSettingReader)

export async function readMintsoftSupplierCreateEnabled(client?: SupplierSettingReader): Promise<boolean> {
  return (await reader(client).setting.findUnique({ where: { key: MINTSOFT_SUPPLIER_CREATE_SETTING } }))?.value === 'true'
}

export async function readMintsoftAsnSupplierRequired(client?: SupplierSettingReader): Promise<boolean> {
  return (await reader(client).setting.findUnique({ where: { key: MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING } }))?.value === 'true'
}

export async function readMintsoftAsnSendSupplierEnabled(client?: SupplierSettingReader): Promise<boolean> {
  return (await reader(client).setting.findUnique({ where: { key: MINTSOFT_ASN_SEND_SUPPLIER_SETTING } }))?.value === 'true'
}

/** N, in minutes: a positive whole number from config, else the default. */
export async function readMintsoftSupplierCacheMaxAgeMinutes(client?: SupplierSettingReader): Promise<number> {
  const raw = (await reader(client).setting.findUnique({ where: { key: MINTSOFT_SUPPLIER_CACHE_MAX_AGE_SETTING } }))?.value?.trim() ?? ''
  const parsed = /^\d{1,5}$/.test(raw) ? Number.parseInt(raw, 10) : 0
  return parsed > 0 ? parsed : DEFAULT_SUPPLIER_CACHE_MAX_AGE_MINUTES
}

/** H, in hours: how old the list may be when an ASN carries a supplier id. A positive whole number from config, else the default. */
export async function readMintsoftAsnSupplierCacheMaxAgeHours(client?: SupplierSettingReader): Promise<number> {
  const raw = (await reader(client).setting.findUnique({ where: { key: MINTSOFT_ASN_SUPPLIER_CACHE_MAX_AGE_SETTING } }))?.value?.trim() ?? ''
  const parsed = /^\d{1,4}$/.test(raw) ? Number.parseInt(raw, 10) : 0
  return parsed > 0 ? parsed : DEFAULT_ASN_SUPPLIER_CACHE_MAX_AGE_HOURS
}

/** When the Mintsoft supplier list was last read in full, or null if never. */
export async function readMintsoftSupplierLastSyncAt(client?: SupplierSettingReader): Promise<Date | null> {
  const raw = (await reader(client).setting.findUnique({ where: { key: MINTSOFT_SUPPLIER_LAST_SYNC_SETTING } }))?.value?.trim()
  const at = raw ? new Date(raw) : null
  return at && !Number.isNaN(at.getTime()) ? at : null
}

/** The IMS supplier id transfer ASNs carry, or null when none is chosen. */
export async function readMintsoftTransferSupplierId(client?: SupplierSettingReader): Promise<string | null> {
  const value = (await reader(client).setting.findUnique({ where: { key: MINTSOFT_TRANSFER_SUPPLIER_SETTING } }))?.value?.trim()
  return value ? value : null
}
