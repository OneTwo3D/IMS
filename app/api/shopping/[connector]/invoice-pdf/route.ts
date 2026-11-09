import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity-log'
import { db } from '@/lib/db'
import { loadCurrentInvoicePdf } from '@/lib/domain/invoice-documents/current-document'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { readLimitedRequestBody } from '@/lib/security/read-limited-request-body'
import {
  getShoppingConnector,
  SHOPPING_CONNECTORS,
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
  consumeNonce: (request: ShoppingInvoicePdfRequest) => Promise<boolean>
  loadInvoicePdf: typeof loadCurrentInvoicePdf
  auditAttempt: (input: ShoppingInvoicePdfAuditInput) => Promise<void>
  checkRateLimit?: (key: string, max: number, windowMs: number) => Promise<RateLimitResult>
  /**
   * Fetch the invoice from the accounting ledger for an order IMS holds no PDF for yet (historic orders are
   * fetched on first customer download). Called only AFTER the request is verified and the order is proved to be
   * the caller's. True when a PDF is now stored. Absent in tests that do not exercise it.
   */
  ensureInvoiceOnDemand?: (orderId: string) => Promise<boolean>
  /**
   * Look again at a PDF IMS already holds when its recheck is due (the ledger can amend an invoice). Never throws; whatever is
   * stored is served when the ledger cannot be asked.
   */
  refreshStaleInvoice?: (orderId: string) => Promise<void>
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
  consumeNonce: consumeShoppingInvoicePdfNonce,
  loadInvoicePdf: loadCurrentInvoicePdf,
  auditAttempt: auditShoppingInvoicePdfAttempt,
  checkRateLimit,
  ensureInvoiceOnDemand: ensureShoppingInvoiceOnDemand,
  refreshStaleInvoice: refreshShoppingInvoice,
}

// DERIVED FROM THE REGISTRY (o3d-remove-parked-connectors): a second id union here would mean this
// ingress accepts only the connectors somebody remembered to spell in this file.
function isShoppingConnectorId(value: string): value is ShoppingConnectorId {
  return SHOPPING_CONNECTORS.some((connector) => connector.id === value)
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

async function ensureShoppingInvoiceOnDemand(orderId: string): Promise<boolean> {
  const [{ ensureInvoiceDocumentOnDemand }, { xeroInvoiceDocumentDeps }] = await Promise.all([
    import('@/lib/domain/invoice-documents/sweep'),
    import('@/lib/connectors/xero/invoice-document-deps'),
  ])
  return ensureInvoiceDocumentOnDemand(orderId, xeroInvoiceDocumentDeps())
}

async function refreshShoppingInvoice(orderId: string): Promise<void> {
  const [{ refreshStaleInvoiceDocument }, { xeroInvoiceDocumentDeps }] = await Promise.all([
    import('@/lib/domain/invoice-documents/sweep'),
    import('@/lib/connectors/xero/invoice-document-deps'),
  ])
  await refreshStaleInvoiceDocument(orderId, xeroInvoiceDocumentDeps())
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002'
}

/** @internal Test seam for guest-checkout ownership proof. */
export function shoppingOrderLinkHasExternalOrderKey(metadata: unknown, externalOrderKey: string | undefined): boolean {
  if (!externalOrderKey || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const value = (metadata as Record<string, unknown>).externalOrderKey
  return typeof value === 'string' && value.length > 0 && value === externalOrderKey
}

async function consumeShoppingInvoicePdfNonce(request: ShoppingInvoicePdfRequest): Promise<boolean> {
  const expiresAt = new Date(request.expiresAt * 1000)
  try {
    await db.oneTimeToken.create({
      data: {
        key: `shopping-invoice-pdf:${request.connector}:${request.nonce}`,
        value: request.externalOrderId,
        expiresAt,
      },
    })
    return true
  } catch (error) {
    if (isUniqueConstraintError(error)) return false
    throw error
  }
}

async function findShoppingInvoicePdfOrder(request: ShoppingInvoicePdfRequest): Promise<ShoppingInvoicePdfOrder | null> {
  const link = await db.shoppingOrderLink.findFirst({
    where: {
      connector: request.connector,
      externalOrderId: request.externalOrderId,
    },
    select: {
      metadata: true,
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

  if (request.externalCustomerId && request.externalCustomerId !== '0') {
    if (!order.customerId) return null
    const customerLink = await db.shoppingCustomerLink.findFirst({
      where: {
        connector: request.connector,
        externalCustomerId: request.externalCustomerId,
        customerId: order.customerId,
      },
      select: { id: true },
    })
    if (!customerLink) return null
  } else if (!shoppingOrderLinkHasExternalOrderKey(link.metadata, request.externalOrderKey)) {
    return null
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
  let nonceConsumed = false
  if (!order.invoicePdfPath) {
    // A historic order the sweep never covered: ask the ledger once (throttled per document, and only with the
    // lazy-fetch setting on). The caller is already proved to own the order. The request's one-time nonce is spent
    // BEFORE the ledger is asked, so a replayed request cannot be used to drive ledger calls. Any failure is the
    // same 404 as before.
    if (!dependencies.ensureInvoiceOnDemand) return reject(dependencies, auditWithOrder, 'invoice_pdf_missing', 404)
    if (!await dependencies.consumeNonce(parsed.request)) return reject(dependencies, auditWithOrder, 'nonce_replayed')
    nonceConsumed = true
    const fetched = await dependencies.ensureInvoiceOnDemand(order.orderId).catch(() => false)
    if (!fetched) return reject(dependencies, auditWithOrder, 'invoice_pdf_missing', 404)
  }
  if (!nonceConsumed && !await dependencies.consumeNonce(parsed.request)) {
    return reject(dependencies, auditWithOrder, 'nonce_replayed')
  }
  if (!nonceConsumed && dependencies.refreshStaleInvoice) {
    // The nonce is spent, so a replay cannot drive this. Failures are swallowed inside: the stored PDF is served.
    await dependencies.refreshStaleInvoice(order.orderId).catch(() => undefined)
  }

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
