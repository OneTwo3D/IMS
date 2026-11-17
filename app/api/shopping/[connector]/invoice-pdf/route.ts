import { NextRequest, NextResponse } from 'next/server'

import { loadCurrentInvoicePdf } from '@/lib/domain/invoice-documents/current-document'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import { readLimitedRequestBody } from '@/lib/security/read-limited-request-body'
import {
  getShoppingConnector,
  type ShoppingConnectorId,
} from '@/lib/connectors/shopping-registry'
import {
  auditShoppingInvoicePdfAttempt,
  consumeShoppingInvoicePdfNonce,
  findShoppingInvoicePdfOrder,
  isShoppingConnectorId,
  isShoppingConnectorPluginEnabled,
  NO_STORE_HEADERS,
  preparingResponse,
  shoppingOrderLinkHasExternalOrderKey,
  type ShoppingDocumentAuditInput,
  type ShoppingDocumentOrder,
} from '@/lib/shopping-invoice-access'
import type { OnDemandRequestOutcome } from '@/lib/domain/invoice-documents/on-demand'
import {
  getShoppingInvoicePdfSecret,
  parseShoppingInvoicePdfRequest,
  verifyShoppingInvoicePdfSignature,
  type ShoppingInvoicePdfRequest,
} from '@/lib/shopping-invoice-pdf'

export { auditShoppingInvoicePdfAttempt, shoppingOrderLinkHasExternalOrderKey }

type ShoppingInvoicePdfRouteParams = {
  connector: string
}

type ShoppingInvoicePdfOrder = ShoppingDocumentOrder

type ShoppingInvoicePdfAuditInput = ShoppingDocumentAuditInput

type ShoppingInvoicePdfRouteDependencies = {
  getPluginEnabled: (connector: ShoppingConnectorId) => Promise<boolean>
  getSecret: (connector: ShoppingConnectorId) => Promise<string | null>
  findOrder: (request: ShoppingInvoicePdfRequest) => Promise<ShoppingInvoicePdfOrder | null>
  consumeNonce: (request: ShoppingInvoicePdfRequest) => Promise<boolean>
  loadInvoicePdf: typeof loadCurrentInvoicePdf
  auditAttempt: (input: ShoppingInvoicePdfAuditInput) => Promise<void>
  checkRateLimit?: (key: string, max: number, windowMs: number) => Promise<RateLimitResult>
  /**
   * QUEUE the fetch of the invoice from the accounting ledger for an order IMS holds no PDF for yet (historic orders are fetched on
   * the first customer click, in the background). Called only AFTER the request is verified, the order is proved to be the caller's and
   * the request's one-time nonce is spent. Touches IMS's own tables and nothing else: the ledger is asked later, by the sweep.
   * Absent in tests that do not exercise it.
   */
  requestInvoiceOnDemand?: (orderId: string) => Promise<OnDemandRequestOutcome>
  /**
   * Look again at a PDF IMS already holds when its recheck is due (the ledger can amend an invoice). Never throws; whatever is
   * stored is served when the ledger cannot be asked.
   */
  refreshStaleInvoice?: (orderId: string) => Promise<void>
  now?: Date | number
}

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
  requestInvoiceOnDemand: requestShoppingInvoiceOnDemand,
  refreshStaleInvoice: refreshShoppingInvoice,
}

function jsonNoStore(body: object, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function safeInvoiceFilename(value: string | null | undefined): string {
  const safe = value?.replace(/[^a-zA-Z0-9_-]/g, '_') ?? ''
  return safe.length > 0 ? `invoice-${safe}.pdf` : 'invoice.pdf'
}

async function requestShoppingInvoiceOnDemand(orderId: string): Promise<OnDemandRequestOutcome> {
  const { requestInvoiceDocumentOnDemand } = await import('@/lib/domain/invoice-documents/on-demand')
  return requestInvoiceDocumentOnDemand({ orderId, kind: 'INVOICE' })
}

async function refreshShoppingInvoice(orderId: string): Promise<void> {
  const [{ refreshStaleInvoiceDocument }, { xeroInvoiceDocumentDeps }] = await Promise.all([
    import('@/lib/domain/invoice-documents/sweep'),
    import('@/lib/connectors/xero/invoice-document-deps'),
  ])
  await refreshStaleInvoiceDocument(orderId, xeroInvoiceDocumentDeps())
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
    // A historic order the sweep never covered. The caller is already proved to own the order. The request's one-time nonce is spent
    // BEFORE anything is queued, so a replayed request cannot be used to drive the queue. The fetch is QUEUED, not run: the ledger is
    // asked later by the sweep, under its own budget, so this answer is immediate and a customer cannot drive ledger traffic.
    if (!dependencies.requestInvoiceOnDemand) return reject(dependencies, auditWithOrder, 'invoice_pdf_missing', 404)
    if (!await dependencies.consumeNonce(parsed.request)) return reject(dependencies, auditWithOrder, 'nonce_replayed')
    nonceConsumed = true
    const outcome = await dependencies.requestInvoiceOnDemand(order.orderId).catch((): OnDemandRequestOutcome => ({ status: 'unavailable', reason: 'the request could not be queued' }))
    if (outcome.status === 'preparing') {
      await auditAttemptSafely(dependencies, { ...auditWithOrder, accepted: true, reason: 'invoice_pdf_preparing' })
      return preparingResponse(outcome.retryAfterSeconds)
    }
    if (outcome.status === 'throttled') {
      await auditAttemptSafely(dependencies, { ...auditWithOrder, accepted: false, reason: 'invoice_pdf_queue_full' })
      return NextResponse.json(
        { status: 'busy', error: 'Invoice PDF is not available right now' },
        { status: 429, headers: { ...NO_STORE_HEADERS, 'Retry-After': String(outcome.retryAfterSeconds) } },
      )
    }
    return reject(dependencies, auditWithOrder, 'invoice_pdf_missing', 404)
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
