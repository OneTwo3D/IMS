import { handleShoppingWebhook, isEmptyShoppingWebhookBodyAllowed, type ShoppingWebhookResource } from '@/lib/shopping'
import { SHOPPING_CONNECTORS, type ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import { parsePositiveIntegerEnv } from '@/lib/env'
import { readLimitedRequestBody } from '@/lib/security/read-limited-request-body'

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

// czuf4: registry-driven — a connector is valid iff it's registered. Adding a connector
// needs only a SHOPPING_CONNECTORS entry, not an edit here.
function isConnector(value: string): value is ShoppingConnectorId {
  return SHOPPING_CONNECTORS.some((c) => c.id === value)
}

function isResource(value: string): value is ShoppingWebhookResource {
  return RESOURCES.includes(value as ShoppingWebhookResource)
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
    emptyBodyAllowed: await isEmptyShoppingWebhookBodyAllowed(connector, request),
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
