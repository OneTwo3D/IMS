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
 *   mintsoft_transfer_supplier_id      the IMS supplier ("One Two Enterprises Ltd") that transfer ASNs carry; mapped through the same screen.
 */
export const MINTSOFT_SUPPLIER_CREATE_SETTING = 'mintsoft_supplier_create_enabled'
export const MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING = 'mintsoft_asn_supplier_required'
export const MINTSOFT_TRANSFER_SUPPLIER_SETTING = 'mintsoft_transfer_supplier_id'

export const MINTSOFT_SUPPLIER_SETTING_KEYS = [
  MINTSOFT_SUPPLIER_CREATE_SETTING,
  MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING,
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

/** The IMS supplier id transfer ASNs carry, or null when none is chosen. */
export async function readMintsoftTransferSupplierId(client?: SupplierSettingReader): Promise<string | null> {
  const value = (await reader(client).setting.findUnique({ where: { key: MINTSOFT_TRANSFER_SUPPLIER_SETTING } }))?.value?.trim()
  return value ? value : null
}
