'use server'

import { requireAuth } from '@/lib/auth/server'

import { getWcProductExternalLink } from './links'

/**
 * Fetch the public permalink for a product by SKU from WooCommerce.
 *
 * o3d-hic9: this module carries a `'use server'` directive, so this export is a
 * public HTTP endpoint even though nothing in the app imports it — the only
 * reference is a re-export from ./index.ts. It had no guard, which made it an
 * unauthenticated SKU-existence oracle against the store (the error text
 * distinguishes "not configured" from "no product found for SKU X") and an
 * outbound-request amplifier using the tenant's own WooCommerce credentials.
 *
 * requireAuth matches the equivalent guarded action, app/actions/shopping.ts:
 * fetchShoppingProductLink, which additionally rate-limits per user; callers
 * that need a lookup should prefer that one.
 */
export async function fetchWcProductUrl(
  sku: string,
): Promise<{ permalink: string | null; error?: string }> {
  await requireAuth()
  const result = await getWcProductExternalLink(sku)
  return { permalink: result.link?.url ?? null, error: result.error }
}
