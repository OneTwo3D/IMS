import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity-log'
import { db } from '@/lib/db'
import { loadInvoicePdf } from '@/lib/invoice-pdf'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { readLimitedRequestBody } from '@/lib/security/read-limited-request-body'
import {
  getShoppingConnector,
  type ShoppingConnectorId,
} from '@/lib/connectors/shopping-registry'
import {
  getShoppingInvoicePdfSecret,
  parseShoppingInvoicePdfRequest,
  verifyShoppingInvoicePdfSignature,
  type ShoppingInvoicePdfRequest,
} from '@/lib/shopping-invoice-pdf'

type ShoppingInvoicePdfRouteParams = {
  connector: string
}

type ShoppingInvoicePdfOrder = {
  orderId: string
  invoiceNumber: string | null
  invoicePdfPath: string | null
}

type ShoppingInvoicePdfAuditInput = {
  connector: ShoppingConnectorId | string
  externalOrderId?: string | null
  orderId?: string | null
  accepted: boolean
  reason?: string | null
}

type ShoppingInvoicePdfRouteDependencies = {
  getPluginEnabled: (connector: ShoppingConnectorId) => Promise<boolean>
  getSecret: (connector: ShoppingConnectorId) => Promise<string | null>
  findOrder: (request: ShoppingInvoicePdfRequest) => Promise<ShoppingInvoicePdfOrder | null>
  loadInvoicePdf: typeof loadInvoicePdf
  auditAttempt: (input: ShoppingInvoicePdfAuditInput) => Promise<void>
  checkRateLimit?: (key: string, max: number, windowMs: number) => Promise<RateLimitResult>
  now?: Date | number
}

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
} as const

const SHOPPING_INVOICE_RATE_LIMIT_MAX = 60
const SHOPPING_INVOICE_RATE_LIMIT_WINDOW_MS = 60_000
const SHOPPING_INVOICE_PDF_MAX_BODY_BYTES = 4096
const SHOPPING_INVOICE_PDF_READ_TIMEOUT_MS = 5000

const defaultDependencies: ShoppingInvoicePdfRouteDependencies = {
  getPluginEnabled: isShoppingConnectorPluginEnabled,
  getSecret: getShoppingInvoicePdfSecret,
  findOrder: findShoppingInvoicePdfOrder,
  loadInvoicePdf,
  auditAttempt: auditShoppingInvoicePdfAttempt,
  checkRateLimit,
}

function isShoppingConnectorId(value: string): value is ShoppingConnectorId {
  return value === 'woocommerce' || value === 'shopify'
}

