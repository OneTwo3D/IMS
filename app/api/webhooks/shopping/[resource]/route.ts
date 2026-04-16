import type { ShoppingWebhookResource } from '@/lib/shopping'

export async function POST(request: Request, context: { params: Promise<{ resource: string }> }) {
  const { resource } = await context.params
  if (!['orders', 'products', 'refunds'].includes(resource)) {
    return Response.json({ error: 'Unknown shopping webhook resource' }, { status: 404 })
  }

  return Response.json({
    error: 'Shopping webhook routes are connector-scoped now. Use /api/webhooks/shopping/[connector]/[resource].',
    resource: resource as ShoppingWebhookResource,
  }, { status: 410 })
}
