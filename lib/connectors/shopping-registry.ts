/**
 * Shopping connector registry.
 *
 * Declares the shopping (storefront) connectors that the IMS supports, and
 * the Setting keys used for their document numbering prefixes. This lets the
 * Numbering tab in Settings → Company render one row per connector, and lets
 * each connector's order import code read its own prefix keys in a uniform
 * way, without hardcoding WooCommerce assumptions.
 *
 * Add a new entry here when a new shopping connector lands (e.g. Shopify,
 * BigCommerce). No changes required to the Numbering UI — it reads this list.
 */

import { db } from '@/lib/db'

export type ShoppingConnectorId = 'woocommerce' | 'shopify'

export type ShoppingConnectorDef = {
  id: ShoppingConnectorId
  label: string
  /** Setting.key used for the order number prefix prepended to the platform's order number. */
  orderKey: string
  /** Setting.key used for the accounting invoice number prefix. */
  invKey: string
  /** Default value when no Setting row exists. */
  defaultOrder: string
  /** Default value when no Setting row exists. */
  defaultInv: string
  /** Whether the connector ships today. Non-available connectors still show in the Numbering UI as dormant. */
  available: boolean
  /** Legacy Setting.key values that should be read as a fallback during migration. */
  legacyOrderKeys?: string[]
  legacyInvKeys?: string[]
}

export const SHOPPING_CONNECTORS: readonly ShoppingConnectorDef[] = [
  {
    id: 'woocommerce',
    label: 'WooCommerce',
    orderKey: 'woocommerce_order_prefix',
    invKey: 'woocommerce_inv_prefix',
    defaultOrder: '',
    defaultInv: 'INWC-',
    available: true,
    legacyOrderKeys: ['wc_order_prefix', 'order_number_prefix'],
    legacyInvKeys: ['wc_inv_prefix', 'wc_invoice_prefix'],
  },
  {
    id: 'shopify',
    label: 'Shopify',
    orderKey: 'shopify_order_prefix',
    invKey: 'shopify_inv_prefix',
    defaultOrder: '',
    defaultInv: 'INSH-',
    available: true,
  },
] as const

export function getShoppingConnector(id: ShoppingConnectorId): ShoppingConnectorDef {
  const def = SHOPPING_CONNECTORS.find((c) => c.id === id)
  if (!def) throw new Error(`Unknown shopping connector: ${id}`)
  return def
}

/**
 * Resolve a caller-supplied connector value (e.g. a request param) to a known
 * ShoppingConnectorId. An empty/absent value falls back to `fallback` (default
 * WooCommerce, for back-compat with endpoints that predate connector routing);
 * an unknown non-empty value returns null so the caller can reject it (400).
 * (b8i6.5)
 */
export function parseShoppingConnectorId(
  raw: unknown,
  fallback: ShoppingConnectorId = 'woocommerce',
): ShoppingConnectorId | null {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw !== 'string') return null
  return SHOPPING_CONNECTORS.some((c) => c.id === raw) ? (raw as ShoppingConnectorId) : null
}

/**
 * Returns the numbering prefixes for the given shopping connector, honouring
 * legacy Setting keys as a fallback so existing deployments keep working.
 */
export async function getShoppingConnectorPrefixes(
  id: ShoppingConnectorId,
): Promise<{ orderPrefix: string; invPrefix: string }> {
  const def = getShoppingConnector(id)
  const keys = [def.orderKey, def.invKey, ...(def.legacyOrderKeys ?? []), ...(def.legacyInvKeys ?? [])]
  const rows = await db.setting.findMany({ where: { key: { in: keys } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))

  const orderPrefix = map.get(def.orderKey)
    ?? def.legacyOrderKeys?.map((k) => map.get(k)).find((v) => v !== undefined)
    ?? def.defaultOrder
  const invPrefix = map.get(def.invKey)
    ?? def.legacyInvKeys?.map((k) => map.get(k)).find((v) => v !== undefined)
    ?? def.defaultInv

  return { orderPrefix, invPrefix }
}
