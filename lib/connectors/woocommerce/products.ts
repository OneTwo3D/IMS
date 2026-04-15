'use server'

import { getWcProductExternalLink } from './links'

/**
 * Fetch the public permalink for a product by SKU from WooCommerce.
 */
export async function fetchWcProductUrl(
  sku: string,
): Promise<{ permalink: string | null; error?: string }> {
  const result = await getWcProductExternalLink(sku)
  return { permalink: result.link?.url ?? null, error: result.error }
}
