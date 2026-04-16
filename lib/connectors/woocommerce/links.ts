import type { ShoppingExternalLink, ShoppingProductLinkResult } from '@/lib/shopping'
import { db } from '@/lib/db'
import { getWcCredentials, wcFetch } from './api'

function createWcLink(url: string, label: string): ShoppingExternalLink {
  return {
    connectorId: 'woocommerce',
    connectorName: 'WooCommerce',
    label,
    url,
  }
}

export async function getWcProductExternalLink(sku: string): Promise<ShoppingProductLinkResult> {
  try {
    const creds = await getWcCredentials()
    if (!creds) return { link: null, error: 'WooCommerce not configured in Settings' }

    const { data, error } = await wcFetch('/products', { sku, per_page: '1' }, creds)
    if (error) return { link: null, error }

    const product = Array.isArray(data) ? data[0] : data
    const permalink = (product as { permalink?: string } | undefined)?.permalink
    if (!permalink) return { link: null, error: `No WooCommerce product found for SKU "${sku}"` }

    return {
      link: createWcLink(permalink, 'View on WooCommerce'),
    }
  } catch {
    return { link: null, error: 'Failed to fetch from WooCommerce' }
  }
}

export async function getWcSalesOrderAdminLink(orderId: string): Promise<ShoppingExternalLink | null> {
  const [link, creds] = await Promise.all([
    db.shoppingOrderLink.findFirst({
      where: { connector: 'woocommerce', orderId },
      select: { externalOrderId: true },
    }),
    getWcCredentials(),
  ])

  if (!link?.externalOrderId || !creds) return null

  return createWcLink(`${creds.url}/wp-admin/post.php?post=${link.externalOrderId}&action=edit`, 'WooCommerce')
}

export async function hasWcProductExternalLink(productId: string): Promise<boolean> {
  const count = await db.shoppingSyncLog.count({
    where: { connector: 'woocommerce', entityType: 'Product', entityId: productId, status: 'SYNCED' },
  })
  return count > 0
}
