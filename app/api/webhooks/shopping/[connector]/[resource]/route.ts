import { handleShoppingWebhook, type ShoppingWebhookResource } from '@/lib/shopping'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import { parsePositiveIntegerEnv } from '@/lib/env'
import { readLimitedRequestBody } from '@/lib/security/read-limited-request-body'

const CONNECTORS: ShoppingConnectorId[] = ['woocommerce', 'shopify']
const RESOURCES: ShoppingWebhookResource[] = ['orders', 'products', 'refunds']
const DEFAULT_SHOPPING_WEBHOOK_MAX_BODY_BYTES = 262_144
const DEFAULT_SHOPPING_WEBHOOK_READ_TIMEOUT_MS = 30_000

type ShoppingWebhookRouteDependencies = {
  handleShoppingWebhook: typeof handleShoppingWebhook
}

const defaultDependencies: ShoppingWebhookRouteDependencies = {
  handleShoppingWebhook,
}

function shoppingWebhookMaxBodyBytes(): number {
  // Re-read per request so runtime env changes take effect without restart.
  return parsePositiveIntegerEnv(
    process.env.SHOPPING_WEBHOOK_MAX_BODY_BYTES,
    DEFAULT_SHOPPING_WEBHOOK_MAX_BODY_BYTES,
  )
}

function shoppingWebhookReadTimeoutMs(): number {
  // Re-read per request so runtime env changes take effect without restart.
  return parsePositiveIntegerEnv(
    process.env.SHOPPING_WEBHOOK_READ_TIMEOUT_MS,
    DEFAULT_SHOPPING_WEBHOOK_READ_TIMEOUT_MS,
  )
}

function isConnector(value: string): value is ShoppingConnectorId {
  return CONNECTORS.includes(value as ShoppingConnectorId)
}

function isResource(value: string): value is ShoppingWebhookResource {
  return RESOURCES.includes(value as ShoppingWebhookResource)
}

function isEmptyBodyAllowed(connector: ShoppingConnectorId, request: Request): boolean {
  if (connector !== 'woocommerce') return false
  const signature = request.headers.get('x-wc-webhook-signature')
  const topic = request.headers.get('x-wc-webhook-topic')
  // WooCommerce may send unsigned empty-body pings and signed action hooks
  // with no JSON payload; signed real webhooks still verify downstream.
  return (!signature && !topic) || (topic?.startsWith('action.') ?? false)
}

export async function POST(
  request: Request,
  context: { params: Promise<{ connector: string; resource: string }> },
) {
  return handleShoppingWebhookRoute(request, await context.params)
}

export async function handleShoppingWebhookRoute(
  request: Request,
  params: { connector: string; resource: string },
  dependencies: ShoppingWebhookRouteDependencies = defaultDependencies,
) {
  const { connector, resource } = params
  if (!isConnector(connector)) {
    return Response.json({ error: 'Unknown shopping connector' }, { status: 404 })
  }
  if (!isResource(resource)) {
    return Response.json({ error: 'Unknown shopping webhook resource' }, { status: 404 })
  }

  const bodyResult = await readLimitedRequestBody(request, {
    maxBytes: shoppingWebhookMaxBodyBytes(),
    timeoutMs: shoppingWebhookReadTimeoutMs(),
    emptyBodyAllowed: isEmptyBodyAllowed(connector, request),
    tooLargeMessage: 'Shopping webhook body is too large.',
    emptyBodyMessage: 'Shopping webhook body is required.',
  })
  if (!bodyResult.ok) return bodyResult.response

  return dependencies.handleShoppingWebhook(
    connector,
    resource,
    request,
    bodyResult.body,
  )
}