function jsonNoStore(body: object, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function safeInvoiceFilename(value: string | null | undefined): string {
  const safe = value?.replace(/[^a-zA-Z0-9_-]/g, '_') ?? ''
  return safe.length > 0 ? `invoice-${safe}.pdf` : 'invoice.pdf'
}

async function isShoppingConnectorPluginEnabled(connector: ShoppingConnectorId): Promise<boolean> {
  const pluginState = await getIntegrationPluginState()
  return pluginState[connector]
}

async function findShoppingInvoicePdfOrder(request: ShoppingInvoicePdfRequest): Promise<ShoppingInvoicePdfOrder | null> {
  const link = await db.shoppingOrderLink.findFirst({
    where: {
      connector: request.connector,
      externalOrderId: request.externalOrderId,
    },
    select: {
      order: {
        select: {
          id: true,
          customerId: true,
          invoiceNumber: true,
          invoicePdfPath: true,
        },
      },
    },
  })
  const order = link?.order
  if (!order) return null

  if (request.externalCustomerId && request.externalCustomerId !== '0' && order.customerId) {
    const customerLink = await db.shoppingCustomerLink.findFirst({
      where: {
        connector: request.connector,
        externalCustomerId: request.externalCustomerId,
        customerId: order.customerId,
      },
      select: { id: true },
    })
    if (!customerLink) return null
  }

  return {
    orderId: order.id,
    invoiceNumber: order.invoiceNumber,
    invoicePdfPath: order.invoicePdfPath,
  }
}

async function auditAttemptSafely(
  dependencies: ShoppingInvoicePdfRouteDependencies,
  input: ShoppingInvoicePdfAuditInput,
): Promise<void> {
  try {
    await dependencies.auditAttempt(input)
  } catch (error) {
    console.warn('[shopping-invoice-pdf] audit failed', {
      connector: input.connector,
      externalOrderId: input.externalOrderId,
      orderId: input.orderId,
      accepted: input.accepted,
      reason: input.reason,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** @internal Test seam for shopping invoice PDF route auditing. */
export async function auditShoppingInvoicePdfAttempt(input: ShoppingInvoicePdfAuditInput): Promise<void> {
  await logActivity({
    entityType: input.orderId ? 'SALES_ORDER' : 'SYNC',
    entityId: input.orderId ?? null,
    tag: 'auth',
    action: input.accepted ? 'shopping_invoice_pdf_request_verified' : 'shopping_invoice_pdf_request_rejected',
    level: input.accepted ? 'INFO' : 'WARNING',
    description: input.accepted
      ? 'Shopping invoice PDF request accepted'
      : `Shopping invoice PDF request rejected: ${input.reason ?? 'unknown'}`,
    metadata: {
      connector: input.connector,
      externalOrderId: input.externalOrderId ?? null,
      reason: input.reason ?? null,
    },
    resolveUser: false,
  })
}

function reject(
  dependencies: ShoppingInvoicePdfRouteDependencies,
  input: ShoppingInvoicePdfAuditInput,
  reason: string,
  status = 403,
): Promise<NextResponse> {
  return auditAttemptSafely(dependencies, { ...input, accepted: false, reason })
    .then(() => jsonNoStore({ error: 'Invoice PDF is not available' }, status))
}

/** @internal Test seam for the shopping invoice PDF route handler. */
export async function handleShoppingInvoicePdfRoute(
  request: NextRequest,
  params: ShoppingInvoicePdfRouteParams,
  dependencies: ShoppingInvoicePdfRouteDependencies = defaultDependencies,
): Promise<Response> {
  const { connector: rawConnector } = params
  if (!isShoppingConnectorId(rawConnector)) {
    return jsonNoStore({ error: 'Unknown shopping connector' }, 404)
  }
  const connector = rawConnector
  const auditBase: ShoppingInvoicePdfAuditInput = { connector, accepted: false }

  // Throws if the connector is absent from the registry despite the narrow id guard.
  getShoppingConnector(connector)

  const clientIp = getClientIp(request.headers) ?? 'unknown'
  const rateLimit = await dependencies.checkRateLimit?.(
    `shopping-invoice-pdf:${connector}:${clientIp}`,
    SHOPPING_INVOICE_RATE_LIMIT_MAX,
    SHOPPING_INVOICE_RATE_LIMIT_WINDOW_MS,
  )
  if (rateLimit && !rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many invoice PDF requests' },
      {
        status: 429,
        headers: {
          ...NO_STORE_HEADERS,
          'Retry-After': String(rateLimit.retryAfterSec),
        },
      },
    )
  }

  if (!await dependencies.getPluginEnabled(connector)) {
    return reject(dependencies, auditBase, 'connector_disabled', 423)
  }

  const bodyResult = await readLimitedRequestBody(request, {
    maxBytes: SHOPPING_INVOICE_PDF_MAX_BODY_BYTES,
    timeoutMs: SHOPPING_INVOICE_PDF_READ_TIMEOUT_MS,
    tooLargeMessage: 'Shopping invoice PDF request body is too large.',
    emptyBodyMessage: 'Shopping invoice PDF request body is required.',
  })
  if (!bodyResult.ok) return bodyResult.response

  const rawBody = bodyResult.body
  const secret = await dependencies.getSecret(connector)
  if (!secret) {
    return reject(dependencies, auditBase, 'missing_connector_secret', 503)
  }

  const signature = request.headers.get('x-oti-signature')
  if (!verifyShoppingInvoicePdfSignature(rawBody, signature, secret)) {
    return reject(dependencies, auditBase, 'bad_signature')
  }

  const parsed = parseShoppingInvoicePdfRequest(rawBody, connector, { now: dependencies.now })
  if (!parsed.valid) {
    return reject(dependencies, auditBase, parsed.reason)
  }

  const order = await dependencies.findOrder(parsed.request)
  const auditWithOrder = {
    ...auditBase,
    externalOrderId: parsed.request.externalOrderId,
    orderId: order?.orderId ?? null,
  }
  if (!order) return reject(dependencies, auditWithOrder, 'order_not_found')
  if (!order.invoicePdfPath) return reject(dependencies, auditWithOrder, 'invoice_pdf_missing', 404)

  const pdf = await dependencies.loadInvoicePdf(order.orderId)
  if (!pdf) return reject(dependencies, auditWithOrder, 'invoice_pdf_storage_missing', 404)

  await auditAttemptSafely(dependencies, { ...auditWithOrder, accepted: true, reason: null })

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safeInvoiceFilename(order.invoiceNumber)}"`,
      ...NO_STORE_HEADERS,
    },
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connector: string }> },
) {
  return handleShoppingInvoicePdfRoute(request, await params)
}
