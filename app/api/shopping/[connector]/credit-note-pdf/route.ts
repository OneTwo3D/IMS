import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { loadCurrentCreditNotePdf } from '@/lib/domain/invoice-documents/current-document'
import type { OnDemandRequestOutcome } from '@/lib/domain/invoice-documents/on-demand'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import { readLimitedRequestBody } from '@/lib/security/read-limited-request-body'
import { getShoppingConnector, type ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import {
  auditShoppingInvoicePdfAttempt,
  consumeShoppingInvoicePdfNonce,
  findShoppingInvoicePdfOrder,
  isShoppingConnectorId,
  isShoppingConnectorPluginEnabled,
  NO_STORE_HEADERS,
  preparingResponse,
  type ShoppingDocumentAuditInput,
  type ShoppingDocumentOrder,
} from '@/lib/shopping-invoice-access'
import {
  getShoppingInvoicePdfSecret,
  parseShoppingInvoicePdfRequest,
  verifyShoppingInvoicePdfSignature,
  type ShoppingInvoicePdfRequest,
} from '@/lib/shopping-invoice-pdf'

/**
 * POST /api/shopping/[connector]/credit-note-pdf: a customer's CREDIT NOTE, its own document (never the invoice).
 *
 * The invoice route's twin, with the same checks in the same order: connector plugin enabled, bounded body, HMAC signature (the same
 * dedicated secret), a fresh request window, ONE-TIME NONCE, and the proof that the caller owns the ORDER (a logged-in customer linked to
 * the order's customer, or a guest holding the order's own key). On top of that the refund must be one OF THAT ORDER: it is looked up by
 * the storefront's refund id inside the proved order, so a refund id belonging to anyone else's order is "not found", never served.
 *
 * A credit note IMS does not hold yet is QUEUED (same on-demand queue and caps as the invoice) and answered 202 "preparing".
 */

type CreditNoteRouteParams = { connector: string }

type CreditNoteRefund = { refundId: string; creditNoteNumber: string | null }

type CreditNoteRouteDependencies = {
  getPluginEnabled: (connector: ShoppingConnectorId) => Promise<boolean>
  getSecret: (connector: ShoppingConnectorId) => Promise<string | null>
  findOrder: (request: ShoppingInvoicePdfRequest) => Promise<ShoppingDocumentOrder | null>
  /** The refund the storefront id names, ONLY if it belongs to this order. */
  findRefund: (orderId: string, externalRefundId: string) => Promise<CreditNoteRefund | null>
  consumeNonce: (request: ShoppingInvoicePdfRequest) => Promise<boolean>
  loadCreditNotePdf: typeof loadCurrentCreditNotePdf
  requestCreditNoteOnDemand?: (orderId: string, refundId: string) => Promise<OnDemandRequestOutcome>
  auditAttempt: (input: ShoppingDocumentAuditInput) => Promise<void>
  checkRateLimit?: (key: string, max: number, windowMs: number) => Promise<RateLimitResult>
  now?: Date | number
}

const RATE_LIMIT_MAX = 60
const RATE_LIMIT_WINDOW_MS = 60_000
const MAX_BODY_BYTES = 4096
const READ_TIMEOUT_MS = 5000

async function findRefundOfOrder(orderId: string, externalRefundId: string): Promise<CreditNoteRefund | null> {
  // The storefront's refund id is a number; anything else names no refund.
  if (!/^\d{1,12}$/.test(externalRefundId)) return null
  const refund = await db.salesOrderRefund.findFirst({
    where: { orderId, externalRefundId: Number(externalRefundId) },
    select: { id: true, creditNoteNumber: true },
  })
  return refund ? { refundId: refund.id, creditNoteNumber: refund.creditNoteNumber } : null
}

async function requestCreditNoteOnDemand(orderId: string, refundId: string): Promise<OnDemandRequestOutcome> {
  const { requestInvoiceDocumentOnDemand } = await import('@/lib/domain/invoice-documents/on-demand')
  return requestInvoiceDocumentOnDemand({ orderId, kind: 'CREDIT_NOTE', refundId })
}

const defaultDependencies: CreditNoteRouteDependencies = {
  getPluginEnabled: isShoppingConnectorPluginEnabled,
  getSecret: getShoppingInvoicePdfSecret,
  findOrder: findShoppingInvoicePdfOrder,
  findRefund: findRefundOfOrder,
  consumeNonce: consumeShoppingInvoicePdfNonce,
  loadCreditNotePdf: loadCurrentCreditNotePdf,
  requestCreditNoteOnDemand,
  auditAttempt: auditShoppingInvoicePdfAttempt,
  checkRateLimit,
}

function jsonNoStore(body: object, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function safeCreditNoteFilename(value: string | null | undefined): string {
  const safe = value?.replace(/[^a-zA-Z0-9_-]/g, '_') ?? ''
  return safe.length > 0 ? `credit-note-${safe}.pdf` : 'credit-note.pdf'
}

async function auditSafely(dependencies: CreditNoteRouteDependencies, input: ShoppingDocumentAuditInput): Promise<void> {
  try {
    await dependencies.auditAttempt({ ...input, document: 'credit_note' })
  } catch (error) {
    console.warn('[shopping-credit-note-pdf] audit failed', {
      connector: input.connector,
      externalOrderId: input.externalOrderId,
      orderId: input.orderId,
      accepted: input.accepted,
      reason: input.reason,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function reject(dependencies: CreditNoteRouteDependencies, input: ShoppingDocumentAuditInput, reason: string, status = 403): Promise<NextResponse> {
  return auditSafely(dependencies, { ...input, accepted: false, reason })
    .then(() => jsonNoStore({ error: 'Credit note PDF is not available' }, status))
}

/** @internal Test seam for the shopping credit note PDF route handler. */
export async function handleShoppingCreditNotePdfRoute(
  request: NextRequest,
  params: CreditNoteRouteParams,
  dependencies: CreditNoteRouteDependencies = defaultDependencies,
): Promise<Response> {
  const { connector: rawConnector } = params
  if (!isShoppingConnectorId(rawConnector)) return jsonNoStore({ error: 'Unknown shopping connector' }, 404)
  const connector = rawConnector
  const auditBase: ShoppingDocumentAuditInput = { connector, accepted: false }
  getShoppingConnector(connector)

  const clientIp = getClientIp(request.headers) ?? 'unknown'
  const rateLimit = await dependencies.checkRateLimit?.(`shopping-credit-note-pdf:${connector}:${clientIp}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  if (rateLimit && !rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many credit note PDF requests' },
      { status: 429, headers: { ...NO_STORE_HEADERS, 'Retry-After': String(rateLimit.retryAfterSec) } },
    )
  }

  if (!await dependencies.getPluginEnabled(connector)) return reject(dependencies, auditBase, 'connector_disabled', 423)

  const bodyResult = await readLimitedRequestBody(request, {
    maxBytes: MAX_BODY_BYTES,
    timeoutMs: READ_TIMEOUT_MS,
    tooLargeMessage: 'Shopping credit note PDF request body is too large.',
    emptyBodyMessage: 'Shopping credit note PDF request body is required.',
  })
  if (!bodyResult.ok) return bodyResult.response

  const rawBody = bodyResult.body
  const secret = await dependencies.getSecret(connector)
  if (!secret) return reject(dependencies, auditBase, 'missing_connector_secret', 503)

  if (!verifyShoppingInvoicePdfSignature(rawBody, request.headers.get('x-oti-signature'), secret)) {
    return reject(dependencies, auditBase, 'bad_signature')
  }

  const parsed = parseShoppingInvoicePdfRequest(rawBody, connector, { now: dependencies.now })
  if (!parsed.valid) return reject(dependencies, auditBase, parsed.reason)
  // A credit note request names the refund. Without it there is nothing to look up, and the invoice must never be served in its place.
  const externalRefundId = parsed.request.externalRefundId
  if (!externalRefundId) return reject(dependencies, auditBase, 'refund_id_missing')

  const order = await dependencies.findOrder(parsed.request)
  const auditWithOrder: ShoppingDocumentAuditInput = { ...auditBase, externalOrderId: parsed.request.externalOrderId, orderId: order?.orderId ?? null }
  if (!order) return reject(dependencies, auditWithOrder, 'order_not_found')

  const refund = await dependencies.findRefund(order.orderId, externalRefundId)
  if (!refund) return reject(dependencies, auditWithOrder, 'refund_not_found', 404)

  if (!await dependencies.consumeNonce(parsed.request)) return reject(dependencies, auditWithOrder, 'nonce_replayed')

  const pdf = await dependencies.loadCreditNotePdf(order.orderId, refund.refundId)
  if (!pdf) {
    // Not stored (a historic refund) or not servable: QUEUE it, answer "preparing". Nothing here reaches the ledger.
    if (!dependencies.requestCreditNoteOnDemand) return reject(dependencies, auditWithOrder, 'credit_note_pdf_missing', 404)
    const outcome = await dependencies.requestCreditNoteOnDemand(order.orderId, refund.refundId)
      .catch((): OnDemandRequestOutcome => ({ status: 'unavailable', reason: 'the request could not be queued' }))
    if (outcome.status === 'preparing') {
      await auditSafely(dependencies, { ...auditWithOrder, accepted: true, reason: 'credit_note_pdf_preparing' })
      return preparingResponse(outcome.retryAfterSeconds)
    }
    if (outcome.status === 'throttled') {
      await auditSafely(dependencies, { ...auditWithOrder, accepted: false, reason: 'credit_note_queue_full' })
      return NextResponse.json(
        { status: 'busy', error: 'Credit note PDF is not available right now' },
        { status: 429, headers: { ...NO_STORE_HEADERS, 'Retry-After': String(outcome.retryAfterSeconds) } },
      )
    }
    return reject(dependencies, auditWithOrder, 'credit_note_pdf_missing', 404)
  }

  await auditSafely(dependencies, { ...auditWithOrder, accepted: true, reason: null })

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safeCreditNoteFilename(refund.creditNoteNumber)}"`,
      ...NO_STORE_HEADERS,
    },
  })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ connector: string }> }) {
  return handleShoppingCreditNotePdfRoute(request, await params)
}
