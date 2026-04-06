'use server'

import { getWcCredentials, wcFetch } from './api'

/**
 * Fetch the public permalink for a product by SKU from WooCommerce.
 */
export async function fetchWcProductUrl(
  sku: string,
): Promise<{ permalink: string | null; error?: string }> {
  try {
    const creds = await getWcCredentials()
    if (!creds) return { permalink: null, error: 'WooCommerce not configured in Settings' }

    const { data, error } = await wcFetch(`/products`, { sku, per_page: '1' }, creds)
    if (error) return { permalink: null, error }

    const product = Array.isArray(data) ? data[0] : data
    if (!product) return { permalink: null, error: `No WooCommerce product found for SKU "${sku}"` }
    return { permalink: (product as { permalink?: string }).permalink ?? null }
  } catch {
    return { permalink: null, error: 'Failed to fetch from WooCommerce' }
  }
}
