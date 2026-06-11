/**
 * Public signed-URL PDF download endpoint for Xero invoices.
 * GET /api/invoices/[id]?token=<expiring-signed-token>
 * Authenticated invoice rendering lives in the sibling singular /api/invoice/[id] route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity-log'
import { auth } from '@/lib/auth'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import {
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
  auditTokenAttempt: (input: InvoicePdfTokenAuditInput) => Promise<void>
  getTokenBinding?: (request: NextRequest, clientIp: string) => Promise<InvoicePdfTokenBinding | null>
  checkRateLimit?: (key: string, max: number, windowMs: number) => Promise<RateLimitResult>
}

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
} as const

const defaultDependencies: InvoicePdfRouteDependencies = {
  loadInvoicePdf,
  verifyPdfToken: verifyPdfTokenDetailed,
  auditTokenAttempt: auditInvoicePdfTokenAttempt,
  getTokenBinding: getInvoicePdfTokenBinding,
  checkRateLimit,
}

export function isInvoicePdfTokenSecuritySignal(verification: PdfTokenVerificationResult): boolean {
  return !verification.valid && (
    verification.reason === 'wrong_session' ||
    verification.reason === 'wrong_ip'
  )
}

export function invoicePdfTokenAuditAction(verification: PdfTokenVerificationResult): string {
  if (verification.valid) return 'invoice_pdf_token_verified'
  return isInvoicePdfTokenSecuritySignal(verification)
    ? 'invoice_pdf_token_security_signal'
    : 'invoice_pdf_token_rejected'
}

export function invoicePdfTokenAuditDescription(verification: PdfTokenVerificationResult): string {
  if (verification.valid) return 'Invoice PDF token accepted'
  return isInvoicePdfTokenSecuritySignal(verification)
    ? `Invoice PDF token security signal: ${verification.reason}`
    : `Invoice PDF token rejected: ${verification.reason}`
}

function jsonNoStore(body: object, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function safeInvoiceFilenameId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return safe.length > 0 ? safe : 'invoice'
}

async function getInvoicePdfTokenBinding(_request: NextRequest, clientIp: string): Promise<InvoicePdfTokenBinding | null> {
  const session = await auth()
  if (!session?.user?.id) return null
  return {
    sessionId: `${session.user.id}:${session.user.sessionVersion ?? 'unknown'}:${session.user.sessionAuthTime ?? 'unknown'}`,
    clientIp,
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
  const securitySignal = isInvoicePdfTokenSecuritySignal(input.verification)
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: input.orderId,
    tag: 'auth',
    action: invoicePdfTokenAuditAction(input.verification),
    level: accepted ? 'INFO' : 'WARNING',
    description: invoicePdfTokenAuditDescription(input.verification),
    metadata: {
      tokenPresent: input.tokenPresent,
      tokenLength: input.tokenLength,
      tokenFormat: 'expiring',
      reason: accepted ? null : input.verification.reason,
      userAgent: input.userAgent,
      securitySignal,
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
  const clientIp = getClientIp(request.headers)
  const rateLimit = await dependencies.checkRateLimit?.(`invoice-pdf:${clientIp ?? 'unknown'}`, 30, 60_000)
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

  const tokenBinding = clientIp ? await dependencies.getTokenBinding?.(request, clientIp) ?? null : null
  const verification = dependencies.verifyPdfToken(id, token, {
    binding: tokenBinding,
    requireBinding: true,
  })
  if (!verification.valid) {
    await auditTokenAttemptSafely(dependencies, {
      orderId: id,
      verification,
      tokenPresent: Boolean(token),
      tokenLength,
      userAgent,
    })
    return jsonNoStore({ error: 'Invalid or expired invoice PDF link. Return to the invoice page and request a fresh link.' }, 403)
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
