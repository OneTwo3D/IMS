/**
 * Public signed-URL PDF download endpoint for Xero invoices.
 * GET /api/invoices/[id]?token=<expiring-signed-token>
 * Authenticated invoice rendering lives in the sibling singular /api/invoice/[id] route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { logActivity } from '@/lib/activity-log'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import {
  buildInvoicePdfSessionBinding,
  loadInvoicePdf,
  verifyPdfTokenDetailed,
  type InvoicePdfTokenBinding,
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
  userAgent: string | null
}

type InvoicePdfRouteDependencies = {
  loadInvoicePdf: typeof loadInvoicePdf
  verifyPdfToken: typeof verifyPdfTokenDetailed
  getTokenBinding: () => Promise<InvoicePdfTokenBinding | null>
  auditTokenAttempt: (input: InvoicePdfTokenAuditInput) => Promise<void>
  checkRateLimit?: (key: string, max: number, windowMs: number) => Promise<RateLimitResult>
}

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
} as const

const defaultDependencies: InvoicePdfRouteDependencies = {
  loadInvoicePdf,
  verifyPdfToken: verifyPdfTokenDetailed,
  getTokenBinding: getInvoicePdfTokenBinding,
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

async function getInvoicePdfTokenBinding(): Promise<InvoicePdfTokenBinding | null> {
  const session = await auth()
  if (!session?.user?.id || session.user.sessionInvalidReason) return null
  if (session.user.totpEnabled && !session.user.totpVerified) return null
  return {
    sessionId: buildInvoicePdfSessionBinding({
      userId: session.user.id,
      sessionVersion: session.user.sessionVersion,
      sessionAuthTime: session.user.sessionAuthTime,
    }),
  }
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
      userAgent: input.userAgent,
      accepted: input.verification.valid,
      reason: input.verification.valid ? null : input.verification.reason,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** @internal Test seam for the invoice PDF route handler. */
export async function auditInvoicePdfTokenAttempt(input: InvoicePdfTokenAuditInput): Promise<void> {
  const accepted = input.verification.valid
  const suspiciousSessionMismatch = !accepted && input.verification.reason === 'wrong_session'
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: input.orderId,
    tag: 'auth',
    action: accepted ? 'invoice_pdf_token_verified' : 'invoice_pdf_token_rejected',
    level: accepted || !suspiciousSessionMismatch ? 'INFO' : 'WARNING',
    description: accepted
      ? 'Invoice PDF token accepted'
      : `Invoice PDF token rejected: ${input.verification.reason}`,
    metadata: {
      tokenPresent: input.tokenPresent,
      tokenLength: input.tokenLength,
      tokenFormat: 'expiring',
      userAgent: input.userAgent,
      suspiciousSessionMismatch,
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
  const userAgent = request.headers.get('user-agent')
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

  const tokenBinding = await dependencies.getTokenBinding()
  const verification = dependencies.verifyPdfToken(id, token, { binding: tokenBinding ?? undefined })
  if (!verification.valid) {
    await auditTokenAttemptSafely(dependencies, {
      orderId: id,
      verification,
      tokenPresent: Boolean(token),
      tokenLength,
      userAgent,
    })
    return jsonNoStore({ error: 'Invalid or expired invoice PDF link. Refresh the invoice page to request a new link.' }, 403)
  }

  await auditTokenAttemptSafely(dependencies, {
    orderId: id,
    verification,
    tokenPresent: Boolean(token),
    tokenLength,
    userAgent,
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
