import type { ShoppingExternalLink, ShoppingProductLinkResult } from '@/lib/shopping'

import { db } from '@/lib/db'
import { buildShopifyAdminUrl, extractShopifyLegacyResourceId, getShopifyCredentials, shopifyGraphql } from './api'

type ProductVariantLookupResponse = {
  productVariants: {
    nodes: Array<{
      sku: string | null
      product: {
        legacyResourceId: string | number | null
        onlineStoreUrl?: string | null
      } | null
    }>
  }
}

function createShopifyLink(url: string, label: string): ShoppingExternalLink {
  return {
    connectorId: 'shopify',
    connectorName: 'Shopify',
    label,
    url,
  }
}

export async function getShopifyProductExternalLink(sku: string): Promise<ShoppingProductLinkResult> {
  const trimmedSku = sku.trim()
  if (!trimmedSku) return { link: null, error: 'No SKU provided' }

  try {
    const creds = await getShopifyCredentials()
    if (!creds) return { link: null, error: 'Shopify not configured in Settings' }

    const { data, error } = await shopifyGraphql<ProductVariantLookupResponse>(
      `
        query ShopifyProductVariantBySku($query: String!) {
          productVariants(first: 2, query: $query) {
            nodes {
              sku
              product {
                legacyResourceId
                onlineStoreUrl
              }
            }
          }
        }
      `,
      { query: `sku:${JSON.stringify(trimmedSku)}` },
      creds,
    )

    if (error) return { link: null, error }

    if ((data?.productVariants.nodes.length ?? 0) > 1) {
      return {
        link: null,
        error: `Multiple Shopify variants share SKU "${trimmedSku}" — product link is ambiguous`,
      }
    }

    const variant = data?.productVariants.nodes[0]
    const product = variant?.product
    if (!product) return { link: null, error: `No Shopify product found for SKU "${trimmedSku}"` }

    const adminUrl = buildShopifyAdminUrl(creds, 'products', product.legacyResourceId)
    if (adminUrl) {
      return {
        link: createShopifyLink(adminUrl, 'Shopify Admin'),
      }
    }

    if (product.onlineStoreUrl) {
      return {
        link: createShopifyLink(product.onlineStoreUrl, 'View on Shopify'),
      }
    }

    return { link: null, error: `Shopify product found for SKU "${trimmedSku}" but no admin link could be built` }
  } catch {
    return { link: null, error: 'Failed to fetch from Shopify' }
  }
}

export async function getShopifySalesOrderAdminLink(orderId: string): Promise<ShoppingExternalLink | null> {
  const [link, creds] = await Promise.all([
    db.shoppingOrderLink.findFirst({
      where: { connector: 'shopify', orderId },
      select: { externalOrderId: true, metadata: true },
    }),
    getShopifyCredentials(),
  ])

  if (!link || !creds) return null

  const metadata = (link.metadata ?? {}) as Record<string, unknown>
  const adminUrlCandidate = typeof metadata.adminUrl === 'string' ? metadata.adminUrl : null
  if (adminUrlCandidate) return createShopifyLink(adminUrlCandidate, 'Shopify')

  const externalId = extractShopifyLegacyResourceId(link.externalOrderId)
    ?? extractShopifyLegacyResourceId(typeof metadata.legacyResourceId === 'string' || typeof metadata.legacyResourceId === 'number' ? metadata.legacyResourceId : null)

  const adminUrl = buildShopifyAdminUrl(creds, 'orders', externalId)
  return adminUrl ? createShopifyLink(adminUrl, 'Shopify') : null
}

export async function hasShopifyProductExternalLink(productId: string): Promise<boolean> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { sku: true },
  })
  if (!product?.sku) return false

  const result = await getShopifyProductExternalLink(product.sku)
  return Boolean(result.link)
}
