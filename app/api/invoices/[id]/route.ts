/**
 * Public signed-URL PDF download endpoint for Xero invoices.
 * GET /api/invoices/[id]?token=<expiring-signed-token>
 */

import { NextRequest, NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity-log'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import {
  loadInvoicePdf,
  verifyPdfTokenDetailed,
  type PdfTokenVerificationResult,
} from '@/lib/invoice-pdf'

type InvoicePdfRouteParams = {
  id: string
}

type InvoicePdfTokenAuditInput = {
  orderId: string
  verification: PdfTokenVerificationResult
  tokenPresent: boolean
  tokenLength: number
}

type InvoicePdfRouteDependencies = {
  loadInvoicePdf: typeof loadInvoicePdf
  verifyPdfToken: typeof verifyPdfTokenDetailed
  auditTokenAttempt: (input: InvoicePdfTokenAuditInput) => Promise<void>
  checkRateLimit?: (key: string, max: number, windowMs: number) => Promise<RateLimitResult>
}

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
} as const

const defaultDependencies: InvoicePdfRouteDependencies = {
  loadInvoicePdf,
  verifyPdfToken: verifyPdfTokenDetailed,
  auditTokenAttempt: auditInvoicePdfTokenAttempt,
  checkRateLimit,
}

function jsonNoStore(body: object, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function safeInvoiceFilenameId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return safe.length > 0 ? safe : 'invoice'
}

async function auditTokenAttemptSafely(
  dependencies: InvoicePdfRouteDependencies,
  input: InvoicePdfTokenAuditInput,
): Promise<void> {
  try {
    await dependencies.auditTokenAttempt(input)
  } catch (error) {
    console.warn('[invoice-pdf] token audit failed', {
      orderId: input.orderId,
      tokenPresent: input.tokenPresent,
      tokenLength: input.tokenLength,
      accepted: input.verification.valid,
      reason: input.verification.valid ? null : input.verification.reason,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** @internal Test seam for the invoice PDF route handler. */
export async function auditInvoicePdfTokenAttempt(input: InvoicePdfTokenAuditInput): Promise<void> {
  const accepted = input.verification.valid
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: input.orderId,
    tag: 'auth',
    action: accepted ? 'invoice_pdf_token_verified' : 'invoice_pdf_token_rejected',
    level: accepted ? 'INFO' : 'WARNING',
    description: accepted
      ? 'Invoice PDF token accepted'
      : `Invoice PDF token rejected: ${input.verification.reason}`,
    metadata: {
      tokenPresent: input.tokenPresent,
      tokenLength: input.tokenLength,
      tokenFormat: 'expiring',
      reason: accepted ? null : input.verification.reason,
    },
    resolveUser: false,
  })
}

/** @internal Test seam for the invoice PDF route handler. */
export async function handleInvoicePdfRoute(
  request: NextRequest,
  params: InvoicePdfRouteParams,
  dependencies: InvoicePdfRouteDependencies = defaultDependencies,
): Promise<NextResponse> {
  const { id } = params
  const token = request.nextUrl.searchParams.get('token')
  const tokenLength = token?.length ?? 0
  const clientIp = getClientIp(request.headers) ?? 'unknown'
  const rateLimit = await dependencies.checkRateLimit?.(`invoice-pdf:${clientIp}`, 30, 60_000)
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

  const verification = dependencies.verifyPdfToken(id, token)
  if (!verification.valid) {
    await auditTokenAttemptSafely(dependencies, {
      orderId: id,
      verification,
      tokenPresent: Boolean(token),
      tokenLength,
    })
    return jsonNoStore({ error: 'Invalid or missing token' }, 403)
  }

  await auditTokenAttemptSafely(dependencies, {
    orderId: id,
    verification,
    tokenPresent: Boolean(token),
    tokenLength,
  })

  const pdf = await dependencies.loadInvoicePdf(id)
  if (!pdf) {
    return jsonNoStore({ error: 'Invoice PDF not found' }, 404)
  }

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${safeInvoiceFilenameId(id)}.pdf"`,
      ...NO_STORE_HEADERS,
    },
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleInvoicePdfRoute(request, await params)
}
