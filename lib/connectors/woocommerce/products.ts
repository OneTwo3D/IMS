'use server'

import { requireInternalUser } from '@/lib/auth/server'

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
 * o3d-512h round 3: requireAuth was still not enough. It admits SUPPLIER — an
 * external principal — so a supplier session could probe the storefront's SKU
 * space and spend the tenant's WooCommerce rate budget doing it. requireInternalUser
 * removes the external principal; the equivalent guarded action,
 * app/actions/shopping.ts:fetchShoppingProductLink, additionally rate-limits per
 * user, and callers that need a lookup should still prefer that one.
 */
export async function fetchWcProductUrl(
  sku: string,
): Promise<{ permalink: string | null; error?: string }> {
  await requireInternalUser()
  const result = await getWcProductExternalLink(sku)
  return { permalink: result.link?.url ?? null, error: result.error }
}
