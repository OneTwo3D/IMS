/**
 * What the customer document routes under /api/shopping/[connector] share: the connector gate, the one-time nonce, the proof that the
 * caller owns the order, and the audit row. The invoice route and the credit note route both build on this, so a customer is proved
 * the same way for both and a document is never reachable by a looser check than the invoice's.
 *
 * Route files may export nothing but their handlers, so the shared parts live here.
 */

import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { SHOPPING_CONNECTORS, type ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import type { ShoppingInvoicePdfRequest } from '@/lib/shopping-invoice-pdf'

export type ShoppingDocumentOrder = {
  orderId: string
  invoiceNumber: string | null
  invoicePdfPath: string | null
}

export type ShoppingDocumentAuditInput = {
  connector: ShoppingConnectorId | string
  externalOrderId?: string | null
  orderId?: string | null
  accepted: boolean
  reason?: string | null
  /** Which document was asked for. Absent means the invoice (the route that predates the credit note). */
  document?: 'invoice' | 'credit_note'
}

export const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
} as const

// DERIVED FROM THE REGISTRY (o3d-remove-parked-connectors): a second id union here would mean this
// ingress accepts only the connectors somebody remembered to spell in this file.
export function isShoppingConnectorId(value: string): value is ShoppingConnectorId {
  return SHOPPING_CONNECTORS.some((connector) => connector.id === value)
}

export async function isShoppingConnectorPluginEnabled(connector: ShoppingConnectorId): Promise<boolean> {
  const pluginState = await getIntegrationPluginState()
  return pluginState[connector]
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

export async function consumeShoppingInvoicePdfNonce(request: ShoppingInvoicePdfRequest): Promise<boolean> {
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

/**
 * The order the signed request names, but only if the caller is proved to own it: a logged-in customer must be the customer the order
 * belongs to (their storefront account is linked to that IMS customer), a guest must hold the order's own key. Anything else is null,
 * so another customer's order is indistinguishable from one that does not exist.
 */
export async function findShoppingInvoicePdfOrder(request: ShoppingInvoicePdfRequest): Promise<ShoppingDocumentOrder | null> {
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

/** @internal Test seam for shopping invoice PDF route auditing. */
export async function auditShoppingInvoicePdfAttempt(input: ShoppingDocumentAuditInput): Promise<void> {
  const what = input.document === 'credit_note' ? 'credit note PDF' : 'invoice PDF'
  await logActivity({
    entityType: input.orderId ? 'SALES_ORDER' : 'SYNC',
    entityId: input.orderId ?? null,
    tag: 'auth',
    action: input.accepted ? 'shopping_invoice_pdf_request_verified' : 'shopping_invoice_pdf_request_rejected',
    level: input.accepted ? 'INFO' : 'WARNING',
    description: input.accepted
      ? `Shopping ${what} request accepted`
      : `Shopping ${what} request rejected: ${input.reason ?? 'unknown'}`,
    metadata: {
      connector: input.connector,
      externalOrderId: input.externalOrderId ?? null,
      reason: input.reason ?? null,
      ...(input.document === 'credit_note' ? { document: 'credit_note' } : {}),
    },
    resolveUser: false,
  })
}

/**
 * THE "PREPARING" ANSWER (the contract the storefront helper plugin may rely on): HTTP 202, `{ status: 'preparing', retryAfterSeconds }`, the
 * same value in `Retry-After`, and `X-IMS-Invoice-Status: preparing`. It carries no document and no customer data. The next request after
 * that time is served the PDF once the sweep has stored it.
 */
export function preparingResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { status: 'preparing', retryAfterSeconds },
    { status: 202, headers: { ...NO_STORE_HEADERS, 'Retry-After': String(retryAfterSeconds), 'X-IMS-Invoice-Status': 'preparing' } },
  )
}

