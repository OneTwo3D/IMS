import { handleShoppingWebhook, type ShoppingWebhookResource } from '@/lib/shopping'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

const CONNECTORS: ShoppingConnectorId[] = ['woocommerce', 'shopify']
const RESOURCES: ShoppingWebhookResource[] = ['orders', 'products', 'refunds']

export async function POST(
  request: Request,
  context: { params: Promise<{ connector: string; resource: string }> },
) {
  const { connector, resource } = await context.params
  if (!CONNECTORS.includes(connector as ShoppingConnectorId)) {
    return Response.json({ error: 'Unknown shopping connector' }, { status: 404 })
  }
  if (!RESOURCES.includes(resource as ShoppingWebhookResource)) {
    return Response.json({ error: 'Unknown shopping webhook resource' }, { status: 404 })
  }

  return handleShoppingWebhook(
    connector as ShoppingConnectorId,
    resource as ShoppingWebhookResource,
    request,
  )
}
